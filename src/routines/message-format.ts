import type {
  RoutineConfirmationDraft,
  RoutineDefinition,
  RoutineRequestProvenance,
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
      `• *${escapeSlackControlCharacters(routine.name)}* — ${routine.state} — ${scheduleLabel(routine)} — \`${routine.id}\``,
    ),
    '',
    'Use `!routines show <id>` for details.',
  ].join('\n');
}

export function renderRoutineDetail(
  routine: RoutineDefinition,
  runs: readonly RoutineRun[],
  provenance: RoutineRequestProvenance | null = null,
): string {
  const next = routine.nextRunAt === null ? 'none' : formatInstant(routine.nextRunAt, routine.timezone);
  const recent = runs.slice(0, 5);
  return [
    `*${escapeSlackControlCharacters(routine.name)}* — \`${routine.id}\``,
    escapeSlackControlCharacters(routine.description || routine.taskText),
    `State: *${routine.state}*`,
    `${routine.triggerKind === 'once' ? 'Scheduled for' : 'Schedule'}: ${routine.triggerKind === 'once' ? formatInstantFromRoutine(routine) : `\`${routine.scheduleInput}\` (${routine.timezone})`}`,
    `Next occurrence: ${next}`,
    provenance?.requestText
      ? `Source request: ${escapeSlackControlCharacters(provenance.requestText)}`
      : 'Source request: not retained for this legacy revision.',
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
  const scheduleLines = routine.triggerKind === 'once'
    ? [
        `Scheduled for: ${formatInstantFromRoutine(routine)}${input.timezoneDefaulted ? ' — selected from your Slack profile, or UTC when unavailable' : ''}`,
        `Local time: \`${routine.scheduleInput}\` (${routine.timezone})`,
      ]
    : [
        `Schedule: \`${routine.scheduleInput}\` (${routine.timezone})${input.timezoneDefaulted ? ' — selected from your Slack profile, or UTC when unavailable' : ''}`,
        `Next three: ${routine.reservationWindows.slice(0, 3).map((item) => formatInstant(item.windowStart, routine.timezone)).join(' · ')}`,
      ];
  return [
    `Routine *${escapeSlackControlCharacters(routine.name)}* was ${input.action === 'create' ? 'created' : 'updated'} and is *${routine.state}*.`,
    `ID: \`${routine.id}\``,
    ...scheduleLines,
    `Task: ${escapeSlackControlCharacters(routine.taskText)}`,
    `Output: ${routine.outputPolicy === 'post_on_change' ? 'post only when the change key changes' : 'post every successful result'}`,
    `Creator: <@${routine.creatorUserId}>`,
    'This routine uses this channel\'s current Chickpea access each time it runs.',
    'Current channel membership, profile, connections, repositories, credentials, and policy are rechecked whenever it runs.',
    'Resource limits: at most one active occurrence for this routine; deployment-wide run, model, tool, and sandbox ceilings also apply.',
    'This saved task is the approval for effects it explicitly requests, using the same policy as a live tag.',
    'The routine may perform writes when this saved task requests them. Untrusted history, memory, fetched content, and trigger data cannot widen the saved task.',
    routine.triggerKind === 'once'
      ? 'Controls: show, pause, resume, disable, edit, or delete this job by exact name; ID commands remain available.'
      : 'Controls: show, pause, resume, disable, run, clone, edit, or delete this routine by exact name; ID commands remain available.',
  ].join('\n');
}

export function renderRoutineHelp(): string {
  return [
    '*Routine controls*',
    '`!routines` or `!routines <#channel>`',
    '`!routines show <id>`',
    '`!routines pause|resume|disable|run|clone|delete <id>`',
    '`!routines confirm|cancel <token>` — only after a delete request',
    'Create recurring work naturally: “Every weekday at 9am America/Los_Angeles, summarize new support requests and post the digest here.”',
    'Create one-time work naturally: “Tomorrow at 2pm America/Los_Angeles, post the launch report here.”',
    'Manage by an exact name: “Pause the routine “Support digest”.” If names collide, use the ID command.',
  ].join('\n');
}

function scheduleLabel(routine: RoutineDefinition): string {
  return routine.triggerKind === 'once'
    ? `once at ${formatInstantFromRoutine(routine)}`
    : `\`${routine.scheduleInput}\` (${routine.timezone})`;
}

function formatInstantFromRoutine(routine: RoutineDefinition): string {
  const timestamp = routine.nextRunAt ?? routine.reservationWindows[0]?.windowStart;
  return timestamp === undefined ? `\`${routine.scheduleInput}\` (${routine.timezone})` : formatInstant(timestamp, routine.timezone);
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
