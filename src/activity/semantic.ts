import { hasCredentialLikeContent } from '../security/content-validation.ts';
import type {
  ManagedCapabilityDefinition,
  ManagedConnectorDefinition,
  ManagedEffectClass,
} from '../connections/catalog/types.ts';

export const ACTIVITY_STATUS_TEXT_LIMIT = 50;

export const SEMANTIC_OPERATIONS = [
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

export type SemanticOperation = typeof SEMANTIC_OPERATIONS[number];

export const SEMANTIC_OBJECTS = [
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

export type SemanticObject = typeof SEMANTIC_OBJECTS[number];

export type SemanticTargetFamily =
  | 'managed_connector'
  | 'custom_connection'
  | 'skill'
  | 'repository'
  | 'memory'
  | 'scheduled_work'
  | 'workspace'
  | 'connection_setup'
  | 'agent_authoring'
  | 'artifact'
  | 'response'
  | 'unknown'
  | 'internal';

export type SemanticActivityPhase =
  | 'thinking'
  | 'working'
  | 'reviewing'
  | 'drafting'
  | 'reassessing';

export type SemanticLifecycleRole = 'work' | 'answer_generation' | 'internal_hidden';
export type SemanticTrustTier = 'managed_catalog' | 'built_in' | 'customer_configuration' | 'unknown';
export type SemanticEffectClass = ManagedEffectClass | 'none';

export interface ManagedSemanticLabelReference {
  readonly kind: 'managed_connector';
  /** Stable product-controlled catalog identity. */
  readonly id: string;
  /** Immutable catalog copy; validated again before narration. */
  readonly label: string;
}

export interface SemanticActivityDescriptor {
  readonly operation: SemanticOperation;
  readonly target: SemanticTargetFamily;
  readonly label?: ManagedSemanticLabelReference | undefined;
  readonly object: SemanticObject;
  readonly effect: SemanticEffectClass;
  readonly role: SemanticLifecycleRole;
  readonly trust: SemanticTrustTier;
}

export interface ManagedCapabilitySemanticOverride {
  operation?: SemanticOperation | undefined;
  object?: SemanticObject | undefined;
}

export type SemanticLifecycleEvent =
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
  unknown: unknownSemanticDescriptor(),
} as const satisfies Record<
  Exclude<SemanticTargetFamily, 'managed_connector' | 'response' | 'internal'>,
  SemanticActivityDescriptor
>;

/**
 * Return a family descriptor with no slot for a customer-authored display name.
 * Invocation owners may select only this closed family-level fact.
 */
export function genericSemanticDescriptor(
  family: keyof typeof GENERIC_DESCRIPTORS,
): SemanticActivityDescriptor {
  return { ...GENERIC_DESCRIPTORS[family] };
}

export function unknownSemanticDescriptor(): SemanticActivityDescriptor {
  return descriptor('run', 'unknown', 'the request', 'none', 'unknown');
}

export function semanticDescriptorForCoreTool(toolName: string): SemanticActivityDescriptor {
  if (toolName === 'stream_answer') {
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
  if (!isSemanticOperation(value.operation) || !isTargetFamily(value.target) ||
      !isSemanticObject(value.object) || !isEffect(value.effect) ||
      !isLifecycleRole(value.role) || !isTrustTier(value.trust)) return false;
  if (value.label === undefined) return value.target !== 'managed_connector';
  if (value.target !== 'managed_connector' || value.trust !== 'managed_catalog' ||
      !isRecord(value.label)) return false;
  if (!hasOnlyKeys(value.label, ['kind', 'id', 'label'])) return false;
  return value.label.kind === 'managed_connector' &&
    typeof value.label.id === 'string' && /^[a-z0-9][a-z0-9_.-]{0,191}$/.test(value.label.id) &&
    typeof value.label.label === 'string' && isSafeManagedLabel(value.label.label);
}

/** Accept only canonical structured copy before crossing the activity wire. */
export function isSafeTypedActivityStatus(value: unknown): value is TypedActivityStatus {
  if (!isRecord(value) ||
      !hasOnlyKeys(value, ['kind', 'action', 'object', 'family', 'phase', 'text']) ||
      !isActivityKind(value.kind) ||
      typeof value.action !== 'string' || typeof value.object !== 'string' ||
      !isTargetFamily(value.family) || !isSemanticActivityPhase(value.phase) ||
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
    case 'custom_connection':
      return settled
        ? activityStatus('reading', 'Reviewing', 'the results')
        : activityStatus(
            descriptorValue.effect === 'read' ? 'checking' : 'updating',
            descriptorValue.effect === 'read' ? 'Checking' : 'Updating',
            'a connected service',
          );
    case 'skill':
      return settled
        ? activityStatus('reading', 'Reviewing', 'skill results')
        : activityStatus('running', 'Using', 'a skill');
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
    case 'connection_setup':
      return settled
        ? activityStatus('checking', 'Checking', 'the connection')
        : activityStatus('updating', 'Setting up', 'a connection');
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

function isTargetFamily(value: unknown): value is SemanticTargetFamily {
  return value === 'managed_connector' || value === 'custom_connection' || value === 'skill' ||
    value === 'repository' || value === 'memory' || value === 'scheduled_work' ||
    value === 'workspace' || value === 'connection_setup' || value === 'agent_authoring' ||
    value === 'artifact' || value === 'response' || value === 'unknown' || value === 'internal';
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
  return `${value.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}
