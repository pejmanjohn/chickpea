import type { WebClient } from '@slack/web-api';

import { canEditAgent } from '../auth/permissions.ts';
import type { AuthPrincipal } from '../auth/types.ts';
import { isAgentId } from '../config/agent-id.ts';
import type { CustomAgentConfig } from '../config/types.ts';
import type { IdentityStore } from '../identity/types.ts';
import { agentSlackHandle } from './agent-asks.ts';
import { activeOwnerSlackUserIds } from './credits-ask.ts';
import type { AgentRoutingActor } from './agent-routing.ts';
import type { SlackTransport } from './transport/types.ts';
import type { SlackUiAction } from './ui/interaction-payload.ts';

/**
 * The button that adds a mentioned Agent to the Channel it was mentioned in.
 * It is in the host namespace, so the shared gateway forwards its click like
 * any host control; it names no stored surface, and every click is
 * authorized again.
 */
export const AGENT_CHANNEL_ADD_ACTION = 'chickpea.host.v1.agent_channel_add';

/** Slack's limit for a button label. */
const BUTTON_LABEL_LIMIT = 75;
/** Owners named to someone who cannot add the Agent themselves. */
const OWNERS_NAMED = 2;

type SlackBlock = Record<string, unknown>;
type OfferIdentity = Pick<IdentityStore, 'listMemberships' | 'listExternalIdentities'>;
type EphemeralClient = { chat: Pick<WebClient['chat'], 'postEphemeral'> };

interface AddingActor {
  routing: AgentRoutingActor;
  principal?: AuthPrincipal;
}

/** Someone asking for an Agent in a Channel: the offer's Add click, or Slack's own Add of the Agent's app bot. */
export interface AgentChannelAddRequest {
  workspaceId: string;
  userId: string;
  channelId: string;
  threadTs: string | null;
  agentId: string;
  /** The click's action_ts, or the join event's ID: a redelivery of either is answered once. */
  requestId: string;
}

/** Parsing grants no authority. */
export function parseAgentChannelAddClick(action: SlackUiAction): AgentChannelAddRequest | undefined {
  if (action.actionId !== AGENT_CHANNEL_ADD_ACTION || action.containerType !== 'message' ||
      !action.channelId || !action.value || !isAgentId(action.value)) return undefined;
  return {
    workspaceId: action.workspaceId,
    userId: action.userId,
    channelId: action.channelId,
    threadTs: action.threadTs,
    agentId: action.value,
    requestId: action.actionTs,
  };
}

/**
 * Tells the person who mentioned `agent` in a Channel it has not been added
 * to, privately and where they wrote. Someone who may add it gets a button
 * that does; anyone else learns who can. When the bot the Agent posts as is
 * what is missing, the button could not bring that bot in, so nobody gets it.
 */
export async function offerAgentForChannel(input: {
  workspaceId: string;
  channelId: string;
  userId: string;
  /** The thread the mention was in, when it was a reply. */
  threadTs?: string;
  agent: CustomAgentConfig;
  postingBotAbsent?: boolean;
  actor: AddingActor;
  identity: OfferIdentity;
  transport: Pick<SlackTransport, 'lookupChannel'>;
  client: EphemeralClient;
}): Promise<void> {
  const handle = agentSlackHandle(input.agent)?.handle ?? input.agent.id;
  const notInChannel = `@${handle} isn’t in <#${input.channelId}> yet.`;
  let text: string;
  let blocks: SlackBlock[] | undefined;
  const mayAdd = canEditAgent(input.actor.principal, input.agent);
  if (mayAdd && input.postingBotAbsent) {
    text = notInChannel;
  } else if (mayAdd) {
    const channelName = await input.transport.lookupChannel(input.channelId)
      .then(({ name }) => name, () => undefined);
    text = notInChannel;
    blocks = [
      { type: 'section', text: { type: 'mrkdwn', text } },
      {
        type: 'actions',
        block_id: AGENT_CHANNEL_ADD_ACTION,
        elements: [{
          type: 'button',
          action_id: AGENT_CHANNEL_ADD_ACTION,
          style: 'primary',
          text: { type: 'plain_text', text: addButtonLabel(handle, channelName) },
          value: input.agent.id,
        }],
      },
    ];
  } else {
    text = `${notInChannel} ${askOwnersToAdd(await namedOwners(input.identity, input.workspaceId))} to add it.`;
  }
  await input.client.chat.postEphemeral({
    channel: input.channelId,
    user: input.userId,
    text,
    ...(blocks ? { blocks } : {}),
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
  } as Parameters<WebClient['chat']['postEphemeral']>[0]);
}

export interface AgentChannelAddDependencies {
  /** First wins, so a redelivered request is answered once. */
  claim(key: string): Promise<boolean>;
  /** The person asking, in this Channel, read now rather than when the button was sent. */
  resolveActor(): Promise<AddingActor>;
  getAgent(agentId: string): Promise<CustomAgentConfig | undefined>;
  identity: OfferIdentity;
  /** Adds the Agent to the Channel exactly as Admin's Add to channels does. */
  publish(agent: CustomAgentConfig, principal: AuthPrincipal): Promise<void>;
  adminUrl(): Promise<string | undefined>;
  client: EphemeralClient;
}

/** A request to add an Agent to a Channel: Admin's authority check, then Admin's publish. */
export async function addAgentToChannel(
  request: AgentChannelAddRequest,
  deps: AgentChannelAddDependencies,
): Promise<void> {
  const key = ['agent-channel-add', request.workspaceId, request.channelId, request.agentId, request.userId, request.requestId];
  if (!await deps.claim(key.join(':'))) return;
  const [actor, agent] = await Promise.all([deps.resolveActor(), deps.getAgent(request.agentId)]);
  const handle = agent?.kind === 'user' ? agentSlackHandle(agent)?.handle : undefined;
  let text: string;
  if (!agent || !handle || !actor.routing.fullMember || !actor.routing.channelMember) {
    text = 'That Agent is not available here.';
  } else if (!actor.principal || !canEditAgent(actor.principal, agent)) {
    text = `${askOwnersToAdd(await namedOwners(deps.identity, request.workspaceId))} to add @${handle} to this channel.`;
  } else {
    try {
      await deps.publish(agent, actor.principal);
      text = `@${handle} is ready in this channel. Mention @${handle} to start a conversation.`;
    } catch {
      const url = await deps.adminUrl().catch(() => undefined);
      text = `I couldn’t add @${handle} to this channel. Open Chickpea to add it there.` +
        (url && !/[<>|]/.test(url) ? ` <${url}|Open Chickpea>` : '');
    }
  }
  await deps.client.chat.postEphemeral({
    channel: request.channelId,
    user: request.userId,
    text,
    ...(request.threadTs ? { thread_ts: request.threadTs } : {}),
  });
}

function addButtonLabel(handle: string, channelName: string | undefined): string {
  const named = channelName ? `Add @${handle} to #${channelName}` : undefined;
  return named && named.length <= BUTTON_LABEL_LIMIT ? named : `Add @${handle} to this channel`;
}

async function namedOwners(identity: OfferIdentity, workspaceId: string): Promise<string[]> {
  const owners = await activeOwnerSlackUserIds(identity, workspaceId).catch(() => []);
  return owners.slice(0, OWNERS_NAMED);
}

function askOwnersToAdd(owners: readonly string[]): string {
  if (owners.length === 0) return 'Ask a workspace Owner or Admin';
  return `Ask a workspace Owner or Admin, such as ${owners.map((id) => `<@${id}>`).join(' or ')},`;
}
