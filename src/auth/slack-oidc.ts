import { createHash } from 'node:crypto';

import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';

import { readBoundedBytes } from '../http/bounded-body.ts';
import { constantTimeEquals } from '../security/constant-time.ts';
import { HOSTED_SLACK_INSTALLATION_ID, WORKSPACE_SLACK_INSTALLATION_ID } from '../config/types.ts';
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
const MAX_SLACK_OIDC_RESPONSE_BYTES = 64 * 1_024;

const TEAM_CLAIM = 'https://slack.com/team_id';
const USER_CLAIM = 'https://slack.com/user_id';
const SLACK_ID = /^[A-Z][A-Z0-9]{1,63}$/;

type SlackOidcErrorCode =
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
  /**
   * Set when no bot of the app could check the person's membership because
   * the app is not installed in their workspace yet. Only an install grant
   * naming this same person may admit such a proof; it never yields a session.
   */
  eligibility?: 'install_grant';
}

/** What verification needs from the attempt that started the sign-in. */
export type SlackOidcAttemptBinding =
  Pick<SlackOidcAttempt, 'appId' | 'clientId' | 'credentialRevision' | 'redirectUri' | 'nonceHash' | 'expectedSlackUserId'> & {
    /** Absent for a discovery sign-in, where the workspace is learned from Slack. */
    expectedTeamId: string | null;
  };

export interface SlackOidcAppCredentials {
  appId: string;
  clientId: string;
  clientSecret: string;
  connectionRevision: string;
}

export interface SlackOidcBotCredentials {
  botToken: string;
  botUserId: string;
}

/** Where verification reads the signing-in app and the bot in a workspace. */
export interface SlackOidcCredentials {
  app(): Promise<SlackOidcAppCredentials>;
  /** The app's bot in `teamId`, current for `attempt`; undefined where it has none. */
  bot(teamId: string, attempt: SlackOidcAttemptBinding): Promise<SlackOidcBotCredentials | undefined>;
}

/** A standalone deployment: one installation's bundle holds the app and its bot. */
export function standaloneSlackOidcCredentials(credentials: SlackCredentialDependencies): SlackOidcCredentials {
  return {
    async app() {
      const app = await resolveSlackControlPlaneAppCredentials(credentials);
      return {
        appId: app.appId,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        connectionRevision: app.connectionRevision,
      };
    },
    async bot(teamId, attempt) {
      const [app, bot] = await Promise.all([
        resolveSlackControlPlaneAppCredentials(credentials),
        resolveSlackInstallationCredentials(WORKSPACE_SLACK_INSTALLATION_ID, undefined, credentials),
      ]);
      if (app.teamId !== teamId || app.connectionRevision !== attempt.credentialRevision ||
          bot.connectionRevision !== attempt.credentialRevision || !bot.botToken || !bot.botUserId) {
        return undefined;
      }
      return { botToken: bot.botToken, botUserId: bot.botUserId };
    },
  };
}

/**
 * A deployment serving many installations: the host owns the app's
 * credentials, and each installation's store holds only its own bot.
 */
export function hostedSlackOidcCredentials(input: {
  app: () => Promise<SlackOidcAppCredentials>;
  installation: SlackCredentialDependencies;
}): SlackOidcCredentials {
  return {
    app: input.app,
    async bot(teamId, attempt) {
      const [active, bot] = await Promise.all([
        input.installation.state.getActiveSlackCredentialRevision(HOSTED_SLACK_INSTALLATION_ID),
        resolveSlackInstallationCredentials(HOSTED_SLACK_INSTALLATION_ID, undefined, input.installation),
      ]);
      if (!active || active.teamId !== teamId || active.appId !== attempt.appId ||
          bot.connectionRevision !== active.revision || !bot.botToken || !bot.botUserId) {
        return undefined;
      }
      return { botToken: bot.botToken, botUserId: bot.botUserId };
    },
  };
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
  credentials: SlackOidcCredentials;
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

  /** Without `teamId`, Slack lets the person choose their workspace. */
  authorizationUrl(input: {
    clientId: string;
    redirectUri: string;
    state: string;
    nonce: string;
    teamId?: string;
  }): string {
    const url = new URL(SLACK_OIDC_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', input.clientId);
    url.searchParams.set('scope', SLACK_OIDC_SCOPES.join(' '));
    url.searchParams.set('redirect_uri', exactHttpsRedirect(input.redirectUri));
    url.searchParams.set('state', boundedSecret(input.state, 'state'));
    url.searchParams.set('nonce', boundedSecret(input.nonce, 'nonce'));
    if (input.teamId !== undefined) url.searchParams.set('team', slackId(input.teamId, 'team'));
    return url.toString();
  }

  /**
   * `eligibility: 'install_grant'` accepts a person whose workspace has no bot
   * of the app yet, marking the proof so only that person's install grant can
   * admit it. Otherwise the bot must confirm an eligible human.
   */
  async exchangeAndVerify(input: {
    attempt: SlackOidcAttemptBinding;
    code: string;
    nonce: string;
    eligibility?: 'install_grant';
  }): Promise<SlackOidcProof> {
    if (!input.code || input.code.length > 2_048 || /\s/.test(input.code)) {
      throw new SlackOidcError('invalid_response');
    }
    if (!secretHashMatches(input.nonce, input.attempt.nonceHash)) {
      throw new SlackOidcError('invalid_token');
    }
    const expectedTeamId = input.attempt.expectedTeamId;
    const [appCredentials, expectedBot] = await Promise.all([
      this.dependencies.credentials.app(),
      expectedTeamId ? this.dependencies.credentials.bot(expectedTeamId, input.attempt) : undefined,
    ]).catch(() => { throw new SlackOidcError('stale_revision'); });
    if (appCredentials.appId !== input.attempt.appId ||
        appCredentials.clientId !== input.attempt.clientId ||
        appCredentials.connectionRevision !== input.attempt.credentialRevision ||
        (expectedTeamId && !expectedBot)) {
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
    if (expectedTeamId && teamId !== expectedTeamId) throw new SlackOidcError('workspace_mismatch');
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
    const email = contactEmail(userInfo);
    const proof: SlackOidcProof = {
      slackTeamId: teamId,
      slackUserId: userId,
      displayName: displayName(userInfo),
      ...(email ? { contactEmail: email } : {}),
    };
    const botCredentials = expectedBot ?? await this.dependencies.credentials.bot(teamId, input.attempt)
      .catch(() => { throw new SlackOidcError('stale_revision'); });
    if (!botCredentials) {
      if (input.eligibility !== 'install_grant') throw new SlackOidcError('inactive_user');
      return { ...proof, eligibility: 'install_grant' };
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
    return proof;
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
      if (typeof claims.at_hash !== 'string' || !constantTimeEquals(
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
  const bytes = await readBoundedBytes(response, {
    maxBytes: MAX_SLACK_OIDC_RESPONSE_BYTES,
    onOversize: () => new SlackOidcError('invalid_response'),
    onMissingBody: () => new SlackOidcError('invalid_response'),
  });
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
  return constantTimeEquals(createHash('sha256').update(secret).digest('hex'), expectedHash);
}
