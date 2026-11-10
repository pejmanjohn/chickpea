import { slackActionResponseUrl } from './action-response-url.ts';
import {
  PrivateChannelSetupError,
  type AddPrivateChannelAgentResult,
} from './private-channel-setup-service.ts';

/** Versioned alongside the private gateway's narrowly normalized Add action. */
export const PRIVATE_CHANNEL_SETUP_ADD_ACTION = 'chickpea.private_channel_setup.v1.add';
export const PRIVATE_CHANNEL_SETUP_AGENT_ACTION = 'chickpea.private_channel_setup.v1.agent';
export const PRIVATE_CHANNEL_SETUP_CHOICE_BLOCK = 'chickpea.private_channel_setup.v1.choice';

export interface PrivateChannelSetupAction {
  workspaceId: string;
  userId: string;
  channelId: string;
  setupId: string;
  /** A valid unselected control produces private guidance, never a mutation. */
  agentId: string | null;
  deliveryId: string;
  /** Where the clicked card can be replaced. The gateway never forwards one. */
  responseUrl?: string;
}

/** Parsing grants no authority. Call only after Slack signature verification. */
export function parsePrivateChannelSetupAction(payload: unknown): PrivateChannelSetupAction | undefined {
  const click = parseSetupCardClick(payload, PRIVATE_CHANNEL_SETUP_ADD_ACTION);
  if (!click) return undefined;
  const values = record(record(click.root.state)?.values);
  const control = record(record(values?.[PRIVATE_CHANNEL_SETUP_CHOICE_BLOCK])?.[PRIVATE_CHANNEL_SETUP_AGENT_ACTION]);
  if (control?.type !== 'static_select') return undefined;
  const selected = control.selected_option;
  const agentId = selected === null ? null : record(selected)?.value;
  if (agentId !== null && !safeId(agentId)) return undefined;
  return { ...click.action, agentId };
}

/** One button click on an inviter's own ephemeral setup card. */
function parseSetupCardClick(payload: unknown, actionId: string) {
  const root = record(payload);
  if (root?.type !== 'block_actions') return undefined;
  const team = record(root.team);
  const user = record(root.user);
  const channel = record(root.channel);
  const container = record(root.container);
  if (!safeId(team?.id) || !safeId(user?.id) || !safeId(channel?.id) ||
      container?.type !== 'message' || container.is_ephemeral !== true ||
      container.channel_id !== channel.id || !Array.isArray(root.actions)) return undefined;
  const actions = root.actions.map(record).filter((action) => action?.action_id === actionId);
  if (actions.length !== 1 || root.actions.length !== 1) return undefined;
  const action = actions[0]!;
  if (!safeId(action.value)) return undefined;
  const actionTs = action.action_ts;
  if (typeof actionTs !== 'string' || !/^\d{1,16}\.\d{1,16}$/.test(actionTs)) return undefined;
  const responseUrl = slackActionResponseUrl(root.response_url);
  return {
    root,
    action: {
      workspaceId: team.id,
      userId: user.id,
      channelId: channel.id,
      setupId: action.value,
      deliveryId: `setup:${team.id}:${user.id}:${channel.id}:${action.value}:${actionTs}`,
      ...(responseUrl ? { responseUrl } : {}),
    },
  };
}

interface SetupChoice {
  id: string;
  name: string;
  handle?: string;
}

export interface SetupCardMessage {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

export function privateChannelSetupCard(input: {
  setupId: string;
  agents: readonly SetupChoice[];
  truncated?: boolean;
  adminUrl?: string;
}): SetupCardMessage {
  const choices = input.agents.slice(0, 100);
  const text = choices.length
    ? 'Choose an Agent to add to this private channel. Only you can see this setup.'
    : 'Open Chickpea to create or manage Agents for this private channel.';
  const blocks: Array<Record<string, unknown>> = [{
    type: 'section',
    text: { type: 'plain_text', text, emoji: false },
  }];
  if (choices.length) {
    blocks.push({
      type: 'actions',
      block_id: PRIVATE_CHANNEL_SETUP_CHOICE_BLOCK,
      elements: [{
        type: 'static_select',
        action_id: PRIVATE_CHANNEL_SETUP_AGENT_ACTION,
        placeholder: { type: 'plain_text', text: 'Choose an Agent', emoji: false },
        options: choices.map((agent) => ({
          text: { type: 'plain_text', text: label(agent.name), emoji: false },
          value: agent.id,
          ...(agent.handle ? {
            description: { type: 'plain_text', text: label(`@${agent.handle}`), emoji: false },
          } : {}),
        })),
      }],
    });
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        action_id: PRIVATE_CHANNEL_SETUP_ADD_ACTION,
        value: input.setupId,
        style: 'primary',
        text: { type: 'plain_text', text: 'Add', emoji: false },
        accessibility_label: 'Add the selected Agent to this private channel',
      }],
    });
  }
  const adminUrl = safeAdminUrl(input.adminUrl);
  blocks.push({
    type: 'context',
    elements: [{
      type: 'plain_text',
      text: input.truncated || input.agents.length > 100
        ? 'Showing the first 100 Agents you can add. Open Chickpea to see more.'
        : 'You can also add Agents from Chickpea whenever you need to.',
      emoji: false,
    }],
  });
  if (adminUrl) blocks.push({ type: 'actions', elements: [openChickpeaButton(adminUrl)] });
  return { text, blocks };
}

/**
 * What one setup click does to the inviter's card: replace it once it is
 * finished, answer beside it while it is still usable, or say nothing.
 * `fallback` is what goes out as a new ephemeral message when the card cannot
 * be replaced: the text alone, or the whole card when it is one to click.
 */
export type SetupCardReply =
  | { kind: 'replace'; message: SetupCardMessage; fallback: 'text' | 'card' }
  | { kind: 'notice'; text: string }
  | { kind: 'silent' };

export type PrivateChannelSetupOutcome =
  | AddPrivateChannelAgentResult
  | { kind: 'choose' }
  | { kind: 'unavailable'; reason: 'expired' | 'used' }
  | { kind: 'failed'; error: unknown };

export function privateChannelSetupReply(
  outcome: PrivateChannelSetupOutcome,
  context: { adminUrl?: string },
): SetupCardReply {
  switch (outcome.kind) {
    case 'completed':
      return { kind: 'replace', message: setupConfirmation(outcome.handle, context), fallback: 'text' };
    case 'in_progress':
      return { kind: 'notice', text: 'This Agent is being added. Click Add again in a moment to check.' };
    case 'choose':
      return { kind: 'notice', text: 'Choose an Agent in the setup card, then click Add.' };
    case 'no_longer_added':
      return unavailableReply('removed', context);
    case 'unavailable':
      return unavailableReply(outcome.reason, context);
    case 'recovery_required':
      return textReply(privateChannelSetupRecoveryText(context.adminUrl));
    case 'failed':
      return failedReply(outcome.error, context);
  }
}

function failedReply(error: unknown, context: { adminUrl?: string }): SetupCardReply {
  // An unexpected error leaves the card as it was, so another click can retry.
  if (!(error instanceof PrivateChannelSetupError)) {
    return { kind: 'notice', text: privateChannelSetupRecoveryText(context.adminUrl) };
  }
  switch (error.code) {
    case 'forbidden':
      return { kind: 'silent' };
    case 'agent_off':
      return { kind: 'notice', text: error.message };
    case 'unverifiable':
      return { kind: 'notice', text: 'I couldn’t check this Agent right now. Click Add again in a moment.' };
    case 'expired':
    case 'stale':
      return unavailableReply(error.code, context);
    case 'unavailable':
      return unavailableReply('used', context);
  }
}

function setupConfirmation(handle: string, context: { adminUrl?: string }): SetupCardMessage {
  const text = `Added @${handle} to this private channel. Mention @${handle} to start a conversation.`;
  const adminUrl = safeAdminUrl(context.adminUrl);
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'plain_text', text, emoji: false } },
      ...(adminUrl ? [{ type: 'actions', elements: [openChickpeaButton(adminUrl)] }] : []),
    ],
  };
}

function unavailableReply(
  reason: 'expired' | 'stale' | 'used' | 'removed',
  context: { adminUrl?: string },
): SetupCardReply {
  return textReply(privateChannelSetupUnavailableText(reason, context.adminUrl));
}

/** The text carries its own Open Chickpea link, so it renders as mrkdwn. */
function textReply(text: string): SetupCardReply {
  return {
    kind: 'replace',
    message: { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] },
    fallback: 'text',
  };
}

function openChickpeaButton(url: string): Record<string, unknown> {
  return { type: 'button', text: { type: 'plain_text', text: 'Open Chickpea', emoji: false }, url };
}

function privateChannelSetupRecoveryText(adminUrl?: string): string {
  const url = safeAdminUrl(adminUrl);
  return 'This setup could not finish. Open Chickpea, choose the Agent, and retry adding this channel.' +
    (url ? ` <${url}|Open Chickpea>` : '');
}

function privateChannelSetupUnavailableText(
  reason: 'expired' | 'stale' | 'used' | 'removed',
  adminUrl?: string,
): string {
  const explanation = {
    expired: 'This setup card has expired.',
    stale: 'This setup card is no longer current.',
    used: 'This setup card has already been used.',
    removed: 'This Agent is no longer available in this channel.',
  }[reason];
  const url = safeAdminUrl(adminUrl);
  return `${explanation} Open Chickpea to add an Agent to this channel.` +
    (url ? ` <${url}|Open Chickpea>` : '');
}

function label(value: string): string {
  const trimmed = value.trim() || 'Agent';
  return [...trimmed].length > 75 ? `${[...trimmed].slice(0, 74).join('')}…` : trimmed;
}

function safeAdminUrl(value?: string): string | undefined {
  if (!value || value.length > 2_048 || /[<>|]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
