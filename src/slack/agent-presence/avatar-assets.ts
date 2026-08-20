import type { SettingsStore } from '../../config/settings-store.ts';
import type { ConfigStore } from '../../config/store.ts';
import type { CustomAgentConfig } from '../../config/types.ts';

export const MAX_AGENT_AVATAR_BYTES = 512 * 1_024;

interface StoredAvatarAsset {
  contentType: 'image/png' | 'image/jpeg' | 'image/webp';
  base64: string;
}

export class AgentAvatarError extends Error {
  constructor(readonly code: 'unsupported_type' | 'invalid_image' | 'too_large') {
    super(code);
    this.name = 'AgentAvatarError';
  }
}

export function agentAvatarUrl(
  origin: string,
  agentId: string,
  revision: number,
): string {
  return `${new URL(origin).origin}/assets/agents/${encodeURIComponent(agentId)}/avatar/${revision}`;
}

export function agentAvatarUrlForPresentation(
  agent: CustomAgentConfig,
  publicOrigin: string | undefined,
): string | undefined {
  if (agent.slackPresence?.avatar.url) return agent.slackPresence.avatar.url;
  if (!publicOrigin || !agent.slackPresence) return undefined;
  return agentAvatarUrl(publicOrigin, agent.id, agent.slackPresence.avatar.revision);
}

export async function uploadAgentAvatar(input: {
  config: ConfigStore;
  settings: SettingsStore;
  agentId: string;
  bytes: Uint8Array;
  contentType: string;
  publicOrigin: string;
  publish?: (input: {
    agentId: string;
    revision: number;
    contentType: StoredAvatarAsset['contentType'];
    bytes: Uint8Array;
  }) => Promise<string>;
}): Promise<CustomAgentConfig> {
  const contentType = validateRaster(input.bytes, input.contentType);
  const agent = await input.config.getAgent(input.agentId);
  const revision = (agent.slackPresence?.avatar.revision ?? 0) + 1;
  await input.settings.setSetting(
    avatarAssetKey(input.agentId, revision),
    JSON.stringify({ contentType, base64: bytesToBase64(input.bytes) } satisfies StoredAvatarAsset),
  );
  const url = input.publish
    ? await input.publish({ agentId: input.agentId, revision, contentType, bytes: input.bytes })
    : agentAvatarUrl(input.publicOrigin, input.agentId, revision);
  return input.config.updateAgent(
    input.agentId,
    {
      slackPresence: {
        ...requiredPresence(agent),
        avatar: { kind: 'uploaded', revision, url },
      },
    },
    agent.revision,
  );
}

export async function readAgentAvatarAsset(input: {
  settings: SettingsStore;
  agentId: string;
  revision: number;
}): Promise<{ contentType: string; bytes: Uint8Array } | undefined> {
  const stored = await input.settings.getSetting(avatarAssetKey(input.agentId, input.revision));
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Partial<StoredAvatarAsset>;
      if (
        typeof parsed.base64 === 'string' &&
        ['image/png', 'image/jpeg', 'image/webp'].includes(parsed.contentType ?? '')
      ) {
        return { contentType: parsed.contentType!, bytes: base64ToBytes(parsed.base64) };
      }
    } catch {
      return undefined;
    }
  }
  // Generated revisions are public, immutable SVGs. The product uses a sprout
  // family distinct from Atlas and varies the palette per Agent/revision.
  const svg = generatedAgentAvatarSvg(`${input.agentId}:${input.revision}`);
  return { contentType: 'image/svg+xml', bytes: new TextEncoder().encode(svg) };
}

export function generatedAgentAvatarSvg(seed: string): string {
  const hue = stableHue(seed);
  const accent = (hue + 42) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Chickpea Agent"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(${hue} 72% 48%)"/><stop offset="1" stop-color="hsl(${accent} 78% 38%)"/></linearGradient></defs><rect width="128" height="128" rx="30" fill="url(#g)"/><path d="M64 101c-21 0-37-15-37-35 0-19 14-34 33-35-2-10 2-18 11-23 4 10 3 18-1 24 18 3 31 17 31 34 0 20-16 35-37 35Z" fill="#fffdf6"/><circle cx="51" cy="63" r="5" fill="#17331f"/><circle cx="77" cy="63" r="5" fill="#17331f"/><path d="M50 78c8 7 20 7 28 0" fill="none" stroke="#17331f" stroke-width="5" stroke-linecap="round"/></svg>`;
}

function requiredPresence(agent: CustomAgentConfig) {
  if (!agent.slackPresence) throw new Error(`Agent ${agent.id} has no Slack presence`);
  return agent.slackPresence;
}

function validateRaster(bytes: Uint8Array, declared: string): StoredAvatarAsset['contentType'] {
  if (bytes.byteLength === 0) throw new AgentAvatarError('invalid_image');
  if (bytes.byteLength > MAX_AGENT_AVATAR_BYTES) throw new AgentAvatarError('too_large');
  const normalized = declared.split(';', 1)[0]?.trim().toLowerCase();
  const detected = isPng(bytes) ? 'image/png'
    : isJpeg(bytes) ? 'image/jpeg'
    : isWebp(bytes) ? 'image/webp'
    : undefined;
  if (!detected) throw new AgentAvatarError('invalid_image');
  if (normalized && normalized !== detected) throw new AgentAvatarError('unsupported_type');
  return detected;
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    .every((value, index) => bytes[index] === value);
}
function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}
function isWebp(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && text(bytes, 0, 4) === 'RIFF' && text(bytes, 8, 12) === 'WEBP';
}
function text(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function avatarAssetKey(agentId: string, revision: number): string {
  return `agent.avatar.${agentId}.${revision}`;
}

function stableHue(seed: string): number {
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 360;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
