import type { ConfigStore } from '../config/store.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { SlackIdentity } from '../config/types.ts';
import {
  recordPendingSlackChallenge,
  type RecordPendingSlackChallengeResult,
} from './identity-handshake.ts';

export const MAX_SLACK_INGRESS_BYTES = 1_048_576;

const INGRESS_KEY_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const JSON_MEDIA_TYPE = 'application/json';

export type SlackIngressCandidateResult =
  | { found: true; identity: SlackIdentity }
  | { found: false };

export type SlackIdentityEnvelopeBindingResult =
  | { valid: true }
  | { valid: false; reason: 'app_mismatch' | 'workspace_mismatch' | 'identity_unavailable' };

/**
 * Resolve opaque routing material to one candidate identity. The ingress key
 * chooses which signing secret may verify the request; it is never treated as
 * authentication and must not be logged or returned.
 */
export async function resolveSlackIngressCandidate(
  store: ConfigStore,
  ingressKey: string,
): Promise<SlackIngressCandidateResult> {
  if (!INGRESS_KEY_PATTERN.test(ingressKey)) return { found: false };
  const identity = (await store.listSlackIdentities()).find(
    (candidate) => candidate.ingressKey === ingressKey,
  );
  return identity ? { found: true, identity } : { found: false };
}

/** Payload identity is trusted only after @flue/slack verifies the raw body. */
export function validateSlackIdentityEnvelopeBinding(
  identity: SlackIdentity,
  payload: { api_app_id?: unknown; team_id?: unknown },
): SlackIdentityEnvelopeBindingResult {
  if (
    identity.lifecycle === 'retired' ||
    (identity.kind === 'dedicated' && identity.lifecycle !== 'connected' && identity.lifecycle !== 'degraded')
  ) {
    return { valid: false, reason: 'identity_unavailable' };
  }
  if (typeof payload.api_app_id !== 'string') {
    return { valid: false, reason: 'app_mismatch' };
  }
  if (!identity.appId && identity.kind === 'dedicated') {
    return { valid: false, reason: 'app_mismatch' };
  }
  if (identity.appId && payload.api_app_id !== identity.appId) {
    return { valid: false, reason: 'app_mismatch' };
  }
  if (typeof payload.team_id !== 'string') {
    return { valid: false, reason: 'workspace_mismatch' };
  }
  if (!identity.teamId && identity.kind === 'dedicated') {
    return { valid: false, reason: 'workspace_mismatch' };
  }
  if (identity.teamId && payload.team_id !== identity.teamId) {
    return { valid: false, reason: 'workspace_mismatch' };
  }
  return { valid: true };
}

/**
 * The sole unsigned identity route: one bounded, structurally valid pending
 * URL-verification envelope. Its signing headers are retained for the later
 * operator-supplied secret check; every event callback remains unauthorized.
 */
export async function handlePendingSlackIdentityChallenge(
  request: Request,
  identity: SlackIdentity,
  settings: SettingsStore,
): Promise<Response> {
  const mediaType = request.headers.get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE) return Response.json({ error: 'invalid_content_type' }, { status: 415 });

  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      return Response.json({ error: 'invalid_content_length' }, { status: 400 });
    }
    if (Number(contentLength) > MAX_SLACK_INGRESS_BYTES) {
      return Response.json({ error: 'request_too_large' }, { status: 413 });
    }
  }

  const rawBody = await readBoundedBody(request, MAX_SLACK_INGRESS_BYTES);
  if (rawBody === 'oversized') {
    return Response.json({ error: 'request_too_large' }, { status: 413 });
  }
  if (rawBody === undefined) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  const signature = request.headers.get('x-slack-signature') ?? '';
  const timestamp = request.headers.get('x-slack-request-timestamp') ?? '';
  const result = await recordPendingSlackChallenge(settings, identity, {
    rawBody,
    signature,
    timestamp,
  });
  if (!result.accepted) return pendingChallengeFailure(result);

  const challenge = parseChallenge(rawBody);
  if (!challenge) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }
  return Response.json({ challenge });
}

async function readBoundedBody(
  request: Request,
  limit: number,
): Promise<string | 'oversized' | undefined> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return 'oversized';
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function parseChallenge(rawBody: string): string | undefined {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const body = parsed as Record<string, unknown>;
    return body.type === 'url_verification' && typeof body.challenge === 'string'
      ? body.challenge
      : undefined;
  } catch {
    return undefined;
  }
}

function pendingChallengeFailure(
  result: Exclude<RecordPendingSlackChallengeResult, { accepted: true }>,
): Response {
  if (result.reason === 'oversized') {
    return Response.json({ error: 'request_too_large' }, { status: 413 });
  }
  if (result.reason === 'rate_limited' || result.reason === 'changed') {
    return Response.json({ error: 'challenge_already_recorded' }, { status: 429 });
  }
  if (result.reason === 'identity_not_pending') {
    return Response.json({ error: 'slack_identity_unavailable' }, { status: 409 });
  }
  return Response.json({ error: 'invalid_slack_request' }, { status: 401 });
}
