import { hostedGithubConnectPath } from '../config/hosted-github.ts';
import { platformBilling } from '../config/platform-billing.ts';

export type OnboardingStepId = 'slack' | 'provider' | 'model' | 'github' | 'try';

export interface OnboardingStep {
  id: OnboardingStepId;
  label: string;
}

export function onboardingSteps(input: {
  selfHosted: boolean;
  onChickpeaModels: boolean;
  githubOffered: boolean;
}): OnboardingStep[] {
  return [
    { id: 'slack', label: input.selfHosted ? 'Connect Slack' : 'Add to Slack' },
    ...(input.onChickpeaModels ? [] : [
      { id: 'provider', label: 'Choose provider' },
      { id: 'model', label: 'Choose model' },
    ] as const),
    ...(input.githubOffered && !input.selfHosted ? [{ id: 'github', label: 'Connect GitHub' }] as const : []),
    { id: 'try', label: 'Try Chickpea' },
  ];
}

export async function hostedSignUpOnboardingSteps(): Promise<OnboardingStep[]> {
  return onboardingSteps({
    selfHosted: false,
    onChickpeaModels: platformBilling() !== undefined,
    githubOffered: await hostedGithubConnectPath() !== null,
  });
}
