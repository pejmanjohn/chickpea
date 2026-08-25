import { AsyncLocalStorage } from 'node:async_hooks';

import type {
  FlueEventContext,
  FlueExecutionInterceptor,
  FlueObservation,
  LlmMessage,
} from '@flue/runtime';

import { CHICKPEA_SLACK_AGENT_NAME } from '../agents/names.ts';
import {
  currentRequestOffersProgressiveStreaming,
  parseCurrentRequestEnvelope,
  type CurrentRequestEnvelope,
} from '../memory/tool-policy.ts';
import { SLACK_STREAM_ANSWER_TOOL_NAME } from './presentation-intent.ts';

interface PresentationToolPolicyState {
  envelope?: CurrentRequestEnvelope;
  answerOnly: boolean;
}

const submissionPolicy = new AsyncLocalStorage<PresentationToolPolicyState>();

export class SlackAnswerOnlyToolDeniedError extends Error {
  constructor() {
    super(
      'This response declared answer-only delivery. Finish the answer using facts already gathered; additional tools are unavailable.',
    );
    this.name = 'SlackAnswerOnlyToolDeniedError';
  }
}

export class SlackPresentationToolUnavailableError extends Error {
  constructor() {
    super('This response does not offer a progressive-delivery declaration.');
    this.name = 'SlackPresentationToolUnavailableError';
  }
}

/** Submission-scoped execution authority for the declaration-only response path. */
export const presentationToolPolicyInterceptor: FlueExecutionInterceptor = async (
  operation,
  context,
  next,
) => {
  const active = submissionPolicy.getStore();
  if (
    operation.type === 'agent' &&
    context.agentName === CHICKPEA_SLACK_AGENT_NAME &&
    active === undefined
  ) {
    return submissionPolicy.run({ answerOnly: false }, next);
  }

  if (operation.type !== 'tool' || active === undefined) return next();

  if (operation.toolName === SLACK_STREAM_ANSWER_TOOL_NAME) {
    if (!currentRequestOffersProgressiveStreaming(active.envelope)) {
      throw new SlackPresentationToolUnavailableError();
    }
    const result = await next();
    active.answerOnly = true;
    return result;
  }

  if (active.answerOnly) throw new SlackAnswerOnlyToolDeniedError();
  return next();
};

/** Rehydrate declaration authority from durable current-response tool history. */
export function observePresentationToolPolicy(
  observation: FlueObservation,
  context: FlueEventContext,
): void {
  if (
    observation.type !== 'turn_request' ||
    observation.purpose !== 'agent' ||
    context.agentName !== CHICKPEA_SLACK_AGENT_NAME
  ) return;
  const active = submissionPolicy.getStore();
  if (!active) return;

  const current = currentResponsePolicy(observation.request.input.messages);
  if (current.envelope) active.envelope = current.envelope;
  else delete active.envelope;
  if (current.successfulDeclaration) active.answerOnly = true;
}

function currentResponsePolicy(messages: readonly LlmMessage[]): {
  envelope?: CurrentRequestEnvelope;
  successfulDeclaration: boolean;
} {
  let newestUserIndex = -1;
  let envelope: CurrentRequestEnvelope | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    newestUserIndex = index;
    envelope = envelopeFromUserMessage(message);
    break;
  }
  if (newestUserIndex < 0) return { successfulDeclaration: false };

  const declaredCalls = new Set<string>();
  let successfulDeclaration = false;
  for (const message of messages.slice(newestUserIndex + 1)) {
    if (message.role === 'assistant') {
      for (const content of message.content) {
        if (content.type === 'toolCall' && content.name === SLACK_STREAM_ANSWER_TOOL_NAME) {
          declaredCalls.add(content.id);
        }
      }
      continue;
    }
    if (
      message.role === 'toolResult' &&
      message.toolName === SLACK_STREAM_ANSWER_TOOL_NAME &&
      message.isError === false &&
      declaredCalls.has(message.toolCallId)
    ) {
      successfulDeclaration = true;
    }
  }
  return {
    ...(envelope ? { envelope } : {}),
    successfulDeclaration,
  };
}

function envelopeFromUserMessage(
  message: Extract<LlmMessage, { role: 'user' }>,
): CurrentRequestEnvelope | undefined {
  const texts = typeof message.content === 'string'
    ? [message.content]
    : message.content.flatMap((content) => content.type === 'text' ? [content.text] : []);
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const envelope = parseCurrentRequestEnvelope(texts[index]!);
    if (envelope) return envelope;
  }
  return undefined;
}
