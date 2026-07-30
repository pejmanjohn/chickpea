const WORK_RUN_TRACESTATE_KEY = 'chickpea-run';
const WORK_EXECUTION_TRACESTATE_KEY = 'chickpea-exec';
const WORK_MODE_TRACESTATE_KEY = 'chickpea-work-mode';
const OPAQUE_ID = /^[a-z][a-z0-9_-]{7,127}$/;

export interface WorkTraceCorrelation {
  runId: string;
  runExecutionId: string;
  mode: 'observe' | 'enforce';
}

export function workTraceStateEntries(correlation: WorkTraceCorrelation): string[] {
  return [
    `${WORK_RUN_TRACESTATE_KEY}=${encodeURIComponent(correlation.runId)}`,
    `${WORK_EXECUTION_TRACESTATE_KEY}=${encodeURIComponent(correlation.runExecutionId)}`,
    `${WORK_MODE_TRACESTATE_KEY}=${correlation.mode}`,
  ];
}

export function workTraceCorrelationFromState(
  tracestate: string | undefined,
): WorkTraceCorrelation | undefined {
  if (!tracestate) return undefined;
  const values = new Map<string, string>();
  for (const entry of tracestate.split(',')) {
    const [key, encoded] = entry.trim().split('=', 2);
    if (!key || !encoded) continue;
    try {
      values.set(key, decodeURIComponent(encoded));
    } catch {
      return undefined;
    }
  }
  const runId = values.get(WORK_RUN_TRACESTATE_KEY);
  const runExecutionId = values.get(WORK_EXECUTION_TRACESTATE_KEY);
  const mode = values.get(WORK_MODE_TRACESTATE_KEY);
  if (
    !runId || !OPAQUE_ID.test(runId) ||
    !runExecutionId || !OPAQUE_ID.test(runExecutionId) ||
    (mode !== 'observe' && mode !== 'enforce')
  ) return undefined;
  return { runId, runExecutionId, mode };
}
