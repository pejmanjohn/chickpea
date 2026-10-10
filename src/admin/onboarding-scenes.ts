import { escapeHtml } from '../security/html-escape.ts';

export type OnboardingSceneId =
  | 'sign-in'
  | 'add-to-slack'
  | 'setting-up'
  | 'own-model'
  | 'github'
  | 'github-connected'
  | 'try'
  | 'ready';

type OnboardingTone = 'gold' | 'apricot' | 'sage' | 'lilac' | 'coral';

export interface OnboardingScene {
  /** `assets/onboarding/pose-<pose>.webp` */
  pose: string;
  tone: OnboardingTone;
  caption: string;
}

export const ONBOARDING_SCENES: Readonly<Record<OnboardingSceneId, OnboardingScene>> = {
  'sign-in': { pose: 'hello', tone: 'gold', caption: 'Hi! I’m Chickpea.' },
  'add-to-slack': { pose: 'moving-in', tone: 'apricot', caption: 'Bags packed. Where to?' },
  'setting-up': { pose: 'setup', tone: 'apricot', caption: 'Moving in…' },
  'own-model': { pose: 'setup', tone: 'gold', caption: 'Power me up!' },
  github: { pose: 'coding', tone: 'sage', caption: 'Ready to read some code.' },
  'github-connected': { pose: 'coding-done', tone: 'sage', caption: 'Code connected!' },
  try: { pose: 'chat', tone: 'lilac', caption: 'Come say hi in Slack!' },
  ready: { pose: 'celebrate', tone: 'coral', caption: 'We did it!' },
};

const CONFETTI_PIECES = 18;

/**
 * The scene beside an onboarding stage. Admin's script keeps the same table
 * and paints the scene HTML the page config carries.
 */
export function onboardingSceneId(input: {
  stage: unknown;
  onChickpeaModels: boolean;
  githubConnected: boolean;
}): OnboardingSceneId {
  switch (input.stage) {
    case 'choose_provider':
    case 'choose_model':
      return input.onChickpeaModels ? 'setting-up' : 'own-model';
    case 'connect_github':
      return input.githubConnected ? 'github-connected' : 'github';
    case 'try':
      return 'try';
    case 'complete':
      return 'ready';
    default:
      return 'add-to-slack';
  }
}

export function onboardingSceneHtml(id: OnboardingSceneId): string {
  const scene = ONBOARDING_SCENES[id];
  const confetti = id === 'ready'
    ? `<div class="onboarding-confetti" aria-hidden="true">${'<i></i>'.repeat(CONFETTI_PIECES)}</div>`
    : '';
  return `<aside class="onboarding-scene onboarding-tone-${scene.tone}" data-scene="${id}">${confetti}` +
    `<div class="onboarding-arch"><img class="onboarding-pose" src="/onboarding/pose-${scene.pose}.webp" alt="" width="512" height="512" decoding="async" draggable="false"></div>` +
    `<p class="onboarding-caption">${escapeHtml(scene.caption)}</p></aside>`;
}

export function onboardingScenesHtml(): Record<OnboardingSceneId, string> {
  return Object.fromEntries(
    (Object.keys(ONBOARDING_SCENES) as OnboardingSceneId[]).map((id) => [id, onboardingSceneHtml(id)]),
  ) as Record<OnboardingSceneId, string>;
}
