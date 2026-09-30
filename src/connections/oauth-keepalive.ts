import {
  apiOAuthSettingKeys,
  connectionAccountIdFromOAuthRef,
  connectionAccountOAuthRef,
  resolveApiOAuthAccessToken,
  type ApiOAuthProvider,
  type ApiOAuthRef,
} from '../config/api-oauth.ts';
import { mcpOAuthSettingKeys, resolveMcpOAuthAccessToken } from '../config/mcp-oauth.ts';
import type { McpSecretRef } from '../config/mcp-secrets.ts';
import { validateMcpUrl } from '../config/mcp-url.ts';
import type { OAuthRefreshTelemetryEvent } from '../config/oauth-refresh-telemetry.ts';
import { OAUTH_KEEPALIVE_AGE_MS } from '../config/oauth-shared.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { ConfigStore } from '../config/store.ts';
import { apiOAuthLifecycleDependencies } from './api-oauth-lifecycle.ts';
import { mcpOAuthLifecycleDependencies } from './mcp-oauth-lifecycle.ts';

/**
 * Credential keep-alive. Chickpea otherwise renews OAuth credentials only when
 * an Agent uses them, so a connection left idle longer than its provider's
 * refresh-token lifetime would silently stop working. This sweep renews every
 * refreshable credential that has gone OAUTH_KEEPALIVE_AGE_MS without one,
 * through the same leased, compare-and-set refresh a turn uses.
 */

export const OAUTH_KEEPALIVE_INTERVAL_MS = 10 * 60_000;
const RETRY_WINDOW_MS = 60 * 60_000;
const MAX_RENEWALS_PER_SWEEP = 10;

export function isOAuthKeepAliveMinute(scheduledTime: number): boolean {
  return new Date(scheduledTime).getUTCMinutes() % (OAUTH_KEEPALIVE_INTERVAL_MS / 60_000) === 0;
}

/**
 * Due once the credential is OAUTH_KEEPALIVE_AGE_MS old. A failed renewal
 * leaves the issue time unchanged, so it is retried on every sweep for the
 * first hour and then hourly, without any separately stored retry state.
 */
export function isOAuthKeepAliveDue(obtainedAt: number, now: number): boolean {
  const overdue = now - (obtainedAt + OAUTH_KEEPALIVE_AGE_MS);
  if (overdue < 0) return false;
  return overdue < RETRY_WINDOW_MS || overdue % RETRY_WINDOW_MS < OAUTH_KEEPALIVE_INTERVAL_MS;
}

type KeepAliveCredential =
  | { lane: 'mcp'; ref: McpSecretRef; workspaceId?: string; serverUrl: string }
  | { lane: 'api'; ref: ApiOAuthRef; workspaceId?: string; provider: ApiOAuthProvider };

export interface OAuthKeepAliveSummary {
  event: 'chickpea.oauth.keepalive';
  credentials: number;
  due: number;
  renewed: number;
  unavailable: number;
  rejected: number;
  skipped: number;
  deferred: number;
  durationMs: number;
}

export async function runOAuthKeepAliveSweep(input: {
  config: ConfigStore;
  settings: SettingsStore;
  now?: () => number;
  fetchFn?: typeof fetch;
  maxRenewals?: number;
  emit?: (event: OAuthKeepAliveSummary | OAuthRefreshTelemetryEvent) => void;
}): Promise<OAuthKeepAliveSummary> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const credentials = await listOAuthCredentials(input.config);
  const tokens = await input.settings.getSettings(credentials.map(tokenKey));
  const due = credentials.filter((credential, index) => {
    const renewal = renewalState(credential.lane, tokens[index]);
    return renewal !== undefined && isOAuthKeepAliveDue(renewal.obtainedAt, startedAt);
  });
  const limit = input.maxRenewals ?? MAX_RENEWALS_PER_SWEEP;
  const summary: OAuthKeepAliveSummary = {
    event: 'chickpea.oauth.keepalive',
    credentials: credentials.length,
    due: due.length,
    renewed: 0,
    unavailable: 0,
    rejected: 0,
    skipped: 0,
    deferred: Math.max(0, due.length - limit),
    durationMs: 0,
  };
  for (const credential of due.slice(0, limit)) {
    summary[await renew(credential, input, now)] += 1;
  }
  summary.durationMs = Math.max(0, now() - startedAt);
  try {
    (input.emit ?? ((event) => console.info(event)))(summary);
  } catch {
    // Observability must not alter credential behavior.
  }
  return summary;
}

async function renew(
  credential: KeepAliveCredential,
  input: Parameters<typeof runOAuthKeepAliveSweep>[0],
  now: () => number,
): Promise<'renewed' | 'unavailable' | 'rejected' | 'skipped'> {
  const before = await input.settings.getSetting(tokenKey(credential));
  const shared = {
    settings: input.settings,
    now,
    ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    refreshTelemetry: {
      trigger: 'keepalive' as const,
      ...(input.emit ? { emit: input.emit } : {}),
    },
  };
  const refreshIfObtainedBefore = now() - OAUTH_KEEPALIVE_AGE_MS;
  try {
    if (credential.lane === 'mcp') {
      await resolveMcpOAuthAccessToken({ ref: credential.ref, serverUrl: credential.serverUrl, refreshIfObtainedBefore }, {
        ...shared,
        ...mcpOAuthLifecycleDependencies(input.config, input.settings, credential.workspaceId),
        validateConnection: (_ref, serverUrl, _revision, attemptId) =>
          isCurrentCredential(input.config, credential, serverUrl, attemptId),
      });
    } else {
      await resolveApiOAuthAccessToken({ ref: credential.ref, provider: credential.provider, refreshIfObtainedBefore }, {
        ...shared,
        ...apiOAuthLifecycleDependencies(input.config, input.settings, credential.workspaceId),
        validateConnection: (_ref, provider, _revision, attemptId) =>
          isCurrentCredential(input.config, credential, provider, attemptId),
      });
    }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'oauth_unavailable') return 'unavailable';
    if (code === 'reauthorization_required') return 'rejected';
    return 'skipped';
  }
  // The token lease let another caller renew first; its result stands.
  return (await input.settings.getSetting(tokenKey(credential))) === before ? 'skipped' : 'renewed';
}

/** Every refreshable-lane OAuth credential that is currently expected to work. */
async function listOAuthCredentials(config: ConfigStore): Promise<KeepAliveCredential[]> {
  const credentials: KeepAliveCredential[] = [];
  for (const { workspaceId } of await config.listWorkspaceInstallations()) {
    for (const account of await config.listConnectionAccounts(workspaceId)) {
      if (account.lifecycle !== 'ready' || account.policy.kind === 'managed' ||
          account.policy.authMode !== 'oauth') continue;
      const ref = connectionAccountOAuthRef(account.id);
      if (account.policy.kind === 'mcp') {
        const validated = validateMcpUrl(account.policy.url);
        if (validated.ok) credentials.push({ lane: 'mcp', ref, workspaceId, serverUrl: validated.url });
      } else if (account.policy.oauthProvider) {
        credentials.push({ lane: 'api', ref, workspaceId, provider: account.policy.oauthProvider });
      }
    }
  }
  // Per-Agent connections that predate connection accounts.
  for (const agent of await config.listAgents()) {
    for (const server of agent.mcpServers) {
      if (!server.enabled || server.authMode !== 'oauth' || server.lifecycleStatus !== 'ready') continue;
      const validated = validateMcpUrl(server.url);
      if (validated.ok) {
        credentials.push({ lane: 'mcp', ref: { agentId: agent.id, connectionId: server.id }, serverUrl: validated.url });
      }
    }
    for (const connection of agent.apiConnections) {
      if (!connection.enabled || connection.authMode !== 'oauth' || !connection.oauthProvider ||
          (connection.lifecycleStatus !== undefined && connection.lifecycleStatus !== 'ready')) continue;
      credentials.push({
        lane: 'api',
        ref: { agentId: agent.id, connectionId: connection.id },
        provider: connection.oauthProvider,
      });
    }
  }
  return credentials;
}

/** The credential's connection still exists, is ready, and targets the same server. */
async function isCurrentCredential(
  config: ConfigStore,
  credential: KeepAliveCredential,
  target: string,
  attemptId: string | undefined,
): Promise<boolean> {
  const accountId = connectionAccountIdFromOAuthRef(credential.ref);
  if (accountId) {
    const account = credential.workspaceId === undefined
      ? undefined
      : (await config.listConnectionAccounts(credential.workspaceId)).find(({ id }) => id === accountId);
    if (!account || account.lifecycle !== 'ready' || account.policy.kind === 'managed' ||
        account.policy.authMode !== 'oauth' ||
        (attemptId !== undefined && account.policy.oauthAttemptId !== attemptId)) return false;
    if (account.policy.kind === 'mcp') {
      const validated = validateMcpUrl(account.policy.url);
      return credential.lane === 'mcp' && validated.ok && validated.url === target;
    }
    return credential.lane === 'api' && account.policy.oauthProvider === target;
  }
  try {
    const agent = await config.getAgent(credential.ref.agentId);
    if (credential.lane === 'mcp') {
      const server = agent.mcpServers.find(({ id }) => id === credential.ref.connectionId);
      const validated = server ? validateMcpUrl(server.url) : undefined;
      return !!server && server.enabled && server.authMode === 'oauth' &&
        server.lifecycleStatus === 'ready' && !!validated?.ok && validated.url === target;
    }
    const connection = agent.apiConnections.find(({ id }) => id === credential.ref.connectionId);
    return !!connection && connection.enabled && connection.authMode === 'oauth' &&
      connection.oauthProvider === target;
  } catch {
    return false;
  }
}

function tokenKey(credential: KeepAliveCredential): string {
  return credential.lane === 'mcp'
    ? mcpOAuthSettingKeys(credential.ref)[2]
    : apiOAuthSettingKeys(credential.ref)[2];
}

/**
 * Issue time of a credential worth keeping alive: one with a refresh token and
 * an expiring access token. Unreadable records are left to the turn path,
 * which reports them.
 */
function renewalState(
  lane: KeepAliveCredential['lane'],
  raw: string | undefined,
): { obtainedAt: number } | undefined {
  if (!raw) return undefined;
  try {
    const bundle: unknown = JSON.parse(raw);
    if (!bundle || typeof bundle !== 'object') return undefined;
    const record = bundle as Record<string, unknown>;
    const tokens = (lane === 'mcp' ? record.tokens : record) as Record<string, unknown> | undefined;
    const refreshToken = lane === 'mcp' ? tokens?.refresh_token : tokens?.refreshToken;
    const expiresIn = lane === 'mcp' ? tokens?.expires_in : tokens?.expiresIn;
    if (typeof refreshToken !== 'string' || typeof expiresIn !== 'number' ||
        typeof record.obtainedAt !== 'number') return undefined;
    return { obtainedAt: record.obtainedAt };
  } catch {
    return undefined;
  }
}
