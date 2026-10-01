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
  readEnvironmentCapabilities,
  renderCapabilityTable,
  writeCapabilityMatrix,
} from './lib/environment-capabilities.mjs';
import {
  reconcileEnvironmentDeployment,
  adoptEnvironmentFromFile,
  carryEnvironmentSchemaAdvancementIntent,
  readLocalEnvironmentContract,
  withEnvironmentReleaseFence,
  writeEnvironmentSchemaAdvancementIntent,
} from './lib/environment-preflight.mjs';

export const USAGE = `Usage: npm run env -- <command> [lane] [options]

Lanes: ${activeEnvironmentTargets.join(', ')}. Every command takes --worktree <absolute path> (default: the current directory).

  status [lane|--all]            Claims, health, serving version and schema generation.
  capabilities <lane|all> [--json] [--write]
                                 Read-only lane capability matrix: profile, keys, models, schema.
  claim [lane]                   Claim a free lane for this worktree at its current HEAD.
  wait-claim <lane|any> --timeout-ms MS --poll-ms MS
                                 Wait for a lane, then claim it (0 timeout = try once).
  restamp <lane>                 Move this worktree's own claim to its current HEAD after a commit,
                                 rebase or branch switch. Refused while a deploy is open; never
                                 takes another worktree's lane. Carries a pending schema intent.
  schema-advance <lane>          Record this worktree's intent to advance the lane's Durable Object
                                 schema to the candidate's generation (one recorded step). The next
                                 guarded deploy applies it. Permanent: Cloudflare cannot roll back.
  release <lane>                 Give back this worktree's claim from any branch HEAD.
  reclaim <lane> [--adopt-orphan]
                                 Renew an expired claim, or adopt one whose worktree is gone.
  target <lane> | attest <lane>  Doctor inputs for the legacy coordinator.
  reconciliation [lane]          Adopt an uploaded version after an interrupted deploy.
  register --registration FILE | migrate-provider-auth --bindings FILE
  install-reserve|install-start|install-reconcile|install-restore <lane> ...
                                 Borrow a lane for a fresh install (qa/live/operator/environments.md).

Output is JSON on stdout; errors are JSON on stderr with an "error" code.
`;

/**
 * One advisory line on stderr after a claim: whether the worktree's HEAD
 * already contains remote main. The guarded deploy refuses a candidate behind
 * main (QA_SOURCE_BEHIND_MAIN); saying so now saves a build and a host wait.
 */
async function sourceAdvisory(worktreePath, stderr, io) {
  if (io.sourceAdvisory === false || process.env.CHICKPEA_ENV_SOURCE_ADVISORY === 'off') return;
  try {
    const { admitQaCandidate } = await import('./lib/qa-candidate.mjs');
    const admission = admitQaCandidate(worktreePath);
    stderr(`source: contains remote main ${admission.approvedTip.slice(0, 8)}; ready for a guarded deploy\n`);
  } catch (error) {
    const code = error?.code ?? 'UNKNOWN';
    stderr(code === 'QA_SOURCE_BEHIND_MAIN'
      ? 'source: behind remote main; rebase or merge origin/main, then `npm run env -- restamp <lane>`, before deploying\n'
      : `source: admission not confirmed (${code}); the guarded deploy will check again\n`);
  }
}

/**
 * The schema contract belongs to the claimed checkout. Without this, a
 * `--worktree` pointing at another checkout would be judged by the runner's own
 * migrations.
 */
function contractOptions(options, parsed) {
  return parsed.flags.worktree ? { ...options, projectRoot: parsed.flags.worktree } : options;
}

export async function runEnvironmentCli(argv, io = {}) {
  const stdout = io.stdout ?? ((value) => process.stdout.write(value));
  const stderr = io.stderr ?? ((value) => process.stderr.write(value));
  try {
    if (argv.length === 0 || argv.includes('--help') || argv[0] === 'help') {
      (argv.length === 0 ? stderr : stdout)(USAGE);
      return argv.length === 0 ? 2 : 0;
    }
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
      await sourceAdvisory(result.canonicalWorktreePath, stderr, io);
    } else if (parsed.command === 'restamp') {
      requireTarget(parsed.target);
      if (Object.keys(parsed.flags).some((flag) => !['root', 'worktree', 'leaseMs'].includes(flag))) {
        throw new EnvironmentRegistryError('INVALID_ARGUMENT');
      }
      let previous;
      const claim = reclaimEnvironment(parsed.target, {
        ...options,
        requireSameWorktree: true,
        onReclaimed: (change) => { previous = change.previous; },
      });
      const schemaIntent = carryEnvironmentSchemaAdvancementIntent(parsed.target, previous?.leaseNonce, contractOptions(options, parsed));
      result = {
        target: parsed.target,
        restamped: true,
        branch: claim.branch,
        previousRevision: previous?.claimedRevision ?? null,
        claimedRevision: claim.claimedRevision,
        expiresAt: claim.expiresAt,
        schemaIntent,
        ...(schemaIntent.startsWith('stale:') ? { next: 'The pending schema intent no longer matches this HEAD; run `env schema-advance` again if the candidate still needs it.' } : {}),
      };
      await sourceAdvisory(claim.canonicalWorktreePath, stderr, io);
    } else if (parsed.command === 'schema-advance') {
      requireTarget(parsed.target);
      if (Object.keys(parsed.flags).some((flag) => !['root', 'worktree'].includes(flag))) {
        throw new EnvironmentRegistryError('INVALID_ARGUMENT');
      }
      const local = contractOptions(options, parsed);
      result = writeEnvironmentSchemaAdvancementIntent(parsed.target, readLocalEnvironmentContract(local).schemaGeneration, local);
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
      if (result?.claim?.canonicalWorktreePath) await sourceAdvisory(result.claim.canonicalWorktreePath, stderr, io);
    } else if (parsed.command === 'capabilities') {
      requireTarget(parsed.target);
      if (Object.keys(parsed.flags).some((flag) => ![
        'root', 'profile', 'environment', 'json', 'write',
      ].includes(flag)) || (parsed.flags.write && parsed.target !== 'all')) {
        throw new EnvironmentRegistryError('INVALID_ARGUMENT');
      }
      const report = await readEnvironmentCapabilities(parsed.target, {
        ...options,
        // Test harnesses inject fake Wrangler and registry readers here only.
        ...(io.capabilityOptions ?? {}),
      });
      const written = parsed.flags.write
        ? writeCapabilityMatrix(report, { ...options, ...(io.capabilityOptions ?? {}) })
        : undefined;
      if (parsed.flags.json) {
        stdout(`${JSON.stringify(written ? { ...report, matrix: written } : report, null, 2)}\n`);
      } else {
        stdout(renderCapabilityTable(report));
        if (written) stdout(`\nUpdated the generated section of ${written.path}.\n`);
      }
      return 0;
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
      const releaseOptions = { ...options, ownerHeadMayMove: true };
      result = withEnvironmentReleaseFence(
        parsed.target,
        releaseOptions,
        (fence) => releaseEnvironment(parsed.target, {
          ...releaseOptions,
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
    if (value === '--json' || value === '--write') {
      flags[value.slice(2)] = true;
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
  if ((flags.json || flags.write) && positional[0] !== 'capabilities') throw new EnvironmentRegistryError('INVALID_ARGUMENT');
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
