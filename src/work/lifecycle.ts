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

/**
 * What became of one observe-mode stage when the turn moved on: `deferred` is
 * queued behind a write that outlived its budget (see observe); `gap` was not
 * recorded, because this stage or an earlier one is a gap.
 */
type ObservedWrite = 'recorded' | 'deferred' | 'gap';

/**
 * How long one deferred observational write may take, and one read the turn
 * needs, its wait behind deferred writes included. The turn never waits on a
 * deferred write: it awaits the backlog only after its reply and cleanup.
 */
export const DEFERRED_SHADOW_WRITE_BUDGET_MS = 5_000;

/**
 * How long a finished turn waits, in all, for the writes deferred behind a
 * slow one. The thread's next message waits behind the turn, so whatever is
 * still unrecorded then is a gap.
 */
export const SHADOW_BACKLOG_DEADLINE_MS = 10_000;

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
  /** Its creation was queued behind a slow write (and may not have landed yet). */
  private executionDeferred = false;
  private terminalDisposition: RunDisposition = 'succeeded';
  /**
   * The last observe-mode write queued behind one that outlived its budget.
   * Once a write is slow, every later stage of this attempt queues behind it
   * in order, off the turn's path. Undefined while writes keep up.
   */
  private backlog: Promise<boolean> | undefined;
  /** Ends the deferred write in flight once the backlog is past its deadline. */
  private stopBacklog!: () => void;
  private readonly backlogStopped = new Promise<void>((resolve) => { this.stopBacklog = resolve; });
  /** Waiting for a creation queued behind a slow write (see whenExecutionRecorded). */
  private readonly executionWaiters: Array<(executionId: RunExecutionId) => void> = [];

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

  /** Only the legacy observer's writes are raced against a budget and can be deferred. */
  private get bounded(): boolean {
    return this.options.mode !== 'enforce' && this.options.persistenceMode !== 'durable';
  }

  /**
   * Hands `use` this attempt's execution once it is recorded: at once, or when
   * a creation queued behind a slow write lands. A creation that never lands
   * is never handed out, so nothing comes to name an execution that does not
   * exist.
   */
  whenExecutionRecorded(use: (executionId: RunExecutionId) => void): void {
    if (this.executionCreated) use(this.executionId);
    else if (this.executionDeferred && this.usable) this.executionWaiters.push(use);
  }

  /**
   * Resolves once every write deferred behind a slow one is recorded or
   * abandoned, within SHADOW_BACKLOG_DEADLINE_MS; never rejects. A legacy turn
   * awaits it after its reply and cleanup, so the Run still settles and the
   * user never waits for it. Past the deadline the write in flight is a gap,
   * and nothing behind it is recorded.
   */
  async settled(): Promise<void> {
    if (!this.backlog) return;
    if (await settleWithin(this.drainBacklog(), SHADOW_BACKLOG_DEADLINE_MS) !== 'pending') return;
    // The write in flight records the gap as it stops; the rest then skip.
    this.stopBacklog();
    await this.drainBacklog();
  }

  private async drainBacklog(): Promise<void> {
    let awaited: Promise<boolean> | undefined;
    while (this.backlog !== awaited) {
      awaited = this.backlog;
      await awaited;
    }
  }

  async prepareExecution(preparedInput: string): Promise<string | undefined> {
    if (!this.usable) return undefined;
    if (this.options.resumedExecution) {
      const body = await this.observeRead('prepare_input', async () => {
        const run = await this.options.store.getRun(this.options.runId);
        const content = run?.preparedInputRef ? await this.options.store.getContent(run.preparedInputRef) : undefined;
        if (!content?.body || run?.fencingToken !== this.fencingToken) {
          throw new Error('Saved execution input or ownership is unavailable.');
        }
        return content.body;
      });
      if (body !== undefined) this.executionRecorded();
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
    if (prepared === 'gap') return undefined;
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
    const created = await this.observe('create_execution', async () => {
      await this.options.store.createRunExecution(execution);
      this.executionRecorded();
    });
    if (created === 'gap') return undefined;
    if (created === 'deferred') this.executionDeferred = true;
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
    ) !== 'gap';
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
      return this.observeRead('start_delivery', async () => {
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
        return run.deliveryAttemptId;
      });
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
    if (recorded === 'gap') return undefined;
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
    return started === 'gap' ? undefined : attemptId;
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

  private executionRecorded(): void {
    this.executionCreated = true;
    for (const use of this.executionWaiters.splice(0)) use(this.executionId);
  }

  /**
   * A read whose result the turn needs (a resumed attempt's saved input, a
   * stream recovery's pending delivery). It is never deferred, or the turn
   * would go on without its result: it waits for the writes deferred before
   * it, then reads, all within DEFERRED_SHADOW_WRITE_BUDGET_MS, and is a gap
   * past that. A store that keeps up answers it as quickly as before.
   */
  private async observeRead<T>(stage: ShadowLifecycleStage, read: () => Promise<T>): Promise<T | undefined> {
    if (!this.usable) return undefined;
    let value: T | undefined;
    if (!this.bounded) {
      const observed = await this.observe(stage, async () => { value = await read(); });
      return observed === 'recorded' ? value : undefined;
    }
    const behind = this.backlog;
    const outcome = await settleWithin((async () => {
      // A write before it that is a gap has recorded that gap already.
      if (behind && !await behind) return;
      value = await read();
    })(), DEFERRED_SHADOW_WRITE_BUDGET_MS);
    if (outcome === 'fulfilled') return value;
    this.recordGap(stage);
    return undefined;
  }

  private async observe(stage: ShadowLifecycleStage, write: () => unknown): Promise<ObservedWrite> {
    if (!this.usable) return 'gap';
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
      return 'gap';
    }
  }

  /** Queue one observe-mode write behind the backlog (see settled). */
  private defer(stage: ShadowLifecycleStage, write: () => unknown): void {
    this.backlog = (this.backlog ?? Promise.resolve(true)).then(async (keptUp) => {
      if (!keptUp || !this.usable) return false;
      const outcome = await settleWithin(
        Promise.resolve().then(write),
        DEFERRED_SHADOW_WRITE_BUDGET_MS,
        this.backlogStopped,
      );
      if (outcome === 'fulfilled') return true;
      this.recordGap(stage);
      return false;
    });
  }

  /** The first gap of an attempt; nothing after it is recorded or reported again. */
  private recordGap(stage: ShadowLifecycleStage): void {
    if (!this.usable) return;
    this.usable = false;
    this.options.onGap?.(stage);
    this.warnGap(stage);
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

/** `stop`, once it resolves, ends the wait early, as the budget would. */
async function settleWithin(
  value: Promise<unknown>,
  budgetMs: number,
  stop?: Promise<void>,
): Promise<'fulfilled' | 'rejected' | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value.then(() => 'fulfilled' as const, () => 'rejected' as const),
      new Promise<'pending'>((resolve) => {
        timer = setTimeout(() => resolve('pending'), budgetMs);
      }),
      ...(stop ? [stop.then(() => 'pending' as const)] : []),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function boundedObserveBudget(value: number | undefined): number {
  if (value === undefined) return 100;
  return Number.isFinite(value) ? Math.max(1, Math.min(250, Math.floor(value))) : 100;
}
