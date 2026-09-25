import type { TypedActivityStatus } from '../activity/status.ts';
import type { RuntimePlanV2 } from '../agents/runtime-plan.ts';
import type {
  StateRpcResult,
  TurnProgress,
  TurnPullRequestProgress,
} from '../config/state-rpc.ts';
import type { UsagePersistenceEvent } from '../usage/runtime-recorder.ts';
import type { SlackInteractionIntent } from './interaction-intent.ts';
import type {
  SlackPresentationTransitionInput,
  SlackPresentationTransitionResult,
  SlackRunPresentation,
} from './run-presentations.ts';
import type { FrozenRuntimePlanDecision } from './turn-job-types.ts';
import type { RunnerTurnJobView } from './turn-jobs.ts';
import type { ThreadRunnerJob, ThreadRunnerStatus } from './thread-runner-jobs.ts';

/**
 * Per-turn state-store operations a thread runner makes over one RPC method
 * (`TagStateRpc.threadRunnerTurn`): the turn-row writes the existing Slack
 * state RPCs do not cover. Each is called a bounded number of times per turn,
 * never per poll. Entries are `[input, result]`; results use null for none.
 */
export interface ThreadRunnerTurnOps {
  /** The authoritative row, read before the runner runs or reattaches. */
  view: [{ id: string }, RunnerTurnJobView];
  /** The runner is done with a row; pending Slack cleanup returns to the state store. */
  finish: [{ id: string }, RunnerTurnJobView];
  recordAttempt: [{ id: string; attempts: number }, null];
  recordPullRequest: [{ id: string; pullRequest: TurnPullRequestProgress }, TurnProgress | null];
  freezeRuntimePlan: [{ id: string; candidate: RuntimePlanV2 }, FrozenRuntimePlanDecision];
  getBoundRuntimePlan: [{
    continuityKey: string;
    beforeMessageTs: string;
    actorMembershipId: string;
    agentId: string;
  }, RuntimePlanV2 | null];
  recordUsagePersistence: [{ id: string; event: UsagePersistenceEvent }, TurnProgress | null];
  recordInteractionIntent: [{ id: string; intent: SlackInteractionIntent }, TurnProgress | null];
  markDelivered: [{ id: string }, null];
  markError: [{ id: string }, null];
  markCodingActiveWork: [{ key: string; generation: string }, null];
  /** Write the runner's presentation back for the state store's readers. */
  putPresentation: [{ presentation: SlackRunPresentation }, boolean];
}

export type ThreadRunnerTurnKind = keyof ThreadRunnerTurnOps;

export type ThreadRunnerTurnOp<K extends ThreadRunnerTurnKind = ThreadRunnerTurnKind> =
  K extends ThreadRunnerTurnKind ? { kind: K } & ThreadRunnerTurnOps[K][0] : never;

export type ThreadRunnerTurnResult<K extends ThreadRunnerTurnKind> = ThreadRunnerTurnOps[K][1];

/** What the state store hands a thread runner with each turn it dispatches. */
export interface ThreadRunnerJobPayload {
  /**
   * The turn's presentation as the state store held it at hand-off. The
   * runner keeps the authoritative copy from then on.
   */
  presentation?: SlackRunPresentation;
}

/** The RPC surface of one `SlackThreadRunner` (see thread-runner.ts). */
export interface SlackThreadRunnerRpc {
  admit(job: ThreadRunnerJob): Promise<{ admitted: boolean }>;
  status(): Promise<ThreadRunnerStatus>;
  /** Activity the agent observed for a turn this runner executes. */
  observedStatus(
    instanceId: string,
    submissionId: string,
    status: TypedActivityStatus,
  ): Promise<StateRpcResult<null>>;
  /**
   * The authoritative presentation of one of this runner's turns, for effects
   * the state store applies from outside the turn (an Agent welcome).
   */
  presentationGet(runId: string): Promise<StateRpcResult<SlackRunPresentation | null>>;
  presentationTransition(
    input: SlackPresentationTransitionInput,
  ): Promise<StateRpcResult<SlackPresentationTransitionResult>>;
}

interface ThreadRunnerNamespace {
  getByName(name: string): SlackThreadRunnerRpc;
}

/** The runner of one thread key, or undefined without the binding. */
export function threadRunnerStub(
  env: Record<string, unknown> | undefined,
  threadKey: string,
): SlackThreadRunnerRpc | undefined {
  const namespace = env?.SLACK_THREAD_RUNNER as ThreadRunnerNamespace | undefined;
  if (!namespace || typeof namespace.getByName !== 'function') return undefined;
  return namespace.getByName(threadKey);
}
