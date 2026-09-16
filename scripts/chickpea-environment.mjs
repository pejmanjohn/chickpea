#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { attestEnvironment } from './lib/environment-attestation.mjs';
import {
  EnvironmentRegistryError,
  activeEnvironmentTargets,
  claimEnvironment,
  migrateEnvironmentProviderAuthConfigsFromFile,
  readEnvironmentStatus,
  reclaimEnvironment,
  reconcileEnvironment,
  releaseEnvironment,
  withEnvironmentInstallationClaim,
} from './lib/environment-registry.mjs';
import { EnvironmentWaitError, waitForEnvironmentClaim } from './lib/environment-wait.mjs';
import { assertInstallationNodeRuntime, reserveEnvironmentInstallation, restoreEnvironmentInstallation } from './lib/environment-installation.mjs';
import { InstallationNodeError, reconcileNodeInstallationProcess, runNodeInstallation } from './lib/environment-installation-node.mjs';
import { targetEnvironment } from './lib/environment-target.mjs';
import {
  reconcileEnvironmentDeployment,
  adoptEnvironmentFromFile,
  withEnvironmentReleaseFence,
} from './lib/environment-preflight.mjs';

export async function runEnvironmentCli(argv, io = {}) {
  const stdout = io.stdout ?? ((value) => process.stdout.write(value));
  const stderr = io.stderr ?? ((value) => process.stderr.write(value));
  try {
    const parsed = parseArgs(argv);
    const options = {
      ...(parsed.flags.root ? { root: parsed.flags.root } : {}),
      ...(parsed.flags.worktree ? { worktreePath: parsed.flags.worktree } : {}),
      ...(parsed.flags.leaseMs ? { leaseDurationMs: numberFlag(parsed.flags.leaseMs) } : {}),
      ...((parsed.flags.profile || parsed.flags.environment) ? {
        providerContext: [
          ...(parsed.flags.profile ? ['--profile', parsed.flags.profile] : []),
          ...(parsed.flags.environment ? ['--env', parsed.flags.environment] : []),
        ],
      } : {}),
      // Direct injection is intentionally available only to unit harnesses.
      // The executable never accepts a host identity from argv or env.
      ...(io.hostFingerprint ? { hostFingerprint: io.hostFingerprint } : {}),
      // Test harnesses must opt in explicitly; this is never derived from argv,
      // environment variables, or the injected machine identity.
      ...(io.allowSuppliedObservation === true ? { allowSuppliedObservation: true } : {}),
    };
    let result;
    if (['install-start', 'install-reconcile'].includes(parsed.command)) {
      requireTarget(parsed.target);
      if (Object.keys(parsed.flags).some((flag) => !['root', 'worktree', 'runtimeEnv'].includes(flag))
        || (parsed.command === 'install-start' ? !parsed.flags.runtimeEnv : parsed.flags.runtimeEnv)) {
        throw new EnvironmentRegistryError('INVALID_ARGUMENT');
      }
      if (parsed.command === 'install-start') {
        const installation = assertInstallationNodeRuntime(parsed.target, options);
        result = await runNodeInstallation(installation, parsed.flags.runtimeEnv,
          (start) => withEnvironmentInstallationClaim(parsed.target, options, start));
        stdout(`${JSON.stringify(result)}\n`);
        return result.code ?? 1;
      }
      result = withEnvironmentInstallationClaim(parsed.target, options, (installation) => {
        if (installation.runtime !== 'node') throw new EnvironmentRegistryError('INSTALLATION_RUNTIME_MISMATCH');
        return reconcileNodeInstallationProcess(installation);
      });
    } else if (['install-reserve', 'install-restore'].includes(parsed.command)) {
      requireTarget(parsed.target);
      if (!parsed.flags.installation || Object.keys(parsed.flags).some((flag) => ![
        'root', 'worktree', 'installation', 'profile', 'environment',
      ].includes(flag))) throw new EnvironmentRegistryError('INVALID_ARGUMENT');
      result = await (parsed.command === 'install-reserve' ? reserveEnvironmentInstallation : restoreEnvironmentInstallation)(
        parsed.target, parsed.flags.installation, options,
      );
    } else if (parsed.command === 'register') {
      if (parsed.target || !parsed.flags.registration
        || Object.keys(parsed.flags).some((flag) => !['root', 'registration'].includes(flag))) {
        throw new EnvironmentRegistryError('INVALID_ARGUMENT');
      }
      result = await adoptEnvironmentFromFile(parsed.flags.registration, options);
    } else if (parsed.command === 'migrate-provider-auth') {
      if (parsed.target || !parsed.flags.bindings
        || Object.keys(parsed.flags).some((flag) => !['root', 'bindings'].includes(flag))) {
        throw new EnvironmentRegistryError('INVALID_ARGUMENT');
      }
      result = migrateEnvironmentProviderAuthConfigsFromFile(parsed.flags.bindings, options);
    } else if (parsed.command === 'claim') {
      result = claimEnvironment(parsed.target, options);
    } else if (parsed.command === 'wait-claim') {
      if (!parsed.target || !['any', ...activeEnvironmentTargets].includes(parsed.target)
        || parsed.flags.timeoutMs === undefined || parsed.flags.pollMs === undefined
        || Object.keys(parsed.flags).some((flag) => ![
          'root', 'worktree', 'leaseMs', 'timeoutMs', 'pollMs',
        ].includes(flag))) {
        throw new EnvironmentRegistryError('INVALID_ARGUMENT');
      }
      const controller = new AbortController();
      const signal = io.signal ?? controller.signal;
      const interrupt = () => controller.abort();
      if (!io.signal) {
        process.once('SIGINT', interrupt);
        process.once('SIGTERM', interrupt);
      }
      try {
        result = await waitForEnvironmentClaim(parsed.target, {
          ...options,
          timeoutMs: numberFlag(parsed.flags.timeoutMs),
          pollMs: numberFlag(parsed.flags.pollMs),
          signal,
          ...(io.waitOptions ?? {}),
          onStatusChange: (status) => stderr(
            `wait-claim: ${status.map((lane) => `${lane.target}=${lane.claimed ? 'claimed' : lane.verifierLock === 'live' ? 'locked' : lane.health}`).join(' ')}\n`,
          ),
        });
      } finally {
        if (!io.signal) {
          process.removeListener('SIGINT', interrupt);
          process.removeListener('SIGTERM', interrupt);
        }
      }
    } else if (parsed.command === 'status') {
      result = readEnvironmentStatus({
        ...options,
        worktreePath: options.worktreePath ?? process.cwd(),
        ...(!parsed.flags.all && parsed.target ? { target: parsed.target } : {}),
      });
    } else if (parsed.command === 'target') {
      requireTarget(parsed.target);
      result = targetEnvironment(parsed.target, options);
    } else if (parsed.command === 'attest') {
      requireTarget(parsed.target);
      if (parsed.flags.observation && io.allowSuppliedObservation !== true) {
        throw new EnvironmentRegistryError('CALLER_OBSERVATION_REFUSED');
      }
      if (!parsed.flags.observation && io.allowSuppliedObservation === true) {
        throw new EnvironmentRegistryError('OBSERVATION_REQUIRED');
      }
      const observation = parsed.flags.observation
        ? JSON.parse(readFileSync(parsed.flags.observation, 'utf8'))
        : undefined;
      result = await attestEnvironment(parsed.target, observation, options);
    } else if (parsed.command === 'release') {
      requireTarget(parsed.target);
      result = withEnvironmentReleaseFence(
        parsed.target,
        options,
        (fence) => releaseEnvironment(parsed.target, {
          ...options,
          expectedTargetLockRunId: fence.runId,
        }),
      );
    } else if (parsed.command === 'reclaim') {
      requireTarget(parsed.target);
      result = reclaimEnvironment(parsed.target, {
        ...options,
        ...(parsed.flags.adoptOrphan ? { adoptOrphan: true } : {}),
      });
    } else if (parsed.command === 'reconciliation') {
      const recoveredDeployment = parsed.target
        ? await reconcileEnvironmentDeployment(parsed.target, options)
        : null;
      result = {
        ...reconcileEnvironment(parsed.target, options),
        deploymentRecovered: recoveredDeployment !== null,
      };
    } else {
      throw new EnvironmentRegistryError('INVALID_COMMAND');
    }
    stdout(`${JSON.stringify(result, null, 2)}\n`);
    return result?.kind === 'timeout' ? 3 : 0;
  } catch (error) {
    const code = error instanceof EnvironmentRegistryError || error instanceof EnvironmentWaitError || error instanceof InstallationNodeError
      ? error.code
      : 'ENVIRONMENT_COMMAND_FAILED';
    // A non-registry failure used to surface as a bare code, which hid the
    // actual cause (a missing host variable, an unreachable Worker, a parse
    // error). Name it, bounded and without any token-shaped content.
    const message = error instanceof EnvironmentRegistryError || error instanceof EnvironmentWaitError || error instanceof InstallationNodeError
      ? undefined
      : redactCommandFailure(error instanceof Error ? error.message : String(error));
    const body = {
      error: code,
      ...((error instanceof EnvironmentRegistryError || error instanceof EnvironmentWaitError) && error.details
        ? { details: error.details }
        : {}),
      ...(message ? { message } : {}),
    };
    stderr(`${JSON.stringify(body)}\n`);
    return error instanceof EnvironmentWaitError && error.code === 'WAIT_CANCELLED' ? 130 : 2;
  }
}

function redactCommandFailure(message) {
  return String(message)
    .replace(/[A-Za-z0-9_-]{43}/g, '<redacted>')
    .replace(/xox[a-z]-[A-Za-z0-9-]+/g, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--all') {
      flags.all = true;
      continue;
    }
    if (value === '--adopt-orphan') {
      flags.adoptOrphan = true;
      continue;
    }
    const field = {
      '--root': 'root',
      '--worktree': 'worktree',
      '--lease-ms': 'leaseMs',
      '--timeout-ms': 'timeoutMs',
      '--poll-ms': 'pollMs',
      '--observation': 'observation',
      '--bindings': 'bindings',
      '--registration': 'registration',
      '--installation': 'installation',
      '--runtime-env': 'runtimeEnv',
      '--profile': 'profile',
      '--env': 'environment',
    }[value];
    if (field) {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new EnvironmentRegistryError('INVALID_ARGUMENT');
      flags[field] = next;
      index += 1;
      continue;
    }
    if (value.startsWith('--')) throw new EnvironmentRegistryError('INVALID_ARGUMENT');
    positional.push(value);
  }
  if (positional.length < 1 || positional.length > 2) {
    throw new EnvironmentRegistryError('INVALID_COMMAND');
  }
  if (flags.bindings && positional[0] !== 'migrate-provider-auth') {
    throw new EnvironmentRegistryError('INVALID_ARGUMENT');
  }
  if (flags.registration && positional[0] !== 'register') throw new EnvironmentRegistryError('INVALID_ARGUMENT');
  if (flags.installation && !['install-reserve', 'install-restore'].includes(positional[0])) throw new EnvironmentRegistryError('INVALID_ARGUMENT');
  if (positional[0] !== 'wait-claim'
    && (flags.timeoutMs !== undefined || flags.pollMs !== undefined)) {
    throw new EnvironmentRegistryError('INVALID_ARGUMENT');
  }
  return { command: positional[0], target: positional[1], flags };
}

function requireTarget(target) {
  if (!target) throw new EnvironmentRegistryError('TARGET_REQUIRED');
}

function numberFlag(input) {
  const value = Number(input);
  if (!Number.isSafeInteger(value)) throw new EnvironmentRegistryError('INVALID_ARGUMENT');
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runEnvironmentCli(process.argv.slice(2));
}
