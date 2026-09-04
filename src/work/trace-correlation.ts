import type { FlueObservation } from '@flue/runtime';
import { opaqueId } from './admission.ts';

/** App-owned correlation stored only in TurnJob state; never serialized to traces. */
export interface WorkTraceCorrelation {
  runId: string;
  runExecutionId: string;
  mode: 'observe' | 'enforce';
}

/** Link a platform invocation to the opaque references already in the Run ledger.
 * No raw instance/submission IDs, WorkTraceCorrelation, or model content leaves
 * this boundary. Cloudflare supplies the request/trace IDs on the log itself.
 */
export function emitRuntimeCorrelation(
  observation: FlueObservation,
  sink: { info(record: Record<string, unknown>): void } = console,
): void {
  if (observation.type !== 'operation_start' ||
    !['prompt', 'skill'].includes(observation.operationKind) ||
    !observation.instanceId || !observation.submissionId) return;
  try {
    sink.info({
      component: 'runtime',
      event: 'run.correlation',
      flueInstanceRef: opaqueId('flueinstance', observation.instanceId),
      flueSubmissionRef: opaqueId('fluesubmission', observation.submissionId),
    });
  } catch {
    // Diagnostics must not affect execution, including when the sink fails.
  }
}
