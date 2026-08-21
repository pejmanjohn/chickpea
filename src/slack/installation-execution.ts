import type { WebClient } from '@slack/web-api';

import type { ConfigStore } from '../config/store.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { getConfigStore, getSettingsStore } from '../config/state-backend.ts';
import {
  WORKSPACE_SLACK_INSTALLATION_ID,
  type WorkspaceInstallation,
} from '../config/types.ts';
import {
  isTransientSlackApiError,
  slackConversationsInfo,
  slackIdentityAuthTest,
} from './credentials.ts';
import {
  resolveSlackInstallationCredentials,
  type SlackCredentialResolutionDependencies,
} from './installation-credentials.ts';
import { createSlackWebClient } from './web-client.ts';
import { GatewayDeploymentClient } from './gateway/client.ts';
import { loadCredentialKeyring } from './credential-keyring.ts';
import { resolveChickpeaGatewayUrl } from './gateway/runtime.ts';
import { createGatewaySlackWebClient } from './gateway/web-client.ts';
import type { NormalizedSlackTurn } from './types.ts';
import { isDirectSlackTurn } from './work-admission.ts';

type MaybePromise<T> = T | Promise<T>;

export interface SlackInstallationReader {
  getWorkspaceInstallation(
    workspaceId: string,
  ): MaybePromise<WorkspaceInstallation | undefined>;
}

export interface SlackInstallationExecutionContext {
  workspaceId: string;
  transportMode: 'direct' | 'gateway';
  botToken?: string;
  botUserId: string;
  displayName?: string;
  client: WebClient;
}

export type SlackInstallationExecutionResolver = (
  workspaceId: string,
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
      WORKSPACE_SLACK_INSTALLATION_ID,
      env,
      options.credentialDependencies ?? options.settings,
    );
  } catch {
    throw new SlackInstallationUnavailableError(workspaceId, 'credential_resolution_failed', {
      retryable: true,
    });
  }
  if (!credentials.botToken) {
    throw new SlackInstallationUnavailableError(workspaceId, 'credentials_missing');
  }
  const auth = await slackIdentityAuthTest(credentials.botToken);
  if (!auth.ok || !auth.botUserId || !auth.teamId) {
    throw new SlackInstallationUnavailableError(
      workspaceId,
      auth.error ?? 'bot_identity_missing',
      auth.retryAfterMs === undefined ? {} : { retryAfterMs: auth.retryAfterMs },
    );
  }
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
    botToken: credentials.botToken,
    botUserId: auth.botUserId,
    ...(auth.botName ? { displayName: auth.botName } : {}),
    client: createSlackWebClient(credentials.botToken),
  };
}

export async function verifySlackInstallationTurnAccess(
  context: SlackInstallationExecutionContext,
  turn: NormalizedSlackTurn,
): Promise<void> {
  if (context.workspaceId !== turn.workspaceId) {
    throw new SlackInstallationUnavailableError(context.workspaceId, 'workspace_mismatch');
  }
  if (isDirectSlackTurn(turn)) return;
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
  let auth: Awaited<ReturnType<typeof client.auth.test>>;
  try {
    auth = await client.auth.test();
  } catch {
    throw new SlackInstallationUnavailableError(
      installation.workspaceId,
      'gateway_unreachable',
      { retryable: true },
    );
  }
  const botUserId = typeof auth.user_id === 'string' ? auth.user_id : binding.botUserId;
  const teamId = typeof auth.team_id === 'string' ? auth.team_id : binding.workspaceId;
  if (teamId !== installation.workspaceId || botUserId !== installation.botUserId) {
    throw new SlackInstallationUnavailableError(
      installation.workspaceId,
      'gateway_binding_mismatch',
    );
  }
  return {
    workspaceId: installation.workspaceId,
    transportMode: 'gateway',
    botUserId,
    client,
  };
}
