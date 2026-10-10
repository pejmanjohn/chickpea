import { DEFAULT_AGENT_AVATAR_FILES } from '../slack/agent-presence/default-avatar-pool.generated.ts';
import { FONT_ASSET_PATHS } from './fonts.ts';

export const ONBOARDING_ASSET_FILES = [
  'ready.webp', 'allow.webp', 'bot-token.webp', 'create-review.webp',
  'create-workspace.webp', 'events.webp', 'reinstall.webp',
  'signing-secret.webp', 'events-retry.webp',
  ...['hello', 'moving-in', 'setup', 'coding', 'coding-done', 'chat', 'celebrate'].map((pose) => `pose-${pose}.webp`),
  'team.webp',
] as const;

// The Admin application ships as static assets rather than inline markup so
// the Cloudflare Worker's compressed size budget holds server code only.
export const ADMIN_UI_SCRIPT_PATH = 'admin-ui/admin.js';
export const ADMIN_UI_STYLESHEET_PATH = 'admin-ui/admin.css';
export const ADMIN_UI_ASSET_PATHS = [ADMIN_UI_SCRIPT_PATH, ADMIN_UI_STYLESHEET_PATH] as const;

// Only these public files may be read through the Node HTTP adapter. Never
// turn a request pathname into an unrestricted filesystem path.
export const PUBLIC_ASSET_PATHS = [
  ...ADMIN_UI_ASSET_PATHS,
  'chickpea-chatgpt-connect.mjs',
  'chickpea-mark-128.png', 'chickpea-favicon-32.png', 'chickpea-wordmark-512.png',
  'bot-avatar.png',
  ...DEFAULT_AGENT_AVATAR_FILES.map((file) => `chickpea-avatars/agent-defaults/${file}`),
  ...ONBOARDING_ASSET_FILES.map((file) => `onboarding/${file}`),
  ...FONT_ASSET_PATHS,
  ...[
    'bugsnag', 'exa', 'fireflies', 'gamma', 'granola', 'incident-io', 'lunarcrush',
    'google-search-console', 'google-analytics', 'google-ads',
  ].map((name) => `connectors/${name}.png`),
];
const publicPaths = new Set(PUBLIC_ASSET_PATHS);

export function isPublicAssetPath(path: string): boolean {
  return publicPaths.has(path);
}
