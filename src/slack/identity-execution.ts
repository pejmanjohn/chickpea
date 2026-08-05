import type { WebClient } from '@slack/web-api';

import type { SettingsStore } from '../config/settings-store.ts';
import { UnknownSlackIdentityError } from '../config/errors.ts';
import { getConfigStore, type PlatformEnv } from '../config/state-backend.ts';
import {
  WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
  type SlackIdentity,
} from '../config/types.ts';
import {
  slackConversationsInfo,
  slackIdentityAuthTest,
} from './credentials.ts';
import { resolveSlackIdentityCredentials } from './identity-credentials.ts';
import { createSlackWebClient } from './web-client.ts';
import type { NormalizedSlackTurn } from './types.ts';
import { isDirectSlackTurn } from './work-admission.ts';

type MaybePromise<T> = T | Promise<T>;

export interface SlackIdentityPolicyReader {
  getSlackIdentity(identityId: string): MaybePromise<SlackIdentity>;
}

export interface SlackIdentityExecutionContext {
  identityId: string;
  botToken: string;
  botUserId: string;
  teamId: string;
  client: WebClient;
}

export type SlackIdentityExecutionResolver = (
  identityId: string,
) => Promise<SlackIdentityExecutionContext>;

export type SlackIdentityAccessVerifier = (
  context: SlackIdentityExecutionContext,
  turn: NormalizedSlackTurn,
) => Promise<void>;

/** Cache one in-flight/current resolution per identity for the lifetime of a
 * bounded drain. Callers own that lifetime so a later retry sees rotations. */
export function cacheSlackIdentityExecutionContexts(
  resolve: SlackIdentityExecutionResolver,
): SlackIdentityExecutionResolver {
  const pending = new Map<string, Promise<SlackIdentityExecutionContext>>();
  return (identityId) => {
    let resolution = pending.get(identityId);
    if (!resolution) {
      resolution = resolve(identityId);
      pending.set(identityId, resolution);
    }
    return resolution;
  };
}

export class SlackIdentityUnavailableError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly identityId: string,
    readonly reasonCode: string,
    options: { retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(`Slack identity ${identityId} is unavailable (${reasonCode})`);
    this.name = 'SlackIdentityUnavailableError';
    this.retryable = options.retryable ?? transientSlackIdentityReason(reasonCode);
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Normalize every preflight failure into retry or repair semantics without
 * exposing credentials or transport details to logs and persisted state. */
export function normalizeSlackIdentityExecutionError(
  error: unknown,
  identityId: string,
): SlackIdentityUnavailableError {
  if (error instanceof SlackIdentityUnavailableError) return error;
  return new SlackIdentityUnavailableError(identityId, 'identity_resolution_failed', {
    retryable: true,
  });
}

/** Resolve current credential material by stable identity reference. Dedicated
 * identities never inherit installation-wide environment credentials. */
export async function resolveSlackIdentityExecutionContext(
  identityId: string,
  env?: PlatformEnv,
  options: {
    config?: SlackIdentityPolicyReader;
    settings?: SettingsStore;
  } = {},
): Promise<SlackIdentityExecutionContext> {
  const config = options.config ?? getConfigStore(env);
  let identity: SlackIdentity;
  try {
    identity = await config.getSlackIdentity(identityId);
  } catch (error) {
    if (error instanceof UnknownSlackIdentityError) {
      throw new SlackIdentityUnavailableError(identityId, 'identity_unknown');
    }
    throw new SlackIdentityUnavailableError(identityId, 'identity_lookup_failed', {
      retryable: true,
    });
  }
  if (
    identityId !== WORKSPACE_DEFAULT_SLACK_IDENTITY_ID &&
    (identity.lifecycle !== 'connected' && identity.lifecycle !== 'degraded')
  ) {
    throw new SlackIdentityUnavailableError(identityId, `identity_${identity.lifecycle}`);
  }
  if (
    identityId !== WORKSPACE_DEFAULT_SLACK_IDENTITY_ID &&
    (
      identity.health === 'disconnected' ||
      identity.health === 'uninstalled' ||
      identity.health === 'unauthorized'
    )
  ) {
    throw new SlackIdentityUnavailableError(identityId, `identity_${identity.health}`);
  }

  let credentials: Awaited<ReturnType<typeof resolveSlackIdentityCredentials>>;
  try {
    credentials = await resolveSlackIdentityCredentials(identityId, env, options.settings);
  } catch {
    throw new SlackIdentityUnavailableError(identityId, 'credential_resolution_failed', {
      retryable: true,
    });
  }
  if (!credentials.botToken) {
    throw new SlackIdentityUnavailableError(identityId, 'credentials_missing');
  }
  const auth = await slackIdentityAuthTest(credentials.botToken);
  if (!auth.ok || !auth.botUserId || !auth.teamId) {
    throw new SlackIdentityUnavailableError(
      identityId,
      auth.error ?? 'bot_identity_missing',
      auth.retryAfterMs === undefined ? {} : { retryAfterMs: auth.retryAfterMs },
    );
  }
  if (identity.teamId && identity.teamId !== auth.teamId) {
    throw new SlackIdentityUnavailableError(identityId, 'workspace_mismatch');
  }
  if (identity.appId && identity.appId !== auth.appId) {
    throw new SlackIdentityUnavailableError(identityId, 'app_identity_mismatch');
  }
  if (identity.botUserId && identity.botUserId !== auth.botUserId) {
    throw new SlackIdentityUnavailableError(identityId, 'bot_identity_mismatch');
  }
  return {
    identityId,
    botToken: credentials.botToken,
    botUserId: auth.botUserId,
    teamId: auth.teamId,
    client: createSlackWebClient(credentials.botToken),
  };
}

/** Re-check target membership at durable execution time. This occurs before
 * model work and never substitutes the workspace-default app. */
export async function verifySlackIdentityTurnAccess(
  context: SlackIdentityExecutionContext,
  turn: NormalizedSlackTurn,
): Promise<void> {
  if (context.teamId !== turn.workspaceId) {
    throw new SlackIdentityUnavailableError(context.identityId, 'workspace_mismatch');
  }
  if (isDirectSlackTurn(turn)) return;
  const conversation = await slackConversationsInfo(context.botToken, turn.channelId);
  if (
    !conversation.ok ||
    !conversation.facts ||
    conversation.facts.id !== turn.channelId ||
    (conversation.facts.teamId !== undefined &&
      conversation.facts.teamId !== turn.workspaceId) ||
    !conversation.facts.member
  ) {
    throw new SlackIdentityUnavailableError(
      context.identityId,
      conversation.error ?? 'not_in_channel',
      conversation.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: conversation.retryAfterMs },
    );
  }
}

export function effectiveTurnSlackIdentityId(turn: NormalizedSlackTurn): string {
  return turn.slackIdentityId ?? WORKSPACE_DEFAULT_SLACK_IDENTITY_ID;
}

function transientSlackIdentityReason(reasonCode: string): boolean {
  return reasonCode === 'ratelimited' ||
    reasonCode === 'slack_request_timeout' ||
    reasonCode === 'slack_network_error' ||
    reasonCode === 'slack_non_json_response' ||
    reasonCode === 'internal_error' ||
    reasonCode === 'fatal_error' ||
    reasonCode === 'service_unavailable' ||
    reasonCode === 'request_timeout' ||
    /^slack_http_5\d\d$/.test(reasonCode);
}
