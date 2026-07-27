import type { PlatformEnv } from '../config/state-backend.ts';
import { getRoutineStore } from '../config/state-backend.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import type { NormalizedSlackTurn } from '../slack/types.ts';
import { resolveSlackCredentials, slackUsersInfo } from '../slack/credentials.ts';
import {
  createRoutineRunId,
  hashRoutineValue,
  runNowOccurrenceKey,
} from './ids.ts';
import { parseRoutineIntent, isRoutineIntentCandidate, type RoutineIntent } from './intent.ts';
import { ROUTINE_LIMITS } from './limits.ts';
import {
  renderRoutineConfirmation,
  renderRoutineCreated,
  renderRoutineDetail,
  renderRoutineHelp,
  renderRoutineList,
} from './message-format.ts';
import { normalizeRoutineSchedule } from './schedule.ts';
import {
  requireRoutineScheduling,
  resolveRoutineCapability,
  type RoutineCapability,
} from './scheduler-adapter.ts';
import { RoutineService, type RoutineDraftRequest } from './service.ts';
import { canManageRoutineChannel, parseSlackChannelMention } from './slack-context.ts';
import {
  RoutineStateError,
  type RoutineDefinition,
  type RoutineDefinitionContent,
  type RoutineStore,
} from './types.ts';
import { isIanaTimeZone } from './validation.ts';

export type RoutineCommand =
  | { kind: 'list'; channelMention?: string }
  | { kind: 'help' }
  | { kind: 'show'; routineId: string }
  | { kind: 'confirm'; token: string }
  | { kind: 'cancel'; token: string }
  | { kind: 'control'; action: 'pause' | 'resume' | 'disable'; routineId: string }
  | { kind: 'run'; routineId: string }
  | { kind: 'clone'; routineId: string }
  | { kind: 'delete'; routineId: string }
  | { kind: 'invalid' };

const OPAQUE = '[A-Za-z0-9_-]{1,200}';
const TOKEN = '[A-Za-z0-9._-]{4,512}';

export function parseRoutineCommand(rawText: string): RoutineCommand | undefined {
  const text = rawText.replace(/^\s*(?:<@[^>\s]+>\s*)+/i, '').trim();
  if (/^!routines?\s*$/i.test(text)) return { kind: 'list' };
  if (/^!routines?\s+help\s*$/i.test(text)) return { kind: 'help' };
  let match = text.match(/^!routines?\s+(<#[^>]+>)\s*$/i);
  if (match) return { kind: 'list', channelMention: match[1]! };
  match = text.match(new RegExp(`^!routines?\\s+show\\s+(${OPAQUE})\\s*$`, 'i'));
  if (match) return { kind: 'show', routineId: match[1]! };
  match = text.match(new RegExp(`^!routines?\\s+(confirm|cancel)\\s+(${TOKEN})\\s*$`, 'i'));
  if (match) return { kind: match[1]!.toLowerCase() as 'confirm' | 'cancel', token: match[2]! };
  match = text.match(new RegExp(`^!routines?\\s+(pause|resume|disable)\\s+(${OPAQUE})\\s*$`, 'i'));
  if (match) {
    return {
      kind: 'control',
      action: match[1]!.toLowerCase() as 'pause' | 'resume' | 'disable',
      routineId: match[2]!,
    };
  }
  match = text.match(new RegExp(`^!routines?\\s+(run|clone|delete)\\s+(${OPAQUE})\\s*$`, 'i'));
  if (match) return { kind: match[1]!.toLowerCase() as 'run' | 'clone' | 'delete', routineId: match[2]! };
  if (/^!routines?\b/i.test(text)) return { kind: 'invalid' };
  return undefined;
}

/** Exact controls first; positive natural-language candidates produce only a confirmation draft. */
export async function handleRoutineSlackRequest(
  turn: NormalizedSlackTurn,
  env: PlatformEnv | undefined,
  dependencies: {
    store?: RoutineStore;
    parseIntent?: typeof parseRoutineIntent;
    resolveDefaultTimezone?: (turn: NormalizedSlackTurn, env: PlatformEnv | undefined) => Promise<string>;
    now?: () => number;
    capability?: RoutineCapability;
  } = {},
): Promise<string | undefined> {
  const store = dependencies.store ?? getRoutineStore(env);
  const now = dependencies.now ?? Date.now;
  const capability = dependencies.capability ?? routineCapability(env);
  const command = parseRoutineCommand(turn.text);
  if (command) {
    try {
      return await executeRoutineCommand(command, turn, store, env, capability, now);
    } catch (error) {
      return routineErrorText(error);
    }
  }
  if (!isRoutineIntentCandidate(turn.text)) return undefined;
  try {
    const intent = await (dependencies.parseIntent ?? parseRoutineIntent)(
      {
        workspaceId: turn.workspaceId,
        channelId: turn.channelId,
        eventId: turn.eventId,
        text: turn.text,
      },
      env,
    );
    if (!intent) return undefined;
    requireRoutineScheduling(capability);
    const defaultTimezone = intent.action === 'create' && (intent.timezoneWasDefaulted === true || !intent.timezone)
      ? await (dependencies.resolveDefaultTimezone ?? resolveRoutineDefaultTimezone)(turn, env)
      : undefined;
    return await createIntentConfirmation(intent, turn, store, now, defaultTimezone);
  } catch (error) {
    return routineErrorText(error);
  }
}

async function executeRoutineCommand(
  command: RoutineCommand,
  turn: NormalizedSlackTurn,
  store: RoutineStore,
  env: PlatformEnv | undefined,
  capability: RoutineCapability,
  now: () => number,
): Promise<string> {
  const service = new RoutineService(store, { now });
  if (command.kind === 'help' || command.kind === 'invalid') return renderRoutineHelp();
  if (command.kind === 'list') {
    const mentionedId = command.channelMention
      ? parseSlackChannelMention(command.channelMention)
      : undefined;
    if (command.channelMention && !mentionedId) return notFoundText();
    const channelId = mentionedId ?? turn.channelId;
    if (
      channelId !== turn.channelId &&
      !(await canManageRoutineChannel(turn.workspaceId, channelId, turn.userId, env))
    ) {
      return notFoundText();
    }
    const suffix = capability.enabled
      ? ''
      : `\n\n_${capability.reason === 'unsupported_target' ? 'Scheduling is currently Cloudflare-only.' : 'Scheduling is disabled by the deployment operator.'}_`;
    return renderRoutineList(await store.listRoutines(turn.workspaceId, channelId), channelId) + suffix;
  }
  if (command.kind === 'confirm') {
    const confirmation = await store.getConfirmation(hashRoutineValue(command.token));
    if (!confirmation) return 'That routine confirmation was not found or is no longer available.';
    if (confirmation.draft.action !== 'delete') requireRoutineScheduling(capability);
    const routine = await service.confirm({
      token: command.token,
      actorId: turn.userId,
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      previewHash: confirmation.previewHash,
      idempotencyKey: `routine:slack:${turn.eventId}:confirm`,
    });
    return confirmation.draft.action === 'delete'
      ? `Routine \`${routine.id}\` was deleted. Its saved body was scrubbed; body-free audit/run metadata is retained.`
      : renderRoutineCreated(routine);
  }
  if (command.kind === 'cancel') {
    const cancelled = await store.cancelConfirmation({
      tokenHash: hashRoutineValue(command.token),
      actorId: turn.userId,
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      at: now(),
    });
    return cancelled
      ? 'Routine confirmation cancelled.'
      : 'That routine confirmation was not found or is no longer available.';
  }

  const routine = await scopedRoutine(store, command.routineId, turn);
  if (!routine) return notFoundText();
  if (command.kind === 'show') {
    return renderRoutineDetail(routine, await store.listRuns({ routineId: routine.id, limit: 5 }));
  }
  if (command.kind === 'control') {
    if (command.action === 'resume') requireRoutineScheduling(capability);
    const updated = await service.control({
      routineId: routine.id,
      expectedVersion: routine.version,
      action: command.action,
      actorId: turn.userId,
      actorClass: 'member',
      idempotencyKey: `routine:slack:${turn.eventId}:${command.action}:${routine.id}`,
    });
    return `Routine *${updated.name}* is now *${updated.state}*.`;
  }
  if (command.kind === 'run') {
    requireRoutineScheduling(capability);
    const at = now();
    const occurrence = await store.createOccurrence({
      runId: createRoutineRunId(),
      idempotencyKey: runNowOccurrenceKey(routine.id, turn.eventId),
      routineId: routine.id,
      routineVersion: routine.version,
      scheduledFor: at,
      triggerSource: 'run_now',
      requestedBy: turn.userId,
      queuedAt: at,
      deadlineAt: at + ROUTINE_LIMITS.occurrenceDeadlineMs,
    });
    return `Queued one occurrence of *${routine.name}* (\`${occurrence.id}\`). It will use current channel authority.`;
  }
  if (command.kind === 'clone') {
    requireRoutineScheduling(capability);
    const projection = normalizeRoutineSchedule(routine.scheduleInput, routine.timezone, now());
    const receipt = await service.createConfirmation({
      action: 'create',
      actorId: turn.userId,
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      definition: definitionFromRoutine(routine, {
        name: `${routine.name} copy`.slice(0, ROUTINE_LIMITS.maxNameCodePoints),
        scheduleJson: projection.scheduleJson,
      }),
      nextRunAt: projection.nextRunAt,
      projectedDailyStarts: projection.projectedDailyStarts,
      reservations: projection.reservations,
    });
    return renderRoutineConfirmation({ ...receipt, creatorUserId: turn.userId });
  }
  const receipt = await service.createConfirmation({
    action: 'delete',
    actorId: turn.userId,
    workspaceId: turn.workspaceId,
    channelId: turn.channelId,
    routineId: routine.id,
    expectedVersion: routine.version,
  });
  return renderRoutineConfirmation({ ...receipt });
}

async function createIntentConfirmation(
  intent: RoutineIntent,
  turn: NormalizedSlackTurn,
  store: RoutineStore,
  now: () => number,
  defaultTimezone?: string,
): Promise<string> {
  const service = new RoutineService(store, { now });
  const current = intent.action === 'edit' && intent.routineId
    ? await scopedRoutine(store, intent.routineId, turn)
    : undefined;
  if (intent.action === 'edit' && !current) return notFoundText();
  const scheduleInput = cleanRequired(intent.scheduleExpression ?? current?.scheduleInput, 'A recurring schedule is required.');
  const timezone = cleanRequired(
    intent.timezoneWasDefaulted === true
      ? current?.timezone ?? defaultTimezone ?? 'UTC'
      : intent.timezone ?? current?.timezone ?? defaultTimezone ?? 'UTC',
    'An IANA time zone is required.',
  );
  const projection = normalizeRoutineSchedule(scheduleInput, timezone, now());
  const taskText = cleanRequired(intent.taskText ?? current?.taskText, 'A routine task is required.');
  const definition: RoutineDefinitionContent = {
    name: cleanName(intent.name ?? current?.name ?? taskText),
    description: cleanDescription(intent.description ?? current?.description ?? taskText),
    taskText,
    triggerKind: 'schedule',
    scheduleInput: projection.schedule.expression,
    scheduleJson: projection.scheduleJson,
    timezone,
    outputPolicy: intent.outputPolicy ?? current?.outputPolicy ?? 'post',
    authorityMode: 'live_channel_v1',
  };
  const request: RoutineDraftRequest = {
    action: current ? 'edit' : 'create',
    actorId: turn.userId,
    workspaceId: turn.workspaceId,
    channelId: turn.channelId,
    ...(current ? { routineId: current.id, expectedVersion: current.version } : {}),
    definition,
    nextRunAt: projection.nextRunAt,
    projectedDailyStarts: projection.projectedDailyStarts,
    reservations: projection.reservations,
  };
  const receipt = await service.createConfirmation(request);
  return renderRoutineConfirmation({
    ...receipt,
    timezoneDefaulted: !current && (intent.timezoneWasDefaulted === true || !intent.timezone),
    creatorUserId: current?.creatorUserId ?? turn.userId,
  });
}

async function resolveRoutineDefaultTimezone(
  turn: NormalizedSlackTurn,
  env: PlatformEnv | undefined,
): Promise<string> {
  try {
    const { botToken } = await resolveSlackCredentials(env);
    if (!botToken) return 'UTC';
    const result = await slackUsersInfo(botToken, turn.userId);
    const timezone = result.ok ? result.user?.timezone : undefined;
    return timezone && isIanaTimeZone(timezone) ? timezone : 'UTC';
  } catch {
    return 'UTC';
  }
}

async function scopedRoutine(
  store: RoutineStore,
  routineId: string,
  turn: NormalizedSlackTurn,
): Promise<RoutineDefinition | undefined> {
  const routine = await store.getRoutine(routineId);
  return routine &&
    routine.deletedAt === null &&
    routine.workspaceId === turn.workspaceId &&
    routine.channelId === turn.channelId
    ? routine
    : undefined;
}

function routineCapability(env: PlatformEnv | undefined): RoutineCapability {
  const flag = env?.TAG_ROUTINES_ENABLED;
  return resolveRoutineCapability({
    cloudflare: isCloudflareTarget(),
    ...(typeof flag === 'string' ? { enabledFlag: flag } : {}),
  });
}

function definitionFromRoutine(
  routine: RoutineDefinition,
  overrides: Partial<RoutineDefinitionContent> = {},
): RoutineDefinitionContent {
  return {
    name: routine.name,
    description: routine.description,
    taskText: routine.taskText,
    triggerKind: routine.triggerKind,
    scheduleInput: routine.scheduleInput,
    scheduleJson: routine.scheduleJson,
    timezone: routine.timezone,
    outputPolicy: routine.outputPolicy,
    authorityMode: routine.authorityMode,
    ...overrides,
  };
}

function cleanRequired(value: string | undefined, message: string): string {
  const result = value?.trim();
  if (!result) throw new RoutineStateError('routine_intent_incomplete', message);
  return result;
}

function cleanName(value: string): string {
  return [...value.trim().replace(/\s+/g, ' ')].slice(0, ROUTINE_LIMITS.maxNameCodePoints).join('');
}

function cleanDescription(value: string): string {
  return [...value.trim().replace(/\s+/g, ' ')].slice(0, ROUTINE_LIMITS.maxDescriptionCodePoints).join('');
}

function routineErrorText(error: unknown): string {
  if (error instanceof RoutineStateError) return error.message;
  return 'Chickpea could not safely prepare that routine. Try an explicit recurrence, five-field cron, and IANA time zone, or use `!routines help`.';
}

function notFoundText(): string {
  return 'That routine or channel was not found or is unavailable.';
}
