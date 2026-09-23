import { createHash, randomUUID } from 'node:crypto';

import type { SettingsStore } from '../config/settings-store.ts';
import { SAVED_IMAGE_ID, type ImageOutputStore } from '../images/output-store.ts';
import type { SlackFileContent } from '../sandbox/artifact-tool.ts';
import type {
  ThreadImageInventory,
  ThreadImageReader,
  ThreadImageUnavailableDetail,
} from '../slack/thread-images.ts';

/**
 * Handles for files an Agent produced or can see, so a later tool can send
 * the same bytes somewhere other than Slack. Three families, each bound to the
 * turn's workspace, Agent, and Slack destination:
 *
 * - `saved:<uuid>`: a generated image or browser screenshot, retained by the
 *   image output store for up to 24 hours.
 * - `rec:<uuid>`: a browser recording. Its bytes are never retained here (a
 *   recording can be hundreds of megabytes); the handle keeps the browser
 *   provider's session id, and the recording is streamed from the provider
 *   again when it is used.
 * - `img:N`: an image already in this Slack conversation, resolved against
 *   the turn's own inventory.
 *
 * No lookup is global: a handle from another thread, another Agent, or past
 * its expiry resolves to nothing.
 */

export const RECORDING_RETENTION_MS = 24 * 60 * 60 * 1000;
export const RECORDING_HANDLE_ID = /^rec:[a-f0-9-]{36}$/;
const RECORDING_INDEX = 'browser_recordings:v1:index';
const MAX_RECORDING_ENTRIES = 128;
const PROVIDER_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

interface RecordingEntry {
  id: string;
  scope: string;
  sessionId: string;
  filename: string;
  byteLength?: number;
  expiresAt: number;
}

export interface RetainedRecording {
  sessionId: string;
  filename: string;
  byteLength?: number;
  expiresAt: number;
}

export interface RecordingHandleStore {
  save(input: { sessionId: string; filename: string; byteLength?: number }): Promise<{ id: string; expiresAt: number }>;
  read(id: string): Promise<RetainedRecording | undefined>;
}

/** The same destination hash the image output store uses for its scope. */
function scopeOf(destination: object): string {
  return createHash('sha256').update(JSON.stringify(destination)).digest('hex');
}

export function createRecordingHandleStore(
  settings: Pick<SettingsStore, 'getSetting' | 'applySettingsPatch'>,
  destination: object,
  now: () => number = Date.now,
): RecordingHandleStore {
  const scope = scopeOf(destination);
  return {
    async save(input) {
      if (!PROVIDER_SESSION_ID.test(input.sessionId)) throw new Error('recording_session_invalid');
      const entry: RecordingEntry = {
        id: `rec:${randomUUID()}`,
        scope,
        sessionId: input.sessionId,
        filename: input.filename,
        ...(input.byteLength === undefined ? {} : { byteLength: input.byteLength }),
        expiresAt: now() + RECORDING_RETENTION_MS,
      };
      for (let attempt = 0; attempt < 8; attempt++) {
        const raw = await settings.getSetting(RECORDING_INDEX);
        const live = (recordingEntries(raw) ?? []).filter((item) => item.expiresAt > now());
        const kept = [...live, entry].slice(-MAX_RECORDING_ENTRIES);
        if (await settings.applySettingsPatch({
          expected: { key: RECORDING_INDEX, value: raw ?? null },
          set: [{ key: RECORDING_INDEX, value: JSON.stringify(kept) }],
        })) return { id: entry.id, expiresAt: entry.expiresAt };
      }
      throw new Error('recording_retention_busy');
    },
    async read(id) {
      if (!RECORDING_HANDLE_ID.test(id)) return undefined;
      const entry = (recordingEntries(await settings.getSetting(RECORDING_INDEX)) ?? [])
        .find((item) => item.id === id && item.scope === scope && item.expiresAt > now());
      if (!entry) return undefined;
      return {
        sessionId: entry.sessionId,
        filename: entry.filename,
        ...(entry.byteLength === undefined ? {} : { byteLength: entry.byteLength }),
        expiresAt: entry.expiresAt,
      };
    },
  };
}

function recordingEntries(raw: string | undefined): RecordingEntry[] | undefined {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!Array.isArray(parsed) || parsed.length > MAX_RECORDING_ENTRIES) return undefined;
  const valid = parsed.every((entry) =>
    entry && typeof entry === 'object' &&
    RECORDING_HANDLE_ID.test(entry.id) && /^[a-f0-9]{64}$/.test(entry.scope) &&
    typeof entry.sessionId === 'string' && PROVIDER_SESSION_ID.test(entry.sessionId) &&
    typeof entry.filename === 'string' && entry.filename.length > 0 && entry.filename.length <= 256 &&
    Number.isSafeInteger(entry.expiresAt) &&
    (entry.byteLength === undefined || (Number.isSafeInteger(entry.byteLength) && entry.byteLength > 0)));
  return valid ? parsed as RecordingEntry[] : undefined;
}

/** One file ready to send: content plus the name and type it goes out with. */
export interface ResolvedUploadFile {
  filename: string;
  contentType: string;
  content: SlackFileContent;
}

export type UploadFileUnavailableDetail =
  | 'not_found'
  | 'expired_or_unavailable'
  | 'recording_unavailable'
  | ThreadImageUnavailableDetail;

export type UploadFileResolution =
  | { ok: true; file: ResolvedUploadFile }
  | { ok: false; detail: UploadFileUnavailableDetail };

export interface UploadFileSources {
  images?: Pick<ImageOutputStore, 'read'>;
  recordings?: Pick<RecordingHandleStore, 'read'>;
  /** Streams a provider recording again; returns undefined when it is no longer retrievable. */
  openRecording?: (sessionId: string) => Promise<SlackFileContent | undefined>;
  inventory?: ThreadImageInventory;
  createImageReader?: () => Promise<Pick<ThreadImageReader, 'read'>>;
}

export const UPLOAD_FILE_HANDLE = /^(?:saved:[a-f0-9-]{36}|rec:[a-f0-9-]{36}|img:[1-9][0-9]{0,2})$/;

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

/** Resolve one handle within the turn's scope; every failure is a returned value. */
export async function resolveUploadFile(
  handle: string,
  sources: UploadFileSources,
): Promise<UploadFileResolution> {
  if (SAVED_IMAGE_ID.test(handle)) {
    const saved = await sources.images?.read(handle).catch(() => undefined);
    const format = typeof saved?.metadata.format === 'string' ? saved.metadata.format : '';
    const contentType = IMAGE_TYPES[format];
    if (!saved || !contentType) return { ok: false, detail: 'expired_or_unavailable' };
    const stem = saved.metadata.source === 'browser_screenshot' ? 'screenshot' : 'image';
    return { ok: true, file: { filename: `${stem}.${format === 'jpeg' ? 'jpg' : format}`, contentType, content: saved.bytes } };
  }
  if (RECORDING_HANDLE_ID.test(handle)) {
    const recording = await sources.recordings?.read(handle).catch(() => undefined);
    if (!recording) return { ok: false, detail: 'expired_or_unavailable' };
    const content = await sources.openRecording?.(recording.sessionId).catch(() => undefined);
    if (!content) return { ok: false, detail: 'recording_unavailable' };
    return { ok: true, file: { filename: recording.filename, contentType: 'video/mp4', content } };
  }
  if (!sources.inventory || !sources.createImageReader) return { ok: false, detail: 'not_found' };
  const resolved = sources.inventory.resolveHandle(handle);
  if (!resolved.ok) return { ok: false, detail: resolved.detail };
  const read = await (await sources.createImageReader()).read(resolved.record);
  if (!read.ok) return { ok: false, detail: read.detail };
  return { ok: true, file: { filename: read.filename, contentType: read.mimeType, content: read.bytes } };
}
