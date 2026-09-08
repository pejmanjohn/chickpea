import { readPublicAsset } from '#chickpea-assets';
import { DEFAULT_AGENT_AVATAR_FILES } from './default-avatar-pool.generated.ts';
import { fnv1aHash } from './hash.ts';

export { DEFAULT_AGENT_AVATAR_FILES };

const SEED_PREFIX = 'chickpea-avatar-v1';

export function defaultAgentAvatarIndex(seed: string): number {
  const selected = encodedAvatarIndex(seed);
  if (selected !== undefined) return selected;
  return stableHash(seed) % DEFAULT_AGENT_AVATAR_FILES.length;
}

export function isDefaultAgentAvatarSeed(seed: string): boolean {
  return encodedAvatarIndex(seed) !== undefined;
}

/**
 * Pick randomly among the least-used defaults. A workspace sees all twelve
 * before any one image appears a second time, while concurrent creates remain
 * safe because the durable seed fully records the selected image.
 */
export function nextDefaultAgentAvatarSeed(
  existingSeeds: readonly string[],
  nonce: string,
): string {
  const useCounts = Array.from({ length: DEFAULT_AGENT_AVATAR_FILES.length }, () => 0);
  for (const seed of existingSeeds) {
    if (seed) useCounts[defaultAgentAvatarIndex(seed)]! += 1;
  }
  const leastUsed = Math.min(...useCounts);
  const candidates = useCounts.flatMap((count, index) => count === leastUsed ? [index] : []);
  const selected = candidates[stableHash(nonce) % candidates.length]!;
  return `${SEED_PREFIX}:${String(selected + 1).padStart(2, '0')}:${nonce}`;
}

export function defaultAgentAvatarPng(seed: string): Promise<Uint8Array<ArrayBuffer>> {
  const file = DEFAULT_AGENT_AVATAR_FILES[defaultAgentAvatarIndex(seed)]!;
  return readPublicAsset(`chickpea-avatars/agent-defaults/${file}`);
}

function stableHash(seed: string): number {
  return fnv1aHash(seed) >>> 0;
}

function encodedAvatarIndex(seed: string): number | undefined {
  const selected = /^chickpea-avatar-v1:(\d{2}):/.exec(seed)?.[1];
  if (!selected) return undefined;
  const index = Number(selected) - 1;
  return index >= 0 && index < DEFAULT_AGENT_AVATAR_FILES.length ? index : undefined;
}
