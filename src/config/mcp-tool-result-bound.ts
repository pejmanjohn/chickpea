import type { FlueExecutionInterceptor } from '@flue/runtime';

/** About 32-40k tokens: several of the largest useful results seen (75 KB) fit in a turn. */
export const MCP_TOOL_RESULT_MAX_BYTES = 128 * 1024;

const STRUCTURED_PREFIX = 'Structured content:\n';
const LOGGED_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const encoder = new TextEncoder();

/**
 * One MCP tool result's text for the model, bounded; undefined when it fits.
 * Over the bound, Flue's structured copy is dropped when the server's next
 * text block is the same JSON; what still does not fit is cut at a character
 * boundary and ends with a note asking the model to narrow the request.
 */
export function boundMcpToolResultText(text: string) {
  const originalBytes = encoder.encode(text).byteLength;
  if (originalBytes <= MCP_TOOL_RESULT_MAX_BYTES) return undefined;
  const single = withoutStructuredCopy(text);
  const duplicateDropped = single !== undefined;
  const bytes = encoder.encode(single ?? text);
  if (bytes.byteLength <= MCP_TOOL_RESULT_MAX_BYTES) {
    return { text: single!, originalBytes, keptBytes: bytes.byteLength, duplicateDropped, cut: false };
  }
  const note = `\n\n[Cut at the 128 KiB limit: this result was ${Math.ceil(bytes.byteLength / 1024)} KiB, and ` +
    'only its beginning is shown above. To get a complete result, narrow the request: fewer rows, a shorter ' +
    'time range, or fewer fields.]';
  let end = MCP_TOOL_RESULT_MAX_BYTES - encoder.encode(note).byteLength;
  // Never end inside a character: a continuation byte is 10xxxxxx.
  while ((bytes[end]! & 0xc0) === 0x80) end -= 1;
  const kept = new TextDecoder().decode(bytes.subarray(0, end)) + note;
  return { text: kept, originalBytes, keptBytes: encoder.encode(kept).byteLength, duplicateDropped, cut: true };
}

/**
 * Bounds every MCP tool result before the model and the conversation record
 * see it, on Flue's adapted tool: after the MCP client checked the answer
 * against the tool's output schema, on any transport. A tool's error is a
 * rejection here and passes untouched, as does any other result shape.
 */
export const mcpToolResultBoundInterceptor: FlueExecutionInterceptor = async (operation, _context, next) => {
  const result = await next();
  if (operation.type !== 'tool' || !operation.toolName.startsWith('mcp__') || !isRecord(result) ||
      !Array.isArray(result.content) || result.content.length !== 1) return result;
  const block: unknown = result.content[0];
  if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return result;
  const bounded = boundMcpToolResultText(block.text);
  if (!bounded) return result;
  // `mcp__<connection>__<tool>`: a connection ID Chickpea writes holds no `__`.
  const [, connectionId = '', ...tool] = operation.toolName.split('__');
  const name = (value: string) => LOGGED_NAME.test(value) ? value : '(other)';
  console.info({
    event: 'chickpea.mcp.tool_result_bounded', connectionId: name(connectionId), toolName: name(tool.join('__')),
    originalBytes: bounded.originalBytes, keptBytes: bounded.keptBytes,
    duplicateDropped: bounded.duplicateDropped, cut: bounded.cut,
  });
  return { ...result, content: [{ ...block, text: bounded.text }] } as typeof result;
};

/**
 * Flue writes `structuredContent` as indented JSON, which holds no blank
 * line, then each content block after a blank line. When the next block is
 * the same value, the rest is the whole result once, in the server's form.
 */
function withoutStructuredCopy(text: string): string | undefined {
  if (!text.startsWith(STRUCTURED_PREFIX)) return undefined;
  const end = text.indexOf('\n\n');
  if (end === -1) return undefined;
  const rest = text.slice(end + 2);
  try {
    const copy = JSON.stringify(JSON.parse(rest.split('\n\n', 1)[0]!));
    return copy === JSON.stringify(JSON.parse(text.slice(STRUCTURED_PREFIX.length, end))) ? rest : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
