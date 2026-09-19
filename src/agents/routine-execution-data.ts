import * as v from 'valibot';

import { parseRuntimePlanV2, type RuntimePlanV2 } from './runtime-plan.ts';

/**
 * The routine execution agent's creation-data contract, kept apart from the
 * agent module so the routine executor can read envelopes without evaluating
 * the turn runtime; the agent itself is loaded on demand.
 */
export const ROUTINE_RESULT_DATA_NAME = 'routineResult';

export interface RoutineExecutionInitialData {
  runtimePlan: RuntimePlanV2;
  requestedModel: string;
  connectorUsageCorrelation?: {
    operationId: string;
    runId?: string;
  };
}

export function parseRoutineExecutionInitialData(value: unknown): RoutineExecutionInitialData {
  const parsed = v.safeParse(v.strictObject({
    runtimePlan: v.unknown(),
    requestedModel: v.pipe(v.string(), v.minLength(3), v.maxLength(240)),
    connectorUsageCorrelation: v.optional(v.strictObject({
      operationId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/)),
      runId: v.optional(v.pipe(
        v.string(),
        v.regex(/^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/),
      )),
    })),
  }), value);
  if (!parsed.success) throw new Error('Routine execution creation data is invalid.');
  return {
    // Queued envelopes from before artifact threads were frozen carry a
    // synthetic due-time conversation stamp; never let it become a thread.
    runtimePlan: parseRuntimePlanV2(parsed.output.runtimePlan, { legacyArtifactThread: 'none' }),
    requestedModel: parsed.output.requestedModel,
    ...(parsed.output.connectorUsageCorrelation
      ? {
          connectorUsageCorrelation: {
            operationId: parsed.output.connectorUsageCorrelation.operationId,
            ...(parsed.output.connectorUsageCorrelation.runId
              ? { runId: parsed.output.connectorUsageCorrelation.runId }
              : {}),
          },
        }
      : {}),
  };
}
