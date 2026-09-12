import { createHash, randomUUID } from 'node:crypto';
import type { SettingsStore } from '../config/settings-store.ts';

export const IMAGE_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_RETAINED_IMAGE_BYTES = 8 * 1024 * 1024;
const TOTAL_BYTES = 64 * 1024 * 1024;
const CHUNK_CHARS = 256 * 1024;
const INDEX = 'generated_images:v1:index';
const PREFIX = 'generated_images:v1:';
export const SAVED_IMAGE_ID = /^saved:[a-f0-9-]{36}$/;

interface Entry { id: string; scope: string; digest?: string; expiresAt: number; bytes: number; chunks: number }
export interface SavedImage {
  bytes: Uint8Array;
  metadata: Record<string, unknown>;
  expiresAt: number;
}
export interface ImageOutputStore {
  save(bytes: Uint8Array, metadata: Record<string, unknown>): Promise<{ id: string; expiresAt: number }>;
  read(id: string): Promise<SavedImage | undefined>;
  remove(id: string): Promise<void>;
}

/** Exact workspace/Agent/destination binding; no global image lookup is exposed to a tool. */
export function createImageOutputStore(settings: SettingsStore, destination: object, now = Date.now): ImageOutputStore {
  const scope = createHash('sha256').update(JSON.stringify(destination)).digest('hex');
  return {
    async save(bytes, metadata) {
      if (!bytes.length || bytes.length > MAX_RETAINED_IMAGE_BYTES) throw new Error('image_retention_size_limit');
      // Content-addressed within this destination: metadata refreshes and
      // replay never duplicate unchanged bytes or extend their original TTL.
      const hash = createHash('sha256').update(scope).update(JSON.stringify({
        model: metadata.model, size: metadata.size, background: metadata.background,
      })).update(bytes).digest('hex');
      const id = `saved:${randomUUID()}`;
      const entry: Entry = { id, scope, digest: hash, expiresAt: now() + IMAGE_RETENTION_MS, bytes: bytes.length,
        chunks: Math.ceil(Math.ceil(bytes.length / 3) * 4 / CHUNK_CHARS) };
      let set: { key: string; value: string }[] | undefined;
      for (let attempt = 0; attempt < 8; attempt++) {
        const raw = await settings.getSetting(INDEX);
        const entries = indexEntries(raw) ?? [];
        const existing = entries.find((item) => item.scope === scope && item.digest === hash && item.expiresAt > now());
        if (existing) {
          if (await settings.applySettingsPatch({ expected: { key: INDEX, value: raw ?? null },
            set: [{ key: `${PREFIX}${existing.id}:meta`, value: JSON.stringify(metadata) }] })) {
            return { id: existing.id, expiresAt: existing.expiresAt };
          }
          continue;
        }
        if (!set) {
          const encoded = Buffer.from(bytes).toString('base64');
          set = [{ key: `${PREFIX}${id}:meta`, value: JSON.stringify(metadata) }];
          for (let i = 0; i < entry.chunks; i++) {
            set.push({ key: `${PREFIX}${id}:${i}`, value: encoded.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) });
          }
        }
        const retained = entries.filter((item) => item.expiresAt > now());
        let total = retained.reduce((sum, item) => sum + item.bytes, bytes.length);
        while (retained.length && (total > TOTAL_BYTES || retained.length >= 128)) total -= retained.shift()!.bytes;
        const keep = new Set(retained.map((item) => item.id));
        const removed = entries.filter((item) => !keep.has(item.id));
        if (await settings.applySettingsPatch({
          expected: { key: INDEX, value: raw ?? null },
          set: [...set, { key: INDEX, value: JSON.stringify([...retained, entry]) }],
          delete: removed.flatMap(entryKeys),
        })) return { id, expiresAt: entry.expiresAt };
      }
      throw new Error('image_retention_busy');
    },
    async read(id) {
      if (!SAVED_IMAGE_ID.test(id)) return undefined;
      await purgeExpiredImageOutputs(settings, now());
      const entry = (indexEntries(await settings.getSetting(INDEX)) ?? [])
        .find((item) => item.id === id && item.scope === scope && item.expiresAt > now());
      if (!entry) return undefined;
      const values = await settings.getSettings(entryKeys(entry));
      if (values.some((value) => value === undefined)) return undefined;
      const bytes = new Uint8Array(Buffer.from(values.slice(1).join(''), 'base64'));
      if (bytes.length !== entry.bytes) return undefined;
      try {
        const metadata: unknown = JSON.parse(values[0]!);
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
        return { bytes, metadata: metadata as Record<string, unknown>, expiresAt: entry.expiresAt };
      } catch { return undefined; }
    },
    async remove(id) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const raw = await settings.getSetting(INDEX);
        const entries = indexEntries(raw) ?? [];
        const entry = entries.find((item) => item.id === id && item.scope === scope);
        if (!entry) return;
        if (await settings.applySettingsPatch({ expected: { key: INDEX, value: raw ?? null },
          set: [{ key: INDEX, value: JSON.stringify(entries.filter((item) => item.id !== id)) }], delete: entryKeys(entry) })) return;
      }
    },
  };
}

/** Also called by periodic maintenance; TTL removes bytes, not just the lookup. */
export async function purgeExpiredImageOutputs(settings: Pick<SettingsStore, 'getSetting' | 'applySettingsPatch'>, at = Date.now()): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const raw = await settings.getSetting(INDEX);
    const parsed = indexEntries(raw);
    // A corrupt index cannot safely name deletions. Reset its lookup to recover
    // service; any unaddressable chunk rows need an operator storage repair.
    const entries = parsed ?? [];
    const expired = entries.filter((item) => item.expiresAt <= at);
    if (parsed && !expired.length) return;
    if (await settings.applySettingsPatch({
      expected: { key: INDEX, value: raw ?? null },
      set: [{ key: INDEX, value: JSON.stringify(entries.filter((item) => item.expiresAt > at)) }],
      delete: expired.flatMap(entryKeys),
    })) return;
  }
}

function entryKeys(entry: Entry): string[] {
  return [`${PREFIX}${entry.id}:meta`, ...Array.from({ length: entry.chunks }, (_, i) => `${PREFIX}${entry.id}:${i}`)];
}
function indexEntries(raw: string | undefined): Entry[] | undefined {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!Array.isArray(parsed) || parsed.length > 128 || parsed.some((entry) =>
    !entry || !SAVED_IMAGE_ID.test(entry.id) || !/^[a-f0-9]{64}$/.test(entry.scope) ||
    !Number.isSafeInteger(entry.expiresAt) || !Number.isSafeInteger(entry.bytes) ||
    entry.bytes < 1 || entry.bytes > MAX_RETAINED_IMAGE_BYTES ||
    !Number.isSafeInteger(entry.chunks) || entry.chunks < 1 || entry.chunks > 86)) {
    return undefined;
  }
  return parsed as Entry[];
}
