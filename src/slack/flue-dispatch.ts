import {
  AgentInstanceExistsError,
  AgentInstanceNotFoundError,
  AgentRunError,
  SubmissionConflictError,
  init,
  type AgentReply,
  type DispatchReceipt,
} from '@flue/runtime';

import type { RuntimePlanV2 } from '../agents/runtime-plan.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import { cloudflareSandboxOptionVariants } from '../sandbox/lifecycle.ts';
import { sandboxThreadKey } from '../sandbox/thread-key.ts';
import { prepareSandboxTurn, type SandboxTurnContext } from '../sandbox/turn-context.ts';
import {
  CHICKPEA_RESPONSE_METADATA_KEY,
  type ChickpeaResponseMetadata,
} from '../usage/response-metadata.ts';
import { opaqueId } from '../work/admission.ts';
import type { WorkTraceCorrelation } from '../work/trace-correlation.ts';
import type {
  FlueDispatchEnvelopeV1,
  FlueDispatchReceiptV1,
  FlueSettlementCheckpointV1,
  FlueTurnObservationV1,
} from './turn-job-types.ts';
import type { SlackProgressiveReadRelay } from './progressive-relay.ts';
import {
  AGENT_FAILURE_TEXT,
  OPENAI_SUBSCRIPTION_POLICY_TEXT,
  OPENAI_SUBSCRIPTION_QUOTA_TEXT,
  OPENAI_SUBSCRIPTION_RECONNECT_TEXT,
  PROVIDER_FAILURE_TEXT,
  SANDBOX_FAILURE_TEXT,
  SANDBOX_SESSION_CAP_FAILURE_TEXT,
} from './web-client-presenter.ts';

export type AgentPromptFailureKind =
  | 'agent'
  | 'provider'
  | 'openai-subscription-reconnect'
  | 'openai-subscription-quota'
  | 'openai-subscription-policy'
  | 'sandbox'
  | 'sandbox-session-cap';

export type AgentUsageCompleteness = 'complete' | 'partial' | 'not_reported';

export interface AgentReportedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  totalTokens: number | null;
}

export interface AgentReturnedModel {
  provider: string;
  id: string;
}

export interface AgentDispatchResult {
  text: string;
  requestedModel: string | null;
  returnedModel: AgentReturnedModel | null;
  reportedUsage: AgentReportedUsage | null;
  usageCompleteness: AgentUsageCompleteness;
  flueSubmissionRef?: string | null;
}

export class AgentPromptFailure extends Error {
  constructor(
    readonly kind: AgentPromptFailureKind,
    readonly status = 500,
    readonly recoveryRequired = false,
    readonly retryable = false,
  ) {
    super(`agent prompt failed (${kind})`);
    this.name = 'AgentPromptFailure';
  }
}

export function agentFailureText(error: unknown): string {
  if (!(error instanceof AgentPromptFailure)) return AGENT_FAILURE_TEXT;
  if (error.kind === 'provider') return PROVIDER_FAILURE_TEXT;
  if (error.kind === 'openai-subscription-reconnect') return OPENAI_SUBSCRIPTION_RECONNECT_TEXT;
  if (error.kind === 'openai-subscription-quota') return OPENAI_SUBSCRIPTION_QUOTA_TEXT;
  if (error.kind === 'openai-subscription-policy') return OPENAI_SUBSCRIPTION_POLICY_TEXT;
  if (error.kind === 'sandbox') return SANDBOX_FAILURE_TEXT;
  if (error.kind === 'sandbox-session-cap') return SANDBOX_SESSION_CAP_FAILURE_TEXT;
  return AGENT_FAILURE_TEXT;
}

export interface SlackFlueDispatchState {
  dispatchEnvelope?: FlueDispatchEnvelopeV1;
  dispatchReceipt?: FlueDispatchReceiptV1;
  flueSettlement?: FlueSettlementCheckpointV1;
  prepare(
    message: string,
    observation: FlueTurnObservationV1,
  ): FlueDispatchEnvelopeV1 | Promise<FlueDispatchEnvelopeV1>;
  recordReceipt(
    receipt: FlueDispatchReceiptV1,
  ): FlueDispatchReceiptV1 | Promise<FlueDispatchReceiptV1>;
  recordSettlement(
    settlement: FlueSettlementCheckpointV1,
  ): FlueSettlementCheckpointV1 | Promise<FlueSettlementCheckpointV1>;
  reconcileExistingInstance(
    uid: string,
  ): FlueDispatchEnvelopeV1 | Promise<FlueDispatchEnvelopeV1>;
  markRecoveryRequired(reason: string): void | Promise<void>;
}

export interface PromptSlackAgentInput {
  message: string;
  state: SlackFlueDispatchState;
  turnId: string;
  conversationKey: string;
  useCloudflareSandbox: boolean;
  requestedModel: string | null;
  /** Frozen, non-secret revision evidence retained by the adapter observation. */
  runtimePlan?: RuntimePlanV2;
  workCorrelation?: WorkTraceCorrelation;
  env?: PlatformEnv;
  now?: () => number;
  /** Slack seam run after settlement persistence and before any visible reply. */
  beforeResult?: () => Promise<void>;
  /** Prepared only after the durable receipt exists and eligibility is frozen. */
  prepareProgressiveRelay?: (input: {
    instanceId: string;
    receipt: FlueDispatchReceiptV1;
  }) => Promise<SlackProgressiveReadRelay | undefined>;
  /** Focused contract seam; production uses the real Flue handle. */
  handle?: ReturnType<typeof init>;
  /** Focused seam; production uses the Cloudflare Sandbox turn preparer. */
  prepareSandbox?: typeof prepareCloudflareSandboxTurn;
}

/**
 * Durable Flue 2 dispatch/read adapter. Admission, receipt, and settlement are
 * separate checkpoints: ambiguous admission repeats the same keyed envelope;
 * a saved receipt skips dispatch; a saved settlement skips both Flue calls.
 */
export async function promptSlackThreadAgent(
  input: PromptSlackAgentInput,
): Promise<AgentDispatchResult> {
  const now = input.now ?? Date.now;
  if (input.state.flueSettlement) {
    await input.beforeResult?.();
    return resultFromSettlement(input.state.flueSettlement);
  }

  if (input.useCloudflareSandbox) {
    try {
      await (input.prepareSandbox ?? prepareCloudflareSandboxTurn)(
        input.env,
        input.conversationKey,
        input.turnId,
      );
    } catch {
      throw new AgentPromptFailure('sandbox');
    }
  }

  const observation: FlueTurnObservationV1 = {
    generation: input.turnId,
    ...(input.workCorrelation ? { workCorrelation: input.workCorrelation } : {}),
    ...(input.runtimePlan
      ? {
          harnessRevision: input.runtimePlan.harnessRevision,
          ...(input.runtimePlan.configurationRevision
            ? { configurationRevision: input.runtimePlan.configurationRevision }
            : {}),
        }
      : {}),
  };
  let envelope = input.state.dispatchEnvelope ??
    await input.state.prepare(input.message, observation);
  input.state.dispatchEnvelope = envelope;
  const agent = input.handle ? undefined : (await import('../agents/slack-thread.ts')).ChickpeaSlack;
  let handle = input.handle ?? init(agent!, { id: envelope.instanceId, uid: envelope.uid });
  let receipt = input.state.dispatchReceipt;
  if (!receipt) {
    let admitted: DispatchReceipt;
    try {
      admitted = await handle.dispatch({
        message: envelope.message,
        ...(envelope.initialData ? { initialData: envelope.initialData } : {}),
        idempotencyKey: envelope.idempotencyKey,
      });
    } catch (error) {
      if (error instanceof AgentInstanceExistsError && error.uid) {
        try {
          envelope = await input.state.reconcileExistingInstance(error.uid);
          input.state.dispatchEnvelope = envelope;
          handle = input.handle ?? init(agent!, {
            id: envelope.instanceId,
            uid: envelope.uid,
          });
          admitted = await handle.dispatch({
            message: envelope.message,
            idempotencyKey: envelope.idempotencyKey,
          });
        } catch (reconciliationError) {
          const reason = dispatchReconciliationReason(reconciliationError);
          if (reason) await input.state.markRecoveryRequired(reason);
          if (reconciliationError instanceof SubmissionConflictError ||
              reconciliationError instanceof AgentInstanceExistsError ||
              reconciliationError instanceof AgentInstanceNotFoundError) {
            throw new AgentPromptFailure('agent', 409, true);
          }
          // The local reconciliation CAS marks its own conflict. A transport
          // interruption from the second keyed dispatch remains retryable.
          if (input.state.dispatchEnvelope?.uid === error.uid) {
            throw new AgentPromptFailure('agent', 503, false, true);
          }
          await input.state.markRecoveryRequired(
            'flue_existing_instance_reconciliation_conflict',
          );
          throw new AgentPromptFailure('agent', 409, true);
        }
      } else {
        const reason = dispatchReconciliationReason(error);
        if (reason) {
          await input.state.markRecoveryRequired(reason);
          throw new AgentPromptFailure('agent', 409, true);
        }
        throw new AgentPromptFailure('agent', 503, false, true);
      }
    }
    receipt = await input.state.recordReceipt(boundedReceipt(admitted));
    input.state.dispatchReceipt = receipt;
  }

  let progressiveRelay: SlackProgressiveReadRelay | undefined;
  if (input.prepareProgressiveRelay) {
    try {
      progressiveRelay = await input.prepareProgressiveRelay({
        instanceId: envelope.instanceId,
        receipt,
      });
    } catch {
      // The receipt is already durable, so retry reattaches to the same paid
      // submission. No read callback was registered and no text escaped.
      throw new AgentPromptFailure('agent', 503, false, true);
    }
  }

  let reply: AgentReply;
  try {
    reply = await handle.read(
      receipt as DispatchReceipt,
      progressiveRelay ? { onEvent: progressiveRelay.onEvent } : undefined,
    );
  } catch (error) {
    if (!(error instanceof AgentRunError)) {
      await progressiveRelay?.invalidateAndDrain('read_interrupted');
      if (error instanceof AgentInstanceNotFoundError) {
        await input.state.markRecoveryRequired('flue_expected_instance_missing');
        throw new AgentPromptFailure('agent', 409, true);
      }
      // Transport/isolate interruptions are not settlement evidence. Keep the
      // receipt and let the durable relay reattach instead of freezing a paid,
      // possibly completed turn as a permanent failure.
      throw new AgentPromptFailure('agent', 503, false, true);
    }
    const kind = classifyFlueRunFailure(error);
    let checkpoint: FlueSettlementCheckpointV1;
    try {
      checkpoint = await input.state.recordSettlement({
        outcome: error.outcome,
        settledAt: now(),
        failureKind: kind,
      });
    } catch (settlementError) {
      await progressiveRelay?.invalidateAndDrain('settlement_persist_failed');
      throw settlementError;
    }
    input.state.flueSettlement = checkpoint;
    await progressiveRelay?.invalidateAndDrain('run_failed');
    await input.beforeResult?.();
    throw new AgentPromptFailure(kind);
  }

  let completed: AgentDispatchResult;
  try {
    completed = resultFromAgentReply(reply, input.requestedModel);
  } catch {
    let checkpoint: FlueSettlementCheckpointV1;
    try {
      checkpoint = await input.state.recordSettlement({
        outcome: 'failed',
        settledAt: now(),
        failureKind: 'agent',
      });
    } catch (settlementError) {
      await progressiveRelay?.invalidateAndDrain('settlement_persist_failed');
      throw settlementError;
    }
    input.state.flueSettlement = checkpoint;
    await progressiveRelay?.invalidateAndDrain('invalid_result');
    await input.beforeResult?.();
    throw new AgentPromptFailure('agent');
  }

  let checkpoint: FlueSettlementCheckpointV1;
  try {
    checkpoint = await input.state.recordSettlement({
      outcome: 'completed',
      settledAt: now(),
      result: completed,
    });
  } catch (settlementError) {
    await progressiveRelay?.invalidateAndDrain('settlement_persist_failed');
    throw settlementError;
  }
  input.state.flueSettlement = checkpoint;
  await progressiveRelay?.closeAndDrain();
  await input.beforeResult?.();
  return resultFromSettlement(checkpoint);
}

function dispatchReconciliationReason(error: unknown): string | undefined {
  if (error instanceof SubmissionConflictError) return 'flue_dispatch_payload_conflict';
  if (error instanceof AgentInstanceExistsError) return 'flue_unexpected_existing_instance';
  if (error instanceof AgentInstanceNotFoundError) return 'flue_expected_instance_missing';
  return undefined;
}

function resultFromSettlement(
  settlement: FlueSettlementCheckpointV1,
): AgentDispatchResult {
  if (settlement.outcome === 'completed') return settlement.result;
  throw new AgentPromptFailure(settlement.failureKind);
}

function boundedReceipt(receipt: DispatchReceipt): FlueDispatchReceiptV1 {
  return {
    submissionId: receipt.submissionId,
    acceptedAt: receipt.acceptedAt,
    uid: receipt.uid,
    ...(receipt.deduplicated ? { deduplicated: true } : {}),
  };
}

/** Reduce the Flue reply before any common Work/Run, Slack, or usage seam. */
export function resultFromAgentReply(
  reply: AgentReply,
  requestedModel: string | null,
): AgentDispatchResult {
  if (!reply.text) throw new Error('agent prompt returned no result text');
  const metadata = parseResponseMetadata(reply.metadata?.[CHICKPEA_RESPONSE_METADATA_KEY]);
  const usage = metadata ? parseReportedUsage(metadata.usage) : {
    reportedUsage: null,
    completeness: 'not_reported' as const,
  };
  return {
    text: reply.text,
    requestedModel: metadata?.requestedModel ?? nonEmptyString(requestedModel),
    returnedModel: metadata?.returnedModel ?? null,
    reportedUsage: usage.reportedUsage,
    usageCompleteness: usage.completeness,
    flueSubmissionRef: opaqueId('fluesubmission', reply.submissionId),
  };
}

function parseResponseMetadata(value: unknown): ChickpeaResponseMetadata | undefined {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== 1) return undefined;
  const requestedModel = nonEmptyString(record.requestedModel);
  const usage = asRecord(record.usage);
  if (!requestedModel || !usage) return undefined;
  if (![usage.input, usage.output, usage.totalTokens].every(isTokenCount)) return undefined;
  const returned = asRecord(record.returnedModel);
  const provider = nonEmptyString(returned?.provider);
  const id = nonEmptyString(returned?.id);
  return {
    schemaVersion: 1,
    requestedModel,
    usage: {
      input: Number(usage.input),
      output: Number(usage.output),
      cacheRead: isTokenCount(usage.cacheRead) ? Number(usage.cacheRead) : 0,
      cacheWrite: isTokenCount(usage.cacheWrite) ? Number(usage.cacheWrite) : 0,
      totalTokens: Number(usage.totalTokens),
    },
    ...(provider && id ? { returnedModel: { provider, id } } : {}),
  };
}

/** Compatibility parser retained for stored usage fixtures during migration. */
export function parseAgentDispatchEnvelope(
  envelope: unknown,
  requestedModel: string | null,
): AgentDispatchResult {
  const body = asRecord(envelope);
  const result = body?.result;
  const text = extractResultText(result);
  if (!text) throw new Error('agent prompt returned no result text');
  const record = asRecord(result);
  const usage = parseReportedUsage(record?.usage);
  return {
    text,
    requestedModel: nonEmptyString(requestedModel),
    returnedModel: parseReturnedModel(record?.model),
    reportedUsage: usage.reportedUsage,
    usageCompleteness: usage.completeness,
    flueSubmissionRef: typeof body?.submissionId === 'string' && body.submissionId
      ? opaqueId('fluesubmission', body.submissionId)
      : null,
  };
}

export function classifyAgentPromptFailure(
  _status: number,
  rawEnvelope: string,
): AgentPromptFailureKind {
  const error = parseFlueErrorEnvelope(rawEnvelope);
  return classifyFailureText(error.type, error.message);
}

function classifyFlueRunFailure(error: unknown): AgentPromptFailureKind {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let type = '';
  let message = '';
  for (let depth = 0; current && depth < 5 && !seen.has(current); depth += 1) {
    seen.add(current);
    const record = asRecord(current);
    if (!record) break;
    type += ` ${typeof record.type === 'string' ? record.type : ''}`;
    message += ` ${typeof record.message === 'string' ? record.message : ''}`;
    current = record.cause;
  }
  return classifyFailureText(type, message);
}

function classifyFailureText(typeValue: string, messageValue: string): AgentPromptFailureKind {
  const type = typeValue.toLowerCase();
  const message = messageValue.toLowerCase();
  const searchable = `${type} ${message}`;
  if (
    message.includes('openai subscription operation failed (auth_reconnect_required)') ||
    message.includes('openai subscription operation failed (authorization_missing)') ||
    message.includes('openai subscription operation failed (storage_invalid)')
  ) return 'openai-subscription-reconnect';
  if (message.includes('openai subscription operation failed (subscription_quota_exhausted)')) {
    return 'openai-subscription-quota';
  }
  if (
    message.includes('openai subscription operation failed (entitlement_denied)') ||
    message.includes('openai subscription operation failed (client_rejected)') ||
    message.includes('openai subscription operation failed (originator_rejected)')
  ) return 'openai-subscription-policy';
  if (
    type.includes('sandbox_session_cap_reached') ||
    message.includes('coding workspace monthly session limit')
  ) return 'sandbox-session-cap';
  if (
    type.includes('sandbox_unavailable') ||
    message.includes('coding workspace is temporarily unavailable') ||
    message.includes('maximum number of running container instances') ||
    message.includes('container was unavailable') ||
    message.includes('container unavailable')
  ) return 'sandbox';
  if (
    type.includes('cloudflare_ai_binding_error') ||
    type.includes('invalid_provider_registration') ||
    /\b(model|provider|llm|workers ai)\b/.test(searchable)
  ) return 'provider';
  return 'agent';
}

function parseFlueErrorEnvelope(rawEnvelope: string): { type: string; message: string } {
  try {
    const parsed = JSON.parse(rawEnvelope) as { error?: { type?: unknown; message?: unknown } };
    return {
      type: typeof parsed.error?.type === 'string' ? parsed.error.type : '',
      message: typeof parsed.error?.message === 'string' ? parsed.error.message : '',
    };
  } catch {
    return { type: '', message: '' };
  }
}

function extractResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  const record = asRecord(result);
  if (typeof record?.text === 'string') return record.text;
  if (typeof record?.data === 'string') return record.data;
  return '';
}

function parseReturnedModel(value: unknown): AgentReturnedModel | null {
  const record = asRecord(value);
  const provider = nonEmptyString(record?.provider);
  const id = nonEmptyString(record?.id);
  return provider && id ? { provider, id } : null;
}

function parseReportedUsage(value: unknown): {
  reportedUsage: AgentReportedUsage | null;
  completeness: AgentUsageCompleteness;
} {
  const record = asRecord(value);
  if (!record) return { reportedUsage: null, completeness: 'not_reported' };
  const rawValues = [record.input, record.output, record.totalTokens];
  const presentValues = rawValues.filter((raw) => raw !== undefined && raw !== null);
  if (presentValues.length === 0 || presentValues.some((raw) => !isTokenCount(raw))) {
    return { reportedUsage: null, completeness: 'not_reported' };
  }
  const reportedUsage: AgentReportedUsage = {
    inputTokens: isTokenCount(record.input) ? record.input : null,
    outputTokens: isTokenCount(record.output) ? record.output : null,
    cacheReadTokens: isTokenCount(record.cacheRead) ? record.cacheRead : null,
    cacheWriteTokens: isTokenCount(record.cacheWrite) ? record.cacheWrite : null,
    totalTokens: isTokenCount(record.totalTokens) ? record.totalTokens : null,
  };
  const values = [
    reportedUsage.inputTokens,
    reportedUsage.outputTokens,
    reportedUsage.totalTokens,
  ];
  if (values.every((tokenCount) => tokenCount === 0)) {
    return { reportedUsage: null, completeness: 'not_reported' };
  }
  return {
    reportedUsage,
    completeness: values.every((tokenCount) => tokenCount !== null) ? 'complete' : 'partial',
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function isTokenCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export async function prepareCloudflareSandboxTurn(
  env: PlatformEnv | undefined,
  conversationKey: string,
  turnId: string,
): Promise<void> {
  if (!isCloudflareTarget()) return;
  const binding = env?.SANDBOX ?? env?.Sandbox;
  if (!binding) throw new Error('SANDBOX Durable Object binding is unavailable');
  const { getSandbox } = await import('@cloudflare/sandbox');
  const sandboxKey = sandboxThreadKey(conversationKey);
  const preparations = await Promise.allSettled(
    cloudflareSandboxOptionVariants(sandboxKey).map(async (options) => {
      const sandbox = getSandbox(
        binding as Parameters<typeof getSandbox>[0],
        sandboxKey,
        options,
      ) as ReturnType<typeof getSandbox> & SandboxTurnContext;
      await prepareSandboxTurn(sandbox, turnId);
    }),
  );
  if (preparations.some((result) => result.status === 'rejected')) {
    throw new Error('sandbox turn preparation failed');
  }
}

export async function releaseCloudflareSandboxTurn(
  env: PlatformEnv | undefined,
  conversationKey: string,
  usedCloudflareSandbox: boolean,
): Promise<void> {
  if (!usedCloudflareSandbox || !isCloudflareTarget()) return;
  const binding = env?.SANDBOX ?? env?.Sandbox;
  if (!binding) return;
  try {
    const { getSandbox } = await import('@cloudflare/sandbox');
    const sandboxKey = sandboxThreadKey(conversationKey);
    const teardowns = await Promise.allSettled(
      cloudflareSandboxOptionVariants(sandboxKey).map(async (options) => {
        const sandbox = getSandbox(
          binding as Parameters<typeof getSandbox>[0],
          sandboxKey,
          options,
        ) as ReturnType<typeof getSandbox> & { destroy(): Promise<void> };
        await sandbox.destroy();
      }),
    );
    if (teardowns.some((result) => result.status === 'rejected')) {
      console.warn('[chickpea] coding workspace teardown did not complete');
    }
  } catch {
    console.warn('[chickpea] coding workspace teardown did not complete');
  }
}
