import { validateMcpUrl } from '../config/mcp-url.ts';
import { hasCredentialLikeContent, isRecord } from '../security/content-validation.ts';
import {
  neutralizeSlackBroadcastMentions,
  neutralizeSlackMrkdwnHandles,
  SLACK_MENTION_BREAK,
} from '../slack/message-format.ts';
import type {
  ManagedCapabilityDefinition,
  ManagedConnectorDefinition,
  ManagedEffectClass,
} from '../connections/catalog/types.ts';

const ACTIVITY_STATUS_TEXT_LIMIT = 50;

const SEMANTIC_OPERATIONS = [
  'inspect',
  'search',
  'list',
  'get',
  'read',
  'query',
  'create',
  'update',
  'apply',
  'send',
  'delete',
  'run',
  'draft',
  'use',
  'connect',
  'share',
] as const;

type SemanticOperation = typeof SEMANTIC_OPERATIONS[number];

const SEMANTIC_OBJECTS = [
  'account',
  'activities',
  'ad groups',
  'ads',
  'analytics',
  'artifacts',
  'associations',
  'association types',
  'budgets',
  'calls',
  'calendars',
  'campaigns',
  'captions',
  'channels',
  'coaching metrics',
  'comments',
  'companies',
  'connections',
  'contacts',
  'content',
  'customers',
  'data sources',
  'databases',
  'deals',
  'documents',
  'drafts',
  'events',
  'files',
  'interaction stats',
  'keywords',
  'meetings',
  'memory',
  'messages',
  'metadata',
  'notes',
  'owners',
  'pages',
  'pipelines',
  'playlist items',
  'playlists',
  'presentations',
  'profile',
  'properties',
  'quotas',
  'reports',
  'repository results',
  'results',
  'rows',
  'scheduled work',
  'scorecard activity',
  'scorecards',
  'sheets',
  'sitemaps',
  'sites',
  'skill results',
  'spreadsheets',
  'tasks',
  'tests',
  'tickets',
  'trackers',
  'transcripts',
  'URLs',
  'users',
  'values',
  'videos',
  'workspace settings',
  'workspaces',
  'Agent changes',
  'the artifact',
  'the connection',
  'the repository',
  'the request',
  'the response',
] as const;

type SemanticObject = typeof SEMANTIC_OBJECTS[number];

export const SEMANTIC_TARGET_FAMILIES = [
  'managed_connector',
  'custom_connection',
  'skill',
  'repository',
  'memory',
  'scheduled_work',
  'workspace',
  'connection_setup',
  'agent_authoring',
  'artifact',
  'web',
  'response',
  'unknown',
  'internal',
] as const;

export type SemanticTargetFamily = typeof SEMANTIC_TARGET_FAMILIES[number];

export type SemanticActivityPhase =
  | 'thinking'
  | 'working'
  | 'reviewing'
  | 'drafting'
  | 'reassessing';

type SemanticLifecycleRole = 'work' | 'answer_generation' | 'internal_hidden';
type SemanticTrustTier = 'managed_catalog' | 'built_in' | 'customer_configuration' | 'unknown';
type SemanticEffectClass = ManagedEffectClass | 'none';

/**
 * The labels a web or connection-setup tool's own input may supply, each with
 * the only check that admits it. Every other label is catalog copy or an
 * admin-given name.
 */
const WEB_LABELS = {
  web_host: isSafeWebHostLabel,
  web_query: isSafeWebQueryLabel,
} as const satisfies Record<string, (label: string) => boolean>;

type WebLabelKind = keyof typeof WEB_LABELS;
type SemanticLabelKind = 'managed_connector' | 'custom_connection' | 'skill' | WebLabelKind;

interface SemanticLabelReference {
  readonly kind: SemanticLabelKind;
  /** Catalog identity, the configured connection id or skill name, or the web label itself. */
  readonly id: string;
  /**
   * Catalog copy, the name a workspace admin gave the connection or skill, or
   * a web label that passed its check. Validated again before narration.
   */
  readonly label: string;
}

export interface SemanticActivityDescriptor {
  readonly operation: SemanticOperation;
  readonly target: SemanticTargetFamily;
  readonly label?: SemanticLabelReference | undefined;
  readonly object: SemanticObject;
  readonly effect: SemanticEffectClass;
  readonly role: SemanticLifecycleRole;
  readonly trust: SemanticTrustTier;
}

export interface ManagedCapabilitySemanticOverride {
  operation?: SemanticOperation | undefined;
  object?: SemanticObject | undefined;
}

type SemanticLifecycleEvent =
  | { phase: 'started' }
  | { phase: 'settled'; outcome: 'succeeded' | 'failed' | 'ambiguous' };

export interface SemanticInvocationFact {
  readonly toolCallId: string;
  readonly descriptor: SemanticActivityDescriptor;
}

export type ActivityKind =
  | 'preparing'
  | 'checking'
  | 'reading'
  | 'writing'
  | 'updating'
  | 'running'
  | 'waiting'
  | 'finishing';

export interface ActivityStatus {
  /** Present on all production-derived activity; optional only for legacy relays/tests. */
  kind?: ActivityKind;
  action?: string;
  object?: string;
  family?: SemanticTargetFamily;
  phase?: SemanticActivityPhase;
  text: string;
}

export interface TypedActivityStatus extends ActivityStatus {
  kind: ActivityKind;
  action: string;
  object: string;
  family: SemanticTargetFamily;
  phase: SemanticActivityPhase;
}

const OPERATION_SET = new Set<string>(SEMANTIC_OPERATIONS);
const OBJECT_SET = new Set<string>(SEMANTIC_OBJECTS);
const TARGET_FAMILY_SET = new Set<string>(SEMANTIC_TARGET_FAMILIES);

const MANAGED_OBJECTS = {
  account: 'account',
  activities: 'activities',
  ad_groups: 'ad groups',
  ads: 'ads',
  analytics: 'analytics',
  associations: 'associations',
  association_types: 'association types',
  budgets: 'budgets',
  calls: 'calls',
  calendars: 'calendars',
  campaigns: 'campaigns',
  captions: 'captions',
  channels: 'channels',
  coaching: 'coaching metrics',
  comments: 'comments',
  companies: 'companies',
  contacts: 'contacts',
  content: 'content',
  customers: 'customers',
  data_sources: 'data sources',
  databases: 'databases',
  deals: 'deals',
  documents: 'documents',
  drafts: 'drafts',
  events: 'events',
  files: 'files',
  interactions: 'interaction stats',
  keywords: 'keywords',
  meetings: 'meetings',
  messages: 'messages',
  metadata: 'metadata',
  notes: 'notes',
  owners: 'owners',
  pages: 'pages',
  pipelines: 'pipelines',
  playlist_items: 'playlist items',
  playlists: 'playlists',
  presentations: 'presentations',
  profile: 'profile',
  properties: 'properties',
  quotas: 'quotas',
  reports: 'reports',
  rows: 'rows',
  scorecards: 'scorecards',
  search: 'results',
  sheets: 'sheets',
  sitemaps: 'sitemaps',
  sites: 'sites',
  tasks: 'tasks',
  thumbnails: 'videos',
  tickets: 'tickets',
  trackers: 'trackers',
  transcripts: 'transcripts',
  urls: 'URLs',
  users: 'users',
  values: 'values',
  videos: 'videos',
  workspaces: 'workspaces',
} as const satisfies Record<string, SemanticObject>;

const OPERATION_ALIASES: Readonly<Record<string, SemanticOperation>> = {
  inspect: 'inspect',
  search: 'search',
  list: 'list',
  list_replies: 'list',
  get: 'get',
  read: 'read',
  metadata: 'read',
  text: 'read',
  markdown: 'read',
  export_pdf: 'read',
  thumbnail: 'read',
  public: 'search',
  query: 'query',
  report: 'query',
  realtime: 'query',
  pivot: 'query',
  funnel: 'query',
  stats: 'query',
  metrics: 'query',
  activity: 'read',
  create: 'create',
  create_markdown: 'create',
  create_paused: 'create',
  copy_template: 'create',
  upload: 'create',
  update: 'update',
  update_amount: 'update',
  update_properties: 'update',
  update_markdown: 'update',
  update_section_markdown: 'update',
  batch_update: 'update',
  append: 'update',
  append_blocks: 'update',
  insert_text: 'update',
  upsert: 'update',
  add: 'update',
  set: 'update',
  rename: 'update',
  pause: 'update',
  enable: 'apply',
  send: 'send',
  reply: 'send',
  delete: 'delete',
  run: 'run',
};

const GENERIC_DESCRIPTORS = {
  custom_connection: descriptor('inspect', 'custom_connection', 'results', 'read', 'customer_configuration'),
  skill: descriptor('use', 'skill', 'skill results', 'read', 'customer_configuration'),
  repository: descriptor('inspect', 'repository', 'repository results', 'read', 'customer_configuration'),
  memory: descriptor('inspect', 'memory', 'memory', 'read', 'customer_configuration'),
  scheduled_work: descriptor('inspect', 'scheduled_work', 'scheduled work', 'read', 'customer_configuration'),
  workspace: descriptor('inspect', 'workspace', 'workspace settings', 'read', 'built_in'),
  connection_setup: descriptor('connect', 'connection_setup', 'the connection', 'reversible_write', 'built_in'),
  agent_authoring: descriptor('inspect', 'agent_authoring', 'Agent changes', 'read', 'customer_configuration'),
  artifact: descriptor('create', 'artifact', 'the artifact', 'reversible_write', 'built_in'),
  web: descriptor('read', 'web', 'pages', 'read', 'built_in'),
  unknown: unknownSemanticDescriptor(),
} as const satisfies Record<
  Exclude<SemanticTargetFamily, 'managed_connector' | 'response' | 'internal'>,
  SemanticActivityDescriptor
>;

/**
 * Return the closed family descriptor without a name; only
 * `configuredSemanticDescriptor` adds one, from the Agent's configuration.
 */
export function genericSemanticDescriptor(
  family: keyof typeof GENERIC_DESCRIPTORS,
): SemanticActivityDescriptor {
  return { ...GENERIC_DESCRIPTORS[family] };
}

/**
 * Name a custom connection or skill in activity copy. The caller selects the
 * id by exact lookup in the Agent's own configuration; tool input may only
 * pick among those entries, so the label is always the name an admin gave it.
 * A label that fails the copy rules keeps the generic family descriptor.
 */
export function configuredSemanticDescriptor(
  family: 'custom_connection' | 'skill',
  id: string,
  label: string,
): SemanticActivityDescriptor {
  const generic = genericSemanticDescriptor(family);
  if (!isSafeLabelId(id) || !isSafeConfiguredLabel(label)) return generic;
  return { ...generic, label: { kind: family, id, label } };
}

/** Room for a host in `Reading <host>…` and `Testing <host>…`. */
const WEB_HOST_LABEL_LIMIT = ACTIVITY_STATUS_TEXT_LIMIT - 'Reading …'.length;

/**
 * Name the host a web read's input gives. It must be a public https host on
 * the standard port, as the read itself requires; a bare http link becomes
 * https, as the read does. The URL parser lowercases it and spells an
 * international name in punycode. A host too long for the status keeps the
 * rightmost labels that fit. Anything else keeps the generic web read.
 */
export function webPageSemanticDescriptor(url: unknown): SemanticActivityDescriptor {
  return withWebHostLabel(genericSemanticDescriptor('web'), url);
}

/** Name the host a try_connection call sends its one GET to, held to the web read's host check. */
export function connectionTrySemanticDescriptor(host: unknown): SemanticActivityDescriptor {
  return withWebHostLabel(
    genericSemanticDescriptor('connection_setup'),
    typeof host === 'string' && !/[/:?#@\\]/.test(host) ? `https://${host}/` : undefined,
  );
}

function withWebHostLabel(generic: SemanticActivityDescriptor, url: unknown): SemanticActivityDescriptor {
  const parsed = typeof url === 'string' ? URL.parse(url.trim()) : null;
  if (!parsed) return generic;
  if (parsed.protocol === 'http:' && parsed.port === '') parsed.protocol = 'https:';
  const checked = validateMcpUrl(parsed.href);
  if (!checked.ok) return generic;
  const { hostname, port } = new URL(checked.url);
  if (port !== '') return generic;
  const labels = hostname.split('.');
  const host = labels.map((_, start) => labels.slice(start).join('.'))
    .find((suffix) => suffix.includes('.') && suffix.length <= WEB_HOST_LABEL_LIMIT);
  return host && isSafeWebHostLabel(host)
    ? { ...generic, label: { kind: 'web_host', id: host, label: host } }
    : generic;
}

/** Room for a query in `Searching: “<query>”…`. */
const WEB_QUERY_LABEL_LIMIT = ACTIVITY_STATUS_TEXT_LIMIT - 'Searching: “”…'.length;

/**
 * Quote the query a web search's input gives, as plain status text: no
 * control character or mrkdwn, every mention and broadcast inert, nothing
 * credential-shaped, and shortened with "…" to fit the 50-character
 * status. Anything else keeps the generic search.
 */
export function webSearchSemanticDescriptor(query?: unknown): SemanticActivityDescriptor {
  const generic = descriptor('search', 'web', 'results', 'read', 'built_in');
  if (typeof query !== 'string' || hasCredentialLikeContent(query)) return generic;
  const plain = neutralizeSlackMrkdwnHandles(
    neutralizeSlackBroadcastMentions(query)
      .replace(/[\u0000-\u001f\u007f-\u009f|]/g, ' ')
      .replace(/[<>&*_~`“”]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  const label = truncate(plain, WEB_QUERY_LABEL_LIMIT);
  return isSafeWebQueryLabel(label)
    ? { ...generic, label: { kind: 'web_query', id: label, label } }
    : generic;
}

export function unknownSemanticDescriptor(): SemanticActivityDescriptor {
  return descriptor('run', 'unknown', 'the request', 'none', 'unknown');
}

/** Slack presentation components are part of drafting the answer. */
const SLACK_COMPONENT_TOOLS: ReadonlySet<string> = new Set([
  'ask_user', 'offer_actions', 'present_cards', 'present_chart', 'present_details', 'request_form',
]);

export function semanticDescriptorForCoreTool(toolName: string): SemanticActivityDescriptor {
  if (['read_slack_list', 'read_slack_list_item'].includes(toolName)) return descriptor('read', 'workspace', 'tasks', 'read', 'built_in');
  if (toolName === 'read_slack_thread' || toolName === 'read_slack_channel') return descriptor('read', 'workspace', 'messages', 'read', 'built_in');
  if (toolName === 'lookup_slack_user') return descriptor('read', 'workspace', 'users', 'read', 'built_in');
  if (['create_slack_list_item', 'create_slack_task_list'].includes(toolName)) return descriptor('create', 'workspace', 'tasks', 'reversible_write', 'built_in');
  if (toolName === 'update_slack_list_item') return descriptor('update', 'workspace', 'tasks', 'reversible_write', 'built_in');
  if (toolName === 'share_slack_list') return descriptor('share', 'workspace', 'tasks', 'reversible_write', 'built_in');
  if (toolName === 'stream_answer' || toolName === 'present_table' || SLACK_COMPONENT_TOOLS.has(toolName)) {
    return {
      ...descriptor('draft', 'response', 'the response', 'none', 'built_in'),
      role: 'answer_generation',
    };
  }
  if (toolName === 'request_chickpea_handoff') {
    return {
      ...descriptor('share', 'internal', 'the request', 'none', 'built_in'),
      role: 'internal_hidden',
    };
  }
  return unknownSemanticDescriptor();
}

export function managedConnectorSemanticDescriptor(
  connector: ManagedConnectorDefinition,
  capability: ManagedCapabilityDefinition,
): SemanticActivityDescriptor {
  const parts = capability.id.split('.');
  const operationToken = parts.at(-1) ?? '';
  const objectToken = parts.at(-2) ?? '';
  const override = capability.semantic;
  const operation = override?.operation ?? OPERATION_ALIASES[operationToken] ??
    (capability.effect === 'read' ? 'read' : 'update');
  const object = override?.object ?? MANAGED_OBJECTS[objectToken as keyof typeof MANAGED_OBJECTS] ??
    'results';
  return {
    operation,
    target: 'managed_connector',
    label: {
      kind: 'managed_connector',
      id: connector.toolkit,
      label: connector.label,
    },
    object,
    effect: capability.effect,
    role: 'work',
    trust: 'managed_catalog',
  };
}

export function semanticInvocationFact(
  toolCallId: string,
  descriptorValue: SemanticActivityDescriptor,
): SemanticInvocationFact {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(toolCallId)) {
    throw new Error('Semantic activity tool-call identity is invalid');
  }
  if (!isSemanticActivityDescriptor(descriptorValue)) {
    throw new Error('Semantic activity descriptor is invalid');
  }
  const label = descriptorValue.label ? Object.freeze({
    kind: descriptorValue.label.kind,
    id: descriptorValue.label.id,
    label: descriptorValue.label.label,
  }) : undefined;
  const factDescriptor = Object.freeze({
    operation: descriptorValue.operation,
    target: descriptorValue.target,
    ...(label ? { label } : {}),
    object: descriptorValue.object,
    effect: descriptorValue.effect,
    role: descriptorValue.role,
    trust: descriptorValue.trust,
  });
  return Object.freeze({ toolCallId, descriptor: factDescriptor });
}

export function thinkingSemanticActivity(): TypedActivityStatus {
  return canonicalActivityStatus(
    'preparing',
    'Thinking',
    'the request',
    'Thinking…',
    'unknown',
    'thinking',
  );
}

export function narrateSemanticActivity(
  value: unknown,
  event: SemanticLifecycleEvent,
): TypedActivityStatus | undefined {
  if (!isSemanticActivityDescriptor(value)) {
    return genericActivity(event);
  }
  const descriptorValue = value;
  if (descriptorValue.role === 'internal_hidden') return undefined;
  if (descriptorValue.role === 'answer_generation') {
    return event.phase === 'started'
      ? activityStatus('writing', 'Drafting', 'the response', 'response', 'drafting')
      : undefined;
  }
  if (event.phase === 'settled' && event.outcome !== 'succeeded') {
    return activityStatus(
      'preparing',
      'Reassessing',
      'the request',
      'unknown',
      'reassessing',
    );
  }
  if (descriptorValue.target === 'unknown') return genericActivity(event);
  const phase = event.phase === 'settled' ? 'reviewing' : 'working';
  if (descriptorValue.target === 'managed_connector') {
    return withSemanticFact(
      managedActivity(descriptorValue, event),
      descriptorValue.target,
      phase,
    );
  }
  return withSemanticFact(
    familyActivity(descriptorValue, event),
    descriptorValue.target,
    phase,
  );
}

export function isManagedCapabilitySemanticOverride(
  value: unknown,
): value is ManagedCapabilitySemanticOverride {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => key !== 'operation' && key !== 'object')) return false;
  return (value.operation === undefined || isSemanticOperation(value.operation)) &&
    (value.object === undefined || isSemanticObject(value.object));
}

export function isSemanticActivityDescriptor(value: unknown): value is SemanticActivityDescriptor {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ['operation', 'target', 'label', 'object', 'effect', 'role', 'trust'])) {
    return false;
  }
  if (!isSemanticOperation(value.operation) || !isSemanticTargetFamily(value.target) ||
      !isSemanticObject(value.object) || !isEffect(value.effect) ||
      !isLifecycleRole(value.role) || !isTrustTier(value.trust)) return false;
  if (value.label === undefined) return value.target !== 'managed_connector';
  if (!isRecord(value.label) || !hasOnlyKeys(value.label, ['kind', 'id', 'label'])) return false;
  const { kind, id, label } = value.label;
  if (typeof id !== 'string' || typeof label !== 'string') return false;
  if (value.target === 'managed_connector') {
    return value.trust === 'managed_catalog' && kind === 'managed_connector' &&
      /^[a-z0-9][a-z0-9_.-]{0,191}$/.test(id) && isSafeManagedLabel(label);
  }
  if (value.target === 'custom_connection' || value.target === 'skill') {
    return value.trust === 'customer_configuration' && kind === value.target &&
      isSafeLabelId(id) && isSafeConfiguredLabel(label);
  }
  if (value.target === 'web' || value.target === 'connection_setup') {
    return value.trust === 'built_in' && typeof kind === 'string' && Object.hasOwn(WEB_LABELS, kind) &&
      id === label && WEB_LABELS[kind as WebLabelKind](label);
  }
  return false;
}

/** Accept only canonical structured copy before crossing the activity wire. */
export function isSafeTypedActivityStatus(value: unknown): value is TypedActivityStatus {
  if (!isRecord(value) ||
      !hasOnlyKeys(value, ['kind', 'action', 'object', 'family', 'phase', 'text']) ||
      !isActivityKind(value.kind) ||
      typeof value.action !== 'string' || typeof value.object !== 'string' ||
      !isSemanticTargetFamily(value.family) || !isSemanticActivityPhase(value.phase) ||
      typeof value.text !== 'string' || value.text.length > ACTIVITY_STATUS_TEXT_LIMIT) return false;
  if (value.action === 'Thinking' && value.object === 'the request') {
    return value.kind === 'preparing' && value.family === 'unknown' &&
      value.phase === 'thinking' && value.text === 'Thinking…';
  }
  return activityStatus(
    value.kind,
    value.action,
    value.object,
    value.family,
    value.phase,
  ).text === value.text;
}

/**
 * Whether an observed activity is real progress for a run's quiet clock
 * (docs/runbooks/semantic-activity-status.md): a tool starting or settling
 * and a coding worker's stage are; a model attempt's `Thinking…` is not, so a
 * long stretch of thinking without tools reads as no progress.
 */
export function activityShowsProgress(status: ActivityStatus): boolean {
  return status.phase !== 'thinking';
}

export function activityStatus(
  kind: ActivityKind,
  action: string,
  object: string,
  family: SemanticTargetFamily = 'unknown',
  phase: SemanticActivityPhase = defaultSemanticPhase(action),
): TypedActivityStatus {
  const safeAction = safeActivityLabel(action) || 'Working on';
  const candidateObject = safeActivityLabel(object);
  const safeObject = hasCredentialLikeContent(candidateObject)
    ? 'the current item'
    : candidateObject || 'the request';
  if (
    kind === 'preparing' &&
    safeAction === 'Thinking' &&
    safeObject === 'the request' &&
    family === 'unknown' &&
    phase === 'thinking'
  ) {
    return thinkingSemanticActivity();
  }
  const maxObjectLength = Math.max(1, ACTIVITY_STATUS_TEXT_LIMIT - safeAction.length - 2);
  const boundedObject = truncate(safeObject, maxObjectLength);
  return canonicalActivityStatus(
    kind,
    safeAction,
    boundedObject,
    `${safeAction} ${boundedObject}…`,
    family,
    phase,
  );
}

function withSemanticFact(
  status: TypedActivityStatus,
  family: SemanticTargetFamily,
  phase: SemanticActivityPhase,
): TypedActivityStatus {
  return { ...status, family, phase };
}

function defaultSemanticPhase(action: string): SemanticActivityPhase {
  if (action === 'Thinking') return 'thinking';
  if (action === 'Drafting') return 'drafting';
  if (action === 'Reviewing') return 'reviewing';
  if (action === 'Reassessing') return 'reassessing';
  return 'working';
}

export function safeActivityLabel(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>&*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || 'connection';
}

function managedActivity(
  descriptorValue: SemanticActivityDescriptor,
  event: SemanticLifecycleEvent,
): TypedActivityStatus {
  const label = descriptorValue.label?.label;
  if (!label || !isSafeManagedLabel(label)) return genericActivity(event);
  if (event.phase === 'settled') {
    const object = managedReviewObject(label, descriptorValue.object);
    return boundedOrGeneric('reading', 'Reviewing', object, event);
  }
  if (descriptorValue.effect === 'read') {
    return boundedOrGeneric('checking', 'Checking', label, event);
  }
  if (descriptorValue.operation === 'send') {
    return boundedOrGeneric('updating', 'Sending with', label, event);
  }
  return boundedOrGeneric(
    'updating',
    'Updating',
    `${descriptorValue.object} in ${label}`,
    event,
  );
}

function familyActivity(
  descriptorValue: SemanticActivityDescriptor,
  event: SemanticLifecycleEvent,
): TypedActivityStatus {
  const settled = event.phase === 'settled';
  switch (descriptorValue.target) {
    case 'custom_connection': {
      // Fit the name against the longer settled copy so it never drops out
      // between start and review.
      const label = fittingLabel(descriptorValue, (name) => `Reviewing ${name} results…`);
      if (settled) {
        return activityStatus('reading', 'Reviewing', label ? `${label} results` : 'the results');
      }
      const read = descriptorValue.effect === 'read';
      return activityStatus(
        read ? 'checking' : 'updating',
        read ? 'Checking' : 'Updating',
        label ?? 'a connected service',
      );
    }
    case 'skill': {
      // Loading a skill is quick; afterwards the model works from its
      // instructions, which is what the settled copy says.
      const label = fittingLabel(descriptorValue, (name) => `Following the ${name} skill…`);
      if (settled) {
        return label
          ? activityStatus('reading', 'Following', `the ${label} skill`)
          : activityStatus('reading', 'Reviewing', 'skill results');
      }
      return activityStatus('running', 'Using', label ? `the ${label} skill` : 'a skill');
    }
    case 'repository':
      if (settled) {
        const object = descriptorValue.operation === 'run'
          ? 'test results'
          : descriptorValue.effect === 'read' ? 'repository results' : 'file changes';
        return activityStatus('reading', 'Reviewing', object);
      }
      if (descriptorValue.operation === 'run') return activityStatus('running', 'Running', 'tests');
      if (descriptorValue.effect !== 'read') return activityStatus('updating', 'Editing', 'files');
      return activityStatus('checking', 'Inspecting', 'the repository');
    case 'memory':
      return settled
        ? activityStatus('reading', 'Reviewing', 'memory')
        : activityStatus(
            descriptorValue.effect === 'read' ? 'checking' : 'updating',
            descriptorValue.effect === 'read' ? 'Checking' : 'Updating',
            'memory',
          );
    case 'scheduled_work':
      return settled
        ? activityStatus('reading', 'Reviewing', 'scheduled work')
        : activityStatus(
            descriptorValue.effect === 'read' ? 'checking' : 'updating',
            descriptorValue.effect === 'read' ? 'Checking' : 'Updating',
            'scheduled work',
          );
    case 'workspace':
      return settled
        ? activityStatus('reading', 'Reviewing', 'workspace settings')
        : activityStatus('checking', 'Inspecting', 'workspace settings');
    case 'connection_setup': {
      if (settled) return activityStatus('checking', 'Checking', 'the connection');
      const host = descriptorValue.label?.kind === 'web_host' ? descriptorValue.label.label : undefined;
      return host
        ? activityStatus('checking', 'Testing', host)
        : activityStatus('updating', 'Setting up', 'a connection');
    }
    case 'agent_authoring':
      if (settled) return activityStatus('reading', 'Reviewing', 'Agent changes');
      if (descriptorValue.operation === 'draft') {
        return activityStatus('writing', 'Preparing', 'Agent changes');
      }
      if (descriptorValue.operation === 'apply' || descriptorValue.effect !== 'read') {
        return activityStatus('updating', 'Applying', 'Agent changes');
      }
      return activityStatus('checking', 'Inspecting', 'Agent settings');
    case 'artifact':
      return settled
        ? activityStatus('reading', 'Reviewing', 'the artifact')
        : activityStatus('writing', 'Creating', 'an artifact');
    case 'web': {
      if (descriptorValue.operation === 'search') {
        if (settled) return activityStatus('reading', 'Reviewing', 'the results');
        const query = descriptorValue.label?.kind === 'web_query' ? descriptorValue.label.label : undefined;
        return query
          ? activityStatus('reading', 'Searching:', `“${query}”`)
          : activityStatus('reading', 'Searching', 'the web');
      }
      if (settled) return activityStatus('reading', 'Reviewing', 'the page');
      const host = descriptorValue.label?.kind === 'web_host' ? descriptorValue.label.label : undefined;
      return activityStatus('reading', 'Reading', host ?? 'a web page');
    }
    default:
      return genericActivity(event);
  }
}

function genericActivity(event: SemanticLifecycleEvent): TypedActivityStatus {
  return event.phase === 'started'
    ? activityStatus('running', 'Working on', 'the request')
    : event.outcome === 'succeeded'
      ? activityStatus('reading', 'Reviewing', 'the results')
      : activityStatus('preparing', 'Reassessing', 'the request');
}

/** The configured name when it belongs to this family and fits the longest copy. */
function fittingLabel(
  descriptorValue: SemanticActivityDescriptor,
  longestCopy: (label: string) => string,
): string | undefined {
  const label = descriptorValue.label;
  if (label?.kind !== descriptorValue.target || !isSafeConfiguredLabel(label.label)) return undefined;
  return longestCopy(label.label).length <= ACTIVITY_STATUS_TEXT_LIMIT ? label.label : undefined;
}

function boundedOrGeneric(
  kind: ActivityKind,
  action: string,
  object: string,
  event: SemanticLifecycleEvent,
): TypedActivityStatus {
  if (`${action} ${object}…`.length > ACTIVITY_STATUS_TEXT_LIMIT) return genericActivity(event);
  return activityStatus(kind, action, object);
}

function managedReviewObject(label: string, object: SemanticObject): string {
  const normalizedLabel = label.toLowerCase();
  const normalizedObject = object.toLowerCase();
  const stem = normalizedObject.endsWith('s') ? normalizedObject.slice(0, -1) : normalizedObject;
  return normalizedLabel.includes(stem) ? label : `${label} ${object}`;
}

function isSafeManagedLabel(value: string): boolean {
  return value.length <= 40 && /^[A-Za-z0-9][A-Za-z0-9 .+/-]*$/.test(value) &&
    !hasCredentialLikeContent(value);
}

/**
 * Admin-authored names: letters and digits in any script plus light
 * punctuation, short enough for a status line, and never credential-shaped.
 */
export function isSafeConfiguredLabel(value: string): boolean {
  return value.length <= 32 && value.trim() === value &&
    /^[\p{L}\p{N}][\p{L}\p{N} .'’+/-]*$/u.test(value) && !/\s{2}/.test(value) &&
    !hasCredentialLikeContent(value);
}

/**
 * A lowercase ASCII host of two or more letter-digit-hyphen labels, so it can
 * carry no mention, broadcast, mrkdwn or control character, short enough for
 * `Reading <host>…`, and never credential-shaped.
 */
function isSafeWebHostLabel(value: string): boolean {
  return value.length <= WEB_HOST_LABEL_LIMIT &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(value) &&
    !hasCredentialLikeContent(value);
}

/**
 * Status text a search query became: short enough for
 * `Searching: “<query>”…`, single-spaced, with no control character, mrkdwn
 * or quote mark, every `@` followed by the mention break, and never
 * credential-shaped.
 */
function isSafeWebQueryLabel(value: string): boolean {
  return value.length > 0 && value.length <= WEB_QUERY_LABEL_LIMIT && value.trim() === value &&
    !/\s{2}/.test(value) && !/[\u0000-\u001f\u007f-\u009f<>&*_~`|“”]/.test(value) &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value) &&
    [...value.matchAll(/@/g)].every(({ index }) => value[index + 1] === SLACK_MENTION_BREAK) &&
    !hasCredentialLikeContent(value);
}

function isSafeLabelId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/.test(value);
}

function descriptor(
  operation: SemanticOperation,
  target: SemanticTargetFamily,
  object: SemanticObject,
  effect: SemanticEffectClass,
  trust: SemanticTrustTier,
): SemanticActivityDescriptor {
  return { operation, target, object, effect, role: 'work', trust };
}

function canonicalActivityStatus(
  kind: ActivityKind,
  action: string,
  object: string,
  text: string,
  family: SemanticTargetFamily,
  phase: SemanticActivityPhase,
): TypedActivityStatus {
  return { kind, action, object, family, phase, text };
}

function isSemanticOperation(value: unknown): value is SemanticOperation {
  return typeof value === 'string' && OPERATION_SET.has(value);
}

function isSemanticObject(value: unknown): value is SemanticObject {
  return typeof value === 'string' && OBJECT_SET.has(value);
}

export function isSemanticTargetFamily(value: unknown): value is SemanticTargetFamily {
  return typeof value === 'string' && TARGET_FAMILY_SET.has(value);
}

function isSemanticActivityPhase(value: unknown): value is SemanticActivityPhase {
  return value === 'thinking' || value === 'working' || value === 'reviewing' ||
    value === 'drafting' || value === 'reassessing';
}

function isEffect(value: unknown): value is SemanticEffectClass {
  return value === 'read' || value === 'reversible_write' || value === 'external_publish' ||
    value === 'spend_or_budget' || value === 'destructive' ||
    value === 'administrative' || value === 'none';
}

function isLifecycleRole(value: unknown): value is SemanticLifecycleRole {
  return value === 'work' || value === 'answer_generation' || value === 'internal_hidden';
}

function isTrustTier(value: unknown): value is SemanticTrustTier {
  return value === 'managed_catalog' || value === 'built_in' ||
    value === 'customer_configuration' || value === 'unknown';
}

function isActivityKind(value: unknown): value is ActivityKind {
  return value === 'preparing' || value === 'checking' || value === 'reading' ||
    value === 'writing' || value === 'updating' || value === 'running' ||
    value === 'waiting' || value === 'finishing';
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  // The cut is in UTF-16 units; a high surrogate it leaves behind is not text.
  return `${value.slice(0, Math.max(1, maxLength - 1)).replace(/[\uD800-\uDBFF]$/, '').trimEnd()}…`;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}
