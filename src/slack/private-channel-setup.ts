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
}

/** Parsing grants no authority. Call only after Slack signature verification. */
export function parsePrivateChannelSetupAction(payload: unknown): PrivateChannelSetupAction | undefined {
  const root = record(payload);
  if (root?.type !== 'block_actions') return undefined;
  const team = record(root.team);
  const user = record(root.user);
  const channel = record(root.channel);
  const container = record(root.container);
  if (!safeId(team?.id) || !safeId(user?.id) || !safeId(channel?.id) ||
      container?.type !== 'message' || container.is_ephemeral !== true ||
      container.channel_id !== channel.id || !Array.isArray(root.actions)) return undefined;
  const actions = root.actions.map(record).filter((action) =>
    action?.action_id === PRIVATE_CHANNEL_SETUP_ADD_ACTION);
  if (actions.length !== 1 || root.actions.length !== 1) return undefined;
  const action = actions[0]!;
  if (!safeId(action.value)) return undefined;
  const actionTs = action.action_ts;
  if (typeof actionTs !== 'string' || !/^\d{1,16}\.\d{1,16}$/.test(actionTs)) return undefined;
  const values = record(record(root.state)?.values);
  const control = record(record(values?.[PRIVATE_CHANNEL_SETUP_CHOICE_BLOCK])?.[PRIVATE_CHANNEL_SETUP_AGENT_ACTION]);
  if (control?.type !== 'static_select') return undefined;
  const selected = control.selected_option;
  const agentId = selected === null ? null : record(selected)?.value;
  if (agentId !== null && !safeId(agentId)) return undefined;
  return {
    workspaceId: team.id,
    userId: user.id,
    channelId: channel.id,
    setupId: action.value,
    agentId,
    deliveryId: `setup:${team.id}:${user.id}:${channel.id}:${action.value}:${actionTs}`,
  };
}

interface SetupChoice {
  id: string;
  name: string;
  handle?: string;
}

export function privateChannelSetupCard(input: {
  setupId: string;
  agents: readonly SetupChoice[];
  truncated?: boolean;
  adminUrl?: string;
}): { text: string; blocks: Array<Record<string, unknown>> } {
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
  if (adminUrl) blocks.push({
    type: 'actions',
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: 'Open Chickpea', emoji: false },
      url: adminUrl,
    }],
  });
  return { text, blocks };
}

export function privateChannelSetupRecoveryText(adminUrl?: string): string {
  const url = safeAdminUrl(adminUrl);
  return 'This setup could not finish. Open Chickpea, choose the Agent, and retry adding this channel.' +
    (url ? ` <${url}|Open Chickpea>` : '');
}

export function privateChannelSetupUnavailableText(
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
