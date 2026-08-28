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
  'slackPresence',
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

const PRESENTATION_FIELD_LABELS: Readonly<Record<string, string>> = {
  apiConnections: 'API Connections',
  mcpServers: 'MCP Servers',
  slackPresence: 'Slack Presence',
  editPolicy: 'Editing Authority',
  requestedHandle: 'Slack Handle',
  ownerAgent: 'Agent',
  taskText: 'Task',
  schedule: 'Schedule',
  timezone: 'Timezone',
  destination: 'Destination',
  delivery: 'Delivery',
};

const PROPOSAL_HEADER = '*Proposed changes*';
const APPROVAL_INSTRUCTION =
  'Reply `approve` to apply these exact changes, or tell me what to adjust.';
const TRUNCATED_APPROVAL_INSTRUCTION =
  'Reply `approve` to apply the full proposed changes, or tell me what to adjust.';
const TRUNCATION_NOTICE =
  '_Preview truncated to fit Slack. Approval applies the full proposed changes._';

export function formatSlackChangeSetProposal(preview: ManagementChangeSetPreview): string {
  const sections = preview.changes.flatMap((change) => {
    const before = recordValue(change.before);
    const after = recordValue(change.after);
    const targetName = stringValue(after?.name) ?? stringValue(before?.name) ?? change.target;
    const fields = changedPresentationFields(before, after);
    if (fields.length === 0) {
      return [formatSlackChangeSection(targetName, 'Change', change.before, change.after)];
    }
    return fields.map((field) => formatSlackChangeSection(
      targetName,
      presentationFieldLabel(field),
      before?.[field],
      after?.[field],
    ));
  });
  const body = sections.join('\n\n');
  const fullPresentation = [
    PROPOSAL_HEADER,
    body,
    '',
    APPROVAL_INSTRUCTION,
  ].join('\n');
  if (fullPresentation.length <= slackMarkdownBlockTextLimit) {
    return fullPresentation;
  }

  const prefix = `${PROPOSAL_HEADER}\n`;
  const suffix = `\n\n${TRUNCATION_NOTICE}\n\n${TRUNCATED_APPROVAL_INSTRUCTION}`;
  const availableBodyLength = slackMarkdownBlockTextLimit - prefix.length - suffix.length;
  return `${prefix}${body.slice(0, availableBodyLength).trimEnd()}${suffix}`;
}

function formatSlackChangeSection(
  targetName: string,
  fieldLabel: string,
  before: unknown,
  after: unknown,
): string {
  return [
    `*${escapeSlackControlCharacters(targetName)} — ${fieldLabel}*`,
    '*Before*',
    quoteSlackValue(before),
    '*After*',
    quoteSlackValue(after),
  ].join('\n');
}

function changedPresentationFields(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): string[] {
  if (!before && !after) return [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys]
    .filter((key) => !INTERNAL_PROPOSAL_FIELDS.has(key))
    .filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]))
    .sort((left, right) => {
      const leftIndex = PROPOSAL_FIELD_ORDER.indexOf(left);
      const rightIndex = PROPOSAL_FIELD_ORDER.indexOf(right);
      if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    });
}

function presentationFieldLabel(field: string): string {
  return PRESENTATION_FIELD_LABELS[field] ?? field
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (value) => value.toUpperCase());
}

function quoteSlackValue(value: unknown): string {
  const rendered = value === undefined || value === ''
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

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
