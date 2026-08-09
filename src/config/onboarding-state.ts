import type { SettingsStore } from './settings-store.ts';

export const ONBOARDING_JOURNEY_KEY = 'onboarding.journey.v1';

export interface OnboardingJourney {
  version: 1;
  state: 'active' | 'complete';
  startedAt: number;
  selectedWorkspaceId?: string;
  selectedChannelId?: string;
  selectedChannelName?: string;
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
  const journey: OnboardingJourney = { version: 1, state: 'active', startedAt: validTime(startedAt) };
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

export async function startOnboardingTry(
  settings: SettingsStore,
  input: {
    expectedRevision: string;
    workspaceId: string;
    channelId: string;
    channelName: string;
    tryStartedAt?: number;
  },
): Promise<OnboardingSnapshot> {
  const current = parseOnboardingJourney(input.expectedRevision);
  if (current.state !== 'active') return { journey: current, revision: input.expectedRevision };
  const journey: OnboardingJourney = {
    ...current,
    selectedWorkspaceId: slackId(input.workspaceId, 'workspaceId'),
    selectedChannelId: slackId(input.channelId, 'channelId'),
    selectedChannelName: channelName(input.channelName),
    tryStartedAt: validTime(input.tryStartedAt ?? Date.now()),
  };
  return writeJourney(settings, input.expectedRevision, journey);
}

export async function completeOnboardingJourney(
  settings: SettingsStore,
  expectedRevision: string,
  completedAt: number = Date.now(),
): Promise<OnboardingSnapshot> {
  const current = parseOnboardingJourney(expectedRevision);
  if (current.state === 'complete') return { journey: current, revision: expectedRevision };
  if (!current.selectedWorkspaceId || !current.selectedChannelId || !current.tryStartedAt) {
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
  if (!isRecord(value) || value.version !== 1 ||
      !['active', 'complete'].includes(String(value.state)) ||
      !isTime(value.startedAt)) throw new Error('Stored onboarding journey is invalid.');
  const journey: OnboardingJourney = {
    version: 1,
    state: value.state as OnboardingJourney['state'],
    startedAt: value.startedAt,
    ...(typeof value.selectedWorkspaceId === 'string'
      ? { selectedWorkspaceId: slackId(value.selectedWorkspaceId, 'workspaceId') }
      : {}),
    ...(typeof value.selectedChannelId === 'string'
      ? { selectedChannelId: slackId(value.selectedChannelId, 'channelId') }
      : {}),
    ...(typeof value.selectedChannelName === 'string'
      ? { selectedChannelName: channelName(value.selectedChannelName) }
      : {}),
    ...(isTime(value.tryStartedAt) ? { tryStartedAt: value.tryStartedAt } : {}),
    ...(isTime(value.completedAt) ? { completedAt: value.completedAt } : {}),
  };
  const selected = Boolean(journey.selectedWorkspaceId && journey.selectedChannelId &&
    journey.selectedChannelName && journey.tryStartedAt);
  if (Boolean(journey.selectedWorkspaceId || journey.selectedChannelId ||
      journey.selectedChannelName || journey.tryStartedAt) !== selected ||
      (journey.state === 'complete' && (!selected || !journey.completedAt))) {
    throw new Error('Stored onboarding journey is invalid.');
  }
  return journey;
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
