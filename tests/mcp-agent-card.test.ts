import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';

import { createMcpHandler } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import { isPublicAssetPath } from '../src/assets/public-assets.ts';
import { createWorkspaceManagementMcpServer } from '../src/management/mcp.ts';
import { CARD_URIS, MCP_APP_MIME_TYPE } from '../src/management/mcp-v5/cards.ts';
import { FIVE_ZERO_TOOLS } from '../src/management/mcp-v5/tools.ts';
import { agentWelcomeQuote, formatManagementSetupReceipt } from '../src/management/receipts.ts';
import type { ManagementAgentCreatedWelcome } from '../src/management/types.ts';
import { CARD_NAMES, cardAssetPath, cardVersions, RETIRED_CARD_ASSET_PATH, type CardName } from '../src/mcp-cards/published.ts';
import { PROTOCOL_VERSION } from '../src/mcp-cards/bridge.ts';
import { SLACK_SETTING_KEYS } from '../src/slack/credentials.ts';
// @ts-expect-error Build tooling JavaScript helper.
import { assetPath, buildCard, CARD_TITLES, publishCard, readPublished, saveCard, sha256 } from '../scripts/lib/mcp-cards.mjs';
import { createFixtureAgent, createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const BASE_URL = 'https://chickpea.example.test';

/**
 * The tools whose result a card draws. The Agent card: the proposal, the
 * creation, the change and its save, and every tool that can return
 * needs_confirmation, whose card is the "Are you sure?". The connect card:
 * the two tools that hand out a connection's setup link. No tool draws the
 * health card any more: check_agent reports in text, and a chat that drew
 * the card before still reads its resource and presses Check again.
 */
const CARD_TOOLS: Record<string, CardName> = {
  ...Object.fromEntries([
    'propose_agent', 'propose_agent_change', 'create_agent', 'update_agent', 'undo_change',
    'delete_agent', 'remove_connection', 'remove_website_login', 'delete_schedule', 'remove_model_provider_key', 'update_member',
  ].map((tool) => [tool, 'agent-card' as const])),
  connect_service: 'connect-card',
  reconnect_service: 'connect-card',
};

/** The card-only tools: hidden from the model, called by a card. */
const CARD_ONLY = ['get_creation_status', 'decline_change', 'get_confirmation'];

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
  /** The whole JSON-RPC answer: a result or an error. */
  const answer = async (method: string, params: Record<string, unknown> = {}) => {
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
    return JSON.parse(json) as { result?: any; error?: { code: number; message: string } };
  };
  const rpc = async (method: string, params: Record<string, unknown> = {}) => (await answer(method, params)).result;
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    await rpc('tools/call', { name, arguments: args }) as ToolResult;
  return { f, rpc, answer, call, teamId: f.owner.binding.slackTeamId };
}

async function version(call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>, agentId: string) {
  return (await call('get_agent', { agentId })).structuredContent!.version as string;
}

test('each card tool links its card; a card-only tool and every other tool do not', async (t) => {
  const { rpc } = await harness(t, 'card-meta');
  const { tools } = await rpc('tools/list') as { tools: Array<{ name: string; _meta?: Record<string, any> }> };
  for (const tool of tools) {
    const card = CARD_TOOLS[tool.name];
    const uri = card ? CARD_URIS[card] : undefined;
    assert.equal(tool._meta?.ui?.resourceUri, uri, `${tool.name}: ui.resourceUri`);
    assert.equal(tool._meta?.['openai/outputTemplate'], uri, `${tool.name}: openai/outputTemplate`);
    assert.deepEqual(tool._meta?.ui?.visibility, CARD_ONLY.includes(tool.name) ? ['app'] : undefined, `${tool.name}: visibility`);
  }
  assert.deepEqual(Object.keys(CARD_TOOLS).filter((name) => !tools.some((tool) => tool.name === name)), [], 'every card tool is listed');
  for (const card of CARD_NAMES) {
    assert.equal(CARD_URIS[card], `ui://chickpea/${card}-v${cardVersions(card).at(-1)}`, `${card} tools name its newest version`);
  }
});

test('a tool that can ask "Are you sure?" draws the Agent card, which is its confirmation', () => {
  const confirming = Object.entries(FIVE_ZERO_TOOLS)
    .filter(([, tool]) => /\breturns needs_confirmation\b/.test(tool.description))
    .map(([name]) => name);
  assert.deepEqual(confirming.sort(), [
    'delete_agent', 'delete_schedule', 'remove_connection', 'remove_model_provider_key', 'remove_website_login',
    'undo_change', 'update_agent', 'update_member',
  ]);
  for (const name of confirming) {
    assert.equal(CARD_TOOLS[name], 'agent-card', `${name} can return needs_confirmation, so it needs card: 'agent-card'`);
  }
});

test('each card resource is an MCP App that loads only Chickpea\'s own pictures and links only to Chickpea and Slack', async (t) => {
  const { rpc } = await harness(t, 'card-resource');
  const { resources } = await rpc('resources/list') as { resources: Array<Record<string, any>> };
  assert.equal(MCP_APP_MIME_TYPE, 'text/html;profile=mcp-app');
  const descriptions = new Set<string>();
  for (const name of CARD_NAMES) {
    const uri = CARD_URIS[name];
    const listed = resources.find((resource) => resource.uri === uri);
    assert.ok(listed, `resources/list names ${uri}`);
    assert.equal(listed.mimeType, 'text/html;profile=mcp-app');

    const { contents } = await rpc('resources/read', { uri }) as { contents: Array<Record<string, any>> };
    assert.equal(contents.length, 1);
    const [card] = contents;
    assert.equal(card!.mimeType, 'text/html;profile=mcp-app');
    assert.equal(card!.text, readFileSync(`assets/${cardAssetPath(name, cardVersions(name).at(-1)!)}`, 'utf8'), 'the page is the built asset');
    assert.match(card!.text, new RegExp(`^<!doctype html>[\\s\\S]*<title>${CARD_TITLES[name]}</title>`));
    for (const meta of [card!._meta, listed._meta]) {
      assert.deepEqual(meta.ui.csp, { connectDomains: [], resourceDomains: [BASE_URL] }, 'polling goes through the host; pictures come from Chickpea alone');
      assert.equal(meta.ui.prefersBorder, true);
      assert.deepEqual(meta['openai/widgetCSP'], {
        connect_domains: [],
        resource_domains: [BASE_URL],
        redirect_domains: [BASE_URL, 'https://slack.com'],
      });
    }
    descriptions.add(listed._meta['openai/widgetDescription']);
    assert.doesNotMatch(card!.text, /<(?:link|script)[^>]+(?:href|src)=/i, 'everything is inline');
  }
  assert.equal(descriptions.size, CARD_NAMES.length, 'each card tells the model what it shows');
});

type Published = Record<CardName, Array<{ version: number; sha256: string; released: boolean }>>;

test('every served card is public as inert text and served as published; only its newest may be unreleased', async (t) => {
  const { rpc, answer } = await harness(t, 'card-versions');
  const published = readPublished() as Published;
  assert.deepEqual(Object.keys(published), CARD_NAMES);
  assert.deepEqual(Object.keys(CARD_TITLES), CARD_NAMES, 'the build makes every card');
  for (const card of CARD_NAMES) {
    const versions = published[card]!;
    assert.ok(versions.length > 0, `${card} serves a version`);
    assert.ok(versions.every(({ version: v }, index) => Number.isInteger(v) && v >= 1 && (index === 0 || v === versions[index - 1]!.version + 1)),
      `${card}: served versions count up by one`);
    assert.ok(versions.every(({ released }) => typeof released === 'boolean'), `${card}: each version says whether it is released`);
    assert.ok(versions.slice(0, -1).every(({ released }) => released), `${card}: only the newest version may be unreleased`);
    assert.deepEqual(cardVersions(card), versions.map(({ version: v }) => v));
    assert.equal(new Set(versions.map(({ sha256: hash }) => hash)).size, versions.length, `${card}: no two versions share bytes`);
    for (const { version: v, sha256: hash } of versions) {
      const path = cardAssetPath(card, v);
      assert.equal(path, assetPath(card, v));
      assert.match(path, /\.txt$/, 'never an .html page on Chickpea\'s own origin');
      assert.ok(isPublicAssetPath(path), `${card} v${v}: readPublicAsset may read it`);
      const stored = readFileSync(`assets/${path}`);
      assert.equal(sha256(stored), hash, `${card} v${v} differs from published.json. Run npm run mcp-cards:build.`);
      const { contents } = await rpc('resources/read', { uri: `ui://chickpea/${card}-v${v}` }) as { contents: Array<{ text: string }> };
      assert.equal(contents[0]!.text, stored.toString('utf8'), `${card} v${v} is served`);
    }
    const latest = versions.at(-1)!;
    assert.equal(sha256(await buildCard(card, latest.version)), latest.sha256,
      `The ${card} changed since it was built. Run npm run mcp-cards:build: it rebuilds an unreleased version in place and publishes the next after a released one.`);
  }
  const { resources } = await rpc('resources/list') as { resources: Array<{ uri: string }> };
  assert.deepEqual(resources.map(({ uri }) => uri).filter((uri) => uri.startsWith('ui://chickpea/')), Object.values(CARD_URIS),
    'only the newest of each card is listed; an older or retired one is read by the URI its chat kept');
  const after = cardVersions('agent-card').at(-1)! + 1;
  const notFound = (await answer('resources/read', { uri: 'ui://chickpea/nothing-v1' })).error;
  assert.equal(typeof notFound?.code, 'number');
  for (const uri of ['ui://chickpea/agent-card-v0', 'ui://chickpea/agent-card-v01', `ui://chickpea/agent-card-v${after}`]) {
    assert.equal((await answer('resources/read', { uri })).error?.code, notFound!.code, `${uri} was never published, so it is not found`);
  }
});

test('a retired card version reads as one static card that asks the person to ask again', async (t) => {
  const { rpc } = await harness(t, 'card-retired');
  const retired = readFileSync(`assets/${RETIRED_CARD_ASSET_PATH}`, 'utf8');
  assert.ok(isPublicAssetPath(RETIRED_CARD_ASSET_PATH), 'readPublicAsset may read it');
  assert.match(RETIRED_CARD_ASSET_PATH, /\.txt$/, 'never an .html page on Chickpea\'s own origin');
  assert.match(retired, /^<!doctype html>/);
  assert.equal(retired.match(/<p>([^<]*)<\/p>/)?.[1], 'This card is from an older version of Chickpea. Ask again to see it.');
  assert.doesNotMatch(retired, /<(?:script|button|a|form|input|img|link|iframe)\b|\bon\w+=|url\(/i, 'no buttons, calls, links, pictures or loads');
  for (const card of CARD_NAMES) {
    const oldest = cardVersions(card)[0]!;
    // Agent card v1 to v11, connect card v1 to v9 and health card v1 to v6 never reached a production chat.
    assert.ok(oldest > 1, `${card} has retired versions`);
    for (const v of [1, oldest - 1]) {
      const uri = `ui://chickpea/${card}-v${v}`;
      const { contents } = await rpc('resources/read', { uri }) as { contents: Array<Record<string, any>> };
      assert.equal(contents.length, 1);
      assert.equal(contents[0]!.uri, uri);
      assert.equal(contents[0]!.mimeType, MCP_APP_MIME_TYPE);
      assert.equal(contents[0]!.text, retired, `${uri} is retired`);
    }
  }
});

test('the build rebuilds an unreleased newest version in place, and publishes the next after a released one', async (t) => {
  const changed = async (card: string, v: number) => `${await buildCard(card, v)}<!-- changed -->\n`;
  const before = readPublished() as Published;
  const newest = before['connect-card'].at(-1)!;

  // Unreleased: the same version, its new bytes, still unreleased; nothing else moves.
  const unreleased = { ...before, 'connect-card': [...before['connect-card'].slice(0, -1), { ...newest, released: false }] };
  const inPlace = await publishCard('connect-card', { published: unreleased, build: changed });
  assert.equal(inPlace.version, newest.version);
  assert.deepEqual(inPlace.published, {
    ...unreleased,
    'connect-card': [...before['connect-card'].slice(0, -1), { version: newest.version, sha256: sha256(inPlace.html), released: false }],
  });
  assert.notEqual(sha256(inPlace.html), newest.sha256);

  // Unchanged: nothing to write, released or not.
  const same = await publishCard('connect-card', { published: unreleased });
  assert.equal(same.version, newest.version);
  assert.equal(same.published, unreleased);

  // Released: the next version, unreleased, after the released one, which stays.
  const released = { ...before, 'connect-card': [...before['connect-card'].slice(0, -1), { ...newest, released: true }] };
  const next = await publishCard('connect-card', { published: released, build: changed });
  assert.equal(next.version, newest.version + 1);
  assert.deepEqual(next.published['connect-card'], [...released['connect-card'], { version: next.version, sha256: sha256(next.html), released: false }]);
  assert.deepEqual(Object.keys(next.published), CARD_NAMES);

  // That release, served: tools name the next version, and a chat drawn with the released one still gets it.
  const release = mkdtempSync(join(tmpdir(), 'card-release-'));
  t.after(() => rmSync(release, { recursive: true, force: true }));
  cpSync('assets/mcp-cards', join(release, 'assets', 'mcp-cards'), { recursive: true });
  saveCard(next, { assets: join(release, 'assets'), publishedPath: join(release, 'published.json') });
  for (const card of CARD_NAMES) {
    for (const { version: v } of before[card]) {
      assert.deepEqual(readFileSync(join(release, 'assets', assetPath(card, v))), readFileSync(`assets/${assetPath(card, v)}`), `${card} v${v} stays as it was`);
    }
  }

  const output = execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), resolve('tests/helpers/card-release.ts')], {
    cwd: release,
    env: { ...process.env, PUBLISHED_JSON: join(release, 'published.json') },
    encoding: 'utf8',
    // Every card's page goes through stdout; three at once outgrow the default 1 MiB.
    maxBuffer: 64 * 1024 * 1024,
  });
  const { toolsName, allowlisted, listed, served } = JSON.parse(output) as {
    toolsName: Record<string, string>; allowlisted: string[]; listed: string[]; served: Record<string, string>;
  };
  assert.deepEqual(toolsName, { ...CARD_URIS, 'connect-card': `ui://chickpea/connect-card-v${next.version}` }, 'tools name the newest of each card');
  assert.deepEqual(listed, Object.values(toolsName), 'the resource list names only the newest of each card');
  const all = CARD_NAMES.flatMap((card) => [
    ...before[card].map(({ version: v }) => ({ card, v, text: readFileSync(`assets/${assetPath(card, v)}`, 'utf8') })),
    ...card === 'connect-card' ? [{ card, v: next.version, text: next.html }] : [],
  ]);
  assert.deepEqual(allowlisted, all.map(({ card, v }) => assetPath(card, v)));
  assert.deepEqual(served, Object.fromEntries(all.map(({ card, v, text }) => [`ui://chickpea/${card}-v${v}`, text])), 'every version serves its own bytes');
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
  // A Channel whose name Chickpea does not have is named in words, never by its ID.
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C0PRIVATE1', lifecycle: 'active' });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C0PRIVATE1', agentId: 'agent_support', status: 'active',
    createdByMembershipId: f.owner.membership.id,
  });
  const off = await call('update_agent', {
    agentId: 'agent_support', version: await version(call, 'agent_support'), on: false, idempotencyKey: 'off',
  });
  const { ask, preview } = off.structuredContent!.confirmation;
  const handle = off.structuredContent!.agent.handle;
  assert.deepEqual(ask, {
    question: `Turn off @${handle}?`,
    consequence: 'It answers in #support and a private Channel. People who mention it there get no reply until you turn it back on. Its instructions, memory and connections stay as they are.',
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

test('a removal asks in the words of its preview, with buttons that say what they do', async (t) => {
  const { call } = await harness(t, 'card-member');
  const [admin] = (await call('list_members')).structuredContent!.members.filter(({ role }: { role: string }) => role === 'admin');
  const suspend = await call('update_member', { slackUserId: admin.slackUserId, status: 'suspended', idempotencyKey: 'suspend' });
  assert.equal(suspend._meta?.['chickpea/tool'], 'update_member');
  const { ask } = suspend.structuredContent!.confirmation;
  assert.deepEqual([ask.question, ask.confirm, ask.keep], [`Suspend ${admin.name}?`, 'Suspend', 'Keep their access']);
  assert.equal(ask.consequence, `Suspend ${admin.name}’s Chickpea access. They can’t use Agents or sign in until an Owner restores it.`);
});
