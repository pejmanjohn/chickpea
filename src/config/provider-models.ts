import type { ProviderKeyId } from './provider-keys.ts';
import { isProviderKeyId, resolveProviderApiKey } from './provider-keys.ts';
import type { SettingsStore } from './settings-store.ts';
import type { PlatformEnv } from './state-backend.ts';

export type AdminProviderId = ProviderKeyId | 'workers-ai';
export type FavoriteProviderId = 'openrouter' | 'workers-ai';

export interface ProviderModel {
  id: string;
  display_name?: string;
  context_length?: number;
  pricing?: Record<string, string>;
}

export interface ProviderModelsResult {
  models: ProviderModel[];
  cached: boolean;
}

export class ProviderKeyRejectedError extends Error {
  constructor(
    readonly provider: ProviderKeyId,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Provider ${provider} rejected key: ${detail}`);
  }
}

export class ProviderUnreachableError extends Error {
  constructor(
    readonly provider: AdminProviderId,
    message: string,
  ) {
    super(message);
  }
}

export class ProviderModelsUnavailableError extends Error {
  constructor(
    readonly provider: AdminProviderId,
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

export const WORKERS_AI_DEFAULT_FAVORITES = [
  '@cf/zai-org/glm-5.2',
  '@cf/moonshotai/kimi-k2.6',
  '@cf/openai/gpt-oss-120b',
  '@cf/meta/llama-3.3-70b-instruct',
] as const;

export const PROVIDER_FAVORITES_SETTING_KEYS = {
  openrouter: 'provider.openrouter.favorites',
  'workers-ai': 'provider.workers-ai.favorites',
} as const;

const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_PROVIDER_FETCH_TIMEOUT_MS = 8_000;
const OPENAI_CHAT_MODEL_PREFIXES = ['gpt-', 'o1', 'o3', 'o4', 'o5', 'chatgpt-', 'codex-'];

const modelCache = new Map<AdminProviderId, { expiresAt: number; models: ProviderModel[] }>();
const cachedModelCounts = new Map<AdminProviderId, number>();

export function isAdminProviderId(id: string): id is AdminProviderId {
  return isProviderKeyId(id) || id === 'workers-ai';
}

export function isFavoriteProviderId(id: string): id is FavoriteProviderId {
  return id === 'openrouter' || id === 'workers-ai';
}

export async function validateProviderApiKey(
  id: ProviderKeyId,
  apiKey: string,
  options: { timeoutMs?: number } = {},
): Promise<ProviderModel[]> {
  switch (id) {
    case 'anthropic':
      return fetchAnthropicModels(apiKey, true, options.timeoutMs);
    case 'openai':
      return fetchOpenAiModels(apiKey, true, options.timeoutMs);
    case 'openrouter':
      await validateOpenRouterKey(apiKey, options.timeoutMs);
      return fetchOpenRouterModels(options.timeoutMs);
  }
}

export async function listProviderModels(
  id: AdminProviderId,
  options: {
    env?: PlatformEnv;
    store?: SettingsStore;
    refresh?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<ProviderModelsResult> {
  if (!options.refresh) {
    const cached = modelCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return { models: cached.models, cached: true };
    }
  }

  const models = await fetchProviderModels(id, options.env, options.store, options.timeoutMs);
  primeProviderModelCache(id, models);
  return { models, cached: false };
}

export function primeProviderModelCache(id: AdminProviderId, models: ProviderModel[]): void {
  modelCache.set(id, { expiresAt: Date.now() + MODEL_CACHE_TTL_MS, models });
  cachedModelCounts.set(id, models.length);
}

export function invalidateProviderModelCache(id?: AdminProviderId): void {
  if (id) {
    modelCache.delete(id);
    cachedModelCounts.delete(id);
    return;
  }
  modelCache.clear();
  cachedModelCounts.clear();
}

export function cachedProviderModelCount(id: AdminProviderId): number | undefined {
  return cachedModelCounts.get(id);
}

export async function getProviderFavorites(
  id: FavoriteProviderId,
  store: SettingsStore,
): Promise<string[]> {
  const settingKey = PROVIDER_FAVORITES_SETTING_KEYS[id];
  const stored = await store.getSetting(settingKey);
  if (stored) {
    return parseFavorites(stored);
  }
  if (id === 'workers-ai') {
    const seeded = [...WORKERS_AI_DEFAULT_FAVORITES];
    await store.setSetting(settingKey, JSON.stringify(seeded));
    return seeded;
  }
  return [];
}

export async function putProviderFavorites(
  id: FavoriteProviderId,
  favorites: readonly string[],
  store: SettingsStore,
): Promise<string[]> {
  const normalized = uniqueNonEmptyStrings(favorites);
  await store.setSetting(PROVIDER_FAVORITES_SETTING_KEYS[id], JSON.stringify(normalized));
  return normalized;
}

async function fetchProviderModels(
  id: AdminProviderId,
  env: PlatformEnv | undefined,
  store: SettingsStore | undefined,
  timeoutMs: number | undefined,
): Promise<ProviderModel[]> {
  if (id === 'openrouter') {
    return fetchOpenRouterModels(timeoutMs);
  }
  if (id === 'workers-ai') {
    return fetchWorkersAiModels(env, timeoutMs);
  }
  const { apiKey } = await resolveProviderApiKey(id, env, store);
  if (!apiKey) {
    throw new ProviderModelsUnavailableError(id, 'provider_key_missing', 409);
  }
  return id === 'anthropic'
    ? fetchAnthropicModels(apiKey, false, timeoutMs)
    : fetchOpenAiModels(apiKey, false, timeoutMs);
}

async function fetchAnthropicModels(
  apiKey: string,
  validating: boolean,
  timeoutMs?: number,
): Promise<ProviderModel[]> {
  const { response, body } = await fetchProviderJson(
    'anthropic',
    `${anthropicApiBase()}/v1/models`,
    {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    },
    timeoutMs,
  );
  if (!response.ok) {
    throw validating
      ? new ProviderKeyRejectedError('anthropic', response.status, providerErrorDetail(body, response))
      : new ProviderModelsUnavailableError('anthropic', 'provider_models_failed', 502);
  }
  return readModelArray(body).map((model) => {
    const id = stringField(model, 'id');
    const displayName = optionalStringField(model, 'display_name') ?? optionalStringField(model, 'displayName');
    return displayName ? { id, display_name: displayName } : { id };
  });
}

async function fetchOpenAiModels(
  apiKey: string,
  validating: boolean,
  timeoutMs?: number,
): Promise<ProviderModel[]> {
  const { response, body } = await fetchProviderJson(
    'openai',
    `${openAiApiBase()}/models`,
    { headers: { authorization: `Bearer ${apiKey}` } },
    timeoutMs,
  );
  if (!response.ok) {
    throw validating
      ? new ProviderKeyRejectedError('openai', response.status, providerErrorDetail(body, response))
      : new ProviderModelsUnavailableError('openai', 'provider_models_failed', 502);
  }
  return readModelArray(body)
    .map((model) => ({ id: stringField(model, 'id') }))
    .filter((model) => OPENAI_CHAT_MODEL_PREFIXES.some((prefix) => model.id.startsWith(prefix)));
}

async function validateOpenRouterKey(apiKey: string, timeoutMs?: number): Promise<void> {
  const { response, body } = await fetchProviderJson(
    'openrouter',
    `${openRouterApiBase()}/auth/key`,
    { headers: { authorization: `Bearer ${apiKey}` } },
    timeoutMs,
  );
  if (!response.ok) {
    throw new ProviderKeyRejectedError('openrouter', response.status, providerErrorDetail(body, response));
  }
}

async function fetchOpenRouterModels(timeoutMs?: number): Promise<ProviderModel[]> {
  const { response, body } = await fetchProviderJson(
    'openrouter',
    `${openRouterApiBase()}/models`,
    undefined,
    timeoutMs,
  );
  if (!response.ok) {
    throw new ProviderModelsUnavailableError('openrouter', 'provider_models_failed', 502);
  }
  return readModelArray(body).map((model) => {
    const pricing = recordOfStrings(model.pricing);
    const contextLength = numberField(model, 'context_length');
    return {
      id: stringField(model, 'id'),
      ...(contextLength !== undefined ? { context_length: contextLength } : {}),
      ...(pricing ? { pricing } : {}),
    };
  });
}

async function fetchWorkersAiModels(
  env: PlatformEnv | undefined,
  timeoutMs?: number,
): Promise<ProviderModel[]> {
  const binding = aiBinding(env);
  if (binding) {
    const models = await withProviderDeadline(
      'workers-ai',
      timeoutMs,
      () => binding.models({ task: 'Text Generation' }),
    );
    return models.map(workersAiProviderModel).filter((model) => model.id);
  }

  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) {
    throw new ProviderModelsUnavailableError('workers-ai', 'workers_ai_credentials_required', 409);
  }

  const url = new URL(`${cloudflareApiBase()}/accounts/${accountId}/ai/models/search`);
  url.searchParams.set('task', 'Text Generation');
  const { response, body } = await fetchProviderJson(
    'workers-ai',
    url.href,
    { headers: { authorization: `Bearer ${token}` } },
    timeoutMs,
  );
  if (!response.ok) {
    throw new ProviderModelsUnavailableError('workers-ai', 'provider_models_failed', 502);
  }
  return readModelArray(body).map(workersAiProviderModel).filter((model) => model.id);
}

async function fetchProviderJson(
  provider: AdminProviderId,
  url: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<{ response: Response; body: unknown }> {
  return withProviderDeadline(
    provider,
    timeoutMs,
    async (signal) => {
      let response: Response;
      try {
        response = await fetch(url, { ...init, signal });
      } catch (err) {
        if (signal.aborted) throw err;
        throw new ProviderUnreachableError(provider, errorMessage(err));
      }
      return { response, body: await readJson(response) };
    },
    init?.signal ?? undefined,
  );
}

async function withProviderDeadline<T>(
  provider: AdminProviderId,
  timeoutMs: number | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal,
): Promise<T> {
  const deadlineMs = timeoutMs ?? DEFAULT_PROVIDER_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const rejectOnAbort = () => rejectAbort?.(controller.signal.reason);
  controller.signal.addEventListener('abort', rejectOnAbort, { once: true });

  const forwardAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) {
    forwardAbort();
  } else {
    callerSignal?.addEventListener('abort', forwardAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deadlineMs);

  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } catch (err) {
    if (timedOut) {
      throw new ProviderUnreachableError(
        provider,
        `Provider ${provider} request timed out after ${deadlineMs}ms`,
      );
    }
    if (controller.signal.aborted) {
      throw new ProviderUnreachableError(provider, errorMessage(err));
    }
    throw err;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', forwardAbort);
    controller.signal.removeEventListener('abort', rejectOnAbort);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function anthropicApiBase(): string {
  return trimTrailingSlashes(process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com');
}

function openAiApiBase(): string {
  return trimTrailingSlashes(process.env.OPENAI_API_URL || 'https://api.openai.com/v1');
}

function openRouterApiBase(): string {
  return trimTrailingSlashes(process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1');
}

function cloudflareApiBase(): string {
  return trimTrailingSlashes(process.env.CLOUDFLARE_API_URL || 'https://api.cloudflare.com/client/v4');
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function readModelArray(body: unknown): Record<string, unknown>[] {
  if (!body || typeof body !== 'object') {
    return [];
  }
  const record = body as Record<string, unknown>;
  const candidates = [record.data, record.result, record.models];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(isRecord);
    }
    if (candidate && typeof candidate === 'object') {
      const nested = candidate as Record<string, unknown>;
      if (Array.isArray(nested.models)) {
        return nested.models.filter(isRecord);
      }
    }
  }
  return [];
}

function providerErrorDetail(body: unknown, response: Response): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const error = record.error;
    if (error && typeof error === 'object') {
      const errorRecord = error as Record<string, unknown>;
      const type = optionalStringField(errorRecord, 'type') ?? optionalStringField(errorRecord, 'code');
      const message = optionalStringField(errorRecord, 'message');
      if (type && message) return `${type}: ${message}`;
      if (message) return message;
    }
    const message = optionalStringField(record, 'message') ?? optionalStringField(record, 'error');
    if (message) return message;
  }
  return `${response.status} ${response.statusText}`.trim();
}

function parseFavorites(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? uniqueNonEmptyStrings(parsed) : [];
  } catch {
    return [];
  }
}

function uniqueNonEmptyStrings(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function stringField(record: Record<string, unknown>, key: string): string {
  return optionalStringField(record, key) ?? '';
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function recordOfStrings(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function aiBinding(env: PlatformEnv | undefined):
  | { models(params?: { task?: string }): Promise<Array<{ id: string; name?: string }>> }
  | undefined {
  const candidate = env?.AI;
  if (!candidate || typeof candidate !== 'object') {
    return undefined;
  }
  const models = (candidate as { models?: unknown }).models;
  if (typeof models !== 'function') {
    return undefined;
  }
  return candidate as { models(params?: { task?: string }): Promise<Array<{ id: string; name?: string }>> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function workersAiProviderModel(model: { id?: unknown; name?: unknown }): ProviderModel {
  const name = typeof model.name === 'string' && model.name ? model.name : undefined;
  const id = typeof model.id === 'string' ? model.id : '';
  return { id: name ?? id };
}
