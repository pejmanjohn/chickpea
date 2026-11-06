import { opaqueId } from '../work/admission.ts';
import * as v from 'valibot';

export const SLACK_MEMORY_UPDATE_DATA_NAME = 'slackMemoryUpdate';
// Not strict: older receipts also carry summary and preservesContext, and
// stored settlements still hold them. Reading drops both.
export const SlackMemoryUpdateSchema = v.object({
  operationId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /** The injected revision, when every write of this turn up to this one applied on the one before. */
  chainedFrom: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});
export type SlackMemoryUpdate = v.InferOutput<typeof SlackMemoryUpdateSchema>;

/** Metadata is only a hint: delivery must independently verify the durable receipt. */
export function parseSlackMemoryUpdate(value: unknown): SlackMemoryUpdate | undefined {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const parsed = v.safeParse(SlackMemoryUpdateSchema, value[0]);
  return parsed.success ? parsed.output : undefined;
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

/**
 * Verify the operation is this turn's own write, then recheck live memory and
 * visibility. Only such a write may advance memory past the ordinary lease.
 */
export async function verifyOwnMemoryWrite(input: {
  hint: SlackMemoryUpdate;
  agentId: string;
  turnJobId: string;
  getOperation(operationId: string): Promise<unknown>;
  validateReceiptLease(revision: number, chainedFrom?: number): Promise<boolean>;
}): Promise<boolean> {
  const result = await input.getOperation(input.hint.operationId);
  const receipt = appliedMemoryReceipt(result, input.agentId);
  if (!receipt || receipt.revision !== input.hint.revision ||
      (result as { idempotencyKey?: string }).idempotencyKey !==
        opaqueId('memory', `${input.turnJobId}:${receipt.revision - 1}`)) return false;
  return input.validateReceiptLease(receipt.revision, input.hint.chainedFrom);
}
