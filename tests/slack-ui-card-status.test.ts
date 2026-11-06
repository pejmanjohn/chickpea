import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteSlackStateStore } from '../src/slack/claim-store.ts';
import { createSlackReadGate, UNGATED_SLACK_READS } from '../src/slack/read-budget.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { checkSlackBlocks } from '../src/slack/ui/block-kit-limits.ts';
import { createUpdateCardTool } from '../src/slack/ui/card-outcome-tool.ts';
import { cardSetMessageBlocks, readCardSetMessage, type CardSetMessage } from '../src/slack/ui/card-set-message.ts';
import { createDisplayTools } from '../src/slack/ui/display-tools.ts';
import { deliverInteractiveSurfaces, type UiSurfaceMessenger } from '../src/slack/ui/host-surfaces.ts';
import { validatePresentCards } from '../src/slack/ui/presentation-tools.ts';
import { renderCardSet, renderCards } from '../src/slack/ui/render-display.ts';
import {
  displaySurfaceId,
  uiBlockId,
  uiSurfaceId,
  type UiSurfaceRecord,
} from '../src/slack/ui/surface.ts';
import { UiSurfaceStoreLogic } from '../src/slack/ui/surface-store.ts';

const NOW = Date.UTC(2026, 10, 6, 15, 0);
const THREAD = '1.000001';
const ANSWER_TS = '2.000001';
const WEEK = 7 * 24 * 60 * 60_000;

const SPEC = validatePresentCards({
  caption: 'Budget changes',
  cards: [
    { title: 'Campaign A', subtitle: 'Raise to $30/day', actions: [{ label: 'Approve' }, { label: 'Skip' }] },
    { title: 'Campaign B', subtitle: 'Raise to $45/day', actions: [{ label: 'Approve' }, { label: 'Skip' }] },
    { title: 'Campaign C', subtitle: 'No change', link: 'https://ads.example.com/c' },
  ],
});

function cardSet(patch: Partial<UiSurfaceRecord> = {}): UiSurfaceRecord {
  return {
    id: displaySurfaceId('job1', 0), namespace: 'ui', workspaceId: 'T1', channelId: 'C1', threadTs: THREAD,
    conversationThreadTs: THREAD, conversationKind: 'channel', agentId: 'agent_a', turnJobId: 'job1',
    requesterUserId: 'U1', spec: { kind: 'cards', cards: SPEC }, status: 'open', messageTs: ANSWER_TS,
    createdAt: NOW, updatedAt: NOW, expiresAt: NOW + WEEK, ...patch,
  };
}

const pick = (surfaceId: string, slot: number, byUserId = 'U2') =>
  ({ surfaceId, resolution: { byUserId, at: NOW, choice: slot } });

type Block = Record<string, unknown>;

function cardsIn(blocks: readonly Block[], surfaceId: string): Block[] {
  const set = blocks.find((block) => block.block_id === uiBlockId('ui', surfaceId, 1))!;
  return set.type === 'carousel' ? set.elements as Block[] : [set];
}

const requestButtons = (card: Block) => ((card.actions ?? []) as Block[])
  .filter((button) => String(button.action_id).startsWith('chickpea.ui.v1.cards.'))
  .map((button) => (button.text as { text: string }).text);

const statusLines = (blocks: readonly Block[], surfaceId: string) => {
  const status = blocks.find((block) => block.block_id === uiBlockId('ui', surfaceId, 20));
  return ((status?.elements ?? []) as Array<{ text: string }>).map((element) => element.text);
};

test('each card claims on its own: two cards both admit, one card admits once, and the set resolves when every request card is settled', () => {
  const store = new UiSurfaceStoreLogic(openStateDb(':memory:'), () => NOW);
  const set = store.put(cardSet());
  const first = store.claim(pick(set.id, 1), 'ui');
  assert.equal(first.claimed, true);
  assert.equal(first.surface?.status, 'open', 'Campaign B can still be picked');
  assert.deepEqual(first.surface?.cardSettlements, { 0: { pick: { slot: 1, byUserId: 'U2', at: NOW } } });
  assert.equal(store.claim(pick(set.id, 2, 'U1'), 'ui').claimed, false, 'Skip on the same card loses to its Approve');
  const second = store.claim(pick(set.id, 4, 'U1'), 'ui');
  assert.equal(second.claimed, true);
  assert.equal(second.surface?.status, 'resolved', 'Campaign C has only a link, so two picks settle the set');
  assert.equal(second.surface?.resolution, undefined, 'no whole-set answer is written');
  assert.equal(store.claim(pick(set.id, 5), 'ui').claimed, false);
  assert.equal(store.claim(pick(set.id, 1), 'host').claimed, false, 'a host click never claims a ui card');
});

test('an expired or closed card set admits no click', () => {
  let now = NOW;
  const store = new UiSurfaceStoreLogic(openStateDb(':memory:'), () => now);
  const set = store.put(cardSet());
  store.close(set.id, 'superseded');
  assert.equal(store.claim(pick(set.id, 1), 'ui').claimed, false);
  const later = store.put(cardSet({ id: displaySurfaceId('job2', 0), turnJobId: 'job2' }));
  now = NOW + WEEK + 1;
  assert.equal(store.claim(pick(later.id, 1), 'ui').claimed, false);
});

test('a later answer leaves earlier cards open for the approve, confirm, approve-next flow', async () => {
  const state = new SqliteSlackStateStore(':memory:');
  const updates: string[] = [];
  const messenger: UiSurfaceMessenger = {
    async post() { return '9.000001'; },
    async update(messageTs) { updates.push(messageTs); },
  };
  const set = cardSet();
  await state.executeUiSurface!({ kind: 'put_surface', record: set });
  await deliverInteractiveSurfaces({
    turn: { workspaceId: 'T1', channelId: 'C1', threadTs: THREAD }, agentId: 'agent_a', turnJobId: 'job2',
    state, messenger, answerText: 'Approved Campaign A.',
  });
  const read = await state.executeUiSurface!({ kind: 'get_surface', id: set.id });
  assert.equal(read.kind === 'surface' && read.surface?.status, 'open');
  assert.deepEqual(updates, []);
  state.close();
});

test('a settled card loses its request buttons and shows its status; the person and time show under the cards', () => {
  const store = new UiSurfaceStoreLogic(openStateDb(':memory:'), () => NOW);
  const set = store.put(cardSet());
  const picked = store.claim(pick(set.id, 1), 'ui').surface!;
  const rendered = renderCardSet(picked);
  assert.deepEqual(checkSlackBlocks(rendered.blocks).issues, []);
  const [a, b, c] = cardsIn(rendered.blocks, set.id);
  assert.deepEqual(requestButtons(a!), [], 'the clicked card loses its request buttons');
  assert.equal((a!.subtext as { text: string }).text, ':white_check_mark: Approve');
  assert.deepEqual(requestButtons(b!), ['Approve', 'Skip'], 'the other card stays live');
  assert.equal((c!.actions as Block[])[0]!.url, 'https://ads.example.com/c', 'link buttons stay');
  const [line] = statusLines(rendered.blocks, set.id);
  assert.match(line!, /^:white_check_mark: \*Approve\* on \*Campaign A\*, requested by <@U2> · <!date\^\d+\^\{time\}\|15:00 UTC>$/);

  const done = store.setCardOutcome({
    id: set.id, scope: { workspaceId: 'T1', channelId: 'C1', threadTs: THREAD, agentId: 'agent_a' },
    card: 0, outcome: { tone: 'done', text: 'Done, $30/day verified', at: NOW + 60_000 },
  })!;
  const after = renderCardSet(done);
  const [doneCard] = cardsIn(after.blocks, set.id);
  assert.equal((doneCard!.subtext as { text: string }).text, ':white_check_mark: Done, $30/day verified');
  assert.match(statusLines(after.blocks, set.id)[0]!, /^:white_check_mark: \*Campaign A\*: Done, \$30\/day verified \(\*Approve\* by <@U2>\) · <!date/);
  assert.deepEqual(checkSlackBlocks(after.blocks).issues, []);
});

test('an outcome on a card nobody clicked settles it; a failure reads as one', () => {
  const store = new UiSurfaceStoreLogic(openStateDb(':memory:'), () => NOW);
  const set = store.put(cardSet());
  const scope = { workspaceId: 'T1', channelId: 'C1', threadTs: THREAD, agentId: 'agent_a' };
  const failed = store.setCardOutcome({
    id: set.id, scope, card: 1, outcome: { tone: 'failed', text: 'The budget changed since', at: NOW },
  })!;
  assert.equal(failed.status, 'open');
  const [, b] = cardsIn(renderCardSet(failed).blocks, set.id);
  assert.deepEqual(requestButtons(b!), []);
  assert.equal((b!.subtext as { text: string }).text, ':x: The budget changed since');
  assert.match(statusLines(renderCardSet(failed).blocks, set.id)[0]!, /^:x: \*Campaign B\*: The budget changed since · <!date/);
  assert.equal(store.claim(pick(set.id, 4), 'ui').claimed, false, 'a settled card admits no click');
  assert.equal(store.setCardOutcome({ ...{ id: set.id, card: 1, outcome: { tone: 'info', text: 'x', at: NOW } }, scope: { ...scope, agentId: 'agent_b' } }), undefined);
  assert.equal(store.setCardOutcome({ id: set.id, scope: { ...scope, threadTs: '9.000001' }, card: 1, outcome: { tone: 'info', text: 'x', at: NOW } }), undefined);
  assert.equal(store.setCardOutcome({ id: set.id, scope, card: 3, outcome: { tone: 'info', text: 'x', at: NOW } }), undefined);
});

test('a set answered whole by an older build still reads, renders, and takes an outcome', () => {
  const store = new UiSurfaceStoreLogic(openStateDb(':memory:'), () => NOW);
  const set = store.put(cardSet());
  // An older build resolved the whole set on its first click.
  const old = store.resolve(set.id, { byUserId: 'U2', at: NOW, choice: 1 })!;
  assert.equal(old.status, 'resolved');
  assert.equal(old.resolution?.byUserId, 'U2');
  assert.equal(old.cardSettlements, undefined);
  const rendered = renderCardSet(old);
  assert.deepEqual(checkSlackBlocks(rendered.blocks).issues, []);
  const [a, b] = cardsIn(rendered.blocks, set.id);
  assert.deepEqual(requestButtons(a!), []);
  assert.deepEqual(requestButtons(b!), [], 'the older build closed every card with its first click');
  assert.match(statusLines(rendered.blocks, set.id)[0]!, /\*Approve\* on \*Campaign A\*, requested by <@U2>/);
  assert.equal(store.claim(pick(set.id, 4), 'ui').claimed, false);
  const outcome = store.setCardOutcome({
    id: set.id, scope: { workspaceId: 'T1', channelId: 'C1', threadTs: THREAD, agentId: 'agent_a' },
    card: 0, outcome: { tone: 'done', text: 'Done', at: NOW },
  })!;
  assert.deepEqual(outcome.cardSettlements?.[0], {
    pick: { slot: 1, byUserId: 'U2', at: NOW },
    outcome: { tone: 'done', text: 'Done', at: NOW },
  });
});

// ── the answer message the cards ride in ─────────────────────────────────

const ANSWER_BLOCK = { type: 'rich_text', block_id: 'Ab1', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Two campaigns need a budget change.' }] }] };
const CHART_BLOCK = { type: 'data_visualization', block_id: 'Ch1', title: 'Spend', chart: { type: 'pie', segments: [{ label: 'A', value: 1 }] } };
const FOOTER_BLOCK = { type: 'context', block_id: 'Ft1', elements: [{ type: 'mrkdwn', text: 'support · Claude' }] };

function answerMessage(record: UiSurfaceRecord): CardSetMessage {
  return {
    ts: ANSWER_TS,
    text: 'Two campaigns need a budget change.',
    blocks: [ANSWER_BLOCK, ...renderCards(SPEC, record.id).blocks, CHART_BLOCK, FOOTER_BLOCK],
  };
}

test('a redraw replaces only the card set and its status line; the answer, other components and footer stay', () => {
  const store = new UiSurfaceStoreLogic(openStateDb(':memory:'), () => NOW);
  const set = store.put(cardSet());
  const picked = store.claim(pick(set.id, 1), 'ui').surface!;
  const message = answerMessage(set);
  const redrawn = cardSetMessageBlocks(message, picked)!;
  assert.equal(redrawn.text, message.text);
  assert.deepEqual(redrawn.blocks[0], ANSWER_BLOCK);
  assert.deepEqual(redrawn.blocks.slice(-2), [CHART_BLOCK, FOOTER_BLOCK]);
  assert.deepEqual(redrawn.blocks.map((block) => block.type), ['rich_text', 'section', 'carousel', 'context', 'data_visualization', 'context']);
  assert.deepEqual(requestButtons(cardsIn(redrawn.blocks, set.id)[0]!), []);
  // Drawn again over itself, the status line is replaced, never repeated.
  const second = store.claim(pick(set.id, 4, 'U1'), 'ui').surface!;
  const again = cardSetMessageBlocks({ ...message, blocks: redrawn.blocks }, second)!;
  assert.equal(again.blocks.length, redrawn.blocks.length);
  assert.equal(statusLines(again.blocks, set.id).length, 2);
  assert.equal(cardSetMessageBlocks({ ...message, blocks: [ANSWER_BLOCK, FOOTER_BLOCK] }, picked), undefined,
    'a message without this card set is never rewritten');
});

test('the message is read back by its timestamp, or found by its card block when nobody clicked yet', async () => {
  const set = cardSet();
  const message = answerMessage(set);
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    conversations: {
      async replies(input: Record<string, unknown>) {
        calls.push(input);
        return {
          ok: true,
          messages: [
            { ts: THREAD, text: 'Which budgets should change?', user: 'U1' },
            { ts: '1.900000', text: 'Working on it.', bot_id: 'B1' },
            { ...message, bot_id: 'B1' },
          ],
        };
      },
    },
  };
  const bound = await readCardSetMessage(client, UNGATED_SLACK_READS, set);
  assert.deepEqual(bound, message);
  assert.deepEqual(calls[0], { channel: 'C1', ts: THREAD, oldest: ANSWER_TS, inclusive: true, limit: 15 });

  const { messageTs: _unbound, ...unbound } = set;
  assert.deepEqual(await readCardSetMessage(client, UNGATED_SLACK_READS, unbound), message);
  assert.equal(calls[1]!.oldest, '1793977140.000000', 'a minute before the set was stored');

  const state = new SqliteSlackStateStore(':memory:');
  const gate = createSlackReadGate({ state, workspaceId: 'T1', gated: true, now: () => NOW });
  assert.deepEqual(await readCardSetMessage(client, gate, set), message);
  assert.equal(await readCardSetMessage(client, gate, set), undefined, 'the shared read budget is spent');
  assert.equal(calls.length, 3);
  state.close();
});

// ── update_card ──────────────────────────────────────────────────────────

const SCOPE = {
  workspaceId: 'T1', channelId: 'C1', threadTs: THREAD, conversationKind: 'channel' as const,
  agentId: 'agent_a', turnJobId: 'job9', requesterUserId: 'U1',
};

async function withOutcomeTool(
  body: (input: {
    state: SqliteSlackStateStore;
    set: UiSurfaceRecord;
    ref: string;
    redrawn: UiSurfaceRecord[];
    tool: (scope?: typeof SCOPE, redraw?: (surface: UiSurfaceRecord) => Promise<boolean>) => ReturnType<typeof createUpdateCardTool>;
  }) => Promise<void>,
): Promise<void> {
  const state = new SqliteSlackStateStore(':memory:');
  const set = cardSet({ createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + WEEK });
  await state.executeUiSurface!({ kind: 'put_surface', record: set });
  const redrawn: UiSurfaceRecord[] = [];
  try {
    await body({
      state, set, ref: set.id.slice(0, 8), redrawn,
      tool: (scope = SCOPE, redraw = async (surface) => { redrawn.push(surface); return true; }) =>
        createUpdateCardTool({ store: async () => state, scope, redraw }),
    });
  } finally {
    state.close();
  }
}

test('update_card sets an outcome on a card by title or number and redraws the set', async () => withOutcomeTool(async ({ state, set, ref, redrawn, tool }) => {
  const result = await tool().run({ data: { cards: `cards ${ref}`, card: 'Campaign A', tone: 'done', text: 'Done, $30/day verified' } });
  assert.match(result.output, /^Outcome shown on card 1, "Campaign A"\./);
  const read = await state.executeUiSurface!({ kind: 'get_surface', id: set.id });
  const stored = read.kind === 'surface' ? read.surface! : undefined;
  assert.equal(stored?.cardSettlements?.[0]?.outcome?.text, 'Done, $30/day verified');
  assert.equal(stored?.cardSettlements?.[0]?.outcome?.tone, 'done');
  assert.equal(redrawn.length, 1);
  assert.equal(redrawn[0]!.cardSettlements?.[0]?.outcome?.text, 'Done, $30/day verified');
  assert.deepEqual(requestButtons(cardsIn(renderCardSet(redrawn[0]!).blocks, set.id)[0]!), []);

  await tool().run({ data: { cards: ref, card: '2', tone: 'failed', text: 'The budget changed since' } });
  assert.equal(redrawn.at(-1)!.cardSettlements?.[1]?.outcome?.tone, 'failed');
  // A later outcome on the same card replaces the earlier one.
  await tool().run({ data: { cards: ref, card: '2', tone: 'done', text: 'Raised after all' } });
  assert.equal(redrawn.at(-1)!.cardSettlements?.[1]?.outcome?.text, 'Raised after all');
}));

test('update_card refuses another Agent, another thread, an expired set, an unknown card and a non-card surface', async () => withOutcomeTool(async ({ state, ref, redrawn, tool }) => {
  const outcome = { tone: 'done' as const, text: 'Done' };
  await assert.rejects(tool({ ...SCOPE, agentId: 'agent_b' }).run({ data: { cards: ref, card: '1', ...outcome } }), /No card set "cards [a-f0-9]{8}" that you posted in this conversation/);
  await assert.rejects(tool({ ...SCOPE, threadTs: '9.000001' }).run({ data: { cards: ref, card: '1', ...outcome } }), /that you posted in this conversation/);
  await assert.rejects(tool().run({ data: { cards: ref, card: 'Campaign Z', ...outcome } }), /No card "Campaign Z" in cards [a-f0-9]{8}\. Name it by its exact title or its number, 1 to 3\./);
  await assert.rejects(tool().run({ data: { cards: ref, card: '4', ...outcome } }), /No card "4"/);
  await assert.rejects(tool().run({ data: { cards: 'the budget cards', card: '1', ...outcome } }), /like "cards 1a2b3c4d"/);

  const expired = cardSet({
    id: displaySurfaceId('job-old', 0), turnJobId: 'job-old',
    createdAt: Date.now() - WEEK - 2, updatedAt: Date.now() - WEEK - 2, expiresAt: Date.now() - 1,
  });
  await state.executeUiSurface!({ kind: 'put_surface', record: expired });
  await assert.rejects(tool().run({ data: { cards: expired.id.slice(0, 8), card: '1', ...outcome } }), /has expired/);

  const unposted = cardSet({ id: displaySurfaceId('job-now', 0), turnJobId: 'job-now', status: 'pending_delivery', createdAt: Date.now() });
  delete (unposted as Partial<UiSurfaceRecord>).messageTs;
  await state.executeUiSurface!({ kind: 'put_surface', record: unposted });
  await assert.rejects(tool().run({ data: { cards: unposted.id.slice(0, 8), card: '1', ...outcome } }), /not posted yet/);

  const question: UiSurfaceRecord = {
    ...cardSet(), id: uiSurfaceId('job-q', 'interactive'), turnJobId: 'job-q',
    spec: { kind: 'question', question: { question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], answerFrom: 'requester' } },
    createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + WEEK,
  };
  await state.executeUiSurface!({ kind: 'put_surface', record: question });
  await assert.rejects(tool().run({ data: { cards: question.id.slice(0, 8), card: '1', ...outcome } }), /is not a card set/);
  assert.equal(redrawn.length, 0);
}));

test('a card redraw that fails never fails update_card: the outcome is kept and the model is told', async () => withOutcomeTool(async ({ state, set, ref, tool }) => {
  const failing = tool(SCOPE, async () => { throw new Error('chat.update failed'); });
  const result = await failing.run({ data: { cards: ref, card: 'Campaign A', tone: 'info', text: 'Waiting on finance' } });
  assert.match(result.output, /could not be redrawn just now/);
  const read = await state.executeUiSurface!({ kind: 'get_surface', id: set.id });
  assert.equal(read.kind === 'surface' && read.surface?.cardSettlements?.[0]?.outcome?.text, 'Waiting on finance');
  const skipped = await tool(SCOPE, async () => false).run({ data: { cards: ref, card: 'Campaign A', tone: 'done', text: 'Done' } });
  assert.match(skipped.output, /could not be redrawn just now/);
}));

test('present_cards names its set, so a typed request can be answered with update_card', () => {
  const tools = createDisplayTools(() => undefined, { turnJobId: 'job1' });
  const chart = { title: 'Spend', type: 'bar' as const, categories: ['A'], series: [{ name: 's', values: [1] }] };
  tools.chart.run({ data: chart, toolCallId: 'c1' });
  const output = tools.cards.run({ data: { cards: [{ title: 'Campaign A', actions: [{ label: 'Approve' }] }] }, toolCallId: 'c2' }).output;
  assert.match(output, new RegExp(`cards ${displaySurfaceId('job1', 1).slice(0, 8)}`));
  const unscoped = createDisplayTools(() => undefined);
  assert.doesNotMatch(unscoped.cards.run({ data: { cards: [{ title: 'Ada' }] }, toolCallId: 'c1' }).output, /cards [a-f0-9]{8}/);
});
