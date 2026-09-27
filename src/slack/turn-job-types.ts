import { type SlackMemoryUpdate } from './memory-update-terminal.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import type { RunExecutionAuthority } from '../work/types.ts';
import type { AdmittedRuntimePlanData, RuntimePlanV2 } from '../agents/runtime-plan.ts';
import type { WorkTraceCorrelation } from '../work/trace-correlation.ts';
import type { SlackTablePresentation } from './table-presentation.ts';
import type { SlackArtifactReceipt } from './artifact-receipts.ts';
import type { SlackAgentCreationTerminalIntent } from './agent-creation-terminal.ts';
import type { NormalizedSlackTurn } from './types.ts';
import type { CodingWorkerUsageRecord } from './coding-worker-run.ts';

interface FlueDispatchEnvelopeBase {
  agentName: 'chickpea-slack-v2';
  instanceId: string;
  /** null creates the planned incarnation; a string continues the pinned one. */
  uid: string | null;
  /** Present only on create-only first contact; resent exactly as admitted. */
  initialData?: AdmittedRuntimePlanData;
  idempotencyKey: string;
  /** CAS guard used when a governed harness revision rotates an incarnation. */
  previousBinding?: SlackAgentBindingExpectation;
}

/** Pre-management admission input retained for pending durable retries. */
interface LegacyFlueDispatchEnvelopeV1 extends FlueDispatchEnvelopeBase {
  schemaVersion: 1;
  message: {
    kind: 'user';
    body: string;
  };
}

/** Current Flue 2 admission input with requester facts bound to the signal. */
interface FlueDispatchEnvelopeV2 extends FlueDispatchEnvelopeBase {
  schemaVersion: 2;
  message: {
    kind: 'signal';
    type: 'slack.message';
    body: string;
    tagName: 'slack_message';
    attributes: {
      workspaceId: string;
      channelId: string;
      threadTs: string;
      conversationKind?: 'channel' | 'im' | 'mpim';
      slackUserId: string;
      eventId: string;
      messageTs: string;
      turnJobId: string;
      /** Authenticated triggering Slack text, kept separate from the assembled model prompt. */
      requesterText?: string;
      requesterTimezone?: string;
      /** Comma-separated Slack file ids; bytes and private URLs remain outside durable state. */
      attachmentFileIds?: string;
      attachmentIntakeStatus?: 'ok' | 'too_many' | 'invalid_metadata';
      attachmentCount?: string;
      /**
       * Bounded JSON list of this turn's thread images, without any
       * conversation key: the Agent re-derives that from its frozen plan.
       * Slack file ids only — no bytes and no private URLs.
       */
      threadImages?: string;
      /** Sorted bounded List ids admitted from host-visible current-task sources. */
      admittedListIds?: string;
    };
  };
}

/** Compatibility name used across the durable relay while both versions drain. */
export type FlueDispatchEnvelopeV1 = LegacyFlueDispatchEnvelopeV1 | FlueDispatchEnvelopeV2;

/** Raw-but-bounded Flue receipt retained only in adapter-owned TurnJob state. */
export interface FlueDispatchReceiptV1 {
  submissionId: string;
  acceptedAt: string;
  uid: string;
  deduplicated?: true;
}

export type FlueSettlementCheckpointV1 =
  | {
      outcome: 'completed';
      settledAt: number;
      result: {
        text: string;
        tablePresentations?: SlackTablePresentation[];
        artifacts?: SlackArtifactReceipt[];
        agentCreationTerminal?: SlackAgentCreationTerminalIntent;
        memoryUpdate?: SlackMemoryUpdate;
        codingModel?: string;
        codingWorkerUsage?: CodingWorkerUsageRecord[];
        requestedModel: string | null;
        returnedModel: { provider: string; id: string } | null;
        reportedUsage: {
          inputTokens: number | null;
          outputTokens: number | null;
          cacheReadTokens?: number | null;
          cacheWriteTokens?: number | null;
          totalTokens: number | null;
        } | null;
        usageCompleteness: 'complete' | 'partial' | 'not_reported';
        flueSubmissionRef?: string | null;
      };
    }
  | {
      outcome: 'failed' | 'aborted';
      settledAt: number;
      failureKind:
        | 'agent'
        | 'provider'
        | 'invalid-output'
        | 'openai-subscription-reconnect'
        | 'openai-subscription-quota'
        | 'openai-subscription-policy'
        | 'sandbox'
        | 'sandbox-session-cap';
    };

/** Model-invisible facts observers recover from app-owned state. */
export interface FlueTurnObservationV1 {
  generation: string;
  workCorrelation?: WorkTraceCorrelation;
  /** Effective live configuration frozen into this turn, never model-visible. */
  harnessRevision?: string;
  configurationRevision?: {
    agent: number;
    channel?: number;
  };
  /**
   * Set when a per-thread SlackThreadRunner executes the turn: the agent
   * relays observed activity to that runner (addressed by `runnerKey`, the
   * thread key) instead of the shared state store.
   */
  executor?: 'runner';
  runnerKey?: string;
}

export interface FlueObservationTarget extends FlueTurnObservationV1 {
  turnJobId: string;
  instanceId: string;
  submissionId?: string;
}

/** The Slack control that asked for a stop: a typed stop phrase or the Stop button. */
export type TurnStopSource = 'typed' | 'button';

/**
 * Durable stop record on a turn row (`turn_jobs.stop_json`, additive: an
 * older release ignores the column). A stopped run's head row carries
 * `stopped`; each earlier unread row the stop holds carries `held`, which
 * becomes `dropped` (under the existing `done` status) or `released` once the
 * stopped ending finishes. Row status keeps its existing vocabulary: this
 * record plus Flue's `aborted` settlement are the discriminator (KTD2).
 */
export type TurnStopRecordV1 = TurnStopHeadRecordV1 | TurnStopMemberRecordV1;

export interface TurnStopHeadRecordV1 {
  schemaVersion: 1;
  role: 'stopped';
  source: TurnStopSource;
  /** Slack user id of the person who stopped the run; the stop note names them. */
  stopperUserId: string;
  /** The stop's own Slack timestamp (the typed stop's or the button event's). */
  cutoffTs: string;
  stoppedAt: number;
  /** Set once, when the stopped ending drops the held rows or a completion race releases them. */
  ending?: TurnStopEndingV1;
}

export interface TurnStopEndingV1 {
  outcome: 'dropped' | 'released';
  /** Rows the ending dropped or released. */
  count: number;
  at: number;
}

/**
 * The thread's previous run ended with a stop that stopped it (its stopped
 * ending dropped, not released): the next turn's prompt says so, and by whom,
 * so the Agent does not resume the stopped work unless asked (KTD3).
 */
export interface TurnPreviousStop {
  stopperUserId: string;
  stoppedAt: number;
}

export interface TurnStopMemberRecordV1 {
  schemaVersion: 1;
  role: 'held' | 'dropped' | 'released';
  /** The stopped head row. */
  headId: string;
  at: number;
}

/**
 * A matched stop or check-in (or a plain message) for one Slack thread,
 * decided against the thread's undelivered rows in one state-store
 * transaction (KTD1). `threadKey` is `turnStopThreadKey`: the conversation
 * without its owner incarnation, so a stop reaches a run across a handoff.
 */
export type TurnSteeringRequest =
  | {
      kind: 'stop';
      threadKey: string;
      source: TurnStopSource;
      stopperUserId: string;
      cutoffTs: string;
    }
  | { kind: 'check_in'; threadKey: string }
  | { kind: 'message'; threadKey: string };

/** Where a thread's current run executes, for an admission-time run-facts read. */
export interface TurnRunRoute {
  /** The running row, or the next row when none has dispatched. */
  turnJobId: string;
  /** Its thread runner (`slackAgentThreadKey`), owner incarnation included. */
  runnerKey: string;
  executor: 'alarm' | 'runner';
  agentId: string;
  requesterUserId: string;
  dispatched: boolean;
  /** The thread's undelivered rows, this one included. */
  undelivered: number;
}

export interface TurnStopResult {
  /** False when the thread's run already carried a stop: that first stop stands. */
  created: boolean;
  headId: string;
  runnerKey: string;
  executor: 'alarm' | 'runner';
  agentId: string;
  record: TurnStopHeadRecordV1;
  /** Rows the stop holds now, late arrivals included. */
  held: number;
  /** The head row's frozen Flue admission, when its dispatch started. */
  dispatchEnvelope?: FlueDispatchEnvelopeV1;
  dispatchReceipt?: FlueDispatchReceiptV1;
}

/**
 * `stopped`: the stop is recorded (or already was). `check_in`: answer from
 * the run's facts. `enqueue`: the thread has nothing to steer, so the message
 * is an ordinary turn (enqueued in the same transaction when one was given);
 * `undelivered` says whether a run is in progress.
 */
export type TurnSteeringDecision =
  | { outcome: 'stopped'; stop: TurnStopResult }
  | { outcome: 'check_in'; run: TurnRunRoute }
  | { outcome: 'enqueue'; undelivered: boolean; enqueued?: boolean };

/** What the stopped ending (or a completion race) did with the held rows. */
export interface TurnStopFinish {
  outcome: 'dropped' | 'released';
  count: number;
  /** Content-free coordinates of those rows, to finalize their records and receipts. */
  rows: Array<{
    id: string;
    runId?: string;
    messageTs?: string;
    /** The row's 👀 Chickpea added and has not removed yet (KTD9). */
    receipt?: TurnMidRunReceipt;
  }>;
  record: TurnStopHeadRecordV1;
}

/**
 * One entry of the state store's stop outbox: the head row's runner must
 * learn of the stop (and abort its Flue work). Redelivered with a backoff
 * until the runner acknowledges it.
 */
export interface TurnStopNotice {
  turnJobId: string;
  runnerKey: string;
  executor: 'alarm' | 'runner';
  record: TurnStopHeadRecordV1;
  /** Deliveries already attempted (0 on the first). */
  attempts: number;
  /** From the persisted dispatch envelope and receipt, when the dispatch started. */
  instanceId?: string;
  uid?: string;
  submissionId?: string;
}

/**
 * What the outbox calls. A thread runner implements it as its `stop` RPC:
 * `acknowledged: false` (or a rejection) leaves the notice due for a retry.
 */
export interface TurnStopNoticeReceiver {
  stop(notice: TurnStopNotice): Promise<{ acknowledged: boolean }>;
}

/** JSON-clonable durable relay payload shared by Node and Cloudflare state. */
export interface TurnJob {
  id: string;
  evtKey: string;
  msgKey: string;
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  /** Canonical Run correlation for either compatibility or ledger ownership. */
  runId?: string;
  /** Missing only on pre-cutover rows and old test fixtures; those are legacy. */
  executionAuthority?: RunExecutionAuthority;
  /** First-write-wins harness and target decision, populated before dispatch. */
  runtimePlan?: RuntimePlanV2;
  agentInstanceId?: string;
  /**
   * Chickpea's 👀 on this message, which arrived while its thread's run was
   * in progress (R12, KTD9). Written with the row, before Slack is asked to
   * add it, as the turn's receipt: its queued turn reuses it, and that turn's
   * finish, or a stop that drops it, removes exactly this reaction on exactly
   * this message. Only the job's own message may carry one.
   */
  midRunReceipt?: TurnMidRunReceipt;
}

/** Where Chickpea's mid-run 👀 goes: the message's own coordinates and emoji. */
export interface TurnMidRunReceipt {
  channelId: string;
  messageTs: string;
  name: string;
}

/** The only long-lived app-owned binding to a Flue conversation incarnation. */
export interface SlackAgentBinding {
  continuityKey: string;
  instanceId: string;
  uid: string;
  updatedAt: number;
}

export interface SlackAgentBindingExpectation {
  instanceId: string;
  uid: string;
}

export interface FrozenRuntimePlanDecision {
  runtimePlan: RuntimePlanV2;
  instanceId: string;
}

/**
 * A steering decision that took the message instead of queueing it: a stop
 * recorded, or a check-in to answer. No Run or TurnJob is written for it.
 */
export type TurnSteeringInterception = Exclude<TurnSteeringDecision, { outcome: 'enqueue' }>;

/**
 * One person's threads in one DM channel, for a top-level stop or check-in
 * there: it means that person's single running DM thread (KTD1).
 */
export interface TurnDirectThreadQuery {
  workspaceId: string;
  channelId: string;
  requesterUserId: string;
}
