import { connectionAccountOAuthRef } from './api-oauth.ts';
import { isActiveConnectionActor, projectEffectiveMcpConnections, resolveEffectiveConnectionAccounts, resolveConnectionSecretForInvocation } from '../connections/runtime.ts';
import type {
  McpConnectionDefinition,
  ToolDefinition,
} from '@flue/runtime';

import { mcpDebugText } from './mcp-errors.ts';
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
import { connectMcp, type McpConnector } from './mcp-test.ts';
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
 * Turn-time assembly of a profile's remote MCP tools, called from the
 * `slack-thread.ts` factory alongside `resolveProfileSkills`. `mcpServers` rides
 * inside the resolved agent, so it inherits the same freeze contract as skills
 * and instructions (frozen in the snapshot for channel threads, live-resolved
 * for DMs); secrets always resolve live from env/settings.
 *
 * GRACEFUL DEGRADE is the load-bearing contract here: a dead or slow
 * third-party server must never abort a Slack reply. Every connection runs in
 * parallel inside a closure that catches its own errors and yields `[]`, so one
 * failure never rejects the batch.
 *
 * SECURITY INVARIANT: only `approved ∩ currently-discovered` tools are exposed.
 * Flue adapts tool names to `mcp__<id>__<tool>`; we intersect on the STRIPPED
 * name against `allowedTools`, and return the tool with its full prefixed name
 * (so it stays namespaced). A tool approved but no longer discovered is simply
 * absent. Duplicate full names — against built-ins, skills, or an earlier
 * server — are dropped (first wins), because duplicate tool names are an
 * uncatchable turn-killer once the factory returns.
 */

const NODE_CLOSE_DELAY_MS = 600_000; // 10 minutes — bounded leak on the node lane.
const TOOL_NAME_PREFIX = /^mcp__[^_]+(?:_[^_]+)*__/;

interface ResolveProfileMcpToolsOptions {
  /** Immutable profile id used to scope connection secrets. */
  agentId: string;
  // `undefined` is explicit: the slack-thread seam passes a possibly-undefined
  // env (node lane ignores it; CF supplies the binding), so the key is always
  // present but may hold undefined under exactOptionalPropertyTypes.
  env?: PlatformEnv | undefined;
  /** Tool + skill names already claimed by the agent; MCP collisions are dropped. */
  existingToolNames: string[];
  /** Test seam — defaults to Flue's `createMcpConnection`. */
  connect?: McpConnector;
  /** Test seam — shortens the per-connect deadline; defaults to mcp-test's 8s. */
  connectTimeoutMs?: number;
  /** Test seam for OAuth token resolution; production resolves from settings. */
  resolveOAuthAccessToken?: (
    input: ResolveMcpOAuthAccessInput,
  ) => Promise<string>;
  /** U6 account seam; rechecks binding/actor before returning a bearer. */
  resolveBearerCredential?: (connectionId: string) => Promise<string>;
  /** Live account/profile projection used to fence every legacy invocation. */
  resolveCurrentConnection?: (connectionId: string) => Promise<McpConnectionConfig | undefined>;
  /** Test seam; production uses the SSRF-guarded fetch implementation. */
  createGuardedFetch?: typeof createMcpGuardedFetch;
  /** Best-effort policy-only lifecycle hook; never receives headers or secrets. */
  onConnectionStart?: (connection: { id: string; displayName: string }) => void;
}

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

export async function resolveProfileMcpTools(
  servers: McpConnectionConfig[],
  opts: ResolveProfileMcpToolsOptions,
): Promise<ToolDefinition[]> {
  // A channel snapshot frozen before this field existed deserializes with
  // `servers` undefined (the raw JSON.parse in snapshot-store does no coercion,
  // unlike rowToAgent). Guard it exactly as resolveProfileSkills does — the
  // factory must never throw.
  if (!servers || servers.length === 0) {
    return [];
  }
  const eligible = servers.filter(isProfileMcpServerEligible);
  if (eligible.length === 0) {
    return [];
  }

  // All connections in parallel; each closure catches internally so a rejection
  // never propagates and one dead server never aborts the turn.
  const perServer = await Promise.all(eligible.map((server) => resolveOneServer(server, opts)));

  // Merge with first-wins dedupe against existing names AND earlier MCP tools.
  const seen = new Set(opts.existingToolNames);
  const merged: ToolDefinition[] = [];
  for (const tools of perServer) {
    for (const tool of tools) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      merged.push(tool);
    }
  }
  return merged;
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

async function resolveOneServer(
  server: McpConnectionConfig,
  opts: ResolveProfileMcpToolsOptions,
): Promise<ToolDefinition[]> {
  let debugHeaders: Readonly<Record<string, string>> = {};
  try {
    const runtimeAllowed = new Set(runtimeAllowedToolsForServer(server));
    if (runtimeAllowed.size === 0) return [];
    const liveMetaPolicy = isMetaAdsMcpConnection(server);
    const headers = liveMetaPolicy ? {} : await resolveLegacyMcpHeaders(server, opts);
    debugHeaders = headers;
    try {
      opts.onConnectionStart?.({ id: server.id, displayName: server.displayName });
    } catch {
      // Status narration is cosmetic and must never block a connection.
    }
    const connection = await connectMcp(
      {
        id: server.id,
        url: server.url,
        transport: server.transport,
        headers,
        ...(liveMetaPolicy ? {
          resolveHeaders: async () => {
            const current = await requireCurrentLegacyMcpServer(server, opts);
            return resolveLegacyMcpHeaders(current, opts);
          },
          transformResponse: async (request: Request, response: Response) => {
            const advertised = usesMetaAdsOutputAdapter(server)
              ? await advertiseMetaAdsAccountHelperOutput(request, response)
              : response;
            const invocation = await mcpToolInvocation(request);
            if (invocation?.name !== META_ADS_ACCOUNT_HELPER) return advertised;
            const current = await requireCurrentLegacyMcpServer(server, opts);
            assertServerMcpToolInvocation(current, runtimeAllowedToolsForServer(server), invocation);
            const sanitized = await sanitizeAccountHelperResponse(current, advertised);
            await requireCurrentLegacyMcpServer(server, opts);
            return sanitized;
          },
        } : {}),
        ...(opts.connectTimeoutMs !== undefined ? { connectTimeoutMs: opts.connectTimeoutMs } : {}),
      },
      opts.connect,
      opts.createGuardedFetch,
    );

    const approved = new Set(server.allowedTools);
    const kept = connection.tools
      .filter((tool) => approved.has(stripPrefix(server.id, tool.name)) &&
        runtimeAllowed.has(stripPrefix(server.id, tool.name)))
      .map((tool) => wrapLegacyMcpTool(server, tool, opts));

    if (kept.length === 0) {
      // Nothing survived the intersection — no reason to hold the connection.
      scheduleClose(connection, true);
      return [];
    }
    scheduleClose(connection, false);
    return kept;
  } catch (err) {
    // Graceful degrade: skip this server, never abort the turn. The DB and UI
    // only ever see the safe sentence; the log line carries the bounded debug
    // text so a live connect failure is actually diagnosable in observability.
    console.warn(
      '[chickpea] MCP connection ' +
        server.id +
        ' skipped: ' +
        mcpDebugText(err, { url: server.url, headers: debugHeaders }),
    );
    return [];
  }
}

async function resolveLegacyMcpHeaders(
  server: McpConnectionConfig,
  opts: ResolveProfileMcpToolsOptions,
): Promise<Record<string, string>> {
  const secrets = opts.resolveBearerCredential
    ? await resolveConnectionAccountMcpSecrets(server, opts.resolveBearerCredential)
    : await resolveMcpSecrets(
        { agentId: opts.agentId, connectionId: server.id },
        server.headerNames,
        opts.env,
      );
  if (server.authMode === 'oauth') {
    secrets.bearer = await (
      opts.resolveOAuthAccessToken ??
      ((input) => {
        const configStore = getConfigStore(opts.env);
        return resolveMcpOAuthAccessToken(input, {
          settings: getSettingsStore(opts.env),
          validateConnection: (ref, serverUrl) =>
            isCurrentMcpOAuthConnection(configStore, ref, serverUrl),
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
  return buildMcpRequestHeaders(server.authMode, secrets);
}

async function requireCurrentLegacyMcpServer(
  frozen: McpConnectionConfig,
  opts: ResolveProfileMcpToolsOptions,
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

function wrapLegacyMcpTool(
  server: McpConnectionConfig,
  tool: ToolDefinition,
  opts: ResolveProfileMcpToolsOptions,
): ToolDefinition {
  const name = stripPrefix(server.id, tool.name);
  if (!isMetaAdsMcpConnection(server) && !server.toolPolicies?.[name]?.argumentConstraints) return tool;
  const wrapped: ToolDefinition = {
    ...tool,
    async run(context) {
      const argumentsValue = 'data' in context ? context.data : undefined;
      const current = isMetaAdsMcpConnection(server)
        ? await requireCurrentLegacyMcpServer(server, opts)
        : server;
      assertServerMcpToolInvocation(current, runtimeAllowedToolsForServer(server), {
        name,
        arguments: argumentsValue,
      });
      if (isMetaAdsMcpConnection(current) && isMetaAdsWriteTool(name)) {
        const headers = new Headers(await resolveLegacyMcpHeaders(current, opts));
        await assertMetaWriteOwnership(current, { name, arguments: argumentsValue }, headers, opts.createGuardedFetch);
        const latest = await requireCurrentLegacyMcpServer(server, opts);
        assertServerMcpToolInvocation(latest, runtimeAllowedToolsForServer(server), {
          name, arguments: argumentsValue,
        });
      }
      const result = await tool.run(context);
      if (isMetaAdsMcpConnection(server)) await requireCurrentLegacyMcpServer(server, opts);
      // Flue records an omitted output as null; an empty envelope preserves
      // that behavior while keeping this async wrapper's return union sound.
      return result === undefined ? {} : result;
    },
  };
  return wrapped;
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

/**
 * Flue 2 has no connection-specific turn-end hook. On Cloudflare, connection
 * I/O is request-pinned and dies with
 * the request, so there is nothing to schedule. On node, close via an unref'd
 * setTimeout so a bounded leak is reclaimed 10 minutes after connect (or
 * immediately when the connection yielded no usable tools).
 */
function scheduleClose(connection: { close(): Promise<void> }, immediate: boolean): void {
  if (immediate) {
    void connection.close().catch(() => undefined);
    return;
  }
  if (isCloudflareTarget()) {
    return;
  }
  const timer = setTimeout(() => {
    void connection.close().catch(() => undefined);
  }, NODE_CLOSE_DELAY_MS);
  timer.unref?.();
}

/**
 * Strip Flue's `mcp__<id>__` prefix so the intersection matches the bare tool
 * name stored in `allowedTools`. Falls back to a generic strip if the
 * id-specific prefix does not match (mirrors mcp-test.ts).
 */
function stripPrefix(id: string, name: string): string {
  const specific = 'mcp__' + id + '__';
  if (name.startsWith(specific)) {
    return name.slice(specific.length);
  }
  return name.replace(TOOL_NAME_PREFIX, '');
}
