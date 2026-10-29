import type { FlueExecutionInterceptor } from '@flue/runtime';

import { registeredToolDescriptor } from '../activity/status.ts';
import { qualifiesAsTask } from '../usage/run-fees.ts';
import { WEB_TOOL_NAMES } from '../web/names.ts';
import { currentRunFees } from './model-access.ts';

/**
 * Each attempt asks once, before its first qualifying call, whether the run
 * may become a task, and no qualifying call runs once that answer or the post
 * refuses it. A call makes the reply a task once it returns or throws, since a
 * throw can follow work already done; Flue reports a tool's error to an
 * interceptor only by rejecting `next()`. A call the run's stop refused before
 * the tool started did no work.
 */
export const runFeeInterceptor: FlueExecutionInterceptor = async (operation, context, next) => {
  if (operation.type !== 'tool') return next();
  const fees = currentRunFees();
  if (!fees || !qualifiesAsTask(fees.feeRun, {
    kind: 'tool',
    toolName: operation.toolName,
    descriptor: registeredToolDescriptor(context.instanceId, operation.toolName),
  })) return next();
  await fees.requireTaskAdmitted();
  const result = await next().catch(async (error: unknown) => {
    if (!refusedBeforeStart(error)) await fees.postTaskFee();
    throw error;
  });
  if (!refusedBeforeWork(operation.toolName, result)) await fees.postTaskFee();
  return result;
};

/**
 * Flue refuses a call on a run that has already ended (stopped, timed out)
 * without invoking the tool, by rejecting with an abort whose message and
 * cause are the run's end. A call stopped once the tool started is rejected
 * with a note that it may still be running, or with the tool's own error.
 */
function refusedBeforeStart(error: unknown): boolean {
  if (!(error instanceof DOMException) || error.name !== 'AbortError') return false;
  const { cause } = error as { cause?: unknown };
  return cause instanceof Error && error.message === cause.message;
}

/**
 * Tools that return a refusal made before any work for the model to explain,
 * rather than throwing. read_slack_channel says not_read. The web tools say
 * outcome refused when nothing went out: a URL or query they may not send, or
 * a turn whose budget is spent. A page or search that went out and failed is
 * work, and charges.
 */
const REFUSALS_BEFORE_WORK = new Map<string, (output: { status?: unknown; outcome?: unknown }) => boolean>([
  ['read_slack_channel', (output) => output.status === 'not_read'],
  ...WEB_TOOL_NAMES.map((name) => [name, (output: { outcome?: unknown }) => output.outcome === 'refused'] as const),
]);

/** Any other shape charges, and the check never throws, which would lose the tool's result. */
function refusedBeforeWork(toolName: string, result: unknown): boolean {
  const refusal = REFUSALS_BEFORE_WORK.get(toolName);
  if (!refusal) return false;
  const output = (result as { details?: { output?: unknown } } | null | undefined)?.details?.output;
  if (typeof output !== 'string') return false;
  try {
    const parsed = JSON.parse(output) as unknown;
    return typeof parsed === 'object' && parsed !== null && refusal(parsed);
  } catch {
    return false;
  }
}
