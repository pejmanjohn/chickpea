import type { TypedActivityStatus } from '../activity/status.ts';
import type { RuntimePlanV2 } from '../agents/runtime-plan.ts';
import type {
  StateRpcResult,
  TurnProgress,
  TurnPullRequestProgress,
} from '../config/state-rpc.ts';
import type { UsagePersistenceEvent } from '../usage/runtime-recorder.ts';
import type { WorkspaceInstallation } from '../config/types.ts';
import { SLACK_SETTING_KEYS } from './credentials.ts';
import { GATEWAY_DEPLOYMENT_IDENTITY_SETTING } from './gateway/identity.ts';
import { GATEWAY_BINDING_SETTING } from './gateway/settings.ts';
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
  /**
   * `view` plus what the turn reads from the state store before its first
   * Slack status (the installation record, the gateway settings, the public
   * URL, the thread's session generation), so a runner starts a turn with
   * one round trip.
   */
  begin: [{ id: string }, RunnerTurnBegin];
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
  isCodingActiveWork: [{ key: string; generation: string }, boolean];
  /** Write the runner's presentation back for the state store's readers. */
  putPresentation: [{ presentation: SlackRunPresentation }, boolean];
}

export interface RunnerTurnBegin {
  view: RunnerTurnJobView;
  /** The pending turn's workspace installation, when there is one. */
  installation?: WorkspaceInstallation;
  /** RUNNER_PREFETCHED_SETTINGS values; null when unset. */
  settings: Record<string, string | null>;
  /**
   * The newest session generation the state store holds for the turn's Slack
   * thread (null when none), which the turn's first activity status checks.
   * Absent when the turn has no V3 presentation or the state store predates it.
   */
  latestThreadSessionGeneration?: number | null;
}

/**
 * Settings a turn reads before its first Slack status: those a gateway
 * installation's execution context reads, and the stored public URL.
 */
export const RUNNER_PREFETCHED_SETTINGS: readonly string[] = [
  GATEWAY_BINDING_SETTING,
  GATEWAY_DEPLOYMENT_IDENTITY_SETTING,
  SLACK_SETTING_KEYS.publicUrl,
];

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
  /**
   * Persist a hand-off. `refused` (a reason token) means the runner did not
   * take the job, so the state store keeps it a hand-off and retries.
   */
  admit(job: ThreadRunnerJob): Promise<{ admitted: boolean; refused?: string }>;
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
  /**
   * `versionId` is serving. A runner on another version yields the turns it
   * is observing, so its next alarm reattaches them on the serving version;
   * `superseded` counts them. A runner on that version does nothing.
   */
  supersede(versionId: string): Promise<{ superseded: number }>;
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
