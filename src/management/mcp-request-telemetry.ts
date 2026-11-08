import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type RequestId,
  type Transport,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
  emitManagementMetric,
  emitMcpToolInputRefusal,
  type ManagementMetricValue,
} from './telemetry.ts';

type McpToolInputSchemas = Readonly<Record<string, z.ZodType>>;

interface PendingRequest {
  readonly fields: Record<string, ManagementMetricValue>;
  readonly startedAt: number;
  readonly toolCall?: { readonly name: string; readonly args: unknown };
}

/**
 * The clients the `client` label names, by `clientInfo.name`. Any other name
 * is `other`, so no client-chosen text reaches a metric.
 */
const MCP_CLIENT_TOKENS: Readonly<Record<string, string>> = {
  'openai-mcp': 'openai-mcp',
  'openai-mcp (Codex)': 'openai-mcp-codex',
  'codex-mcp-client': 'codex-mcp-client',
  'claude-code': 'claude-code',
  'claude-ai': 'claude-ai',
  'gemini-cli-mcp-client': 'gemini-cli-mcp-client',
  'chickpea-cli': 'chickpea-cli',
};

const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';

/**
 * Which client sent a message, as a closed token. `clientInfo.name` comes from
 * `initialize`, or from each request's `_meta` in the 2026-07-28 era. On the
 * stateless legacy door only `initialize` carries it, so any other message
 * falls back to the User-Agent, whose product and comment repeat the name for
 * the clients measured: `openai-mcp/1.0.0`, `openai-mcp/1.0.0 (Codex)` and
 * `codex-mcp-client/0.160.1`.
 */
function mcpClientToken(message: JSONRPCMessage, extra: MessageExtraInfo | undefined): string {
  const params = ('params' in message ? message.params : undefined) as Record<string, unknown> | undefined;
  const fromInit = isJSONRPCRequest(message) && message.method === 'initialize'
    ? (params?.clientInfo as { name?: unknown } | undefined)?.name
    : undefined;
  const fromMeta = ((params?._meta as Record<string, unknown> | undefined)?.[CLIENT_INFO_META_KEY] as
    { name?: unknown } | undefined)?.name;
  const named = typeof fromInit === 'string' ? fromInit : typeof fromMeta === 'string' ? fromMeta : undefined;
  const names = named !== undefined ? [named] : userAgentClientNames(extra?.request?.headers.get('user-agent'));
  if (names.length === 0) return 'unknown';
  const known = names.find((name) => Object.hasOwn(MCP_CLIENT_TOKENS, name));
  return known === undefined ? 'other' : MCP_CLIENT_TOKENS[known]!;
}

/**
 * `name/version (comment)` as `name (comment)`, the way those clients spell
 * clientInfo.name, then the bare product name.
 */
function userAgentClientNames(userAgent: string | null | undefined): string[] {
  const match = userAgent?.match(/^([^\s/]+)\/\S+(?: \(([^)]*)\))?/);
  if (!match?.[1]) return [];
  return match[2] ? [`${match[1]} (${match[2]})`, match[1]] : [match[1]];
}

/**
 * Emit one `mcp.request` metric for each JSON-RPC message this transport
 * carries: a notification when it arrives, a request when its response is
 * sent. Call before the server connects, so the SDK chains `onmessage` ahead of
 * its own dispatch. Arguments stay in memory only to tell a schema refusal
 * apart from a tool error; nothing but allowlisted tokens is emitted.
 */
export function observeMcpRequests(transport: Transport, inputSchemas: McpToolInputSchemas): void {
  const pending = new Map<RequestId, PendingRequest>();
  const onmessage = transport.onmessage;
  transport.onmessage = (message, extra) => {
    try {
      receive(message, extra);
    } catch {
      // Observability never changes MCP behavior.
    }
    onmessage?.(message, extra);
  };
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    try {
      settle(message);
    } catch {
      // Observability never changes MCP behavior.
    }
    return send(message, options);
  };
  const onclose = transport.onclose;
  transport.onclose = () => {
    for (const request of pending.values()) finish(request, { outcome: 'abandoned' });
    pending.clear();
    onclose?.();
  };

  function receive(message: JSONRPCMessage, extra: MessageExtraInfo | undefined): void {
    const client = mcpClientToken(message, extra);
    if (isJSONRPCNotification(message)) {
      emitManagementMetric('mcp.request', { method: message.method, client, outcome: 'received' });
      return;
    }
    if (!isJSONRPCRequest(message)) return;
    const params = (message.params ?? {}) as Record<string, unknown>;
    const fields: Record<string, ManagementMetricValue> = { method: message.method, client };
    let toolCall: PendingRequest['toolCall'];
    if (message.method === 'tools/call' && typeof params.name === 'string') {
      fields.tool = params.name;
      toolCall = { name: params.name, args: params.arguments };
    }
    if (message.method === 'resources/read' && typeof params.uri === 'string') {
      fields.resource = params.uri;
    }
    pending.set(message.id, { fields, startedAt: Date.now(), ...(toolCall ? { toolCall } : {}) });
  }

  function settle(message: JSONRPCMessage): void {
    const isResult = isJSONRPCResultResponse(message);
    if (!isResult && !isJSONRPCErrorResponse(message)) return;
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (!isResult) {
      finish(request, { outcome: 'jsonrpc_error', errorCode: String(message.error.code) });
      return;
    }
    if (!request.toolCall || message.result.isError !== true) {
      finish(request, { outcome: 'success' });
      return;
    }
    finish(request, { outcome: refusedInput(request.toolCall) ? 'input_refused' : 'tool_error' });
  }

  function finish(request: PendingRequest, result: Record<string, ManagementMetricValue>): void {
    emitManagementMetric('mcp.request', {
      ...request.fields,
      ...result,
      durationMs: Date.now() - request.startedAt,
    });
  }

  /**
   * The SDK validates with these same schemas before the handler runs, so an
   * error result whose arguments fail them is a refusal. Parses only on errors.
   */
  function refusedInput(call: NonNullable<PendingRequest['toolCall']>): boolean {
    const schema = inputSchemas[call.name];
    if (!schema) return false;
    const parsed = schema.safeParse(call.args ?? {});
    if (parsed.success) return false;
    emitMcpToolInputRefusal(call.name, parsed.error.issues, schemaPropertyNames(schema));
    return true;
  }
}

const propertyNamesBySchema = new WeakMap<z.ZodType, ReadonlySet<string>>();

/** Every property name the schema declares, at any depth. Record keys are not declared. */
function schemaPropertyNames(schema: z.ZodType): ReadonlySet<string> {
  const cached = propertyNamesBySchema.get(schema);
  if (cached) return cached;
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
        for (const name of Object.keys(value)) names.add(name);
      }
      visit(value);
    }
  };
  try {
    visit(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }));
  } catch {
    // An unconvertible schema names no fields; every key becomes `*`.
  }
  propertyNamesBySchema.set(schema, names);
  return names;
}
