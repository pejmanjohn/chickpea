import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { INITIAL, present, step, type Action, type View } from '../src/mcp-cards/agent-card/model.ts';
import {
  hostErrorOf,
  hostFailed,
  hostWrites,
  keptMemory,
  keptState,
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
import { createFixtureAgent, type ManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';
import { cardHost, cardServer, type CardHostKind, type CardModelUnderTest } from './helpers/mcp-card-host.ts';

/**
 * What the live check on ChatGPT found, against Core's real MCP server:
 * a refusal reached the card without its code; a reopened card offered
 * buttons that could not work; the card's widget state, which ChatGPT shows
 * its model, held tokens; and each update to the model replaced the last.
 * Probe 12 then found ChatGPT hides `privateContent` from its model beside a
 * `modelContent`, so a created Agent's ID may be kept there.
 */

const AGENT_CARD: CardModelUnderTest<View, Action> = {
  initial: INITIAL,
  step,
  present,
  reads: new Set(['get_creation_status', 'get_agent', 'get_confirmation']),
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
  return { ...server, version, turnOff, card: (host?: CardHostKind) => cardHost(AGENT_CARD, call, clock, host) };
}

/** What Slack does after create_agent: the Agent joins, and its hello is delivered. */
async function arrive(f: ManagementAdapterFixture, clock: { now: number }, agentId: string): Promise<void> {
  const agent = await f.config.getAgent(agentId);
  await f.config.updateAgent(agentId, { slackPresence: { ...agent!.slackPresence!, health: 'healthy' } });
  const claimed = await f.management.claimDueOutbox(clock.now, 25, clock.now + 60_000);
  const hello = claimed.find(({ receipt }) => 'kind' in receipt && receipt.kind === 'agent_created_welcome');
  assert.ok(hello, 'create_agent queued a hello');
  await f.management.settleOutbox({ outboxId: hello.outboxId, outcome: 'delivered', at: clock.now, deliveryRef: 'D1:1.1' });
}

const tokenOf = (result: ToolResult) => (result._meta?.['chickpea/held'] as { confirmToken: string }).confirmToken;
const memoryOf = ({ told = [], outcome }: CardState<View>): Memory => ({ told, ...outcome === undefined ? {} : { outcome } });

// Mutation proof (item 1): reading only the result's own structuredContent fails the three host deliveries.
test('a refusal reaches the card wherever its host put it: in the result, beside it, or with a JSON-RPC error', async (t) => {
  const { call, turnOff, card } = await world(t, 'memory-refusal');
  const pending = await turnOff();
  // Kept on another card after this one asked where it stands: the token this card holds is retired.
  await call('decline_change', { confirmToken: tokenOf(pending) });
  const refused = await call('confirm_change', { confirmToken: tokenOf(pending) });
  const sentence = 'That confirmation no longer applies. Ask again to make the change.';
  assert.equal((refused.structuredContent as { error: { code: string; message: string } }).error.message, sentence);
  assert.equal(refused.isError, false, 'a card session gets the refusal as a result');

  const { structuredContent: _stripped, ...bare } = refused;
  const deliveries: Record<string, ToolResult> = {
    'the result itself': refused,
    'ChatGPT\'s copy of the whole result, beside a result without it': { ...bare, _meta: { mcp_tool_result: refused } },
    'a JSON-RPC error carrying the result': { isError: true, hostError: hostErrorOf({ code: -32603, message: 'Tool call failed', data: refused }) },
    'a JSON-RPC error carrying ChatGPT\'s envelope': { isError: true, hostError: hostErrorOf({ code: -32603, message: 'Tool call failed', data: { status: 'error', mcp_tool_result: refused } }) },
  };
  for (const [how, result] of Object.entries(deliveries)) {
    const confirm = card();
    confirm.hold = ({ tool }) => tool === 'get_confirmation';
    await confirm.result(pending);
    await confirm.answer('unreachable');
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
  const words: ToolResult = { isError: true, hostError: hostErrorOf({ code: -32603, message: sentence }) };
  assert.deepEqual(words.hostError, { code: -32603 }, 'the host\'s words never come in');
  assert.deepEqual([refusalOf(words), hostFailed(words)], [undefined, true]);
  const carried = deliveries['a JSON-RPC error carrying the result']!;
  assert.deepEqual([refusalOf(carried)?.code, hostFailed(carried)], ['changed_since_read', false]);
});

// Mutation proof (review MUST 1): taking an error with no code as Chickpea's refusal shows and keeps "Nothing changed".
test('an error with no Chickpea code, answering Turn off, keeps the buttons: the change may have been made', async (t) => {
  const { f, turnOff, card } = await world(t, 'memory-host-error');
  const pending = await turnOff();
  const confirm = card();
  await confirm.result(pending);
  confirm.hold = ({ tool }) => tool === 'confirm_change';
  await confirm.press('confirm');
  assert.equal((await f.config.getAgent('agent_support'))!.enabled, false, 'the server made the change');
  // The host answers with an error result of its own: words, no structuredContent.
  const timedOut = { isError: true, content: [{ type: 'text', text: 'Request timed out' }] };
  confirm.held[0]!.result = timedOut;
  const told = confirm.effects.length;
  await confirm.answer();
  assert.deepEqual([confirm.shown.title, confirm.labels(), confirm.shown.busy], ['Turn off @support?', ['Turn off (danger)', 'Keep it on (secondary)'], false]);
  assert.equal(confirm.shown.error, 'That did not work. Try again.');
  assert.deepEqual(confirm.effects.slice(told).filter(({ type }) => type === 'context'), [], 'the model is told nothing');
  assert.equal(confirm.state.outcome, undefined, 'nothing is kept for a reopened card');

  // Pressed again, the same token: Chickpea's answer decides.
  confirm.hold = () => false;
  await confirm.press('confirm');
  assert.deepEqual(confirm.calls('confirm_change').map(({ args }) => args.confirmToken), [tokenOf(pending), tokenOf(pending)]);
  assert.equal(confirm.shown.done, true, confirm.shown.title);
});

test('a card first drawn with a refusal shows its sentence, from the result or ChatGPT\'s copy of it', async (t) => {
  const { call, card } = await world(t, 'memory-error-result');
  const refused = await call('get_agent', { agentId: 'agent_missing' });
  const { error } = refused.structuredContent as { error: { code: string; message: string } };
  assert.deepEqual([refused.isError, error.code], [false, 'not_found']);
  const { structuredContent: _stripped, ...bare } = refused;
  for (const result of [refused, { ...bare, _meta: { mcp_tool_result: refused } }]) {
    const drawn = card();
    await drawn.result(result);
    assert.deepEqual([drawn.shown.title, drawn.labels()], [error.message, []]);
  }
});

// Mutation proof (item 2): a card that ignores what it kept offers Keep it on, Save or Create again.
test('a card that mounts again comes back to what its presses did, and never offers a button that cannot work', async (t) => {
  const { call, f, turnOff, version, card, clock } = await world(t, 'memory-reopen');
  const reopen = async (result: ToolResult, kept: Memory | undefined) => {
    const again = card();
    await again.dispatch({ type: 'result', result, kept, now: clock.now });
    return again;
  };
  const writes = (opened: ReturnType<typeof card>) => opened.calls().filter(({ tool }) => !AGENT_CARD.reads.has(tool));

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
    ['Turned off Support Desk', true, [], []]);
  assert.deepEqual(confirmedAgain.calls().map(({ tool }) => tool), ['get_agent'], 'it reads where the Agent stands');
  assert.equal(confirming.state.outcome !== undefined && !JSON.stringify(confirming.state.outcome).includes(tokenOf(confirmed)), true, 'no token kept');

  // Saved, then undone, on a change card.
  await f.config.updateAgent('agent_support', { enabled: true });
  const preview = await call('propose_agent_change', { agentId: 'agent_support', version: await version(), change: { description: 'Answers support questions.' } });
  const changing = card();
  await changing.result(preview);
  await changing.press('save');
  await changing.press('undo');
  const undoneAgain = await reopen(preview, memoryOf(changing.state));
  assert.deepEqual([undoneAgain.shown.title, undoneAgain.labels(), writes(undoneAgain)], ['Undid the change', [], []]);

  // Created from the proposal: it follows the Agent it created, and offers no second Create.
  const proposal = await call('propose_agent', {
    name: 'Invoice Chaser', handle: 'invoices', job: 'Chases overdue invoices.', instructions: '# Job\nChase invoices.',
    sampleAsk: 'who is overdue?', promisedAnswer: 'I list them.',
  });
  const creating = card();
  await creating.result(proposal);
  await creating.press('create');
  const createdAgain = await reopen(proposal, memoryOf(creating.state));
  assert.deepEqual([createdAgain.state.view.kind, createdAgain.shown.title, createdAgain.calls().map(({ tool, args }) => [tool, args])],
    ['creating', 'Invoice Chaser', [['get_creation_status', { agentId: 'agent_invoice_chaser' }]]], 'it reads the arrival of the Agent it created');
  assert.deepEqual([writes(createdAgain), createdAgain.effects.some(({ type }) => type === 'context')], [[], false], 'and tells the model nothing new');
  // Arrived in Slack meanwhile: Open in Slack and its next step come back.
  await createdAgain.dispatch({
    type: 'reply',
    call: { tool: 'get_creation_status', args: { agentId: 'agent_invoice_chaser' }, seq: createdAgain.state.seq },
    result: { structuredContent: { stage: 'said_hello', agent: { name: 'Invoice Chaser', handle: 'invoices', hasFirstAsk: true }, channels: 'none', slackUrl: 'https://slack.com/app_redirect?team=T1&app=A1' } },
    now: clock.now,
  });
  assert.deepEqual([createdAgain.shown.title, createdAgain.labels()],
    ['@invoices said hello to you in Slack', ['Open in Slack (primary)', 'See its first answer (secondary)']]);
  assert.equal(createdAgain.effects.some(({ type }) => type === 'context'), false, 'its arrival is not news to the model');
  // What an older card kept, with no ID: it shows only that it created it.
  const { outcome: _outcome, ...withoutId } = memoryOf(creating.state);
  const createdBefore = await reopen(proposal, { ...withoutId, outcome: { kind: 'created', name: 'Invoice Chaser' } });
  assert.deepEqual([createdBefore.shown.title, createdBefore.shown.done, createdBefore.labels(), createdBefore.calls()],
    ['Created Invoice Chaser', true, [], []]);
  // What the host kept is untrusted: an ID that is not an Agent's is no ID, and nothing is read with it.
  const createdOdd = await reopen(proposal, { ...withoutId, outcome: { kind: 'created', name: 'Invoice Chaser', agentId: '../agent_support' } });
  assert.deepEqual([createdOdd.shown.title, createdOdd.calls()], ['Created Invoice Chaser', []]);

  // A host that keeps nothing, as claude.ai: the preview it saved says it changed since.
  const changed = await reopen(preview, undefined);
  assert.deepEqual([changed.labels(), changed.shown.blocks.at(-1)],
    [['Cancel (secondary)'], { kind: 'note', text: 'It changed since this preview. Ask again for a fresh one.', tone: 'warn' }]);
});

// Mutation proof (dry run M4): sending ChatGPT a `ui/update-model-context` after the widget state, as run-card
// did, leaves ChatGPT only the model's sentences, and every card here reloads with its first buttons again.
test('reloaded in ChatGPT, each card comes back to what its presses did, offers none of its first buttons again, and only reads', async (t) => {
  const { call, f, clock, turnOff, version, card } = await world(t, 'memory-reload');
  const tools = (opened: ReturnType<typeof card>) => opened.calls().map(({ tool }) => tool);
  const kept = (opened: ReturnType<typeof card>) => keptMemory(opened.widgetState, 9)?.outcome;

  // Created from the proposal, then arrived in Slack: the Agent's card, never Create again.
  const proposal = await call('propose_agent', {
    name: 'Invoice Chaser', handle: 'invoices', job: 'Chases overdue invoices.', instructions: '# Job\nChase invoices.',
    sampleAsk: 'who is overdue?', promisedAnswer: 'I list them.',
  });
  const created = card();
  await created.result(proposal);
  await created.press('create');
  await arrive(f, clock, 'agent_invoice_chaser');
  await created.dispatch({ type: 'tick', now: clock.now });
  assert.equal(created.shown.title, '@invoices said hello to you in Slack');
  assert.equal(created.modelReads, [
    'The person created the Agent "Invoice Chaser" (@invoices) from the card. It is joining Slack now.',
    'The person created the Agent "Invoice Chaser" (@invoices) from the card. It is ready in Slack and said hello to them there.',
  ].join('\n'), 'ChatGPT\'s model reads what the card told it, from the widget state');
  created.hold = ({ tool }) => tool === 'get_creation_status';
  await created.reopen(proposal);
  assert.deepEqual([created.shown.title, created.labels(), tools(created)], ['Invoice Chaser', [], ['get_creation_status']],
    'while it reads where the Agent stands: its steps, and nothing to press');
  await created.answer();
  assert.deepEqual([created.shown.title, created.labels()], ['@invoices said hello to you in Slack', ['See its first answer (secondary)']]);
  assert.deepEqual(created.effects.filter(({ type }) => type === 'context'), [], 'its arrival is not news to the model');
  assert.deepEqual(kept(created), { kind: 'created', name: 'Invoice Chaser', agentId: 'agent_invoice_chaser' }, 'what ChatGPT kept');
  created.hold = () => false;

  // Saved on a change card: Saved, never Save again.
  const preview = await call('propose_agent_change', { agentId: 'agent_support', version: await version(), change: { description: 'Answers support questions.' } });
  const saving = card();
  await saving.result(preview);
  await saving.press('save');
  assert.equal(saving.shown.title, 'Saved Support Desk');
  await saving.reopen(preview);
  assert.deepEqual([saving.shown.title, saving.shown.done, saving.labels(), tools(saving)], ['Saved Support Desk', true, [], ['get_agent']]);

  // Saved, then undone: no Save, and no Undo that would save it again.
  const second = await call('propose_agent_change', { agentId: 'agent_support', version: await version(), change: { description: 'Answers billing questions.' } });
  const undoing = card();
  await undoing.result(second);
  await undoing.press('save');
  await undoing.press('undo');
  await undoing.reopen(second);
  assert.deepEqual([undoing.shown.title, undoing.labels(), tools(undoing)], ['Undid the change', [], ['get_agent']]);

  // Kept on a confirmation, then turned off on another: neither asks again.
  const keptOn = await turnOff();
  const keeping = card();
  await keeping.result(keptOn);
  await keeping.press('keep');
  await keeping.reopen(keptOn);
  assert.deepEqual([keeping.shown.title, keeping.labels(), tools(keeping)], ['Kept as it is', [], []]);
  const off = await turnOff();
  const confirming = card();
  await confirming.result(off);
  await confirming.press('confirm');
  await confirming.reopen(off);
  assert.deepEqual([confirming.shown.title, confirming.labels(), tools(confirming)], ['Turned off Support Desk', [], ['get_agent']]);
  assert.equal((await f.config.getAgent('agent_support'))!.enabled, false, 'nothing a reload did turned it back on');
  assert.equal((await f.config.listAgents()).filter(({ name }) => name === 'Invoice Chaser').length, 1, 'and nothing made a second Agent');
});

test('claude.ai keeps nothing across a reload, so it gets each sentence as a model update, and a reloaded card asks Chickpea', async (t) => {
  const { call, version, card } = await world(t, 'memory-reload-claude');
  const preview = await call('propose_agent_change', { agentId: 'agent_support', version: await version(), change: { description: 'Answers support questions.' } });
  const saving = card('claude');
  await saving.result(preview);
  await saving.press('save');
  assert.deepEqual([saving.widgetState, saving.modelReads], [undefined, 'The person saved the change to the Agent "Support Desk" from the card.']);
  await saving.reopen(preview);
  assert.deepEqual([saving.labels(), saving.shown.blocks.at(-1)],
    [['Cancel (secondary)'], { kind: 'note', text: 'It changed since this preview. Ask again for a fresh one.', tone: 'warn' }], 'no Save for what changed since');
});

// Mutation proof (dry run M4): any update to the host's model besides the widget state fails the first case.
test('a host that keeps widget state gets one write, holding what its model reads and what the card keeps; any other host gets the model update', () => {
  const before: CardState<View> = { view: { kind: 'notice', title: 'Before' }, busy: false, seq: 1, told: ['Earlier.'] };
  const next = { state: { ...before, seq: 2, told: ['Earlier.', 'Now.'], outcome: { kind: 'notice', title: 'Now' } }, effects: [{ type: 'context' as const, text: 'Earlier.\nNow.' }] };
  const press = { type: 'press', action: 'keep', now: 0 } as const;
  assert.deepEqual(hostWrites(before, press, next, { keepsState: true, version: 3 }), [{ type: 'state', state: keptState(next.state, 3) }]);
  assert.equal(keptState(next.state, 3).modelContent, 'Earlier.\nNow.', 'the model reads the same sentences either way');
  assert.deepEqual(hostWrites(before, press, next, { keepsState: false, version: 3 }), [{ type: 'context', text: 'Earlier.\nNow.' }]);
  // Mounting with what was kept writes nothing back, and a step that tells nothing writes nothing.
  const mounted = { state: next.state, effects: [] };
  assert.deepEqual(hostWrites(INITIAL, { type: 'result', result: {}, kept: { told: next.state.told }, now: 0 }, mounted, { keepsState: true, version: 3 }), []);
  assert.deepEqual(hostWrites(next.state, { type: 'reread', now: 0 }, { state: { ...next.state, seq: 3 }, effects: [] }, { keepsState: true, version: 3 }), []);
  // What the host kept is read back only for the same card version.
  assert.deepEqual(keptMemory(keptState(next.state, 3), 3), { told: ['Earlier.', 'Now.'], outcome: { kind: 'notice', title: 'Now' } });
  assert.equal(keptMemory(keptState(next.state, 3), 4), undefined);
  assert.equal(keptMemory({ modelContent: 'Earlier.\nNow.' }, 3), undefined, 'a model update ChatGPT kept is not what the card kept');
});

// Mutation proof (item 2): a card that takes presses at once offers Turn off before it knows the Agent is there.
test('a card that mounts draws its buttons waiting until its first read answers or fails', async (t) => {
  const { turnOff, card } = await world(t, 'memory-checking');
  const pending = await turnOff();
  const confirm = card();
  confirm.hold = ({ tool }) => tool === 'get_agent';
  await confirm.result(pending);
  assert.deepEqual([confirm.shown.title, confirm.labels(), confirm.shown.busy], ['Turn off @support?', ['Turn off (danger)', 'Keep it on (secondary)'], true],
    'the question and its buttons show; the buttons wait');
  await confirm.press('confirm');
  assert.deepEqual(confirm.calls('confirm_change'), [], 'a press before the read sends nothing');
  await confirm.answer();
  assert.deepEqual([confirm.labels(), confirm.shown.busy], [['Turn off (danger)', 'Keep it on (secondary)'], false]);

  // A read that fails is not a failed write: the buttons stop waiting, and Chickpea decides on a press.
  const unread = card();
  unread.hold = ({ tool }) => tool === 'get_agent';
  await unread.result(pending);
  await unread.answer('unreachable');
  assert.deepEqual([unread.labels(), unread.shown.busy], [['Turn off (danger)', 'Keep it on (secondary)'], false]);

  // Its Agent deleted since: the confirmation has nothing left to confirm.
  const gone = card();
  gone.hold = ({ tool }) => tool === 'get_agent';
  await gone.result(pending);
  gone.held[0]!.result = { isError: true, structuredContent: { error: { code: 'not_found', message: 'No Agent.', retryable: false } } };
  await gone.answer();
  assert.deepEqual([gone.shown.title, gone.labels()], ['Support Desk is no longer available', []]);
});

// Mutation proof (review SHOULD 3): a resumed done card that keeps its undoToken offers an Undo that redoes the change.
test('a done card that mounts again after its Undo offers no Undo, even when its read fails', async (t) => {
  const { call, version, card } = await world(t, 'memory-undone-reopen');
  // A change the model made: the card is drawn with update_agent's done result and its Undo.
  const saved = await call('update_agent', { agentId: 'agent_support', version: await version(), description: 'Answers support questions.', idempotencyKey: 'described' });
  assert.equal((saved.structuredContent as { status: string }).status, 'done');
  const first = card();
  await first.result(saved);
  assert.ok(first.labels().includes('Undo (secondary)'), JSON.stringify(first.labels()));
  await first.press('undo');
  assert.equal(first.shown.title, 'Undid the change');

  const again = card();
  again.hold = ({ tool }) => tool === 'get_agent';
  await again.dispatch({ type: 'result', result: saved, kept: memoryOf(first.state), now: Date.now() });
  const undo = () => again.labels().filter((label) => label.startsWith('Undo'));
  assert.deepEqual([again.shown.title, undo()], ['Undid the change', []], 'while it reads');
  await again.answer('unreachable');
  assert.deepEqual([again.shown.title, undo()], ['Undid the change', []], 'after its read fails');
});

// Mutation proof (review SHOULD 3): a mount read that judges a confirmation replaces Delete with "is archived".
test('a delete confirmation keeps its buttons after the mount read finds its Agent archived', async (t) => {
  const { call, version, card } = await world(t, 'memory-delete-archived');
  const archived = await call('archive_agent', { agentId: 'agent_support', version: await version(), idempotencyKey: 'archive' });
  const deleting = await call('delete_agent', { agentId: 'agent_support', version: (archived.structuredContent as { version: string }).version, idempotencyKey: 'delete' });
  const confirm = card();
  await confirm.result(deleting);
  assert.deepEqual(confirm.calls().map(({ tool }) => tool), ['get_confirmation', 'get_agent'], 'it read where the confirmation and the Agent stand');
  assert.deepEqual([confirm.labels(), confirm.shown.busy], [['Delete (danger)', 'Keep it (secondary)'], false]);
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

// Mutation proof (review SHOULD 2): keptState writing the view, tokens included, into privateContent.
// It is what run-card writes to the widget state. ChatGPT's model reads modelContent, and privateContent
// beside it only when there is none (probe 12), so only privateContent may hold a created Agent's ID.
test('what a card keeps holds no token or instructions, and only its private part holds an ID', async (t) => {
  const { call, f, version, turnOff, card } = await world(t, 'memory-safe');
  const ids = ['agent_support', 'agent_invoice_chaser'];
  const secrets = new Set<string>([INSTRUCTIONS, 'Chase invoices.']);
  const kept: Array<ReturnType<typeof keptState>> = [];
  const watch = (opened: ReturnType<typeof card>) => {
    const dispatch = opened.dispatch.bind(opened);
    opened.dispatch = async (event) => {
      await dispatch(event);
      kept.push(keptState(opened.state, 9));
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

  const cards = kept.map(({ privateContent }) => privateContent.card);
  assert.ok(cards.some(({ outcome }) => outcome !== undefined) && cards.some(({ told }) => told.length === 2), 'the journeys kept something');
  assert.ok(cards.some(({ outcome }) => JSON.stringify(outcome) === '{"kind":"created","name":"Invoice Chaser","agentId":"agent_invoice_chaser"}'),
    'a creation keeps its Agent\'s ID');
  for (const state of kept) {
    const written = JSON.stringify(state);
    assert.deepEqual([Object.keys(state), Object.keys(state.privateContent)], [['modelContent', 'privateContent'], ['card']], written);
    assert.ok(Object.keys(state.privateContent.card).every((key) => ['version', 'told', 'outcome'].includes(key)), written);
    assert.equal(state.modelContent, state.privateContent.card.told.join('\n'), 'the model reads what the card told it');
    for (const secret of [...secrets, ...ids]) assert.equal(state.modelContent.includes(secret), false, `${secret} told: ${written}`);
    for (const secret of secrets) assert.equal(written.includes(secret), false, `${secret} kept: ${written}`);
    const { agentId: _id, ...outcome } = (state.privateContent.card.outcome ?? {}) as { agentId?: string };
    for (const id of ids) assert.equal(JSON.stringify({ ...state.privateContent.card, outcome }).includes(id), false, `${id} kept outside a creation: ${written}`);
    assert.doesNotMatch(written, /changeset_|https?:/, written);
  }
});

// Mutation proof (item 4): sending only the newest sentence loses what the card said before.
test('each update to the host\'s model carries everything the card told before, newest last, bounded', () => {
  type Counted = { kind: 'n'; n: number };
  const counting = sequenced<Counted, 'say' | 'shout' | 'again'>((state, event) => event.type === 'press'
    ? tell(show({ kind: 'n', n: state.view.n + 1 }), event.action === 'shout' ? 'x'.repeat(TOLD_CHARS + 10)
      : event.action === 'again' ? 'Nothing new.' : `Sentence ${state.view.n + 1}.`)
    : stay(state));
  let state: CardState<Counted> = { view: { kind: 'n', n: 0 }, busy: false, seq: 0 };
  const sent: string[] = [];
  const press = (action: 'say' | 'shout' | 'again') => {
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

  // Mutation proof (review SHOULD 5): a sentence told again takes one place, so repeated presses keep what came before.
  for (let i = 0; i < TOLD_MAX + 2; i += 1) press('again');
  assert.equal(sent.at(-1), 'Sentence 14.\nNothing new.', 'the same sentence again moves to the end');
});
