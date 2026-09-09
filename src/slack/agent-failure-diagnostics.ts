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

// Exact structured codes only. Never infer a code from provider error prose.
const MODEL_ERROR_CODES = new Set([
  'cloudflare_ai_binding_error', 'operation_failed', 'AbortError', 'TimeoutError',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT',
  'context_length_exceeded', 'rate_limit_exceeded',
]);

const SETTLEMENT_ERROR_TYPES = new Set([
  'internal_error', 'operation_failed', 'tool_input_validation',
  'tool_output_validation', 'tool_output_serialization', 'tool_name_conflict',
  'submission_interrupted', 'submission_retry_exhausted', 'submission_timeout',
  'submission_aborted', 'conversation_record_invariant',
  'conversation_stream_store_failure', 'invalid_request',
]);

/** The durable read carries a serialized cause, even if live observations were lost. */
export function settlementFailureFacts(error: unknown): Record<string, unknown>[] {
  const facts: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  for (let current = error; current && typeof current === 'object' &&
      facts.length < 5 && !seen.has(current);) {
    seen.add(current);
    const value = current as Record<string, unknown>;
    const type = typeof value.type === 'string' ? value.type : value.name;
    const meta = value.meta && typeof value.meta === 'object'
      ? value.meta as Record<string, unknown> : undefined;
    facts.push({
      kind: typeof type === 'string' && (SETTLEMENT_ERROR_TYPES.has(type) || ERROR_KINDS.has(type))
        ? type : 'unknown',
      ...serializedProviderFailure(value.message),
      ...serializedProviderFailure(meta?.reason),
    });
    current = value.cause;
  }
  return facts;
}

/** Pi serializes SDK errors before Flue observes them. Read only its fixed
 * transport envelope; never emit the provider body or classify arbitrary prose. */
function serializedProviderFailure(message: unknown): Record<string, string | number> {
  if (typeof message !== 'string') return {};
  const http = /^OpenAI API error \(([45]\d{2})\): /.exec(message) ??
    /^([45]\d{2})(?:: | )/.exec(message);
  if (http) return { providerFailureKind: 'http', providerHttpStatus: Number(http[1]) };
  const streamCode = /^(?:Error Code )?(server_error|rate_limit_exceeded|context_length_exceeded): /.exec(message);
  if (streamCode) return { providerFailureKind: 'provider_stream_error', providerErrorCode: streamCode[1]! };
  const transportErrors: Record<string, string> = {
    'Network connection lost.': 'network_connection_lost',
    'fetch failed': 'fetch_failed',
    'Connection error.': 'connection_error',
    'Request timed out.': 'request_timeout',
    'Request was aborted': 'request_aborted',
    'Request was aborted.': 'request_aborted',
    'terminated': 'stream_terminated',
    'OpenAI Responses stream ended without a stop reason': 'stream_incomplete',
    'OpenAI Responses stream ended before a terminal response event': 'stream_incomplete',
  };
  const kind = Object.hasOwn(transportErrors, message) ? transportErrors[message] : undefined;
  return kind ? { providerFailureKind: kind } : {};
}

/** Retain failed/empty model-turn facts, including attempts later recovered by Flue. */
export function observeAgentResultDiagnostics(
  event: FlueObservation,
  context: Pick<FlueEventContext, 'agentName'>,
): void {
  if (context.agentName !== CHICKPEA_SLACK_AGENT_NAME || event.type !== 'turn' ||
      event.purpose !== 'agent') return;
  try {
    const content = event.response.output?.content ?? [];
    const hasText = content.some((block) => block.type === 'text' && block.text.length > 0);
    const hasToolCalls = content.some((block) => block.type === 'toolCall');
    const failed = event.isError || event.response.finishReason === 'error' ||
      event.response.finishReason === 'aborted';
    if (!failed && (hasText || (event.response.finishReason === 'toolUse' && hasToolCalls))) return;
    const finishReason = (value: string | undefined) =>
      value === undefined ? null : FINISH_REASONS.has(value) ? value : 'other';
    const tokenCount = (value: number | undefined) =>
      value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
    const errorCode = event.response.error?.code ?? event.response.error?.type;
    const status = event.response.error?.meta?.status;
    console.error(failed ? '[chickpea] agent model turn failed:' : '[chickpea] agent model returned no text:', {
      submissionRef: event.submissionId ? opaqueId('fluesubmission', event.submissionId) : null,
      finishReason: finishReason(event.response.finishReason),
      providerFinishReason: finishReason(event.response.providerFinishReason),
      requestedMaxTokens: tokenCount(event.request.maxTokens),
      inputTokens: tokenCount(event.response.usage?.input),
      cacheReadTokens: tokenCount(event.response.usage?.cacheRead),
      outputTokens: tokenCount(event.response.usage?.output),
      hasText,
      hasThinking: content.some((block) => block.type === 'thinking'),
      hasToolCalls,
      ...(failed ? {
        ...serializedProviderFailure(event.response.error?.message),
        errorCode: errorCode === undefined ? null : MODEL_ERROR_CODES.has(errorCode) ? errorCode : 'other',
        status: typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
          ? status : null,
      } : {}),
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
