import { opaqueId } from './admission.ts';
import type { SafeRuntimeModelRouteEvidence } from '../config/runtime-model.ts';
import type {
  ContentSensitivity,
  RunDisposition,
  RunExecutionId,
  RunId,
  RunRecord,
  WorkStore,
} from './types.ts';

export interface ShadowWorkLifecycleOptions {
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
  /** Legacy-only budget so shadow writes cannot delay the established path. */
  observeWriteBudgetMs?: number;
}

export type ShadowLifecycleStage =
  | 'prepare_input'
  | 'create_execution'
  | 'record_route'
  | 'mark_invoked'
  | 'settle_execution'
  | 'record_response'
  | 'start_delivery'
  | 'finalize_delivery';

export type ShadowDeliveryOutcome = 'delivered' | 'failed' | 'unknown';

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
  private terminalDisposition: RunDisposition = 'succeeded';

  constructor(private readonly options: ShadowWorkLifecycleOptions) {
    this.now = options.now ?? Date.now;
    this.fencingToken = options.fencingToken ?? options.attemptNumber;
    this.executionId = shadowRunExecutionId(options.runId, options.attemptNumber);
  }

  get hasExecution(): boolean {
    return this.executionCreated;
  }

  async prepareExecution(preparedInput: string): Promise<string | undefined> {
    if (!this.usable) return undefined;
    let preparedRun: RunRecord | undefined;
    if (!await this.observe('prepare_input', async () => {
      preparedRun = await this.options.store.prepareRunInput({
        runId: this.options.runId,
        sensitivity: this.options.sensitivity,
        body: preparedInput,
        preparedAt: this.now(),
      });
    })) return undefined;
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
    if (!await this.observe('create_execution', () => this.options.store.createRunExecution({
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
    }))) return undefined;
    this.executionCreated = true;
    if (!this.options.deferRoute) {
      const routeRecorded = await this.recordRoute();
      if (!routeRecorded) return undefined;
    }
    return preparedContent.body;
  }

  async markInvoked(): Promise<void> {
    if (!this.executionCreated) return;
    if (!await this.recordRoute()) return;
    await this.observe('mark_invoked', () => this.options.store.markRunExecutionInvoked({
      executionId: this.executionId,
      fencingToken: this.fencingToken,
      invokedAt: this.now(),
    }));
  }

  private async recordRoute(): Promise<boolean> {
    return this.observe('record_route', () => this.options.store.recordRunExecutionRoute({
      executionId: this.executionId,
      recordedAt: this.now(),
      ...this.options.routeEvidence,
    }));
  }

  async settleExecution(input: {
    outcome: 'succeeded' | 'failed' | 'ambiguous' | 'not_submitted';
    rawStatus: string;
    safeFailureCode?: string;
    safeDisagreementCode?: string;
    flueSubmissionRef?: string;
  }): Promise<void> {
    if (!this.executionCreated) return;
    if (input.outcome !== 'succeeded') this.terminalDisposition = 'failed';
    await this.observe('settle_execution', () => this.options.store.settleRunExecution({
      executionId: this.executionId,
      fencingToken: this.fencingToken,
      outcome: input.outcome,
      modelInvocationStatus: input.outcome === 'not_submitted' ? 'not_invoked' : 'settled',
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
      finishedAt: this.now(),
    }));
  }

  async beforeDelivery(input: {
    method: string;
    approvedOutput: string;
    renderedPayload: string;
  }): Promise<string | undefined> {
    if (!this.executionCreated || !this.usable) return undefined;
    const recorded = await this.observe('record_response', () =>
      this.options.store.recordRunResponse({
        runId: this.options.runId,
        executionId: this.executionId,
        fencingToken: this.fencingToken,
        sensitivity: this.options.sensitivity,
        approvedOutput: input.approvedOutput,
        renderedPayload: input.renderedPayload,
        recordedAt: this.now(),
      })
    );
    if (!recorded) return undefined;
    const attemptId = opaqueId(
      'delivery',
      `${this.executionId}:${input.method}`,
    );
    const started = await this.observe('start_delivery', () =>
      this.options.store.startRunDelivery({
        runId: this.options.runId,
        fencingToken: this.fencingToken,
        method: input.method,
        attemptId,
        startedAt: this.now(),
      })
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
    if (!input.attemptId || !this.executionCreated) return;
    const attemptId = input.attemptId;
    await this.observe('finalize_delivery', () => this.options.store.finalizeRunDelivery({
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
    }));
  }

  async settleWithoutDelivery(input: {
    terminalDisposition: 'no_op' | 'failed' | 'skipped' | 'cancelled' | 'superseded';
    safeFailureCode?: string;
  }): Promise<void> {
    if (!this.executionCreated) return;
    await this.observe('finalize_delivery', () => this.options.store.settleRunWithoutDelivery({
      runId: this.options.runId,
      fencingToken: this.fencingToken,
      terminalDisposition: input.terminalDisposition,
      ...(input.safeFailureCode ? { safeFailureCode: input.safeFailureCode } : {}),
      settledAt: this.now(),
    }));
  }

  private async observe(stage: ShadowLifecycleStage, write: () => Promise<unknown>): Promise<boolean> {
    if (!this.usable) return false;
    try {
      if (this.options.mode === 'enforce') {
        await write();
      } else {
        const recorded = await withinBudget(
          write(),
          boundedObserveBudget(this.options.observeWriteBudgetMs),
        );
        if (!recorded) throw new Error('shadow_write_budget_exceeded');
      }
      return true;
    } catch (error) {
      this.usable = false;
      this.options.onGap?.(stage);
      if (this.options.mode === 'enforce') throw error;
      console.warn(`[work] shadow lifecycle gap at ${stage}; legacy execution will continue`);
      return false;
    }
  }
}

async function withinBudget(value: unknown, budgetMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Cloudflare's in-isolate SQLite store is synchronous, so its write has
    // already completed here. Promise normalization keeps that valid local
    // store compatible; the timer bounds only genuinely asynchronous writes.
    return await Promise.race([
      Promise.resolve(value).then(() => true, () => false),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), budgetMs);
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
