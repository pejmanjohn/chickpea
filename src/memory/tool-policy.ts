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
  explicitArtifactDeliveryIntent: boolean;
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
}

const submissionPolicy = new AsyncLocalStorage<SubmissionPolicyState>();

/** Tools whose only side effect is delivering a file into the current thread. */
export const ARTIFACT_DELIVERY_TOOL_NAMES: ReadonlySet<string> = new Set(['post_artifact', 'render_chart']);

const ARTIFACT_ACTION_PATTERN =
  'attach|capture|chart|create|draw|export|generate|give|graph|include|make|plot|post|render|send|share|show|screenshot|take|upload|visuali[sz]e';
const ARTIFACT_TARGET_PATTERN =
  'artifact|chart|csv|document|file|graph|image|plot|png|report|screenshot|spreadsheet|video|visuali[sz]ation|visuali[sz]e';
const ARTIFACT_ACTION = new RegExp(`\\b(?:${ARTIFACT_ACTION_PATTERN})\\b`, 'i');
const ARTIFACT_TARGET = new RegExp(`\\b(?:${ARTIFACT_TARGET_PATTERN})\\b`, 'i');
const DIRECT_TASK_START =
  /^(?:attach|build|capture|change|chart|create|draw|edit|export|generate|give|graph|include|make|open|plot|post|prepare|render|run|send|share|show|screenshot|take|test|update|upload|visuali[sz]e|write)\b/i;

export interface ArtifactRequestAddress {
  botUserId?: string | undefined;
  agentUserGroupId?: string | undefined;
  agentHandle?: string | undefined;
}

/**
 * Which host surface authored the current request. A live Slack message is
 * classified as written. A saved routine task is the Agent's verbatim span of
 * an earlier request, so it may keep the scheduling wrapper that preceded the
 * work ("At that due time, generate and attach…"); admission evaluates the
 * task's own clauses instead of only its first word.
 */
export type CurrentRequestKind = 'slack_message' | 'saved_task';

/**
 * A terminal app-generated envelope is the only source of admission state.
 * User and memory text precede it, so marker lookalikes in either cannot win
 * the last-marker + exact-end parse below.
 */
export function serializeCurrentRequestEnvelope(
  currentRequest: string,
  memoryInfluenced: boolean,
  slackActorId?: string,
  slackMessageTs?: string,
  options: {
    schemaVersion?: 1 | 2;
    progressiveStreamingOffered?: boolean;
    artifactAddress?: ArtifactRequestAddress;
    requestKind?: CurrentRequestKind;
  } = {},
): string {
  const shared: CurrentRequestEnvelopeBase = {
    memoryInfluenced,
    // Retain the wire shape for stored envelopes. Connector authority comes
    // from connection grants, not host-side classification of request words.
    explicitExternalSideEffectIntent: false,
    externalSideEffectIntents: [],
    managedCapabilityIntents: [],
    explicitArtifactDeliveryIntent:
      hasExplicitArtifactDeliveryIntent(currentRequest, options.artifactAddress, options.requestKind),
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
 * Flue renders host signals as escaped XML in model observations. Two host
 * signals carry a current-request envelope: the Slack turn (`slack_message`)
 * and the due routine occurrence (`signal type="schedule"`). Each must prove
 * the terminal envelope in its body belongs to the signal's own host-owned
 * coordinates; an envelope from any other message never admits delivery.
 */
export function parseModelVisibleCurrentRequestEnvelope(
  text: string,
): CurrentRequestEnvelope | undefined {
  const plain = parseCurrentRequestEnvelope(text);
  if (plain) return plain;
  const signal = /^<(slack_message|signal)((?: [A-Za-z][A-Za-z0-9]*="[^"<>]*")+)>\n([^<>]*)\n<\/\1>$/.exec(text);
  if (!signal) return undefined;
  const attributes = new Map<string, string>();
  for (const match of signal[2]!.matchAll(/ ([A-Za-z][A-Za-z0-9]*)="([^"]*)"/g)) {
    if (attributes.has(match[1]!)) return undefined;
    attributes.set(match[1]!, decodeSignalText(match[2]!));
  }
  const envelope = parseCurrentRequestEnvelope(decodeSignalText(signal[3]!));
  if (!envelope || !envelope.slackActorId || !envelope.slackMessageTs) return undefined;
  const type = attributes.get('type');
  if (signal[1] === 'slack_message' && type === 'slack.message') {
    return envelope.slackActorId === attributes.get('slackUserId') &&
      envelope.slackMessageTs === attributes.get('messageTs')
      ? envelope
      : undefined;
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
      typeof value.explicitArtifactDeliveryIntent !== 'boolean' ||
      (schemaVersion === 2 && typeof value.progressiveStreamingOffered !== 'boolean') ||
      (schemaVersion === 1 && value.progressiveStreamingOffered !== undefined) ||
      (value.slackActorId !== undefined && !isSlackActorId(value.slackActorId)) ||
      (value.slackMessageTs !== undefined && !isSlackMessageTs(value.slackMessageTs)) ||
      (value.slackActorId === undefined) !== (value.slackMessageTs === undefined) ||
      keys.some((key) => !allowedKeys.has(key)) ||
      keys.length !== (hasSlackCoordinates ? 6 : 4) +
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
      explicitArtifactDeliveryIntent: value.explicitArtifactDeliveryIntent,
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

/** Host-side view of the same admission the envelope freezes for the model. */
export function requestAdmitsArtifactDelivery(
  currentRequest: string,
  address?: ArtifactRequestAddress,
  requestKind?: CurrentRequestKind,
): boolean {
  return hasExplicitArtifactDeliveryIntent(currentRequest, address, requestKind);
}

/**
 * Artifact delivery is scoped separately from generic connector mutation. A
 * task request must name both creation/delivery work and the artifact itself;
 * merely asking to review an existing screenshot does not authorize upload.
 */
function hasExplicitArtifactDeliveryIntent(
  currentRequest: string,
  address?: ArtifactRequestAddress,
  requestKind: CurrentRequestKind = 'slack_message',
): boolean {
  const request = normalizedCurrentRequest(currentRequest, address);
  if (!request) return false;
  if (requestKind === 'saved_task') return savedTaskAdmitsArtifactDelivery(request);
  if (/^(?:do not|don't|never)\b/i.test(request)) return false;
  const task = stripRequestPreamble(request);
  return artifactTaskClause(task);
}

function artifactTaskClause(task: string): boolean {
  return DIRECT_TASK_START.test(task) && ARTIFACT_ACTION.test(task) && ARTIFACT_TARGET.test(task);
}

const QUOTED_SPAN = /```[\s\S]*?(?:```|$)|`[^`\n]*`|"[^"]*(?:"|$)|\u201c[^\u201d]*(?:\u201d|$)|\u2018[^\u2019]*(?:\u2019|$)|(?<!\w)'[^']*'(?!\w)/g;
const CLAUSE_BOUNDARY = /[.!?;\n]+|\bbut\b/i;
const NEGATED_CLAUSE = /^(?:do not|don't|never|not|without|no longer)\b/i;
const SAVED_TASK_START = /^(?:analy[sz]e|calculate|check|compare|count|describe|fetch|find|inspect|list|read|report|review|summari[sz]e)\b/i;
const SAVED_TASK_CONJUNCTION = /\s*,?\s+and(?:\s+then)?\s+|,\s*(?:then\s+)?/i;
const ARTIFACT_NEGATION = /\b(?:do not|don't|never|must not|should not|cannot|can't|without|avoid|no longer)\b([^.!?;\n]*)/gi;
const ARTIFACT_WRITE_ACTION = /\b(?:attach(?:ing)?|captur(?:e|ing)|creat(?:e|ing)|draw(?:ing)?|export(?:ing)?|generat(?:e|ing)|giv(?:e|ing)|includ(?:e|ing)|mak(?:e|ing)|plot(?:ting)?|post(?:ing)?|render(?:ing)?|send(?:ing)?|shar(?:e|ing)|show(?:ing)?|upload(?:ing)?)\b/i;
const ARTIFACT_OR_ATTACHMENT = new RegExp(`\\b(?:${ARTIFACT_TARGET_PATTERN}|attachment)s?\\b`, 'i');
const ARTIFACT_PROHIBITION = /\b(?:no|without)\s+(?:(?:more|any|an?)\s+)?(?:attachments?|files?|images?|charts?|exports?)\b/i;
const ARTIFACT_PRONOUN = /\b(?:it|them|anything)\b/i;
// An instruction introduced as text to quote or an example is not a task,
// including an unquoted example on the next line. Keep preceding real work.
const QUOTED_TASK_INTRODUCTION = /\b(?:example|(?:quoted?|following|exact)\s+(?:text|instruction|example)|(?:say|repeat|return|reply)\s+(?:exactly|verbatim))\s*:[\s\S]*/i;
const SCHEDULE_WRAPPERS: readonly RegExp[] = [
  // "At that due time,", "when the scheduled time comes,", "once it is due,"
  /^(?:at|when|once|after)\s+(?:that|the|its?|this)\s+(?:due\s+|scheduled\s+)?(?:time|moment|run|occurrence)(?:\s+(?:comes|arrives))?[,:]?\s*/i,
  /^(?:when|once|whenever)\s+(?:it(?:'s| is)\s+)?due[,:]?\s*/i,
  // "at 18:06 UTC generate…", "at 6 pm on September 10, 2026,"
  /^at\s+\d{1,2}(?::\d{2})?(?:\s*(?:am|pm|a\.m\.|p\.m\.))?(?:\s+(?:utc|gmt|[a-z]{2,4}t|[A-Za-z]+\/[A-Za-z_]+))?(?:\s+on\s+[A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?)?[,:]?\s*/i,
  // "Every Monday at 9am,", "each weekday,"
  /^(?:every|each)\s+(?:day|weekday|week|month|morning|evening|afternoon|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+\s+[a-z]+)(?:\s+at\s+[^,:]{1,30})?[,:]?\s*/i,
  // "On Monday,", "tomorrow at 9,", "on September 10 at 18:06 UTC,"
  /^(?:on\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|[A-Z][a-z]+\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?)s?(?:\s+at\s+[^,:]{1,30})?[,:]\s*/,
  /^(?:then|and then|next)[,:]?\s+/i,
];

/**
 * A saved task is the Agent's verbatim span of the request that scheduled it.
 * It may start with the scheduling wrapper or a "do not run it now" sentence
 * that the interactive rule would treat as a non-task or a negation. Evaluate
 * each of its own clauses after removing quoted text, so a quoted example, a
 * negated clause, or history-like prose never opens delivery on its own.
 */
function savedTaskAdmitsArtifactDelivery(taskText: string): boolean {
  const unquoted = taskText
    .replace(QUOTED_SPAN, ' ')
    .replace(/^\s*>[^\n]*$/gm, ' ')
    .replace(QUOTED_TASK_INTRODUCTION, ' ')
    .replace(/\u2019/g, "'");
  // Evaluate constraints before accepting any affirmative clause. These tools
  // publish every staged file, so a conflicting artifact prohibition must fail
  // closed rather than being forgotten after an earlier "generate a chart".
  if (ARTIFACT_PROHIBITION.test(unquoted)) return false;
  for (const negated of unquoted.matchAll(ARTIFACT_NEGATION)) {
    if (ARTIFACT_WRITE_ACTION.test(negated[1]!) && (
      ARTIFACT_OR_ATTACHMENT.test(negated[1]!) ||
      (ARTIFACT_OR_ATTACHMENT.test(unquoted) && ARTIFACT_PRONOUN.test(negated[1]!))
    )) {
      return false;
    }
  }
  for (const rawClause of unquoted.split(CLAUSE_BOUNDARY)) {
    let clause = rawClause.trim();
    if (!clause) continue;
    for (let pass = 0; pass < 2; pass += 1) {
      for (const wrapper of SCHEDULE_WRAPPERS) clause = clause.replace(wrapper, '');
      clause = stripRequestPreamble(clause.trim());
    }
    if (!clause || NEGATED_CLAUSE.test(clause)) continue;
    // A later imperative in the same saved task is equally authoritative:
    // "Summarize bookings and attach a CSV." Requiring an imperative at the
    // start also prevents history such as "the user said ... and attach ..."
    // from becoming an independent request through conjunction splitting.
    if (!DIRECT_TASK_START.test(clause) && !SAVED_TASK_START.test(clause)) continue;
    for (const task of clause.split(SAVED_TASK_CONJUNCTION)) {
      if (artifactTaskClause(stripRequestPreamble(task.trim()))) return true;
    }
  }
  return false;
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
  const policy = envelopeFromMessages(observation.request.input.messages);
  if (policy) state.policy = policy;
}

/** Artifact delivery has a separate product contract from connector access. */
export function assertArtifactDeliveryAllowed(): void {
  const state = submissionPolicy.getStore();
  if (state === undefined || state.policy?.explicitArtifactDeliveryIntent === true) return;
  const error = new Error('Artifact delivery requires an explicit request to create or deliver the artifact.');
  error.name = 'CurrentRequestSideEffectDeniedError';
  throw error;
}

function isManagedCurrentRequestAgent(agentName: string | undefined): boolean {
  return agentName !== undefined &&
    (MANAGED_SUBMISSION_AGENT_NAMES as readonly string[]).includes(agentName);
}

function normalizedCurrentRequest(currentRequest: string, address?: ArtifactRequestAddress): string {
  // Only the host-resolved recipient may be removed. A request addressed to
  // someone else in a followed thread must not become this Agent's task.
  const identities: string[] = [];
  if (address?.botUserId && /^[A-Z0-9]+$/i.test(address.botUserId)) {
    identities.push(`<@${address.botUserId}(?:\\|[^>]*)?>`);
  }
  if (address?.agentUserGroupId && /^[A-Z0-9]+$/i.test(address.agentUserGroupId)) {
    identities.push(`<!subteam\\^${address.agentUserGroupId}(?:\\|[^>]*)?>`);
  }
  if (address?.agentHandle && /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(address.agentHandle)) {
    identities.push(`@${address.agentHandle}(?=[\\s,:;.!?]|$)`);
  }
  if (!identities.length) return currentRequest.trim();
  return currentRequest.replace(
    new RegExp(`^\\s*(?:(?:${identities.join('|')})\\s*[,;:.!?–—-]?\\s*)+`, 'i'), '',
  ).trim();
}

/** Normalize polite prefixes for the separate artifact request check. */
function stripRequestPreamble(request: string): string {
  return request.replace(/^(?:(?:please|kindly)\s+|instead,?\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?|i(?:'d| would)?\s+(?:like|want|need)\s+you\s+to\s+|(?:go ahead|proceed)\s+(?:and\s+)?)/i, '');
}

function envelopeFromMessages(
  messages: readonly LlmMessage[],
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
      const policy = parseModelVisibleCurrentRequestEnvelope(texts[textIndex]!);
      if (policy) return policy;
    }
    // The newest user message is the current submission. Never fall back to an
    // older envelope when the newest one is missing or malformed.
    return undefined;
  }
  return undefined;
}
