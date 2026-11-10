import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { POLL_BACKOFF_MAX_MS, POLL_CEILING_MS, POLL_INTERVAL_MS, type ToolResult } from '../src/mcp-cards/card-model.ts';
import { INITIAL, present, step } from '../src/mcp-cards/connect-card/model.ts';
import type { WorkspaceManagementServiceInput } from '../src/management/service.ts';
import type { ManagementSetupPublicStatus } from '../src/management/types.ts';
import { createFixtureAgent, type ManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';
import { BASE_URL, cardHost, cardServer, type ServerCall } from './helpers/mcp-card-host.ts';

/**
 * The connect card's state machine against Core's real MCP server. It may
 * read a setup link's status by itself, and check a custom connection once
 * it is connected; every other call, and opening any link, needs a press.
 */
const CONNECT_CARD = { initial: INITIAL, step, present, reads: new Set(['get_setup_status', 'check_agent']) };

async function harness(t: TestContext, suffix: string, overrides: Partial<WorkspaceManagementServiceInput> = {}) {
  const server = await cardServer(t, suffix, overrides);
  const { f, teamId } = server;
  await createFixtureAgent(f, 'agent_research', {
    slackPresence: { requestedHandle: 'research', normalizedHandle: 'research', desiredState: 'active', health: 'healthy', avatar: { kind: 'generated', revision: 1, seed: 'research' } },
  });
  // An installed Slack app, so results carry Slack's web link to it.
  const installation = await f.config.ensureWorkspaceInstallation({ workspaceId: teamId, transportMode: 'gateway', teamId, appId: 'A0CHICKPEA', defaultAgentId: 'agent_research' });
  await f.config.updateWorkspaceInstallation(teamId, { appId: 'A0CHICKPEA' }, installation.revision);
  return { ...server, card: () => cardHost(CONNECT_CARD, server.call, server.clock), finish: finisher(f) };
}

type SetupStatus = ManagementSetupPublicStatus['status'];

/** The setup page's outcome, as the service would report it: only the link's status changes. */
function finisher(f: ManagementAdapterFixture) {
  const finished = new Map<string, SetupStatus>();
  const original = f.service.getOperation.bind(f.service);
  f.service.getOperation = async (context, id) => {
    const result = await original(context, id);
    const status = finished.get(id);
    return status && result && 'setupOperationId' in result ? { ...result, status } : result;
  };
  return (setupToken: string, status: SetupStatus) => finished.set(setupToken, status);
}

const version = async (call: ServerCall, agentId = 'agent_research') => (await call('get_agent', { agentId })).structuredContent!.version as string;

/** Rows of the card, as a person reads them. */
function rows(shown: ReturnType<typeof present>): string[] {
  const block = shown.blocks.find(({ kind }) => kind === 'rows');
  return block?.kind === 'rows'
    ? block.rows.map((row) => [row.title, row.detail, row.control && `[${row.control.label}]`].filter(Boolean).join(' · '))
    : [];
}

/** A managed sign-in bound to the Agent, as the setup page or Admin leaves one. */
async function bindManaged(
  f: ManagementAdapterFixture,
  teamId: string,
  toolkit: string,
  options: { ownerKind: 'team' | 'member'; lifecycle: 'ready' | 'needs_attention' | 'pending'; label: string },
) {
  const account = await f.config.putConnectionAccount({
    id: `connection_${toolkit}_${options.ownerKind}`, workspaceId: teamId, ownerKind: options.ownerKind, providerId: toolkit, label: options.label,
    lifecycle: options.lifecycle, createdByMembershipId: f.owner.membership.id, secretRefId: `secret_${toolkit}_${options.ownerKind}`,
    ...options.ownerKind === 'member' ? { ownerMembershipId: f.owner.membership.id } : {},
    policy: {
      kind: 'managed', adapterId: 'composio', toolkit, principalRef: `chickpea:${options.ownerKind}`,
      accountRef: `account_${toolkit}_${options.ownerKind}`, allowedCapabilities: [`${toolkit}.read`],
    },
  } as never);
  await f.config.putAgentConnectionBinding({
    agentId: 'agent_research', connectionAccountId: account.id, providerId: account.providerId, allowedCapabilities: [], enabled: true,
  });
  return account;
}

test('Connect opens Chickpea\'s page for this one connection only when pressed, then follows the link until it is done', async (t) => {
  const { call, card, clock, finish } = await harness(t, 'connect-card');
  const result = await call('connect_service', { agentId: 'agent_research', service: 'Gmail', owner: 'me', idempotencyKey: 'gmail' });
  const { setup } = result.structuredContent!;
  assert.equal(result._meta?.['chickpea/tool'], 'connect_service');
  assert.deepEqual(JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text), result.structuredContent, 'a client without cards gets it all');
  assert.equal(setup.owner, 'member');

  const connect = card();
  await connect.result(result);
  assert.equal(connect.effects.length, 0, 'showing the link opens nothing');
  assert.equal(connect.shown.title, 'Connect Gmail to Research');
  assert.deepEqual(connect.shown.subtitle, [{ text: 'You sign in on Chickpea\'s page, never in this chat.' }]);
  assert.deepEqual(rows(connect.shown), ['Gmail · Your own account · [Connect]']);

  // Mounting again, coming back into view and its timer only read.
  await connect.dispatch({ type: 'reread', now: clock.now });
  await connect.dispatch({ type: 'tick', now: clock.now });
  assert.deepEqual(connect.effects.map(({ type }) => type), ['call']);
  assert.deepEqual(connect.calls().map(({ tool, args }) => [tool, args]), [['get_setup_status', { setupToken: setup.setupToken }]]);
  assert.equal(connect.state.view.kind, 'start', 'an unopened link waits for Connect');

  await connect.press('connect');
  const opened = connect.effects.filter((effect) => effect.type === 'open');
  assert.deepEqual(opened, [{ type: 'open', url: setup.url }], 'the press opens the link from the result');
  const page = new URL(setup.url);
  assert.equal(page.origin, BASE_URL);
  assert.equal(page.pathname, `/setup/${setup.setupToken}`, 'the focused page for this connection, never Admin');
  assert.deepEqual(connect.effects.at(-1), { type: 'timer', inMs: POLL_INTERVAL_MS });
  assert.deepEqual(rows(connect.shown), ['Waiting for Gmail · Finish on the Chickpea page that opened, then come back. · [I\'m done]']);

  await connect.dispatch({ type: 'tick', now: clock.now });
  assert.deepEqual(connect.effects.at(-1), { type: 'timer', inMs: POLL_INTERVAL_MS }, 'still waiting: polls again in 2 s');
  finish(setup.setupToken, 'completed');
  await connect.dispatch({ type: 'tick', now: clock.now });
  assert.equal(connect.state.view.kind, 'connected');
  assert.deepEqual(rows(connect.shown), ['Gmail is connected · [Open in Slack]'], 'a catalog service: connected, and nothing more');
  assert.deepEqual(connect.calls('check_agent'), [], 'nothing checks a catalog service');

  await connect.press('open_slack');
  assert.deepEqual(connect.effects.at(-1), { type: 'open', url: 'https://slack.com/app_redirect?team=' + (await call('get_agent', { agentId: 'agent_research' })).structuredContent!.links.slack.split('team=')[1] });
  assert.equal(connect.effects.filter(({ type }) => type === 'open').length, 2, 'two presses, two links');
});

test('"I\'m done" reads at once; a link opened from the chat is followed too', async (t) => {
  const { call, card, clock, finish } = await harness(t, 'connect-done');
  const result = await call('connect_service', { agentId: 'agent_research', service: 'Gmail', owner: 'me', idempotencyKey: 'gmail' });
  const { setupToken } = result.structuredContent!.setup;
  const connect = card();
  await connect.result(result);
  finish(setupToken, 'claimed');
  await connect.dispatch({ type: 'reread', now: clock.now });
  assert.equal(connect.state.view.kind, 'finishing', 'opened from the link in the chat');
  assert.deepEqual(connect.effects.filter(({ type }) => type === 'open'), [], 'the card opened nothing itself');

  finish(setupToken, 'completed');
  const before = connect.calls('get_setup_status').length;
  await connect.press('done');
  assert.equal(connect.calls('get_setup_status').length, before + 1, 'I\'m done reads at once');
  assert.equal(connect.state.view.kind, 'connected');
});

// Mutation proof: a stale waiting link with the connection already healthy shows connected.
test('a link still waiting after the service was connected another way shows connected', async (t) => {
  const { f, teamId, call, card, clock } = await harness(t, 'connect-elsewhere');
  const result = await call('connect_service', { agentId: 'agent_research', service: 'Gmail', owner: 'team', idempotencyKey: 'gmail-team' });
  const { setupToken } = result.structuredContent!.setup;
  const connect = card();
  await connect.result(result);
  await connect.press('connect');

  // Someone's own Gmail is not the team's: the card keeps waiting.
  await bindManaged(f, teamId, 'gmail', { ownerKind: 'member', lifecycle: 'ready', label: 'Gmail' });
  await connect.dispatch({ type: 'reread', now: clock.now });
  assert.equal(connect.state.view.kind, 'finishing');

  await bindManaged(f, teamId, 'gmail', { ownerKind: 'team', lifecycle: 'ready', label: 'Gmail' });
  const status = (await call('get_setup_status', { setupToken })).structuredContent!;
  assert.equal(status.status, 'waiting', 'the link itself was never used');
  assert.deepEqual(status.connection, { connectionId: 'connection_gmail_team', name: 'Gmail', kind: 'service', status: 'ready' });
  await connect.dispatch({ type: 'reread', now: clock.now });
  assert.equal(connect.state.view.kind, 'connected');
  assert.deepEqual(rows(connect.shown), ['Gmail is connected · [Open in Slack]']);
});

test('Reconnect: a connection that was ready says nothing about the new sign-in; one that needed attention is done once ready', async (t) => {
  const { f, teamId, call, card, clock, finish } = await harness(t, 'reconnect-card');
  const broken = await bindManaged(f, teamId, 'hubspot', { ownerKind: 'team', lifecycle: 'needs_attention', label: 'HubSpot · Team' });
  const result = await call('reconnect_service', { agentId: 'agent_research', connectionId: broken.id });
  assert.equal(result._meta?.['chickpea/tool'], 'reconnect_service');
  const connect = card();
  await connect.result(result);
  assert.equal(connect.shown.title, 'Sign HubSpot in again');
  assert.deepEqual(rows(connect.shown), ['HubSpot · For everyone who uses Research · [Reconnect]']);
  await connect.dispatch({ type: 'reread', now: clock.now });
  await connect.press('connect');
  await f.config.putConnectionAccount({ ...broken, lifecycle: 'ready' } as never, broken.revision);
  await connect.dispatch({ type: 'reread', now: clock.now });
  assert.equal(connect.state.view.kind, 'connected', 'it needed attention, and now it is ready');
  assert.deepEqual(rows(connect.shown), ['HubSpot is connected · [Open in Slack]']);

  // Signing in a working connection again, say for other access: ready says nothing about this sign-in.
  const again = await call('reconnect_service', { agentId: 'agent_research', connectionId: broken.id });
  const { setupToken } = again.structuredContent!.setup;
  const working = card();
  await working.result(again);
  await working.dispatch({ type: 'reread', now: clock.now });
  await working.press('connect');
  await working.dispatch({ type: 'reread', now: clock.now });
  assert.equal(working.state.view.kind, 'finishing', 'it waits for the link');
  finish(setupToken, 'completed');
  await working.dispatch({ type: 'tick', now: clock.now });
  assert.equal(working.state.view.kind, 'connected');
});

test('an expired, cancelled or failed link says so and asks the chat for a new one; the card never makes a link', async (t) => {
  const { call, card, clock, finish } = await harness(t, 'connect-ended');
  const link = async (key: string) => call('connect_service', { agentId: 'agent_research', service: 'Gmail', owner: 'me', idempotencyKey: key });

  const cancelledResult = await link('cancelled');
  const cancelled = card();
  await cancelled.result(cancelledResult);
  await call('cancel_setup_link', { setupToken: cancelledResult.structuredContent!.setup.setupToken });
  await cancelled.dispatch({ type: 'reread', now: clock.now });
  assert.deepEqual(rows(cancelled.shown), ['This link was cancelled · Ask for a new link to try again. · [Get a new link]']);
  await cancelled.press('new_link');
  assert.deepEqual(cancelled.effects.at(-1), { type: 'message', sent: 'Send me a new link to connect Gmail to Research.' });

  const failedResult = await link('failed');
  const failed = card();
  await failed.result(failedResult);
  await failed.press('connect');
  finish(failedResult.structuredContent!.setup.setupToken, 'failed');
  await failed.dispatch({ type: 'tick', now: clock.now });
  assert.deepEqual(rows(failed.shown), ['Gmail did not connect · Ask for a new link to try again. · [Get a new link]']);
  assert.deepEqual(failed.effects.filter(({ type }) => type === 'timer').length, 1, 'polling stops');

  const expired = card();
  await expired.result(await link('expired'));
  clock.now += 25 * 60 * 60_000;
  await expired.dispatch({ type: 'reread', now: clock.now });
  assert.deepEqual(rows(expired.shown), ['This link expired · Ask for a new link to try again. · [Get a new link]']);

  for (const ended of [cancelled, failed, expired]) {
    assert.deepEqual(ended.calls().filter(({ tool }) => tool !== 'get_setup_status'), [], 'only reads');
  }
});

test('polls every 2 s, waits longer after each failed poll, and stops at the ceiling until I\'m done', async (t) => {
  const { call, card, clock } = await harness(t, 'connect-poll');
  const connect = card();
  await connect.result(await call('connect_service', { agentId: 'agent_research', service: 'Gmail', owner: 'me', idempotencyKey: 'gmail' }));
  await connect.press('connect');
  const waits: number[] = [];
  for (let failed = 0; failed < 4; failed += 1) {
    await connect.dispatch({ type: 'unreachable', call: { tool: 'get_setup_status', args: {}, seq: connect.state.seq }, now: clock.now });
    waits.push((connect.effects.at(-1) as { inMs: number }).inMs);
  }
  assert.deepEqual(waits, [4_000, 8_000, POLL_BACKOFF_MAX_MS, POLL_BACKOFF_MAX_MS]);
  assert.equal(connect.shown.busy, false, 'a failed read leaves the buttons alone');
  await connect.dispatch({ type: 'tick', now: clock.now });
  assert.deepEqual(connect.effects.at(-1), { type: 'timer', inMs: POLL_INTERVAL_MS }, 'a poll that answers starts over at 2 s');

  clock.now += POLL_CEILING_MS;
  const timers = connect.effects.filter(({ type }) => type === 'timer').length;
  await connect.dispatch({ type: 'tick', now: clock.now });
  assert.equal(connect.effects.filter(({ type }) => type === 'timer').length, timers, 'past the ceiling it stops asking');
  assert.deepEqual(rows(connect.shown), ['Waiting for Gmail · Finish on the Chickpea page that opened, then press I\'m done. · [I\'m done]']);
  await connect.press('done');
  assert.deepEqual(connect.effects.at(-1), { type: 'timer', inMs: POLL_INTERVAL_MS }, 'I\'m done starts the polls again');
});

test('a custom connection, once ready, is checked with one request, and the card says what that check found', async (t) => {
  const tested: string[] = [];
  let outcome: { kind: 'ok'; url: string; status: number } | { kind: 'key_rejected'; status: number; detail: string } = { kind: 'ok', url: 'https://api.statusboard.example/v1/me', status: 200 };
  const { f, call, card, clock } = await harness(t, 'connect-custom', {
    testConnection: async ({ connectionId }) => {
      tested.push(connectionId);
      return outcome;
    },
  });
  const result = await call('connect_service', {
    agentId: 'agent_research',
    custom: { kind: 'api', name: 'Statusboard API', hosts: ['api.statusboard.example'], pathPrefixes: ['/v1'] },
    checkPath: '/v1/me',
    version: await version(call),
    idempotencyKey: 'statusboard',
  });
  const connect = card();
  await connect.result(result);
  assert.deepEqual(rows(connect.shown), ['Statusboard API · For everyone who uses Research · [Connect]']);
  await connect.press('connect');

  const [account] = (await f.config.listConnectionAccounts(f.owner.binding.slackTeamId!)).filter(({ label }) => label === 'Statusboard API');
  await f.config.putConnectionAccount({ ...account!, lifecycle: 'ready' } as never, account!.revision);
  await connect.dispatch({ type: 'tick', now: clock.now });
  assert.equal(connect.state.view.kind, 'connected');
  assert.deepEqual(rows(connect.shown), ['Statusboard API is connected · Chickpea checked it. Answered with HTTP 200. · [Open in Slack]']);
  assert.equal(connect.calls('check_agent').length, 1);
  await connect.dispatch({ type: 'reread', now: clock.now });
  await connect.dispatch({ type: 'tick', now: clock.now });
  assert.equal(connect.calls('check_agent').length, 1, 'checked once, never again by itself');

  outcome = { kind: 'key_rejected', status: 401, detail: 'Unauthorized' };
  const rejected = card();
  await rejected.result(result);
  await rejected.dispatch({ type: 'reread', now: clock.now });
  const row = present(rejected.state).blocks[0];
  assert.deepEqual(row?.kind === 'rows' && row.rows[0], {
    icon: 'done',
    title: 'Statusboard API is connected',
    detail: 'Chickpea checked it. The service rejected its saved key. HTTP 401. Unauthorized',
    tone: 'warn',
    control: { label: 'Open in Slack', action: 'open_slack', style: 'secondary' },
  });
});

// Mutation proof: a late reply never moves a newer view.
test('a reply that answers after the card moved on is dropped', async (t) => {
  const { call, card, clock } = await harness(t, 'connect-late');
  const result = await call('connect_service', { agentId: 'agent_research', service: 'Gmail', owner: 'me', idempotencyKey: 'gmail' });
  const connect = card();
  await connect.result(result);
  connect.hold = ({ tool }) => tool === 'get_setup_status';
  await call('cancel_setup_link', { setupToken: result.structuredContent!.setup.setupToken });
  await connect.dispatch({ type: 'reread', now: clock.now });
  await connect.press('connect');
  assert.equal(connect.state.view.kind, 'finishing');
  await connect.answer();
  assert.equal(connect.state.view.kind, 'finishing', 'the read from before Connect does not end the newer view');
  const timers = connect.effects.filter(({ type }) => type === 'timer').length;
  connect.held.length = 0;
  await connect.dispatch({ type: 'unreachable', call: { tool: 'get_setup_status', args: {}, seq: connect.state.seq - 1 }, now: clock.now });
  assert.equal(connect.effects.filter(({ type }) => type === 'timer').length, timers, 'nor does its failure count as a failed poll');
});

test('a link that is not Chickpea\'s page for one connection is never opened from the card', async (t) => {
  const { call, card } = await harness(t, 'connect-admin');
  const result = await call('connect_service', { agentId: 'agent_research', service: 'Sentry', owner: 'team', idempotencyKey: 'sentry' });
  const { setup } = result.structuredContent!;
  assert.equal(setup.setupToken, undefined);
  assert.match(setup.url, /\/admin\//);
  const connect = card();
  await connect.result(result);
  assert.deepEqual(rows(connect.shown), ['Sentry · Chickpea can\'t connect it from this card. Use the link in the chat.']);
  await connect.press('connect');
  assert.deepEqual(connect.effects, []);
});

test('a page the host would not open offers Connect again, with the reason', async (t) => {
  const { call, card, clock } = await harness(t, 'connect-refused');
  const connect = card();
  await connect.result(await call('connect_service', { agentId: 'agent_research', service: 'Gmail', owner: 'me', idempotencyKey: 'gmail' }));
  await connect.press('connect');
  await connect.dispatch({ type: 'refused', now: clock.now });
  assert.deepEqual([connect.state.view.kind, connect.shown.error], ['start', 'That did not work. Try again.']);
  assert.deepEqual(rows(connect.shown), ['Gmail · Your own account · [Connect]']);
});

test('an error or a result of the wrong shape shows nothing to press', async (t) => {
  const { call, card, clock } = await harness(t, 'connect-errors');
  const refused = card();
  await refused.result(await call('connect_service', { agentId: 'agent_research', service: 'Nonexistent Service', owner: 'me', idempotencyKey: 'x' }));
  assert.deepEqual([refused.shown.title, rows(refused.shown), refused.labels()], ['Chickpea does not list a service called Nonexistent Service.', [], []]);
  const nothing = async (): Promise<ToolResult> => ({ isError: true });
  const malformed = cardHost(CONNECT_CARD, nothing, clock);
  await malformed.result({ structuredContent: { status: 'needs_setup', summary: 'x', setup: { url: 1 } } });
  assert.equal(malformed.shown.title, 'x');
  const cancelled = cardHost(CONNECT_CARD, nothing, clock);
  await cancelled.dispatch({ type: 'no_result', now: clock.now });
  assert.equal(cancelled.shown.title, 'Nothing to show here.');
});
