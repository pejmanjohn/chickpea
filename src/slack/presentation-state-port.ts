import { deploymentServesManyInstallations, deploymentTenancy } from '../config/installation-scope.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { SlackStateStore } from './claim-store.ts';
import type { SlackPresentationStatePort } from './agent-view-presentation.ts';
import type { SlackRunPresentationStoreLogic } from './run-presentations.ts';

/**
 * Adapt the optional presentation surface on a target-neutral Slack state
 * store. Under installation tenancy (`env`) its receipt reads book from the
 * store's shared read budget.
 */
export function slackPresentationStatePort(
  state: SlackStateStore,
  env?: PlatformEnv,
): SlackPresentationStatePort | undefined {
  if (
    !state.getRunPresentation ||
    !state.getLatestThreadSessionGeneration ||
    !state.transitionRunPresentation ||
    !state.reserveSlackAppend ||
    !state.applySlackAppendCooldown ||
    !state.matchFlueObservation
  ) return undefined;
  const activityCoordinator = state.reserveSlackActivityStatus &&
      state.applySlackActivityStatusCooldown
    ? {
        reserveSlackActivityStatus: state.reserveSlackActivityStatus.bind(state),
        applySlackActivityStatusCooldown:
          state.applySlackActivityStatusCooldown.bind(state),
      }
    : {};
  return {
    getRunPresentation: state.getRunPresentation.bind(state),
    getLatestThreadSessionGeneration: state.getLatestThreadSessionGeneration.bind(state),
    transitionRunPresentation: state.transitionRunPresentation.bind(state),
    reserveSlackAppend: state.reserveSlackAppend.bind(state),
    applySlackAppendCooldown: state.applySlackAppendCooldown.bind(state),
    ...(state.slackAppendCooldownUntil
      ? { slackAppendCooldownUntil: state.slackAppendCooldownUntil.bind(state) }
      : {}),
    ...activityCoordinator,
    matchFlueObservation: state.matchFlueObservation.bind(state),
    ...(deploymentServesManyInstallations(env) && state.reserveSlackRead && state.applySlackReadCooldown
      ? {
          sharedSlackReads: {
            reserveSlackRead: state.reserveSlackRead.bind(state),
            applySlackReadCooldown: state.applySlackReadCooldown.bind(state),
          },
        }
      : {}),
  };
}

/**
 * The presentation port over one SQLite owner's `slack_run_presentations`
 * logic. The shared state store passes the logic over its own database, and
 * under installation tenancy (`sharedReadsEnv`) books receipt reads from its
 * workspace read budget; a per-thread runner can pass logic built on its own
 * `StateDb`, which holds no shared budget.
 */
export function localSlackPresentationStatePort(input: {
  presentations: SlackRunPresentationStoreLogic;
  matchFlueObservation: SlackPresentationStatePort['matchFlueObservation'];
  sharedReadsEnv?: PlatformEnv;
}): SlackPresentationStatePort & Required<Pick<SlackPresentationStatePort,
  | 'slackAppendCooldownUntil'
  | 'reserveSlackActivityStatus'
  | 'applySlackActivityStatusCooldown'
>> {
  const { presentations, matchFlueObservation } = input;
  return {
    getRunPresentation: (runId) => presentations.get(runId),
    getLatestThreadSessionGeneration: (root) =>
      presentations.getLatestThreadSessionGeneration(root),
    transitionRunPresentation: (transition) => presentations.transition(transition),
    reserveSlackAppend: (workspaceId) => presentations.reserveAppend(workspaceId),
    slackAppendCooldownUntil: (workspaceId) => presentations.appendCooldownUntil(workspaceId),
    applySlackAppendCooldown: (workspaceId, retryAfterMs) =>
      presentations.applyAppendCooldown(workspaceId, retryAfterMs),
    reserveSlackActivityStatus: (workspaceId) =>
      presentations.reserveActivityStatus(workspaceId),
    applySlackActivityStatusCooldown: (workspaceId, retryAfterMs) =>
      presentations.applyActivityStatusCooldown(workspaceId, retryAfterMs),
    matchFlueObservation,
    ...(deploymentTenancy(input.sharedReadsEnv) === 'installation'
      ? {
          sharedSlackReads: {
            reserveSlackRead: async (workspaceId, method) => presentations.reserveSlackRead(workspaceId, method),
            applySlackReadCooldown: async (workspaceId, method, retryAfterMs) =>
              presentations.applySlackReadCooldown(workspaceId, method, retryAfterMs),
          },
        }
      : {}),
  };
}
