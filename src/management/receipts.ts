import type { WebClient } from '@slack/web-api';

import type { PlatformEnv } from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import { managedConnectorReadCopy } from '../connections/managed-copy.ts';
import type { IdentityStore } from '../identity/types.ts';
import {
  resolveSlackInstallationExecutionContext,
  type SlackInstallationExecutionResolver,
} from '../slack/installation-execution.ts';
import { renderSlackActionLink } from '../slack/message-format.ts';
import type { SlackPresentationStatePort } from '../slack/agent-view-presentation.ts';
import {
  abandonDeferredTerminalSlackDelivery,
  acknowledgeDeferredTerminalSlackDelivery,
  slackPresentationRepairFailureCode,
} from '../slack/presentation-repair.ts';
import { SlackTransportError } from '../slack/transport/types.ts';
import {
  handoffCreatedAgentThread,
  type CreatedAgentHandoffConfig,
} from '../slack/agent-routing.ts';
import type { ManagementStore } from './store.ts';
import { RoutineStateError, type RoutineStore } from '../routines/types.ts';
import type {
  ManagementReceiptDestination,
  ManagementReceiptOutboxRecord,
  ManagementReceipt,
  ManagementAgentCreatedWelcome,
  ManagementChickpeaIntroduction,
  ManagementConnectorConnectedReceipt,
  ManagementRoutineSavedAcknowledgement,
  ManagementScheduleActionAcknowledgement,
  ManagementSetupReceipt,
  ManagementSetupRecord,
} from './types.ts';
import { emitManagementMetric } from './telemetry.ts';

const OUTBOX_LEASE_MS = 30_000;
const OUTBOX_MAX_ATTEMPTS = 8;
const VIEW_AGENT_LINK_LABEL = 'View Agent';

/** Slack rejections a retry can never fix; settle them terminally at once. */
const PERMANENT_DELIVERY_CODES = new Set([
  'missing_scope',
  'not_allowed_token_type',
  'invalid_name',
  'channel_not_found',
  'message_not_found',
  'is_archived',
  'operation_not_allowed',
  'introduction_recipient_ineligible',
]);

export interface CompleteManagementSetupReceiptInput {
  setup: ManagementSetupRecord;
  browserSessionDigest: string;
  completedByUserId?: string;
  completedByMembershipId?: string;
  connectionAccountId?: string;
  connector?: string;
  accountLabel?: string;
  initiator: string;
  at: number;
  receiptKind?: 'connector_connected';
  agentId?: string;
  agentName?: string;
  toolkit?: string;
  ownerKind?: 'team' | 'member';
  accessLane?: 'read' | 'write';
  avatarUrl?: string;
}

export async function completeManagementSetupReceipt(
  management: ManagementStore,
  input: CompleteManagementSetupReceiptInput,
): Promise<ManagementSetupRecord> {
  const receipt: ManagementSetupReceipt | ManagementConnectorConnectedReceipt =
    input.receiptKind === 'connector_connected'
      ? {
          kind: 'connector_connected',
          setupOperationId: input.setup.setupOperationId,
          connector: input.connector ?? input.setup.target.targetLabel,
          toolkit: input.toolkit ?? input.setup.target.provider,
          agentId: input.agentId ?? input.setup.target.agentId ?? 'unknown_agent',
          agentName: boundedLabel(
            input.agentName ?? input.setup.target.agentName ?? 'Agent',
          ),
          ownerKind: input.ownerKind ?? input.setup.target.ownerKind ?? 'member',
          accessLane: input.accessLane ?? input.setup.target.accessLane ?? 'read',
          ...(input.avatarUrl ? { avatarUrl: input.avatarUrl } : {}),
          completedAt: input.at,
        }
      : {
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
    ...(input.completedByUserId ? { completedByUserId: input.completedByUserId } : {}),
    ...(input.completedByMembershipId
      ? { completedByMembershipId: input.completedByMembershipId }
      : {}),
    ...(input.connectionAccountId ? { connectionAccountId: input.connectionAccountId } : {}),
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
      return scheduleActionFailureText(receipt.code, receipt.safeState);
    }
    return `✅ That scheduled-work action completed.${scheduleActionSafeStateText(receipt.safeState)}`;
  }
  if (isAgentCreatedWelcome(receipt)) return formatAgentCreatedWelcome(receipt);
  if (isChickpeaIntroduction(receipt)) return formatChickpeaIntroduction(receipt);
  if (isConnectorConnectedReceipt(receipt)) {
    const scope = receipt.ownerKind === 'member' ? 'personal' : 'team';
    const access = receipt.accessLane === 'read' ? 'read-only' : 'read and write';
    const copy = managedConnectorReadCopy(receipt.toolkit, receipt.connector);
    const action = receipt.accessLane === 'read'
      ? copy.receiptAction
      : `use the approved ${receipt.connector} capabilities`;
    return `✅ ${receipt.connector} is now connected. Your ${scope}, ${access} connection is ready — I can ${action} when you ask me here.`;
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

export interface AgentWelcomePresentationRuntime {
  state: SlackPresentationStatePort;
  resolveClient(workspaceId: string): Promise<WebClient>;
}

export async function completeAgentWelcomeDelivery(
  record: ManagementReceiptOutboxRecord,
  delivery: {
    workspaceId: string;
    channelId: string;
    threadTs?: string;
    messageTs: string;
    text: string;
    persona: 'agent' | 'chickpea';
    client: WebClient;
  },
  config: CreatedAgentHandoffConfig & {
    putSlackPublicContext(
      ...args: Parameters<ConfigStore['putSlackPublicContext']>
    ): Awaited<ReturnType<ConfigStore['putSlackPublicContext']>> |
      ReturnType<ConfigStore['putSlackPublicContext']>;
  },
  presentation?: AgentWelcomePresentationRuntime,
): Promise<void> {
  if (!isAgentCreatedWelcome(record.receipt)) return;
  if (delivery.persona !== 'agent') return;
  if (record.destination.kind !== 'thread' || !delivery.threadTs) {
    throw new Error('The Agent welcome must target its creation thread.');
  }
  let presentationError: unknown;
  if (record.receipt.presentationRunId && presentation) {
    try {
      await acknowledgeDeferredTerminalSlackDelivery({
        runId: record.receipt.presentationRunId,
        state: presentation.state,
        // Reuse the installation client that Slack just accepted for the
        // welcome. Resolving it again here creates a second failure boundary
        // after the irreversible post and can strand the terminal activity.
        client: delivery.client,
      });
    } catch (error) {
      // The Slack post is already durable. Still complete routing and public
      // context so one failed lifecycle effect cannot strand the Agent thread.
      presentationError = error;
    }
  }
  await handoffCreatedAgentThread({
    workspaceId: record.destination.workspaceId,
    channelId: record.destination.channelId,
    threadTs: record.destination.threadTs,
    welcomeMessageTs: delivery.messageTs,
    agentId: record.receipt.agentId,
    requesterMembershipId: record.receipt.requesterMembershipId,
    surface: record.receipt.surface,
    config,
  });
  await config.putSlackPublicContext({
    workspaceId: record.destination.workspaceId,
    channelId: record.destination.channelId,
    rootTs: record.destination.threadTs,
    messageTs: delivery.messageTs,
    role: 'agent',
    agentId: record.receipt.agentId,
    text: delivery.text,
  });
  if (presentationError) {
    console.warn('[chickpea:management] Agent welcome lifecycle settlement failed', JSON.stringify({
      outboxId: record.outboxId,
      failureCode: receiptDeliveryFailureCode(presentationError),
    }));
    throw presentationError;
  }
}

export async function failAgentWelcomeDelivery(
  record: ManagementReceiptOutboxRecord,
  presentation?: AgentWelcomePresentationRuntime,
): Promise<void> {
  if (!isAgentCreatedWelcome(record.receipt) || !record.receipt.presentationRunId ||
      !presentation || record.destination.kind !== 'thread') return;
  await abandonDeferredTerminalSlackDelivery({
    runId: record.receipt.presentationRunId,
    state: presentation.state,
    resolveClient: presentation.resolveClient,
  });
}

export async function drainManagementReceiptOutbox(input: {
  management: ManagementStore;
  deliver(record: ManagementReceiptOutboxRecord): Promise<ManagementReceiptDeliveryResult>;
  onTerminalFailure?(record: ManagementReceiptOutboxRecord, failureCode: string): Promise<void>;
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
      if (terminal) {
        try {
          await input.onTerminalFailure?.(record, failureCode);
        } catch (cleanupError) {
          console.warn('[chickpea:management] terminal receipt cleanup failed', JSON.stringify({
            outboxId: record.outboxId,
            failureCode: receiptDeliveryFailureCode(cleanupError),
          }));
        }
      }
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
    identity: Pick<IdentityStore, 'listExternalIdentities'> &
      Partial<Pick<IdentityStore, 'resolveSlackIdentity'>>;
    env?: PlatformEnv;
    resolveInstallation?: SlackInstallationExecutionResolver;
    onDelivered?: (
      record: ManagementReceiptOutboxRecord,
      delivery: {
        workspaceId: string;
        channelId: string;
        threadTs?: string;
        messageTs: string;
        text: string;
        persona: 'agent' | 'chickpea';
        client: WebClient;
      },
    ) => void | Promise<void>;
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
  } else if (record.destination.kind === 'initiator_dm') {
    const destination = record.destination;
    const binding = (await input.identity.listExternalIdentities()).find((candidate) =>
      candidate.organizationId === destination.organizationId &&
      candidate.userId === destination.userId);
    if (!binding) throw new Error('The initiating Slack member is unavailable.');
    workspaceId = binding.slackTeamId;
    channel = binding.slackUserId;
  } else {
    workspaceId = record.destination.workspaceId;
    channel = record.destination.slackUserId;
    const resolution = await input.identity.resolveSlackIdentity?.(workspaceId, channel);
    if (
      !resolution ||
      resolution.membership.status !== 'active' ||
      resolution.binding.slackTeamId !== workspaceId ||
      resolution.binding.slackUserId !== channel
    ) {
      const error = new Error('The Chickpea introduction recipient is no longer eligible.');
      error.name = 'introduction_recipient_ineligible';
      throw error;
    }
  }
  const execution = await (input.resolveInstallation
    ? input.resolveInstallation(workspaceId)
    : resolveSlackInstallationExecutionContext(workspaceId, input.env));
  if (execution.workspaceId !== workspaceId) {
    throw new Error('Receipt workspace does not match the Slack installation.');
  }
  if (record.destination.kind === 'slack_dm' || record.destination.kind === 'initiator_dm') {
    const opened = await execution.client.conversations.open({ users: channel });
    if (!opened.ok || !opened.channel?.id) throw new Error('Slack did not open the receipt DM.');
    channel = opened.channel.id;
  }
  const text = formatManagementSetupReceipt(record.receipt);
  const baseMessage = {
    channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text,
    client_msg_id: record.outboxId,
    ...(isConnectorConnectedReceipt(record.receipt)
      ? {
          username: record.receipt.agentName,
          ...(record.receipt.avatarUrl ? { icon_url: record.receipt.avatarUrl } : {}),
          unfurl_links: false,
          unfurl_media: false,
        }
      : {}),
  } as Parameters<typeof execution.client.chat.postMessage>[0];
  let response;
  let deliveredText = text;
  let persona: 'agent' | 'chickpea' = isConnectorConnectedReceipt(record.receipt)
    ? 'agent'
    : 'chickpea';
  if (isAgentCreatedWelcome(record.receipt)) {
    try {
      response = await execution.client.chat.postMessage({
        ...baseMessage,
        username: record.receipt.persona.name,
        ...(record.receipt.persona.avatarUrl
          ? { icon_url: record.receipt.persona.avatarUrl }
          : {}),
      } as Parameters<typeof execution.client.chat.postMessage>[0]);
      persona = 'agent';
    } catch (error) {
      if (slackPlatformErrorCode(error) !== 'missing_scope') throw error;
      deliveredText = formatAgentWelcomeFallback(record.receipt);
      response = await execution.client.chat.postMessage({
        ...baseMessage,
        text: deliveredText,
      });
    }
  } else {
    response = await execution.client.chat.postMessage(baseMessage);
  }
  if (!response.ok || !response.ts) throw new Error('Slack did not acknowledge the receipt.');
  try {
    await input.onDelivered?.(record, {
      workspaceId,
      channelId: channel,
      ...(threadTs ? { threadTs } : {}),
      messageTs: response.ts,
      text: deliveredText,
      persona,
      client: execution.client,
    });
  } catch (error) {
    // Slack has already acknowledged the irreversible post. A follow-up route
    // or context write must never make the outbox retry and duplicate it.
    console.warn('[chickpea:management] post-delivery bookkeeping failed', JSON.stringify({
      outboxId: record.outboxId,
      error: error instanceof Error ? error.name : 'unknown',
    }));
  }
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

export function isAgentCreatedWelcome(
  receipt: ManagementReceipt,
): receipt is ManagementAgentCreatedWelcome {
  return 'kind' in receipt && receipt.kind === 'agent_created_welcome';
}

export function isChickpeaIntroduction(
  receipt: ManagementReceipt,
): receipt is ManagementChickpeaIntroduction {
  return 'kind' in receipt && receipt.kind === 'chickpea_introduction';
}

function formatAgentCreatedWelcome(receipt: ManagementAgentCreatedWelcome): string {
  const description = receipt.agentDescription
    ? boundedSlackText(receipt.agentDescription, 400)
    : undefined;
  const lines = [
    `Hi — I’m *${boundedSlackText(receipt.agentName, 80)}*.${description ? ` ${description}` : ''}`,
  ];
  if (receipt.suggestedConnector) {
    lines.push(
      `A sensible next step is to connect *${escapeSlackText(receipt.suggestedConnector)}* so I can work with live account data.`,
    );
    if (receipt.setupUrl) lines.push(renderSlackActionLink(receipt.setupUrl, VIEW_AGENT_LINK_LABEL));
  } else if (receipt.setupUrl) {
    lines.push('You can configure my connections and capabilities from my Agent page.');
    lines.push(renderSlackActionLink(receipt.setupUrl, VIEW_AGENT_LINK_LABEL));
  } else {
    lines.push('Tell me what you’d like to work on first.');
  }
  return lines.join('\n\n');
}

function formatAgentWelcomeFallback(receipt: ManagementAgentCreatedWelcome): string {
  return [
    `Created *${boundedSlackText(receipt.agentName, 80)}*, but Slack would not let me post its welcome under the Agent’s identity. The creation thread remains with Chickpea.`,
    ...(receipt.setupUrl ? [renderSlackActionLink(receipt.setupUrl, VIEW_AGENT_LINK_LABEL)] : []),
  ].join('\n\n');
}

function formatChickpeaIntroduction(_receipt: ManagementChickpeaIntroduction): string {
  return [
    'Hi — I’m *Chickpea*. I help your workspace create and manage specialized Agents right from Slack.',
    'You can ask me to create an Agent, change how an Agent works, connect tools, or set up scheduled work. I’ll show one clear proposal when approval matters, then carry it out after you approve it once.',
  ].join('\n\n');
}

function escapeSlackText(value: string): string {
  return value
    .replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[*_~`]/g, '');
}

function boundedSlackText(value: string, max: number): string {
  return escapeSlackText(value).slice(0, max).trim();
}

export function isConnectorConnectedReceipt(
  receipt: ManagementReceipt,
): receipt is ManagementConnectorConnectedReceipt {
  return 'kind' in receipt && receipt.kind === 'connector_connected';
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
    const recoveredAfterPendingReceipt = action.pendingReceiptQueuedAt !== null;
    const immediateChannelSuccess = action.conversationKind === 'channel' &&
      transition === 'applied' && !recoveredAfterPendingReceipt;
    if (!immediateChannelSuccess) {
      const reaction = action.conversationKind === 'im' && transition === 'applied' &&
        !recoveredAfterPendingReceipt;
      const failedResult = transition === 'failed' && action.result?.outcome === 'failed'
        ? action.result
        : undefined;
      const appliedResult = transition === 'applied' && action.result?.outcome === 'applied'
        ? action.result
        : undefined;
      const nonActiveSafeState = appliedResult?.safeState && appliedResult.safeState !== 'active'
        ? appliedResult.safeState
        : undefined;
      const receipt: ManagementScheduleActionAcknowledgement = transition === 'pending'
        ? { kind: 'schedule_action', transition }
        : transition === 'applied'
          ? {
              kind: 'schedule_action',
              transition,
              ...(reaction ? { emojiName: 'white_check_mark' as const } : {}),
              ...(nonActiveSafeState ? { safeState: nonActiveSafeState } : {}),
            }
          : {
              kind: 'schedule_action',
              transition,
              code: failedResult?.code ?? 'schedule_failed',
              ...(failedResult?.safeState ? { safeState: failedResult.safeState } : {}),
            };
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
        receipt,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: input.at,
        createdAt: input.at,
        updatedAt: input.at,
      });
    }
    try {
      await input.routines.markScheduleActionReceiptQueued({
        actionId: action.actionId,
        phase,
        at: input.at,
      });
    } catch (error) {
      if (!(error instanceof RoutineStateError &&
          error.code === 'routine_schedule_action_conflict')) throw error;
      continue;
    }
    reconciled += 1;
  }
  return reconciled;
}

function scheduleActionFailureText(
  code: string | undefined,
  safeState: 'paused' | 'disabled' | 'pending_authority' | undefined,
): string {
  let failure: string;
  if (code === 'routines_unavailable_on_target') {
    failure = 'I couldn’t complete that scheduled-work action because scheduling is unavailable on this deployment.';
  } else if (code === 'schedule_authority_missing') {
    failure = 'I couldn’t complete that scheduled-work action because its Agent authority is unavailable.';
  } else {
    failure = 'I couldn’t complete that scheduled-work action.';
  }
  return `${failure}${scheduleActionSafeStateText(safeState)}`;
}

function scheduleActionSafeStateText(
  safeState: 'active' | 'paused' | 'disabled' | 'pending_authority' | undefined,
): string {
  if (safeState === 'paused') {
    return ' The affected schedule is paused, so it will not run.';
  }
  if (safeState === 'disabled') {
    return ' The affected schedule is disabled, so it will not run.';
  }
  if (safeState === 'pending_authority') {
    return ' The affected schedule is pending authority, so it will not run until authority is restored.';
  }
  return '';
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
  const repairCode = slackPresentationRepairFailureCode(error);
  if (repairCode) return repairCode;
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
