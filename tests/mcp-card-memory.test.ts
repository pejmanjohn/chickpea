import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { INITIAL, present, step, type Action, type View } from '../src/mcp-cards/agent-card/model.ts';
import {
  hostFailed,
  refusalOf,
  sequenced,
  show,
  stay,
  tell,
  TOLD_CHARS,
  TOLD_MAX,
  type CardState,
  type Memory,
  type ToolResult,
} from '../src/mcp-cards/card-model.ts';
import { createFixtureAgent } from './helpers/management-adapter-fixture.ts';
import { cardHost, cardServer, type CardModelUnderTest } from './helpers/mcp-card-host.ts';

/**
 * What the live check on ChatGPT found, against Core's real MCP server:
 * a refusal reached the card without its code; a reopened card offered
 * buttons that could not work; the card's widget state, which ChatGPT shows
 * its model, held tokens; and each update to the model replaced the last.
 */

const AGENT_CARD: CardModelUnderTest<View, Action> = {
  initial: INITIAL,
  step,
  present,
  reads: new Set(['get_creation_status', 'get_agent']),
  followsPress: ({ view }) => view.kind === 'creating' && view.byPress === true,
};

const INSTRUCTIONS = '# Job\nAnswer support questions from the help center, briefly.';

/** A card session's workspace with an Agent that answers in #support, so turning it off asks first. */
async function world(t: TestContext, suffix: string) {
  const server = await cardServer(t, suffix, {}, { cards: true });
  const { f, call, clock, teamId } = server;
  await createFixtureAgent(f, 'agent_support', {
    name: 'Support Desk',
    instructions: INSTRUCTIONS,
    slackPresence: { requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy', avatar: { kind: 'generated', revision: 1, seed: 'support' } },
  });
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_SUPPORT', label: 'support', lifecycle: 'active' });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C_SUPPORT', agentId: 'agent_support', status: 'active',
    createdByMembershipId: f.owner.membership.id, channelLabel: 'support',
  });
  const version = async () => (await call('get_agent', { agentId: 'agent_support' })).structuredContent!.version as string;
  let keys = 0;
  const turnOff = async () => {
    await f.config.updateAgent('agent_support', { enabled: true });
    return call('update_agent', { agentId: 'agent_support', version: await version(), on: false, idempotencyKey: `off-${keys += 1}` });
  };
  return { ...server, version, turnOff, card: () => cardHost(AGENT_CARD, call, clock) };
}

const tokenOf = (result: ToolResult) => (result._meta?.['chickpea/held'] as { confirmToken: string }).confirmToken;
const memoryOf = ({ told = [], outcome }: CardState<View>): Memory => ({ told, ...outcome === undefined ? {} : { outcome } });

// Mutation proof (item 1): reading only the result's own structuredContent fails the three host deliveries.
test('a refusal reaches the card wherever its host put it: in the result, beside it, or with a JSON-RPC error', async (t) => {
  const { call, turnOff, card } = await world(t, 'memory-refusal');
  const pending = await turnOff();
  // Kept on another card: the token this card holds is retired.
  await call('decline_change', { confirmToken: tokenOf(pending) });
  const refused = await call('confirm_change', { confirmToken: tokenOf(pending) });
  const sentence = 'That confirmation no longer applies. Ask again to make the change.';
  assert.equal((refused.structuredContent as { error: { code: string; message: string } }).error.message, sentence);

  const { structuredContent: _stripped, ...bare } = refused;
  const deliveries: Record<string, ToolResult> = {
    'the result itself': refused,
    'ChatGPT\'s copy of the whole result, beside a result without it': { ...bare, _meta: { mcp_tool_result: refused } },
    'a JSON-RPC error carrying the result': { isError: true, hostError: { code: -32603, message: 'Tool call failed', data: refused } },
    'a JSON-RPC error carrying ChatGPT\'s envelope': { isError: true, hostError: { code: -32603, message: 'Tool call failed', data: { status: 'error', mcp_tool_result: refused } } },
  };
  for (const [how, result] of Object.entries(deliveries)) {
    const confirm = card();
    await confirm.result(pending);
    confirm.hold = ({ tool }) => tool === 'confirm_change';
    await confirm.press('confirm');
    confirm.held[0]!.result = result;
    await confirm.answer();
    assert.deepEqual([confirm.shown.title, confirm.shown.blocks, confirm.labels()],
      ['Nothing changed', [{ kind: 'text', text: sentence }], []], `${how}: its own sentence, and no button that cannot work`);
    const context = confirm.effects.findLast(({ type }) => type === 'context') as { text: string };
    assert.equal(context.text, `The person confirmed on the card, but nothing changed. Chickpea said: ${JSON.stringify(sentence)}`, how);
  }

  // A host's own words are never shown as Chickpea's: without a refusal in it, the error is the host's.
  const words: ToolResult = { isError: true, hostError: { code: -32603, message: sentence } };
  assert.deepEqual([refusalOf(words), hostFailed(words)], [undefined, true]);
  const carried = deliveries['a JSON-RPC error carrying the result']!;
  assert.deepEqual([refusalOf(carried)?.code, hostFailed(carried)], ['changed_since_read', false]);
});

test('a card first drawn with an error finds its sentence in ChatGPT\'s copy of the result', async (t) => {
  const { call, card } = await world(t, 'memory-error-result');
  const refused = await call('get_agent', { agentId: 'agent_missing' });
  assert.equal(refused.isError, true);
  const { structuredContent: _stripped, ...bare } = refused;
  const drawn = card();
  await drawn.result({ ...bare, _meta: { mcp_tool_result: refused } });
  assert.equal(drawn.shown.title, (refused.structuredContent as { error: { message: string } }).error.message);
});

// Mutation proof (item 2): a card that ignores what it kept offers Keep it on, Save or Create again.
test('a card that mounts again comes back to what its presses did, and never offers a button that cannot work', async (t) => {
  const { call, f, turnOff, version, card } = await world(t, 'memory-reopen');
  const reopen = async (result: ToolResult, kept: Memory | undefined) => {
    const again = card();
    await again.dispatch({ type: 'result', result, kept, now: Date.now() });
    return again;
  };
  const writes = (opened: ReturnType<typeof card>) => opened.calls().filter(({ tool }) => tool !== 'get_agent' && tool !== 'get_creation_status');

  // Kept on the card, then the chat reopens.
  const kept = await turnOff();
  const keeping = card();
  await keeping.result(kept);
  await keeping.press('keep');
  const keptAgain = await reopen(kept, memoryOf(keeping.state));
  assert.deepEqual([keptAgain.shown.title, keptAgain.labels(), writes(keptAgain)], ['Kept as it is', [], []]);
  assert.equal(keptAgain.effects.some(({ type }) => type === 'context'), false, 'mounting tells the model nothing new');
  assert.deepEqual(keptAgain.state.told, keeping.state.told, 'it goes on from what it told before');

  // Turned off on the card, then the chat reopens: done, and no Undo without its token.
  const confirmed = await turnOff();
  const confirming = card();
  await confirming.result(confirmed);
  await confirming.press('confirm');
  assert.equal((await f.config.getAgent('agent_support'))!.enabled, false);
  const confirmedAgain = await reopen(confirmed, memoryOf(confirming.state));
  assert.deepEqual([confirmedAgain.shown.title, confirmedAgain.shown.done, confirmedAgain.labels(), writes(confirmedAgain)],
    ['Made the change you confirmed', true, [], []]);
  assert.deepEqual(confirmedAgain.calls().map(({ tool }) => tool), ['get_agent'], 'it reads where the Agent stands');

  // Saved, then undone, on a change card.
  await f.config.updateAgent('agent_support', { enabled: true });
  const preview = await call('propose_agent_change', { agentId: 'agent_support', version: await version(), change: { description: 'Answers support questions.' } });
  const changing = card();
  await changing.result(preview);
  await changing.press('save');
  await changing.press('undo');
  const undoneAgain = await reopen(preview, memoryOf(changing.state));
  assert.deepEqual([undoneAgain.shown.title, undoneAgain.labels(), writes(undoneAgain)], ['Undid the change', [], []]);

  // Created from the proposal: it shows that it did, and offers no second Create.
  const proposal = await call('propose_agent', {
    name: 'Invoice Chaser', handle: 'invoices', job: 'Chases overdue invoices.', instructions: '# Job\nChase invoices.',
    sampleAsk: 'who is overdue?', promisedAnswer: 'I list them.',
  });
  const creating = card();
  await creating.result(proposal);
  await creating.press('create');
  const createdAgain = await reopen(proposal, memoryOf(creating.state));
  assert.deepEqual([createdAgain.shown.title, createdAgain.shown.done, createdAgain.labels(), createdAgain.calls()],
    ['Created Invoice Chaser', true, [], []]);

  // A host that keeps nothing, as claude.ai: the preview it saved says it changed since.
  const changed = await reopen(preview, undefined);
  assert.deepEqual([changed.labels(), changed.shown.blocks.at(-1)],
    [['Cancel (secondary)'], { kind: 'note', text: 'It changed since this preview. Ask again for a fresh one.', tone: 'warn' }]);
});

// Mutation proof (item 2): a card that draws its buttons at once offers Turn off before it knows the Agent is there.
test('a card that mounts draws no button until its first read answers', async (t) => {
  const { turnOff, card } = await world(t, 'memory-checking');
  const pending = await turnOff();
  const confirm = card();
  confirm.hold = ({ tool }) => tool === 'get_agent';
  await confirm.result(pending);
  assert.deepEqual([confirm.shown.title, confirm.labels()], ['Turn off @support?', []], 'the question shows; its buttons wait');
  await confirm.press('confirm');
  assert.deepEqual(confirm.calls('confirm_change'), [], 'a press before the read sends nothing');
  await confirm.answer();
  assert.deepEqual(confirm.labels(), ['Turn off (danger)', 'Keep it on (secondary)']);

  // Its Agent deleted since: the confirmation has nothing left to confirm.
  const gone = card();
  gone.hold = ({ tool }) => tool === 'get_agent';
  await gone.result(pending);
  gone.held[0]!.result = { isError: true, structuredContent: { error: { code: 'not_found', message: 'No Agent.', retryable: false } } };
  await gone.answer();
  assert.deepEqual([gone.shown.title, gone.labels()], ['Support Desk is no longer available', []]);
});

test('an older card drops Undo once a newer change exists, however its change was made', async (t) => {
  const { call, version, turnOff, card } = await world(t, 'memory-undo');
  const pending = await turnOff();
  const confirmed = card();
  await confirmed.result(pending);
  await confirmed.press('confirm');
  assert.deepEqual(confirmed.labels(), ['Undo (secondary)']);
  await call('update_agent', { agentId: 'agent_support', version: await version(), description: 'Newer.', idempotencyKey: 'newer' });
  await confirmed.dispatch({ type: 'reread', now: Date.now() });
  assert.deepEqual(confirmed.labels(), [], 'scrolled back to, it reads the Agent and offers no Undo');
});

// The widget state run-card writes is exactly `told` and `outcome`, and ChatGPT shows all of it to its model.
test('what a card keeps where the host\'s model reads it holds no token, ID or instructions', async (t) => {
  const { call, f, version, turnOff, card } = await world(t, 'memory-safe');
  const secrets = new Set<string>(['agent_support', 'agent_invoice_chaser', INSTRUCTIONS, 'Chase invoices.']);
  const kept: Memory[] = [];
  const watch = (opened: ReturnType<typeof card>) => {
    const dispatch = opened.dispatch.bind(opened);
    opened.dispatch = async (event) => {
      await dispatch(event);
      kept.push(memoryOf(opened.state));
    };
    return opened;
  };
  for (const press of ['keep', 'confirm'] as const) {
    const pending = await turnOff();
    secrets.add(tokenOf(pending));
    const confirm = watch(card());
    await confirm.result(pending);
    await confirm.press(press);
    const { undoToken } = confirm.state.view as { undoToken?: string };
    if (undoToken) secrets.add(undoToken);
    if (press === 'confirm') await confirm.press('undo');
  }
  await f.config.updateAgent('agent_support', { enabled: true });
  const preview = await call('propose_agent_change', { agentId: 'agent_support', version: await version(), change: { instructions: `${INSTRUCTIONS}\nCite the article.` } });
  secrets.add(`${INSTRUCTIONS}\nCite the article.`);
  const change = watch(card());
  await change.result(preview);
  await change.press('save');
  const proposal = await call('propose_agent', {
    name: 'Invoice Chaser', handle: 'invoices', job: 'Chases overdue invoices.', instructions: '# Job\nChase invoices.',
    sampleAsk: 'who is overdue?', promisedAnswer: 'I list them.',
  });
  secrets.add((proposal.structuredContent as { create: { arguments: { idempotencyKey: string } } }).create.arguments.idempotencyKey);
  const create = watch(card());
  await create.result(proposal);
  await create.press('create');

  assert.ok(kept.some(({ outcome }) => outcome !== undefined) && kept.some(({ told }) => told.length === 2), 'the journeys kept something');
  for (const memory of kept) {
    const written = JSON.stringify(memory);
    for (const secret of secrets) assert.equal(written.includes(secret), false, `${secret} kept: ${written}`);
    assert.doesNotMatch(written, /changeset_|"agentId"|https?:/, written);
  }
});

// Mutation proof (item 4): sending only the newest sentence loses what the card said before.
test('each update to the host\'s model carries everything the card told before, newest last, bounded', () => {
  type Counted = { kind: 'n'; n: number };
  const counting = sequenced<Counted, 'say' | 'shout'>((state, event) => event.type === 'press'
    ? tell(show({ kind: 'n', n: state.view.n + 1 }), event.action === 'shout' ? 'x'.repeat(TOLD_CHARS + 10) : `Sentence ${state.view.n + 1}.`)
    : stay(state));
  let state: CardState<Counted> = { view: { kind: 'n', n: 0 }, busy: false, seq: 0 };
  const sent: string[] = [];
  const press = (action: 'say' | 'shout') => {
    const next = counting(state, { type: 'press', action, now: 0 });
    state = next.state;
    sent.push(...next.effects.flatMap((effect) => effect.type === 'context' ? [effect.text] : []));
  };
  press('say');
  press('say');
  assert.deepEqual(sent, ['Sentence 1.', 'Sentence 1.\nSentence 2.'], 'each update replaces the last, so each carries the history');
  for (let i = 0; i < 10; i += 1) press('say');
  assert.equal(sent.at(-1), Array.from({ length: TOLD_MAX }, (_, i) => `Sentence ${12 - TOLD_MAX + i + 1}.`).join('\n'), `the newest ${TOLD_MAX}`);
  press('shout');
  assert.equal(sent.at(-1), 'x'.repeat(TOLD_CHARS + 10), 'the newest stays even when it alone is long; nothing older fits beside it');
  press('say');
  assert.equal(sent.at(-1), 'Sentence 14.', 'a long sentence leaves as soon as a newer one would not fit beside it');
  assert.equal(state.told?.join('\n'), sent.at(-1), 'the state holds what was sent');
});
