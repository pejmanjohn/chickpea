import type { SlackStateStore } from './claim-store.ts';
import type { SlackPresentationStatePort } from './agent-view-presentation.ts';
import type { SlackRunPresentationStoreLogic } from './run-presentations.ts';

/** Adapt the optional presentation surface on a target-neutral Slack state store. */
export function slackPresentationStatePort(
  state: SlackStateStore,
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
  };
}

/**
 * The presentation port over one SQLite owner's `slack_run_presentations`
 * logic. The shared state store passes the logic over its own database; a
 * per-thread runner can pass logic built on its own `StateDb`.
 */
export function localSlackPresentationStatePort(input: {
  presentations: SlackRunPresentationStoreLogic;
  matchFlueObservation: SlackPresentationStatePort['matchFlueObservation'];
}): SlackPresentationStatePort {
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
  };
}
