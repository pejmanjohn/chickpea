import type { View } from '@slack/types';
import type { SlackInteractionPayload } from '@flue/slack';

import type { CustomAgentConfig } from '../config/types.ts';

export const START_AGENT_ACTION_ID = 'chickpea.agent.start';

export function agentDirectoryAppHome(agents: readonly CustomAgentConfig[]): View {
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
  }
  return { type: 'home', blocks } as unknown as View;
}

export interface AgentAppHomeSelection {
  workspaceId: string;
  userId: string;
  agentId: string;
}

export function parseAgentAppHomeSelection(
  payload: SlackInteractionPayload,
): AgentAppHomeSelection | undefined {
  if (payload.type !== 'block_actions' || !payload.team?.id || !payload.user?.id) {
    return undefined;
  }
  const action = payload.actions.find((candidate) => candidate.action_id === START_AGENT_ACTION_ID);
  if (!action || typeof action.value !== 'string' || !safeAgentId(action.value)) return undefined;
  return {
    workspaceId: payload.team.id,
    userId: payload.user.id,
    agentId: action.value,
  };
}

function safeAgentId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(value);
}

function escapeSlack(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
