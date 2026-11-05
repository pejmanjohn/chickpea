import type { FlueExecutionInterceptor } from '@flue/runtime';

import { registeredToolDescriptor } from '../activity/status.ts';
import type { SLACK_CANVAS_TOOL_NAMES } from '../slack/canvases/tools.ts';
import { SLACK_GROUP_DM_TOOL_NAME } from '../slack/group-dm/tools.ts';
import type { SLACK_LIST_TOOL_NAMES } from '../slack/lists/tools.ts';
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

type Refusal = (output: { status?: unknown; outcome?: unknown }) => boolean;

const notRead: Refusal = (output) => output.status === 'not_read';
const notWritten: Refusal = (output) => output.status === 'not_written';

const SLACK_CANVAS_REFUSALS: Record<(typeof SLACK_CANVAS_TOOL_NAMES)[number], Refusal> = {
  read_slack_canvas: notRead,
  create_slack_canvas: notWritten,
  update_slack_canvas: notWritten,
};

const SLACK_LIST_REFUSALS: Record<(typeof SLACK_LIST_TOOL_NAMES)[number], Refusal> = {
  read_slack_list: notWritten,
  read_slack_list_item: notWritten,
  create_slack_list_item: notWritten,
  update_slack_list_item: notWritten,
  create_slack_task_list: notWritten,
  share_slack_list: notWritten,
};

const REFUSALS_BEFORE_WORK = new Map<string, Refusal>([
  ['read_slack_channel', notRead],
  [SLACK_GROUP_DM_TOOL_NAME, (output) => output.status === 'refused'],
  ...Object.entries(SLACK_CANVAS_REFUSALS),
  ...Object.entries(SLACK_LIST_REFUSALS),
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
