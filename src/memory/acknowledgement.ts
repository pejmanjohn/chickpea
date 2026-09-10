import * as v from 'valibot';
import type { AgentMemory } from './types.ts';

export const memoryUpdateSummarySchema = v.pipe(
  v.string(), v.trim(), v.minLength(1), v.maxLength(300),
  v.check((text) => !/[\r\n]/.test(text), 'Use one line for the memory confirmation.'),
);

/** Only additions may reuse model-authored prose from the old memory context. */
export function memoryUpdateAcknowledgementText(
  before: AgentMemory,
  after: AgentMemory,
  summary?: string,
): string {
  if (!after.body.trim()) return 'I cleared my saved memory.';
  const fallback = 'I updated my memory.';
  if (after.revision !== before.revision + 1 || before.body === after.body) return fallback;
  // Preserve every previous nonblank line verbatim and in order. Rewrites are
  // conservatively treated as possible forgetting, even when merely reworded.
  let offset = 0;
  const lines = after.body.split('\n');
  for (const line of before.body.split('\n').filter((line) => line.trim())) {
    const index = lines.indexOf(line, offset);
    if (index < 0) return fallback;
    offset = index + 1;
  }
  const parsed = v.safeParse(memoryUpdateSummarySchema, summary);
  return parsed.success ? parsed.output : fallback;
}
