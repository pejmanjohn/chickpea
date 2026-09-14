import {
  createMcpConnection,
  type McpConnection,
  type McpConnectionDefinition,
  type ToolDefinition,
} from '@flue/runtime';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { McpBlockedUrlError } from './mcp-errors.ts';
import { isMetaAdsMcpConnection, isReviewedMetaAdsTool } from './meta-ads-policy.ts';
import {
  createMcpGuardedFetch,
  validateMcpUrl,
  type McpGuardedFetchOptions,
} from './mcp-url.ts';
import type {
  McpConnectionToolInfo,
  McpToolInputSchemaProjection,
} from './types.ts';

/**
 * Shared connect + discover routine for MCP connections. Reused by the admin
 * test-connection route and the turn-time resolver so the SSRF guard, connect
 * deadline, prefix stripping, and truncation live in exactly one place.
 *
 * Both entry points run the SSRF guard first (turn-time re-check) and throw a
 * classifiable `McpBlockedUrlError` on reject. Flue's `timeoutMs` bounds MCP
 * *requests*, not the initial connect, so we wrap `connect(...)` in our own
 * `Promise.race` deadline; the `timeoutMs` we pass through only bounds tool
 * calls. Raw errors from `connect` propagate unchanged — callers classify them
 * via `classifyMcpError`/`safeMcpFailureText`.
 */

const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const MAX_TOOLS = 50;
const MAX_META_DISCOVERY_RAW_TOOLS = 1_024;
const MAX_META_DISCOVERY_PAGES = 20;
const MAX_META_DISCOVERY_TIMEOUT_MS = 30_000;
const NAME_MAX = 120;
const DESCRIPTION_MAX = 400;
const TOOL_NAME_PREFIX = /^mcp__[^_]+(?:_[^_]+)*__/;
const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_NODES = 4_096;
const MAX_SCHEMA_KEYS = 256;
const MAX_SCHEMA_ARRAY = 256;
const MAX_SCHEMA_STRING = 4_096;
const MAX_PROJECTED_PROPERTIES = 64;
const MAX_PROPERTY_NAME = 120;

export interface McpDiscoveryResult {
  tools: McpConnectionToolInfo[];
}

export interface McpConnectInput {
  /** Used as the Flue server name, which becomes the `mcp__<id>__` tool prefix. */
  id: string;
  url: string;
  transport: 'streamable-http' | 'sse';
  headers: Record<string, string>;
  /** When present, each request resolves fresh headers instead of retaining these headers. */
  resolveHeaders?: () => Promise<Record<string, string>>;
  /** Deadline around the initial connect (Flue's timeoutMs does not bound it). */
  connectTimeoutMs?: number;
  /** Per-request timeout passed to `createMcpConnection` (bounds tool calls). */
  callTimeoutMs?: number;
}

export type McpConnector = (
  name: string,
  definition: Omit<McpConnectionDefinition, 'name'>,
) => Promise<McpConnection>;
export type McpServerConnection = McpConnection;
export type McpServerOptions = Omit<McpConnectionDefinition, 'name'>;

const connectWithFlueV2: McpConnector = (name, definition) =>
  createMcpConnection({ name, ...definition });

/**
 * Connect + list tools + close. Generic servers retain their first 50 tools.
 * Meta Ads scans a separately bounded complete catalog and retains only the
 * reviewed reporting tools, including schema-incompatible entries that the UI
 * must explain. Throws classifiable errors; callers map via classify/safeText.
 * The connection is always closed in `finally`.
 */
export async function discoverMcpTools(
  input: McpConnectInput,
  connect?: McpConnector,
  createGuardedFetch: (options: McpGuardedFetchOptions) => typeof fetch = createMcpGuardedFetch,
): Promise<McpDiscoveryResult> {
  // Discovery needs the protocol metadata that Flue's executable tool adapter
  // intentionally omits. Keep invocation on Flue, but discover with the SDK.
  if (!connect) return discoverProtocolTools(input, createGuardedFetch);
  const connection = await connectMcp(input, connect);
  try {
    return { tools: mapTools(
      input.id,
      connection.tools,
      isMetaAdsMcpConnection({ url: input.url }),
    ) };
  } finally {
    await connection.close().catch(() => undefined);
  }
}

async function discoverProtocolTools(
  input: McpConnectInput,
  createGuardedFetch: (options: McpGuardedFetchOptions) => typeof fetch,
): Promise<McpDiscoveryResult> {
  const validated = validateMcpUrl(input.url);
  if (!validated.ok) throw new McpBlockedUrlError(validated.reason);
  const controller = new AbortController();
  const fetch = createGuardedFetch({
    allowedOrigin: new URL(validated.url).origin,
    signal: controller.signal,
  });
  const options = { requestInit: { headers: input.headers }, fetch };
  const transport = input.transport === 'sse'
    ? new SSEClientTransport(new URL(validated.url), options)
    : new StreamableHTTPClientTransport(new URL(validated.url), options);
  // Tool output schemas are compiled during listTools. Use the SDK's
  // interpreter so discovery also works where dynamic code is prohibited.
  const client = new Client({ name: 'chickpea', version: '1' }, {
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
  });
  try {
    await raceDeadline(
      // SDK entrypoints disagree only on the optional sessionId property.
      client.connect(transport as Parameters<Client['connect']>[0]),
      input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      (error) => controller.abort(error),
    );
    const tools: McpConnectionToolInfo[] = [];
    const cursors = new Set<string>();
    const metaAds = isMetaAdsMcpConnection({ url: validated.url });
    const reviewedNames = new Set<string>();
    let rawToolCount = 0;
    let pageCount = 0;
    let cursor: string | undefined;
    const listTools = async (): Promise<void> => {
      do {
        pageCount += 1;
        const page = await client.listTools(cursor ? { cursor } : {}, {
          timeout: input.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
        });
        rawToolCount += page.tools.length;
        if (metaAds && rawToolCount > MAX_META_DISCOVERY_RAW_TOOLS) {
          throw new Error('Meta Ads MCP discovery exceeded the raw tool limit.');
        }
        for (const tool of page.tools) {
          if (metaAds && isReviewedMetaAdsTool(tool.name)) {
            if (reviewedNames.has(tool.name)) {
              throw new Error(`Meta Ads MCP discovery returned duplicate reviewed tool ${tool.name}.`);
            }
            reviewedNames.add(tool.name);
          }
          if (metaAds && !isReviewedMetaAdsTool(tool.name)) continue;
          if (tool.execution?.taskSupport === 'required') continue;
          if (!metaAds && tools.length >= MAX_TOOLS) break;
          if (!supportedToolName(tool.name)) continue;
          const description = truncate(tool.description, DESCRIPTION_MAX);
          const title = truncate(tool.title ?? tool.annotations?.title, 160);
          const inputSchema = projectMcpToolInputSchema(tool.inputSchema);
          tools.push({
            name: tool.name,
            ...(title ? { title } : {}),
            ...(description ? { description } : {}),
            ...(typeof tool.annotations?.readOnlyHint === 'boolean'
              ? { readOnlyHint: tool.annotations.readOnlyHint } : {}),
            inputSchema,
          });
        }
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('MCP discovery repeated a cursor.');
        if (cursor) cursors.add(cursor);
        if (metaAds && cursor && pageCount >= MAX_META_DISCOVERY_PAGES) {
          throw new Error('Meta Ads MCP discovery exceeded the page limit.');
        }
      } while (cursor && (metaAds || tools.length < MAX_TOOLS));
    };
    if (metaAds) {
      await raceDeadline(
        listTools(),
        Math.min(input.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, MAX_META_DISCOVERY_TIMEOUT_MS),
        (error) => controller.abort(error),
        'Meta Ads MCP discovery',
      );
      return { tools };
    }
    await listTools();
    return { tools };
  } finally {
    controller.abort();
    await client.close().catch(() => undefined);
  }
}

/**
 * Connect and RETURN the live connection — the caller owns closing it. Used by
 * the turn-time resolver, which holds the connection open for tool calls.
 */
export async function connectMcp(
  input: McpConnectInput,
  connect: McpConnector = connectWithFlueV2,
  createGuardedFetch: (options: McpGuardedFetchOptions) => typeof fetch = createMcpGuardedFetch,
): Promise<McpConnection> {
  const validated = validateMcpUrl(input.url);
  if (!validated.ok) {
    throw new McpBlockedUrlError(validated.reason);
  }
  const deadlineMs = input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const callTimeoutMs = input.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const guardedFetch = createGuardedFetch({
    allowedOrigin: new URL(validated.url).origin,
    signal: controller.signal,
  });
  const fetch = input.resolveHeaders
    ? async (requestInput: RequestInfo | URL, requestInit?: RequestInit): Promise<Response> => {
        const request = new Request(requestInput, requestInit);
        const headers = new Headers(request.headers);
        for (const [name, value] of Object.entries(await input.resolveHeaders!())) headers.set(name, value);
        return guardedFetch(new Request(request, { headers }));
      }
    : guardedFetch;
  const pending = connect(input.id, {
    url: validated.url,
    transport: input.transport,
    headers: input.resolveHeaders ? {} : input.headers,
    timeoutMs: callTimeoutMs,
    fetch,
  });
  // A non-conforming connector may ignore the abort and resolve after our
  // deadline. Reclaim that late connection instead of leaking it indefinitely.
  void pending.then(
    (connection) => {
      if (timedOut) void connection.close().catch(() => undefined);
    },
    () => undefined,
  );
  return raceDeadline(pending, deadlineMs, (timeoutError) => {
    timedOut = true;
    controller.abort(timeoutError);
  });
}

function raceDeadline<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: (timeoutError: Error) => void,
  label = 'connect',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const timeoutError = new Error(label + ' timeout after ' + ms + 'ms');
      onTimeout(timeoutError);
      reject(timeoutError);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function mapTools(id: string, tools: ToolDefinition[], metaAds = false): McpConnectionToolInfo[] {
  if (metaAds && tools.length > MAX_META_DISCOVERY_RAW_TOOLS) {
    throw new Error('Meta Ads MCP discovery exceeded the raw tool limit.');
  }
  const mapped: McpConnectionToolInfo[] = [];
  const reviewedNames = new Set<string>();
  for (const raw of tools) {
    const name = stripPrefix(id, raw.name);
    if (metaAds) {
      if (!isReviewedMetaAdsTool(name)) continue;
      if (reviewedNames.has(name)) {
        throw new Error(`Meta Ads MCP discovery returned duplicate reviewed tool ${name}.`);
      }
      reviewedNames.add(name);
    } else if (mapped.length >= MAX_TOOLS) {
      break;
    }
    if (!supportedToolName(name)) continue;
    mapped.push(toDiscovered(id, raw));
  }
  return mapped;
}

function toDiscovered(id: string, raw: ToolDefinition): McpConnectionToolInfo {
  const name = stripPrefix(id, raw.name);
  // Flue's adapter folds any MCP tool title into the description string, so the
  // adapted ToolDefinition never exposes a title field — we surface description
  // only. The stored McpDiscoveredTool keeps an optional `title` for schema
  // symmetry, populated if a future runtime ever surfaces one directly.
  const description = truncate(raw.description, DESCRIPTION_MAX);
  return {
    name,
    ...(description ? { description } : {}),
  };
}

/**
 * Keep only the authenticated schema evidence needed to prove an exact Meta
 * ad-account argument. The full schema is hashed, not persisted. Unsupported
 * root composition, alternate account selectors, optional account fields, and
 * unbounded schemas remain discoverable but cannot become account-scoped tools.
 */
export function projectMcpToolInputSchema(inputSchema: unknown): McpToolInputSchemaProjection {
  const bounded = boundedCanonicalSchema(inputSchema);
  const accountFields: McpToolInputSchemaProjection['accountFields'] = [];
  let propertyNames: string[] = [];
  let ambiguous = bounded.truncated;
  if (!isRecord(inputSchema) || inputSchema.type !== 'object' || !isRecord(inputSchema.properties)) {
    ambiguous = true;
  } else {
    const names = Object.keys(inputSchema.properties);
    propertyNames = names.filter((name) => name.length <= MAX_PROPERTY_NAME)
      .sort().slice(0, MAX_PROJECTED_PROPERTIES);
    if (names.length > MAX_PROJECTED_PROPERTIES || propertyNames.length !== names.length) ambiguous = true;
    if (['$ref', 'oneOf', 'anyOf', 'allOf'].some((key) => key in inputSchema)) ambiguous = true;
    const required = Array.isArray(inputSchema.required) && inputSchema.required.every((value) => typeof value === 'string')
      ? new Set(inputSchema.required as string[])
      : new Set<string>();
    if (inputSchema.required !== undefined &&
        (!Array.isArray(inputSchema.required) || !inputSchema.required.every((value) => typeof value === 'string'))) {
      ambiguous = true;
    }
    for (const [name, definition] of Object.entries(inputSchema.properties)) {
      if (name !== 'ad_account_id' && name !== 'account_id') {
        if (looksLikeAlternateTargetSelector(name) || containsNestedAccountSelector(definition)) ambiguous = true;
        continue;
      }
      if (!isRecord(definition) || definition.type !== 'string' ||
          ['$ref', 'oneOf', 'anyOf', 'allOf'].some((key) => key in definition)) {
        ambiguous = true;
        continue;
      }
      const isRequired = required.has(name);
      accountFields.push({ name, type: 'string', required: isRequired });
      if (!isRequired) ambiguous = true;
    }
  }
  if (accountFields.length !== 1) ambiguous = true;
  return {
    accountFields,
    propertyNames,
    ambiguous,
    fingerprint: bytesToHex(sha256(new TextEncoder().encode(bounded.value))),
  };
}

function looksLikeAlternateAccountSelector(name: string): boolean {
  return /account/i.test(name) && /id/i.test(name);
}

function looksLikeAlternateTargetSelector(name: string): boolean {
  return looksLikeAlternateAccountSelector(name) || /(?:^|_)ids?$/i.test(name);
}

function containsNestedAccountSelector(value: unknown, depth = 0): boolean {
  if (depth > MAX_SCHEMA_DEPTH) return false;
  if (Array.isArray(value)) return value.some((entry) => containsNestedAccountSelector(entry, depth + 1));
  if (!isRecord(value)) return false;
  const properties = isRecord(value.properties) ? value.properties : undefined;
  if (properties && Object.entries(properties).some(([name, definition]) =>
    name === 'ad_account_id' || name === 'account_id' || looksLikeAlternateTargetSelector(name) ||
      containsNestedAccountSelector(definition, depth + 1))) return true;
  if (containsNestedAccountSelector(value.items, depth + 1) ||
      containsNestedAccountSelector(value.additionalProperties, depth + 1) ||
      containsNestedAccountSelector(value.unevaluatedProperties, depth + 1)) return true;
  return ['oneOf', 'anyOf', 'allOf', 'prefixItems'].some((key) => Array.isArray(value[key]) &&
    (value[key] as unknown[]).some((entry) => containsNestedAccountSelector(entry, depth + 1)));
}

function boundedCanonicalSchema(value: unknown): { value: string; truncated: boolean } {
  const state = { nodes: 0, truncated: false };
  const visit = (current: unknown, depth: number): unknown => {
    state.nodes += 1;
    if (state.nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) {
      state.truncated = true;
      return '[schema-limit]';
    }
    if (current === null || typeof current === 'boolean' || typeof current === 'number') return current;
    if (typeof current === 'string') {
      if (current.length <= MAX_SCHEMA_STRING) return current;
      // Hash the complete string so long schema annotations remain bounded
      // without making an otherwise exact input contract ambiguous. Every
      // ordinary object key below is namespaced with `value:` or `sha256:`, so
      // this unnamespaced marker cannot collide with any transformed schema
      // object, string, or array.
      return {
        '$schema-string-sha256': bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(current)))),
        length: current.length,
      };
    }
    if (Array.isArray(current)) {
      if (current.length > MAX_SCHEMA_ARRAY) state.truncated = true;
      return current.slice(0, MAX_SCHEMA_ARRAY).map((entry) => visit(entry, depth + 1));
    }
    if (!isRecord(current)) {
      state.truncated = true;
      return `[unsupported:${typeof current}]`;
    }
    const keys = Object.keys(current).sort();
    if (keys.length > MAX_SCHEMA_KEYS) state.truncated = true;
    return Object.fromEntries(keys.slice(0, MAX_SCHEMA_KEYS).map((key) => {
      const boundedKey = key.length <= MAX_PROPERTY_NAME
        ? `value:${key}`
        : `sha256:${bytesToHex(sha256(new TextEncoder().encode(key)))}`;
      return [boundedKey, visit(current[key], depth + 1)];
    }));
  };
  return { value: JSON.stringify(visit(value, 0)), truncated: state.truncated };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function supportedToolName(name: string): boolean {
  if (name.length <= NAME_MAX) return true;
  console.warn('MCP discovery omitted a tool whose identifier exceeds the supported length.');
  return false;
}

/**
 * Flue names adapted tools `mcp__<server>__<tool>`. Strip that prefix for the
 * stored/displayed name so the profile allowlist matches the bare tool name.
 * Falls back to a generic strip if the id-specific prefix does not match.
 */
function stripPrefix(id: string, name: string): string {
  const specific = 'mcp__' + id + '__';
  if (name.startsWith(specific)) {
    return name.slice(specific.length);
  }
  return name.replace(TOOL_NAME_PREFIX, '');
}

/** Collapse whitespace runs to single spaces, trim, and slice to `max`. */
function truncate(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return undefined;
  return collapsed.length > max ? collapsed.slice(0, max) : collapsed;
}
