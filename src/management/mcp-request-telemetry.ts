import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
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
      receive(message);
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

  function receive(message: JSONRPCMessage): void {
    if (isJSONRPCNotification(message)) {
      emitManagementMetric('mcp.request', { method: message.method, outcome: 'received' });
      return;
    }
    if (!isJSONRPCRequest(message)) return;
    const params = (message.params ?? {}) as Record<string, unknown>;
    const fields: Record<string, ManagementMetricValue> = { method: message.method };
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
