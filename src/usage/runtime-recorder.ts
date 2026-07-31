import type { AgentDispatchResult } from '../slack/agent-dispatch.ts';
import type { NormalizedSlackTurn } from '../slack/types.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { ResolvedAssignment } from '../config/types.ts';
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

export const DEFAULT_USAGE_WRITE_BUDGET_MS = 100;

export type UsagePersistencePhase = 'admission' | 'terminal' | 'repair';
export type UsagePersistenceOutcome = 'recorded' | 'timed_out' | 'failed';

export interface UsagePersistenceEvent {
  phase: UsagePersistencePhase;
  outcome: UsagePersistenceOutcome;
  executionId: string;
}

export interface InteractiveUsageRecorderOptions {
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
}

export class InteractiveUsageRecorder {
  private readonly admission: AdmitUsageOperationInput;
  private readonly budgetMs: number;
  private readonly now: () => number;
  private terminalInput: RecordUsageTerminalInput | undefined;
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
      installationId: installationId(options.platformEnv, options.processEnv),
      workspaceId: options.turn.workspaceId,
      profileId: options.assignment.agentId,
      profileLabel: options.assignment.agent.name,
      channelId: options.turn.channelId,
      channelLabel: direct ? null : (options.assignment.channelLabel ?? options.turn.channelId),
      conversationKind: direct ? 'direct_message' : 'named_channel',
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
    this.terminalInput = this.baseTerminal({
      status: 'completed',
      providerRoute: returned?.provider ?? this.admission.requestedProvider,
      returnedProvider: returned?.provider ?? null,
      returnedModel: returned?.id ?? null,
      usageCompleteness: result.usageCompleteness,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
      usageUnknownReason: unknownReason,
    });
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
      totalTokens: null,
      usageUnknownReason: reason,
    });
    await this.persistTerminal();
  }

  async repairAfterDelivery(): Promise<void> {
    if (!this.terminalInput || !this.needsRepair || this.repairAttempted) return;
    this.repairAttempted = true;
    const outcome = await this.persist('repair', async () => {
      await this.options.store.admitOperation(this.admission);
      await this.options.store.recordTerminal(this.terminalInput!);
    });
    if (outcome === 'recorded') this.needsRepair = false;
  }

  private async persistTerminal(): Promise<void> {
    const outcome = await this.persist(
      'terminal',
      () => this.options.store.recordTerminal(this.terminalInput!),
    );
    this.needsRepair ||= outcome !== 'recorded';
  }

  private async persist(
    phase: UsagePersistencePhase,
    write: () => Promise<unknown>,
  ): Promise<UsagePersistenceOutcome> {
    return persistUsage(
      write(),
      this.budgetMs,
      phase,
      this.options.executionId,
      this.options.onPersistence,
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
      | 'totalTokens'
      | 'usageUnknownReason'
    >,
  ): RecordUsageTerminalInput {
    const finishedAt = this.now();
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
      ...estimateForRuntime(terminal, this.options.platformEnv, this.options.processEnv),
    };
  }
}

export interface RoutineUsageRecorderOptions {
  operationId: string;
  executionId: string;
  runId?: string;
  runExecutionId?: string;
  startedAt: number;
  workspaceId: string;
  channelId: string;
  channelLabel?: string;
  profileId: string | null;
  profileLabel: string | null;
  routineId: string;
  routineLabel: string;
  requestedModel: string | null;
  credentialRefId: string | null;
  credentialVersion: number | null;
  store: UsageStore;
  platformEnv?: PlatformEnv;
  processEnv?: NodeJS.ProcessEnv;
  writeBudgetMs?: number;
  now?: () => number;
  onPersistence?: (event: UsagePersistenceEvent) => void;
}

export interface RoutineReportedUsage {
  input: number;
  output: number;
  totalTokens: number;
}

export interface InteractionUsageRecorderOptions {
  operationId: string;
  executionId: string;
  runId?: string;
  runExecutionId?: string;
  startedAt: number;
  workspaceId: string;
  channelId: string;
  channelLabel?: string;
  conversationKind?: UsageConversationKind;
  profileId: string | null;
  profileLabel: string | null;
  requestedModel: string | null;
  credentialRefId: string | null;
  credentialVersion: number | null;
  store: UsageStore;
  platformEnv?: PlatformEnv;
  processEnv?: NodeJS.ProcessEnv;
  writeBudgetMs?: number;
  now?: () => number;
  onPersistence?: (event: UsagePersistenceEvent) => void;
}

export interface InteractionReportedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
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
      installationId: installationId(options.platformEnv, options.processEnv),
      workspaceId: options.workspaceId,
      profileId: options.profileId,
      profileLabel: options.profileLabel,
      channelId: options.channelId,
      channelLabel: options.channelLabel ?? options.channelId,
      conversationKind: options.conversationKind ?? 'named_channel',
      requestedProvider: requested.provider,
      requestedModel: requested.model,
      credentialRefId: options.credentialRefId,
      credentialVersion: options.credentialVersion,
    };
  }

  async admit(): Promise<void> {
    const outcome = await persistUsage(
      this.options.store.admitOperation(this.admission),
      this.budgetMs,
      'admission',
      this.options.executionId,
      this.options.onPersistence,
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
      totalTokens: usage?.totalTokens ?? null,
      usageUnknownReason: usage ? null : (input.unknownReason ?? 'usage_not_reported'),
    };
    this.terminalInput = {
      ...terminal,
      ...estimateForRuntime(terminal, this.options.platformEnv, this.options.processEnv),
    };
    const outcome = await persistUsage(
      this.options.store.recordTerminal(this.terminalInput),
      this.budgetMs,
      'terminal',
      this.options.executionId,
      this.options.onPersistence,
    );
    this.needsRepair ||= outcome !== 'recorded';
  }

  async repairAfterTerminal(): Promise<void> {
    if (!this.terminalInput || !this.needsRepair || this.repairAttempted) return;
    this.repairAttempted = true;
    const outcome = await persistUsage(
      (async () => {
        await this.options.store.admitOperation(this.admission);
        await this.options.store.recordTerminal(this.terminalInput!);
      })(),
      this.budgetMs,
      'repair',
      this.options.executionId,
      this.options.onPersistence,
    );
    if (outcome === 'recorded') this.needsRepair = false;
  }
}

export class RoutineUsageRecorder {
  private readonly admission: AdmitUsageOperationInput;
  private readonly budgetMs: number;
  private readonly now: () => number;
  private terminalInput: RecordUsageTerminalInput | undefined;
  private repairAttempted = false;
  private needsRepair = false;
  private runExecutionId: string | undefined;

  constructor(private readonly options: RoutineUsageRecorderOptions) {
    this.now = options.now ?? Date.now;
    this.budgetMs = boundedBudget(options.writeBudgetMs);
    this.runExecutionId = options.runExecutionId;
    const requested = splitModelSpecifier(options.requestedModel);
    this.admission = {
      operationId: options.operationId,
      operationKind: 'routine_run',
      sourceId: options.operationId,
      ...(options.runId ? { runId: options.runId } : {}),
      startedAt: options.startedAt,
      installationId: installationId(options.platformEnv, options.processEnv),
      workspaceId: options.workspaceId,
      profileId: options.profileId,
      profileLabel: options.profileLabel,
      channelId: options.channelId,
      channelLabel: options.channelLabel ?? options.channelId,
      conversationKind: 'named_channel',
      routineId: options.routineId,
      routineLabel: options.routineLabel,
      routineRunId: options.operationId,
      requestedProvider: requested.provider,
      requestedModel: requested.model,
      credentialRefId: options.credentialRefId,
      credentialVersion: options.credentialVersion,
    };
  }

  async admit(): Promise<void> {
    const outcome = await persistUsage(
      this.options.store.admitOperation(this.admission),
      this.budgetMs,
      'admission',
      this.options.executionId,
      this.options.onPersistence,
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
    const finishedAt = this.now();
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
      totalTokens: usage?.totalTokens ?? null,
      usageUnknownReason: usage ? null : (input.unknownReason ?? 'usage_not_reported'),
    };
    const terminalInput: RecordUsageTerminalInput = {
      ...terminal,
      ...estimateForRuntime(terminal, this.options.platformEnv, this.options.processEnv),
    };
    this.terminalInput = terminalInput;
    const outcome = await persistUsage(
      this.options.store.recordTerminal(terminalInput),
      this.budgetMs,
      'terminal',
      this.options.executionId,
      this.options.onPersistence,
    );
    this.needsRepair ||= outcome !== 'recorded';
  }

  async repairAfterTerminal(): Promise<void> {
    if (!this.terminalInput || !this.needsRepair || this.repairAttempted) return;
    this.repairAttempted = true;
    const outcome = await persistUsage(
      (async () => {
        await this.options.store.admitOperation(this.admission);
        await this.options.store.recordTerminal(this.terminalInput!);
      })(),
      this.budgetMs,
      'repair',
      this.options.executionId,
      this.options.onPersistence,
    );
    if (outcome === 'recorded') this.needsRepair = false;
  }
}

export function usageRuntimeRecordingEnabled(
  platformEnv?: PlatformEnv,
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = platformEnv?.USAGE_RUNTIME_RECORDING ?? processEnv.USAGE_RUNTIME_RECORDING;
  return value === '1' || value === 'true';
}

function splitModelSpecifier(value: string | null): { provider: string | null; model: string | null } {
  if (!value) return { provider: null, model: null };
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return { provider: value, model: value };
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

function installationId(
  platformEnv: PlatformEnv | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
): string {
  const configured = platformEnv?.CHICKPEA_INSTALLATION_ID ?? processEnv.CHICKPEA_INSTALLATION_ID;
  if (typeof configured === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/.test(configured)) {
    return configured;
  }
  return 'chickpea';
}

function boundedBudget(value: number | undefined): number {
  if (value === undefined) return DEFAULT_USAGE_WRITE_BUDGET_MS;
  return Number.isFinite(value) ? Math.max(1, Math.min(250, Math.floor(value))) : DEFAULT_USAGE_WRITE_BUDGET_MS;
}

function slackTimestampMs(value: string): number | null {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const milliseconds = Math.floor(Number(value) * 1_000);
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : null;
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
  promise: Promise<unknown>,
  budgetMs: number,
  phase: UsagePersistencePhase,
  executionId: string,
  onPersistence?: (event: UsagePersistenceEvent) => void,
): Promise<UsagePersistenceOutcome> {
  const outcome = await withinBudget(promise, budgetMs);
  onPersistence?.({ phase, outcome, executionId });
  if (outcome !== 'recorded') {
    console.warn(`[usage] ${phase} persistence ${outcome}; model execution will continue`);
  }
  return outcome;
}

function normalizeRoutineUsage(usage: RoutineReportedUsage | null): RoutineReportedUsage | null {
  if (!usage) return null;
  const values = [usage.input, usage.output, usage.totalTokens];
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  return values.every((value) => value === 0) ? null : usage;
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
  terminal: Pick<
    RecordUsageTerminalInput,
    | 'observedAt'
    | 'providerRoute'
    | 'returnedProvider'
    | 'requestedProvider'
    | 'returnedModel'
    | 'requestedModel'
    | 'usageCompleteness'
    | 'inputTokens'
    | 'outputTokens'
  >,
  platformEnv: PlatformEnv | undefined,
  processEnv: NodeJS.ProcessEnv | undefined,
) {
  return usageEstimatesEnabled(platformEnv, processEnv ?? process.env)
    ? estimateUsage(terminal)
    : notPriced();
}
