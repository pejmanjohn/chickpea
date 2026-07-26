import { AsyncLocalStorage } from 'node:async_hooks';

import type {
  FlueEventContext,
  FlueExecutionInterceptor,
  FlueObservation,
  LlmMessage,
} from '@flue/runtime';

export const MEMORY_CURRENT_REQUEST_ENVELOPE_START =
  '--- BEGIN CHICKPEA CURRENT REQUEST POLICY v1 ---';
export const MEMORY_CURRENT_REQUEST_ENVELOPE_END =
  '--- END CHICKPEA CURRENT REQUEST POLICY v1 ---';

export interface CurrentRequestEnvelope {
  schemaVersion: 1;
  memoryInfluenced: boolean;
  explicitExternalSideEffectIntent: boolean;
  explicitArtifactDeliveryIntent: boolean;
}

interface SubmissionPolicyState {
  policy?: CurrentRequestEnvelope;
}

const submissionPolicy = new AsyncLocalStorage<SubmissionPolicyState>();

const INTRINSIC_EXTERNAL_WRITE_VERBS = new Set([
  'attach',
  'dispatch',
  'email',
  'invite',
  'message',
  'notify',
  'pay',
  'post',
  'publish',
  'purchase',
  'send',
  'share',
  'submit',
  'upload',
]);

const TARGETED_EXTERNAL_WRITE_VERBS = new Set([
  'add',
  'approve',
  'assign',
  'cancel',
  'change',
  'close',
  'create',
  'delete',
  'deploy',
  'disable',
  'edit',
  'enable',
  'merge',
  'modify',
  'move',
  'reject',
  'remove',
  'reopen',
  'save',
  'set',
  'start',
  'stop',
  'trigger',
  'update',
]);

const EXTERNAL_TARGET =
  /\b(?:account|branch|calendar|card|comment|deployment|document|event|file|folder|issue|item|job|meeting|member|message|order|page|payment|project|pull request|record|repo(?:sitory)?|row|task|ticket|user|workflow)\b/i;

const ARTIFACT_ACTION =
  /\b(?:attach|capture|create|generate|give|include|make|post|render|send|share|show|screenshot|take|upload)\b/i;
const ARTIFACT_TARGET =
  /\b(?:artifact|document|file|image|report|screenshot|video)\b/i;
const DIRECT_TASK_START =
  /^(?:attach|build|capture|change|create|edit|generate|give|include|make|open|post|prepare|render|run|send|share|show|screenshot|take|test|update|upload|write)\b/i;

const READ_ONLY_MCP_VERBS = new Set([
  'browse',
  'check',
  'describe',
  'fetch',
  'find',
  'get',
  'inspect',
  'list',
  'lookup',
  'query',
  'read',
  'resolve',
  'retrieve',
  'search',
  'show',
  'status',
  'view',
]);

const WRITE_CAPABLE_MCP_VERBS = new Set([
  ...INTRINSIC_EXTERNAL_WRITE_VERBS,
  ...TARGETED_EXTERNAL_WRITE_VERBS,
  'archive',
  'execute',
  'mutate',
  'rename',
  'run',
  'write',
]);

/**
 * A terminal app-generated envelope is the only source of admission state.
 * User and memory text precede it, so marker lookalikes in either cannot win
 * the last-marker + exact-end parse below.
 */
export function serializeCurrentRequestEnvelope(
  currentRequest: string,
  memoryInfluenced: boolean,
): string {
  const payload: CurrentRequestEnvelope = {
    schemaVersion: 1,
    memoryInfluenced,
    explicitExternalSideEffectIntent:
      hasExplicitExternalSideEffectIntent(currentRequest),
    explicitArtifactDeliveryIntent:
      hasExplicitArtifactDeliveryIntent(currentRequest),
  };
  return [
    MEMORY_CURRENT_REQUEST_ENVELOPE_START,
    JSON.stringify(payload),
    MEMORY_CURRENT_REQUEST_ENVELOPE_END,
  ].join('\n');
}

export function parseCurrentRequestEnvelope(
  prompt: string,
): CurrentRequestEnvelope | undefined {
  const end = `\n${MEMORY_CURRENT_REQUEST_ENVELOPE_END}`;
  if (!prompt.endsWith(end)) return undefined;
  const startMarker = `${MEMORY_CURRENT_REQUEST_ENVELOPE_START}\n`;
  const start = prompt.lastIndexOf(startMarker, prompt.length - end.length);
  if (start < 0) return undefined;
  const json = prompt.slice(start + startMarker.length, prompt.length - end.length);
  if (json.includes('\n')) return undefined;

  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.memoryInfluenced !== 'boolean' ||
      typeof value.explicitExternalSideEffectIntent !== 'boolean' ||
      typeof value.explicitArtifactDeliveryIntent !== 'boolean' ||
      Object.keys(value).length !== 4
    ) {
      return undefined;
    }
    return {
      schemaVersion: 1,
      memoryInfluenced: value.memoryInfluenced,
      explicitExternalSideEffectIntent: value.explicitExternalSideEffectIntent,
      explicitArtifactDeliveryIntent: value.explicitArtifactDeliveryIntent,
    };
  } catch {
    return undefined;
  }
}

/**
 * Intentionally conservative and model-independent. A write is admitted only
 * when the final Slack request itself is phrased as a direct action request.
 * Quoted, historical, or advisory text is never inspected here.
 */
export function hasExplicitExternalSideEffectIntent(
  currentRequest: string,
): boolean {
  const request = normalizedCurrentRequest(currentRequest);
  if (!request) return false;

  if (/^open\s+(?:(?:a|the)\s+)?(?:pull request|pr)\b/i.test(stripRequestPreamble(request))) {
    return true;
  }

  const verbs = [...INTRINSIC_EXTERNAL_WRITE_VERBS, ...TARGETED_EXTERNAL_WRITE_VERBS]
    .sort((left, right) => right.length - left.length)
    .join('|');
  const direct = new RegExp(
    `^(?:(?:please|kindly)\\s+|(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?|` +
      `i(?:'d| would)?\\s+(?:like|want|need)\\s+you\\s+to\\s+|` +
      `(?:go ahead|proceed)\\s+(?:and\\s+)?)?(${verbs})\\b`,
    'i',
  ).exec(request);
  if (!direct?.[1]) return false;
  if (/^(?:do not|don't|never)\b/i.test(request)) return false;

  const verb = direct[1].toLowerCase();
  return INTRINSIC_EXTERNAL_WRITE_VERBS.has(verb) || EXTERNAL_TARGET.test(request);
}

/**
 * Artifact delivery is scoped separately from generic connector mutation. A
 * task request must name both creation/delivery work and the artifact itself;
 * merely asking to review an existing screenshot does not authorize upload.
 */
export function hasExplicitArtifactDeliveryIntent(
  currentRequest: string,
): boolean {
  const request = normalizedCurrentRequest(currentRequest);
  if (!request || /^(?:do not|don't|never)\b/i.test(request)) return false;
  const task = stripRequestPreamble(request);
  return DIRECT_TASK_START.test(task) && ARTIFACT_ACTION.test(task) && ARTIFACT_TARGET.test(task);
}

export function isReadOnlyMcpToolName(toolName: string): boolean {
  if (!toolName.startsWith('mcp__')) return false;
  const bareName = toolName.slice(toolName.lastIndexOf('__') + 2);
  const tokens = bareName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.some((token) => WRITE_CAPABLE_MCP_VERBS.has(token))) return false;
  return (
    READ_ONLY_MCP_VERBS.has(tokens[0]!) ||
    READ_ONLY_MCP_VERBS.has(tokens[tokens.length - 1]!)
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
    context.agentName === 'slack-thread' &&
    active === undefined
  ) {
    return submissionPolicy.run({}, next);
  }

  if (operation.type === 'tool' && active !== undefined) {
    if (operation.toolName === 'post_artifact') {
      assertCurrentRequestSideEffectAllowed(operation.toolName);
    } else if (
      operation.toolName.startsWith('mcp__') &&
      !isReadOnlyMcpToolName(operation.toolName)
    ) {
      assertCurrentRequestSideEffectAllowed(operation.toolName);
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
    context.agentName !== 'slack-thread'
  ) {
    return;
  }
  const state = submissionPolicy.getStore();
  if (!state) return;
  const policy = envelopeFromMessages(observation.request.input.messages);
  if (policy) state.policy = policy;
}

/**
 * Defense-in-depth seam for external writes performed below a model tool
 * wrapper (connector fetches and artifact delivery). Calls outside a managed
 * Slack submission keep their existing behavior; a managed submission with no
 * observed policy is closed.
 */
export function assertCurrentRequestSideEffectAllowed(action: string): void {
  const state = submissionPolicy.getStore();
  if (state === undefined || state.policy?.memoryInfluenced === false) return;
  if (action === 'post_artifact') {
    if (state.policy?.explicitArtifactDeliveryIntent === true) return;
  } else if (state.policy?.explicitExternalSideEffectIntent === true) {
    return;
  }

  const error = new Error(
    `External side effect "${action}" requires explicit intent in the current Slack request; advisory memory cannot authorize it.`,
  );
  error.name = 'CurrentRequestSideEffectDeniedError';
  throw error;
}

function normalizedCurrentRequest(currentRequest: string): string {
  return currentRequest.replace(/^\s*<@[A-Z0-9]+>\s*/i, '').trim();
}

function stripRequestPreamble(request: string): string {
  return request.replace(
    /^(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?|i(?:'d| would)?\s+(?:like|want|need)\s+you\s+to\s+|(?:go ahead|proceed)\s+(?:and\s+)?)/i,
    '',
  );
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
      const policy = parseCurrentRequestEnvelope(texts[textIndex]!);
      if (policy) return policy;
    }
    // The newest user message is the current submission. Never fall back to an
    // older envelope when the newest one is missing or malformed.
    return undefined;
  }
  return undefined;
}
