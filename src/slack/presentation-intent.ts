import * as v from 'valibot';

import {
  currentRequestOffersProgressiveStreaming,
  type CurrentRequestEnvelope,
} from '../memory/tool-policy.ts';

export const SLACK_STREAM_ANSWER_TOOL_NAME = 'stream_answer';
export const SLACK_STREAM_ANSWER_ACKNOWLEDGEMENT =
  'Delivery preference noted. Continue with the answer.';

export const SLACK_STREAM_ANSWER_INSTRUCTION = [
  'You may call stream_answer once, before writing any answer text, only for a direct answer whose stable early prose would be useful to read before the response is complete.',
  'Do not call it for a short confirmation, a primarily structured response, a correction, or a response likely to need another tool.',
  'This is only a delivery preference. Never claim that Slack is streaming, change the answer based on delivery, or mention this internal tool to the user.',
  'If uncertain, answer normally without calling it; terminal delivery is expected and is not an error.',
].join(' ');

export function createSlackStreamAnswerTool() {
  return {
    name: SLACK_STREAM_ANSWER_TOOL_NAME,
    description:
      'Declare before answer text that progressive delivery would improve this direct response.',
    output: v.string(),
    run: () => ({ output: SLACK_STREAM_ANSWER_ACKNOWLEDGEMENT }),
  };
}

export function slackPresentationIntentCapability(
  envelope: CurrentRequestEnvelope | undefined,
) {
  if (!currentRequestOffersProgressiveStreaming(envelope)) return undefined;
  return {
    instruction: SLACK_STREAM_ANSWER_INSTRUCTION,
    tool: createSlackStreamAnswerTool(),
  };
}
