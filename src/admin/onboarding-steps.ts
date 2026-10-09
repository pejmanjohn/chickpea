import { hostedGithubConnectPath } from '../config/hosted-github.ts';
import { platformBilling } from '../config/platform-billing.ts';

export type OnboardingStepId = 'slack' | 'provider' | 'model' | 'github' | 'try';

export interface OnboardingStep {
  id: OnboardingStepId;
  label: string;
}

/**
 * The steps a person sees from adding Chickpea to Slack to its first reply.
 * One plan serves the host's Add to Slack page and Admin's onboarding, so the
 * step bar never changes between them.
 */
export function onboardingSteps(input: {
  selfHosted: boolean;
  /** Chickpea's models are set up for the workspace: no provider or model to choose. */
  chickpeaModels: boolean;
  /** The host can start a GitHub connect. Standalone never offers it. */
  github: boolean;
}): OnboardingStep[] {
  return [
    { id: 'slack', label: input.selfHosted ? 'Connect Slack' : 'Add to Slack' },
    ...(input.chickpeaModels ? [] : [
      { id: 'provider', label: 'Choose provider' },
      { id: 'model', label: 'Choose model' },
    ] as const),
    ...(input.github && !input.selfHosted ? [{ id: 'github', label: 'Connect GitHub' }] as const : []),
    { id: 'try', label: 'Try Chickpea' },
  ];
}

/** The plan for a host's Add to Slack page, where the person becomes the first Owner. */
export async function hostedSignUpOnboardingSteps(): Promise<OnboardingStep[]> {
  return onboardingSteps({
    selfHosted: false,
    chickpeaModels: platformBilling() !== undefined,
    github: await hostedGithubConnectPath() !== null,
  });
}
