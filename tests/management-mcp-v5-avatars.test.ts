import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import { workspaceManagementMcpFetch } from '../src/management/mcp.ts';
import {
  DEFAULT_AGENT_AVATAR_FILES,
  DEFAULT_AGENT_AVATAR_NAMES,
  defaultAgentAvatarIndex,
  defaultAgentAvatarSeedFor,
} from '../src/slack/agent-presence/default-avatar-pool.ts';
import { createFixtureAgent, createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const BASE_URL = 'https://chickpea.example.test';

type ToolResult = { structuredContent?: Record<string, any>; isError?: boolean };

async function harness(t: TestContext, suffix: string) {
  const f = await createManagementAdapterFixture(suffix, ({ settings }) => ({ settings }));
  t.after(() => f.close());
  const principal: McpAuthenticatedPrincipal = {
    betterAuthUserId: f.owner.binding.betterAuthUserId ?? 'ba_owner',
    userId: f.owner.user.id,
    membershipId: f.owner.membership.id,
    organizationId: f.owner.membership.organizationId,
    role: 'owner',
    clientId: `client_${suffix}`,
  };
  const fetch = workspaceManagementMcpFetch({ principal, service: f.service, baseUrl: BASE_URL });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }));
    const text = await response.text();
    const json = text.trimStart().startsWith('{') ? text : text.split('\n').find((line) => line.startsWith('data: '))!.slice(6);
    return (JSON.parse(json) as { result: ToolResult }).result;
  };
  return { f, call };
}

const PROPOSAL = {
  name: 'Invoice Chaser',
  handle: 'invoices',
  job: 'Chases overdue invoices.',
  instructions: 'Chase invoices more than 30 days overdue.',
  sampleAsk: 'who is overdue?',
  promisedAnswer: 'Two customers are overdue.',
};

function pictureOf(seed: string | undefined): string {
  return DEFAULT_AGENT_AVATAR_FILES[defaultAgentAvatarIndex(seed ?? '')]!;
}

test('the proposal shows the default picture the Agent gets, the least-used one, and a retry keeps it', async (t) => {
  const { f, call } = await harness(t, 'avatar-proposal');
  // Eleven Agents already wear eleven of the twelve defaults, so creation would pick the twelfth.
  const left = DEFAULT_AGENT_AVATAR_FILES[7]!;
  for (const [index, file] of DEFAULT_AGENT_AVATAR_FILES.filter((file) => file !== left).entries()) {
    await createFixtureAgent(f, `agent_existing_${index}`, {
      slackPresence: {
        requestedHandle: `existing-${index}`, normalizedHandle: `existing-${index}`, desiredState: 'active', health: 'healthy',
        avatar: { kind: 'generated', revision: 1, seed: defaultAgentAvatarSeedFor(file, `n${index}`) },
      },
    });
  }
  const proposal = (await call('propose_agent', PROPOSAL)).structuredContent!;
  assert.equal(proposal.create.arguments.avatar, DEFAULT_AGENT_AVATAR_NAMES[7]);
  assert.equal(proposal.proposal.avatarUrl, `${BASE_URL}/chickpea-avatars/agent-defaults/${left}`);

  const created = (await call('create_agent', proposal.create.arguments)).structuredContent!;
  const agent = await f.config.getAgent(created.agent.agentId);
  assert.equal(pictureOf(agent.slackPresence?.avatar.seed), left, 'Slack shows the picture the proposal showed');
  assert.equal(created.agent.avatarUrl, `${BASE_URL}/assets/agents/${agent.id}/avatar/1`);

  const retried = (await call('create_agent', proposal.create.arguments)).structuredContent!;
  assert.equal(retried.agent.agentId, agent.id, 'the same key replays the same Agent');
  assert.equal(pictureOf((await f.config.getAgent(agent.id)).slackPresence?.avatar.seed), left);
  assert.equal((await f.config.listUserAgents()).length, 12, 'one Agent was created');
});

test('create_agent wears exactly the default it names, and refuses a name that is not one', async (t) => {
  const { f, call } = await harness(t, 'avatar-named');
  const { idempotencyKey: _key, ...args } = (await call('propose_agent', PROPOSAL)).structuredContent!.create.arguments;
  for (const [index, name] of ['coral', 'muted-berry'].entries()) {
    const created = (await call('create_agent', { ...args, name: `Chaser ${index}`, handle: `chaser-${index}`, avatar: name, idempotencyKey: `named-${index}` })).structuredContent!;
    const file = DEFAULT_AGENT_AVATAR_FILES[DEFAULT_AGENT_AVATAR_NAMES.indexOf(name)];
    assert.equal(pictureOf((await f.config.getAgent(created.agent.agentId)).slackPresence?.avatar.seed), file);
  }
  const refused = await call('create_agent', { ...args, avatar: 'sunflower', idempotencyKey: 'unknown' });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent!.error.code, 'invalid_input');
  assert.equal((await f.config.listUserAgents()).length, 2, 'nothing was created for it');
});

test('every result a card draws for an existing Agent carries its picture on Chickpea\'s own origin', async (t) => {
  const { f, call } = await harness(t, 'avatar-outputs');
  // A gateway publishes this one on its own origin; Chickpea serves the same revision itself.
  await createFixtureAgent(f, 'agent_support', {
    slackPresence: {
      requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy',
      avatar: { kind: 'uploaded', revision: 3, url: 'https://gateway.example.net/avatars/agent_support/3.png' },
    },
  });
  const url = `${BASE_URL}/assets/agents/agent_support/avatar/3`;
  const agent = (await call('get_agent', { agentId: 'agent_support' })).structuredContent!;
  assert.equal(agent.avatarUrl, url);
  const change = (await call('propose_agent_change', { agentId: 'agent_support', version: agent.version, change: { description: 'Billing.' } })).structuredContent!;
  assert.equal(change.agent.avatarUrl, url);
  const saved = (await call('update_agent', change.save.arguments)).structuredContent!;
  assert.equal(saved.agent.avatarUrl, url);
  assert.equal((await call('undo_change', { undoToken: saved.undoToken, idempotencyKey: 'undo' })).structuredContent!.agent.avatarUrl, url);
  assert.equal((await call('get_creation_status', { agentId: 'agent_support' })).structuredContent!.agent.avatarUrl, url);
  assert.equal((await call('check_agent', { agentId: 'agent_support' })).structuredContent!.agent.avatarUrl, url);
  const link = (await call('connect_service', { agentId: 'agent_support', service: 'Gmail', owner: 'team', idempotencyKey: 'gmail' })).structuredContent!;
  assert.equal(link.agent.avatarUrl, url);
  assert.equal((await call('get_setup_status', { setupToken: link.setup.setupToken })).structuredContent!.agent.avatarUrl, url);
});
