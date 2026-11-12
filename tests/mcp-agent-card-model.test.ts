import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { INITIAL, present, step, type Action, type View } from '../src/mcp-cards/agent-card/model.ts';
import {
  POLL_BACKOFF_MAX_MS,
  POLL_CEILING_MS,
  POLL_INTERVAL_MS,
  withResponseMeta,
  type Block,
  type Effect,
  type ToolResult,
} from '../src/mcp-cards/card-model.ts';
import { createFixtureAgent } from './helpers/management-adapter-fixture.ts';
import { BASE_URL, cardHost, cardServer, NOW, type CardModelUnderTest, type ServerCall } from './helpers/mcp-card-host.ts';

/**
 * The Agent card's state machine against Core's real MCP server: every call
 * the card makes goes to the server, and its reply comes back as the next
 * event, as a host would carry it. It may read creation status and the Agent
 * by itself; every other call needs a press.
 */
const AGENT_CARD: CardModelUnderTest<View, Action> = {
  initial: INITIAL,
  step,
  present,
  reads: new Set(['get_creation_status', 'get_agent', 'get_confirmation']),
  // A creation the person pressed Create for: its polls may tell the model it is ready.
  followsPress: ({ view }) => view.kind === 'creating' && view.byPress === true,
};

function card(call: ServerCall, clock: { now: number }) {
  return cardHost(AGENT_CARD, call, clock);
}

async function harness(t: TestContext, suffix: string) {
  const server = await cardServer(t, suffix);
  return { ...server, card: card(server.call, server.clock) };
}

const UNREACHABLE = 'Chickpea could not be reached. Try again.';

/** A block as one line: stressed words in **, chips in [], and an exchange as its two speakers. */
function words(block: Block | undefined): string {
  switch (block?.kind) {
    case 'exchange':
      return `You: ${block.ask} / ${block.agent}: ${block.answer}`;
    case 'line':
      return block.parts.map((part) => 'chip' in part ? `[${part.chip}]` : part.strong ? `**${part.text}**` : part.text).join('');
    case 'text':
    case 'note':
      return block.text;
    default:
      return String(block?.kind);
  }
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
  assert.deepEqual(shown.subtitle, [{ text: '@invoices' }], 'the handle, and no "handle is free"');
  assert.deepEqual(shown.blocks.map(words), [
    `You: ${PROPOSAL.sampleAsk} / Invoice Chaser: ${PROPOSAL.promisedAnswer}`,
    'Answers in **your DMs**. Anyone in Acme can message it.',
    'Needs [Stripe] · you sign in after it\'s created',
  ], 'shown by example, then where it answers and who can message it, then the service it needs');
  assert.equal(shown.foot, undefined, 'who can message it is on the line with where it answers');
  assert.deepEqual(agentCard.labels(), ['Create in Slack (primary)', 'Change something (secondary)']);
  assert.deepEqual(agentCard.effects, [], 'showing a proposal does nothing');

  await agentCard.press('change_something');
  assert.deepEqual(agentCard.effects, [{
    type: 'message',
    draft: 'Change Invoice Chaser: ',
    sent: 'Change Invoice Chaser: ',
  }], 'Change something talks to the chat in the same words on every host, and calls no tool');

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
  // Undo stays while the Agent is as the save left it.
  clock.now += 5_000;
  await agentCard.dispatch({ type: 'reread', now: clock.now });
  assert.deepEqual(agentCard.labels(), ['Undo (secondary)']);
  await agentCard.press('undo');
  assert.deepEqual(agentCard.calls('undo_change').map(({ args }) => args), [{ undoToken, idempotencyKey: `undo:${undoToken}` }]);
  assert.equal(agentCard.shown.title, 'Undid the change');
  assert.deepEqual(agentCard.labels(), [], 'an undo offers no second undo, which would redo the change');
  assert.equal((await call('get_agent', { agentId: 'agent_invoices' })).structuredContent!.description, read.description);

  // Someone changes it elsewhere: a card that offered Undo no longer does.
  const saved = card(call, clock);
  const again = (await call('get_agent', { agentId: 'agent_invoices' })).structuredContent!;
  await saved.result(await call('update_agent', { agentId: 'agent_invoices', version: again.version, description: 'Chases invoices.', idempotencyKey: 'again' }));
  assert.deepEqual(saved.labels(), ['Undo (secondary)']);
  const now = (await call('get_agent', { agentId: 'agent_invoices' })).structuredContent!;
  await call('update_agent', { agentId: 'agent_invoices', version: now.version, name: 'Invoices', idempotencyKey: 'elsewhere' });
  await saved.dispatch({ type: 'reread', now: clock.now });
  assert.deepEqual(saved.labels(), []);
});

// Mutation proof: a card that cuts the changed words, or keeps "nothing is saved" and its buttons while saving, fails here.
test('the change card quotes every changed word of the instructions, and says Saving… until the save answers', async (t) => {
  const { f, call, card: agentCard, clock } = await harness(t, 'card-change-whole');
  const before = 'You answer questions about colours accurately and concisely. Answer in one or two sentences, and name the colour first.';
  const after = 'You answer questions about colours accurately and concisely. Every answer must consist of exactly one full sentence that ends with the words "Colour check done." and nothing else.';
  await createFixtureAgent(f, 'agent_colours', { name: 'Colours', instructions: before });
  const read = (await call('get_agent', { agentId: 'agent_colours' })).structuredContent!;
  const preview = await call('propose_agent_change', { agentId: 'agent_colours', version: read.version, change: { instructions: after } });
  const quoted = (preview.structuredContent!.changes as Array<{ quotes: Array<{ quote: string }> }>)[0]!.quotes[0]!.quote;
  assert.equal(quoted.includes('Colour check done.'), false, 'the preview\'s short quote cuts the requested ending');

  await agentCard.result(preview);
  assert.deepEqual(agentCard.calls('get_agent').length, 1, 'the card reads the saved instructions once, as it mounts');
  assert.deepEqual(agentCard.shown.blocks, [
    { kind: 'section', label: 'Instructions' },
    {
      kind: 'quote',
      text: 'At the end, changes wording to: “…colours accurately and concisely. Every answer must consist of exactly one full sentence that ends with the words "Colour check done." and nothing else.”',
    },
  ], 'every changed word, with the unchanged words before it that fit');

  // A change longer than the card fits keeps every changed word and drops the words around it.
  const long = `${before} ${'Always check the shade twice before you answer. '.repeat(8).trim()}`;
  const card2 = card(call, clock);
  await card2.result(await call('propose_agent_change', { agentId: 'agent_colours', version: read.version, change: { instructions: long } }));
  const text = (card2.shown.blocks[1] as { text: string }).text;
  assert.equal(text, `At the end, adds: “…${'Always check the shade twice before you answer. '.repeat(8).trim()}”`);

  agentCard.hold = ({ tool }) => tool === 'update_agent';
  await agentCard.press('save');
  assert.equal(agentCard.shown.subtitle, undefined, 'no "nothing is saved" while it saves');
  assert.equal(agentCard.shown.announce, 'Change Colours. Saving…', 'the heading stays, so the live region says the step');
  assert.deepEqual(agentCard.shown.blocks.at(-1), { kind: 'steps', steps: [{ label: 'Saving…', state: 'now' }] });
  assert.deepEqual(agentCard.labels(), []);
  await agentCard.answer();
  assert.equal(agentCard.shown.title, 'Saved Colours');
  assert.equal((await call('get_agent', { agentId: 'agent_colours' })).structuredContent!.instructions, after);
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
  assert.equal(agentCard.shown.title, 'Turned off Research');
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

  const confirmToken = pending.structuredContent!.confirmation.confirmToken;
  await agentCard.result(pending);
  assert.deepEqual(agentCard.effects, [
    { type: 'timer', inMs: 30 * 60_000 },
    { type: 'call', call: { tool: 'get_confirmation', args: { confirmToken }, seq: 1 } },
    { type: 'call', call: { tool: 'get_agent', args: { agentId: 'agent_support' }, seq: 1 } },
  ], 'it will say when the token expires, and reads where the confirmation and its Agent stand before it offers a button');
  await agentCard.press('keep');
  assert.deepEqual([agentCard.shown.title, agentCard.calls().map(({ tool, args }) => [tool, args])],
    ['Kept as it is', [['get_confirmation', { confirmToken }], ['get_agent', { agentId: 'agent_support' }], ['decline_change', { confirmToken }]]],
    'Keep retires the token, and nothing else');
  const after = await call('confirm_change', { confirmToken: pending.structuredContent!.confirmation.confirmToken });
  assert.equal(after.isError, true, 'the model cannot confirm what the person kept');
  // A card for it that mounts later asks before it offers a button, and finds it kept.
  const reopened = card(call, clock);
  await reopened.result(pending);
  assert.deepEqual([reopened.shown.title, reopened.labels()], ['This confirmation no longer applies', []]);

  const fresh = await call('update_agent', { agentId: 'agent_support', version: read.version, on: false, idempotencyKey: 'off-again' });
  const later = card(call, clock);
  await later.result(fresh);
  clock.now = Date.parse(fresh.structuredContent!.confirmation.expiresAt);
  await later.dispatch({ type: 'reread', now: clock.now });
  assert.equal(later.shown.title, 'This confirmation expired');
  await later.press('confirm');
  assert.deepEqual(later.calls().map(({ tool }) => tool), ['get_confirmation', 'get_agent'], 'only the reads it made when it mounted');

  // A card that mounts after the token expired says so at once.
  const mountedLate = card(call, clock);
  await mountedLate.result(fresh);
  assert.equal(mountedLate.shown.title, 'This confirmation expired');

  // Pressed after it expired, before the card noticed: still nothing is sent.
  const unnoticed = card(call, clock);
  clock.now = NOW;
  await unnoticed.result(fresh);
  clock.now = Date.parse(fresh.structuredContent!.confirmation.expiresAt);
  await unnoticed.press('confirm');
  assert.deepEqual([unnoticed.calls('confirm_change'), unnoticed.shown.title], [[], 'This confirmation expired']);
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
  assert.equal(words(agentCard.shown.blocks[1]), 'Answers in **your DMs, #finance and a private Channel**. Anyone in Acme can message it.');
});

test('the proposal shows it by example: no labels, Needs only for a service, and who can message it with or without the workspace name', async (t) => {
  const { f, call, card: agentCard, clock, teamId } = await harness(t, 'card-by-example');
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_FINANCE', label: 'finance', lifecycle: 'active' });
  const answer = 'Overdue this week:\n• Acme Co: $4,200, 41 days\n• Birch Ltd: $860, 33 days';
  const proposal = await call('propose_agent', {
    ...PROPOSAL,
    services: [],
    channels: ['#finance'],
    sampleAsk: '  who is overdue this week?\n',
    promisedAnswer: `\n${answer}\n\n`,
  });
  await agentCard.result(proposal);
  const shown = agentCard.shown;
  assert.deepEqual(shown.subtitle, [{ text: '@invoices' }]);
  assert.deepEqual(shown.blocks, [
    { kind: 'exchange', ask: 'who is overdue this week?', answer, agent: 'Invoice Chaser' },
    { kind: 'line', parts: [{ text: 'Answers in ' }, { text: 'your DMs and #finance', strong: true }, { text: '. Anyone in Acme can message it.' }] },
  ], 'the example in place of the job, its line breaks kept and its ends trimmed; no Needs line without a service');
  const drawn = JSON.stringify(shown);
  for (const gone of ['handle is free', 'Example in Slack', PROPOSAL.job]) {
    assert.ok(!drawn.includes(gone), `the card no longer shows "${gone}"`);
  }

  const { workspaceName: _workspace, ...unnamed } = proposal.structuredContent.proposal;
  const elsewhere = card(call, clock);
  await elsewhere.result({ ...proposal, structuredContent: { ...proposal.structuredContent, proposal: unnamed } });
  assert.equal(words(elsewhere.shown.blocks[1]), 'Answers in **your DMs and #finance**. Anyone in your Slack workspace can message it.');

  const needing = card(call, clock);
  await needing.result(await call('propose_agent', { ...PROPOSAL, services: ['Stripe', 'HubSpot'] }));
  assert.equal(words(needing.shown.blocks[2]), 'Needs [Stripe] [HubSpot] · you sign in after it\'s created');
});

test('the proposal says "handle is taken" only when another Agent has the handle', async (t) => {
  const { f, call, card: agentCard } = await harness(t, 'card-handle-taken');
  await createFixtureAgent(f, 'agent_billing', {
    name: 'Billing Bot',
    slackPresence: { requestedHandle: 'invoices', normalizedHandle: 'invoices', desiredState: 'active', health: 'healthy', avatar: { kind: 'generated', revision: 1, seed: 'billing' } },
  });
  await agentCard.result(await call('propose_agent', PROPOSAL));
  assert.deepEqual(agentCard.shown.subtitle, [{ text: '@invoices' }, { text: ' · ' }, { text: 'handle is taken', tone: 'warn' }]);
  assert.ok(agentCard.shown.blocks.some((block) => block.kind === 'note' && block.tone === 'warn' && block.text.includes('@invoices already belongs to Billing Bot')),
    'the server\'s issue still shows below');
});

test('a proposal with no example shows its job, and Create still makes the Agent', async (t) => {
  const { call, card: agentCard, clock } = await harness(t, 'card-no-example');
  const proposal = await call('propose_agent', { ...PROPOSAL, services: [] });
  const without = (sampleExchange: unknown) => {
    const { sampleExchange: _example, ...rest } = proposal.structuredContent.proposal;
    return { ...proposal, structuredContent: { ...proposal.structuredContent, proposal: sampleExchange === undefined ? rest : { ...rest, sampleExchange } } };
  };
  for (const sampleExchange of [undefined, { ask: ' ', answer: 'An answer.' }, { ask: 'A question?', answer: '\n' }, { ask: 'A question?' }, 'neither']) {
    const bare = card(call, clock);
    await bare.result(without(sampleExchange));
    assert.deepEqual(bare.shown.blocks.map(words), [PROPOSAL.job, 'Answers in **your DMs**. Anyone in Acme can message it.'],
      `${JSON.stringify(sampleExchange)}: the job where the example would go`);
  }

  await agentCard.result(without(undefined));
  await agentCard.press('create');
  assert.equal(agentCard.calls('create_agent').length, 1);
  assert.equal(agentCard.state.view.kind, 'creating');
  assert.equal((agentCard.state.view as { promised?: unknown }).promised, undefined, 'no promise to set beside its first answer');
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

/** The newest sentence of each update the card sent the host's model; each carries all the card told before. */
const contexts = (agentCard: { effects: readonly Effect[] }) =>
  agentCard.effects.flatMap((effect) => effect.type === 'context' ? [effect.text.split('\n').at(-1)!] : []);

const PRESENCE = {
  requestedHandle: 'research', normalizedHandle: 'research', desiredState: 'active', health: 'healthy',
  avatar: { kind: 'generated', revision: 1, seed: 'research' },
} as const;

test('Create in Slack shows its steps at once, and tells the model when the Agent exists and when it is ready', async (t) => {
  const { call, card: agentCard, clock } = await harness(t, 'card-start');
  const proposal = await call('propose_agent', PROPOSAL);
  await agentCard.result(proposal);
  const picture = proposal.structuredContent!.proposal.avatarUrl;
  assert.match(picture, /^https:\/\/chickpea\.example\.test\/chickpea-avatars\/agent-defaults\/\d{2}-[a-z-]+\.png$/);
  assert.equal(agentCard.shown.avatarUrl, picture, 'the proposal shows the picture the Agent gets');

  agentCard.hold = ({ tool }) => tool === 'create_agent';
  await agentCard.press('create');
  assert.equal(agentCard.state.view.kind, 'starting', 'no greyed buttons while create_agent runs');
  assert.deepEqual([agentCard.shown.title, agentCard.shown.subtitle, agentCard.shown.blocks, agentCard.labels()], [
    'Invoice Chaser',
    [{ text: 'Setting up in Acme\'s Slack…' }],
    [{ kind: 'steps', steps: [
      { label: 'Creating it in Chickpea', state: 'now' },
      { label: 'Joining Slack as @invoices', state: 'todo' },
      { label: 'Saying hello to you', state: 'todo' },
    ] }],
    [],
  ]);
  assert.deepEqual(contexts(agentCard), [], 'nothing is made yet');

  await agentCard.answer();
  assert.equal(agentCard.state.view.kind, 'creating');
  assert.equal(agentCard.shown.blocks[0]!.kind === 'steps' && agentCard.shown.blocks[0]!.steps[0]!.label, 'Created in Chickpea');
  assert.match(agentCard.shown.avatarUrl ?? '', /\/assets\/agents\/agent_invoice_chaser\/avatar\/1$/, 'its own picture, once it exists');
  assert.deepEqual(contexts(agentCard), ['The person created the Agent "Invoice Chaser" (@invoices) from the card. It is joining Slack now.']);

  const agentId = (agentCard.state.view as { agentId: string }).agentId;
  await agentCard.dispatch({
    type: 'reply',
    call: { tool: 'get_creation_status', args: { agentId }, seq: agentCard.state.seq },
    result: { structuredContent: { stage: 'said_hello', agent: { name: 'Invoice Chaser', handle: 'invoices' }, channels: 'none', hello: 'Hi' } },
    now: clock.now,
  });
  assert.equal(agentCard.shown.title, '@invoices said hello to you in Slack');
  assert.equal(contexts(agentCard).at(-1), 'The person created the Agent "Invoice Chaser" (@invoices) from the card. It is ready in Slack and said hello to them there.');

  // An Agent the model created itself is not news from the card, even once it is ready.
  const fromModel = card(call, clock);
  await fromModel.result(await call('create_agent', { ...proposal.structuredContent!.create.arguments, name: 'Second', handle: 'second', idempotencyKey: 'model' }));
  await fromModel.dispatch({
    type: 'reply',
    call: { tool: 'get_creation_status', args: { agentId: (fromModel.state.view as { agentId: string }).agentId }, seq: fromModel.state.seq },
    result: { structuredContent: { stage: 'said_hello', agent: { name: 'Second', handle: 'second' }, channels: 'none', hello: 'Hi' } },
    now: clock.now,
  });
  assert.equal(fromModel.shown.title, '@second said hello to you in Slack');
  assert.deepEqual(contexts(fromModel), []);
});

test('a session that draws cards confirms, keeps and undoes with tokens only the card holds', async (t) => {
  const { f, call, clock, teamId } = await cardServer(t, 'card-held', {}, { cards: true });
  const agentCard = card(call, clock);
  await createFixtureAgent(f, 'agent_support', { slackPresence: { ...PRESENCE } });
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_SUPPORT', label: 'support', lifecycle: 'active' });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C_SUPPORT', agentId: 'agent_support', status: 'active',
    createdByMembershipId: f.owner.membership.id, channelLabel: 'support',
  });
  const version = async () => (await call('get_agent', { agentId: 'agent_support' })).structuredContent!.version;
  const off = await call('update_agent', { agentId: 'agent_support', version: await version(), on: false, idempotencyKey: 'off' });
  const held = (off._meta?.['chickpea/held'] as { confirmToken: string }).confirmToken;
  assert.equal(off.structuredContent!.confirmation.confirmToken, undefined, 'the model has no token');

  const kept = card(call, clock);
  await kept.result(off);
  await kept.press('keep');
  assert.deepEqual(kept.calls('decline_change').map(({ args }) => args), [{ confirmToken: held }]);
  assert.deepEqual([kept.shown.title, contexts(kept)], ['Kept as it is', [
    'On the card, the person pressed "Keep it on", so nothing changed. Make this change only if they ask for it again.',
  ]]);

  const again = await call('update_agent', { agentId: 'agent_support', version: await version(), on: false, idempotencyKey: 'off-again' });
  await agentCard.result(again);
  await agentCard.press('confirm');
  assert.deepEqual(agentCard.calls('confirm_change').map(({ args }) => args), [{ confirmToken: (again._meta?.['chickpea/held'] as { confirmToken: string }).confirmToken }]);
  assert.equal((await f.config.getAgent('agent_support')).enabled, false);
  assert.equal(agentCard.shown.title, 'Turned off Research');
  assert.deepEqual(agentCard.shown.subtitle, [{ text: 'It won\'t answer in Slack until it\'s turned back on.' }]);
  assert.ok(agentCard.labels().includes('Undo (secondary)'), 'Undo works from the undo token the card holds');
  assert.equal(contexts(agentCard).at(-1), 'The person confirmed on the card. Chickpea said: "Turned off Research."');

  const saved = card(call, clock);
  const preview = await call('propose_agent_change', { agentId: 'agent_support', version: await version(), change: { description: 'Billing.' } });
  await saved.result(preview);
  await saved.press('save');
  assert.deepEqual(saved.labels(), ['Undo (secondary)'], 'Undo works from the token the card holds');
  await saved.press('undo');
  assert.equal(saved.calls('undo_change').length, 1);
  assert.equal(typeof saved.calls('undo_change')[0]!.args.undoToken, 'string');
  assert.equal(saved.shown.title, 'Undid the change');
  assert.equal(contexts(saved).at(-1), 'The person undid the change to the Agent "Research" from the card.');
});

test('a card whose Agent was archived or deleted since says so, and offers nothing to press', async (t) => {
  const { f, call, card: agentCard, clock } = await harness(t, 'card-gone');
  await createFixtureAgent(f, 'agent_research', { slackPresence: { ...PRESENCE } });
  const version = async () => (await call('get_agent', { agentId: 'agent_research' })).structuredContent!.version;
  const preview = await call('propose_agent_change', { agentId: 'agent_research', version: await version(), change: { description: 'Finds sources.' } });
  const change = card(call, clock);
  await change.result(preview);
  await agentCard.result(preview);
  await agentCard.press('save');
  await agentCard.press('undo');
  assert.deepEqual([agentCard.shown.title, agentCard.labels()], ['Undid the change', []], 'a card with no Undo still re-reads');

  await call('archive_agent', { agentId: 'agent_research', version: await version(), idempotencyKey: 'archive' });
  for (const shown of [agentCard, change]) {
    await shown.dispatch({ type: 'reread', now: clock.now });
    assert.deepEqual([shown.shown.title, shown.shown.blocks, shown.labels()],
      ['Research is archived', [{ kind: 'text', text: 'It no longer answers in Slack.' }], []]);
  }

  // A ready card for an Agent deleted since.
  const ready = card(call, clock);
  await ready.result(await call('propose_agent', PROPOSAL));
  await ready.press('create');
  const agentId = (ready.state.view as { agentId: string }).agentId;
  await ready.dispatch({
    type: 'reply',
    call: { tool: 'get_creation_status', args: { agentId }, seq: ready.state.seq },
    result: { structuredContent: { stage: 'ready', agent: { name: 'Invoice Chaser', handle: 'invoices' }, channels: 'none', slackUrl: 'https://slack.com/app_redirect?team=T1&app=A1' } },
    now: clock.now,
  });
  assert.deepEqual(ready.labels(), ['Open in Slack (primary)', 'Connect Stripe (secondary)']);
  for (const id of ['agent_research', agentId]) {
    const current = (await call('get_agent', { agentId: id })).structuredContent!.version;
    if (id === agentId) await call('archive_agent', { agentId: id, version: current, idempotencyKey: `archive-${id}` });
    const deleting = await call('delete_agent', { agentId: id, version: (await call('get_agent', { agentId: id })).structuredContent!.version, idempotencyKey: `delete-${id}` });
    await call('confirm_change', { confirmToken: deleting.structuredContent!.confirmation.confirmToken });
  }
  await ready.dispatch({ type: 'reread', now: clock.now });
  assert.deepEqual([ready.shown.title, ready.labels()], ['Invoice Chaser is no longer available', []], 'no Open in Slack for an Agent that is gone');
  const stale = card(call, clock);
  await stale.result(preview);
  await stale.dispatch({ type: 'reread', now: clock.now });
  assert.deepEqual([stale.shown.title, stale.labels()], ['Research is no longer available', []], 'no Save for one');
});

test('a save says what it did and where to try the Agent: a DM, or a mention in its Channels', async (t) => {
  const { f, call, card: agentCard, clock, teamId } = await harness(t, 'card-saved');
  await createFixtureAgent(f, 'agent_research', { slackPresence: { ...PRESENCE } });
  const version = async () => (await call('get_agent', { agentId: 'agent_research' })).structuredContent!.version;

  await agentCard.result(await call('propose_agent_change', { agentId: 'agent_research', version: await version(), change: { on: false } }));
  await agentCard.press('save');
  assert.deepEqual([agentCard.shown.title, agentCard.shown.subtitle], ['Turned off Research', [{ text: 'It won\'t answer in Slack until it\'s turned back on.' }]]);

  // A save the model made itself shows the same, with where to try it.
  const on = card(call, clock);
  await on.result(await call('update_agent', { agentId: 'agent_research', version: await version(), on: true, idempotencyKey: 'on' }));
  assert.deepEqual([on.shown.title, on.shown.subtitle], ['Turned on Research', [{ text: 'Try it: message @research in Slack.' }]]);

  const who = card(call, clock);
  await who.result(await call('update_agent', { agentId: 'agent_research', version: await version(), whoCanEdit: 'all_workspace_members', idempotencyKey: 'who' }));
  assert.equal(who.shown.title, 'Changed who can edit Research');

  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_SUPPORT', label: 'support', lifecycle: 'active' });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C_SUPPORT', agentId: 'agent_research', status: 'active',
    createdByMembershipId: f.owner.membership.id, channelLabel: 'support',
  });
  const described = card(call, clock);
  await described.result(await call('update_agent', { agentId: 'agent_research', version: await version(), description: 'Finds sources.', idempotencyKey: 'describe' }));
  assert.deepEqual([described.shown.title, described.shown.subtitle], ['Saved Research', [{ text: 'Try it: mention @research in #support.' }]]);
});

test('Cancel tells the model nothing was saved', async (t) => {
  const { f, call, card: agentCard } = await harness(t, 'card-cancel');
  await createFixtureAgent(f, 'agent_research');
  const read = (await call('get_agent', { agentId: 'agent_research' })).structuredContent!;
  await agentCard.result(await call('propose_agent_change', { agentId: 'agent_research', version: read.version, change: { description: 'x' } }));
  await agentCard.press('cancel');
  assert.deepEqual([agentCard.shown.title, contexts(agentCard), agentCard.calls().map(({ tool }) => tool)],
    ['Not saved', ['The person cancelled this change to the Agent "Research" on the card. Nothing was saved.'], ['get_agent']],
    'only the read the card made when it mounted');
});

/** A card session's workspace with an Agent that answers in #support, so turning it off asks first. */
async function heldServer(t: TestContext, suffix: string) {
  const server = await cardServer(t, suffix, {}, { cards: true });
  const { f, teamId, call } = server;
  await createFixtureAgent(f, 'agent_support', { slackPresence: { ...PRESENCE } });
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_SUPPORT', label: 'support', lifecycle: 'active' });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C_SUPPORT', agentId: 'agent_support', status: 'active',
    createdByMembershipId: f.owner.membership.id, channelLabel: 'support',
  });
  const version = async () => (await call('get_agent', { agentId: 'agent_support' })).structuredContent!.version as string;
  return { ...server, version };
}

/** The server, except that `tool` answers `answer`. */
function answering(call: ServerCall, tool: string, answer: ToolResult): ServerCall {
  return async (name, args) => name === tool ? answer : await call(name, args);
}

test('Keep says Kept only when Chickpea retired the token: any other failure keeps both buttons and tells the model nothing', async (t) => {
  const { call, clock, version } = await heldServer(t, 'card-keep-failures');
  const off = await call('update_agent', { agentId: 'agent_support', version: await version(), on: false, idempotencyKey: 'off' });
  for (const answer of [
    // The host's own error, with no Chickpea code.
    { isError: true, content: [{ type: 'text', text: 'Tool decline_change not found' }] },
    { isError: true, structuredContent: { error: { code: 'something_new', message: 'Something new happened.' } } },
    { isError: true, structuredContent: { error: { code: 'invalid_input', message: 'decline_change did not accept these arguments.' } } },
    { isError: true, structuredContent: { error: { code: 'in_progress', message: 'That change is being made now.' } } },
  ] as ToolResult[]) {
    const kept = card(answering(call, 'decline_change', answer), clock);
    await kept.result(off);
    await kept.press('keep');
    assert.equal(kept.calls('decline_change').length, 1);
    assert.deepEqual([kept.shown.title, kept.labels()], ['Turn off @research?', ['Turn off (danger)', 'Keep it on (secondary)']], JSON.stringify(answer));
    assert.deepEqual(contexts(kept), [], 'the model hears nothing of a Keep that may not have happened');
  }
  // No confirmation of this person's under the token: it can never apply for them.
  const unknown = card(answering(call, 'decline_change', {
    isError: true, structuredContent: { error: { code: 'not_found', message: 'No confirmation of yours has that confirmToken.' } },
  }), clock);
  await unknown.result(off);
  await unknown.press('keep');
  assert.deepEqual([unknown.shown.title, unknown.labels()], ['Kept as it is', []]);
});

test('Keep pressed past the card\'s own clock still asks Chickpea, which alone says the token is dead', async (t) => {
  const { f, call, clock, version } = await heldServer(t, 'card-keep-clock');
  const off = await call('update_agent', { agentId: 'agent_support', version: await version(), on: false, idempotencyKey: 'off' });
  const kept = card(call, clock);
  await kept.result(off);
  clock.now = Date.parse(off.structuredContent!.confirmation.expiresAt);
  await kept.press('keep');
  assert.equal(kept.calls('decline_change').length, 1);
  assert.equal(kept.shown.title, 'Kept as it is');
  assert.equal((await f.config.getAgent('agent_support')).enabled, true);
});

test('a confirmation whose token never reached the card asks nothing, and says where else the change can be made', async (t) => {
  const { call, clock, version } = await heldServer(t, 'card-tokenless');
  // A host that left the result's _meta behind, where the card's token travels.
  const bare = ({ _meta: _held, ...result }: ToolResult) => result;
  const off = await call('update_agent', { agentId: 'agent_support', version: await version(), on: false, idempotencyKey: 'off' });
  const tokenless = card(call, clock);
  await tokenless.result(bare(off));
  assert.equal(tokenless.shown.title, 'Turn off @research?');
  assert.deepEqual(tokenless.shown.blocks.at(-1), { kind: 'note', text: 'Confirm this in Admin.' });
  assert.deepEqual(tokenless.labels(), ['Open in Admin (secondary)'], 'no button that cannot work');
  await tokenless.press('confirm');
  await tokenless.press('keep');
  assert.deepEqual(tokenless.calls(), []);
  await tokenless.press('open_admin');
  assert.deepEqual(tokenless.effects.at(-1), { type: 'open', url: `${BASE_URL}/admin/agents/agent_support` });

  // Admin cannot delete an Agent, so the card never sends the person there for one.
  const archived = await call('archive_agent', { agentId: 'agent_support', version: await version(), idempotencyKey: 'archive' });
  const deleting = await call('delete_agent', { agentId: 'agent_support', version: archived.structuredContent!.version, idempotencyKey: 'delete' });
  const deleteCard = card(call, clock);
  await deleteCard.result(bare(deleting));
  assert.deepEqual(deleteCard.shown.blocks.at(-1), { kind: 'note', text: 'Ask again in a new chat to confirm it.' });
  assert.deepEqual(deleteCard.labels(), []);
  await deleteCard.press('open_admin');
  assert.deepEqual(deleteCard.calls(), []);
  assert.equal(deleteCard.effects.some(({ type }) => type === 'open'), false);
});

test('what the model hears quotes a long Agent name cut short, and never a server summary that repeats it whole', async (t) => {
  const { f, call, card: agentCard, clock } = await harness(t, 'card-long-name');
  const long = `Research ${'x'.repeat(231)}`;
  assert.equal(long.length, 240);
  await createFixtureAgent(f, 'agent_research', { name: long });
  const read = (await call('get_agent', { agentId: 'agent_research' })).structuredContent!;
  await agentCard.result(await call('propose_agent_change', { agentId: 'agent_research', version: read.version, change: { on: false } }));
  await agentCard.press('save');
  assert.deepEqual(contexts(agentCard), [`The person saved the change to the Agent ${JSON.stringify(`${long.slice(0, 59)}…`)} from the card.`]);

  // A summary the sentence ends with is one line of at most 200 characters.
  const similar = card(answering(call, 'create_agent', {
    structuredContent: {
      status: 'similar_agent_exists',
      summary: `An Agent like this already exists:\n${long} (@research).\nNothing was created.`,
      matches: [{ agentId: 'agent_research', name: long, handle: 'research' }],
    },
  }), clock);
  await similar.result(await call('propose_agent', PROPOSAL));
  await similar.press('create');
  const [sentence = ''] = contexts(similar);
  const lead = 'The person pressed Create in Slack on the card, but nothing was created. Chickpea said: "';
  assert.ok(sentence.startsWith(lead) && sentence.endsWith('…"'), sentence);
  assert.equal(sentence.length, lead.length + 200 + 1, 'the summary quoted, cut to 200 characters');
  assert.ok(!sentence.includes('\n') && !sentence.includes(long));
});

test('the card finds its tokens in the host\'s copy of _meta, whatever _meta the notification brings', async (t) => {
  const { call, clock, version } = await heldServer(t, 'card-response-meta');
  const off = await call('update_agent', { agentId: 'agent_support', version: await version(), on: false, idempotencyKey: 'off' });
  const { _meta: held, ...bare } = off;
  const notifications: ToolResult[] = [bare, { ...bare, _meta: {} }, { ...bare, _meta: { 'openai/widgetSessionId': 'widget_1' } }];
  for (const notified of notifications) {
    const confirm = card(call, clock);
    await confirm.result(withResponseMeta(notified, held));
    assert.deepEqual(confirm.labels(), ['Turn off (danger)', 'Keep it on (secondary)'], JSON.stringify(notified._meta));
  }
  assert.deepEqual(withResponseMeta({ _meta: { a: 1, b: 2 } }, { b: 3, c: 4 })._meta, { a: 1, b: 2, c: 4 }, 'the notification\'s own keys win');
  for (const meta of [undefined, null, ['chickpea/held'], 'chickpea/held']) {
    assert.deepEqual(withResponseMeta(bare, meta), bare, JSON.stringify(meta));
  }
});
