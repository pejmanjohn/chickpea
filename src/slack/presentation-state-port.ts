import type { SlackStateStore } from './claim-store.ts';
import type { SlackPresentationStatePort } from './agent-view-presentation.ts';

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
    ...activityCoordinator,
    matchFlueObservation: state.matchFlueObservation.bind(state),
  };
}
