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
    return `**Scheduled work for <#${channelId}>**\n\nNo routines are configured for this channel.`;
  }
  return [
    `**Scheduled work for <#${channelId}>**`,
    '',
    ...visible.flatMap((routine) => [
      `- **${escapeSlackControlCharacters(routine.name)}** · ${stateLabel(routine.state)}`,
      `  **Schedule:** ${scheduleLabel(routine)}`,
      `  **Next:** ${routine.nextRunAt === null ? 'None' : formatInstant(routine.nextRunAt, routine.timezone)}`,
      `  **ID:** \`${routine.id}\``,
    ]),
    '',
    'Use `!routines show <id>` to inspect one.',
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
    '**Routine details**',
    `**${escapeSlackControlCharacters(routine.name)}** · ${stateLabel(routine.state)}`,
    '',
    `**Description:** ${escapeSlackControlCharacters(routine.description || routine.taskText)}`,
    `**${routine.triggerKind === 'once' ? 'Scheduled for' : 'Schedule'}:** ${scheduleLabel(routine)}`,
    `**Next occurrence:** ${next}`,
    `**Task:** ${escapeSlackControlCharacters(routine.taskText)}`,
    `**Output:** ${outputPolicyLabel(routine.outputPolicy)}`,
    `**ID:** \`${routine.id}\``,
    '',
    provenance?.requestText
      ? `**Source request:** ${escapeSlackControlCharacters(provenance.requestText)}`
      : '**Source request:** Not retained for this legacy revision.',
    '**Authority:** Current Channel access, connections, Agent, repositories, and credentials are resolved again for every run.',
    '',
    recent.length > 0 ? '**Recent occurrences**' : '**Recent occurrences:** None',
    ...recent.map((run) =>
      `- ${formatInstant(run.scheduledFor, routine.timezone)} · ${stateLabel(run.status)}${run.publicError ? ` · ${escapeSlackControlCharacters(run.publicError)}` : ''}`,
    ),
  ].join('\n');
}

export function renderRoutineDeletionConfirmation(input: {
  draft: Extract<RoutineConfirmationDraft, { action: 'delete' }>;
  token: string;
}): string {
  return [
    '⚠️ **Delete routine?**',
    `**ID:** \`${input.draft.routineId}\``,
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
        `**Scheduled for:** ${formatInstantFromRoutine(routine)}${input.timezoneDefaulted ? ' · Timezone selected from your Slack profile, or UTC when unavailable' : ''}`,
      ]
    : [
        `**Schedule:** ${scheduleLabel(routine)}${input.timezoneDefaulted ? ' · Timezone selected from your Slack profile, or UTC when unavailable' : ''}`,
        `**Next runs:** ${routine.reservationWindows.slice(0, 3).map((item) => formatInstant(item.windowStart, routine.timezone)).join(' · ')}`,
      ];
  return [
    `${input.action === 'create' ? '✅ **Routine created**' : '✏️ **Routine updated**'}`,
    `**${escapeSlackControlCharacters(routine.name)}** · ${stateLabel(routine.state)}`,
    '',
    ...scheduleLines,
    `**Task:** ${escapeSlackControlCharacters(routine.taskText)}`,
    `**Output:** ${outputPolicyLabel(routine.outputPolicy)}`,
    `**ID:** \`${routine.id}\``,
  ].join('\n');
}

export function renderRoutineHelp(): string {
  return [
    '**Routine controls**',
    '`!routines` or `!routines <#channel>`',
    '`!routines show <id>`',
    '`!routines pause|resume|disable|run|clone|delete <id>`',
    '`!routines confirm|cancel <token>` — only after a delete request',
    '',
    '**Create naturally**',
    '“Every weekday at 9am Pacific, summarize new support requests and post the digest here.”',
    '“Tomorrow at 2pm PT, post the launch report here.”',
    'You can also use an exact IANA timezone such as `America/Los_Angeles`.',
    'Recurring schedules must be at least five minutes apart.',
    '',
    '**How routines run**',
    'The saved task can request the same actions as a live tag in its Channel. Current membership, Agent, connections, repositories, credentials, policy, and resource limits are rechecked for each run.',
    'Manage by an exact name: “Pause the routine “Support digest”.” If names collide, use the ID command.',
  ].join('\n');
}

function scheduleLabel(routine: RoutineDefinition): string {
  return routine.triggerKind === 'once'
    ? formatInstantFromRoutine(routine)
    : humanRecurringSchedule(routine.scheduleInput, routine.timezone);
}

function humanRecurringSchedule(expression: string, timezone: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return `\`${expression}\` · ${timezone}`;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const zone = timezoneLabel(timezone);
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const step = /^\*\/(\d+)$/.exec(minute ?? '');
    if (step && hour === '*') return `Every ${Number(step[1])} minutes · ${zone}`;
    if (/^\d+$/.test(minute ?? '') && hour === '*') {
      return Number(minute) === 0
        ? `Every hour · ${zone}`
        : `Hourly at :${String(minute).padStart(2, '0')} · ${zone}`;
    }
  }
  if (/^\d+$/.test(minute ?? '') && /^\d+$/.test(hour ?? '') && dayOfMonth === '*' && month === '*') {
    const at = formatClock(Number(hour), Number(minute));
    if (dayOfWeek === '*') return `Every day at ${at} ${zone}`;
    if (dayOfWeek === '1-5') return `Weekdays at ${at} ${zone}`;
    if (dayOfWeek === '0,6' || dayOfWeek === '6,0') return `Weekends at ${at} ${zone}`;
    if (/^[0-6]$/.test(dayOfWeek ?? '')) return `Every ${weekdayName(Number(dayOfWeek))} at ${at} ${zone}`;
  }
  return `\`${expression}\` · ${zone} (\`${timezone}\`)`;
}

function formatClock(hour: number, minute: number): string {
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function weekdayName(day: number): string {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day] ?? String(day);
}

function timezoneLabel(timezone: string): string {
  const common: Record<string, string> = {
    'America/Los_Angeles': 'Pacific',
    'America/Denver': 'Mountain',
    'America/Chicago': 'Central',
    'America/New_York': 'Eastern',
    UTC: 'UTC',
  };
  return common[timezone] ?? timezone;
}

function stateLabel(state: string): string {
  return state.length === 0 ? state : `${state[0]!.toUpperCase()}${state.slice(1).replaceAll('_', ' ')}`;
}

function outputPolicyLabel(policy: RoutineDefinition['outputPolicy']): string {
  return policy === 'post_on_change' ? 'Only when the result changes' : 'Every successful result';
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
