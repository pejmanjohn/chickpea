import { createHmac } from 'node:crypto';

import { constantTimeEquals } from '../admin/constant-time.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { SlackIdentity } from '../config/types.ts';
import {
  clearSlackIdentityCredentials,
  slackIdentityCredentialSettingKeys,
} from './identity-credentials.ts';

export const MAX_PENDING_SLACK_CHALLENGE_BYTES = 1_048_576;
export const PENDING_SLACK_CHALLENGE_TTL_MS = 5 * 60_000;
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
  | { accepted: true; challenge: string; expiresAt: number }
  | {
      accepted: false;
      reason:
        | 'identity_not_pending'
        | 'oversized'
        | 'invalid_envelope'
        | 'stale_timestamp'
        | 'rate_limited'
        | 'changed';
    };

export type VerifyPendingSlackChallengeResult =
  | { verified: true; purgeReceipt: string }
  | { verified: false; reason: 'missing' | 'expired' | 'invalid_signature' };

export function slackIdentityPendingEnvelopeSettingKey(identityId: string): string {
  const revisionKey = slackIdentityCredentialSettingKeys(identityId).connectionRevision;
  return revisionKey.replace(/\.connectionRevision$/, '.pendingEnvelope');
}

/** Store one structurally valid, signed-header-bearing challenge for <=5 min. */
export async function recordPendingSlackChallenge(
  store: SettingsStore,
  identity: SlackIdentity,
  input: PendingSlackChallengeInput,
  options: { now?: number } = {},
): Promise<RecordPendingSlackChallengeResult> {
  if (
    identity.kind !== 'dedicated' ||
    (identity.lifecycle !== 'setup_incomplete' &&
      identity.lifecycle !== 'credentials_pending')
  ) {
    return { accepted: false, reason: 'identity_not_pending' };
  }
  if (new TextEncoder().encode(input.rawBody).byteLength > MAX_PENDING_SLACK_CHALLENGE_BYTES) {
    return { accepted: false, reason: 'oversized' };
  }
  const timestampSeconds = parseTimestamp(input.timestamp);
  const body = parseChallengeBody(input.rawBody);
  if (!body || !/^v0=[a-f0-9]{64}$/i.test(input.signature) || timestampSeconds === undefined) {
    return { accepted: false, reason: 'invalid_envelope' };
  }

  const now = options.now ?? Date.now();
  if (Math.abs(now - timestampSeconds * 1_000) > PENDING_SLACK_CHALLENGE_TTL_MS) {
    return { accepted: false, reason: 'stale_timestamp' };
  }

  const key = slackIdentityPendingEnvelopeSettingKey(identity.id);
  const current = await store.getSetting(key);
  if (current) {
    const existing = parseStoredEnvelope(current);
    if (existing && existing.expiresAt > now) {
      return { accepted: false, reason: 'rate_limited' };
    }
  }

  const envelope: PendingSlackChallengeEnvelope = {
    ...input,
    receivedAt: now,
    expiresAt: now + PENDING_SLACK_CHALLENGE_TTL_MS,
  };
  const applied = await store.applySettingsPatch({
    expected: { key, value: current ?? null },
    set: [{ key, value: JSON.stringify(envelope) }],
  });
  return applied
    ? { accepted: true, challenge: body.challenge, expiresAt: envelope.expiresAt }
    : { accepted: false, reason: 'changed' };
}

export async function readPendingSlackChallenge(
  store: SettingsStore,
  identityId: string,
  options: { now?: number } = {},
): Promise<PendingSlackChallengeEnvelope | undefined> {
  const key = slackIdentityPendingEnvelopeSettingKey(identityId);
  const raw = await store.getSetting(key);
  if (!raw) return undefined;
  const envelope = parseStoredEnvelope(raw);
  const now = options.now ?? Date.now();
  if (!envelope || envelope.expiresAt <= now) {
    await purgePendingSlackChallenge(store, identityId, raw);
    return undefined;
  }
  return envelope;
}

/** Verify the recorded raw body. A valid envelope remains available until the
 * caller commits dependent metadata, then uses the exact receipt to CAS-delete
 * it. Invalid and expired envelopes are purged immediately. */
export async function verifyPendingSlackChallenge(
  store: SettingsStore,
  identityId: string,
  signingSecret: string,
  options: { now?: number } = {},
): Promise<VerifyPendingSlackChallengeResult> {
  const key = slackIdentityPendingEnvelopeSettingKey(identityId);
  const raw = await store.getSetting(key);
  if (!raw) return { verified: false, reason: 'missing' };
  const envelope = parseStoredEnvelope(raw);
  const now = options.now ?? Date.now();
  if (!envelope || envelope.expiresAt <= now) {
    await purgePendingSlackChallenge(store, identityId, raw);
    return { verified: false, reason: 'expired' };
  }

  const expected = `v0=${createHmac('sha256', signingSecret)
    .update(`v0:${envelope.timestamp}:${envelope.rawBody}`)
    .digest('hex')}`;
  const verified = constantTimeEquals(expected, envelope.signature);
  if (verified) return { verified: true, purgeReceipt: raw };
  await purgePendingSlackChallenge(store, identityId, raw);
  return { verified: false, reason: 'invalid_signature' };
}

export async function purgePendingSlackChallenge(
  store: SettingsStore,
  identityId: string,
  expectedEnvelope?: string,
): Promise<boolean> {
  const key = slackIdentityPendingEnvelopeSettingKey(identityId);
  if (expectedEnvelope === undefined) {
    await store.deleteSetting(key);
    return true;
  }
  return store.applySettingsPatch({
    expected: { key, value: expectedEnvelope },
    delete: [key],
  });
}

/** One settings transaction erases credentials and the pending raw envelope. */
export async function cancelPendingSlackIdentitySecrets(
  store: SettingsStore,
  identityId: string,
  expectedCredentialRevision: string | null,
): Promise<string> {
  return clearSlackIdentityCredentials(
    store,
    identityId,
    expectedCredentialRevision,
    [slackIdentityPendingEnvelopeSettingKey(identityId)],
  );
}

function parseChallengeBody(rawBody: string): { challenge: string } | undefined {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const body = parsed as Record<string, unknown>;
    if (
      body.type !== 'url_verification' ||
      typeof body.challenge !== 'string' ||
      body.challenge.length === 0 ||
      body.challenge.length > MAX_CHALLENGE_TEXT_LENGTH
    ) {
      return undefined;
    }
    return { challenge: body.challenge };
  } catch {
    return undefined;
  }
}

function parseStoredEnvelope(raw: string): PendingSlackChallengeEnvelope | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<PendingSlackChallengeEnvelope>;
    if (
      typeof parsed.rawBody !== 'string' ||
      typeof parsed.signature !== 'string' ||
      typeof parsed.timestamp !== 'string' ||
      !Number.isSafeInteger(parsed.receivedAt) ||
      !Number.isSafeInteger(parsed.expiresAt) ||
      !parseChallengeBody(parsed.rawBody)
    ) {
      return undefined;
    }
    return parsed as PendingSlackChallengeEnvelope;
  } catch {
    return undefined;
  }
}

function parseTimestamp(value: string): number | undefined {
  if (!/^\d{1,12}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
