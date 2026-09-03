import { DEFAULT_AGENT_AVATAR_FILES } from '../slack/agent-presence/default-avatar-pool.generated.ts';

export const ONBOARDING_ASSET_FILES = [
  'ready.webp', 'allow.webp', 'bot-token.webp', 'create-review.webp',
  'create-workspace.webp', 'events.webp', 'reinstall.webp',
  'signing-secret.webp', 'events-retry.webp',
] as const;

// Only these public files may be read through the Node HTTP adapter. Never
// turn a request pathname into an unrestricted filesystem path.
export const PUBLIC_ASSET_PATHS = [
  'chickpea-mark-128.png', 'chickpea-favicon-32.png', 'chickpea-wordmark-512.png',
  ...DEFAULT_AGENT_AVATAR_FILES.map((file) => `chickpea-avatars/agent-defaults/${file}`),
  ...ONBOARDING_ASSET_FILES.map((file) => `onboarding/${file}`),
  ...[
    'exa', 'fireflies', 'gamma', 'granola', 'incident-io', 'lunarcrush',
    'google-search-console', 'google-analytics', 'google-ads',
  ].map((name) => `connectors/${name}.png`),
];
const publicPaths = new Set(PUBLIC_ASSET_PATHS);

export function isPublicAssetPath(path: string): boolean {
  return publicPaths.has(path);
}
