import { CHICKPEA_AGENT_ID } from '../config/agent-id.ts';
import { scheduleActionId } from '../routines/ids.ts';
import {
  assertRoutineTaskBoundToSource,
  normalizeAuthorityText,
} from '../routines/provenance.ts';
import { SlackScheduleCommandError } from '../routines/slack-command.ts';
import {
  RoutineStateError,
  type RoutineDefinition,
  type RoutineScheduleAction,
  type RoutineScheduleActionResult,
  type RoutineStore,
} from '../routines/types.ts';
import {
  managementActorOriginKey,
  managementOperationDigest,
  managementStorageIdempotencyKey,
  validateManagementOperations,
} from './contracts.ts';
import { reconcileScheduleActionReceipts } from './receipts.ts';
import type { WorkspaceManagementService } from './service.ts';
import type { ManagementStore } from './store.ts';
import {
  ManagementError,
  type ManagementActorContext,
  type ManagementOperation,
  type ManagementRequestRecord,
} from './types.ts';
import type { SlackManagementSignal } from './slack-tools.ts';

const ACTION_LEASE_MS = 30_000;
const ACTION_MAX_ATTEMPTS = 3;

export type SlackScheduleManagementOperation = Extract<ManagementOperation, {
  kind: 'save_routine' | 'control_routine' | 'run_routine';
}>;

export type SlackScheduleActionOutcome =
  | RoutineScheduleActionResult
  | { outcome: 'pending'; actionId: string };

export interface SlackScheduleActionRpcRequest {
  signal: SlackManagementSignal;
  operation: SlackScheduleManagementOperation;
}

export interface SlackScheduleActionDependencies {
  management: ManagementStore;
  routines: RoutineStore;
  service: WorkspaceManagementService;
  now?: () => number;
  owner?: string;
}

/** Admit and attempt one first-class Slack scheduling action. */
export async function invokeSlackScheduleAction(input: {
  signal: SlackManagementSignal;
  context: ManagementActorContext;
  operation: SlackScheduleManagementOperation;
  dependencies: SlackScheduleActionDependencies;
}): Promise<SlackScheduleActionOutcome> {
  const now = input.dependencies.now ?? Date.now;
  const operation = validateStandaloneScheduleOperation(input.signal, input.operation);
  const [schemaValidated] = validateManagementOperations([operation]) as [SlackScheduleManagementOperation];
  const validated = await bindScheduleOperationToRequester(
    input.signal,
    schemaValidated,
    input.dependencies.routines,
    now(),
  );
  const digest = managementOperationDigest([validated]);
  const actionId = scheduleActionId(input.signal.turnJobId, digest);
  const publicIdempotencyKey = `schedule-action:${actionId}`;
  const storageIdempotencyKey = managementStorageIdempotencyKey(
    input.context,
    publicIdempotencyKey,
  );
  const at = now();
  const request = await input.dependencies.management.reserveRequest({
    operationId: `management_${actionId}`,
    organizationId: input.context.organizationId,
    actorUserId: input.context.userId,
    actorMembershipId: input.context.membershipId,
    originKey: managementActorOriginKey(input.context),
    idempotencyKey: storageIdempotencyKey,
    digest,
    operations: [validated],
    at,
  });
  const action = await input.dependencies.routines.reserveScheduleAction({
    actionId,
    actionDigest: digest,
    requestOperationId: request.request.operationId,
    workspaceId: input.signal.workspaceId,
    actorUserId: input.context.userId,
    actorMembershipId: input.context.membershipId,
    agentId: input.signal.agentId,
    conversationKind: input.signal.conversationKind === 'im' ? 'im' : 'channel',
    channelId: input.signal.channelId,
    threadTs: input.signal.threadTs,
    messageTs: input.signal.messageTs,
    at,
  });
  if (action.status !== 'pending') {
    await reconcileReceipts(input.dependencies, now());
    return action.result!;
  }

  const owner = input.dependencies.owner ?? `foreground:${input.signal.turnJobId}`;
  const claim = await input.dependencies.routines.claimScheduleAction({
    actionId,
    owner,
    at: now(),
    leaseUntil: now() + ACTION_LEASE_MS,
  });
  if (claim.outcome === 'terminal') {
    await reconcileReceipts(input.dependencies, now());
    return claim.action.result!;
  }
  if (claim.outcome === 'pending') {
    await reconcileReceipts(input.dependencies, now());
    return { outcome: 'pending', actionId };
  }

  const settled = await applyClaimedScheduleAction({
    action: claim.action,
    operation: validated,
    context: input.context,
    publicIdempotencyKey,
    dependencies: input.dependencies,
    now,
  });
  await reconcileReceipts(input.dependencies, now());
  return settled.status === 'pending'
    ? { outcome: 'pending', actionId }
    : settled.result!;
}

/**
 * The schedule tool input is model-authored. Bind a new or changed task to the
 * trusted current Slack request before it can enter the durable action ledger.
 * A cadence-only edit may retain the task from the current routine revision.
 */
async function bindScheduleOperationToRequester(
  signal: SlackManagementSignal,
  operation: SlackScheduleManagementOperation,
  routines: Pick<RoutineStore, 'getRoutine' | 'listRoutines'>,
  at: number,
): Promise<SlackScheduleManagementOperation> {
  const requestText = signal.requesterText?.trim();
  if (!requestText) {
    throw new ManagementError(
      'invalid_request',
      'Scheduled work requires the trusted current Slack request.',
    );
  }
  if (operation.kind !== 'save_routine') {
    await requireRoutineActionAuthority(signal, operation, routines, requestText);
    return operation;
  }

  let previous: RoutineDefinition | undefined;
  if (operation.routineId) previous = await routines.getRoutine(operation.routineId);

  const taskMatchesPrevious = previous !== undefined &&
    normalizeAuthorityText(operation.taskText) === normalizeAuthorityText(previous.taskText);
  const taskMatchesRequest = routineTaskMatchesRequest(operation.taskText, requestText);
  if (!taskMatchesRequest && !taskMatchesPrevious) {
    throw new ManagementError(
      'invalid_request',
      'The scheduled task must be explicitly present in the current Slack request.',
    );
  }

  let bound = taskMatchesPrevious && previous
    ? { ...operation, taskText: previous.taskText }
    : operation;
  let cadenceChanged = false;
  let outputPolicyChanged = false;

  if (!previous) {
    requireScheduleAuthority(bound.schedule, bound.timezone, requestText, at, false);
    if (bound.schedule.kind !== 'in' && !requestMentionsAnyTimezone(requestText)) {
      throw new ManagementError(
        'invalid_request',
        'Recurring and wall-clock schedules require an explicit timezone in the current Slack request.',
      );
    }
    requireCompatibleNamedTimezone(bound.timezone, requestText, false);
  } else {
    if (bound.timezone !== previous.timezone) {
      if (requestNamesTimezone(requestText, bound.timezone, true)) {
        cadenceChanged = true;
      } else if (requestMentionsAnyTimezone(requestText)) {
        throw new ManagementError(
          'invalid_request',
          'The requested schedule timezone does not match the current Slack request.',
        );
      } else {
        bound = { ...bound, timezone: previous.timezone };
      }
    } else {
      requireCompatibleNamedTimezone(bound.timezone, requestText, true);
    }

    if (!scheduleMatchesPrevious(bound.schedule, previous)) {
      requireScheduleAuthority(bound.schedule, bound.timezone, requestText, at, true);
      cadenceChanged = true;
    }
  }

  const requestedOutputPolicy = outputPolicyFromRequest(requestText);
  if (!previous) {
    if (
      requestedOutputPolicy !== undefined &&
      requestedOutputPolicy !== bound.outputPolicy
    ) {
      throw new ManagementError(
        'invalid_request',
        'The requested output policy does not match the current Slack request.',
      );
    }
    if (bound.outputPolicy === 'post_on_change' && requestedOutputPolicy !== 'post_on_change') {
      throw new ManagementError(
        'invalid_request',
        'Posting only on change must be explicit in the current Slack request.',
      );
    }
  } else if (bound.outputPolicy !== previous.outputPolicy) {
    if (requestedOutputPolicy === bound.outputPolicy) {
      outputPolicyChanged = true;
    } else if (requestedOutputPolicy !== undefined) {
      throw new ManagementError(
        'invalid_request',
        'The requested output policy does not match the current Slack request.',
      );
    } else {
      // The tool defaults an omitted policy to `post`. Preserve the prior
      // value so a cadence-only request cannot broaden delivery by accident.
      bound = { ...bound, outputPolicy: previous.outputPolicy };
    }
  } else if (
    requestedOutputPolicy !== undefined &&
    requestedOutputPolicy !== bound.outputPolicy
  ) {
    throw new ManagementError(
      'invalid_request',
      'The requested output policy does not match the current Slack request.',
    );
  }

  if (previous && !taskMatchesRequest && !cadenceChanged && !outputPolicyChanged) {
    throw new ManagementError(
      'invalid_request',
      'An edit that reuses the previous task needs an explicit cadence or output change in the current Slack request.',
    );
  }
  return bound;
}

async function requireRoutineActionAuthority(
  signal: SlackManagementSignal,
  operation: Exclude<SlackScheduleManagementOperation, { kind: 'save_routine' }>,
  routines: Pick<RoutineStore, 'getRoutine' | 'listRoutines'>,
  requestText: string,
): Promise<void> {
  const routine = await routines.getRoutine(operation.routineId);
  if (!routine || routine.deletedAt !== null) {
    throw new ManagementError('invalid_request', 'The scheduled work was not found.');
  }
  const action = operation.kind === 'run_routine' ? 'run' : operation.action;
  const clause = directActionClause(requestText, action);
  if (!clause) {
    throw new ManagementError(
      'invalid_request',
      `The current Slack request must explicitly ${action} the scheduled work.`,
    );
  }

  if (containsBoundedText(clause, routine.id)) return;
  if (!containsBoundedText(clause, routine.name)) {
    throw new ManagementError(
      'invalid_request',
      'The current Slack request must name the scheduled work being changed.',
    );
  }
  const scoped = await routines.listRoutines(signal.workspaceId, signal.channelId);
  const targetName = normalizeAuthorityText(routine.name).toLocaleLowerCase('en-US');
  const matchingNames = scoped.filter((candidate) =>
    normalizeAuthorityText(candidate.name).toLocaleLowerCase('en-US') === targetName);
  if (matchingNames.length !== 1 || matchingNames[0]?.id !== routine.id) {
    throw new ManagementError(
      'invalid_request',
      'The scheduled work name is ambiguous. Name its exact ID in the current Slack request.',
    );
  }
}

function directActionClause(
  requestText: string,
  action: 'pause' | 'resume' | 'disable' | 'run',
): string | undefined {
  const actionPattern = new RegExp(
    `^\\s*(?:<@[^>\\s]+>\\s*)*(?:(?:please|also|then|next|now)\\b[\\s,:-]*)*(?:(?:go\\s+ahead\\s+and)\\s+)?${action}\\b`,
    'i',
  );
  let start = 0;
  for (let index = 0; index <= requestText.length; index += 1) {
    const terminal = requestText[index];
    if (index < requestText.length && !/[.!?;\n]/.test(terminal ?? '')) continue;
    const sentence = requestText.slice(start, index);
    start = index + 1;
    if (terminal === '?') continue;
    const unquoted = stripQuotedText(sentence);
    if (
      !actionPattern.test(unquoted) ||
      /\b(?:what\s+would|what\s+happens?|what\s+if|if\s+i|suppose|imagine|hypothetically|pasted\s+text|for\s+example|example|explain|describe|teach|review|advice|how\s+to|plan\s+to|planning\s+to)\b/i.test(unquoted)
    ) {
      continue;
    }
    return unquoted;
  }
  return undefined;
}

function containsBoundedText(container: string, value: string): boolean {
  const normalized = normalizeAuthorityText(value);
  if (!normalized) return false;
  return new RegExp(
    `(?:^|[^A-Za-z0-9_])${escapeRegExp(normalized)}(?:$|[^A-Za-z0-9_])`,
    'i',
  ).test(normalizeAuthorityText(container));
}

function routineTaskMatchesRequest(taskText: string, requestText: string): boolean {
  try {
    assertRoutineTaskBoundToSource(taskText, requestText);
    return true;
  } catch (error) {
    if (error instanceof RoutineStateError) return false;
    throw error;
  }
}

function scheduleMatchesPrevious(
  schedule: Extract<SlackScheduleManagementOperation, { kind: 'save_routine' }>['schedule'],
  previous: RoutineDefinition,
): boolean {
  if (schedule.kind === 'cron') {
    return previous.triggerKind === 'schedule' &&
      normalizeAuthorityText(schedule.expression) === normalizeAuthorityText(previous.scheduleInput);
  }
  return schedule.kind === 'once' && previous.triggerKind === 'once' &&
    schedule.localDateTime.trim() === previous.scheduleInput;
}

function requireScheduleAuthority(
  schedule: Extract<SlackScheduleManagementOperation, { kind: 'save_routine' }>['schedule'],
  timezone: string,
  requestText: string,
  at: number,
  edit: boolean,
): void {
  const patterns = scheduleAuthorityPatterns(schedule, timezone, at);
  if (patterns.some((pattern) => hasPositiveAuthorityMatch(
    requestText,
    pattern,
    edit ? 'edit' : 'create',
  ))) return;
  throw new ManagementError(
    'invalid_request',
    'The schedule cadence must be explicit in the current Slack request.',
  );
}

function scheduleAuthorityPatterns(
  schedule: Extract<SlackScheduleManagementOperation, { kind: 'save_routine' }>['schedule'],
  timezone: string,
  at: number,
): RegExp[] {
  if (schedule.kind === 'in') {
    const count = authorityNumberPattern(schedule.minutes);
    return [
      new RegExp(`\\bin\\s+${count}\\s+(?:minutes?|mins?)\\b`, 'gi'),
      new RegExp(`\\bafter\\s+${count}\\s+(?:minutes?|mins?)\\b`, 'gi'),
      new RegExp(`\\b${count}\\s+(?:minutes?|mins?)\\s+(?:from\\s+now|later)\\b`, 'gi'),
    ];
  }
  if (schedule.kind === 'once') {
    return oneTimeAuthorityPatterns(schedule.localDateTime, timezone, at);
  }

  const expression = normalizeAuthorityText(schedule.expression);
  const patterns = [new RegExp(escapeRegExp(expression), 'gi')];
  const fields = expression.split(' ');
  if (fields.length !== 5) return patterns;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const minuteStep = /^\*\/(\d+)$/.exec(minute ?? '');
  if (minuteStep && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const count = authorityNumberPattern(Number(minuteStep[1]));
    patterns.push(new RegExp(`\\bevery\\s+${count}\\s+(?:minutes?|mins?)\\b`, 'gi'));
    return patterns;
  }
  if (minute === '0' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    patterns.push(/\b(?:every\s+hour|hourly)\b/gi);
    return patterns;
  }
  if (
    /^\d+$/.test(minute ?? '') && /^\d+$/.test(hour ?? '') &&
    dayOfMonth === '*' && month === '*'
  ) {
    const recurrence = recurringDayPattern(dayOfWeek ?? '');
    if (!recurrence) return patterns;
    const clock = clockAuthorityPattern(Number(hour), Number(minute));
    patterns.push(
      new RegExp(`\\b${recurrence}\\b[^.!?;\\n]{0,30}\\b(?:at\\s+)?${clock}\\b`, 'gi'),
      new RegExp(`\\b${clock}\\b[^.!?;\\n]{0,30}\\b${recurrence}\\b`, 'gi'),
    );
  }
  return patterns;
}

function oneTimeAuthorityPatterns(localDateTime: string, timezone: string, at: number): RegExp[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localDateTime.trim());
  if (!match) return [new RegExp(escapeRegExp(localDateTime.trim()), 'gi')];
  const [, year, month, day, hour, minute] = match;
  const clock = clockAuthorityPattern(Number(hour), Number(minute));
  const patterns = [
    new RegExp(`${escapeRegExp(year!)}-${escapeRegExp(month!)}-${escapeRegExp(day!)}[T\\s]${escapeRegExp(hour!)}:${escapeRegExp(minute!)}`, 'gi'),
    new RegExp(`\\b${Number(month)}/${Number(day)}(?:/${year})?\\b[^.!?;\\n]{0,20}\\b(?:at\\s+)?${clock}\\b`, 'gi'),
  ];
  const scheduledDate = `${year}-${month}-${day}`;
  const currentDate = localCalendarDate(at, timezone);
  if (scheduledDate === currentDate) {
    patterns.push(new RegExp(`\\btoday\\b[^.!?;\\n]{0,20}\\b(?:at\\s+)?${clock}\\b`, 'gi'));
  }
  if (scheduledDate === nextCalendarDate(currentDate)) {
    patterns.push(
      new RegExp(`\\btomorrow\\b[^.!?;\\n]{0,20}\\b(?:at\\s+)?${clock}\\b`, 'gi'),
      new RegExp(`\\b${clock}\\b[^.!?;\\n]{0,20}\\btomorrow\\b`, 'gi'),
    );
  }
  return patterns;
}

function recurringDayPattern(dayOfWeek: string): string | undefined {
  if (dayOfWeek === '*') return '(?:every\\s+day|daily)';
  if (dayOfWeek === '1-5') return '(?:every\\s+)?weekdays?';
  if (dayOfWeek === '0,6' || dayOfWeek === '6,0') return '(?:every\\s+)?weekends?';
  if (!/^[0-6]$/.test(dayOfWeek)) return undefined;
  const day = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][Number(dayOfWeek)];
  return `(?:every\\s+)?${day}`;
}

function clockAuthorityPattern(hour: number, minute: number): string {
  const hour12 = hour % 12 || 12;
  const suffix = hour >= 12 ? 'p\\.?m\\.?' : 'a\\.?m\\.?';
  const minuteText = String(minute).padStart(2, '0');
  const twentyFourHour = `${String(hour).padStart(2, '0')}:${minuteText}`;
  const twelveHour = minute === 0
    ? `${hour12}(?::00)?\\s*${suffix}`
    : `${hour12}:${minuteText}\\s*${suffix}`;
  return `(?:${twentyFourHour}|${twelveHour})`;
}

function authorityNumberPattern(value: number): string {
  const word = numberWord(value);
  return word ? `(?:${value}|${word.replaceAll('-', '[-\\s]')})` : String(value);
}

function numberWord(value: number): string | undefined {
  const underTwenty = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
    'seventeen', 'eighteen', 'nineteen',
  ];
  if (value >= 0 && value < underTwenty.length) return underTwenty[value];
  if (value < 20 || value > 99) return undefined;
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const remainder = value % 10;
  return `${tens[Math.floor(value / 10)]}${remainder ? `-${underTwenty[remainder]}` : ''}`;
}

type AuthorityIntent = 'none' | 'create' | 'edit';

function hasPositiveAuthorityMatch(
  requestText: string,
  pattern: RegExp,
  intent: AuthorityIntent,
): boolean {
  const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  for (const match of requestText.matchAll(matcher)) {
    const offset = match.index ?? 0;
    const start = clauseBoundary(requestText, offset, 'start');
    const end = clauseBoundary(requestText, offset + match[0].length, 'end');
    const clause = requestText.slice(start, end);
    const prefix = requestText.slice(start, offset);
    if (/\b(?:do\s+not|don't|never|must\s+not|should\s+not|cannot|can't|avoid|refrain\s+from|without)\b/i.test(prefix)) {
      continue;
    }
    if (
      requestText[end] === '?' ||
      /\b(?:what\s+would|what\s+happens?|what\s+if|if\s+i|suppose|imagine|hypothetically|pasted\s+text|for\s+example|example|explain|describe|teach|review|advice|how\s+to|plan\s+to|planning\s+to)\b/i.test(clause) ||
      insideQuotedText(requestText, start, offset)
    ) {
      continue;
    }
    const unquoted = stripQuotedText(clause);
    if (intent === 'create' && !hasDirectCreateIntent(unquoted)) continue;
    if (intent === 'edit' && !hasDirectEditIntent(unquoted)) continue;
    return true;
  }
  return false;
}

function clauseBoundary(text: string, offset: number, direction: 'start' | 'end'): number {
  const delimiters = /[.!?;\n]/;
  if (direction === 'start') {
    for (let index = offset - 1; index >= 0; index -= 1) {
      if (delimiters.test(text[index]!)) return index + 1;
    }
    return 0;
  }
  for (let index = offset; index < text.length; index += 1) {
    if (delimiters.test(text[index]!)) return index;
  }
  return text.length;
}

function stripQuotedText(text: string): string {
  return text.replace(/"[^"]*"|“[^”]*”/g, ' ');
}

function hasDirectCreateIntent(text: string): boolean {
  return /^\s*(?:<@[^>\s]+>\s*)*(?:(?:please|also|then|next|now)\b[\s,:-]*)*(?:(?:go\s+ahead\s+and)\s+)?(?:schedule|create|remind|run)\b/i
    .test(text);
}

function hasDirectEditIntent(text: string): boolean {
  return /^\s*(?:<@[^>\s]+>\s*)*(?:(?:please|also|then|next|now)\b[\s,:-]*)*(?:(?:go\s+ahead\s+and)\s+)?(?:change|edit|update|set|switch|reschedule|move|make|use|run|repeat|have|instead)\b/i
    .test(text);
}

function insideQuotedText(text: string, start: number, offset: number): boolean {
  const prefix = text.slice(start, offset);
  const straightDouble = (prefix.match(/"/g) ?? []).length % 2 === 1;
  const curlyDouble = prefix.lastIndexOf('“') > prefix.lastIndexOf('”');
  return straightDouble || curlyDouble;
}

function outputPolicyFromRequest(
  requestText: string,
): Extract<SlackScheduleManagementOperation, { kind: 'save_routine' }>['outputPolicy'] | undefined {
  const onChangePatterns = [
    /\b(?:tell|report|show|send|message|notify|post)\b[^.!?;\n]{0,50}\b(?:anything|something)\s+new\b/gi,
    /\bonly\s+(?:tell|report|show|send|message|notify|post)\b[^.!?;\n]{0,60}\b(?:change|changed|changes|different|new|update|updates)\b/gi,
    /\b(?:tell|report|show|send|message|notify|post)\b[^.!?;\n]{0,40}\bonly\s+(?:when|if)\b[^.!?;\n]{0,40}\b(?:change|changed|changes|different|new|update|updates)\b/gi,
    /\bpost_on_change\b/gi,
  ];
  const everyTimePatterns = [
    /\balways\s+(?:tell|report|show|send|message|notify|post)\b/gi,
    /\b(?:tell|report|show|send|message|notify|post)\b[^.!?;\n]{0,40}\b(?:every\s+time|every\s+result|all\s+results)\b/gi,
    /\beven\s+(?:when|if)\b[^.!?;\n]{0,40}\b(?:unchanged|nothing\s+is\s+new|no\s+changes?)\b/gi,
  ];
  const onChange = onChangePatterns.some((pattern) =>
    hasPositiveAuthorityMatch(requestText, pattern, 'none'));
  const everyTime = everyTimePatterns.some((pattern) =>
    hasPositiveAuthorityMatch(requestText, pattern, 'none'));
  if (onChange && everyTime) {
    throw new ManagementError(
      'invalid_request',
      'The current Slack request contains conflicting output instructions.',
    );
  }
  return onChange ? 'post_on_change' : everyTime ? 'post' : undefined;
}

function requireCompatibleNamedTimezone(
  timezone: string,
  requestText: string,
  edit: boolean,
): void {
  if (
    requestMentionsAnyTimezone(requestText) &&
    !requestNamesTimezone(requestText, timezone, edit)
  ) {
    throw new ManagementError(
      'invalid_request',
      'The requested schedule timezone does not match the current Slack request.',
    );
  }
}

function requestNamesTimezone(requestText: string, timezone: string, edit: boolean): boolean {
  const exact = new RegExp(
    `(?:^|[^A-Za-z0-9_])${escapeRegExp(timezone)}(?:$|[^A-Za-z0-9_])`,
    'gi',
  );
  if (hasPositiveAuthorityMatch(requestText, exact, edit ? 'edit' : 'none')) {
    return true;
  }
  const aliases: Record<string, RegExp> = {
    UTC: /\b(?:UTC|GMT)\b/i,
    'America/Los_Angeles': /\b(?:PT|PST|PDT|Pacific)\b/i,
    'America/Denver': /\b(?:MT|MST|MDT|Mountain)\b/i,
    'America/Chicago': /\b(?:CT|CST|CDT|Central)\b/i,
    'America/New_York': /\b(?:ET|EST|EDT|Eastern)\b/i,
  };
  const alias = aliases[timezone];
  return alias
    ? hasPositiveAuthorityMatch(requestText, alias, edit ? 'edit' : 'none')
    : false;
}

function requestMentionsAnyTimezone(requestText: string): boolean {
  return /\b(?:UTC|GMT|PT|PST|PDT|Pacific|MT|MST|MDT|Mountain|CT|CST|CDT|Central|ET|EST|EDT|Eastern)\b/i
    .test(requestText) || /\b(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/.test(requestText);
}

function localCalendarDate(at: number, timezone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US-u-ca-iso8601', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function nextCalendarDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day! + 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Retry actions already admitted by a prior RPC or interrupted Agent turn. */
export async function retryDueSlackScheduleActions(input: {
  dependencies: SlackScheduleActionDependencies;
  resolveContext(
    action: RoutineScheduleAction,
    request: ManagementRequestRecord,
  ): Promise<ManagementActorContext>;
  limit?: number;
}): Promise<{ attempted: number; nextDueAt?: number }> {
  const now = input.dependencies.now ?? Date.now;
  const at = now();
  const owner = input.dependencies.owner ?? `alarm:${at}`;
  const claimed = await input.dependencies.routines.claimDueScheduleActions({
    owner,
    at,
    leaseUntil: at + ACTION_LEASE_MS,
    limit: input.limit ?? 10,
  });
  for (const action of claimed) {
    const request = await input.dependencies.management.getRequest(action.requestOperationId);
    const operation = request?.operations[0];
    if (!request || request.operations.length !== 1 ||
        (operation?.kind !== 'save_routine' && operation?.kind !== 'control_routine' &&
          operation?.kind !== 'run_routine')) {
      await input.dependencies.routines.settleScheduleAction({
        actionId: action.actionId,
        owner,
        expectedAttempt: action.attempts,
        result: { outcome: 'failed', code: 'schedule_action_payload_unavailable' },
        at: now(),
      });
      continue;
    }
    let context: ManagementActorContext;
    try {
      context = await input.resolveContext(action, request);
    } catch {
      await input.dependencies.routines.settleScheduleAction({
        actionId: action.actionId,
        owner,
        expectedAttempt: action.attempts,
        result: { outcome: 'failed', code: 'schedule_actor_unavailable' },
        at: now(),
      });
      continue;
    }
    await applyClaimedScheduleAction({
      action,
      operation,
      context,
      publicIdempotencyKey: `schedule-action:${action.actionId}`,
      dependencies: { ...input.dependencies, owner },
      now,
    });
  }
  await reconcileReceipts(input.dependencies, now());
  const nextDueAt = await input.dependencies.routines.nextScheduleActionDueAt();
  return { attempted: claimed.length, ...(nextDueAt !== undefined ? { nextDueAt } : {}) };
}

async function applyClaimedScheduleAction(input: {
  action: RoutineScheduleAction;
  operation: SlackScheduleManagementOperation;
  context: ManagementActorContext;
  publicIdempotencyKey: string;
  dependencies: SlackScheduleActionDependencies;
  now: () => number;
}): Promise<RoutineScheduleAction> {
  const owner = input.action.leaseOwner ?? input.dependencies.owner;
  if (!owner) throw new Error('Claimed schedule action owner is unavailable.');
  try {
    const result = await input.dependencies.service.applyWorkspaceChanges({
      context: input.context,
      idempotencyKey: input.publicIdempotencyKey,
      operations: [input.operation],
      acknowledgementOwner: 'caller',
    });
    if (result.status === 'clarification_required') {
      throw new Error('A schedule operation returned Agent identity clarification.');
    }
    const outcome = result.outcomes[0];
    const routineRef = outcome?.changed?.find(({ kind }) => kind === 'routine');
    if (outcome?.disposition === 'applied' && routineRef) {
      const routine = await input.dependencies.routines.getRoutine(routineRef.id);
      return input.dependencies.routines.settleScheduleAction({
        actionId: input.action.actionId,
        owner,
        expectedAttempt: input.action.attempts,
        result: {
          outcome: 'applied',
          effect: input.operation.kind === 'save_routine'
            ? 'saved'
            : input.operation.kind === 'run_routine'
              ? 'run_queued'
              : 'controlled',
          routineId: routineRef.id,
          ...((routine?.version ?? routineRef.revision) !== undefined
            ? { routineVersion: routine?.version ?? routineRef.revision }
            : {}),
          ...(routine && ['active', 'paused', 'disabled', 'pending_authority'].includes(routine.state)
            ? { safeState: routine.state as 'active' | 'paused' | 'disabled' | 'pending_authority' }
            : {}),
        },
        at: input.now(),
      });
    }
    return input.dependencies.routines.settleScheduleAction({
      actionId: input.action.actionId,
      owner,
      expectedAttempt: input.action.attempts,
      result: {
        outcome: 'failed',
        code: safeFailureCode(outcome?.code ?? outcome?.disposition ?? 'schedule_failed'),
        ...(routineRef ? {
          routineId: routineRef.id,
          ...await safeRoutineState(input.dependencies.routines, routineRef.id),
        } : {}),
      },
      at: input.now(),
    });
  } catch (error) {
    if (error instanceof ManagementError) {
      const routineRef = error.changed?.find(({ kind }) => kind === 'routine');
      return input.dependencies.routines.settleScheduleAction({
        actionId: input.action.actionId,
        owner,
        expectedAttempt: input.action.attempts,
        result: {
          outcome: 'failed',
          code: safeFailureCode(error.code),
          ...(routineRef
            ? await failedRoutineResult(input.dependencies.routines, routineRef)
            : {}),
        },
        at: input.now(),
      });
    }
    const safetyTransitionPending = error instanceof SlackScheduleCommandError &&
      error.code === 'schedule_safety_pending';
    if (!safetyTransitionPending && input.action.attempts >= ACTION_MAX_ATTEMPTS) {
      const at = input.now();
      await input.dependencies.management.failRequest(input.action.requestOperationId, at);
      return input.dependencies.routines.settleScheduleAction({
        actionId: input.action.actionId,
        owner,
        expectedAttempt: input.action.attempts,
        result: { outcome: 'failed', code: 'schedule_internal_failure' },
        at,
      });
    }
    return input.dependencies.routines.deferScheduleAction({
      actionId: input.action.actionId,
      owner,
      expectedAttempt: input.action.attempts,
      nextAttemptAt: input.now() + retryDelay(input.action.attempts),
      at: input.now(),
    });
  }
}

async function reconcileReceipts(
  dependencies: SlackScheduleActionDependencies,
  at: number,
): Promise<void> {
  await reconcileScheduleActionReceipts({
    routines: dependencies.routines,
    management: dependencies.management,
    at,
  });
}

function validateStandaloneScheduleOperation(
  signal: SlackManagementSignal,
  operation: SlackScheduleManagementOperation,
): SlackScheduleManagementOperation {
  if (signal.conversationKind === 'mpim') {
    throw new ManagementError('invalid_request', 'Scheduling in group DMs is not supported.');
  }
  const direct = signal.conversationKind === 'im';
  if (operation.workspaceId !== signal.workspaceId) {
    throw new ManagementError('invalid_request', 'The schedule workspace must match this conversation.');
  }
  if (operation.kind === 'save_routine') {
    if (operation.agentId === CHICKPEA_AGENT_ID ||
        (signal.agentId !== CHICKPEA_AGENT_ID && operation.agentId !== signal.agentId)) {
      throw new ManagementError('forbidden', 'The addressed user Agent must own this schedule.');
    }
    if (direct) {
      if (operation.channelId !== undefined || operation.destination?.kind !== 'current_dm_thread') {
        throw new ManagementError('invalid_request', 'A DM schedule must use the current DM thread.');
      }
    } else if (operation.channelId !== signal.channelId || operation.destination !== undefined) {
      throw new ManagementError('invalid_request', 'A Channel schedule must use the current Channel.');
    }
    return operation;
  }
  if ((direct && operation.channelId !== undefined) ||
      (!direct && operation.channelId !== signal.channelId)) {
    throw new ManagementError('invalid_request', 'The schedule destination must match this conversation.');
  }
  return operation;
}

async function safeRoutineState(
  routines: RoutineStore,
  routineId: string,
): Promise<{ safeState?: 'paused' | 'disabled' | 'pending_authority' }> {
  const routine = await routines.getRoutine(routineId);
  return routine && isFailedRoutineSafeState(routine.state)
    ? { safeState: routine.state }
    : {};
}

function isFailedRoutineSafeState(
  state: string,
): state is 'paused' | 'disabled' | 'pending_authority' {
  return state === 'paused' || state === 'disabled' || state === 'pending_authority';
}

async function failedRoutineResult(
  routines: RoutineStore,
  reference: { id: string },
): Promise<{ routineId: string; safeState?: 'paused' | 'disabled' | 'pending_authority' }> {
  return {
    routineId: reference.id,
    ...await safeRoutineState(routines, reference.id),
  };
}

function safeFailureCode(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 80);
  return normalized || 'schedule_failed';
}

function retryDelay(attempt: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt - 1));
}
