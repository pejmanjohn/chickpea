import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';

import { createMcpHandler } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import { isPublicAssetPath } from '../src/assets/public-assets.ts';
import { createWorkspaceManagementMcpServer } from '../src/management/mcp.ts';
import { AGENT_CARD_URI, MCP_APP_MIME_TYPE } from '../src/management/mcp-v5/cards.ts';
import { FIVE_ZERO_TOOLS } from '../src/management/mcp-v5/tools.ts';
import { agentWelcomeQuote, formatManagementSetupReceipt } from '../src/management/receipts.ts';
import type { ManagementAgentCreatedWelcome } from '../src/management/types.ts';
import { AGENT_CARD_ASSET_PATH, AGENT_CARD_VERSION } from '../src/mcp-cards/agent-card/published.ts';
import { PROTOCOL_VERSION } from '../src/mcp-cards/bridge.ts';
import { SLACK_SETTING_KEYS } from '../src/slack/credentials.ts';
// @ts-expect-error Build tooling JavaScript helper.
import { assetPath, buildAgentCard, readPublished, sha256 } from '../scripts/lib/mcp-cards.mjs';
import { createFixtureAgent, createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const BASE_URL = 'https://chickpea.example.test';

/**
 * The tools whose result the Agent card draws: the proposal, the creation,
 * the change and its save, and every tool that can return
 * needs_confirmation, whose card is the "Are you sure?".
 */
const CARD_TOOLS = ['propose_agent', 'propose_agent_change', 'create_agent', 'update_agent', 'undo_change'];

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, any>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

async function harness(t: TestContext, suffix: string, teamName?: string) {
  const f = await createManagementAdapterFixture(suffix, ({ settings }) => ({ settings }));
  t.after(() => f.close());
  if (teamName) await f.settings.setSetting(SLACK_SETTING_KEYS.teamName, teamName);
  const principal: McpAuthenticatedPrincipal = {
    betterAuthUserId: f.owner.binding.betterAuthUserId ?? 'ba_owner',
    userId: f.owner.user.id,
    membershipId: f.owner.membership.id,
    organizationId: f.owner.membership.organizationId,
    role: 'owner',
    clientId: `client_${suffix}`,
  };
  const handler = createMcpHandler(
    () => createWorkspaceManagementMcpServer({ principal, service: f.service, baseUrl: BASE_URL }),
    { legacy: 'stateless' },
  );
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }));
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const json = body.trimStart().startsWith('{')
      ? body
      : body.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length);
    return (JSON.parse(json) as { result: any }).result;
  };
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    await rpc('tools/call', { name, arguments: args }) as ToolResult;
  return { f, rpc, call, teamId: f.owner.binding.slackTeamId };
}

async function version(call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>, agentId: string) {
  return (await call('get_agent', { agentId })).structuredContent!.version as string;
}

test('the card tools link the Agent card; a card-only tool and every other tool do not', async (t) => {
  const { rpc } = await harness(t, 'card-meta');
  const { tools } = await rpc('tools/list') as { tools: Array<{ name: string; _meta?: Record<string, any> }> };
  for (const tool of tools) {
    const card = CARD_TOOLS.includes(tool.name);
    assert.equal(tool._meta?.ui?.resourceUri, card ? AGENT_CARD_URI : undefined, `${tool.name}: ui.resourceUri`);
    assert.equal(tool._meta?.['openai/outputTemplate'], card ? AGENT_CARD_URI : undefined, `${tool.name}: openai/outputTemplate`);
  }
  const status = tools.find(({ name }) => name === 'get_creation_status')!;
  assert.deepEqual(status._meta?.ui, { visibility: ['app'] }, 'the poll is for the card only');
  assert.equal(AGENT_CARD_URI, `ui://chickpea/agent-card-v${AGENT_CARD_VERSION}`);
});

test('a tool that can ask "Are you sure?" draws the card, which is its confirmation', () => {
  const confirming = Object.entries(FIVE_ZERO_TOOLS)
    .filter(([, tool]) => /\breturns needs_confirmation\b/.test(tool.description))
    .map(([name]) => name);
  assert.deepEqual(confirming.sort(), ['undo_change', 'update_agent']);
  for (const name of confirming) {
    assert.ok(CARD_TOOLS.includes(name), `${name} can return needs_confirmation, so it needs card: true`);
  }
});

test('the card resource is an MCP App that reaches nothing and links only to Chickpea and Slack', async (t) => {
  const { rpc } = await harness(t, 'card-resource');
  const { resources } = await rpc('resources/list') as { resources: Array<Record<string, any>> };
  const listed = resources.find(({ uri }) => uri === AGENT_CARD_URI);
  assert.ok(listed, 'resources/list names the card');
  assert.equal(listed.mimeType, 'text/html;profile=mcp-app');
  assert.equal(MCP_APP_MIME_TYPE, 'text/html;profile=mcp-app');

  const { contents } = await rpc('resources/read', { uri: AGENT_CARD_URI }) as { contents: Array<Record<string, any>> };
  assert.equal(contents.length, 1);
  const [card] = contents;
  assert.equal(card!.mimeType, 'text/html;profile=mcp-app');
  assert.equal(card!.text, readFileSync(`assets/${AGENT_CARD_ASSET_PATH}`, 'utf8'), 'the page is the built asset');
  assert.match(card!.text, /^<!doctype html>/);
  for (const meta of [card!._meta, listed._meta]) {
    assert.deepEqual(meta.ui.csp, { connectDomains: [], resourceDomains: [] }, 'polling goes through the host');
    assert.equal(meta.ui.prefersBorder, true);
    assert.deepEqual(meta['openai/widgetCSP'], {
      connect_domains: [],
      resource_domains: [],
      redirect_domains: [BASE_URL, 'https://slack.com'],
    });
  }
  assert.doesNotMatch(card!.text, /<(?:link|script)[^>]+(?:href|src)=/i, 'everything is inline');
});

test('the built card is public as inert text, and its URI changes whenever its bytes do', async () => {
  assert.ok(isPublicAssetPath(AGENT_CARD_ASSET_PATH), 'readPublicAsset may read it');
  assert.match(AGENT_CARD_ASSET_PATH, /\.txt$/, 'never an .html page on Chickpea\'s own origin');

  const published = readPublished() as Array<{ version: number; sha256: string }>;
  assert.deepEqual(published.map(({ version: v }) => v), published.map((_, index) => index + 1), 'versions count up from 1');
  assert.equal(new Set(published.map(({ sha256: hash }) => hash)).size, published.length, 'no two versions share bytes');
  const latest = published.at(-1)!;
  assert.equal(latest.version, AGENT_CARD_VERSION);
  assert.equal(assetPath(latest.version), AGENT_CARD_ASSET_PATH);

  const built = await buildAgentCard(latest.version);
  assert.equal(sha256(built), latest.sha256,
    'The Agent card changed since it was published. Run npm run mcp-cards:build: it publishes the next version.');
  assert.equal(readFileSync(`assets/${AGENT_CARD_ASSET_PATH}`, 'utf8'), built, 'the committed card is the build');
});

test('a card tool\'s result names its tool for the card and keeps its whole result in the text', async (t) => {
  const { call } = await harness(t, 'card-text', 'Acme');
  const proposal = await call('propose_agent', {
    name: 'Invoice Chaser',
    handle: 'invoices',
    job: 'Chases overdue invoices.',
    instructions: '# Job\nChase invoices.',
    sampleAsk: 'who is overdue?',
    promisedAnswer: 'Three invoices are overdue.',
  });
  assert.equal(proposal._meta?.['chickpea/tool'], 'propose_agent');
  assert.deepEqual(JSON.parse(proposal.content[0]!.text), proposal.structuredContent, 'a client without cards gets it all');
  assert.equal(proposal.structuredContent!.proposal.workspaceName, 'Acme');

  const created = await call('create_agent', proposal.structuredContent!.create.arguments);
  assert.equal(created._meta?.['chickpea/tool'], 'create_agent');
  assert.deepEqual(JSON.parse(created.content[0]!.text), created.structuredContent);

  const read = await call('get_agent', { agentId: created.structuredContent!.agent.agentId });
  assert.equal(read._meta, undefined, 'a tool without the card says nothing extra');
});

test('turning off an Agent asks in plain words, naming the Channels that go quiet', async (t) => {
  const { f, call, teamId } = await harness(t, 'card-ask');
  await createFixtureAgent(f, 'agent_support');
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_SUPPORT', label: 'support', lifecycle: 'active' });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C_SUPPORT', agentId: 'agent_support', status: 'active',
    createdByMembershipId: f.owner.membership.id, channelLabel: 'support',
  });
  const off = await call('update_agent', {
    agentId: 'agent_support', version: await version(call, 'agent_support'), on: false, idempotencyKey: 'off',
  });
  const { ask, preview } = off.structuredContent!.confirmation;
  const handle = off.structuredContent!.agent.handle;
  assert.deepEqual(ask, {
    question: `Turn off @${handle}?`,
    consequence: 'It answers in #support. People who mention it there get no reply until you turn it back on. Its instructions, memory and connections stay as they are.',
    confirm: 'Turn off',
    keep: 'Keep it on',
  });
  assert.ok(preview.length > 0, 'the preview stays for clients without cards');
  assert.equal((await f.config.getAgent('agent_support')).enabled, true, 'asking changes nothing');

  // Undoing "turn on" turns it off again: that confirmation names the Agent too.
  await call('confirm_change', { confirmToken: off.structuredContent!.confirmation.confirmToken });
  const on = await call('update_agent', {
    agentId: 'agent_support', version: await version(call, 'agent_support'), on: true, idempotencyKey: 'on',
  });
  const reverse = await call('undo_change', { undoToken: on.structuredContent!.undoToken, idempotencyKey: 'undo-on' });
  assert.equal(reverse.structuredContent!.status, 'needs_confirmation');
  assert.equal(reverse.structuredContent!.agent.agentId, 'agent_support');
  assert.equal(reverse.structuredContent!.confirmation.ask.question, `Turn off @${handle}?`);
});

test('the card quotes the hello an Agent posts in its own name, in the same words', () => {
  const receipt: ManagementAgentCreatedWelcome = {
    kind: 'agent_created_welcome',
    agentId: 'agent_invoices',
    agentName: 'Invoice Chaser',
    agentHandle: 'invoices',
    agentDescription: 'Chases invoices more than 30 days overdue.',
    requesterMembershipId: 'membership_1',
    surface: 'direct',
    persona: { name: 'Invoice Chaser' },
    firstAsk: 'who is overdue this week?',
  };
  const quote = agentWelcomeQuote(receipt)!;
  assert.equal(quote, 'Hi — I’m Invoice Chaser (@invoices). Chases invoices more than 30 days overdue.\n\nTry asking me: “who is overdue this week?”');
  const posted = formatManagementSetupReceipt(receipt).replaceAll('*', '');
  for (const paragraph of quote.split('\n\n')) assert.ok(posted.includes(paragraph), `Slack says: ${paragraph}`);
  assert.equal(agentWelcomeQuote({ ...receipt, publication: { status: 'partial', incomplete: ['slack_presence'] } }), undefined,
    'Chickpea posts in its place, in other words');
});

test('the card speaks the MCP Apps version of the ext-apps release it is pinned to', async () => {
  // ext-apps' declarations re-export without file extensions, which NodeNext cannot follow.
  const extApps = await import('@modelcontextprotocol/ext-apps') as unknown as { LATEST_PROTOCOL_VERSION: string };
  assert.equal(PROTOCOL_VERSION, extApps.LATEST_PROTOCOL_VERSION);
});
