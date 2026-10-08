import type { FlueExecutionInterceptor } from '@flue/runtime';

import { registeredToolDescriptor } from '../activity/status.ts';
import { SlackReadError, type SlackReadErrorCode } from '../slack/reading/errors.ts';
import { SLACK_READ_TOOL_NAMES } from '../slack/reading/tools.ts';
import { qualifiesAsTask } from '../usage/run-fees.ts';
import { currentRunFees } from './model-access.ts';
import { CreditsExhaustedError } from './platform-funding.ts';

/**
 * A qualifying tool call makes the reply a task once it returns or throws,
 * since a throw can follow work already done. Flue reports a tool's error to
 * an interceptor only by rejecting `next()`. Once the run's post is refused,
 * no later qualifying call does any work.
 */
export const runFeeInterceptor: FlueExecutionInterceptor = async (operation, context, next) => {
  if (operation.type !== 'tool') return next();
  const fees = currentRunFees();
  if (!fees || !qualifiesAsTask(fees.feeRun, {
    kind: 'tool',
    toolName: operation.toolName,
    descriptor: registeredToolDescriptor(context.instanceId, operation.toolName),
  })) return next();
  if (fees.refused) throw new CreditsExhaustedError();
  const result = await next().catch(async (error: unknown) => {
    if (!refusedBeforeWork(operation.toolName, { threw: error })) await fees.postTaskFee();
    throw error;
  });
  if (!refusedBeforeWork(operation.toolName, { returned: result })) await fees.postTaskFee();
  return result;
};

const REFUSED_SLACK_READS: ReadonlySet<SlackReadErrorCode> = new Set(['rate_limited', 'read_limit']);

/**
 * Our side refused the call before it did any work: today, a Slack read held
 * back by the read budget or the per-request cap. The Slack read tools return
 * that refusal as a not_read result, for the model to explain, rather than
 * throwing.
 */
function refusedBeforeWork(toolName: string, outcome: { threw: unknown } | { returned: unknown }): boolean {
  if ('threw' in outcome) return outcome.threw instanceof SlackReadError && REFUSED_SLACK_READS.has(outcome.threw.code);
  if (!(SLACK_READ_TOOL_NAMES as readonly string[]).includes(toolName)) return false;
  const output = (outcome.returned as { details?: { output?: unknown } } | undefined)?.details?.output;
  if (typeof output !== 'string') return false;
  try {
    const read = JSON.parse(output) as { status?: unknown; code?: unknown } | null;
    return read?.status === 'not_read' && REFUSED_SLACK_READS.has(read.code as SlackReadErrorCode);
  } catch {
    return false;
  }
}
