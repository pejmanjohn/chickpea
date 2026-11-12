import * as v from 'valibot';

export const SLACK_MEMORY_UPDATE_DATA_NAME = 'slackMemoryUpdate';
// Not strict: older receipts also carry summary, preservesContext and
// chainedFrom, and stored settlements still hold them. Reading drops them.
export const SlackMemoryUpdateSchema = v.object({
  operationId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
export type SlackMemoryUpdate = v.InferOutput<typeof SlackMemoryUpdateSchema>;

/** The newest of a turn's receipts, one per applied write. */
export function parseSlackMemoryUpdate(value: unknown): SlackMemoryUpdate | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const parsed = v.safeParse(v.array(SlackMemoryUpdateSchema), value);
  if (!parsed.success) return undefined;
  return parsed.output.reduce((newest, receipt) => (receipt.revision > newest.revision ? receipt : newest));
}

export function appliedMemoryReceipt(value: unknown, agentId: string): SlackMemoryUpdate | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result = value as Record<string, unknown>;
  if (result.status !== 'completed' || !Array.isArray(result.outcomes) || result.outcomes.length !== 1) return undefined;
  const outcome = result.outcomes[0];
  if (!outcome || outcome.operationKind !== 'update_agent_memory' || outcome.disposition !== 'applied' ||
      !Array.isArray(outcome.changed) || outcome.changed.length !== 1) return undefined;
  const changed = outcome.changed[0];
  if (!changed || changed.kind !== 'memory' || changed.id !== agentId) return undefined;
  return parseSlackMemoryUpdate([{ operationId: result.operationId, revision: changed.revision }]);
}
