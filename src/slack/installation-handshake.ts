import { createHmac } from 'node:crypto';

import { constantTimeEquals } from '../security/constant-time.ts';
import type { SettingsStore } from '../config/settings-store.ts';

export const MAX_PENDING_SLACK_CHALLENGE_BYTES = 1_048_576;
export const SLACK_REQUEST_FRESHNESS_MS = 5 * 60_000;
export const PENDING_SLACK_CHALLENGE_TTL_MS = 24 * 60 * 60_000;
export const SLACK_PENDING_ENVELOPE_SETTING = 'slack.pendingEnvelope';
const MAX_CHALLENGE_TEXT_LENGTH = 4_096;

export interface PendingSlackChallengeInput {
  rawBody: string;
  signature: string;
  timestamp: string;
}

export interface PendingSlackChallengeEnvelope extends PendingSlackChallengeInput {
  receivedAt: number;
  expiresAt: number;
}

export type RecordPendingSlackChallengeResult =
  | { accepted: true; challenge: string; expiresAt: number; appId?: string; teamId?: string }
  | {
      accepted: false;
      reason: 'oversized' | 'invalid_envelope' | 'stale_timestamp' | 'changed';
    };

export type VerifyPendingSlackChallengeResult =
  | { verified: true; purgeReceipt: string; appId?: string; teamId?: string }
  | {
      verified: false;
      reason: 'missing' | 'expired' | 'invalid_signature' | 'app_mismatch' |
        'workspace_mismatch';
    };

/** Retain the latest fresh URL-verification envelope until install finalization. */
export async function recordPendingSlackChallenge(
  store: SettingsStore,
  input: PendingSlackChallengeInput,
  options: { now?: number } = {},
): Promise<RecordPendingSlackChallengeResult> {
  if (new TextEncoder().encode(input.rawBody).byteLength > MAX_PENDING_SLACK_CHALLENGE_BYTES) {
    return { accepted: false, reason: 'oversized' };
  }
  const timestampSeconds = parseTimestamp(input.timestamp);
  const body = parseChallengeBody(input.rawBody);
  if (!body || !/^v0=[a-f0-9]{64}$/i.test(input.signature) || timestampSeconds === undefined) {
    return { accepted: false, reason: 'invalid_envelope' };
  }
  const now = options.now ?? Date.now();
  if (Math.abs(now - timestampSeconds * 1_000) > SLACK_REQUEST_FRESHNESS_MS) {
    return { accepted: false, reason: 'stale_timestamp' };
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await store.getSetting(SLACK_PENDING_ENVELOPE_SETTING);
    const existing = current ? parseStoredEnvelope(current) : undefined;
    if (existing && existing.expiresAt > now && sameEnvelope(existing, input)) {
      return acceptedChallenge(body, existing.expiresAt);
    }
    const envelope: PendingSlackChallengeEnvelope = {
      ...input,
      receivedAt: now,
      expiresAt: now + PENDING_SLACK_CHALLENGE_TTL_MS,
    };
    const applied = await store.applySettingsPatch({
      expected: { key: SLACK_PENDING_ENVELOPE_SETTING, value: current ?? null },
      set: [{ key: SLACK_PENDING_ENVELOPE_SETTING, value: JSON.stringify(envelope) }],
    });
    if (applied) return acceptedChallenge(body, envelope.expiresAt);
  }
  return { accepted: false, reason: 'changed' };
}

export async function readPendingSlackChallenge(
  store: SettingsStore,
  options: { now?: number } = {},
): Promise<PendingSlackChallengeEnvelope | undefined> {
  const raw = await store.getSetting(SLACK_PENDING_ENVELOPE_SETTING);
  if (!raw) return undefined;
  const envelope = parseStoredEnvelope(raw);
  if (!envelope || envelope.expiresAt <= (options.now ?? Date.now())) {
    await purgePendingSlackChallenge(store, raw);
    return undefined;
  }
  return envelope;
}

export async function verifyPendingSlackChallenge(
  store: SettingsStore,
  signingSecret: string,
  options: { now?: number; expectedAppId?: string; expectedTeamId?: string } = {},
): Promise<VerifyPendingSlackChallengeResult> {
  const raw = await store.getSetting(SLACK_PENDING_ENVELOPE_SETTING);
  if (!raw) return { verified: false, reason: 'missing' };
  const envelope = parseStoredEnvelope(raw);
  if (!envelope || envelope.expiresAt <= (options.now ?? Date.now())) {
    await purgePendingSlackChallenge(store, raw);
    return { verified: false, reason: 'expired' };
  }
  const expected = `v0=${createHmac('sha256', signingSecret)
    .update(`v0:${envelope.timestamp}:${envelope.rawBody}`)
    .digest('hex')}`;
  if (!constantTimeEquals(expected, envelope.signature)) {
    return { verified: false, reason: 'invalid_signature' };
  }
  const body = parseChallengeBody(envelope.rawBody);
  if (!body) {
    await purgePendingSlackChallenge(store, raw);
    return { verified: false, reason: 'expired' };
  }
  if (options.expectedAppId && body.appId && body.appId !== options.expectedAppId) {
    return { verified: false, reason: 'app_mismatch' };
  }
  if (options.expectedTeamId && body.teamId && body.teamId !== options.expectedTeamId) {
    return { verified: false, reason: 'workspace_mismatch' };
  }
  return {
    verified: true,
    purgeReceipt: raw,
    ...(body.appId ? { appId: body.appId } : {}),
    ...(body.teamId ? { teamId: body.teamId } : {}),
  };
}

export async function purgePendingSlackChallenge(
  store: SettingsStore,
  expectedEnvelope?: string,
): Promise<boolean> {
  if (expectedEnvelope === undefined) {
    await store.deleteSetting(SLACK_PENDING_ENVELOPE_SETTING);
    return true;
  }
  return store.applySettingsPatch({
    expected: { key: SLACK_PENDING_ENVELOPE_SETTING, value: expectedEnvelope },
    delete: [SLACK_PENDING_ENVELOPE_SETTING],
  });
}

function parseChallengeBody(rawBody: string): {
  challenge: string;
  appId?: string;
  teamId?: string;
} | undefined {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const body = parsed as Record<string, unknown>;
    if (body.type !== 'url_verification' || typeof body.challenge !== 'string' ||
        body.challenge.length === 0 || body.challenge.length > MAX_CHALLENGE_TEXT_LENGTH) {
      return undefined;
    }
    return {
      challenge: body.challenge,
      ...(typeof body.api_app_id === 'string' ? { appId: body.api_app_id } : {}),
      ...(typeof body.team_id === 'string' ? { teamId: body.team_id } : {}),
    };
  } catch {
    return undefined;
  }
}

function parseStoredEnvelope(raw: string): PendingSlackChallengeEnvelope | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<PendingSlackChallengeEnvelope>;
    if (typeof parsed.rawBody !== 'string' || typeof parsed.signature !== 'string' ||
        typeof parsed.timestamp !== 'string' || typeof parsed.receivedAt !== 'number' ||
        typeof parsed.expiresAt !== 'number') return undefined;
    return parsed as PendingSlackChallengeEnvelope;
  } catch {
    return undefined;
  }
}

function parseTimestamp(value: string): number | undefined {
  if (!/^\d{1,12}$/.test(value)) return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : undefined;
}

function sameEnvelope(
  existing: PendingSlackChallengeEnvelope,
  input: PendingSlackChallengeInput,
): boolean {
  return existing.rawBody === input.rawBody && existing.signature === input.signature &&
    existing.timestamp === input.timestamp;
}

function acceptedChallenge(
  body: { challenge: string; appId?: string; teamId?: string },
  expiresAt: number,
): RecordPendingSlackChallengeResult {
  return {
    accepted: true,
    challenge: body.challenge,
    expiresAt,
    ...(body.appId ? { appId: body.appId } : {}),
    ...(body.teamId ? { teamId: body.teamId } : {}),
  };
}
