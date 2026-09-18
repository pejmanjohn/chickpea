import type { ManagementChangeSetPreview } from './types.ts';

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

const INTERNAL_PROPOSAL_FIELDS = new Set([
  'revision',
  'configurationGeneration',
  'creatorMembershipId',
  'archivedAt',
]);

const PROPOSAL_FIELD_ORDER = [
  'name',
  'description',
  'instructions',
  'requestedHandle',
  'editPolicy',
  'model',
  'skills',
  'mcpServers',
  'apiConnections',
  'repositories',
  'ownerAgent',
  'taskText',
  'schedule',
  'timezone',
  'destination',
  'delivery',
  'enabled',
  'lifecycle',
];

const NEW_AGENT_PRESENTATION_FIELDS = [
  'name',
  'requestedHandle',
  'description',
  'instructions',
] as const;

const PRESENTATION_OPERATION_LABELS: Readonly<Record<string, string>> = {
  archive_agent: 'Archive Agent',
  control_routine: 'Control Routine',
  delete_agent: 'Delete Agent',
  delete_routine: 'Delete Routine',
  remove_provider_credential: 'Remove Provider Credential',
  restore_agent: 'Restore Agent',
  run_routine: 'Run Routine',
  update_agent: 'Update Agent',
  update_member: 'Update Member',
};

const PRESENTATION_FIELD_LABELS: Readonly<Record<string, string>> = {
  apiConnections: 'API Connections',
  mcpServers: 'MCP Servers',
  editPolicy: 'Editing Authority',
  requestedHandle: 'Slack Handle',
  ownerAgent: 'Agent',
  taskText: 'Task',
  schedule: 'Schedule',
  timezone: 'Timezone',
  destination: 'Destination',
  delivery: 'Delivery',
  availableIn: 'Available in',
  skills: 'Skills',
};

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
    const before = presentationRecord(change.operationKind, change.before);
    const after = presentationRecord(change.operationKind, change.after);
    const targetName = stringValue(after?.name) ?? stringValue(before?.name) ?? change.target;
    if (change.operationKind === 'create_agent') {
      return [formatNewAgentSection(after, targetName, dialect, creation?.originGrant !== undefined)];
    }
    const fields = changedPresentationFields(before, after);
    if (fields.length === 0) {
      return [formatOperationSection(targetName, change.operationKind, dialect)];
    }
    return fields.flatMap((field) => {
      if (field === 'skills') {
        return formatSkillChangeSections(
          targetName,
          before?.[field],
          after?.[field],
          change.before !== undefined,
          dialect,
        );
      }
      return [formatChangeSection(
        targetName,
        presentationFieldLabel(field),
        before?.[field],
        after?.[field],
        change.before !== undefined,
        dialect,
      )];
    });
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
      presentationFieldLabel('skills'),
      before,
      after,
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
  before: unknown,
  after: unknown,
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
  targetName: string,
  dialect: ChangeSetPresentationDialect,
  availableInOriginChannel = false,
): string {
  const identityFields = NEW_AGENT_PRESENTATION_FIELDS.flatMap((field) => {
    const fallback = field === 'name' ? targetName : undefined;
    const value = after?.[field] ?? fallback;
    return isEmptyPresentationValue(value) ? [] : [[field, value] as const];
  });
  const optionalFields: ReadonlyArray<readonly [string, unknown]> = availableInOriginChannel
    ? [['availableIn', 'This Channel'] as const]
    : [];
  const fields = [...identityFields, ...optionalFields];
  return [
    dialect.bold('New Agent'),
    fields.map(([field, value]) => [
      dialect.bold(presentationFieldLabel(field)),
      quoteValue(value, dialect),
    ].join('\n')).join('\n\n'),
  ].join('\n');
}

function formatOperationSection(
  targetName: string,
  operationKind: ManagementChangeSetPreview['changes'][number]['operationKind'],
  dialect: ChangeSetPresentationDialect,
): string {
  return dialect.bold(
    `${dialect.escape(targetName)} — ${presentationOperationLabel(operationKind)}`,
  );
}

function presentationOperationLabel(operationKind: string): string {
  return PRESENTATION_OPERATION_LABELS[operationKind] ?? operationKind
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function changedPresentationFields(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): string[] {
  if (!before && !after) return [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys]
    .filter((key) => !INTERNAL_PROPOSAL_FIELDS.has(key))
    .filter((key) => !presentationValuesEqual(before?.[key], after?.[key]))
    .sort((left, right) => {
      const leftIndex = PROPOSAL_FIELD_ORDER.indexOf(left);
      const rightIndex = PROPOSAL_FIELD_ORDER.indexOf(right);
      if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    });
}

function creationPreview(preview: ManagementChangeSetPreview): {
  creation: ManagementChangeSetPreview['changes'][number];
  originGrant?: ManagementChangeSetPreview['changes'][number];
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

function presentationFieldLabel(field: string): string {
  return PRESENTATION_FIELD_LABELS[field] ?? field
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (value) => value.toUpperCase());
}

function quoteValue(value: unknown, dialect: ChangeSetPresentationDialect): string {
  const rendered = isEmptyPresentationValue(value)
    ? '(not set)'
    : typeof value === 'string'
      ? value
      : JSON.stringify(value, null, 2) ?? String(value);
  return rendered
    .split(/\r?\n/)
    .map((line) => `> ${dialect.escape(line)}`)
    .join('\n');
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function presentationRecord(
  operationKind: ManagementChangeSetPreview['changes'][number]['operationKind'],
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
