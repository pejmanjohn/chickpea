import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';

import * as agentCard from '../src/mcp-cards/agent-card/model.ts';
import { keptState, type CardState, type Memory } from '../src/mcp-cards/card-model.ts';
import { GIVE_UP_MS, HELD_FOR_MS, HELD_RETRY_MS, KEPT_ANSWER_CHARS, PRACTICE_SHOWN } from '../src/mcp-cards/first-answer.ts';
import { cardAssetPath, cardVersions, CARD_NAMES } from '../src/mcp-cards/published.ts';
import { asChatGpt, cardHost, cardServer, type CardModelUnderTest } from './helpers/mcp-card-host.ts';
import { slackMember } from './helpers/slack-members.ts';
import { StubTestRuns, type TestRunOutcome } from './helpers/stub-test-runs.ts';

/**
 * "Try it again" on the Saved card, against Core's real MCP server through
 * ChatGPT's delivery: practice_agent with no question, then
 * get_practice_run, over a stub of the state store's runs. The card draws
 * the answer as After, beside the last practice answer it has as Before,
 * and tells the host's model only that a practice answer is on the card.
 */

const AGENT_CARD: CardModelUnderTest<agentCard.View, agentCard.Action> = {
  ...agentCard,
  initial: agentCard.INITIAL,
  reads: new Set(['get_creation_status', 'get_agent', 'get_confirmation', 'get_practice_run']),
  followsPress: ({ view }) => view.kind === 'first_answer',
  replays: new Set(['practice_agent']),
};

const AGENT = 'agent_invoices';
const ASK = 'who is overdue this week?';
const FIRST = '**2 invoices** are overdue:\n- Northwind, $1,240\n- [Lumen Labs](https://dashboard.stripe.com/x), $860';
/** As practice_agent sends it: a `<` that could open a tag escaped for clients that render the answer. */
const SECOND = 'Northwind owes $1,240. Write to Ada &lt;ada@northwind.example> first.';
const answered = (reply: string): TestRunOutcome => ({ status: 'answered', failure: null, result: { reply, read: ['Stripe'] } });

async function world(t: TestContext, suffix: string, agent: { firstAsk?: string | null } = {}) {
  const runs = new StubTestRuns(answered(FIRST));
  const slack = { team: '', guest: false };
  const server = await cardServer(t, suffix, {
    modelReadiness: async () => async () => undefined,
    slackMember: async (id) => slackMember(id, slack.team, { restricted: slack.guest }),
    testRuns: runs,
  }, { cards: true });
  const { f, teamId, call, clock } = server;
  slack.team = teamId;
  runs.now = () => clock.now;
  await f.config.ensureWorkspaceInstallation({ workspaceId: teamId, transportMode: 'direct', botUserId: 'UBOT', runtimeContract: 'chickpea-v1' });
  await f.config.createAgent({
    id: AGENT, name: 'Invoice Chaser', instructions: '# Job\nChase invoices.', enabled: true, lifecycle: 'active',
    creatorMembershipId: f.owner.membership.id, editPolicy: 'creator_and_admins', configurationGeneration: 1,
    model: 'local-stub/invoices', skills: [], mcpServers: [], apiConnections: [], repositories: [],
    slackPresence: { requestedHandle: 'invoices', normalizedHandle: 'invoices', desiredState: 'active', health: 'healthy', avatar: { kind: 'generated', revision: 1, seed: 'invoices' } },
  } as never, undefined, agent.firstAsk === null ? undefined : agent.firstAsk ?? ASK);
  const version = async () => (await call('get_agent', { agentId: AGENT })).structuredContent!.version as string;
  /** A card drawn with propose_agent_change's preview, as ChatGPT delivers the card's calls. */
  const preview = async (change: Record<string, unknown>, options: Parameters<typeof asChatGpt>[1] = {}) => {
    const card = cardHost(AGENT_CARD, asChatGpt(call, options), clock);
    await card.result(await call('propose_agent_change', { agentId: AGENT, version: await version(), change }));
    return card;
  };
  /** The Saved card: that preview, saved on the card. */
  const saved = async (change: Record<string, unknown> = { instructions: '# Job\nChase invoices. Name each customer.' }, options = {}) => {
    const card = await preview(change, options);
    await card.press('save');
    assert.equal(card.state.view.kind, 'done', JSON.stringify(card.state.view));
    return card;
  };
  return { ...server, runs, slack, version, preview, saved };
}

/** The server's waits for a run that is still going pass at once: every turn of the event loop moves the mocked clock on a second. */
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

type Card = Awaited<ReturnType<Awaited<ReturnType<typeof world>>['saved']>>;

/** The newest sentence the card told the host's model. */
const told = (card: Card) => (card.effects.findLast(({ type }) => type === 'context') as { text: string } | undefined)?.text.split('\n').at(-1);
const panes = (card: Card) => card.shown.blocks.find((block) => block.kind === 'panes');
const memoryOf = ({ told: sentences = [], outcome }: CardState<agentCard.View>): Memory => ({ told: sentences, ...outcome === undefined ? {} : { outcome } });

// Mutation proof: each half of the show condition (the first question, the field, an Agent that answers) is cut by a case below.
test('the Saved card offers Try it again only for an Agent with a first question, after a save that changes how it answers', async (t) => {
  const w = await world(t, 'try-again-offered');
  const offered = ['Try it again (primary)', 'Undo (secondary)'];
  const notOffered = ['Undo (secondary)', 'Open in Slack (secondary)'];
  for (const change of [
    { instructions: '# Job\nChase invoices. Name each customer.' },
    { model: 'local-stub/sharper' },
    { effort: 'high' },
    { instructions: '# Job\nChase invoices politely.', description: 'Chases invoices.' },
  ]) {
    assert.deepEqual((await w.saved(change)).labels(), offered, JSON.stringify(change));
  }
  for (const change of [{ description: 'Chases overdue invoices.' }, { name: 'Invoice Desk' }, { whoCanEdit: 'all_workspace_members' }]) {
    const card = await w.saved(change);
    assert.deepEqual(card.labels(), notOffered, JSON.stringify(change));
    await card.press('try_once');
    assert.deepEqual(card.calls('practice_agent'), [], 'a button that is not offered sends nothing');
  }
  // Turned off by the same save: it answers no one, so there is nothing to try.
  const off = await w.saved({ instructions: '# Job\nChase invoices later.', on: false });
  assert.equal(off.shown.subtitle?.[0]?.text, 'It won\'t answer in Slack until it\'s turned back on.');
  assert.equal(off.labels().some((label) => label.startsWith('Try it again')), false);

  // A save the model made itself says nothing of what changed, so its card offers no Try it again.
  const bare = cardHost(AGENT_CARD, w.call, w.clock);
  await bare.result(await w.call('update_agent', { agentId: AGENT, version: await w.version(), on: true, instructions: '# Job\nChase.', idempotencyKey: 'model-save' }));
  assert.deepEqual(bare.labels(), notOffered);

  // No first question saved: practice_agent would have nothing to ask.
  const plain = await world(t, 'try-again-no-ask', { firstAsk: null });
  const preview = await plain.preview({ instructions: '# Job\nChase invoices. Name each customer.' });
  assert.equal((preview.state.view as { preview: { agent: { hasFirstAsk?: boolean } } }).preview.agent.hasFirstAsk, undefined);
  await preview.press('save');
  assert.deepEqual(preview.labels(), notOffered);
  assert.equal(w.runs.starts.length + plain.runs.starts.length, 0, 'nothing ran');
});

test('Try it again asks the first question with practice_agent, then draws After, and Before beside the next one', async (t) => {
  const { runs, clock, saved } = await world(t, 'try-again-before-after');
  const card = await saved();
  assert.equal(card.shown.subtitle?.[0]?.text, 'Try it: message @invoices in Slack.');
  await card.press('try_once');
  assert.deepEqual(card.calls('practice_agent').map(({ args }) => args), [{ agentId: AGENT, idempotencyKey: `try:${AGENT}:${clock.now}` }],
    'no question and no practiceId: the stored first question');
  assert.equal(runs.starts[0]!.run.question, ASK);
  assert.deepEqual(card.shown.blocks, [
    { kind: 'note', text: `First question: “${ASK}”` },
    { kind: 'panes', panes: [{ label: 'After', text: '2 invoices are overdue:\n• Northwind, $1,240\n• Lumen Labs, $860' }] },
    { kind: 'note', text: 'It read Stripe.' },
  ], 'no answer from before this card, so After alone');
  assert.deepEqual(card.labels(), ['Try it again (primary)', 'Undo (secondary)']);
  assert.equal(told(card), `The person pressed "Try it again" for the Agent "Invoice Chaser" (@invoices) on the card. ${PRACTICE_SHOWN}`);

  // After another change made elsewhere: the answer this card showed is Before.
  runs.outcome = answered(SECOND);
  clock.now += 60_000;
  await card.press('try_once');
  assert.equal(runs.starts.length, 2, 'a new key: a new run');
  assert.deepEqual(panes(card), { kind: 'panes', panes: [
    { label: 'Before', text: '2 invoices are overdue:\n• Northwind, $1,240\n• Lumen Labs, $860' },
    { label: 'After', text: 'Northwind owes $1,240. Write to Ada <ada@northwind.example> first.' },
  ] });
  // Its picture's address may name the Agent; nothing else drawn does.
  const drawn = JSON.stringify({ ...card.shown, avatarUrl: undefined });
  assert.equal(drawn.includes('&lt;'), false, 'the `<` the Agent wrote, never &lt;');
  for (const id of [AGENT, runs.runs[0]!.view.runToken, runs.runs[1]!.view.runToken, 'try:']) assert.equal(drawn.includes(id), false, `${id} drawn`);
  // Everything the card told before, then one sentence, without the answer.
  const context = (card.effects.findLast(({ type }) => type === 'context') as { text: string }).text;
  assert.deepEqual(context.split('\n'), [
    'The person saved the change to the Agent "Invoice Chaser" from the card.',
    `The person pressed "Try it again" for the Agent "Invoice Chaser" (@invoices) on the card. ${PRACTICE_SHOWN}`,
  ], 'the same sentence told again moves to the end');
  assert.doesNotMatch(context, /Northwind|overdue/);
});

test('what the card keeps holds the last answer only where the host hides it from its model, and never the run\'s token', async (t) => {
  const w = await world(t, 'try-again-kept');
  const card = await w.saved();
  const memory = memoryOf(card.state);
  assert.deepEqual(memory.outcome, { kind: 'done', summary: 'Saved Invoice Chaser.', practice: {} }, 'the save offers Try it again');
  await card.press('try_once');
  const state = keptState(card.state, cardVersions('agent-card').at(-1)!);
  const answer = '2 invoices are overdue:\n• Northwind, $1,240\n• Lumen Labs, $860';
  assert.deepEqual(state.privateContent.card.outcome, { kind: 'done', summary: 'Saved Invoice Chaser.', practice: { answer } });
  assert.equal(state.modelContent, state.privateContent.card.told.join('\n'), 'the model reads only what the card told it');
  assert.ok(state.modelContent.endsWith(PRACTICE_SHOWN));
  assert.doesNotMatch(state.modelContent, /Northwind|overdue/, 'the answer is not the model\'s to read here');
  const written = JSON.stringify(state);
  const undoToken = (card.state.view as { again?: { undoToken?: string } }).again?.undoToken;
  assert.ok(undoToken, 'the card holds Undo beside the answer');
  for (const secret of [w.runs.runs[0]!.view.runToken, 'try:', AGENT, 'practiceId', undoToken]) {
    assert.equal(written.includes(secret), false, `${secret} kept`);
  }

  // The chat reopens: the card comes back to the Saved card, and its next answer has the kept one as Before.
  const reopened = cardHost(AGENT_CARD, asChatGpt(w.call), w.clock);
  // A reopened card mounts with the preview it was first drawn with.
  const result = await w.call('propose_agent_change', { agentId: AGENT, version: await w.version(), change: { description: 'Chases invoices.' } });
  await reopened.dispatch({ type: 'result', result, now: w.clock.now, kept: memoryOf(card.state) });
  assert.equal(reopened.shown.title, 'Saved Invoice Chaser');
  assert.deepEqual(reopened.labels(), ['Try it again (primary)'], 'no Undo: a reopened card holds no token');
  w.runs.outcome = answered(SECOND);
  w.clock.now += 60_000;
  await reopened.press('try_once');
  assert.deepEqual(panes(reopened), { kind: 'panes', panes: [
    { label: 'Before', text: answer },
    { label: 'After', text: 'Northwind owes $1,240. Write to Ada <ada@northwind.example> first.' },
  ] });
  assert.deepEqual(reopened.labels(), ['Try it again (primary)', 'Change something (secondary)']);

  // Kept state is untrusted: an answer longer than any the card keeps is dropped, and Try it again stays.
  const tampered = cardHost(AGENT_CARD, w.call, w.clock);
  await tampered.dispatch({
    type: 'result', result, now: w.clock.now,
    kept: { told: [], outcome: { kind: 'done', summary: 'Saved Invoice Chaser.', practice: { answer: 'x'.repeat(KEPT_ANSWER_CHARS + 1) } } },
  });
  assert.deepEqual(tampered.labels(), ['Try it again (primary)']);
  await tampered.press('try_once');
  assert.deepEqual((panes(tampered) as { panes: Array<{ label: string }> }).panes.map(({ label }) => label), ['After']);
});

test('an answer longer than the card keeps is cut for Before, with a mark that it was cut', async (t) => {
  const w = await world(t, 'try-again-long');
  const card = await w.saved();
  w.runs.outcome = answered('word '.repeat(1_000));
  await card.press('try_once');
  w.runs.outcome = answered('Short now.');
  w.clock.now += 60_000;
  await card.press('try_once');
  const [before] = (panes(card) as { panes: Array<{ label: string; text: string }> }).panes;
  assert.equal(before!.label, 'Before');
  assert.equal(before!.text.length, KEPT_ANSWER_CHARS);
  assert.ok(before!.text.endsWith('…'));
});

test('Undo stays beside a Try it again answer and undoes the save', async (t) => {
  const w = await world(t, 'try-again-undo');
  const card = await w.saved();
  const { undoToken } = card.state.view as { undoToken: string };
  await card.press('try_once');
  assert.deepEqual(card.labels(), ['Try it again (primary)', 'Undo (secondary)']);
  await card.press('undo');
  assert.deepEqual(card.calls('undo_change').map(({ args }) => args), [{ undoToken, idempotencyKey: `undo:${undoToken}` }]);
  assert.equal(card.shown.title, 'Undid the change');
  assert.equal(told(card), 'The person undid the change to the Agent "Invoice Chaser" from the card.');
  assert.equal((await w.f.config.getAgent(AGENT))!.instructions, '# Job\nChase invoices.');
  assert.deepEqual(memoryOf(card.state).outcome, { kind: 'done', summary: 'Undid the change.' }, 'no Try it again after an undo');

  // Undo is offered only beside the answer, and only with the save's token.
  fastTime(t);
  const running = await w.saved();
  w.runs.outcome = { status: 'running', failure: null, result: null };
  running.hold = ({ tool }) => tool === 'get_practice_run';
  await running.press('try_once');
  assert.deepEqual(running.labels(), []);
  await running.press('undo');
  assert.deepEqual(running.calls('undo_change'), [], 'nothing to undo while it answers');
});

test('a refusal or a failed run shows its own sentence on Try it again, as ChatGPT delivers it', async (t) => {
  const NOT_STARTED = 'The person pressed "Try it again" for the Agent "Invoice Chaser" (@invoices) on the card, but the practice run did not start.';

  // Slack would refuse the person a DM: no Try again, which would read the same.
  const guest = await world(t, 'try-again-guest');
  const refused = await guest.saved();
  guest.slack.guest = true;
  await refused.press('try_once');
  assert.deepEqual(refused.shown.blocks, [{ kind: 'text', text: 'You can\'t message Invoice Chaser in Slack yet, so you can\'t practice with it.' }]);
  assert.deepEqual(refused.labels(), ['Open in Slack (primary)'], 'not one that passes on a retry');
  assert.equal(told(refused), NOT_STARTED);
  assert.deepEqual(guest.runs.starts, []);

  // A run another holds: the card waits a minute, then shows the sentence with Try again, which sends the same key.
  const held = await world(t, 'try-again-in-progress');
  const busy = await held.saved();
  held.runs.refuse = { kind: 'in_progress' };
  await busy.press('try_once');
  for (let waited = 0; waited <= HELD_FOR_MS; waited += HELD_RETRY_MS) {
    held.clock.now += HELD_RETRY_MS;
    await busy.dispatch({ type: 'tick', now: held.clock.now });
  }
  assert.deepEqual(busy.shown.blocks, [{ kind: 'text', text: 'A practice run is still going. Wait for it, then ask again.' }]);
  assert.deepEqual(busy.labels(), ['Try again (primary)', 'Open in Slack (secondary)']);
  held.runs.refuse = undefined;
  await busy.press('try_once');
  assert.equal(new Set(busy.calls('practice_agent').map(({ args }) => args.idempotencyKey)).size, 1);
  assert.equal((panes(busy) as { panes: Array<{ label: string }> }).panes.at(-1)!.label, 'After');

  // The plan refused it as it would a direct message: its own words.
  const funded = await world(t, 'try-again-funding');
  const out = await funded.saved();
  funded.runs.outcome = { status: 'failed', failure: 'out_of_usage', result: { funding: { kind: 'credits_exhausted' } } } as TestRunOutcome;
  await out.press('try_once');
  assert.deepEqual(out.shown.blocks, [{ kind: 'text', text: 'This workspace is out of usage for now, so I can\'t start this one. Once an Owner adds more, send it again.' }]);
  assert.equal(told(out), 'The person pressed "Try it again" for the Agent "Invoice Chaser" (@invoices) on the card, but it did not finish answering.');

  // Before ChatGPT lists practice_agent ("MCP Resource not found"): unreachable, tried again, then Check again.
  const unlisted = await world(t, 'try-again-unlisted');
  const waiting = await unlisted.saved(undefined, { unlisted: ['practice_agent'] });
  await waiting.press('try_once');
  assert.deepEqual(waiting.effects.at(-1), { type: 'timer', inMs: 2_000 }, 'not a refusal: the same call again');
  unlisted.clock.now += GIVE_UP_MS;
  await waiting.dispatch({ type: 'tick', now: unlisted.clock.now });
  assert.deepEqual(waiting.labels(), ['Check again (primary)', 'Open in Slack (secondary)']);
  assert.equal(told(waiting), 'The person pressed "Try it again" for the Agent "Invoice Chaser" (@invoices) on the card, but its answer did not come back in time.');
  assert.deepEqual(unlisted.runs.starts, []);
});

/**
 * What every first-answer view of an Agent card published before practice
 * runs (agent v6 to v10, connect v4 to v8) reads from the names it calls:
 * a status, a runToken and the question as `ask`, then the reply as text.
 */
function readByAnOldCard(content: unknown): { status: string; runToken: string; ask: string; reply?: string; read?: string[] } {
  const run = content as Record<string, unknown>;
  assert.ok(['running', 'answered', 'failed'].includes(run.status as string), JSON.stringify(run));
  assert.equal(typeof run.runToken, 'string');
  assert.equal(typeof run.ask, 'string');
  return run as never;
}

// Mutation proof (the alias decision): unregistered, a redrawn old card gets "tool not found"; mapped to the new shape, it reads no `ask`.
test('a card published before practice runs gets the same run under its old names, in the shape it reads', async (t) => {
  const w = await world(t, 'try-again-old-names');
  const { call, runs } = w;
  runs.outcome = answered(SECOND);
  const tried = await call('try_agent_once', { agentId: AGENT, idempotencyKey: 'old-card-key' });
  assert.equal(tried.isError, undefined);
  assert.deepEqual(Object.keys(tried.structuredContent!).sort(), ['ask', 'note', 'read', 'reply', 'runToken', 'status']);
  const run = readByAnOldCard(tried.structuredContent);
  assert.deepEqual([run.status, run.ask, run.reply], ['answered', ASK, 'Northwind owes $1,240. Write to Ada <ada@northwind.example> first.'],
    'an old card draws the reply as text, so it gets the `<` the Agent wrote');
  assert.deepEqual(readByAnOldCard((await call('get_test_run', { runToken: run.runToken })).structuredContent), run);
  // The same run practice_agent started for that key: one run, admitted by the same checks.
  const practice = await call('practice_agent', { agentId: AGENT, idempotencyKey: 'old-card-key' });
  assert.equal(practice.structuredContent!.runToken, run.runToken);
  assert.equal(runs.starts.length, 1);
  // On a card session its refusals are results an old card reads.
  w.slack.guest = true;
  const refused = await call('try_agent_once', { agentId: AGENT, idempotencyKey: 'old-card-guest' });
  assert.equal(refused.isError, false);
  assert.equal((refused.structuredContent as { error: { code: string } }).error.code, 'not_allowed');
  // Listed for cards only.
  const listed = JSON.parse(await w.send('tools/list', {})).result.tools as Array<{ name: string; _meta?: { ui?: { visibility?: string[] } } }>;
  for (const name of ['try_agent_once', 'get_test_run']) {
    assert.deepEqual(listed.find((tool) => tool.name === name)?._meta?.ui?.visibility, ['app'], name);
  }
});

// Mutation proof (the alias decision): dropping either name fails here while a published card still sends it.
test('every tool name a published card sends is registered, listed for cards, and takes the arguments that card sends', async (t) => {
  const { send } = await world(t, 'try-again-published-names');
  const listed = JSON.parse(await send('tools/list', {})).result.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }>;
  const sends: Record<string, string[]> = {};
  for (const card of CARD_NAMES) {
    for (const version of cardVersions(card)) {
      const page = readFileSync(`assets/${cardAssetPath(card, version)}`, 'utf8');
      // The bundle calls a tool as b("name",{…}): its name and the keys of the object it sends.
      for (const [, name, keys] of page.matchAll(/\b[A-Za-z_$][\w$]*\("(try_agent_once|get_test_run|practice_agent|get_practice_run)",\{([^}]*)\}\)/g)) {
        sends[name!] = [...new Set([...sends[name!] ?? [], ...keys!.split(',').map((pair) => pair.split(':')[0]!.trim())])];
      }
    }
  }
  assert.deepEqual(Object.keys(sends).sort(), ['get_practice_run', 'get_test_run', 'practice_agent', 'try_agent_once'], JSON.stringify(sends));
  for (const [name, keys] of Object.entries(sends)) {
    const tool = listed.find((entry) => entry.name === name);
    assert.ok(tool, `${name} is sent by a published card, so it stays registered until the versions collapse`);
    assert.deepEqual(keys.filter((key) => !(key in tool.inputSchema.properties)), [], `${name} takes ${keys}`);
    assert.deepEqual((tool.inputSchema.required ?? []).filter((key) => !keys.includes(key)), [], `${name} needs nothing a card does not send`);
  }
  assert.deepEqual(sends.practice_agent!.sort(), ['agentId', 'idempotencyKey'], 'the card never sends a question or a practiceId');
});

test('a result the card draws never carries a step or a raw result to the card\'s panes', async (t) => {
  const w = await world(t, 'try-again-no-steps');
  const card = await w.saved();
  const RAW = 'RAW RESULT that a service returned';
  w.runs.outcome = {
    status: 'answered', failure: null,
    result: {
      reply: 'One invoice.', read: ['Stripe'], off: ['Reading Slack'],
      steps: [{ kind: 'tool', service: 'Stripe', tool: 'stripe_list_invoices', input: '{"status":"open"}', outcome: 'ok', result: { data: RAW, size: RAW.length, truncated: false } }],
    },
  };
  await card.press('try_once');
  const drawn = JSON.stringify(card.shown);
  for (const words of [RAW, 'stripe_list_invoices', 'Reading Slack', '"status"']) assert.equal(drawn.includes(words), false, `${words} drawn`);
  assert.equal((card.effects.findLast(({ type }) => type === 'context') as { text: string }).text.includes(RAW), false);
});
