import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { INITIAL, present, step } from '../src/mcp-cards/agent-card/model.ts';
import { POLL_BACKOFF_MAX_MS, POLL_CEILING_MS, POLL_INTERVAL_MS, type ToolResult } from '../src/mcp-cards/card-model.ts';
import { createFixtureAgent } from './helpers/management-adapter-fixture.ts';
import { cardHost, cardServer, NOW, type ServerCall } from './helpers/mcp-card-host.ts';

/**
 * The Agent card's state machine against Core's real MCP server: every call
 * the card makes goes to the server, and its reply comes back as the next
 * event, as a host would carry it. It may read creation status and the Agent
 * by itself; every other call needs a press.
 */
const AGENT_CARD = { initial: INITIAL, step, present, reads: new Set(['get_creation_status', 'get_agent']) };

function card(call: ServerCall, clock: { now: number }) {
  return cardHost(AGENT_CARD, call, clock);
}

async function harness(t: TestContext, suffix: string) {
  const server = await cardServer(t, suffix);
  return { ...server, card: card(server.call, server.clock) };
}

const UNREACHABLE = 'Chickpea could not be reached. Try again.';

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

  // Create on the card it moved to does nothing.
  await agentCard.press('create');
  assert.equal(agentCard.calls('create_agent').length, 1);

  // When the model calls create_agent itself, the card it gets follows the arrival too.
  const fromModel = card(call, clock);
  await fromModel.result(await call('create_agent', create!.args));
  assert.deepEqual([fromModel.state.view.kind, fromModel.calls().map(({ tool }) => tool)], ['creating', ['get_creation_status']]);

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
  assert.deepEqual(agentCard.calls('undo_change').map(({ args }) => args), [{ undoToken, idempotencyKey: `undo:${undoToken}` }]);
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

// Defect caught: a retried write's late second answer landed on a newer view while another write was in flight.
test('a retried confirm\'s second answer, or its timeout, never moves the card while Undo is in flight', async (t) => {
  const { f, call, card: agentCard, clock, teamId } = await harness(t, 'card-late-retry');
  await createFixtureAgent(f, 'agent_support');
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_SUPPORT', label: 'support', lifecycle: 'active' });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C_SUPPORT', agentId: 'agent_support', status: 'active',
    createdByMembershipId: f.owner.membership.id, channelLabel: 'support',
  });
  const read = (await call('get_agent', { agentId: 'agent_support' })).structuredContent!;
  await agentCard.result(await call('update_agent', { agentId: 'agent_support', version: read.version, on: false, idempotencyKey: 'off' }));
  agentCard.hold = ({ tool }) => tool === 'confirm_change' || tool === 'undo_change';

  await agentCard.press('confirm');
  const [first] = agentCard.held;
  await agentCard.answer('unreachable');
  await agentCard.press('confirm');
  const [retry] = agentCard.held;
  agentCard.held.length = 0;
  // The first confirm's answer arrives late: the change applied, and Undo is offered.
  await agentCard.dispatch({ type: 'reply', call: first!.call, result: first!.result, now: clock.now });
  assert.equal(agentCard.state.view.kind, 'done');
  await agentCard.press('undo');
  assert.equal(agentCard.shown.busy, true);

  await agentCard.dispatch({ type: 'reply', call: retry!.call, result: retry!.result, now: clock.now });
  await agentCard.dispatch({ type: 'unreachable', call: retry!.call, now: clock.now });
  assert.deepEqual([agentCard.state.view.kind, agentCard.shown.busy], ['done', true], 'the older call\'s answers are dropped');
  assert.equal(agentCard.calls('undo_change').length, 1, 'no second undo goes out');
});

test('a read that answers after the card moved on is dropped', async (t) => {
  const { f, call, card: agentCard, clock } = await harness(t, 'card-stale');
  await createFixtureAgent(f, 'agent_invoices');
  const read = (await call('get_agent', { agentId: 'agent_invoices' })).structuredContent!;
  const preview = await call('propose_agent_change', { agentId: 'agent_invoices', version: read.version, change: { name: 'Invoices' } });
  await agentCard.result(preview);
  agentCard.hold = ({ tool }) => tool === 'get_agent';
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

test('two presses before the reply make one call, and a reply after the host gave up still counts', async (t) => {
  const { f, call, card: agentCard, clock } = await harness(t, 'card-double');
  await agentCard.result(await call('propose_agent', PROPOSAL));
  agentCard.hold = ({ tool }) => tool === 'create_agent';
  await agentCard.press('create');
  await agentCard.press('create');
  assert.equal(agentCard.calls('create_agent').length, 1, 'the second press waits for the first');
  assert.equal(agentCard.shown.busy, true);

  const [made] = agentCard.held;
  await agentCard.answer('unreachable');
  assert.deepEqual([agentCard.shown.busy, agentCard.shown.error], [false, UNREACHABLE], 'the buttons come back with the reason');
  assert.equal(agentCard.state.view.kind, 'proposal');

  // The host's answer comes after all: the Agent exists, and the card follows its arrival.
  await agentCard.dispatch({ type: 'reply', call: made!.call, result: made!.result, now: clock.now });
  assert.equal(agentCard.state.view.kind, 'creating');
  assert.equal(agentCard.shown.error, undefined);
  assert.equal((await f.config.listAgents()).filter(({ name }) => name === 'Invoice Chaser').length, 1);
});

test('Create it anyway, pressed again after a timeout, replays its first call: exactly one Agent', async (t) => {
  const { f, call, card: agentCard, clock } = await harness(t, 'card-anyway');
  await createFixtureAgent(f, 'agent_chaser', { name: 'Invoice Chaser' });
  const proposal = await call('propose_agent', PROPOSAL);
  await agentCard.result(proposal);
  await agentCard.press('create');
  assert.equal(agentCard.shown.title, 'An Agent like this already exists');
  assert.deepEqual(agentCard.labels(), ['Create it anyway (primary)', 'Change something (secondary)']);
  assert.equal(agentCard.calls('create_agent').length, 1, 'the reply that found a similar Agent created nothing by itself');

  agentCard.hold = ({ tool }) => tool === 'create_agent';
  await agentCard.press('create_anyway');
  await agentCard.press('create_anyway');
  const [first] = agentCard.held;
  await agentCard.answer('unreachable');
  assert.deepEqual([agentCard.state.view.kind, agentCard.shown.busy, agentCard.shown.error], ['similar', false, UNREACHABLE]);
  await agentCard.press('create_anyway');
  const [, anyway, retry] = agentCard.calls('create_agent');
  assert.equal(agentCard.calls('create_agent').length, 3);
  assert.deepEqual(retry!.args, anyway!.args, 'the same call again, so the server replays it');
  assert.deepEqual([anyway!.args.createEvenIfSimilar, anyway!.args.idempotencyKey],
    [true, `${proposal.structuredContent!.create.arguments.idempotencyKey}:anyway`]);
  await agentCard.answer();
  assert.equal(agentCard.state.view.kind, 'creating');
  assert.deepEqual((await f.config.listAgents()).filter(({ name }) => name === 'Invoice Chaser').length, 2, 'the one before and one new');

  // The first call's own answer, late: the card has moved on and does not start over.
  const polls = agentCard.calls('get_creation_status').length;
  await agentCard.dispatch({ type: 'reply', call: first!.call, result: first!.result, now: clock.now });
  assert.equal(agentCard.calls('get_creation_status').length, polls);
});

test('Undo, pressed again after a timeout, replays: one undo applies and the card says it worked', async (t) => {
  const { f, call, card: agentCard } = await harness(t, 'card-undo-retry');
  await createFixtureAgent(f, 'agent_invoices');
  const read = (await call('get_agent', { agentId: 'agent_invoices' })).structuredContent!;
  await agentCard.result(await call('propose_agent_change', { agentId: 'agent_invoices', version: read.version, change: { description: 'Chases overdue invoices.' } }));
  await agentCard.press('save');
  const { undoToken } = agentCard.state.view as { undoToken?: string };

  agentCard.hold = ({ tool }) => tool === 'undo_change';
  await agentCard.press('undo');
  await agentCard.answer('unreachable');
  assert.deepEqual([agentCard.shown.error, agentCard.labels()], [UNREACHABLE, ['Undo (secondary)']]);
  await agentCard.press('undo');
  assert.deepEqual(agentCard.calls('undo_change').map(({ args }) => args), [
    { undoToken, idempotencyKey: `undo:${undoToken}` },
    { undoToken, idempotencyKey: `undo:${undoToken}` },
  ]);
  await agentCard.answer();
  assert.deepEqual([agentCard.shown.title, agentCard.shown.error], ['Undid the change', undefined], 'a replay, not "nothing to undo"');
  assert.equal((await f.config.getAgent('agent_invoices')).description, read.description);
});

test('a failed read never frees the buttons while a write is in flight', async (t) => {
  const { f, call, card: agentCard, clock } = await harness(t, 'card-read-fails');
  await createFixtureAgent(f, 'agent_invoices');
  const read = (await call('get_agent', { agentId: 'agent_invoices' })).structuredContent!;
  await agentCard.result(await call('propose_agent_change', { agentId: 'agent_invoices', version: read.version, change: { description: 'Chases overdue invoices.' } }));
  await agentCard.press('save');

  agentCard.hold = ({ tool }) => tool === 'get_agent' || tool === 'undo_change';
  await agentCard.dispatch({ type: 'reread', now: clock.now });
  await agentCard.press('undo');
  await agentCard.answer('unreachable');
  assert.deepEqual([agentCard.shown.busy, agentCard.shown.error], [true, undefined], 'Undo still waits');
  await agentCard.press('undo');
  assert.equal(agentCard.calls('undo_change').length, 1);
  await agentCard.answer();
  assert.equal(agentCard.shown.title, 'Undid the change');
});

test('a failed poll is not a failed write: polling goes on, waiting longer each time, then offers Check again', async (t) => {
  const { call, card: agentCard, clock } = await harness(t, 'card-poll-fails');
  await agentCard.result(await call('propose_agent', PROPOSAL));
  await agentCard.press('create');
  const lastTimer = () => agentCard.effects.findLast(({ type }) => type === 'timer');

  agentCard.hold = ({ tool }) => tool === 'get_creation_status';
  const waits: number[] = [];
  for (let failed = 0; failed < 4; failed++) {
    await agentCard.dispatch({ type: 'tick', now: clock.now });
    const timers = agentCard.effects.length;
    await agentCard.answer('unreachable');
    assert.equal(agentCard.effects.length, timers + 1, 'one timer for the next poll');
    waits.push((lastTimer() as { inMs: number }).inMs);
    assert.deepEqual([agentCard.shown.error, agentCard.labels()], [undefined, []], 'a failed read shows no error');
  }
  assert.deepEqual(waits, [2 * POLL_INTERVAL_MS, 4 * POLL_INTERVAL_MS, POLL_BACKOFF_MAX_MS, POLL_BACKOFF_MAX_MS]);

  // A poll that answers goes back to every 2 s.
  await agentCard.dispatch({ type: 'tick', now: clock.now });
  await agentCard.answer();
  assert.deepEqual(lastTimer(), { type: 'timer', inMs: POLL_INTERVAL_MS });

  // A poll an earlier view made fails late: it starts no second round of polling.
  await agentCard.dispatch({ type: 'reread', now: clock.now });
  await agentCard.dispatch({ type: 'tick', now: clock.now });
  await agentCard.answer();
  const before = agentCard.effects.length;
  await agentCard.answer('unreachable');
  assert.equal(agentCard.effects.length, before);

  // Past the ceiling a failure stops asking and offers Check again.
  clock.now += POLL_CEILING_MS;
  await agentCard.dispatch({ type: 'tick', now: clock.now });
  const atCeiling = agentCard.effects.length;
  await agentCard.answer('unreachable');
  assert.equal(agentCard.effects.length, atCeiling, 'no timer');
  assert.deepEqual(agentCard.labels(), ['Check again (secondary)']);

  // Check again starts over: its first failure waits 4 s again.
  await agentCard.press('check_again');
  await agentCard.answer('unreachable');
  assert.deepEqual(lastTimer(), { type: 'timer', inMs: 2 * POLL_INTERVAL_MS });
});

test('the creating steps follow get_creation_status', async (t) => {
  const { f, call, card: agentCard, clock, teamId } = await harness(t, 'card-steps');
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_FINANCE', label: 'finance', lifecycle: 'active' });
  await agentCard.result(await call('propose_agent', { ...PROPOSAL, channels: ['#finance'] }));
  await agentCard.press('create');
  const { agentId } = agentCard.state.view as { agentId: string };
  const shownFor = async (stage: string, channels: string) => {
    await agentCard.dispatch({
      type: 'reply',
      call: { tool: 'get_creation_status', args: { agentId }, seq: agentCard.state.seq },
      result: { structuredContent: { stage, channels, agent: { name: 'Invoice Chaser', handle: 'invoices' } } },
      now: clock.now,
    });
    const [block] = agentCard.shown.blocks;
    return block?.kind === 'steps' ? block.steps.map(({ label, state }) => `${label}: ${state}`) : [agentCard.shown.title];
  };
  const created = 'Created in Chickpea: done';
  assert.deepEqual(await shownFor('joining', 'joining'),
    [created, 'Joining Slack as @invoices: now', 'Saying hello to you: todo', 'Joining #finance: todo']);
  assert.deepEqual(await shownFor('said_hello', 'joining'),
    [created, 'Joining Slack as @invoices: done', 'Saying hello to you: done', 'Joining #finance: now']);
  assert.deepEqual(await shownFor('ready', 'joining'),
    [created, 'Joining Slack as @invoices: done', 'Joining #finance: now'], 'no hello is coming');
  assert.deepEqual(await shownFor('joining', 'joined'),
    [created, 'Joining Slack as @invoices: now', 'Saying hello to you: todo', 'Joining #finance: done']);
  assert.deepEqual(await shownFor('joining', 'needs_attention'),
    [created, 'Joining Slack as @invoices: now', 'Saying hello to you: todo', 'Joining #finance: failed']);
  assert.deepEqual(await shownFor('needs_attention', 'joining'), ['Invoice Chaser needs attention in Slack'],
    'a problem shows at once, though a Channel still joins');
});

test('a Channel without a name shows as a private Channel, never its ID', async (t) => {
  const { f, call, card: agentCard, teamId } = await harness(t, 'card-private');
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C0PRIVATE1', lifecycle: 'active' });
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_FINANCE', label: 'finance', lifecycle: 'active' });
  await agentCard.result(await call('propose_agent', { ...PROPOSAL, channels: ['C0PRIVATE1', '#finance'] }));
  const facts = agentCard.shown.blocks.find((block) => block.kind === 'facts');
  assert.deepEqual(facts?.kind === 'facts' && facts.rows[0], { label: 'Answers in', value: 'Your DMs · #finance · a private Channel' });
});

test('a result that is not the shape it claims, or a host that sends none, shows nothing to press', async () => {
  const nothing = async (): Promise<ToolResult> => ({ isError: true });
  const clock = { now: NOW };
  for (const structuredContent of [
    { proposal: { name: 'Invoice Chaser' }, create: { arguments: {} } },
    { changes: [{ field: 'name' }], save: { arguments: {} } },
  ]) {
    const malformed = card(nothing, clock);
    await malformed.result({ structuredContent });
    assert.deepEqual([malformed.shown.title, malformed.labels()], ['Nothing to show here.', []]);
  }

  const cancelled = card(nothing, clock);
  await cancelled.dispatch({ type: 'no_result', now: clock.now });
  assert.deepEqual([cancelled.shown.title, cancelled.labels()], ['Nothing to show here.', []]);
  await cancelled.result({ structuredContent: { status: 'done', summary: 'Saved Invoice Chaser.' } });
  await cancelled.dispatch({ type: 'no_result', now: clock.now });
  assert.equal(cancelled.shown.title, 'Saved Invoice Chaser', 'a card that has its result keeps it');

  // A link or a message the host would not take says so.
  await cancelled.dispatch({ type: 'refused', effect: { type: 'open', url: 'https://slack.com/app_redirect' }, now: clock.now });
  assert.equal(cancelled.shown.error, 'That did not work. Try again.');
});
