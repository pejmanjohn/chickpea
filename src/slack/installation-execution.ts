import { CREDENTIAL_KEYRING_UNAVAILABLE, isCredentialKeyringUnavailable } from './credential-keyring.ts';
import type { WebClient } from '@slack/web-api';

import type { ConfigStore } from '../config/store.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { getConfigStore, getSettingsStore } from '../config/state-backend.ts';
import type { WorkspaceInstallation } from '../config/types.ts';
import {
  isTransientSlackApiError,
  slackConversationsInfo,
  slackIdentityAuthTest,
} from './credentials.ts';
import { slackInstallationCredentialId } from './hosted-slack-app.ts';
import {
  resolveSlackInstallationCredentials,
  type SlackCredentialResolutionDependencies,
} from './installation-credentials.ts';
import { sharesSlackAppReadBudget } from './read-budget.ts';
import { createSlackWebClient } from './web-client.ts';
import { SlackTransportError } from './transport/types.ts';
import { GatewayDeploymentClient } from './gateway/client.ts';
import { loadCredentialKeyring } from './credential-keyring.ts';
import { resolveChickpeaGatewayUrl } from './gateway/runtime.ts';
import { createGatewaySlackWebClient } from './gateway/web-client.ts';
import { sha256HexNode } from '../security/digest.ts';
import type { NormalizedSlackTurn } from './types.ts';
import { slackTurnSurface } from './thread-key.ts';

type MaybePromise<T> = T | Promise<T>;

interface SlackInstallationReader {
  getWorkspaceInstallation(
    workspaceId: string,
  ): MaybePromise<WorkspaceInstallation | undefined>;
}

export interface SlackInstallationExecutionContext {
  workspaceId: string;
  transportMode: 'direct' | 'gateway';
  /** Whether its reads draw on a shared app's budget (sharesSlackAppReadBudget). */
  sharedAppReads: boolean;
  botToken?: string;
  botUserId: string;
  displayName?: string;
  client: WebClient;
}

export type SlackInstallationExecutionResolver = (
  workspaceId: string,
  /** The Agent the turn runs as; one with its own Slack app answers as that bot. */
  agentId?: string,
) => Promise<SlackInstallationExecutionContext>;

export type SlackInstallationAccessVerifier = (
  context: SlackInstallationExecutionContext,
  turn: NormalizedSlackTurn,
) => Promise<void>;

export function effectiveTurnSlackInstallationId(turn: NormalizedSlackTurn): string {
  return turn.workspaceId;
}

export function cacheSlackInstallationExecutionContexts(
  resolve: SlackInstallationExecutionResolver,
): SlackInstallationExecutionResolver {
  const pending = new Map<string, Promise<SlackInstallationExecutionContext>>();
  return (workspaceId) => {
    let resolution = pending.get(workspaceId);
    if (!resolution) {
      resolution = resolve(workspaceId);
      pending.set(workspaceId, resolution);
    }
    return resolution;
  };
}

export class SlackInstallationUnavailableError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly workspaceId: string,
    readonly reasonCode: string,
    options: { retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(`Slack installation for ${workspaceId} is unavailable (${reasonCode})`);
    this.name = 'SlackInstallationUnavailableError';
    this.retryable = options.retryable ?? isTransientSlackApiError(reasonCode);
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function normalizeSlackInstallationExecutionError(
  error: unknown,
  workspaceId: string,
): SlackInstallationUnavailableError {
  if (error instanceof SlackInstallationUnavailableError) return error;
  return new SlackInstallationUnavailableError(workspaceId, 'installation_resolution_failed', {
    retryable: true,
  });
}

export async function resolveSlackInstallationExecutionContext(
  workspaceId: string,
  env?: PlatformEnv,
  options: {
    config?: SlackInstallationReader;
    settings?: SettingsStore;
    credentialDependencies?: SlackCredentialResolutionDependencies;
    gatewayClient?: GatewayDeploymentClient;
    rejectRateLimitedCalls?: boolean;
  } = {},
): Promise<SlackInstallationExecutionContext> {
  const config = options.config ?? getConfigStore(env);
  const installation = await config.getWorkspaceInstallation(workspaceId);
  if (!installation) {
    throw new SlackInstallationUnavailableError(workspaceId, 'installation_unknown');
  }
  if (installation.health === 'revoked') {
    throw new SlackInstallationUnavailableError(workspaceId, 'installation_revoked');
  }
  if (installation.transportMode === 'gateway') {
    return resolveGatewayExecutionContext(installation, env, {
      config,
      ...(options.settings ? { settings: options.settings } : {}),
      ...(options.gatewayClient ? { gatewayClient: options.gatewayClient } : {}),
    });
  }

  let credentials: Awaited<ReturnType<typeof resolveSlackInstallationCredentials>>;
  try {
    credentials = await resolveSlackInstallationCredentials(
      slackInstallationCredentialId(options.credentialDependencies?.env ?? env),
      env,
      options.credentialDependencies ?? options.settings,
    );
  } catch (error) {
    throw new SlackInstallationUnavailableError(
      workspaceId,
      isCredentialKeyringUnavailable(error) ? CREDENTIAL_KEYRING_UNAVAILABLE : 'credential_resolution_failed',
      { retryable: true },
    );
  }
  const { botToken } = credentials;
  if (!botToken) {
    throw new SlackInstallationUnavailableError(workspaceId, 'credentials_missing');
  }
  const auth = await verifiedIdentity(`${workspaceId}:${sha256HexNode(botToken)}`, async () => {
    const result = await slackIdentityAuthTest(botToken);
    if (!result.ok || !result.botUserId || !result.teamId) {
      throw new SlackInstallationUnavailableError(
        workspaceId,
        result.error ?? 'bot_identity_missing',
        result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs },
      );
    }
    return {
      botUserId: result.botUserId,
      teamId: result.teamId,
      ...(result.appId ? { appId: result.appId } : {}),
      ...(result.botName ? { botName: result.botName } : {}),
    };
  });
  if (auth.teamId !== workspaceId || (installation.teamId && installation.teamId !== auth.teamId)) {
    throw new SlackInstallationUnavailableError(workspaceId, 'workspace_mismatch');
  }
  if (installation.appId && auth.appId && installation.appId !== auth.appId) {
    throw new SlackInstallationUnavailableError(workspaceId, 'app_identity_mismatch');
  }
  if (installation.botUserId && installation.botUserId !== auth.botUserId) {
    throw new SlackInstallationUnavailableError(workspaceId, 'bot_identity_mismatch');
  }
  return {
    workspaceId,
    transportMode: 'direct',
    sharedAppReads: sharesSlackAppReadBudget({ transportMode: 'direct', env }),
    botToken,
    botUserId: auth.botUserId,
    ...(auth.botName ? { displayName: auth.botName } : {}),
    client: createSlackWebClient(botToken, { rejectRateLimitedCalls: options.rejectRateLimitedCalls === true }),
  };
}

export async function verifySlackInstallationTurnAccess(
  context: SlackInstallationExecutionContext,
  turn: NormalizedSlackTurn,
): Promise<void> {
  if (context.workspaceId !== turn.workspaceId) {
    throw new SlackInstallationUnavailableError(context.workspaceId, 'workspace_mismatch');
  }
  if (slackTurnSurface(turn) === 'direct') return;
  if (context.transportMode === 'direct' && context.botToken) {
    const conversation = await slackConversationsInfo(context.botToken, turn.channelId);
    if (
      conversation.ok && conversation.facts?.id === turn.channelId &&
      (conversation.facts.teamId === undefined || conversation.facts.teamId === turn.workspaceId) &&
      conversation.facts.member
    ) return;
    throw new SlackInstallationUnavailableError(
      context.workspaceId,
      conversation.error ?? 'not_in_channel',
      conversation.retryAfterMs === undefined ? {} : { retryAfterMs: conversation.retryAfterMs },
    );
  }
  try {
    const result = await context.client.conversations.info({ channel: turn.channelId });
    const channel = result.channel as Record<string, unknown> | undefined;
    if (!result.ok || !channel || channel.id !== turn.channelId || channel.is_member !== true) {
      throw new SlackInstallationUnavailableError(context.workspaceId, 'not_in_channel');
    }
  } catch (error) {
    if (error instanceof SlackInstallationUnavailableError) throw error;
    throw normalizeSlackInstallationExecutionError(error, context.workspaceId);
  }
}

async function resolveGatewayExecutionContext(
  installation: WorkspaceInstallation,
  env: PlatformEnv | undefined,
  options: {
    config: SlackInstallationReader;
    settings?: SettingsStore;
    gatewayClient?: GatewayDeploymentClient;
  },
): Promise<SlackInstallationExecutionContext> {
  const settings = options.settings ?? getSettingsStore(env);
  const gateway = options.gatewayClient ?? new GatewayDeploymentClient({
    settings,
    config: options.config as ConfigStore,
    keyring: loadCredentialKeyring(env),
    gatewayBaseUrl: resolveChickpeaGatewayUrl(env),
  });
  const binding = await gateway.loadBinding();
  if (!binding || binding.workspaceId !== installation.workspaceId ||
      binding.bindingId !== installation.gatewayBindingId) {
    throw new SlackInstallationUnavailableError(
      installation.workspaceId,
      'gateway_binding_missing',
      { retryable: true },
    );
  }
  const client = createGatewaySlackWebClient(gateway);
  const { botUserId, teamId } = await verifiedIdentity(
    `${installation.workspaceId}:${binding.bindingId}:${installation.botUserId ?? ''}`,
    async () => {
      let auth: Awaited<ReturnType<typeof client.auth.test>>;
      try {
        auth = await client.auth.test();
      } catch (error) {
        const reasonCode = error instanceof SlackTransportError
          ? error.code
          : 'gateway_unreachable';
        console.error('[chickpea] shared Slack auth.test failed:', reasonCode);
        throw new SlackInstallationUnavailableError(
          installation.workspaceId,
          reasonCode,
          {
            retryable: true,
            ...(error instanceof SlackTransportError && error.retryAfterMs !== undefined
              ? { retryAfterMs: error.retryAfterMs }
              : {}),
          },
        );
      }
      return {
        botUserId: typeof auth.user_id === 'string' ? auth.user_id : binding.botUserId,
        teamId: typeof auth.team_id === 'string' ? auth.team_id : binding.workspaceId,
      };
    },
  );
  if (teamId !== installation.workspaceId || botUserId !== installation.botUserId) {
    throw new SlackInstallationUnavailableError(
      installation.workspaceId,
      'gateway_binding_mismatch',
    );
  }
  return {
    workspaceId: installation.workspaceId,
    transportMode: 'gateway',
    sharedAppReads: true,
    botUserId,
    client,
  };
}

/**
 * How long one auth.test vouches for an installation's identity. Every turn
 * attempt resolves its installation (once per TagStateStore drain, once per
 * thread-runner alarm), so a burst of threads verified the same unchanged
 * identity once per turn: on the gateway each auth.test spends one operation
 * of the shared gateway's per-binding window, and on a direct installation it
 * is a Slack round trip before the turn's first visible write. The gateway key
 * carries the workspace, binding and expected bot user, and the direct key a
 * digest of the bot token, so a reinstall, rebinding or rotated token is
 * verified afresh; a revoked token still fails the turn's first real Slack
 * call. Only a successful verification is reused, and the identity checks
 * still run against it on every resolution; a failure is never cached.
 */
export const IDENTITY_VERIFICATION_TTL_MS = 60_000;

interface VerifiedIdentity {
  botUserId: string;
  teamId: string;
  appId?: string;
  botName?: string;
}

const identityVerifications = new Map<
  string,
  { expiresAt: number; identity: Promise<VerifiedIdentity> }
>();

async function verifiedIdentity(
  key: string,
  verify: () => Promise<VerifiedIdentity>,
  now: () => number = Date.now,
): Promise<VerifiedIdentity> {
  const cached = identityVerifications.get(key);
  if (cached && cached.expiresAt > now()) return cached.identity;
  // Concurrent resolutions share one in-flight auth.test.
  const identity = verify();
  const entry = { expiresAt: now() + IDENTITY_VERIFICATION_TTL_MS, identity };
  identityVerifications.set(key, entry);
  try {
    return await identity;
  } catch (error) {
    if (identityVerifications.get(key) === entry) identityVerifications.delete(key);
    throw error;
  } finally {
    if (identityVerifications.size > 64) {
      const at = now();
      for (const [candidate, value] of identityVerifications) {
        if (value.expiresAt <= at) identityVerifications.delete(candidate);
      }
    }
  }
}

/** Test seam: forget every cached identity verification. */
export function resetIdentityVerificationsForTests(): void {
  identityVerifications.clear();
}
