import { SLACK_MEMORY_UPDATE_DATA_NAME, parseSlackMemoryUpdate, type SlackMemoryUpdate } from './memory-update-terminal.ts';
import {
  CODING_WORKER_RUN_DATA_NAME,
  CODING_WORKER_USAGE_DATA_NAME,
  parseCodingWorkerRunModel,
  parseCodingWorkerUsage,
  type CodingWorkerUsageRecord,
  WORKSPACE_MILESTONE_DATA_NAME,
  type WorkspaceMilestoneRecord,
} from './coding-worker-run.ts';
import { createWorkspaceMilestoneRelay } from './workspace-milestone-relay.ts';
import { FILE_DELIVERY_DATA_NAME, resolveFileDeliveryText } from './file-delivery-completion.ts';
import {
  AgentInstanceExistsError,
  AgentInstanceNotFoundError,
  AgentRunError,
  SubmissionConflictError,
  init,
  type AgentReply,
  type ConversationStreamChunk,
  type DispatchReceipt,
} from '@flue/runtime';

import type { RuntimePlanV2 } from '../agents/runtime-plan.ts';
import type { ThreadImageRecord } from './thread-images.ts';
import {
  BoundedObservationAbortedError,
  createCloudflareBoundedAgentReplyReader,
  type BoundedReplyReader,
} from './bounded-agent-observation.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import { cloudflareSandboxOptionVariants } from '../sandbox/lifecycle.ts';
import { reconnectingSandboxStub } from '../sandbox/reconnect.ts';
import { sandboxThreadKey } from '../sandbox/thread-key.ts';
import {
  CODING_WORKSPACE_USE_DATA_NAME,
  codingWorkspaceOpenedFromReplyData,
} from '../sandbox/workspace-use.ts';
import { prepareSandboxTurn, type SandboxTurnContext } from '../sandbox/turn-context.ts';
import {
  CHICKPEA_RESPONSE_METADATA_KEY,
  parseChickpeaResponseMetadata,
} from '../usage/response-metadata.ts';
import { opaqueId } from '../work/admission.ts';
import { settlementFailureFacts } from './agent-failure-diagnostics.ts';
import type { WorkTraceCorrelation } from '../work/trace-correlation.ts';
import type {
  FlueDispatchEnvelopeV1,
  FlueDispatchReceiptV1,
  FlueSettlementCheckpointV1,
  FlueTurnObservationV1,
} from './turn-job-types.ts';
import type { SlackProgressiveReadRelay } from './progressive-relay.ts';
import {
  parseSlackTablePresentations,
  SLACK_TABLE_PRESENTATION_DATA_NAME,
  type SlackTablePresentation,
} from './table-presentation.ts';
import {
  parseSlackArtifactReceipts,
  SLACK_ARTIFACT_RECEIPTS_DATA_NAME,
  type SlackArtifactReceipt,
} from './artifact-receipts.ts';
import {
  parseSlackAgentCreationTerminalIntents,
  SLACK_AGENT_CREATION_TERMINAL_DATA_NAME,
  type SlackAgentCreationTerminalIntent,
} from './agent-creation-terminal.ts';
import {
  AGENT_FAILURE_TEXT,
  OPENAI_SUBSCRIPTION_POLICY_TEXT,
  OPENAI_SUBSCRIPTION_QUOTA_TEXT,
  OPENAI_SUBSCRIPTION_RECONNECT_TEXT,
  PROVIDER_FAILURE_TEXT,
  SANDBOX_FAILURE_TEXT,
  SANDBOX_SESSION_CAP_FAILURE_TEXT,
} from './web-client-presenter.ts';

type AgentPromptFailureKind =
  | 'agent'
  | 'provider'
  | 'invalid-output'
  | 'openai-subscription-reconnect'
  | 'openai-subscription-quota'
  | 'openai-subscription-policy'
  | 'sandbox'
  | 'sandbox-session-cap';

type AgentUsageCompleteness = 'complete' | 'partial' | 'not_reported';

interface AgentReportedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  totalTokens: number | null;
}

interface AgentReturnedModel {
  provider: string;
  id: string;
}

export interface AgentDispatchResult {
  text: string;
  tablePresentations?: SlackTablePresentation[];
  /** Host-staged files to publish with the final reply; never model-authored. */
  artifacts?: SlackArtifactReceipt[];
  agentCreationTerminal?: SlackAgentCreationTerminalIntent;
  memoryUpdate?: SlackMemoryUpdate;
  /** The coding model a coding worker ran on this response; names it in the footer. */
  codingModel?: string;
  /** Each coding worker's own model usage this response, recorded beside the Agent's. */
  codingWorkerUsage?: CodingWorkerUsageRecord[];
  requestedModel: string | null;
  returnedModel: AgentReturnedModel | null;
  reportedUsage: AgentReportedUsage | null;
  usageCompleteness: AgentUsageCompleteness;
  flueSubmissionRef?: string | null;
  /**
   * Whether the Agent opened a coding workspace, read from this attempt's own
   * reply. Never persisted with the settlement, so a replayed settlement
   * leaves it undefined (unknown).
   */
  codingWorkspaceOpened?: boolean;
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

/**
 * The caller stopped observing an already-dispatched turn on purpose (the
 * Cloudflare alarm's wall-time budget). Nothing settled and nothing was
 * decided: the durable receipt stays, no Slack output is written, and a later
 * attempt reattaches to the same submission exactly as after an isolate kill.
 */
export class AgentObservationYield extends AgentPromptFailure {
  constructor() {
    super('agent', 503, false, true);
    this.name = 'AgentObservationYield';
  }
}

export function agentFailureText(error: unknown): string {
  if (!(error instanceof AgentPromptFailure)) return AGENT_FAILURE_TEXT;
  if (error.kind === 'provider') return PROVIDER_FAILURE_TEXT;
  if (error.kind === 'invalid-output') return 'The model returned an unusable response. I have not retried the request. Check the connected service before retrying any write, because its outcome is not confirmed by this response.';
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
    /** This turn's thread images; the envelope carries them as one attribute. */
    threadImages?: readonly ThreadImageRecord[],
    admittedListIds?: readonly string[],
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

interface PromptSlackAgentInput {
  message: string;
  state: SlackFlueDispatchState;
  turnId: string;
  conversationKey: string;
  useCloudflareSandbox: boolean;
  requestedModel: string | null;
  /** Frozen, non-secret revision evidence retained by the adapter observation. */
  runtimePlan?: RuntimePlanV2;
  /** Images already in this Slack conversation, collected by the host fetch. */
  threadImages?: readonly ThreadImageRecord[];
  /** Host-admitted List references for this exact turn. */
  admittedListIds?: readonly string[];
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
  /**
   * Applies a delegated coding task's steps to the run's checklist while the
   * reply is observed. Called in stream order for this submission only; the
   * reply waits for pending calls, which must not throw.
   */
  /**
   * An earlier observation of this turn saw a coding task start; the reader
   * treats the worker as busy until the first chunk after it catches up.
   */
  codingTaskStarted?: boolean;
  onWorkspaceMilestone?: (
    record: WorkspaceMilestoneRecord,
    target: { instanceId: string; submissionId: string },
  ) => Promise<void>;
  /**
   * Ends observation of the dispatched reply without settling it. An abort
   * surfaces as AgentObservationYield; the receipt stays for reattachment.
   */
  observationSignal?: AbortSignal;
  /** Called once the durable receipt exists and observation is about to begin. */
  onObservationStarted?: () => void;
  /** Focused contract seam; production uses the real Flue handle. */
  handle?: ReturnType<typeof init>;
  /**
   * Focused seam. On Cloudflare the adapter always observes the reply with
   * bounded reads (see ./bounded-agent-observation.ts); Node uses Flue's
   * in-process `read()`.
   */
  observeReply?: BoundedReplyReader;
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

  // The workspace turn is prepared once, before dispatch. A reattaching
  // attempt (receipt saved, nothing settled) observes a submission that is
  // still running in that workspace; preparing again would revoke its egress
  // under it.
  if (input.useCloudflareSandbox && !input.state.dispatchReceipt) {
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
  // Resolved before dispatch: a turn that cannot be observed must not be
  // admitted. On Cloudflare a long-poll into the agent object nests
  // cross-object subrequests until the platform rejects them, so the reply is
  // observed with bounded immediate reads instead of Flue's `read()`.
  const observeReply = input.observeReply ??
    (isCloudflareTarget() ? createCloudflareBoundedAgentReplyReader(input.env) : undefined);
  let envelope = input.state.dispatchEnvelope ??
    await input.state.prepare(input.message, observation, input.threadImages, input.admittedListIds);
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

  // Flue's UI reply folds every assistant step (including interrupted drafts)
  // into one text value. Retain the durable step boundary before that fold.
  const terminalText = new TerminalStepText(receipt.submissionId);
  const milestoneTarget = { instanceId: envelope.instanceId, submissionId: receipt.submissionId };
  const onWorkspaceMilestone = input.onWorkspaceMilestone;
  const milestones = onWorkspaceMilestone
    ? createWorkspaceMilestoneRelay(
        receipt.submissionId,
        (record) => onWorkspaceMilestone(record, milestoneTarget),
      )
    : undefined;
  let reply: AgentReply;
  const onEvent = (chunk: ConversationStreamChunk) => {
    terminalText.onEvent(chunk);
    progressiveRelay?.onEvent(chunk);
    milestones?.onEvent(chunk);
  };
  input.onObservationStarted?.();
  const signal = input.observationSignal;
  try {
    reply = observeReply
      ? await observeReply({
          handle,
          instanceId: envelope.instanceId,
          receipt,
          onEvent,
          ...(signal ? { signal } : {}),
          ...(milestones ? { isIdleCandidate: milestones.isIdleCandidate } : {}),
          ...(input.codingTaskStarted ? { initialIdleCandidate: true } : {}),
        })
      : await handle.read(receipt as DispatchReceipt, { onEvent });
  } catch (error) {
    await milestones?.drain();
    if (signal?.aborted && isObservationAbort(error, signal)) {
      // A deliberate yield is not an interruption of the relay: leave the
      // stream and intent exactly as they are so the reattached read resumes
      // them from the durable position.
      await progressiveRelay?.suspendAndDrain();
      throw new AgentObservationYield();
    }
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
    const classified = classifyFlueRunFailure(error);
    // Only an attached container can fail a turn as a sandbox failure. A
    // workspace tool reports its failures to the model as tool results.
    const attachedContainer = input.runtimePlan
      ? input.runtimePlan.sandbox.mode === 'cloudflare'
      : input.useCloudflareSandbox;
    const kind = !attachedContainer &&
        (classified === 'sandbox' || classified === 'sandbox-session-cap')
      ? 'agent'
      : classified;
    logDispatchFailure('settlement_failed', receipt.submissionId, undefined, error);
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

  milestones?.replay(reply.data?.[WORKSPACE_MILESTONE_DATA_NAME]);
  await milestones?.drain();

  let completed: AgentDispatchResult;
  try {
    completed = resultFromAgentReply({ ...reply, text: terminalText.resolve(reply.text) }, input.requestedModel);
  } catch (error) {
    const failureKind = error instanceof AgentPromptFailure && error.kind === 'invalid-output'
      ? 'invalid-output' : 'agent';
    logDispatchFailure('invalid_result', receipt.submissionId, Boolean(reply.text));
    let checkpoint: FlueSettlementCheckpointV1;
    try {
      checkpoint = await input.state.recordSettlement({
        outcome: 'failed',
        settledAt: now(),
        failureKind,
      });
    } catch (settlementError) {
      await progressiveRelay?.invalidateAndDrain('settlement_persist_failed');
      throw settlementError;
    }
    input.state.flueSettlement = checkpoint;
    await progressiveRelay?.invalidateAndDrain('invalid_result');
    await input.beforeResult?.();
    throw new AgentPromptFailure(failureKind);
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
  return {
    ...resultFromSettlement(checkpoint),
    codingWorkspaceOpened: codingWorkspaceOpenedFromReplyData(
      reply.data?.[CODING_WORKSPACE_USE_DATA_NAME],
    ),
  };
}

/**
 * Only the abort itself is a yield. Any other error the read produced (a
 * settled failure, a missing agent instance) keeps its own meaning even when
 * it surfaces after the signal fired.
 */
function isObservationAbort(error: unknown, signal: AbortSignal): boolean {
  return error === signal.reason ||
    error instanceof BoundedObservationAbortedError;
}

/** Slack presents the final self-contained assistant step, not working narration. */
class TerminalStepText {
  private step: { conversationId: string; messageId: string; text: string; completed: boolean } | undefined;
  private position: { batch: number; index: number } | undefined;
  constructor(private readonly submissionId: string) {}

  onEvent(chunk: import('@flue/runtime').ConversationStreamChunk): void {
    const prior = this.position;
    if (prior && (chunk.position.batch < prior.batch ||
        (chunk.position.batch === prior.batch && chunk.position.index <= prior.index))) return;
    this.position = chunk.position;
    if (chunk.type === 'conversation-reset') {
      // A folded snapshot has no assistant-step boundaries. Do not guess.
      this.step = undefined;
    } else if (chunk.type === 'message-started' && chunk.submissionId === this.submissionId) {
      this.step = { conversationId: chunk.conversationId, messageId: chunk.messageId, text: '', completed: false };
    } else if (this.step && chunk.conversationId === this.step.conversationId &&
        'messageId' in chunk && chunk.messageId === this.step.messageId) {
      if (chunk.type === 'message-delta' && chunk.kind === 'text' && !this.step.completed) {
        this.step.text += chunk.delta;
        if (this.step.text.length > 128 * 1024) this.step = undefined;
      } else if (chunk.type === 'message-completed') {
        this.step.completed = true;
      }
    }
  }

  resolve(folded: string): string {
    const text = this.step?.completed ? this.step.text : undefined;
    // Only replace a proven complete trailing step. Legacy/snapshot-only reads
    // and structured replies without text retain their existing behavior.
    return text && (folded === text || folded.endsWith(`\n\n${text}`)) ? text : folded;
  }
}

/** Distinguish terminal failure boundaries without logging error or reply content. */
function logDispatchFailure(
  stage: 'settlement_failed' | 'invalid_result',
  submissionId: string,
  hasText?: boolean,
  error?: unknown,
): void {
  try {
    console.error('[chickpea] agent dispatch failed:', {
      stage,
      submissionRef: opaqueId('fluesubmission', submissionId),
      ...(hasText === undefined ? {} : { hasText }),
      ...(error === undefined ? {} : { causes: settlementFailureFacts(error) }),
    });
  } catch {
    // Diagnostics must not interrupt settlement or change retry behavior.
  }
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
  const artifacts = parseSlackArtifactReceipts(reply.data?.[SLACK_ARTIFACT_RECEIPTS_DATA_NAME]);
  // Checkpoints and the Work ledger require nonempty approved text. A file-only
  // model result still has a useful host caption for its combined Slack reply.
  const text = resolveFileDeliveryText(reply.text || (artifacts.length > 0 ? 'Requested files' : ''), reply.data?.[FILE_DELIVERY_DATA_NAME]);
  if (!text && artifacts.length === 0) throw new Error('agent prompt returned no result text');
  // Reject only extreme single-punctuation degeneration, not code, JSON,
  // Markdown separators, short emphatic answers, or mixed punctuation.
  if (/^([!?])\1{1023,}$/.test(text.trim())) throw new AgentPromptFailure('invalid-output');
  const metadata = parseChickpeaResponseMetadata(reply.metadata?.[CHICKPEA_RESPONSE_METADATA_KEY]);
  const usage = metadata ? parseReportedUsage(metadata.usage) : {
    reportedUsage: null,
    completeness: 'not_reported' as const,
  };
  const tablePresentations = parseSlackTablePresentations(
    reply.data?.[SLACK_TABLE_PRESENTATION_DATA_NAME],
  );
  const memoryUpdate = parseSlackMemoryUpdate(reply.data?.[SLACK_MEMORY_UPDATE_DATA_NAME]);
  const codingModel = parseCodingWorkerRunModel(reply.data?.[CODING_WORKER_RUN_DATA_NAME]);
  const codingWorkerUsage = parseCodingWorkerUsage(reply.data?.[CODING_WORKER_USAGE_DATA_NAME]);
  const agentCreationTerminal = parseSlackAgentCreationTerminalIntents(
    reply.data?.[SLACK_AGENT_CREATION_TERMINAL_DATA_NAME],
  )[0];
  return {
    text,
    ...(tablePresentations.length > 0 ? { tablePresentations } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(agentCreationTerminal ? { agentCreationTerminal } : {}),
    ...(memoryUpdate ? { memoryUpdate } : {}),
    ...(codingModel ? { codingModel } : {}),
    ...(codingWorkerUsage.length > 0 ? { codingWorkerUsage } : {}),
    requestedModel: metadata?.requestedModel ?? nonEmptyString(requestedModel),
    returnedModel: metadata?.returnedModel ?? null,
    reportedUsage: usage.reportedUsage,
    usageCompleteness: usage.completeness,
    flueSubmissionRef: opaqueId('fluesubmission', reply.submissionId),
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
    type.includes('sandbox_connection_dropped') ||
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
      const sandbox = reconnectingSandboxStub(() => getSandbox(
        binding as Parameters<typeof getSandbox>[0],
        sandboxKey,
        options,
      )) as ReturnType<typeof getSandbox> & SandboxTurnContext;
      await prepareSandboxTurn(sandbox, turnId);
    }),
  );
  if (preparations.some((result) => result.status === 'rejected')) {
    throw new Error('sandbox turn preparation failed');
  }
}

/**
 * End a Slack turn without stopping the thread's workspace. The container
 * stays warm for follow-ups until `sleepAfter` idles it out; only the turn's
 * egress grants are revoked, so nothing left running in it keeps GitHub
 * access between turns.
 */
export async function endCloudflareSandboxTurn(
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
    const revocations = await Promise.allSettled(
      cloudflareSandboxOptionVariants(sandboxKey).map(async (options) => {
        const sandbox = reconnectingSandboxStub(() => getSandbox(
          binding as Parameters<typeof getSandbox>[0],
          sandboxKey,
          options,
        )) as ReturnType<typeof getSandbox> & { endTurn(): Promise<void> };
        await sandbox.endTurn();
      }),
    );
    if (revocations.some((result) => result.status === 'rejected')) {
      console.warn('[chickpea] coding workspace egress revocation did not complete');
    }
  } catch {
    console.warn('[chickpea] coding workspace egress revocation did not complete');
  }
}

/**
 * Destroy the workspace outright. Routine runs use this at their end: nobody
 * follows up in a scheduled run's workspace, so it never stays warm.
 */
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
        const sandbox = reconnectingSandboxStub(() => getSandbox(
          binding as Parameters<typeof getSandbox>[0],
          sandboxKey,
          options,
        )) as ReturnType<typeof getSandbox> & { destroy(): Promise<void> };
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
