import {
  escapeSlackControlCharacters,
  slackMarkdownBlockTextLimit,
} from '../slack/message-format.ts';
import type { ManagementChangeSetPreview } from './types.ts';

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

const PROPOSAL_HEADER = '*Proposed changes*';
const CREATE_HEADER = '*Ready to create*';
const APPROVAL_INSTRUCTION =
  'Reply `approve` to apply these exact changes, or tell me what to adjust.';
const CREATE_APPROVAL_INSTRUCTION =
  'Reply `create it` to create this Agent and publish its Slack handle, or tell me what to adjust.';
const TRUNCATED_APPROVAL_INSTRUCTION =
  'Reply `approve` to apply the full proposed changes, or tell me what to adjust.';
const TRUNCATED_CREATE_APPROVAL_INSTRUCTION =
  'Reply `create it` to create the full Agent and publish its Slack handle, or tell me what to adjust.';
const TRUNCATION_NOTICE =
  '_Preview truncated to fit Slack. Approval applies the full proposed changes._';

export function formatSlackChangeSetProposal(preview: ManagementChangeSetPreview): string {
  return formatSlackProposal(preview, []);
}

export function formatSlackSkillImportProposal(
  preview: ManagementChangeSetPreview,
  sourceUrl: string,
): string {
  return formatSlackProposal(preview, [
    ['*Source*', quoteSlackValue(sourceUrl)].join('\n'),
  ]);
}

function formatSlackProposal(
  preview: ManagementChangeSetPreview,
  leadingSections: readonly string[],
): string {
  const creation = slackCreationPreview(preview);
  const creationOnly = creation !== undefined;
  const header = creationOnly ? CREATE_HEADER : PROPOSAL_HEADER;
  const approvalInstruction = creationOnly
    ? CREATE_APPROVAL_INSTRUCTION
    : APPROVAL_INSTRUCTION;
  const truncatedApprovalInstruction = creationOnly
    ? TRUNCATED_CREATE_APPROVAL_INSTRUCTION
    : TRUNCATED_APPROVAL_INSTRUCTION;
  const sections = preview.changes.flatMap((change) => {
    if (creation?.originGrant === change) return [];
    const before = presentationRecord(change.operationKind, change.before);
    const after = presentationRecord(change.operationKind, change.after);
    const targetName = stringValue(after?.name) ?? stringValue(before?.name) ?? change.target;
    if (change.operationKind === 'create_agent') {
      return [formatSlackNewAgentSection(after, targetName, creation?.originGrant !== undefined)];
    }
    const fields = changedPresentationFields(before, after);
    if (fields.length === 0) {
      return [formatSlackOperationSection(targetName, change.operationKind)];
    }
    return fields.flatMap((field) => {
      if (field === 'skills') {
        return formatSlackSkillChangeSections(
          targetName,
          before?.[field],
          after?.[field],
          change.before !== undefined,
        );
      }
      return [formatSlackChangeSection(
        targetName,
        presentationFieldLabel(field),
        before?.[field],
        after?.[field],
        change.before !== undefined,
      )];
    });
  });
  const body = [...leadingSections, ...sections].join('\n\n');
  const fullPresentation = [
    header,
    ...(body ? [body, ''] : []),
    approvalInstruction,
  ].join('\n');
  if (fullPresentation.length <= slackMarkdownBlockTextLimit) {
    return fullPresentation;
  }

  const prefix = `${header}\n`;
  const suffix = `\n\n${TRUNCATION_NOTICE}\n\n${truncatedApprovalInstruction}`;
  const availableBodyLength = slackMarkdownBlockTextLimit - prefix.length - suffix.length;
  return `${prefix}${body.slice(0, availableBodyLength).trimEnd()}${suffix}`;
}

function formatSlackSkillChangeSections(
  targetName: string,
  before: unknown,
  after: unknown,
  compare: boolean,
): string[] {
  const beforeSkills = skillPresentationRecords(before);
  const afterSkills = skillPresentationRecords(after);
  if (!beforeSkills || !afterSkills) {
    return [formatSlackChangeSection(
      targetName,
      presentationFieldLabel('skills'),
      before,
      after,
      compare,
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
  return changedNames.map((name) => formatSlackSkillChangeSection(
    targetName,
    name,
    beforeByName.get(name),
    afterByName.get(name),
  ));
}

function formatSlackSkillChangeSection(
  targetName: string,
  skillName: string,
  before: SkillPresentationRecord | undefined,
  after: SkillPresentationRecord | undefined,
): string {
  const heading = `*${escapeSlackControlCharacters(targetName)} — Skill: ${
    escapeSlackControlCharacters(skillName)
  }*`;
  if (!before && after) {
    return [heading, '*Add*', formatSlackSkillDetails(after)].join('\n');
  }
  if (before && !after) {
    return [heading, '*Remove*', formatSlackSkillDetails(before)].join('\n');
  }
  return [
    heading,
    '*Replace*',
    '*Before*',
    formatSlackSkillDetails(before!),
    '*After*',
    formatSlackSkillDetails(after!),
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

function formatSlackSkillDetails(skill: SkillPresentationRecord): string {
  return [
    ...(skill.enabled === undefined
      ? []
      : ['*Status*', quoteSlackValue(skill.enabled ? 'Enabled' : 'Disabled')]),
    '*Description*',
    quoteSlackExcerpt(skill.description, 600),
    '*Instructions*',
    quoteSlackExcerpt(skill.instructions, 1_600),
  ].join('\n');
}

function quoteSlackExcerpt(value: string, limit: number): string {
  const truncated = value.length > limit;
  const excerpt = truncated ? value.slice(0, limit).trimEnd() : value;
  return [
    quoteSlackValue(excerpt),
    ...(truncated
      ? [`> _… ${value.length - excerpt.length} more characters; approval applies the full skill._`]
      : []),
  ].join('\n');
}

function formatSlackChangeSection(
  targetName: string,
  fieldLabel: string,
  before: unknown,
  after: unknown,
  compare: boolean,
): string {
  if (!compare) {
    return [
      `*${escapeSlackControlCharacters(targetName)} — ${fieldLabel}*`,
      quoteSlackValue(after),
    ].join('\n');
  }
  return [
    `*${escapeSlackControlCharacters(targetName)} — ${fieldLabel}*`,
    '*Before*',
    quoteSlackValue(before),
    '*After*',
    quoteSlackValue(after),
  ].join('\n');
}

function formatSlackNewAgentSection(
  after: Record<string, unknown> | undefined,
  targetName: string,
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
    '*New Agent*',
    fields.map(([field, value]) => [
      `*${presentationFieldLabel(field)}*`,
      quoteSlackValue(value),
    ].join('\n')).join('\n\n'),
  ].join('\n');
}

function formatSlackOperationSection(
  targetName: string,
  operationKind: ManagementChangeSetPreview['changes'][number]['operationKind'],
): string {
  return `*${escapeSlackControlCharacters(targetName)} — ${presentationOperationLabel(operationKind)}*`;
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

function slackCreationPreview(preview: ManagementChangeSetPreview): {
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

function quoteSlackValue(value: unknown): string {
  const rendered = isEmptyPresentationValue(value)
    ? '(not set)'
    : typeof value === 'string'
      ? value
      : JSON.stringify(value, null, 2) ?? String(value);
  return rendered
    .split(/\r?\n/)
    .map((line) => `> ${escapeSlackControlCharacters(line)}`)
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
