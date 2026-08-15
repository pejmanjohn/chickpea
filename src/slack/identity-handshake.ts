import { createHmac } from 'node:crypto';

import { constantTimeEquals } from '../admin/constant-time.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import {
  WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
  type SlackIdentity,
} from '../config/types.ts';
import {
  clearSlackIdentityCredentials,
  slackIdentityPendingMetadataSettingKey,
  type SlackCredentialDependencies,
} from './identity-credentials.ts';

export const MAX_PENDING_SLACK_CHALLENGE_BYTES = 1_048_576;
/** Slack requests must be current when they reach ingress. */
export const SLACK_REQUEST_FRESHNESS_MS = 5 * 60_000;
/** The verified-at-ingress envelope remains available during human setup. */
export const PENDING_SLACK_CHALLENGE_TTL_MS = 24 * 60 * 60_000;
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
  | {
      accepted: true;
      challenge: string;
      expiresAt: number;
      appId?: string;
      teamId?: string;
    }
  | {
      accepted: false;
      reason:
        | 'identity_not_pending'
        | 'oversized'
        | 'invalid_envelope'
        | 'stale_timestamp'
        | 'changed';
    };

export type VerifyPendingSlackChallengeResult =
  | {
      verified: true;
      purgeReceipt: string;
      appId?: string;
      teamId?: string;
    }
  | {
      verified: false;
      reason:
        | 'missing'
        | 'expired'
        | 'invalid_signature'
        | 'app_mismatch'
        | 'workspace_mismatch';
    };

export function slackIdentityPendingEnvelopeSettingKey(identityId: string): string {
  if (identityId === WORKSPACE_DEFAULT_SLACK_IDENTITY_ID) {
    return 'slack.pendingEnvelope';
  }
  return slackIdentityPendingMetadataSettingKey(identityId);
}

/** Store one fresh, structurally valid, signed-header-bearing challenge for <=24h. */
export async function recordPendingSlackChallenge(
  store: SettingsStore,
  identity: SlackIdentity,
  input: PendingSlackChallengeInput,
  options: { now?: number } = {},
): Promise<RecordPendingSlackChallengeResult> {
  if (
    identity.lifecycle !== 'setup_incomplete' &&
    identity.lifecycle !== 'credentials_pending'
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
  if (Math.abs(now - timestampSeconds * 1_000) > SLACK_REQUEST_FRESHNESS_MS) {
    return { accepted: false, reason: 'stale_timestamp' };
  }

  const key = slackIdentityPendingEnvelopeSettingKey(identity.id);
  // Slack's create-and-install UI may verify the same Request URL more than
  // once, and may replace a temporary app challenge with the final app's
  // challenge immediately. Every structurally valid, fresh attempt must get
  // the documented challenge response. Pinning the first envelope made Slack
  // report "Your URL didn't respond" and forced a manual Retry during setup.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await store.getSetting(key);
    const existing = current ? parseStoredEnvelope(current) : undefined;
    if (
      existing &&
      existing.expiresAt > now &&
      existing.rawBody === input.rawBody &&
      existing.signature === input.signature &&
      existing.timestamp === input.timestamp
    ) {
      return {
        accepted: true,
        challenge: body.challenge,
        expiresAt: existing.expiresAt,
        ...(body.appId ? { appId: body.appId } : {}),
        ...(body.teamId ? { teamId: body.teamId } : {}),
      };
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
    if (applied) {
      return {
        accepted: true,
        challenge: body.challenge,
        expiresAt: envelope.expiresAt,
        ...(body.appId ? { appId: body.appId } : {}),
        ...(body.teamId ? { teamId: body.teamId } : {}),
      };
    }
  }
  return { accepted: false, reason: 'changed' };
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
  options: { now?: number; expectedAppId?: string; expectedTeamId?: string } = {},
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
  if (!verified) return { verified: false, reason: 'invalid_signature' };

  const body = parseChallengeBody(envelope.rawBody);
  if (!body) {
    await purgePendingSlackChallenge(store, identityId, raw);
    return { verified: false, reason: 'expired' };
  }
  // Slack's documented url_verification body contains only token, challenge,
  // and type. Compare identity metadata when Slack includes it, but do not
  // reject the documented payload shape after its app-unique signature has
  // verified. Normal event callbacks still require both app and workspace IDs.
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
  credentialDependencies?: SlackCredentialDependencies,
): Promise<string> {
  const revision = await clearSlackIdentityCredentials(
    credentialDependencies ?? store,
    identityId,
    expectedCredentialRevision,
    credentialDependencies ? [] : [slackIdentityPendingEnvelopeSettingKey(identityId)],
  );
  if (credentialDependencies) {
    await store.deleteSetting(slackIdentityPendingEnvelopeSettingKey(identityId));
  }
  return revision;
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
    if (
      body.type !== 'url_verification' ||
      typeof body.challenge !== 'string' ||
      body.challenge.length === 0 ||
      body.challenge.length > MAX_CHALLENGE_TEXT_LENGTH
    ) {
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
