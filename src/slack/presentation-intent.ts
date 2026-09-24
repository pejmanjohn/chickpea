import * as v from 'valibot';

import {
  currentRequestProgressiveStreamingMode,
  type CurrentRequestEnvelope,
  type ProgressiveStreamingMode,
} from '../memory/tool-policy.ts';

export const SLACK_STREAM_ANSWER_TOOL_NAME = 'stream_answer';
export const SLACK_STREAM_ANSWER_ACKNOWLEDGEMENT =
  'Delivery preference noted. Continue with the answer.';
export const SLACK_STREAM_ANSWER_TOOL_DESCRIPTION =
  'Declare before answer text that progressive delivery would improve this direct response.';
export const SLACK_STREAM_FINAL_ANSWER_TOOL_DESCRIPTION =
  'Declare, after your last other tool call and immediately before the final answer text, that progressive delivery would improve that final answer.';

export const SLACK_STREAM_ANSWER_INSTRUCTION = [
  'You may call stream_answer once, before writing any answer text, only for a direct answer whose stable early prose would be useful to read before the response is complete.',
  'Do not call it for a short confirmation, a primarily structured response, a correction, a response containing attached files, or a response likely to need another tool.',
  'This is only a delivery preference. Never claim that Slack is streaming, change the answer based on delivery, or mention this internal tool to the user.',
  'If uncertain, answer normally without calling it; terminal delivery is expected and is not an error.',
].join(' ');

/** Effect-capable Agents declare after their tool work, not before it. */
export const SLACK_STREAM_FINAL_ANSWER_INSTRUCTION = [
  'You may call stream_answer once, after every other tool call in this response has returned and immediately before you write the final answer, only when that final answer is long enough that its stable early prose would be useful to read before the response is complete.',
  'Call it alone in its step, never alongside another tool call, and write no text before it in that step. After calling it, no other tool can run in this response: finish the answer from the results you already have.',
  'Do not call it for a short confirmation, a primarily structured response, a correction, a response containing attached files, after updating memory, or while you might still need another tool.',
  'This is only a delivery preference. Never claim that Slack is streaming, change the answer based on delivery, or mention this internal tool to the user.',
  'If uncertain, answer normally without calling it; terminal delivery is expected and is not an error.',
].join(' ');

export function createSlackStreamAnswerTool(mode: ProgressiveStreamingMode = 'early') {
  return {
    name: SLACK_STREAM_ANSWER_TOOL_NAME,
    description: mode === 'final_answer'
      ? SLACK_STREAM_FINAL_ANSWER_TOOL_DESCRIPTION
      : SLACK_STREAM_ANSWER_TOOL_DESCRIPTION,
    output: v.string(),
    run: () => ({ output: SLACK_STREAM_ANSWER_ACKNOWLEDGEMENT }),
  };
}

export function slackPresentationIntentCapability(
  envelope: CurrentRequestEnvelope | undefined,
) {
  const mode = currentRequestProgressiveStreamingMode(envelope);
  if (!mode) return undefined;
  return {
    instruction: mode === 'final_answer'
      ? SLACK_STREAM_FINAL_ANSWER_INSTRUCTION
      : SLACK_STREAM_ANSWER_INSTRUCTION,
    tool: createSlackStreamAnswerTool(mode),
  };
}
