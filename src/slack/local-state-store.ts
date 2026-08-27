import type { WorkStoreLogic } from '../work/store.ts';
import type { SlackCanonicalAdmissionInput, SlackStateStore, SlackStateLogic } from './claim-store.ts';
import { MAX_TURN_DRAIN_BATCH, type TurnJobStoreLogic } from './turn-jobs.ts';
import type { SlackRunPresentationStoreLogic } from './run-presentations.ts';

/**
 * Promise-shaped Slack state port for code already running inside the shared
 * state owner. Unlike a generic async wrapper, this adapter composes the raw
 * logic classes that jointly own canonical admission, durable turns, and run
 * presentations. Those collaborators must participate in the same SQLite
 * transaction; omitting them makes follow-up Slack turns fail at admission.
 */
export function localSlackStateStore(input: {
  slack: SlackStateLogic;
  work: WorkStoreLogic;
  turnJobs: TurnJobStoreLogic;
  presentations: SlackRunPresentationStoreLogic;
}): SlackStateStore {
  const { slack, work, turnJobs, presentations } = input;
  return {
    claim: async (key) => slack.claim(key),
    release: async (key) => slack.release(key),
    start: async (key) => slack.start(key),
    has: async (key) => slack.has(key),
    isActiveWork: async (key) => slack.isActiveWork(key),
    setActiveWork: async (key, generation, active) =>
      slack.setActiveWork(key, generation, active),
    admitCanonical: async (admission: SlackCanonicalAdmissionInput) =>
      slack.admitCanonical(admission, work, turnJobs, presentations),
    enqueueTurn: async (job) => turnJobs.enqueue(job),
    resumeTurnAfterOAuth: async (originalTaskId, continuationId) =>
      turnJobs.resumeAfterOAuth(originalTaskId, continuationId),
    pinAgentBinding: async (binding, expected) => turnJobs.pinAgentBinding(binding, expected),
    getAgentBinding: async (continuityKey) => turnJobs.getAgentBinding(continuityKey),
    runtimeDrainCounts: async () => turnJobs.runtimeDrainCounts(),
    countPendingDeliveriesForWorkspace: async (workspaceId) =>
      turnJobs.countPendingDeliveriesForWorkspace(workspaceId),
    listPendingTurns: async () => turnJobs.listPending(MAX_TURN_DRAIN_BATCH),
    getPendingTurnByRunId: async (runId) => turnJobs.getPendingByRunId(runId),
    freezeRuntimePlan: async (id, candidate) => turnJobs.freezeRuntimePlan(id, candidate),
    prepareFlueDispatch: async (id, message, observation) =>
      turnJobs.prepareFlueDispatch(id, message, observation),
    reconcileFlueExistingInstance: async (id, uid) =>
      turnJobs.reconcileFlueExistingInstance(id, uid),
    recordFlueReceipt: async (id, receipt) => turnJobs.recordFlueReceipt(id, receipt),
    recordFlueSettlement: async (id, settlement) =>
      turnJobs.recordFlueSettlement(id, settlement),
    matchFlueObservation: async (instanceId, submissionId) =>
      turnJobs.matchFlueObservation(instanceId, submissionId),
    recordTurnAttempt: async (id, attempts) => turnJobs.recordAttempt(id, attempts),
    recordInteractionIntent: async (id, intent) => {
      turnJobs.recordInteractionIntent(id, intent);
    },
    recordSlackInteractionProgress: async (id, patch) => {
      turnJobs.recordSlackInteractionProgress(id, patch);
    },
    listPendingSlackInteractionCleanups: async () =>
      turnJobs.listPendingSlackInteractionCleanups(MAX_TURN_DRAIN_BATCH),
    hasPendingSlackInteractionCleanup: async () => turnJobs.hasPendingSlackInteractionCleanup(),
    markTurnDelivered: async (id) => turnJobs.markDelivered(id),
    markTurnError: async (id) => turnJobs.markError(id),
    markTurnRecoveryRequired: async (id, reason) => turnJobs.markRecoveryRequired(id, reason),
    listTurnRecoveryRequired: async (limit = 50) => turnJobs.listRecoveryRequired(limit),
    retrySlackInstallationRecovery: async (workspaceId) =>
      turnJobs.retrySlackInstallationRecovery(workspaceId),
    resolveTurnRecoveryRequired: async (id) => turnJobs.resolveRecoveryRequired(id),
    getRunPresentation: async (runId) => presentations.get(runId),
    getLatestThreadSessionGeneration: async (root) =>
      presentations.getLatestThreadSessionGeneration(root),
    transitionRunPresentation: async (transition) => presentations.transition(transition),
    reserveSlackAppend: async (workspaceId) => presentations.reserveAppend(workspaceId),
    applySlackAppendCooldown: async (workspaceId, retryAfterMs) =>
      presentations.applyAppendCooldown(workspaceId, retryAfterMs),
    reserveSlackActivityStatus: async (workspaceId) =>
      presentations.reserveActivityStatus(workspaceId),
    applySlackActivityStatusCooldown: async (workspaceId, retryAfterMs) =>
      presentations.applyActivityStatusCooldown(workspaceId, retryAfterMs),
    listRunPresentationsForRepair: async (limit = 50) =>
      presentations.listAutoRepairableV3(limit),
    maintainRunPresentations: async (limit = 100) => presentations.maintain(limit),
    summarizeRunPresentations: async (workspaceId) => presentations.summarize(workspaceId),
    discardTurn: async (id) => turnJobs.discard(id),
  };
}
