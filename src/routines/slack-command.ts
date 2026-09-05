import type { ConfigStore } from '../config/store.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import type { IdentityStore } from '../identity/types.ts';
import {
  bindRoutineAgentAuthority,
  resolveRoutineAgentAuthority,
} from './agent-authority.ts';
import {
  createRoutineRunId,
  hashRoutineValue,
  routineDestinationBindingDigest,
  runNowOccurrenceKey,
} from './ids.ts';
import { ROUTINE_LIMITS } from './limits.ts';
import {
  normalizeOneTimeSchedule,
  normalizeRelativeOneTimeSchedule,
  normalizeRoutineSchedule,
} from './schedule.ts';
import { RoutineService } from './service.ts';
import { normalizeAuthorityText } from './provenance.ts';
import {
  RoutineStateError,
  type RoutineDefinition,
  type RoutineOutputPolicy,
  type RoutineStore,
} from './types.ts';

export type SlackScheduleCommand =
  | {
      kind: 'save';
      actionKey: string;
      itemId: string;
      actorUserId: string;
      actorMembershipId: string;
      workspaceId: string;
      channelId: string;
      agentId: string;
      channelThreadTs?: string;
      sourceRequest?: {
        requestText: string;
        eventId: string;
        messageTs: string;
        threadTs: string;
      };
      directDestination?: {
        conversationId: string;
        threadTs: string;
        ownerMembershipId: string;
      };
      routineId?: string;
      expectedVersion?: number;
      name: string;
      description: string;
      taskText: string;
      schedule:
        | { kind: 'cron'; expression: string }
        | { kind: 'once'; localDateTime: string }
        | { kind: 'in'; minutes: number };
      timezone: string;
      outputPolicy: RoutineOutputPolicy;
    }
  | {
      kind: 'control';
      actionKey: string;
      itemId: string;
      actorUserId: string;
      actorClass?: 'operator' | 'member';
      routineId: string;
      expectedVersion: number;
      action: 'pause' | 'resume' | 'disable';
    }
  | {
      kind: 'run';
      actionKey: string;
      itemId: string;
      actorUserId: string;
      routineId: string;
    };

type SlackScheduleCommandResult =
  | { effect: 'saved'; routine: RoutineDefinition; created: boolean }
  | { effect: 'controlled'; routine: RoutineDefinition }
  | { effect: 'run_queued'; routine: RoutineDefinition; runId: string };

export class SlackScheduleCommandError extends Error {
  readonly name = 'SlackScheduleCommandError';

  constructor(
    readonly code:
      | 'routines_unavailable_on_target'
      | 'schedule_authority_missing'
      | 'schedule_safety_pending'
      | 'schedule_command_failed',
    message: string,
    readonly safeRoutine?: Pick<RoutineDefinition, 'id' | 'version' | 'state'>,
  ) {
    super(message);
  }
}

interface SlackScheduleCommandDependencies {
  routines: RoutineStore;
  config: ConfigStore;
  identity: IdentityStore;
  schedulingAvailable: boolean | (() => boolean | Promise<boolean>);
  now?: () => number;
  createRunId?: () => string;
  bindAuthority?: typeof bindRoutineAgentAuthority;
  resolveAuthority?: typeof resolveRoutineAgentAuthority;
}

/**
 * Apply one already-authorized schedule mutation. This is the single effect
 * boundary used by both workspace-management sagas and first-class Slack
 * schedule actions. Callers must authorize and derive destinations from
 * trusted host context before invoking it.
 */
export async function executeSlackScheduleCommand(
  command: SlackScheduleCommand,
  dependencies: SlackScheduleCommandDependencies,
): Promise<SlackScheduleCommandResult> {
  const now = dependencies.now ?? Date.now;
  const service = new RoutineService(dependencies.routines, {
    now,
    routineId: () => deterministicRoutineId(command.actionKey, command.itemId),
  });

  try {
    if (command.kind === 'control') {
      if (command.action === 'resume') await requireSchedulingAvailable(dependencies);
      const routine = await service.control({
        routineId: command.routineId,
        expectedVersion: command.expectedVersion,
        action: command.action,
        actorId: command.actorUserId,
        actorClass: command.actorClass ?? 'operator',
        reasonCode: 'workspace_management',
        idempotencyKey: effectKey(command, `control:${command.action}`),
      });
      return { effect: 'controlled', routine };
    }

    if (command.kind === 'run') {
      await requireSchedulingAvailable(dependencies);
      const routine = await dependencies.routines.getRoutine(command.routineId);
      if (!routine || routine.deletedAt !== null) {
        throw new RoutineStateError('routine_not_found', 'The routine was not found.');
      }
      if (routine.triggerKind === 'once') {
        throw new RoutineStateError(
          'routine_one_time_run_unsupported',
          'A one-time job runs only at its scheduled time. Create another one-time job for a different time.',
        );
      }
      const resolveAuthority = dependencies.resolveAuthority ?? ((candidate) =>
        resolveRoutineAgentAuthority(candidate, undefined, {
          config: dependencies.config,
          identity: dependencies.identity,
        }));
      await resolveAuthority(routine, undefined);
      const at = now();
      const run = await dependencies.routines.createOccurrence({
        runId: (dependencies.createRunId ?? createRoutineRunId)(),
        idempotencyKey: runNowOccurrenceKey(routine.id, command.actionKey),
        routineId: routine.id,
        routineVersion: routine.version,
        scheduledFor: at,
        triggerSource: 'run_now',
        requestedBy: command.actorUserId,
        queuedAt: at,
        deadlineAt: at + ROUTINE_LIMITS.occurrenceDeadlineMs,
      });
      return { effect: 'run_queued', routine, runId: run.id };
    }

    await requireSchedulingAvailable(dependencies);
    const projection = command.schedule.kind === 'cron'
      ? normalizeRoutineSchedule(command.schedule.expression, command.timezone, now())
      : command.schedule.kind === 'once'
        ? normalizeOneTimeSchedule(command.schedule.localDateTime, command.timezone, now())
        : normalizeRelativeOneTimeSchedule(command.schedule.minutes, command.timezone, now());
    const existing = command.routineId
      ? await dependencies.routines.getRoutine(command.routineId)
      : undefined;
    const priorCreate = command.routineId
      ? undefined
      : await dependencies.routines.getRoutine(
          deterministicRoutineId(command.actionKey, command.itemId),
        );
    const created = !command.routineId && !priorCreate;
    const direct = Boolean(command.directDestination) || existing?.destination.kind === 'direct_thread';
    const definition = {
      name: command.name,
      description: command.description,
      taskText: command.taskText,
      triggerKind: command.schedule.kind === 'cron' ? 'schedule' as const : 'once' as const,
      scheduleInput: projection.schedule.kind === 'cron'
        ? projection.schedule.expression
        : projection.schedule.localDateTime,
      scheduleJson: projection.scheduleJson,
      timezone: command.timezone,
      outputPolicy: command.outputPolicy,
      authorityMode: direct ? 'live_direct_member_v1' as const : 'live_channel_v1' as const,
    };
    const request = command.routineId
      ? {
          action: 'edit' as const,
          routineId: command.routineId,
          ...(command.expectedVersion !== undefined
            ? { expectedVersion: command.expectedVersion }
            : {}),
          definition,
        }
      : { action: 'create' as const, definition };
    const routine = await service.save({
      ...request,
      actorId: command.actorUserId,
      actorClass: 'operator',
      workspaceId: command.workspaceId,
      channelId: command.channelId,
      ...(!existing && command.directDestination
        ? { destination: { kind: 'direct_thread' as const, ...command.directDestination } }
        : command.channelThreadTs
          ? { destination: { kind: 'channel' as const, channelId: command.channelId, threadTs: command.channelThreadTs } }
          : {}),
      nextRunAt: projection.nextRunAt,
      projectedDailyStarts: projection.projectedDailyStarts,
      reservations: projection.reservations,
      sourceVisibility: direct ? 'private' : 'unknown',
      ...(command.sourceRequest ? { provenance: {
        ...command.sourceRequest,
        sourceKind: 'slack_request' as const,
        ...(existing && normalizeAuthorityText(command.taskText) === normalizeAuthorityText(existing.taskText)
          ? {
              authoritySource: 'previous_revision' as const,
              sourceRoutineId: existing.id,
              sourceRoutineVersion: existing.version,
            }
          : { authoritySource: 'current_request' as const }),
      } } : {}),
    }, effectKey(command, 'save'));

    try {
      const agent = await dependencies.config.getAgent(command.agentId);
      const assignment: ResolvedAssignment = {
        workspaceId: command.workspaceId,
        channelId: command.channelId,
        agentId: agent.id,
        agent,
      };
      const bindAuthority = dependencies.bindAuthority ?? ((input) =>
        bindRoutineAgentAuthority(input, {
          config: dependencies.config,
          identity: dependencies.identity,
        }));
      const reference = await bindAuthority({
        routine,
        assignment,
        actorMembershipId: command.actorMembershipId,
        env: undefined,
      });
      if (!existing && routine.destination.kind === 'direct_thread') {
        const digest = routineDestinationBindingDigest(
          routine.id,
          routine.workspaceId,
          routine.destination,
        );
        const activated = await dependencies.routines.activateDirectRoutine({
          routineId: routine.id,
          expectedVersion: routine.version,
          expectedReferenceRevision: reference.revision,
          destinationBindingDigest: digest,
        });
        return { effect: 'saved', routine: activated, created };
      }
    } catch {
      const pendingDirect = routine.destination.kind === 'direct_thread' &&
        routine.state === 'pending_authority';
      const safeRoutine = pendingDirect
        ? routine
        : await proveAuthorityFailureSafeState(
            dependencies.routines,
            routine.id,
            () => service.control({
              routineId: routine.id,
              expectedVersion: routine.version,
              action: 'pause',
              actorId: command.actorUserId,
              actorClass: 'operator',
              reasonCode: 'schedule_authority_missing',
              idempotencyKey: effectKey(command, 'authority-failed'),
            }),
          );
      throw new SlackScheduleCommandError(
        'schedule_authority_missing',
        pendingDirect
          ? 'The private schedule was saved inactive because its Agent authority could not be bound.'
          : 'The schedule was saved paused because its Agent authority could not be bound.',
        safeRoutine,
      );
    }
    return { effect: 'saved', routine, created };
  } catch (error) {
    if (error instanceof SlackScheduleCommandError || error instanceof RoutineStateError) throw error;
    console.warn('[chickpea:routines] schedule command failed', JSON.stringify({
      errorName: error instanceof Error ? error.name : 'unknown',
    }));
    throw new SlackScheduleCommandError(
      'schedule_command_failed',
      'The schedule command could not be applied.',
    );
  }
}

async function proveAuthorityFailureSafeState(
  routines: RoutineStore,
  routineId: string,
  compensate: () => Promise<RoutineDefinition>,
): Promise<RoutineDefinition> {
  try {
    const compensated = await compensate();
    if (isAuthorityFailureSafeState(compensated)) return compensated;
  } catch {
    try {
      const observed = await routines.getRoutine(routineId);
      if (observed && isAuthorityFailureSafeState(observed)) return observed;
    } catch {
      // The state owner must prove the safe state; a failed read cannot do so.
    }
    throw new SlackScheduleCommandError(
      'schedule_safety_pending',
      'The schedule is still recovering from an authority-binding failure.',
    );
  }
  throw new SlackScheduleCommandError(
    'schedule_safety_pending',
    'The schedule is still recovering from an authority-binding failure.',
  );
}

function isAuthorityFailureSafeState(
  routine: Pick<RoutineDefinition, 'state'>,
): boolean {
  return routine.state === 'paused' ||
    routine.state === 'disabled' ||
    routine.state === 'pending_authority';
}

function deterministicRoutineId(actionKey: string, itemId: string): string {
  return `routine_${hashRoutineValue(`${actionKey}:${itemId}`).slice(0, 32)}`;
}

function effectKey(
  command: Pick<SlackScheduleCommand, 'actionKey' | 'itemId'>,
  effect: string,
): string {
  return `schedule-command:${command.actionKey}:${command.itemId}:${effect}`;
}

async function requireSchedulingAvailable(
  dependencies: SlackScheduleCommandDependencies,
): Promise<void> {
  const available = typeof dependencies.schedulingAvailable === 'function'
    ? await dependencies.schedulingAvailable()
    : dependencies.schedulingAvailable;
  if (!available) {
    throw new SlackScheduleCommandError(
      'routines_unavailable_on_target',
      'Routine scheduling is unavailable on this deployment.',
    );
  }
}
