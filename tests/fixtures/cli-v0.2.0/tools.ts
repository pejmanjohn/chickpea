/**
 * chickpea-cli 0.2.0's envelope reader and the code it prints, from tag
 * `cli-v0.2.0` (packages/cli/src/tools.ts `parseToolEnvelope` and
 * `isEnvelope`, cli.ts `failEnvelope`), copied unchanged but for the error
 * class. That release is frozen and still installed, so this is what an old
 * CLI makes of a management result.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';

class CliError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string) {
    super(message);
  }
}

export type ToolEnvelope =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

export function parseToolEnvelope(result: CallToolResult): ToolEnvelope {
  const structured = result.structuredContent;
  if (isEnvelope(structured)) return structured;
  const first = result.content?.find((block) => block.type === 'text');
  if (first && first.type === 'text') {
    try {
      const parsed: unknown = JSON.parse(first.text);
      if (isEnvelope(parsed)) return parsed;
    } catch {
      // fall through to the generic failure below
    }
  }
  if (result.isError) {
    // The MCP SDK reports argument validation failures as plain text, not as a
    // Chickpea envelope; show that text so the caller can fix the arguments.
    const message = first && first.type === 'text' && first.text.trim()
      ? first.text.trim()
      : 'The tool reported an error without a readable body.';
    return { ok: false, error: { code: 'tool_error', message } };
  }
  throw new CliError('UNEXPECTED_RESULT', 'The tool result did not carry a { ok, result | error } envelope', 'Check that the URL points at a Chickpea deployment');
}

function isEnvelope(value: unknown): value is ToolEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.ok === true) return 'result' in record;
  if (record.ok === false) {
    const error = record.error as Record<string, unknown> | undefined;
    return !!error && typeof error === 'object' && typeof error.code === 'string';
  }
  return false;
}

/** The code `failEnvelope` prints for a failed envelope, as in `chickpea: TOOL_TOOL_REMOVED: …`. */
export function printedCode(envelope: Extract<ToolEnvelope, { ok: false }>): string {
  return `TOOL_${envelope.error.code.toUpperCase()}`;
}
