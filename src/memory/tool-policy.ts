import { AsyncLocalStorage } from 'node:async_hooks';

import type {
  FlueEventContext,
  FlueExecutionInterceptor,
  FlueObservation,
  LlmMessage,
} from '@flue/runtime';

import {
  MANAGED_SUBMISSION_AGENT_NAMES,
  UNATTENDED_AGENT_NAMES,
} from '../agents/names.ts';
import { MANAGED_CONNECTOR_CATALOG } from '../connections/catalog/index.ts';

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
  explicitExternalSideEffectIntent: boolean;
  /** Exact host-derived clauses that may authorize a matching effect family and target. */
  externalSideEffectIntents: string[];
  /** Exact repo-owned managed capability IDs selected from current-request text. */
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
  requireExplicitEffectIntent?: boolean;
  /** A semantic tool boundary already matched the current request. */
  nestedEffectAuthorized?: boolean;
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
  'acknowledge',
  'add',
  'append',
  'approve',
  'archive',
  'associate',
  'assign',
  'ban',
  'cancel',
  'change',
  'charge',
  'close',
  'commit',
  'copy',
  'create',
  'delete',
  'deploy',
  'destroy',
  'disable',
  'draft',
  'edit',
  'enable',
  'encrypt',
  'execute',
  'grant',
  'import',
  'insert',
  'install',
  'lock',
  'merge',
  'mark',
  'modify',
  'move',
  'mutate',
  'open',
  'pause',
  'pin',
  'purge',
  'react',
  'reject',
  'remove',
  'rename',
  'replace',
  'reopen',
  'reply',
  'refund',
  'register',
  'reset',
  'restore',
  'resume',
  'rotate',
  'run',
  'save',
  'schedule',
  'set',
  'start',
  'stop',
  'subscribe',
  'transfer',
  'trigger',
  'unlock',
  'unsubscribe',
  'update',
  'upsert',
  'vote',
  'write',
]);

const EXTERNAL_WRITE_VERB_PATTERN = [
  ...INTRINSIC_EXTERNAL_WRITE_VERBS,
  ...TARGETED_EXTERNAL_WRITE_VERBS,
].sort((left, right) => right.length - left.length).join('|');

const EXTERNAL_TARGET_PATTERN =
  'accounts?|ads?|associations?|branch(?:es)?|budgets?|calendars?|campaigns?|cards?|comments?|compan(?:y|ies)|contacts?|deals?|deployments?|documents?|emails?|events?|files?|folders?|issues?|items?|jobs?|keywords?|meetings?|members?|messages?|notes?|orders?|pages?|payments?|playlists?|presentations?|projects?|prs?|pull requests?|records?|repos?|repositor(?:y|ies)|rows?|sheets?|slides?|spreadsheets?|tasks?|templates?|thumbnails?|tickets?|trackers?|users?|videos?|workflows?';
const EXTERNAL_TARGET = new RegExp(`\\b(?:${EXTERNAL_TARGET_PATTERN})\\b`, 'i');

const ARTIFACT_ACTION_PATTERN =
  'attach|capture|create|generate|give|include|make|post|render|send|share|show|screenshot|take|upload';
const ARTIFACT_TARGET_PATTERN =
  'artifact|document|file|image|report|screenshot|video';
const ARTIFACT_ACTION = new RegExp(`\\b(?:${ARTIFACT_ACTION_PATTERN})\\b`, 'i');
const ARTIFACT_TARGET = new RegExp(`\\b(?:${ARTIFACT_TARGET_PATTERN})\\b`, 'i');
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
  'acknowledge',
  'ban',
  'charge',
  'commit',
  'destroy',
  'encrypt',
  'archive',
  'execute',
  'grant',
  'import',
  'install',
  'lock',
  'mutate',
  'pin',
  'purge',
  'react',
  'refund',
  'register',
  'rename',
  'reset',
  'restore',
  'rotate',
  'run',
  'schedule',
  'subscribe',
  'transfer',
  'unlock',
  'unsubscribe',
  'upsert',
  'vote',
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
  slackActorId?: string,
  slackMessageTs?: string,
  options: {
    schemaVersion?: 1 | 2;
    progressiveStreamingOffered?: boolean;
  } = {},
): string {
  const externalSideEffectIntents = explicitExternalSideEffectIntents(currentRequest);
  const managedCapabilityIntents = explicitManagedCapabilityIntents(currentRequest);
  const shared: CurrentRequestEnvelopeBase = {
    memoryInfluenced,
    explicitExternalSideEffectIntent: externalSideEffectIntents.length > 0,
    externalSideEffectIntents,
    managedCapabilityIntents,
    explicitArtifactDeliveryIntent:
      hasExplicitArtifactDeliveryIntent(currentRequest),
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
 * Intentionally conservative and model-independent. A write is admitted only
 * when the final Slack request itself is phrased as a direct action request.
 * Quoted, historical, or advisory text is never inspected here.
 */
export function hasExplicitExternalSideEffectIntent(
  currentRequest: string,
): boolean {
  return explicitExternalSideEffectIntents(currentRequest).length > 0;
}

function explicitExternalSideEffectIntents(currentRequest: string): string[] {
  const request = normalizedCurrentRequest(currentRequest);
  if (!request) return [];
  return explicitActionClauses(request)
    .filter(clauseHasExplicitExternalSideEffectIntent)
    .slice(0, 8)
    .map((clause) => clause.slice(0, 500));
}

function explicitManagedCapabilityIntents(currentRequest: string): string[] {
  const request = normalizedCurrentRequest(currentRequest);
  if (!request) return [];
  const writes = MANAGED_CONNECTOR_CATALOG.list().flatMap((connector) =>
    connector.capabilities.filter((capability) =>
      capability.effect !== 'read' && capability.sideEffectLabel
    )
  );
  const selected = new Set<string>();
  for (const clause of explicitActionClauses(request)) {
    if (!clauseHasExplicitExternalSideEffectIntent(clause)) continue;
    const clauseVerb = directExternalWriteVerb(clause);
    if (!clauseVerb) continue;
    const clauseTokens = new Set(managedCapabilityMatchTokens(clause));
    const matches = writes.flatMap((capability) => {
      const label = capability.sideEffectLabel!;
      const labelVerb = directExternalWriteVerb(label);
      if (!labelVerb || effectVerbFamily(labelVerb) !== effectVerbFamily(clauseVerb)) return [];
      const labelTokens = managedCapabilityMatchTokens(label);
      return labelTokens.every((token) => clauseTokens.has(token))
        ? [{ capabilityId: capability.id, specificity: labelTokens.length }]
        : [];
    });
    const highestSpecificity = Math.max(0, ...matches.map(({ specificity }) => specificity));
    const best = matches.filter(({ specificity }) => specificity === highestSpecificity);
    if (best.length === 1) selected.add(best[0]!.capabilityId);
    if (selected.size >= 8) break;
  }
  return [...selected];
}

const MANAGED_CAPABILITY_LABEL_STOP_WORDS = new Set([
  'a', 'an', 'and', 'its', 'may', 'one', 'or', 'specified', 'that', 'the', 'to',
  'with',
]);

function managedCapabilityMatchTokens(value: string): string[] {
  return [...new Set(
    semanticEffectTokens(value)
      .filter((token) => !MANAGED_CAPABILITY_LABEL_STOP_WORDS.has(token))
      .map(effectTargetAlias),
  )];
}

function clauseHasExplicitExternalSideEffectIntent(request: string): boolean {
  if (!request) return false;
  if (isNegatedActionClause(request)) return false;

  const verb = directExternalWriteVerb(request);
  if (!verb) return false;
  if (
    ['attach', 'post', 'send', 'share', 'upload'].includes(verb) &&
    ARTIFACT_TARGET.test(request) &&
    !/\b(?:account|branch|calendar|card|comment|deployment|event|folder|issue|item|job|meeting|member|message|order|payment|project|pull request|record|repo(?:sitory)?|row|task|ticket|tracker|user|workflow)\b/i.test(request) &&
    // A service-qualified media upload is an external connector action, not
    // merely a request to return an artifact in Slack.
    !/\byoutube\b/i.test(request)
  ) {
    return false;
  }
  return INTRINSIC_EXTERNAL_WRITE_VERBS.has(verb) || EXTERNAL_TARGET.test(request);
}

function directExternalWriteVerb(request: string): string | undefined {
  const task = stripRequestPreamble(request);
  if (/^open\s+(?:(?:a|the)\s+)?(?:pull request|pr)\b/i.test(task)) return 'open';
  return new RegExp(`^(${EXTERNAL_WRITE_VERB_PATTERN})\\b`, 'i')
    .exec(task)?.[1]?.toLowerCase();
}

function explicitActionClauses(request: string): string[] {
  return request
    // A full stop or semicolon starts a fresh directive. Coordinating
    // conjunctions do not: a leading negation scopes over every coordinated
    // action in that sentence ("do not send ... and delete ...").
    .split(/[.;]\s*/)
    .flatMap((sentence) => {
      const clauses = sentence
        .split(new RegExp(
          `(?:,\\s+and\\s+|\\b(?:and then|then)\\b|` +
            `\\s+\\band\\b\\s+(?=(?:please\\s+)?(?:${EXTERNAL_WRITE_VERB_PATTERN})\\b))`,
          'i',
        ))
        .map((clause) => clause.trim())
        .filter(Boolean);
      if (!isNegatedActionClause(clauses[0] ?? '')) return clauses;
      return clauses.map((clause, index) =>
        index === 0 || isNegatedActionClause(clause) ? clause : `do not ${clause}`
      );
    });
}

function isNegatedActionClause(clause: string): boolean {
  const normalized = clause.replace(/^(?:please|kindly)\s+/i, '');
  return /^(?:do\s+not|don't|never|refrain\s+from|avoid)\b/i.test(normalized) ||
    /^(?:i\s+)?(?:do\s+not|don't)\s+(?:want|need)\s+you\s+to\b/i.test(normalized);
}

/**
 * Artifact delivery is scoped separately from generic connector mutation. A
 * task request must name both creation/delivery work and the artifact itself;
 * merely asking to review an existing screenshot does not authorize upload.
 */
function hasExplicitArtifactDeliveryIntent(
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
  // A read-looking suffix cannot bless an arbitrary leading action, and a
  // compound name can conceal a second mutation after a benign first verb.
  // Unknown/custom MCP shapes therefore enter the effect gate unless their
  // declared operation starts with one unambiguous read verb.
  if (tokens.includes('and') || tokens.includes('then')) return false;
  return READ_ONLY_MCP_VERBS.has(tokens[0]!);
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
    return submissionPolicy.run(
      { requireExplicitEffectIntent: isUnattendedAgent(context.agentName) },
      next,
    );
  }

  if (operation.type === 'tool' && active !== undefined) {
    if (operation.toolName === 'post_artifact') {
      return withCurrentRequestSideEffectAuthorization(operation.toolName, next);
    } else if (
      operation.toolName.startsWith('mcp__') &&
      !isReadOnlyMcpToolName(operation.toolName)
    ) {
      return withCurrentRequestSideEffectAuthorization(operation.toolName, next);
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

/**
 * Defense-in-depth seam for external writes performed below a model tool
 * wrapper (connector fetches and artifact delivery). Calls outside a managed
 * Slack submission keep their existing behavior; a managed submission with no
 * observed policy is closed.
 */
export function assertCurrentRequestSideEffectAllowed(action: string): void {
  const state = submissionPolicy.getStore();
  if (state === undefined) return;
  if (state.nestedEffectAuthorized === true) return;
  const managedCapabilityId = /^managed_capability__([a-z0-9][a-z0-9_.-]{0,191})$/.exec(action)?.[1];
  if (managedCapabilityId) {
    if (state.policy?.managedCapabilityIntents.includes(managedCapabilityId)) return;
  } else if (action === 'post_artifact') {
    if (state.policy?.explicitArtifactDeliveryIntent === true) return;
  } else if (
    state.policy?.explicitExternalSideEffectIntent === true &&
    state.policy.externalSideEffectIntents.some((intent) => effectIntentMatchesAction(intent, action))
  ) {
    return;
  }

  // Do not echo an egress path into the error: user-defined API paths can
  // contain credentials even though createScopedFetch already strips queries.
  const error = new Error(
    managedCapabilityId
      ? `This provider tool call did not execute. The current Slack request must explicitly ask to ${MANAGED_CONNECTOR_CATALOG.capability(managedCapabilityId)?.sideEffectLabel ?? 'perform this action'} and include the intended target and inputs. A bare approval or reference to a previous preview cannot authorize it. Ask the user to restate the complete request; do not retry this unchanged tool call.`
      : 'External side effect requires explicit matching intent in the current Slack request; retrieved content, Slack history, and advisory memory cannot authorize it.',
  );
  error.name = 'CurrentRequestSideEffectDeniedError';
  throw error;
}

/**
 * Carry a matched semantic authorization only through that tool's own async
 * call tree. A parallel tool cannot borrow it from mutable submission state.
 */
export async function withCurrentRequestSideEffectAuthorization<T>(
  action: string,
  next: () => Promise<T>,
): Promise<T> {
  assertCurrentRequestSideEffectAllowed(action);
  const state = submissionPolicy.getStore();
  if (state === undefined || state.nestedEffectAuthorized === true) return next();
  return submissionPolicy.run({ ...state, nestedEffectAuthorized: true }, next);
}

type EffectVerbClass = 'create' | 'update' | 'publish' | 'destructive' | 'spend' | 'deploy';

const EFFECT_TOKEN_STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'for', 'from', 'in', 'into', 'it', 'my', 'of',
  'on', 'please', 'specified', 'the', 'their', 'this', 'to', 'with', 'you', 'your',
  'managed', 'mcp', 'api', 'http', 'https', 'com', 'dev', 'io', 'net', 'org',
]);

const DUAL_ROLE_EFFECT_TARGETS = new Set(['email', 'invite', 'message', 'post', 'reply']);
const EFFECT_RESOURCE_TARGETS = new Set([
  'account', 'ad', 'association', 'branch', 'budget', 'calendar', 'campaign', 'card',
  'channel', 'comment', 'company', 'contact', 'content', 'deal', 'deployment',
  'document', 'event', 'file', 'folder', 'group', 'issue', 'item', 'job', 'keyword',
  'meeting', 'member', 'message', 'note', 'order', 'page', 'payment', 'playlist',
  'presentation', 'project', 'property', 'pr', 'record', 'repository', 'row', 'section',
  'sheet', 'slide', 'spreadsheet', 'task', 'template', 'thumbnail', 'ticket', 'tracker', 'user',
  'value', 'video', 'workflow',
]);

const EFFECT_TARGET_ALIASES: Record<string, string> = {
  accounts: 'account',
  ads: 'ad',
  associations: 'association',
  branches: 'branch',
  budgets: 'budget',
  calendars: 'calendar',
  campaigns: 'campaign',
  cards: 'card',
  channels: 'channel',
  chat: 'message',
  comments: 'comment',
  companies: 'company',
  contents: 'content',
  contacts: 'contact',
  conversation: 'channel',
  conversations: 'channel',
  deployments: 'deployment',
  documents: 'document',
  deals: 'deal',
  email: 'message',
  emails: 'message',
  events: 'event',
  files: 'file',
  folders: 'folder',
  groups: 'group',
  gmail: 'message',
  issues: 'issue',
  items: 'item',
  jobs: 'job',
  keywords: 'keyword',
  mail: 'message',
  mails: 'message',
  meetings: 'meeting',
  members: 'member',
  messages: 'message',
  notes: 'note',
  orders: 'order',
  pages: 'page',
  payments: 'payment',
  playlists: 'playlist',
  presentations: 'presentation',
  projects: 'project',
  properties: 'property',
  pull: 'pr',
  pulls: 'pr',
  records: 'record',
  repositories: 'repository',
  repo: 'repository',
  repos: 'repository',
  rows: 'row',
  sections: 'section',
  sheets: 'sheet',
  slides: 'slide',
  spreadsheets: 'spreadsheet',
  tasks: 'task',
  tickets: 'ticket',
  trackers: 'tracker',
  templates: 'template',
  thumbnails: 'thumbnail',
  users: 'user',
  videos: 'video',
  values: 'value',
  workflows: 'workflow',
  prs: 'pr',
  pullrequest: 'pr',
  pullrequests: 'pr',
};

interface RawHttpEffectAction {
  method: string;
  methodVerb: string;
  pathTokens: string[];
  pathVerb?: string;
  destination: Set<string>;
  rawDestinationTokens: string[];
}

interface EffectActionAnalysis {
  verb?: string;
  targets: Set<string>;
  destination: Set<string>;
  terms: Set<string>;
  rawTargetTokens: string[];
  rawDestinationTokens: string[];
}

function effectIntentMatchesAction(intent: string, action: string): boolean {
  const intentVerb = directExternalWriteVerb(intent);
  const actionAnalysis = analyzeEffectAction(action);
  if (!intentVerb || !actionAnalysis.verb) return false;
  const intentClass = effectVerbClass(intentVerb);
  if (!intentClass || !actionAllowsEffect(
    action,
    actionAnalysis.verb,
    intentVerb,
    intentClass,
  )) return false;

  const intentAnalysis = analyzeEffectAction(intent, intentVerb);
  if (intentAnalysis.targets.size === 0 || actionAnalysis.targets.size === 0) return false;

  // MCP/custom tool identifiers carry their destination before the action
  // verb. Require the current request to name that destination so an allowed
  // write in one connected service cannot authorize another service's tool.
  const requiresDestination = action.startsWith('mcp__') || action.startsWith('managed__') ||
    /^\s*[a-z]+\s+https?:/i.test(action);
  if (requiresDestination) {
    if (actionAnalysis.destination.size === 0 ||
        !setContainsAll(intentAnalysis.terms, actionAnalysis.destination)) return false;
  }
  const qualifiedIntentTargets = qualifiedIntentTargetCounts(intentAnalysis, actionAnalysis);
  return [...actionAnalysis.targets].every(
    (target) => (qualifiedIntentTargets.get(target) ?? 0) > 0,
  );
}

function analyzeEffectAction(
  text: string,
  knownVerb?: string,
): EffectActionAnalysis {
  const rawHttpAction = analyzeRawHttpEffectAction(text);
  if (rawHttpAction) {
    const verb = rawHttpAction.pathVerb ?? rawHttpAction.methodVerb;
    const targets = new Set<string>();
    const candidateTargetTokens: string[] = [];
    for (const token of rawHttpAction.pathTokens) {
      if (token === rawHttpAction.pathVerb || EFFECT_TOKEN_STOP_WORDS.has(token)) continue;
      if (effectVerbClass(token) !== undefined && !DUAL_ROLE_EFFECT_TARGETS.has(token)) continue;
      const target = effectTargetAlias(token);
      if (EFFECT_RESOURCE_TARGETS.has(target)) candidateTargetTokens.push(token);
    }
    // REST paths include structural parents and identity placeholders that the
    // requester should not have to recite (`/repos/:owner/:repo/issues`,
    // `users/me/messages/send`). The terminal recognized resource is the
    // endpoint's effect target; service identity is checked independently.
    const terminalTargetToken = candidateTargetTokens.at(-1);
    const rawTargetTokens = terminalTargetToken ? [terminalTargetToken] : [];
    if (terminalTargetToken) targets.add(effectTargetAlias(terminalTargetToken));
    return {
      verb,
      targets,
      destination: rawHttpAction.destination,
      terms: new Set([...rawHttpAction.destination, ...targets]),
      rawTargetTokens,
      rawDestinationTokens: rawHttpAction.rawDestinationTokens,
    };
  }

  const tokens = semanticEffectTokens(text);
  let verb = knownVerb;
  let verbIndex = knownVerb ? tokens.indexOf(knownVerb) : -1;
  if (!verb) {
    verbIndex = tokens.findIndex((token) => effectVerbClass(token) !== undefined);
    if (verbIndex >= 0) verb = tokens[verbIndex];
  }
  const targets = new Set<string>();
  const rawTargetTokens: string[] = [];
  tokens.slice(Math.max(0, verbIndex + 1)).forEach((token) => {
    if (EFFECT_TOKEN_STOP_WORDS.has(token)) return;
    if (effectVerbClass(token) !== undefined && !DUAL_ROLE_EFFECT_TARGETS.has(token)) return;
    const target = effectTargetAlias(token);
    if (EFFECT_RESOURCE_TARGETS.has(target)) {
      targets.add(target);
      rawTargetTokens.push(token);
    }
  });
  // A few stable semantic tools encode their resource in the operation itself
  // rather than as a separate name token.
  if (verb === 'react' || verb === 'mark' && tokens.includes('read')) targets.add('message');
  const rawDestinationTokens = tokens.slice(0, Math.max(0, verbIndex))
    .filter(isMeaningfulDestinationToken);
  const destination = new Set(rawDestinationTokens.map(serviceTokenAlias));
  const terms = new Set(
    tokens
      .filter((token) => !EFFECT_TOKEN_STOP_WORDS.has(token))
      .filter((token) => effectVerbClass(token) === undefined || DUAL_ROLE_EFFECT_TARGETS.has(token))
      .flatMap((token) => [serviceTokenAlias(token), effectTargetAlias(token)]),
  );
  return {
    ...(verb ? { verb } : {}),
    targets,
    destination,
    terms,
    rawTargetTokens,
    rawDestinationTokens,
  };
}

/**
 * Service qualifiers occur after the verb in natural language ("create a
 * Google Sheets spreadsheet") but before it in an MCP identifier
 * ("google_sheets__create_sheet"). Remove exactly the qualifier occurrences
 * before comparing resources. Counts preserve the distinction between the
 * provider word and a repeated resource word ("Google Sheets sheet").
 */
function qualifiedIntentTargetCounts(
  intent: EffectActionAnalysis,
  action: EffectActionAnalysis,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of intent.rawTargetTokens) {
    const target = effectTargetAlias(token);
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  const remainingRawTokens = [...intent.rawTargetTokens];
  for (const destinationToken of action.rawDestinationTokens) {
    const index = remainingRawTokens.indexOf(destinationToken);
    if (index < 0) continue;
    remainingRawTokens.splice(index, 1);
    const target = effectTargetAlias(destinationToken);
    if (!EFFECT_RESOURCE_TARGETS.has(target)) continue;
    const next = (counts.get(target) ?? 0) - 1;
    if (next > 0) counts.set(target, next);
    else counts.delete(target);
  }
  return counts;
}

const DESTINATION_TOKEN_STOP_WORDS = new Set([
  ...EFFECT_TOKEN_STOP_WORDS,
  ...READ_ONLY_MCP_VERBS,
  'app', 'cloud', 'co', 'connection', 'example', 'services', 'test', 'then', 'www',
]);

const SERVICE_TOKEN_ALIASES: Record<string, string> = {
  email: 'mail',
  emails: 'mail',
  gmail: 'mail',
  googleads: 'ads',
  googleapis: 'google',
  mails: 'mail',
};

function isMeaningfulDestinationToken(token: string): boolean {
  return !DESTINATION_TOKEN_STOP_WORDS.has(token) && effectVerbClass(token) === undefined &&
    !/^\d+$/.test(token);
}

function serviceTokenAlias(token: string): string {
  return SERVICE_TOKEN_ALIASES[token] ?? token;
}

function actionAllowsEffect(
  action: string,
  actionVerb: string,
  intentVerb: string,
  intentClass: EffectVerbClass,
): boolean {
  const rawHttpAction = analyzeRawHttpEffectAction(action);
  if (rawHttpAction?.pathVerb) {
    return effectVerbFamily(rawHttpAction.pathVerb) === effectVerbFamily(intentVerb);
  }
  const method = rawHttpAction?.method;
  if (method === 'post') {
    return intentClass === 'create' || intentClass === 'update' || intentClass === 'publish';
  }
  if (method === 'put' || method === 'patch') return intentClass === 'update';
  if (method === 'delete') return intentClass === 'destructive';
  return effectVerbFamily(actionVerb) === effectVerbFamily(intentVerb);
}

function analyzeRawHttpEffectAction(text: string): RawHttpEffectAction | undefined {
  const match = /^\s*([a-z]+)\s+(https?:\/\/\S+)\s*$/i.exec(text);
  if (!match?.[1] || !match[2]) return undefined;
  const method = match[1].toLowerCase();
  try {
    const url = new URL(match[2]);
    const pathTokens = semanticEffectTokens(url.pathname);
    const pathVerb = pathTokens.find((token) => effectVerbClass(token) !== undefined);
    let rawDestinationTokens = semanticEffectTokens(url.hostname)
      .filter(isMeaningfulDestinationToken);
    // Product subdomains already identify the Google service. Requiring the
    // infrastructure suffix as a second user-facing provider would make normal
    // prompts such as "send a Gmail message" fail. On the shared
    // www.googleapis.com host, retain `googleapis` as the Google qualifier.
    if (rawDestinationTokens.length > 1 && rawDestinationTokens.includes('googleapis')) {
      rawDestinationTokens = rawDestinationTokens.filter((token) => token !== 'googleapis');
    }
    const destination = new Set(rawDestinationTokens.map(serviceTokenAlias));
    return {
      method,
      methodVerb: method === 'delete'
        ? 'delete'
        : method === 'post'
        ? 'create'
        : method === 'put' || method === 'patch'
        ? 'update'
        : method,
      pathTokens,
      ...(pathVerb ? { pathVerb } : {}),
      destination,
      rawDestinationTokens,
    };
  } catch {
    return undefined;
  }
}

function semanticEffectTokens(text: string): string[] {
  const tokens = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const canonical: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === 'git' && tokens[index + 1] === 'hub') {
      canonical.push('github');
      index += 1;
    } else if (tokens[index] === 'pull' && /^requests?$/.test(tokens[index + 1] ?? '')) {
      canonical.push('pr');
      index += 1;
    } else {
      canonical.push(tokens[index]!);
    }
  }
  return canonical;
}

function effectTargetAlias(token: string): string {
  return EFFECT_TARGET_ALIASES[token] ?? token;
}

function effectVerbClass(verb: string): EffectVerbClass | undefined {
  if (['add', 'commit', 'copy', 'create', 'draft', 'execute', 'import', 'install',
    'open', 'register', 'run', 'schedule', 'start', 'subscribe', 'trigger', 'write'].includes(verb)) {
    return 'create';
  }
  if (['acknowledge', 'append', 'approve', 'associate', 'assign', 'change', 'edit',
    'enable', 'encrypt', 'grant', 'insert', 'lock', 'merge', 'modify', 'mark', 'move',
    'mutate', 'pause', 'pin', 'react', 'rename', 'reopen', 'replace', 'reset', 'restore',
    'resume', 'rotate', 'save', 'set', 'unlock', 'update', 'upsert', 'vote'].includes(verb)) {
    return 'update';
  }
  if (['attach', 'dispatch', 'email', 'invite', 'message', 'notify', 'post', 'publish',
    'reply', 'send', 'share', 'submit', 'upload'].includes(verb)) {
    return 'publish';
  }
  if (['archive', 'ban', 'cancel', 'close', 'delete', 'destroy', 'disable', 'purge',
    'reject', 'remove', 'stop', 'unsubscribe'].includes(verb)) {
    return 'destructive';
  }
  if (['charge', 'pay', 'purchase', 'refund', 'transfer'].includes(verb)) return 'spend';
  if (verb === 'deploy') return 'deploy';
  return undefined;
}

/**
 * Semantic tools and named API routes require the same narrow action family;
 * broad HTTP classes are used only when a REST path contains no action verb.
 */
function effectVerbFamily(verb: string): string | undefined {
  if (!effectVerbClass(verb)) return undefined;
  if (['add', 'create', 'draft', 'open', 'register', 'write'].includes(verb)) return 'create';
  if (['change', 'edit', 'modify', 'mutate', 'replace', 'save', 'set', 'update', 'upsert'].includes(verb)) {
    return 'update';
  }
  if (['append', 'insert'].includes(verb)) return 'append';
  if (['dispatch', 'email', 'message', 'notify', 'post', 'publish', 'reply', 'send'].includes(verb)) {
    return 'publish';
  }
  if (['attach', 'share', 'submit', 'upload'].includes(verb)) return 'share';
  if (['delete', 'destroy', 'purge', 'remove'].includes(verb)) return 'delete';
  if (['cancel', 'stop'].includes(verb)) return 'stop';
  if (['execute', 'run', 'start', 'trigger'].includes(verb)) return 'run';
  if (['charge', 'pay', 'purchase'].includes(verb)) return 'charge';
  // The remaining verbs intentionally stay distinct: update must not authorize
  // enable, pause, rename, merge, refund, transfer, or another adjacent action.
  return verb;
}

function setContainsAll(container: ReadonlySet<string>, required: ReadonlySet<string>): boolean {
  for (const value of required) if (!container.has(value)) return false;
  return true;
}

function isManagedCurrentRequestAgent(agentName: string | undefined): boolean {
  return agentName !== undefined &&
    (MANAGED_SUBMISSION_AGENT_NAMES as readonly string[]).includes(agentName);
}

function isUnattendedAgent(agentName: string | undefined): boolean {
  return agentName !== undefined &&
    (UNATTENDED_AGENT_NAMES as readonly string[]).includes(agentName);
}

function normalizedCurrentRequest(currentRequest: string): string {
  return currentRequest.replace(/^\s*<@[A-Z0-9]+>\s*/i, '').trim();
}

function stripRequestPreamble(request: string): string {
  return request.replace(
    /^(?:(?:please|kindly)\s+|instead,?\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?|i(?:'d| would)?\s+(?:like|want|need)\s+you\s+to\s+|(?:go ahead|proceed)\s+(?:and\s+)?)/i,
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
