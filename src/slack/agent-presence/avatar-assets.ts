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
  // Generated revisions are public, immutable PNGs so Slack can fetch them
  // through the same raster persona path as uploaded avatars. The product
  // uses a sprout family distinct from Atlas and varies the palette per Agent.
  return {
    contentType: 'image/png',
    bytes: await generatedAgentAvatarPng(`${input.agentId}:${input.revision}`),
  };
}

export async function generatedAgentAvatarPng(seed: string): Promise<Uint8Array> {
  const width = 128;
  const height = 128;
  const scanlines = new Uint8Array(height * (1 + width * 4));
  const hue = stableHue(seed);
  const start = hslToRgb(hue, 0.72, 0.48);
  const end = hslToRgb((hue + 42) % 360, 0.78, 0.38);
  const cream = [255, 253, 246] as const;
  const ink = [23, 51, 31] as const;

  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    scanlines[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      if (!insideRoundedSquare(x, y, width, height, 30)) continue;
      const blend = (x + y) / (width + height - 2);
      scanlines[offset] = mix(start[0], end[0], blend);
      scanlines[offset + 1] = mix(start[1], end[1], blend);
      scanlines[offset + 2] = mix(start[2], end[2], blend);
      scanlines[offset + 3] = 255;

      if (
        ellipse(x, y, 64, 66, 37, 35) ||
        rotatedEllipse(x, y, 68, 23, 9, 19, -0.28)
      ) setPixel(scanlines, offset, cream);
      if (circle(x, y, 51, 63, 5) || circle(x, y, 77, 63, 5)) {
        setPixel(scanlines, offset, ink);
      }
      if (x >= 48 && x <= 80) {
        const normalized = (x - 64) / 14;
        const smileY = 78 + 5 * Math.max(0, 1 - normalized * normalized);
        if (Math.abs(y - smileY) <= 2.5) setPixel(scanlines, offset, ink);
      }
    }
  }

  const compressed = new Uint8Array(await new Response(
    new Blob([scanlines]).stream().pipeThrough(new CompressionStream('deflate')),
  ).arrayBuffer());
  return concatenateBytes(
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', pngHeader(width, height)),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', new Uint8Array()),
  );
}

function insideRoundedSquare(
  x: number, y: number, width: number, height: number, radius: number,
): boolean {
  const nearestX = Math.max(radius, Math.min(x, width - radius - 1));
  const nearestY = Math.max(radius, Math.min(y, height - radius - 1));
  const dx = x - nearestX;
  const dy = y - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}

function ellipse(
  x: number, y: number, centerX: number, centerY: number, radiusX: number, radiusY: number,
): boolean {
  const dx = (x - centerX) / radiusX;
  const dy = (y - centerY) / radiusY;
  return dx * dx + dy * dy <= 1;
}

function rotatedEllipse(
  x: number, y: number, centerX: number, centerY: number,
  radiusX: number, radiusY: number, angle: number,
): boolean {
  const dx = x - centerX;
  const dy = y - centerY;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return ellipse(
    dx * cosine - dy * sine,
    dx * sine + dy * cosine,
    0, 0, radiusX, radiusY,
  );
}

function circle(
  x: number, y: number, centerX: number, centerY: number, radius: number,
): boolean {
  const dx = x - centerX;
  const dy = y - centerY;
  return dx * dx + dy * dy <= radius * radius;
}

function setPixel(
  pixels: Uint8Array,
  offset: number,
  color: readonly [number, number, number],
): void {
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
  pixels[offset + 3] = 255;
}

function mix(start: number, end: number, amount: number): number {
  return Math.round(start + (end - start) * amount);
}

function hslToRgb(
  hue: number, saturation: number, lightness: number,
): readonly [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = hue / 60;
  const secondary = chroma * (1 - Math.abs((sector % 2) - 1));
  const [red, green, blue] = sector < 1 ? [chroma, secondary, 0]
    : sector < 2 ? [secondary, chroma, 0]
    : sector < 3 ? [0, chroma, secondary]
    : sector < 4 ? [0, secondary, chroma]
    : sector < 5 ? [secondary, 0, chroma]
    : [chroma, 0, secondary];
  const match = lightness - chroma / 2;
  return [
    Math.round((red + match) * 255),
    Math.round((green + match) * 255),
    Math.round((blue + match) * 255),
  ];
}

function pngHeader(width: number, height: number): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  return header;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(concatenateBytes(typeBytes, data)));
  return chunk;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatenateBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
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
