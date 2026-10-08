/**
 * Posts a hosted reply run's task fee row before its first qualifying tool
 * runs. A refused row fails the tool, and the provider proxy then refuses the
 * attempt's next model request, so the turn ends as out of usage.
 */
import type { FlueExecutionInterceptor } from '@flue/runtime';

import { registeredToolDescriptor } from '../activity/status.ts';
import { qualifiesAsTask } from '../usage/run-fees.ts';
import { currentRunFees } from './model-access.ts';

export const runFeeInterceptor: FlueExecutionInterceptor = async (operation, context, next) => {
  if (operation.type !== 'tool') return next();
  const fees = currentRunFees();
  if (fees && qualifiesAsTask(fees.runKind, {
    kind: 'tool',
    toolName: operation.toolName,
    descriptor: registeredToolDescriptor(context.instanceId, operation.toolName),
  })) {
    await fees.requireTaskFee();
  }
  return next();
};
