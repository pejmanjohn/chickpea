import type { WebClient } from '@slack/web-api';

import { deploymentTenancy } from '../config/installation-scope.ts';
import {
  CREDITS_EXHAUSTED_CODE,
  isDailyLimitScope,
  type DailyLimitAdmission,
  type PlatformFundingRefusal,
} from '../config/platform-funding.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { IdentityStore } from '../identity/types.ts';
import type { SlackClaimStore } from './claim-store.ts';
import type { RenderedSlackComponents } from './reply-continuations.ts';
import { slackDateTime } from './ui/text.ts';

/** Outside the host UI namespaces, so the UI click parser never claims it. */
export const CREDITS_ASK_ADMIN_ACTION = 'chickpea.credits.v1.ask_admin';
/** A daily limit's ask; its value is `WORKSPACE:SCOPE:SECONDS`, with when usage resumes in epoch seconds. */
export const DAILY_LIMIT_ASK_ACTION = 'chickpea.credits.v1.ask_admin_daily_limit';
export const CREDITS_ASK_ADMIN_BLOCK = 'chickpea.credits.v1.ask_admin_block';

export const CREDITS_ASK_OWNER_LABEL = 'Ask an Owner';
export const CREDITS_OWNER_HINT_TEXT = "You're an Owner, so you can add extra usage or change the plan in Chickpea.";
export const DAILY_LIMIT_OWNER_HINT_TEXT = "You're an Owner, so you can choose a plan in Chickpea to continue now.";
export const CREDITS_ASK_CONFIRMATION_TEXT = "I asked this workspace's Owners to add usage.";
export const DAILY_LIMIT_ASK_CONFIRMATION_TEXT = "I asked this workspace's Owners to choose a plan.";
export const CREDITS_ASK_UNREACHABLE_TEXT =
  "I couldn't reach this workspace's Owners. Try again in a few minutes.";

export function creditsAskOwnerDmText(clickerUserId: string, channelId: string): string {
  return `<@${clickerUserId}> asked you to add usage to Chickpea. ` +
    `A request in ${requestPlace(channelId)} stopped because this workspace has used all of its plan's usage.`;
}

export function dailyLimitAskOwnerDmText(
  clickerUserId: string,
  channelId: string,
  { scope, resumesAt }: Pick<DailyLimitAdmission, 'scope' | 'resumesAt'>,
): string {
  const why = scope === 'workspace'
    ? `this workspace reached its daily trial limit. Chickpea resumes ${slackDateTime(resumesAt)}.`
    : `Chickpea has paused trial usage for now. It resumes ${slackDateTime(resumesAt)}.`;
  return `<@${clickerUserId}> asked you to choose a plan for Chickpea. ` +
    `A request in ${requestPlace(channelId)} stopped because ${why}`;
}

function requestPlace(channelId: string): string {
  return channelId.startsWith('D') ? 'a direct message' : `<#${channelId}>`;
}

/** What the reply and its button say for each refusal. */
function refusalCopy(refusal: PlatformFundingRefusal) {
  return refusal === CREDITS_EXHAUSTED_CODE
    ? {
        ownerHint: CREDITS_OWNER_HINT_TEXT,
        confirmation: CREDITS_ASK_CONFIRMATION_TEXT,
        ownerDm: creditsAskOwnerDmText,
        button: (workspaceId: string) => ({ action_id: CREDITS_ASK_ADMIN_ACTION, value: workspaceId }),
      }
    : {
        ownerHint: DAILY_LIMIT_OWNER_HINT_TEXT,
        confirmation: DAILY_LIMIT_ASK_CONFIRMATION_TEXT,
        ownerDm: (clickerUserId: string, channelId: string) =>
          dailyLimitAskOwnerDmText(clickerUserId, channelId, refusal),
        button: (workspaceId: string) => ({
          action_id: DAILY_LIMIT_ASK_ACTION,
          value: `${workspaceId}:${refusal.scope}:${Math.floor(refusal.resumesAt / 1000)}`,
        }),
      };
}

type CreditsIdentity = Pick<IdentityStore, 'resolveSlackIdentity' | 'listMemberships' | 'listExternalIdentities'>;
type SlackBlock = Record<string, unknown>;

export interface CreditsAskClient {
  conversations: Pick<WebClient['conversations'], 'open'>;
  chat: Pick<WebClient['chat'], 'postMessage' | 'update' | 'postEphemeral'>;
}

export interface OwnerDmClient {
  conversations: Pick<WebClient['conversations'], 'open'>;
  chat: Pick<WebClient['chat'], 'postMessage'>;
}

export interface CreditsAskAction {
  /** What the clicked button asks the Owners to fix. */
  refusal: PlatformFundingRefusal;
  workspaceId: string;
  userId: string;
  channelId: string;
  messageTs: string;
  threadTs?: string;
  /** The clicked message as Slack sent it, redrawn without the button. */
  message: { text: string; blocks: SlackBlock[] };
}

export interface CreditsAskDeps {
  identity: CreditsIdentity;
  claims: SlackClaimStore;
  client: CreditsAskClient;
  now?: () => number;
}

export type CreditsAskOutcome = 'asked' | 'already_asked' | 'owner' | 'unreachable';

function outcomePresentation(
  outcome: CreditsAskOutcome,
  refusal: PlatformFundingRefusal,
): { text: string; replacesButton: boolean } {
  const copy = refusalCopy(refusal);
  switch (outcome) {
    case 'asked':
    case 'already_asked': return { text: copy.confirmation, replacesButton: true };
    case 'owner': return { text: copy.ownerHint, replacesButton: false };
    case 'unreachable': return { text: CREDITS_ASK_UNREACHABLE_TEXT, replacesButton: false };
  }
}

const HOUR_MS = 3_600_000;
const SLACK_TS = /^\d{1,16}\.\d{1,16}$/;
const TEXT_BLOCK_TYPES = new Set(['markdown', 'rich_text', 'section']);

export async function fundingRefusalComponents(input: {
  env: PlatformEnv | undefined;
  identity: CreditsIdentity;
  workspaceId: string;
  userId: string;
  refusal: PlatformFundingRefusal;
}): Promise<RenderedSlackComponents | undefined> {
  if (deploymentTenancy(input.env) !== 'installation') return undefined;
  const owner = await isActiveOwner(input.identity, input.workspaceId, input.userId).catch(() => {
    console.warn('[chickpea] The out-of-credits reply could not read the requester\'s role');
    return false;
  });
  const copy = refusalCopy(input.refusal);
  return owner
    ? { blocks: [contextBlock(copy.ownerHint)], fallbackText: copy.ownerHint }
    : { blocks: [askAdminBlock(copy.button(input.workspaceId))], fallbackText: '' };
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

export async function askOwnersForCredits(action: CreditsAskAction, deps: CreditsAskDeps): Promise<CreditsAskOutcome> {
  const outcome = await ask(action, deps).catch((): CreditsAskOutcome => {
    console.warn('[chickpea] A credits request could not be checked');
    return 'unreachable';
  });
  await present(action, outcomePresentation(outcome, action.refusal), deps.client);
  return outcome;
}

/** A button carries its own workspace, so a value for another workspace is refused. */
function clickedRefusal(actionId: unknown, value: unknown, workspaceId: string): PlatformFundingRefusal | undefined {
  if (actionId === CREDITS_ASK_ADMIN_ACTION) return value === workspaceId ? CREDITS_EXHAUSTED_CODE : undefined;
  if (actionId !== DAILY_LIMIT_ASK_ACTION || typeof value !== 'string' || !value.startsWith(`${workspaceId}:`)) {
    return undefined;
  }
  const [, scope, seconds] = /^([a-z]+):(\d{1,12})$/.exec(value.slice(workspaceId.length + 1)) ?? [];
  return isDailyLimitScope(scope) && Number(seconds) > 0
    ? { kind: 'daily_limit', scope, resumesAt: Number(seconds) * 1000 }
    : undefined;
}

async function ask(action: CreditsAskAction, deps: CreditsAskDeps): Promise<CreditsAskOutcome> {
  if (await isActiveOwner(deps.identity, action.workspaceId, action.userId)) return 'owner';
  const release = await claimAskWindow(deps.claims, action.workspaceId, (deps.now ?? Date.now)());
  if (!release) return 'already_asked';
  const owners = await activeOwnerSlackUserIds(deps.identity, action.workspaceId).catch(() => {
    console.warn('[chickpea] The installation\'s Owners could not be read for a credits request');
    return [];
  });
  const message = { text: refusalCopy(action.refusal).ownerDm(action.userId, action.channelId) };
  let delivered = 0;
  for (const owner of owners) {
    if (await sendOwnerDm(deps.client, owner, message)) delivered += 1;
  }
  if (delivered > 0) return 'asked';
  await release();
  return 'unreachable';
}

/**
 * Claims expire two hours after they are made and cannot be shortened, so an
 * ask holds its own clock hour and the one before. The next ask needs both
 * free, which comes at least an hour later.
 */
async function claimAskWindow(
  claims: SlackClaimStore,
  workspaceId: string,
  now: number,
): Promise<(() => Promise<void>) | undefined> {
  const hour = Math.floor(now / HOUR_MS);
  const previous = `credits-ask:${workspaceId}:${hour - 1}`;
  const current = `credits-ask:${workspaceId}:${hour}`;
  if (!await claims.claim(previous)) return undefined;
  if (!await claims.claim(current)) {
    await claims.release(previous);
    return undefined;
  }
  return async () => {
    await claims.release(previous);
    await claims.release(current);
  };
}

async function isActiveOwner(identity: CreditsIdentity, workspaceId: string, userId: string): Promise<boolean> {
  const membership = (await identity.resolveSlackIdentity(workspaceId, userId))?.membership;
  return membership?.role === 'owner' && membership.status === 'active';
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

async function present(
  action: CreditsAskAction,
  presentation: { text: string; replacesButton: boolean },
  client: CreditsAskClient,
): Promise<void> {
  if (presentation.replacesButton && await replaceButton(action, presentation.text, client)) return;
  await client.chat.postEphemeral({
    channel: action.channelId,
    user: action.userId,
    text: presentation.text,
    ...(action.threadTs ? { thread_ts: action.threadTs } : {}),
  }).catch(() => {
    console.warn('[chickpea] A credits request notice was not delivered');
  });
}

async function replaceButton(action: CreditsAskAction, text: string, client: CreditsAskClient): Promise<boolean> {
  const blocks = withoutButton(action.message.blocks, text);
  if (!blocks) return false;
  try {
    await client.chat.update({
      channel: action.channelId,
      ts: action.messageTs,
      text: action.message.text,
      blocks,
    } as unknown as Parameters<CreditsAskClient['chat']['update']>[0]);
    return true;
  } catch {
    console.warn('[chickpea] The out-of-credits reply could not be redrawn');
    return false;
  }
}

/** Undefined when redrawing would lose the reply's visible text. */
function withoutButton(blocks: SlackBlock[], text: string): SlackBlock[] | undefined {
  const index = blocks.findIndex((block) => block.block_id === CREDITS_ASK_ADMIN_BLOCK);
  if (index < 0 || !blocks.some((block) => TEXT_BLOCK_TYPES.has(String(block.type)))) return undefined;
  return blocks.with(index, contextBlock(text));
}

function askAdminBlock(button: { action_id: string; value: string }): SlackBlock {
  return {
    type: 'actions',
    block_id: CREDITS_ASK_ADMIN_BLOCK,
    elements: [{
      type: 'button',
      action_id: button.action_id,
      text: { type: 'plain_text', text: CREDITS_ASK_OWNER_LABEL, emoji: false },
      value: button.value,
    }],
  };
}

function contextBlock(text: string): SlackBlock {
  return { type: 'context', elements: [{ type: 'plain_text', text, emoji: false }] };
}

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
