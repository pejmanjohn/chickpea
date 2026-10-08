import type { AgentDispatchResult } from '../slack/flue-dispatch.ts';
import type { CodingWorkerUsageRecord } from '../slack/coding-worker-run.ts';
import { slackTimestampMs } from '../slack/timestamp.ts';
import type { NormalizedSlackTurn } from '../slack/types.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { usageInstallationId } from './model-requests.ts';
import type { AgentModelAttribution, ResolvedAssignment } from '../config/types.ts';
import type {
  AdmitUsageOperationInput,
  RecordUsageTerminalInput,
  UsageStore,
  UsageConversationKind,
  UsageUnknownReason,
  UsageTerminalStatus,
} from './types.ts';
import {
  estimateUsage,
  notPriced,
  usageEstimatesEnabled,
} from './pricing/estimate.ts';

const DEFAULT_USAGE_WRITE_BUDGET_MS = 100;

type UsagePersistenceMode = 'bounded' | 'durable';
type UsagePersistencePhase = 'admission' | 'terminal' | 'repair';
type UsagePersistenceOutcome = 'recorded' | 'timed_out' | 'failed';

export interface UsagePersistenceEvent {
  phase: UsagePersistencePhase;
  outcome: UsagePersistenceOutcome;
  executionId: string;
}

interface InteractiveUsageRecorderOptions {
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  requestedModel: string | null;
  operationId: string;
  executionId: string;
  runId?: string;
  runExecutionId?: string;
  store: UsageStore;
  platformEnv?: PlatformEnv;
  processEnv?: NodeJS.ProcessEnv;
  writeBudgetMs?: number;
  now?: () => number;
  onPersistence?: (event: UsagePersistenceEvent) => void;
  /** A saved Flue settlement is being delivered again, not a new model call. */
  replaySettlementAt?: number;
}

export class InteractiveUsageRecorder {
  private readonly admission: AdmitUsageOperationInput;
  private readonly budgetMs: number;
  private readonly now: () => number;
  private terminalInput: RecordUsageTerminalInput | undefined;
  /** Coding workers' measurements, written before the Agent's own. */
  private workerTerminals: RecordUsageTerminalInput[] = [];
  private repairAttempted = false;
  private needsRepair = false;
  private runExecutionId: string | undefined;

  constructor(private readonly options: InteractiveUsageRecorderOptions) {
    this.now = options.now ?? Date.now;
    this.budgetMs = boundedBudget(options.writeBudgetMs);
    this.runExecutionId = options.runExecutionId;
    const requested = splitModelSpecifier(options.requestedModel);
    const direct = options.turn.source === 'dm_message' || options.turn.channelType === 'im';
    this.admission = {
      operationId: options.operationId,
      operationKind: 'interactive_turn',
      sourceId: options.operationId,
      ...(options.runId ? { runId: options.runId } : {}),
      startedAt: slackTimestampMs(options.turn.messageTs) ?? this.now(),
      installationId: usageInstallationId(options.platformEnv, options.processEnv),
      workspaceId: options.turn.workspaceId,
      agentId: options.assignment.agentId,
      agentLabel: options.assignment.agent.name,
      channelId: options.turn.channelId,
      channelLabel: direct ? null : (options.assignment.channelLabel ?? options.turn.channelId),
      conversationKind: direct ? 'direct_message' : 'named_channel',
      requesterMembershipId: options.turn.actorMembershipId ?? null,
      executionPrincipalId: options.assignment.agentId,
      ...modelPolicyUsage(options.assignment.modelAttribution),
      requestedProvider: requested.provider,
      requestedModel: requested.model,
      credentialRefId: options.assignment.modelCredential?.credentialRefId ?? null,
      credentialVersion: options.assignment.modelCredential?.version ?? null,
    };
  }

  async admit(): Promise<void> {
    const outcome = await this.persist(
      'admission',
      () => this.options.store.admitOperation(this.admission),
    );
    this.needsRepair ||= outcome !== 'recorded';
  }

  linkRunExecution(runExecutionId: string): void {
    if (!this.terminalInput) this.runExecutionId = runExecutionId;
  }

  async recordSuccess(result: AgentDispatchResult): Promise<void> {
    if (this.terminalInput) return;
    const returned = result.returnedModel;
    const usage = result.reportedUsage;
    const unknownReason: UsageUnknownReason | null = result.usageCompleteness === 'complete'
      ? null
      : result.usageCompleteness === 'partial'
        ? 'usage_partial'
        : 'usage_not_reported';
    const terminal = this.baseTerminal({
      status: 'completed',
      providerRoute: returned?.provider ?? this.admission.requestedProvider,
      returnedProvider: returned?.provider ?? null,
      returnedModel: returned?.id ?? null,
      usageCompleteness: result.usageCompleteness,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      cacheReadTokens: usage?.cacheReadTokens ?? null,
      cacheWriteTokens: usage?.cacheWriteTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
      usageUnknownReason: unknownReason,
    }, usage?.cacheWrite1hTokens ?? null);
    this.terminalInput = terminal;
    this.workerTerminals = (result.codingWorkerUsage ?? []).map((record, index) =>
      this.codingWorkerTerminal(record, index, terminal.finishedAt));
    await this.persistTerminal();
  }

  async recordFailure(reason: UsageUnknownReason = 'provider_request_unknown'): Promise<void> {
    if (this.terminalInput) return;
    this.terminalInput = this.baseTerminal({
      status: 'failed',
      providerRoute: this.admission.requestedProvider,
      returnedProvider: null,
      returnedModel: null,
      usageCompleteness: 'not_reported',
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
      usageUnknownReason: reason,
    });
    await this.persistTerminal();
  }

  /**
   * A person stopped the run (KTD3): Flue's aborted settlement reports no
   * usage, and the operation reads as interrupted, never as failed.
   */
  async recordStopped(): Promise<void> {
    if (this.terminalInput) return;
    this.terminalInput = this.baseTerminal({
      status: 'interrupted',
      providerRoute: this.admission.requestedProvider,
      returnedProvider: null,
      returnedModel: null,
      usageCompleteness: 'not_reported',
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
      usageUnknownReason: 'stream_interrupted',
    });
    await this.persistTerminal();
  }

  async repairAfterDelivery(): Promise<void> {
    if (!this.terminalInput || !this.needsRepair || this.repairAttempted) return;
    this.repairAttempted = true;
    const outcome = await this.persist('repair', async () => {
      await this.options.store.admitOperation(this.admission);
      await this.writeTerminal();
    });
    if (outcome === 'recorded') this.needsRepair = false;
  }

  private async persistTerminal(): Promise<void> {
    const outcome = await this.persist(
      'terminal',
      () => this.writeTerminal(),
    );
    this.needsRepair ||= outcome !== 'recorded';
  }

  private async writeTerminal(): Promise<unknown> {
    if (this.options.replaySettlementAt !== undefined) {
      const detail = await this.options.store.getOperation(this.admission.operationId);
      // Preserve observation identity. The store still rejects changed usage,
      // model, credential, or explicitly supplied execution linkage.
      const preserve = (terminal: RecordUsageTerminalInput): RecordUsageTerminalInput => {
        const original = detail?.measurements.find((row) => row.executionId === terminal.executionId);
        return original
          ? {
              ...terminal,
              observedAt: original.observedAt,
              finishedAt: original.observedAt,
              runExecutionId: this.runExecutionId ?? original.runExecutionId ?? null,
            }
          : terminal;
      };
      this.workerTerminals = this.workerTerminals.map(preserve);
      this.terminalInput = preserve(this.terminalInput!);
    }
    // Workers first: the operation takes its status from the last measurement,
    // and that is the Agent's own outcome.
    for (const terminal of this.workerTerminals) await this.options.store.recordTerminal(terminal);
    return this.options.store.recordTerminal(this.terminalInput!);
  }

  /**
   * One coding worker's usage as its own measurement on this turn's
   * operation, under the coding model. Its execution id derives from the
   * turn's, so a replayed settlement writes the same measurement, never a
   * second. It is observed when the task settled, clamped to before the
   * Agent's own measurement: a view that shows a turn's latest measurement
   * then names the Agent's model.
   */
  private codingWorkerTerminal(
    record: CodingWorkerUsageRecord,
    index: number,
    agentFinishedAt: number,
  ): RecordUsageTerminalInput {
    const finishedAt = Math.max(
      this.admission.startedAt,
      Math.min(record.settledAt, agentFinishedAt - 1),
    );
    const requested = splitModelSpecifier(record.model);
    const usage = record.usage && record.usage.totalTokens > 0 ? record.usage : undefined;
    // The turn's credential is attributed only when it is for the same provider.
    const credential = this.options.assignment.modelCredential?.providerId === requested.provider
      ? this.options.assignment.modelCredential
      : undefined;
    const terminal = {
      operationId: this.admission.operationId,
      executionId: `${this.options.executionId}:coding:${index + 1}`,
      ...(this.runExecutionId ? { runExecutionId: this.runExecutionId } : {}),
      status: record.status,
      finishedAt,
      observedAt: finishedAt,
      providerRoute: record.returnedModel?.provider ?? requested.provider,
      requestedProvider: requested.provider,
      requestedModel: requested.model,
      returnedProvider: record.returnedModel?.provider ?? null,
      returnedModel: record.returnedModel?.id ?? null,
      credentialRefId: credential?.credentialRefId ?? null,
      credentialVersion: credential?.version ?? null,
      usageCompleteness: usage ? 'complete' as const : 'not_reported' as const,
      inputTokens: usage?.input ?? null,
      outputTokens: usage?.output ?? null,
      cacheReadTokens: usage?.cacheRead ?? null,
      cacheWriteTokens: usage?.cacheWrite ?? null,
      totalTokens: usage?.totalTokens ?? null,
      usageUnknownReason: usage
        ? null
        : record.status === 'completed'
          ? 'usage_not_reported' as const
          : record.status === 'interrupted'
            ? 'stream_interrupted' as const
            : 'provider_request_unknown' as const,
    };
    return {
      ...terminal,
      ...estimateForRuntime(
        { ...terminal, cacheWrite1hTokens: usage?.cacheWrite1h ?? null },
        this.options.platformEnv,
        this.options.processEnv,
      ),
    };
  }

  private async persist(
    phase: UsagePersistencePhase,
    write: () => Promise<unknown>,
  ): Promise<UsagePersistenceOutcome> {
    return persistUsage(
      write,
      this.budgetMs,
      {
        phase,
        executionId: this.options.executionId,
        onPersistence: this.options.onPersistence,
      },
    );
  }

  private baseTerminal(
    fields: Pick<
      RecordUsageTerminalInput,
      | 'status'
      | 'providerRoute'
      | 'returnedProvider'
      | 'returnedModel'
      | 'usageCompleteness'
      | 'inputTokens'
      | 'outputTokens'
      | 'cacheReadTokens'
      | 'cacheWriteTokens'
      | 'totalTokens'
      | 'usageUnknownReason'
    >,
    cacheWrite1hTokens: number | null = null,
  ): RecordUsageTerminalInput {
    const finishedAt = this.options.replaySettlementAt ?? this.now();
    const terminal = {
      operationId: this.admission.operationId,
      executionId: this.options.executionId,
      ...(this.runExecutionId
        ? { runExecutionId: this.runExecutionId }
        : {}),
      finishedAt,
      observedAt: finishedAt,
      requestedProvider: this.admission.requestedProvider,
      requestedModel: this.admission.requestedModel,
      credentialRefId: this.admission.credentialRefId,
      credentialVersion: this.admission.credentialVersion,
      ...fields,
    };
    return {
      ...terminal,
      ...estimateForRuntime(
        { ...terminal, cacheWrite1hTokens },
        this.options.platformEnv,
        this.options.processEnv,
      ),
    };
  }
}

interface RoutineUsageRecorderOptions {
  operationId: string;
  executionId: string;
  runId?: string;
  runExecutionId?: string;
  startedAt: number;
  workspaceId: string;
  channelId: string;
  channelLabel?: string | null;
  conversationKind?: UsageConversationKind;
  agentId: string | null;
  agentLabel: string | null;
  routineId: string;
  routineLabel: string;
  requestedModel: string | null;
  requesterMembershipId?: string | null;
  executionPrincipalId?: string | null;
  modelAttribution?: AgentModelAttribution;
  credentialRefId: string | null;
  credentialVersion: number | null;
  store: UsageStore;
  platformEnv?: PlatformEnv;
  processEnv?: NodeJS.ProcessEnv;
  writeBudgetMs?: number;
  persistenceMode?: UsagePersistenceMode;
  replaySettlementAt?: number;
  /** Outer occurrence wall-time boundary for durable owner writes. */
  deadlineAt?: number;
  now?: () => number;
  onPersistence?: (event: UsagePersistenceEvent) => void;
}

interface RoutineReportedUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  totalTokens: number;
}

interface InteractionUsageRecorderOptions {
  operationId: string;
  executionId: string;
  runId?: string;
  runExecutionId?: string;
  startedAt: number;
  workspaceId: string;
  channelId: string;
  channelLabel?: string;
  conversationKind?: UsageConversationKind;
  agentId: string | null;
  agentLabel: string | null;
  requestedModel: string | null;
  requesterMembershipId?: string | null;
  executionPrincipalId?: string | null;
  modelAttribution?: AgentModelAttribution;
  credentialRefId: string | null;
  credentialVersion: number | null;
  store: UsageStore;
  platformEnv?: PlatformEnv;
  processEnv?: NodeJS.ProcessEnv;
  writeBudgetMs?: number;
  now?: () => number;
  onPersistence?: (event: UsagePersistenceEvent) => void;
}

interface InteractionReportedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
  totalTokens: number;
}

/** A classifier call's reported usage as the recorder takes it; null when a count is missing. */
export function interactionReportedUsage(
  reported: AgentDispatchResult['reportedUsage'] | undefined,
): InteractionReportedUsage | null {
  if (
    !reported ||
    reported.inputTokens === null ||
    reported.outputTokens === null ||
    reported.totalTokens === null
  ) return null;
  return {
    inputTokens: reported.inputTokens,
    outputTokens: reported.outputTokens,
    cacheReadTokens: reported.cacheReadTokens ?? 0,
    cacheWriteTokens: reported.cacheWriteTokens ?? 0,
    ...(reported.cacheWrite1hTokens ? { cacheWrite1hTokens: reported.cacheWrite1hTokens } : {}),
    totalTokens: reported.totalTokens,
  };
}

export class InteractionUsageRecorder {
  private readonly admission: AdmitUsageOperationInput;
  private readonly budgetMs: number;
  private readonly now: () => number;
  private terminalInput: RecordUsageTerminalInput | undefined;
  private repairAttempted = false;
  private needsRepair = false;
  private runExecutionId: string | undefined;

  constructor(private readonly options: InteractionUsageRecorderOptions) {
    this.now = options.now ?? Date.now;
    this.budgetMs = boundedBudget(options.writeBudgetMs);
    this.runExecutionId = options.runExecutionId;
    const requested = splitModelSpecifier(options.requestedModel);
    this.admission = {
      operationId: options.operationId,
      operationKind: 'interaction_classification',
      sourceId: options.operationId,
      ...(options.runId ? { runId: options.runId } : {}),
      startedAt: options.startedAt,
      installationId: usageInstallationId(options.platformEnv, options.processEnv),
      workspaceId: options.workspaceId,
      agentId: options.agentId,
      agentLabel: options.agentLabel,
      channelId: options.channelId,
      channelLabel: options.channelLabel ?? options.channelId,
      conversationKind: options.conversationKind ?? 'named_channel',
      requesterMembershipId: options.requesterMembershipId ?? null,
      executionPrincipalId: options.executionPrincipalId ?? options.agentId,
      ...modelPolicyUsage(options.modelAttribution),
      requestedProvider: requested.provider,
      requestedModel: requested.model,
      credentialRefId: options.credentialRefId,
      credentialVersion: options.credentialVersion,
    };
  }

  async admit(): Promise<void> {
    const outcome = await persistUsage(
      () => this.options.store.admitOperation(this.admission),
      this.budgetMs,
      {
        phase: 'admission',
        executionId: this.options.executionId,
        onPersistence: this.options.onPersistence,
      },
    );
    this.needsRepair ||= outcome !== 'recorded';
  }

  linkRunExecution(runExecutionId: string): void {
    if (!this.terminalInput) this.runExecutionId = runExecutionId;
  }

  async recordTerminal(input: {
    status: UsageTerminalStatus;
    usage?: InteractionReportedUsage | null;
    returnedModel?: { provider: string; id: string } | null;
    unknownReason?: UsageUnknownReason;
  }): Promise<void> {
    if (this.terminalInput) return;
    const usage = normalizeInteractionUsage(input.usage ?? null);
    const finishedAt = this.now();
    const terminal = {
      operationId: this.admission.operationId,
      executionId: this.options.executionId,
      ...(this.runExecutionId ? { runExecutionId: this.runExecutionId } : {}),
      status: input.status,
      finishedAt,
      observedAt: finishedAt,
      providerRoute: input.returnedModel?.provider ?? this.admission.requestedProvider,
      requestedProvider: this.admission.requestedProvider,
      requestedModel: this.admission.requestedModel,
      returnedProvider: input.returnedModel?.provider ?? null,
      returnedModel: input.returnedModel?.id ?? null,
      credentialRefId: this.admission.credentialRefId,
      credentialVersion: this.admission.credentialVersion,
      usageCompleteness: usage ? 'complete' as const : 'not_reported' as const,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      cacheReadTokens: usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
      totalTokens: usage?.totalTokens ?? null,
      usageUnknownReason: usage ? null : (input.unknownReason ?? 'usage_not_reported'),
    };
    this.terminalInput = {
      ...terminal,
      ...estimateForRuntime(
        { ...terminal, cacheWrite1hTokens: usage?.cacheWrite1hTokens ?? null },
        this.options.platformEnv,
        this.options.processEnv,
      ),
    };
    const outcome = await persistUsage(
      () => this.options.store.recordTerminal(this.terminalInput!),
      this.budgetMs,
      {
        phase: 'terminal',
        executionId: this.options.executionId,
        onPersistence: this.options.onPersistence,
      },
    );
    this.needsRepair ||= outcome !== 'recorded';
  }

  async repairAfterTerminal(): Promise<void> {
    if (!this.terminalInput || !this.needsRepair || this.repairAttempted) return;
    this.repairAttempted = true;
    const outcome = await persistUsage(
      async () => {
        await this.options.store.admitOperation(this.admission);
        await this.options.store.recordTerminal(this.terminalInput!);
      },
      this.budgetMs,
      {
        phase: 'repair',
        executionId: this.options.executionId,
        onPersistence: this.options.onPersistence,
      },
    );
    if (outcome === 'recorded') this.needsRepair = false;
  }
}

export class RoutineUsageRecorder {
  private readonly admission: AdmitUsageOperationInput;
  private readonly budgetMs: number;
  private readonly now: () => number;
  private readonly persistenceMode: UsagePersistenceMode;
  private terminalInput: RecordUsageTerminalInput | undefined;
  private repairAttempted = false;
  private needsRepair = false;
  private runExecutionId: string | undefined;

  constructor(private readonly options: RoutineUsageRecorderOptions) {
    this.now = options.now ?? Date.now;
    this.budgetMs = boundedBudget(options.writeBudgetMs);
    this.persistenceMode = options.persistenceMode ?? 'bounded';
    this.runExecutionId = options.runExecutionId;
    const requested = splitModelSpecifier(options.requestedModel);
    this.admission = {
      operationId: options.operationId,
      operationKind: 'routine_run',
      sourceId: options.operationId,
      ...(options.runId ? { runId: options.runId } : {}),
      startedAt: options.startedAt,
      installationId: usageInstallationId(options.platformEnv, options.processEnv),
      workspaceId: options.workspaceId,
      agentId: options.agentId,
      agentLabel: options.agentLabel,
      channelId: options.channelId,
      channelLabel: options.channelLabel === undefined ? options.channelId : options.channelLabel,
      conversationKind: options.conversationKind ?? 'named_channel',
      routineId: options.routineId,
      routineLabel: options.routineLabel,
      routineRunId: options.operationId,
      requesterMembershipId: options.requesterMembershipId ?? null,
      executionPrincipalId: options.executionPrincipalId ?? options.agentId,
      ...modelPolicyUsage(options.modelAttribution),
      requestedProvider: requested.provider,
      requestedModel: requested.model,
      credentialRefId: options.credentialRefId,
      credentialVersion: options.credentialVersion,
    };
  }

  async admit(): Promise<void> {
    const outcome = await persistUsage(
      () => this.options.store.admitOperation(this.admission),
      this.budgetMs,
      {
        phase: 'admission',
        executionId: this.options.executionId,
        onPersistence: this.options.onPersistence,
        mode: this.persistenceMode,
        deadlineAt: this.options.deadlineAt,
        now: this.now,
      },
    );
    this.needsRepair ||= outcome !== 'recorded';
  }

  linkRunExecution(runExecutionId: string): void {
    if (!this.terminalInput) this.runExecutionId = runExecutionId;
  }

  async recordTerminal(input: {
    status: UsageTerminalStatus;
    usage?: RoutineReportedUsage | null;
    returnedModel?: { provider: string; id: string } | null;
    unknownReason?: UsageUnknownReason;
  }): Promise<void> {
    if (this.terminalInput) return;
    const usage = normalizeRoutineUsage(input.usage ?? null);
    const usageCompleteness: RecordUsageTerminalInput['usageCompleteness'] = usage
      ? 'complete'
      : 'not_reported';
    const finishedAt = this.options.replaySettlementAt ?? this.now();
    const terminal = {
      operationId: this.admission.operationId,
      executionId: this.options.executionId,
      ...(this.runExecutionId
        ? { runExecutionId: this.runExecutionId }
        : {}),
      status: input.status,
      finishedAt,
      observedAt: finishedAt,
      providerRoute: input.returnedModel?.provider ?? this.admission.requestedProvider,
      requestedProvider: this.admission.requestedProvider,
      requestedModel: this.admission.requestedModel,
      returnedProvider: input.returnedModel?.provider ?? null,
      returnedModel: input.returnedModel?.id ?? null,
      credentialRefId: this.admission.credentialRefId,
      credentialVersion: this.admission.credentialVersion,
      usageCompleteness,
      inputTokens: usage?.input ?? null,
      outputTokens: usage?.output ?? null,
      cacheReadTokens: usage ? (usage.cacheRead ?? 0) : null,
      cacheWriteTokens: usage ? (usage.cacheWrite ?? 0) : null,
      totalTokens: usage?.totalTokens ?? null,
      usageUnknownReason: usage ? null : (input.unknownReason ?? 'usage_not_reported'),
    };
    this.terminalInput = {
      ...terminal,
      ...estimateForRuntime(
        { ...terminal, cacheWrite1hTokens: usage?.cacheWrite1h ?? null },
        this.options.platformEnv,
        this.options.processEnv,
      ),
    };
    const outcome = await persistUsage(
      () => this.writeTerminal(),
      this.budgetMs,
      {
        phase: 'terminal',
        executionId: this.options.executionId,
        onPersistence: this.options.onPersistence,
        mode: this.persistenceMode,
        deadlineAt: this.options.deadlineAt,
        now: this.now,
      },
    );
    this.needsRepair ||= outcome !== 'recorded';
  }

  private async writeTerminal(): Promise<unknown> {
    if (this.options.replaySettlementAt !== undefined) {
      const detail = await this.options.store.getOperation(this.admission.operationId);
      const original = detail?.measurements.find(
        (measurement) => measurement.executionId === this.terminalInput!.executionId,
      );
      if (original) {
        this.terminalInput = {
          ...this.terminalInput!,
          observedAt: original.observedAt,
          finishedAt: original.observedAt,
          ...(this.runExecutionId || original.runExecutionId
            ? { runExecutionId: this.runExecutionId ?? original.runExecutionId }
            : {}),
        };
      }
    }
    return this.options.store.recordTerminal(this.terminalInput!);
  }

  async repairAfterTerminal(): Promise<void> {
    if (!this.terminalInput || !this.needsRepair || this.repairAttempted) return;
    this.repairAttempted = true;
    const outcome = await persistUsage(
      async () => {
        await this.options.store.admitOperation(this.admission);
        await this.writeTerminal();
      },
      this.budgetMs,
      {
        phase: 'repair',
        executionId: this.options.executionId,
        onPersistence: this.options.onPersistence,
        mode: this.persistenceMode,
        deadlineAt: this.options.deadlineAt,
        now: this.now,
      },
    );
    if (outcome === 'recorded') this.needsRepair = false;
  }
}

/**
 * Record the terminal of a routine execution whose recorder is gone: its
 * occurrence ended before it could be prepared again. The terminal repeats
 * what the operation was admitted with and reports its spend as unknown. An
 * operation never admitted, or an execution already measured, is left as it
 * is. Returns whether the execution's terminal is recorded.
 */
export async function recordRoutineTerminalWithoutRecorder(input: {
  store: UsageStore;
  operationId: string;
  executionId: string;
  runExecutionId?: string;
  status: UsageTerminalStatus;
  unknownReason: UsageUnknownReason;
  at: number;
  platformEnv?: PlatformEnv;
}): Promise<boolean> {
  const detail = await input.store.getOperation(input.operationId);
  if (!detail) return false;
  if (detail.measurements.some((measurement) => measurement.executionId === input.executionId)) return true;
  const { operation } = detail;
  const terminal = {
    operationId: operation.operationId,
    executionId: input.executionId,
    ...(input.runExecutionId ? { runExecutionId: input.runExecutionId } : {}),
    status: input.status,
    finishedAt: input.at,
    observedAt: input.at,
    providerRoute: operation.requestedProvider,
    requestedProvider: operation.requestedProvider,
    requestedModel: operation.requestedModel,
    returnedProvider: null,
    returnedModel: null,
    credentialRefId: operation.credentialRefId,
    credentialVersion: operation.credentialVersion,
    usageCompleteness: 'not_reported' as const,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    usageUnknownReason: input.unknownReason,
  };
  await input.store.recordTerminal({
    ...terminal,
    ...estimateForRuntime(terminal, input.platformEnv, undefined),
  });
  return true;
}

export function usageRuntimeRecordingEnabled(
  platformEnv?: PlatformEnv,
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = platformEnv?.USAGE_RUNTIME_RECORDING ?? processEnv.USAGE_RUNTIME_RECORDING;
  return value === undefined || value === '1' || value === 'true';
}

function splitModelSpecifier(value: string | null): { provider: string | null; model: string | null } {
  if (!value) return { provider: null, model: null };
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return { provider: value, model: value };
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

function modelPolicyUsage(attribution: AgentModelAttribution | undefined): Pick<
  AdmitUsageOperationInput,
  'modelSource' | 'workspaceDefaultRevision' | 'catalogRevision'
> {
  return {
    modelSource: attribution?.source ?? null,
    workspaceDefaultRevision: attribution?.workspaceDefaultRevision ?? null,
    catalogRevision: attribution?.catalogRevision ?? null,
  };
}

function boundedBudget(value: number | undefined): number {
  if (value === undefined) return DEFAULT_USAGE_WRITE_BUDGET_MS;
  return Number.isFinite(value) ? Math.max(1, Math.min(250, Math.floor(value))) : DEFAULT_USAGE_WRITE_BUDGET_MS;
}

async function withinBudget(
  promise: Promise<unknown>,
  budgetMs: number,
): Promise<UsagePersistenceOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => 'recorded' as const, () => 'failed' as const),
      new Promise<'timed_out'>((resolve) => {
        timer = setTimeout(() => resolve('timed_out'), budgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function persistUsage(
  write: () => Promise<unknown>,
  budgetMs: number,
  options: {
    phase: UsagePersistencePhase;
    executionId: string;
    onPersistence?: ((event: UsagePersistenceEvent) => void) | undefined;
    mode?: UsagePersistenceMode;
    deadlineAt?: number | undefined;
    now?: (() => number) | undefined;
  },
): Promise<UsagePersistenceOutcome> {
  const mode = options.mode ?? 'bounded';
  let outcome: UsagePersistenceOutcome;
  if (mode !== 'durable') {
    outcome = await withinBudget(write(), budgetMs);
  } else if (options.deadlineAt === undefined) {
    outcome = await write().then(() => 'recorded' as const, () => 'failed' as const);
  } else {
    const remainingMs = options.deadlineAt - (options.now ?? Date.now)();
    outcome = remainingMs <= 0
      ? 'timed_out'
      : await withinBudget(write(), remainingMs);
  }
  options.onPersistence?.({
    phase: options.phase,
    outcome,
    executionId: options.executionId,
  });
  if (outcome !== 'recorded' && mode === 'bounded') {
    console.warn(`[usage] ${options.phase} persistence ${outcome}; model execution will continue`);
  }
  return outcome;
}

function normalizeRoutineUsage(usage: RoutineReportedUsage | null): RoutineReportedUsage | null {
  if (!usage) return null;
  const values = [usage.input, usage.output, usage.cacheRead ?? 0, usage.cacheWrite ?? 0, usage.totalTokens];
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  return values.every((value) => value === 0)
    ? null
    : { ...usage, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 };
}

function normalizeInteractionUsage(
  usage: InteractionReportedUsage | null,
): InteractionReportedUsage | null {
  if (!usage) return null;
  const values = [usage.inputTokens, usage.outputTokens, usage.totalTokens];
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  return values.every((value) => value === 0) ? null : usage;
}

function estimateForRuntime(
  terminal: Parameters<typeof estimateUsage>[0],
  platformEnv: PlatformEnv | undefined,
  processEnv: NodeJS.ProcessEnv | undefined,
) {
  return usageEstimatesEnabled(platformEnv, processEnv ?? process.env)
    ? estimateUsage(terminal)
    : notPriced();
}
