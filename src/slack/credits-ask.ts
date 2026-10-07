import type { WebClient } from '@slack/web-api';

import { deploymentTenancy } from '../config/installation-scope.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { IdentityStore } from '../identity/types.ts';
import type { SlackClaimStore } from './claim-store.ts';
import type { RenderedSlackComponents } from './reply-continuations.ts';

/** Outside the host UI namespaces, so the UI click parser never claims it. */
export const CREDITS_ASK_ADMIN_ACTION = 'chickpea.credits.v1.ask_admin';
export const CREDITS_ASK_ADMIN_BLOCK = 'chickpea.credits.v1.ask_admin_block';

export const CREDITS_ASK_ADMIN_LABEL = 'Ask an admin';
export const CREDITS_OWNER_HINT_TEXT = "You're an Owner, so you can add credits in Chickpea.";
export const CREDITS_ASK_CONFIRMATION_TEXT = "I asked this workspace's Owners to add credits.";
export const CREDITS_ASK_UNREACHABLE_TEXT =
  "I couldn't reach this workspace's Owners. Try again in a few minutes.";

export function creditsAskOwnerDmText(clickerUserId: string, channelId: string): string {
  const where = channelId.startsWith('D') ? 'a direct message' : `<#${channelId}>`;
  return `<@${clickerUserId}> asked you to add Chickpea credits. ` +
    `A request in ${where} stopped because this workspace is out of credits.`;
}

type CreditsIdentity = Pick<IdentityStore, 'resolveSlackIdentity' | 'listMemberships' | 'listExternalIdentities'>;
type SlackBlock = Record<string, unknown>;

export interface CreditsAskClient {
  conversations: Pick<WebClient['conversations'], 'open'>;
  chat: Pick<WebClient['chat'], 'postMessage' | 'update' | 'postEphemeral'>;
}

export interface CreditsAskAction {
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

const OUTCOME_PRESENTATION: Record<CreditsAskOutcome, { text: string; replacesButton: boolean }> = {
  asked: { text: CREDITS_ASK_CONFIRMATION_TEXT, replacesButton: true },
  already_asked: { text: CREDITS_ASK_CONFIRMATION_TEXT, replacesButton: true },
  owner: { text: CREDITS_OWNER_HINT_TEXT, replacesButton: false },
  unreachable: { text: CREDITS_ASK_UNREACHABLE_TEXT, replacesButton: false },
};

const HOUR_MS = 3_600_000;
const SLACK_TS = /^\d{1,16}\.\d{1,16}$/;
const TEXT_BLOCK_TYPES = new Set(['markdown', 'rich_text', 'section']);

export async function creditsExhaustedComponents(input: {
  env: PlatformEnv | undefined;
  identity: CreditsIdentity;
  workspaceId: string;
  userId: string;
}): Promise<RenderedSlackComponents | undefined> {
  if (deploymentTenancy(input.env) !== 'installation') return undefined;
  const owner = await isActiveOwner(input.identity, input.workspaceId, input.userId).catch(() => {
    console.warn('[chickpea] The out-of-credits reply could not read the requester\'s role');
    return false;
  });
  return owner
    ? { blocks: [contextBlock(CREDITS_OWNER_HINT_TEXT)], fallbackText: CREDITS_OWNER_HINT_TEXT }
    : { blocks: [askAdminBlock(input.workspaceId)], fallbackText: '' };
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
  if (action?.action_id !== CREDITS_ASK_ADMIN_ACTION || !safeId(team?.id) || action.value !== team.id ||
      !safeId(user?.id) || !safeId(channel?.id) ||
      container?.type !== 'message' || container.is_ephemeral === true ||
      container.channel_id !== channel.id || !slackTs(container.message_ts)) return undefined;
  const blocks = Array.isArray(message?.blocks) ? message.blocks : [];
  return {
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
  const outcome = await ask(action, deps);
  await present(action, OUTCOME_PRESENTATION[outcome], deps.client);
  return outcome;
}

async function ask(action: CreditsAskAction, deps: CreditsAskDeps): Promise<CreditsAskOutcome> {
  if (await isActiveOwner(deps.identity, action.workspaceId, action.userId)) return 'owner';
  const release = await claimAskWindow(deps.claims, action.workspaceId, (deps.now ?? Date.now)());
  if (!release) return 'already_asked';
  const owners = await activeOwnerSlackUserIds(deps.identity, action.workspaceId).catch(() => {
    console.warn('[chickpea] The installation\'s Owners could not be read for a credits request');
    return [];
  });
  const text = creditsAskOwnerDmText(action.userId, action.channelId);
  let delivered = 0;
  for (const owner of owners) {
    if (await sendOwnerDm(deps.client, owner, text)) delivered += 1;
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

async function activeOwnerSlackUserIds(identity: CreditsIdentity, workspaceId: string): Promise<string[]> {
  const [memberships, bindings] = await Promise.all([identity.listMemberships(), identity.listExternalIdentities()]);
  const owners = new Set(memberships
    .filter((membership) => membership.role === 'owner' && membership.status === 'active')
    .map((membership) => membership.id));
  return [...new Set(bindings
    .filter((binding) => binding.slackTeamId === workspaceId && owners.has(binding.membershipId))
    .map((binding) => binding.slackUserId))];
}

async function sendOwnerDm(client: CreditsAskClient, ownerUserId: string, text: string): Promise<boolean> {
  try {
    const opened = await client.conversations.open({ users: ownerUserId });
    const channel = opened.channel?.id;
    if (!channel) return false;
    await client.chat.postMessage({ channel, text });
    return true;
  } catch {
    console.warn('[chickpea] An Owner could not be messaged about credits');
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

function askAdminBlock(workspaceId: string): SlackBlock {
  return {
    type: 'actions',
    block_id: CREDITS_ASK_ADMIN_BLOCK,
    elements: [{
      type: 'button',
      action_id: CREDITS_ASK_ADMIN_ACTION,
      text: { type: 'plain_text', text: CREDITS_ASK_ADMIN_LABEL, emoji: false },
      value: workspaceId,
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
