import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createMcpGuardedFetch } from './mcp-url.ts';
import type { McpConnectionIdentity } from './types.ts';

const CONNECT_TIMEOUT_MS = 8_000;
const CALL_TIMEOUT_MS = 30_000;
const IDENTITY_TEXT_MAX = 160;

export interface McpIdentityInput {
  id: string;
  url: string;
  transport: 'streamable-http' | 'sse';
  headers: Record<string, string>;
  presetId?: string;
}

interface McpIdentityProbe {
  name: string;
  arguments: Record<string, unknown>;
}

type IdentityPayloadLoader = (
  input: McpIdentityInput,
  probe: McpIdentityProbe,
) => Promise<unknown>;

const IDENTITY_PROBES: Record<string, McpIdentityProbe> = {
  notion: { name: 'notion-fetch', arguments: { id: 'self' } },
  linear: { name: 'get_user', arguments: { query: 'me' } },
  airtable: { name: 'list_workspaces', arguments: {} },
  granola: { name: 'get_account_info', arguments: {} },
};

/**
 * Returns bounded, non-secret account labels when a preset exposes a safe
 * identity probe. Unknown presets deliberately return no identity rather than
 * guessing at provider-specific tools.
 */
export async function discoverMcpConnectionIdentity(
  input: McpIdentityInput,
  loadPayload: IdentityPayloadLoader = loadIdentityPayload,
): Promise<McpConnectionIdentity | undefined> {
  const presetId = input.presetId;
  if (!presetId) return undefined;
  const probe = IDENTITY_PROBES[presetId];
  if (!probe) return undefined;
  const payload = await loadPayload(input, probe);
  if (presetId === 'notion') return parseNotionIdentity(payload);
  if (presetId === 'linear') return parseLinearIdentity(payload);
  if (presetId === 'airtable') return parseAirtableIdentity(payload);
  if (presetId === 'granola') return parseGranolaIdentity(payload);
  return undefined;
}

async function loadIdentityPayload(
  input: McpIdentityInput,
  probe: McpIdentityProbe,
): Promise<unknown> {
  if (input.transport !== 'streamable-http') return undefined;
  const client = new Client({ name: 'chickpea', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(input.url), {
    requestInit: { headers: input.headers },
    fetch: createMcpGuardedFetch({ allowedOrigin: new URL(input.url).origin }),
  });
  try {
    // The SDK currently exposes structurally equivalent transport types from
    // two entrypoints whose exact optional properties do not unify under our
    // strict TypeScript settings. Keep the compatibility cast at this boundary.
    await client.connect(transport as Parameters<Client['connect']>[0], {
      timeout: CONNECT_TIMEOUT_MS,
    });
    const result = await client.callTool(
      probe,
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    );
    if (!isRecord(result) || result.isError === true) return undefined;
    if (isRecord(result.structuredContent)) return result;
    if (!Array.isArray(result.content)) return undefined;
    const text = result.content.find(
      (entry) => isRecord(entry) && entry.type === 'text' && typeof entry.text === 'string',
    );
    if (!isRecord(text) || typeof text.text !== 'string') return undefined;
    return JSON.parse(text.text) as unknown;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function parseNotionIdentity(value: unknown): McpConnectionIdentity | undefined {
  if (!isRecord(value) || !isRecord(value.self)) return undefined;
  const workspace = isRecord(value.self.workspace) ? value.self.workspace : undefined;
  const user = isRecord(value.self.user) ? value.self.user : undefined;
  const workspaceName = boundedLabel(workspace?.name);
  const accountName = boundedLabel(user?.name);
  if (!workspaceName && !accountName) return undefined;
  return {
    ...(workspaceName ? { workspaceName } : {}),
    ...(accountName ? { accountName } : {}),
  };
}

function parseLinearIdentity(value: unknown): McpConnectionIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const accountName = boundedLabel(value.displayName) ?? boundedLabel(value.name);
  return accountName ? { accountName } : undefined;
}

function parseAirtableIdentity(value: unknown): McpConnectionIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const content = isRecord(value.structuredContent) ? value.structuredContent : value;
  if (!Array.isArray(content.workspaces)) return undefined;
  const workspaces = content.workspaces.filter(isRecord);
  if (workspaces.length === 0) return undefined;
  if (workspaces.length === 1) {
    const workspaceName = boundedLabel(workspaces[0]?.name);
    return workspaceName ? { workspaceName } : undefined;
  }
  return { workspaceName: `${workspaces.length} accessible workspaces` };
}

function parseGranolaIdentity(value: unknown): McpConnectionIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const content = isRecord(value.structuredContent) ? value.structuredContent : value;
  const account = isRecord(content.account)
    ? content.account
    : isRecord(content.user)
      ? content.user
      : undefined;
  const workspace =
    content.active_workspace ?? content.activeWorkspace ?? content.workspace;
  const workspaceName = boundedLabel(
    isRecord(workspace) ? workspace.name ?? workspace.title : workspace,
  );
  const accountName =
    boundedLabel(content.email) ??
    boundedLabel(content.account_email) ??
    boundedLabel(account?.email);
  if (!workspaceName && !accountName) return undefined;
  return {
    ...(workspaceName ? { workspaceName } : {}),
    ...(accountName ? { accountName } : {}),
  };
}

function boundedLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.slice(0, IDENTITY_TEXT_MAX);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
