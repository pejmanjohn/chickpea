import { PhotonImage, SamplingFilter, resize } from '@cf-wasm/photon';

import type { SettingsStore } from '../../config/settings-store.ts';
import type { ConfigStore } from '../../config/store.ts';
import type { CustomAgentConfig } from '../../config/types.ts';

export const MAX_AGENT_AVATAR_BYTES = 512 * 1_024;
export const MAX_AGENT_AVATAR_SOURCE_DIMENSION = 4_096;
export const MAX_AGENT_AVATAR_SOURCE_PIXELS = 16_777_216;
export const NORMALIZED_AGENT_AVATAR_DIMENSION = 512;
const MAX_NORMALIZED_AGENT_AVATAR_BYTES = 2 * 1_024 * 1_024;

interface StoredAvatarAsset {
  contentType: 'image/png';
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
  const normalized = normalizeRaster(input.bytes, input.contentType);
  const agent = await input.config.getAgent(input.agentId);
  const asset = JSON.stringify({
    contentType: normalized.contentType,
    base64: bytesToBase64(normalized.bytes),
  } satisfies StoredAvatarAsset);
  let revision = (agent.slackPresence?.avatar.revision ?? 0) + 1;
  // Reserve an immutable revision atomically. Concurrent editors may have read
  // the same Agent revision, but they must never overwrite bytes at the same
  // public URL even when one later loses the Agent CAS.
  while (!await input.settings.applySettingsPatch({
    expected: { key: avatarAssetKey(input.agentId, revision), value: null },
    set: [{ key: avatarAssetKey(input.agentId, revision), value: asset }],
  })) {
    revision += 1;
    if (!Number.isSafeInteger(revision)) throw new AgentAvatarError('too_large');
  }
  const url = input.publish
    ? await input.publish({
        agentId: input.agentId,
        revision,
        contentType: normalized.contentType,
        bytes: normalized.bytes,
      })
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
        parsed.contentType === 'image/png'
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

export function normalizeRaster(
  bytes: Uint8Array,
  declared: string,
): { contentType: StoredAvatarAsset['contentType']; bytes: Uint8Array } {
  if (bytes.byteLength === 0) throw new AgentAvatarError('invalid_image');
  if (bytes.byteLength > MAX_AGENT_AVATAR_BYTES) throw new AgentAvatarError('too_large');
  const normalized = declared.split(';', 1)[0]?.trim().toLowerCase();
  const detected = isPng(bytes) ? 'image/png'
    : isJpeg(bytes) ? 'image/jpeg'
    : isWebp(bytes) ? 'image/webp'
    : undefined;
  if (!detected) throw new AgentAvatarError('invalid_image');
  if (normalized && normalized !== detected) throw new AgentAvatarError('unsupported_type');
  const dimensions = rasterDimensions(bytes, detected);
  if (!dimensions) throw new AgentAvatarError('invalid_image');
  if (dimensions.width > MAX_AGENT_AVATAR_SOURCE_DIMENSION ||
      dimensions.height > MAX_AGENT_AVATAR_SOURCE_DIMENSION ||
      dimensions.width * dimensions.height > MAX_AGENT_AVATAR_SOURCE_PIXELS) {
    throw new AgentAvatarError('too_large');
  }

  let decoded: PhotonImage | undefined;
  let output: PhotonImage | undefined;
  try {
    decoded = PhotonImage.new_from_byteslice(bytes);
    const width = decoded.get_width();
    const height = decoded.get_height();
    if (width !== dimensions.width || height !== dimensions.height || width <= 0 || height <= 0) {
      throw new AgentAvatarError('invalid_image');
    }
    const scale = Math.min(1, NORMALIZED_AGENT_AVATAR_DIMENSION / Math.max(width, height));
    output = scale < 1
      ? resize(
          decoded,
          Math.max(1, Math.round(width * scale)),
          Math.max(1, Math.round(height * scale)),
          SamplingFilter.Lanczos3,
        )
      : decoded;
    const normalizedBytes = Uint8Array.from(output.get_bytes());
    if (normalizedBytes.byteLength === 0 ||
        normalizedBytes.byteLength > MAX_NORMALIZED_AGENT_AVATAR_BYTES) {
      throw new AgentAvatarError('too_large');
    }
    return { contentType: 'image/png', bytes: normalizedBytes };
  } catch (error) {
    if (error instanceof AgentAvatarError) throw error;
    throw new AgentAvatarError('invalid_image');
  } finally {
    if (output && output !== decoded) output.free();
    decoded?.free();
  }
}

function rasterDimensions(
  bytes: Uint8Array,
  contentType: 'image/png' | 'image/jpeg' | 'image/webp',
): { width: number; height: number } | undefined {
  if (contentType === 'image/png') {
    if (bytes.length < 24 || text(bytes, 12, 16) !== 'IHDR') return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return boundedDimensions(view.getUint32(16), view.getUint32(20));
  }
  if (contentType === 'image/jpeg') return jpegDimensions(bytes);
  return webpDimensions(bytes);
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return undefined;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length) return undefined;
    if (isJpegStartOfFrame(marker)) {
      if (length < 7) return undefined;
      return boundedDimensions(
        (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        (bytes[offset + 3]! << 8) | bytes[offset + 4]!,
      );
    }
    offset += length;
  }
  return undefined;
}

function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf &&
    ![0xc4, 0xc8, 0xcc].includes(marker);
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 30) return undefined;
  const chunk = text(bytes, 12, 16);
  if (chunk === 'VP8X') {
    return boundedDimensions(readUint24(bytes, 24) + 1, readUint24(bytes, 27) + 1);
  }
  if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return boundedDimensions(
      ((bytes[27]! << 8) | bytes[26]!) & 0x3fff,
      ((bytes[29]! << 8) | bytes[28]!) & 0x3fff,
    );
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return boundedDimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  return undefined;
}

function readUint24(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function boundedDimensions(width: number, height: number) {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    ? { width, height }
    : undefined;
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
