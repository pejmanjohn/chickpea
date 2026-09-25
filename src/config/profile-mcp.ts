import { connectionAccountOAuthRef } from './api-oauth.ts';
import { isActiveConnectionActor, projectEffectiveMcpConnections, resolveEffectiveConnectionAccounts, resolveConnectionSecretForInvocation } from '../connections/runtime.ts';
import type { McpConnectionDefinition } from '@flue/runtime';

import { withMcpHttpTelemetry } from './mcp-telemetry.ts';
import { assertMcpToolArgumentKeys, assertMcpToolArguments } from './mcp-tool-policy.ts';
import {
  META_ADS_ACCOUNT_HELPER,
  assertMetaAdsHelperArguments,
  isMetaAdsMcpConnection,
  isMetaAdsHelperTool,
  isMetaAdsAccountScopeTool,
  isMetaAdsWriteTool,
  metaAdsApprovedAccountIds,
  metaAdsRuntimeAllowedTools,
  metaAdsRuntimeConstraint,
  metaAdsRuntimePolicyConstraint,
  metaAdsRuntimePropertyNames,
  metaAdsToolEffect,
} from './meta-ads-policy.ts';
import {
  advertiseMetaAdsAccountHelperOutput,
  sanitizeMetaAdsAccountHelperResponse,
} from './meta-ads-response.ts';
import { assertMetaAdsWriteAccountOwnership, META_ADS_OWNERSHIP_ORIGIN } from './meta-ads-write-guard.ts';
import { META_ADS_OAUTH_MANAGEMENT_SCOPE } from './mcp-oauth-clients.ts';
import {
  isCurrentMcpOAuthConnection,
  resolveMcpOAuthAccessToken,
  type ResolveMcpOAuthAccessInput,
} from './mcp-oauth.ts';
import {
  buildMcpRequestHeaders,
  resolveMcpHeaders,
  resolveMcpSecrets,
} from './mcp-secrets.ts';
import { createMcpGuardedFetch, validateMcpUrl } from './mcp-url.ts';
import { isCloudflareTarget } from './runtime-target.ts';
import {
  getConfigStore,
  getIdentityStore,
  getSettingsStore,
  type PlatformEnv,
} from './state-backend.ts';
import type { McpConnectionConfig } from './types.ts';
import type { RuntimePlanMcpConnectionV2 } from '../agents/runtime-plan.ts';
import { ConnectionCredentialUnavailableError } from '../connections/errors.ts';

/**
 * Turn-time MCP connection declarations for Flue. Definitions carry policy
 * only (URL, transport, the approved tool list); Flue owns discovery,
 * namespacing, and the strict tool allowlist. Every request re-reads the live
 * connection policy, and secrets always resolve live from env/settings, so a
 * revoked connection or rotated credential takes effect on the next call.
 */

interface ResolveProfileMcpConnectionsOptions {
  /** Durable profile id; definitions close over this id, never a token. */
  agentId: string;
  env?: PlatformEnv | undefined;
  resolveOAuthAccessToken?: (
    input: ResolveMcpOAuthAccessInput,
  ) => Promise<string>;
  resolveBearerCredential?: (connectionId: string) => Promise<string>;
  /** Test/account seam; production falls back to the live Agent profile. */
  resolveCurrentConnection?: (connectionId: string) => Promise<McpConnectionConfig | undefined>;
  onConnectionStart?: (connection: { id: string; displayName: string }) => void;
  /** Test seam; production uses the SSRF-guarded fetch implementation. */
  createGuardedFetch?: typeof createMcpGuardedFetch;
}

function isProfileMcpServerEligible(server: McpConnectionConfig): boolean {
  return server.enabled && server.lifecycleStatus === 'ready' && server.allowedTools.length > 0;
}

/**
 * Flue 2-native MCP declarations. Tool discovery, namespacing, strict
 * allowlists, caching, and optional-resource narration belong to Flue; this
 * adapter owns only Chickpea policy, SSRF defense, and live auth resolution.
 */
export function resolveProfileMcpConnections(
  servers: readonly McpConnectionConfig[] | undefined,
  opts: ResolveProfileMcpConnectionsOptions,
): McpConnectionDefinition[] {
  return (servers ?? [])
    .filter(isProfileMcpServerEligible)
    .flatMap((server) => {
      const allowedTools = runtimeAllowedToolsForServer(server);
      if (allowedTools.length === 0) return [];
      const validated = validateMcpUrl(server.url);
      if (!validated.ok) {
        console.warn(`[chickpea] MCP connection ${server.id} skipped: blocked URL`);
        return [];
      }
      try {
        opts.onConnectionStart?.({ id: server.id, displayName: server.displayName });
      } catch {
        // Status narration is cosmetic and must never block a connection.
      }
      const guardedFetch = (opts.createGuardedFetch ?? createMcpGuardedFetch)({
        allowedOrigin: new URL(validated.url).origin,
      });
      const fetchWithLiveCustomHeaders = withMcpHttpTelemetry(async (input, init) => {
        const request = new Request(input, init);
        const advertisedRequest = usesMetaAdsOutputAdapter(server) ? request.clone() : undefined;
        const invocation = serverNeedsInvocationGuard(server)
          ? await mcpToolInvocation(request) : undefined;
        if (invocation) assertServerMcpToolInvocation(server, allowedTools, invocation);
        const liveMetaServer = invocation && isMetaAdsMcpConnection(server)
          ? await requireCurrentProfileMcpServer(server, opts)
          : undefined;
        if (liveMetaServer && invocation) {
          assertServerMcpToolInvocation(liveMetaServer, allowedTools, invocation);
        }
        const customHeaders = await resolveMcpHeaders(
          { agentId: opts.agentId, connectionId: server.id },
          server.headerNames,
          opts.env,
        );
        const headers = new Headers(request.headers);
        for (const [name, value] of Object.entries(buildMcpRequestHeaders(
          server.authMode,
          { headers: customHeaders },
        ))) {
          headers.set(name, value);
        }
        const outbound = new Request(request, { headers });
        if (liveMetaServer && invocation && isMetaAdsWriteTool(invocation.name)) {
          await assertMetaWriteOwnership(liveMetaServer, invocation, headers, opts.createGuardedFetch, request.signal);
          const current = await requireCurrentProfileMcpServer(server, opts);
          assertServerMcpToolInvocation(current, allowedTools, invocation);
        }
        const response = await guardedFetch(outbound);
        const advertised = advertisedRequest
          ? await advertiseMetaAdsAccountHelperOutput(advertisedRequest, response)
          : response;
        if (!liveMetaServer || !invocation) {
          return advertised;
        }
        const sanitized = invocation.name === META_ADS_ACCOUNT_HELPER
          ? await sanitizeAccountHelperResponse(liveMetaServer, advertised)
          : advertised;
        await requireCurrentProfileMcpServer(server, opts);
        return sanitized;
      }, { connectionId: server.id, authMode: server.authMode });
      return [{
        name: server.id,
        url: validated.url,
        transport: server.transport,
        tools: allowedTools,
        optional: true,
        timeoutMs: 30_000,
        fetch: fetchWithLiveCustomHeaders,
        ...(server.authMode === 'bearer' || server.authMode === 'oauth'
          ? { auth: () => resolveLiveMcpBearer(server, opts) }
          : {}),
      }];
    });
}

/**
 * Materialize a frozen RuntimePlanV2 MCP declaration without capturing a
 * token, request, or Cloudflare invocation context. Each request re-reads the
 * current profile row, requires it to remain within the frozen declaration,
 * and resolves credentials from the trusted settings seam.
 */
export function resolveRuntimePlanMcpConnections(
  profileId: string,
  declarations: readonly RuntimePlanMcpConnectionV2[],
  onConnectionStart?: (connection: { id: string; displayName: string }) => void,
  accountContext?: { workspaceId: string; actorMembershipId: string },
  testOptions?: { createGuardedFetch?: typeof createMcpGuardedFetch },
): McpConnectionDefinition[] {
  return declarations.flatMap((declaration) => {
    const allowedTools = runtimeAllowedToolsForDeclaration(declaration);
    if (allowedTools.length === 0) return [];
    const effectiveDeclaration: RuntimePlanMcpConnectionV2 = {
      ...declaration,
      allowedTools,
      ...(declaration.readOnlyTools
        ? { readOnlyTools: declaration.readOnlyTools.filter((tool) => allowedTools.includes(tool)) } : {}),
      ...(declaration.writeTools
        ? { writeTools: declaration.writeTools.filter((tool) => allowedTools.includes(tool)) } : {}),
      ...(declaration.toolArgumentConstraints
        ? { toolArgumentConstraints: Object.fromEntries(Object.entries(declaration.toolArgumentConstraints)
            .filter(([tool]) => allowedTools.includes(tool))) } : {}),
    };
    const validated = validateMcpUrl(declaration.url);
    if (!validated.ok) {
      throw new Error(`Runtime plan MCP connection ${declaration.id} has a blocked URL.`);
    }
    const guardedFetch = (testOptions?.createGuardedFetch ?? createMcpGuardedFetch)({
      allowedOrigin: new URL(validated.url).origin,
    });
    const liveServer = async (): Promise<{
      server: McpConnectionConfig;
      env: PlatformEnv | undefined;
    }> => {
      const env = await resolveCurrentMcpEnv();
      const config = getConfigStore(env);
      let server: McpConnectionConfig | undefined;
      if (accountContext) {
        if (!(await isActiveConnectionActor({ ...accountContext, identity: getIdentityStore(env) }))) {
          throw new Error('Connection account is not available to this actor');
        }
        const accounts = await resolveEffectiveConnectionAccounts({
          ...accountContext, config, agentId: profileId,
        });
        server = projectEffectiveMcpConnections(accounts).find((candidate) => candidate.id === declaration.id);
      } else {
        const profile = await config.getAgent(profileId);
        server = profile.mcpServers.find((candidate) => candidate.id === declaration.id);
      }
      if (!server || !runtimeMcpDeclarationStillAllowed(server, effectiveDeclaration)) {
        throw new Error('MCP connection policy changed; a new agent instance is required.');
      }
      try {
        onConnectionStart?.({ id: server.id, displayName: server.displayName });
      } catch {
        // Activity narration is cosmetic.
      }
      return { server, env };
    };
    const fetchWithLiveHeaders = withMcpHttpTelemetry(async (input, init) => {
      const request = new Request(input, init);
      const invocation = await mcpToolInvocation(request);
      if (invocation) {
        if (!effectiveDeclaration.allowedTools.includes(invocation.name)) {
          throw new Error('MCP tool is not selected for this Agent.');
        }
        if (effectiveDeclaration.toolArgumentConstraints &&
            !(isMetaAdsMcpConnection(effectiveDeclaration) && isMetaAdsAccountScopeTool(invocation.name))) {
          assertMcpToolArguments(invocation.name, invocation.arguments, effectiveDeclaration.toolArgumentConstraints);
        }
      }
      const { server, env } = await liveServer();
      const advertisedRequest = usesMetaAdsOutputAdapter(server) ? request.clone() : undefined;
      if (invocation && isMetaAdsMcpConnection(server)) {
        assertServerMcpToolInvocation(server, effectiveDeclaration.allowedTools, invocation);
      }
      const customHeaders = accountContext
        ? (await resolveConnectionAccountMcpSecrets(server, (connectionAccountId) =>
            resolveConnectionSecretForInvocation({ ...accountContext, config: getConfigStore(env),
              settings: getSettingsStore(env), ...(env ? { env } : {}), agentId: profileId, connectionAccountId }))).headers
        : await resolveMcpHeaders(
            { agentId: profileId, connectionId: server.id }, declaration.headerNames, env,
          );
      const headers = new Headers(request.headers);
      for (const [name, value] of Object.entries(buildMcpRequestHeaders(
        declaration.authMode,
        { headers: customHeaders },
      ))) {
        headers.set(name, value);
      }
      if (invocation && isMetaAdsMcpConnection(server) && isMetaAdsWriteTool(invocation.name)) {
        await assertMetaWriteOwnership(server, invocation, headers, testOptions?.createGuardedFetch, request.signal);
        const current = (await liveServer()).server;
        assertUnchangedMetaInvocationSchema(server, current, invocation.name);
        assertServerMcpToolInvocation(current, effectiveDeclaration.allowedTools, invocation);
      }
      const response = await guardedFetch(new Request(request, { headers }));
      const advertised = advertisedRequest
        ? await advertiseMetaAdsAccountHelperOutput(advertisedRequest, response)
        : response;
      if (!invocation || !isMetaAdsMcpConnection(server)) {
        return advertised;
      }
      const sanitized = invocation.name === META_ADS_ACCOUNT_HELPER
        ? await sanitizeAccountHelperResponse(server, advertised)
        : advertised;
      await liveServer();
      return sanitized;
    }, { connectionId: declaration.id, authMode: declaration.authMode });
    return {
      name: declaration.id,
      url: validated.url,
      transport: declaration.transport,
      tools: allowedTools,
      optional: declaration.optional,
      timeoutMs: 30_000,
      fetch: fetchWithLiveHeaders,
      ...(declaration.authMode === 'none'
        ? {}
        : {
            auth: async () => {
              const { server, env } = await liveServer();
              if (accountContext) {
                if (server.authMode === 'oauth') {
                  return resolveMcpOAuthAccessToken({
                    ref: connectionAccountOAuthRef(server.id), serverUrl: server.url,
                  }, {
                    settings: getSettingsStore(env),
                    validateConnection: async (_ref, serverUrl, _revision, attemptId) => {
                      await liveServer();
                      const accounts = await resolveEffectiveConnectionAccounts({
                        ...accountContext, config: getConfigStore(env), agentId: profileId,
                      });
                      const account = accounts.find(({ account }) => account.id === server.id)?.account;
                      return account?.policy.kind === 'mcp' && account.policy.authMode === 'oauth' &&
                        account.policy.url === serverUrl &&
                        (attemptId === undefined || account.policy.oauthAttemptId === attemptId);
                    },
                  });
                }
                return resolveConnectionSecretForInvocation({
                  ...accountContext, config: getConfigStore(env), settings: getSettingsStore(env),
                  ...(env ? { env } : {}), agentId: profileId, connectionAccountId: server.id,
                });
              }
              return resolveLiveMcpBearer(server, { agentId: profileId, env }, true);
            },
          }),
    };
  });
}

function runtimeMcpDeclarationStillAllowed(
  server: McpConnectionConfig,
  declaration: RuntimePlanMcpConnectionV2,
): boolean {
  if (isMetaAdsMcpConnection(server) !== isMetaAdsMcpConnection(declaration)) return false;
  if (isMetaAdsMcpConnection(server) && declaration.allowedTools.some(isMetaAdsWriteTool) &&
      (server.oauthScope !== declaration.oauthScope || server.oauthAttemptId !== declaration.oauthAttemptId)) {
    return false;
  }
  return isProfileMcpServerEligible(server) &&
    (declaration.displayName === undefined || server.displayName === declaration.displayName) &&
    declaration.allowedTools.every((tool) => {
      const current = server.toolPolicies?.[tool]?.argumentConstraints ?? {};
      const frozen = declaration.toolArgumentConstraints?.[tool] ?? {};
      const canonical = (fields: Record<string, string[]>) => JSON.stringify(Object.entries(fields)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, [...values].sort()]));
      return canonical(current) === canonical(frozen);
    }) &&
    server.url === declaration.url &&
    server.transport === declaration.transport &&
    server.authMode === declaration.authMode &&
    JSON.stringify([...server.headerNames].map((name) => name.toLowerCase()).sort()) ===
      JSON.stringify([...declaration.headerNames].sort()) &&
    declaration.allowedTools.every((tool) => server.allowedTools.includes(tool));
}

async function resolveCurrentMcpEnv(): Promise<PlatformEnv | undefined> {
  if (!isCloudflareTarget()) return undefined;
  const { getCloudflareContext } = await import('@flue/runtime/cloudflare');
  return getCloudflareContext().env as PlatformEnv;
}

async function resolveLiveMcpBearer(
  server: McpConnectionConfig,
  opts: ResolveProfileMcpConnectionsOptions,
  connectionAlreadyValidated = false,
): Promise<string> {
  if (server.authMode === 'oauth') {
    const configStore = getConfigStore(opts.env);
    let useValidatedConnection = connectionAlreadyValidated;
    return (
      opts.resolveOAuthAccessToken ??
      ((input) => {
        return resolveMcpOAuthAccessToken(input, {
          settings: getSettingsStore(opts.env),
          validateConnection: (ref, serverUrl) => {
            if (useValidatedConnection) {
              useValidatedConnection = false;
              const validated = validateMcpUrl(server.url);
              return ref.agentId === opts.agentId &&
                ref.connectionId === server.id &&
                server.authMode === 'oauth' &&
                validated.ok &&
                validated.url === serverUrl;
            }
            return isCurrentMcpOAuthConnection(configStore, ref, serverUrl);
          },
          onReauthorizationRequired: async (ref, serverUrl) => {
            await configStore.markOAuthReauthorizationRequired({
              lane: 'mcp',
              ...ref,
              serverUrl,
            });
          },
        });
      })
    )({
      ref: { agentId: opts.agentId, connectionId: server.id },
      serverUrl: server.url,
    });
  }
  if (opts.resolveBearerCredential) return opts.resolveBearerCredential(server.id);
  const secrets = await resolveMcpSecrets(
    { agentId: opts.agentId, connectionId: server.id },
    [],
    opts.env,
  );
  if (!secrets.bearer) throw new Error('MCP bearer credential is unavailable.');
  return secrets.bearer;
}

function legacyMcpServerStillAllowed(
  current: McpConnectionConfig,
  frozen: McpConnectionConfig,
): boolean {
  if (isMetaAdsMcpConnection(current) !== isMetaAdsMcpConnection(frozen)) return false;
  if (!isProfileMcpServerEligible(current) || current.id !== frozen.id || current.url !== frozen.url ||
      current.transport !== frozen.transport || current.authMode !== frozen.authMode ||
      JSON.stringify([...current.headerNames].map((name) => name.toLowerCase()).sort()) !==
        JSON.stringify([...frozen.headerNames].map((name) => name.toLowerCase()).sort())) return false;
  if (isMetaAdsMcpConnection(frozen) &&
      (current.oauthAttemptId !== frozen.oauthAttemptId || current.oauthScope !== frozen.oauthScope)) return false;
  const currentAllowed = new Set(runtimeAllowedToolsForServer(current));
  return runtimeAllowedToolsForServer(frozen).every((name) => {
    if (!currentAllowed.has(name)) return false;
    if (canonicalMcpToolConstraint(current, name) !== canonicalMcpToolConstraint(frozen, name)) return false;
    if (!isMetaAdsMcpConnection(frozen)) return true;
    const currentSchema = current.discoveredTools.find((tool) => tool.name === name)?.inputSchema?.fingerprint;
    const frozenSchema = frozen.discoveredTools.find((tool) => tool.name === name)?.inputSchema?.fingerprint;
    return Boolean(currentSchema && currentSchema === frozenSchema);
  });
}

function canonicalMcpToolConstraint(server: McpConnectionConfig, name: string): string {
  const constraint = server.toolPolicies?.[name]?.argumentConstraints ?? {};
  return JSON.stringify(Object.entries(constraint).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, values]) => [key, [...values].sort()]));
}

interface McpToolInvocation {
  name: string;
  arguments: unknown;
}

async function mcpToolInvocation(request: Request): Promise<McpToolInvocation | undefined> {
  if (request.method !== 'POST') return undefined;
  const rpc = await request.clone().json() as { method?: string; params?: { name?: string; arguments?: unknown } };
  if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc)) {
    throw new Error('Invalid MCP tool invocation.');
  }
  if (rpc.method !== 'tools/call') return undefined;
  if (typeof rpc.params?.name !== 'string') throw new Error('Invalid MCP tool invocation.');
  return { name: rpc.params.name, arguments: rpc.params.arguments };
}

function runtimeAllowedToolsForServer(server: McpConnectionConfig): string[] {
  return isMetaAdsMcpConnection(server)
    ? metaAdsRuntimeAllowedTools(server)
    : [...server.allowedTools];
}

function usesMetaAdsOutputAdapter(connection: Pick<McpConnectionConfig, 'url'>): boolean {
  try {
    const url = new URL(connection.url);
    const path = decodeURIComponent(url.pathname).replace(/\/+$/, '');
    return url.protocol === 'https:' && url.hostname === 'mcp.facebook.com' && url.port === '' &&
      url.username === '' && url.password === '' && url.search === '' && url.hash === '' && path === '/ads';
  } catch {
    return false;
  }
}

function serverNeedsInvocationGuard(server: McpConnectionConfig): boolean {
  return isMetaAdsMcpConnection(server) || server.allowedTools.some((name) =>
    server.toolPolicies?.[name]?.argumentConstraints !== undefined);
}

function runtimeAllowedToolsForDeclaration(declaration: RuntimePlanMcpConnectionV2): string[] {
  if (!isMetaAdsMcpConnection(declaration)) return [...declaration.allowedTools];
  return declaration.allowedTools.filter((name) =>
    metaAdsToolEffect(name) !== undefined &&
      metaAdsRuntimePolicyConstraint(name, declaration.toolArgumentConstraints?.[name]) !== undefined);
}

function assertServerMcpToolInvocation(
  server: McpConnectionConfig,
  allowedTools: readonly string[],
  invocation: McpToolInvocation,
): void {
  if (!allowedTools.includes(invocation.name)) {
    throw new Error('MCP tool is not selected for this Agent.');
  }
  const constraints = isMetaAdsMcpConnection(server)
    ? metaAdsRuntimeConstraint(server, invocation.name)
    : server.toolPolicies?.[invocation.name]?.argumentConstraints;
  if (isMetaAdsMcpConnection(server) && !constraints) {
    throw new Error('Meta Ads tool access changed; review the connection before using it.');
  }
  if (isMetaAdsMcpConnection(server)) {
    if (isMetaAdsWriteTool(invocation.name) &&
        (server.authMode !== 'oauth' || server.oauthScope !== META_ADS_OAUTH_MANAGEMENT_SCOPE)) {
      throw new Error('Reconnect Meta Ads with Reporting and editing access before using write tools.');
    }
    const propertyNames = metaAdsRuntimePropertyNames(server, invocation.name);
    if (!propertyNames) {
      throw new Error('Meta Ads tool schema changed; review the connection before using it.');
    }
    assertMcpToolArgumentKeys(invocation.name, invocation.arguments, propertyNames);
    if (isMetaAdsHelperTool(invocation.name)) {
      assertMetaAdsHelperArguments(invocation.name, invocation.arguments);
    }
  }
  if (constraints && !(isMetaAdsMcpConnection(server) && isMetaAdsAccountScopeTool(invocation.name))) {
    assertMcpToolArguments(invocation.name, invocation.arguments, { [invocation.name]: constraints });
  }
}

function assertUnchangedMetaInvocationSchema(
  frozen: McpConnectionConfig,
  current: McpConnectionConfig,
  name: string,
): void {
  if (current.oauthAttemptId !== frozen.oauthAttemptId || current.oauthScope !== frozen.oauthScope) {
    throw new Error('Meta Ads authorization changed; start a new request before using it.');
  }
  const before = frozen.discoveredTools.find((tool) => tool.name === name)?.inputSchema?.fingerprint;
  const after = current.discoveredTools.find((tool) => tool.name === name)?.inputSchema?.fingerprint;
  if (!before || before !== after) throw new Error('Meta Ads tool schema changed; review the connection before using it.');
}

async function assertMetaWriteOwnership(
  server: McpConnectionConfig,
  invocation: McpToolInvocation,
  headers: Headers,
  createGuardedFetchOverride?: typeof createMcpGuardedFetch,
  signal?: AbortSignal,
): Promise<void> {
  // Never send a custom MCP server's credential to Graph based on a forged preset ID.
  if (!usesMetaAdsOutputAdapter(server)) throw new Error('Meta Ads writes require the official Meta Ads endpoint.');
  const constraints = metaAdsRuntimeConstraint(server, invocation.name);
  const approved = constraints ? Object.values(constraints).flat() : [];
  await assertMetaAdsWriteAccountOwnership({
    name: invocation.name,
    argumentsValue: invocation.arguments,
    approvedAccountIds: approved,
    authorization: headers.get('authorization'),
    fetch: (createGuardedFetchOverride ?? createMcpGuardedFetch)({
      allowedOrigin: META_ADS_OWNERSHIP_ORIGIN,
      maxRedirects: 0,
    }),
    ...(signal ? { signal } : {}),
  });
}

async function sanitizeAccountHelperResponse(
  server: McpConnectionConfig,
  response: Response,
): Promise<Response> {
  const constraints = metaAdsRuntimeConstraint(server, META_ADS_ACCOUNT_HELPER);
  const approvedAccountIds = metaAdsApprovedAccountIds(constraints);
  if (!approvedAccountIds) {
    throw new Error('Meta Ads account verification scope changed; review the connection before using it.');
  }
  return sanitizeMetaAdsAccountHelperResponse(response, approvedAccountIds);
}

async function requireCurrentProfileMcpServer(
  frozen: McpConnectionConfig,
  opts: ResolveProfileMcpConnectionsOptions,
): Promise<McpConnectionConfig> {
  const current = opts.resolveCurrentConnection
    ? await opts.resolveCurrentConnection(frozen.id)
    : (await getConfigStore(opts.env).getAgent(opts.agentId)).mcpServers
        .find((candidate) => candidate.id === frozen.id);
  if (!current || !legacyMcpServerStillAllowed(current, frozen)) {
    throw new Error('MCP connection policy changed; a new agent instance is required.');
  }
  return current;
}

async function resolveConnectionAccountMcpSecrets(
  server: McpConnectionConfig,
  resolveCredential: (connectionId: string) => Promise<string>,
): Promise<{ bearer?: string; headers: Record<string, string> }> {
  const credentialNeeded = server.authMode === 'bearer' || !!server.credentialHeaderName;
  let credential: string | undefined;
  if (credentialNeeded) {
    try {
      credential = await resolveCredential(server.id);
    } catch (error) {
      if (!server.credentialOptional ||
          !(error instanceof ConnectionCredentialUnavailableError)) throw error;
    }
  }
  const prefix = server.credentialValuePrefix ?? '';
  return {
    ...(server.authMode === 'bearer' && credential ? { bearer: credential } : {}),
    headers: server.credentialHeaderName && credential
      ? {
          [server.credentialHeaderName]: prefix && !credential.startsWith(prefix)
            ? prefix + credential
            : credential,
        }
      : {},
  };
}
