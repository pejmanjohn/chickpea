#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { attestEnvironment } from './lib/environment-attestation.mjs';
import {
  EnvironmentRegistryError,
  claimEnvironment,
  migrateEnvironmentProviderAuthConfigsFromFile,
  readEnvironmentStatus,
  reclaimEnvironment,
  reconcileEnvironment,
  releaseEnvironment,
} from './lib/environment-registry.mjs';
import { targetEnvironment } from './lib/environment-target.mjs';
import {
  reconcileEnvironmentDeployment,
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
    if (parsed.command === 'migrate-provider-auth') {
      if (parsed.target || !parsed.flags.bindings
        || Object.keys(parsed.flags).some((flag) => !['root', 'bindings'].includes(flag))) {
        throw new EnvironmentRegistryError('INVALID_ARGUMENT');
      }
      result = migrateEnvironmentProviderAuthConfigsFromFile(parsed.flags.bindings, options);
    } else if (parsed.command === 'claim') {
      result = claimEnvironment(parsed.target, options);
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
    return 0;
  } catch (error) {
    const code = error instanceof EnvironmentRegistryError ? error.code : 'ENVIRONMENT_COMMAND_FAILED';
    // A non-registry failure used to surface as a bare code, which hid the
    // actual cause (a missing host variable, an unreachable Worker, a parse
    // error). Name it, bounded and without any token-shaped content.
    const message = error instanceof EnvironmentRegistryError
      ? undefined
      : redactCommandFailure(error instanceof Error ? error.message : String(error));
    const body = {
      error: code,
      ...(error instanceof EnvironmentRegistryError && error.details
        ? { details: error.details }
        : {}),
      ...(message ? { message } : {}),
    };
    stderr(`${JSON.stringify(body)}\n`);
    return 2;
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
      '--observation': 'observation',
      '--bindings': 'bindings',
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
