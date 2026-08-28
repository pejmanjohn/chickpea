import { CHICKPEA_AGENT_ID } from '../config/agent-id.ts';
import { scheduleActionId } from '../routines/ids.ts';
import type {
  RoutineScheduleAction,
  RoutineScheduleActionResult,
  RoutineStore,
} from '../routines/types.ts';
import {
  managementActorOriginKey,
  managementOperationDigest,
  validateManagementOperations,
} from './contracts.ts';
import { reconcileScheduleActionReceipts } from './receipts.ts';
import type { WorkspaceManagementService } from './service.ts';
import type { ManagementStore } from './store.ts';
import {
  ManagementError,
  type ManagementActorContext,
  type ManagementOperation,
} from './types.ts';
import type { SlackManagementSignal } from './slack-tools.ts';

const ACTION_LEASE_MS = 30_000;
const ACTION_MAX_ATTEMPTS = 3;

export type SlackScheduleManagementOperation = Extract<ManagementOperation, {
  kind: 'save_routine' | 'control_routine';
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
  const [validated] = validateManagementOperations([operation]) as [SlackScheduleManagementOperation];
  const digest = managementOperationDigest([validated]);
  const actionId = scheduleActionId(input.signal.turnJobId, digest);
  const publicIdempotencyKey = `schedule-action:${actionId}`;
  const storageIdempotencyKey = input.context.actingAgentId
    ? `agent.${input.context.actingAgentId}.${publicIdempotencyKey}`
    : publicIdempotencyKey;
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

/** Retry actions already admitted by a prior RPC or interrupted Agent turn. */
export async function retryDueSlackScheduleActions(input: {
  dependencies: SlackScheduleActionDependencies;
  resolveContext(action: RoutineScheduleAction): Promise<ManagementActorContext>;
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
        (operation?.kind !== 'save_routine' && operation?.kind !== 'control_routine')) {
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
      context = await input.resolveContext(action);
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
    });
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
          effect: input.operation.kind === 'save_routine' ? 'saved' : 'controlled',
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
      },
      at: input.now(),
    });
  } catch (error) {
    if (error instanceof ManagementError) {
      return input.dependencies.routines.settleScheduleAction({
        actionId: input.action.actionId,
        owner,
        expectedAttempt: input.action.attempts,
        result: { outcome: 'failed', code: safeFailureCode(error.code) },
        at: input.now(),
      });
    }
    if (input.action.attempts >= ACTION_MAX_ATTEMPTS) {
      return input.dependencies.routines.settleScheduleAction({
        actionId: input.action.actionId,
        owner,
        expectedAttempt: input.action.attempts,
        result: { outcome: 'failed', code: 'schedule_internal_failure' },
        at: input.now(),
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

function safeFailureCode(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 80);
  return normalized || 'schedule_failed';
}

function retryDelay(attempt: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt - 1));
}
