/**
 * The Slack calls an Agent app's lifecycle makes, parsed into domain results.
 * Nothing here returns a raw payload, and no error carries a token.
 */
import { readBoundedText } from '../../http/bounded-body.ts';
import { createdSlackApp, safeSlackError } from '../app-creation.ts';
import type { SlackAppManifest } from '../app-manifest.ts';
import { SLACK_BOT_TOKEN_URL } from '../install-oauth.ts';

const SLACK_API = 'https://slack.com/api';
const MAX_RESPONSE_BYTES = 64 * 1_024;
const ICON_TIMEOUT_MS = 5_000;
const SLACK_ID = /^[A-Z][A-Z0-9]{1,63}$/;
/** Slack answers these for a bot whose app is gone or whose token is dead. */
const BOT_GONE = new Set(['account_inactive', 'invalid_auth', 'token_revoked', 'not_authed', 'app_not_installed']);

/** Slack answered the request and said no. */
export class SlackRefused extends Error {
  readonly name = 'SlackRefused';
  constructor(readonly method: string, readonly code: string) {
    super(`Slack refused ${method}: ${code}`);
  }
}

/** Slack may or may not have done it; nothing repeats this call by itself. */
export class AmbiguousEffect extends Error {
  readonly name = 'AmbiguousEffect';
  constructor(readonly method: string, readonly reason: string) {
    super(`Slack's answer to ${method} is unknown: ${reason}`);
  }
}

/** Slack did not answer, or answered with an outage. */
export class SlackUnavailable extends Error {
  readonly name = 'SlackUnavailable';
  constructor(readonly method: string, readonly reason: string) {
    super(`Slack did not answer ${method}: ${reason}`);
  }
}

export interface RotatedConfigurationToken {
  accessToken: string;
  refreshToken: string;
  teamId: string;
  expiresAt: number;
}

export interface CreatedAgentApp {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
}

export interface AgentAppGrant {
  botToken: string;
  botUserId: string;
  teamId: string;
  appId: string;
  /** The person who chose Allow in Slack. */
  installerUserId: string;
  scopes: string[];
}

export interface AgentAppSlackApi {
  rotate(refreshToken: string): Promise<RotatedConfigurationToken>;
  /** Throws AmbiguousEffect when Slack's answer is unknown and SlackRefused when it said no. */
  create(token: string, manifest: SlackAppManifest): Promise<CreatedAgentApp>;
  update(token: string, appId: string, manifest: SlackAppManifest): Promise<void>;
  setIcon(token: string, appId: string, png: Uint8Array<ArrayBuffer>): Promise<'set' | 'refused' | 'failed'>;
  exchange(input: { clientId: string; clientSecret: string; code: string; redirectUri: string }): Promise<AgentAppGrant>;
  uninstall(input: { clientId: string; clientSecret: string; botToken: string }): Promise<'removed' | 'absent'>;
  delete(token: string, appId: string): Promise<'deleted' | 'absent'>;
}

export interface AgentAppSlackApiOptions {
  fetch?: typeof fetch;
  apiBaseUrl?: string;
}

type Answer = { kind: 'ok'; payload: Record<string, unknown> } | { kind: 'refused'; code: string } | { kind: 'unavailable'; reason: string };

export function createAgentAppSlackApi(options: AgentAppSlackApiOptions = {}): AgentAppSlackApi {
  const fetchImpl = options.fetch ?? fetch;
  const base = options.apiBaseUrl?.trim().replace(/\/+$/, '') || SLACK_API;
  const url = (method: string): string => `${base}/${method}`;

  async function call(method: string, init: RequestInit): Promise<Answer> {
    let response: Response;
    try {
      response = await fetchImpl(url(method), init);
    } catch {
      return { kind: 'unavailable', reason: 'network_error' };
    }
    let payload: Record<string, unknown>;
    try {
      payload = asRecord(JSON.parse(await readBoundedText(response, {
        maxBytes: MAX_RESPONSE_BYTES,
        onOversize: () => new Error('oversize'),
        onMissingBody: () => new Error('empty'),
        fatalDecoder: true,
      })));
    } catch {
      return response.status >= 500
        ? { kind: 'unavailable', reason: `http_${response.status}` }
        : { kind: 'unavailable', reason: 'invalid_slack_response' };
    }
    if (response.ok && payload.ok === true) return { kind: 'ok', payload };
    const code = safeSlackError(payload.error);
    if (response.status >= 500 || code === 'fatal_error' || code === 'internal_error' || code === 'service_unavailable') {
      return { kind: 'unavailable', reason: code || `http_${response.status}` };
    }
    return { kind: 'refused', code: code || (response.status === 429 ? 'ratelimited' : `http_${response.status}`) };
  }

  const json = (token: string, body: unknown): RequestInit => ({
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const form = (params: Record<string, string>, token?: string): RequestInit => ({
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
    body: new URLSearchParams(params).toString(),
  });

  function settled(method: string, answer: Answer): Record<string, unknown> {
    if (answer.kind === 'ok') return answer.payload;
    if (answer.kind === 'refused') throw new SlackRefused(method, answer.code);
    throw new SlackUnavailable(method, answer.reason);
  }

  return {
    async rotate(refreshToken) {
      const payload = settled('tooling.tokens.rotate', await call('tooling.tokens.rotate', form({ refresh_token: refreshToken })));
      const expires = payload.exp;
      const teamId = payload.team_id;
      if (typeof expires !== 'number' || !Number.isFinite(expires) || typeof teamId !== 'string' || !SLACK_ID.test(teamId)) {
        throw new SlackUnavailable('tooling.tokens.rotate', 'invalid_slack_response');
      }
      return {
        accessToken: requiredString(payload.token, 'tooling.tokens.rotate'),
        refreshToken: requiredString(payload.refresh_token, 'tooling.tokens.rotate'),
        teamId,
        expiresAt: expires * 1_000,
      };
    },

    async create(token, manifest) {
      const answer = await call('apps.manifest.create', json(token, { manifest }));
      if (answer.kind === 'unavailable') throw new AmbiguousEffect('apps.manifest.create', answer.reason);
      if (answer.kind === 'refused') throw new SlackRefused('apps.manifest.create', answer.code);
      try {
        return createdSlackApp(answer.payload);
      } catch {
        throw new AmbiguousEffect('apps.manifest.create', 'incomplete_slack_success');
      }
    },

    async update(token, appId, manifest) {
      settled('apps.manifest.update', await call('apps.manifest.update', json(token, { app_id: appId, manifest })));
    },

    async setIcon(token, appId, png) {
      const body = new FormData();
      body.set('app_id', appId);
      body.set('file', new Blob([png], { type: 'image/png' }), 'icon.png');
      const answer = await call('apps.icon.set', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body,
        signal: AbortSignal.timeout(ICON_TIMEOUT_MS),
      });
      if (answer.kind === 'ok') return 'set';
      return answer.kind === 'refused' ? 'refused' : 'failed';
    },

    async exchange(input) {
      const answer = await call('oauth.v2.access', {
        ...form({
          client_id: input.clientId,
          client_secret: input.clientSecret,
          code: input.code,
          redirect_uri: input.redirectUri,
        }),
      });
      const payload = settled('oauth.v2.access', answer);
      const team = asRecord(payload.team);
      const teamId = team.id;
      const appId = payload.app_id;
      if (typeof teamId !== 'string' || !SLACK_ID.test(teamId) || typeof appId !== 'string' || !SLACK_ID.test(appId)) {
        throw new SlackUnavailable('oauth.v2.access', 'invalid_slack_response');
      }
      const scope = typeof payload.scope === 'string' ? payload.scope : '';
      return {
        botToken: requiredString(payload.access_token, 'oauth.v2.access'),
        botUserId: requiredString(payload.bot_user_id, 'oauth.v2.access'),
        teamId,
        appId,
        installerUserId: requiredString(asRecord(payload.authed_user).id, 'oauth.v2.access'),
        scopes: [...new Set(scope.split(',').map((item) => item.trim()).filter(Boolean))],
      };
    },

    async uninstall(input) {
      const answer = await call('apps.uninstall', form({ client_id: input.clientId, client_secret: input.clientSecret }, input.botToken));
      if (answer.kind === 'ok') return 'removed';
      if (answer.kind === 'refused' && BOT_GONE.has(answer.code)) return 'absent';
      settled('apps.uninstall', answer);
      return 'removed';
    },

    async delete(token, appId) {
      const answer = await call('apps.manifest.delete', json(token, { app_id: appId }));
      if (answer.kind === 'ok') return 'deleted';
      if (answer.kind === 'refused' && answer.code === 'app_not_found') return 'absent';
      settled('apps.manifest.delete', answer);
      return 'deleted';
    },
  };
}

/** oauth.v2.access lives outside the method base, so the token URL stays the install flow's constant. */
export const AGENT_APP_TOKEN_URL = SLACK_BOT_TOKEN_URL;

function requiredString(value: unknown, method: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_096) {
    throw new SlackUnavailable(method, 'invalid_slack_response');
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
