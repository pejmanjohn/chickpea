import type { CallToolResult, Client, Tool } from '@modelcontextprotocol/client';

import { CliError } from './errors.ts';

export type ToolEnvelope =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

/**
 * Every management tool answers with `{ ok, result | error }` both as
 * structured content and as the first text block. Prefer the structured
 * copy; fall back to the text so older servers still parse.
 */
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
    return { ok: false, error: { code: 'tool_error', message: 'The tool reported an error without a readable body.' } };
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

export async function callManagementTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolEnvelope> {
  const result = await client.callTool({ name, arguments: args });
  return parseToolEnvelope(result as CallToolResult);
}

export interface EnvelopeHints {
  /** Proposal ids that need an explicit confirm_workspace_change call. */
  proposals: string[];
  /** Credential-bearing setup links, each one-use and valid for 24 hours. */
  setupLinks: string[];
}

export function collectEnvelopeHints(envelope: ToolEnvelope): EnvelopeHints {
  const proposals = new Set<string>();
  const setupLinks = new Set<string>();
  if (!envelope.ok) return { proposals: [], setupLinks: [] };
  const result = envelope.result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (typeof record.proposalId === 'string' &&
        (record.status === 'pending' || record.status === 'confirmation_required' ||
         record.confirmationTool === 'confirm_workspace_change')) {
      proposals.add(record.proposalId);
    }
    if (Array.isArray(record.outcomes)) {
      for (const outcome of record.outcomes) {
        if (!outcome || typeof outcome !== 'object') continue;
        const item = outcome as Record<string, unknown>;
        if (item.disposition === 'confirmation_required' && typeof item.proposalId === 'string') {
          proposals.add(item.proposalId);
        }
      }
    }
  }
  walk(result, (key, value) => {
    if (key === 'setupUrl' && typeof value === 'string') setupLinks.add(value);
  });
  return { proposals: [...proposals], setupLinks: [...setupLinks] };
}

function walk(value: unknown, visit: (key: string, value: unknown) => void, depth = 0): void {
  if (depth > 12 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    visit(key, child);
    walk(child, visit, depth + 1);
  }
}

export function renderEnvelopeHints(hints: EnvelopeHints, origin: string): string[] {
  const lines: string[] = [];
  for (const proposalId of hints.proposals) {
    lines.push(
      `Proposal ${proposalId} is waiting for confirmation. Nothing has been applied.`,
      'Review the preview in the result, then confirm it from this same CLI session with:',
      `  chickpea call ${origin} confirm_workspace_change --args '${JSON.stringify({ proposalId })}'`,
    );
  }
  for (const link of hints.setupLinks) {
    lines.push(
      'Setup link issued. Anyone who holds it can complete its exact action without signing in; it expires in 24 hours.',
      `  ${link}`,
      'Revoke it with the revoke_setup_link tool if it leaks.',
    );
  }
  return lines;
}

export function renderToolList(tools: Tool[]): string {
  const width = Math.max(...tools.map((tool) => tool.name.length), 4);
  return tools
    .map((tool) => {
      const tags: string[] = [];
      if (tool.annotations?.readOnlyHint) tags.push('read-only');
      if (tool.annotations?.destructiveHint) tags.push('destructive');
      if (tool.annotations?.idempotentHint) tags.push('idempotent');
      const summary = firstSentence(tool.description ?? '');
      return `${tool.name.padEnd(width)}  ${tags.length ? `[${tags.join(', ')}] ` : ''}${summary}`;
    })
    .join('\n');
}

function firstSentence(text: string): string {
  const match = /^(.*?[.!?])(\s|$)/s.exec(text.trim());
  return (match?.[1] ?? text.trim()).replace(/\s+/g, ' ');
}
