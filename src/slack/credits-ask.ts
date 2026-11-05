import type { WebClient } from '@slack/web-api';

import { deploymentTenancy } from '../config/installation-scope.ts';
import {
  CREDITS_EXHAUSTED_CODE,
  isDailyLimitScope,
  type OutOfUsageCause,
  type OutOfUsageCauseKind,
  type PlatformFundingRefusal,
} from '../config/platform-funding.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { IdentityStore } from '../identity/types.ts';
import { formatPriceCents } from '../usage/usage-display.ts';
import type { SlackClaimStore } from './claim-store.ts';
import { buildSlackAdminUrl } from './message-format.ts';
import type { RenderedSlackComponents } from './reply-continuations.ts';
import { slackDateTime } from './ui/text.ts';

/** Outside the host UI namespaces, so the UI click parser never claims it. */
export const CREDITS_ASK_ADMIN_ACTION = 'chickpea.credits.v1.ask_admin';
/** A daily limit's ask; its value is `WORKSPACE:SCOPE:SECONDS`, with when usage resumes in epoch seconds. */
export const DAILY_LIMIT_ASK_ACTION = 'chickpea.credits.v1.ask_admin_daily_limit';
export const CREDITS_ASK_ADMIN_BLOCK = 'chickpea.credits.v1.ask_admin_block';
/** A Plan page button's action; Slack opens its URL, and the click it also sends is ignored. */
const PLAN_BUTTON_ACTION = 'chickpea.credits.v1.plan';

export const CREDITS_ASK_OWNER_LABEL = 'Ask an Owner';
export const OUT_OF_USAGE_TEXT =
  "This workspace is out of usage for now, so I can't start this one. Once an Owner adds more, send it again.";
export const CREDITS_ASK_UNREACHABLE_TEXT =
  "I couldn't reach this workspace's Owners. Try again in a few minutes.";

type PlanStep = 'add' | 'raise-limit' | 'upgrade' | 'choose' | 'card';
interface PlanButton { readonly label: string; readonly step: PlanStep }

const ADD_USAGE: PlanButton = { label: 'Add usage', step: 'add' };
const UPGRADE: PlanButton = { label: 'Upgrade plan', step: 'upgrade' };
const CHOOSE_PLAN: PlanButton = { label: 'Choose a plan', step: 'choose' };

/**
 * What a refusal says, and what the Owners can do about it. Only `reply` is
 * public: shared channels can include people outside the company, so no
 * amount, card or failure reason goes there.
 */
interface RefusalCopy {
  /** The thread reply everyone sees, whatever their role. */
  readonly reply: string;
  /** The Owner's private reply: the reason, then what to do. */
  readonly owner: string;
  /** Plan page buttons for the Owner's private reply and the Owners' DM; the first is primary. */
  readonly buttons: readonly PlanButton[];
  /** What Ask an Owner asks the Owners to do. */
  readonly ask: 'add usage' | 'choose a plan';
  /** Why the request didn't run, in the Owners' DM. */
  readonly dmReason: string;
}

const OUT_OF_USAGE: Omit<RefusalCopy, 'owner' | 'buttons'> = {
  reply: OUT_OF_USAGE_TEXT,
  ask: 'add usage',
  dmReason: "This workspace is out of usage, so it didn't run.",
};

function refusalCopy(refusal: PlatformFundingRefusal): RefusalCopy {
  if (refusal.kind === 'daily_limit') {
    const resumes = slackDateTime(refusal.resumesAt);
    const owner = 'Plans have no daily limit. Choose one to continue now.';
    return refusal.scope === 'workspace'
      ? {
          reply: "This workspace has reached today's free trial limit, so I can't start this one. " +
            `The limit resets ${resumes}, or an Owner can choose a plan to continue now.`,
          owner, buttons: [CHOOSE_PLAN], ask: 'choose a plan',
          dmReason: `This workspace reached today's free trial limit, so it didn't run. The limit resets ${resumes}.`,
        }
      : {
          reply: "Chickpea has paused free trial usage for now, so I can't start this one. " +
            `Trials resume ${resumes}, or an Owner can choose a plan to continue now.`,
          owner, buttons: [CHOOSE_PLAN], ask: 'choose a plan',
          dmReason: `Chickpea has paused free trial usage for now, so it didn't run. Trials resume ${resumes}.`,
        };
  }
  const cause = refusal.cause;
  switch (cause?.kind) {
    case undefined:
    case 'plan_used':
      return { ...OUT_OF_USAGE, owner: 'Add usage or upgrade, then send this again.', buttons: [ADD_USAGE, UPGRADE] };
    case 'top_up_limit':
      return {
        ...OUT_OF_USAGE,
        owner: `Auto top-up reached its ${cause.limitCents === undefined ? 'monthly limit' : `${formatPriceCents(cause.limitCents)} limit for this month`}. ` +
          'Raise the limit or upgrade, then send this again.',
        buttons: [{ label: 'Raise limit', step: 'raise-limit' }, UPGRADE],
      };
    case 'top_up_declined':
      return {
        ...OUT_OF_USAGE,
        owner: "Auto top-up couldn't charge your card. Update it or add usage, then send this again.",
        buttons: [{ label: 'Update card', step: 'card' }, ADD_USAGE],
      };
    case 'top_up_unconfirmed':
      return {
        ...OUT_OF_USAGE,
        owner: 'Your bank needs you to confirm the auto top-up charge. Confirm it or add usage, then send this again.',
        buttons: [{ label: 'Confirm payment', step: 'card' }, ADD_USAGE],
      };
    case 'trial_used':
    case 'trial_ended':
      return {
        reply: cause.kind === 'trial_used'
          ? "This workspace's free trial usage is used up, so I can't start this one. Once an Owner chooses a plan, send it again."
          : "This workspace's free trial has ended, so I can't start this one. Once an Owner chooses a plan, send it again.",
        owner: ['Choose a plan, then send this again.', plansFrom(cause)].filter(Boolean).join(' '),
        buttons: [CHOOSE_PLAN],
        ask: 'choose a plan',
        dmReason: cause.kind === 'trial_used'
          ? "The free trial's usage is used up, so it didn't run."
          : "The free trial has ended, so it didn't run.",
      };
    case 'own_key_tasks_used':
      return {
        reply: "This workspace has used this month's tasks, so I can't do this one. I can still chat. " +
          'Once an Owner adds more, send it again.',
        owner: 'Add usage or upgrade, then send this again.',
        buttons: [ADD_USAGE, UPGRADE],
        ask: 'add usage',
        dmReason: "This workspace has used this month's tasks, so it didn't run.",
      };
    case 'own_key_no_plan': {
      const price = cause.plansFromCents === undefined ? undefined : formatPriceCents(cause.plansFromCents);
      return {
        reply: "This workspace needs a plan for tasks, so I can't do this one. I can still chat. " +
          'Once an Owner chooses a plan, send it again.',
        owner: 'Tasks need a plan when this workspace uses its own API key.' +
          (price ? ` Plans with your own key start at ${price} a month.` : ''),
        buttons: [price ? { label: `Choose the ${price} plan`, step: 'choose' } : CHOOSE_PLAN],
        ask: 'choose a plan',
        dmReason: "Tasks need a plan on this workspace's own API key, so it didn't run.",
      };
    }
  }
}

function plansFrom(cause: Extract<OutOfUsageCause, { kind: 'trial_used' | 'trial_ended' }>): string {
  if (cause.plansFromCents === undefined) return '';
  const bonus = cause.bonusPercent ? ` and include ${cause.bonusPercent}% more usage than they cost` : '';
  return `Plans start at ${formatPriceCents(cause.plansFromCents)} a month${bonus}.`;
}

/** The thread reply to a refused request: the same words for every role. */
export function fundingRefusalText(refusal: PlatformFundingRefusal): string {
  return refusalCopy(refusal).reply;
}

export function creditsAskOwnerDmText(clickerUserId: string, channelId: string, refusal: PlatformFundingRefusal): string {
  const copy = refusalCopy(refusal);
  return `<@${clickerUserId}> asked you to ${copy.ask} for a request in ${requestPlace(channelId)}. ${copy.dmReason}`;
}

function requestPlace(channelId: string): string {
  return channelId.startsWith('D') ? 'a direct message' : `<#${channelId}>`;
}

function askedText(names: readonly string[], refusal: PlatformFundingRefusal): string {
  return `✓ I asked ${owners(names)}. Send this again once they've ${done(refusal)}.`;
}

/** Owners are asked at most once in two clock hours, so a later click says so instead of asking again. */
function alreadyAskedText(names: readonly string[], refusal: PlatformFundingRefusal): string {
  const who = names.length > 0 ? owners(names) : "This workspace's Owners";
  return `${who} were asked in the last two hours. Send this again once they've ${done(refusal)}.`;
}

function done(refusal: PlatformFundingRefusal): string {
  return refusalCopy(refusal).ask === 'add usage' ? 'added usage' : 'chosen a plan';
}

function owners(names: readonly string[]): string {
  if (names.length === 0) return "this workspace's Owners";
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

type CreditsIdentity = Pick<IdentityStore, 'resolveSlackIdentity' | 'listMemberships' | 'listExternalIdentities' | 'getUser'>;
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

export interface CreditsAskDeps {
  identity: CreditsIdentity;
  claims: SlackClaimStore;
  client: CreditsAskClient;
  /** Admin's origin, for the Plan page buttons; without one the messages have none. */
  publicUrl?: string;
  /**
   * Why the workspace is out now, with the cause the reply kept private, for
   * an Owner's private reply and the Owners' DM. Undefined when the host
   * admits it or does not say; the reply's own words stand in.
   */
  currentRefusal?: () => Promise<PlatformFundingRefusal | undefined>;
  now?: () => number;
}

export type CreditsAskOutcome = 'asked' | 'already_asked' | 'owner' | 'unreachable';

/** A message with its text for notifications and the blocks Slack shows. */
export interface SlackNote {
  text: string;
  blocks: SlackBlock[];
}

const HOUR_MS = 3_600_000;
const SLACK_TS = /^\d{1,16}\.\d{1,16}$/;
const TEXT_BLOCK_TYPES = new Set(['markdown', 'rich_text', 'section']);
/** Refusals whose public reply already names their cause, so its button may carry it. */
const PUBLIC_CAUSES: ReadonlySet<OutOfUsageCauseKind> = new Set(['trial_used', 'trial_ended', 'own_key_tasks_used', 'own_key_no_plan']);

/**
 * A refused request's thread reply, on a deployment serving many
 * installations: the Owners' names and an Ask an Owner button for everyone,
 * and, when the requester is an Owner, the private reply to send after it.
 */
export async function fundingRefusalReply(input: {
  env: PlatformEnv | undefined;
  identity: CreditsIdentity;
  workspaceId: string;
  userId: string;
  refusal: PlatformFundingRefusal;
  publicUrl?: string;
}): Promise<{ components: RenderedSlackComponents; ownerNote?: SlackNote } | undefined> {
  if (deploymentTenancy(input.env) !== 'installation') return undefined;
  const [owner, names] = await Promise.all([
    isActiveOwner(input.identity, input.workspaceId, input.userId).catch(() => {
      console.warn('[chickpea] The out-of-usage reply could not read the requester\'s role');
      return false;
    }),
    activeOwners(input.identity, input.workspaceId).then(namesOf).catch(() => {
      console.warn('[chickpea] The out-of-usage reply could not read the installation\'s Owners');
      return [];
    }),
  ]);
  const blocks = [
    ...(names.length > 0 ? [contextBlock(`Owners: ${names.join(', ')}.`)] : []),
    askOwnerBlock(askButton(input.workspaceId, input.refusal)),
  ];
  return {
    components: { blocks, fallbackText: '' },
    ...(owner ? { ownerNote: ownerNote(input.refusal, input.publicUrl) } : {}),
  };
}

/** The Owner's private reply: the reason and the Plan page buttons that fix it. */
function ownerNote(refusal: PlatformFundingRefusal, publicUrl: string | undefined): SlackNote {
  const copy = refusalCopy(refusal);
  const buttons = planButtons(copy.buttons, publicUrl);
  return {
    text: copy.owner,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: copy.owner } }, ...(buttons ? [buttons] : [])],
  };
}

function planButtons(buttons: readonly PlanButton[], publicUrl: string | undefined): SlackBlock | undefined {
  const elements = buttons.flatMap(({ label, step }, index) => {
    const url = buildSlackAdminUrl(publicUrl, { planStep: step });
    return url
      ? [{
          type: 'button', action_id: `${PLAN_BUTTON_ACTION}.${step}`, url,
          text: { type: 'plain_text', text: label, emoji: false },
          ...(index === 0 ? { style: 'primary' } : {}),
        }]
      : [];
  });
  return elements.length > 0 ? { type: 'actions', elements } : undefined;
}

/**
 * A note only `userId` sees in the thread: an ephemeral message in a channel
 * or group DM, and an ordinary reply in a DM, where only they and the Agent are.
 */
export async function postPrivateNote(
  client: Pick<WebClient['chat'], 'postMessage' | 'postEphemeral'>,
  target: { channelId: string; userId: string; threadTs?: string; persona?: { username?: string; icon_url?: string } },
  note: SlackNote,
): Promise<void> {
  const message = {
    channel: target.channelId,
    ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
    text: note.text,
    ...(note.blocks.length > 0 ? { blocks: note.blocks } : {}),
    ...target.persona,
  };
  await (target.channelId.startsWith('D')
    ? client.postMessage(message as unknown as Parameters<typeof client.postMessage>[0])
    : client.postEphemeral({ ...message, user: target.userId } as unknown as Parameters<typeof client.postEphemeral>[0]));
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

/**
 * A Member's click DMs each active Owner, at most once in two clock hours
 * per installation, and redraws the reply with whom it asked. An Owner's
 * click gets the Owner's private reply instead.
 */
export async function askOwnersForCredits(action: CreditsAskAction, deps: CreditsAskDeps): Promise<CreditsAskOutcome> {
  try {
    return await ask(action, deps);
  } catch {
    console.warn('[chickpea] A request to the Owners could not be checked');
    await notify(action, deps.client, { text: CREDITS_ASK_UNREACHABLE_TEXT, blocks: [] });
    return 'unreachable';
  }
}

/** Its value carries the workspace, and a cause only when the public reply already names it. */
function askButton(workspaceId: string, refusal: PlatformFundingRefusal): { action_id: string; value: string } {
  if (refusal.kind === 'daily_limit') {
    return {
      action_id: DAILY_LIMIT_ASK_ACTION,
      value: `${workspaceId}:${refusal.scope}:${Math.floor(refusal.resumesAt / 1000)}`,
    };
  }
  const cause = refusal.cause?.kind;
  return {
    action_id: CREDITS_ASK_ADMIN_ACTION,
    value: cause && PUBLIC_CAUSES.has(cause) ? `${workspaceId}:${cause}` : workspaceId,
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

async function ask(action: CreditsAskAction, deps: CreditsAskDeps): Promise<CreditsAskOutcome> {
  if (await isActiveOwner(deps.identity, action.workspaceId, action.userId)) {
    await notify(action, deps.client, ownerNote(await refusalNow(action, deps), deps.publicUrl));
    return 'owner';
  }
  const listed = activeOwners(deps.identity, action.workspaceId).catch(() => {
    console.warn('[chickpea] The installation\'s Owners could not be read for a request to them');
    return [];
  });
  const release = await claimAskWindow(deps.claims, action.workspaceId, (deps.now ?? Date.now)());
  if (!release) {
    const text = alreadyAskedText(namesOf(await listed), action.refusal);
    await notify(action, deps.client, { text, blocks: [contextBlock(text)] });
    return 'already_asked';
  }
  const refusal = await refusalNow(action, deps);
  const buttons = planButtons(refusalCopy(refusal).buttons, deps.publicUrl);
  const text = creditsAskOwnerDmText(action.userId, action.channelId, refusal);
  const message = { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }, ...(buttons ? [buttons] : [])] };
  const asked: Owner[] = [];
  for (const owner of await listed) {
    if (await sendOwnerDm(deps.client, owner.slackUserId, message)) asked.push(owner);
  }
  if (asked.length === 0) {
    await release();
    await notify(action, deps.client, { text: CREDITS_ASK_UNREACHABLE_TEXT, blocks: [] });
    return 'unreachable';
  }
  const confirmation = askedText(namesOf(asked), action.refusal);
  if (!await replaceButton(action, confirmation, deps.client)) {
    await notify(action, deps.client, { text: confirmation, blocks: [] });
  }
  return 'asked';
}

/** The host's current answer, which may name a cause the reply kept private; otherwise what the reply said. */
async function refusalNow(action: CreditsAskAction, deps: CreditsAskDeps): Promise<PlatformFundingRefusal> {
  const current = await deps.currentRefusal?.().catch(() => undefined);
  return current ?? action.refusal;
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

interface Owner {
  readonly slackUserId: string;
  /** The name Slack last gave Chickpea; null when it never did. */
  readonly name: string | null;
}

async function activeOwners(identity: CreditsIdentity, workspaceId: string): Promise<Owner[]> {
  const [memberships, bindings] = await Promise.all([identity.listMemberships(), identity.listExternalIdentities()]);
  const users = new Map(memberships
    .filter((membership) => membership.role === 'owner' && membership.status === 'active')
    .map((membership) => [membership.id, membership.userId]));
  const owners = new Map<string, Promise<Owner>>();
  for (const binding of bindings) {
    const userId = users.get(binding.membershipId);
    if (binding.slackTeamId !== workspaceId || userId === undefined || owners.has(binding.slackUserId)) continue;
    owners.set(binding.slackUserId, identity.getUser(userId).then(
      (user) => ({ slackUserId: binding.slackUserId, name: user?.displayName?.trim() || null }),
      () => ({ slackUserId: binding.slackUserId, name: null }),
    ));
  }
  return (await Promise.all(owners.values()))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.slackUserId.localeCompare(b.slackUserId));
}

/**
 * Plain names, never mentions: a mention would notify every Owner each time
 * the reply is posted. Every Owner has a name, or none is named, so a list
 * never reads as complete when it is not.
 */
function namesOf(list: readonly Owner[]): string[] {
  const names = list.flatMap(({ name }) => name ? [name] : []);
  return names.length < list.length ? [] : names;
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

/** Told only to the person who clicked, in the reply's thread. */
async function notify(action: CreditsAskAction, client: CreditsAskClient, note: SlackNote): Promise<void> {
  await postPrivateNote(client.chat, {
    channelId: action.channelId,
    userId: action.userId,
    ...(action.threadTs ? { threadTs: action.threadTs } : {}),
  }, note).catch(() => {
    console.warn('[chickpea] A note about a request to the Owners was not delivered');
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
    console.warn('[chickpea] The out-of-usage reply could not be redrawn');
    return false;
  }
}

/** Undefined when redrawing would lose the reply's visible text. */
function withoutButton(blocks: SlackBlock[], text: string): SlackBlock[] | undefined {
  const index = blocks.findIndex((block) => block.block_id === CREDITS_ASK_ADMIN_BLOCK);
  if (index < 0 || !blocks.some((block) => TEXT_BLOCK_TYPES.has(String(block.type)))) return undefined;
  return blocks.with(index, contextBlock(text));
}

function askOwnerBlock(button: { action_id: string; value: string }): SlackBlock {
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
