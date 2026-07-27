import type {
  RoutineConfirmationDraft,
  RoutineDefinition,
  RoutineRun,
} from './types.ts';

export function renderRoutineList(
  routines: readonly RoutineDefinition[],
  channelId: string,
): string {
  const visible = routines.filter((routine) => routine.deletedAt === null);
  if (visible.length === 0) {
    return `No routines are configured for <#${channelId}>.`;
  }
  return [
    `*Routines for <#${channelId}>*`,
    ...visible.map((routine) =>
      `• *${escapeSlack(routine.name)}* — ${routine.state} — \`${routine.scheduleInput}\` (${routine.timezone}) — \`${routine.id}\``,
    ),
    '',
    'Use `!routines show <id>` for details.',
  ].join('\n');
}

export function renderRoutineDetail(routine: RoutineDefinition, runs: readonly RoutineRun[]): string {
  const next = routine.nextRunAt === null ? 'none' : formatInstant(routine.nextRunAt, routine.timezone);
  const recent = runs.slice(0, 5);
  return [
    `*${escapeSlack(routine.name)}* — \`${routine.id}\``,
    escapeSlack(routine.description || routine.taskText),
    `State: *${routine.state}*`,
    `Schedule: \`${routine.scheduleInput}\` (${routine.timezone})`,
    `Next occurrence: ${next}`,
    'Authority: current channel access, connections, profile, repositories, and credentials are resolved again for every run.',
    recent.length > 0 ? '*Recent occurrences*' : '*Recent occurrences:* none',
    ...recent.map((run) =>
      `• ${formatInstant(run.scheduledFor, routine.timezone)} — ${run.status}${run.publicError ? ` — ${escapeSlack(run.publicError)}` : ''}`,
    ),
  ].join('\n');
}

export function renderRoutineConfirmation(input: {
  draft: RoutineConfirmationDraft;
  token: string;
  expiresAt: number;
  timezoneDefaulted?: boolean;
  creatorUserId?: string;
}): string {
  if (input.draft.action === 'delete') {
    return [
      `Delete routine \`${input.draft.routineId}\`?`,
      'Its saved task body will be scrubbed. Body-free run and audit metadata remain for up to 365 days, while Flue may retain its separate execution history.',
      `Confirm with \`!routines confirm ${input.token}\` or cancel with \`!routines cancel ${input.token}\`.`,
    ].join('\n');
  }
  const { definition } = input.draft;
  return [
    `*${input.draft.action === 'create' ? 'Create' : 'Edit'} routine preview*`,
    `Name: *${escapeSlack(definition.name)}*`,
    `Schedule: \`${definition.scheduleInput}\` (${definition.timezone})${input.timezoneDefaulted ? ' — proposed from your Slack profile, or UTC when unavailable' : ''}`,
    `Next three: ${input.draft.reservations.slice(0, 3).map((item) => formatInstant(item.windowStart, definition.timezone)).join(' · ')}`,
    ...(input.creatorUserId ? [`Creator: <@${input.creatorUserId}>`] : []),
    `Task: ${escapeSlack(definition.taskText)}`,
    `Output: ${definition.outputPolicy === 'post_on_change' ? 'post only when the change key changes' : 'post every successful result'}`,
    'Authority: this routine uses this channel\'s current Chickpea access each time it runs. Membership, profile, connections, repositories, and credentials are rechecked at run time.',
    'Resource limits: at most one active occurrence for this routine; deployment-wide run, model, tool, and sandbox ceilings also apply.',
    'Tools that require a separate just-in-time human confirmation cannot run unattended; that occurrence fails safely.',
    'The routine may perform writes when this saved task requests them. Untrusted history, memory, fetched content, and trigger data cannot widen the saved task.',
    `Confirm within 15 minutes with \`!routines confirm ${input.token}\` or cancel with \`!routines cancel ${input.token}\`.`,
  ].join('\n');
}

export function renderRoutineCreated(routine: RoutineDefinition): string {
  return [
    `Routine *${escapeSlack(routine.name)}* is ${routine.state}.`,
    `ID: \`${routine.id}\``,
    `Schedule: \`${routine.scheduleInput}\` (${routine.timezone})`,
    'Controls: `!routines show <id>`, `pause`, `resume`, `disable`, `run`, `clone`, or `delete`.',
  ].join('\n');
}

export function renderRoutineHelp(): string {
  return [
    '*Routine controls*',
    '`!routines` or `!routines <#channel>`',
    '`!routines show <id>`',
    '`!routines pause|resume|disable|run|clone|delete <id>`',
    '`!routines confirm|cancel <token>`',
    'To create or edit one, ask naturally—for example: “Every weekday at 9am America/Los_Angeles, summarize new support requests and post the digest here.”',
  ].join('\n');
}

function formatInstant(timestamp: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(timestamp);
  } catch {
    return new Date(timestamp).toISOString();
  }
}

function escapeSlack(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
