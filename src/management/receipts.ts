import type { PlatformEnv } from '../config/state-backend.ts';
import type { IdentityStore } from '../identity/types.ts';
import {
  resolveSlackInstallationExecutionContext,
  type SlackInstallationExecutionResolver,
} from '../slack/installation-execution.ts';
import { SlackTransportError } from '../slack/transport/types.ts';
import type { ManagementStore } from './store.ts';
import type { RoutineStore } from '../routines/types.ts';
import type {
  ManagementReceiptDestination,
  ManagementReceiptOutboxRecord,
  ManagementReceipt,
  ManagementRoutineSavedAcknowledgement,
  ManagementScheduleActionAcknowledgement,
  ManagementSetupReceipt,
  ManagementSetupRecord,
} from './types.ts';
import { emitManagementMetric } from './telemetry.ts';

const OUTBOX_LEASE_MS = 30_000;
const OUTBOX_MAX_ATTEMPTS = 8;

/** Slack rejections a retry can never fix; settle them terminally at once. */
const PERMANENT_DELIVERY_CODES = new Set([
  'missing_scope',
  'not_allowed_token_type',
  'invalid_name',
  'channel_not_found',
  'message_not_found',
  'is_archived',
  'operation_not_allowed',
]);

export interface CompleteManagementSetupReceiptInput {
  setup: ManagementSetupRecord;
  browserSessionDigest: string;
  connector?: string;
  accountLabel?: string;
  initiator: string;
  at: number;
}

export async function completeManagementSetupReceipt(
  management: ManagementStore,
  input: CompleteManagementSetupReceiptInput,
): Promise<ManagementSetupRecord> {
  const receipt: ManagementSetupReceipt = {
    setupOperationId: input.setup.setupOperationId,
    connector: input.connector ?? input.setup.target.targetLabel,
    target: input.setup.target.agentName ?? input.setup.target.targetLabel,
    scopes: [...input.setup.scopes],
    initiator: input.initiator,
    ...(input.accountLabel ? { accountLabel: boundedLabel(input.accountLabel) } : {}),
    completedAt: input.at,
  };
  const outbox: ManagementReceiptOutboxRecord = {
    outboxId: `receipt_${input.setup.setupOperationId}`,
    operationId: input.setup.setupOperationId,
    destination: receiptDestination(input.setup),
    receipt,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: input.at,
    createdAt: input.at,
    updatedAt: input.at,
  };
  return management.completeSetup({
    setupOperationId: input.setup.setupOperationId,
    browserSessionDigest: input.browserSessionDigest,
    receipt,
    outbox,
    at: input.at,
  });
}

export function formatManagementSetupReceipt(receipt: ManagementReceipt): string {
  if (isRoutineSavedAcknowledgement(receipt) || isScheduleActionReaction(receipt)) {
    throw new Error('A reaction acknowledgement cannot be formatted as a setup receipt.');
  }
  if (isScheduleActionAcknowledgement(receipt)) {
    if (receipt.transition === 'pending') {
      return '⏳ I’m still setting up that scheduled work. I’ll post the final outcome here.';
    }
    if (receipt.transition === 'failed') {
      return scheduleActionFailureText(receipt.code);
    }
    throw new Error('An applied schedule acknowledgement requires a reaction destination.');
  }
  const subject = receipt.accountLabel ?? receipt.connector;
  const lead = `${subject} has been connected to ${receipt.connector} connector.`;
  const details = [
    `Target: ${receipt.target}`,
    `Scopes: ${receipt.scopes.length ? receipt.scopes.join(', ') : 'provider default'}`,
    `Initiated by: ${receipt.initiator}`,
    `Receipt: ${receipt.setupOperationId}`,
  ];
  return `${lead}\n${details.join(' · ')}`;
}

export interface ManagementReceiptDeliveryResult {
  deliveryRef: string;
}

export async function drainManagementReceiptOutbox(input: {
  management: ManagementStore;
  deliver(record: ManagementReceiptOutboxRecord): Promise<ManagementReceiptDeliveryResult>;
  now?: () => number;
  limit?: number;
}): Promise<{ delivered: number; retried: number; failed: number }> {
  const now = input.now ?? Date.now;
  const at = now();
  const claimed = await input.management.claimDueOutbox(
    at,
    input.limit ?? 10,
    at + OUTBOX_LEASE_MS,
  );
  let delivered = 0;
  let retried = 0;
  let failed = 0;
  for (const record of claimed) {
    try {
      const result = await input.deliver(record);
      await input.management.settleOutbox({
        outboxId: record.outboxId,
        outcome: 'delivered',
        at: now(),
        deliveryRef: result.deliveryRef,
      });
      delivered += 1;
    } catch (error) {
      const failureCode = receiptDeliveryFailureCode(error);
      const terminal = record.attempts >= OUTBOX_MAX_ATTEMPTS ||
        PERMANENT_DELIVERY_CODES.has(failureCode);
      await input.management.settleOutbox({
        outboxId: record.outboxId,
        outcome: terminal ? 'failed' : 'retry',
        at: now(),
        failureCode,
        ...(terminal ? {} : { nextAttemptAt: now() + receiptRetryDelay(record.attempts) }),
      });
      console.warn('[chickpea:management] receipt delivery failed', JSON.stringify({
        outboxId: record.outboxId,
        destination: record.destination.kind,
        attempt: record.attempts,
        terminal,
        failureCode,
      }));
      if (terminal) failed += 1;
      else retried += 1;
    }
  }
  if (claimed.length > 0) {
    emitManagementMetric('receipt.delivery', {
      outcome: failed > 0 ? 'failed' : retried > 0 ? 'retry' : 'delivered',
      operationCount: claimed.length,
    });
  }
  return { delivered, retried, failed };
}

export async function deliverManagementReceiptToSlack(
  record: ManagementReceiptOutboxRecord,
  input: {
    identity: Pick<IdentityStore, 'listExternalIdentities'>;
    env?: PlatformEnv;
    resolveInstallation?: SlackInstallationExecutionResolver;
  },
): Promise<ManagementReceiptDeliveryResult> {
  if (record.destination.kind === 'reaction') {
    if (!isRoutineSavedAcknowledgement(record.receipt) && !isScheduleActionReaction(record.receipt)) {
      throw new Error('The Slack reaction acknowledgement payload is invalid.');
    }
    const destination = record.destination;
    const execution = await (input.resolveInstallation
      ? input.resolveInstallation(destination.workspaceId)
      : resolveSlackInstallationExecutionContext(destination.workspaceId, input.env));
    if (execution.workspaceId !== destination.workspaceId) {
      throw new Error('Acknowledgement workspace does not match the Slack installation.');
    }
    try {
      const response = await execution.client.reactions.add({
        channel: destination.channelId,
        timestamp: destination.messageTs,
        name: record.receipt.emojiName,
      });
      if (response.ok === false) {
        if (response.error === 'already_reacted') {
          return { deliveryRef: reactionDeliveryRef(record) };
        }
        throw new Error('Slack did not acknowledge the schedule reaction.');
      }
    } catch (error) {
      if (slackPlatformErrorCode(error) !== 'already_reacted') throw error;
    }
    return { deliveryRef: reactionDeliveryRef(record) };
  }
  if (isRoutineSavedAcknowledgement(record.receipt)) {
    throw new Error('The Slack reaction acknowledgement destination is invalid.');
  }
  let channel: string;
  let threadTs: string | undefined;
  let workspaceId: string;
  if (record.destination.kind === 'thread') {
    workspaceId = record.destination.workspaceId;
    channel = record.destination.channelId;
    threadTs = record.destination.threadTs;
  } else {
    const destination = record.destination;
    const binding = (await input.identity.listExternalIdentities()).find((candidate) =>
      candidate.organizationId === destination.organizationId &&
      candidate.userId === destination.userId);
    if (!binding) throw new Error('The initiating Slack member is unavailable.');
    workspaceId = binding.slackTeamId;
    channel = binding.slackUserId;
  }
  const execution = await (input.resolveInstallation
    ? input.resolveInstallation(workspaceId)
    : resolveSlackInstallationExecutionContext(workspaceId, input.env));
  if (execution.workspaceId !== workspaceId) {
    throw new Error('Receipt workspace does not match the Slack installation.');
  }
  const response = await execution.client.chat.postMessage({
    channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text: formatManagementSetupReceipt(record.receipt),
    client_msg_id: record.outboxId,
  } as Parameters<typeof execution.client.chat.postMessage>[0]);
  if (!response.ok || !response.ts) throw new Error('Slack did not acknowledge the receipt.');
  return { deliveryRef: `slack:${channel}:${response.ts}` };
}

function receiptDestination(setup: ManagementSetupRecord): ManagementReceiptDestination {
  if (setup.origin.kind === 'slack') {
    return {
      kind: 'thread',
      workspaceId: setup.origin.workspaceId,
      channelId: setup.origin.channelId,
      threadTs: setup.origin.threadTs,
    };
  }
  return {
    kind: 'initiator_dm',
    organizationId: setup.organizationId,
    userId: setup.actorUserId,
  };
}

export function isRoutineSavedAcknowledgement(
  receipt: ManagementReceipt,
): receipt is ManagementRoutineSavedAcknowledgement {
  return 'kind' in receipt && receipt.kind === 'routine_saved_reaction';
}

export function isScheduleActionAcknowledgement(
  receipt: ManagementReceipt,
): receipt is ManagementScheduleActionAcknowledgement {
  return 'kind' in receipt && receipt.kind === 'schedule_action';
}

function isScheduleActionReaction(
  receipt: ManagementReceipt,
): receipt is ManagementScheduleActionAcknowledgement & {
  transition: 'applied'; emojiName: 'white_check_mark';
} {
  return isScheduleActionAcknowledgement(receipt) && receipt.transition === 'applied' &&
    receipt.emojiName === 'white_check_mark';
}

/**
 * Repair schedule acknowledgements from durable action state. Outbox insertion
 * happens before the queued marker; a crash between them safely replays the
 * deterministic INSERT OR IGNORE on the next alarm.
 */
export async function reconcileScheduleActionReceipts(input: {
  routines: Pick<
    RoutineStore,
    'listScheduleActionsNeedingReceipts' | 'markScheduleActionReceiptQueued'
  >;
  management: Pick<ManagementStore, 'putOutbox'>;
  at: number;
  limit?: number;
}): Promise<number> {
  const actions = await input.routines.listScheduleActionsNeedingReceipts(input.limit ?? 25);
  let reconciled = 0;
  for (const action of actions) {
    const phase = action.status === 'pending' ? 'pending' : 'terminal';
    const transition = action.status === 'pending'
      ? 'pending' as const
      : action.status === 'applied' ? 'applied' as const : 'failed' as const;
    if (!(action.conversationKind === 'channel' && transition === 'applied')) {
      const reaction = action.conversationKind === 'im' && transition === 'applied';
      await input.management.putOutbox({
        outboxId: `receipt_schedule_action_${action.actionId}_${phase}`,
        operationId: action.actionId,
        destination: reaction
          ? {
              kind: 'reaction',
              workspaceId: action.workspaceId,
              channelId: action.channelId,
              messageTs: action.messageTs,
            }
          : {
              kind: 'thread',
              workspaceId: action.workspaceId,
              channelId: action.channelId,
              threadTs: action.threadTs,
            },
        receipt: {
          kind: 'schedule_action',
          transition,
          ...(transition === 'failed' ? { code: action.result?.outcome === 'failed'
            ? action.result.code
            : 'schedule_failed' } : {}),
          ...(reaction ? { emojiName: 'white_check_mark' as const } : {}),
        },
        status: 'pending',
        attempts: 0,
        nextAttemptAt: input.at,
        createdAt: input.at,
        updatedAt: input.at,
      });
    }
    await input.routines.markScheduleActionReceiptQueued({
      actionId: action.actionId,
      phase,
      at: input.at,
    });
    reconciled += 1;
  }
  return reconciled;
}

function scheduleActionFailureText(code: string | undefined): string {
  if (code === 'routines_unavailable_on_target') {
    return 'I couldn’t create that scheduled work because scheduling is unavailable on this deployment.';
  }
  if (code === 'schedule_authority_missing') {
    return 'I couldn’t activate that scheduled work because its Agent authority is unavailable. No active unowned schedule was left behind.';
  }
  return 'I couldn’t create that scheduled work. No new active schedule was created.';
}

function reactionDeliveryRef(record: ManagementReceiptOutboxRecord): string {
  const destination = record.destination;
  if (destination.kind !== 'reaction') throw new Error('Reaction destination is unavailable.');
  return `slack:${destination.channelId}:${destination.messageTs}:reaction`;
}

function slackPlatformErrorCode(error: unknown): string | undefined {
  if (error instanceof SlackTransportError) return error.code;
  if (!error || typeof error !== 'object') return undefined;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  const code = (data as { error?: unknown }).error;
  return typeof code === 'string' ? code : undefined;
}

/** Content-free failure classification: a Slack error code or an error name. */
function receiptDeliveryFailureCode(error: unknown): string {
  const code = slackPlatformErrorCode(error);
  if (code) return code;
  if (error instanceof Error && error.name !== 'Error') return error.name;
  return 'slack_delivery_failed';
}

function receiptRetryDelay(attempts: number): number {
  return Math.min(15 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1));
}

function boundedLabel(value: string): string {
  const normalized = value.trim().replace(/[\r\n\u0000-\u001f\u007f]/g, ' ');
  return normalized.slice(0, 240) || 'Connected account';
}
