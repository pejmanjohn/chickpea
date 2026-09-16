import {
  getConfigStore,
  getManagementStore,
  getRoutineStore,
  getSettingsStore,
  getWorkStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import { purgeExpiredImageOutputs } from '../images/output-store.ts';
import { createLiveWorkspaceManagementService } from '../management/live-service.ts';
import { reconcileScheduleActionReceipts } from '../management/receipts.ts';
import { retryDueSlackScheduleActions } from '../management/slack-schedule-actions.ts';
import type { ManagementRequestRecord } from '../management/types.ts';
import { createPlatformProductTelemetry } from '../telemetry/platform.ts';
import type { RoutineScheduleAction, RoutineStore } from './types.ts';
import { runRoutineHeartbeat } from './heartbeat.ts';
import { settleScheduledDuties } from './scheduler-adapter.ts';

type ScheduleRetryInput = Parameters<typeof retryDueSlackScheduleActions>[0];

interface NodeScheduledDutyDependencies {
  runHeartbeat?: typeof runRoutineHeartbeat;
  retryScheduleActions?: typeof retryDueSlackScheduleActions;
  reconcileReceipts?: typeof reconcileScheduleActionReceipts;
  purgeImages?: typeof purgeExpiredImageOutputs;
  routines?: RoutineStore;
  management?: ReturnType<typeof getManagementStore>;
  service?: ScheduleRetryInput['dependencies']['service'];
  settings?: ReturnType<typeof getSettingsStore>;
  work?: ReturnType<typeof getWorkStore>;
  config?: ReturnType<typeof getConfigStore>;
}

/** Run every durable duty that Cloudflare's alarms provide for a Node install. */
export async function runNodeScheduledDuties(
  input: { scheduledTime: number; owner: string; env?: PlatformEnv },
  dependencies: NodeScheduledDutyDependencies = {},
): Promise<void> {
  const env = input.env ?? {};
  const routines = dependencies.routines ?? getRoutineStore(env);
  const management = dependencies.management ?? getManagementStore(env);
  const settings = dependencies.settings ?? getSettingsStore(env);
  const work = dependencies.work ?? getWorkStore(env);
  const productTelemetry = createPlatformProductTelemetry({
    settings,
    config: dependencies.config ?? getConfigStore(env),
  });
  await settleScheduledDuties([
    () => drainNodeScheduleActions({
      at: input.scheduledTime,
      owner: input.owner,
      env,
      routines,
      management,
      ...(dependencies.service ? { service: dependencies.service } : {}),
      retry: dependencies.retryScheduleActions ?? retryDueSlackScheduleActions,
      reconcile: dependencies.reconcileReceipts ?? reconcileScheduleActionReceipts,
    }),
    () => (dependencies.runHeartbeat ?? runRoutineHeartbeat)({
      scheduledTime: input.scheduledTime,
      owner: input.owner,
      env,
      productTelemetry,
      store: routines,
    }),
    () => work.purgeContent(input.scheduledTime, 100),
    () => (dependencies.purgeImages ?? purgeExpiredImageOutputs)(settings, input.scheduledTime),
  ]);
}

async function drainNodeScheduleActions(input: {
  at: number;
  owner: string;
  env: PlatformEnv;
  routines: RoutineStore;
  management: ReturnType<typeof getManagementStore>;
  service?: ScheduleRetryInput['dependencies']['service'];
  retry: typeof retryDueSlackScheduleActions;
  reconcile: typeof reconcileScheduleActionReceipts;
}): Promise<void> {
  const nextDueAt = await input.routines.nextScheduleActionDueAt();
  if (nextDueAt === undefined || nextDueAt > input.at) {
    await input.reconcile({
      routines: input.routines,
      management: input.management,
      at: input.at,
    });
    return;
  }
  await input.retry({
    dependencies: {
      management: input.management,
      routines: input.routines,
      service: input.service ?? createLiveWorkspaceManagementService(input.env),
      owner: `${input.owner}:schedule-actions`,
      now: () => input.at,
    },
    resolveContext: resolveScheduleActionContext,
  });
}

async function resolveScheduleActionContext(
  action: RoutineScheduleAction,
  request: ManagementRequestRecord,
) {
  return {
    userId: action.actorUserId,
    membershipId: action.actorMembershipId,
    organizationId: request.organizationId,
    actingAgentId: action.agentId,
    origin: {
      kind: 'slack' as const,
      workspaceId: action.workspaceId,
      channelId: action.channelId,
      threadTs: action.threadTs,
      messageTs: action.messageTs,
      conversationKind: action.conversationKind,
      agentId: action.agentId,
    },
  };
}
