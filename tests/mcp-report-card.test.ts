import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { CARD_URIS } from '../src/management/mcp-v5/cards.ts';
import * as reportCard from '../src/mcp-cards/report-card/model.ts';
import { plainText } from '../src/mcp-cards/first-answer.ts';
import type { Block, Row } from '../src/mcp-cards/card-model.ts';
import { cardHost, cardServer, type CardModelUnderTest } from './helpers/mcp-card-host.ts';
import { slackMember } from './helpers/slack-members.ts';
import { StubTestRuns } from './helpers/stub-test-runs.ts';

/**
 * show_test_report against Core's real MCP server, over a stub of the state
 * store's practice runs, and the report card it draws. The model sends its
 * verdicts and each run's token; Chickpea fills in the questions and answers
 * from the caller's own runs, and the answers reach only the card. The card
 * waits for nothing: it calls no tool, sends no message and tells the host's
 * model nothing, whatever the person opens.
 */

const REPORT_CARD: CardModelUnderTest<reportCard.View, reportCard.Action> = {
  ...reportCard,
  initial: reportCard.INITIAL,
  reads: new Set(),
};

const AGENT = 'agent_docs';
const OTHER = 'agent_other';
/** As the store keeps it: a `<` that could open a tag escaped for clients that render the answer. */
const LONG = 'Go to **Settings**, then Locations, and choose Add location.\n- Each one needs an address &lt;street>.\n- Then set stock levels.';
const SHORT = 'Return labels are billed at your carrier rate.';

async function world(t: TestContext, suffix: string) {
  const runs = new StubTestRuns({ status: 'answered', failure: null, result: { reply: LONG, read: ['Notion'] } });
  const slack = { team: '' };
  const server = await cardServer(t, suffix, {
    modelReadiness: async () => async () => undefined,
    slackMember: async (id) => slackMember(id, slack.team),
    testRuns: runs,
  }, { cards: true });
  const { f, teamId, call, clock } = server;
  slack.team = teamId;
  runs.now = () => clock.now;
  await f.config.ensureWorkspaceInstallation({ workspaceId: teamId, transportMode: 'direct', botUserId: 'UBOT', runtimeContract: 'chickpea-v1' });
  for (const [id, name, handle] of [[AGENT, 'Docs Guide', 'docs-guide'], [OTHER, 'Other Helper', 'other']] as const) {
    await f.config.createAgent({
      id, name, instructions: '# Job\nAnswer docs questions.', enabled: true, lifecycle: 'active',
      creatorMembershipId: f.owner.membership.id, editPolicy: 'creator_and_admins', configurationGeneration: 1,
      model: 'local-stub/docs', skills: [], mcpServers: [], apiConnections: [], repositories: [],
      slackPresence: { requestedHandle: handle, normalizedHandle: handle, desiredState: 'active', health: 'healthy', avatar: { kind: 'generated', revision: 1, seed: handle } },
    } as never);
  }
  /** One practice question; its answer is the stub's outcome when it runs. */
  const practice = async (question: string, agentId = AGENT) => {
    const result = await call('practice_agent', { agentId, question });
    assert.equal(result.structuredContent?.status, 'answered', JSON.stringify(result.structuredContent));
    return result.structuredContent!.runToken as string;
  };
  return { ...server, runs, practice };
}

const rowsOf = (blocks: ReadonlyArray<Block>): Row[] => blocks.flatMap((block) => block.kind === 'rows' ? block.rows : []);

test('show_test_report reads only, links the report card, and lists an output schema', async (t) => {
  const { send } = await cardServer(t, 'report-listing', {}, { cards: true });
  const { tools } = (JSON.parse(await send('tools/list', {})) as { result: { tools: Array<Record<string, any>> } }).result;
  const listed = tools.find(({ name }) => name === 'show_test_report')!;
  assert.deepEqual(listed.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, 'it changes nothing');
  assert.equal(listed._meta.ui.resourceUri, CARD_URIS['report-card']);
  assert.equal(listed._meta['openai/outputTemplate'], CARD_URIS['report-card']);
  // A card session lists each card tool's output beside its refusal.
  assert.ok(listed.outputSchema?.anyOf?.[0]?.properties?.runs, 'an output schema, like its siblings');
  assert.deepEqual(Object.keys(listed.inputSchema.properties).sort(), ['agentId', 'next', 'runs', 'summary']);
  assert.deepEqual(Object.keys(listed.inputSchema.properties.runs.items.properties).sort(), ['before', 'note', 'runToken', 'verdict']);
});

test('the report fills each question and answer from the caller\'s own runs, and only the card gets the answers', async (t) => {
  const w = await world(t, 'report-fills');
  const first = await w.practice('How do I add a second warehouse?');
  w.runs.outcome = { status: 'answered', failure: null, result: { reply: SHORT, read: [] } };
  const second = await w.practice('What does the returns label cost?\n\nAsk me again later.');
  const result = await w.call('show_test_report', {
    agentId: AGENT,
    runs: [
      { runToken: first, verdict: 'Too long', note: 'Right page, 14 lines.', before: 'Too long' },
      { runToken: second, verdict: 'Good' },
    ],
    summary: 'Right page 2 of 2 · Short enough 1 of 2',
    next: 'Shorten the answers, then ask both again.',
  });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.deepEqual(result.structuredContent, {
    agent: { agentId: AGENT, name: 'Docs Guide', handle: 'docs-guide', avatarUrl: result.structuredContent!.agent.avatarUrl },
    runs: [
      { question: 'How do I add a second warehouse?', verdict: 'Too long', note: 'Right page, 14 lines.', before: 'Too long' },
      { question: 'What does the returns label cost? Ask me again later.', verdict: 'Good' },
    ],
    summary: 'Right page 2 of 2 · Short enough 1 of 2',
    next: 'Shorten the answers, then ask both again.',
    nextStep: 'The card shows the person this report, and each answer when they open its row. Don\'t repeat it in your reply. It needs no press, so carry on.',
  }, 'the model gets its own verdicts back, never the answers again');
  assert.deepEqual(result._meta?.['chickpea/answers'], [LONG, SHORT], 'the answers, as the store kept them, for the card');
  assert.equal(result._meta?.['chickpea/tool'], 'show_test_report');
  const text = (result as { content: Array<{ text: string }> }).content.map(({ text }) => text).join('\n');
  assert.equal(text.includes('billed at your carrier rate'), false, 'nor in the text block');
  assert.equal(text.includes('The card above shows this'), false, 'no card-host stop text: the card waits for nothing');
});

test('a run the report can\'t draw is refused, naming which one', async (t) => {
  const w = await world(t, 'report-refusals');
  const mine = await w.practice('How do I add a second warehouse?');
  const others = await w.practice('Who are you?', OTHER);
  const report = (tokens: string[]) => w.call('show_test_report', {
    agentId: AGENT, runs: tokens.map((runToken) => ({ runToken, verdict: 'Good' })), summary: 'One round.',
  });
  const refusal = async (tokens: string[]) => (await report(tokens)).structuredContent!.error as Record<string, string>;

  const gone = await refusal([mine, 'tr_gone']);
  assert.equal(gone.code, 'not_found');
  assert.equal(gone.message, 'The practice run for question 2 is no longer there. Practice runs can be read for an hour after they end.');
  assert.match(gone.nextStep!, /runToken tr_gone \(question 2\)/);

  const elsewhere = await refusal([others]);
  assert.deepEqual([elsewhere.code, elsewhere.message], ['invalid_input', 'The practice run for question 1 is of another Agent.']);

  const observe = w.runs.observe.bind(w.runs);
  w.runs.observe = async (query) => {
    const view = await observe(query);
    return view && query.runToken === mine ? { ...view, status: 'running', result: null } : view;
  };
  const going = await refusal([mine]);
  assert.deepEqual([going.code, going.message], ['in_progress', 'The practice run for question 1 is still answering.']);
  assert.match(going.nextStep!, new RegExp(`get_practice_run with runToken ${mine}`));
  w.runs.observe = observe;

  const twice = await refusal([mine, mine]);
  assert.equal(twice.code, 'invalid_input', 'each run once');
  const gone2 = await w.call('show_test_report', { agentId: 'agent_missing', runs: [{ runToken: mine, verdict: 'Good' }], summary: 'One round.' });
  assert.equal(gone2.structuredContent!.error.code, 'not_found');
});

test('the report reads runs as the caller only: another person\'s runToken is no run', async (t) => {
  const w = await world(t, 'report-own-runs');
  const mine = await w.practice('How do I add a second warehouse?');
  const asked: Array<{ organizationId: string; actorMembershipId: string }> = [];
  const observe = w.runs.observe.bind(w.runs);
  w.runs.observe = async (query: { organizationId: string; actorMembershipId: string; runToken: string }) => {
    asked.push({ organizationId: query.organizationId, actorMembershipId: query.actorMembershipId });
    return observe(query);
  };
  const report = () => w.call('show_test_report', { agentId: AGENT, runs: [{ runToken: mine, verdict: 'Good' }], summary: 'One round.' });
  assert.equal((await report()).structuredContent!.error, undefined);
  const { membership } = w.f.owner;
  assert.deepEqual(asked, [{ organizationId: membership.organizationId, actorMembershipId: membership.id }]);

  // The same token, once the run is someone else's: gone, with none of its question or answer.
  w.runs.runs[0]!.request.run.actorMembershipId = 'membership_someone_else';
  const refused = await report();
  assert.equal(refused.structuredContent!.error.code, 'not_found');
  assert.equal(refused._meta?.['chickpea/answers'], undefined);
  assert.equal(JSON.stringify(refused).includes('second warehouse'), false);
});

test('a failed run draws as a row that says it did not finish', async (t) => {
  const w = await world(t, 'report-failed');
  w.runs.outcome = { status: 'failed', failure: 'deadline', result: {} };
  const result = await w.call('practice_agent', { agentId: AGENT, question: 'Which carriers work in Canada?' });
  const report = await w.call('show_test_report', {
    agentId: AGENT, runs: [{ runToken: result.structuredContent!.runToken, verdict: 'No answer' }], summary: 'It stopped.',
  });
  assert.deepEqual(report._meta?.['chickpea/answers'], [null]);
  const card = cardHost(REPORT_CARD, w.call, w.clock);
  await card.result(report);
  await card.press('toggle:0');
  assert.deepEqual(rowsOf(card.shown.blocks)[0]!.open, [{ kind: 'text', text: 'Docs Guide didn\'t finish answering this one.' }]);
});

test('the report card shows each question and verdict, opens a row to the answer in place, and waits for nothing', async (t) => {
  const w = await world(t, 'report-card');
  const first = await w.practice('How do I add a second warehouse?');
  w.runs.outcome = { status: 'answered', failure: null, result: { reply: SHORT, read: [] } };
  const second = await w.practice('What does the returns label cost?');
  const report = await w.call('show_test_report', {
    agentId: AGENT,
    runs: [{ runToken: first, verdict: 'Too long', note: 'Right page, 14 lines.', before: 'Good' }, { runToken: second, verdict: 'Good' }],
    summary: 'Right page 2 of 2 · Short enough 1 of 2',
    next: 'Next: shorten the answers, then ask both again.',
  });
  const card = cardHost(REPORT_CARD, w.call, w.clock);
  await card.result(report);
  const shown = card.shown;
  assert.equal(shown.title, 'Tested Docs Guide · 2 questions');
  assert.deepEqual(shown.subtitle, [{ text: 'Right page 2 of 2 · Short enough 1 of 2' }]);
  assert.deepEqual(shown.buttons, [], 'nothing to press but the rows');
  assert.deepEqual(shown.blocks.at(-1), { kind: 'note', text: 'Next: shorten the answers, then ask both again.' }, 'one Next, however the model wrote it');
  assert.deepEqual(rowsOf(shown.blocks), [
    {
      icon: 'tile', tile: '1', title: 'How do I add a second warehouse?', chip: 'Too long', detail: 'was: Good',
      control: { label: 'Show answer', action: 'toggle:0', style: 'toggle', expanded: false },
    },
    {
      icon: 'tile', tile: '2', title: 'What does the returns label cost?', chip: 'Good',
      control: { label: 'Show answer', action: 'toggle:1', style: 'toggle', expanded: false },
    },
  ]);

  await card.press('toggle:0');
  const [opened, closed] = rowsOf(card.shown.blocks);
  assert.deepEqual(opened!.control, { label: 'Hide answer', action: 'toggle:0', style: 'toggle', expanded: true });
  assert.deepEqual(opened!.open, [
    { kind: 'exchange', ask: 'How do I add a second warehouse?', answer: plainText(LONG.replaceAll('&lt;', '<')), agent: 'Docs Guide', whole: true },
    { kind: 'note', text: 'Right page, 14 lines.' },
  ], 'the Agent\'s own words, whole, with the model\'s note under them');
  assert.match((opened!.open![0] as { answer: string }).answer, /address <street>/, 'the < the Agent wrote');
  assert.equal(closed!.open, undefined);
  await card.press('toggle:1');
  await card.press('toggle:0');
  assert.deepEqual(rowsOf(card.shown.blocks).map(({ open }) => open !== undefined), [false, true]);
  await card.press('toggle:7' as reportCard.Action);
  assert.deepEqual(rowsOf(card.shown.blocks).map(({ open }) => open !== undefined), [false, true], 'a row that isn\'t there opens nothing');

  assert.deepEqual(card.effects, [], 'no call, message, link or word to the host\'s model');
  assert.equal(card.widgetState, undefined, 'and nothing kept');
  const drawn = JSON.stringify(card.shown);
  for (const hidden of [first, second, 'runToken', 'practice_agent', 'Notion']) assert.equal(drawn.includes(hidden), false, `${hidden} drawn`);

  // A reopened chat draws from the result alone: the runs may be gone by then.
  w.runs.runs.length = 0;
  await card.reopen(report);
  assert.deepEqual(rowsOf(card.shown.blocks).map(({ title }) => title), ['How do I add a second warehouse?', 'What does the returns label cost?']);
  await card.press('toggle:1');
  assert.equal((rowsOf(card.shown.blocks)[1]!.open![0] as { answer: string }).answer, SHORT);
});

test('a host that drops the answers still draws every verdict, with its note on the row', async (t) => {
  const w = await world(t, 'report-no-answers');
  const first = await w.practice('How do I add a second warehouse?');
  const report = await w.call('show_test_report', {
    agentId: AGENT, runs: [{ runToken: first, verdict: 'Too long', note: 'Right page, 14 lines.', before: 'Good' }], summary: 'One round.',
  });
  const card = cardHost(REPORT_CARD, w.call, w.clock);
  await card.result({ structuredContent: report.structuredContent });
  assert.deepEqual(rowsOf(card.shown.blocks), [
    { icon: 'tile', tile: '1', title: 'How do I add a second warehouse?', chip: 'Too long', detail: 'was: Good · Right page, 14 lines.' },
  ]);
  await card.press('toggle:0');
  assert.equal(rowsOf(card.shown.blocks)[0]!.open, undefined, 'nothing to open');
  assert.equal(card.shown.title, 'Tested Docs Guide · 1 question');
});

test('the report card draws a refusal as its words, and a result of another shape as nothing', async (t) => {
  const w = await world(t, 'report-shapes');
  const card = cardHost(REPORT_CARD, w.call, w.clock);
  await card.result(await w.call('show_test_report', { agentId: AGENT, runs: [{ runToken: 'tr_gone', verdict: 'Good' }], summary: 'x' }));
  assert.equal(card.shown.title, 'The practice run for question 1 is no longer there. Practice runs can be read for an hour after they end.');
  const odd = cardHost(REPORT_CARD, w.call, w.clock);
  await odd.result({ structuredContent: { agent: { name: 'Docs Guide' }, runs: [{ question: 'Q', verdict: 7 }], summary: 's' } });
  assert.equal(odd.shown.title, 'Nothing to show here.');
});
