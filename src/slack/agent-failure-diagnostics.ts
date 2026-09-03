import type { FlueExecutionInterceptor } from '@flue/runtime';

import { CHICKPEA_SLACK_AGENT_NAME } from '../agents/names.ts';
import { opaqueId } from '../work/admission.ts';

const ERROR_KINDS = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError',
  'AggregateError', 'AbortError', 'TimeoutError', 'FlueError',
]);

interface FailureDiagnostic {
  kind: string;
  status?: number;
  frames: { fileRef: string; line: number; column: number }[];
}

/** Local operator logs only: no error prose, paths, payloads, or credentials. */
function failureDiagnostics(error: unknown): FailureDiagnostic[] {
  const causes: FailureDiagnostic[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && causes.length < 4 && !seen.has(current)) {
    seen.add(current);
    if (!(current instanceof Error)) {
      causes.push({ kind: 'non_error', frames: [] });
      break;
    }
    const status: unknown = Object.getOwnPropertyDescriptor(current, 'status')?.value;
    const frames: FailureDiagnostic['frames'] = [];
    // Fingerprint basenames so operators can match the deployed bundle locally
    // without copying filesystem paths, function names, or arbitrary stack text.
    for (const line of (current.stack ?? '').slice(0, 16_384).split('\n').slice(1, 33)) {
      const match = /(?:^|[/\\( ])([^/\\():\s]+):(\d{1,9}):(\d{1,9})\)?$/.exec(line);
      if (match) frames.push({
        fileRef: opaqueId('errorfile', match[1]!),
        line: Number(match[2]),
        column: Number(match[3]),
      });
      if (frames.length === 4) break;
    }
    causes.push({
      kind: ERROR_KINDS.has(current.name) ? current.name : 'unknown',
      ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
        ? { status } : {}),
      frames,
    });
    current = Object.getOwnPropertyDescriptor(current, 'cause')?.value;
  }
  return causes;
}

// Catch before Flue serializes unexpected errors to a generic internal_error.
// Observe only the root prompt, not every failed/retried model or tool call.
export const agentFailureDiagnosticsInterceptor: FlueExecutionInterceptor = async (
  operation,
  context,
  next,
) => {
  if (context.agentName !== CHICKPEA_SLACK_AGENT_NAME ||
      operation.type !== 'agent' || operation.operationKind !== 'prompt') return next();
  try {
    return await next();
  } catch (error) {
    try {
      console.error('[chickpea] agent execution failed:', {
        submissionRef: context.submissionId ? opaqueId('fluesubmission', context.submissionId) : null,
        causes: failureDiagnostics(error),
      });
    } catch {
      // Diagnostics must never replace the execution failure or affect retries.
    }
    throw error;
  }
};
