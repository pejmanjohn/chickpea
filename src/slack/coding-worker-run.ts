import * as v from 'valibot';

/** Written by `workspace_task` once a coding worker accepted a task this response. */
export const CODING_WORKER_RUN_DATA_NAME = 'chickpeaCodingWorkerRun';

export const CodingWorkerRunSchema = v.strictObject({
  schemaVersion: v.literal(1),
  /** The coding model the worker ran on (canonical id, as the footer names models). */
  model: v.pipe(v.string(), v.minLength(3), v.maxLength(240)),
});

export type CodingWorkerRunRecord = v.InferOutput<typeof CodingWorkerRunSchema>;

/**
 * The coding model that did work in this response, for the reply footer's
 * attribution. Every worker in one response runs on the turn's frozen coding
 * model, so the latest valid record names it.
 */
export function parseCodingWorkerRunModel(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const parsed = v.safeParse(CodingWorkerRunSchema, value[index]);
    if (parsed.success) return parsed.output.model;
  }
  return undefined;
}
