import type { SettingsStore } from '../../config/settings-store.ts';
import type { ConfigStore } from '../../config/store.ts';
import type { AgentAvatarRevision, CustomAgentConfig } from '../../config/types.ts';
import {
  defaultAgentAvatarPng,
  isDefaultAgentAvatarSeed,
} from './default-avatar-pool.ts';
import { base64ToBytes, fnv1aHash } from './hash.ts';

// Uploads are stored as sent, minus embedded metadata. The Worker no longer
// decodes or resizes images: the wasm codec that did so cost 600 KiB of the
// compressed Worker size budget for a cosmetic step. The Admin UI downscales
// oversized photos in the browser before upload, and these caps bound what a
// direct API client can store per revision.
const MAX_AGENT_AVATAR_BYTES = 512 * 1_024;
const MAX_AGENT_AVATAR_SOURCE_DIMENSION = 2_048;
const MAX_AGENT_AVATAR_SOURCE_PIXELS = 4_194_304;

type AvatarContentType = 'image/png' | 'image/jpeg' | 'image/webp';
const AVATAR_CONTENT_TYPES: ReadonlySet<string> = new Set<AvatarContentType>([
  'image/png', 'image/jpeg', 'image/webp',
]);

interface StoredAvatarAsset {
  contentType: AvatarContentType;
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
  seed?: string;
  avatar?: AgentAvatarRevision;
}): Promise<{ contentType: string; bytes: Uint8Array } | undefined> {
  if (input.avatar && input.revision > input.avatar.revision) return undefined;
  const stored = await input.settings.getSetting(avatarAssetKey(input.agentId, input.revision));
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Partial<StoredAvatarAsset>;
      if (
        typeof parsed.base64 === 'string' &&
        typeof parsed.contentType === 'string' &&
        AVATAR_CONTENT_TYPES.has(parsed.contentType)
      ) {
        return { contentType: parsed.contentType, bytes: base64ToBytes(parsed.base64) };
      }
    } catch {
      return undefined;
    }
  }
  // Generated revisions are public, immutable PNGs so Slack can fetch the
  // selected default through the same path as an uploaded replacement.
  const historical = input.avatar?.generatedSeedHistory?.find(
    ({ throughRevision }) => input.revision <= throughRevision,
  );
  const seed = historical?.seed ?? input.avatar?.seed ?? input.seed ?? input.agentId;
  if (input.avatar?.kind === 'uploaded' && !historical) return undefined;
  return {
    contentType: 'image/png',
    bytes: historical && !isDefaultAgentAvatarSeed(seed)
      ? await legacyGeneratedAgentAvatarPng(`${input.agentId}:${input.revision}`)
      : await generatedAgentAvatarPng(seed),
  };
}

export async function generatedAgentAvatarPng(seed: string): Promise<Uint8Array> {
  return defaultAgentAvatarPng(seed);
}

/** Preserve bytes already published at immutable legacy revision URLs. */
async function legacyGeneratedAgentAvatarPng(seed: string): Promise<Uint8Array> {
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

function normalizeRaster(
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
  // Uploaded photos routinely carry location and device metadata. Chickpea
  // serves these bytes publicly for Slack, so strip every metadata container
  // the three formats define while leaving the encoded pixels untouched.
  const stripped = detected === 'image/png' ? stripPngMetadata(bytes)
    : detected === 'image/jpeg' ? stripJpegMetadata(bytes)
    : stripWebpMetadata(bytes);
  if (!stripped || stripped.byteLength === 0) throw new AgentAvatarError('invalid_image');
  return { contentType: detected, bytes: stripped };
}

// Critical chunks plus the ancillary chunks that affect rendering. Text,
// timestamp, EXIF, ICC profile and animation chunks are dropped.
const PNG_KEPT_CHUNKS = new Set([
  'IHDR', 'PLTE', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'bKGD', 'pHYs', 'IDAT', 'IEND',
]);

function stripPngMetadata(bytes: Uint8Array): Uint8Array | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [bytes.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const type = asciiAt(bytes, offset + 4, 4);
    const end = offset + 12 + length;
    if (end > bytes.byteLength) return undefined;
    if (PNG_KEPT_CHUNKS.has(type)) parts.push(bytes.subarray(offset, end));
    offset = end;
    if (type === 'IEND') return concatenateBytes(...parts);
  }
  return undefined;
}

function stripJpegMetadata(bytes: Uint8Array): Uint8Array | undefined {
  const parts = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset + 2 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd9) {
      parts.push(bytes.subarray(offset, offset + 2));
      return concatenateBytes(...parts);
    }
    // Standalone markers carry no length: restart markers and TEM.
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(bytes.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (offset + 4 > bytes.byteLength) return undefined;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    const segmentEnd = offset + 2 + length;
    if (length < 2 || segmentEnd > bytes.byteLength) return undefined;
    // Keep JFIF (APP0) and Adobe (APP14, colour transform) application
    // segments; drop EXIF, XMP, ICC, IPTC and every other APPn plus comments.
    const application = marker >= 0xe0 && marker <= 0xef;
    const keep = marker !== 0xfe && (!application || marker === 0xe0 || marker === 0xee);
    if (keep) parts.push(bytes.subarray(offset, segmentEnd));
    offset = segmentEnd;
    if (marker === 0xda) {
      // Entropy-coded scan data follows until the next real marker.
      let scanEnd = offset;
      while (scanEnd + 1 < bytes.byteLength) {
        const next = bytes[scanEnd + 1]!;
        if (bytes[scanEnd] === 0xff && next !== 0x00 && next !== 0xff &&
            !(next >= 0xd0 && next <= 0xd7)) break;
        scanEnd += 1;
      }
      parts.push(bytes.subarray(offset, scanEnd));
      offset = scanEnd;
    }
  }
  return undefined;
}

function stripWebpMetadata(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes.byteLength < 12 || asciiAt(bytes, 0, 4) !== 'RIFF' || asciiAt(bytes, 8, 4) !== 'WEBP') {
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const type = asciiAt(bytes, offset, 4);
    const size = readUint32LE(bytes, offset + 4);
    const dataEnd = offset + 8 + size;
    if (dataEnd > bytes.byteLength) return undefined;
    if (type === 'VP8X') {
      const copy = Uint8Array.from(bytes.subarray(offset, dataEnd));
      // Clear the ICC, EXIF and XMP flags alongside the chunks they announce.
      copy[8] = copy[8]! & ~(0x20 | 0x08 | 0x04);
      chunks.push(copy);
    } else if (type !== 'EXIF' && type !== 'XMP ' && type !== 'ICCP') {
      chunks.push(bytes.subarray(offset, dataEnd));
    }
    if (size & 1) chunks.push(new Uint8Array(1));
    offset = dataEnd + (size & 1);
  }
  const body = concatenateBytes(...chunks);
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode('RIFF'), 0);
  new DataView(header.buffer).setUint32(4, 4 + body.byteLength, true);
  header.set(new TextEncoder().encode('WEBP'), 8);
  return concatenateBytes(header, body);
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
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
  return Math.abs(fnv1aHash(seed)) % 360;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
