import {
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type RequestId,
  type Transport,
} from '@modelcontextprotocol/server';

import { mcpErrorResult, type McpToolError } from './conventions.ts';

/**
 * Two things the SDK cannot express for a 5.0 tool, applied to the messages
 * this transport sends. Call before the server connects, as with
 * `observeMcpRequests`.
 *
 * - `tools/list` emits a fixed descriptor field set, so a tool's top-level
 *   `securitySchemes` (OpenAI's primary placement) is copied from the
 *   `_meta.securitySchemes` mirror the tool registers. Only 5.0 tools carry it.
 * - An error the SDK makes itself (input validation, a failed output check)
 *   is plain text. For a 5.0 tool it becomes the 5.0 error shape, so every
 *   error from these tools carries `structuredContent.error`. A 4.x tool's
 *   result passes through untouched.
 */
export function shapeFiveZeroResults(transport: Transport, toolNames: ReadonlySet<string>): void {
  const toolLists = new Set<RequestId>();
  const fiveZeroCalls = new Map<RequestId, string>();
  const onmessage = transport.onmessage;
  transport.onmessage = (message, extra) => {
    try {
      if (isJSONRPCRequest(message)) {
        if (message.method === 'tools/list') toolLists.add(message.id);
        const name = (message.params as { name?: unknown } | undefined)?.name;
        if (message.method === 'tools/call' && typeof name === 'string' && toolNames.has(name)) {
          fiveZeroCalls.set(message.id, name);
        }
      }
    } catch {
      // Shaping never changes how a message is dispatched.
    }
    onmessage?.(message, extra);
  };
  const send = transport.send.bind(transport);
  transport.send = (message, options) => send(shaped(message), options);

  function shaped(message: JSONRPCMessage): JSONRPCMessage {
    if (!isJSONRPCResultResponse(message) || message.id === undefined) return message;
    if (toolLists.delete(message.id)) return withSecuritySchemes(message);
    const tool = fiveZeroCalls.get(message.id);
    if (tool === undefined) return message;
    fiveZeroCalls.delete(message.id);
    return withFiveZeroError(message, tool);
  }
}

type ResultResponse = Extract<JSONRPCMessage, { result: unknown }>;

function withSecuritySchemes(message: ResultResponse): JSONRPCMessage {
  const tools = (message.result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return message;
  return {
    ...message,
    result: {
      ...message.result,
      tools: tools.map((tool: Record<string, unknown>) => {
        const schemes = (tool._meta as { securitySchemes?: unknown } | undefined)?.securitySchemes;
        return Array.isArray(schemes) && !('securitySchemes' in tool) ? { ...tool, securitySchemes: schemes } : tool;
      }),
    },
  };
}

function withFiveZeroError(message: ResultResponse, tool: string): JSONRPCMessage {
  const result = message.result as {
    isError?: unknown;
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: { error?: unknown };
  };
  if (result.isError !== true || result.structuredContent?.error !== undefined) return message;
  const text = result.content?.find((part) => part.type === 'text')?.text ?? '';
  const error: McpToolError = text.startsWith('Input validation error:')
    ? {
        code: 'invalid_input',
        message: `${tool} did not accept these arguments.`,
        retryable: false,
        nextStep: `Fix the arguments and call ${tool} again. ${text.replace(/^Input validation error: /, '')}`,
      }
    : {
        code: 'temporarily_unavailable',
        message: 'Chickpea could not finish that request.',
        retryable: true,
        nextStep: 'Try the same call again in a moment.',
      };
  return { ...message, result: mcpErrorResult(error) };
}
