import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';

import * as agentCard from '../src/mcp-cards/agent-card/model.ts';
import { keptState, type CardState, type Memory } from '../src/mcp-cards/card-model.ts';
import { GIVE_UP_MS, HELD_FOR_MS, HELD_RETRY_MS, PRACTICE_SHOWN } from '../src/mcp-cards/first-answer.ts';
import { cardAssetPath, cardVersions, CARD_NAMES } from '../src/mcp-cards/published.ts';
import { asChatGpt, cardHost, cardServer, type CardModelUnderTest } from './helpers/mcp-card-host.ts';
import { slackMember } from './helpers/slack-members.ts';
import { StubTestRuns, type TestRunOutcome } from './helpers/stub-test-runs.ts';

/**
 * "Try it again" on the Saved card, against Core's real MCP server through
 * ChatGPT's delivery: practice_agent with no question, then
 * get_practice_run, over a stub of the state store's runs that keeps its
 * repeat window. The card draws the answer as After beside Before only when
 * Chickpea names an answer to the same question from another version of the
 * Agent, and tells the host's model only that a practice answer is on the card.
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
  assert.equal('practice' in (memoryOf(off.state).outcome as object), false, 'nor kept for a reopened chat, which reads no status');

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

const FIRST_SHOWN = '2 invoices are overdue:\n• Northwind, $1,240\n• Lumen Labs, $860';
const SECOND_SHOWN = 'Northwind owes $1,240. Write to Ada <ada@northwind.example> first.';
const labels = (card: Card) => (panes(card) as { panes: Array<{ label: string }> } | undefined)?.panes.map(({ label }) => label);

/** A first answer before any change, as "See its first answer" or the model asks it: practice_agent with no question. */
async function firstAnswer(w: Awaited<ReturnType<typeof world>>) {
  const run = await w.call('practice_agent', { agentId: AGENT, idempotencyKey: `first-${w.clock.now}` });
  assert.equal(run.structuredContent!.status, 'answered');
  return run.structuredContent as { runToken: string; ran: { agentVersion: string } };
}

test('Try it again asks the first question with practice_agent, and draws Before only from an answer of the Agent before the save', async (t) => {
  const w = await world(t, 'try-again-before-after');
  const { runs, clock } = w;
  const earlier = await firstAnswer(w);
  clock.now += 60_000;
  const card = await w.saved();
  assert.equal(card.shown.subtitle?.[0]?.text, 'Try it: message @invoices in Slack.');
  runs.outcome = answered(SECOND);
  await card.press('try_once');
  assert.deepEqual(card.calls('practice_agent').map(({ args }) => args), [{ agentId: AGENT, idempotencyKey: `try:${AGENT}:${clock.now}` }],
    'no question and no practiceId: the stored first question');
  assert.equal(runs.starts.at(-1)!.run.question, ASK);
  const after = runs.runs.at(-1)!;
  assert.notEqual(after.request.run.admitted.ran!.agentVersion, earlier.ran.agentVersion, 'the save made a new version');
  assert.deepEqual(card.calls('get_practice_run').map(({ args }) => args).at(-1), { runToken: earlier.runToken }, 'Chickpea named the answer from before');
  assert.deepEqual(card.shown.blocks, [
    { kind: 'note', text: `First question: “${ASK}”` },
    { kind: 'panes', panes: [{ label: 'Before', text: FIRST_SHOWN }, { label: 'After', text: SECOND_SHOWN }] },
    { kind: 'note', text: 'It read Stripe.' },
  ]);
  assert.deepEqual(card.labels(), ['Try it again (primary)', 'Undo the change (secondary)']);
  assert.equal(card.shown.title, 'Invoice Chaser after this change', 'not its first answer: the heading follows Before and After');
  // Its picture's address may name the Agent; nothing else drawn does.
  const drawn = JSON.stringify({ ...card.shown, avatarUrl: undefined });
  assert.equal(drawn.includes('&lt;'), false, 'the `<` the Agent wrote, never &lt;');
  for (const id of [AGENT, earlier.runToken, after.view.runToken, 'try:']) assert.equal(drawn.includes(id), false, `${id} drawn`);
  // Everything the card told before, then one sentence, without either answer.
  const context = (card.effects.findLast(({ type }) => type === 'context') as { text: string }).text;
  assert.deepEqual(context.split('\n'), [
    'The person saved the change to the Agent "Invoice Chaser" from the card.',
    `The person pressed "Try it again" for the Agent "Invoice Chaser" (@invoices) on the card. ${PRACTICE_SHOWN}`,
  ]);
  assert.doesNotMatch(context, /Northwind|overdue/);

  // Pressed again with nothing changed, within two minutes: the same run again, and the same answer from before.
  const starts = runs.starts.length;
  clock.now += 30_000;
  await card.press('try_once');
  assert.equal(runs.starts.length, starts, 'the store\'s repeat: no second run');
  assert.deepEqual(labels(card), ['Before', 'After']);
  assert.equal(told(card), `The person pressed "Try it again" for the Agent "Invoice Chaser" (@invoices) on the card. ${PRACTICE_SHOWN}`);
});

// Mutation proof: a Before from any earlier run, or from this card's own last answer, draws two answers of one version here.
test('with no answer from another version, Try it again draws the answer alone, and never two answers of the same version', async (t) => {
  const w = await world(t, 'try-again-alone');
  const card = await w.saved();
  await card.press('try_once');
  assert.deepEqual(card.shown.blocks, [
    { kind: 'note', text: `First question: “${ASK}”` },
    { kind: 'panes', panes: [{ label: 'What it answered', text: FIRST_SHOWN }] },
    { kind: 'note', text: 'It read Stripe.' },
  ], 'no Before, and no label that claims a comparison');
  assert.deepEqual(card.calls('get_practice_run'), [], 'nothing to read');

  // A new run of the same saved Agent, past the repeat window, with another answer: still alone.
  w.clock.now += 3 * 60_000;
  w.runs.outcome = answered(SECOND);
  await card.press('try_once');
  assert.equal(w.runs.starts.length, 2, 'a second run of the same version');
  assert.deepEqual(panes(card), { kind: 'panes', panes: [{ label: 'What it answered', text: SECOND_SHOWN }] });

  // An answer from before the save, past its hour, is gone: alone again.
  const later = await world(t, 'try-again-past-hour');
  await firstAnswer(later);
  later.clock.now += 61 * 60_000;
  const old = await later.saved();
  later.runs.outcome = answered(SECOND);
  await old.press('try_once');
  assert.deepEqual(labels(old), ['What it answered']);
});

// Mutation proof: the card's own version checks, against results that would break them.
test('the card draws Before only when both runs name their versions and they differ', async (t) => {
  const w = await world(t, 'try-again-versions');
  const earlier = await firstAnswer(w);
  w.clock.now += 60_000;
  w.runs.outcome = answered(SECOND);

  // A result that names its earlier run as one of its own version reads nothing.
  const same = await w.saved({ instructions: '# Job\nChase invoices. Name each customer.' });
  same.hold = ({ tool }) => tool === 'practice_agent';
  await same.press('try_once');
  const held = same.held[0]!;
  const content = held.result.structuredContent as { ran: { agentVersion: string }; before: { runToken: string; agentVersion: string } };
  assert.equal(content.before.runToken, earlier.runToken);
  held.result = { ...held.result, structuredContent: { ...content, before: { ...content.before, agentVersion: content.ran.agentVersion } } };
  await same.answer();
  assert.deepEqual([same.calls('get_practice_run'), labels(same)], [[], ['What it answered']]);

  // An earlier run whose own result names the same version as this one is not drawn.
  const read = await w.saved({ instructions: '# Job\nChase invoices. Name each customer and the amount.' });
  read.hold = ({ tool }) => tool === 'get_practice_run';
  w.clock.now += 3 * 60_000;
  await read.press('try_once');
  const earlierRead = read.held[0]!;
  const version = (w.runs.runs.at(-1)!.request.run.admitted.ran!).agentVersion;
  const run = earlierRead.result.structuredContent as { ran: Record<string, unknown> };
  earlierRead.result = { ...earlierRead.result, structuredContent: { ...run, ran: { ...run.ran, agentVersion: version } } };
  await read.answer();
  assert.deepEqual(labels(read), ['What it answered']);

  // A read of the earlier run that fails draws the answer alone.
  const failed = await w.saved({ instructions: '# Job\nChase invoices. Name each customer, the amount and the date.' });
  failed.hold = ({ tool }) => tool === 'get_practice_run';
  w.clock.now += 3 * 60_000;
  await failed.press('try_once');
  assert.deepEqual(failed.labels(), [], 'nothing to press while the earlier answer is read');
  assert.equal(failed.shown.title, 'Invoice Chaser after this change', 'answering after the save');
  await failed.answer('unreachable');
  assert.deepEqual([labels(failed), failed.labels()], [['What it answered'], ['Try it again (primary)', 'Undo the change (secondary)']]);
  assert.equal(failed.shown.title, 'Invoice Chaser\'s answer', 'no Before, so no "after this change"');
});

test('what the card keeps says only that it offers Try it again, never an answer, a run\'s token or the undo token', async (t) => {
  const w = await world(t, 'try-again-kept');
  await firstAnswer(w);
  w.clock.now += 60_000;
  const card = await w.saved();
  assert.deepEqual(memoryOf(card.state).outcome, { kind: 'done', summary: 'Saved Invoice Chaser.', practice: true }, 'the save offers Try it again');
  w.runs.outcome = answered(SECOND);
  await card.press('try_once');
  assert.deepEqual(labels(card), ['Before', 'After']);
  const state = keptState(card.state, cardVersions('agent-card').at(-1)!);
  assert.deepEqual(state.privateContent.card.outcome, { kind: 'done', summary: 'Saved Invoice Chaser.', practice: true });
  assert.equal(state.modelContent, state.privateContent.card.told.join('\n'), 'the model reads only what the card told it');
  assert.ok(state.modelContent.endsWith(PRACTICE_SHOWN));
  const written = JSON.stringify(state);
  assert.doesNotMatch(written, /Northwind|overdue/, 'no answer kept anywhere');
  const undoToken = (card.state.view as { again?: { undoToken?: string } }).again?.undoToken;
  assert.ok(undoToken, 'the card holds Undo beside the answer');
  for (const secret of [...w.runs.runs.map(({ view }) => view.runToken), 'try:', AGENT, 'practiceId', undoToken]) {
    assert.equal(written.includes(secret), false, `${secret} kept`);
  }

  // The chat reopens: the Saved card with Try it again, and Chickpea again finds the answer from before the save.
  const reopened = cardHost(AGENT_CARD, asChatGpt(w.call), w.clock);
  const result = await w.call('propose_agent_change', { agentId: AGENT, version: await w.version(), change: { description: 'Chases invoices.' } });
  await reopened.dispatch({ type: 'result', result, now: w.clock.now, kept: memoryOf(card.state) });
  assert.equal(reopened.shown.title, 'Saved Invoice Chaser');
  assert.deepEqual(reopened.labels(), ['Try it again (primary)'], 'no Undo: a reopened card holds no token');
  w.clock.now += 3 * 60_000;
  await reopened.press('try_once');
  assert.deepEqual(panes(reopened), { kind: 'panes', panes: [{ label: 'Before', text: FIRST_SHOWN }, { label: 'After', text: SECOND_SHOWN }] });
  assert.deepEqual(reopened.labels(), ['Try it again (primary)', 'Change something (secondary)']);

  // Kept state is untrusted: only `practice: true` offers Try it again.
  for (const practice of [{}, 'yes', { answer: 'x' }]) {
    const tampered = cardHost(AGENT_CARD, w.call, w.clock);
    await tampered.dispatch({ type: 'result', result, now: w.clock.now, kept: { told: [], outcome: { kind: 'done', summary: 'Saved Invoice Chaser.', practice } } });
    assert.deepEqual(tampered.labels(), [], JSON.stringify(practice));
  }
});

// Mutation proof: a card that reads no left-out line, offers no fix for it, or gives its fix the save's Undo's place, fails here.
test('a connection the run left out is named under the answer; the save\'s Undo keeps its place, and a card with no Undo offers the fix', async (t) => {
  const w = await world(t, 'try-again-left-out');
  const { f, teamId } = w;
  await f.config.putConnectionAccount({
    id: 'connection_docs', providerId: 'docs', label: 'Docs MCP', ownerKind: 'team', workspaceId: teamId, createdByMembershipId: f.owner.membership.id,
    secretRefId: 'secret_docs', lifecycle: 'ready',
    policy: { kind: 'mcp', url: 'https://mcp.docs.example/mcp', transport: 'streamable-http', authMode: 'bearer', headerNames: [], allowedTools: ['search'], discoveredTools: [{ name: 'search' }] },
  } as never, 0);
  await f.config.putAgentConnectionBinding({ agentId: AGENT, connectionAccountId: 'connection_docs', providerId: 'docs', allowedCapabilities: [], enabled: true });
  const LEFT_OUT = [
    { kind: 'note', text: 'It read Stripe.' },
    { kind: 'note', text: 'Docs MCP wasn\'t used: none of its tools are marked as ones that only read.', tone: 'warn' },
  ];
  const saved = await w.saved();
  await saved.press('try_once');
  assert.deepEqual(saved.shown.blocks.slice(2), LEFT_OUT);
  assert.deepEqual(saved.labels(), ['Try it again (primary)', 'Undo the change (secondary)'], 'the line, and the save\'s Undo where it was');
  await saved.press('undo');
  assert.equal(saved.shown.title, 'Undid the change');

  // A reopened card holds no Undo: the fix is its second button, until the person acts on it.
  const card = cardHost(AGENT_CARD, asChatGpt(w.call), w.clock);
  const result = await w.call('propose_agent_change', { agentId: AGENT, version: await w.version(), change: { description: 'Chases invoices.' } });
  await card.dispatch({ type: 'result', result, now: w.clock.now, kept: { told: [], outcome: { kind: 'done', summary: 'Saved Invoice Chaser.', practice: true } } });
  w.clock.now += 3 * 60_000;
  await card.press('try_once');
  assert.deepEqual(card.shown.blocks.slice(2), LEFT_OUT);
  assert.deepEqual(card.labels(), ['Try it again (primary)', 'Mark Docs MCP\'s read tools (secondary)']);
  assert.equal(JSON.stringify({ ...card.shown, avatarUrl: undefined }).includes('connection_docs'), false);
  await card.press('try_fix');
  assert.deepEqual(card.effects.at(-1), { type: 'message', sent: 'Mark Docs MCP\'s read tools for Invoice Chaser.' });
  assert.deepEqual(card.calls('update_connection'), [], 'the card never makes that change itself');
  assert.deepEqual(card.shown.blocks.at(-1), { kind: 'note', text: 'Finish it in the chat, then try again.' });
  assert.deepEqual(card.labels(), ['Try it again (primary)', 'Change something (secondary)']);
  // The host refused the message: the fix is offered again, with no note that it was acted on.
  await card.dispatch({ type: 'refused', effect: { type: 'message', sent: 'Mark Docs MCP\'s read tools for Invoice Chaser.' }, now: w.clock.now });
  assert.equal(card.shown.blocks.some((block) => block.kind === 'note' && block.text.startsWith('Finish it')), false);
  assert.deepEqual(card.labels(), ['Try it again (primary)', 'Mark Docs MCP\'s read tools (secondary)']);
});

// Mutation proof: a card that finds the connection by off's sentence again, or offers an Admin link as the fix, fails here.
test('the card finds a left-out connection in the result\'s leftOut, never in off\'s sentence, and offers only its tool fix', async (t) => {
  const w = await world(t, 'try-again-left-out-field');
  const mark = { label: 'Mark Docs MCP\'s read tools', tool: 'update_connection', arguments: { agentId: AGENT, connectionId: 'docs' } };
  const read = { kind: 'note', text: 'It read Stripe.' };
  const line = { kind: 'note', text: 'Docs MCP wasn\'t used: none of its tools are marked as ones that only read.', tone: 'warn' };
  const drawn = async (result: Record<string, unknown>) => {
    w.runs.outcome = { status: 'answered', failure: null, result: { reply: 'One invoice.', read: ['Stripe'], ...result } };
    // A reopened card holds no Undo, so a fix would be its second button.
    const card = cardHost(AGENT_CARD, asChatGpt(w.call), w.clock);
    const proposed = await w.call('propose_agent_change', { agentId: AGENT, version: await w.version(), change: { description: 'Chases invoices.' } });
    await card.dispatch({ type: 'result', result: proposed, now: w.clock.now, kept: { told: [], outcome: { kind: 'done', summary: 'Saved Invoice Chaser.', practice: true } } });
    w.clock.now += 3 * 60_000;
    await card.press('try_once');
    return { blocks: card.shown.blocks.slice(2), labels: card.labels() };
  };
  const sentence = 'Docs MCP was not available in this practice run, so an answer that needs it can\'t be judged here.';
  assert.deepEqual(await drawn({ off: [sentence], fixes: [mark] }),
    { blocks: [read], labels: ['Try it again (primary)', 'Change something (secondary)'] }, 'off\'s sentence alone names nothing');
  assert.deepEqual(await drawn({ leftOut: [{ service: 'Docs MCP', fix: mark }] }),
    { blocks: [read, line], labels: ['Try it again (primary)', 'Mark Docs MCP\'s read tools (secondary)'] });
  assert.deepEqual(await drawn({ leftOut: [{ service: 'Docs MCP', fix: { label: 'Choose its tools in Admin', url: 'https://chickpea.example.test/admin/agents/agent_invoices' } }] }),
    { blocks: [read, line], labels: ['Try it again (primary)', 'Change something (secondary)'] }, 'an Admin link is not the answer\'s fix');
});

test('Undo stays beside a Try it again answer and undoes the save', async (t) => {
  const w = await world(t, 'try-again-undo');
  const card = await w.saved();
  const { undoToken } = card.state.view as { undoToken: string };
  await card.press('try_once');
  assert.deepEqual(card.labels(), ['Try it again (primary)', 'Undo the change (secondary)']);
  await card.press('undo');
  assert.deepEqual(card.calls('undo_change').map(({ args }) => args), [{ undoToken, idempotencyKey: `undo:${undoToken}` }]);
  assert.equal(card.shown.title, 'Undid the change');
  assert.equal(told(card), 'The person undid the change to the Agent "Invoice Chaser" from the card.');
  assert.equal((await w.f.config.getAgent(AGENT))!.instructions, '# Job\nChase invoices.');
  assert.deepEqual(memoryOf(card.state).outcome, { kind: 'done', summary: 'Undid the change.' }, 'no Try it again after an undo');

  // Undo is offered only once the run has come to something, and only with the save's token.
  // Past the repeat window, so the same plan runs again instead of answering from the run above.
  fastTime(t);
  w.clock.now += 3 * 60_000;
  const running = await w.saved();
  w.runs.outcome = { status: 'running', failure: null, result: null };
  running.hold = ({ tool }) => tool === 'get_practice_run';
  await running.press('try_once');
  assert.deepEqual(running.labels(), []);
  await running.press('undo');
  assert.deepEqual(running.calls('undo_change'), [], 'nothing to undo while it answers');
});

test('a refusal or a failed run shows its own sentence on Try it again, as ChatGPT delivers it', async (t) => {
  const GUEST = 'You can\'t message Invoice Chaser in Slack yet, so you can\'t practice with it.';
  const NOT_STARTED = `The person pressed "Try it again" for the Agent "Invoice Chaser" (@invoices) on the card, but the practice run did not start. Chickpea said: ${JSON.stringify(GUEST)}`;

  // Slack would refuse the person a DM: no Try again, which would read the same.
  const guest = await world(t, 'try-again-guest');
  const refused = await guest.saved();
  guest.slack.guest = true;
  await refused.press('try_once');
  assert.deepEqual(refused.shown.blocks, [{ kind: 'text', text: GUEST }]);
  assert.equal(refused.shown.title, 'Couldn\'t practice with Invoice Chaser', 'the heading names the refusal');
  assert.deepEqual(refused.labels(), ['Open in Slack (primary)', 'Undo the change (secondary)'], 'not one that passes on a retry; the save\'s Undo stays');
  assert.equal(told(refused), NOT_STARTED, 'the model hears why, so its next reply fits');
  assert.deepEqual(guest.runs.starts, []);
  await refused.press('undo');
  assert.equal(refused.shown.title, 'Undid the change');
  assert.equal((await guest.f.config.getAgent(AGENT))!.instructions, '# Job\nChase invoices.', 'a refused run does not cost the person their Undo');

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
  assert.deepEqual(busy.labels(), ['Try again (primary)', 'Undo the change (secondary)']);
  held.runs.refuse = undefined;
  await busy.press('try_once');
  assert.equal(new Set(busy.calls('practice_agent').map(({ args }) => args.idempotencyKey)).size, 1);
  assert.equal((panes(busy) as { panes: Array<{ label: string }> }).panes.at(-1)!.label, 'What it answered');

  // The plan refused it as it would a direct message: its own words.
  const funded = await world(t, 'try-again-funding');
  const out = await funded.saved();
  funded.runs.outcome = { status: 'failed', failure: 'out_of_usage', result: { funding: { kind: 'credits_exhausted' } } } as TestRunOutcome;
  await out.press('try_once');
  assert.deepEqual(out.shown.blocks, [{ kind: 'text', text: 'This workspace is out of usage for now, so I can\'t start this one. Once an Owner adds more, send it again.' }]);
  assert.deepEqual(out.labels(), ['Open in Slack (primary)', 'Undo the change (secondary)']);
  assert.equal(told(out), 'The person pressed "Try it again" for the Agent "Invoice Chaser" (@invoices) on the card, but it did not finish answering.');

  // Before ChatGPT lists practice_agent ("MCP Resource not found"): unreachable, tried again, then Check again.
  const unlisted = await world(t, 'try-again-unlisted');
  const waiting = await unlisted.saved(undefined, { unlisted: ['practice_agent'] });
  await waiting.press('try_once');
  assert.deepEqual(waiting.effects.at(-1), { type: 'timer', inMs: 2_000 }, 'not a refusal: the same call again');
  unlisted.clock.now += GIVE_UP_MS;
  await waiting.dispatch({ type: 'tick', now: unlisted.clock.now });
  assert.deepEqual(waiting.labels(), ['Check again (primary)', 'Undo the change (secondary)']);
  assert.equal(told(waiting), 'The person pressed "Try it again" for the Agent "Invoice Chaser" (@invoices) on the card, but its answer did not come back in time.');
  assert.deepEqual(unlisted.runs.starts, []);
});

// Mutation proof: a refusal drawn without the earlier answer, or offering Admin for a turned-off Agent, fails here.
test('Try it again on an Agent turned off since: the refusal says so under the answer it showed, and offers to turn it back on', async (t) => {
  const w = await world(t, 'try-again-off');
  const { runs, clock } = w;
  await firstAnswer(w);
  clock.now += 60_000;
  const card = await w.saved();
  runs.outcome = answered(SECOND);
  await card.press('try_once');
  const answer = card.shown.blocks.slice(0, 2);
  assert.deepEqual(answer[1], { kind: 'panes', panes: [{ label: 'Before', text: FIRST_SHOWN }, { label: 'After', text: SECOND_SHOWN }] });

  await w.f.config.updateAgent(AGENT, { enabled: false });
  clock.now += 3 * 60_000;
  await card.press('try_once');
  const OFF = 'Invoice Chaser is turned off, so you can\'t practice with it.';
  assert.equal(card.shown.title, 'Couldn\'t practice with Invoice Chaser');
  assert.deepEqual(card.shown.blocks, [...answer, { kind: 'text', text: OFF }], 'the refusal goes under the answer, never in its place');
  assert.deepEqual(card.labels(), ['Turn it back on (primary)', 'Undo the change (secondary)']);
  assert.equal(told(card), `The person pressed "Try it again" for the Agent "Invoice Chaser" (@invoices) on the card, but the practice run did not start. Chickpea said: ${JSON.stringify(OFF)}`);

  // The fix goes to the chat, where the model turns it on; then Try again.
  await card.press('try_fix');
  assert.deepEqual(card.effects.findLast(({ type }) => type === 'message'), { type: 'message', sent: 'Turn it back on for Invoice Chaser.' });
  assert.deepEqual(card.shown.blocks.at(-1), { kind: 'note', text: 'Finish it in the chat, then try again.' });
  assert.deepEqual(card.labels(), ['Try again (primary)', 'Turn it back on (secondary)']);
  await w.f.config.updateAgent(AGENT, { enabled: true });
  await card.press('try_once');
  assert.equal(card.shown.title, 'Invoice Chaser after this change');
  assert.deepEqual((panes(card) as { panes: Array<{ label: string }> }).panes.map(({ label }) => label), ['Before', 'After']);
  assert.deepEqual(card.labels(), ['Try it again (primary)', 'Undo the change (secondary)']);
});

// Mutation proof: an Agent card that keeps the run's token once Try it again settles fails here.
test('a Try it again run still going keeps its token beside the Saved card\'s title, and once it answers the card keeps only that it offers Try it again', async (t) => {
  const w = await world(t, 'try-again-still');
  fastTime(t);
  await firstAnswer(w);
  w.clock.now += 60_000;
  const card = await w.saved();
  w.runs.outcome = { status: 'running', failure: null, result: null };
  card.hold = (made) => made.tool === 'get_practice_run';
  await card.press('try_once');
  w.clock.now += GIVE_UP_MS;
  await card.answer();
  const runToken = w.runs.runs.at(-1)!.view.runToken;
  assert.deepEqual([card.shown.blocks, card.labels()], [[{ kind: 'text', text: 'Still working on it.' }], ['Check again (primary)', 'Undo the change (secondary)']]);
  const kept = keptState(card.state, cardVersions('agent-card').at(-1)!);
  assert.deepEqual(kept.privateContent.card.outcome,
    { kind: 'checking', runToken, agentId: AGENT, name: 'Invoice Chaser', handle: 'invoices', summary: 'Saved Invoice Chaser.' });
  assert.equal(kept.modelContent.includes(runToken), false, 'the model never reads the token');

  // The chat reopens: one read of that run, no Undo, and Check again reads it again. Nothing starts a run.
  const reopened = cardHost(AGENT_CARD, asChatGpt(w.call), w.clock);
  const result = await w.call('propose_agent_change', { agentId: AGENT, version: await w.version(), change: { description: 'Chases invoices.' } });
  await reopened.dispatch({ type: 'result', result, now: w.clock.now, kept: memoryOf(card.state) });
  assert.deepEqual(reopened.calls().map(({ tool, args }) => [tool, args]), [['get_practice_run', { runToken }]]);
  assert.deepEqual([reopened.shown.blocks, reopened.labels()], [[{ kind: 'text', text: 'Still working on it.' }], ['Check again (primary)']]);
  w.runs.outcome = answered(SECOND);
  await reopened.press('check_again');
  assert.deepEqual(panes(reopened), { kind: 'panes', panes: [{ label: 'Before', text: FIRST_SHOWN }, { label: 'After', text: SECOND_SHOWN }] });
  assert.deepEqual(reopened.labels(), ['Try it again (primary)', 'Change something (secondary)']);
  assert.deepEqual([reopened.calls('practice_agent').length, w.runs.starts.length], [0, 2], 'the first answer and the one Try it again: no run of the reopened card\'s');
  const after = keptState(reopened.state, cardVersions('agent-card').at(-1)!);
  assert.deepEqual(after.privateContent.card.outcome, { kind: 'done', summary: 'Saved Invoice Chaser.', practice: true });
  assert.equal(JSON.stringify(after).includes(runToken), false, 'once it answers, no token is kept');
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
