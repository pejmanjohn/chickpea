import type { FlueEventContext, FlueExecutionInterceptor, FlueObservation } from '@flue/runtime';

import { CHICKPEA_SLACK_AGENT_NAME } from '../agents/names.ts';
import { opaqueId } from '../work/admission.ts';

const ERROR_KINDS = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError',
  'AggregateError', 'AbortError', 'TimeoutError', 'FlueError',
]);

const FINISH_REASONS = new Set([
  'stop', 'length', 'toolUse', 'error', 'aborted', 'tool_calls', 'function_call', 'eos',
]);

/** A successful model turn can still end without a usable final response. */
export function observeAgentResultDiagnostics(
  event: FlueObservation,
  context: Pick<FlueEventContext, 'agentName'>,
): void {
  if (context.agentName !== CHICKPEA_SLACK_AGENT_NAME || event.type !== 'turn' ||
      event.purpose !== 'agent' || event.isError) return;
  try {
    const content = event.response.output?.content ?? [];
    if (content.some((block) => block.type === 'text' && block.text.length > 0) ||
        event.response.finishReason === 'toolUse') return;
    const finishReason = (value: string | undefined) =>
      value === undefined ? null : FINISH_REASONS.has(value) ? value : 'other';
    const tokenCount = (value: number | undefined) =>
      value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
    console.error('[chickpea] agent model returned no text:', {
      submissionRef: event.submissionId ? opaqueId('fluesubmission', event.submissionId) : null,
      finishReason: finishReason(event.response.finishReason),
      providerFinishReason: finishReason(event.response.providerFinishReason),
      requestedMaxTokens: tokenCount(event.request.maxTokens),
      outputTokens: tokenCount(event.response.usage?.output),
      hasThinking: content.some((block) => block.type === 'thinking'),
      hasToolCalls: content.some((block) => block.type === 'toolCall'),
    });
  } catch {
    // Never interrupt execution, even when diagnostics are unavailable.
  }
}

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
