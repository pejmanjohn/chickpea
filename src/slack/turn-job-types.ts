import type { ResolvedAssignment } from '../config/types.ts';
import type { RunExecutionAuthority } from '../work/types.ts';
import type { RuntimePlanV2 } from '../agents/runtime-plan.ts';
import type { NormalizedSlackTurn } from './types.ts';

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
