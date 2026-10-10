import { hostedGithubConnectPath } from '../config/hosted-github.ts';
import { platformBilling } from '../config/platform-billing.ts';

export type OnboardingStepId = 'slack' | 'provider' | 'model' | 'github' | 'try';

export interface OnboardingStep {
  id: OnboardingStepId;
  label: string;
  /** Under the label until the step is done. */
  note?: string;
}

export function onboardingSteps(input: {
  selfHosted: boolean;
  onChickpeaModels: boolean;
  githubOffered: boolean;
}): OnboardingStep[] {
  return [
    { id: 'slack', label: input.selfHosted ? 'Connect Slack' : 'Add to Slack', note: 'Your workspace' },
    ...(input.onChickpeaModels ? [] : [
      { id: 'provider', label: 'Choose provider' },
      { id: 'model', label: 'Choose model' },
    ] as const),
    ...(input.githubOffered && !input.selfHosted ? [{ id: 'github', label: 'Connect GitHub', note: 'Optional' }] as const : []),
    { id: 'try', label: 'Try Chickpea', note: 'Say hi' },
  ];
}

const STAGE_STEPS: Readonly<Record<string, OnboardingStepId>> = {
  connect_slack: 'slack', choose_provider: 'provider', choose_model: 'model', connect_github: 'github', try: 'try',
};
const CHICKPEA_MODELS_STAGE_STEPS: Readonly<Record<string, OnboardingStepId>> = {
  ...STAGE_STEPS, choose_provider: 'slack', choose_model: 'slack',
};

/** The current step's index; `steps.length` once the journey is complete. Admin's script keeps the same table. */
export function onboardingStepIndex(steps: readonly OnboardingStep[], stage: unknown, onChickpeaModels: boolean): number {
  if (stage === 'complete') return steps.length;
  const table = onChickpeaModels ? CHICKPEA_MODELS_STAGE_STEPS : STAGE_STEPS;
  const id = (typeof stage === 'string' ? table[stage] : undefined) ?? 'slack';
  const index = steps.findIndex((step) => step.id === id);
  return index >= 0 ? index : steps.length - 1;
}

export async function hostedSignUpOnboardingSteps(): Promise<OnboardingStep[]> {
  return onboardingSteps({
    selfHosted: false,
    onChickpeaModels: platformBilling() !== undefined,
    githubOffered: await hostedGithubConnectPath() !== null,
  });
}
