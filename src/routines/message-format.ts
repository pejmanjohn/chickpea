import type {
  RoutineConfirmationDraft,
  RoutineDefinition,
  RoutineRun,
} from './types.ts';
import { escapeSlackControlCharacters } from '../slack/message-format.ts';

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
      `• *${escapeSlackControlCharacters(routine.name)}* — ${routine.state} — \`${routine.scheduleInput}\` (${routine.timezone}) — \`${routine.id}\``,
    ),
    '',
    'Use `!routines show <id>` for details.',
  ].join('\n');
}

export function renderRoutineDetail(routine: RoutineDefinition, runs: readonly RoutineRun[]): string {
  const next = routine.nextRunAt === null ? 'none' : formatInstant(routine.nextRunAt, routine.timezone);
  const recent = runs.slice(0, 5);
  return [
    `*${escapeSlackControlCharacters(routine.name)}* — \`${routine.id}\``,
    escapeSlackControlCharacters(routine.description || routine.taskText),
    `State: *${routine.state}*`,
    `Schedule: \`${routine.scheduleInput}\` (${routine.timezone})`,
    `Next occurrence: ${next}`,
    'Authority: current channel access, connections, profile, repositories, and credentials are resolved again for every run.',
    recent.length > 0 ? '*Recent occurrences*' : '*Recent occurrences:* none',
    ...recent.map((run) =>
      `• ${formatInstant(run.scheduledFor, routine.timezone)} — ${run.status}${run.publicError ? ` — ${escapeSlackControlCharacters(run.publicError)}` : ''}`,
    ),
  ].join('\n');
}

export function renderRoutineDeletionConfirmation(input: {
  draft: Extract<RoutineConfirmationDraft, { action: 'delete' }>;
  token: string;
}): string {
  return [
    `Delete routine \`${input.draft.routineId}\`?`,
    'Its saved task body will be scrubbed. Body-free run and audit metadata remain for up to 365 days, while Flue may retain its separate execution history.',
    `Confirm with \`!routines confirm ${input.token}\` or cancel with \`!routines cancel ${input.token}\`.`,
  ].join('\n');
}

export function renderRoutineSaved(
  routine: RoutineDefinition,
  input: { action: 'create' | 'edit'; timezoneDefaulted?: boolean },
): string {
  return [
    `Routine *${escapeSlackControlCharacters(routine.name)}* was ${input.action === 'create' ? 'created' : 'updated'} and is *${routine.state}*.`,
    `ID: \`${routine.id}\``,
    `Schedule: \`${routine.scheduleInput}\` (${routine.timezone})${input.timezoneDefaulted ? ' — selected from your Slack profile, or UTC when unavailable' : ''}`,
    `Next three: ${routine.reservationWindows.slice(0, 3).map((item) => formatInstant(item.windowStart, routine.timezone)).join(' · ')}`,
    `Task: ${escapeSlackControlCharacters(routine.taskText)}`,
    `Output: ${routine.outputPolicy === 'post_on_change' ? 'post only when the change key changes' : 'post every successful result'}`,
    `Creator: <@${routine.creatorUserId}>`,
    'This routine uses this channel\'s current Chickpea access each time it runs.',
    'Current channel membership, profile, connections, repositories, credentials, and policy are rechecked whenever it runs.',
    'Resource limits: at most one active occurrence for this routine; deployment-wide run, model, tool, and sandbox ceilings also apply.',
    'Tools that require separate just-in-time human confirmation cannot run unattended; that occurrence fails safely.',
    'The routine may perform writes when this saved task requests them. Untrusted history, memory, fetched content, and trigger data cannot widen the saved task.',
    'Controls: `!routines show <id>`, `pause`, `resume`, `disable`, `run`, `clone`, or `delete`.',
  ].join('\n');
}

export function renderRoutineHelp(): string {
  return [
    '*Routine controls*',
    '`!routines` or `!routines <#channel>`',
    '`!routines show <id>`',
    '`!routines pause|resume|disable|run|clone|delete <id>`',
    '`!routines confirm|cancel <token>` — only after a delete request',
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
