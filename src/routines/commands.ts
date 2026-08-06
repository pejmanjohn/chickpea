import type { PlatformEnv } from '../config/state-backend.ts';
import { getRoutineStore } from '../config/state-backend.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import type { NormalizedSlackTurn } from '../slack/types.ts';
import type { SlackIdentityExecutionContext } from '../slack/identity-execution.ts';
import { resolveSlackCredentials, slackUsersInfo } from '../slack/credentials.ts';
import {
  createRoutineRunId,
  hashRoutineValue,
  runNowOccurrenceKey,
} from './ids.ts';
import type {
  parseRoutineIntent,
  RoutineIntent,
} from './intent.ts';
import {
  isRoutineIntentCandidate,
  routineIntentNeedsDefaultTimezone,
} from './intent-candidate.ts';
import { ROUTINE_LIMITS } from './limits.ts';
import {
  renderRoutineDeletionConfirmation,
  renderRoutineDetail,
  renderRoutineHelp,
  renderRoutineList,
  renderRoutineSaved,
} from './message-format.ts';
import { normalizeOneTimeSchedule, normalizeRoutineSchedule } from './schedule.ts';
import {
  requireRoutineScheduling,
  resolveRoutineCapability,
  type RoutineCapability,
} from './scheduler-adapter.ts';
import { RoutineService, type RoutineSaveRequest } from './service.ts';
import {
  canManageRoutineChannel,
  parseSlackChannelMention,
  resolveRoutineSourceVisibility,
} from './slack-context.ts';
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

type RoutineManagementAction = 'show' | 'pause' | 'resume' | 'disable' | 'run' | 'clone' | 'delete';
type RoutineManagementIntent = Omit<RoutineIntent, 'action'> & { action: RoutineManagementAction };

interface RoutineCommandExecutionContext {
  turn: NormalizedSlackTurn;
  store: RoutineStore;
  env: PlatformEnv | undefined;
  capability: RoutineCapability;
  now: () => number;
  canManageChannel: typeof canManageRoutineChannel;
  botToken?: string;
}

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

export type RoutineResponseVisibility = 'channel' | 'requester';

/**
 * A current-channel routine list is channel-owned and safe to show there. A
 * cross-channel list (including its non-disclosing failure) is visible only to
 * the requester in the invoking channel, matching Slack's requester-only
 * `chat.postEphemeral` surface.
 */
export function routineResponseVisibility(
  rawText: string,
  currentChannelId: string,
): RoutineResponseVisibility {
  const command = parseRoutineCommand(rawText);
  if (command?.kind !== 'list' || !command.channelMention) return 'channel';
  return parseSlackChannelMention(command.channelMention) === currentChannelId
    ? 'channel'
    : 'requester';
}

/** Exact controls first; clear natural-language create/edit requests persist in one turn. */
export async function handleRoutineSlackRequest(
  turn: NormalizedSlackTurn,
  env: PlatformEnv | undefined,
  dependencies: {
    store?: RoutineStore;
    parseIntent?: typeof parseRoutineIntent;
    resolveDefaultTimezone?: (
      turn: NormalizedSlackTurn,
      env: PlatformEnv | undefined,
      botToken?: string,
    ) => Promise<string>;
    now?: () => number;
    capability?: RoutineCapability;
    canManageChannel?: typeof canManageRoutineChannel;
    identityContext?: SlackIdentityExecutionContext;
  } = {},
): Promise<string | undefined> {
  const store = dependencies.store ?? getRoutineStore(env);
  const now = dependencies.now ?? Date.now;
  const capability = dependencies.capability ?? routineCapability(env);
  const canManageChannel = dependencies.canManageChannel ?? canManageRoutineChannel;
  const botToken = dependencies.identityContext?.botToken;
  const commandContext: RoutineCommandExecutionContext = {
    turn, store, env, capability, now, canManageChannel, ...(botToken ? { botToken } : {}),
  };
  const command = parseRoutineCommand(turn.text);
  if (command) {
    try {
      return await executeRoutineCommand(command, commandContext);
    } catch (error) {
      return routineErrorText(error);
    }
  }
  if (!isRoutineIntentCandidate(turn.text)) return undefined;
  if (!(await canManageChannel(turn.workspaceId, turn.channelId, turn.userId, env, botToken))) {
    return notFoundText();
  }
  const explicitMutation = isExplicitRoutineMutationRequest(turn.text);
  if (requestsSubminimumMinuteInterval(turn.text)) {
    return 'Routine schedules must be at least five minutes apart.';
  }
  const defaultTimezone = routineIntentNeedsDefaultTimezone(turn.text)
    ? await (dependencies.resolveDefaultTimezone ?? resolveRoutineDefaultTimezone)(
        turn,
        env,
        botToken,
      )
    : 'UTC';
  let intent: RoutineIntent | undefined;
  try {
    const parseIntent = dependencies.parseIntent ?? (async (...args) =>
      (await import('./intent.ts')).parseRoutineIntent(...args));
    intent = await parseIntent(
      {
        workspaceId: turn.workspaceId,
        channelId: turn.channelId,
        eventId: turn.eventId,
        text: turn.text,
        defaultTimezone,
      },
      env,
    );
  } catch {
    // The classifier is advisory. Infrastructure failures must preserve the
    // ordinary Slack turn unless the user explicitly requested a routine
    // mutation. Explicit routine work must never fall through to the
    // tool-capable live agent, which could execute the task instead of saving
    // or rejecting it.
    return explicitMutation ? unclearRoutineIntentText() : undefined;
  }
  if (!intent) return explicitMutation ? unclearRoutineIntentText() : undefined;
  try {
    if (intent.action === 'create' || intent.action === 'edit') {
      requireRoutineScheduling(capability);
      return await saveRoutineIntent(intent, turn, store, now, defaultTimezone, env, botToken);
    }
    if (isRoutineManagementIntent(intent)) {
      return await executeNaturalRoutineManagement(intent, commandContext);
    }
    return undefined;
  } catch (error) {
    return routineErrorText(error);
  }
}

async function executeRoutineCommand(
  command: RoutineCommand,
  context: RoutineCommandExecutionContext,
): Promise<string> {
  const { turn, store, env, capability, now, canManageChannel, botToken } = context;
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
      !(await canManageChannel(turn.workspaceId, channelId, turn.userId, env, botToken))
    ) {
      return notFoundText();
    }
    const suffix = capability.enabled
      ? ''
      : `\n\n_${capability.reason === 'unsupported_target' ? 'Scheduling is currently Cloudflare-only.' : 'Scheduling is disabled by the deployment operator.'}_`;
    return renderRoutineList(await store.listRoutines(turn.workspaceId, channelId), channelId) + suffix;
  }
  if (!(await canManageChannel(
    turn.workspaceId,
    turn.channelId,
    turn.userId,
    env,
    botToken,
  ))) {
    return notFoundText();
  }
  if (command.kind === 'confirm') {
    const confirmation = await store.getConfirmation(hashRoutineValue(command.token));
    if (!confirmation) return 'That routine confirmation was not found or is no longer available.';
    // New flows only create deletion confirmations. Accept any unexpired
    // pre-upgrade create/edit receipt until normal retention removes it.
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
      ? `🗑️ **Routine deleted**\n**ID:** \`${routine.id}\`\nIts saved body was scrubbed; body-free audit and run metadata is retained.`
      : renderRoutineSaved(routine, { action: confirmation.draft.action });
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
      ? '**Routine deletion cancelled**'
      : 'That routine confirmation was not found or is no longer available.';
  }

  const routine = await scopedRoutine(store, command.routineId, turn);
  if (!routine) return notFoundText();
  if (command.kind === 'show') {
    const [runs, revisions] = await Promise.all([
      store.listRuns({ routineId: routine.id, limit: 5 }),
      store.listRevisions(routine.id),
    ]);
    const provenance = revisions.find((revision) => revision.version === routine.version)?.provenance ?? null;
    return renderRoutineDetail(routine, runs, provenance);
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
    const verb = command.action === 'pause' ? 'paused' : command.action === 'resume' ? 'resumed' : 'disabled';
    const icon = command.action === 'pause' ? '⏸️' : command.action === 'resume' ? '▶️' : '⏹️';
    return `${icon} **Routine ${verb}**\n**Name:** ${updated.name}\n**ID:** \`${updated.id}\``;
  }
  if (command.kind === 'run') {
    requireRoutineScheduling(capability);
    if (routine.triggerKind === 'once') {
      throw new RoutineStateError(
        'routine_one_time_run_unsupported',
        'A one-time job runs only at its scheduled time. Create another one-time job for a different time.',
      );
    }
    const at = now();
    await store.createOccurrence({
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
    return `▶️ **Routine queued**\n**Name:** ${routine.name}`;
  }
  if (command.kind === 'clone') {
    requireRoutineScheduling(capability);
    if (routine.triggerKind === 'once') {
      throw new RoutineStateError(
        'routine_one_time_clone_unsupported',
        'Create a new one-time job with a future time instead of cloning this one.',
      );
    }
    const projection = normalizeRoutineSchedule(routine.scheduleInput, routine.timezone, now());
    const created = await service.save({
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
      provenance: {
        sourceKind: 'slack_clone',
        requestText: turn.text,
        eventId: turn.eventId,
        messageTs: turn.messageTs,
        threadTs: turn.threadTs,
        authoritySource: 'cloned_revision',
        sourceRoutineId: routine.id,
        sourceRoutineVersion: routine.version,
      },
      sourceVisibility: await resolveRoutineSourceVisibility(
        turn.workspaceId,
        turn.channelId,
        env,
        botToken,
      ),
    }, `routine:slack:${turn.eventId}:clone:${routine.id}`);
    return renderRoutineSaved(created, { action: 'create' });
  }
  const receipt = await service.createConfirmation({
    action: 'delete',
    actorId: turn.userId,
    workspaceId: turn.workspaceId,
    channelId: turn.channelId,
    routineId: routine.id,
    expectedVersion: routine.version,
  });
  return renderRoutineDeletionConfirmation({ draft: receipt.draft, token: receipt.token });
}

async function saveRoutineIntent(
  intent: RoutineIntent,
  turn: NormalizedSlackTurn,
  store: RoutineStore,
  now: () => number,
  defaultTimezone?: string,
  env?: PlatformEnv,
  botToken?: string,
): Promise<string> {
  const service = new RoutineService(store, { now });
  const resolution = intent.action === 'edit'
    ? await resolveIntentRoutine(intent, turn, store)
    : { kind: 'missing' as const };
  if (intent.action === 'edit' && resolution.kind === 'ambiguous') {
    return ambiguousNameText(intent.routineName ?? '', resolution.routines);
  }
  const current = resolution.kind === 'found' ? resolution.routine : undefined;
  if (intent.action === 'edit' && !current) return notFoundText();
  const triggerKind = intent.triggerKind ?? current?.triggerKind ?? 'schedule';
  const requestedSchedule = cleanRequired(
    intent.scheduleExpression ?? current?.scheduleInput,
    'A schedule is required.',
  );
  const timezone = normalizeRoutineTimezone(cleanRequired(
    intent.timezoneWasDefaulted === true
      ? current?.timezone ?? defaultTimezone ?? 'UTC'
      : intent.timezone ?? current?.timezone ?? defaultTimezone ?? 'UTC',
    'An IANA time zone is required.',
  ));
  const projection = triggerKind === 'once'
    ? normalizeOneTimeSchedule(requestedSchedule, timezone, now())
    : normalizeRoutineSchedule(requestedSchedule, timezone, now());
  const taskText = cleanRequired(intent.taskText ?? current?.taskText, 'A routine task is required.');
  const definition: RoutineDefinitionContent = {
    name: cleanName(explicitCreatedRoutineName(turn.text, intent.action) ?? intent.name ?? current?.name ?? taskText),
    description: cleanDescription(intent.description ?? current?.description ?? taskText),
    taskText,
    triggerKind,
    scheduleInput: projection.schedule.kind === 'once'
      ? projection.schedule.localDateTime
      : projection.schedule.expression,
    scheduleJson: projection.scheduleJson,
    timezone,
    outputPolicy: intent.outputPolicy ?? current?.outputPolicy ?? 'post',
    authorityMode: 'live_channel_v1',
  };
  // Prior authority applies only when the parser omitted the task entirely.
  // A supplied task, even one equal to the prior task, must be grounded in
  // this Slack request rather than inferred from effect-shaped text.
  const inheritsAuthority = current !== undefined && intent.taskText === undefined;
  const shared = {
    actorId: turn.userId,
    workspaceId: turn.workspaceId,
    channelId: turn.channelId,
    definition,
    nextRunAt: projection.nextRunAt,
    projectedDailyStarts: projection.projectedDailyStarts,
    reservations: projection.reservations,
    sourceVisibility: await resolveRoutineSourceVisibility(
      turn.workspaceId,
      turn.channelId,
      env,
      botToken,
    ),
    provenance: {
      sourceKind: 'slack_request' as const,
      requestText: turn.text,
      eventId: turn.eventId,
      messageTs: turn.messageTs,
      threadTs: turn.threadTs,
      authoritySource: inheritsAuthority
        ? 'previous_revision' as const
        : 'current_request' as const,
      sourceRoutineId: inheritsAuthority ? current!.id : null,
      sourceRoutineVersion: inheritsAuthority ? current!.version : null,
    },
  };
  const request: RoutineSaveRequest = current
    ? { ...shared, action: 'edit', routineId: current.id, expectedVersion: current.version }
    : { ...shared, action: 'create' };
  const action = request.action;
  const routine = await service.save(
    request,
    `routine:slack:${turn.eventId}:${action}:${request.routineId ?? 'new'}`,
  );
  return renderRoutineSaved(routine, {
    action,
    timezoneDefaulted: !current && (intent.timezoneWasDefaulted === true || !intent.timezone),
  });
}

async function executeNaturalRoutineManagement(
  intent: RoutineManagementIntent,
  context: RoutineCommandExecutionContext,
): Promise<string> {
  const { turn, store } = context;
  const resolution = await resolveIntentRoutine(intent, turn, store);
  if (resolution.kind === 'ambiguous') {
    return ambiguousNameText(intent.routineName ?? '', resolution.routines);
  }
  if (resolution.kind !== 'found') return notFoundText();
  const requestAction = naturalRoutineManagementAction(turn.text, resolution.routine.name);
  if (requestAction !== intent.action) {
    throw new RoutineStateError(
      'routine_natural_action_mismatch',
      'The current Slack request does not unambiguously authorize that routine action.',
    );
  }
  return executeRoutineCommand(
    routineManagementCommand(intent.action, resolution.routine.id),
    context,
  );
}

function naturalRoutineManagementAction(
  requestText: string,
  routineName: string,
): RoutineManagementAction | undefined {
  const text = requestText
    .replace(/^\s*(?:<@[^>\s]+>\s*)+/i, '')
    .replace(routineNamePattern(routineName), ' ');
  const actions: RoutineManagementAction[] = [];
  if (/\b(?:show|view|inspect|details?)\b/i.test(text)) actions.push('show');
  if (/\b(?:pause|suspend)\b/i.test(text)) actions.push('pause');
  if (/\b(?:resume|unpause|enable)\b/i.test(text)) actions.push('resume');
  if (/\bdisable\b|\bturn\s+off\b/i.test(text)) actions.push('disable');
  if (/\b(?:run|execute|start)\b/i.test(text)) actions.push('run');
  if (/\b(?:clone|copy|duplicate)\b/i.test(text)) actions.push('clone');
  if (/\b(?:delete|remove)\b/i.test(text)) actions.push('delete');
  return actions.length === 1 ? actions[0] : undefined;
}

function routineNamePattern(name: string): RegExp {
  const normalizedName = normalizeRoutineName(name);
  const escaped = normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'giu');
}

function isRoutineManagementIntent(intent: RoutineIntent): intent is RoutineManagementIntent {
  return ['show', 'pause', 'resume', 'disable', 'run', 'clone', 'delete'].includes(intent.action);
}

function routineManagementCommand(
  action: RoutineManagementAction,
  routineId: string,
): RoutineCommand {
  switch (action) {
    case 'show': return { kind: 'show', routineId };
    case 'pause':
    case 'resume':
    case 'disable':
      return { kind: 'control', action, routineId };
    case 'run':
    case 'clone':
    case 'delete':
      return { kind: action, routineId };
  }
}

type IntentRoutineResolution =
  | { kind: 'found'; routine: RoutineDefinition }
  | { kind: 'ambiguous'; routines: RoutineDefinition[] }
  | { kind: 'missing' };

async function resolveIntentRoutine(
  intent: RoutineIntent,
  turn: NormalizedSlackTurn,
  store: RoutineStore,
): Promise<IntentRoutineResolution> {
  if (intent.routineId && turn.text.includes(intent.routineId)) {
    const routine = await scopedRoutine(store, intent.routineId, turn);
    return routine ? { kind: 'found', routine } : { kind: 'missing' };
  }
  const requestedName = intent.routineName;
  if (!requestedName) return { kind: 'missing' };
  const normalizedName = normalizeRoutineName(requestedName);
  if (!normalizedName || !messageContainsRoutineName(turn.text, normalizedName)) {
    return { kind: 'missing' };
  }
  const matches = (await store.listRoutines(turn.workspaceId, turn.channelId))
    .filter((routine) => routine.deletedAt === null && normalizeRoutineName(routine.name) === normalizedName);
  if (matches.length === 1) return { kind: 'found', routine: matches[0]! };
  if (matches.length > 1) return { kind: 'ambiguous', routines: matches };
  return { kind: 'missing' };
}

function normalizeRoutineName(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function messageContainsRoutineName(message: string, normalizedName: string): boolean {
  const escaped = normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'u')
    .test(normalizeRoutineName(message));
}

function ambiguousNameText(name: string, routines: readonly RoutineDefinition[]): string {
  return [
    `**More than one routine is named ${name}.** No change was made:`,
    ...routines.map((routine) => `- **${routine.name}** · \`${routine.id}\``),
    'Use an exact ID, for example `!routines show <id>`.',
  ].join('\n');
}

async function resolveRoutineDefaultTimezone(
  turn: NormalizedSlackTurn,
  env: PlatformEnv | undefined,
  admittedBotToken?: string,
): Promise<string> {
  try {
    const botToken = admittedBotToken ?? (await resolveSlackCredentials(env)).botToken;
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

function explicitCreatedRoutineName(
  requestText: string,
  action: RoutineIntent['action'],
): string | undefined {
  if (action !== 'create') return undefined;
  const text = requestText.replace(/^\s*(?:<@[^>\s]+>\s*)+/i, '');
  const match = /\b(?:named|called)\s+["“]([^"”\n]{1,200})["”]/iu.exec(text);
  return match?.[1]?.trim() || undefined;
}

function normalizeRoutineTimezone(value: string): string {
  const aliases: Record<string, string> = {
    pt: 'America/Los_Angeles',
    pst: 'America/Los_Angeles',
    pdt: 'America/Los_Angeles',
    pacific: 'America/Los_Angeles',
    'pacific time': 'America/Los_Angeles',
    mt: 'America/Denver',
    mst: 'America/Denver',
    mdt: 'America/Denver',
    mountain: 'America/Denver',
    'mountain time': 'America/Denver',
    ct: 'America/Chicago',
    cst: 'America/Chicago',
    cdt: 'America/Chicago',
    central: 'America/Chicago',
    'central time': 'America/Chicago',
    et: 'America/New_York',
    est: 'America/New_York',
    edt: 'America/New_York',
    eastern: 'America/New_York',
    'eastern time': 'America/New_York',
    gmt: 'UTC',
    utc: 'UTC',
  };
  return aliases[value.trim().toLocaleLowerCase('en-US')] ?? value.trim();
}

function isExplicitRoutineMutationRequest(rawText: string): boolean {
  const text = rawText.replace(/^\s*(?:<@[^>\s]+>\s*)+/i, '').trim();
  return /\b(?:create|add|set\s*up|schedule|edit|update|change|pause|resume|enable|disable|run|clone|copy|delete|remove)\b[^.\n?!]{0,80}\b(?:routine|scheduled\s+(?:job|work))\b/i.test(text);
}

function requestsSubminimumMinuteInterval(rawText: string): boolean {
  const text = rawText.replace(/^\s*(?:<@[^>\s]+>\s*)+/i, '').trim();
  const match = /\bevery\s+(minute|one|two|three|four|\d+)\s*(?:minutes?|mins?)?\b/i.exec(text);
  if (!match) return false;
  const words: Record<string, number> = { minute: 1, one: 1, two: 2, three: 3, four: 4 };
  const value = words[match[1]!.toLocaleLowerCase('en-US')] ?? Number(match[1]);
  return Number.isFinite(value) && value > 0 && value < 5;
}

function unclearRoutineIntentText(): string {
  return 'I could not safely understand that routine request. Try a clearer schedule and task, or use `!routines help`.';
}

function routineErrorText(error: unknown): string {
  if (error instanceof RoutineStateError) return error.message;
  return 'Chickpea could not safely prepare that routine. Try an explicit recurrence, five-field cron, and IANA time zone, or use `!routines help`.';
}

function notFoundText(): string {
  return 'That routine or channel was not found or is unavailable.';
}
