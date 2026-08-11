import type { WebClient } from '@slack/web-api';

import type { SettingsStore } from '../config/settings-store.ts';
import { UnknownSlackIdentityError } from '../config/errors.ts';
import { getConfigStore, type PlatformEnv } from '../config/state-backend.ts';
import {
  WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
  type SlackIdentity,
} from '../config/types.ts';
import {
  isTransientSlackApiError,
  slackBotIdentityInfo,
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
  updateSlackIdentity?(
    identityId: string,
    expectedRevision: number,
    patch: {
      observedDisplayName?: string | null;
      observedAvatarUrl?: string | null;
      observedAt?: number | null;
    },
  ): MaybePromise<SlackIdentity>;
}

export interface SlackIdentityExecutionContext {
  identityId: string;
  botToken: string;
  botUserId: string;
  teamId: string;
  /** Cached presentation label only; botUserId remains the mention authority. */
  displayName?: string;
  client: WebClient;
}

export const SLACK_IDENTITY_PRESENTATION_TTL_MS = 24 * 60 * 60 * 1_000;

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
    this.retryable = options.retryable ?? isTransientSlackApiError(reasonCode);
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
    now?: () => number;
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
  // Slack's documented auth.test response does not guarantee app_id. Bind it
  // when Slack supplies one, but do not turn an omitted optional field into a
  // false mismatch: the stored app id was established during bootstrap from
  // users.info, and the workspace plus bot-user checks still fence the
  // credential to that installation.
  if (identity.appId && auth.appId && identity.appId !== auth.appId) {
    throw new SlackIdentityUnavailableError(identityId, 'app_identity_mismatch');
  }
  if (identity.botUserId && identity.botUserId !== auth.botUserId) {
    throw new SlackIdentityUnavailableError(identityId, 'bot_identity_mismatch');
  }
  let displayName = identity.observedDisplayName ?? auth.botName;
  const now = (options.now ?? Date.now)();
  const presentationIsStale =
    identity.observedAt === undefined ||
    identity.observedAt <= now - SLACK_IDENTITY_PRESENTATION_TTL_MS;
  if (presentationIsStale) {
    // Presentation metadata is deliberately best-effort. Identity, workspace,
    // and authorization were already established above; a users.info outage
    // must not make an otherwise healthy Slack turn unavailable.
    const presentation = await slackBotIdentityInfo(
      credentials.botToken,
      auth.botUserId,
    );
    if (presentation.ok) {
      displayName = presentation.displayName ?? auth.botName ?? displayName;
      if (config.updateSlackIdentity) {
        try {
          await config.updateSlackIdentity(
            identityId,
            identity.connectionRevision,
            {
              ...(displayName ? { observedDisplayName: displayName } : {}),
              ...(presentation.avatarUrl
                ? { observedAvatarUrl: presentation.avatarUrl }
                : {}),
              observedAt: now,
            },
          );
        } catch {
          // A concurrent refresh or Admin edit won the row CAS. Keep the live
          // result for this turn and let the next resolver read the winner.
        }
      }
    }
  }
  return {
    identityId,
    botToken: credentials.botToken,
    botUserId: auth.botUserId,
    teamId: auth.teamId,
    ...(displayName ? { displayName } : {}),
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
