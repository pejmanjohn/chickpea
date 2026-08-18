import type {
  McpConnectionDefinition,
  ToolDefinition,
} from '@flue/runtime';

import { mcpDebugText } from './mcp-errors.ts';
import { withMcpHttpTelemetry } from './mcp-telemetry.ts';
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
  getSettingsStore,
  type PlatformEnv,
} from './state-backend.ts';
import type { McpConnectionConfig } from './types.ts';
import type { RuntimePlanMcpConnectionV2 } from '../agents/runtime-plan.ts';

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

export interface ResolveProfileMcpToolsOptions {
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
  /** Best-effort policy-only lifecycle hook; never receives headers or secrets. */
  onConnectionStart?: (connection: { id: string; displayName: string }) => void;
}

export interface ResolveProfileMcpConnectionsOptions {
  /** Durable profile id; definitions close over this id, never a token. */
  agentId: string;
  env?: PlatformEnv | undefined;
  resolveOAuthAccessToken?: (
    input: ResolveMcpOAuthAccessInput,
  ) => Promise<string>;
  onConnectionStart?: (connection: { id: string; displayName: string }) => void;
  /** Test seam; production uses the SSRF-guarded fetch implementation. */
  createGuardedFetch?: typeof createMcpGuardedFetch;
}

export function isProfileMcpServerEligible(server: McpConnectionConfig): boolean {
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
        return guardedFetch(new Request(request, { headers }));
      }, { connectionId: server.id, authMode: server.authMode });
      return [{
        name: server.id,
        url: validated.url,
        transport: server.transport,
        tools: [...server.allowedTools],
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
): McpConnectionDefinition[] {
  return declarations.map((declaration) => {
    const validated = validateMcpUrl(declaration.url);
    if (!validated.ok) {
      throw new Error(`Runtime plan MCP connection ${declaration.id} has a blocked URL.`);
    }
    const guardedFetch = createMcpGuardedFetch({ allowedOrigin: new URL(validated.url).origin });
    const liveServer = async (): Promise<{
      server: McpConnectionConfig;
      env: PlatformEnv | undefined;
    }> => {
      const env = await resolveCurrentMcpEnv();
      const profile = await getConfigStore(env).getAgent(profileId);
      const server = profile.mcpServers.find((candidate) => candidate.id === declaration.id);
      if (!server || !runtimeMcpDeclarationStillAllowed(server, declaration)) {
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
      const { server, env } = await liveServer();
      const customHeaders = await resolveMcpHeaders(
        { agentId: profileId, connectionId: server.id },
        declaration.headerNames,
        env,
      );
      const request = new Request(input, init);
      const headers = new Headers(request.headers);
      for (const [name, value] of Object.entries(buildMcpRequestHeaders(
        declaration.authMode,
        { headers: customHeaders },
      ))) {
        headers.set(name, value);
      }
      return guardedFetch(new Request(request, { headers }));
    }, { connectionId: declaration.id, authMode: declaration.authMode });
    return {
      name: declaration.id,
      url: validated.url,
      transport: declaration.transport,
      tools: [...declaration.allowedTools],
      optional: declaration.optional,
      timeoutMs: 30_000,
      fetch: fetchWithLiveHeaders,
      ...(declaration.authMode === 'none'
        ? {}
        : {
            auth: async () => {
              const { server, env } = await liveServer();
              return resolveLiveMcpBearer(server, {
                agentId: profileId,
                env,
              }, true);
            },
          }),
    };
  });
}

function runtimeMcpDeclarationStillAllowed(
  server: McpConnectionConfig,
  declaration: RuntimePlanMcpConnectionV2,
): boolean {
  return isProfileMcpServerEligible(server) &&
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
  const secrets = await resolveMcpSecrets(
    { agentId: opts.agentId, connectionId: server.id },
    [],
    opts.env,
  );
  if (!secrets.bearer) {
    throw new Error('MCP bearer credential is unavailable.');
  }
  return secrets.bearer;
}

async function resolveOneServer(
  server: McpConnectionConfig,
  opts: ResolveProfileMcpToolsOptions,
): Promise<ToolDefinition[]> {
  let debugHeaders: Readonly<Record<string, string>> = {};
  try {
    const secrets = await resolveMcpSecrets(
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
              isCurrentMcpOAuthConnection(
                configStore,
                ref,
                serverUrl,
              ),
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
    const headers = buildMcpRequestHeaders(server.authMode, secrets);
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
        ...(opts.connectTimeoutMs !== undefined ? { connectTimeoutMs: opts.connectTimeoutMs } : {}),
      },
      opts.connect,
    );

    const approved = new Set(server.allowedTools);
    const kept = connection.tools.filter((tool) => approved.has(stripPrefix(server.id, tool.name)));

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
