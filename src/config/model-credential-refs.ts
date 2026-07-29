import { randomUUID } from 'node:crypto';

import type { ProviderKeyId } from './provider-keys.ts';
import type { SettingsStore } from './settings-store.ts';
import { getSettingsStore, getUsageStore, type PlatformEnv } from './state-backend.ts';
import type { ModelCredentialAttribution } from './types.ts';
import type { UsageStore } from '../usage/types.ts';
import {
  hasCredentialLikeContent,
  hasDisallowedControlCharacter,
} from '../security/content-validation.ts';

const ENV_KEY_NAMES: Record<ProviderKeyId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

const ENV_PREFIXES: Record<ProviderKeyId, string> = {
  anthropic: 'ANTHROPIC',
  openai: 'OPENAI',
  openrouter: 'OPENROUTER',
};

const BUILTIN_PROVIDERS = new Set<ProviderKeyId>(['anthropic', 'openai', 'openrouter']);

export interface StoredCredentialMetadata {
  credentialRefId: string;
  version: number;
  active: boolean;
  activeFrom: number;
}

interface ResolveCredentialOptions {
  processEnv?: NodeJS.ProcessEnv;
  now?: () => number;
}

export async function resolveModelCredentialAttribution(
  modelSpecifier: string,
  platformEnv?: PlatformEnv,
  settingsStore?: SettingsStore,
  usageStore?: UsageStore,
  options: ResolveCredentialOptions = {},
): Promise<ModelCredentialAttribution | null> {
  const providerId = providerPrefix(modelSpecifier);
  const processEnv = options.processEnv ?? process.env;
  const now = options.now ?? Date.now;
  const settings = settingsStore ?? getSettingsStore(platformEnv);
  const usage = usageStore ?? getUsageStore(platformEnv);

  if (BUILTIN_PROVIDERS.has(providerId as ProviderKeyId)) {
    const id = providerId as ProviderKeyId;
    if (nonEmpty(processEnv[ENV_KEY_NAMES[id]])) {
      const prefix = ENV_PREFIXES[id];
      return registerCredential(usage, {
        credentialRefId: `cred_${id}_environment`,
        version: positiveEpoch(processEnv[`${prefix}_CREDENTIAL_EPOCH`]) ?? 1,
        providerId: id,
        sourceKind: 'environment',
        label: safeLabel(
          processEnv[`${prefix}_CREDENTIAL_ALIAS`],
          'Environment credential',
        ),
        scopeLabel: environmentScope(id, processEnv),
        unknownRotation: positiveEpoch(processEnv[`${prefix}_CREDENTIAL_EPOCH`]) === null,
        activeFrom: 0,
      });
    }
    const apiKey = await settings.getSetting(providerApiKeySetting(id));
    if (!nonEmpty(apiKey)) return null;
    const metadata = await ensureStoredCredentialMetadata(id, settings, now);
    if (!metadata.active) return null;
    return registerCredential(usage, {
      credentialRefId: metadata.credentialRefId,
      version: metadata.version,
      providerId: id,
      sourceKind: 'stored',
      label: `Stored ${providerDisplayName(id)} credential`,
      scopeLabel: null,
      unknownRotation: false,
      activeFrom: metadata.activeFrom,
    });
  }

  if (providerId === 'cloudflare-workers-ai') {
    if (!nonEmpty(processEnv.CLOUDFLARE_API_TOKEN) || !nonEmpty(processEnv.CLOUDFLARE_ACCOUNT_ID)) {
      return null;
    }
    const epoch = positiveEpoch(processEnv.CLOUDFLARE_WORKERS_AI_CREDENTIAL_EPOCH);
    return registerCredential(usage, {
      credentialRefId: 'cred_cloudflare-workers-ai_environment',
      version: epoch ?? 1,
      providerId,
      sourceKind: 'environment',
      label: safeLabel(
        processEnv.CLOUDFLARE_WORKERS_AI_CREDENTIAL_ALIAS,
        'Workers AI API token',
      ),
      scopeLabel: `Cloudflare account ${processEnv.CLOUDFLARE_ACCOUNT_ID}`,
      unknownRotation: epoch === null,
      activeFrom: 0,
    });
  }

  if (providerId === 'cloudflare' && hasWorkersAiBinding(platformEnv)) {
    const epoch = positiveEpoch(processEnv.CHICKPEA_DEPLOYMENT_EPOCH);
    return registerCredential(usage, {
      credentialRefId: 'cred_cloudflare_binding',
      version: epoch ?? 1,
      providerId,
      sourceKind: 'cloudflare_binding',
      label: safeLabel(processEnv.CLOUDFLARE_AI_BINDING_ALIAS, 'Workers AI binding'),
      scopeLabel: null,
      unknownRotation: epoch === null,
      activeFrom: 0,
    });
  }

  return registerCredential(usage, {
    credentialRefId: `cred_${safeProviderId(providerId)}_custom`,
    version: 1,
    providerId: safeProviderId(providerId),
    sourceKind: 'custom',
    label: 'Custom provider route',
    scopeLabel: null,
    unknownRotation: true,
    activeFrom: 0,
  });
}

export async function rotateStoredModelCredential(
  id: ProviderKeyId,
  action: { kind: 'save'; apiKey: string } | { kind: 'delete' },
  settings: SettingsStore,
  usage: UsageStore,
  now: () => number = Date.now,
): Promise<StoredCredentialMetadata> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await storedCredentialMetadata(id, settings);
    const timestamp = now();
    const next: StoredCredentialMetadata = {
      credentialRefId: current?.credentialRefId ?? `cred_${id}_${randomUUID()}`,
      version: (current?.version ?? 0) + 1,
      active: action.kind === 'save',
      activeFrom: timestamp,
    };
    if (current?.active) {
      await usage.putCredential({
        credentialRefId: current.credentialRefId,
        version: current.version,
        providerId: id,
        sourceKind: 'stored',
        label: `Stored ${providerDisplayName(id)} credential`,
        scopeLabel: null,
        unknownRotation: false,
        activeFrom: current.activeFrom,
      });
    }
    const applied = await settings.applySettingsPatch({
      expected: {
        key: credentialVersionSetting(id),
        value: current ? String(current.version) : null,
      },
      set: [
        ...(action.kind === 'save'
          ? [{ key: providerApiKeySetting(id), value: action.apiKey }]
          : []),
        { key: credentialRefSetting(id), value: next.credentialRefId },
        { key: credentialVersionSetting(id), value: String(next.version) },
        { key: credentialActiveSetting(id), value: String(next.active) },
        { key: credentialActiveFromSetting(id), value: String(next.activeFrom) },
      ],
      ...(action.kind === 'delete' ? { delete: [providerApiKeySetting(id)] } : {}),
    });
    if (!applied) continue;
    if (current?.active) {
      await usage.retireCredential(current.credentialRefId, current.version, timestamp);
    }
    if (next.active) {
      await usage.putCredential({
        credentialRefId: next.credentialRefId,
        version: next.version,
        providerId: id,
        sourceKind: 'stored',
        label: `Stored ${providerDisplayName(id)} credential`,
        scopeLabel: null,
        unknownRotation: false,
        activeFrom: next.activeFrom,
      });
    }
    return next;
  }
  throw new Error('Provider credential metadata changed concurrently.');
}

export async function storedCredentialMetadata(
  id: ProviderKeyId,
  settings: SettingsStore,
): Promise<StoredCredentialMetadata | null> {
  const [ref, versionRaw, activeRaw, activeFromRaw] = await settings.getSettings([
    credentialRefSetting(id),
    credentialVersionSetting(id),
    credentialActiveSetting(id),
    credentialActiveFromSetting(id),
  ]);
  const version = positiveEpoch(versionRaw);
  const activeFrom = nonNegativeInteger(activeFromRaw);
  if (!ref || version === null || activeFrom === null) return null;
  return {
    credentialRefId: ref,
    version,
    active: activeRaw === 'true',
    activeFrom,
  };
}

async function ensureStoredCredentialMetadata(
  id: ProviderKeyId,
  settings: SettingsStore,
  now: () => number,
): Promise<StoredCredentialMetadata> {
  const existing = await storedCredentialMetadata(id, settings);
  if (existing) return existing;
  const created: StoredCredentialMetadata = {
    credentialRefId: `cred_${id}_${randomUUID()}`,
    version: 1,
    active: true,
    activeFrom: now(),
  };
  const applied = await settings.applySettingsPatch({
    expected: { key: credentialVersionSetting(id), value: null },
    set: [
      { key: credentialRefSetting(id), value: created.credentialRefId },
      { key: credentialVersionSetting(id), value: '1' },
      { key: credentialActiveSetting(id), value: 'true' },
      { key: credentialActiveFromSetting(id), value: String(created.activeFrom) },
    ],
  });
  if (applied) return created;
  const raced = await storedCredentialMetadata(id, settings);
  if (!raced) throw new Error('Provider credential metadata did not materialize.');
  return raced;
}

async function registerCredential(
  store: UsageStore,
  input: Parameters<UsageStore['putCredential']>[0],
): Promise<ModelCredentialAttribution> {
  let row = input;
  try {
    row = await store.putCredential(input);
  } catch {
    // Credential registration enriches reporting. It must never make model work
    // unavailable when the telemetry store is slow or temporarily unhealthy.
    console.warn('[usage] credential registry write failed; model execution will continue');
  }
  return {
    credentialRefId: row.credentialRefId,
    version: row.version,
    providerId: row.providerId,
    sourceKind: row.sourceKind,
    label: row.label,
    scopeLabel: row.scopeLabel,
    unknownRotation: row.unknownRotation,
  };
}

function providerPrefix(modelSpecifier: string): string {
  const slash = modelSpecifier.indexOf('/');
  return slash > 0 ? modelSpecifier.slice(0, slash) : modelSpecifier;
}

function providerApiKeySetting(id: ProviderKeyId): string {
  return `provider.${id}.apiKey`;
}

function credentialRefSetting(id: ProviderKeyId): string {
  return `provider.${id}.credentialRefId`;
}

function credentialVersionSetting(id: ProviderKeyId): string {
  return `provider.${id}.credentialVersion`;
}

function credentialActiveSetting(id: ProviderKeyId): string {
  return `provider.${id}.credentialActive`;
}

function credentialActiveFromSetting(id: ProviderKeyId): string {
  return `provider.${id}.credentialActiveFrom`;
}

function environmentScope(id: ProviderKeyId, env: NodeJS.ProcessEnv): string | null {
  if (id === 'openai') return nonEmpty(env.OPENAI_PROJECT_ID) ?? null;
  if (id === 'anthropic') return nonEmpty(env.ANTHROPIC_WORKSPACE_ID) ?? null;
  return null;
}

function providerDisplayName(id: ProviderKeyId): string {
  return id === 'openai' ? 'OpenAI' : id === 'openrouter' ? 'OpenRouter' : 'Anthropic';
}

function hasWorkersAiBinding(env: PlatformEnv | undefined): boolean {
  const binding = env?.AI;
  return Boolean(binding && typeof binding === 'object');
}

function safeProviderId(providerId: string): string {
  const normalized = providerId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 80);
  return normalized || 'custom';
}

function positiveEpoch(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function safeLabel(value: string | undefined, fallback: string): string {
  const candidate = nonEmpty(value);
  if (
    !candidate ||
    new TextEncoder().encode(candidate).byteLength > 160 ||
    hasDisallowedControlCharacter(candidate) ||
    hasCredentialLikeContent(candidate)
  ) {
    return fallback;
  }
  return candidate;
}
