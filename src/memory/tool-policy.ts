import { AsyncLocalStorage } from 'node:async_hooks';

import type {
  FlueEventContext,
  FlueExecutionInterceptor,
  FlueObservation,
  LlmMessage,
} from '@flue/runtime';

import { MANAGED_SUBMISSION_AGENT_NAMES } from '../agents/names.ts';
import {
  ROUTINE_SCHEDULE_SIGNAL_IDENTITY_ATTRIBUTES,
  ROUTINE_SCHEDULE_SIGNAL_TYPE,
  scheduleSignalMessageTsFromAttribute,
} from '../routines/schedule-signal.ts';

export const MEMORY_CURRENT_REQUEST_ENVELOPE_START =
  '--- BEGIN CHICKPEA CURRENT REQUEST POLICY v1 ---';
export const MEMORY_CURRENT_REQUEST_ENVELOPE_END =
  '--- END CHICKPEA CURRENT REQUEST POLICY v1 ---';

export const CURRENT_REQUEST_ENVELOPE_V2_START =
  '--- BEGIN CHICKPEA CURRENT REQUEST POLICY v2 ---';
export const CURRENT_REQUEST_ENVELOPE_V2_END =
  '--- END CHICKPEA CURRENT REQUEST POLICY v2 ---';

interface CurrentRequestEnvelopeBase {
  memoryInfluenced: boolean;
  /** Legacy connector classification fields, retained only for envelope compatibility. */
  explicitExternalSideEffectIntent: boolean;
  externalSideEffectIntents: string[];
  managedCapabilityIntents: string[];
  /** Host-validated actor for this delivery. Absent on legacy/non-Slack prompts. */
  slackActorId?: string;
  /** Host-validated Slack message coordinate paired with slackActorId. */
  slackMessageTs?: string;
}

interface CurrentRequestEnvelopeV1 extends CurrentRequestEnvelopeBase {
  schemaVersion: 1;
}

interface CurrentRequestEnvelopeV2 extends CurrentRequestEnvelopeBase {
  schemaVersion: 2;
  progressiveStreamingOffered: boolean;
}

export type CurrentRequestEnvelope = CurrentRequestEnvelopeV1 | CurrentRequestEnvelopeV2;

interface SubmissionPolicyState {
  policy?: CurrentRequestEnvelope;
  conversation?: CurrentRequestConversationBinding;
}

/**
 * The host-owned Slack coordinates of the submission being rendered. Only the
 * host can supply these: they come from the frozen runtime plan, never from
 * model-visible text.
 */
export interface CurrentRequestConversationBinding {
  workspaceId: string;
  channelId: string;
  threadTs: string;
}

const submissionPolicy = new AsyncLocalStorage<SubmissionPolicyState>();

/** Tools whose only side effect is delivering a file into the current thread. */
export const ARTIFACT_DELIVERY_TOOL_NAMES: ReadonlySet<string> = new Set(['post_artifact', 'render_chart', 'generate_image']);

/**
 * Bind this submission's host-owned conversation from the render, where the
 * frozen runtime plan is in hand. The attachment-context signal re-stamps the
 * turn's envelope and must prove it belongs to this conversation; no other
 * signal consults the binding.
 */
export function bindCurrentRequestConversation(
  conversation: CurrentRequestConversationBinding,
): void {
  const state = submissionPolicy.getStore();
  if (state) state.conversation = conversation;
}

/** The conversation the caller bound for this submission, if any. */
export function boundCurrentRequestConversation(): CurrentRequestConversationBinding | undefined {
  return submissionPolicy.getStore()?.conversation;
}

/**
 * Return the verbatim terminal current-request envelope of `prompt`, so a host
 * signal can re-stamp exactly the bytes the host wrote rather than a
 * re-serialization of them.
 */
export function currentRequestEnvelopeText(prompt: string): string | undefined {
  for (const [startValue, endValue] of [
    [CURRENT_REQUEST_ENVELOPE_V2_START, CURRENT_REQUEST_ENVELOPE_V2_END],
    [MEMORY_CURRENT_REQUEST_ENVELOPE_START, MEMORY_CURRENT_REQUEST_ENVELOPE_END],
  ] as const) {
    const end = `\n${endValue}`;
    if (!prompt.endsWith(end)) continue;
    const startMarker = `${startValue}\n`;
    const start = prompt.lastIndexOf(startMarker, prompt.length - end.length);
    if (start < 0) continue;
    const text = prompt.slice(start);
    if (parseCurrentRequestEnvelope(text)) return text;
  }
  return undefined;
}

/**
 * A terminal app-generated envelope is the only source of admission state.
 * User and memory text precede it, so marker lookalikes in either cannot win
 * the last-marker + exact-end parse below.
 */
export function serializeCurrentRequestEnvelope(
  _currentRequest: string,
  memoryInfluenced: boolean,
  slackActorId?: string,
  slackMessageTs?: string,
  options: {
    schemaVersion?: 1 | 2;
    progressiveStreamingOffered?: boolean;
  } = {},
): string {
  const shared: CurrentRequestEnvelopeBase = {
    memoryInfluenced,
    // Retain the wire shape for stored envelopes. Connector authority comes
    // from connection grants, not host-side classification of request words.
    explicitExternalSideEffectIntent: false,
    externalSideEffectIntents: [],
    managedCapabilityIntents: [],
    ...(slackActorId && slackMessageTs ? { slackActorId, slackMessageTs } : {}),
  };
  const schemaVersion = options.schemaVersion ?? 2;
  const payload: CurrentRequestEnvelope = schemaVersion === 1
    ? { ...shared, schemaVersion: 1 }
    : {
        ...shared,
        schemaVersion: 2,
        progressiveStreamingOffered: options.progressiveStreamingOffered === true,
      };
  const markers = schemaVersion === 1
    ? [MEMORY_CURRENT_REQUEST_ENVELOPE_START, MEMORY_CURRENT_REQUEST_ENVELOPE_END]
    : [CURRENT_REQUEST_ENVELOPE_V2_START, CURRENT_REQUEST_ENVELOPE_V2_END];
  return [
    markers[0],
    JSON.stringify(payload),
    markers[1],
  ].join('\n');
}

export function parseCurrentRequestEnvelope(
  prompt: string,
): CurrentRequestEnvelope | undefined {
  return parseCurrentRequestEnvelopeVersion(prompt, 2) ??
    parseCurrentRequestEnvelopeVersion(prompt, 1);
}

/**
 * Flue renders host signals as escaped XML in model observations. Three host
 * signals carry a current-request envelope: the Slack turn (`slack_message`),
 * the attachment-analysis context the host appends to an upload turn
 * (`slack_attachment_context`), and the due routine occurrence
 * (`signal type="schedule"`). Each must prove the terminal envelope in its
 * body belongs to the signal's own host-owned coordinates; an envelope from
 * any other message never admits delivery.
 */
export function parseModelVisibleCurrentRequestEnvelope(
  text: string,
  conversation: CurrentRequestConversationBinding | undefined =
    boundCurrentRequestConversation(),
): CurrentRequestEnvelope | undefined {
  const plain = parseCurrentRequestEnvelope(text);
  if (plain) return plain;
  const signal = /^<(slack_message|slack_attachment_context|signal)((?: [A-Za-z][A-Za-z0-9]*="[^"<>]*")+)>\n([^<>]*)\n<\/\1>$/.exec(text);
  if (!signal) return undefined;
  const attributes = new Map<string, string>();
  for (const match of signal[2]!.matchAll(/ ([A-Za-z][A-Za-z0-9]*)="([^"]*)"/g)) {
    if (attributes.has(match[1]!)) return undefined;
    attributes.set(match[1]!, decodeSignalText(match[2]!));
  }
  const envelope = parseCurrentRequestEnvelope(decodeSignalText(signal[3]!));
  if (!envelope || !envelope.slackActorId || !envelope.slackMessageTs) return undefined;
  const type = attributes.get('type');
  const slackTurn = signal[1] === 'slack_message' && type === 'slack.message';
  // An upload turn's attachment analysis becomes the newest user message, so
  // the host re-stamps the same envelope as its final lines. The gate resolves
  // by the last marker, which is why file-derived observations sit above it.
  const attachmentContext = signal[1] === 'slack_attachment_context' &&
    type === 'slack.attachment_context';
  if (slackTurn || attachmentContext) {
    if (envelope.slackActorId !== attributes.get('slackUserId') ||
        envelope.slackMessageTs !== attributes.get('messageTs')) {
      return undefined;
    }
    // The envelope record carries no channel or thread, so the re-stamped
    // signal is bound to the turn by the host-owned conversation the caller
    // supplies. Without one, an attachment-context envelope admits nothing.
    if (attachmentContext && !conversationMatches(attributes, conversation)) return undefined;
    return envelope;
  }
  if (signal[1] === 'signal' && type === ROUTINE_SCHEDULE_SIGNAL_TYPE) {
    // A due occurrence has no Slack message. The host stamps its due time as
    // the synthetic message coordinate when it assembles the saved task, and
    // repeats that due time as a signal attribute, so the envelope must match
    // exactly this occurrence rather than any other saved task or prompt.
    // Envelopes queued before the actor attribute existed carry no actor to
    // compare; newer signals must name the same member the prompt ran as.
    const actor = attributes.get('actorSlackUserId');
    return ROUTINE_SCHEDULE_SIGNAL_IDENTITY_ATTRIBUTES.every((name) => attributes.get(name)) &&
      envelope.slackMessageTs === scheduleSignalMessageTsFromAttribute(attributes.get('scheduledFor')) &&
      (actor === undefined || actor === envelope.slackActorId)
      ? envelope
      : undefined;
  }
  return undefined;
}

function conversationMatches(
  attributes: ReadonlyMap<string, string>,
  conversation: CurrentRequestConversationBinding | undefined,
): boolean {
  if (!conversation) return false;
  return ([
    ['workspaceId', conversation.workspaceId],
    ['channelId', conversation.channelId],
    ['threadTs', conversation.threadTs],
  ] as const).every(([name, expected]) => {
    const value = attributes.get(name);
    return Boolean(value) && Boolean(expected) && value === expected;
  });
}

function decodeSignalText(text: string): string {
  // One pass only: user text containing literal entity spellings stays text.
  return text.replace(/&(amp|lt|gt|quot);/g, (_entity, name: string) =>
    ({ amp: '&', lt: '<', gt: '>', quot: '"' })[name]!
  );
}

export function currentRequestOffersProgressiveStreaming(
  envelope: CurrentRequestEnvelope | undefined,
): boolean {
  return envelope?.schemaVersion === 2 && envelope.progressiveStreamingOffered;
}

function parseCurrentRequestEnvelopeVersion(
  prompt: string,
  schemaVersion: 1 | 2,
): CurrentRequestEnvelope | undefined {
  const [startValue, endValue] = schemaVersion === 1
    ? [MEMORY_CURRENT_REQUEST_ENVELOPE_START, MEMORY_CURRENT_REQUEST_ENVELOPE_END]
    : [CURRENT_REQUEST_ENVELOPE_V2_START, CURRENT_REQUEST_ENVELOPE_V2_END];
  const end = `\n${endValue}`;
  if (!prompt.endsWith(end)) return undefined;
  const startMarker = `${startValue}\n`;
  const start = prompt.lastIndexOf(startMarker, prompt.length - end.length);
  if (start < 0) return undefined;
  const json = prompt.slice(start + startMarker.length, prompt.length - end.length);
  if (json.includes('\n')) return undefined;

  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    const keys = Object.keys(value);
    const allowedKeys = new Set([
      'schemaVersion',
      'memoryInfluenced',
      'explicitExternalSideEffectIntent',
      'externalSideEffectIntents',
      'managedCapabilityIntents',
      'explicitArtifactDeliveryIntent',
      'slackActorId',
      'slackMessageTs',
      'progressiveStreamingOffered',
    ]);
    const hasSlackCoordinates = value.slackActorId !== undefined &&
      value.slackMessageTs !== undefined;
    const hasScopedEffectIntents = value.externalSideEffectIntents !== undefined;
    const hasManagedCapabilityIntents = value.managedCapabilityIntents !== undefined;
    if (
      value.schemaVersion !== schemaVersion ||
      typeof value.memoryInfluenced !== 'boolean' ||
      typeof value.explicitExternalSideEffectIntent !== 'boolean' ||
      (hasScopedEffectIntents && (
        !isExternalSideEffectIntentList(value.externalSideEffectIntents) ||
        value.explicitExternalSideEffectIntent !==
          ((value.externalSideEffectIntents as string[]).length > 0)
      )) ||
      (hasManagedCapabilityIntents &&
        !isManagedCapabilityIntentList(value.managedCapabilityIntents)) ||
      (value.explicitArtifactDeliveryIntent !== undefined &&
        typeof value.explicitArtifactDeliveryIntent !== 'boolean') ||
      (schemaVersion === 2 && typeof value.progressiveStreamingOffered !== 'boolean') ||
      (schemaVersion === 1 && value.progressiveStreamingOffered !== undefined) ||
      (value.slackActorId !== undefined && !isSlackActorId(value.slackActorId)) ||
      (value.slackMessageTs !== undefined && !isSlackMessageTs(value.slackMessageTs)) ||
      (value.slackActorId === undefined) !== (value.slackMessageTs === undefined) ||
      keys.some((key) => !allowedKeys.has(key)) ||
      keys.length !== (hasSlackCoordinates ? 5 : 3) +
        (value.explicitArtifactDeliveryIntent !== undefined ? 1 : 0) +
        (schemaVersion === 2 ? 1 : 0) + (hasScopedEffectIntents ? 1 : 0) +
        (hasManagedCapabilityIntents ? 1 : 0)
    ) {
      return undefined;
    }
    const shared: CurrentRequestEnvelopeBase = {
      memoryInfluenced: value.memoryInfluenced,
      // Pre-scope V1/V2 envelopes may be replayed after a deployment. Preserve
      // their non-effect features, but fail closed for writes that were only
      // authorized by the old submission-wide boolean.
      explicitExternalSideEffectIntent: hasScopedEffectIntents
        ? value.explicitExternalSideEffectIntent as boolean
        : false,
      externalSideEffectIntents: hasScopedEffectIntents
        ? value.externalSideEffectIntents as string[]
        : [],
      managedCapabilityIntents: hasManagedCapabilityIntents
        ? value.managedCapabilityIntents as string[]
        : [],
      ...(hasSlackCoordinates
        ? {
            slackActorId: value.slackActorId as string,
            slackMessageTs: value.slackMessageTs as string,
          }
        : {}),
    };
    return schemaVersion === 1
      ? { ...shared, schemaVersion: 1 }
      : {
          ...shared,
          schemaVersion: 2,
          progressiveStreamingOffered: value.progressiveStreamingOffered as boolean,
        };
  } catch {
    return undefined;
  }
}

function isSlackActorId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

function isSlackMessageTs(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,20}\.\d{1,10}$/.test(value);
}

function isExternalSideEffectIntentList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 8 && value.every((intent) =>
    typeof intent === 'string' && intent.length > 0 && intent.length <= 500 &&
    intent === intent.trim()
  );
}

function isManagedCapabilityIntentList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 8 && value.every((capabilityId) =>
    typeof capabilityId === 'string' &&
    /^[a-z0-9][a-z0-9_.-]{0,191}$/.test(capabilityId)
  );
}

/** Restore one mutable admission cell around the complete durable submission. */
export const memoryToolPolicyInterceptor: FlueExecutionInterceptor = async (
  operation,
  context,
  next,
) => {
  const active = submissionPolicy.getStore();
  if (
    operation.type === 'agent' &&
    isManagedCurrentRequestAgent(context.agentName) &&
    active === undefined
  ) {
    return submissionPolicy.run({}, next);
  }

  if (operation.type === 'tool' && active !== undefined) {
    if (ARTIFACT_DELIVERY_TOOL_NAMES.has(operation.toolName)) {
      assertArtifactDeliveryAllowed();
      return next();
    }
  }
  return next();
};

/**
 * `turn_request` fires synchronously after Flue has assembled the actual model
 * input and before provider execution. Resolve admission there so every nested
 * model tool call observes the same submission-scoped state.
 */
export function observeMemoryToolPolicy(
  observation: FlueObservation,
  context: FlueEventContext,
): void {
  if (
    observation.type !== 'turn_request' ||
    observation.purpose !== 'agent' ||
    !isManagedCurrentRequestAgent(context.agentName)
  ) {
    return;
  }
  const state = submissionPolicy.getStore();
  if (!state) return;
  const policy = envelopeFromMessages(observation.request.input.messages, state.conversation);
  if (policy) state.policy = policy;
  else delete state.policy;
}

/** Require the current host envelope, not a vocabulary-based permission. */
export function assertArtifactDeliveryAllowed(): void {
  const state = submissionPolicy.getStore();
  if (state === undefined || state.policy !== undefined) return;
  const error = new Error('File delivery is unavailable because this response has no valid current request context.');
  error.name = 'CurrentRequestSideEffectDeniedError';
  throw error;
}

function isManagedCurrentRequestAgent(agentName: string | undefined): boolean {
  return agentName !== undefined &&
    (MANAGED_SUBMISSION_AGENT_NAMES as readonly string[]).includes(agentName);
}

function envelopeFromMessages(
  messages: readonly LlmMessage[],
  conversation: CurrentRequestConversationBinding | undefined,
): CurrentRequestEnvelope | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const texts = typeof message.content === 'string'
      ? [message.content]
      : message.content.flatMap((content) =>
          content.type === 'text' ? [content.text] : [],
        );
    for (let textIndex = texts.length - 1; textIndex >= 0; textIndex -= 1) {
      const policy = parseModelVisibleCurrentRequestEnvelope(texts[textIndex]!, conversation);
      if (policy) return policy;
    }
    // The newest user message is the current submission. Never fall back to an
    // older envelope when the newest one is missing or malformed.
    return undefined;
  }
  return undefined;
}
