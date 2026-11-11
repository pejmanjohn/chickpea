#!/usr/bin/env node
/**
 * Renders the ChatGPT cards the way ChatGPT hosts them, against Core's real
 * MCP server on a fixture workspace, and drives them in Chrome: every state in
 * light and dark, 728 and 390 px wide, in ChatGPT and in a host like
 * claude.ai. Saves one screenshot per state and checks that a destructive
 * confirmation, a setup link and a fix each wait for the click, and that
 * the card tells the host's model what each press did.
 *
 *   npm run mcp-cards:harness -- --out <dir> [--chrome <path>]
 *
 * Nothing here touches Slack, ChatGPT or a deployment.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { build } from 'esbuild';

import { workspaceManagementMcpFetch } from '../src/management/mcp.ts';
import { CARD_URIS } from '../src/management/mcp-v5/cards.ts';
import { readAgentAvatarAsset } from '../src/slack/agent-presence/avatar-assets.ts';
import { SLACK_SETTING_KEYS } from '../src/slack/credentials.ts';
import { createFixtureAgent, createManagementAdapterFixture } from '../tests/helpers/management-adapter-fixture.ts';
import { StubTestRuns } from '../tests/helpers/stub-test-runs.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** This deployment's origin, which serves every Agent's picture; Chrome's requests to it are answered from the fixture. */
const ORIGIN = 'https://app.chickpea.example';
const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: join(tmpdir(), 'chickpea-card-screens') },
    chrome: { type: 'string', default: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  },
});
const OUT = resolve(args.out);
mkdirSync(OUT, { recursive: true });

const STYLES = JSON.parse(readFileSync(join(HERE, 'mcp-card-harness', 'chatgpt-host-styles.json'), 'utf8'));
const HOST_SCRIPT = (await build({
  entryPoints: [join(HERE, 'mcp-card-harness', 'host.mjs')],
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent',
})).outputFiles[0].text;

const FRAME_STYLE = `
  :root { color-scheme: light; --bg: #fff; --fg: #0d0d0d; --muted: #5d5d5d; --line: #e5e5e5; }
  :root[data-theme="dark"] { color-scheme: dark; --bg: rgb(14 14 14); --fg: rgb(237 237 237); --muted: rgb(205 205 205); --line: rgb(255 255 255 / 15%); }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 13px -apple-system, system-ui, sans-serif; }
  #shot { display: inline-block; }
  .app { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; color: var(--muted); }
  .app i { width: 16px; height: 16px; border-radius: 5px; background: #e8901a; }
  #frame { border: 1px solid var(--line); border-radius: 20px; overflow: hidden; }
  iframe { display: block; width: 100%; height: 120px; border: 0; }`;

/** A first answer, as an Agent writes one: Markdown, which the card reads as plain text. */
const ANSWERED = {
  status: 'answered',
  failure: null,
  result: {
    reply: '**Two renewals** are due this month:\n- Northwind: renews on the 18th, $9,800 a year *(Stripe)*\n- [Lumen Labs](https://dashboard.stripe.com/subscriptions/x): renews on the 27th, $7,400 a year *(Stripe)*\n\nNeither has a reminder yet.',
    read: ['Stripe', 'HubSpot'],
  },
};
const RUNNING = { status: 'running', failure: null, result: null };

/** One fixture workspace with Core's MCP server; each run of the scenes gets its own. */
async function world() {
  const clock = { now: Date.now() };
  // The state store's test runs, which only a deployment of many installations serves.
  const runs = new StubTestRuns(ANSWERED);
  const f = await createManagementAdapterFixture(`harness_${Math.random().toString(36).slice(2, 8)}`,
    ({ settings }) => ({
      settings,
      now: () => clock.now,
      setupBaseUrl: ORIGIN,
      testRuns: runs,
      slackMemberTimezone: async () => 'America/Los_Angeles',
      modelReadiness: async () => async () => undefined,
      // A custom connection's one request: the docs server refuses its key, the status board answers.
      testConnection: async ({ connectionId }) => connectionId === 'connection_docs'
        ? { kind: 'key_rejected', status: 401, detail: 'Unauthorized' }
        : { kind: 'ok', url: 'https://api.statusboard.example/v1/me', status: 200 },
    }));
  // What the setup page reports when the person finishes there.
  const finished = new Map();
  const getOperation = f.service.getOperation.bind(f.service);
  f.service.getOperation = async (context, id) => {
    const result = await getOperation(context, id);
    return finished.has(id) && result && 'setupOperationId' in result ? { ...result, status: finished.get(id) } : result;
  };
  // A deployment that serves no test runs: Node, or one installation alone.
  let serving = true;
  const testRunStore = f.service.testRunStore.bind(f.service);
  f.service.testRunStore = async (context) => serving ? testRunStore(context) : undefined;
  await f.settings.setSetting(SLACK_SETTING_KEYS.teamName, 'Acme');
  const teamId = f.owner.binding.slackTeamId;
  const principal = {
    betterAuthUserId: f.owner.binding.betterAuthUserId ?? 'ba_owner',
    userId: f.owner.user.id,
    membershipId: f.owner.membership.id,
    organizationId: f.owner.membership.organizationId,
    role: 'owner',
    clientId: 'client_harness',
  };
  // ChatGPT's own door: it declares cards at initialize, so its model never sees a card's tokens.
  const fetchMcp = workspaceManagementMcpFetch({ principal, service: f.service, baseUrl: ORIGIN });
  const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' };
  const post = (body, session) => {
    const text = JSON.stringify({ jsonrpc: '2.0', id: 1, ...body });
    return fetchMcp(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { ...headers, 'content-length': String(Buffer.byteLength(text)), ...session ? { 'mcp-session-id': session } : {} },
      body: text,
    }));
  };
  const session = (await post({
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } }, clientInfo: { name: 'openai-mcp', version: '1.0.0' } },
  })).headers.get('mcp-session-id');
  assert.ok(session, 'a client that draws cards gets a session');
  const rpc = async (method, params) => {
    const body = await (await post({ method, params }, session)).text();
    return JSON.parse(body.trimStart().startsWith('{') ? body : body.split('\n').find((line) => line.startsWith('data: ')).slice(6)).result;
  };
  const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });
  const version = async (agentId) => (await call('get_agent', { agentId })).structuredContent.version;

  // An installed Slack app, so results carry Slack's web link to it.
  const installation = await f.config.ensureWorkspaceInstallation({ workspaceId: teamId, transportMode: 'gateway', teamId, appId: 'A0CHICKPEA' });
  await f.config.updateWorkspaceInstallation(teamId, { appId: 'A0CHICKPEA' }, installation.revision);
  for (const [channelId, label] of [['C_FINANCE', 'finance'], ['C_SUPPORT', 'support'], ['C_BILLING', 'billing']]) {
    await f.config.putChannel({ workspaceId: teamId, channelId, label, lifecycle: 'active' });
  }
  await createFixtureAgent(f, 'agent_support', {
    name: 'Support Desk',
    slackPresence: { requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy', avatar: { kind: 'generated', revision: 1, seed: 'support' } },
  });
  for (const channelId of ['C_SUPPORT', 'C_BILLING']) {
    await f.config.putAgentChannelGrant({ workspaceId: teamId, channelId, agentId: 'agent_support', status: 'active', createdByMembershipId: f.owner.membership.id });
  }

  const created = () => f.config.getAgent('agent_invoice_chaser');
  const scenes = {
    proposal: () => call('propose_agent', {
      name: 'Invoice Chaser',
      handle: 'invoices',
      job: 'Chases invoices more than 30 days overdue and posts a summary in #finance every Monday.',
      instructions: '# Job\nChase invoices more than 30 days overdue.\n\n## Tone\nBe brief and polite.',
      sampleAsk: 'who\'s overdue this week?',
      promisedAnswer: 'Overdue this week —\n• Acme Co: $4,200, 41 days, reminded twice\n• Birch Ltd: $860, 33 days\nEach is linked in Stripe.',
      services: ['Stripe'],
      channels: ['#finance'],
    }),
    // A question with a list pasted in, and a reply too long for the card: each shows its start.
    proposalLong: () => call('propose_agent', {
      name: 'Churn Watch',
      handle: 'churn',
      job: 'Flags customers who may not renew, from their invoices and email.',
      instructions: '# Job\nFlag customers who may not renew.',
      sampleAsk: 'Which of these renew before the quarter ends?\nNorthwind, Lumen Labs, Birch Ltd, Acme Co\nHas anyone talked to them since their last renewal?',
      promisedAnswer: 'Three of the four renew before the quarter ends.\n\n' +
        'Northwind renews on the 18th. Dana last emailed them 41 days ago, and they have not opened the last two invoice emails.\n' +
        'Lumen Labs renews on the 27th. Nobody has written to them since their last renewal, a year ago.\n' +
        'Birch Ltd renews on the 30th. Sam had a call with them last week; the notes are in HubSpot.\n' +
        'Acme Co renews next quarter, so I left it out.\n\nI would start with Lumen Labs.',
      channels: ['#finance', '#billing'],
    }),
    // A proposal without its example, as an older or hand-made result may come: its job shows instead.
    proposalBare: async () => {
      const result = await scenes.proposalLong();
      const { sampleExchange: _example, ...proposal } = result.structuredContent.proposal;
      return { ...result, structuredContent: { ...result.structuredContent, proposal } };
    },
    // Support Desk already has @support: the handle says so, and Create finds the Agent like it.
    proposalTaken: () => call('propose_agent', {
      name: 'Support Triage',
      handle: 'support',
      job: 'Sorts new support requests by product and urgency.',
      instructions: '# Job\nSort support requests.',
      sampleAsk: 'what came in overnight?',
      promisedAnswer: 'Six requests came in overnight: two urgent billing questions and four about the mobile app.',
    }),
    change: async () => {
      const agent = (await call('get_agent', { agentId: 'agent_invoice_chaser' })).structuredContent;
      return call('propose_agent_change', {
        agentId: agent.agentId,
        version: agent.version,
        change: {
          instructions: agent.instructions.replace('Be brief and polite.', 'Be brief and polite. Keep each message under three sentences, and open with the customer\'s name.'),
          description: 'Chases invoices more than 30 days overdue and posts a summary in #finance every Monday and Thursday.',
        },
      });
    },
    confirm: async () => {
      await f.config.updateAgent('agent_support', { enabled: true });
      return call('update_agent', { agentId: 'agent_support', version: await version('agent_support'), on: false, idempotencyKey: `off-${clock.now}-${Math.random()}` });
    },
    // A host that left the result's _meta behind: the card has no token.
    confirmBare: async () => {
      const { _meta: _held, ...bare } = await scenes.confirm();
      return bare;
    },
    // ChatGPT keeps the _meta for the card in window.openai.toolResponseMetadata instead.
    confirmMetaElsewhere: async () => {
      const { _meta, ...bare } = await scenes.confirm();
      return { ...bare, [OPENAI_META]: _meta };
    },
    turnedOff: async () => call('update_agent', { agentId: 'agent_dm', version: await version('agent_dm'), on: false, idempotencyKey: `dm-off-${Math.random()}` }),
    savedDm: async () => {
      await f.config.updateAgent('agent_dm', { enabled: true });
      return call('update_agent', { agentId: 'agent_dm', version: await version('agent_dm'), description: `Answers HR questions in DMs (${Math.random()}).`, idempotencyKey: `dm-save-${Math.random()}` });
    },
    expired: async () => {
      const at = clock.now;
      clock.now = Date.now() - 31 * 60_000;
      try {
        await f.config.updateAgent('agent_support', { enabled: true });
        return await call('update_agent', { agentId: 'agent_support', version: await version('agent_support'), on: false, idempotencyKey: `stale-${at}` });
      } finally {
        clock.now = at;
      }
    },
  };
  // The connect card: a link for one service, one to sign one in again, one cancelled, and a custom API.
  let lastSetup;
  const link = async (args) => {
    const result = await call('connect_service', { agentId: 'agent_support', ...args, idempotencyKey: `${args.service ?? 'custom'}-${Math.random()}` });
    lastSetup = result.structuredContent.setup;
    return result;
  };
  const account = async (id, fields) => {
    const stored = await f.config.putConnectionAccount({
      id, workspaceId: teamId, ownerKind: 'team', createdByMembershipId: f.owner.membership.id, secretRefId: `secret_${id}`, ...fields,
    });
    await f.config.putAgentConnectionBinding({ agentId: 'agent_support', connectionAccountId: id, providerId: fields.providerId, allowedCapabilities: [], enabled: true });
    return stored;
  };
  const api = (host) => ({ kind: 'api', allowedHosts: [host], pathPrefixes: ['/v1'], headerName: 'Authorization', allowedMethods: ['GET'], authMode: 'credential' });
  let seeded = false;
  /** The health card's Agent: Notion needs signing in again, and a docs server refuses its key. */
  async function seedHealth() {
    if (seeded) return;
    seeded = true;
    await account('connection_notion', {
      providerId: 'notion', label: 'Notion', lifecycle: 'needs_attention',
      policy: { kind: 'managed', adapterId: 'composio', toolkit: 'notion', principalRef: 'chickpea:team', accountRef: 'account_notion', allowedCapabilities: ['notion.read'] },
    });
    await account('connection_docs', {
      providerId: 'docs', label: 'Help center', lifecycle: 'ready',
      policy: { kind: 'mcp', url: 'https://mcp.help.example/mcp', transport: 'streamable-http', authMode: 'bearer', headerNames: [], allowedTools: ['search'], discoveredTools: [{ name: 'search' }] },
    });
  }
  Object.assign(scenes, {
    connect: () => link({ service: 'Gmail', owner: 'team' }),
    // A link whose page lets the person choose Personal or Team: the server names no owner.
    connectChoose: async () => {
      const result = await link({ service: 'Notion', owner: 'me' });
      const { owner: _owner, ...setup } = result.structuredContent.setup;
      return { ...result, structuredContent: { ...result.structuredContent, setup } };
    },
    reconnect: async () => {
      await seedHealth();
      return call('reconnect_service', { agentId: 'agent_support', connectionId: 'connection_notion' });
    },
    cancelled: async () => {
      const result = await link({ service: 'Gmail', owner: 'me' });
      await call('cancel_setup_link', { setupToken: lastSetup.setupToken });
      return result;
    },
    custom: async () => {
      const result = await link({ custom: { kind: 'api', name: 'Status board', hosts: ['api.statusboard.example'], pathPrefixes: ['/v1'] }, checkPath: '/v1/me', version: await version('agent_support') });
      const added = (await f.config.listConnectionAccounts(teamId)).find(({ label }) => label === 'Status board');
      await f.config.putConnectionAccount({ ...added, lifecycle: 'ready' }, added.revision);
      return result;
    },
    health: async () => {
      await seedHealth();
      return call('check_agent', { agentId: 'agent_support' });
    },
    healthy: () => call('check_agent', { agentId: 'agent_clean' }),
    // Scene 4: an Agent with nothing to connect, so its ready card offers its first answer.
    firstProposal: () => call('propose_agent', {
      name: 'Renewals Desk',
      handle: 'renewals',
      job: 'Tracks the contracts that renew in the next 60 days.',
      instructions: '# Job\nTrack contract renewals.',
      sampleAsk: 'which renewals are due this month?',
      promisedAnswer: 'I list each contract that renews this month, with the customer, the date and the amount, each linked in Stripe.',
    }),
    connectRenewals: () => link({ agentId: 'agent_renewals_desk', service: 'Gmail', owner: 'team' }),
    // Agents the model created itself, each with a first question: their cards hold no promise.
    readyQuiet: () => arrived.agent_quiet_desk,
    readySetup: () => arrived.agent_linear_helper,
    readyDocs: () => arrived.agent_docs_helper,
  });
  /** What Slack does after create_agent: each Agent joins with a model that runs, and its hello is delivered. */
  async function arrive(...agentIds) {
    for (const agentId of agentIds) {
      const agent = await f.config.getAgent(agentId);
      await f.config.updateAgent(agentId, { model: 'local-stub/desk', slackPresence: { ...agent.slackPresence, health: 'healthy' } });
    }
    const claimed = await f.management.claimDueOutbox(clock.now, 50, clock.now + 60_000);
    // As sayHello does: the hello the Agent posted in its own name, delivered.
    const hellos = claimed.filter(({ receipt }) => receipt.kind === 'agent_created_welcome' && agentIds.includes(receipt.agentId)).map((queued) => ({
      ...queued,
      outboxId: `${queued.outboxId}_published`,
      receipt: { ...queued.receipt, publication: { status: 'complete', incomplete: [] } },
      status: 'pending',
      createdAt: clock.now + 1,
      updatedAt: clock.now + 1,
      nextAttemptAt: clock.now,
    }));
    for (const hello of hellos) await f.management.putOutbox(hello);
    await f.management.claimDueOutbox(clock.now, 50, clock.now + 60_000);
    for (const hello of hellos) {
      await f.management.settleOutbox({ outboxId: hello.outboxId, outcome: 'delivered', at: clock.now, deliveryRef: `D1:${hello.outboxId}` });
    }
  }
  const arrived = {};
  for (const [name, handle, firstAsk] of [
    ['Quiet Desk', 'quiet', 'what changed in the queue today?'],
    ['Linear Helper', 'linear-helper', 'which issues are blocked?'],
    ['Docs Helper', 'docs-helper', 'where is the refund policy?'],
  ]) {
    const result = await call('create_agent', { name, handle, instructions: 'Answer briefly.', firstAsk, idempotencyKey: `create-${handle}` });
    arrived[result.structuredContent.agent.agentId] = result;
  }
  await arrive(...Object.keys(arrived));
  // Linear is someone else's own account, which the caller has yet to sign in to; the docs server allows no tools yet, so only Admin can fix it.
  for (const [agentId, account] of [
    ['agent_linear_helper', {
      id: 'connection_linear_admin', providerId: 'linear', label: 'Linear', ownerKind: 'member', ownerMembershipId: f.admin.membership.id,
      createdByMembershipId: f.admin.membership.id, lifecycle: 'ready',
      policy: { kind: 'api', allowedHosts: ['api.linear.app'], pathPrefixes: ['/'], headerName: 'Authorization', allowedMethods: ['GET'], authMode: 'credential' },
    }],
    ['agent_docs_helper', {
      id: 'connection_docs_helper', providerId: 'docs', label: 'Help center', ownerKind: 'team', createdByMembershipId: f.owner.membership.id,
      lifecycle: 'ready',
      policy: { kind: 'mcp', url: 'https://mcp.help.example/mcp', transport: 'streamable-http', authMode: 'bearer', headerNames: [], allowedTools: [], discoveredTools: [{ name: 'search' }] },
    }],
  ]) {
    await f.config.putConnectionAccount({ workspaceId: teamId, secretRefId: `secret_${account.id}`, ...account });
    await f.config.putAgentConnectionBinding({ agentId, connectionAccountId: account.id, providerId: account.providerId, allowedCapabilities: [], enabled: true });
  }
  await createFixtureAgent(f, 'agent_clean', {
    name: 'Billing Helper',
    model: 'local-stub/billing',
    slackPresence: { requestedHandle: 'billing', normalizedHandle: 'billing', desiredState: 'active', health: 'healthy', avatar: { kind: 'generated', revision: 1, seed: 'billing' } },
  });
  await f.config.putAgentChannelGrant({ workspaceId: teamId, channelId: 'C_FINANCE', agentId: 'agent_clean', status: 'active', createdByMembershipId: f.owner.membership.id, channelIsPrivate: false });
  // An Agent that answers only in DMs, wearing one of the default pictures.
  await createFixtureAgent(f, 'agent_dm', {
    name: 'People Helper',
    slackPresence: { requestedHandle: 'people', normalizedHandle: 'people', desiredState: 'active', health: 'healthy', avatar: { kind: 'generated', revision: 1, seed: 'chickpea-avatar-v1:06:people' } },
  });

  /**
   * What this deployment's origin serves Chrome: the default pictures, and
   * each Agent's avatar as the avatar route reads it. Billing Helper's fails,
   * so its card shows the art instead.
   */
  async function picture(url) {
    const { pathname } = new URL(url);
    if (pathname.startsWith('/chickpea-avatars/agent-defaults/')) return readFileSync(join(HERE, '..', 'assets', pathname.slice(1)));
    const match = /^\/assets\/agents\/([^/]+)\/avatar\/(\d+)$/.exec(pathname);
    if (!match || match[1] === 'agent_clean') return undefined;
    const agent = await f.config.getAgent(decodeURIComponent(match[1])).catch(() => undefined);
    if (!agent) return undefined;
    const asset = await readAgentAvatarAsset({ settings: f.settings, agentId: agent.id, revision: Number(match[2]), avatar: agent.slackPresence?.avatar });
    return asset && Buffer.from(asset.bytes);
  }

  /** Its Channels, joining or joined. */
  async function channels(status) {
    const agent = await created();
    for (const grant of (await f.config.listAgentChannelGrants()).filter(({ agentId }) => agentId === agent.id)) {
      await f.config.putAgentChannelGrant({ ...grant, status });
    }
  }
  /** The welcome Chickpea delivers once Slack has the Agent; a Channel may still be joining. */
  async function sayHello() {
    const agent = await created();
    await f.config.updateAgent(agent.id, { slackPresence: { ...agent.slackPresence, health: 'healthy' } });
    await channels('pending');
    // The fixture has no Slack, so create_agent's own hello is Chickpea's stand-in. With Slack,
    // the Agent posts it in its own name: that receipt, delivered as the outbox would.
    const claimed = await f.management.claimDueOutbox(clock.now, 25, clock.now + 60_000);
    const queued = claimed.find(({ receipt }) => receipt.kind === 'agent_created_welcome' && receipt.agentId === agent.id);
    assert.ok(queued, 'create_agent queued a hello');
    const welcome = {
      ...queued,
      outboxId: `${queued.outboxId}_published`,
      receipt: { ...queued.receipt, publication: { status: 'complete', incomplete: [] } },
      status: 'pending',
      createdAt: clock.now + 1,
      updatedAt: clock.now + 1,
      nextAttemptAt: clock.now,
    };
    await f.management.putOutbox(welcome);
    await f.management.claimDueOutbox(clock.now, 25, clock.now + 60_000);
    await f.management.settleOutbox({ outboxId: welcome.outboxId, outcome: 'delivered', at: clock.now, deliveryRef: 'D1:1.1' });
  }
  return {
    f, rpc, call, scenes, sayHello, picture, joinChannels: () => channels('active'), close: () => f.close(),
    runs, arrive, serve: (on) => { serving = on; },
    /** The person finishes on the setup page of the last link. */
    finishSetup: () => finished.set(lastSetup.setupToken, 'completed'),
    /** The person cancels on the setup page of the last link. */
    cancelSetup: () => finished.set(lastSetup.setupToken, 'revoked'),
    lastSetup: () => lastSetup,
  };
}

/** Where a scene's result carries the _meta its host gives the card as window.openai.toolResponseMetadata. */
const OPENAI_META = 'harness/openaiMeta';

/** The card each scene's tool draws. */
const SCENE_CARDS = {
  connect: 'connect-card', reconnect: 'connect-card', cancelled: 'connect-card', custom: 'connect-card', connectRenewals: 'connect-card',
  connectChoose: 'connect-card',
  health: 'health-card', healthy: 'health-card',
};

/** Two origins, like ChatGPT's page and its card sandbox. */
async function serve(current) {
  const listen = (handle) => new Promise((done) => {
    const server = createServer(handle);
    server.listen(0, '127.0.0.1', () => done(server));
  });
  const cardServer = await listen(async (request, response) => {
    // The page ChatGPT gets: resources/read on the card's URI.
    const query = new URL(request.url, 'http://card').searchParams;
    const [card] = (await current().rpc('resources/read', { uri: query.get('uri') })).contents;
    // ChatGPT's own globals, set before the card runs, as its sandbox sets them. The widget state
    // of a reopened chat comes after the result, with openai:set_globals: the harder case for the card.
    const json = (name) => query.get(name) === null ? undefined : JSON.stringify(JSON.parse(query.get(name))).replaceAll('<', '\\u003c');
    const [meta, widgetState, chatgpt] = [json('openaiMeta'), json('widgetState'), query.get('chatgpt') === '1'];
    const later = widgetState ? `addEventListener('load', () => setTimeout(() => {
      window.openai.widgetState = ${widgetState};
      dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: { widgetState: window.openai.widgetState } } }));
    }, 300));` : '';
    const globals = meta || chatgpt ? `<script>window.openai = {
      ${meta ? `toolResponseMetadata: ${meta},` : ''}
      ${chatgpt ? 'setWidgetState: (state) => window.parent.postMessage({ harnessWidgetState: state }, "*"),' : ''}
    };${later}</script>` : '';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(card.text.replace('<head>', `<head>${globals}`));
  });
  const hostServer = await listen(async (request, response) => {
    const url = new URL(request.url, 'http://host');
    const json = (value) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === '/scene') {
      const name = url.searchParams.get('name');
      const { [OPENAI_META]: openaiMeta, ...result } = await current().scenes[name]();
      return json({ result, uri: CARD_URIS[SCENE_CARDS[name] ?? 'agent-card'], ...openaiMeta ? { openaiMeta } : {} });
    }
    if (url.pathname === '/call') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const { name, arguments: callArgs } = JSON.parse(body);
      return json(await current().call(name, callArgs));
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><style>${FRAME_STYLE}</style>
      <script>window.HARNESS_STYLES = ${JSON.stringify(STYLES)};</script></head>
      <body><div id="shot"><div class="app"><i></i>Chickpea</div><div id="frame"></div></div>
      <script type="module">${HOST_SCRIPT}</script></body></html>`);
  });
  const origin = (server) => `http://127.0.0.1:${server.address().port}`;
  return { host: origin(hostServer), card: origin(cardServer), close: () => { hostServer.close(); cardServer.close(); } };
}

/**
 * Chrome with a throwaway profile, driven over the DevTools protocol.
 * Requests to this deployment's origin are answered by `picture`.
 */
async function chrome(picture) {
  const profile = mkdtempSync(join(tmpdir(), 'chickpea-card-chrome-'));
  const child = spawn(args.chrome, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((done, fail) => {
    let log = '';
    child.stderr.on('data', (chunk) => {
      log += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(log);
      if (match) done(match[1]);
    });
    child.on('exit', () => fail(new Error(`Chrome exited: ${log}`)));
  });
  const http = endpoint.replace(/^ws:\/\/([^/]+).*/, 'http://$1');
  const page = await (await fetch(`${http}/json/new?about:blank`, { method: 'PUT' })).json();
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done) => socket.addEventListener('open', done, { once: true }));
  let id = 0;
  const waiting = new Map();
  const contexts = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.executionContextCreated') {
      const { context } = message.params;
      if (context.auxData?.isDefault) contexts.set(context.auxData.frameId, context.id);
    }
    if (message.method === 'Runtime.executionContextsCleared') contexts.clear();
    if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params;
      void Promise.resolve(picture(request.url)).catch(() => undefined).then((body) => send('Fetch.fulfillRequest', body
        ? { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'image/png' }], body: body.toString('base64') }
        : { requestId, responseCode: 404, responseHeaders: [], body: '' }));
    }
    const pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id);
    if (message.error) pending.fail(new Error(message.error.message));
    else pending.done(message.result);
  });
  const send = (method, params = {}) => new Promise((done, fail) => {
    const messageId = ++id;
    waiting.set(messageId, { done, fail });
    socket.send(JSON.stringify({ id: messageId, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: `${ORIGIN}/*` }] });
  await send('Page.bringToFront');
  const evaluate = async (expression, contextId) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...contextId ? { contextId } : {} });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const cardContext = async () => {
    const { frameTree } = await send('Page.getFrameTree');
    const frameId = frameTree.childFrames?.[0]?.frame.id;
    return frameId && contexts.get(frameId);
  };
  const inCard = async (expression) => evaluate(expression, await cardContext());
  return {
    async open(url, { width, theme }) {
      await send('Emulation.setDeviceMetricsOverride', { width: width + 32, height: 900, deviceScaleFactor: 2, mobile: width < 500 });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme === 'dark' ? 'dark' : 'light' }] });
      await send('Page.navigate', { url });
    },
    inCard,
    host: (expression) => evaluate(expression),
    /** Waits until the card's page makes `expression` true. */
    async waitFor(expression, what, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (await inCard(`Boolean(${expression})`).catch(() => false)) return;
        if (Date.now() > deadline) {
          const shown = await inCard('document.querySelector(".cp-card")?.innerText ?? ""').catch(() => '');
          throw new Error(`The card never showed ${what}. It shows:\n${shown}`);
        }
        await new Promise((done) => setTimeout(done, 100));
      }
    },
    waitForTitle(pattern, timeoutMs) {
      return this.waitFor(`${pattern}.test(document.querySelector(".cp-title")?.textContent ?? "")`, pattern, timeoutMs);
    },
    /** Waits until the host has seen `count` links opened. */
    async linksOpened(count, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const links = await evaluate('window.harness.links');
        if (links.length >= count || Date.now() > deadline) return links;
        await new Promise((done) => setTimeout(done, 100));
      }
    },
    waitForRow(pattern, timeoutMs) {
      return this.waitFor(`[...document.querySelectorAll(".cp-row-title")].some((node) => ${pattern}.test(node.textContent))`, pattern, timeoutMs);
    },
    /** A real mouse click on the card's button, by its action or, with `label`, by its words. */
    async click(action, { label } = {}) {
      const find = label
        ? `[...document.querySelectorAll('button[data-action]')].find((node) => node.textContent === ${JSON.stringify(label)})`
        : `document.querySelector('button[data-action="${action}"]')`;
      // A card draws its buttons waiting while its first read is out.
      await this.waitFor(`(${find})?.disabled === false`, `${label ?? action}, ready to press`);
      const box = await inCard(`(() => { const r = ${find}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      const frame = await evaluate('(() => { const r = document.querySelector("iframe").getBoundingClientRect(); return { x: r.x, y: r.y }; })()');
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: frame.x + box.x, y: frame.y + box.y });
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: frame.x + box.x, y: frame.y + box.y, button: 'left', clickCount: 1 });
      }
    },
    /**
     * The lowest WCAG contrast of any text on the card against what is behind
     * it, from the colors the page computed, so host variables count.
     */
    contrast: () => inCard(`(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const paint = canvas.getContext('2d', { willReadFrequently: true });
      const over = (colors) => {
        paint.clearRect(0, 0, 1, 1);
        for (const color of colors) { paint.fillStyle = color; paint.fillRect(0, 0, 1, 1); }
        return [...paint.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      };
      const luminance = (rgb) => rgb.map((v) => v / 255).map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const backgrounds = (node) => {
        const layers = [];
        for (let at = node; at; at = at.parentElement) {
          const bg = getComputedStyle(at).backgroundColor;
          if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') layers.unshift(bg);
        }
        return ['#ffffff', ...layers];
      };
      let worst = { ratio: 99 };
      for (const node of document.querySelectorAll('.cp-card *')) {
        const text = [...node.childNodes].filter((child) => child.nodeType === 3).map((child) => child.textContent.trim()).join('');
        if (!text || node.closest('[hidden]') || node.classList.contains('sr-only')) continue;
        const style = getComputedStyle(node);
        const behind = backgrounds(node);
        const [fg, bg] = [over([...behind, style.color]), over(behind)];
        const [a, b] = [luminance(fg), luminance(bg)];
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
        // A glyph hidden from screen readers is a graphic: WCAG 1.4.11 asks 3:1 of it.
        const needed = large || node.closest('[aria-hidden="true"]') ? 3 : 4.5;
        if (ratio / needed < worst.ratio / (worst.needed ?? 1)) worst = { ratio: Math.round(ratio * 100) / 100, needed, text: text.slice(0, 40) };
      }
      return worst;
    })()`),
    async screenshot(file) {
      await new Promise((done) => setTimeout(done, 400));
      const clip = await evaluate('(() => { const r = document.getElementById("shot").getBoundingClientRect(); return { x: r.x - 16, y: r.y - 16, width: r.width + 32, height: r.height + 32, scale: 1 }; })()');
      const { data } = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
      writeFileSync(file, Buffer.from(data, 'base64'));
    },
    async close() {
      socket.close();
      const exited = new Promise((done) => child.once('exit', done));
      child.kill();
      await exited;
      rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

let current;
const servers = await serve(() => current);
const browser = await chrome((url) => current?.picture(url));
const shots = [];
const contrast = [];
const runs = [
  ...['chatgpt', 'claude'].flatMap((host) => ['light', 'dark'].flatMap((theme) => [728, 390].map((width) => ({ host, theme, width })))),
  { host: 'chatgpt', theme: 'none', width: 728 },
];
/** The card's header shows the Agent's own picture, loaded, or the art when it would not load. */
const picture = () => browser.inCard(`(() => {
  const holder = document.querySelector('.cp-hdr .cp-avatar');
  const image = holder?.querySelector('img');
  return image ? (image.complete && image.naturalWidth > 0 ? 'picture' : 'loading') : holder?.querySelector('svg') ? 'art' : 'none';
})()`);
try {
  for (const { host, theme, width } of runs) {
    current = await world();
    const label = `${host === 'claude' ? 'claude-' : ''}${theme === 'none' ? 'no-host-theme' : theme}-${width}`;
    const open = (scene) => browser.open(`${servers.host}/?scene=${scene}&host=${host}&theme=${theme}&width=${width}&card=${encodeURIComponent(servers.card)}`, { width, theme });
    const shot = async (name) => {
      const file = join(OUT, `${name}-${label}.png`);
      await browser.screenshot(file);
      shots.push(file);
      const worst = await browser.contrast();
      contrast.push({ shot: `${name}-${label}`, ...worst });
      assert.ok(worst.ratio >= worst.needed, `${name}-${label}: "${worst.text}" has contrast ${worst.ratio}, under ${worst.needed}`);
    };
    const showsPicture = async (what) => {
      await browser.waitFor(`document.querySelector('.cp-hdr .cp-avatar img')?.complete`, `${what}: its picture`);
      assert.equal(await picture(), 'picture', `${what}: the Agent's own picture`);
    };
    const told = async (pattern, what) => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const contexts = await browser.host('window.harness.contexts');
        // Each update carries everything the card told before; the newest sentence is last.
        if (pattern.test(contexts.at(-1)?.split('\n').at(-1) ?? '')) return;
        if (Date.now() > deadline) assert.fail(`${what}: the model was told ${JSON.stringify(contexts)}`);
        await new Promise((done) => setTimeout(done, 100));
      }
    };
    const subtitle = () => browser.inCard('document.querySelector(".cp-sub")?.textContent ?? ""');
    const buttons = () => browser.inCard('[...document.querySelectorAll(".cp-acts button")].map((node) => node.textContent)');
    /**
     * What the card saved to ChatGPT's widget state, which its model may read:
     * only what the card told the model and its outcome, never a token, key, ID or link.
     */
    const keptOnlyTold = async (what) => {
      const [states, sent, held] = await Promise.all([
        browser.host('window.harness.widgetStates'),
        browser.host('window.harness.args'),
        browser.host('window.harness.scene.result._meta?.["chickpea/held"] ?? {}'),
      ]);
      const secrets = [...sent.flatMap((args) => Object.entries(args ?? {})), ...Object.entries(held)]
        .flatMap(([key, value]) => /Token$|idempotencyKey|Id$/.test(key) && typeof value === 'string' ? [value] : []);
      assert.ok(states.length > 0, `${what}: the card kept something`);
      for (const state of states) {
        const written = JSON.stringify(state);
        assert.deepEqual([Object.keys(state), Object.keys(state.privateContent)], [['modelContent', 'privateContent'], ['card']], `${what}: ${written}`);
        assert.ok(Object.keys(state.privateContent.card).every((key) => ['version', 'told', 'outcome'].includes(key)), `${what}: ${written}`);
        assert.equal(state.modelContent, state.privateContent.card.told.join('\n'), `${what}: the model reads what the card told it`);
        assert.doesNotMatch(written, /agent_|changeset_|https?:/, `${what}: ${written}`);
        for (const secret of secrets) assert.equal(written.includes(secret), false, `${what}: ${secret} kept`);
      }
    };
    /** The example's two messages: how many lines each shows, and whether it was cut short. */
    const said = () => browser.inCard(`[...document.querySelectorAll('.cp-said')].map((node) => {
      const style = getComputedStyle(node);
      const line = style.lineHeight.endsWith('px') ? parseFloat(style.lineHeight) : parseFloat(style.lineHeight) * parseFloat(style.fontSize);
      return { lines: Math.round(node.clientHeight / line), cut: node.scrollHeight > node.clientHeight + 1 };
    })`);
    const smallPrint = () => browser.inCard('[...document.querySelectorAll(".cp-line")].map((node) => node.textContent)');

    await open('proposal');
    await browser.waitForTitle(/^Invoice Chaser$/);
    await showsPicture('The proposal');
    assert.equal(await browser.inCard('document.querySelectorAll(".cp-said")[1].innerText.split("\\n").length'), 4,
      'the example reply keeps its line breaks');
    assert.deepEqual((await said()).map(({ cut }) => cut), [false, false], 'a short example shows whole');
    assert.equal(await subtitle(), '@invoices', 'the handle, and no "handle is free"');
    assert.deepEqual(await browser.inCard('[...document.querySelectorAll(".cp-msg .sr-only")].map((node) => node.textContent)'),
      ['You: ', 'Invoice Chaser: '], 'a screen reader hears who said each line of the example');
    assert.deepEqual(await smallPrint(), [
      'Answers in your DMs and #finance. Anyone in Acme can message it.',
      'Needs Stripe · you sign in after it\'s created',
    ]);
    await shot('1-proposal');
    if (host === 'chatgpt' && theme !== 'none') {
      assert.equal(await browser.inCard('document.documentElement.style.getPropertyValue("--cursor-interaction")'), 'pointer',
        'the host\'s cursor for things to press');
    }
    if (host === 'chatgpt' && theme === 'light' && width === 728) {
      // A theme flip without new style variables drops the old theme's colors for the card's own.
      await browser.host('window.harness.flipTheme("dark")');
      await browser.waitFor('getComputedStyle(document.body).backgroundColor === "rgb(24, 24, 24)"', 'the dark fallback after a theme-only flip');
      const worst = await browser.contrast();
      assert.ok(worst.ratio >= worst.needed, `after the flip: "${worst.text}" has contrast ${worst.ratio}`);
      await open('proposal');
      await browser.waitForTitle(/^Invoice Chaser$/);
    }
    if (theme === 'none') {
      await open('confirm');
      await browser.waitForTitle(/^Turn off @support\?$/);
      await shot('6-confirm');
      current.close();
      continue;
    }
    await browser.click('change_something');
    for (let tries = 0; tries < 50 && (await browser.host('window.harness.messages.length')) === 0; tries += 1) {
      await new Promise((done) => setTimeout(done, 100));
    }
    const [asked] = await browser.host('window.harness.messages');
    assert.equal(asked?.content?.[0]?.text, 'Change Invoice Chaser: ', `${host}: Change something puts the same words in the composer`);
    await browser.host('window.harness.holdCreate = true');
    await browser.click('create');
    await browser.waitFor('[...document.querySelectorAll(".cp-steps li")].some((li) => li.textContent.endsWith("Creating it in Chickpea (in progress)"))',
      'the steps at once, while create_agent runs');
    assert.deepEqual(await buttons(), [], 'nothing to press while it is made');
    await shot('2-starting');
    await browser.host('window.harness.release()');
    await browser.waitFor('[...document.querySelectorAll(".cp-steps li")].some((li) => li.textContent.endsWith("Created in Chickpea (done)"))', 'the creation steps');
    await told(/^The person created the Agent "Invoice Chaser" \(@invoices\) from the card\. It is joining Slack now\.$/, 'Created');
    await showsPicture('The creating card');
    await shot('2-creating');
    await current.sayHello();
    await browser.waitFor(`["Joining Slack as @invoices (done)", "Saying hello to you (done)", "Joining #finance (in progress)"]
      .every((step) => [...document.querySelectorAll('.cp-steps li')].some((li) => li.textContent.endsWith(step)))`, 'the hello done while its Channel joins');
    await shot('2-hello-joining');
    await current.joinChannels();
    await browser.waitForTitle(/said hello to you in Slack$/);
    await told(/^The person created the Agent "Invoice Chaser" \(@invoices\) from the card\. It is ready in Slack and said hello to them there\.$/, 'Ready');
    await showsPicture('The ready card');
    await shot('2-ready');
    assert.match((await browser.host('window.harness.contexts')).at(-1), /^The person created .* It is joining Slack now\.\nThe person created .* said hello to them there\.$/,
      'the ready sentence carries the one before it');
    if (host === 'chatgpt') await keptOnlyTold('Created');
    const before = (await browser.host('window.harness.calls')).length;
    await browser.host('window.harness.reload()');
    if (host === 'chatgpt') {
      await browser.waitForTitle(/^✓ Created Invoice Chaser$/);
      assert.deepEqual(await buttons(), [], 'a reopened card offers no second Create');
    } else {
      // claude.ai keeps no widget state: the proposal again, whose Create replays the same Agent.
      await browser.waitForTitle(/^Invoice Chaser$/);
    }
    assert.deepEqual((await browser.host('window.harness.calls')).slice(before), [], 'reopening made no call');
    await shot('2-reopened');

    await open('proposalLong');
    await browser.waitForTitle(/^Churn Watch$/);
    assert.deepEqual(await said(), [{ lines: 2, cut: true }, { lines: 5, cut: true }], 'a long question shows two lines, a long reply five');
    assert.deepEqual(await smallPrint(), ['Answers in your DMs, #finance and #billing. Anyone in Acme can message it.'], 'no Needs without a service');
    await shot('1-proposal-long');
    await open('proposalBare');
    await browser.waitForTitle(/^Churn Watch$/);
    assert.equal(await browser.inCard('document.querySelector(".cp-thread") ? "an example" : document.querySelector(".cp-text")?.textContent'),
      'Flags customers who may not renew, from their invoices and email.', 'no example: the job in its place');
    await shot('1-proposal-no-example');
    await open('proposalTaken');
    await browser.waitForTitle(/^Support Triage$/);
    assert.equal(await subtitle(), '@support · handle is taken');
    await shot('1-proposal-taken');
    await browser.click('create');
    await browser.waitForTitle(/^An Agent like this already exists$/);
    assert.deepEqual(await buttons(), ['Create it anyway', 'Change something']);
    await shot('1-similar');

    await open('change');
    await browser.waitForTitle(/^Change Invoice Chaser$/);
    await showsPicture('The change');
    await shot('5-change');
    await browser.click('save');
    await browser.waitForTitle(/^✓ Saved Invoice Chaser$/);
    assert.equal(await subtitle(), 'Try it: mention @invoices in #finance.', 'a mention reaches it in its Channel');
    await told(/^The person saved the change to the Agent "Invoice Chaser" from the card\.$/, 'Saved');
    await shot('5-saved');
    await browser.click('undo');
    await browser.waitForTitle(/^✓ Undid the change$/);
    assert.deepEqual(await buttons(), ['Open in Slack'], 'no second Undo, which would redo the change');
    await told(/^The person undid the change to the Agent "Invoice Chaser" from the card\.$/, 'Undone');
    if (host === 'chatgpt') await keptOnlyTold('Saved and undone');
    await shot('5-undone');
    await browser.host('window.harness.reload()');
    await browser.waitForTitle(host === 'chatgpt' ? /^✓ Undid the change$/ : /^Change Invoice Chaser$/);
    await browser.waitFor('/It changed since this preview|Undid the change/.test(document.querySelector(".cp-card")?.textContent ?? "")', 'no Save for what changed since');
    assert.deepEqual(await buttons(), host === 'chatgpt' ? [] : ['Cancel'], 'no Save, and no Undo');
    await shot('5-undone-reopened');
    await open('turnedOff');
    await browser.waitForTitle(/^✓ Turned off People Helper$/);
    assert.equal(await subtitle(), 'It won\'t answer in Slack until it\'s turned back on.');
    await showsPicture('A saved change');
    await shot('5-turned-off');
    await open('savedDm');
    await browser.waitForTitle(/^✓ Saved People Helper$/);
    assert.equal(await subtitle(), 'Try it: message @people in Slack.', 'a save the model made, for an Agent that answers in DMs');
    await shot('5-saved-dm');

    await open('confirm');
    await browser.waitForTitle(/^Turn off @support\?$/);
    await new Promise((done) => setTimeout(done, 3_000));
    await browser.inCard('window.dispatchEvent(new Event("focus"))');
    const nonReads = async () => (await browser.host('window.harness.calls')).filter((name) => name !== 'get_agent');
    assert.deepEqual(await nonReads(), [], 'the card only read before the click');
    assert.equal((await current.f.config.getAgent('agent_support')).enabled, true);
    await showsPicture('The confirmation');
    await shot('6-confirm');
    await browser.click('keep');
    await browser.waitForTitle(/^Kept as it is$/);
    assert.deepEqual(await nonReads(), ['decline_change'], 'Keep retires the confirmation, and nothing else');
    await told(/^On the card, the person pressed "Keep it on", so nothing changed\./, 'Kept');
    assert.equal((await current.f.config.getAgent('agent_support')).enabled, true);
    if (host === 'chatgpt') await keptOnlyTold('Kept');
    await shot('6-kept');
    // The chat reopens with the confirmation's first result: ChatGPT's widget state says it was kept.
    await browser.host('window.harness.reload()');
    if (host === 'chatgpt') {
      await browser.waitForTitle(/^Kept as it is$/);
      assert.deepEqual(await buttons(), [], 'no Turn off or Keep it on for a retired confirmation');
      await shot('6-kept-reopened');
    } else {
      // claude.ai keeps nothing, and no read says the token is retired: a press gets Chickpea's own sentence.
      await browser.waitForTitle(/^Turn off @support\?$/);
      await browser.waitFor('document.querySelectorAll(".cp-acts button:enabled").length === 2', 'the buttons, once the read answers');
      await shot('6-kept-reopened');
      await browser.click('confirm');
      await browser.waitForTitle(/^Nothing changed$/);
      assert.match(await browser.inCard('document.querySelector(".cp-card").textContent'), /That confirmation no longer applies\./);
      assert.deepEqual(await buttons(), []);
      await shot('6-retired-refused');
    }
    assert.equal((await current.f.config.getAgent('agent_support')).enabled, true, 'nothing reopened turned it off');
    await open('confirm');
    await browser.waitForTitle(/^Turn off @support\?$/);
    await browser.click('confirm');
    await browser.waitForTitle(/^✓ Made the change you confirmed$/);
    assert.deepEqual(await nonReads(), ['confirm_change'], 'one click, one confirmation');
    assert.equal((await current.f.config.getAgent('agent_support')).enabled, false);
    assert.equal(await subtitle(), 'It won\'t answer in Slack until it\'s turned back on.');
    if (host === 'chatgpt') await keptOnlyTold('Confirmed');
    await shot('6-confirmed');

    await open('confirmBare');
    await browser.waitForTitle(/^Turn off @support\?$/);
    assert.deepEqual(await buttons(), ['Open in Admin'], 'no token on the card: no button that cannot work');
    await browser.waitFor('/Confirm this in Admin\./.test(document.querySelector(".cp-card")?.textContent ?? "")', 'where else to confirm');
    await shot('6-confirm-no-token');
    await browser.click('open_admin');
    assert.deepEqual(await browser.linksOpened(1), [`${ORIGIN}/admin/agents/agent_support`]);
    assert.deepEqual(await browser.host('window.harness.calls'), [], 'nothing confirmed or kept');
    await open('confirmMetaElsewhere');
    await browser.waitForTitle(/^Turn off @support\?$/);
    assert.deepEqual(await buttons(), ['Turn off', 'Keep it on'], 'the token from window.openai.toolResponseMetadata');
    await browser.click('keep');
    await browser.waitForTitle(/^Kept as it is$/);
    assert.deepEqual(await nonReads(), ['decline_change']);

    if (host === 'chatgpt') {
      // ChatGPT answers a refused call with a JSON-RPC error. With its copy of the result in the
      // error's data the card shows Chickpea's sentence; with only words it can only say it failed.
      for (const errors of ['data', ...theme === 'light' && width === 728 ? ['bare'] : []]) {
        await open('confirm');
        await browser.waitForTitle(/^Turn off @support\?$/);
        await browser.waitFor('document.querySelectorAll(".cp-acts button:enabled").length === 2', 'the buttons, once the read answers');
        const token = await browser.host('window.harness.scene.result._meta["chickpea/held"].confirmToken');
        await current.call('decline_change', { confirmToken: token });
        await browser.host(`window.harness.errors = ${JSON.stringify(errors)}`);
        await browser.click('confirm');
        if (errors === 'data') {
          await browser.waitForTitle(/^Nothing changed$/);
          assert.match(await browser.inCard('document.querySelector(".cp-card").textContent'), /That confirmation no longer applies\./);
          assert.deepEqual(await buttons(), []);
          await told(/^The person confirmed on the card, but nothing changed\. Chickpea said: "That confirmation no longer applies\./, 'Retired');
          await shot('6-retired-refused');
        } else {
          await browser.waitFor('!document.querySelector(".cp-error").hidden', 'the failure');
          await shot('6-retired-refused-no-data');
        }
        assert.equal((await current.f.config.getAgent('agent_support')).enabled, true);
      }
      if (theme === 'light' && width === 728) {
        // The host gives up on Turn off and the person presses it again. Only then does the first
        // try's own failure come, with nothing of Chickpea's in it: the card still waits for the second.
        await open('confirm');
        await browser.waitForTitle(/^Turn off @support\?$/);
        await browser.host('window.harness.holding = ["confirm_change"]');
        await browser.inCard('window.harnessTimeout = setTimeout; window.setTimeout = (run, ms, ...rest) => window.harnessTimeout(run, ms === 60_000 ? 200 : ms, ...rest)');
        await browser.click('confirm');
        await browser.waitFor('/could not be reached/.test(document.querySelector(".cp-error")?.textContent ?? "")', 'the host giving up');
        await browser.inCard('window.setTimeout = window.harnessTimeout');
        await browser.click('confirm');
        await browser.host('window.harness.held.shift()("fail")');
        await new Promise((done) => setTimeout(done, 500));
        assert.deepEqual(await browser.inCard('[...document.querySelectorAll(".cp-acts button")].map((node) => node.disabled)'), [true, true],
          'the second Turn off is still out');
        await browser.host('window.harness.holding = []; window.harness.answerHeld()');
        await browser.waitForTitle(/^✓ Made the change you confirmed$/);
        assert.deepEqual(await nonReads(), ['confirm_change', 'confirm_change'], 'Turn off twice, and no Keep it on');
        assert.equal((await current.f.config.getAgent('agent_support')).enabled, false);
      }
    }

    await open('expired');
    await browser.waitForTitle(/^This confirmation expired$/);
    await shot('6-expired');

    // Someone archives the Agent while its change card is open.
    await open('change');
    await browser.waitForTitle(/^Change Invoice Chaser$/);
    const invoices = (await current.call('get_agent', { agentId: 'agent_invoice_chaser' })).structuredContent;
    await current.call('archive_agent', { agentId: invoices.agentId, version: invoices.version, idempotencyKey: `archive-${label}` });
    await new Promise((done) => setTimeout(done, 1_100));
    await browser.inCard('window.dispatchEvent(new Event("focus"))');
    await browser.waitForTitle(/^Invoice Chaser is archived$/);
    assert.deepEqual(await buttons(), [], 'no Save for an archived Agent');
    await shot('8-archived');
    // A saved card whose Agent is deleted since: to this person it is gone, as to one who can no longer manage it.
    await open('savedDm');
    await browser.waitForTitle(/^✓ Saved People Helper$/);
    const people = (await current.call('get_agent', { agentId: 'agent_dm' })).structuredContent;
    const archivedPeople = await current.call('archive_agent', { agentId: 'agent_dm', version: people.version, idempotencyKey: `archive-dm-${label}` });
    const deleting = await current.call('delete_agent', { agentId: 'agent_dm', version: archivedPeople.structuredContent.version, idempotencyKey: `delete-dm-${label}` });
    const deleted = await current.call('confirm_change', { confirmToken: deleting._meta['chickpea/held'].confirmToken });
    assert.equal(deleted.structuredContent.status, 'done', JSON.stringify(deleted));
    await new Promise((done) => setTimeout(done, 1_100));
    await browser.inCard('window.dispatchEvent(new Event("focus"))');
    await browser.waitForTitle(/^People Helper is no longer available$/);
    assert.deepEqual(await buttons(), [], 'nothing to press for it');
    await shot('8-unavailable');

    const reads = async (what, { links = 0 } = {}) => {
      const calls = await browser.host('window.harness.calls');
      assert.deepEqual(calls.filter((name) => !['get_setup_status', 'get_agent'].includes(name)), [], `${what}: the card only read`);
      assert.equal((await browser.host('window.harness.links')).length, links, `${what}: no link opened before a click`);
      assert.deepEqual(await browser.host('window.harness.messages'), [], `${what}: no message sent before a click`);
    };
    /** The ruling: no status code, no service's own words and no ID on a card; the tool's result keeps them. */
    const plain = async (what) => {
      const text = await browser.inCard('document.querySelector(".cp-card")?.textContent ?? ""');
      assert.doesNotMatch(text, /HTTP|\b[1-5]\d\d\b|Unauthorized|timed out|connection_/, `${what}: ${text}`);
    };
    await open('connect');
    await browser.waitForTitle(/^Connect Gmail to Support Desk$/);
    await browser.inCard('window.dispatchEvent(new Event("focus"))');
    await new Promise((done) => setTimeout(done, 2_500));
    await reads('Connect');
    await showsPicture('The connect card');
    await shot('3-connect');
    await browser.click('connect');
    await browser.waitForRow(/^Waiting for Gmail/);
    const page = new URL(current.lastSetup().url);
    assert.deepEqual(await browser.linksOpened(1), [page.href], 'one click, one link');
    assert.equal(page.pathname, `/setup/${current.lastSetup().setupToken}`, 'Chickpea\'s page for this connection, never Admin');
    await shot('3-waiting');
    current.finishSetup();
    await browser.waitForRow(/^Gmail is connected/, 10_000);
    await told(/^"Gmail" is connected to the Agent "Support Desk" now\.$/, 'Connected');
    await shot('3-connected');

    await open('reconnect');
    await browser.waitForTitle(/^Sign Notion in again$/);
    await shot('3-reconnect');
    await open('cancelled');
    await browser.waitForRow(/^This link was cancelled/);
    await reads('A cancelled link');
    await shot('3-cancelled');
    await open('connect');
    await browser.waitForTitle(/^Connect Gmail to Support Desk$/);
    await browser.click('connect');
    await browser.waitForRow(/^Waiting for Gmail/);
    current.cancelSetup();
    await browser.waitForRow(/^This link was cancelled/, 10_000);
    await told(/^"Gmail" did not connect to the Agent "Support Desk": the link was cancelled\. Nothing changed\.$/, 'Cancelled');
    assert.equal(await browser.inCard('document.querySelector(".cp-row button")?.textContent'), 'Get a new link');
    await shot('3-cancelled-while-waiting');
    await open('connectChoose');
    await browser.waitForTitle(/^Connect Notion to Support Desk$/);
    assert.doesNotMatch(await browser.inCard('document.querySelector(".cp-rows").textContent'), /Your own account|For everyone/,
      'the person chooses on the page, so the card names no owner');
    await shot('3-connect-owner-open');
    await open('custom');
    await browser.waitFor('/Chickpea checked it/.test(document.querySelector(".cp-rows")?.textContent ?? "")', 'the custom connection\'s check');
    await plain('The custom connection\'s check');
    await shot('3-checked');
    if (host === 'chatgpt' && theme === 'light' && width === 728) {
      // A theme change on a card that is polling restyles it and does nothing else.
      await open('connect');
      await browser.waitForTitle(/^Connect Gmail to Support Desk$/);
      await browser.click('connect');
      await browser.waitForRow(/^Waiting for Gmail/);
      await browser.linksOpened(1);
      await browser.host('window.harness.flipTheme("dark")');
      await browser.waitFor('getComputedStyle(document.body).backgroundColor === "rgb(24, 24, 24)"', 'the waiting card after a theme-only flip');
      await new Promise((done) => setTimeout(done, 2_500));
      await browser.waitForRow(/^Waiting for Gmail/);
      await reads('A theme change while waiting', { links: 1 });
    }

    await open('health');
    await browser.waitForTitle(/^\d things need attention$/);
    await new Promise((done) => setTimeout(done, 1_000));
    await browser.inCard('window.dispatchEvent(new Event("focus"))');
    await reads('The health card');
    await showsPicture('The health card');
    await shot('7-health');
    await browser.click('show');
    await browser.waitForRow(/^@support /);
    await plain('The health card, every row shown');
    await shot('7-health-open');
    await browser.click(undefined, { label: 'Reconnect Notion' });
    await browser.waitFor('/Finish on the Chickpea page that opened/.test(document.querySelector(".cp-rows")?.textContent ?? "")', 'the fix\'s page opened');
    assert.deepEqual((await browser.host('window.harness.calls')).filter((name) => name === 'reconnect_service'), ['reconnect_service'], 'one click, one link');
    const links = await browser.linksOpened(1);
    assert.equal(links.length, 1);
    assert.match(new URL(links[0]).pathname, /^\/setup\/setup_/);
    await told(/^The person pressed "Reconnect Notion" for the Agent "Support Desk" on the card, which opened Chickpea's page\./, 'Fixing');
    await shot('7-fixing');
    await open('healthy');
    await browser.waitForTitle(/^Everything looks healthy$/);
    await browser.waitFor(`document.querySelector('.cp-hdr .cp-avatar svg')`, 'the art, when the picture would not load');
    assert.equal(await picture(), 'art', 'a picture that fails to load falls back to the art');
    await shot('7-healthy-fallback');

    // Scene 4: "See its first answer". A run starts only on the press, and every call for that press sends one key.
    const { runs } = current;
    const tried = async () => {
      const [calls, sent] = await Promise.all([browser.host('window.harness.calls'), browser.host('window.harness.args')]);
      return calls.flatMap((name, index) => name === 'try_agent_once' ? [sent[index].idempotencyKey] : []);
    };
    const shows = (pattern, what, timeoutMs) =>
      browser.waitFor(`${pattern}.test(document.querySelector(".cp-card")?.textContent ?? "")`, what, timeoutMs);
    /** Three minutes pass on the card's clock, as they would while it waits. */
    const later = (ms) => browser.inCard(`(() => { const now = Date.now.bind(Date); Date.now = () => now() + ${ms}; })()`);
    await open('firstProposal');
    await browser.waitForTitle(/^Renewals Desk$/);
    await browser.click('create');
    await browser.waitFor('[...document.querySelectorAll(".cp-steps li")].some((li) => li.textContent.endsWith("Created in Chickpea (done)"))', 'the creation steps');
    await current.arrive('agent_renewals_desk');
    await browser.waitForTitle(/said hello to you in Slack$/, 10_000);
    assert.deepEqual(await buttons(), ['Open in Slack', 'See its first answer'], 'nothing to connect: its first answer');
    await new Promise((done) => setTimeout(done, 1_200));
    await browser.inCard('window.dispatchEvent(new Event("focus"))');
    await new Promise((done) => setTimeout(done, 2_500));
    assert.deepEqual([await tried(), runs.starts.length], [[], 0], 'no run before the press');
    await shot('4-ready');
    runs.outcome = RUNNING;
    await browser.host('window.harness.holding = ["get_test_run"]');
    await browser.click('try_once');
    await shows('/Asking Renewals Desk its first question/', 'the run starting');
    await shot('4-asking');
    await shows('/Renewals Desk is answering/', 'the run going', 30_000);
    await shot('4-running');
    await later(181_000);
    await browser.host('window.harness.holding = []; window.harness.answerHeld("fail")');
    await shows('/taking longer than it should/', 'the card giving up');
    assert.deepEqual(await buttons(), ['Check again', 'Open in Slack']);
    await told(/^The person ran the Agent "Renewals Desk" \(@renewals\) once from the card, but its answer did not come back in time\.$/, 'Gave up');
    assert.match((await browser.host('window.harness.contexts')).at(-1), /^The person created the Agent "Renewals Desk".*\n/s,
      'the model still hears that the Agent was created');
    await plain('Gave up');
    await shot('4-gave-up');
    await browser.click('check_again');
    await shows('/It\'s still answering\./', 'Check again, still running', 30_000);
    await shot('4-still-answering');
    // Check again once more, and the answer has come.
    runs.outcome = ANSWERED;
    await browser.click('check_again');
    await browser.waitFor('document.querySelectorAll(".cp-pane").length === 2', 'what was promised beside what it answered');
    await told(/^The person ran the Agent "Renewals Desk" \(@renewals\) once from the card, and it answered its first question there\.$/, 'Answered');
    assert.deepEqual(await buttons(), ['Open in Slack', 'Change something']);
    assert.equal(new Set(await tried()).size, 1, 'one key for the press');
    assert.equal(runs.starts.length, 1, 'one run for the press');
    assert.equal(await browser.inCard('document.querySelectorAll(".cp-pane-text")[1].innerText.split("\\n").length'), 5,
      'the answer keeps its line breaks');
    assert.doesNotMatch(await browser.inCard('document.querySelector(".cp-panes").innerHTML'), /<(?!\/?(section|h3|div)\b)/, 'the answer is text, never markup');
    assert.doesNotMatch(await browser.inCard('document.querySelectorAll(".cp-pane-text")[1].innerText'), /[*_[\]]/, 'no Markdown marks in the answer');
    await shot('4-answered');
    await browser.click('change_something');
    for (let tries = 0; tries < 50 && (await browser.host('window.harness.messages.length')) === 0; tries += 1) {
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.equal((await browser.host('window.harness.messages')).at(-1)?.content?.[0]?.text, 'Change Renewals Desk: ');

    // The connect card holds no proposal: the answer alone.
    await open('connectRenewals');
    await browser.waitForTitle(/^Connect Gmail to Renewals Desk$/);
    await browser.click('connect');
    await browser.waitForRow(/^Waiting for Gmail/);
    current.finishSetup();
    await browser.waitForRow(/^Gmail is connected/, 10_000);
    assert.equal(await browser.inCard('document.querySelector(".cp-row button")?.textContent'), 'See its first answer');
    await shot('3-connected-first-answer');
    await browser.click('try_once');
    await browser.waitFor('document.querySelectorAll(".cp-pane").length === 1', 'the answer alone');
    assert.equal(await browser.inCard('document.querySelector(".cp-pane-label").textContent'), 'What it answered');
    await shot('4-answered-reply-only');

    /** An Agent's ready card, then its first answer refused or failed. */
    const refused = async (scene, name, pattern, labels) => {
      await open(scene);
      await browser.waitForTitle(/said hello to you in Slack$/, 10_000);
      await browser.click('try_once');
      await shows(pattern, name);
      assert.deepEqual(await buttons(), labels, `${name}: what it offers next`);
      await plain(name);
      await shot(`4-refused-${name}`);
    };
    current.serve(false);
    await refused('readyQuiet', 'unavailable', /Test runs aren't available on this workspace yet\./, ['Open in Slack']);
    current.serve(true);
    runs.refuse = { kind: 'daily_limit', resumesAt: Date.now() + 5 * 3_600_000 - 60_000 };
    await refused('readyQuiet', 'limit', /reached today's limit\. They start again in about 5 hours\./, ['Open in Slack']);
    if (host === 'chatgpt') {
      // As ChatGPT delivers a refused call: a JSON-RPC error carrying its copy of the result.
      await open('readyQuiet');
      await browser.waitForTitle(/said hello to you in Slack$/, 10_000);
      await browser.host('window.harness.errors = "data"');
      await browser.click('try_once');
      await shows(/reached today's limit\. They start again in about 5 hours\./, 'the limit, through a JSON-RPC error');
      assert.equal((await tried()).length, 1, 'no retry of a refusal');
      await shot('4-refused-limit-host-error');
    }
    runs.refuse = undefined;
    runs.outcome = { status: 'failed', failure: 'deadline', result: null };
    await refused('readyQuiet', 'deadline', /took too long and was stopped\. Ask Quiet Desk in Slack instead\./, ['Open in Slack']);
    runs.outcome = { status: 'failed', failure: 'out_of_usage', result: null };
    await refused('readyQuiet', 'out-of-usage', /out of usage, so the test run couldn't finish\./, ['Open in Slack']);
    runs.outcome = ANSWERED;
    await refused('readySetup', 'setup', /Finish setting up Linear first, then try again\./, ['Finish its setup in Admin', 'Open in Slack']);
    await refused('readyDocs', 'untestable', /Help center allows no tools yet, so a test run can't use it\./, ['Choose its tools in Admin', 'Open in Slack']);
    await browser.click('try_fix');
    assert.deepEqual(await browser.linksOpened(1), [`${ORIGIN}/admin/agents/agent_docs_helper`], 'its fix opens on the press');
    await shows('/Finish on the Chickpea page that opened, then try again\./', 'Try again after the fix');
    assert.deepEqual(await buttons(), ['Try again', 'Choose its tools in Admin']);
    await shot('4-refused-untestable-fixing');

    // Another run holds the workspace: the card asks again every 5 s, and after a minute offers Try again.
    runs.refuse = { kind: 'in_progress' };
    await open('readyQuiet');
    await browser.waitForTitle(/said hello to you in Slack$/, 10_000);
    await browser.click('try_once');
    await shows('/Waiting for another test run in this workspace to finish/', 'the wait');
    await shot('4-waiting');
    await later(61_000);
    await shows('/Another test run is going in this workspace\. Try again in a minute\./', 'Try again', 10_000);
    assert.deepEqual(await buttons(), ['Try again', 'Open in Slack']);
    await plain('Busy');
    await shot('4-refused-busy');
    runs.refuse = undefined;
    await browser.click('try_once');
    await browser.waitFor('document.querySelectorAll(".cp-pane").length === 1', 'the answer after Try again');
    const keys = await tried();
    assert.ok(keys.length >= 3, 'asked again while it waited');
    assert.equal(new Set(keys).size, 1, 'every call for the press, Try again included, sends one key');
    current.close();
  }
} finally {
  await browser.close();
  servers.close();
}
writeFileSync(join(OUT, 'contrast.json'), `${JSON.stringify(contrast, null, 2)}\n`);
const lowest = (needed) => Math.min(...contrast.filter((entry) => entry.needed === needed).map(({ ratio }) => ratio));
console.log(`${shots.length} screenshots in ${OUT}; lowest contrast ${lowest(4.5)}:1 for text, ${lowest(3)}:1 for graphics`);
