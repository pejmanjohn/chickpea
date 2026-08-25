import type { SettingsStore } from './settings-store.ts';
import { modelBelongsToProvider as providerOwnsModel } from './provider-impact.ts';

export const ONBOARDING_JOURNEY_KEY = 'onboarding.journey.v2';

export const ONBOARDING_PROVIDER_IDS = [
  'cloudflare',
  'anthropic',
  'openai',
  'openrouter',
] as const;

export type OnboardingProviderId = (typeof ONBOARDING_PROVIDER_IDS)[number];

export interface OnboardingJourney {
  version: 2;
  state: 'active' | 'complete';
  startedAt: number;
  agentId?: string;
  selectedWorkspaceId?: string;
  selectedChannelId?: string;
  selectedChannelName?: string;
  selectedProviderId?: OnboardingProviderId;
  selectedModelId?: string;
  trySlackUserId?: string;
  tryStartedAt?: number;
  completedAt?: number;
}

export interface OnboardingSnapshot {
  journey: OnboardingJourney;
  revision: string;
}

export async function readOnboardingJourney(
  settings: SettingsStore,
): Promise<OnboardingSnapshot | undefined> {
  const raw = await settings.getSetting(ONBOARDING_JOURNEY_KEY);
  if (raw === undefined) return undefined;
  return { journey: parseOnboardingJourney(raw), revision: raw };
}

export async function beginOnboardingJourney(
  settings: SettingsStore,
  startedAt: number = Date.now(),
): Promise<OnboardingSnapshot> {
  const existing = await readOnboardingJourney(settings);
  if (existing) return existing;
  const journey: OnboardingJourney = { version: 2, state: 'active', startedAt: validTime(startedAt) };
  const revision = JSON.stringify(journey);
  const created = await settings.applySettingsPatch({
    expected: { key: ONBOARDING_JOURNEY_KEY, value: null },
    set: [{ key: ONBOARDING_JOURNEY_KEY, value: revision }],
  });
  if (created) return { journey, revision };
  const raced = await readOnboardingJourney(settings);
  if (!raced) throw new Error('Onboarding journey changed concurrently.');
  return raced;
}

export async function selectOnboardingProvider(
  settings: SettingsStore,
  input: {
    expectedRevision: string;
    workspaceId: string;
    providerId: OnboardingProviderId;
  },
): Promise<OnboardingSnapshot> {
  const current = parseOnboardingJourney(input.expectedRevision);
  if (current.state !== 'active') return { journey: current, revision: input.expectedRevision };
  const journey: OnboardingJourney = {
    ...current,
    selectedWorkspaceId: slackId(input.workspaceId, 'workspaceId'),
    selectedProviderId: providerId(input.providerId),
  };
  delete journey.agentId;
  delete journey.selectedChannelId;
  delete journey.selectedChannelName;
  delete journey.selectedModelId;
  delete journey.trySlackUserId;
  delete journey.tryStartedAt;
  delete journey.completedAt;
  return writeJourney(settings, input.expectedRevision, journey);
}

export async function startOnboardingTry(
  settings: SettingsStore,
  input: {
    expectedRevision: string;
    agentId: string;
    modelId: string;
    slackUserId: string;
    tryStartedAt?: number;
  },
): Promise<OnboardingSnapshot> {
  const current = parseOnboardingJourney(input.expectedRevision);
  if (current.state !== 'active') return { journey: current, revision: input.expectedRevision };
  if (!current.selectedWorkspaceId || !current.selectedProviderId) {
    throw new Error('Onboarding cannot start Try before choosing a provider.');
  }
  const selectedModelId = modelId(input.modelId, current.selectedProviderId);
  return writeJourney(settings, input.expectedRevision, {
    ...current,
    agentId: agentId(input.agentId),
    selectedModelId,
    trySlackUserId: slackId(input.slackUserId, 'slackUserId'),
    tryStartedAt: validTime(input.tryStartedAt ?? Date.now()),
  });
}

export async function completeOnboardingJourney(
  settings: SettingsStore,
  expectedRevision: string,
  completedAt: number = Date.now(),
): Promise<OnboardingSnapshot> {
  const current = parseOnboardingJourney(expectedRevision);
  if (current.state === 'complete') return { journey: current, revision: expectedRevision };
  if (!current.agentId || !current.selectedWorkspaceId || !current.tryStartedAt) {
    throw new Error('Onboarding cannot complete before Try begins.');
  }
  return writeJourney(settings, expectedRevision, {
    ...current,
    state: 'complete',
    completedAt: validTime(completedAt),
  });
}

export function parseOnboardingJourney(raw: string): OnboardingJourney {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Stored onboarding journey is invalid.');
  }
  if (!isRecord(value) || value.version !== 2 ||
      !['active', 'complete'].includes(String(value.state)) ||
      !isTime(value.startedAt)) throw new Error('Stored onboarding journey is invalid.');
  const hasRawProvider = typeof value.selectedProviderId === 'string';
  const hasRawModel = typeof value.selectedModelId === 'string';
  if (hasRawModel && !hasRawProvider) throw new Error('Stored onboarding journey is invalid.');
  const journey: OnboardingJourney = {
    version: 2,
    state: value.state as OnboardingJourney['state'],
    startedAt: value.startedAt,
    ...(typeof value.agentId === 'string' ? { agentId: agentId(value.agentId) } : {}),
    ...(typeof value.selectedWorkspaceId === 'string'
      ? { selectedWorkspaceId: slackId(value.selectedWorkspaceId, 'workspaceId') }
      : {}),
    ...(typeof value.selectedChannelId === 'string'
      ? { selectedChannelId: slackId(value.selectedChannelId, 'channelId') }
      : {}),
    ...(typeof value.selectedChannelName === 'string'
      ? { selectedChannelName: channelName(value.selectedChannelName) }
      : {}),
    ...(hasRawProvider
      ? { selectedProviderId: providerId(String(value.selectedProviderId)) }
      : {}),
    ...(hasRawModel && hasRawProvider
      ? {
          selectedModelId: modelId(
            String(value.selectedModelId),
            providerId(String(value.selectedProviderId)),
          ),
        }
      : {}),
    ...(typeof value.trySlackUserId === 'string'
      ? { trySlackUserId: slackId(value.trySlackUserId, 'slackUserId') }
      : {}),
    ...(isTime(value.tryStartedAt) ? { tryStartedAt: value.tryStartedAt } : {}),
    ...(isTime(value.completedAt) ? { completedAt: value.completedAt } : {}),
  };
  const hasAnyChannel = Boolean(journey.selectedChannelId || journey.selectedChannelName);
  const hasChannel = hasSelectedChannel(journey);
  const hasAnyNewSelection = Boolean(journey.selectedProviderId || journey.selectedModelId);
  const newSelectionValid = !hasAnyNewSelection || Boolean(
    journey.selectedWorkspaceId && journey.selectedProviderId &&
    (!journey.selectedModelId || providerOwnsModel(
      journey.selectedModelId,
      runtimeProviderId(journey.selectedProviderId),
    )),
  );
  const dmTryValid = Boolean(
    journey.agentId && journey.selectedWorkspaceId && journey.selectedProviderId &&
    journey.selectedModelId && journey.trySlackUserId,
  );
  const tryValid = !journey.tryStartedAt || hasChannel || dmTryValid;
  if (hasAnyChannel !== hasChannel || !newSelectionValid || !tryValid ||
      (journey.selectedModelId && !journey.tryStartedAt) ||
      (journey.state === 'complete' && (!journey.tryStartedAt || !journey.completedAt))) {
    throw new Error('Stored onboarding journey is invalid.');
  }
  return journey;
}

function hasSelectedChannel(journey: OnboardingJourney): boolean {
  return Boolean(
    journey.agentId && journey.selectedWorkspaceId && journey.selectedChannelId && journey.selectedChannelName,
  );
}

function providerId(value: string): OnboardingProviderId {
  if (!(ONBOARDING_PROVIDER_IDS as readonly string[]).includes(value)) {
    throw new Error('providerId is invalid.');
  }
  return value as OnboardingProviderId;
}

function modelId(value: string, provider: OnboardingProviderId): string {
  const normalized = value.trim();
  if (!/^[^/]+\/.+$/.test(normalized) ||
      !providerOwnsModel(normalized, runtimeProviderId(provider))) {
    throw new Error('modelId is invalid.');
  }
  return normalized;
}

function runtimeProviderId(provider: OnboardingProviderId): string {
  return provider === 'cloudflare' ? 'workers-ai' : provider;
}

function agentId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error('agentId is invalid.');
  }
  return normalized;
}

async function writeJourney(
  settings: SettingsStore,
  expectedRevision: string,
  journey: OnboardingJourney,
): Promise<OnboardingSnapshot> {
  const revision = JSON.stringify(journey);
  const updated = await settings.applySettingsPatch({
    expected: { key: ONBOARDING_JOURNEY_KEY, value: expectedRevision },
    set: [{ key: ONBOARDING_JOURNEY_KEY, value: revision }],
  });
  if (!updated) throw new Error('Onboarding journey changed concurrently.');
  return { journey, revision };
}

function validTime(value: number): number {
  if (!isTime(value)) throw new Error('Onboarding time is invalid.');
  return value;
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function slackId(value: string, field: string): string {
  const normalized = value.trim();
  if (!/^[A-Z0-9]{2,32}$/i.test(normalized)) throw new Error(`${field} is invalid.`);
  return normalized;
}

function channelName(value: string): string {
  const normalized = value.trim().replace(/^#/, '');
  if (!normalized || normalized.length > 80 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('channelName is invalid.');
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
