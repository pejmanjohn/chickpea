import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import { DISCOVERY_GUIDE_URI } from '../src/management/agent-authoring/index.ts';
import { DISCOVERY_GUIDE, DISCOVERY_GUIDE_FIVE_ZERO } from '../src/management/agent-authoring/discovery-guide.ts';
import { codingAgentAuthoringGuideResource } from '../src/management/agent-authoring/mcp-guide.ts';
import {
  V4_TOOL_REPLACEMENTS,
  WORKSPACE_MANAGEMENT_AGENT_AUTHORING_GUIDE_URI,
  WORKSPACE_MANAGEMENT_OPERATION_SCHEMA_URI,
  workspaceManagementMcpFetch,
} from '../src/management/mcp.ts';
import {
  WORKSPACE_MANAGEMENT_PROMPT_NAMES,
  WORKSPACE_MANAGEMENT_PROMPTS,
  workspaceManagementPromptText,
  type WorkspaceManagementPromptName,
} from '../src/management/prompts.ts';
import { CARD_SHOWS_IT, forCardHost } from '../src/management/mcp-v5/card-host.ts';
import { writeHints } from '../src/management/mcp-v5/conventions.ts';
import type { FiveZeroDeps } from '../src/management/mcp-v5/reads.ts';
import { changeResultOutput, getWorkspaceInput } from '../src/management/mcp-v5/schemas.ts';
import { registerFiveZeroTool, type FiveZeroTool, type FiveZeroToolName } from '../src/management/mcp-v5/tools.ts';
import { createFixtureAgent, createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';
import { jsonRequest } from './helpers/mcp-card-host.ts';

const BASE_URL = 'https://chickpea.example.test';
const LEGACY = '2025-11-25';
const MODERN = '2026-07-28';
const CARDS = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } };

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, any>;
  isError?: boolean;
  _meta?: Record<string, any>;
};

/**
 * Core's MCP server as the Worker serves it: a client that declares cards at
 * initialize gets a session, and each later request in it says so.
 */
async function harness(t: TestContext, suffix: string) {
  const f = await createManagementAdapterFixture(suffix, ({ settings }) => ({ settings }));
  t.after(() => f.close());
  const teamId = f.owner.binding.slackTeamId;
  /** The signed-in owner through one MCP app: an app is one OAuth client. */
  const fetchAs = (clientId: string) => workspaceManagementMcpFetch({
    principal: {
      betterAuthUserId: f.owner.binding.betterAuthUserId ?? 'ba_owner',
      userId: f.owner.user.id,
      membershipId: f.owner.membership.id,
      organizationId: f.owner.membership.organizationId,
      role: 'owner',
      clientId,
    } satisfies McpAuthenticatedPrincipal,
    service: f.service,
    baseUrl: BASE_URL,
  });
  const fetch = fetchAs(`client_${suffix}`);
  /** One JSON-RPC message and the server's whole answer, result or error. */
  const send = async (body: Record<string, unknown>, headers: Record<string, string> = {}, via = fetch) => {
    const response = await via(jsonRequest(
      { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers },
      { jsonrpc: '2.0', id: 1, ...body },
    ));
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const json = text.trimStart().startsWith('{') ? text : text.split('\n').find((line) => line.startsWith('data: '))!.slice(6);
    return { response, message: JSON.parse(json) as { result?: any; error?: { code: number; message: string } } };
  };
  const post = async (body: Record<string, unknown>, headers: Record<string, string> = {}, via = fetch) => {
    const { response, message } = await send(body, headers, via);
    return { response, result: message.result };
  };
  /** A 2025 client: initialize, then each call with the session initialize named, if any. */
  const connect = async (capabilities: Record<string, unknown>, via = fetch) => {
    const { response } = await post({
      method: 'initialize',
      params: { protocolVersion: LEGACY, capabilities, clientInfo: { name: 'test-client', version: '1' } },
    }, { 'mcp-protocol-version': LEGACY }, via);
    const session = response.headers.get('mcp-session-id');
    const headers = { 'mcp-protocol-version': LEGACY, ...session ? { 'mcp-session-id': session } : {} };
    const call = async (name: string, args: Record<string, unknown> = {}) => (await post(
      { method: 'tools/call', params: { name, arguments: args } }, headers, via,
    )).result as ToolResult;
    /** Any request in the session, answered with a result or an error. */
    const request = (method: string, params: Record<string, unknown> = {}) => send({ method, params }, headers, via);
    return { session, call, request };
  };
  /** A 2026-07-28 client: every request carries its capabilities. */
  const modernMeta = (capabilities: Record<string, unknown>) => ({
    'io.modelcontextprotocol/protocolVersion': MODERN,
    'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': capabilities,
  });
  const modern = (capabilities: Record<string, unknown>) => async (name: string, args: Record<string, unknown> = {}) => (await post({
    method: 'tools/call',
    params: { name, arguments: args, _meta: modernMeta(capabilities) },
  }, { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call', 'mcp-name': name })).result as ToolResult;
  /** A 2026-07-28 client's tools/list, or a call answered with a result or an error. */
  const modernRequest = (capabilities: Record<string, unknown>, method: string, params: Record<string, unknown> = {}) => send(
    { method, params: { ...params, _meta: modernMeta(capabilities) } },
    {
      'mcp-protocol-version': MODERN,
      'mcp-method': method,
      ...typeof params.name === 'string' ? { 'mcp-name': params.name } : typeof params.uri === 'string' ? { 'mcp-name': params.uri } : {},
    },
  );

  await createFixtureAgent(f, 'agent_support');
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_SUPPORT', label: 'support', lifecycle: 'active' });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C_SUPPORT', agentId: 'agent_support', status: 'active',
    createdByMembershipId: f.owner.membership.id, channelLabel: 'support',
  });
  return { f, teamId, connect, modern, modernRequest, fetchAs, post };
}

async function version(call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>, agentId: string) {
  return (await call('get_agent', { agentId })).structuredContent!.version as string;
}

/** Everything a host's model reads from a result. */
function modelView(result: ToolResult): string {
  return JSON.stringify({ structuredContent: result.structuredContent, content: result.content });
}

test('Keep voids a confirmation: confirm_change with its token afterwards is refused, and nothing changes', async (t) => {
  const { f, connect } = await harness(t, 'card-keep');
  const { call } = await connect({});
  const off = await call('update_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), on: false, idempotencyKey: 'off' });
  const { confirmToken } = off.structuredContent!.confirmation;

  const kept = await call('decline_change', { confirmToken });
  assert.deepEqual(kept.structuredContent, { status: 'unchanged', summary: 'Kept as it is. Nothing changed.' });
  assert.deepEqual((await call('decline_change', { confirmToken })).structuredContent, kept.structuredContent, 'a second press says the same');

  const refused = await call('confirm_change', { confirmToken });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent!.error.message, 'That confirmation no longer applies. Ask again to make the change.');
  assert.equal((await f.config.getAgent('agent_support')).enabled, true, 'the Agent is still on');

  // Sending the same call again replays it, and says the same.
  const replayed = await call('update_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), on: false, idempotencyKey: 'off' });
  assert.deepEqual([replayed.structuredContent!.error.message, replayed.structuredContent!.error.nextStep], [
    'That confirmation no longer applies. Ask again to make the change.',
    'Nothing changed. Propose it again, with a new idempotencyKey, only if the person asks for it again.',
  ]);

  // Asking again makes a fresh confirmation, which works.
  const again = await call('update_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), on: false, idempotencyKey: 'off-again' });
  const done = await call('confirm_change', { confirmToken: again.structuredContent!.confirmation.confirmToken });
  assert.equal(done.structuredContent!.status, 'done');
  assert.equal((await f.config.getAgent('agent_support')).enabled, false);
});

test('Keep after the change was already made says so, and never undoes it', async (t) => {
  const { f, connect } = await harness(t, 'card-keep-late');
  const { call } = await connect({});
  const off = await call('update_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), on: false, idempotencyKey: 'off' });
  const { confirmToken } = off.structuredContent!.confirmation;
  await call('confirm_change', { confirmToken });
  const late = await call('decline_change', { confirmToken });
  assert.equal(late.structuredContent!.status, 'done');
  assert.equal(late.structuredContent!.summary, 'That change was already made.');
  assert.equal((await f.config.getAgent('agent_support')).enabled, false);

  const unknown = await call('decline_change', { confirmToken: 'proposal_nobody' });
  assert.equal(unknown.structuredContent!.error.code, 'not_found');
});

test('a client that draws cards never shows its model a confirm or undo token; its card gets them in _meta', async (t) => {
  const { f, connect } = await harness(t, 'card-host');
  const { session, call } = await connect(CARDS);
  assert.match(session ?? '', /^chickpea-cards-[0-9a-f-]{36}$/, 'initialize names a session that draws cards');

  const off = await call('update_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), on: false, idempotencyKey: 'off' });
  const held = off._meta?.['chickpea/held'] as { confirmToken?: string };
  assert.equal(typeof held?.confirmToken, 'string', 'the card holds the token');
  assert.equal(off.structuredContent!.status, 'needs_confirmation');
  assert.equal(off.structuredContent!.confirmation.confirmToken, undefined);
  assert.ok(!modelView(off).includes(held.confirmToken!), 'the model sees no confirm token');
  assert.equal(off.structuredContent!.summary,
    `Nothing has changed yet. Confirm on the card above, or in Admin: ${BASE_URL}/admin/agents/agent_support.`);
  assert.deepEqual(off.content.map(({ text }) => text), [CARD_SHOWS_IT, JSON.stringify(off.structuredContent)],
    'the text leads with what the card shows, then says the same');
  assert.equal(off.structuredContent!.nextStep, `${CARD_SHOWS_IT} Only the card can confirm it: it holds the confirmToken.`);
  assert.equal((await f.config.getAgent('agent_support')).enabled, true);

  // The card's press confirms with the token it holds.
  const confirmed = await call('confirm_change', { confirmToken: held.confirmToken! });
  assert.equal(confirmed.structuredContent!.status, 'done');
  assert.equal((await f.config.getAgent('agent_support')).enabled, false);
  // Its undo token is the confirm token's own string: the card holds it too.
  assert.equal(confirmed.structuredContent!.undoToken, undefined);
  assert.equal((confirmed._meta?.['chickpea/held'] as { undoToken?: string } | undefined)?.undoToken, held.confirmToken);
  assert.ok(!modelView(confirmed).includes(held.confirmToken!), 'the model sees no undo token');

  const renamed = await call('update_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), description: 'Answers billing questions.', idempotencyKey: 'describe' });
  const undo = (renamed._meta?.['chickpea/held'] as { undoToken?: string } | undefined)?.undoToken;
  assert.equal(typeof undo, 'string', 'the card holds the undo token');
  assert.equal(renamed.structuredContent!.undoToken, undefined);
  assert.ok(!modelView(renamed).includes(undo!), 'the model sees no undo token');
  // Mutation proof (review SHOULD 1): the card's sentence replacing the off Agent's next step.
  const name = renamed.structuredContent!.agent.name as string;
  assert.equal(renamed.structuredContent!.nextStep,
    `${CARD_SHOWS_IT} They can undo it on the card. ${name} is off, so it answers no one in Slack. Don't suggest trying it.`,
    'the Agent is off since the confirmation, and a card host\'s model hears so too');

  // A write no card draws keeps its token where the model can use it.
  const memory = await call('get_agent_memory', { agentId: 'agent_support' });
  const remembered = await call('update_agent_memory', {
    agentId: 'agent_support', version: memory.structuredContent!.version, body: 'Billing questions go to #support.', idempotencyKey: 'memory',
  });
  assert.equal(typeof remembered.structuredContent!.undoToken, 'string', JSON.stringify(remembered));
  assert.equal(remembered._meta, undefined);
});

test('a card host\'s model hears that a card shows the result: one sentence, nothing restated, then wait', async (t) => {
  const { connect } = await harness(t, 'card-shows-it');
  const cards = await connect(CARDS);
  const plain = await connect({});
  const shown = {
    propose_agent: {
      name: 'Invoice Chaser', handle: 'invoices', job: 'Chases overdue invoices.', instructions: '# Job\nChase invoices.',
      sampleAsk: 'who is overdue?', promisedAnswer: 'Three invoices are overdue.',
    },
    propose_agent_change: { agentId: 'agent_support', version: await version(cards.call, 'agent_support'), change: { description: 'Billing.' } },
    check_agent: { agentId: 'agent_support' },
  };
  for (const [tool, args] of Object.entries(shown)) {
    const drawn = await cards.call(tool, args);
    assert.equal(drawn.structuredContent!.nextStep, CARD_SHOWS_IT, tool);
    assert.deepEqual(drawn.content.map(({ text }) => text), [CARD_SHOWS_IT, JSON.stringify(drawn.structuredContent)],
      `${tool}: the text leads with it, then the result`);
    const bare = await plain.call(tool, args);
    assert.equal(bare.structuredContent!.nextStep, undefined, `${tool}: a client without cards gets the result alone`);
    assert.deepEqual(bare.content.map(({ text }) => text), [JSON.stringify(bare.structuredContent)], tool);
  }
  const read = await cards.call('get_agent', { agentId: 'agent_support' });
  assert.equal(JSON.stringify(read).includes(CARD_SHOWS_IT), false, 'a result no card draws says nothing about a card');
});

test('a setup link the card cannot open stays the model\'s to give; one it can open is the card\'s', () => {
  const link = {
    status: 'needs_setup', summary: 'Open the link to connect Sentry to Support.', nextStep: 'Give the person the link; they finish there.',
    setup: { url: `${BASE_URL}/admin/agents/agent_support`, what: 'Sentry' },
  };
  assert.deepEqual(forCardHost(link, BASE_URL, true), { structured: link }, 'Admin\'s page: the model hands it over');
  const page = { ...link, setup: { ...link.setup, url: `${BASE_URL}/setup/setup_1`, setupToken: 'setup_1' } };
  assert.deepEqual(forCardHost(page, BASE_URL, true), { structured: { ...page, nextStep: CARD_SHOWS_IT }, lead: CARD_SHOWS_IT });
  assert.deepEqual(forCardHost(page, BASE_URL, false), { structured: page }, 'a result no card draws is left as it is');
});

test('a client without cards keeps every token where its model reads it, as before', async (t) => {
  const { connect } = await harness(t, 'card-none');
  const { session, call } = await connect({ elicitation: { form: {} } });
  assert.equal(session, null, 'no session for a client that draws no cards');
  const off = await call('update_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), on: false, idempotencyKey: 'off' });
  const { confirmToken } = off.structuredContent!.confirmation;
  assert.equal(typeof confirmToken, 'string');
  assert.ok(off.content[0]!.text.includes(confirmToken), 'the text carries it too');
  assert.equal(off.structuredContent!.summary, 'This change waits for the person\'s confirmation. Nothing has changed yet.');
  assert.deepEqual(off._meta, { 'chickpea/tool': 'update_agent' });
  const confirmed = await call('confirm_change', { confirmToken });
  assert.equal(typeof confirmed.structuredContent!.undoToken, 'string', 'its model can undo what it confirmed');
  assert.equal(confirmed._meta?.['chickpea/held'], undefined);
});

test('a 2026-07-28 request that declares cards gets the same: the token only in _meta', async (t) => {
  const { modern } = await harness(t, 'card-modern');
  const withCards = modern(CARDS);
  const off = await withCards('update_agent', { agentId: 'agent_support', version: await version(withCards, 'agent_support'), on: false, idempotencyKey: 'off' });
  const held = off._meta?.['chickpea/held'] as { confirmToken?: string };
  assert.equal(typeof held?.confirmToken, 'string');
  assert.ok(!modelView(off).includes(held.confirmToken!));

  const plain = modern({});
  const again = await plain('update_agent', { agentId: 'agent_support', version: await version(plain, 'agent_support'), on: false, idempotencyKey: 'off-plain' });
  assert.equal(typeof again.structuredContent!.confirmation.confirmToken, 'string');
});

test('Keep from another app of the same person reads as no such confirmation, and the confirmation still applies', async (t) => {
  const { f, connect, fetchAs } = await harness(t, 'card-keep-other');
  const mine = await connect({});
  const other = await connect({}, fetchAs('client_other_app'));
  const off = await mine.call('update_agent', { agentId: 'agent_support', version: await version(mine.call, 'agent_support'), on: false, idempotencyKey: 'off' });
  const { confirmToken } = off.structuredContent!.confirmation;

  const refused = await other.call('decline_change', { confirmToken });
  assert.equal(refused.structuredContent!.error.code, 'not_found');
  assert.equal((await f.management.getChangeSetProposal(confirmToken))?.status, 'pending', 'it still waits for its own app');

  const done = await mine.call('confirm_change', { confirmToken });
  assert.equal(done.structuredContent!.status, 'done');
  assert.equal((await f.config.getAgent('agent_support')).enabled, false);
});

/** Moves a set to `applying`, as a confirmation's claim does. */
async function claim(f: Awaited<ReturnType<typeof harness>>['f'], proposalId: string) {
  const { organizationId, actorUserId, actorMembershipId, originKey, approvalScopeKey } = (await f.management.getChangeSetProposal(proposalId))!;
  await f.management.claimChangeSetProposal({
    proposalId, organizationId, actorUserId, actorMembershipId, originKey, approvalScopeKey, at: Date.now(),
  });
}

test('Keep while the confirmation applies says it is in progress and leaves it applying', async (t) => {
  const { f, connect } = await harness(t, 'card-keep-applying');
  const { call } = await connect({});
  const off = await call('update_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), on: false, idempotencyKey: 'off' });
  const { confirmToken } = off.structuredContent!.confirmation;
  await claim(f, confirmToken);

  const busy = await call('decline_change', { confirmToken });
  assert.equal(busy.structuredContent!.error.code, 'in_progress');
  assert.equal((await f.management.getChangeSetProposal(confirmToken))?.status, 'applying');
});

test('a confirm that lands between Keep\'s read and its write wins: Keep never says Kept for a change that applied', async (t) => {
  const { f, connect } = await harness(t, 'card-keep-race');
  const { call } = await connect({});
  const retire = f.management.markChangeSetProposalStale.bind(f.management);
  /** Runs `between` once, inside Keep's store write, before the write itself. */
  const interleave = (between: (proposalId: string) => Promise<unknown>) => {
    let armed = true;
    f.management.markChangeSetProposalStale = async (proposalId, at, options) => {
      if (armed) {
        armed = false;
        await between(proposalId);
      }
      return await retire(proposalId, at, options);
    };
  };
  const ask = async (key: string) => (await call('update_agent', {
    agentId: 'agent_support', version: await version(call, 'agent_support'), on: false, idempotencyKey: key,
  })).structuredContent!.confirmation.confirmToken as string;

  // The confirm finished first: Keep returns its result.
  const first = await ask('off');
  let confirmed: ToolResult | undefined;
  interleave(async () => {
    confirmed = await call('confirm_change', { confirmToken: first });
  });
  const late = await call('decline_change', { confirmToken: first });
  assert.equal(confirmed?.structuredContent!.status, 'done');
  assert.deepEqual([late.structuredContent!.status, late.structuredContent!.summary], ['done', 'That change was already made.']);
  assert.equal((await f.management.getChangeSetProposal(first))?.status, 'completed', 'its result is kept');
  assert.equal((await f.config.getAgent('agent_support')).enabled, false);

  // The confirm has claimed it and is still applying: Keep refuses and leaves it be.
  const on = await call('update_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), on: true, idempotencyKey: 'on' });
  assert.equal(on.structuredContent!.status, 'done');
  const second = await ask('off-again');
  interleave((proposalId) => claim(f, proposalId));
  const busy = await call('decline_change', { confirmToken: second });
  assert.equal(busy.structuredContent!.error.code, 'in_progress');
  assert.equal((await f.management.getChangeSetProposal(second))?.status, 'applying', 'never cut off mid-apply');
});

type ChangeSet = NonNullable<Awaited<ReturnType<Awaited<ReturnType<typeof harness>>['f']['management']['getChangeSetProposal']>>>;

/**
 * Two confirms of one token: B reads the set while it waits, and `between`
 * runs right after that read, where confirm A claims and applies it. The
 * store's own methods read the set synchronously, so every other read stays
 * synchronous.
 */
function afterConfirmRead(
  f: Awaited<ReturnType<typeof harness>>['f'],
  between: (proposalId: string) => Promise<unknown>,
  shown: (proposal: ChangeSet) => ChangeSet = (proposal) => proposal,
) {
  type Read = (this: object, proposalId: string) => ChangeSet | undefined;
  const store = f.management as unknown as { getChangeSetProposal: (this: object, proposalId: string) => unknown };
  const read = (Object.getPrototypeOf(f.management) as { getChangeSetProposal: Read }).getChangeSetProposal;
  let armed = true;
  store.getChangeSetProposal = function (proposalId) {
    const proposal = read.call(this, proposalId);
    if (!armed || proposal?.status !== 'pending') return proposal;
    armed = false;
    return between(proposalId).then(() => shown(proposal));
  };
}

test('a confirm whose recheck fails because another confirm applied it first never retires that one', async (t) => {
  const { f, connect } = await harness(t, 'card-confirm-race');
  const { call } = await connect({});
  const ask = async (key: string) => (await call('update_agent', {
    agentId: 'agent_support', version: await version(call, 'agent_support'), on: false, idempotencyKey: key,
  })).structuredContent!.confirmation.confirmToken as string;

  // A claimed the set and turned the Agent off, and has not saved its result yet.
  const first = await ask('off');
  afterConfirmRead(f, async (proposalId) => {
    await claim(f, proposalId);
    await f.config.updateAgent('agent_support', { enabled: false });
  });
  const busy = await call('confirm_change', { confirmToken: first });
  assert.equal(busy.structuredContent!.error.code, 'in_progress', JSON.stringify(busy.structuredContent));
  assert.equal((await f.management.getChangeSetProposal(first))?.status, 'applying', 'A keeps its claim, so its result is saved');

  // A finished first: B returns A's result instead of saying it changed.
  await f.config.updateAgent('agent_support', { enabled: true });
  const second = await ask('off-again');
  let applied: ToolResult | undefined;
  afterConfirmRead(f, async () => {
    applied = await call('confirm_change', { confirmToken: second });
  });
  const replayed = await call('confirm_change', { confirmToken: second });
  assert.equal(applied?.structuredContent!.status, 'done');
  assert.equal(replayed.structuredContent!.status, 'done', JSON.stringify(replayed.structuredContent));
  assert.equal((await f.management.getChangeSetProposal(second))?.status, 'completed', 'its result is kept');
  assert.equal((await f.config.getAgent('agent_support')).enabled, false);
});

test('a confirm that finds the digest changed never retires a set another confirm claimed since its read', async (t) => {
  const { f, connect } = await harness(t, 'card-confirm-digest');
  const { call } = await connect({});
  const off = await call('update_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), on: false, idempotencyKey: 'off' });
  const { confirmToken } = off.structuredContent!.confirmation;
  afterConfirmRead(f, (proposalId) => claim(f, proposalId), (proposal) => ({ ...proposal, digest: 'f'.repeat(64) }));
  const busy = await call('confirm_change', { confirmToken });
  assert.equal(busy.structuredContent!.error.code, 'in_progress', JSON.stringify(busy.structuredContent));
  assert.equal((await f.management.getChangeSetProposal(confirmToken))?.status, 'applying', 'never cut off mid-apply');

  // A set that still waits is retired as before.
  const again = await call('update_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), on: false, idempotencyKey: 'off-again' });
  const token = again.structuredContent!.confirmation.confirmToken as string;
  afterConfirmRead(f, async () => undefined, (proposal) => ({ ...proposal, digest: 'f'.repeat(64) }));
  const refused = await call('confirm_change', { confirmToken: token });
  assert.equal(refused.structuredContent!.error.message, 'That confirmation no longer applies. Ask again to make the change.');
  assert.equal((await f.management.getChangeSetProposal(token))?.status, 'stale');
});

test('a set whose applier is gone and whose digest no longer matches is retired, not left applying for good', async (t) => {
  const { f, connect } = await harness(t, 'card-confirm-stuck');
  const { call } = await connect({});
  const off = await call('update_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), on: false, idempotencyKey: 'off' });
  const { confirmToken } = off.structuredContent!.confirmation;
  const { organizationId, actorUserId, actorMembershipId, originKey, approvalScopeKey } = (await f.management.getChangeSetProposal(confirmToken))!;
  // Claimed by a confirm that crashed long ago: its lease has run out.
  await f.management.claimChangeSetProposal({
    proposalId: confirmToken, organizationId, actorUserId, actorMembershipId, originKey, approvalScopeKey, at: Date.now() - 60_000,
  });
  type Read = (this: object, proposalId: string) => ChangeSet | undefined;
  const read = (Object.getPrototypeOf(f.management) as { getChangeSetProposal: Read }).getChangeSetProposal;
  (f.management as unknown as { getChangeSetProposal: Read }).getChangeSetProposal = function (proposalId) {
    const proposal = read.call(this, proposalId);
    return proposal && { ...proposal, digest: 'f'.repeat(64) };
  };
  const refused = await call('confirm_change', { confirmToken });
  assert.equal(refused.structuredContent!.error.message, 'That confirmation no longer applies. Ask again to make the change.');
  assert.equal(read.call(f.management, confirmToken)?.status, 'stale');
});

const V4_TOOLS = Object.keys(V4_TOOL_REPLACEMENTS);
const V4_OFF = {
  idempotencyKey: 'v4-off',
  operations: [{ itemId: 'off', kind: 'update_agent', agentId: 'agent_support', expectedRevision: 1, patch: { enabled: false } }],
};

/** No result: the server answered with an error, or a result that is one. */
function refusedCall(message: { result?: any; error?: unknown }): boolean {
  return message.error !== undefined || message.result?.isError === true;
}

test('a client that draws cards gets no 4.x tool: none is listed, and a call to one is refused', async (t) => {
  const { f, connect, modernRequest } = await harness(t, 'card-v4');
  const names = (message: { result?: any }) => (message.result.tools as Array<{ name: string }>).map(({ name }) => name);

  const cards = await connect(CARDS);
  const listed = names((await cards.request('tools/list')).message);
  assert.deepEqual(V4_TOOLS.filter((name) => listed.includes(name)), [], 'no 4.x tool is listed');
  assert.ok(listed.includes('update_agent') && listed.includes('confirm_change'), 'the 5.0 tools are');
  assert.ok(refusedCall((await cards.request('tools/call', { name: 'apply_workspace_changes', arguments: V4_OFF })).message));
  assert.ok(refusedCall((await cards.request('tools/call', { name: 'confirm_workspace_change', arguments: { proposalId: 'changeset_any' } })).message));

  const modernListed = names((await modernRequest(CARDS, 'tools/list')).message);
  assert.deepEqual(V4_TOOLS.filter((name) => modernListed.includes(name)), [], 'nor on 2026-07-28');
  assert.ok(refusedCall((await modernRequest(CARDS, 'tools/call', { name: 'apply_workspace_changes', arguments: V4_OFF })).message));
  assert.equal((await f.config.getAgent('agent_support')).enabled, true, 'nothing changed');

  // A client without cards keeps every 4.x tool, as before.
  const plain = await connect({});
  const plainListed = names((await plain.request('tools/list')).message);
  assert.deepEqual(V4_TOOLS.filter((name) => !plainListed.includes(name)), []);
  const modernPlainListed = names((await modernRequest({}, 'tools/list')).message);
  assert.deepEqual(V4_TOOLS.filter((name) => !modernPlainListed.includes(name)), []);
  const applied = (await plain.request('tools/call', { name: 'apply_workspace_changes', arguments: V4_OFF })).message;
  assert.equal(refusedCall(applied), false, JSON.stringify(applied));
  assert.match(JSON.stringify(applied.result.structuredContent), /"proposalId":"changeset_/, 'its model gets the confirmation, as before');
});

/** A later tool no card draws, which returns `result`. */
async function undrawnTool(cardHost: boolean, result: Record<string, unknown>): Promise<ToolResult> {
  const stub: FiveZeroTool = {
    title: 'Stub',
    description: 'A later write no card draws.',
    input: getWorkspaceInput,
    output: changeResultOutput,
    write: writeHints({ destructive: false }),
    run: async () => result,
  };
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'stub', version: '0' });
    registerFiveZeroTool(server, { baseUrl: BASE_URL } as FiveZeroDeps, 'stub_write' as FiveZeroToolName, stub, () => cardHost);
    return server;
  }, { legacy: 'stateless' });
  const response = await handler.fetch(jsonRequest(
    { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': LEGACY },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'stub_write', arguments: {} } },
  ));
  const text = await response.text();
  const json = text.trimStart().startsWith('{') ? text : text.split('\n').find((line) => line.startsWith('data: '))!.slice(6);
  return (JSON.parse(json) as { result: ToolResult }).result;
}

test('any tool\'s confirmation keeps its token from a card host\'s model, even one no card draws', async () => {
  const confirmation = {
    status: 'needs_confirmation',
    summary: 'This change waits for the person\'s confirmation. Nothing has changed yet.',
    confirmation: {
      confirmToken: 'changeset_stub', preview: 'Turns it off.', expiresAt: '2026-11-10T00:30:00.000Z', inAdmin: true,
      ask: { question: 'Turn it off?', consequence: 'It stops answering.', confirm: 'Turn off', keep: 'Keep it on' },
    },
  };
  const held = await undrawnTool(true, confirmation);
  assert.equal(held.isError, undefined, JSON.stringify(held));
  assert.equal(held.structuredContent!.confirmation.confirmToken, undefined);
  assert.ok(!modelView(held).includes('changeset_stub'), 'the model never sees it');
  assert.deepEqual(held._meta?.['chickpea/held'], { confirmToken: 'changeset_stub' }, 'only _meta carries it');

  // Without cards, the model keeps it, as before.
  const plain = await undrawnTool(false, confirmation);
  assert.equal(plain.structuredContent!.confirmation.confirmToken, 'changeset_stub');
  assert.equal(plain._meta, undefined);

  // An undrawn change's undo token still reaches the model.
  const done = await undrawnTool(true, { status: 'done', summary: 'Saved.', undoToken: 'undo_stub' });
  assert.equal(done.structuredContent!.undoToken, 'undo_stub');
  assert.equal(done._meta, undefined);
});

/** The 4.x tools a text names, each as a whole word: `import_skill` is not `import_skill_from_github`. */
const v4Named = (text: string) => V4_TOOLS.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
const PROMPT_ARGUMENTS: Record<string, string> = {
  purpose: 'chase overdue invoices', handle: 'support', change: 'answer in French', service: 'gmail',
  what: 'post a Monday summary', url: 'octo/skills',
};
const promptArguments = (name: WorkspaceManagementPromptName) =>
  Object.fromEntries(WORKSPACE_MANAGEMENT_PROMPTS[name].arguments.map(({ name: arg }) => [arg, PROMPT_ARGUMENTS[arg]!]));
const promptText = (message: { result?: any }) =>
  (message.result.messages as Array<{ content: { text: string } }>).map(({ content }) => content.text).join('\n');
const resourceText = (message: { result?: any }) =>
  (message.result.contents as Array<{ text?: string }>).map(({ text }) => text ?? '').join('\n');
const V4_GUIDES = [WORKSPACE_MANAGEMENT_OPERATION_SCHEMA_URI, WORKSPACE_MANAGEMENT_AGENT_AUTHORING_GUIDE_URI];

test('a client that draws cards gets no prompt or guide that tells its model to call a 4.x tool', async (t) => {
  const { connect, modernRequest } = await harness(t, 'card-v4-briefs');
  type Request = (method: string, params?: Record<string, unknown>) => Promise<{ message: { result?: any; error?: unknown } }>;
  const legs: Array<[string, Request]> = [
    ['2025 session', (await connect(CARDS)).request],
    ['2026-07-28', (method, params = {}) => modernRequest(CARDS, method, params)],
  ];
  for (const [leg, request] of legs) {
    const listed = (await request('prompts/list')).message.result.prompts as Array<{ name: string }>;
    for (const { name } of listed) {
      assert.deepEqual(v4Named(promptText((await request('prompts/get', { name, arguments: promptArguments(name as WorkspaceManagementPromptName) })).message)), [], `${leg}: ${name}`);
    }
    for (const name of WORKSPACE_MANAGEMENT_PROMPT_NAMES) {
      const got = (await request('prompts/get', { name, arguments: promptArguments(name) })).message;
      assert.ok(refusedCall(got) || v4Named(promptText(got)).length === 0, `${leg}: prompts/get ${name} names no 4.x tool`);
    }

    const resources = (await request('resources/list')).message.result.resources as Array<{ uri: string }>;
    const uris = resources.map(({ uri }) => uri);
    assert.deepEqual(V4_GUIDES.filter((uri) => uris.includes(uri)), [], `${leg}: no 4.x guide is listed`);
    assert.deepEqual(v4Named(JSON.stringify(resources)), [], leg);
    for (const { uri } of resources) {
      assert.deepEqual(v4Named(resourceText((await request('resources/read', { uri })).message)), [], `${leg}: ${uri}`);
    }
    assert.equal(resourceText((await request('resources/read', { uri: DISCOVERY_GUIDE_URI })).message), DISCOVERY_GUIDE_FIVE_ZERO,
      `${leg}: the discovery guide stays, in 5.0 terms`);
  }
});

test('a client without cards keeps every prompt and guide as before', async (t) => {
  const { connect, modernRequest } = await harness(t, 'card-none-briefs');
  type Request = (method: string, params?: Record<string, unknown>) => Promise<{ message: { result?: any } }>;
  const legs: Array<[string, Request]> = [
    ['2025', (await connect({})).request],
    ['2026-07-28', (method, params = {}) => modernRequest({}, method, params)],
  ];
  for (const [leg, request] of legs) {
    const listed = ((await request('prompts/list')).message.result.prompts as Array<{ name: string }>).map(({ name }) => name);
    assert.deepEqual(listed, [...WORKSPACE_MANAGEMENT_PROMPT_NAMES], leg);
    for (const name of WORKSPACE_MANAGEMENT_PROMPT_NAMES) {
      const args = promptArguments(name);
      assert.equal(promptText((await request('prompts/get', { name, arguments: args })).message),
        workspaceManagementPromptText(name, args, BASE_URL), `${leg}: ${name}`);
    }
    const uris = ((await request('resources/list')).message.result.resources as Array<{ uri: string }>).map(({ uri }) => uri);
    assert.deepEqual(V4_GUIDES.filter((uri) => !uris.includes(uri)), [], leg);
    assert.equal(resourceText((await request('resources/read', { uri: DISCOVERY_GUIDE_URI })).message), DISCOVERY_GUIDE, leg);
    assert.equal(resourceText((await request('resources/read', { uri: WORKSPACE_MANAGEMENT_AGENT_AUTHORING_GUIDE_URI })).message),
      JSON.stringify(codingAgentAuthoringGuideResource()), leg);
  }
});

test('only a session Chickpea named draws cards: any other session ID keeps the token where the model reads it', async (t) => {
  const { post } = await harness(t, 'card-other-session');
  const headers = { 'mcp-protocol-version': LEGACY, 'mcp-session-id': 'something-else' };
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await post({ method: 'tools/call', params: { name, arguments: args } }, headers)).result as ToolResult;
  const off = await call('update_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), on: false, idempotencyKey: 'off' });
  assert.equal(typeof off.structuredContent!.confirmation.confirmToken, 'string');
  assert.equal(off._meta?.['chickpea/held'], undefined);
});

test('a confirmation kept as it was is refused the same way, whatever changed since', async (t) => {
  const { connect } = await harness(t, 'card-keep-then-edit');
  const { call } = await connect(CARDS);
  const off = await call('update_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), on: false, idempotencyKey: 'off' });
  const { confirmToken } = off._meta!['chickpea/held'] as { confirmToken: string };
  await call('decline_change', { confirmToken });
  const edited = await call('update_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), description: 'Answers billing questions.', idempotencyKey: 'describe' });
  assert.equal(edited.structuredContent!.status, 'done');
  const refused = await call('confirm_change', { confirmToken });
  assert.equal(refused.structuredContent!.error.message, 'That confirmation no longer applies. Ask again to make the change.');
});

test('a held deletion never sends the person to Admin, which cannot delete an Agent', async (t) => {
  const { connect } = await harness(t, 'card-delete');
  const { call } = await connect(CARDS);
  const archived = await call('archive_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), idempotencyKey: 'archive' });
  const deleting = await call('delete_agent', { agentId: 'agent_support', version: archived.structuredContent!.version, idempotencyKey: 'delete' });
  const held = deleting._meta?.['chickpea/held'] as { confirmToken?: string };
  assert.equal(typeof held?.confirmToken, 'string', 'the card holds the token');
  assert.ok(!modelView(deleting).includes(held.confirmToken!), 'the model never sees it');
  assert.equal(deleting.structuredContent!.confirmation.inAdmin, false);
  assert.equal(deleting.structuredContent!.summary,
    'Nothing has changed yet. Confirm on the card above. If the card doesn\'t show, ask again in a new chat.');
});

test('an initialize that does not say its length, or is too long to be one, opens no card session', async (t) => {
  const { fetchAs } = await harness(t, 'card-length');
  const fetch = fetchAs('client_card-length');
  const initialize = (padding: string) => JSON.stringify({
    jsonrpc: '2.0', id: 0, method: 'initialize',
    params: { protocolVersion: LEGACY, capabilities: CARDS, clientInfo: { name: 'test-client', version: '1', padding } },
  });
  const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': LEGACY };
  const session = async (body: string, length?: number) => (await fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { ...headers, ...length === undefined ? {} : { 'content-length': String(length) } },
    body,
  }))).headers.get('mcp-session-id');
  const small = initialize('');
  assert.match(await session(small, Buffer.byteLength(small)) ?? '', /^chickpea-cards-/, 'one that says its length opens one');
  assert.equal(await session(small), null, 'no length: the body is never read twice');
  const large = initialize('x'.repeat(20_000));
  assert.equal(await session(large, Buffer.byteLength(large)), null);
});

test('an Agent\'s Channels in a change result are the ones it answers in', async (t) => {
  const { f, teamId, connect } = await harness(t, 'card-channels');
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_JOINING', label: 'joining', lifecycle: 'active' });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C_JOINING', agentId: 'agent_support', status: 'pending',
    createdByMembershipId: f.owner.membership.id, channelLabel: 'joining',
  });
  const { call } = await connect({});
  const described = await call('update_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), description: 'Answers billing questions.', idempotencyKey: 'describe' });
  assert.deepEqual(described.structuredContent!.agent.channels, [{ channelId: 'C_SUPPORT', name: 'support' }]);
  assert.deepEqual((await call('get_agent', { agentId: 'agent_support' })).structuredContent!.channels, [{ channelId: 'C_SUPPORT', name: 'support' }]);
});
