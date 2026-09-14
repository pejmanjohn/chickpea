import { isRecord } from '../security/content-validation.ts';
import { decodeBase64Url, encodeBase64Url } from '../security/base64url.ts';
import { applicationIdentity } from '../release/identity.ts';
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl,
} from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthMetadataSchema,
  OAuthTokensSchema,
  OpenIdProviderDiscoveryMetadataSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import { UnknownAgentError } from './errors.ts';
import { AGENT_ID_PATTERN } from './agent-id.ts';
import {
  stageMcpSecretCleanup,
  type McpSecretRef,
} from './mcp-secrets.ts';
import {
  configuredMcpOAuthClientDescriptor,
  ConfiguredMcpOAuthClientError,
  getConfiguredMcpOAuthClient,
  isConfiguredMcpOAuthClientOrigin,
  isConfiguredMcpOAuthClientGeneration,
  type ConfiguredMcpOAuthClient,
} from './mcp-oauth-clients.ts';
import { createMcpGuardedFetch, validateMcpUrl } from './mcp-url.ts';
import {
  isOAuthAttemptId,
  LEASE_ATTEMPTS,
  LEASE_MAX_RETRY_MS,
  LEASE_RETRY_MS,
  LEASE_TTL_MS,
  oauthNow,
  oauthRandomId,
  oauthSleep,
  parseOAuthLease,
  PENDING_TTL_MS,
  publishFencedOAuthState,
  REFRESH_SKEW_MS,
  type StoredOAuthLease,
  validateOAuthAttemptId,
} from './oauth-shared.ts';
import type { SettingsStore } from './settings-store.ts';
import type { ConfigStore } from './store.ts';
import {
  parseOAuthAuthorizationAuthority,
  type OAuthAuthorizationAuthority,
} from './oauth-authorization.ts';

const OAUTH_FETCH_TIMEOUT_MS = 8_000;
const CONNECTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONFIGURED_CLIENT_PUBLISH_ATTEMPTS = 16;
const MCP_OAUTH_USER_AGENT = `Chickpea/${applicationIdentity.version}`;

type McpOAuthErrorCode =
  | 'authorization_expired'
  | 'connection_missing'
  | 'invalid_state'
  | 'oauth_attempt_superseded'
  | 'oauth_configuration_required'
  | 'oauth_discovery_failed'
  | 'oauth_storage_invalid'
  | 'oauth_unavailable'
  | 'reauthorization_required';

interface McpOAuthCallbackContext {
  ref: McpSecretRef;
  accountRevision?: number;
  oauthAttemptId?: string;
  returnAgentId?: string;
}

interface McpOAuthErrorOptions extends ErrorOptions {
  callbackContext?: McpOAuthCallbackContext;
}

export class McpOAuthError extends Error {
  readonly callbackContext?: McpOAuthCallbackContext;

  constructor(
    readonly code: McpOAuthErrorCode,
    message: string,
    options?: McpOAuthErrorOptions,
  ) {
    super(message, options);
    this.name = 'McpOAuthError';
    if (options?.callbackContext) this.callbackContext = options.callbackContext;
  }
}

export interface McpOAuthDependencies {
  settings: SettingsStore;
  fetchFn?: typeof fetch;
  now?: () => number;
  randomId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  validateConnection?: (
    ref: McpSecretRef,
    serverUrl: string,
    accountRevision?: number,
    oauthAttemptId?: string,
  ) => boolean | Promise<boolean>;
  validateAuthorization?: (
    authority: OAuthAuthorizationAuthority | undefined,
    ref: McpSecretRef,
  ) => boolean | Promise<boolean>;
  onReauthorizationRequired?: (
    ref: McpSecretRef,
    serverUrl: string,
  ) => void | Promise<void>;
}

export interface StartMcpOAuthInput {
  ref: McpSecretRef;
  serverUrl: string;
  callbackUrl: string;
  scope?: string;
  /** Admin Agent page that initiated this Agent-owned connection flow. */
  returnAgentId?: string;
  /** Agent-owned connection revision that fences this authorization attempt. */
  accountRevision?: number;
  /** Stable attempt identity retained after the account revision advances. */
  oauthAttemptId?: string;
  /** Management setup resumed after the provider returns to the fixed callback. */
  setupOperationId?: string;
  authorizationAuthority?: OAuthAuthorizationAuthority;
}

export interface CompleteMcpOAuthInput {
  code: string;
  state: string;
}

export interface ResolveMcpOAuthAccessInput {
  ref: McpSecretRef;
  serverUrl: string;
}

interface StoredClient {
  authorizationServerUrl: string;
  callbackUrl: string;
  clientInformation: OAuthClientInformationMixed;
  scope?: string;
  configurationGeneration?: string;
}

interface PendingAuthorization {
  state: string;
  expiresAt: number;
  serverUrl: string;
  callbackUrl: string;
  authorizationServerUrl: string;
  metadata: AuthorizationServerMetadata;
  resource: string;
  clientInformation: OAuthClientInformationMixed;
  returnAgentId?: string;
  accountRevision?: number;
  oauthAttemptId?: string;
  setupOperationId?: string;
  configurationGeneration?: string;
  authorizationAuthority?: OAuthAuthorizationAuthority;
}

interface StoredTokenBundle {
  serverUrl: string;
  authorizationServerUrl: string;
  metadata: AuthorizationServerMetadata;
  resource: string;
  clientInformation: OAuthClientInformationMixed;
  tokens: OAuthTokens;
  obtainedAt: number;
  accountRevision?: number;
  oauthAttemptId?: string;
  configurationGeneration?: string;
}

export function mcpOAuthSettingKeys(ref: McpSecretRef): [
  client: string,
  pending: string,
  tokens: string,
  registrationLease: string,
  refreshLease: string,
] {
  const prefix = `mcp.${ref.agentId}.${ref.connectionId}.oauth`;
  return [
    `${prefix}.client`,
    `${prefix}.pending`,
    `${prefix}.tokens`,
    `${prefix}.registration-lease`,
    `${prefix}.refresh-lease`,
  ];
}

export function createMcpOAuthClientMetadata(
  callbackUrl: string,
): OAuthClientMetadata {
  validateCallbackUrl(callbackUrl);
  return {
    redirect_uris: [callbackUrl],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: 'Chickpea',
  };
}

export function createMcpOAuthClientMetadataDocument(
  documentUrl: string,
): OAuthClientMetadata & { client_id: string } {
  const url = new URL(documentUrl);
  if (
    url.protocol !== 'https:' ||
    url.pathname !== '/.well-known/oauth-client-metadata.json' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new McpOAuthError(
      'oauth_discovery_failed',
      'OAuth client metadata document URL is invalid',
    );
  }
  const callbackUrl = new URL('/oauth/callback', url).href;
  return {
    client_id: url.href,
    ...createMcpOAuthClientMetadata(callbackUrl),
  };
}

export async function isCurrentMcpOAuthConnection(
  store: Pick<ConfigStore, 'getAgent'>,
  ref: McpSecretRef,
  serverUrl: string,
): Promise<boolean> {
  try {
    const connection = (await store.getAgent(ref.agentId)).mcpServers.find(
      (server) => server.id === ref.connectionId,
    );
    const validated = connection ? validateMcpUrl(connection.url) : undefined;
    return (
      connection?.authMode === 'oauth' &&
      validated?.ok === true &&
      validated.url === serverUrl
    );
  } catch (error) {
    if (error instanceof UnknownAgentError) return false;
    throw error;
  }
}

export async function startMcpOAuthAuthorization(
  input: StartMcpOAuthInput,
  dependencies: McpOAuthDependencies,
): Promise<{ authorizationUrl: URL; state: string }> {
  validateRef(input.ref);
  const serverUrl = normalizedServerUrl(input.serverUrl);
  const callbackUrl = validateCallbackUrl(input.callbackUrl).href;
  if (input.returnAgentId !== undefined && !AGENT_ID_PATTERN.test(input.returnAgentId)) {
    throw new McpOAuthError('oauth_unavailable', 'OAuth return Agent is invalid');
  }
  if (input.accountRevision !== undefined &&
      (!Number.isSafeInteger(input.accountRevision) || input.accountRevision < 1)) {
    throw new McpOAuthError('oauth_unavailable', 'OAuth account revision is invalid');
  }
  validateOAuthAttemptId(
    input.oauthAttemptId,
    () => new McpOAuthError('oauth_unavailable', 'OAuth attempt identity is invalid'),
  );
  validateSetupOperationId(input.setupOperationId);
  await requireCurrentAuthorization(input.ref, input.authorizationAuthority, dependencies);
  const settings = dependencies.settings;
  const oauthKeys = mcpOAuthSettingKeys(input.ref);
  const [, pendingKey] = oauthKeys;
  await stageMcpSecretCleanup(
    input.ref.agentId,
    oauthKeys,
    settings,
  );

  await requireCurrentConnection(
    input.ref, serverUrl, dependencies, input.accountRevision, input.oauthAttemptId,
  );

  // A reviewed configured-client server must never fall through to CIMD or
  // dynamic registration. Resolve installation state before the first
  // provider request so missing setup is an actionable local failure.
  const configuredClient = await configuredClientForStart(serverUrl, dependencies);

  const fetchFn = guardedOAuthFetch(dependencies);
  let resourceMetadata: OAuthProtectedResourceMetadata;
  let metadata: AuthorizationServerMetadata | undefined;
  let authorizationServerUrl: string;
  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(
      serverUrl,
      undefined,
      fetchFn,
    );
    authorizationServerUrl = resourceMetadata.authorization_servers?.[0] ?? '';
    if (!authorizationServerUrl) {
      throw new Error('Protected Resource Metadata has no authorization server');
    }
    if (configuredClient &&
        new URL(authorizationServerUrl).href !== configuredClient.authorizationServerUrl) {
      throw new Error('Protected Resource Metadata returned an untrusted authorization server');
    }
    metadata = await discoverAuthorizationServerMetadata(authorizationServerUrl, {
      fetchFn,
    });
  } catch (error) {
    throw new McpOAuthError(
      'oauth_discovery_failed',
      'MCP OAuth metadata discovery failed',
      { cause: error },
    );
  }
  if (!metadata) {
    throw new McpOAuthError(
      'oauth_discovery_failed',
      'Authorization Server Metadata is required',
    );
  }
  validateAuthorizationServerMetadata(authorizationServerUrl, metadata);
  if (configuredClient &&
      !metadata.token_endpoint_auth_methods_supported?.includes('none')) {
    throw new McpOAuthError(
      'oauth_discovery_failed',
      'Authorization server does not support the configured public client',
    );
  }
  if ((configuredClient && !metadata.code_challenge_methods_supported?.includes('S256')) ||
      (metadata.code_challenge_methods_supported &&
        !metadata.code_challenge_methods_supported.includes('S256'))) {
    throw new McpOAuthError(
      'oauth_discovery_failed',
      'Authorization server does not advertise PKCE S256',
    );
  }

  const requestedResource = resourceUrlFromServerUrl(serverUrl);
  if (configuredClient && new URL(resourceMetadata.resource).href !== serverUrl) {
    throw new McpOAuthError(
      'oauth_discovery_failed',
      'Protected resource metadata does not match the reviewed MCP server',
    );
  }
  if (
    !checkResourceAllowed({
      requestedResource,
      configuredResource: resourceMetadata.resource,
    })
  ) {
    throw new McpOAuthError(
      'oauth_discovery_failed',
      'Protected resource metadata does not match the MCP server',
    );
  }
  const resource = new URL(resourceMetadata.resource);
  const clientInformation = await resolveClientInformation(
    input.ref,
    authorizationServerUrl,
    callbackUrl,
    metadata,
    input.scope,
    dependencies,
    configuredClient,
  );
  const state = encodeState(input.ref, oauthRandomId(dependencies));
  const { authorizationUrl, codeVerifier } = await startAuthorization(
    authorizationServerUrl,
    {
      metadata,
      clientInformation,
      redirectUrl: callbackUrl,
      ...(input.scope ? { scope: input.scope } : {}),
      state,
      resource,
    },
  );
  try {
    await requireConfiguredClientGeneration(
      serverUrl, configuredClient?.generation, dependencies,
    );
  } catch (error) {
    if (configuredClient && isConfiguredClientDrift(error)) {
      await invalidateConfiguredMcpOAuthAuthorization(
        input.ref, settings, configuredClient.generation,
      );
    }
    throw error;
  }
  const pending: PendingAuthorization = {
    state,
    expiresAt: oauthNow(dependencies) + PENDING_TTL_MS,
    serverUrl,
    callbackUrl,
    authorizationServerUrl,
    metadata,
    resource: resourceMetadata.resource,
    clientInformation,
    ...(input.returnAgentId ? { returnAgentId: input.returnAgentId } : {}),
    ...(input.accountRevision !== undefined ? { accountRevision: input.accountRevision } : {}),
    ...(input.oauthAttemptId ? { oauthAttemptId: input.oauthAttemptId } : {}),
    ...(input.setupOperationId ? { setupOperationId: input.setupOperationId } : {}),
    ...(configuredClient
      ? { configurationGeneration: configuredClient.generation }
      : {}),
    ...(input.authorizationAuthority
      ? { authorizationAuthority: input.authorizationAuthority }
      : {}),
  };
  const storedPending = { ...pending, codeVerifier };
  await publishFencedOAuthState(
    pendingKey,
    storedPending,
    settings,
    {
      parseCurrent: parsePendingAuthorization,
      superseded: attemptSuperseded,
      unavailable: () =>
        new McpOAuthError('oauth_unavailable', 'Could not publish OAuth authorization'),
    },
  );
  try {
    await requireConfiguredClientGeneration(
      serverUrl, configuredClient?.generation, dependencies,
    );
    await requireCurrentConnection(
      input.ref, serverUrl, dependencies, input.accountRevision, input.oauthAttemptId,
    );
  } catch (error) {
    if (configuredClient &&
        (isConnectionMissing(error) || isConfiguredClientDrift(error))) {
      await invalidateConfiguredMcpOAuthAuthorization(
        input.ref, settings, configuredClient.generation,
      );
    }
    if (isConnectionMissing(error) && !configuredClient) {
      await deleteMcpOAuthSettings(input.ref, settings);
    }
    throw error;
  }
  return { authorizationUrl, state };
}

export async function completeMcpOAuthAuthorization(
  input: CompleteMcpOAuthInput,
  dependencies: McpOAuthDependencies,
): Promise<{
  ref: McpSecretRef;
  accountRevision?: number;
  oauthAttemptId?: string;
  returnAgentId?: string;
  authorizationAuthority?: OAuthAuthorizationAuthority;
}> {
  const { ref, pending } = await consumePendingAuthorization(
    input.state,
    dependencies,
  );
  try {
    const settings = dependencies.settings;
    await requireConfiguredClientGeneration(
      pending.serverUrl, pending.configurationGeneration, dependencies,
    );
    await requireCurrentAuthorization(ref, pending.authorizationAuthority, dependencies);
    await requireCurrentConnection(
      ref, pending.serverUrl, dependencies, pending.accountRevision, pending.oauthAttemptId,
    );

    let tokens: OAuthTokens;
    try {
      tokens = await exchangeAuthorization(pending.authorizationServerUrl, {
        metadata: pending.metadata,
        clientInformation: pending.clientInformation,
        authorizationCode: input.code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.callbackUrl,
        resource: new URL(pending.resource),
        fetchFn: guardedOAuthFetch(dependencies),
      });
    } catch (error) {
      throw new McpOAuthError(
        'oauth_unavailable',
        'OAuth authorization-code exchange failed',
        { cause: error },
      );
    }
    assertBearerTokens(tokens);
    await requireConfiguredClientGeneration(
      pending.serverUrl, pending.configurationGeneration, dependencies,
    );
    await requireCurrentAuthorization(ref, pending.authorizationAuthority, dependencies);
    const [, , tokenKey] = mcpOAuthSettingKeys(ref);
    const bundle: StoredTokenBundle = {
      serverUrl: pending.serverUrl,
      authorizationServerUrl: pending.authorizationServerUrl,
      metadata: pending.metadata,
      resource: pending.resource,
      clientInformation: pending.clientInformation,
      tokens,
      obtainedAt: oauthNow(dependencies),
      ...(pending.accountRevision !== undefined
        ? { accountRevision: pending.accountRevision }
        : {}),
      ...(pending.oauthAttemptId ? { oauthAttemptId: pending.oauthAttemptId } : {}),
      ...(pending.configurationGeneration
        ? { configurationGeneration: pending.configurationGeneration }
        : {}),
    };
    await publishFencedOAuthState(tokenKey, bundle, settings, {
      parseCurrent: parseStoredTokenBundle,
      superseded: attemptSuperseded,
      unavailable: () =>
        new McpOAuthError('oauth_unavailable', 'Could not publish OAuth credentials'),
    });

    try {
      await requireConfiguredClientGeneration(
        pending.serverUrl, pending.configurationGeneration, dependencies,
      );
      await requireCurrentConnection(
        ref, pending.serverUrl, dependencies, pending.accountRevision, pending.oauthAttemptId,
      );
    } catch (error) {
      if (isConnectionMissing(error)) {
        if (pending.configurationGeneration === undefined) {
          await deleteMcpOAuthSettings(ref, settings);
        } else {
          await deleteSettingIfCurrent(tokenKey, JSON.stringify(bundle), settings);
        }
      } else if (isConfiguredClientDrift(error)) {
        await deleteSettingIfCurrent(tokenKey, JSON.stringify(bundle), settings);
      }
      throw error;
    }
    return {
      ref,
      ...(pending.accountRevision !== undefined
        ? { accountRevision: pending.accountRevision }
        : {}),
      ...(pending.oauthAttemptId ? { oauthAttemptId: pending.oauthAttemptId } : {}),
      ...(pending.returnAgentId ? { returnAgentId: pending.returnAgentId } : {}),
      ...(pending.authorizationAuthority
        ? { authorizationAuthority: pending.authorizationAuthority }
        : {}),
    };
  } catch (error) {
    if (pending.configurationGeneration && isConfiguredClientDrift(error)) {
      await invalidateConfiguredMcpOAuthAuthorization(
        ref, dependencies.settings, pending.configurationGeneration,
      );
    }
    const oauthError = error instanceof McpOAuthError
      ? error
      : new McpOAuthError('oauth_unavailable', 'OAuth completion failed', { cause: error });
    throw new McpOAuthError(oauthError.code, oauthError.message, {
      cause: oauthError,
      callbackContext: {
        ref,
        ...(pending.accountRevision !== undefined
          ? { accountRevision: pending.accountRevision }
          : {}),
        ...(pending.oauthAttemptId ? { oauthAttemptId: pending.oauthAttemptId } : {}),
        ...(pending.returnAgentId ? { returnAgentId: pending.returnAgentId } : {}),
      },
    });
  }
}

export async function cancelMcpOAuthAuthorization(
  state: string,
  dependencies: McpOAuthDependencies,
): Promise<{ ref: McpSecretRef; returnAgentId?: string }> {
  const { ref, pending } = await consumePendingAuthorization(state, dependencies);
  return { ref, ...(pending.returnAgentId ? { returnAgentId: pending.returnAgentId } : {}) };
}

export async function resolveMcpOAuthAccessToken(
  input: ResolveMcpOAuthAccessInput,
  dependencies: McpOAuthDependencies,
): Promise<string> {
  validateRef(input.ref);
  const serverUrl = normalizedServerUrl(input.serverUrl);
  const [, , tokenKey, , refreshLeaseKey] = mcpOAuthSettingKeys(input.ref);
  const raw = await dependencies.settings.getSetting(tokenKey);
  if (!raw) {
    await configuredClientForStart(serverUrl, dependencies);
    throw new McpOAuthError(
      'reauthorization_required',
      'MCP OAuth connection is not authorized',
    );
  }
  const initial = parseStoredTokenBundle(raw);
  assertTokenResource(initial, serverUrl);
  await requireCurrentConnection(
    input.ref, serverUrl, dependencies, undefined, initial.oauthAttemptId,
  );
  await requireStoredTokenConfiguration(initial, raw, tokenKey, dependencies);
  if (!tokenNeedsRefresh(initial, oauthNow(dependencies))) {
    await requireStoredTokenConfiguration(initial, raw, tokenKey, dependencies);
    return initial.tokens.access_token;
  }
  if (!initial.tokens.refresh_token) {
    if (!tokenHardExpired(initial, oauthNow(dependencies))) {
      await requireStoredTokenConfiguration(initial, raw, tokenKey, dependencies);
      return initial.tokens.access_token;
    }
    throw new McpOAuthError(
      'reauthorization_required',
      'MCP OAuth access expired without a refresh token',
    );
  }

  const leaseRaw = await dependencies.settings.getSetting(refreshLeaseKey);
  const lease = leaseRaw ? parseLease(leaseRaw) : undefined;
  if (
    lease &&
    lease.expiresAt > oauthNow(dependencies) &&
    !tokenHardExpired(initial, oauthNow(dependencies))
  ) {
    await requireStoredTokenConfiguration(initial, raw, tokenKey, dependencies);
    return initial.tokens.access_token;
  }

  return withLease(
    refreshLeaseKey,
    dependencies,
    async () => {
      const currentRaw = await dependencies.settings.getSetting(tokenKey);
      if (!currentRaw) {
        throw new McpOAuthError(
          'reauthorization_required',
          'MCP OAuth connection is not authorized',
        );
      }
      const current = parseStoredTokenBundle(currentRaw);
      assertTokenResource(current, serverUrl);
      await requireCurrentConnection(
        input.ref, serverUrl, dependencies, undefined, current.oauthAttemptId,
      );
      await requireStoredTokenConfiguration(current, currentRaw, tokenKey, dependencies);
      if (!tokenNeedsRefresh(current, oauthNow(dependencies))) {
        await requireStoredTokenConfiguration(current, currentRaw, tokenKey, dependencies);
        return current.tokens.access_token;
      }
      const refreshToken = current.tokens.refresh_token;
      if (!refreshToken) {
        if (!tokenHardExpired(current, oauthNow(dependencies))) {
          await requireStoredTokenConfiguration(current, currentRaw, tokenKey, dependencies);
          return current.tokens.access_token;
        }
        throw new McpOAuthError(
          'reauthorization_required',
          'MCP OAuth access expired without a refresh token',
        );
      }

      let tokens: OAuthTokens;
      try {
        tokens = await refreshAuthorization(current.authorizationServerUrl, {
          metadata: current.metadata,
          clientInformation: current.clientInformation,
          refreshToken,
          resource: new URL(current.resource),
          fetchFn: guardedOAuthFetch(dependencies),
        });
      } catch (error) {
        await requireStoredTokenConfiguration(current, currentRaw, tokenKey, dependencies);
        if (
          error instanceof InvalidGrantError ||
          (isRecord(error) && error.errorCode === 'invalid_grant')
        ) {
          const deleted = await dependencies.settings.applySettingsPatch({
            expected: { key: tokenKey, value: currentRaw },
            delete: [tokenKey],
          });
          if (!deleted) {
            const winner = await dependencies.settings.getSetting(tokenKey);
            if (winner) {
              const winnerBundle = parseStoredTokenBundle(winner);
              assertTokenResource(winnerBundle, serverUrl);
              await requireCurrentConnection(
                input.ref, serverUrl, dependencies, undefined, winnerBundle.oauthAttemptId,
              );
              await requireStoredTokenConfiguration(
                winnerBundle, winner, tokenKey, dependencies,
              );
              return winnerBundle.tokens.access_token;
            }
          }
          await notifyReauthorizationRequired(input.ref, serverUrl, dependencies);
          throw new McpOAuthError(
            'reauthorization_required',
            'MCP OAuth refresh was rejected',
            { cause: error },
          );
        }
        throw new McpOAuthError('oauth_unavailable', 'MCP OAuth refresh failed', {
          cause: error,
        });
      }
      assertBearerTokens(tokens);
      await requireStoredTokenConfiguration(current, currentRaw, tokenKey, dependencies);
      // OAuth servers may rotate a refresh token, but they are allowed to omit
      // one when the existing refresh token remains valid. Preserve the prior
      // value (and unchanged scope metadata) so the next expiry can still
      // refresh instead of forcing an unnecessary reconnect.
      const refreshedTokens: OAuthTokens = {
        ...tokens,
        ...(tokens.refresh_token === undefined && current.tokens.refresh_token !== undefined
          ? { refresh_token: current.tokens.refresh_token }
          : {}),
        ...(tokens.scope === undefined && current.tokens.scope !== undefined
          ? { scope: current.tokens.scope }
          : {}),
      };
      const refreshed: StoredTokenBundle = {
        ...current,
        tokens: refreshedTokens,
        obtainedAt: oauthNow(dependencies),
      };
      const refreshedRaw = JSON.stringify(refreshed);
      await requireStoredTokenConfiguration(current, currentRaw, tokenKey, dependencies);
      const stored = await dependencies.settings.applySettingsPatch({
        expected: { key: tokenKey, value: currentRaw },
        set: [{ key: tokenKey, value: refreshedRaw }],
      });
      if (!stored) {
        const winner = await dependencies.settings.getSetting(tokenKey);
        if (!winner) {
          throw new McpOAuthError(
            'reauthorization_required',
            'MCP OAuth connection is not authorized',
          );
        }
        const winnerBundle = parseStoredTokenBundle(winner);
        assertTokenResource(winnerBundle, serverUrl);
        await requireCurrentConnection(
          input.ref, serverUrl, dependencies, undefined, winnerBundle.oauthAttemptId,
        );
        await requireStoredTokenConfiguration(winnerBundle, winner, tokenKey, dependencies);
        return winnerBundle.tokens.access_token;
      }
      try {
        await requireStoredTokenConfiguration(refreshed, refreshedRaw, tokenKey, dependencies);
        await requireCurrentConnection(
          input.ref, serverUrl, dependencies, undefined, refreshed.oauthAttemptId,
        );
      } catch (error) {
        if (isConnectionMissing(error)) {
          if (refreshed.configurationGeneration === undefined) {
            await deleteMcpOAuthSettings(input.ref, dependencies.settings);
          } else {
            await deleteSettingIfCurrent(tokenKey, refreshedRaw, dependencies.settings);
          }
        } else if (isConfiguredClientDrift(error)) {
          await deleteSettingIfCurrent(tokenKey, refreshedRaw, dependencies.settings);
        }
        throw error;
      }
      await requireStoredTokenConfiguration(refreshed, refreshedRaw, tokenKey, dependencies);
      return refreshedTokens.access_token;
    },
  );
}

async function notifyReauthorizationRequired(
  ref: McpSecretRef,
  serverUrl: string,
  dependencies: McpOAuthDependencies,
): Promise<void> {
  try {
    await dependencies.onReauthorizationRequired?.(ref, serverUrl);
  } catch {
    // Token deletion is authoritative. A cosmetic lifecycle update must never
    // turn a rejected grant into a retry loop or preserve unusable credentials.
    console.warn('[chickpea] Could not update MCP OAuth reconnection status');
  }
}

export async function deleteMcpOAuthSettings(
  ref: McpSecretRef,
  settings: SettingsStore,
): Promise<void> {
  await settings.applySettingsPatch({ delete: mcpOAuthSettingKeys(ref) });
}

/** Clear authorization state while preserving reusable OAuth client registration. */
export async function invalidateMcpOAuthAuthorization(
  ref: McpSecretRef,
  settings: SettingsStore,
): Promise<void> {
  const [, pending, tokens, , refreshLease] = mcpOAuthSettingKeys(ref);
  await settings.applySettingsPatch({ delete: [pending, tokens, refreshLease] });
}

/**
 * Eager cleanup after an installation client change. Every delete is fenced by
 * the stale generation and exact raw value, so a concurrent reconnect using
 * the replacement configuration is preserved. Generation-less leases remain
 * bounded by their normal TTL rather than risking deletion of a newer lease.
 */
export async function invalidateConfiguredMcpOAuthAuthorization(
  ref: McpSecretRef,
  settings: SettingsStore,
  staleGeneration: string,
): Promise<void> {
  validateRef(ref);
  if (!isConfiguredMcpOAuthClientGeneration(staleGeneration)) {
    throw new McpOAuthError('oauth_storage_invalid', 'OAuth client generation is invalid');
  }
  const [clientKey, pendingKey, tokenKey] = mcpOAuthSettingKeys(ref);
  for (const key of [clientKey, pendingKey, tokenKey]) {
    const raw = await settings.getSetting(key);
    if (!raw) continue;
    if (storedConfigurationGeneration(raw) !== staleGeneration) continue;
    await deleteSettingIfCurrent(key, raw, settings);
  }
}

function storedConfigurationGeneration(raw: string): string | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) ||
        !isConfiguredMcpOAuthClientGeneration(value.configurationGeneration)) {
      return undefined;
    }
    return value.configurationGeneration;
  } catch {
    return undefined;
  }
}

async function resolveClientInformation(
  ref: McpSecretRef,
  authorizationServerUrl: string,
  callbackUrl: string,
  metadata: AuthorizationServerMetadata,
  scope: string | undefined,
  dependencies: McpOAuthDependencies,
  configuredClient: ConfiguredMcpOAuthClient | undefined,
): Promise<OAuthClientInformationMixed> {
  const [clientKey, , , registrationLeaseKey] = mcpOAuthSettingKeys(ref);
  if (configuredClient) {
    const clientInformation: OAuthClientInformationMixed = {
      client_id: configuredClient.clientId,
    };
    const record: StoredClient = {
      authorizationServerUrl,
      callbackUrl,
      clientInformation,
      ...(scope ? { scope } : {}),
      configurationGeneration: configuredClient.generation,
    };
    await publishConfiguredClientRecord(
      clientKey, record, configuredClient, dependencies,
    );
    return clientInformation;
  }
  const clientMetadataUrl = new URL(
    '/.well-known/oauth-client-metadata.json',
    callbackUrl,
  ).href;
  if (
    metadata.client_id_metadata_document_supported === true &&
    new URL(clientMetadataUrl).protocol === 'https:'
  ) {
    const clientInformation = { client_id: clientMetadataUrl };
    const record: StoredClient = {
      authorizationServerUrl,
      callbackUrl,
      clientInformation,
      ...(scope ? { scope } : {}),
    };
    await dependencies.settings.setSetting(clientKey, JSON.stringify(record));
    return clientInformation;
  }

  return withLease(registrationLeaseKey, dependencies, async () => {
    const raw = await dependencies.settings.getSetting(clientKey);
    if (raw) {
      const stored = parseStoredClient(raw);
      if (
        stored.authorizationServerUrl === authorizationServerUrl &&
        stored.callbackUrl === callbackUrl &&
        stored.scope === scope &&
        !clientInformationExpired(stored.clientInformation, oauthNow(dependencies))
      ) {
        return stored.clientInformation;
      }
    }
    let clientInformation: OAuthClientInformationMixed;
    try {
      clientInformation = await registerClient(authorizationServerUrl, {
        metadata,
        clientMetadata: createMcpOAuthClientMetadata(callbackUrl),
        ...(scope ? { scope } : {}),
        fetchFn: guardedOAuthFetch(dependencies),
      });
    } catch (error) {
      throw new McpOAuthError(
        'oauth_unavailable',
        'OAuth dynamic client registration failed',
        { cause: error },
      );
    }
    const record: StoredClient = {
      authorizationServerUrl,
      callbackUrl,
      clientInformation,
      ...(scope ? { scope } : {}),
    };
    await dependencies.settings.setSetting(clientKey, JSON.stringify(record));
    return clientInformation;
  });
}

async function consumePendingAuthorization(
  state: string,
  dependencies: McpOAuthDependencies,
): Promise<{
  ref: McpSecretRef;
  pending: PendingAuthorization & { codeVerifier: string };
}> {
  const ref = decodeStateRef(state);
  const settings = dependencies.settings;
  const [, pendingKey] = mcpOAuthSettingKeys(ref);
  const raw = await settings.getSetting(pendingKey);
  if (!raw) {
    throw new McpOAuthError('invalid_state', 'OAuth state is missing or already used');
  }
  const pending = parsePendingAuthorization(raw);
  if (pending.state !== state) {
    throw new McpOAuthError('invalid_state', 'OAuth state is invalid or expired');
  }
  if (pending.expiresAt <= oauthNow(dependencies)) {
    await settings.applySettingsPatch({
      expected: { key: pendingKey, value: raw },
      delete: [pendingKey],
    });
    throw new McpOAuthError('invalid_state', 'OAuth state is invalid or expired');
  }
  const consumed = await settings.applySettingsPatch({
    expected: { key: pendingKey, value: raw },
    delete: [pendingKey],
  });
  if (!consumed) {
    throw new McpOAuthError('invalid_state', 'OAuth state is missing or already used');
  }
  return { ref, pending };
}

async function withLease<T>(
  key: string,
  dependencies: McpOAuthDependencies,
  operation: () => Promise<T>,
): Promise<T> {
  const owner = oauthRandomId(dependencies);
  const settings = dependencies.settings;
  let retryDelay = LEASE_RETRY_MS;
  for (let attempt = 0; attempt < LEASE_ATTEMPTS; attempt += 1) {
    const currentRaw = await settings.getSetting(key);
    const current = currentRaw ? parseLease(currentRaw) : undefined;
    if (!current || current.expiresAt <= oauthNow(dependencies)) {
      const leaseRaw = JSON.stringify({
        owner,
        expiresAt: oauthNow(dependencies) + LEASE_TTL_MS,
      } satisfies StoredOAuthLease);
      const acquired = await settings.applySettingsPatch({
        expected: { key, value: currentRaw ?? null },
        set: [{ key, value: leaseRaw }],
      });
      if (acquired) {
        try {
          return await operation();
        } finally {
          await settings.applySettingsPatch({
            expected: { key, value: leaseRaw },
            delete: [key],
          });
        }
      }
    }
    await oauthSleep(dependencies, retryDelay);
    retryDelay = Math.min(retryDelay * 2, LEASE_MAX_RETRY_MS);
  }
  throw new McpOAuthError('oauth_unavailable', 'OAuth operation is already in progress');
}

function tokenNeedsRefresh(bundle: StoredTokenBundle, currentTime: number): boolean {
  if (bundle.tokens.expires_in === undefined) return false;
  return (
    bundle.obtainedAt + bundle.tokens.expires_in * 1_000 <=
    currentTime + REFRESH_SKEW_MS
  );
}

function tokenHardExpired(bundle: StoredTokenBundle, currentTime: number): boolean {
  if (bundle.tokens.expires_in === undefined) return false;
  return bundle.obtainedAt + bundle.tokens.expires_in * 1_000 <= currentTime;
}

function clientInformationExpired(
  clientInformation: OAuthClientInformationMixed,
  currentTime: number,
): boolean {
  const expiresAt = clientInformation.client_secret_expires_at;
  return (
    expiresAt !== undefined &&
    expiresAt !== 0 &&
    expiresAt <= Math.floor(currentTime / 1_000)
  );
}

async function configuredClientForStart(
  serverUrl: string,
  dependencies: McpOAuthDependencies,
): Promise<ConfiguredMcpOAuthClient | undefined> {
  if (!configuredMcpOAuthClientDescriptor(serverUrl)) return undefined;
  let configured: ConfiguredMcpOAuthClient | undefined;
  try {
    configured = await getConfiguredMcpOAuthClient(serverUrl, dependencies.settings);
  } catch (error) {
    if (error instanceof ConfiguredMcpOAuthClientError) throw invalidStorage(error);
    throw error;
  }
  if (!configured) {
    throw new McpOAuthError(
      'oauth_configuration_required',
      'Configure the Meta App ID before connecting Meta Ads.',
    );
  }
  return configured;
}

async function publishConfiguredClientRecord(
  clientKey: string,
  record: StoredClient,
  configuredClient: ConfiguredMcpOAuthClient,
  dependencies: McpOAuthDependencies,
): Promise<void> {
  const nextRaw = JSON.stringify(record);
  for (let attempt = 0; attempt < CONFIGURED_CLIENT_PUBLISH_ATTEMPTS; attempt += 1) {
    await requireConfiguredClientGeneration(
      configuredClient.serverUrl, configuredClient.generation, dependencies,
    );
    const currentRaw = await dependencies.settings.getSetting(clientKey);
    const stored = await dependencies.settings.applySettingsPatch({
      expected: { key: clientKey, value: currentRaw ?? null },
      set: [{ key: clientKey, value: nextRaw }],
    });
    if (!stored) continue;
    try {
      await requireConfiguredClientGeneration(
        configuredClient.serverUrl, configuredClient.generation, dependencies,
      );
    } catch (error) {
      await deleteSettingIfCurrent(clientKey, nextRaw, dependencies.settings);
      throw error;
    }
    return;
  }
  throw new McpOAuthError('oauth_unavailable', 'Could not publish configured OAuth client');
}

async function requireConfiguredClientGeneration(
  serverUrl: string,
  expectedGeneration: string | undefined,
  dependencies: Pick<McpOAuthDependencies, 'settings'>,
): Promise<void> {
  if (!configuredMcpOAuthClientDescriptor(serverUrl)) {
    if (expectedGeneration !== undefined) throw invalidStorage();
    return;
  }
  let current: ConfiguredMcpOAuthClient | undefined;
  try {
    current = await getConfiguredMcpOAuthClient(serverUrl, dependencies.settings);
  } catch (error) {
    if (error instanceof ConfiguredMcpOAuthClientError) throw invalidStorage(error);
    throw error;
  }
  if (!current) {
    throw new McpOAuthError(
      'oauth_configuration_required',
      'Configure the Meta App ID before connecting Meta Ads.',
    );
  }
  if (!expectedGeneration || current.generation !== expectedGeneration) {
    throw new McpOAuthError(
      'reauthorization_required',
      'The configured MCP OAuth client changed and must be reauthorized.',
    );
  }
}

async function requireStoredTokenConfiguration(
  bundle: StoredTokenBundle,
  raw: string,
  tokenKey: string,
  dependencies: Pick<McpOAuthDependencies, 'settings'>,
): Promise<void> {
  try {
    await requireConfiguredClientGeneration(
      bundle.serverUrl, bundle.configurationGeneration, dependencies,
    );
  } catch (error) {
    await deleteSettingIfCurrent(tokenKey, raw, dependencies.settings);
    throw error;
  }
}

async function deleteSettingIfCurrent(
  key: string,
  raw: string,
  settings: SettingsStore,
): Promise<void> {
  await settings.applySettingsPatch({
    expected: { key, value: raw },
    delete: [key],
  });
}

async function requireCurrentConnection(
  ref: McpSecretRef,
  serverUrl: string,
  dependencies: McpOAuthDependencies,
  accountRevision?: number,
  oauthAttemptId?: string,
): Promise<void> {
  if (
    dependencies.validateConnection &&
    !(await dependencies.validateConnection(ref, serverUrl, accountRevision, oauthAttemptId))
  ) {
    throw new McpOAuthError('connection_missing', 'OAuth connection no longer exists');
  }
}

function validateSetupOperationId(value: string | undefined): void {
  if (value !== undefined && !isSetupOperationId(value)) {
    throw new McpOAuthError('oauth_unavailable', 'OAuth setup continuation is invalid');
  }
}

function isSetupOperationId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

async function requireCurrentAuthorization(
  ref: McpSecretRef,
  authority: OAuthAuthorizationAuthority | undefined,
  dependencies: McpOAuthDependencies,
): Promise<void> {
  if (
    dependencies.validateAuthorization &&
    (!authority || !(await dependencies.validateAuthorization(authority, ref)))
  ) {
    throw new McpOAuthError(
      'authorization_expired',
      'OAuth initiating authority is no longer current',
    );
  }
}

function assertTokenResource(bundle: StoredTokenBundle, serverUrl: string): void {
  if (bundle.serverUrl !== serverUrl) {
    throw new McpOAuthError(
      'reauthorization_required',
      'MCP OAuth resource changed and must be reauthorized',
    );
  }
}

function assertBearerTokens(tokens: OAuthTokens): void {
  if (tokens.token_type.toLowerCase() !== 'bearer') {
    throw new McpOAuthError(
      'oauth_unavailable',
      'MCP OAuth server returned an unsupported token type',
    );
  }
}

function validateAuthorizationServerMetadata(
  authorizationServerUrl: string,
  metadata: AuthorizationServerMetadata,
): void {
  if (new URL(metadata.issuer).href !== new URL(authorizationServerUrl).href) {
    throw new McpOAuthError(
      'oauth_discovery_failed',
      'Authorization server issuer does not match discovery',
    );
  }
  const endpoints = [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.registration_endpoint,
  ].filter((value): value is string => value !== undefined);
  if (endpoints.some((endpoint) => !validateMcpUrl(endpoint).ok)) {
    throw new McpOAuthError(
      'oauth_discovery_failed',
      'Authorization server metadata contains a blocked endpoint',
    );
  }
}

function encodeState(ref: McpSecretRef, nonce: string): string {
  return encodeBase64Url(new TextEncoder().encode(
    JSON.stringify({ a: ref.agentId, c: ref.connectionId, n: nonce }),
  ));
}

/**
 * Recover the status-only connection target from callback state after an OAuth
 * completion error. This is routing metadata, not an authorization check; the
 * callback must still let completeMcpOAuthAuthorization validate and consume
 * state before using this fallback.
 */
export function mcpOAuthReturnRefFromState(state: string): McpSecretRef {
  return decodeStateRef(state);
}

/**
 * Read the management continuation bound to an exact live provider state.
 * This never consumes state and exposes no OAuth client, verifier, or token.
 */
export async function readMcpOAuthSetupContinuation(
  state: string,
  dependencies: Pick<McpOAuthDependencies, 'settings' | 'now'>,
): Promise<string | undefined> {
  const ref = decodeStateRef(state);
  const [, pendingKey] = mcpOAuthSettingKeys(ref);
  const raw = await dependencies.settings.getSetting(pendingKey);
  if (!raw) {
    throw new McpOAuthError('invalid_state', 'OAuth state is missing or already used');
  }
  const pending = parsePendingAuthorization(raw);
  if (pending.state !== state || pending.expiresAt <= oauthNow(dependencies)) {
    throw new McpOAuthError('invalid_state', 'OAuth state is invalid or expired');
  }
  return pending.setupOperationId;
}

function decodeStateRef(state: string): McpSecretRef {
  if (!state || state.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(state)) {
    throw new McpOAuthError('invalid_state', 'OAuth state is malformed');
  }
  try {
    const decoded = JSON.parse(new TextDecoder().decode(decodeBase64Url(state))) as unknown;
    if (
      !isRecord(decoded) ||
      typeof decoded.a !== 'string' ||
      typeof decoded.c !== 'string' ||
      typeof decoded.n !== 'string'
    ) {
      throw new Error('invalid state payload');
    }
    const ref = { agentId: decoded.a, connectionId: decoded.c };
    validateRef(ref);
    return ref;
  } catch (error) {
    if (error instanceof McpOAuthError) throw error;
    throw new McpOAuthError('invalid_state', 'OAuth state is malformed', {
      cause: error,
    });
  }
}

function parsePendingAuthorization(
  raw: string,
): PendingAuthorization & { codeVerifier: string } {
  const value = parseStoredRecord(raw);
  let authorizationAuthority: OAuthAuthorizationAuthority | undefined;
  try {
    authorizationAuthority = value.authorizationAuthority === undefined
      ? undefined
      : parseOAuthAuthorizationAuthority(value.authorizationAuthority);
  } catch {
    throw invalidStorage();
  }
  if (
    typeof value.state !== 'string' ||
    typeof value.expiresAt !== 'number' ||
    typeof value.serverUrl !== 'string' ||
    typeof value.callbackUrl !== 'string' ||
    (value.scope !== undefined && typeof value.scope !== 'string') ||
    typeof value.authorizationServerUrl !== 'string' ||
    typeof value.codeVerifier !== 'string' ||
    typeof value.resource !== 'string' ||
    (value.returnAgentId !== undefined &&
      (typeof value.returnAgentId !== 'string' || !AGENT_ID_PATTERN.test(value.returnAgentId))) ||
    (value.accountRevision !== undefined &&
      (!Number.isSafeInteger(value.accountRevision) || (value.accountRevision as number) < 1)) ||
    (value.oauthAttemptId !== undefined && !isOAuthAttemptId(value.oauthAttemptId)) ||
    (value.setupOperationId !== undefined && !isSetupOperationId(value.setupOperationId)) ||
    (value.configurationGeneration !== undefined &&
      !isConfiguredMcpOAuthClientGeneration(value.configurationGeneration)) ||
    !isRecord(value.metadata) ||
    !isRecord(value.clientInformation)
  ) {
    throw invalidStorage();
  }
  return {
    state: value.state,
    expiresAt: value.expiresAt,
    serverUrl: value.serverUrl,
    callbackUrl: value.callbackUrl,
    authorizationServerUrl: value.authorizationServerUrl,
    metadata: parseAuthorizationServerMetadata(value.metadata),
    resource: value.resource,
    clientInformation: parseClientInformation(value.clientInformation),
    codeVerifier: value.codeVerifier,
    ...(typeof value.returnAgentId === 'string' ? { returnAgentId: value.returnAgentId } : {}),
    ...(typeof value.accountRevision === 'number'
      ? { accountRevision: value.accountRevision }
      : {}),
    ...(typeof value.oauthAttemptId === 'string'
      ? { oauthAttemptId: value.oauthAttemptId }
      : {}),
    ...(typeof value.setupOperationId === 'string'
      ? { setupOperationId: value.setupOperationId }
      : {}),
    ...(typeof value.configurationGeneration === 'string'
      ? { configurationGeneration: value.configurationGeneration }
      : {}),
    ...(authorizationAuthority ? { authorizationAuthority } : {}),
  };
}

function parseStoredClient(raw: string): StoredClient {
  const value = parseStoredRecord(raw);
  if (
    typeof value.authorizationServerUrl !== 'string' ||
    typeof value.callbackUrl !== 'string' ||
    (value.scope !== undefined && typeof value.scope !== 'string') ||
    (value.configurationGeneration !== undefined &&
      !isConfiguredMcpOAuthClientGeneration(value.configurationGeneration)) ||
    !isRecord(value.clientInformation) ||
    typeof value.clientInformation.client_id !== 'string'
  ) {
    throw invalidStorage();
  }
  return {
    authorizationServerUrl: value.authorizationServerUrl,
    callbackUrl: value.callbackUrl,
    clientInformation: parseClientInformation(value.clientInformation),
    ...(typeof value.scope === 'string' ? { scope: value.scope } : {}),
    ...(typeof value.configurationGeneration === 'string'
      ? { configurationGeneration: value.configurationGeneration }
      : {}),
  };
}

function parseStoredTokenBundle(raw: string): StoredTokenBundle {
  const value = parseStoredRecord(raw);
  if (
    typeof value.serverUrl !== 'string' ||
    typeof value.authorizationServerUrl !== 'string' ||
    typeof value.resource !== 'string' ||
    typeof value.obtainedAt !== 'number' ||
    (value.accountRevision !== undefined &&
      (!Number.isSafeInteger(value.accountRevision) || (value.accountRevision as number) < 1)) ||
    (value.oauthAttemptId !== undefined && !isOAuthAttemptId(value.oauthAttemptId)) ||
    (value.configurationGeneration !== undefined &&
      !isConfiguredMcpOAuthClientGeneration(value.configurationGeneration)) ||
    !isRecord(value.metadata) ||
    !isRecord(value.clientInformation) ||
    !isRecord(value.tokens)
  ) {
    throw invalidStorage();
  }
  return {
    serverUrl: value.serverUrl,
    authorizationServerUrl: value.authorizationServerUrl,
    metadata: parseAuthorizationServerMetadata(value.metadata),
    resource: value.resource,
    clientInformation: parseClientInformation(value.clientInformation),
    tokens: parseTokens(value.tokens),
    obtainedAt: value.obtainedAt,
    ...(typeof value.accountRevision === 'number'
      ? { accountRevision: value.accountRevision }
      : {}),
    ...(typeof value.oauthAttemptId === 'string'
      ? { oauthAttemptId: value.oauthAttemptId }
      : {}),
    ...(typeof value.configurationGeneration === 'string'
      ? { configurationGeneration: value.configurationGeneration }
      : {}),
  };
}

function parseAuthorizationServerMetadata(
  value: Record<string, unknown>,
): AuthorizationServerMetadata {
  const oauth = OAuthMetadataSchema.safeParse(value);
  if (oauth.success) return oauth.data;
  const openId = OpenIdProviderDiscoveryMetadataSchema.safeParse(value);
  if (openId.success) return openId.data;
  throw invalidStorage();
}

function parseClientInformation(
  value: Record<string, unknown>,
): OAuthClientInformationMixed {
  const full = OAuthClientInformationFullSchema.safeParse(value);
  if (full.success) return full.data;
  const minimal = OAuthClientInformationSchema.safeParse(value);
  if (minimal.success) return minimal.data;
  throw invalidStorage();
}

function parseTokens(value: Record<string, unknown>): OAuthTokens {
  const parsed = OAuthTokensSchema.safeParse(value);
  if (!parsed.success) throw invalidStorage();
  return parsed.data;
}

function parseLease(raw: string): StoredOAuthLease {
  return parseOAuthLease(raw, parseStoredRecord, invalidStorage);
}

function parseStoredRecord(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) throw new Error('not an object');
    return parsed;
  } catch (error) {
    throw invalidStorage(error);
  }
}

function invalidStorage(cause?: unknown): McpOAuthError {
  return new McpOAuthError(
    'oauth_storage_invalid',
    'Stored MCP OAuth state is invalid',
    cause === undefined ? undefined : { cause },
  );
}

function attemptSuperseded(): McpOAuthError {
  return new McpOAuthError('oauth_attempt_superseded', 'OAuth attempt was superseded');
}

function isConnectionMissing(error: unknown): boolean {
  return error instanceof McpOAuthError && error.code === 'connection_missing';
}

function isConfiguredClientDrift(error: unknown): boolean {
  return error instanceof McpOAuthError &&
    (error.code === 'oauth_configuration_required' || error.code === 'reauthorization_required');
}

function validateRef(ref: McpSecretRef): void {
  if (
    !AGENT_ID_PATTERN.test(ref.agentId) ||
    !CONNECTION_ID_PATTERN.test(ref.connectionId)
  ) {
    throw new McpOAuthError('invalid_state', 'OAuth connection reference is invalid');
  }
}

function normalizedServerUrl(value: string): string {
  const validated = validateMcpUrl(value);
  if (!validated.ok) {
    throw new McpOAuthError(
      'oauth_discovery_failed',
      'MCP OAuth resource URL is blocked',
    );
  }
  if (isConfiguredMcpOAuthClientOrigin(validated.url) &&
      !configuredMcpOAuthClientDescriptor(validated.url)) {
    throw new McpOAuthError(
      'oauth_discovery_failed',
      'MCP OAuth resource URL is not the reviewed configured-client endpoint',
    );
  }
  return validated.url;
}

function validateCallbackUrl(value: string): URL {
  const url = new URL(value);
  const loopback =
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback) {
    throw new McpOAuthError(
      'oauth_discovery_failed',
      'OAuth callback must use HTTPS or loopback HTTP',
    );
  }
  return url;
}

function guardedOAuthFetch(dependencies: McpOAuthDependencies): typeof fetch {
  const guardedFetch = createMcpGuardedFetch(
    dependencies.fetchFn
      ? {
          fetch: dependencies.fetchFn,
          cloudflare: true,
          signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
        }
      : { signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS) },
  );
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    request.headers.set('User-Agent', MCP_OAUTH_USER_AGENT);
    return guardedFetch(request);
  }) as typeof fetch;
}
