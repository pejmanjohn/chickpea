import type { ChannelAssignment, CustomAgentConfig } from './types.ts';
import { isCloudflareTarget } from './runtime-target.ts';

export const SEED_CLOUDFLARE_MODEL_PIN = 'cloudflare/@cf/zai-org/glm-5.2';

export type SeedTarget = 'cloudflare' | 'node';

export function createSeededAgents(
  options: { target?: SeedTarget } = {},
): CustomAgentConfig[] {
  const target = options.target ?? (isCloudflareTarget() ? 'cloudflare' : 'node');
  const defaultAgent: CustomAgentConfig = {
    id: 'agent_default',
    name: 'Default',
    // PROFILE layer only — the runtime composes the RUNTIME and GUARDRAIL layers
    // separately. A neutral, general-purpose voice with zero product-specific
    // opinion, so first-run onboarding involves no profile decisions.
    instructions:
      [
        'You are a general-purpose Slack assistant.',
        'Be direct and concise, and match the formality of the conversation.',
        'Use Slack-friendly markdown only where it aids clarity — short lists or a small code block — and skip decorative formatting.',
        'Say what is missing when you lack the context to answer.',
        'Never invent facts.',
      ].join(' '),
    enabled: true,
    ...(target === 'cloudflare' ? { model: SEED_CLOUDFLARE_MODEL_PIN } : {}),
    skills: [],
    mcpServers: [],
  };
  return [defaultAgent];
}

export const seededAgents: CustomAgentConfig[] = createSeededAgents();

export const seededAssignments: ChannelAssignment[] = [
  {
    // The global '*,*' wildcard is the DIRECT-conversation default (DMs, App
    // Home) — NOT a channel catch-all. The config resolver excludes it for
    // channel turns, so a fresh install is fail-closed in channels: the bot
    // answers a channel only where a profile is explicitly assigned, but a
    // teammate can still DM it out of the box. See surfaceForChannelId.
    workspaceId: '*',
    channelId: '*',
    agentId: 'agent_default',
    enabled: true,
  },
];

// T_DEMO channel-assignment FIXTURES for the offline harnesses (parity
// scenarios, verify scripts, unit tests). These are intentionally NOT part of
// seededAssignments: a fresh install must not show demo channels in /admin.
// Both point at the single seeded profile (agent_default) so the harnesses can
// seed T_DEMO channels with the same agent list the install ships. A scenario
// that needs two DISTINCT profiles builds them in its own setup (see S29 in
// tests/parity/scenarios.ts), not from these fixtures.
export const demoEngChannelAssignment: ChannelAssignment = {
  workspaceId: 'T_DEMO',
  channelId: 'C_ENG',
  agentId: 'agent_default',
  enabled: true,
  channelLabel: 'eng-releases',
};

export const demoExecChannelAssignment: ChannelAssignment = {
  workspaceId: 'T_DEMO',
  channelId: 'C_EXEC',
  agentId: 'agent_default',
  enabled: true,
  channelLabel: 'exec-briefing',
};

export const demoChannelAssignments: ChannelAssignment[] = [
  demoEngChannelAssignment,
  demoExecChannelAssignment,
];
