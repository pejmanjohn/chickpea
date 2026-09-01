import { sha256Hex } from '../security/digest.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import {
  parseModelCatalogBytes,
  parseModelCatalogValue,
  type ModelCatalogDocumentV1,
} from './schema.ts';

export const MODEL_CATALOG_SETTING_KEYS = {
  mode: 'model.catalog.mode',
  lkg: 'model.catalog.lkg',
  refreshLease: 'model.catalog.refresh-lease',
} as const;

export type ModelCatalogMode = 'bundled' | 'hosted';

export interface ModelCatalogLkg {
  schemaVersion: 1;
  sha256: string;
  document: ModelCatalogDocumentV1;
  etag?: string;
  lastModified?: string;
  checkedAt: number;
  nextRefreshAt: number;
}

export interface ModelCatalogCandidate {
  /** Exact fetched bytes. The store parses and hashes its own defensive copy. */
  bytes: Uint8Array;
  etag?: string;
  lastModified?: string;
  checkedAt: number;
  nextRefreshAt: number;
}

export type ModelCatalogAcceptanceResult =
  | { status: 'accepted' | 'unchanged'; lkg: ModelCatalogLkg }
  | { status: 'stale' | 'equivocation'; lkg: ModelCatalogLkg };

interface RefreshLease {
  schemaVersion: 1;
  ownerId: string;
  expiresAt: number;
}

const MAX_CAS_ATTEMPTS = 12;
const REFRESH_LEASE_MS = 10_000;

export async function readModelCatalogMode(settings: SettingsStore): Promise<ModelCatalogMode> {
  return await settings.getSetting(MODEL_CATALOG_SETTING_KEYS.mode) === 'bundled'
    ? 'bundled'
    : 'hosted';
}

export async function readModelCatalogLkg(
  settings: SettingsStore,
): Promise<ModelCatalogLkg | undefined> {
  const raw = await settings.getSetting(MODEL_CATALOG_SETTING_KEYS.lkg);
  return raw === undefined ? undefined : parseStoredLkg(raw);
}

export async function acceptModelCatalogCandidate(
  settings: SettingsStore,
  candidate: ModelCatalogCandidate,
): Promise<ModelCatalogAcceptanceResult> {
  validateCandidateMetadata(candidate);
  // Parse and hash one defensive copy here, at the persistence boundary. A
  // caller cannot pair trusted-looking metadata with different fetched bytes.
  const bytes = Uint8Array.from(candidate.bytes);
  const document = parseModelCatalogBytes(bytes);
  const sha256 = await sha256Hex(bytes);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const currentRaw = await settings.getSetting(MODEL_CATALOG_SETTING_KEYS.lkg);
    const current = currentRaw === undefined ? undefined : parseStoredLkg(currentRaw);
    if (current) {
      if (document.revision < current.document.revision) {
        return { status: 'stale', lkg: current };
      }
      if (document.revision === current.document.revision && sha256 !== current.sha256) {
        return { status: 'equivocation', lkg: current };
      }
    }
    const unchanged = current?.document.revision === document.revision && current.sha256 === sha256;
    const next = candidateToLkg(candidate, document, sha256);
    const stored = await settings.applySettingsPatch({
      expected: {
        key: MODEL_CATALOG_SETTING_KEYS.lkg,
        value: currentRaw ?? null,
      },
      set: [{ key: MODEL_CATALOG_SETTING_KEYS.lkg, value: JSON.stringify(next) }],
    });
    if (stored) {
      return {
        status: unchanged ? 'unchanged' : 'accepted',
        lkg: next,
      };
    }
  }
  throw new Error('Model catalog LKG CAS retry limit exceeded.');
}

export async function touchModelCatalogLkg(
  settings: SettingsStore,
  expected: ModelCatalogLkg,
  metadata: {
    checkedAt: number;
    nextRefreshAt: number;
    etag?: string;
    lastModified?: string;
  },
): Promise<ModelCatalogLkg> {
  const raw = await settings.getSetting(MODEL_CATALOG_SETTING_KEYS.lkg);
  if (raw === undefined) throw new Error('Model catalog 304 has no LKG.');
  const current = parseStoredLkg(raw);
  if (current.sha256 !== expected.sha256 ||
      current.document.revision !== expected.document.revision) {
    return current;
  }
  const next: ModelCatalogLkg = {
    ...current,
    checkedAt: metadata.checkedAt,
    nextRefreshAt: metadata.nextRefreshAt,
    ...(metadata.etag !== undefined
      ? { etag: boundedHeader(metadata.etag, 'etag', 256) }
      : current.etag ? { etag: current.etag } : {}),
    ...(metadata.lastModified !== undefined
      ? { lastModified: boundedHeader(metadata.lastModified, 'lastModified', 128) }
      : current.lastModified ? { lastModified: current.lastModified } : {}),
  };
  const updated = await settings.applySettingsPatch({
    expected: { key: MODEL_CATALOG_SETTING_KEYS.lkg, value: raw },
    set: [{ key: MODEL_CATALOG_SETTING_KEYS.lkg, value: JSON.stringify(next) }],
  });
  return updated ? next : (await readModelCatalogLkg(settings)) ?? current;
}

export async function acquireModelCatalogRefreshLease(
  settings: SettingsStore,
  ownerId: string,
  now: number,
): Promise<{ acquired: boolean; lease?: RefreshLease }> {
  if (!ownerId || ownerId.length > 128 || !Number.isSafeInteger(now) || now < 0) {
    throw new Error('Invalid model catalog refresh lease request.');
  }
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const raw = await settings.getSetting(MODEL_CATALOG_SETTING_KEYS.refreshLease);
    const current = raw === undefined ? undefined : parseLease(raw);
    if (current && current.expiresAt > now && current.ownerId !== ownerId) {
      return { acquired: false };
    }
    const lease: RefreshLease = { schemaVersion: 1, ownerId, expiresAt: now + REFRESH_LEASE_MS };
    const stored = await settings.applySettingsPatch({
      expected: {
        key: MODEL_CATALOG_SETTING_KEYS.refreshLease,
        value: raw ?? null,
      },
      set: [{ key: MODEL_CATALOG_SETTING_KEYS.refreshLease, value: JSON.stringify(lease) }],
    });
    if (stored) return { acquired: true, lease };
  }
  return { acquired: false };
}

export async function releaseModelCatalogRefreshLease(
  settings: SettingsStore,
  ownerId: string,
): Promise<boolean> {
  const raw = await settings.getSetting(MODEL_CATALOG_SETTING_KEYS.refreshLease);
  if (raw === undefined) return false;
  const current = parseLease(raw);
  if (current.ownerId !== ownerId) return false;
  return settings.applySettingsPatch({
    expected: { key: MODEL_CATALOG_SETTING_KEYS.refreshLease, value: raw },
    delete: [MODEL_CATALOG_SETTING_KEYS.refreshLease],
  });
}

function candidateToLkg(
  candidate: ModelCatalogCandidate,
  document: ModelCatalogDocumentV1,
  sha256: string,
): ModelCatalogLkg {
  return {
    schemaVersion: 1,
    sha256,
    document,
    ...(candidate.etag ? { etag: boundedHeader(candidate.etag, 'etag', 256) } : {}),
    ...(candidate.lastModified
      ? { lastModified: boundedHeader(candidate.lastModified, 'lastModified', 128) }
      : {}),
    checkedAt: candidate.checkedAt,
    nextRefreshAt: candidate.nextRefreshAt,
  };
}

function parseStoredLkg(raw: string): ModelCatalogLkg {
  if (raw.length > 140 * 1024) throw new Error('Stored model catalog LKG is oversized.');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Stored model catalog LKG is invalid JSON.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Stored model catalog LKG is invalid.');
  }
  const record = value as Record<string, unknown>;
  exactLocalKeys(
    record,
    ['schemaVersion', 'sha256', 'document', 'etag', 'lastModified', 'checkedAt', 'nextRefreshAt'],
    ['schemaVersion', 'sha256', 'document', 'checkedAt', 'nextRefreshAt'],
  );
  if (record.schemaVersion !== 1 || typeof record.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.sha256)) {
    throw new Error('Stored model catalog LKG metadata is invalid.');
  }
  const checkedAt = nonNegativeInteger(record.checkedAt, 'checkedAt');
  const nextRefreshAt = nonNegativeInteger(record.nextRefreshAt, 'nextRefreshAt');
  return {
    schemaVersion: 1,
    sha256: record.sha256,
    document: parseModelCatalogValue(record.document),
    ...(record.etag !== undefined
      ? { etag: boundedHeader(record.etag, 'etag', 256) }
      : {}),
    ...(record.lastModified !== undefined
      ? { lastModified: boundedHeader(record.lastModified, 'lastModified', 128) }
      : {}),
    checkedAt,
    nextRefreshAt,
  };
}

function parseLease(raw: string): RefreshLease {
  if (raw.length > 512) throw new Error('Stored model catalog refresh lease is oversized.');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Stored model catalog refresh lease is invalid.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Stored model catalog refresh lease is invalid.');
  }
  const record = value as Record<string, unknown>;
  exactLocalKeys(
    record,
    ['schemaVersion', 'ownerId', 'expiresAt'],
    ['schemaVersion', 'ownerId', 'expiresAt'],
  );
  if (record.schemaVersion !== 1 || typeof record.ownerId !== 'string' ||
      record.ownerId.length === 0 || record.ownerId.length > 128) {
    throw new Error('Stored model catalog refresh lease owner is invalid.');
  }
  return {
    schemaVersion: 1,
    ownerId: record.ownerId,
    expiresAt: nonNegativeInteger(record.expiresAt, 'expiresAt'),
  };
}

function validateCandidateMetadata(candidate: ModelCatalogCandidate): void {
  if (!(candidate.bytes instanceof Uint8Array)) {
    throw new Error('Model catalog candidate bytes are invalid.');
  }
  nonNegativeInteger(candidate.checkedAt, 'checkedAt');
  nonNegativeInteger(candidate.nextRefreshAt, 'nextRefreshAt');
}

function boundedHeader(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\r\n]/.test(value)) {
    throw new Error(`Model catalog ${label} is invalid.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Model catalog ${label} is invalid.`);
  }
  return value as number;
}

function exactLocalKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key)) ||
      required.some((key) => !Object.hasOwn(value, key))) {
    throw new Error('Stored model catalog record has unexpected fields.');
  }
}
