import { AsyncLocalStorage } from 'node:async_hooks';

import type { FlueExecutionInterceptor } from '@flue/runtime';

import { CHICKPEA_TEST_TURN_AGENT_NAME } from './names.ts';

export const TEST_TURN_TOOL_CALL_LIMIT = 25;
export const TEST_TURN_TOOL_LIMIT_MESSAGE = 'Test runs allow 25 tool calls. Answer with what you have.';

/** Flue gives a tool call's context no submission, so the count lives in the agent operation's. */
const attempt = new AsyncLocalStorage<{ calls: number }>();

/**
 * Refuses a test run's tool calls past the 25th, as the call's error. It
 * counts before `next()`, so parallel calls cannot pass together.
 */
export const testTurnToolCallInterceptor: FlueExecutionInterceptor = async (operation, context, next) => {
  if (context.agentName !== CHICKPEA_TEST_TURN_AGENT_NAME) return next();
  const counted = attempt.getStore();
  if (operation.type === 'agent' && !counted) return attempt.run({ calls: 0 }, next);
  if (operation.type !== 'tool') return next();
  if (!counted) throw new Error('A test run tool call ran outside its attempt.');
  counted.calls += 1;
  if (counted.calls > TEST_TURN_TOOL_CALL_LIMIT) throw new Error(TEST_TURN_TOOL_LIMIT_MESSAGE);
  return next();
};
