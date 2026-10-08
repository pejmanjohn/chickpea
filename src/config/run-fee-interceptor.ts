import type { FlueExecutionInterceptor } from '@flue/runtime';

import { registeredToolDescriptor } from '../activity/status.ts';
import { qualifiesAsTask } from '../usage/run-fees.ts';
import { currentRunFees } from './model-access.ts';

/**
 * Each attempt asks once, before its first qualifying call, whether the run
 * may become a task, and no qualifying call runs once that answer or the post
 * refuses it. A call makes the reply a task once it returns or throws, since a
 * throw can follow work already done; Flue reports a tool's error to an
 * interceptor only by rejecting `next()`.
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
    await fees.postTaskFee();
    throw error;
  });
  if (!refusedBeforeWork(operation.toolName, result)) await fees.postTaskFee();
  return result;
};

/**
 * read_slack_channel returns a refusal, and only a refusal, as a not_read
 * result for the model to explain, rather than throwing. Any other shape
 * charges, and the check never throws, which would lose the tool's result.
 */
function refusedBeforeWork(toolName: string, result: unknown): boolean {
  if (toolName !== 'read_slack_channel') return false;
  const output = (result as { details?: { output?: unknown } } | null | undefined)?.details?.output;
  if (typeof output !== 'string') return false;
  try {
    return (JSON.parse(output) as { status?: unknown } | null)?.status === 'not_read';
  } catch {
    return false;
  }
}
