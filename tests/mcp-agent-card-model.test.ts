import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createMcpHandler } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import { createWorkspaceManagementMcpServer } from '../src/management/mcp.ts';
import {
  INITIAL,
  POLL_CEILING_MS,
  POLL_INTERVAL_MS,
  present,
  step,
  type Action,
  type Call,
  type Effect,
  type Event,
  type Presentation,
  type State,
  type ToolResult,
} from '../src/mcp-cards/agent-card/model.ts';
import { SLACK_SETTING_KEYS } from '../src/slack/credentials.ts';
import { createFixtureAgent, createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const NOW = 1_800_000_000_000;

/**
 * The card's state machine against Core's real MCP server: every call the
 * card makes goes to the server, and its reply comes back as the next event,
 * as a host would carry it.
 */
async function harness(t: TestContext, suffix: string) {
  const clock = { now: NOW };
  const f = await createManagementAdapterFixture(suffix, ({ settings }) => ({ settings, now: () => clock.now }));
  t.after(() => f.close());
  await f.settings.setSetting(SLACK_SETTING_KEYS.teamName, 'Acme');
  const principal: McpAuthenticatedPrincipal = {
    betterAuthUserId: f.owner.binding.betterAuthUserId ?? 'ba_owner',
    userId: f.owner.user.id,
    membershipId: f.owner.membership.id,
    organizationId: f.owner.membership.organizationId,
    role: 'owner',
    clientId: `client_${suffix}`,
  };
  const handler = createMcpHandler(
    () => createWorkspaceManagementMcpServer({ principal, service: f.service, baseUrl: 'https://chickpea.example.test' }),
    { legacy: 'stateless' },
  );
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult & { structuredContent?: any }> => {
    const response = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }));
    const body = await response.text();
    const json = body.trimStart().startsWith('{') ? body : body.split('\n').find((line) => line.startsWith('data: '))!.slice(6);
    return (JSON.parse(json) as { result: ToolResult }).result;
  };
  return { f, clock, call, card: card(call, clock), teamId: f.owner.binding.slackTeamId };
}

/** A host for the model: it runs calls on the server, records every effect, and checks every presentation. */
function card(server: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>, clock: { now: number }) {
  let state: State = INITIAL;
  let keys = 0;
  const effects: Effect[] = [];
  const held: Array<{ call: Call; result: ToolResult }> = [];
  const self = {
    get state() { return state; },
    get shown(): Presentation { return present(state); },
    effects,
    /** Calls made, by tool name. */
    calls: (tool?: string) => effects.flatMap((effect) => effect.type === 'call' && (!tool || effect.call.tool === tool) ? [effect.call] : []),
    /** With `hold`, read replies wait in `held` instead of arriving. */
    hold: false,
    held,
    async dispatch(event: Event): Promise<void> {
      const next = step(state, event);
      state = next.state;
      const shown = present(state);
      assert.ok(shown.buttons.length <= 2, `at most two buttons: ${JSON.stringify(shown.buttons)}`);
      for (const effect of next.effects) {
        effects.push(effect);
        if (effect.type !== 'call') continue;
        const result = await server(effect.call.tool, effect.call.args);
        if (self.hold && effect.call.tool === 'get_agent') held.push({ call: effect.call, result });
        else await self.dispatch({ type: 'reply', call: effect.call, result, now: clock.now });
      }
    },
    result: (result: ToolResult) => self.dispatch({ type: 'result', result, now: clock.now }),
    press: (action: Action) => self.dispatch({ type: 'press', action, key: `key-${++keys}`, now: clock.now }),
    labels: () => present(state).buttons.map(({ label, tone }) => `${label} (${tone})`),
  };
  return self;
}

const PROPOSAL = {
  name: 'Invoice Chaser',
  handle: 'invoices',
  job: 'Chases invoices more than 30 days overdue and posts a summary every Monday.',
  instructions: '# Job\nChase invoices.\n\n## Tone\nBe brief.',
  sampleAsk: 'who is overdue this week?',
  promisedAnswer: 'I list every invoice past 30 days with the customer, amount and days overdue.',
  services: ['Stripe'],
};

test('Create in Slack sends the proposal\'s create_agent arguments unchanged, then follows the arrival', async (t) => {
  const { call, card: agentCard, clock } = await harness(t, 'card-create');
  const proposal = await call('propose_agent', PROPOSAL);
  await agentCard.result(proposal);
  const shown = agentCard.shown;
  assert.equal(shown.title, 'Invoice Chaser');
  assert.equal(shown.foot, 'Everyone in Acme\'s Slack can message it.', 'who can message it sits right above the button');
  assert.deepEqual(agentCard.labels(), ['Create in Slack (primary)', 'Change something (secondary)']);
  assert.deepEqual(agentCard.effects, [], 'showing a proposal does nothing');

  await agentCard.press('change_something');
  assert.deepEqual(agentCard.effects, [{
    type: 'message',
    draft: 'Change Invoice Chaser: ',
    sent: 'I want to change something about Invoice Chaser before you create it.',
  }], 'Change something talks to the chat and calls no tool');

  await agentCard.press('create');
  const [create] = agentCard.calls('create_agent');
  assert.deepEqual(create!.args, proposal.structuredContent!.create.arguments, 'the exact arguments');
  assert.equal(agentCard.state.view.kind, 'creating');
  const agentId = (agentCard.state.view as { agentId: string }).agentId;
  assert.deepEqual(agentCard.calls('get_creation_status').map(({ args }) => args), [{ agentId }]);
  assert.deepEqual(agentCard.effects.at(-1), { type: 'timer', inMs: POLL_INTERVAL_MS }, 'still joining: polls again in 2 s');
  assert.deepEqual(agentCard.shown.blocks[0], {
    kind: 'steps',
    steps: [
      { label: 'Created in Chickpea', state: 'done' },
      { label: 'Joining Slack as @invoices', state: 'now' },
      { label: 'Saying hello to you', state: 'todo' },
    ],
  });
  assert.equal(agentCard.calls('create_agent').length, 1);

  // A second press while it works, or a remount showing the same card, creates nothing new.
  await agentCard.press('create');
  assert.equal(agentCard.calls('create_agent').length, 1);

  await agentCard.dispatch({ type: 'tick', now: clock.now });
  assert.equal(agentCard.calls('get_creation_status').length, 2);
  const timers = () => agentCard.effects.filter(({ type }) => type === 'timer').length;
  const before = timers();
  clock.now += POLL_CEILING_MS;
  await agentCard.dispatch({ type: 'tick', now: clock.now });
  assert.equal(timers(), before, 'past the ceiling it stops asking');
  assert.deepEqual(agentCard.labels(), ['Check again (secondary)']);

  const hello = 'Hi — I’m Invoice Chaser (@invoices).\n\nTry asking me: “who is overdue this week?”';
  await agentCard.dispatch({
    type: 'reply',
    call: { tool: 'get_creation_status', args: { agentId }, seq: agentCard.state.seq },
    result: { structuredContent: { stage: 'said_hello', agent: { name: 'Invoice Chaser', handle: 'invoices' }, channels: 'none', slackUrl: 'https://slack.com/app_redirect?team=T1&app=A1', hello } },
    now: clock.now,
  });
  assert.equal(agentCard.shown.title, '@invoices said hello to you in Slack');
  assert.deepEqual(agentCard.shown.blocks, [{ kind: 'quote', text: hello }]);
  assert.deepEqual(agentCard.labels(), ['Open in Slack (primary)', 'Connect Stripe (secondary)']);
  await agentCard.press('open_slack');
  await agentCard.press('next_step');
  assert.deepEqual(agentCard.effects.slice(-2), [
    { type: 'open', url: 'https://slack.com/app_redirect?team=T1&app=A1' },
    { type: 'message', sent: 'Connect Stripe to Invoice Chaser.' },
  ]);
});

test('Save sends propose_agent_change\'s update_agent arguments, and Undo hides once something else changes the Agent', async (t) => {
  const { f, call, card: agentCard, clock } = await harness(t, 'card-change');
  await createFixtureAgent(f, 'agent_invoices');
  const read = (await call('get_agent', { agentId: 'agent_invoices' })).structuredContent!;
  const preview = await call('propose_agent_change', {
    agentId: 'agent_invoices',
    version: read.version,
    change: { instructions: `${read.instructions}\n\n## Tone\nKeep each message under three sentences.`, description: 'Chases overdue invoices on Mondays and Thursdays.' },
  });
  await agentCard.result(preview);
  assert.equal(agentCard.shown.title, `Change ${read.name}`);
  assert.deepEqual(agentCard.shown.subtitle, [{ text: '2 changes · nothing is saved until you press Save' }]);
  assert.deepEqual(agentCard.shown.blocks, [
    { kind: 'section', label: 'Description' },
    { kind: 'text', text: 'Chases overdue invoices on Mondays and Thursdays.' },
    { kind: 'note', text: 'Was: Not set' },
    { kind: 'section', label: 'Instructions' },
    { kind: 'quote', text: 'Adds a new section, “Tone”: “Keep each message under three sentences.”' },
  ], 'the key details of the edit, in the words Slack approvals use');
  assert.deepEqual(agentCard.labels(), ['Save (primary)', 'Cancel (secondary)']);

  await agentCard.press('save');
  assert.deepEqual(agentCard.calls('update_agent').map(({ args }) => args), [preview.structuredContent!.save.arguments]);
  assert.equal(agentCard.shown.title, `Saved ${read.name}`);
  assert.equal(agentCard.shown.done, true);
  assert.deepEqual(agentCard.labels(), ['Undo (secondary)']);

  const { undoToken } = agentCard.state.view as { undoToken?: string };
  assert.ok(undoToken);
  await agentCard.press('undo');
  assert.deepEqual(agentCard.calls('undo_change').map(({ args }) => args), [{ undoToken, idempotencyKey: 'key-2' }]);
  assert.equal(agentCard.shown.title, 'Undid the change');
  assert.equal((await call('get_agent', { agentId: 'agent_invoices' })).structuredContent!.description, read.description);

  // Undo stays while the Agent is as the undo left it.
  clock.now += 5_000;
  await agentCard.dispatch({ type: 'reread', now: clock.now });
  assert.deepEqual(agentCard.labels(), ['Undo (secondary)']);
  // Someone changes it elsewhere: the card no longer offers to undo.
  const now = (await call('get_agent', { agentId: 'agent_invoices' })).structuredContent!;
  await call('update_agent', { agentId: 'agent_invoices', version: now.version, name: 'Invoices', idempotencyKey: 'elsewhere' });
  await agentCard.dispatch({ type: 'reread', now: clock.now });
  assert.deepEqual(agentCard.labels(), []);
});

test('a destructive confirmation waits for the click: no mount, focus or timer confirms it', async (t) => {
  const { f, call, card: agentCard, clock, teamId } = await harness(t, 'card-confirm');
  await createFixtureAgent(f, 'agent_support');
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_SUPPORT', label: 'support', lifecycle: 'active' });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C_SUPPORT', agentId: 'agent_support', status: 'active',
    createdByMembershipId: f.owner.membership.id, channelLabel: 'support',
  });
  const read = (await call('get_agent', { agentId: 'agent_support' })).structuredContent!;
  const pending = await call('update_agent', { agentId: 'agent_support', version: read.version, on: false, idempotencyKey: 'off' });
  const { ask } = pending.structuredContent!.confirmation;

  await agentCard.result(pending);
  await agentCard.dispatch({ type: 'reread', now: clock.now });
  clock.now += 60_000;
  await agentCard.dispatch({ type: 'tick', now: clock.now });
  await agentCard.dispatch({ type: 'reread', now: clock.now });
  assert.deepEqual(agentCard.calls('confirm_change'), [], 'nothing but a press confirms');
  assert.equal((await f.config.getAgent('agent_support')).enabled, true);
  assert.equal(agentCard.shown.title, ask.question);
  assert.equal(agentCard.shown.avatar, 'alert');
  assert.deepEqual(agentCard.labels(), [`${ask.confirm} (danger)`, `${ask.keep} (secondary)`]);
  assert.deepEqual(agentCard.labels(), ['Turn off (danger)', 'Keep it on (secondary)']);

  await agentCard.press('confirm');
  assert.deepEqual(agentCard.calls('confirm_change').map(({ args }) => args), [{ confirmToken: ask && pending.structuredContent!.confirmation.confirmToken }]);
  assert.equal((await f.config.getAgent('agent_support')).enabled, false);
  assert.equal(agentCard.shown.title, 'Made the change you confirmed');
  assert.deepEqual(agentCard.labels(), ['Undo (secondary)'], 'a confirmed turn-off can be undone');
});

test('Keep changes nothing, and an expired confirmation cannot be confirmed', async (t) => {
  const { f, call, card: agentCard, clock, teamId } = await harness(t, 'card-expire');
  await createFixtureAgent(f, 'agent_support');
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_SUPPORT', label: 'support', lifecycle: 'active' });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C_SUPPORT', agentId: 'agent_support', status: 'active',
    createdByMembershipId: f.owner.membership.id, channelLabel: 'support',
  });
  const read = (await call('get_agent', { agentId: 'agent_support' })).structuredContent!;
  const pending = await call('update_agent', { agentId: 'agent_support', version: read.version, on: false, idempotencyKey: 'off' });

  await agentCard.result(pending);
  assert.deepEqual(agentCard.effects, [{ type: 'timer', inMs: 30 * 60_000 }], 'it will say when the token expires');
  await agentCard.press('keep');
  assert.deepEqual([agentCard.shown.title, agentCard.calls()], ['Kept as it is', []]);

  const later = card(call, clock);
  await later.result(pending);
  clock.now = Date.parse(pending.structuredContent!.confirmation.expiresAt);
  await later.dispatch({ type: 'reread', now: clock.now });
  assert.equal(later.shown.title, 'This confirmation expired');
  await later.press('confirm');
  assert.deepEqual(later.calls(), []);

  // A card that mounts after the token expired says so at once.
  const mountedLate = card(call, clock);
  await mountedLate.result(pending);
  assert.equal(mountedLate.shown.title, 'This confirmation expired');

  // Pressed after it expired, before the card noticed: still nothing is sent.
  const unnoticed = card(call, clock);
  clock.now = NOW;
  await unnoticed.result(pending);
  clock.now = Date.parse(pending.structuredContent!.confirmation.expiresAt);
  await unnoticed.press('confirm');
  assert.deepEqual([unnoticed.calls(), unnoticed.shown.title], [[], 'This confirmation expired']);
  assert.equal((await f.config.getAgent('agent_support')).enabled, true);
});

test('a read that answers after the card moved on is dropped', async (t) => {
  const { f, call, card: agentCard, clock } = await harness(t, 'card-stale');
  await createFixtureAgent(f, 'agent_invoices');
  const read = (await call('get_agent', { agentId: 'agent_invoices' })).structuredContent!;
  const preview = await call('propose_agent_change', { agentId: 'agent_invoices', version: read.version, change: { name: 'Invoices' } });
  await agentCard.result(preview);
  agentCard.hold = true;
  await agentCard.dispatch({ type: 'reread', now: clock.now });
  await agentCard.press('save');
  assert.deepEqual(agentCard.labels(), ['Undo (secondary)']);
  const [late] = agentCard.held;
  await agentCard.dispatch({ type: 'reply', call: late!.call, result: late!.result, now: clock.now });
  assert.deepEqual(agentCard.labels(), ['Undo (secondary)'], 'the old version from before Save does not hide Undo');
});

test('a refused call keeps the card where it was, with the reason and its buttons', async (t) => {
  const { call, card: agentCard } = await harness(t, 'card-refused');
  const proposal = await call('propose_agent', PROPOSAL);
  await agentCard.result({ ...proposal, structuredContent: { ...proposal.structuredContent, create: { ...proposal.structuredContent!.create, arguments: { ...proposal.structuredContent!.create.arguments, channels: ['#nowhere'] } } } });
  await agentCard.press('create');
  assert.equal(agentCard.state.view.kind, 'proposal');
  assert.equal(agentCard.shown.busy, false);
  assert.match(agentCard.shown.error ?? '', /No Slack Channel you are in is called #nowhere/);
  assert.deepEqual(agentCard.labels(), ['Create in Slack (primary)', 'Change something (secondary)']);
});
