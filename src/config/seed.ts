import type { AgentChannelGrantInput, CustomAgentConfig } from './types.ts';
import { isCloudflareTarget } from './runtime-target.ts';

export const SEED_CLOUDFLARE_MODEL_ID = '@cf/zai-org/glm-5.2';
export const SEED_CLOUDFLARE_MODEL_PIN = `cloudflare/${SEED_CLOUDFLARE_MODEL_ID}`;

export type SeedTarget = 'cloudflare' | 'node';
export type SeedChannelGrant = AgentChannelGrantInput;

export function createSeededAgents(
  options: { target?: SeedTarget } = {},
): CustomAgentConfig[] {
  const target = options.target ?? (isCloudflareTarget() ? 'cloudflare' : 'node');
  const defaultAgent: CustomAgentConfig = {
    id: 'agent_default',
    revision: 1,
    name: 'Sprout',
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
    apiConnections: [],
    repositories: [],
  };
  return [defaultAgent];
}

export const seededAgents: CustomAgentConfig[] = createSeededAgents();

/** Fresh workspaces have no Channel reach until an Agent is published. */
export const seededAgentChannelGrants: SeedChannelGrant[] = [];

// TDEMO channel-assignment FIXTURES for the offline harnesses (parity
// scenarios, verify scripts, unit tests). These are intentionally NOT part of
// seededAssignments: a fresh install must not show demo channels in /admin.
// Both point at the single seeded profile (agent_default) so the harnesses can
// seed TDEMO channels with the same agent list the install ships. A scenario
// that needs two DISTINCT profiles builds them in its own setup (see S29 in
// tests/parity/scenarios.ts), not from these fixtures.
export const demoEngChannelGrant: SeedChannelGrant = {
  workspaceId: 'TDEMO',
  channelId: 'C_ENG',
  agentId: 'agent_default',
  status: 'active',
  createdByMembershipId: 'member_demo',
  channelLabel: 'eng-releases',
};

export const demoExecChannelGrant: SeedChannelGrant = {
  workspaceId: 'TDEMO',
  channelId: 'C_EXEC',
  agentId: 'agent_default',
  status: 'active',
  createdByMembershipId: 'member_demo',
  channelLabel: 'exec-briefing',
};

export const demoAgentChannelGrants: SeedChannelGrant[] = [
  demoEngChannelGrant,
  demoExecChannelGrant,
];
