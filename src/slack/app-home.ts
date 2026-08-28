import type { View } from '@slack/types';
import type { SlackInteractionPayload } from '@flue/slack';

import type { CustomAgentConfig } from '../config/types.ts';

export const START_AGENT_ACTION_ID = 'chickpea.agent.start';

export function agentAppHomeStarterMessage(agentName: string): string {
  return `${agentName} is ready.`;
}

export function agentDirectoryAppHome(
  agents: readonly CustomAgentConfig[],
  options: { unavailableNotice?: boolean } = {},
): View {
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Your Agents', emoji: true },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: 'Choose an Agent to start a private thread in the Messages tab.',
      }],
    },
    { type: 'divider' },
  ];
  if (options.unavailableNotice) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: 'That Agent is not available right now. Your available Agents are shown below.',
      }],
    });
  }
  if (agents.length === 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'No Agents are available to you yet. Join a Channel where an Agent is active, or ask an Agent editor to publish one.',
      },
    });
  } else {
    for (const agent of agents.slice(0, 24)) {
      const handle = agent.slackPresence?.normalizedHandle;
      const description = agent.description?.trim();
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${escapeSlack(agent.name)}*${handle ? `  ·  \`@${escapeSlack(handle)}\`` : ''}${
            description ? `\n${escapeSlack(description)}` : ''
          }`,
        },
        accessory: {
          type: 'button',
          action_id: START_AGENT_ACTION_ID,
          value: agent.id,
          text: { type: 'plain_text', text: 'Message', emoji: true },
          accessibility_label: `Message ${agent.name}`,
        },
      });
    }
    if (agents.length > 24) {
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `Showing 24 of ${agents.length} available Agents. Open Chickpea Admin to browse the full directory.`,
        }],
      });
    }
  }
  return { type: 'home', blocks } as unknown as View;
}

export interface AgentAppHomeSelection {
  workspaceId: string;
  userId: string;
  agentId: string;
  /** Stable Slack action identity used to deduplicate a retried starter post. */
  deliveryId?: string;
}

export function parseAgentAppHomeSelection(
  payload: SlackInteractionPayload,
): AgentAppHomeSelection | undefined {
  if (payload.type !== 'block_actions' || !payload.team?.id || !payload.user?.id) {
    return undefined;
  }
  const action = payload.actions.find((candidate) => candidate.action_id === START_AGENT_ACTION_ID);
  if (!action || typeof action.value !== 'string' || !safeAgentId(action.value)) return undefined;
  const actionTs = (action as { action_ts?: unknown }).action_ts;
  const triggerId = (payload as { trigger_id?: unknown }).trigger_id;
  const actionIdentity = typeof actionTs === 'string' && actionTs.length <= 256
    ? actionTs
    : typeof triggerId === 'string' && triggerId.length <= 256
      ? triggerId
      : undefined;
  return {
    workspaceId: payload.team.id,
    userId: payload.user.id,
    agentId: action.value,
    ...(actionIdentity
      ? { deliveryId: `interaction:${payload.team.id}:${payload.user.id}:${action.value}:${actionIdentity}` }
      : {}),
  };
}

function safeAgentId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(value);
}

function escapeSlack(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
