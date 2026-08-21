import { createHash, timingSafeEqual } from 'node:crypto';

import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';

import { WORKSPACE_SLACK_INSTALLATION_ID } from '../config/types.ts';
import type { SlackOidcAttempt } from '../identity/types.ts';
import {
  resolveSlackControlPlaneAppCredentials,
  resolveSlackInstallationCredentials,
  type SlackCredentialDependencies,
} from '../slack/installation-credentials.ts';
import { classifySlackUserForAdmission } from '../slack/user-classification.ts';

export const SLACK_OIDC_ISSUER = 'https://slack.com';
export const SLACK_OIDC_AUTHORIZE_URL = 'https://slack.com/openid/connect/authorize';
export const SLACK_OIDC_TOKEN_URL = 'https://slack.com/api/openid.connect.token';
export const SLACK_OIDC_USERINFO_URL = 'https://slack.com/api/openid.connect.userInfo';
export const SLACK_OIDC_JWKS_URL = 'https://slack.com/openid/connect/keys';
export const SLACK_OIDC_SCOPES = ['openid', 'profile', 'email'] as const;
export const MAX_SLACK_OIDC_RESPONSE_BYTES = 64 * 1_024;

const TEAM_CLAIM = 'https://slack.com/team_id';
const USER_CLAIM = 'https://slack.com/user_id';
const SLACK_ID = /^[A-Z][A-Z0-9]{1,63}$/;

export type SlackOidcErrorCode =
  | 'invalid_state'
  | 'expired_state'
  | 'wrong_browser'
  | 'wrong_callback'
  | 'processing'
  | 'stale_revision'
  | 'provider_denied'
  | 'slack_unreachable'
  | 'invalid_response'
  | 'invalid_token'
  | 'workspace_mismatch'
  | 'user_mismatch'
  | 'inactive_user'
  | 'invitation_unavailable'
  | 'session_unavailable';

export class SlackOidcError extends Error {
  constructor(readonly code: SlackOidcErrorCode, message = 'Slack identity could not be verified.') {
    super(message);
    this.name = 'SlackOidcError';
  }
}

export interface SlackOidcProof {
  slackTeamId: string;
  slackUserId: string;
  displayName: string;
  contactEmail?: string;
}

export interface SlackOidcProvider {
  authorizationUrl(input: {
    clientId: string;
    redirectUri: string;
    state: string;
    nonce: string;
    teamId: string;
  }): string | Promise<string>;
  exchangeAndVerify(input: {
    attempt: SlackOidcAttempt;
    code: string;
    nonce: string;
  }): Promise<SlackOidcProof>;
}

export interface SlackOidcGatewayDependencies {
  credentials: SlackCredentialDependencies;
  fetch?: typeof fetch;
  jwks?: JWTVerifyGetKey;
  apiBaseUrl?: string;
  jwksUrl?: string;
  now?: () => number;
}

export class SlackOidcGateway implements SlackOidcProvider {
  private readonly fetch: typeof fetch;
  private readonly jwks: JWTVerifyGetKey;
  private readonly now: () => number;

  constructor(private readonly dependencies: SlackOidcGatewayDependencies) {
    this.fetch = dependencies.fetch ?? fetch;
    this.jwks = dependencies.jwks ?? createRemoteJWKSet(
      new URL(dependencies.jwksUrl ?? SLACK_OIDC_JWKS_URL),
    );
    this.now = dependencies.now ?? Date.now;
  }

  authorizationUrl(input: {
    clientId: string;
    redirectUri: string;
    state: string;
    nonce: string;
    teamId: string;
  }): string {
    const url = new URL(SLACK_OIDC_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', input.clientId);
    url.searchParams.set('scope', SLACK_OIDC_SCOPES.join(' '));
    url.searchParams.set('redirect_uri', exactHttpsRedirect(input.redirectUri));
    url.searchParams.set('state', boundedSecret(input.state, 'state'));
    url.searchParams.set('nonce', boundedSecret(input.nonce, 'nonce'));
    url.searchParams.set('team', slackId(input.teamId, 'team'));
    return url.toString();
  }

  async exchangeAndVerify(input: {
    attempt: SlackOidcAttempt;
    code: string;
    nonce: string;
  }): Promise<SlackOidcProof> {
    if (!input.code || input.code.length > 2_048 || /\s/.test(input.code)) {
      throw new SlackOidcError('invalid_response');
    }
    if (!secretHashMatches(input.nonce, input.attempt.nonceHash)) {
      throw new SlackOidcError('invalid_token');
    }
    const [appCredentials, botCredentials] = await Promise.all([
      resolveSlackControlPlaneAppCredentials(this.dependencies.credentials),
      resolveSlackInstallationCredentials(
        WORKSPACE_SLACK_INSTALLATION_ID,
        undefined,
        this.dependencies.credentials,
      ),
    ]).catch(() => { throw new SlackOidcError('stale_revision'); });
    if (appCredentials.appId !== input.attempt.appId ||
        appCredentials.clientId !== input.attempt.clientId ||
        appCredentials.connectionRevision !== input.attempt.credentialRevision ||
        appCredentials.teamId !== input.attempt.expectedTeamId ||
        botCredentials.connectionRevision !== input.attempt.credentialRevision ||
        !botCredentials.botToken || !botCredentials.botUserId) {
      throw new SlackOidcError('stale_revision');
    }

    const tokenResponse = await this.requestJson(this.apiUrl(
      'openid.connect.token',
      SLACK_OIDC_TOKEN_URL,
    ), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: appCredentials.clientId,
        client_secret: appCredentials.clientSecret,
        code: input.code,
        redirect_uri: input.attempt.redirectUri,
      }).toString(),
    });
    const accessToken = exactString(tokenResponse.access_token, 8_192);
    const idToken = exactString(tokenResponse.id_token, 65_536);
    if (tokenResponse.ok === false || !accessToken || !idToken ||
        (tokenResponse.token_type !== undefined && tokenResponse.token_type !== 'Bearer')) {
      throw new SlackOidcError('invalid_response');
    }
    const claims = await this.verifyIdToken({
      idToken,
      accessToken,
      nonce: input.nonce,
      clientId: input.attempt.clientId,
    });
    const teamId = slackId(claims[TEAM_CLAIM], 'team');
    const userId = slackId(claims[USER_CLAIM], 'user');
    if (claims.sub !== userId) throw new SlackOidcError('invalid_token');
    if (teamId !== input.attempt.expectedTeamId) throw new SlackOidcError('workspace_mismatch');
    if (input.attempt.expectedSlackUserId && userId !== input.attempt.expectedSlackUserId) {
      throw new SlackOidcError('user_mismatch');
    }

    const userInfo = await this.requestJson(this.apiUrl(
      'openid.connect.userInfo',
      SLACK_OIDC_USERINFO_URL,
    ), {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (userInfo.ok === false || userInfo.sub !== userId ||
        userInfo[TEAM_CLAIM] !== teamId || userInfo[USER_CLAIM] !== userId) {
      throw new SlackOidcError('invalid_token');
    }
    const slackUser = await this.requestJson(this.apiUrl(
      'users.info',
      'https://slack.com/api/users.info',
    ), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${botCredentials.botToken}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ user: userId }).toString(),
    });
    const facts = slackUserFacts(slackUser.user);
    if (slackUser.ok !== true ||
        classifySlackUserForAdmission(facts, teamId, botCredentials.botUserId) !== 'eligible_human') {
      throw new SlackOidcError('inactive_user');
    }
    const email = contactEmail(userInfo);
    return {
      slackTeamId: teamId,
      slackUserId: userId,
      displayName: displayName(userInfo),
      ...(email ? { contactEmail: email } : {}),
    };
  }

  private async verifyIdToken(input: {
    idToken: string;
    accessToken: string;
    nonce: string;
    clientId: string;
  }): Promise<Record<string, unknown>> {
    let header;
    try {
      header = decodeProtectedHeader(input.idToken);
    } catch {
      throw new SlackOidcError('invalid_token');
    }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid ||
        header.jku !== undefined || header.x5u !== undefined) {
      throw new SlackOidcError('invalid_token');
    }
    try {
      const verified = await jwtVerify(input.idToken, this.jwks, {
        algorithms: ['RS256'],
        issuer: SLACK_OIDC_ISSUER,
        audience: input.clientId,
        clockTolerance: 30,
        maxTokenAge: '10m',
        currentDate: new Date(this.now()),
      });
      const claims = verified.payload as Record<string, unknown>;
      const nowSeconds = Math.floor(this.now() / 1_000);
      if (claims.nonce !== input.nonce || typeof claims.iat !== 'number' ||
          typeof claims.exp !== 'number' || claims.iat > nowSeconds + 30 ||
          claims.exp <= nowSeconds - 30) {
        throw new SlackOidcError('invalid_token');
      }
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if ((audiences.length > 1 || claims.azp !== undefined) && claims.azp !== input.clientId) {
        throw new SlackOidcError('invalid_token');
      }
      if (typeof claims.at_hash !== 'string' || !constantTimeTextEqual(
        claims.at_hash,
        createHash('sha256').update(input.accessToken).digest().subarray(0, 16).toString('base64url'),
      )) {
        throw new SlackOidcError('invalid_token');
      }
      return claims;
    } catch (error) {
      if (error instanceof SlackOidcError) throw error;
      throw new SlackOidcError('invalid_token');
    }
  }

  private async requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      const fetchImpl = this.fetch;
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new SlackOidcError('slack_unreachable');
    }
    if (!response.ok) throw new SlackOidcError('invalid_response');
    return boundedJson(response);
  }

  private apiUrl(method: string, fallback: string): string {
    const normalized = this.dependencies.apiBaseUrl?.trim().replace(/\/+$/, '');
    return normalized ? `${normalized}/${method}` : fallback;
  }
}

function slackUserFacts(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const user = value as Record<string, unknown>;
  if (typeof user.id !== 'string') return undefined;
  return {
    id: user.id,
    teamId: typeof user.team_id === 'string' ? user.team_id : undefined,
    deleted: user.deleted === true,
    bot: user.is_bot === true,
    appUser: user.is_app_user === true,
    restricted: user.is_restricted === true,
    ultraRestricted: user.is_ultra_restricted === true,
    stranger: user.is_stranger === true,
  };
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_SLACK_OIDC_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new SlackOidcError('invalid_response');
  }
  if (!response.body) throw new SlackOidcError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_SLACK_OIDC_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new SlackOidcError('invalid_response');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new SlackOidcError('invalid_response');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SlackOidcError('invalid_response');
  }
  return parsed as Record<string, unknown>;
}

function displayName(userInfo: Record<string, unknown>): string {
  for (const candidate of [userInfo.name, userInfo.given_name, userInfo.sub]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, 120);
  }
  return 'Slack member';
}

function contactEmail(userInfo: Record<string, unknown>): string | undefined {
  const value = userInfo.email;
  return typeof value === 'string' && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    ? value.toLowerCase()
    : undefined;
}

function exactString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function slackId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SLACK_ID.test(value)) throw new SlackOidcError('invalid_token', `Slack ${field} claim is invalid.`);
  return value;
}

function exactHttpsRedirect(value: string): string {
  try {
    const url = new URL(value);
    const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !loopback) || url.username || url.password || url.hash) throw new Error();
    return url.toString();
  } catch {
    throw new SlackOidcError('wrong_callback');
  }
}

function boundedSecret(value: string, field: string): string {
  if (value.length < 32 || value.length > 512 || /\s/.test(value)) {
    throw new SlackOidcError('invalid_state', `Slack OIDC ${field} is invalid.`);
  }
  return value;
}

function secretHashMatches(secret: string, expectedHash: string): boolean {
  return constantTimeTextEqual(createHash('sha256').update(secret).digest('hex'), expectedHash);
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
