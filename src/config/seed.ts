import type { AgentChannelGrantInput, CustomAgentConfig } from './types.ts';
import { CHICKPEA_AGENT_ID, CHICKPEA_AGENT_NAME } from './agent-id.ts';
import { isCloudflareTarget } from './runtime-target.ts';

// The keyless first-run model must be one Workers AI serves on the Workers
// Free plan. Cloudflare moved glm-5.2 behind Workers Paid on 2026-07-28 and
// launched glm-5.3-flash Paid-only, so a Free install seeded with either would
// 403 (error 5035) on its first turn.
export const SEED_CLOUDFLARE_MODEL_ID = '@cf/zai-org/glm-4.7-flash';
export const SEED_CLOUDFLARE_MODEL_PIN = `cloudflare/${SEED_CLOUDFLARE_MODEL_ID}`;
// Installs seeded before the Free-plan change still carry the old pin; the
// cutover starter-pin logic must keep recognizing it as untouched seed state.
const LEGACY_SEED_CLOUDFLARE_MODEL_PINS: ReadonlySet<string> = new Set([
  'cloudflare/@cf/zai-org/glm-5.2',
]);

export function isSeedCloudflareModelPin(model: string | undefined): boolean {
  return model === SEED_CLOUDFLARE_MODEL_PIN ||
    (model !== undefined && LEGACY_SEED_CLOUDFLARE_MODEL_PINS.has(model));
}

export type SeedTarget = 'cloudflare' | 'node';
export type SeedChannelGrant = AgentChannelGrantInput;

export function createSeededAgents(
  options: { target?: SeedTarget } = {},
): CustomAgentConfig[] {
  const target = options.target ?? (isCloudflareTarget() ? 'cloudflare' : 'node');
  const defaultAgent: CustomAgentConfig = {
    id: 'agent_default',
    kind: 'user',
    revision: 1,
    name: 'Sprout',
    // PROFILE layer only — the runtime composes the RUNTIME and GUARDRAIL layers
    // separately. A neutral, general-purpose voice with zero product-specific
    // opinion, so first-run onboarding involves no profile decisions.
    instructions:
      [
        'You are a general-purpose Slack assistant.',
        'Be direct and concise, and match the formality of the conversation.',
        'Use Slack-friendly markdown only where it aids clarity — short lists, a small code block, or a compact table for genuinely tabular data — and skip decorative formatting. Never force prose into a table.',
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

/** Product-owned system principal, materialized only after the Stage 2 fleet gate. */
export function createChickpeaAgent(): CustomAgentConfig {
  return {
    id: CHICKPEA_AGENT_ID,
    kind: 'system',
    revision: 1,
    name: CHICKPEA_AGENT_NAME,
    description: 'Your workspace assistant and Agent administrator.',
    instructions: [
      'You are Chickpea, the built-in workspace assistant.',
      'Help with general questions, explain how Chickpea works, and administer the workspace only through authorized tools.',
      'Suggest a user Agent when work should become specialized, reusable, or recurring.',
      'Be direct and concise, and never invent facts or expose secrets.',
    ].join(' '),
    enabled: true,
    lifecycle: 'active',
    editPolicy: 'creator_and_admins',
    configurationGeneration: 1,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  };
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
