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
}

type PreviewChange = ManagementChangeSetPreview['changes'][number];
type OperationKind = PreviewChange['operationKind'];

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

/** Admin's words for stored values a person would otherwise read as machine tokens. */
const VALUE_LABELS: Partial<Record<PresentationField, Readonly<Record<string, string>>>> = {
  editPolicy: {
    creator_and_admins: 'Creator and workspace admins',
    all_workspace_members: 'Any workspace member',
  },
  enabled: { true: 'Enabled', false: 'Disabled' },
  lifecycle: { active: 'Active', archived: 'Archived' },
};

/** Agent connection lists, rendered entry by entry under the name people see in Admin. */
const CONNECTION_FIELDS = new Set<PresentationField>(['mcpServers', 'apiConnections', 'repositories']);

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
  save_routine: 'Save Routine',
  control_routine: 'Control Routine',
  run_routine: 'Run Routine',
  delete_routine: 'Delete Routine',
  reassign_routine_agent: 'Change Routine Agent',
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

function formatProposal(
  preview: ManagementChangeSetPreview,
  dialect: ChangeSetPresentationDialect,
  leadingSections: readonly string[],
): string {
  const creation = creationPreview(preview);
  const header = dialect.header;
  const approvalInstruction = dialect.approvalInstruction;
  const truncatedApprovalInstruction = dialect.truncatedApprovalInstruction;
  const sections = preview.changes.flatMap((change) => {
    if (creation?.originGrant === change) return [];
    if (change.operationKind === 'create_agent') {
      const after = presentationRecord(change.operationKind, change.after);
      return [formatNewAgentSection(after, dialect, creation?.originGrant !== undefined)];
    }
    return formatChangeSections(change, dialect);
  });
  const body = [...leadingSections, ...sections].join('\n\n');
  const fullPresentation = [
    header,
    ...(body ? [body, ''] : []),
    approvalInstruction,
  ].join('\n');
  if (fullPresentation.length <= dialect.textLimit) {
    return fullPresentation;
  }

  const prefix = `${header}\n`;
  const suffix = `\n\n${dialect.truncationNotice}\n\n${truncatedApprovalInstruction}`;
  const availableBodyLength = dialect.textLimit - prefix.length - suffix.length;
  return `${prefix}${body.slice(0, availableBodyLength).trimEnd()}${suffix}`;
}

function formatChangeSections(
  change: PreviewChange,
  dialect: ChangeSetPresentationDialect,
): string[] {
  const before = presentationRecord(change.operationKind, change.before);
  const after = presentationRecord(change.operationKind, change.after);
  const sections = (fields: readonly PresentationField[], targetName: string) =>
    formatRecordSections(change, before, after, fields, targetName, dialect);
  const statement = change.statement;
  switch (change.operationKind) {
    case 'update_agent':
      return sections(PRESENTATION_FIELDS.agent, recordName(before, after) ?? 'Agent');
    case 'save_routine':
      return sections(PRESENTATION_FIELDS.routine, recordName(before, after) ?? 'Routine');
    case 'put_channel':
      return sections(
        PRESENTATION_FIELDS.channel,
        channelName(stringValue(after?.label) ?? stringValue(before?.label)) ?? 'Channel',
      );
    case 'update_agent_memory':
      return sections(
        PRESENTATION_FIELDS.memory,
        statement?.kind === 'update_agent_memory' ? statement.agent.name : 'Agent',
      );
    default: {
      if (statement && statement.kind !== 'update_agent_memory') {
        return [formatStatement(statement, dialect)];
      }
      const name = recordName(before, after);
      const label = OPERATION_LABELS[change.operationKind];
      return [dialect.bold(name ? `${dialect.escape(name)} — ${label}` : label)];
    }
  }
}

function formatRecordSections(
  change: PreviewChange,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  fields: readonly PresentationField[],
  targetName: string,
  dialect: ChangeSetPresentationDialect,
): string[] {
  const compare = change.before !== undefined;
  const changed = fields.filter((field) => !presentationValuesEqual(before?.[field], after?.[field]));
  if (changed.length === 0) {
    return [dialect.bold(`${dialect.escape(targetName)} — ${OPERATION_LABELS[change.operationKind]}`)];
  }
  return changed.flatMap((field) => {
    if (field === 'skills') {
      return formatSkillChangeSections(targetName, before?.[field], after?.[field], compare, dialect);
    }
    if (CONNECTION_FIELDS.has(field)) {
      return formatConnectionChangeSections(
        agentRecordLabel(before ?? after, targetName),
        before?.[field],
        after?.[field],
        dialect,
      );
    }
    return [formatChangeSection(
      targetName,
      FIELD_LABELS[field],
      presentationValue(field, before?.[field]),
      presentationValue(field, after?.[field]),
      compare,
      dialect,
    )];
  });
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
  const routine = (name: string | undefined) => named(name, 'this routine');
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
      return formatMemberStatement(statement, named(statement.member, 'this member'));
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

function formatMemberStatement(
  statement: Extract<ManagementChangeStatement, { kind: 'update_member' }>,
  member: string,
): string {
  const sentences = [
    ...(statement.role ? [`Make ${member} ${ROLE_PHRASES[statement.role]}.`] : []),
    ...(statement.status === 'suspended'
      ? [`Suspend ${member}’s Chickpea access. They can’t use Agents or sign in until an Owner restores it.`]
      : statement.status === 'removed'
      ? [`Remove ${member} from Chickpea. Removal is permanent.`]
      : statement.status === 'active'
      ? [`Restore ${member}’s Chickpea access.`]
      : []),
  ];
  return sentences.join(' ');
}

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

function formatConnectionChangeSections(
  agent: ManagementAgentLabel,
  before: unknown,
  after: unknown,
  dialect: ChangeSetPresentationDialect,
): string[] {
  const beforeEntries = connectionEntries(before);
  const afterEntries = connectionEntries(after);
  const beforeById = new Map(beforeEntries.map((entry) => [entry.id, entry]));
  const afterById = new Map(afterEntries.map((entry) => [entry.id, entry]));
  const target = formatAgentLabel(agent, dialect);
  const name = (entry: ConnectionEntry) => dialect.bold(dialect.escape(entry.name));
  return [
    ...beforeEntries.flatMap((entry) =>
      afterById.has(entry.id) ? [] : [`Remove ${name(entry)} from ${target}.`]),
    ...afterEntries.flatMap((entry) => {
      const previous = beforeById.get(entry.id);
      if (!previous) return [`Add ${name(entry)} to ${target}.`];
      return presentationValuesEqual(previous.record, entry.record)
        ? []
        : [`Update ${name(entry)} on ${target}.`];
    }),
  ];
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
  return [
    heading,
    dialect.bold('Replace'),
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

function formatNewAgentSection(
  after: Record<string, unknown> | undefined,
  dialect: ChangeSetPresentationDialect,
  availableInOriginChannel = false,
): string {
  const identityFields = PRESENTATION_FIELDS.newAgent.flatMap((field) => {
    const value = presentationValue(field, after?.[field]);
    return value === undefined ? [] : [[field, value] as const];
  });
  const optionalFields: ReadonlyArray<readonly [PresentationField, string]> = availableInOriginChannel
    ? [['availableIn', 'This Channel'] as const]
    : [];
  const fields = [...identityFields, ...optionalFields];
  return [
    dialect.bold('New Agent'),
    fields.map(([field, value]) => [
      dialect.bold(FIELD_LABELS[field]),
      quoteValue(value, dialect),
    ].join('\n')).join('\n\n'),
  ].join('\n');
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
