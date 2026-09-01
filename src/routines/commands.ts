import type { PlatformEnv } from '../config/state-backend.ts';
import type { WebClient } from '@slack/web-api';
import { getConfigStore, getIdentityStore, getRoutineStore } from '../config/state-backend.ts';
import { CHICKPEA_AGENT_ID } from '../config/agent-id.ts';
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
  hashRoutineValue,
  routineDestinationBindingDigest,
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
  executeSlackScheduleCommand,
  SlackScheduleCommandError,
} from './slack-command.ts';
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

type RoutineCommand =
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
  config: ConfigStore;
  resolveIdentity: () => IdentityStore;
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

type RoutineResponseVisibility = 'channel' | 'requester';

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
  if (!isRoutineSlackTurn(turn)) return undefined;
  let identity = dependencies.identity;
  const resolveIdentity = (): IdentityStore => {
    identity ??= getIdentityStore(env);
    return identity;
  };
  const activeActor = dependencies.isActiveActor ?? ((input) =>
    isActiveRoutineActor(input, {
      identity: resolveIdentity(),
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
  const config = dependencies.config ?? getConfigStore(env);
  const now = dependencies.now ?? Date.now;
  const capability = dependencies.capability ?? routineCapability();
  const canManageChannel = dependencies.canManageChannel ?? canManageRoutineChannel;
  const botToken = dependencies.installationContext?.botToken;
  const slackClient = dependencies.installationContext?.client;
  const commandContext: RoutineCommandExecutionContext = {
    turn, store, config, resolveIdentity, env, capability, now, canManageChannel,
    bindAuthority: dependencies.bindAuthority ?? ((input) =>
      bindRoutineAgentAuthority(input, {
        ...(dependencies.config ? { config: dependencies.config } : {}),
        identity: resolveIdentity(),
      })),
    resolveAuthority: dependencies.resolveAuthority ?? ((routine, runtimeEnv) =>
      resolveRoutineAgentAuthority(routine, runtimeEnv, {
        ...(dependencies.config ? { config: dependencies.config } : {}),
        identity: resolveIdentity(),
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
    turn, store, config, resolveIdentity, env, capability, now, canManageChannel, botToken, slackClient, assignment,
    bindAuthority, resolveAuthority,
  } = context;
  const service = new RoutineService(store, { now });
  if (command.kind === 'help' || command.kind === 'invalid') return renderRoutineHelp();
  if (command.kind === 'list') {
    if (turn.channelType === 'im') {
      if (command.channelMention) return notFoundText();
      const routines = await scopedDirectRoutines(
        store,
        context.config,
        turn,
        assignment,
      );
      const suffix = capability.enabled
        ? ''
        : `\n\n_${capability.reason === 'unsupported_target' ? 'Scheduling is currently Cloudflare-only.' : 'Scheduling is disabled by the deployment operator.'}_`;
      return renderRoutineList(routines, turn.channelId, { destinationKind: 'direct_thread' }) + suffix;
    }
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
  if (turn.channelType !== 'im' && !(await canManageChannel(
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
    if (confirmation.draft.action === 'delete' && turn.channelType === 'im') {
      const scope = await scopedRoutine(
        store, context.config, confirmation.draft.routineId, turn, assignment,
      );
      if (scope.kind === 'handoff') return directAgentHandoffText();
      if (scope.kind !== 'allowed') return notFoundText();
    }
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
    const confirmation = await store.getConfirmation(hashRoutineValue(command.token));
    if (confirmation?.draft.action === 'delete' && turn.channelType === 'im') {
      const scope = await scopedRoutine(
        store, context.config, confirmation.draft.routineId, turn, assignment,
      );
      if (scope.kind === 'handoff') return directAgentHandoffText();
      if (scope.kind !== 'allowed') return notFoundText();
    }
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

  const scope = await scopedRoutine(
    store, context.config, command.routineId, turn, assignment,
  );
  if (scope.kind === 'handoff') return directAgentHandoffText();
  if (scope.kind !== 'allowed') return notFoundText();
  const routine = scope.routine;
  if (command.kind === 'show') {
    const [runs, revisions] = await Promise.all([
      store.listRuns({ routineId: routine.id, limit: 5 }),
      store.listRevisions(routine.id),
    ]);
    const provenance = revisions.find((revision) => revision.version === routine.version)?.provenance ?? null;
    return renderRoutineDetail(routine, runs, provenance);
  }
  if (command.kind === 'control') {
    const result = await executeSlackScheduleCommand({
      kind: 'control',
      actionKey: turn.eventId,
      itemId: `${command.action}:${routine.id}`,
      actorUserId: turn.userId,
      actorClass: 'member',
      routineId: routine.id,
      expectedVersion: routine.version,
      action: command.action,
    }, {
      routines: store,
      config,
      identity: resolveIdentity(),
      schedulingAvailable: capability.available,
      now,
    });
    const updated = result.routine;
    const verb = command.action === 'pause' ? 'paused' : command.action === 'resume' ? 'resumed' : 'disabled';
    const icon = command.action === 'pause' ? '⏸️' : command.action === 'resume' ? '▶️' : '⏹️';
    return `${icon} **Routine ${verb}**\n**Name:** ${updated.name}\n**ID:** \`${updated.id}\``;
  }
  if (command.kind === 'run') {
    const authority = await resolveAuthority(routine, env);
    if (assignment && !isChickpeaAssignment(assignment) &&
        authority.reference.agentId !== assignment.agentId) return notFoundText();
    await executeSlackScheduleCommand({
      kind: 'run',
      actionKey: turn.eventId,
      itemId: `run:${routine.id}`,
      actorUserId: turn.userId,
      routineId: routine.id,
    }, {
      routines: store,
      config,
      identity: resolveIdentity(),
      schedulingAvailable: capability.available,
      now,
      resolveAuthority: async () => authority,
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
    const owningAssignment = routine.destination.kind === 'direct_thread'
      ? (await resolveAuthority(routine, env)).assignment
      : assignment;
    const destination = turn.channelType === 'im' && turn.actorMembershipId
      ? {
          kind: 'direct_thread' as const,
          conversationId: turn.channelId,
          threadTs: turn.threadTs,
          ownerMembershipId: turn.actorMembershipId,
        }
      : undefined;
    const created = await service.save({
      action: 'create',
      actorId: turn.userId,
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      ...(destination ? { destination } : {}),
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
      sourceVisibility: destination
        ? 'private'
        : await resolveRoutineSourceVisibility(
            turn.workspaceId,
            turn.channelId,
            env,
            botToken,
            slackClient,
          ),
    }, `routine:slack:${turn.eventId}:clone:${routine.id}`);
    const activated = await bindSavedRoutineAuthority(
      created, owningAssignment, turn, env, service, store, bindAuthority,
    );
    return renderRoutineSaved(activated, { action: 'create' });
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
  store: RoutineStore,
  bindAuthority: typeof bindRoutineAgentAuthority,
): Promise<RoutineDefinition> {
  const pendingDirect = routine.destination.kind === 'direct_thread' &&
    routine.state === 'pending_authority';
  if (!assignment || !turn.actorMembershipId) {
    if (!pendingDirect) {
      await service.control({
        routineId: routine.id,
        expectedVersion: routine.version,
        action: 'pause',
        actorId: turn.userId,
        actorClass: 'member',
        reasonCode: 'schedule_authority_missing',
        idempotencyKey: `routine:authority-missing:${routine.id}:${routine.version}`,
      });
    }
    throw new RoutineStateError(
      'routine_access_denied',
      pendingDirect
        ? 'The private schedule was saved inactive because its Agent or requesting member was unavailable.'
        : 'The schedule was saved paused because its Agent or Runs as member was unavailable.',
    );
  }
  try {
    const reference = await bindAuthority({
      routine,
      assignment,
      actorMembershipId: turn.actorMembershipId,
      env,
    });
    if (routine.destination.kind === 'direct_thread') {
      return store.activateDirectRoutine({
        routineId: routine.id,
        expectedVersion: routine.version,
        expectedReferenceRevision: reference.revision,
        destinationBindingDigest: routineDestinationBindingDigest(
          routine.id,
          routine.workspaceId,
          routine.destination,
        ),
      });
    }
    return routine;
  } catch (error) {
    if (!pendingDirect) {
      await service.control({
        routineId: routine.id,
        expectedVersion: routine.version,
        action: 'pause',
        actorId: turn.userId,
        actorClass: 'member',
        reasonCode: 'schedule_authority_missing',
        idempotencyKey: `routine:authority-failed:${routine.id}:${routine.version}`,
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function scopedRoutine(
  store: RoutineStore,
  config: ConfigStore,
  routineId: string,
  turn: NormalizedSlackTurn,
  assignment: ResolvedAssignment | undefined,
): Promise<
  | { kind: 'allowed'; routine: RoutineDefinition }
  | { kind: 'handoff' }
  | { kind: 'missing' }
> {
  const routine = await store.getRoutine(routineId);
  if (!routine || routine.deletedAt !== null || routine.workspaceId !== turn.workspaceId ||
      routine.channelId !== turn.channelId) return { kind: 'missing' };
  if (routine.destination.kind === 'channel') return { kind: 'allowed', routine };
  if (turn.channelType !== 'im' || !turn.actorMembershipId || !assignment ||
      routine.destination.conversationId !== turn.channelId ||
      routine.destination.ownerMembershipId !== turn.actorMembershipId) {
    return { kind: 'missing' };
  }
  const reference = await config.getAgentScheduleReference(routine.id);
  if (!reference || reference.destinationKind !== 'direct_thread' ||
      reference.createdByMembershipId !== turn.actorMembershipId) {
    return { kind: 'missing' };
  }
  if (!isChickpeaAssignment(assignment) && reference.agentId !== assignment.agentId) {
    return { kind: 'handoff' };
  }
  return { kind: 'allowed', routine };
}

async function scopedDirectRoutines(
  store: RoutineStore,
  config: ConfigStore,
  turn: NormalizedSlackTurn,
  assignment: ResolvedAssignment | undefined,
): Promise<RoutineDefinition[]> {
  if (turn.channelType !== 'im' || !turn.actorMembershipId || !assignment) return [];
  const routines = await store.listRoutines(turn.workspaceId, turn.channelId);
  const visible = await Promise.all(routines.map(async (routine) => {
    const scope = await scopedRoutine(store, config, routine.id, turn, assignment);
    return scope.kind === 'allowed' ? scope.routine : undefined;
  }));
  return visible.filter((routine): routine is RoutineDefinition => routine !== undefined);
}

function routineCapability(): RoutineCapability {
  return resolveRoutineCapability({ cloudflare: isCloudflareTarget() });
}

function isChickpeaAssignment(assignment: ResolvedAssignment): boolean {
  return assignment.agentId === CHICKPEA_AGENT_ID && assignment.agent.kind === 'system';
}

function directAgentHandoffText(): string {
  return 'Mention @Chickpea in this DM to manage scheduled work owned by another Agent.';
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
  if (error instanceof RoutineStateError || error instanceof SlackScheduleCommandError) {
    return error.message;
  }
  return 'Chickpea could not safely manage that routine. Try `!routines help`.';
}

function notFoundText(): string {
  return 'That routine or channel was not found or is unavailable.';
}
