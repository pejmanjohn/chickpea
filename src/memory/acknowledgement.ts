import * as v from 'valibot';
import type { AgentMemory } from './types.ts';

export const memoryUpdateSummarySchema = v.pipe(
  v.string(), v.trim(), v.minLength(1), v.maxLength(300),
  v.check((text) => !/[\r\n]/.test(text), 'Use one line for the memory confirmation.'),
);

/**
 * True only when `after` is the next revision and keeps every previous nonblank
 * line verbatim and in order, including the common case of writing the shown
 * body back unchanged (the store still advances the revision). Prose grounded
 * in `before` then discloses nothing that `after` forgot. Rewrites are
 * conservatively treated as possible forgetting, even when merely reworded;
 * a blank body (forget all) is never context-preserving.
 */
export function memoryUpdatePreservesContext(before: AgentMemory, after: AgentMemory): boolean {
  if (!after.body.trim()) return false;
  if (after.revision !== before.revision + 1) return false;
  if (before.body === after.body) return true;
  let offset = 0;
  const lines = after.body.split('\n');
  for (const line of before.body.split('\n').filter((line) => line.trim())) {
    const index = lines.indexOf(line, offset);
    if (index < 0) return false;
    offset = index + 1;
  }
  return true;
}

/** Only additions may reuse model-authored prose from the old memory context. */
export function memoryUpdateAcknowledgementText(
  before: AgentMemory,
  after: AgentMemory,
  summary?: string,
): string {
  if (!after.body.trim()) return 'I cleared my saved memory.';
  const fallback = 'I updated my memory.';
  // An unchanged body is context-safe but describes no change worth echoing.
  if (before.body === after.body || !memoryUpdatePreservesContext(before, after)) return fallback;
  const parsed = v.safeParse(memoryUpdateSummarySchema, summary);
  return parsed.success ? parsed.output : fallback;
}
