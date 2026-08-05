import type {
  InteractiveRunClaim,
  RenewRunLeaseInput,
  ReleaseRunLeaseInput,
  RunDisposition,
  RunRecord,
  ClaimNextInteractiveRunInput,
} from './types.ts';

type MaybePromise<T> = T | Promise<T>;

export interface RunDriverStore {
  claimNextInteractiveRun(
    input: ClaimNextInteractiveRunInput,
  ): MaybePromise<InteractiveRunClaim | undefined>;
  renewRunLease(input: RenewRunLeaseInput): MaybePromise<RunRecord>;
  releaseRunLease(input: ReleaseRunLeaseInput): MaybePromise<RunRecord>;
}

export type RunDriverHandlerResult =
  | { kind: 'completed' }
  | { kind: 'requeue'; reasonCode: string; retryAfterMs?: number }
  | { kind: 'recovery_required'; reasonCode: string }
  | {
      kind: 'settled';
      reasonCode: string;
      terminalDisposition: Extract<RunDisposition, 'skipped' | 'cancelled' | 'superseded'>;
    };

export interface DurableRunDriverOptions {
  ownerId: string;
  authorityEpoch: number;
  leaseDurationMs: number;
  maxClaims: number;
  concurrency: number;
  handle(claim: InteractiveRunClaim): Promise<RunDriverHandlerResult>;
  now?: () => number;
  /** Test/target override; production defaults to one third of the lease. */
  leaseRenewalIntervalMs?: number;
}

export interface RunDriverDrainResult {
  claimed: number;
  completed: number;
  requeued: number;
  recoveryRequired: number;
  /** Longest bounded retry delay requested by any requeued claim. */
  retryAfterMs?: number;
}

/** Preserve a target's normal retry floor while honoring a handler's longer
 * Retry-After hint from the bounded drain. */
export function runDriverRetryDelayMs(
  result: RunDriverDrainResult,
  minimumMs: number,
): number {
  return Math.max(minimumMs, result.retryAfterMs ?? 0);
}

/**
 * Target-neutral bounded drain for ledger-authoritative interactive Runs.
 * WorkStore owns atomic eligibility, ordering exclusion, leases, and fencing;
 * this loop owns only bounded concurrency and conservative handler outcomes.
 */
export class DurableRunDriver {
  private readonly now: () => number;

  constructor(
    private readonly store: RunDriverStore,
    private readonly options: DurableRunDriverOptions,
  ) {
    if (!Number.isSafeInteger(options.maxClaims) || options.maxClaims < 1 || options.maxClaims > 100) {
      throw new Error('Run driver maxClaims must be between 1 and 100.');
    }
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) {
      throw new Error('Run driver concurrency must be between 1 and 16.');
    }
    if (!Number.isSafeInteger(options.leaseDurationMs) || options.leaseDurationMs < 3) {
      throw new Error('Run driver leaseDurationMs must be at least 3 milliseconds.');
    }
    if (
      options.leaseRenewalIntervalMs !== undefined &&
      (!Number.isSafeInteger(options.leaseRenewalIntervalMs) ||
        options.leaseRenewalIntervalMs < 1 ||
        options.leaseRenewalIntervalMs >= options.leaseDurationMs)
    ) {
      throw new Error('Run driver lease renewal interval must be positive and shorter than its lease.');
    }
    this.now = options.now ?? Date.now;
  }

  async drain(): Promise<RunDriverDrainResult> {
    const result: RunDriverDrainResult = {
      claimed: 0,
      completed: 0,
      requeued: 0,
      recoveryRequired: 0,
    };
    let stopAfterBatch = false;
    while (result.claimed < this.options.maxClaims) {
      const batch: InteractiveRunClaim[] = [];
      const capacity = Math.min(
        this.options.concurrency,
        this.options.maxClaims - result.claimed,
      );
      for (let index = 0; index < capacity; index += 1) {
        const claim = await this.store.claimNextInteractiveRun({
          ownerId: this.options.ownerId,
          authorityEpoch: this.options.authorityEpoch,
          leaseDurationMs: this.options.leaseDurationMs,
          claimedAt: this.now(),
        });
        if (!claim) break;
        batch.push(claim);
        result.claimed += 1;
      }
      if (batch.length === 0) break;
      await Promise.all(batch.map(async (claim) => {
        const handled = await this.handleWithLeaseRenewal(claim);
        const outcome = handled.outcome;
        if (outcome.kind === 'completed') {
          result.completed += 1;
          return;
        }
        if (handled.leaseRenewalFailed) {
          // Do not release through a lease whose ownership could not be
          // renewed. Its durable expiry reconciliation will classify the Run;
          // attempting a stale release would only hide the original failure.
          result.recoveryRequired += 1;
          stopAfterBatch = true;
          return;
        }
        if (outcome.kind === 'requeue') {
          await this.store.releaseRunLease({
            runId: claim.run.id,
            ownerId: claim.leaseOwner,
            fencingToken: claim.fencingToken,
            outcome: 'requeue',
            reasonCode: outcome.reasonCode,
            releasedAt: this.now(),
          });
          result.requeued += 1;
          if (outcome.retryAfterMs !== undefined) {
            result.retryAfterMs = Math.max(
              result.retryAfterMs ?? 0,
              outcome.retryAfterMs,
            );
          }
          stopAfterBatch = true;
          return;
        }
        if (outcome.kind === 'settled') {
          await this.store.releaseRunLease({
            runId: claim.run.id,
            ownerId: claim.leaseOwner,
            fencingToken: claim.fencingToken,
            outcome: 'settled',
            terminalDisposition: outcome.terminalDisposition,
            reasonCode: outcome.reasonCode,
            releasedAt: this.now(),
          });
          result.completed += 1;
          return;
        }
        await this.store.releaseRunLease({
          runId: claim.run.id,
          ownerId: claim.leaseOwner,
          fencingToken: claim.fencingToken,
          outcome: 'recovery_required',
          reasonCode: outcome.reasonCode,
          releasedAt: this.now(),
        });
        result.recoveryRequired += 1;
      }));
      if (stopAfterBatch) break;
    }
    return result;
  }

  private async handleWithLeaseRenewal(claim: InteractiveRunClaim): Promise<{
    outcome: RunDriverHandlerResult;
    leaseRenewalFailed: boolean;
  }> {
    const intervalMs = this.options.leaseRenewalIntervalMs ??
      Math.max(1, Math.floor(this.options.leaseDurationMs / 3));
    let leaseRenewalFailed = false;
    let pendingRenewal: Promise<void> = Promise.resolve();
    const timer = setInterval(() => {
      pendingRenewal = pendingRenewal.then(async () => {
        if (leaseRenewalFailed) return;
        await this.store.renewRunLease({
          runId: claim.run.id,
          ownerId: claim.leaseOwner,
          fencingToken: claim.fencingToken,
          leaseDurationMs: this.options.leaseDurationMs,
          renewedAt: this.now(),
        });
      }).catch(() => {
        leaseRenewalFailed = true;
      });
    }, intervalMs);
    timer.unref();

    let outcome: RunDriverHandlerResult;
    try {
      outcome = await this.options.handle(claim);
    } catch {
      outcome = { kind: 'recovery_required', reasonCode: 'driver_handler_failed' };
    } finally {
      clearInterval(timer);
      await pendingRenewal;
    }
    return { outcome, leaseRenewalFailed };
  }
}
