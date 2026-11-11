import {
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type RequestId,
  type Transport,
} from '@modelcontextprotocol/server';

import { cardRefusal, withRefusalOutput } from './card-host.ts';
import { mcpErrorResult, type McpToolError } from './conventions.ts';

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
 *   `_meta.securitySchemes` mirror the tool registers. Only 5.0 tools carry it.
 * - An error the SDK makes itself (input validation, a failed output check)
 *   is plain text. For a 5.0 tool it becomes the 5.0 error shape, so every
 *   error from these tools carries `structuredContent.error`. A 4.x tool's
 *   result passes through untouched.
 * - On a card session, a refusal from a tool a card receives becomes a
 *   result (`cardRefusal`), and that tool's listed output schema names the
 *   refusal too. The SDK checks a result against its tool's own schema
 *   before it gets here, so the refusal leaves the tool as an error.
 */
export function shapeFiveZeroResults(transport: Transport, toolNames: ReadonlySet<string>, cards: CardRefusals = NO_CARDS): void {
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
    if (toolLists.delete(message.id)) return listed(message, cards.session() ? cards.tools : NO_CARDS.tools);
    const tool = fiveZeroCalls.get(message.id);
    if (tool === undefined) return message;
    fiveZeroCalls.delete(message.id);
    const result = withFiveZeroError(message, tool);
    return cards.session() && cards.tools.has(tool) ? asResult(result) : result;
  }
}

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
  return result.isError === true && error !== undefined ? { ...message, result: cardRefusal(error) } : message;
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
  return { ...message, result: mcpErrorResult(error) };
}
