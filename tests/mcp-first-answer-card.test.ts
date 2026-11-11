import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import * as agentCard from '../src/mcp-cards/agent-card/model.ts';
import { hostErrorOf, keptState, type Call, type Memory, type Presentation, type ToolResult } from '../src/mcp-cards/card-model.ts';
import * as connectCard from '../src/mcp-cards/connect-card/model.ts';
import { GIVE_UP_MS, HELD_FOR_MS, HELD_RETRY_MS, KEY_FOR_MS, plainText } from '../src/mcp-cards/first-answer.ts';
import { cardVersions } from '../src/mcp-cards/published.ts';
import { TEST_RUN_VISIBLE_MS } from '../src/management/test-runs.ts';
import { assertPlain, cardHost, cardServer, type CardModelUnderTest } from './helpers/mcp-card-host.ts';
import { slackMember } from './helpers/slack-members.ts';
import { StubTestRuns } from './helpers/stub-test-runs.ts';

/**
 * "See its first answer" on the Agent card and the connect card, against
 * Core's real MCP server: practice_agent and get_practice_run run their real
 * checks, over a stub of the state store's test runs. Only a press starts a
 * run; every event that is not a press makes only reads, and a timer may send
 * practice_agent again while the card still carries the press, which replays it.
 */

const AGENT_CARD: CardModelUnderTest<agentCard.View, agentCard.Action> = {
  ...agentCard,
  initial: agentCard.INITIAL,
  reads: new Set(['get_creation_status', 'get_agent', 'get_practice_run']),
  followsPress: ({ view }) => (view.kind === 'creating' && view.byPress === true) || view.kind === 'first_answer',
  replays: new Set(['practice_agent']),
};

const CONNECT_CARD: CardModelUnderTest<connectCard.View, connectCard.Action> = {
  ...connectCard,
  initial: connectCard.INITIAL,
  reads: new Set(['get_setup_status', 'check_agent', 'get_practice_run']),
  followsPress: ({ view }) => view.kind === 'finishing' || view.kind === 'first_answer',
  replays: new Set(['practice_agent']),
};

const ASK = 'who is overdue this week?';
const PROMISED = 'I list every invoice past 30 days with the customer, amount and days overdue.';
const REPLY = '**2 invoices** are overdue:\n- Northwind, $1,240\n- [Lumen Labs](https://dashboard.stripe.com/x), $860';

async function world(t: TestContext, suffix: string, options: { unserved?: true } = {}) {
  const runs = new StubTestRuns({ status: 'answered', failure: null, result: { reply: REPLY, read: ['Stripe', 'Notion'] } });
  /** What Slack says of the caller: a full member of the workspace unless a test makes them a guest. */
  const slack = { team: '', guest: false };
  const server = await cardServer(t, suffix, {
    modelReadiness: async () => async () => undefined,
    slackMember: async (id) => slackMember(id, slack.team, { restricted: slack.guest }),
    ...options.unserved ? {} : { testRuns: runs },
  }, { cards: true });
  const { f, teamId } = server;
  slack.team = teamId;
  runs.now = () => server.clock.now;
  await f.config.ensureWorkspaceInstallation({ workspaceId: teamId, transportMode: 'direct', botUserId: 'UBOT', runtimeContract: 'chickpea-v1' });
  return { ...server, runs, slack };
}

/** The Agent card, from the proposal through Create to its hello in Slack. */
async function readyCard(t: TestContext, suffix: string) {
  const w = await world(t, suffix);
  const { call, clock } = w;
  const card = cardHost(AGENT_CARD, call, clock);
  await card.result(await call('propose_agent', {
    name: 'Invoice Chaser', handle: 'invoices', job: 'Chases overdue invoices.', instructions: '# Job\nChase invoices.',
    sampleAsk: ASK, promisedAnswer: PROMISED,
  }));
  await card.press('create');
  await sayHello(w, (card.state.view as { agentId: string }).agentId);
  await card.dispatch({ type: 'tick', now: clock.now });
  assert.equal(card.state.view.kind, 'ready', JSON.stringify(card.state.view));
  return { ...w, card };
}

/**
 * What Slack does after create_agent: the Agent joins, and its hello is
 * delivered. The fixture has no workspace model, so it gets one that runs.
 */
async function sayHello({ f, clock }: Awaited<ReturnType<typeof world>>, agentId: string) {
  const agent = await f.config.getAgent(agentId);
  await f.config.updateAgent(agentId, { model: 'local-stub/invoices', slackPresence: { ...agent!.slackPresence!, health: 'healthy' } });
  const claimed = await f.management.claimDueOutbox(clock.now, 25, clock.now + 60_000);
  const hello = claimed.find(({ receipt }) => 'kind' in receipt && receipt.kind === 'agent_created_welcome');
  assert.ok(hello, 'create_agent queued a hello');
  await f.management.settleOutbox({ outboxId: hello.outboxId, outcome: 'delivered', at: clock.now, deliveryRef: 'D1:1.1' });
}

/** The cards' ruling on words, for what the card draws; its picture's address may name the Agent. */
function plainly(shown: Presentation, ids: readonly string[]): void {
  assertPlain({ ...shown, avatarUrl: undefined }, ids);
}

/** No token, key or Agent ID in what the card draws; its picture's address may name the Agent. */
function assertNoIds(shown: { avatarUrl?: string | undefined }, ids: readonly string[]): void {
  const drawn = JSON.stringify({ ...shown, avatarUrl: undefined });
  for (const id of ids) assert.equal(drawn.includes(id), false, `${id} drawn: ${drawn}`);
}

/**
 * The server's waits for a run that is still going pass at once: every turn
 * of the event loop moves the mocked clock on a second.
 */
function fastTime(t: TestContext): void {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  let on = true;
  const spin = () => {
    if (!on) return;
    t.mock.timers.tick(1_000);
    setImmediate(spin);
  };
  setImmediate(spin);
  t.after(() => { on = false; });
}

function keys(calls: Call[]): unknown[] {
  return calls.map(({ args }) => args.idempotencyKey);
}

test('the ready card offers its first answer, starts it only on the press, and shows what was promised beside what it answered', async (t) => {
  const { card, runs, clock } = await readyCard(t, 'first-answer-ready');
  assert.deepEqual(card.labels(), ['Open in Slack (primary)', 'See its first answer (secondary)']);
  for (const idle of ['reread', 'tick', 'no_result'] as const) await card.dispatch({ type: idle, now: clock.now });
  assert.deepEqual([card.calls('practice_agent'), runs.starts], [[], []], 'nothing runs until the press');

  await card.press('try_once');
  const [tried] = card.calls('practice_agent');
  assert.deepEqual(tried!.args, { agentId: 'agent_invoice_chaser', idempotencyKey: `try:agent_invoice_chaser:${clock.now}` });
  assert.equal(runs.starts.length, 1, JSON.stringify(card.shown));
  assert.equal(runs.starts[0]!.run.question, ASK, 'the stored first question');

  const shown = card.shown;
  assert.equal(shown.title, 'Invoice Chaser\'s first answer');
  assert.deepEqual(shown.subtitle, [{ text: 'A practice run: it made only read requests and sent nothing to Slack.' }]);
  assert.deepEqual(shown.blocks, [
    { kind: 'note', text: `First question: “${ASK}”` },
    {
      kind: 'panes',
      panes: [
        { label: 'What we promised', text: PROMISED },
        { label: 'What it answered', text: '2 invoices are overdue:\n• Northwind, $1,240\n• Lumen Labs, $860' },
      ],
    },
    { kind: 'note', text: 'It read Stripe and Notion.' },
  ]);
  assert.deepEqual(card.labels(), ['Open in Slack (primary)', 'Change something (secondary)']);
  assertNoIds(shown, [runs.runs[0]!.view.runToken, 'try:', 'agent_invoice_chaser']);
  const told = card.effects.filter(({ type }) => type === 'context');
  assert.deepEqual(told.at(-1), {
    type: 'context',
    text: [
      'The person created the Agent "Invoice Chaser" (@invoices) from the card. It is joining Slack now.',
      'The person created the Agent "Invoice Chaser" (@invoices) from the card. It is ready in Slack and said hello to them there.',
      'The person ran the Agent "Invoice Chaser" (@invoices) once from the card, and it answered its first question there.',
    ].join('\n'),
  }, 'everything the card told before, then one bounded sentence, without the answer');

  await card.press('change_something');
  await card.press('open_slack');
  assert.deepEqual(card.effects.slice(-2).map(({ type }) => type), ['message', 'open']);
  assert.deepEqual(card.effects.at(-2), { type: 'message', draft: 'Change Invoice Chaser: ', sent: 'Change Invoice Chaser: ' });
  for (const idle of ['reread', 'tick'] as const) await card.dispatch({ type: idle, now: clock.now });
  assert.equal(runs.starts.length, 1, 'an answered card runs nothing again');
});

test('a run still going is followed with get_practice_run at once, and a failed read waits longer each time', async (t) => {
  const { card, runs, clock } = await readyCard(t, 'first-answer-running');
  fastTime(t);
  runs.outcome = { status: 'running', failure: null, result: null };
  card.hold = (made) => made.tool === 'get_practice_run';
  await card.press('try_once');
  assert.equal(card.state.view.kind, 'first_answer');
  assert.deepEqual(card.shown.blocks, [
    { kind: 'note', text: `First question: “${ASK}”` },
    { kind: 'steps', steps: [{ label: 'Invoice Chaser is answering', state: 'now' }] },
  ]);
  assert.deepEqual(card.shown.subtitle, [{ text: 'A practice run: it makes only read requests and sends nothing to Slack.' }]);
  assert.deepEqual(card.labels(), [], 'nothing to press while it runs');
  const runToken = runs.runs[0]!.view.runToken;
  assert.deepEqual(card.calls('get_practice_run').map(({ args }) => args), [{ runToken }], 'asked again at once');

  // The card comes back into view, or an older timer fires, while a read is out: nothing more is sent.
  await card.dispatch({ type: 'reread', now: clock.now });
  await card.dispatch({ type: 'tick', now: clock.now });
  assert.equal(card.calls('get_practice_run').length, 1);
  await card.answer();
  assert.equal(card.calls('get_practice_run').length, 2, 'still going: asked again at once');
  await card.answer('unreachable');
  assert.deepEqual(card.effects.at(-1), { type: 'timer', inMs: 2_000 }, 'a failed read waits before the next');
  await card.dispatch({ type: 'tick', now: clock.now });
  assert.equal(card.calls('get_practice_run').length, 3);
  await card.answer('unreachable');
  assert.deepEqual(card.effects.at(-1), { type: 'timer', inMs: 4_000 });

  runs.outcome = { status: 'answered', failure: null, result: { reply: 'Two.', read: [] } };
  await card.dispatch({ type: 'tick', now: clock.now });
  await card.answer();
  assert.deepEqual(card.shown.blocks.at(-1), {
    kind: 'panes',
    panes: [{ label: 'What we promised', text: PROMISED }, { label: 'What it answered', text: 'Two.' }],
  }, 'no line about what it read when it read nothing');
  assert.equal(runs.starts.length, 1, 'one run for the one press');
  assert.deepEqual(new Set(keys(card.calls('practice_agent'))).size, 1);
});

test('three minutes after the press the card stops waiting, says it is still working on it, and looks once more when it comes back', async (t) => {
  const { card, runs, clock } = await readyCard(t, 'first-answer-slow');
  fastTime(t);
  runs.outcome = { status: 'running', failure: null, result: null };
  card.hold = (made) => made.tool === 'get_practice_run';
  await card.press('try_once');
  clock.now += GIVE_UP_MS;
  await card.answer();
  assert.equal(card.shown.title, 'Invoice Chaser\'s first answer');
  assert.deepEqual(card.shown.blocks, [{ kind: 'text', text: 'Still working on it.' }]);
  assert.deepEqual(card.labels(), ['Check again (primary)', 'Open in Slack (secondary)']);
  assert.match(String((card.effects.findLast(({ type }) => type === 'context') as { text: string }).text),
    /^The person created the Agent .*\nThe person ran the Agent "Invoice Chaser" \(@invoices\) once from the card, but its answer did not come back in time\.$/s,
    'the give-up follows what the card told before, so the model still knows the Agent exists');
  const polls = card.calls('get_practice_run').length;
  await card.dispatch({ type: 'tick', now: clock.now });
  assert.equal(card.calls('get_practice_run').length, polls, 'a give-up stops the reads');

  runs.outcome = { status: 'answered', failure: null, result: { reply: 'Done.', read: ['Stripe'] } };
  await card.dispatch({ type: 'reread', now: clock.now });
  assert.equal(card.calls('get_practice_run').length, polls + 1, 'one read when it comes back into view');
  await card.answer();
  assert.deepEqual(card.labels(), ['Open in Slack (primary)', 'Change something (secondary)']);
  assert.equal(runs.starts.length, 1);
});

// U7: the person was told to leave while the run was still readable for an hour.
test('Check again on the slow view reads the run once, and shows its answer once it has one', async (t) => {
  const { card, runs, clock } = await readyCard(t, 'first-answer-check-again');
  fastTime(t);
  runs.outcome = { status: 'running', failure: null, result: null };
  card.hold = (made) => made.tool === 'get_practice_run';
  await card.press('try_once');
  clock.now += GIVE_UP_MS;
  await card.answer();
  const polls = card.calls('get_practice_run').length;
  // A press focuses the card first, which reads the run: Check again stays pressable meanwhile.
  await card.dispatch({ type: 'reread', now: clock.now });
  assert.deepEqual([card.calls('get_practice_run').length, card.labels()], [polls + 1, ['Check again (primary)', 'Open in Slack (secondary)']]);
  card.hold = () => false;
  await card.press('check_again');
  assert.equal(card.calls('get_practice_run').length, polls + 2, 'one read for the press');
  assert.deepEqual([card.shown.blocks, card.labels()], [
    [{ kind: 'text', text: 'Still working on it.' }],
    ['Check again (primary)', 'Open in Slack (secondary)'],
  ]);
  runs.outcome = { status: 'answered', failure: null, result: { reply: 'Done.', read: [] } };
  await card.press('check_again');
  assert.deepEqual(card.labels(), ['Open in Slack (primary)', 'Change something (secondary)']);
  assert.deepEqual([card.calls('practice_agent').length, runs.starts.length], [1, 1], 'Check again started nothing');

  // No run ever came back: Check again sends the press's own call again, with its key.
  const lost = await readyCard(t, 'first-answer-check-again-no-run');
  lost.card.hold = (made) => made.tool === 'practice_agent';
  await lost.card.press('try_once');
  lost.clock.now += GIVE_UP_MS;
  await lost.card.answer('unreachable');
  assert.deepEqual(lost.card.labels(), ['Check again (primary)', 'Open in Slack (secondary)']);
  assert.deepEqual(lost.card.shown.blocks, [{
    kind: 'text', text: 'Its answer is taking longer than it should. Check again in a moment, or ask Invoice Chaser in Slack.',
  }], 'no run it knows of: not "still working"');
  lost.card.hold = () => false;
  await lost.card.press('check_again');
  assert.deepEqual(new Set(keys(lost.card.calls('practice_agent'))).size, 1, 'the same key gets the run the first call started');
  assert.equal(lost.card.shown.blocks.some((block) => block.kind === 'panes'), true, 'its answer');
});

// Mutation proof (A's review S3): a Check again or a reopened card that calls practice_agent, or starts a run, fails here.
test('a run still going when the card stops waiting keeps its token where the model never reads it; Check again only reads that run, for hours, and a reopened card reads it once', async (t) => {
  const { card, runs, call, clock } = await readyCard(t, 'first-answer-still');
  fastTime(t);
  runs.outcome = { status: 'running', failure: null, result: null };
  card.hold = (made) => made.tool === 'get_practice_run';
  await card.press('try_once');
  clock.now += GIVE_UP_MS;
  await card.answer();
  const runToken = runs.runs[0]!.view.runToken;
  assert.deepEqual([card.shown.blocks, card.labels()], [[{ kind: 'text', text: 'Still working on it.' }], ['Check again (primary)', 'Open in Slack (secondary)']]);
  const kept = keptState(card.state, cardVersions('agent-card').at(-1)!);
  assert.deepEqual(kept.privateContent.card.outcome,
    { kind: 'checking', runToken, agentId: 'agent_invoice_chaser', name: 'Invoice Chaser', handle: 'invoices' });
  assert.equal(kept.modelContent.includes(runToken), false, 'the model never reads the token');
  const memory: Memory = { told: card.state.told ?? [], outcome: card.state.outcome };
  const result = await call('propose_agent', {
    name: 'Invoice Chaser', handle: 'invoices', job: 'Chases overdue invoices.', instructions: '# Job\nChase invoices.', sampleAsk: ASK, promisedAnswer: PROMISED,
  });
  /** The chat reopens with the token kept: one read of that run on mount, and never practice_agent. */
  const reopen = async () => {
    const reopened = cardHost(AGENT_CARD, call, clock);
    await reopened.dispatch({ type: 'result', result, now: clock.now, kept: memory });
    assert.deepEqual(reopened.calls().map(({ tool, args }) => [tool, args]), [['get_practice_run', { runToken }]]);
    return reopened;
  };
  assert.deepEqual((await reopen()).shown.blocks, [{ kind: 'text', text: 'Still working on it.' }]);
  // The connect card keeps it the same way.
  const link = await call('connect_service', { agentId: 'agent_invoice_chaser', service: 'Gmail', owner: 'me', idempotencyKey: 'gmail-still' });
  const connect = cardHost(CONNECT_CARD, call, clock);
  await connect.dispatch({ type: 'result', result: link, now: clock.now, kept: memory });
  assert.deepEqual(connect.calls().map(({ tool, args }) => [tool, args]), [['get_practice_run', { runToken }]]);
  assert.deepEqual([connect.shown.blocks, connect.labels()], [[{ kind: 'text', text: 'Still working on it.' }], ['Check again (primary)']]);

  // For two hours, as long as a direct message can run: each Check again reads that one run, and starts nothing.
  card.hold = () => false;
  for (let checks = 1; checks <= 4; checks += 1) {
    clock.now += 30 * 60_000;
    await card.press('check_again');
    assert.deepEqual(card.shown.blocks, [{ kind: 'text', text: 'Still working on it.' }]);
  }
  const reads = card.calls('get_practice_run').slice(-4).map(({ args }) => args);
  assert.deepEqual(reads, Array(4).fill({ runToken }));
  assert.deepEqual([card.calls('practice_agent').length, runs.starts.length], [1, 1], 'Check again starts no run');
  runs.outcome = { status: 'answered', failure: null, result: { reply: 'Two invoices.', read: [] } };
  await card.press('check_again');
  assert.deepEqual(card.shown.blocks.find((block) => block.kind === 'panes'),
    { kind: 'panes', panes: [{ label: 'What we promised', text: PROMISED }, { label: 'What it answered', text: 'Two invoices.' }] });
  assert.equal(runs.starts.length, 1, 'the answer of the run that was charged, and no other');
  assert.equal(JSON.stringify(keptState(card.state, 1)).includes(runToken), false, 'once it answers, no token is kept');
  // Nor on the connect card, which then keeps nothing of the run.
  await connect.press('check_again');
  assert.equal(connect.shown.blocks.some((block) => block.kind === 'panes'), true, 'its answer');
  assert.deepEqual(keptState(connect.state, 1).privateContent.card.outcome, { kind: 'settled' });
  assert.deepEqual([connect.calls('practice_agent'), runs.starts.length], [[], 1]);

  // A chat reopened after it answered shows that answer, beside the promise of the proposal it mounts with.
  assert.deepEqual((await reopen()).shown.blocks.find((block) => block.kind === 'panes'),
    { kind: 'panes', panes: [{ label: 'What we promised', text: PROMISED }, { label: 'What it answered', text: 'Two invoices.' }] });
  assert.equal(runs.starts.length, 1);

  // A kept token that is not one is ignored: the card shows its own result.
  const tampered = cardHost(AGENT_CARD, call, clock);
  await tampered.dispatch({ type: 'result', result, now: clock.now, kept: { told: [], outcome: { ...memory.outcome as object, runToken: 'not a token!' } } });
  assert.deepEqual([tampered.state.view.kind, tampered.calls('get_practice_run')], ['proposal', []]);

});

// Mutation proof (item 1): read only from structuredContent, this refusal looks like the host ending the call, and the card retries for three minutes.
test('a refusal that no retry passes reaches the first answer when the host answers with an error that carries the result', async (t) => {
  const wraps: Record<string, (result: ToolResult) => ToolResult> = {
    result: (result) => ({ isError: true, hostError: hostErrorOf({ code: -32603, message: 'Tool call failed', data: result }) }),
    envelope: (result) => ({ isError: true, hostError: hostErrorOf({ code: -32603, message: 'Tool call failed', data: { status: 'error', mcp_tool_result: result } }) }),
  };
  for (const [how, wrap] of Object.entries(wraps)) {
    const limited = await readyCard(t, `first-answer-limit-${how}`);
    limited.slack.guest = true;
    limited.card.hold = (made) => made.tool === 'practice_agent';
    await limited.card.press('try_once');
    limited.card.held[0]!.result = wrap(limited.card.held[0]!.result);
    await limited.card.answer();
    assert.deepEqual(limited.card.shown.blocks,
      [{ kind: 'text', text: 'You can\'t message Invoice Chaser in Slack yet, so you can\'t practice with it.' }], how);
    assert.deepEqual(limited.card.labels(), ['Open in Slack (primary)'], how);
    await limited.card.dispatch({ type: 'tick', now: limited.clock.now });
    assert.equal(limited.card.calls('practice_agent').length, 1, `${how}: no retry`);
  }
});

test('when the host gives up on practice_agent, the card sends the same call again and gets the run the first one started', async (t) => {
  const { card, runs, clock } = await readyCard(t, 'first-answer-retry');
  card.hold = (made) => made.tool === 'practice_agent';
  await card.press('try_once');
  const [first] = card.calls('practice_agent');
  assert.deepEqual(card.labels(), [], 'no button to press twice');
  await card.dispatch({ type: 'tick', now: clock.now });
  assert.equal(card.calls('practice_agent').length, 1, 'a timer from before the press sends nothing while the call is out');
  await card.answer('unreachable');
  assert.deepEqual(card.effects.at(-1), { type: 'timer', inMs: 2_000 });
  assert.equal(card.calls('practice_agent').length, 1, 'only the timer sends it again');
  // Coming back into view while a retry is due changes nothing.
  await card.dispatch({ type: 'reread', now: clock.now });
  assert.equal(card.calls('practice_agent').length, 1);
  await card.dispatch({ type: 'tick', now: clock.now });
  const [, second] = card.calls('practice_agent');
  assert.deepEqual(second!.args, first!.args, 'the same key');

  // The host ends the call with an error of its own: once more, with the same key.
  card.held[0]!.result = { isError: true, structuredContent: { message: 'The tool call failed.' } };
  await card.answer();
  assert.deepEqual(card.effects.at(-1), { type: 'timer', inMs: 4_000 }, 'an error with no Chickpea code is the host giving up');
  await card.dispatch({ type: 'tick', now: clock.now });
  await card.answer();
  assert.deepEqual(new Set(keys(card.calls('practice_agent'))), new Set([first!.args.idempotencyKey]));
  assert.equal(runs.starts.length, 1, 'every call after the first replays its run');
  assert.equal(card.state.view.kind === 'first_answer' && card.state.view.stage.kind, 'answered');
});

test('a late reply never moves a newer view', async (t) => {
  const { card, clock } = await readyCard(t, 'first-answer-late');
  card.hold = () => true;
  await card.press('try_once');
  const first = card.held[0]!;
  await card.answer('unreachable');
  await card.dispatch({ type: 'tick', now: clock.now });
  // The retry is out when the first call's answer, or its failure, comes after all.
  const retrying = card.state;
  const failed: ToolResult = {
    structuredContent: { ...first.result.structuredContent as object, status: 'failed', problem: 'The practice run didn\'t finish. Ask Invoice Chaser in Slack instead.' },
  };
  await card.dispatch({ type: 'reply', call: first.call, result: failed, now: clock.now });
  await card.dispatch({ type: 'unreachable', call: first.call, now: clock.now });
  await card.dispatch({ type: 'tick', now: clock.now });
  assert.deepEqual(card.state, retrying, 'the first call\'s answer and failure belong to the view that made it');
  assert.equal(card.calls('practice_agent').length, 2, 'and arm no third call');
  await card.answer();
  assert.equal(card.state.view.kind === 'first_answer' && card.state.view.stage.kind, 'answered');
  const answered = card.state;
  await card.dispatch({ type: 'reply', call: first.call, result: failed, now: clock.now });
  assert.deepEqual(card.state, answered);

  // A read that comes back while a newer read is out.
  const reading = await readyCard(t, 'first-answer-late-read');
  fastTime(t);
  reading.runs.outcome = { status: 'running', failure: null, result: null };
  reading.card.hold = (made) => made.tool === 'get_practice_run';
  await reading.card.press('try_once');
  const firstRead = reading.card.held[0]!;
  await reading.card.answer('unreachable');
  await reading.card.dispatch({ type: 'tick', now: reading.clock.now });
  const polling = reading.card.state;
  await reading.card.dispatch({ type: 'reply', call: firstRead.call, result: firstRead.result, now: reading.clock.now });
  assert.deepEqual(reading.card.state, polling);
  assert.equal(reading.card.calls('get_practice_run').length, 2, 'a stale "still going" starts no second line of reads');
  reading.runs.outcome = { status: 'answered', failure: null, result: { reply: 'Two.', read: [] } };
  reading.card.held[0]!.result = await reading.call('get_practice_run', { runToken: reading.runs.runs[0]!.view.runToken });
  await reading.card.answer();
  assert.equal(reading.card.state.view.kind === 'first_answer' && reading.card.state.view.stage.kind, 'answered');
});

test('a card that mounts again mid-run reads the run it knows, and waits for a press for one it never heard back about', async (t) => {
  const { card, runs, call, clock } = await readyCard(t, 'first-answer-remount');
  fastTime(t);
  runs.outcome = { status: 'running', failure: null, result: null };
  card.hold = () => true;
  await card.press('try_once');
  const [first] = card.calls('practice_agent');
  /** The card as a reopened chat mounts it: the view it kept, with nothing out. */
  const remount = () => cardHost({ ...AGENT_CARD, initial: { ...card.state, busy: false } }, call, clock);

  // practice_agent is out: its answer goes to the card that closed.
  const lost = remount();
  lost.hold = (made) => made.tool === 'get_practice_run';
  await lost.dispatch({ type: 'reread', now: clock.now });
  await lost.dispatch({ type: 'tick', now: clock.now });
  assert.deepEqual(lost.calls(), [], 'a mount sends nothing');
  assert.deepEqual(lost.shown.blocks, [{ kind: 'text', text: 'This card closed before the practice run answered.' }]);
  assert.deepEqual(lost.labels(), ['See its first answer (primary)']);
  await lost.press('try_once');
  assert.deepEqual(lost.calls('practice_agent').map(({ args }) => args), [first!.args], 'the press sends the same key');
  assert.equal(runs.starts.length, 1, 'and gets the run the first press started');

  // get_practice_run is out: the run is read again.
  await card.answer();
  assert.equal(card.state.view.kind === 'first_answer' && card.state.view.stage.kind, 'running');
  runs.outcome = { status: 'answered', failure: null, result: { reply: 'Two.', read: [] } };
  const reading = remount();
  await reading.dispatch({ type: 'reread', now: clock.now });
  assert.deepEqual(reading.calls().map(({ tool }) => tool), ['get_practice_run']);
  assert.equal(reading.state.view.kind === 'first_answer' && reading.state.view.stage.kind, 'answered');
  assert.equal(runs.starts.length, 1);
});

test('a card reopened after the hour Chickpea keeps a run starts a new one on the press, never an expired one', async (t) => {
  assert.equal(KEY_FOR_MS, TEST_RUN_VISIBLE_MS, 'the card\'s hour is the store\'s');
  const { card, runs, call, clock } = await readyCard(t, 'first-answer-lost-hour');
  card.hold = () => true;
  await card.press('try_once');
  const [first] = card.calls('practice_agent');

  clock.now += KEY_FOR_MS;
  const lost = cardHost({ ...AGENT_CARD, initial: { ...card.state, busy: false } }, call, clock);
  await lost.dispatch({ type: 'reread', now: clock.now });
  assert.deepEqual(lost.labels(), ['See its first answer (primary)']);
  await lost.press('try_once');
  const [again] = lost.calls('practice_agent');
  assert.notEqual(again!.args.idempotencyKey, first!.args.idempotencyKey, 'the old key would start nothing');
  assert.equal(runs.starts.length, 2);
  assert.equal(lost.state.view.kind === 'first_answer' && lost.state.view.stage.kind, 'answered', JSON.stringify(lost.shown.blocks));
  for (const idle of ['reread', 'tick'] as const) await lost.dispatch({ type: idle, now: clock.now });
  assert.equal(runs.starts.length, 2, 'and only on the press');
});

const api = (host: string) => ({
  kind: 'api' as const, allowedHosts: [host], pathPrefixes: ['/api/'], headerName: 'Authorization',
  allowedMethods: ['GET' as const], authMode: 'credential' as const,
});

/** A connection on the Agent. */
async function connect(w: Awaited<ReturnType<typeof world>>, agentId: string, account: Record<string, unknown> & { id: string; providerId: string }) {
  const { f, teamId } = w;
  await f.config.putConnectionAccount({
    ownerKind: 'team', workspaceId: teamId, createdByMembershipId: f.owner.membership.id, secretRefId: `secret_${account.id}`,
    lifecycle: 'ready', ...account,
  } as never, 0);
  await f.config.putAgentConnectionBinding({ agentId, connectionAccountId: account.id, providerId: account.providerId, allowedCapabilities: [], enabled: true });
}

/** The newest sentence the card told the host's model. */
const told = (card: { effects: Array<{ type: string }> }) => (card.effects.findLast(({ type }) => type === 'context') as { text: string } | undefined)?.text.split('\n').at(-1);

test('every refusal reads plainly on the card, with its own next step and no code or ID', async (t) => {
  const NOT_STARTED = 'The person pressed "See its first answer" for the Agent "Invoice Chaser" (@invoices) on the card, but the practice run did not start. Chickpea said: "Practice runs aren\'t available on this workspace yet."';
  const shown = (card: { shown: { blocks: unknown[] } }) => card.shown.blocks;

  // A deployment that serves no test runs.
  const unserved = await world(t, 'first-answer-unserved', { unserved: true });
  const plain = cardHost(AGENT_CARD, unserved.call, unserved.clock);
  await plain.result(await unserved.call('propose_agent', {
    name: 'Invoice Chaser', handle: 'invoices', job: 'Chases overdue invoices.', instructions: 'Chase.', sampleAsk: ASK, promisedAnswer: PROMISED,
  }));
  await plain.press('create');
  await sayHello(unserved, 'agent_invoice_chaser');
  await plain.dispatch({ type: 'tick', now: unserved.clock.now });
  assert.deepEqual(plain.labels(), ['Open in Slack (primary)', 'See its first answer (secondary)'], 'offered whether or not this workspace runs them');
  await plain.press('try_once');
  assert.deepEqual(shown(plain), [{ kind: 'text', text: 'Practice runs aren\'t available on this workspace yet.' }]);
  assert.deepEqual(plain.labels(), ['Open in Slack (primary)'], 'a retry would read the same');
  assert.equal(plain.shown.title, 'Couldn\'t practice with Invoice Chaser', 'the heading names the refusal, not a first answer');
  assert.equal(told(plain), NOT_STARTED);
  plainly(plain.shown, ['agent_invoice_chaser']);

  // A refusal the server says may pass later.
  const passing = await readyCard(t, 'first-answer-retryable');
  passing.card.hold = (made) => made.tool === 'practice_agent';
  await passing.card.press('try_once');
  passing.card.held[0]!.result = {
    isError: true,
    structuredContent: { error: { code: 'temporarily_unavailable', retryable: true, message: 'Chickpea could not finish that request.' } },
  };
  await passing.card.answer();
  assert.deepEqual(shown(passing.card), [{ kind: 'text', text: 'Chickpea could not finish that request.' }]);
  assert.deepEqual(passing.card.labels(), ['Try again (primary)', 'Open in Slack (secondary)'], 'the server says it may pass later');
  const [retried] = passing.card.calls('practice_agent');
  passing.card.hold = () => false;
  await passing.card.press('try_once');
  assert.deepEqual(passing.card.calls('practice_agent').at(-1)!.args, retried!.args, 'a refusal stored no run, so the same key is a new try');

  // Slack would refuse the person a DM: a guest.
  const limited = await readyCard(t, 'first-answer-limit');
  limited.slack.guest = true;
  await limited.card.press('try_once');
  assert.deepEqual(shown(limited.card), [{ kind: 'text', text: 'You can\'t message Invoice Chaser in Slack yet, so you can\'t practice with it.' }]);
  assert.deepEqual(limited.card.labels(), ['Open in Slack (primary)'], 'not one that passes on a retry');
  assert.deepEqual(limited.runs.starts, []);

  // A run that failed.
  const failed = await readyCard(t, 'first-answer-failed');
  failed.runs.outcome = { status: 'failed', failure: 'deadline', result: null };
  await failed.card.press('try_once');
  assert.deepEqual(shown(failed.card), [{ kind: 'text', text: 'The practice run took too long and was stopped.' }]);
  assert.deepEqual(failed.card.labels(), ['Open in Slack (primary)']);
  assert.equal(failed.card.shown.title, 'Invoice Chaser\'s first answer', 'a run that started stays its first answer');
  assert.equal(told(failed.card), 'The person ran the Agent "Invoice Chaser" (@invoices) once from the card, but it did not finish answering.');

  // A connection that allows no tools yet: the run leaves it out and answers. The card says so under the
  // answer; its fix is Admin's page, which names no service, so no button. Never a step or a raw result.
  const LEFT_OUT = { kind: 'note', text: 'Docs MCP wasn\'t used: none of its tools are marked as ones that only read.', tone: 'warn' };
  const untestable = await readyCard(t, 'first-answer-untestable');
  await connect(untestable, 'agent_invoice_chaser', {
    id: 'connection_docs', providerId: 'docs', label: 'Docs MCP',
    policy: {
      kind: 'mcp', url: 'https://mcp.docs.example/mcp', transport: 'streamable-http', authMode: 'bearer', headerNames: [],
      allowedTools: [], discoveredTools: [{ name: 'search', annotations: { readOnlyHint: true } }],
    },
  });
  const RAW = 'RAW RESULT from the help center';
  untestable.runs.outcome = {
    status: 'answered', failure: null,
    result: {
      reply: REPLY, read: ['Stripe', 'Notion'],
      steps: [{ kind: 'tool', service: 'Stripe', tool: 'stripe_search', input: '{"q":"overdue"}', outcome: 'ok', result: { data: RAW, size: RAW.length, truncated: false } }],
    },
  };
  await untestable.card.press('try_once');
  const { admitted } = untestable.runs.starts[0]!.run;
  assert.equal(admitted.partial, true, 'the run left Docs MCP out');
  assert.deepEqual(admitted.fixes, [{ label: 'Choose its tools in Admin', url: 'https://chickpea.example.test/admin/agents/agent_invoice_chaser' }]);
  assert.equal(JSON.stringify(untestable.card.shown).includes(RAW), false, 'no raw result');
  assert.equal(JSON.stringify(untestable.card.shown).includes('stripe_search'), false, 'no step');
  assert.deepEqual(shown(untestable.card).slice(2), [{ kind: 'note', text: 'It read Stripe and Notion.' }, LEFT_OUT]);
  assert.deepEqual(untestable.card.labels(), ['Open in Slack (primary)', 'Change something (secondary)']);
  assertNoIds(untestable.card.shown, ['connection_docs']);
  assert.equal(untestable.runs.starts.length, 1);

  // One whose tools are allowed but none marked as only reading: the line, and its fix, which goes to the chat. Then Try again, as a new run.
  const markable = await readyCard(t, 'first-answer-markable');
  await connect(markable, 'agent_invoice_chaser', {
    id: 'connection_docs', providerId: 'docs', label: 'Docs MCP',
    policy: {
      kind: 'mcp', url: 'https://mcp.docs.example/mcp', transport: 'streamable-http', authMode: 'bearer', headerNames: [],
      allowedTools: ['search'], discoveredTools: [{ name: 'search' }],
    },
  });
  await markable.card.press('try_once');
  assert.deepEqual(shown(markable.card).slice(2), [{ kind: 'note', text: 'It read Stripe and Notion.' }, LEFT_OUT]);
  assert.deepEqual(markable.card.labels(), ['Open in Slack (primary)', 'Mark Docs MCP\'s read tools (secondary)']);
  await markable.card.press('try_fix');
  assert.deepEqual(markable.card.effects.at(-1), { type: 'message', sent: 'Mark Docs MCP\'s read tools for Invoice Chaser.' });
  assert.deepEqual(markable.card.calls('update_connection'), [], 'the card never makes that change itself');
  assert.deepEqual(shown(markable.card).at(-1), { kind: 'note', text: 'Finish it in the chat, then try again.' });
  assert.deepEqual(markable.card.labels(), ['Try again (primary)', 'Mark Docs MCP\'s read tools (secondary)']);
  markable.clock.now += 3 * 60_000;
  await markable.card.press('try_once');
  const [firstKey, secondKey] = markable.card.calls('practice_agent').map(({ args }) => args.idempotencyKey);
  assert.notEqual(secondKey, firstKey, 'Try again after an answer is a new run, never the answered one again');
  assert.equal(markable.runs.starts.length, 2);

  // A fix the card does not run itself goes to the chat, where the model proposes it: then Try again.
  const marked = await readyCard(t, 'first-answer-chat-fix');
  marked.card.hold = (made) => made.tool === 'practice_agent';
  await marked.card.press('try_once');
  marked.card.held[0]!.result = {
    isError: true,
    structuredContent: {
      error: {
        code: 'not_testable', retryable: false,
        message: 'None of Docs MCP\'s tools are marked as reads, so a practice run can\'t use it. Mark the tools that only read as reads, then try again.',
        fix: { label: 'Mark Docs MCP\'s read tools', tool: 'update_connection', arguments: { agentId: 'agent_invoice_chaser', connectionId: 'docs' } },
      },
    },
  };
  await marked.card.answer();
  assert.deepEqual(marked.card.labels(), ['Mark Docs MCP\'s read tools (primary)', 'Open in Slack (secondary)']);
  await marked.card.press('try_fix');
  assert.deepEqual(marked.card.effects.at(-1), { type: 'message', sent: 'Mark Docs MCP\'s read tools for Invoice Chaser.' });
  assert.deepEqual(marked.card.calls('update_connection'), [], 'the card never makes that change itself');
  assert.deepEqual(marked.card.shown.blocks.at(-1), { kind: 'note', text: 'Finish it in the chat, then try again.' });
  assert.deepEqual(marked.card.labels(), ['Try again (primary)', 'Mark Docs MCP\'s read tools (secondary)']);
  const [firstTry] = marked.card.calls('practice_agent');
  await marked.card.press('try_once');
  assert.deepEqual(marked.card.calls('practice_agent').at(-1)!.args, firstTry!.args, 'Try again sends the same key');

  // A personal connection someone else made, which the caller has yet to sign in to: Admin, on the press.
  const setup = await readyCard(t, 'first-answer-setup');
  await connect(setup, 'agent_invoice_chaser', {
    id: 'connection_personal', providerId: 'linear', label: 'Linear', policy: api('api.linear.app'),
    ownerKind: 'member', ownerMembershipId: setup.f.admin.membership.id,
  });
  await setup.card.press('try_once');
  assert.deepEqual(shown(setup.card), [{ kind: 'text', text: 'Finish setting up Linear first, then try again.' }]);
  assert.deepEqual(setup.card.labels(), ['Finish its setup in Admin (primary)', 'Open in Slack (secondary)']);
  plainly(setup.card.shown, ['connection_personal']);
  await setup.card.press('try_fix');
  assert.deepEqual(setup.card.effects.at(-1), { type: 'open', url: 'https://chickpea.example.test/admin/agents/agent_invoice_chaser' });
  assert.deepEqual(setup.runs.starts, []);

  // A fix through reconnect_service: the press opens Chickpea's page for that connection, then offers Try again.
  const reconnect = await readyCard(t, 'first-answer-reconnect');
  await connect(reconnect, 'agent_invoice_chaser', {
    id: 'connection_notion', providerId: 'notion', label: 'Notion', lifecycle: 'needs_attention',
    policy: { kind: 'managed', adapterId: 'composio', toolkit: 'notion', principalRef: 'chickpea:team', accountRef: 'account_notion', allowedCapabilities: ['notion.read'] },
  });
  reconnect.card.hold = (made) => made.tool === 'practice_agent';
  await reconnect.card.press('try_once');
  reconnect.card.held[0]!.result = {
    isError: true,
    structuredContent: {
      error: {
        code: 'needs_setup', message: 'Finish setting up Notion first, then try again.', retryable: false,
        fix: { label: 'Finish setting up Notion', tool: 'reconnect_service', arguments: { agentId: 'agent_invoice_chaser', connectionId: 'connection_notion' } },
      },
    },
  };
  await reconnect.card.answer();
  assert.deepEqual(reconnect.card.labels(), ['Finish setting up Notion (primary)', 'Open in Slack (secondary)']);
  await reconnect.card.press('try_once');
  assert.equal(reconnect.card.calls('practice_agent').length, 1, 'no Try again before the fix');
  await reconnect.card.press('try_fix');
  assert.deepEqual(reconnect.card.calls('reconnect_service').map(({ args }) => args), [{ agentId: 'agent_invoice_chaser', connectionId: 'connection_notion' }]);
  const page = reconnect.card.effects.at(-1);
  assert.equal(page?.type, 'open');
  assert.match(new URL((page as { url: string }).url).pathname, /^\/setup\//, 'Chickpea\'s page for that one connection');
  assert.deepEqual(reconnect.card.shown.blocks.at(-1), { kind: 'note', text: 'Finish on the Chickpea page that opened, then try again.' });
  assert.deepEqual(reconnect.card.labels(), ['Try again (primary)', 'Finish setting up Notion (secondary)']);
  assert.equal(told(reconnect.card),
    'The person pressed "Finish setting up Notion" for the Agent "Invoice Chaser" (@invoices) on the card, which opened Chickpea\'s page. They can try it again once they finish there.');
  const tries = reconnect.card.calls('practice_agent');
  await reconnect.card.press('try_once');
  assert.deepEqual(reconnect.card.calls('practice_agent').at(-1)!.args, tries[0]!.args, 'Try again sends the same key');

  // A link that comes back without its setupToken is not Chickpea's page for one connection: the chat finishes it.
  const tokenless = await readyCard(t, 'first-answer-tokenless');
  await connect(tokenless, 'agent_invoice_chaser', {
    id: 'connection_notion', providerId: 'notion', label: 'Notion', lifecycle: 'needs_attention',
    policy: { kind: 'managed', adapterId: 'composio', toolkit: 'notion', principalRef: 'chickpea:team', accountRef: 'account_notion', allowedCapabilities: ['notion.read'] },
  });
  tokenless.card.hold = (made) => made.tool === 'practice_agent' || made.tool === 'reconnect_service';
  await tokenless.card.press('try_once');
  tokenless.card.held[0]!.result = {
    isError: true,
    structuredContent: {
      error: {
        code: 'needs_setup', message: 'Finish setting up Notion first, then try again.', retryable: false,
        fix: { label: 'Finish setting up Notion', tool: 'reconnect_service', arguments: { agentId: 'agent_invoice_chaser', connectionId: 'connection_notion' } },
      },
    },
  };
  await tokenless.card.answer();
  await tokenless.card.press('try_fix');
  const linked = tokenless.card.held[0]!;
  const content = linked.result.structuredContent as { setup: Record<string, unknown> };
  assert.equal(typeof content.setup.setupToken, 'string', 'the server sends one');
  const { setupToken: _token, ...link } = content.setup;
  linked.result = { ...linked.result, structuredContent: { ...content, setup: link } };
  const opens = tokenless.card.effects.filter(({ type }) => type === 'open').length;
  await tokenless.card.answer();
  assert.equal(tokenless.card.effects.filter(({ type }) => type === 'open').length, opens, 'nothing opens');
  assert.deepEqual(tokenless.card.effects.at(-1), { type: 'message', sent: 'Finish setting up Notion for Invoice Chaser.' });
  assert.deepEqual(tokenless.card.shown.blocks.at(-1), { kind: 'note', text: 'Finish it in the chat, then try again.' });
  assert.deepEqual(tokenless.card.labels(), ['Try again (primary)', 'Finish setting up Notion (secondary)']);
});

test('a model that cannot run is refused in the card\'s own words, never with an Agent ID or a setting\'s name', async (t) => {
  const tagModel = process.env.SLACK_TAG_MODEL;
  delete process.env.SLACK_TAG_MODEL;
  t.after(() => { if (tagModel !== undefined) process.env.SLACK_TAG_MODEL = tagModel; });
  const { f, card, teamId, runs } = await readyCard(t, 'first-answer-no-model');
  // An install from before the Workspace default, with no model pinned: Chickpea's own reason names the Agent's ID and a setting.
  await f.config.updateWorkspaceInstallation(teamId, { runtimeContract: 'legacy' });
  await f.config.updateAgent('agent_invoice_chaser', { model: null });
  card.hold = (made) => made.tool === 'practice_agent';
  await card.press('try_once');
  const { error } = card.held[0]!.result.structuredContent as { error: { code: string } };
  assert.equal(error.code, 'model_unavailable');
  await card.answer();
  assert.deepEqual(card.shown.blocks, [{ kind: 'text', text: 'Invoice Chaser can\'t run right now. No model is ready for it. Choose one in Admin.' }]);
  const drawn = JSON.stringify({ ...card.shown, avatarUrl: undefined });
  assert.doesNotMatch(drawn, /agent_invoice_chaser|SLACK_TAG_MODEL|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\/admin/, drawn);
  plainly(card.shown, ['agent_invoice_chaser']);
  assert.deepEqual(runs.starts, []);
});

test('a fix that is a link is offered and opened only when it is a web link', async (t) => {
  const links = [['http', 'http://plain.example/x'], ['script', 'javascript:alert(1)'], ['text', 'not a url'], ['https', 'https://chickpea.example.test/admin/agents/agent_invoice_chaser']] as const;
  for (const [name, url] of links) {
    const { card } = await readyCard(t, `first-answer-link-${name}`);
    card.hold = (made) => made.tool === 'practice_agent';
    await card.press('try_once');
    card.held[0]!.result = {
      isError: true,
      structuredContent: {
        error: {
          code: 'not_testable', retryable: false,
          message: 'None of Docs MCP\'s tools are marked as reads, so a practice run can\'t use it.',
          fix: { label: 'Open the Agent in Admin', url },
        },
      },
    };
    await card.answer();
    await card.press('try_fix');
    const opened = card.effects.filter((effect) => effect.type === 'open').map((effect) => (effect as { url: string }).url);
    if (name === 'https') {
      assert.deepEqual(opened, [url]);
      assert.deepEqual(card.labels(), ['Try again (primary)', 'Open the Agent in Admin (secondary)']);
    } else {
      assert.deepEqual(opened, [], `${url} opens nothing`);
      assert.deepEqual(card.labels(), ['Open in Slack (primary)'], `${url} is not offered`);
      assert.equal(JSON.stringify(card.shown).includes('page that opened'), false);
    }
  }
});

test('a link or message the host refused counts only when this view offered it, and a fix it refused is offered again', async (t) => {
  const { card, clock } = await readyCard(t, 'first-answer-refused');
  card.hold = (made) => made.tool === 'practice_agent';
  await card.press('try_once');
  const admin = 'https://chickpea.example.test/admin/agents/agent_invoice_chaser';
  card.held[0]!.result = {
    isError: true,
    structuredContent: {
      error: {
        code: 'not_testable', retryable: false,
        message: 'None of Docs MCP\'s tools are marked as reads, so a practice run can\'t use it.',
        fix: { label: 'Open the Agent in Admin', url: admin },
      },
    },
  };
  await card.answer();
  await card.press('try_fix');
  const acted = card.state;
  await card.dispatch({ type: 'refused', effect: { type: 'open', url: 'https://elsewhere.example/' }, now: clock.now });
  await card.dispatch({ type: 'refused', effect: { type: 'message', sent: 'Something else.' }, now: clock.now });
  assert.deepEqual(card.state, acted, 'not a link or message this view offers');
  await card.dispatch({ type: 'refused', effect: { type: 'open', url: admin }, now: clock.now });
  assert.equal(card.state.error, 'That did not work. Try again.');
  assert.deepEqual(card.shown.blocks, [{
    kind: 'text', text: 'None of Docs MCP\'s tools are marked as reads, so a practice run can\'t use it.',
  }], 'no page opened');
  assert.deepEqual(card.labels(), ['Open the Agent in Admin (primary)', 'Open in Slack (secondary)']);

  // On the answer: Open in Slack and Change something are this view's.
  const answered = await readyCard(t, 'first-answer-refused-answer');
  await answered.card.press('try_once');
  await answered.card.press('open_slack');
  const slack = answered.card.effects.at(-1)!;
  assert.equal(slack.type, 'open');
  await answered.card.dispatch({ type: 'refused', effect: slack as { type: 'open'; url: string }, now: answered.clock.now });
  assert.equal(answered.card.state.error, 'That did not work. Try again.');
});

test('while Chickpea says another practice run is going, the card asks again every 5 seconds for a minute, then offers Try again with the same key', async (t) => {
  const { card, runs, clock } = await readyCard(t, 'first-answer-held');
  runs.refuse = { kind: 'in_progress' };
  await card.press('try_once');
  const [first] = card.calls('practice_agent');
  assert.deepEqual(card.shown.blocks, [{ kind: 'steps', steps: [{ label: 'Waiting for another practice run to finish', state: 'now' }] }]);
  assert.deepEqual(card.effects.at(-1), { type: 'timer', inMs: HELD_RETRY_MS });
  for (let waited = HELD_RETRY_MS; waited < HELD_FOR_MS; waited += HELD_RETRY_MS) {
    clock.now += HELD_RETRY_MS;
    await card.dispatch({ type: 'tick', now: clock.now });
  }
  clock.now += HELD_RETRY_MS;
  await card.dispatch({ type: 'tick', now: clock.now });
  assert.deepEqual(card.shown.blocks, [{ kind: 'text', text: 'A practice run is still going. Wait for it, then ask again.' }]);
  assert.deepEqual(card.labels(), ['Try again (primary)', 'Open in Slack (secondary)']);
  const tries = card.calls('practice_agent');
  assert.equal(tries.length, HELD_FOR_MS / HELD_RETRY_MS + 1, 'every 5 s for a minute');
  assert.deepEqual(new Set(keys(tries)), new Set([first!.args.idempotencyKey]));
  await card.dispatch({ type: 'tick', now: clock.now + HELD_RETRY_MS });
  assert.equal(card.calls('practice_agent').length, tries.length, 'then only a press');

  runs.refuse = undefined;
  await card.press('try_once');
  assert.deepEqual(card.calls('practice_agent').at(-1)!.args, first!.args);
  assert.equal(card.state.view.kind === 'first_answer' && card.state.view.stage.kind, 'answered');
  assert.equal(runs.starts.length, 1);
});

test('a run another one held up gets its own three minutes from when it began', async (t) => {
  const { card, runs, clock } = await readyCard(t, 'first-answer-held-clock');
  fastTime(t);
  runs.refuse = { kind: 'in_progress' };
  await card.press('try_once');
  clock.now += HELD_FOR_MS - HELD_RETRY_MS;
  runs.refuse = undefined;
  runs.outcome = { status: 'running', failure: null, result: null };
  card.hold = (made) => made.tool === 'get_practice_run';
  await card.dispatch({ type: 'tick', now: clock.now });
  assert.equal(runs.starts.length, 1, 'it began now');
  const stage = () => card.state.view.kind === 'first_answer' && card.state.view.stage.kind;
  clock.now += GIVE_UP_MS - 1_000;
  await card.answer();
  assert.equal(stage(), 'running', 'still inside its own three minutes');
  clock.now += 1_000;
  await card.answer();
  assert.equal(stage(), 'slow');
});

test('the promised pane shows only the promise this card holds, for the question it promised', async (t) => {
  // The run asked something else: no promise beside it.
  const other = await readyCard(t, 'first-answer-other-ask');
  other.card.hold = (made) => made.tool === 'practice_agent';
  await other.card.press('try_once');
  const held = other.card.held[0]!;
  held.result = { ...held.result, structuredContent: { ...held.result.structuredContent as object, question: 'what is due today?' } };
  await other.card.answer();
  const panes = other.card.shown.blocks.find((block) => block.kind === 'panes');
  assert.deepEqual(panes, { kind: 'panes', panes: [{ label: 'What it answered', text: plainText(REPLY) }] });
  assert.equal(JSON.stringify(other.card.shown).includes(PROMISED), false);

  // A card the model's own create_agent drew holds no proposal.
  const w = await world(t, 'first-answer-from-model');
  const proposal = await w.call('propose_agent', {
    name: 'Invoice Chaser', handle: 'invoices', job: 'Chases overdue invoices.', instructions: 'Chase.', sampleAsk: ASK, promisedAnswer: PROMISED,
  });
  const card = cardHost(AGENT_CARD, w.call, w.clock);
  await card.result(await w.call('create_agent', proposal.structuredContent!.create.arguments));
  await sayHello(w, 'agent_invoice_chaser');
  await card.dispatch({ type: 'tick', now: w.clock.now });
  assert.deepEqual(card.labels(), ['Open in Slack (primary)', 'See its first answer (secondary)'], 'it has a first question all the same');
  await card.press('try_once');
  const shown = card.shown.blocks.find((block) => block.kind === 'panes');
  assert.deepEqual(shown, { kind: 'panes', panes: [{ label: 'What it answered', text: plainText(REPLY) }] });
  assert.equal(JSON.stringify(card.shown).includes(PROMISED), false, 'the proposal\'s promise was never this card\'s');
});

test('an Agent with no first question keeps the ready card\'s other buttons', async (t) => {
  const w = await world(t, 'first-answer-no-ask');
  const { createFixtureAgent } = await import('./helpers/management-adapter-fixture.ts');
  await createFixtureAgent(w.f, 'agent_plain', { name: 'Plain Helper' });
  const status = await w.call('get_creation_status', { agentId: 'agent_plain' });
  assert.equal(status.structuredContent!.agent.hasFirstAsk, undefined, 'no first question, no flag');
  const card = cardHost(AGENT_CARD, w.call, w.clock);
  await card.result({ structuredContent: { status: 'done', summary: 'Created Plain Helper.', agent: { agentId: 'agent_plain', name: 'Plain Helper' } }, _meta: { 'chickpea/tool': 'create_agent' } });
  assert.equal(card.state.view.kind, 'ready', JSON.stringify(card.state.view));
  assert.equal(card.labels().some((label) => label.startsWith('See its first answer')), false);
  await card.press('try_once');
  assert.deepEqual(card.calls('practice_agent'), [], 'a press that is not offered sends nothing');
});

test('the connect card offers its first answer once the service is connected, for an Agent with a first question, and shows no promise', async (t) => {
  const w = await readyCard(t, 'first-answer-connect');
  const { f, call, clock, runs } = w;
  const finished = new Map<string, 'completed'>();
  const getOperation = f.service.getOperation.bind(f.service);
  f.service.getOperation = async (context, id) => {
    const result = await getOperation(context, id);
    return finished.has(id) && result && 'setupOperationId' in result ? { ...result, status: 'completed' as const } : result;
  };
  const { createFixtureAgent } = await import('./helpers/management-adapter-fixture.ts');
  await createFixtureAgent(f, 'agent_plain', { name: 'Plain Helper' });

  const connected = async (agentId: string) => {
    const result = await call('connect_service', { agentId, service: 'Gmail', owner: 'me', idempotencyKey: `gmail-${agentId}` });
    const { setupToken } = result.structuredContent!.setup;
    const card = cardHost(CONNECT_CARD, call, clock);
    await card.result(result);
    await card.press('connect');
    finished.set(setupToken, 'completed');
    await card.dispatch({ type: 'tick', now: clock.now });
    assert.equal(card.state.view.kind, 'connected');
    return { card, setupToken };
  };

  const plain = await connected('agent_plain');
  assert.equal((await call('get_setup_status', { setupToken: plain.setupToken })).structuredContent!.agent.hasFirstAsk, undefined);
  const plainRow = plain.card.shown.blocks.find((block) => block.kind === 'rows');
  assert.equal(plainRow?.kind === 'rows' && plainRow.rows[0]!.control?.label, 'Open in Slack', 'no first question: today\'s next step');

  const { card, setupToken } = await connected('agent_invoice_chaser');
  assert.equal((await call('get_setup_status', { setupToken })).structuredContent!.agent.hasFirstAsk, true);
  const row = card.shown.blocks.find((block) => block.kind === 'rows');
  assert.deepEqual(row?.kind === 'rows' && row.rows[0]!.control, { label: 'See its first answer', action: 'try_once', style: 'secondary' });
  for (const idle of ['reread', 'tick'] as const) await card.dispatch({ type: idle, now: clock.now });
  assert.deepEqual(card.calls('practice_agent'), [], 'nothing runs until the press');

  await card.press('try_once');
  assert.equal(runs.starts.length, 1);
  assert.equal(card.shown.title, 'Invoice Chaser\'s first answer');
  assert.deepEqual(card.shown.blocks.find((block) => block.kind === 'panes'), {
    kind: 'panes', panes: [{ label: 'What it answered', text: plainText(REPLY) }],
  }, 'the connect card holds no proposal');
  assert.deepEqual(card.labels(), ['Open in Slack (primary)', 'Change something (secondary)']);
  await card.press('change_something');
  assert.deepEqual(card.effects.at(-1), { type: 'message', draft: 'Change Invoice Chaser: ', sent: 'Change Invoice Chaser: ' });
});

test('on a card host the test-run results reach the card whole, with no token held back', async (t) => {
  const { card, call, runs } = await readyCard(t, 'first-answer-session');
  void card;
  const tried = await call('try_agent_once', { agentId: 'agent_invoice_chaser', idempotencyKey: 'session-key' });
  assert.equal(tried._meta?.['chickpea/tool'], 'try_agent_once');
  assert.equal(tried._meta?.['chickpea/held'], undefined, 'a test run carries no confirm or undo token');
  assert.deepEqual(Object.keys(tried.structuredContent!).sort(), ['ask', 'note', 'read', 'reply', 'runToken', 'status']);
  const read = await call('get_test_run', { runToken: tried.structuredContent!.runToken });
  assert.equal(read._meta?.['chickpea/held'], undefined);
  assert.deepEqual(read.structuredContent, tried.structuredContent);
  assert.equal(runs.starts.length, 1);
});

test('an answer\'s Markdown reads as plain text, and code and marks that are not Markdown stay as written', () => {
  assert.equal(plainText('## Overdue\n**Acme** owes `$4,200`. See [the invoice](https://x.example/1).\n* one\n  - two\n```\ncode\n```'),
    'Overdue\nAcme owes $4,200. See the invoice.\n• one\n  • two\ncode\n');
  assert.equal(plainText('2 * 3 * 4 = 24, 5*3, snake_case_name and file_name_v2 stay'), '2 * 3 * 4 = 24, 5*3, snake_case_name and file_name_v2 stay');
  assert.equal(plainText('__init__ is bold, `__init__` and `*args*` are code'), 'init is bold, __init__ and *args* are code');
  assert.equal(plainText('```py\n# keep\ndef f(*args): return a_b_c\n```\n**Run `npm test`** first'),
    '# keep\ndef f(*args): return a_b_c\nRun npm test first');
  assert.equal(plainText('![chart](https://x.example/c.png)'), 'chart', 'an image is its words, never a picture');

  // Single-mark emphasis, as a real reply ends a line with its source.
  assert.equal(plainText('*italic* and _also_ and ***both***'), 'italic and also and both');
  assert.equal(plainText([
    '- **Ledger:** INV-204 — two overdue, one due today. *(Ledger service)*',
    '- **Owner:** unavailable; the connected Ledger tool does not expose ownership.',
    '- **Payments:** stage **retry**, collected **40%**. *(Payments API)*',
  ].join('\n')), [
    '• Ledger: INV-204 — two overdue, one due today. (Ledger service)',
    '• Owner: unavailable; the connected Ledger tool does not expose ownership.',
    '• Payments: stage retry, collected 40%. (Payments API)',
  ].join('\n'));
  assert.equal(plainText('* one *two*'), '• one two');

  // A table reads row by row; quotes, strikethrough and rules lose their marks.
  assert.equal(plainText('| Customer | Amount |\n|---|---:|\n| **Northwind** | $1,240 |\n| Lumen | $860 |'),
    'Customer · Amount\nNorthwind · $1,240\nLumen · $860');
  assert.equal(plainText('> Two are _late_.\n\n---\n~~Three~~ Two in all.'), 'Two are late.\n\nThree Two in all.');
  assert.equal(plainText('a | b and - - - stay'), 'a | b and - - - stay');
});
