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

type IdentityPayloadLoader = (input: McpIdentityInput) => Promise<unknown>;

/**
 * Returns bounded, non-secret account labels when a preset exposes a safe
 * identity probe. Unknown presets deliberately return no identity rather than
 * guessing at provider-specific tools.
 */
export async function discoverMcpConnectionIdentity(
  input: McpIdentityInput,
  loadPayload: IdentityPayloadLoader = loadNotionIdentityPayload,
): Promise<McpConnectionIdentity | undefined> {
  if (input.presetId !== 'notion') return undefined;
  return parseNotionIdentity(await loadPayload(input));
}

async function loadNotionIdentityPayload(input: McpIdentityInput): Promise<unknown> {
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
      { name: 'notion-fetch', arguments: { id: 'self' } },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    );
    if (!isRecord(result) || result.isError === true || !Array.isArray(result.content)) {
      return undefined;
    }
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

function boundedLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.slice(0, IDENTITY_TEXT_MAX);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
