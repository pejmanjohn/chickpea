import { AsyncLocalStorage } from 'node:async_hooks';

import type { FlueExecutionInterceptor } from '@flue/runtime';

import { CHICKPEA_TEST_TURN_AGENT_NAME } from './names.ts';

export const TEST_TURN_TOOL_CALL_LIMIT = 25;
export const TEST_TURN_TOOL_LIMIT_MESSAGE = `Test runs allow ${TEST_TURN_TOOL_CALL_LIMIT} tool calls. Answer with what you have.`;
export const TEST_TURN_ATTEMPT_ENDED_MESSAGE = 'The test run kept calling tools past its limit, so it was ended.';

/** Flue gives a tool call's context no submission, so the count lives in the agent operation's. */
const attempt = new AsyncLocalStorage<{
  calls: number;
  /** The model turn whose call was first refused. */
  refusedIn?: string;
  /** The one model turn after it, which answers with what it has. */
  answerTurn?: string;
}>();

/**
 * Refuses a test run's tool calls past the 25th, as the call's error. It
 * counts before `next()`, so parallel calls cannot pass together. After the
 * first refusal the model has one more turn to answer with what it has; a
 * turn after that ends the attempt, so a model that keeps calling tools
 * spends nothing more before Flue's timeout. A Flue model turn is one
 * request with its tool calls, under one `turnId`.
 */
export const testTurnToolCallInterceptor: FlueExecutionInterceptor = async (operation, context, next) => {
  if (context.agentName !== CHICKPEA_TEST_TURN_AGENT_NAME) return next();
  const counted = attempt.getStore();
  if (operation.type === 'agent' && !counted) return attempt.run({ calls: 0 }, next);
  if (operation.type === 'model') {
    if (counted?.refusedIn === undefined || operation.turnId === counted.refusedIn) return next();
    counted.answerTurn ??= operation.turnId;
    if (operation.turnId !== counted.answerTurn) throw new Error(TEST_TURN_ATTEMPT_ENDED_MESSAGE);
    return next();
  }
  if (operation.type !== 'tool') return next();
  if (!counted) throw new Error('A test run tool call ran outside its attempt.');
  counted.calls += 1;
  if (counted.calls > TEST_TURN_TOOL_CALL_LIMIT) {
    counted.refusedIn ??= context.turnId ?? '';
    throw new Error(TEST_TURN_TOOL_LIMIT_MESSAGE);
  }
  return next();
};
