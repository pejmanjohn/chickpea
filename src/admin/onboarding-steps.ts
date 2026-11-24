import { hostedGithubConnectPath } from '../config/hosted-github.ts';
import { platformBilling } from '../config/platform-billing.ts';
import { agentSlackAppsHost, agentSlackAppsMayCreate } from '../slack/agent-apps/host.ts';

export type OnboardingStepId = 'slack' | 'provider' | 'model' | 'slack_apps' | 'github' | 'try';

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
  /** The host offers each Agent its own Slack app, and the person is the Owner. */
  slackAppsOffered?: boolean;
}): OnboardingStep[] {
  return [
    { id: 'slack', label: input.selfHosted ? 'Connect Slack' : 'Add to Slack', note: 'Your workspace' },
    ...(input.onChickpeaModels ? [] : [
      { id: 'provider', label: 'Choose provider' },
      { id: 'model', label: 'Choose model' },
    ] as const),
    ...(input.slackAppsOffered && !input.selfHosted ? [{ id: 'slack_apps', label: 'Slack apps', note: 'Optional' }] as const : []),
    ...(input.githubOffered && !input.selfHosted ? [{ id: 'github', label: 'Connect GitHub', note: 'Optional' }] as const : []),
    { id: 'try', label: 'Try Chickpea', note: 'Say hi' },
  ];
}

const STAGE_STEPS: Readonly<Record<string, OnboardingStepId>> = {
  connect_slack: 'slack', choose_provider: 'provider', choose_model: 'model', slack_apps: 'slack_apps', connect_github: 'github', try: 'try',
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
    // The person signing up becomes the Owner.
    slackAppsOffered: slackAppsCreatable(),
  });
}

/** The host offers each Agent its own Slack app and lets Chickpea create them now. */
function slackAppsCreatable(): boolean {
  const host = agentSlackAppsHost();
  return host !== undefined && agentSlackAppsMayCreate(host);
}
