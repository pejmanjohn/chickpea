import type { PlatformEnv } from '../config/state-backend.ts';
import type { WebClient } from '@slack/web-api';
import { getRoutineStore } from '../config/state-backend.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import type { ConfigStore } from '../config/store.ts';
import type { IdentityStore } from '../identity/types.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import type { NormalizedSlackTurn } from '../slack/types.ts';
import {
  stripResolvedSlackCommandAddress,
  type SlackCommandAddress,
} from '../slack/command-address.ts';
import type { SlackInstallationExecutionContext } from '../slack/installation-execution.ts';
import {
  createRoutineRunId,
  hashRoutineValue,
  runNowOccurrenceKey,
} from './ids.ts';
import { ROUTINE_LIMITS } from './limits.ts';
import {
  renderRoutineDeletionConfirmation,
  renderRoutineDetail,
  renderRoutineHelp,
  renderRoutineList,
  renderRoutineSaved,
} from './message-format.ts';
import { normalizeRoutineSchedule } from './schedule.ts';
import {
  requireRoutineScheduling,
  resolveRoutineCapability,
  type RoutineCapability,
} from './scheduler-adapter.ts';
import { RoutineService } from './service.ts';
import {
  bindRoutineAgentAuthority,
  isActiveRoutineActor,
  resolveRoutineAgentAuthority,
} from './agent-authority.ts';
import {
  canManageRoutineChannel,
  isRoutineSlackTurn,
  parseSlackChannelMention,
  resolveRoutineSourceVisibility,
} from './slack-context.ts';
import {
  RoutineStateError,
  type RoutineDefinition,
  type RoutineDefinitionContent,
  type RoutineStore,
} from './types.ts';

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

interface RoutineCommandExecutionContext {
  turn: NormalizedSlackTurn;
  store: RoutineStore;
  env: PlatformEnv | undefined;
  capability: RoutineCapability;
  now: () => number;
  canManageChannel: typeof canManageRoutineChannel;
  botToken?: string;
  slackClient?: WebClient;
  assignment?: ResolvedAssignment;
  bindAuthority: typeof bindRoutineAgentAuthority;
  resolveAuthority: typeof resolveRoutineAgentAuthority;
}

const OPAQUE = '[A-Za-z0-9_-]{1,200}';
const TOKEN = '[A-Za-z0-9._-]{4,512}';

export function parseRoutineCommand(
  rawText: string,
  address: SlackCommandAddress = {},
): RoutineCommand | undefined {
  const text = stripResolvedSlackCommandAddress(rawText, address).trim();
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

/** The complete deterministic routing boundary: an admitted Channel turn plus an exact command. */
export function shouldHandleRoutineCommandTurn(
  turn: NormalizedSlackTurn,
  address: SlackCommandAddress = {},
): boolean {
  return isRoutineSlackTurn(turn) && Boolean(parseRoutineCommand(turn.text, address));
}

export type RoutineResponseVisibility = 'channel' | 'requester';

/**
 * A current-channel routine list is Agent-owned and safe to show there. A
 * cross-channel list (including its non-disclosing failure) is visible only to
 * the requester in the invoking channel, matching Slack's requester-only
 * `chat.postEphemeral` surface.
 */
export function routineResponseVisibility(
  rawText: string,
  currentChannelId: string,
  address: SlackCommandAddress = {},
): RoutineResponseVisibility {
  const command = parseRoutineCommand(rawText, address);
  if (command?.kind !== 'list' || !command.channelMention) return 'channel';
  return parseSlackChannelMention(command.channelMention) === currentChannelId
    ? 'channel'
    : 'requester';
}

/** Execute only the explicit `!routines` control surface. Natural language belongs to Agent authoring. */
export async function handleRoutineSlackRequest(
  turn: NormalizedSlackTurn,
  env: PlatformEnv | undefined,
  dependencies: {
    store?: RoutineStore;
    config?: ConfigStore;
    identity?: IdentityStore;
    now?: () => number;
    capability?: RoutineCapability;
    canManageChannel?: typeof canManageRoutineChannel;
    installationContext?: SlackInstallationExecutionContext;
    assignment?: ResolvedAssignment;
    /** Test seam; production always uses the canonical Agent authority binder. */
    bindAuthority?: typeof bindRoutineAgentAuthority;
    /** Test seam; production always re-resolves live Agent authority. */
    resolveAuthority?: typeof resolveRoutineAgentAuthority;
    /** Test seam; production always revalidates the canonical member. */
    isActiveActor?: typeof isActiveRoutineActor;
  } = {},
): Promise<string | undefined> {
  const command = parseRoutineCommand(turn.text, {
    botUserId: dependencies.installationContext?.botUserId,
    agentUserGroupId: dependencies.assignment?.agent.slackPresence?.userGroupId,
  });
  if (!command) return undefined;
  const activeActor = dependencies.isActiveActor ?? ((input) =>
    isActiveRoutineActor(input, {
      ...(dependencies.identity ? { identity: dependencies.identity } : {}),
    }));
  if (
    !turn.actorMembershipId ||
    !(await activeActor({
      actorMembershipId: turn.actorMembershipId,
      workspaceId: turn.workspaceId,
      slackUserId: turn.userId,
      env,
    }))
  ) {
    return 'Only an active Chickpea member can manage schedules.';
  }
  const store = dependencies.store ?? getRoutineStore(env);
  const now = dependencies.now ?? Date.now;
  const capability = dependencies.capability ?? routineCapability();
  const canManageChannel = dependencies.canManageChannel ?? canManageRoutineChannel;
  const botToken = dependencies.installationContext?.botToken;
  const slackClient = dependencies.installationContext?.client;
  const commandContext: RoutineCommandExecutionContext = {
    turn, store, env, capability, now, canManageChannel,
    bindAuthority: dependencies.bindAuthority ?? ((input) =>
      bindRoutineAgentAuthority(input, {
        ...(dependencies.config ? { config: dependencies.config } : {}),
        ...(dependencies.identity ? { identity: dependencies.identity } : {}),
      })),
    resolveAuthority: dependencies.resolveAuthority ?? ((routine, runtimeEnv) =>
      resolveRoutineAgentAuthority(routine, runtimeEnv, {
        ...(dependencies.config ? { config: dependencies.config } : {}),
        ...(dependencies.identity ? { identity: dependencies.identity } : {}),
      })),
    ...(botToken ? { botToken } : {}),
    ...(slackClient ? { slackClient } : {}),
    ...(dependencies.assignment ? { assignment: dependencies.assignment } : {}),
  };
  try {
    return await executeRoutineCommand(command, commandContext);
  } catch (error) {
    return routineErrorText(error);
  }
}

async function executeRoutineCommand(
  command: RoutineCommand,
  context: RoutineCommandExecutionContext,
): Promise<string> {
  const {
    turn, store, env, capability, now, canManageChannel, botToken, slackClient, assignment,
    bindAuthority, resolveAuthority,
  } = context;
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
      !(await canManageChannel(
        turn.workspaceId, channelId, turn.userId, env, botToken, slackClient,
      ))
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
    slackClient,
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
    const authority = await resolveAuthority(routine, env);
    if (assignment && authority.reference.agentId !== assignment.agentId) return notFoundText();
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
        slackClient,
      ),
    }, `routine:slack:${turn.eventId}:clone:${routine.id}`);
    await bindSavedRoutineAuthority(created, assignment, turn, env, service, bindAuthority);
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

async function bindSavedRoutineAuthority(
  routine: RoutineDefinition,
  assignment: ResolvedAssignment | undefined,
  turn: NormalizedSlackTurn,
  env: PlatformEnv | undefined,
  service: RoutineService,
  bindAuthority: typeof bindRoutineAgentAuthority,
): Promise<void> {
  if (!assignment || !turn.actorMembershipId) {
    await service.control({
      routineId: routine.id,
      expectedVersion: routine.version,
      action: 'pause',
      actorId: turn.userId,
      actorClass: 'member',
      reasonCode: 'schedule_authority_missing',
      idempotencyKey: `routine:authority-missing:${routine.id}:${routine.version}`,
    });
    throw new RoutineStateError(
      'routine_access_denied',
      'The schedule was saved paused because its Agent or Runs as member was unavailable.',
    );
  }
  try {
    await bindAuthority({
      routine,
      assignment,
      actorMembershipId: turn.actorMembershipId,
      env,
    });
  } catch (error) {
    await service.control({
      routineId: routine.id,
      expectedVersion: routine.version,
      action: 'pause',
      actorId: turn.userId,
      actorClass: 'member',
      reasonCode: 'schedule_authority_missing',
      idempotencyKey: `routine:authority-failed:${routine.id}:${routine.version}`,
    }).catch(() => undefined);
    throw error;
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

function routineCapability(): RoutineCapability {
  return resolveRoutineCapability({ cloudflare: isCloudflareTarget() });
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

function routineErrorText(error: unknown): string {
  if (error instanceof RoutineStateError) return error.message;
  return 'Chickpea could not safely manage that routine. Try `!routines help`.';
}

function notFoundText(): string {
  return 'That routine or channel was not found or is unavailable.';
}
