import type { ToolDefinition, connectMcpServer } from '@flue/runtime';

import { safeMcpFailureText } from './mcp-errors.ts';
import { buildMcpRequestHeaders, resolveMcpSecrets } from './mcp-secrets.ts';
import { connectMcp } from './mcp-test.ts';
import { isCloudflareTarget } from './runtime-target.ts';
import type { PlatformEnv } from './state-backend.ts';
import type { McpConnectionConfig } from './types.ts';

/**
 * Turn-time assembly of a profile's remote MCP tools, called from the
 * `slack-thread.ts` factory alongside `resolveProfileSkills`. `mcpServers` rides
 * inside the resolved agent, so it inherits the same freeze contract as skills
 * and instructions (frozen in the snapshot for channel threads, live-resolved
 * for DMs); secrets always resolve live from env/settings.
 *
 * GRACEFUL DEGRADE is the load-bearing contract here (deliberate divergence from
 * skillet's fail-closed): a dead or slow third-party server must never abort a
 * Slack reply. Every connection runs in parallel inside a closure that catches
 * its own errors and yields `[]`, so one failure never rejects the batch.
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
  // `undefined` is explicit: the slack-thread seam passes a possibly-undefined
  // env (node lane ignores it; CF supplies the binding), so the key is always
  // present but may hold undefined under exactOptionalPropertyTypes.
  env?: PlatformEnv | undefined;
  /** Tool + skill names already claimed by the agent; MCP collisions are dropped. */
  existingToolNames: string[];
  /** Test seam — defaults to Flue's `connectMcpServer`. */
  connect?: typeof connectMcpServer;
  /** Test seam — shortens the per-connect deadline; defaults to mcp-test's 8s. */
  connectTimeoutMs?: number;
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
  const eligible = servers.filter(
    (s) => s.enabled && s.lifecycleStatus === 'ready' && s.allowedTools.length > 0,
  );
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

async function resolveOneServer(
  server: McpConnectionConfig,
  opts: ResolveProfileMcpToolsOptions,
): Promise<ToolDefinition[]> {
  try {
    const secrets = await resolveMcpSecrets(server.id, server.headerNames, opts.env);
    const headers = buildMcpRequestHeaders(server.authMode, secrets);
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
    // Graceful degrade: skip this server, never abort the turn. Log SAFE text
    // only — raw error strings never reach logs, the DB, or the UI.
    console.warn('[chickpea] MCP connection ' + server.id + ' skipped: ' + safeMcpFailureText(err));
    return [];
  }
}

/**
 * `AgentRuntimeConfig` has no turn-end hook (verified against @flue/runtime
 * 1.0.0-beta.8). On Cloudflare, connection I/O is request-pinned and dies with
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
