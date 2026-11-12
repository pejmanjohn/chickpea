import {
  PROTOCOL_VERSION_META_KEY,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type RequestId,
  type Transport,
} from '@modelcontextprotocol/server';

import { cardRefusal, withRefusalOutput } from './card-host.ts';
import { mcpErrorResult, type McpToolError } from './conventions.ts';
import {
  REMOVED_RESOURCE_MESSAGE,
  removedPrompt,
  removedPromptMessage,
  removedResource,
  removedTool,
  removedToolResult,
  type RemovedToolName,
} from './removed-v4.ts';

/** On a card session, the tools whose refusals are results (tools.ts `cardReceives`). */
export interface CardRefusals {
  session(): boolean;
  tools: ReadonlySet<string>;
}

const NO_CARDS: CardRefusals = { session: () => false, tools: new Set() };

/**
 * What the SDK cannot express for a 5.0 tool, applied to the messages this
 * transport sends. Call before the server connects, as with
 * `observeMcpRequests`.
 *
 * - `tools/list` emits a fixed descriptor field set, so a tool's top-level
 *   `securitySchemes` (OpenAI's primary placement) is copied from the
 *   `_meta.securitySchemes` mirror the tool registers.
 * - An error the SDK makes itself (input validation, a failed output check)
 *   is plain text. For a 5.0 tool it becomes the 5.0 error shape, so every
 *   error from these tools carries `structuredContent.error`.
 * - On a card session, a refusal from a tool a card receives becomes a
 *   result (`cardRefusal`), and that tool's listed output schema names the
 *   refusal too. The SDK checks a result against its tool's own schema
 *   before it gets here, so the refusal leaves the tool as an error.
 * - A call of a tool, prompt or resource 5.0.0 removed gets an answer that
 *   names its replacement (removed-v4.ts), for every client. The SDK answers
 *   each with a protocol error, since none is registered. A tool's becomes an
 *   error result, which a client passes to its model; it carries the
 *   `resultType` a 2026-07-28 client requires, when the request names its
 *   revision, and stays an error on a card session too. A prompt's or
 *   resource's keeps its code and gets a message saying what replaced it.
 */
export function shapeFiveZeroResults(
  transport: Transport,
  toolNames: ReadonlySet<string>,
  cards: CardRefusals = NO_CARDS,
): void {
  const toolLists = new Set<RequestId>();
  const fiveZeroCalls = new Map<RequestId, string>();
  const removed = new Map<RequestId, Removed>();
  const onmessage = transport.onmessage;
  transport.onmessage = (message, extra) => {
    try {
      if (isJSONRPCRequest(message)) {
        if (message.method === 'tools/list') toolLists.add(message.id);
        const params = message.params as { name?: unknown; uri?: unknown; _meta?: unknown } | undefined;
        const name = params?.name;
        if (message.method === 'tools/call' && typeof name === 'string' && toolNames.has(name)) {
          fiveZeroCalls.set(message.id, name);
        }
        if (message.method === 'tools/call' && typeof name === 'string' && removedTool(name)) {
          const meta = params?._meta;
          removed.set(message.id, { tool: name, namesRevision: typeof meta === 'object' && meta !== null && PROTOCOL_VERSION_META_KEY in meta });
        }
        if (message.method === 'prompts/get' && typeof name === 'string' && removedPrompt(name)) {
          removed.set(message.id, { message: removedPromptMessage(name) });
        }
        if (message.method === 'resources/read' && typeof params?.uri === 'string' && removedResource(params.uri)) {
          removed.set(message.id, { message: REMOVED_RESOURCE_MESSAGE });
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
    if (!(isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) || message.id === undefined) return message;
    const answer = removed.get(message.id);
    removed.delete(message.id);
    if (answer !== undefined && isJSONRPCErrorResponse(message)) {
      if ('tool' in answer) {
        return { jsonrpc: '2.0', id: message.id, result: {
          ...removedToolResult(answer.tool),
          ...answer.namesRevision ? { resultType: 'complete' } : {},
        } };
      }
      return { jsonrpc: '2.0', id: message.id, error: { code: message.error.code, message: answer.message } };
    }
    if (!isJSONRPCResultResponse(message)) return message;
    if (toolLists.delete(message.id)) return listed(message, cards.session() ? cards.tools : NO_CARDS.tools);
    const tool = fiveZeroCalls.get(message.id);
    if (tool === undefined) return message;
    fiveZeroCalls.delete(message.id);
    const result = withFiveZeroError(message, tool);
    return cards.session() && cards.tools.has(tool) ? asResult(result) : result;
  }
}

/** A request for something 5.0.0 removed, and how to answer it. */
type Removed = { tool: RemovedToolName; namesRevision: boolean } | { message: string };

type ResultResponse = Extract<JSONRPCMessage, { result: unknown }>;

function listed(message: ResultResponse, refusing: ReadonlySet<string>): JSONRPCMessage {
  const tools = (message.result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return message;
  return {
    ...message,
    result: {
      ...message.result,
      tools: tools.map((tool: Record<string, unknown>) => {
        const schemes = (tool._meta as { securitySchemes?: unknown } | undefined)?.securitySchemes;
        const output = tool.outputSchema;
        return {
          ...tool,
          ...Array.isArray(schemes) && !('securitySchemes' in tool) ? { securitySchemes: schemes } : {},
          ...refusing.has(tool.name as string) && typeof output === 'object' && output !== null
            ? { outputSchema: withRefusalOutput(output as Record<string, unknown>) }
            : {},
        };
      }),
    },
  };
}

function asResult(message: JSONRPCMessage): JSONRPCMessage {
  if (!isJSONRPCResultResponse(message)) return message;
  const result = message.result as { isError?: unknown; structuredContent?: { error?: McpToolError } };
  const error = result.structuredContent?.error;
  return result.isError === true && error !== undefined ? reshaped(message, cardRefusal(error)) : message;
}

/**
 * A result this transport rewrites keeps what the SDK stamped beside it. On
 * 2026-07-28 that is the required `resultType`, without which a client
 * rejects the whole result, and `_meta`. Earlier revisions stamp nothing.
 */
function reshaped(message: ResultResponse, result: ReturnType<typeof mcpErrorResult | typeof cardRefusal>): JSONRPCMessage {
  const { content: _content, structuredContent: _structured, isError: _isError, ...stamped } = message.result as Record<string, unknown>;
  return { ...message, result: { ...result, ...stamped } };
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
        message: 'Chickpea did not accept that request.',
        retryable: false,
        nextStep: `Fix the arguments and call ${tool} again. ${text.replace(/^Input validation error: /, '')}`,
      }
    : {
        code: 'temporarily_unavailable',
        message: 'Chickpea could not finish that request.',
        retryable: true,
        nextStep: 'Try the same call again in a moment.',
      };
  return reshaped(message, mcpErrorResult(error));
}
