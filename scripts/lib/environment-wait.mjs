import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import {
  EnvironmentRegistryError,
  activeEnvironmentTargets,
  assertLiveEnvironmentClaim,
  claimEnvironment,
  environmentMarkerPath,
  readEnvironmentStatus,
  releaseEnvironment,
} from './environment-registry.mjs';

const TARGETS = activeEnvironmentTargets;
const RETRYABLE_CLAIM_ERRORS = new Set([
  'NO_TARGET_AVAILABLE',
  'TARGET_CLAIMED',
]);

export class EnvironmentWaitError extends Error {
  constructor(code, details = undefined) {
    super(code);
    this.name = 'EnvironmentWaitError';
    this.code = code;
    this.details = details;
  }
}

export async function waitForEnvironmentClaim(selector, options = {}) {
  if (![...TARGETS, 'any'].includes(selector)) throw new EnvironmentWaitError('INVALID_WAIT_TARGET');
  const timeoutMs = boundedDuration(options.timeoutMs, 'INVALID_WAIT_TIMEOUT', 0, 2 * 60 * 60 * 1_000);
  const pollMs = boundedDuration(options.pollMs, 'INVALID_WAIT_POLL', 250, 60_000);
  const worktreePath = options.worktreePath ?? process.cwd();
  const registryOptions = { ...options, worktreePath };
  delete registryOptions.timeoutMs;
  delete registryOptions.pollMs;
  delete registryOptions.signal;
  delete registryOptions.sleep;
  delete registryOptions.monotonicNow;
  delete registryOptions.readHead;
  delete registryOptions.onStatusChange;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const sleep = options.sleep ?? abortableSleep;
  const readHead = options.readHead ?? readWorktreeHead;
  const startedAt = monotonicNow();
  const deadline = startedAt + timeoutMs;
  const initialHead = readHead(worktreePath);
  let lastSignature;
  let attemptedAvailability = false;

  for (;;) {
    throwIfCancelled(options.signal);
    const currentHead = readHead(worktreePath);
    if (currentHead !== initialHead) {
      throw new EnvironmentWaitError('WAIT_SOURCE_HEAD_CHANGED', {
        initialHead,
        currentHead,
      });
    }
    const beforeStatus = monotonicNow();
    if (attemptedAvailability && beforeStatus >= deadline) {
      const finalStatus = readEnvironmentStatus(registryOptions);
      emitStatusChange(finalStatus, options.onStatusChange, (signature) => {
        if (signature === lastSignature) return false;
        lastSignature = signature;
        return true;
      });
      return timeoutResult(selector, startedAt, monotonicNow(), finalStatus);
    }

    const status = readEnvironmentStatus(registryOptions);
    attemptedAvailability = true;
    emitStatusChange(status, options.onStatusChange, (signature) => {
      if (signature === lastSignature) return false;
      lastSignature = signature;
      return true;
    });

    if (status.selectedTarget) {
      if (selector !== 'any' && selector !== status.selectedTarget) {
        throw new EnvironmentWaitError('WAIT_WORKTREE_ALREADY_CLAIMED', {
          selectedTarget: status.selectedTarget,
        });
      }
      const existing = assertLiveEnvironmentClaim(status.selectedTarget, registryOptions).claim;
      return acquiredResult(existing, selector, startedAt, monotonicNow(), true);
    }
    // Normal claim historically repairs an orphan marker. Waiting is deliberately
    // narrower: leave that evidence untouched for an explicit reconciliation.
    if (existsSync(environmentMarkerPath(worktreePath))) {
      throw new EnvironmentWaitError('WAIT_ORPHAN_MARKER_REQUIRES_RECONCILIATION');
    }

    const considered = status.targets.filter(({ target }) => selector === 'any' || target === selector);
    const available = considered.find(({ health, claim, verifierLock }) =>
      health === 'ready' && claim === null && verifierLock.status === 'clear'
    );
    if (available) {
      try {
        const claim = claimEnvironment(available.target, registryOptions);
        if (options.signal?.aborted) {
          releaseNewClaimOrThrow(available.target, registryOptions, 'WAIT_CANCELLED');
          throw new EnvironmentWaitError('WAIT_CANCELLED');
        }
        const claimedStatus = readEnvironmentStatus({ ...registryOptions, target: available.target });
        const claimedLane = claimedStatus.targets[0];
        if (claimedLane?.health !== 'ready' || claimedLane.verifierLock.status !== 'clear') {
          releaseNewClaimOrThrow(available.target, registryOptions, 'WAIT_ACQUIRED_LANE_CHANGED');
          throw new EnvironmentWaitError('WAIT_ACQUIRED_LANE_CHANGED', {
            target: available.target,
            health: claimedLane?.health ?? 'missing',
            verifierLock: claimedLane?.verifierLock.status ?? 'missing',
          });
        }
        if (options.signal?.aborted) {
          releaseNewClaimOrThrow(available.target, registryOptions, 'WAIT_CANCELLED');
          throw new EnvironmentWaitError('WAIT_CANCELLED');
        }
        return acquiredResult(claim, selector, startedAt, monotonicNow(), false);
      } catch (error) {
        if (!(error instanceof EnvironmentRegistryError)
          || !RETRYABLE_CLAIM_ERRORS.has(error.code)) throw error;
      }
    } else if (!considered.some(retryableStatus)) {
      throw new EnvironmentWaitError('WAIT_ENVIRONMENT_NOT_RETRYABLE', {
        targets: considered.map(({ target, health, claim, verifierLock }) => ({
          target,
          health,
          claimed: claim !== null,
          verifierLock: verifierLock.status,
        })),
      });
    }

    const now = monotonicNow();
    if (now >= deadline) {
      return timeoutResult(selector, startedAt, now, status);
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - now)), options.signal);
  }
}

function timeoutResult(selector, startedAt, finishedAt, status) {
  return Object.freeze({
    schemaVersion: 'chickpea-environment-wait-result/v1',
    kind: 'timeout',
    selector,
    waitedMs: measuredDuration(startedAt, finishedAt),
    status,
  });
}

function releaseNewClaimOrThrow(target, registryOptions, interruptedBy) {
  try {
    releaseEnvironment(target, registryOptions);
  } catch (error) {
    throw new EnvironmentWaitError('WAIT_ACQUIRED_CLAIM_RELEASE_FAILED', {
      target,
      interruptedBy,
      releaseError: error instanceof EnvironmentRegistryError ? error.code : 'UNKNOWN',
    });
  }
}

function retryableStatus({ health, claim, verifierLock }) {
  return (health === 'ready' && claim !== null)
    || (health === 'ready' && verifierLock.status === 'live');
}

function acquiredResult(claim, selector, startedAt, finishedAt, reused) {
  return Object.freeze({
    schemaVersion: 'chickpea-environment-wait-result/v1',
    kind: 'acquired',
    selector,
    target: claim.target,
    waitedMs: measuredDuration(startedAt, finishedAt),
    reused,
    claim,
  });
}

function emitStatusChange(status, callback, accept) {
  if (typeof callback !== 'function') return;
  const compact = status.targets.map(({ target, health, claim, verifierLock }) => ({
    target,
    health,
    claimed: claim !== null,
    verifierLock: verifierLock.status,
  }));
  const signature = JSON.stringify(compact);
  if (accept(signature)) callback(Object.freeze(compact));
}

function readWorktreeHead(worktreePath) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: worktreePath,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  const revision = result.status === 0 ? result.stdout.trim() : '';
  if (!/^[0-9a-f]{7,64}$/u.test(revision)) throw new EnvironmentWaitError('WAIT_SOURCE_UNAVAILABLE');
  return revision;
}

function boundedDuration(value, code, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new EnvironmentWaitError(code, { minimumMs: minimum, maximumMs: maximum });
  }
  return value;
}

function measuredDuration(startedAt, finishedAt) {
  return Math.max(0, Math.round(finishedAt - startedAt));
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new EnvironmentWaitError('WAIT_CANCELLED');
}

function abortableSleep(durationMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new EnvironmentWaitError('WAIT_CANCELLED'));
      return;
    }
    const timer = setTimeout(done, durationMs);
    signal?.addEventListener('abort', cancelled, { once: true });
    function done() {
      signal?.removeEventListener('abort', cancelled);
      resolve();
    }
    function cancelled() {
      clearTimeout(timer);
      reject(new EnvironmentWaitError('WAIT_CANCELLED'));
    }
  });
}
