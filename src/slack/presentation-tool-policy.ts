import { AsyncLocalStorage } from 'node:async_hooks';

import type {
  FlueEventContext,
  FlueExecutionInterceptor,
  FlueObservation,
  LlmMessage,
} from '@flue/runtime';

import { CHICKPEA_SLACK_AGENT_NAME } from '../agents/names.ts';
import {
  ARTIFACT_DELIVERY_TOOL_NAMES,
  currentRequestOffersProgressiveStreaming,
  parseModelVisibleCurrentRequestEnvelope,
  type CurrentRequestEnvelope,
} from '../memory/tool-policy.ts';
import { SLACK_STREAM_ANSWER_TOOL_NAME } from './presentation-intent.ts';
import { SLACK_PRESENT_TABLE_TOOL_NAME } from './table-presentation.ts';

interface PresentationToolPolicyState {
  envelope?: CurrentRequestEnvelope;
  answerOnly: boolean;
  artifactDeliveryAttempted: boolean;
}

const submissionPolicy = new AsyncLocalStorage<PresentationToolPolicyState>();

export class SlackAnswerOnlyToolDeniedError extends Error {
  constructor() {
    super(
      'This response declared answer-only delivery. Finish the answer using facts already gathered; additional tools are unavailable. Do not claim a denied tool ran or attached a file. Include useful information inline.',
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
    return submissionPolicy.run({
      answerOnly: false,
      artifactDeliveryAttempted: false,
    }, next);
  }

  if (operation.type !== 'tool' || active === undefined) return next();

  if (operation.toolName === SLACK_STREAM_ANSWER_TOOL_NAME) {
    if (!currentRequestOffersProgressiveStreaming(active.envelope) ||
        active.artifactDeliveryAttempted) {
      throw new SlackPresentationToolUnavailableError();
    }
    const result = await next();
    // Another tool in the same model batch may have begun an upload while
    // the declaration was awaiting its result. File delivery wins until the
    // answer-only lock is committed; never acknowledge both paths.
    if (active.artifactDeliveryAttempted) {
      throw new SlackPresentationToolUnavailableError();
    }
    active.answerOnly = true;
    return result;
  }

  if (operation.toolName === SLACK_PRESENT_TABLE_TOOL_NAME) {
    if (active.answerOnly) throw new SlackAnswerOnlyToolDeniedError();
    const result = await next();
    active.answerOnly = true;
    return result;
  }

  if (active.answerOnly) throw new SlackAnswerOnlyToolDeniedError();
  // A failed/uncertain upload may already have staged a private file. Keep
  // that response on terminal delivery too; never stream ahead of its result.
  if (ARTIFACT_DELIVERY_TOOL_NAMES.has(operation.toolName)) {
    active.artifactDeliveryAttempted = true;
  }
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
  if (current.artifactDeliveryAttempted) active.artifactDeliveryAttempted = true;
}

function currentResponsePolicy(messages: readonly LlmMessage[]): {
  envelope?: CurrentRequestEnvelope;
  successfulDeclaration: boolean;
  artifactDeliveryAttempted: boolean;
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
  if (newestUserIndex < 0) return { successfulDeclaration: false, artifactDeliveryAttempted: false };

  const declaredCalls = new Set<string>();
  let successfulDeclaration = false;
  let artifactDeliveryAttempted = false;
  for (const message of messages.slice(newestUserIndex + 1)) {
    if (message.role === 'assistant') {
      for (const content of message.content) {
        if (content.type === 'toolCall' && ARTIFACT_DELIVERY_TOOL_NAMES.has(content.name)) {
          artifactDeliveryAttempted = true;
        }
        if (content.type === 'toolCall' && (
          content.name === SLACK_STREAM_ANSWER_TOOL_NAME ||
          content.name === SLACK_PRESENT_TABLE_TOOL_NAME
        )) {
          declaredCalls.add(content.id);
        }
      }
      continue;
    }
    if (
      message.role === 'toolResult' &&
      (message.toolName === SLACK_STREAM_ANSWER_TOOL_NAME ||
        message.toolName === SLACK_PRESENT_TABLE_TOOL_NAME) &&
      message.isError === false &&
      declaredCalls.has(message.toolCallId)
    ) {
      successfulDeclaration = true;
    }
  }
  return {
    ...(envelope ? { envelope } : {}),
    successfulDeclaration,
    artifactDeliveryAttempted,
  };
}

function envelopeFromUserMessage(
  message: Extract<LlmMessage, { role: 'user' }>,
): CurrentRequestEnvelope | undefined {
  const texts = typeof message.content === 'string'
    ? [message.content]
    : message.content.flatMap((content) => content.type === 'text' ? [content.text] : []);
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const envelope = parseModelVisibleCurrentRequestEnvelope(texts[index]!);
    if (envelope) return envelope;
  }
  return undefined;
}
