import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteSlackStateStore } from '../src/slack/claim-store.ts';
import { resultFromAgentReply } from '../src/slack/flue-dispatch.ts';
import { renderSlackReplyPart, renderSlackReplyTable } from '../src/slack/reply-continuations.ts';
import { checkSlackBlocks } from '../src/slack/ui/block-kit-limits.ts';
import {
  createDisplayTools,
  parseDisplayComponents,
  SLACK_DISPLAY_COMPONENTS_DATA_NAME,
  type SlackDisplayComponentPart,
} from '../src/slack/ui/display-tools.ts';
import { prepareDisplaySurfaces, renderDisplayComponents } from '../src/slack/ui/host-surfaces.ts';
import {
  validatePresentCards,
  validatePresentChart,
  validatePresentDetails,
} from '../src/slack/ui/presentation-tools.ts';
import { renderCards, renderChart, renderDetails } from '../src/slack/ui/render-display.ts';
import { uiActionId, uiBlockId, uiValue, type DisplaySurfaceSpec } from '../src/slack/ui/surface.ts';

const SURFACE = 'a'.repeat(32);

test('cards compile to a card or a carousel, with link and request buttons bound to the surface', () => {
  const one = renderCards(validatePresentCards({
    cards: [{ title: 'PR #412: Fix SSO loop', subtitle: 'by dana · 2 approvals', link: 'https://github.com/o/r/pull/412',
      actions: [{ label: 'Review it' }, { label: 'Open CI', url: 'https://ci.example.com/412' }] }],
  }), SURFACE);
  assert.equal(one.blocks.length, 1);
  const card = one.blocks[0]!;
  assert.equal(card.type, 'card');
  assert.equal(card.block_id, uiBlockId('ui', SURFACE, 1));
  assert.deepEqual((card.actions as Array<Record<string, unknown>>).map((button) => [button.action_id, button.value ?? button.url]), [
    [uiActionId('ui', 'link', 0), 'https://github.com/o/r/pull/412'],
    [uiActionId('ui', 'cards', 1), uiValue(SURFACE, 1)],
    [uiActionId('ui', 'link', 2), 'https://ci.example.com/412'],
  ]);
  assert.match(one.fallbackText, /PR #412: Fix SSO loop — by dana/);

  const many = renderCards(validatePresentCards({
    caption: 'Candidates for the analyst role',
    cards: ['Ada', 'Grace', 'Linus'].map((title) => ({ title, body: `${title} <!channel> & co` })),
  }), SURFACE);
  assert.deepEqual(many.blocks.map((block) => block.type), ['section', 'carousel']);
  assert.equal((many.blocks[1]!.elements as unknown[]).length, 3);
  for (const rendered of [one, many]) assert.deepEqual(checkSlackBlocks(rendered.blocks).issues, []);
  assert.doesNotMatch(many.fallbackText, /<!channel>/);
});

test('charts compile to Slack data_visualization shapes, pie and series alike', () => {
  const bar = renderChart(validatePresentChart({
    title: 'Signups by month', type: 'bar', categories: ['Jul', 'Aug', 'Sep'],
    series: [{ name: 'Self-serve', values: [120, 140, 190] }, { name: 'Sales', values: [30, 25, 41] }],
    yLabel: 'Signups',
  }));
  assert.deepEqual(bar.blocks[0], {
    type: 'data_visualization',
    title: 'Signups by month',
    chart: {
      type: 'bar',
      series: [
        { name: 'Self-serve', data: [{ label: 'Jul', value: 120 }, { label: 'Aug', value: 140 }, { label: 'Sep', value: 190 }] },
        { name: 'Sales', data: [{ label: 'Jul', value: 30 }, { label: 'Aug', value: 25 }, { label: 'Sep', value: 41 }] },
      ],
      axis_config: { categories: ['Jul', 'Aug', 'Sep'], y_label: 'Signups' },
    },
  });
  assert.match(bar.fallbackText, /Self-serve: Jul 120, Aug 140, Sep 190/);
  const pie = renderChart(validatePresentChart({
    title: 'Plan mix', type: 'pie', categories: ['Team', 'Business'], series: [{ name: 'Accounts', values: [60, 40] }],
  }));
  assert.deepEqual((pie.blocks[0]!.chart as Record<string, unknown>).segments, [
    { label: 'Team', value: 60 }, { label: 'Business', value: 40 },
  ]);
  for (const rendered of [bar, pie]) assert.deepEqual(checkSlackBlocks(rendered.blocks).issues, []);
  assert.throws(() => validatePresentChart({ title: 'x', type: 'pie', categories: ['a', 'b'], series: [{ name: 's', values: [1, 0] }] }), /greater than 0/);
  assert.throws(() => validatePresentChart({ title: 'x', type: 'line', categories: ['a', 'a'], series: [{ name: 's', values: [1, 2] }] }), /unique/);
});

test('details compile to one collapsed container of escaped mrkdwn sections', () => {
  const markdown = [
    '**Method.** NRR = (start MRR + expansion − contraction − churn) / start MRR.',
    '',
    'Sources: [billing export](https://example.com/export) and <!here> ping attempt.',
    '',
    'x'.repeat(4_500),
  ].join('\n');
  const details = renderDetails(validatePresentDetails({ title: 'How I calculated this', markdown }));
  const container = details.blocks[0]!;
  assert.equal(container.type, 'container');
  assert.equal(container.is_collapsible, true);
  assert.equal(container.default_collapsed, true);
  const children = container.child_blocks as Array<{ text: { text: string } }>;
  assert.ok(children.length >= 2);
  assert.ok(children.every((child) => child.text.text.length <= 3_000));
  assert.match(children[0]!.text.text, /\*Method\.\*/);
  assert.match(children[0]!.text.text, /<https:\/\/example\.com\/export\|billing export>/);
  assert.doesNotMatch(JSON.stringify(children), /<!here>/);
  assert.equal(details.fallbackText, 'Details: How I calculated this');
  assert.deepEqual(checkSlackBlocks(details.blocks).issues, []);
});

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test('property: seeded valid display specs always compile within Slack limits', () => {
  const next = random(4242);
  const pieces = ['<!channel>', '&', '<', '>', '*', '_', '😀', 'Approve', '<@U1>', '|', 'Q3', 'MRR', ' '];
  const word = (max: number) => {
    let out = '';
    while (out.length < 1 + Math.floor(next() * max)) out += pieces[Math.floor(next() * pieces.length)]!;
    return out.slice(0, max).trim() || 'x';
  };
  let compiled = 0;
  for (let run = 0; run < 500; run += 1) {
    let spec: DisplaySurfaceSpec;
    try {
      const pick = next();
      if (pick < 0.4) {
        const count = 1 + Math.floor(next() * 10);
        spec = { kind: 'cards', cards: validatePresentCards({
          ...(next() < 0.5 ? { caption: word(190) } : {}),
          cards: Array.from({ length: count }, (_, index) => ({
            title: `${index} ${word(140)}`,
            ...(next() < 0.5 ? { subtitle: word(150) } : {}),
            ...(next() < 0.5 ? { body: word(200) } : {}),
            ...(next() < 0.3 ? { footnote: word(200) } : {}),
            ...(next() < 0.3 ? { link: `https://example.com/${index}` } : {}),
            ...(next() < 0.3 ? { imageUrl: `https://example.com/${index}.png` } : {}),
            ...(next() < 0.5 ? { actions: [{ label: `Do ${index}` }, ...(next() < 0.5 ? [{ label: 'Open', url: 'https://example.com' }] : [])] } : {}),
          })),
        }) };
      } else if (pick < 0.75) {
        const type = (['bar', 'line', 'area', 'pie'] as const)[Math.floor(next() * 4)]!;
        const categories = Array.from({ length: 1 + Math.floor(next() * 12) }, (_, index) => `c${index}${word(10)}`.slice(0, 20));
        const seriesCount = type === 'pie' ? 1 : 1 + Math.floor(next() * 12);
        spec = { kind: 'chart', chart: validatePresentChart({
          title: word(50), type, categories,
          series: Array.from({ length: seriesCount }, (_, index) => ({
            name: `s${index}${word(10)}`.slice(0, 20),
            values: categories.map(() => type === 'pie' ? 1 + Math.floor(next() * 100) : Math.round((next() - 0.3) * 1000)),
          })),
          ...(next() < 0.5 ? { xLabel: word(50), yLabel: word(50) } : {}),
        }) };
      } else {
        spec = { kind: 'details', details: validatePresentDetails({ title: word(80), markdown: Array.from({ length: 1 + Math.floor(next() * 30) }, () => word(250)).join('\n\n') }) };
      }
    } catch {
      continue;
    }
    compiled += 1;
    const rendered = spec.kind === 'cards' ? renderCards(spec.cards, SURFACE)
      : spec.kind === 'chart' ? renderChart(spec.chart) : renderDetails(spec.details);
    assert.deepEqual(checkSlackBlocks(rendered.blocks).issues, [], `run ${run} ${spec.kind}`);
  }
  assert.ok(compiled > 300, `only ${compiled} compiled`);
});

test('display tools teach, share a two-component budget, and allow cards once', () => {
  const written: SlackDisplayComponentPart[] = [];
  const tools = createDisplayTools((part) => written.push(part));
  assert.throws(() => tools.cards.run({ data: { cards: [] } }), /1–10 cards/);
  const chart = { title: 'Latency', type: 'line' as const, categories: ['Mon', 'Tue'], series: [{ name: 'p95', values: [120, 130] }] };
  assert.match(tools.chart.run({ data: chart }).output, /1 more display component allowed/);
  assert.match(tools.cards.run({ data: { cards: [{ title: 'Ada' }] } }).output, /recorded under your answer\. Don't repeat/);
  assert.throws(() => tools.details.run({ data: { title: 'Sources', markdown: 'x' } }), /already has two display components/);
  assert.equal(written.length, 2);
  const fresh = createDisplayTools(() => undefined);
  fresh.cards.run({ data: { cards: [{ title: 'Ada' }] } });
  assert.throws(() => fresh.cards.run({ data: { cards: [{ title: 'Bo' }] } }), /once per reply/);
});

test('the host re-validates written components, keeps two, and never puts them in the settlement', () => {
  const parts = [
    { kind: 'chart', spec: { title: 'Bad', type: 'pie', categories: ['a'], series: [{ name: 's', values: [0] }] } },
    { kind: 'details', spec: { title: 'Sources', markdown: 'Billing export.' } },
    { kind: 'cards', spec: { cards: [{ title: 'Ada' }] } },
    { kind: 'chart', spec: { title: 'Ok', type: 'bar', categories: ['a'], series: [{ name: 's', values: [1] }] } },
  ];
  assert.deepEqual(parseDisplayComponents(parts).map((component) => component.kind), ['details', 'cards']);
  const result = resultFromAgentReply({
    text: 'Here is the method.', submissionId: 'sub_1', data: { [SLACK_DISPLAY_COMPONENTS_DATA_NAME]: parts },
  } as never, null);
  assert.deepEqual(result.displayComponents?.map((component) => component.kind), ['details', 'cards']);
});

test('display surfaces are stored in call order, replayed from the store, and stale slots close', async () => {
  const state = new SqliteSlackStateStore(':memory:');
  const turn = { workspaceId: 'T1', channelId: 'C1', threadTs: '1.000001', userId: 'U1' };
  const chart: DisplaySurfaceSpec = { kind: 'chart', chart: validatePresentChart({ title: 'A', type: 'bar', categories: ['x'], series: [{ name: 's', values: [1] }] }) };
  const details: DisplaySurfaceSpec = { kind: 'details', details: validatePresentDetails({ title: 'Sources', markdown: 'x' }) };
  const firstAttempt = await prepareDisplaySurfaces({ state, turn, agentId: 'agent_a', turnJobId: 'job1', fresh: [chart, details], now: Date.now() });
  assert.deepEqual(firstAttempt.map((surface) => surface.spec.kind), ['chart', 'details']);
  // A later attempt of the same turn produced only one component.
  const retried = await prepareDisplaySurfaces({ state, turn, agentId: 'agent_a', turnJobId: 'job1', fresh: [details], now: Date.now() + 1_000 });
  assert.deepEqual(retried.map((surface) => surface.spec.kind), ['details']);
  const replay = await prepareDisplaySurfaces({ state, turn, agentId: 'agent_a', turnJobId: 'job1' });
  assert.deepEqual(replay.map((surface) => surface.spec.kind), ['details']);
  const rendered = renderDisplayComponents(replay);
  assert.equal(rendered?.blocks[0]!.type, 'container');
  state.close();
});

test('components ride after the table and before the footer on the reply\'s last message', () => {
  const components = renderDisplayComponents([{
    id: SURFACE, namespace: 'ui', workspaceId: 'T1', channelId: 'C1', threadTs: '1.1', conversationThreadTs: '1.1',
    conversationKind: 'channel', agentId: 'a', turnJobId: 'j', requesterUserId: 'U1', status: 'pending_delivery',
    spec: { kind: 'chart', chart: validatePresentChart({ title: 'Mix', type: 'pie', categories: ['A', 'B'], series: [{ name: 's', values: [1, 2] }] }) },
    createdAt: 1, updatedAt: 1, expiresAt: 2,
  }])!;
  const extras = renderSlackReplyTable({ components }, 'Answer text.');
  assert.deepEqual(extras?.blocks.map((block) => (block as { type: string }).type), ['data_visualization']);
  const part = renderSlackReplyPart('Answer text.', 'markdown', {
    footer: { agentName: 'Ops', agentId: 'agent_ops', modelLabel: 'model' },
    components,
  });
  assert.deepEqual(part.blocks?.map((block) => block.type), ['markdown', 'data_visualization', 'context']);
  assert.match(part.text, /Answer text\.[\s\S]*Mix/);
});
