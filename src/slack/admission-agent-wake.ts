import { deriveSlackTurnInstanceId, isRuntimePlanInstanceId } from '../agents/runtime-plan.ts';
import type { InstallationOwnership } from '../config/installation-scope.ts';
import type { TurnProgress } from '../config/state-rpc.ts';
import type { InstallationObjectRecorder } from '../state/object-inventory.ts';
import { turnJobGate, type PendingTurnJob } from './turn-jobs.ts';
import { isDeterministicSlackCommand } from './turn-commands.ts';

/** The wake admission sent a handed-over turn's Agent object, as the hand-off carries it to the runner. */
export interface AdmissionAgentWake {
  /** The instance admission derived and woke (deriveSlackTurnInstanceId). */
  instanceId: string;
  /** When the state store sent the wake, on its clock. */
  sentAt: number;
}

/** What admission holds of a turn it hands over. */
export type HandedOverTurn =
  & Pick<PendingTurnJob, 'turn' | 'assignment' | 'stop' | 'fold' | 'runtimePlan' | 'agentInstanceId' | 'dispatchReceipt' | 'flueSettlement'>
  & { progress: Pick<TurnProgress, 'interactionIntent'> };

/** What the state store knows besides the turn when it hands it over. */
export interface AdmissionAgentFacts {
  installation: InstallationOwnership | undefined;
  /** The installation's bot, which a command may address. */
  botUserId: string | undefined;
  inventory: Pick<InstallationObjectRecorder, 'recordAgentInstance'>;
}

/**
 * The Flue instance a handed-over turn's plan will name, recorded in the
 * installation's inventory before anything addresses it; or undefined when,
 * by what admission knows, the turn freezes no plan: a stop holds or stopped
 * it, it already froze or dispatched one, it was judged react_only, the host
 * answers it (a command, an approval), or its Agent has no model. A turn
 * judged react_only later, or whose model needs repair, wastes the wake.
 */
export function admissionAgentInstance(job: HandedOverTurn, facts: AdmissionAgentFacts): string | undefined {
  if (turnJobGate(job) !== 'run') return undefined;
  if (job.runtimePlan || job.agentInstanceId || job.dispatchReceipt || job.flueSettlement) return undefined;
  if ((job.turn.interactionIntent ?? job.progress.interactionIntent)?.disposition === 'react_only') return undefined;
  if (job.assignment.runtimeContract === 'chickpea-v1' && !job.assignment.model) return undefined;
  if (isDeterministicSlackCommand(job.turn, {
    botUserId: facts.botUserId,
    agentUserGroupId: job.assignment.agent.slackPresence?.userGroupId,
  })) return undefined;
  const instanceId = deriveSlackTurnInstanceId(job.turn, job.assignment, facts.installation);
  facts.inventory.recordAgentInstance('slack_agent', instanceId);
  return instanceId;
}

/** A carried wake as the runner takes it from a hand-off: anything malformed is no wake. */
export function parseAdmissionAgentWake(value: unknown): AdmissionAgentWake | undefined {
  const wake = value as Partial<AdmissionAgentWake> | null | undefined;
  return wake && isRuntimePlanInstanceId(wake.instanceId) && typeof wake.sentAt === 'number' && Number.isFinite(wake.sentAt)
    ? { instanceId: wake.instanceId, sentAt: wake.sentAt }
    : undefined;
}
