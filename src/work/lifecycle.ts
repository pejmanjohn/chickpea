import { opaqueId } from './admission.ts';
import type { SafeRuntimeModelRouteEvidence } from '../config/runtime-model.ts';
import type {
  ContentSensitivity,
  RunDisposition,
  RunExecutionId,
  RunId,
  RunRecord,
  RunExecutionRecord,
  SettleRunExecutionInput,
  WorkStore,
} from './types.ts';

interface ShadowWorkLifecycleOptions {
  store: WorkStore;
  runId: RunId;
  attemptNumber: number;
  fencingToken?: number;
  executorKind?: 'agent' | 'workflow';
  agentName: string;
  canonicalModel: string;
  sensitivity: ContentSensitivity;
  routeEvidence: SafeRuntimeModelRouteEvidence;
  /** Interactive Flue resolves inside the agent; do not claim its route early. */
  deferRoute?: boolean;
  flueInstanceRef?: string;
  now?: () => number;
  onGap?: (stage: ShadowLifecycleStage) => void;
  /** Legacy observes gaps; ledger authority must fail closed on every gap. */
  mode?: 'observe' | 'enforce';
  /** Scheduled observation waits within the outer occurrence lifecycle. */
  persistenceMode?: 'bounded' | 'durable';
  /** Outer wall-time boundary for durable observational writes. */
  deadlineAt?: number;
  /** Legacy-only budget so shadow writes cannot delay the established path. */
  observeWriteBudgetMs?: number;
  resumedExecution?: RunExecutionRecord;
}

type ShadowLifecycleStage =
  | 'prepare_input'
  | 'create_execution'
  | 'record_route'
  | 'mark_invoked'
  | 'settle_execution'
  | 'record_response'
  | 'start_delivery'
  | 'finalize_delivery';

type ShadowDeliveryOutcome = 'delivered' | 'failed' | 'unknown';

/** `deferred`: queued behind a write that outlived its budget (see observe). */
type ObservedWrite = 'recorded' | 'deferred' | false;

/**
 * How long one deferred observational write may take. The turn no longer
 * waits on it: it awaits the backlog only after its reply and cleanup.
 */
export const DEFERRED_SHADOW_WRITE_BUDGET_MS = 5_000;

/** The execution a lifecycle opens for an attempt that does not resume a saved one. */
export function shadowRunExecutionId(runId: RunId, attemptNumber: number): RunExecutionId {
  return opaqueId('execution', `${runId}:${attemptNumber}`) as RunExecutionId;
}

/**
 * Fenced lifecycle shared by both authority lanes. Legacy runs use observational
 * mode so ledger availability cannot change Slack behavior; ledger-owned Runs
 * use enforcement mode and fail closed before crossing an unrecorded boundary.
 */
export class ShadowWorkLifecycle {
  readonly executionId: RunExecutionId;
  readonly fencingToken: number;
  private readonly now: () => number;
  private usable = true;
  private executionCreated = false;
  /** Its creation is queued behind a slow write and has not landed yet. */
  private executionDeferred = false;
  private terminalDisposition: RunDisposition = 'succeeded';
  /**
   * The last observe-mode write queued behind one that outlived its budget.
   * Once a write is slow, every later stage of this attempt queues behind it
   * in order, off the turn's path. Undefined while writes keep up.
   */
  private backlog: Promise<boolean> | undefined;

  constructor(private readonly options: ShadowWorkLifecycleOptions) {
    this.now = options.now ?? Date.now;
    this.fencingToken = options.resumedExecution?.fencingToken ?? options.fencingToken ?? options.attemptNumber;
    this.executionId = options.resumedExecution?.id ?? shadowRunExecutionId(options.runId, options.attemptNumber);
  }

  get hasExecution(): boolean {
    return this.executionCreated;
  }

  /** Created, or queued to be created: later stages are recorded after it. */
  private get tracksExecution(): boolean {
    return this.executionCreated || this.executionDeferred;
  }

  /**
   * Resolves once every write deferred behind a slow one is recorded or
   * abandoned; never rejects. A legacy turn awaits it after its reply and
   * cleanup, so the Run still settles and the user never waits for it.
   */
  async settled(): Promise<void> {
    let awaited: Promise<boolean> | undefined;
    while (this.backlog !== awaited) {
      awaited = this.backlog;
      await awaited;
    }
  }

  async prepareExecution(preparedInput: string): Promise<string | undefined> {
    if (!this.usable) return undefined;
    if (this.options.resumedExecution) {
      let body: string | undefined;
      const resumed = await this.observe('prepare_input', async () => {
        const run = await this.options.store.getRun(this.options.runId);
        const content = run?.preparedInputRef ? await this.options.store.getContent(run.preparedInputRef) : undefined;
        if (!content?.body || run?.fencingToken !== this.fencingToken) {
          throw new Error('Saved execution input or ownership is unavailable.');
        }
        body = content.body;
        this.executionCreated = true;
      });
      if (resumed === 'deferred') this.executionDeferred = true;
      return body;
    }
    let preparedRun: RunRecord | undefined;
    const input = {
      runId: this.options.runId,
      sensitivity: this.options.sensitivity,
      body: preparedInput,
      preparedAt: this.now(),
    };
    const prepared = await this.observe('prepare_input', async () => {
      preparedRun = await this.options.store.prepareRunInput(input);
    });
    if (!prepared) return undefined;
    let preparedBody: string | undefined;
    // A deferred input is checked by its execution, which requires it.
    if (prepared === 'recorded') {
      const preparedContent = preparedRun?.preparedInputRef
        ? await this.options.store.getContent(preparedRun.preparedInputRef)
        : undefined;
      if (!preparedContent?.body) {
        this.usable = false;
        this.options.onGap?.('prepare_input');
        if (this.options.mode === 'enforce') {
          throw new Error('Ledger prepared input could not be read after persistence.');
        }
        return undefined;
      }
      preparedBody = preparedContent.body;
    }
    const execution = {
      id: this.executionId,
      runId: this.options.runId,
      attemptNumber: this.options.attemptNumber,
      fencingToken: this.fencingToken,
      executorKind: this.options.executorKind ?? 'agent',
      agentName: this.options.agentName,
      canonicalModel: this.options.canonicalModel,
      ...(this.options.flueInstanceRef
        ? { flueInstanceRef: this.options.flueInstanceRef }
        : {}),
      startedAt: this.now(),
    };
    const created = await this.observe(
      'create_execution',
      () => this.options.store.createRunExecution(execution),
    );
    if (!created) return undefined;
    if (created === 'recorded') this.executionCreated = true;
    else this.executionDeferred = true;
    if (!this.options.deferRoute) {
      const routeRecorded = await this.recordRoute();
      if (!routeRecorded) return undefined;
    }
    return preparedBody;
  }

  async markInvoked(): Promise<void> {
    if (!this.tracksExecution) return;
    if (!await this.recordRoute()) return;
    const input = {
      executionId: this.executionId,
      fencingToken: this.fencingToken,
      invokedAt: this.now(),
    };
    await this.observe('mark_invoked', () => this.options.store.markRunExecutionInvoked(input));
  }

  private async recordRoute(): Promise<boolean> {
    const input = {
      executionId: this.executionId,
      recordedAt: this.now(),
      ...this.options.routeEvidence,
    };
    return await this.observe(
      'record_route',
      () => this.options.store.recordRunExecutionRoute(input),
    ) !== false;
  }

  async settleExecution(input: {
    outcome: 'succeeded' | 'failed' | 'ambiguous' | 'not_submitted';
    rawStatus: string;
    safeFailureCode?: string;
    safeDisagreementCode?: string;
    flueSubmissionRef?: string;
    /** Adapter-only outcomes such as a reaction response have no model call. */
    modelInvoked?: boolean;
  }): Promise<void> {
    if (!this.tracksExecution) return;
    if (input.outcome !== 'succeeded') this.terminalDisposition = 'failed';
    const settlement: SettleRunExecutionInput = {
      executionId: this.executionId,
      fencingToken: this.fencingToken,
      outcome: input.outcome,
      modelInvocationStatus:
        input.outcome === 'not_submitted' || input.modelInvoked === false
          ? 'not_invoked'
          : 'settled',
      rawSettlementRef: opaqueId(
        'settlement',
        `${this.executionId}:${input.rawStatus}`,
      ),
      rawSettlementStatus: input.rawStatus,
      ...(input.safeFailureCode ? { safeFailureCode: input.safeFailureCode } : {}),
      ...(input.safeDisagreementCode
        ? { safeDisagreementCode: input.safeDisagreementCode }
        : {}),
      ...(input.flueSubmissionRef ? { flueSubmissionRef: input.flueSubmissionRef } : {}),
      finishedAt: this.options.resumedExecution?.finishedAt ?? this.now(),
    };
    await this.observe('settle_execution', () => this.options.store.settleRunExecution(settlement));
  }

  async beforeDelivery(input: {
    method: string;
    approvedOutput: string;
    renderedPayload: string;
  }): Promise<string | undefined> {
    if (!this.tracksExecution || !this.usable) return undefined;
    if (this.options.resumedExecution && input.method === 'slack_chat_stream_recover') {
      let attemptId: string | undefined;
      await this.observe('start_delivery', async () => {
        const run = await this.options.store.getRun(this.options.runId);
        const approved = run?.policyApprovedOutputRef
          ? await this.options.store.getContent(run.policyApprovedOutputRef) : undefined;
        if (run?.fencingToken !== this.fencingToken || run.deliveryStatus !== 'pending' ||
            !run.deliveryAttemptId || !run.deliveryMethod?.startsWith('slack_chat_stream') ||
            approved?.body !== input.approvedOutput || approved.sensitivity !== this.options.sensitivity) {
          throw new Error('Stream recovery does not match the pending approved delivery.');
        }
        // This is reconciliation of the original effect, not a new delivery.
        // Keep its immutable render and attempt until Slack confirms replacement.
        attemptId = run.deliveryAttemptId;
      });
      return attemptId;
    }
    const response = {
      runId: this.options.runId,
      executionId: this.executionId,
      fencingToken: this.fencingToken,
      sensitivity: this.options.sensitivity,
      approvedOutput: input.approvedOutput,
      renderedPayload: input.renderedPayload,
      recordedAt: this.now(),
    };
    const recorded = await this.observe(
      'record_response',
      () => this.options.store.recordRunResponse(response),
    );
    if (!recorded) return undefined;
    const attemptId = opaqueId(
      'delivery',
      `${this.executionId}:${input.method}`,
    );
    const delivery = {
      runId: this.options.runId,
      fencingToken: this.fencingToken,
      method: input.method,
      attemptId,
      startedAt: this.now(),
    };
    const started = await this.observe(
      'start_delivery',
      () => this.options.store.startRunDelivery(delivery),
    );
    return started ? attemptId : undefined;
  }

  async afterDelivery(input: {
    attemptId: string | undefined;
    outcome: ShadowDeliveryOutcome;
    deliveryRef?: string;
    terminalDisposition?: RunDisposition;
    safeFailureCode?: string;
  }): Promise<void> {
    if (!input.attemptId || !this.tracksExecution) return;
    const attemptId = input.attemptId;
    const finalization = {
      runId: this.options.runId,
      fencingToken: this.fencingToken,
      attemptId,
      outcome: input.outcome,
      ...(input.deliveryRef ? { deliveryRef: input.deliveryRef } : {}),
      ...(input.terminalDisposition
        ? { terminalDisposition: input.terminalDisposition }
        : input.outcome === 'delivered'
          ? { terminalDisposition: this.terminalDisposition }
          : {}),
      ...(input.safeFailureCode ? { safeFailureCode: input.safeFailureCode } : {}),
      finalizedAt: this.now(),
    };
    await this.observe('finalize_delivery', () => this.options.store.finalizeRunDelivery(finalization));
  }

  async settleWithoutDelivery(input: {
    terminalDisposition: 'no_op' | 'failed' | 'skipped' | 'cancelled' | 'superseded';
    safeFailureCode?: string;
  }): Promise<void> {
    if (!this.tracksExecution) return;
    const settlement = {
      runId: this.options.runId,
      fencingToken: this.fencingToken,
      terminalDisposition: input.terminalDisposition,
      ...(input.safeFailureCode ? { safeFailureCode: input.safeFailureCode } : {}),
      settledAt: this.now(),
    };
    await this.observe(
      'finalize_delivery',
      () => this.options.store.settleRunWithoutDelivery(settlement),
    );
  }

  private async observe(stage: ShadowLifecycleStage, write: () => unknown): Promise<ObservedWrite> {
    if (!this.usable) return false;
    if (this.backlog) {
      // Behind a write still in flight: keep the order, never wait for it.
      this.defer(stage, write);
      return 'deferred';
    }
    try {
      if (this.options.persistenceMode === 'durable' && this.options.deadlineAt !== undefined) {
        const remainingMs = this.options.deadlineAt - this.now();
        const recorded = remainingMs > 0 && await withinBudget(write(), remainingMs);
        if (!recorded) throw new Error('durable_write_deadline_exceeded');
      } else if (this.options.mode === 'enforce') {
        await write();
      } else if (this.options.persistenceMode === 'durable') {
        await write();
      } else {
        // A store reached over RPC (a thread runner's) can outlive the budget
        // and still land. The turn stops waiting for it, but its outcome and
        // every later stage are still recorded, in order, behind it: a slow
        // write is not a gap, or the Run would never settle.
        const attempt = Promise.resolve(write());
        const outcome = await settleWithin(
          attempt,
          boundedObserveBudget(this.options.observeWriteBudgetMs),
        );
        if (outcome === 'rejected') throw new Error('shadow_write_failed');
        if (outcome === 'pending') {
          console.warn(`[work] shadow lifecycle write at ${stage} outlived its budget; recording continues behind it`);
          this.defer(stage, () => attempt);
          return 'deferred';
        }
      }
      return 'recorded';
    } catch (error) {
      this.usable = false;
      this.options.onGap?.(stage);
      if (this.options.mode === 'enforce') throw error;
      this.warnGap(stage);
      return false;
    }
  }

  /** Queue one observe-mode write behind the backlog (see settled). */
  private defer(stage: ShadowLifecycleStage, write: () => unknown): void {
    this.backlog = (this.backlog ?? Promise.resolve(true)).then(async (keptUp) => {
      if (!keptUp || !this.usable) return false;
      if (await withinBudget(Promise.resolve().then(write), DEFERRED_SHADOW_WRITE_BUDGET_MS)) {
        return true;
      }
      this.usable = false;
      this.options.onGap?.(stage);
      this.warnGap(stage);
      return false;
    });
  }

  private warnGap(stage: ShadowLifecycleStage): void {
    if (this.options.persistenceMode !== 'durable') {
      console.warn(`[work] shadow lifecycle gap at ${stage}; legacy execution will continue`);
    }
  }
}

async function withinBudget(value: unknown, budgetMs: number): Promise<boolean> {
  // Cloudflare's in-isolate SQLite store is synchronous, so its write has
  // already completed here. Promise normalization keeps that valid local
  // store compatible; the timer bounds only genuinely asynchronous writes.
  return await settleWithin(Promise.resolve(value), budgetMs) === 'fulfilled';
}

async function settleWithin(
  value: Promise<unknown>,
  budgetMs: number,
): Promise<'fulfilled' | 'rejected' | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value.then(() => 'fulfilled' as const, () => 'rejected' as const),
      new Promise<'pending'>((resolve) => {
        timer = setTimeout(() => resolve('pending'), budgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function boundedObserveBudget(value: number | undefined): number {
  if (value === undefined) return 100;
  return Number.isFinite(value) ? Math.max(1, Math.min(250, Math.floor(value))) : 100;
}
