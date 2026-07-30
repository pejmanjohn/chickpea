import { materializeCatalogModel } from './bundled.ts';
import { isCompiledModelProfileId } from './profiles.ts';
import type {
  CompiledModelProfileId,
  ModelAuthLane,
  ModelCatalogEntry,
} from './types.ts';

export const MODEL_CATALOG_SCHEMA_VERSION = 1;
export const MODEL_CATALOG_MAX_ENTRIES = 64;
export const MODEL_CATALOG_MAX_BYTES = 128 * 1024;

export interface ExternalModelCatalogEntryV1 {
  canonical: ModelCatalogEntry['id'];
  displayName?: string;
  lanes: {
    subscription?: CompiledModelProfileId;
    apiKey?: CompiledModelProfileId;
  };
  contextWindow?: number;
  maxTokens?: number;
}

export interface ModelCatalogDocumentV1 {
  schemaVersion: 1;
  revision: number;
  generatedAt: string;
  entries: ExternalModelCatalogEntryV1[];
}

export class ModelCatalogValidationError extends Error {
  constructor(message: string) {
    super(`Model catalog ${message}`);
    this.name = 'ModelCatalogValidationError';
  }
}

export function parseModelCatalogBytes(bytes: Uint8Array): ModelCatalogDocumentV1 {
  if (bytes.byteLength > MODEL_CATALOG_MAX_BYTES) {
    throw new ModelCatalogValidationError(`exceeds ${MODEL_CATALOG_MAX_BYTES} bytes.`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ModelCatalogValidationError('is not valid UTF-8.');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ModelCatalogValidationError('is not valid JSON.');
  }
  return parseModelCatalogValue(value);
}

export function parseModelCatalogValue(value: unknown): ModelCatalogDocumentV1 {
  const root = record(value, 'document');
  exactKeys(root, ['schemaVersion', 'revision', 'generatedAt', 'entries'], 'document');
  if (root.schemaVersion !== MODEL_CATALOG_SCHEMA_VERSION) {
    throw new ModelCatalogValidationError('schemaVersion must be 1.');
  }
  const revision = positiveInteger(root.revision, 'revision');
  if (typeof root.generatedAt !== 'string' || root.generatedAt.length > 64 ||
      !Number.isFinite(Date.parse(root.generatedAt))) {
    throw new ModelCatalogValidationError('generatedAt must be a bounded ISO timestamp.');
  }
  if (!Array.isArray(root.entries) || root.entries.length > MODEL_CATALOG_MAX_ENTRIES) {
    throw new ModelCatalogValidationError(`entries must contain at most ${MODEL_CATALOG_MAX_ENTRIES} items.`);
  }
  const seen = new Set<string>();
  const entries = root.entries.map((candidate, index) => {
    const entry = parseEntry(candidate, index);
    if (seen.has(entry.canonical)) {
      throw new ModelCatalogValidationError(`contains duplicate canonical id ${entry.canonical}.`);
    }
    seen.add(entry.canonical);
    return entry;
  });
  return deepFreeze({
    schemaVersion: 1,
    revision,
    generatedAt: root.generatedAt,
    entries,
  });
}

/** Publisher/runtime shared terminology for validating an already-decoded document. */
export const parseHostedCatalogDocument = parseModelCatalogValue;

export function externalEntryToInternal(entry: ExternalModelCatalogEntryV1): ModelCatalogEntry {
  const provider = entry.canonical.slice(0, entry.canonical.indexOf('/'));
  const lanes: ModelCatalogEntry['lanes'] = {};
  if (entry.lanes.subscription) lanes.openai_subscription = entry.lanes.subscription;
  if (entry.lanes.apiKey) {
    const lane: ModelAuthLane = provider === 'openai' ? 'openai_api_key' : 'anthropic_api_key';
    lanes[lane] = entry.lanes.apiKey;
  }
  return {
    id: entry.canonical,
    ...(entry.displayName ? { displayName: entry.displayName } : {}),
    lanes,
    ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
    ...(entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {}),
  };
}

function parseEntry(value: unknown, index: number): ExternalModelCatalogEntryV1 {
  const entry = record(value, `entry ${index}`);
  exactKeys(
    entry,
    ['canonical', 'displayName', 'lanes', 'contextWindow', 'maxTokens'],
    `entry ${index}`,
    ['canonical', 'lanes'],
  );
  if (typeof entry.canonical !== 'string' ||
      !/^(openai|anthropic)\/[a-z0-9][a-z0-9._-]{0,127}$/.test(entry.canonical)) {
    throw new ModelCatalogValidationError(`entry ${index} has an invalid canonical id.`);
  }
  const canonical = entry.canonical as ModelCatalogEntry['id'];
  const provider = canonical.slice(0, canonical.indexOf('/'));
  const lanesValue = record(entry.lanes, `entry ${index} lanes`);
  exactKeys(lanesValue, ['subscription', 'apiKey'], `entry ${index} lanes`, []);
  if (Object.keys(lanesValue).length === 0) {
    throw new ModelCatalogValidationError(`entry ${index} lanes cannot be empty.`);
  }
  if (lanesValue.subscription !== undefined && provider !== 'openai') {
    throw new ModelCatalogValidationError(`entry ${index} subscription lane requires openai.`);
  }
  for (const [lane, profile] of Object.entries(lanesValue)) {
    if (!isCompiledModelProfileId(profile)) {
      throw new ModelCatalogValidationError(`entry ${index} ${lane} profile is not compiled.`);
    }
  }
  const lanes: ExternalModelCatalogEntryV1['lanes'] = {
    ...(lanesValue.subscription !== undefined
      ? { subscription: lanesValue.subscription as CompiledModelProfileId }
      : {}),
    ...(lanesValue.apiKey !== undefined
      ? { apiKey: lanesValue.apiKey as CompiledModelProfileId }
      : {}),
  };
  const displayName = optionalDisplayName(entry.displayName, index);
  const contextWindow = optionalPositiveInteger(entry.contextWindow, `entry ${index} contextWindow`);
  const maxTokens = optionalPositiveInteger(entry.maxTokens, `entry ${index} maxTokens`);
  const parsed: ExternalModelCatalogEntryV1 = {
    canonical,
    ...(displayName ? { displayName } : {}),
    lanes,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
  const internal = externalEntryToInternal(parsed);
  for (const lane of Object.keys(internal.lanes) as ModelAuthLane[]) {
    try {
      materializeCatalogModel(internal, lane);
    } catch (error) {
      throw new ModelCatalogValidationError(
        `entry ${index} is incompatible: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return parsed;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ModelCatalogValidationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  required: readonly string[] = allowed,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) throw new ModelCatalogValidationError(`${label} contains unknown field ${unknown}.`);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing) throw new ModelCatalogValidationError(`${label} is missing ${missing}.`);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ModelCatalogValidationError(`${label} must be a positive safe integer.`);
  }
  return value as number;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, label);
}

function optionalDisplayName(value: unknown, index: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || value.trim() !== value) {
    throw new ModelCatalogValidationError(`entry ${index} displayName is invalid.`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
