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

/**
 * The scene and the step bar, as Admin's onboarding, the Slack journey pages
 * and the Slack app guide all draw them. Colors are literal because each page
 * names its palette differently. Admin's stylesheet carries this text verbatim
 * (a test checks); each page adds only its own layout: grid placement, margins.
 */
export const ONBOARDING_SCENE_CSS = `.onboarding-tone-gold { --tone: #f7e2ad; --tone-deep: #e6b445; --tone-ink: #7a5410; }
.onboarding-tone-apricot { --tone: #f9d7b8; --tone-deep: #e58d4e; --tone-ink: #8a4a18; }
.onboarding-tone-sage { --tone: #dce8d0; --tone-deep: #86a86f; --tone-ink: #3f6330; }
.onboarding-tone-lilac { --tone: #e7ddf1; --tone-deep: #a189c2; --tone-ink: #5b4580; }
.onboarding-tone-coral { --tone: #f8d6cc; --tone-deep: #d9705a; --tone-ink: #8c3a28; }
.onboarding-scene { --arch: clamp(240px, 26vw, 380px); align-items: center; align-self: start; background: var(--tone); display: flex; flex-direction: column; height: 100dvh; isolation: isolate; justify-content: center; min-height: 560px; overflow: hidden; padding: 40px; position: sticky; top: 0; }
.onboarding-scene::before { background: radial-gradient(60% 50% at 30% 20%, rgba(255, 255, 255, .45), transparent 70%), radial-gradient(50% 40% at 80% 90%, rgba(0, 0, 0, .05), transparent 70%); content: ""; inset: 0; position: absolute; z-index: -2; }
.onboarding-arch { background: var(--tone-deep); border-radius: calc(var(--arch) / 2) calc(var(--arch) / 2) 26px 26px; box-shadow: inset 0 0 0 calc(var(--arch) * .058) color-mix(in srgb, var(--tone-deep) 70%, #000 12%); flex: none; height: calc(var(--arch) * 1.158); position: relative; width: var(--arch); }
.onboarding-arch::before { background: color-mix(in srgb, var(--tone-deep) 55%, #2a1d10 45%); border-radius: calc(var(--arch) * .442) calc(var(--arch) * .442) 10px 10px; content: ""; inset: calc(var(--arch) * .058); position: absolute; }
.onboarding-arch::after { background: color-mix(in srgb, var(--tone-deep) 70%, #000 10%); border-radius: 12px; bottom: calc(var(--arch) * -.058); content: ""; height: calc(var(--arch) * .068); left: -18%; opacity: .55; position: absolute; right: -18%; z-index: -1; }
.onboarding-pose { bottom: -1.5%; height: auto; left: 50%; max-width: none; position: absolute; transform: translateX(-50%); width: 105%; }
.onboarding-caption { color: var(--tone-ink); font-family: var(--display, "Baloo 2", Quicksand, system-ui, sans-serif); font-size: clamp(1.5rem, 2.2vw, 2rem); font-weight: 800; line-height: 1.1; margin: calc(var(--arch) * .1 + 18px) 0 0; position: relative; text-align: center; text-wrap: balance; }
.onboarding-orientation { display: grid; gap: 10px; grid-auto-columns: minmax(0, 1fr); grid-auto-flow: column; list-style: none; max-width: 680px; padding: 0; }
.onboarding-orientation:has(> li:nth-child(5)) li { font-size: .875rem; }
.onboarding-orientation li { color: #6b5c42; display: flex; flex-direction: column; font-size: .9375rem; font-weight: 700; gap: 4px; min-width: 0; }
.onboarding-orientation li::before { background: rgba(59, 50, 32, .1); border-radius: 99px; content: ""; height: 6px; margin-bottom: 6px; }
.onboarding-orientation li.complete::before { background: #6fa25b; }
.onboarding-orientation li.active::before { background: #dda033; }
.onboarding-orientation li.active, .onboarding-orientation li.complete { color: #3b3220; }
.onboarding-step-label, .onboarding-step-note { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.onboarding-step-note { color: #6b5c42; font-size: .8125rem; font-weight: 600; }
@media (max-width: 720px) {
  .onboarding-scene { --arch: 84px; align-self: stretch; flex-direction: row; gap: 18px; height: auto; justify-content: flex-start; min-height: 0; padding: 70px 24px 24px; position: relative; }
  .onboarding-arch { border-radius: 42px 42px 10px 10px; }
  .onboarding-arch::before { border-radius: 37px 37px 5px 5px; }
  .onboarding-arch::after { border-radius: 6px; }
  .onboarding-caption { font-size: 1.375rem; margin: 0; text-align: left; }
  .onboarding-orientation { gap: 6px; }
  .onboarding-orientation li { font-size: .8125rem; }
  .onboarding-step-note { display: none; }
  .onboarding-orientation:has(> li:nth-child(4)) .onboarding-step-label { clip: rect(0 0 0 0); height: 1px; overflow: hidden; position: absolute; width: 1px; }
}`;

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
