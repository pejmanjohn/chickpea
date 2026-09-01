import {
  recordComposioPreparationResult,
  resolveComposioConfiguration,
  type ComposioAuthConfigIds,
  type ComposioConfigurationOptions,
} from '../config/composio-settings.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import { getSettingsStore } from '../config/state-backend.ts';
import {
  MANAGED_CONNECTOR_CATALOG,
  type ManagedAccessLane,
} from './catalog/index.ts';
import {
  createComposioClient,
  isComposioAuthConfigId,
  type ComposioAuthConfigLike,
  type ComposioClientLike,
} from './providers/composio.ts';

const SETUP_LEASE_SETTING = 'managed.composio.setup_lease';
const DEFAULT_SETUP_LEASE_MS = 60_000;
const DEFAULT_SETUP_DEADLINE_MS = 45_000;
const MAX_AUTH_CONFIG_PAGES = 100;
const AUTH_CONFIG_PAGE_SIZE = 100;
const AUTH_CONFIG_NAME_SUFFIX = 'v1';
const LEASE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

interface SetupLease {
  version: 1;
  attemptId: string;
  generation: number;
  expiresAt: number;
}

interface ComposioConnectorPreparationResult {
  toolkit: string;
  status: 'ready' | 'failed';
  authConfigId?: string;
  issueCode?: string;
}

interface ComposioPreparationResult {
  status: 'ready' | 'partial' | 'failed';
  authConfigIds: ComposioAuthConfigIds;
  connectors: ComposioConnectorPreparationResult[];
  issueCodes: string[];
}

interface ComposioSetupOptions extends ComposioConfigurationOptions {
  createClient?: (input: { apiKey: string }) => Promise<ComposioClientLike>;
  signal?: AbortSignal;
  now?: () => number;
  createAttemptId?: () => string;
  leaseDurationMs?: number;
}

export class ComposioProjectKeyValidationError extends Error {
  readonly name = 'ComposioProjectKeyValidationError';
  constructor() {
    super('Composio project key is invalid or unavailable.');
  }
}

export class ComposioSetupInProgressError extends Error {
  readonly name = 'ComposioSetupInProgressError';
  constructor() {
    super('Composio connector setup is already in progress.');
  }
}

/** Validate a project key without returning or logging any upstream error text. */
export async function validateComposioProjectKey(
  value: string,
  options: Pick<ComposioSetupOptions, 'createClient' | 'signal'> = {},
): Promise<void> {
  const apiKey = normalizeApiKey(value);
  try {
    const client = await (options.createClient ?? createComposioClient)({ apiKey });
    if (!client.authConfigs) throw new Error('auth configs unavailable');
    const result = await client.authConfigs.list(
      { limit: 1, showDisabled: true },
      options.signal ? { signal: options.signal } : undefined,
    );
    assertAuthConfigList(result);
  } catch {
    options.signal?.throwIfAborted();
    throw new ComposioProjectKeyValidationError();
  }
}

/**
 * Prepare every curated connector against the currently resolved project.
 * Stored projects persist only safe IDs and status; deployment projects
 * keep their operator-provided IDs and receive transient defaults for gaps.
 */
export async function prepareResolvedComposioManagedAuthConfigs(
  options: ComposioSetupOptions = {},
): Promise<ComposioPreparationResult> {
  const settings = options.settings ?? getSettingsStore(options.env);
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(DEFAULT_SETUP_DEADLINE_MS)])
    : AbortSignal.timeout(DEFAULT_SETUP_DEADLINE_MS);
  signal.throwIfAborted();
  const resolved = await resolveComposioConfiguration({
    ...options,
    verifyLegacyAuthConfigIds: true,
  });
  if (!resolved.apiKey || resolved.desiredState !== 'enabled' ||
      resolved.reconciliationPending) {
    throw new ComposioProjectKeyValidationError();
  }
  return prepareWithLease({
    apiKey: resolved.apiKey,
    generation: resolved.generation,
    settings,
    existingAuthConfigIds: resolved.authConfigIds,
    preserveExisting: resolved.source === 'env',
    source: resolved.source,
    configurationOptions: options,
    ...(options.createClient ? { createClient: options.createClient } : {}),
    signal,
    ...(options.now ? { now: options.now } : {}),
    ...(options.createAttemptId ? { createAttemptId: options.createAttemptId } : {}),
    ...(options.leaseDurationMs !== undefined
      ? { leaseDurationMs: options.leaseDurationMs }
      : {}),
  });
}

async function prepareWithLease(input: {
  apiKey: string;
  generation: number;
  settings: SettingsStore;
  existingAuthConfigIds: ComposioAuthConfigIds;
  preserveExisting: boolean;
  source: 'env' | 'stored' | 'missing';
  configurationOptions: ComposioConfigurationOptions;
  createClient?: (input: { apiKey: string }) => Promise<ComposioClientLike>;
  signal?: AbortSignal;
  now?: () => number;
  createAttemptId?: () => string;
  leaseDurationMs?: number;
}): Promise<ComposioPreparationResult> {
  const now = input.now ?? Date.now;
  const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_SETUP_LEASE_MS;
  let lease = await acquireSetupLease({
    settings: input.settings,
    generation: input.generation,
    now,
    ...(input.createAttemptId ? { createAttemptId: input.createAttemptId } : {}),
    leaseDurationMs,
  });
  try {
    // Acquiring an expired lease never resumes from an old remote assumption:
    // preparation always relists every toolkit before any create call.
    const client = await (input.createClient ?? createComposioClient)({ apiKey: input.apiKey });
    if (!client.authConfigs) throw new ComposioProjectKeyValidationError();
    const result = await prepareAllToolkits({
      client,
      existingAuthConfigIds: input.existingAuthConfigIds,
      preserveExisting: input.preserveExisting,
      beforeCreate: async () => {
        lease = await renewSetupLease({
          settings: input.settings,
          lease,
          now,
          leaseDurationMs,
        });
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    input.signal?.throwIfAborted();
    lease = await renewSetupLease({
      settings: input.settings,
      lease,
      now,
      leaseDurationMs,
    });
    if (input.source === 'stored' || input.source === 'env') {
      await recordComposioPreparationResult({
        expectedGeneration: input.generation,
        authConfigIds: result.authConfigIds,
        status: result.status,
        issueCodes: result.issueCodes,
        completedAt: now(),
      }, input.configurationOptions);
    }
    return result;
  } finally {
    await releaseSetupLease(input.settings, lease);
  }
}

async function prepareAllToolkits(input: {
  client: ComposioClientLike;
  existingAuthConfigIds: ComposioAuthConfigIds;
  preserveExisting: boolean;
  beforeCreate: () => Promise<void>;
  signal?: AbortSignal;
}): Promise<ComposioPreparationResult> {
  const authConfigs = input.client.authConfigs;
  if (!authConfigs) throw new ComposioProjectKeyValidationError();
  const prepared: Record<string, Partial<Record<ManagedAccessLane, string>>> = {};
  const connectors: ComposioConnectorPreparationResult[] = [];
  const issueCodes: string[] = [];

  for (const connector of MANAGED_CONNECTOR_CATALOG.list()) {
    input.signal?.throwIfAborted();
    const lanes = requiredLanes(connector.toolkit);
    // Always seed from the last verified durable IDs so a transient failure for
    // one toolkit cannot erase that toolkit while the other toolkits refresh.
    const preserved = normalizeExistingLanes(input.existingAuthConfigIds[connector.toolkit], lanes);
    prepared[connector.toolkit] = preserved;
    const missingLanes = input.preserveExisting
      ? lanes.filter((lane) => !preserved[lane])
      : lanes;
    if (missingLanes.length === 0) {
      connectors.push({
        toolkit: connector.toolkit,
        status: 'ready',
        authConfigId: (preserved.write ?? preserved.read)!,
      });
      continue;
    }
    try {
      let matching = await listCompatibleConfigs(
        authConfigs,
        connector.toolkit,
        input.signal,
      );
      let selectedId = matching[0]?.id;
      const preservedId = preserved.write ?? preserved.read;
      if (matching.length === 0 && preservedId) {
        if (!authConfigs.get) throw new Error('existing auth config could not be verified');
        try {
          const existing = await authConfigs.get(
            preservedId,
            input.signal ? { signal: input.signal } : undefined,
          );
          if (isCompatibleDefault(existing, connector.toolkit)) {
            matching = [existing];
            selectedId = existing.id;
          }
        } catch (error) {
          if (providerErrorStatus(error) !== 404) throw error;
        }
      }
      if (matching.length === 0) {
        await input.beforeCreate();
        input.signal?.throwIfAborted();
        const created = await authConfigs.create(
          connector.toolkit,
          {
            type: 'use_composio_managed_auth',
            name: defaultAuthConfigName(connector.toolkit),
          },
          input.signal ? { signal: input.signal } : undefined,
        );
        if (isComposioAuthConfigId(created.id) && created.isComposioManaged === true &&
            created.toolkit.toLowerCase() === connector.toolkit) {
          selectedId = created.id;
        } else {
          matching = await listCompatibleConfigs(
            authConfigs,
            connector.toolkit,
            input.signal,
          );
          selectedId = matching[0]?.id;
        }
      }
      if (!isComposioAuthConfigId(selectedId)) {
        throw new Error('compatible auth config unavailable');
      }
      for (const lane of missingLanes) prepared[connector.toolkit]![lane] = selectedId;
      connectors.push({
        toolkit: connector.toolkit,
        status: 'ready',
        authConfigId: selectedId,
      });
    } catch (error) {
      if (error instanceof ComposioSetupInProgressError) throw error;
      input.signal?.throwIfAborted();
      const issueCode = `auth_config_prepare_failed.${connector.toolkit}`;
      issueCodes.push(issueCode);
      connectors.push({ toolkit: connector.toolkit, status: 'failed', issueCode });
    }
  }

  const readyCount = connectors.filter(({ status }) => status === 'ready').length;
  return {
    status: readyCount === connectors.length
      ? 'ready'
      : readyCount === 0 ? 'failed' : 'partial',
    authConfigIds: prepared,
    connectors,
    issueCodes,
  };
}

async function listCompatibleConfigs(
  authConfigs: NonNullable<ComposioClientLike['authConfigs']>,
  toolkit: string,
  signal: AbortSignal | undefined,
): Promise<ComposioAuthConfigLike[]> {
  const items: ComposioAuthConfigLike[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_AUTH_CONFIG_PAGES; page += 1) {
    const response = await authConfigs.list({
      toolkit,
      isComposioManaged: true,
      showDisabled: true,
      limit: AUTH_CONFIG_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    }, signal ? { signal } : undefined);
    assertAuthConfigList(response);
    items.push(...response.items);
    if (!response.nextCursor) break;
    cursor = response.nextCursor;
    if (page === MAX_AUTH_CONFIG_PAGES - 1) {
      throw new Error('auth config pagination exceeded');
    }
  }
  return items.filter((value) => isCompatibleDefault(value, toolkit)).sort(compareConfigs);
}

function isCompatibleDefault(value: ComposioAuthConfigLike, toolkit: string): boolean {
  return isComposioAuthConfigId(value.id) &&
    normalizedAuthConfigName(value.name) === normalizedAuthConfigName(defaultAuthConfigName(toolkit)) &&
    value.toolkit.slug.toLowerCase() === toolkit &&
    value.status === 'ENABLED' &&
    value.isComposioManaged === true &&
    isEmptyRecord(value.credentials) &&
    isEmptyArray(value.restrictToFollowingTools) &&
    isEmptyArray(value.toolAccessConfig?.toolsAvailableForExecution) &&
    isEmptyArray(value.toolAccessConfig?.toolsForConnectedAccountCreation);
}

function compareConfigs(left: ComposioAuthConfigLike, right: ComposioAuthConfigLike): number {
  const leftTime = safeTimestamp(left.createdAt);
  const rightTime = safeTimestamp(right.createdAt);
  return leftTime - rightTime || left.id.localeCompare(right.id);
}

function safeTimestamp(value: string | undefined): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function providerErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  const status = value.status ?? value.statusCode ?? value.response?.status;
  return typeof status === 'number' && Number.isSafeInteger(status) ? status : undefined;
}

function defaultAuthConfigName(toolkit: string): string {
  return `Chickpea default — ${toolkit} ${AUTH_CONFIG_NAME_SUFFIX}`;
}

function normalizedAuthConfigName(value: string): string {
  return value.normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function requiredLanes(toolkit: string): ManagedAccessLane[] {
  const connector = MANAGED_CONNECTOR_CATALOG.connector(toolkit);
  if (!connector) return [];
  const lanes = new Set(connector.capabilities.map(({ accessLane }) => accessLane));
  return lanes.has('write') ? ['read', 'write'] : ['read'];
}

function normalizeExistingLanes(
  value: Readonly<Partial<Record<ManagedAccessLane, string>>> | undefined,
  lanes: readonly ManagedAccessLane[],
): Partial<Record<ManagedAccessLane, string>> {
  const normalized: Partial<Record<ManagedAccessLane, string>> = {};
  for (const lane of lanes) {
    const id = value?.[lane];
    if (isComposioAuthConfigId(id)) normalized[lane] = id;
  }
  return normalized;
}

function assertAuthConfigList(value: {
  items: ComposioAuthConfigLike[];
  nextCursor: string | null;
  totalPages: number;
}): void {
  if (!value || !Array.isArray(value.items) ||
      value.nextCursor !== null && typeof value.nextCursor !== 'string' ||
      !Number.isFinite(value.totalPages)) {
    throw new Error('auth config list response was invalid');
  }
}

function isEmptyRecord(value: Record<string, unknown> | undefined): boolean {
  return value === undefined || Object.keys(value).length === 0;
}

function isEmptyArray(value: string[] | undefined): boolean {
  return value === undefined || value.length === 0;
}

async function acquireSetupLease(input: {
  settings: SettingsStore;
  generation: number;
  now: () => number;
  createAttemptId?: () => string;
  leaseDurationMs?: number;
}): Promise<{ raw: string; value: SetupLease }> {
  const attemptId = (input.createAttemptId ?? randomAttemptId)();
  const duration = input.leaseDurationMs ?? DEFAULT_SETUP_LEASE_MS;
  if (!LEASE_ID_PATTERN.test(attemptId) || !Number.isSafeInteger(duration) ||
      duration < 1_000 || duration > 10 * 60_000) {
    throw new Error('Composio setup lease is invalid');
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = await input.settings.getSetting(SETUP_LEASE_SETTING);
    const current = parseSetupLease(raw);
    const timestamp = input.now();
    if (current && current.expiresAt > timestamp) throw new ComposioSetupInProgressError();
    const value: SetupLease = {
      version: 1,
      attemptId,
      generation: input.generation,
      expiresAt: timestamp + duration,
    };
    const serialized = JSON.stringify(value);
    if (await input.settings.applySettingsPatch({
      expected: { key: SETUP_LEASE_SETTING, value: raw ?? null },
      set: [{ key: SETUP_LEASE_SETTING, value: serialized }],
    })) return { raw: serialized, value };
  }
  throw new ComposioSetupInProgressError();
}

async function releaseSetupLease(
  settings: SettingsStore,
  lease: { raw: string },
): Promise<void> {
  await settings.applySettingsPatch({
    expected: { key: SETUP_LEASE_SETTING, value: lease.raw },
    delete: [SETUP_LEASE_SETTING],
  });
}

async function renewSetupLease(input: {
  settings: SettingsStore;
  lease: { raw: string; value: SetupLease };
  now: () => number;
  leaseDurationMs: number;
}): Promise<{ raw: string; value: SetupLease }> {
  const raw = await input.settings.getSetting(SETUP_LEASE_SETTING);
  const current = parseSetupLease(raw);
  const timestamp = input.now();
  if (raw !== input.lease.raw || !current ||
      current.attemptId !== input.lease.value.attemptId ||
      current.generation !== input.lease.value.generation ||
      current.expiresAt <= timestamp) {
    throw new ComposioSetupInProgressError();
  }
  const value: SetupLease = {
    ...current,
    expiresAt: timestamp + input.leaseDurationMs,
  };
  const serialized = JSON.stringify(value);
  if (!await input.settings.applySettingsPatch({
    expected: { key: SETUP_LEASE_SETTING, value: raw },
    set: [{ key: SETUP_LEASE_SETTING, value: serialized }],
  })) {
    throw new ComposioSetupInProgressError();
  }
  return { raw: serialized, value };
}

function parseSetupLease(raw: string | undefined): SetupLease | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<SetupLease>;
    if (value.version !== 1 || !LEASE_ID_PATTERN.test(value.attemptId ?? '') ||
        !Number.isSafeInteger(value.generation) || (value.generation ?? 0) < 1 ||
        !Number.isSafeInteger(value.expiresAt) || (value.expiresAt ?? 0) < 1) {
      return undefined;
    }
    return value as SetupLease;
  } catch {
    return undefined;
  }
}

function randomAttemptId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

function normalizeApiKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 16_384) {
    throw new ComposioProjectKeyValidationError();
  }
  return normalized;
}
