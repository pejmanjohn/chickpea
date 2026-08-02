import type { ResolvedAssignment } from '../config/types.ts';
import type { RunExecutionAuthority } from '../work/types.ts';
import type { RuntimePlanV2 } from '../agents/runtime-plan.ts';
import type { WorkTraceCorrelation } from '../work/trace-correlation.ts';
import type { NormalizedSlackTurn } from './types.ts';

/** Exact Flue 2 admission input, frozen before the first dispatch attempt. */
export interface FlueDispatchEnvelopeV1 {
  schemaVersion: 1;
  agentName: 'chickpea-slack-v2';
  instanceId: string;
  /** null creates the planned incarnation; a string continues the pinned one. */
  uid: string | null;
  message: {
    kind: 'user';
    body: string;
  };
  /** Present only on create-only first contact. */
  initialData?: RuntimePlanV2;
  idempotencyKey: string;
  /** CAS guard used when a governed harness revision rotates an incarnation. */
  previousBinding?: SlackAgentBindingExpectation;
}

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
        requestedModel: string | null;
        returnedModel: { provider: string; id: string } | null;
        reportedUsage: {
          inputTokens: number | null;
          outputTokens: number | null;
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
}

export interface FlueObservationTarget extends FlueTurnObservationV1 {
  turnJobId: string;
  instanceId: string;
  submissionId?: string;
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
  /** Decision only; Slack delivery and its receipt are owned by the U4 envelope. */
  continuityNoticeRequired?: boolean;
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
  continuityNoticeRequired: boolean;
}
