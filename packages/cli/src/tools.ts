import type { CallToolResult, Client, Tool } from '@modelcontextprotocol/client';

import { CliError } from './errors.ts';

export type ToolEnvelope =
  | { ok: true; result: unknown }
  | { ok: false; error: ToolError };

interface ToolError {
  code: string;
  message: string;
  retryable?: boolean;
  nextStep?: string;
  fix?: { label: string; url: string } | { label: string; tool: string; arguments: Record<string, unknown> };
}

/** Normalize 5.0 structured results and older envelopes for CLI scripts. */
export function parseToolEnvelope(result: CallToolResult): ToolEnvelope {
  const structured = result.structuredContent;
  if (isEnvelope(structured)) return structured;
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    if ('error' in structured && isToolError(structured.error)) return { ok: false, error: structured.error };
    if (!result.isError) return { ok: true, result: structured };
  }
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
  throw new CliError('UNEXPECTED_RESULT', 'The tool result did not carry structured content or a legacy envelope', 'Check that the URL points at a Chickpea deployment');
}

function isToolError(value: unknown): value is ToolError {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const error = value as Record<string, unknown>;
  return typeof error.code === 'string' && typeof error.message === 'string';
}

function isEnvelope(value: unknown): value is ToolEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.ok === true) return 'result' in record;
  if (record.ok === false) {
    return isToolError(record.error);
  }
  return false;
}

/** Lists the deployment's tools and refuses when one of `names` is missing; returns them by name. */
export async function requireManagementTools(client: Client, names: readonly string[]): Promise<Map<string, Tool>> {
  const available = new Map<string, Tool>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    for (const tool of page.tools) available.set(tool.name, tool);
    cursor = page.nextCursor;
  } while (cursor);
  const missing = names.filter((name) => !available.has(name));
  if (missing.length) {
    throw new CliError('UPDATE_REQUIRED', `Update your Chickpea Core to use this command; missing 5.0 tools: ${missing.join(', ')}`);
  }
  return available;
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
  /** Proposal ids of destructive changes that wait for an explicit confirm_workspace_change call. */
  confirmations: string[];
  /** Credential-bearing setup links, each one-use and valid for 24 hours. */
  setupLinks: string[];
  /** 5.0: confirm tokens of changes that wait for an explicit confirm_change call. */
  confirmTokens: string[];
  /** 5.0: the same setup links, under `setup.url`; cancel_setup_link cancels one. */
  setupPages: string[];
}

export function collectEnvelopeHints(envelope: ToolEnvelope): EnvelopeHints {
  const confirmations = new Set<string>();
  const setupLinks = new Set<string>();
  const confirmTokens = new Set<string>();
  const setupPages = new Set<string>();
  if (!envelope.ok) return { confirmations: [], setupLinks: [], confirmTokens: [], setupPages: [] };
  const result = envelope.result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.outcomes)) {
      for (const outcome of record.outcomes) {
        if (!outcome || typeof outcome !== 'object') continue;
        const item = outcome as Record<string, unknown>;
        if (item.disposition === 'confirmation_required' && typeof item.proposalId === 'string') {
          confirmations.add(item.proposalId);
        }
      }
    }
  }
  walk(result, (key, value) => {
    if (key === 'setupUrl' && typeof value === 'string') setupLinks.add(value);
  });
  // 5.0 keeps both at the top of a change result. The token goes into a shell
  // command the person may paste, so anything but a plain handle is skipped.
  const top = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {};
  const confirmToken = (top.confirmation as { confirmToken?: unknown } | undefined)?.confirmToken;
  if (typeof confirmToken === 'string' && /^[\w.:-]{1,128}$/.test(confirmToken)) confirmTokens.add(confirmToken);
  const setupPage = (top.setup as { url?: unknown } | undefined)?.url;
  if (typeof setupPage === 'string' && /^https?:\/\/[^\s\p{Cc}]+$/u.test(setupPage)) setupPages.add(setupPage);
  return {
    confirmations: [...confirmations],
    setupLinks: [...setupLinks],
    confirmTokens: [...confirmTokens],
    setupPages: [...setupPages],
  };
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
  for (const proposalId of hints.confirmations) {
    lines.push(
      `This change is destructive and waits for your confirmation (${proposalId}). Nothing has been applied.`,
      'Read the preview in result.presentation.markdown, then confirm it from this same CLI session with:',
      `  chickpea call ${origin} confirm_workspace_change --args '${JSON.stringify({ proposalId })}'`,
    );
  }
  for (const confirmToken of hints.confirmTokens) {
    lines.push(
      'This change waits for your confirmation. Nothing has been applied.',
      'Read the preview in result.confirmation.preview, then confirm it with:',
      `  chickpea call ${origin} confirm_change --args '${JSON.stringify({ confirmToken })}'`,
    );
  }
  for (const [links, revoke] of [[hints.setupLinks, 'Revoke it with the revoke_setup_link tool'], [hints.setupPages, 'Cancel it with the cancel_setup_link tool']] as const) {
    for (const link of links) {
      lines.push(
        'Setup link issued. Anyone who holds it can complete its exact action without signing in; it expires in 24 hours.',
        `  ${link}`,
        `${revoke} if it leaks.`,
      );
    }
  }
  return lines;
}

export function renderToolList(tools: Tool[]): string {
  const width = Math.max(...tools.map((tool) => tool.name.length), 4);
  return tools
    .map((tool) => {
      const tags: string[] = [];
      if (tool.annotations?.readOnlyHint) tags.push('server hint: read-only');
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
