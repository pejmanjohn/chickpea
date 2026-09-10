import { AsyncLocalStorage } from 'node:async_hooks';

import type {
  FlueEventContext,
  FlueExecutionInterceptor,
  FlueObservation,
  LlmMessage,
} from '@flue/runtime';

import { MANAGED_SUBMISSION_AGENT_NAMES } from '../agents/names.ts';

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
      hasExplicitArtifactDeliveryIntent(currentRequest, options.artifactAddress),
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

/** Flue renders host Slack signals as escaped XML in model observations. */
export function parseModelVisibleCurrentRequestEnvelope(
  text: string,
): CurrentRequestEnvelope | undefined {
  const plain = parseCurrentRequestEnvelope(text);
  if (plain) return plain;
  const signal = /^<slack_message((?: [A-Za-z][A-Za-z0-9]*="[^"<>]*")+)>\n([^<>]*)\n<\/slack_message>$/.exec(text);
  if (!signal) return undefined;
  const attributes = new Map<string, string>();
  for (const match of signal[1]!.matchAll(/ ([A-Za-z][A-Za-z0-9]*)="([^"]*)"/g)) {
    if (attributes.has(match[1]!)) return undefined;
    attributes.set(match[1]!, decodeSignalText(match[2]!));
  }
  if (attributes.get('type') !== 'slack.message') return undefined;
  const envelope = parseCurrentRequestEnvelope(decodeSignalText(signal[2]!));
  if (!envelope || !envelope.slackActorId || !envelope.slackMessageTs ||
      envelope.slackActorId !== attributes.get('slackUserId') ||
      envelope.slackMessageTs !== attributes.get('messageTs')) return undefined;
  return envelope;
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

/**
 * Artifact delivery is scoped separately from generic connector mutation. A
 * task request must name both creation/delivery work and the artifact itself;
 * merely asking to review an existing screenshot does not authorize upload.
 */
function hasExplicitArtifactDeliveryIntent(
  currentRequest: string,
  address?: ArtifactRequestAddress,
): boolean {
  const request = normalizedCurrentRequest(currentRequest, address);
  if (!request || /^(?:do not|don't|never)\b/i.test(request)) return false;
  const task = stripRequestPreamble(request);
  return DIRECT_TASK_START.test(task) && ARTIFACT_ACTION.test(task) && ARTIFACT_TARGET.test(task);
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
