import type {
  ApiConnectionConfig,
  McpConnectionConfig,
  NonChatModelRole,
  RepositoryGrant,
} from '../config/types.ts';
import type { MembershipStatus } from '../identity/types.ts';
import type {
  ManagementAgentLabel,
  ManagementChangeSetPreview,
  ManagementChangeStatement,
} from './types.ts';

/**
 * One change-set renderer shared by every door. Only wording, escaping, and
 * length limits vary by dialect; the facts a reviewer sees never do.
 */
export interface ChangeSetPresentationDialect {
  header: string;
  approvalInstruction: string;
  truncatedApprovalInstruction: string;
  truncationNotice: string;
  textLimit: number;
  bold: (text: string) => string;
  escape: (text: string) => string;
  /** A technical value (URL, host, tool, scope) shown inert: no mention, link or formatting. */
  code: (text: string) => string;
}

type PreviewChange = ManagementChangeSetPreview['changes'][number];
type OperationKind = PreviewChange['operationKind'];

/**
 * A section or line of a preview. A pinned part widens access, or could: it
 * leads a preview that must be cut and counts toward `changeSetAccessFits`.
 */
interface PreviewPart {
  text: string;
  pinned: boolean;
}

/**
 * The only record fields a preview renders, in order. Every other field (IDs,
 * kind, Slack presence and avatar, revisions, credential references,
 * lifecycle internals) is internal and never reaches a person.
 */
const PRESENTATION_FIELDS = {
  agent: [
    'name',
    'requestedHandle',
    'description',
    'instructions',
    'editPolicy',
    'model',
    'modelEffort',
    'enabled',
    'skills',
    'mcpServers',
    'apiConnections',
    'repositories',
  ],
  newAgent: ['name', 'requestedHandle', 'description', 'instructions'],
  routine: ['name', 'ownerAgent', 'description', 'taskText', 'schedule', 'timezone', 'destination', 'delivery'],
  channel: ['label', 'lifecycle'],
  memory: ['body'],
} as const;

type PresentationField =
  | (typeof PRESENTATION_FIELDS)[keyof typeof PRESENTATION_FIELDS][number]
  | 'availableIn';

const FIELD_LABELS: Readonly<Record<PresentationField, string>> = {
  name: 'Name',
  requestedHandle: 'Slack Handle',
  description: 'Description',
  instructions: 'Instructions',
  editPolicy: 'Who can edit',
  model: 'Model',
  modelEffort: 'Effort',
  enabled: 'Status',
  skills: 'Skills',
  mcpServers: 'MCP Servers',
  apiConnections: 'API Connections',
  repositories: 'Repositories',
  ownerAgent: 'Agent',
  taskText: 'Task',
  schedule: 'Schedule',
  timezone: 'Timezone',
  destination: 'Destination',
  delivery: 'Delivery',
  label: 'Name',
  lifecycle: 'Status',
  body: 'Memory',
  availableIn: 'Available in',
};

const STATUS_LABELS = { true: 'Enabled', false: 'Disabled' } as const;

/** Admin's words for stored values a person would otherwise read as machine tokens. */
const VALUE_LABELS: Partial<Record<PresentationField, Readonly<Record<string, string>>>> = {
  editPolicy: {
    creator_and_admins: 'Creator and workspace admins',
    all_workspace_members: 'Any workspace member',
  },
  enabled: STATUS_LABELS,
  lifecycle: { active: 'Active', archived: 'Archived' },
};

/** For a change with nothing else to show: frozen before statements existed, or internal-only. */
const OPERATION_LABELS: Readonly<Record<OperationKind, string>> = {
  create_agent: 'Create Agent',
  update_agent: 'Update Agent',
  delete_agent: 'Delete Agent',
  archive_agent: 'Archive Agent',
  restore_agent: 'Restore Agent',
  put_channel: 'Update Channel',
  grant_agent_channel: 'Add to Channel',
  revoke_agent_channel: 'Remove from Channel',
  update_member: 'Update Member',
  remove_provider_credential: 'Remove Provider Key',
  update_agent_memory: 'Update Memory',
  save_routine: 'Save Schedule',
  control_routine: 'Control Schedule',
  run_routine: 'Run Schedule',
  delete_routine: 'Delete Schedule',
  reassign_routine_agent: 'Change Schedule Agent',
  request_setup: 'Request Setup',
};

const AFFECTED_AGENT_NAME_LIMIT = 8;

export function formatChangeSetProposal(
  preview: ManagementChangeSetPreview,
  dialect: ChangeSetPresentationDialect,
): string {
  return formatProposal(preview, dialect, []);
}

export function formatSkillImportProposal(
  preview: ManagementChangeSetPreview,
  sourceUrl: string,
  dialect: ChangeSetPresentationDialect,
): string {
  return formatProposal(preview, dialect, [
    [dialect.bold('Source'), quoteValue(sourceUrl, dialect)].join('\n'),
  ]);
}

/**
 * Whether everything a change set widens fits in one preview. When it does,
 * truncation only ever cuts sections that grant nothing.
 */
export function changeSetAccessFits(
  preview: ManagementChangeSetPreview,
  dialect: ChangeSetPresentationDialect,
): boolean {
  const pinned = joinParts(proposalParts(preview, dialect).filter(({ pinned }) => pinned));
  return pinned.length <= truncatedBodyLimit(dialect);
}

function formatProposal(
  preview: ManagementChangeSetPreview,
  dialect: ChangeSetPresentationDialect,
  leadingSections: readonly string[],
): string {
  const parts = [
    ...leadingSections.map((text) => ({ text, pinned: true })),
    ...proposalParts(preview, dialect),
  ];
  const body = joinParts(parts);
  const fullPresentation = [
    dialect.header,
    ...(body ? [body, ''] : []),
    dialect.approvalInstruction,
  ].join('\n');
  if (fullPresentation.length <= dialect.textLimit) {
    return fullPresentation;
  }

  const ordered = joinParts([
    ...parts.filter(({ pinned }) => pinned),
    ...parts.filter(({ pinned }) => !pinned),
  ]);
  return `${dialect.header}\n${ordered.slice(0, truncatedBodyLimit(dialect)).trimEnd()}${truncationSuffix(dialect)}`;
}

function proposalParts(
  preview: ManagementChangeSetPreview,
  dialect: ChangeSetPresentationDialect,
): PreviewPart[] {
  const creation = creationPreview(preview);
  return preview.changes.flatMap((change) => {
    if (creation?.originGrant === change) return [];
    if (change.operationKind === 'create_agent') {
      const after = presentationRecord(change.operationKind, change.after);
      return [
        ...formatNewAgentParts(after, dialect, creation?.originGrant !== undefined),
        ...formatSkillChangeSections(recordName(undefined, after) ?? 'New Agent', undefined, after?.skills, false, dialect)
          .map((text) => fieldPart('skills', after?.skills, text)),
      ];
    }
    return formatChangeSections(change, dialect);
  });
}

function truncationSuffix(dialect: ChangeSetPresentationDialect): string {
  return `\n\n${dialect.truncationNotice}\n\n${dialect.truncatedApprovalInstruction}`;
}

function truncatedBodyLimit(dialect: ChangeSetPresentationDialect): number {
  return dialect.textLimit - `${dialect.header}\n`.length - truncationSuffix(dialect).length;
}

function joinParts(parts: readonly PreviewPart[]): string {
  return parts.map(({ text }) => text).join('\n\n');
}

/** Pinned unless `SAFE_CHANGES` lists this change to the field as safe. */
function fieldPart(field: PresentationField, after: unknown, text: string): PreviewPart {
  return { text, pinned: !safeFieldChange(field, after) };
}

function safeFieldChange(field: PresentationField, after: unknown): boolean {
  const rule = SAFE_CHANGES[field];
  return rule === true || rule?.includes(String(after)) === true;
}

function headerPart(operationKind: OperationKind, text: string): PreviewPart {
  return { text, pinned: SAFE_CHANGES[operationKind] !== true };
}

function formatChangeSections(
  change: PreviewChange,
  dialect: ChangeSetPresentationDialect,
): PreviewPart[] {
  const before = presentationRecord(change.operationKind, change.before);
  const after = presentationRecord(change.operationKind, change.after);
  const sections = (fields: readonly PresentationField[], targetName: string) =>
    formatRecordSections(change, before, after, fields, targetName, dialect);
  const statement = change.statement;
  if (statement?.kind === 'update_agent_memory') {
    return sections(PRESENTATION_FIELDS.memory, statement.agent.name);
  }
  if (statement) {
    const rule = SAFE_CHANGES[statement.kind];
    const safe = rule === true || (typeof rule === 'function' && rule(statement));
    return [{ text: formatStatement(statement, dialect), pinned: !safe }];
  }
  switch (change.operationKind) {
    case 'update_agent':
      return sections(PRESENTATION_FIELDS.agent, recordName(before, after) ?? 'Agent');
    case 'save_routine':
      return sections(PRESENTATION_FIELDS.routine, recordName(before, after) ?? 'Schedule');
    case 'put_channel':
      return sections(
        PRESENTATION_FIELDS.channel,
        channelName(stringValue(after?.label) ?? stringValue(before?.label)) ?? 'Channel',
      );
    case 'update_agent_memory':
      return sections(PRESENTATION_FIELDS.memory, 'Agent');
    default:
      return [headerPart(change.operationKind, operationHeader(change.operationKind, recordName(before, after), dialect))];
  }
}

/**
 * The only changes that cannot widen access. Every other part is pinned,
 * including a field or statement added later. `true` is always safe; a list
 * names the values a field may safely change to; a function judges a
 * statement. Connection lines follow their own field tables below.
 */
const SAFE_CHANGES: Partial<Record<PresentationField, true | readonly string[]>> &
  Partial<Record<OperationKind, true | ((statement: SpokenStatement) => boolean)>> = {
  name: true,
  requestedHandle: true,
  description: true,
  instructions: true,
  modelEffort: true,
  skills: true,
  editPolicy: ['creator_and_admins'],
  enabled: ['false'],
  taskText: true,
  schedule: true,
  timezone: true,
  delivery: true,
  label: true,
  lifecycle: ['archived'],
  body: true,
  archive_agent: true,
  delete_agent: true,
  revoke_agent_channel: true,
  remove_provider_credential: true,
  delete_routine: true,
  control_routine: (statement) => statement.kind === 'control_routine' && statement.action !== 'resume',
  update_member: (statement) => statement.kind === 'update_member' &&
    (statement.role === undefined || statement.role === 'member') && statement.status !== 'active',
};

/** The bold "Name — Operation" heading for a change with nothing more specific to say. */
function operationHeader(
  operationKind: OperationKind,
  name: string | undefined,
  dialect: ChangeSetPresentationDialect,
): string {
  const label = OPERATION_LABELS[operationKind];
  return dialect.bold(name ? `${dialect.escape(name)} — ${label}` : label);
}

function formatRecordSections(
  change: PreviewChange,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  fields: readonly PresentationField[],
  targetName: string,
  dialect: ChangeSetPresentationDialect,
): PreviewPart[] {
  const compare = change.before !== undefined;
  const changed = fields.filter((field) => !presentationValuesEqual(before?.[field], after?.[field]));
  const sections = changed.flatMap((field): PreviewPart[] => {
    if (field === 'skills') {
      return formatSkillChangeSections(targetName, before?.[field], after?.[field], compare, dialect)
        .map((text) => fieldPart(field, after?.[field], text));
    }
    const connectionFields = CONNECTION_FIELDS[field];
    if (connectionFields) {
      return formatConnectionChangeSections(
        connectionFields,
        agentRecordLabel(before ?? after, targetName),
        before?.[field],
        after?.[field],
        dialect,
      );
    }
    return [fieldPart(field, after?.[field], formatChangeSection(
      targetName,
      FIELD_LABELS[field],
      presentationValue(field, before?.[field]),
      presentationValue(field, after?.[field]),
      compare,
      dialect,
    ))];
  });
  return sections.length > 0
    ? sections
    : [headerPart(change.operationKind, operationHeader(change.operationKind, targetName, dialect))];
}

/** A memory change shows its body diff instead; its statement only names the Agent. */
type SpokenStatement = Exclude<ManagementChangeStatement, { kind: 'update_agent_memory' }>;

function formatStatement(
  statement: SpokenStatement,
  dialect: ChangeSetPresentationDialect,
): string {
  const named = (name: string | undefined, fallback: string) =>
    name ? dialect.bold(dialect.escape(name)) : fallback;
  const agent = (label: ManagementAgentLabel | undefined) =>
    label ? formatAgentLabel(label, dialect) : 'this Agent';
  const channel = (label: string | undefined) => named(channelName(label), 'a Channel');
  const routine = (name: string | undefined) => named(name, 'this schedule');
  switch (statement.kind) {
    case 'archive_agent': {
      const reach = statement.channelCount === 0
        ? 'It stops answering.'
        : `It leaves ${statement.channelCount} Channel${statement.channelCount === 1 ? '' : 's'} and stops answering.`;
      return `Archive ${agent(statement.agent)}. ${reach} It can be restored later.`;
    }
    case 'restore_agent':
      return `Restore ${agent(statement.agent)}. It gets back the Channels and schedules it had before the archive.`;
    case 'delete_agent':
      return `Delete ${agent(statement.agent)} permanently. This cannot be undone.`;
    case 'update_member':
      return formatMemberStatement(statement, dialect);
    case 'remove_provider_credential':
      return formatProviderRemoval(statement, dialect);
    case 'grant_agent_channel':
      return `Add ${agent(statement.agent)} to ${channel(statement.channel)}.`;
    case 'revoke_agent_channel':
      return `Remove ${agent(statement.agent)} from ${channel(statement.channel)}. It stops answering there.`;
    case 'delete_routine':
      return `Delete ${routine(statement.routine)} permanently. This stops all future runs and cannot be undone.`;
    case 'run_routine':
      return `Run ${routine(statement.routine)} now.`;
    case 'control_routine':
      return `${ROUTINE_ACTIONS[statement.action]} ${routine(statement.routine)}.`;
    case 'reassign_routine_agent':
      return `Run ${routine(statement.routine)} with ${agent(statement.agent)} from now on.`;
    case 'request_setup':
      return `Set up ${named(statement.setup, 'a connection')}.`;
  }
}

const ROUTINE_ACTIONS = { pause: 'Pause', resume: 'Resume', disable: 'Disable' } as const;

const ROLE_PHRASES = { owner: 'an Owner', admin: 'an Admin', member: 'a Member' } as const;

const MEMBER_STATUS_SENTENCES: Readonly<Record<MembershipStatus, (member: string) => string>> = {
  suspended: (member) =>
    `Suspend ${member}’s Chickpea access. They can’t use Agents or sign in until an Owner restores it.`,
  removed: (member) => `Remove ${member} from Chickpea. Removal is permanent.`,
  active: (member) => `Restore ${member}’s Chickpea access.`,
};

function formatMemberStatement(
  statement: Extract<ManagementChangeStatement, { kind: 'update_member' }>,
  dialect: ChangeSetPresentationDialect,
): string {
  const member = statement.member ? dialect.bold(dialect.escape(statement.member)) : 'this member';
  const sentences = [
    ...(statement.role ? [`Make ${member} ${ROLE_PHRASES[statement.role]}.`] : []),
    ...(statement.status ? [MEMBER_STATUS_SENTENCES[statement.status](member)] : []),
  ];
  return sentences.length > 0
    ? sentences.join(' ')
    : operationHeader('update_member', statement.member, dialect);
}

const ROLE_IMPACTS: Readonly<Record<NonChatModelRole, (provider: string) => string>> = {
  image: (provider) =>
    `The default image model uses ${provider}, so image generation stops until a key is available.`,
  coding: (provider) =>
    `The default coding model uses ${provider}, so coding workspaces use each Agent’s own model until a key is available.`,
};

function formatProviderRemoval(
  statement: Extract<ManagementChangeStatement, { kind: 'remove_provider_credential' }>,
  dialect: ChangeSetPresentationDialect,
): string {
  const provider = dialect.escape(statement.provider);
  const agents = statement.affectedAgents;
  const [uses, stops] = agents.length === 1 ? ['uses', 'stops'] : ['use', 'stop'];
  const impacts = [
    ...(statement.workspaceDefaultAffected
      ? [`The Workspace default uses ${provider}, so Chickpea stops answering too.`]
      : []),
    ...(agents.length > 0
      ? [`${joinNames(agents, dialect)} ${uses} ${provider} and ${stops} answering until a key is available.`]
      : []),
    ...statement.affectedWorkspaceRoles.map((role) => ROLE_IMPACTS[role](provider)),
  ];
  return [
    `Remove the stored ${dialect.bold(provider)} key.`,
    ...(impacts.length > 0
      ? impacts
      : [`No Agent pin or Workspace default currently depends on ${provider}.`]),
  ].join(' ');
}

function joinNames(names: readonly string[], dialect: ChangeSetPresentationDialect): string {
  const shown = names.slice(0, AFFECTED_AGENT_NAME_LIMIT)
    .map((name) => dialect.bold(dialect.escape(name)));
  const hidden = names.length - shown.length;
  const items = hidden > 0 ? [...shown, `${hidden} more`] : shown;
  if (items.length <= 2) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

function formatAgentLabel(label: ManagementAgentLabel, dialect: ChangeSetPresentationDialect): string {
  const name = dialect.bold(dialect.escape(label.name));
  return label.handle ? `${name} (@${dialect.escape(label.handle)})` : name;
}

interface ConnectionEntry {
  id: string;
  name: string;
  record: Record<string, unknown>;
}

/** How a stored value reads: as inert code, as a bold name, or in Admin's words. */
type ValueFormat = 'code' | 'name' | Readonly<Record<string, string>>;

/**
 * How one stored connection field reaches the person approving a change.
 * `widens` names the changes that widen access: any change (`true`), none
 * (`false`), or a change to one value, such as turning a connection on.
 */
type ConnectionField =
  | {
      show: 'value';
      label: string;
      format: ValueFormat;
      widens: boolean | string;
      /** Left out of a new connection's lines: always, or when it holds this default. */
      unlessNew?: true | string;
      read?: (value: unknown) => string | undefined;
    }
  | {
      show: 'list';
      label: string;
      noun: string;
      read?: (value: unknown) => string[];
      /** Said when the list empties: an empty list allows everything. */
      emptyAllows?: string;
    }
  /** Named among the other changes, without its value. */
  | { show: 'named'; label: string; widens: boolean }
  /** Part of the entry's name: a change removes the old entry and adds the new one. */
  | { show: 'identity' }
  /** Server bookkeeping: never shown, and a change to it alone is not a change. */
  | { show: 'bookkeeping' };

/** Every stored field is classified, so a new one fails typecheck until it is. */
type ConnectionFields<T> = Readonly<Record<keyof T, ConnectionField>>;

const BOOKKEEPING: ConnectionField = { show: 'bookkeeping' };
const IDENTITY: ConnectionField = { show: 'identity' };
const CONNECTION_NAME: ConnectionField = {
  show: 'value', label: 'Name', format: 'name', widens: false, unlessNew: true,
};
const CONNECTION_STATUS: ConnectionField = {
  show: 'value', label: 'Status', format: STATUS_LABELS, widens: 'true', unlessNew: 'true',
};
/** The account a provider probe reported; Admin shows it as "Connected as". */
const CONNECTED_ACCOUNT: ConnectionField = {
  show: 'value', label: 'Connected account', format: 'code', widens: true, read: accountLabel,
};
/** A preset decides whether new tools need review. */
const CONNECTOR_PRESET: ConnectionField = { show: 'named', label: 'Connector', widens: true };
/**
 * The store derives the credential reference on every write, so a patch
 * cannot choose one and the preview's record drops it.
 */
const CREDENTIAL_REFERENCE = BOOKKEEPING;

/** In display order. Admin's labels: the MCP editor and the connection account form. */
const MCP_FIELDS: ConnectionFields<McpConnectionConfig> = {
  displayName: CONNECTION_NAME,
  url: { show: 'value', label: 'Server URL', format: 'code', widens: true },
  transport: {
    show: 'value',
    label: 'Transport',
    format: { 'streamable-http': 'Streamable HTTP', sse: 'SSE' },
    widens: true,
    unlessNew: 'streamable-http',
  },
  authMode: {
    show: 'value',
    label: 'Authentication',
    format: { none: 'None', bearer: 'Bearer token', oauth: 'OAuth' },
    widens: true,
  },
  headerNames: { show: 'list', label: 'Custom headers', noun: 'custom headers' },
  allowedTools: { show: 'list', label: 'Allowed tools', noun: 'tools' },
  oauthScope: { show: 'list', label: 'Scope', noun: 'scopes', read: scopeTokens },
  enabled: CONNECTION_STATUS,
  identity: CONNECTED_ACCOUNT,
  toolAccessMode: { show: 'named', label: 'Allowed tools', widens: true },
  toolPolicies: { show: 'named', label: 'Tool restrictions', widens: true },
  credentialHeaderName: { show: 'named', label: 'Custom headers', widens: true },
  credentialValuePrefix: { show: 'named', label: 'Custom headers', widens: false },
  credentialOptional: { show: 'named', label: 'Authentication', widens: true },
  discoveredTools: { show: 'named', label: 'Discovered tools', widens: false },
  presetId: CONNECTOR_PRESET,
  id: BOOKKEEPING,
  credentialRef: CREDENTIAL_REFERENCE,
  oauthAttemptId: BOOKKEEPING,
  lifecycleStatus: BOOKKEEPING,
  statusText: BOOKKEEPING,
  lastCheckedAt: BOOKKEEPING,
};

/** In display order. Admin's labels: the API connection editor and its Google form. */
const API_FIELDS: ConnectionFields<ApiConnectionConfig> = {
  displayName: CONNECTION_NAME,
  allowedHosts: { show: 'list', label: 'Allowed hosts', noun: 'hosts' },
  pathPrefixes: {
    show: 'list',
    label: 'Path prefixes',
    noun: 'path prefixes',
    emptyAllows: 'This allows the whole host.',
  },
  allowedMethods: { show: 'list', label: 'Methods', noun: 'methods' },
  authMode: {
    show: 'value',
    label: 'Authentication',
    format: { credential: 'API token', oauth: 'Google OAuth' },
    widens: true,
    unlessNew: 'credential',
    read: (value) => stringValue(value) ?? 'credential',
  },
  oauthProvider: {
    show: 'value', label: 'OAuth provider', format: { google: 'Google' }, widens: true, unlessNew: true,
  },
  oauthAppType: {
    show: 'value',
    label: 'Google app audience',
    format: { 'workspace-internal': 'Workspace internal', external: 'Personal / external' },
    widens: true,
  },
  oauthScopes: { show: 'list', label: 'Scope', noun: 'scopes' },
  headerName: { show: 'value', label: 'Header name', format: 'code', widens: false, unlessNew: 'Authorization' },
  headerValuePrefix: { show: 'value', label: 'Value prefix', format: 'code', widens: false, unlessNew: 'Bearer ' },
  enabled: CONNECTION_STATUS,
  identity: CONNECTED_ACCOUNT,
  presetId: CONNECTOR_PRESET,
  id: BOOKKEEPING,
  credentialRef: CREDENTIAL_REFERENCE,
  lifecycleStatus: BOOKKEEPING,
  statusText: BOOKKEEPING,
};

/** A grant's account, repository and all-repositories choice are its name. */
const REPOSITORY_FIELDS: ConnectionFields<RepositoryGrant> = {
  accountLogin: IDENTITY,
  fullName: IDENTITY,
  allRepos: IDENTITY,
  enabled: CONNECTION_STATUS,
  installationId: { show: 'named', label: 'GitHub installation', widens: true },
  id: BOOKKEEPING,
};

/** Agent connection lists, rendered entry by entry under the name people see in Admin. */
const CONNECTION_FIELDS: Partial<Record<PresentationField, Readonly<Record<string, ConnectionField>>>> = {
  mcpServers: MCP_FIELDS,
  apiConnections: API_FIELDS,
  repositories: REPOSITORY_FIELDS,
};

/** List entries shown before "…and N more". */
const LIST_VALUE_LIMIT = 10;

function formatConnectionChangeSections(
  fields: Readonly<Record<string, ConnectionField>>,
  agent: ManagementAgentLabel,
  before: unknown,
  after: unknown,
  dialect: ChangeSetPresentationDialect,
): PreviewPart[] {
  const beforeEntries = connectionEntries(before);
  const afterEntries = connectionEntries(after);
  const beforeById = new Map(beforeEntries.map((entry) => [entry.id, entry]));
  const afterById = new Map(afterEntries.map((entry) => [entry.id, entry]));
  const target = formatAgentLabel(agent, dialect);
  const name = (entry: ConnectionEntry) => dialect.bold(dialect.escape(entry.name));
  const renamed = (previous: ConnectionEntry, entry: ConnectionEntry) =>
    Object.entries(fields).some(([key, field]) =>
      field.show === 'identity' && !presentationValuesEqual(previous.record[key], entry.record[key]));
  return [
    ...beforeEntries.flatMap((entry) => {
      const next = afterById.get(entry.id);
      return next && !renamed(entry, next)
        ? []
        : [{ text: `Remove ${name(entry)} from ${target}.`, pinned: false }];
    }),
    ...afterEntries.flatMap((entry) => {
      const previous = beforeById.get(entry.id);
      if (!previous || renamed(previous, entry)) {
        return [{
          text: [`Add ${name(entry)} to ${target}.`, ...newConnectionLines(fields, entry.record, dialect)]
            .join('\n'),
          pinned: entry.record.enabled !== false,
        }];
      }
      const lines = changedConnectionLines(fields, previous.record, entry.record, dialect);
      if (lines.length === 0) return [];
      return [{
        text: [`Update ${name(entry)} on ${target}.`, ...lines.map(({ text }) => text)].join('\n'),
        pinned: lines.some(({ pinned }) => pinned),
      }];
    }),
  ];
}

/** What a new connection reaches and allows, leaving out defaults. */
function newConnectionLines(
  fields: Readonly<Record<string, ConnectionField>>,
  record: Record<string, unknown>,
  dialect: ChangeSetPresentationDialect,
): string[] {
  return Object.entries(fields).flatMap(([key, field]) => {
    if (field.show === 'value') {
      const value = (field.read ?? scalarValue)(record[key]);
      if (value === undefined || field.unlessNew === true || field.unlessNew === value) return [];
      return [`${field.label}: ${formatConnectionValue(field.format, value, dialect)}.`];
    }
    if (field.show === 'list') {
      const values = (field.read ?? stringList)(record[key]);
      return values.length > 0 ? [`${field.label}: ${formatValueList(values, dialect)}.`] : [];
    }
    return [];
  });
}

/**
 * One line per changed field, widening lines first, then other changed
 * fields by label. A change no line explains reads as "Changes other
 * settings." and widens: a key the table does not know, or a value whose
 * plain reading hides the difference. A field with its own `read` defines
 * what counts as a change.
 */
function changedConnectionLines(
  fields: Readonly<Record<string, ConnectionField>>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  dialect: ChangeSetPresentationDialect,
): PreviewPart[] {
  const lines: PreviewPart[] = [];
  const named = new Map<string, boolean>();
  let unexplained = [...new Set([...Object.keys(before), ...Object.keys(after)])].some((key) =>
    !Object.hasOwn(fields, key) && !presentationValuesEqual(before[key], after[key]));
  for (const [key, field] of Object.entries(fields)) {
    if (presentationValuesEqual(before[key], after[key])) continue;
    if (field.show === 'value') {
      const read = field.read ?? scalarValue;
      const was = read(before[key]);
      const now = read(after[key]);
      if (was === now) {
        unexplained ||= field.read === undefined;
        continue;
      }
      lines.push({
        text: `${field.label} changes from ${formatConnectionValue(field.format, was, dialect)} to ${
          formatConnectionValue(field.format, now, dialect)
        }.`,
        pinned: field.widens === true || field.widens === now,
      });
    } else if (field.show === 'list') {
      const listed = listChangeLines(field, before[key], after[key], dialect);
      unexplained ||= listed.length === 0 && field.read === undefined;
      lines.push(...listed);
    } else if (field.show === 'named') {
      named.set(field.label, named.get(field.label) === true || field.widens);
    }
  }
  if (named.size > 0) {
    lines.push({ text: `Changes: ${[...named.keys()].join(', ')}.`, pinned: [...named.values()].includes(true) });
  }
  if (unexplained) lines.push({ text: 'Changes other settings.', pinned: true });
  return [...lines.filter(({ pinned }) => pinned), ...lines.filter(({ pinned }) => !pinned)];
}

function listChangeLines(
  field: Extract<ConnectionField, { show: 'list' }>,
  before: unknown,
  after: unknown,
  dialect: ChangeSetPresentationDialect,
): PreviewPart[] {
  const read = field.read ?? stringList;
  const was = read(before);
  const now = read(after);
  const wasSet = new Set(was);
  const nowSet = new Set(now);
  const added = now.filter((value) => !wasSet.has(value));
  const removed = was.filter((value) => !nowSet.has(value));
  const allowsAll = (values: readonly string[]) => field.emptyAllows !== undefined && values.length === 0;
  return [
    ...(added.length > 0
      ? [{ text: `Adds ${field.noun}: ${formatValueList(added, dialect)}.`, pinned: !allowsAll(was) }]
      : []),
    ...(removed.length > 0
      ? [{
          text: [
            `Removes ${field.noun}: ${formatValueList(removed, dialect)}.`,
            ...(allowsAll(now) ? [field.emptyAllows] : []),
          ].join(' '),
          pinned: allowsAll(now),
        }]
      : []),
  ];
}

function formatConnectionValue(
  format: ValueFormat,
  value: string | undefined,
  dialect: ChangeSetPresentationDialect,
): string {
  if (value === undefined) return 'none';
  if (format === 'name') return dialect.bold(dialect.escape(value));
  if (format !== 'code' && format[value] !== undefined) return dialect.escape(format[value]);
  return formatCode(value, dialect);
}

function formatValueList(values: readonly string[], dialect: ChangeSetPresentationDialect): string {
  const shown = values.slice(0, LIST_VALUE_LIMIT).map((value) => formatCode(value, dialect)).join(', ');
  const hidden = values.length - LIST_VALUE_LIMIT;
  return hidden > 0 ? `${shown}, …and ${hidden} more` : shown;
}

/** A value on one line, so it cannot start a line of its own in the preview. */
function formatCode(value: string, dialect: ChangeSetPresentationDialect): string {
  return dialect.code(value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' '));
}

function scalarValue(value: unknown): string | undefined {
  return typeof value === 'boolean' ? String(value) : stringValue(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((entry) => stringValue(entry) ?? []) : [];
}

function accountLabel(value: unknown): string | undefined {
  const identity = recordValue(value);
  const workspace = stringValue(identity?.workspaceName);
  const account = stringValue(identity?.accountName);
  return workspace && account ? `${workspace} (${account})` : workspace ?? account;
}

function scopeTokens(value: unknown): string[] {
  return stringValue(value)?.trim().split(/\s+/) ?? [];
}

function connectionEntries(value: unknown): ConnectionEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const record = recordValue(candidate);
    const id = stringValue(record?.id);
    if (!record || !id) return [];
    const accountLogin = stringValue(record.accountLogin);
    const name = stringValue(record.displayName) ?? stringValue(record.fullName) ??
      (record.allRepos === true && accountLogin ? `All repositories for ${accountLogin}` : undefined) ??
      accountLogin ?? 'Connection';
    return [{ id, name, record }];
  });
}

function formatSkillChangeSections(
  targetName: string,
  before: unknown,
  after: unknown,
  compare: boolean,
  dialect: ChangeSetPresentationDialect,
): string[] {
  const beforeSkills = skillPresentationRecords(before);
  const afterSkills = skillPresentationRecords(after);
  if (!beforeSkills || !afterSkills) {
    return [formatChangeSection(
      targetName,
      FIELD_LABELS.skills,
      skillNames(before),
      skillNames(after),
      compare,
      dialect,
    )];
  }
  const beforeByName = new Map(beforeSkills.map((skill) => [skill.name, skill]));
  const afterByName = new Map(afterSkills.map((skill) => [skill.name, skill]));
  const changedNames = [
    ...afterSkills.flatMap((skill) =>
      presentationValuesEqual(beforeByName.get(skill.name), skill) ? [] : [skill.name]
    ),
    ...beforeSkills.flatMap((skill) => afterByName.has(skill.name) ? [] : [skill.name]),
  ];
  if (changedNames.length === 0) return [];
  return changedNames.map((name) => formatSkillChangeSection(
    targetName,
    name,
    beforeByName.get(name),
    afterByName.get(name),
    dialect,
  ));
}

function formatSkillChangeSection(
  targetName: string,
  skillName: string,
  before: SkillPresentationRecord | undefined,
  after: SkillPresentationRecord | undefined,
  dialect: ChangeSetPresentationDialect,
): string {
  const heading = dialect.bold(`${dialect.escape(targetName)} — Skill: ${
    dialect.escape(skillName)
  }`);
  if (!before && after) {
    return [heading, dialect.bold('Add'), formatSkillDetails(after, dialect)].join('\n');
  }
  if (before && !after) {
    return [heading, dialect.bold('Remove'), formatSkillDetails(before, dialect)].join('\n');
  }
  const changedParts = SKILL_PARTS.flatMap(([part, label]) => before![part] === after![part] ? [] : [label]);
  return [
    heading,
    dialect.bold('Replace'),
    ...(changedParts.length > 0 ? [`Changes: ${changedParts.join(', ')}.`] : []),
    dialect.bold('Before'),
    formatSkillDetails(before!, dialect),
    dialect.bold('After'),
    formatSkillDetails(after!, dialect),
  ].join('\n');
}

interface SkillPresentationRecord {
  name: string;
  description: string;
  instructions: string;
  enabled?: boolean;
}

/** A replaced skill names the parts that differ, since an excerpt can hide a change. */
const SKILL_PARTS = [
  ['enabled', 'Status'],
  ['description', 'Description'],
  ['instructions', 'Instructions'],
] as const satisfies ReadonlyArray<readonly [keyof SkillPresentationRecord, string]>;

function skillPresentationRecords(value: unknown): SkillPresentationRecord[] | undefined {
  if (isEmptyPresentationValue(value)) return [];
  if (!Array.isArray(value)) return undefined;
  const skills: SkillPresentationRecord[] = [];
  for (const candidate of value) {
    const record = recordValue(candidate);
    const name = stringValue(record?.name);
    const description = typeof record?.description === 'string' ? record.description : undefined;
    const instructions = typeof record?.instructions === 'string' ? record.instructions : undefined;
    if (!name || description === undefined || instructions === undefined) return undefined;
    skills.push({
      name,
      description,
      instructions,
      ...(typeof record?.enabled === 'boolean' ? { enabled: record.enabled } : {}),
    });
  }
  return skills;
}

/** Names alone when a skill list is too irregular to compare entry by entry. */
function skillNames(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.flatMap((skill) => stringValue(recordValue(skill)?.name) ?? []);
  return names.length > 0 ? names.join(', ') : undefined;
}

function formatSkillDetails(
  skill: SkillPresentationRecord,
  dialect: ChangeSetPresentationDialect,
): string {
  return [
    ...(skill.enabled === undefined
      ? []
      : [dialect.bold('Status'), quoteValue(skill.enabled ? 'Enabled' : 'Disabled', dialect)]),
    dialect.bold('Description'),
    quoteExcerpt(skill.description, 600, dialect),
    dialect.bold('Instructions'),
    quoteExcerpt(skill.instructions, 1_600, dialect),
  ].join('\n');
}

function quoteExcerpt(
  value: string,
  limit: number,
  dialect: ChangeSetPresentationDialect,
): string {
  const truncated = value.length > limit;
  const excerpt = truncated ? value.slice(0, limit).trimEnd() : value;
  return [
    quoteValue(excerpt, dialect),
    ...(truncated
      ? [`> _… ${value.length - excerpt.length} more characters; approval applies the full skill._`]
      : []),
  ].join('\n');
}

function formatChangeSection(
  targetName: string,
  fieldLabel: string,
  before: string | undefined,
  after: string | undefined,
  compare: boolean,
  dialect: ChangeSetPresentationDialect,
): string {
  if (!compare) {
    return [
      dialect.bold(`${dialect.escape(targetName)} — ${fieldLabel}`),
      quoteValue(after, dialect),
    ].join('\n');
  }
  return [
    dialect.bold(`${dialect.escape(targetName)} — ${fieldLabel}`),
    dialect.bold('Before'),
    quoteValue(before, dialect),
    dialect.bold('After'),
    quoteValue(after, dialect),
  ].join('\n');
}

/**
 * The New Agent section, one part per field so a long field can be cut while
 * a pinned one leads. The heading rides with the first field, so pinned
 * fields still say what they belong to. Its edit policy shows only when it
 * is not the safe default.
 */
function formatNewAgentParts(
  after: Record<string, unknown> | undefined,
  dialect: ChangeSetPresentationDialect,
  availableInOriginChannel = false,
): PreviewPart[] {
  const identityFields = PRESENTATION_FIELDS.newAgent.flatMap((field) => {
    const value = presentationValue(field, after?.[field]);
    return value === undefined ? [] : [[field, value] as const];
  });
  const editing = after?.editPolicy !== undefined && !safeFieldChange('editPolicy', after.editPolicy)
    ? presentationValue('editPolicy', after.editPolicy)
    : undefined;
  const fields: ReadonlyArray<readonly [PresentationField, string]> = [
    ...identityFields,
    ...(editing ? [['editPolicy', editing] as const] : []),
    ...(availableInOriginChannel ? [['availableIn', 'This Channel'] as const] : []),
  ];
  const heading = dialect.bold('New Agent');
  if (fields.length === 0) return [{ text: heading, pinned: true }];
  return fields.map(([field, value], index) => {
    const text = [dialect.bold(FIELD_LABELS[field]), quoteValue(value, dialect)].join('\n');
    return index === 0
      ? { text: `${heading}\n${text}`, pinned: true }
      : fieldPart(field, after?.[field], text);
  });
}

function creationPreview(preview: ManagementChangeSetPreview): {
  creation: PreviewChange;
  originGrant?: PreviewChange;
} | undefined {
  const [creation, originGrant, ...extra] = preview.changes;
  if (creation?.operationKind !== 'create_agent' || extra.length > 0) return undefined;
  if (!originGrant) return { creation };
  if (originGrant.operationKind !== 'grant_agent_channel' || originGrant.before !== undefined) {
    return undefined;
  }
  const createdAgentId = stringValue(recordValue(creation.after)?.id) ??
    (creation.target.startsWith('agent:') ? creation.target.slice('agent:'.length) : undefined);
  const grantedAgentId = stringValue(recordValue(originGrant.after)?.agentId);
  if (!createdAgentId || createdAgentId !== grantedAgentId) return undefined;
  return { creation, originGrant };
}

/** A field's value as a person reads it, or undefined when it is empty. */
function presentationValue(field: PresentationField, value: unknown): string | undefined {
  if (isEmptyPresentationValue(value)) return undefined;
  const labels = VALUE_LABELS[field];
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
  return labels?.[raw] ?? raw;
}

function quoteValue(value: string | undefined, dialect: ChangeSetPresentationDialect): string {
  return (value ?? '(not set)')
    .split(/\r?\n/)
    .map((line) => `> ${dialect.escape(line)}`)
    .join('\n');
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function recordName(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): string | undefined {
  return stringValue(after?.name) ?? stringValue(before?.name);
}

function channelName(label: string | undefined): string | undefined {
  return label ? `#${label.replace(/^#/, '')}` : undefined;
}

function agentRecordLabel(
  record: Record<string, unknown> | undefined,
  fallbackName: string,
): ManagementAgentLabel {
  const handle = stringValue(record?.requestedHandle)?.replace(/^@/, '');
  return {
    name: stringValue(record?.name) ?? fallbackName,
    ...(handle ? { handle } : {}),
  };
}

function presentationRecord(
  operationKind: OperationKind,
  value: unknown,
): Record<string, unknown> | undefined {
  const record = recordValue(value);
  if (!record || (operationKind !== 'create_agent' && operationKind !== 'update_agent')) {
    return record;
  }
  const { slackPresence: _slackPresence, ...presentation } = record;
  const handle = slackHandle(record.slackPresence);
  return {
    ...presentation,
    ...(handle ? { requestedHandle: handle } : {}),
  };
}

function slackHandle(value: unknown): string | undefined {
  const presence = recordValue(value);
  const handle = stringValue(presence?.normalizedHandle) ?? stringValue(presence?.requestedHandle);
  return handle ? `@${handle.replace(/^@/, '')}` : undefined;
}

function presentationValuesEqual(left: unknown, right: unknown): boolean {
  if (isEmptyPresentationValue(left) && isEmptyPresentationValue(right)) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function isEmptyPresentationValue(value: unknown): boolean {
  return value === undefined || value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
