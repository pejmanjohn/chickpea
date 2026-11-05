import type { WebClient } from '@slack/web-api';

import {
  CREDITS_EXHAUSTED_CODE,
  isDailyLimitScope,
  type OutOfUsageCause,
  type OutOfUsageCauseKind,
  type PlatformFundingRefusal,
} from '../config/platform-funding.ts';
import type { IdentityStore } from '../identity/types.ts';
import { slackDateTime } from './ui/text.ts';

/** Outside the host UI namespaces, so the UI click parser never claims it. */
export const CREDITS_ASK_ADMIN_ACTION = 'chickpea.credits.v1.ask_admin';
/** A daily limit's ask; its value is `WORKSPACE:SCOPE:SECONDS`, with when usage resumes in epoch seconds. */
export const DAILY_LIMIT_ASK_ACTION = 'chickpea.credits.v1.ask_admin_daily_limit';
export const CREDITS_ASK_ADMIN_BLOCK = 'chickpea.credits.v1.ask_admin_block';

export const CREDITS_ASK_OWNER_LABEL = 'Ask an Owner';
export const OUT_OF_USAGE_TEXT =
  "This workspace is out of usage for now, so I can't start this one. Once an Owner adds more, send it again.";

/** Refusals whose public reply already names their cause, so its button may carry it. */
export const PUBLIC_CAUSES: ReadonlySet<OutOfUsageCauseKind> = new Set(['trial_used', 'trial_ended', 'own_key_tasks_used', 'own_key_no_plan']);

/**
 * The thread reply to a refused request: the same words for every role.
 * Shared channels can include people outside the company, so no amount,
 * card or failure reason goes here. The Owners' words load with the reply
 * (funding-refusal-reply.ts).
 */
export function fundingRefusalText(refusal: PlatformFundingRefusal): string {
  if (refusal.kind === 'daily_limit') {
    const resumes = slackDateTime(refusal.resumesAt);
    return refusal.scope === 'workspace'
      ? "This workspace has reached today's free trial limit, so I can't start this one. " +
        `The limit resets ${resumes}, or an Owner can choose a plan to continue now.`
      : "Chickpea has paused free trial usage for now, so I can't start this one. " +
        `Trials resume ${resumes}, or an Owner can choose a plan to continue now.`;
  }
  switch (refusal.cause?.kind) {
    case 'trial_used':
      return "This workspace's free trial usage is used up, so I can't start this one. Once an Owner chooses a plan, send it again.";
    case 'trial_ended':
      return "This workspace's free trial has ended, so I can't start this one. Once an Owner chooses a plan, send it again.";
    case 'own_key_tasks_used':
      return "This workspace has used this month's tasks, so I can't do this one. I can still chat. " +
        'Once an Owner adds more, send it again.';
    case 'own_key_no_plan':
      return "This workspace needs a plan for tasks, so I can't do this one. I can still chat. " +
        'Once an Owner chooses a plan, send it again.';
    case undefined:
    case 'plan_used':
    case 'top_up_limit':
    case 'top_up_declined':
    case 'top_up_unconfirmed':
      return OUT_OF_USAGE_TEXT;
  }
}

type SlackBlock = Record<string, unknown>;

export interface OwnerDmClient {
  conversations: Pick<WebClient['conversations'], 'open'>;
  chat: Pick<WebClient['chat'], 'postMessage'>;
}

export interface CreditsAskAction {
  /** What the reply said: an out-of-usage refusal names only the cause its public words already tell. */
  refusal: PlatformFundingRefusal;
  workspaceId: string;
  userId: string;
  channelId: string;
  messageTs: string;
  threadTs?: string;
  /** The clicked message as Slack sent it, redrawn without the button. */
  message: { text: string; blocks: SlackBlock[] };
}

/** Parsing grants no authority. Call only after Slack signature verification. */
export function parseCreditsAskAction(payload: unknown): CreditsAskAction | undefined {
  const root = record(payload);
  if (root?.type !== 'block_actions' || !Array.isArray(root.actions) || root.actions.length !== 1) {
    return undefined;
  }
  const action = record(root.actions[0]);
  const team = record(root.team);
  const user = record(root.user);
  const channel = record(root.channel);
  const container = record(root.container);
  const message = record(root.message);
  if (!safeId(team?.id) || !safeId(user?.id) || !safeId(channel?.id) ||
      container?.type !== 'message' || container.is_ephemeral === true ||
      container.channel_id !== channel.id || !slackTs(container.message_ts)) return undefined;
  const refusal = clickedRefusal(action?.action_id, action?.value, team.id);
  if (!refusal) return undefined;
  const blocks = Array.isArray(message?.blocks) ? message.blocks : [];
  return {
    refusal,
    workspaceId: team.id,
    userId: user.id,
    channelId: channel.id,
    messageTs: container.message_ts,
    ...(slackTs(message?.thread_ts) ? { threadTs: message.thread_ts } : {}),
    message: {
      text: typeof message?.text === 'string' ? message.text : '',
      blocks: blocks.every((block) => record(block)) ? blocks as SlackBlock[] : [],
    },
  };
}

/** A button carries its own workspace, so a value for another workspace is refused. */
function clickedRefusal(actionId: unknown, value: unknown, workspaceId: string): PlatformFundingRefusal | undefined {
  if (typeof value !== 'string') return undefined;
  if (actionId === CREDITS_ASK_ADMIN_ACTION) {
    if (value === workspaceId) return { kind: CREDITS_EXHAUSTED_CODE };
    const cause = value.startsWith(`${workspaceId}:`) ? value.slice(workspaceId.length + 1) : undefined;
    return cause && PUBLIC_CAUSES.has(cause as OutOfUsageCauseKind)
      ? { kind: CREDITS_EXHAUSTED_CODE, cause: { kind: cause } as OutOfUsageCause }
      : undefined;
  }
  if (actionId !== DAILY_LIMIT_ASK_ACTION || !value.startsWith(`${workspaceId}:`)) return undefined;
  const [, scope, seconds] = /^([a-z]+):(\d{1,12})$/.exec(value.slice(workspaceId.length + 1)) ?? [];
  return isDailyLimitScope(scope) && Number(seconds) > 0
    ? { kind: 'daily_limit', scope, resumesAt: Number(seconds) * 1000 }
    : undefined;
}

export async function activeOwnerSlackUserIds(
  identity: Pick<IdentityStore, 'listMemberships' | 'listExternalIdentities'>,
  workspaceId: string,
): Promise<string[]> {
  const [memberships, bindings] = await Promise.all([identity.listMemberships(), identity.listExternalIdentities()]);
  const owners = new Set(memberships
    .filter((membership) => membership.role === 'owner' && membership.status === 'active')
    .map((membership) => membership.id));
  return [...new Set(bindings
    .filter((binding) => binding.slackTeamId === workspaceId && owners.has(binding.membershipId))
    .map((binding) => binding.slackUserId))];
}

export async function sendOwnerDm(
  client: OwnerDmClient,
  ownerUserId: string,
  message: { text: string; blocks?: readonly SlackBlock[] },
): Promise<boolean> {
  try {
    const opened = await client.conversations.open({ users: ownerUserId });
    const channel = opened.channel?.id;
    if (!channel) return false;
    await client.chat.postMessage({
      channel,
      text: message.text,
      ...(message.blocks ? { blocks: message.blocks } : {}),
    } as unknown as Parameters<OwnerDmClient['chat']['postMessage']>[0]);
    return true;
  } catch {
    console.warn('[chickpea] An Owner could not be messaged');
    return false;
  }
}

const SLACK_TS = /^\d{1,16}\.\d{1,16}$/;

function slackTs(value: unknown): value is string {
  return typeof value === 'string' && SLACK_TS.test(value);
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
