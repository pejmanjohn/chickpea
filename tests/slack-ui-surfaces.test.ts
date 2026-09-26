import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openStateDb } from '../src/state/node-state-db.ts';
import { parseGatewayFrameText } from '../src/slack/gateway/protocol.ts';
import { checkSlackBlocks } from '../src/slack/ui/block-kit-limits.ts';
import {
  microsecondSlackTs,
  normalizeSlackUiState,
  parseSlackUiBlockAction,
} from '../src/slack/ui/interaction-payload.ts';
import { renderUiSurface, uiResponseTurnText } from '../src/slack/ui/render.ts';
import {
  parseUiControl,
  uiActionId,
  uiBlockId,
  uiSurfaceId,
  uiValue,
  type UiSurfaceRecord,
} from '../src/slack/ui/surface.ts';
import { UiSurfaceStoreLogic } from '../src/slack/ui/surface-store.ts';

const NOW = Date.UTC(2026, 8, 26, 14, 0);

function record(patch: Partial<UiSurfaceRecord> = {}): UiSurfaceRecord {
  return {
    id: uiSurfaceId('msg:C1:1.000001', 'host-approval:browser_step'),
    namespace: 'host',
    workspaceId: 'T1', channelId: 'C1', threadTs: '1.000001', conversationThreadTs: '1.000001',
    conversationKind: 'channel', agentId: 'agent_a', turnJobId: 'msg:C1:1.000001', requesterUserId: 'U1',
    spec: { kind: 'approval', approval: 'browser_step', browserActionId: 'a'.repeat(32), description: 'click "Save"', host: 'example.com' },
    status: 'open', createdAt: NOW, updatedAt: NOW, expiresAt: NOW + 60_000,
    ...patch,
  };
}

// ── ids ───────────────────────────────────────────────────────────────────

test('surface ids are stable per turn and slot, and controls parse only structurally', () => {
  const id = uiSurfaceId('msg:C1:1.000001', 'slot');
  assert.equal(id, uiSurfaceId('msg:C1:1.000001', 'slot'));
  assert.notEqual(id, uiSurfaceId('msg:C1:1.000001', 'other'));
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.deepEqual(parseUiControl({
    actionId: uiActionId('host', 'approval', 1), blockId: uiBlockId('host', id, 1), value: uiValue(id, 1),
  }), { namespace: 'host', kind: 'approval', surfaceId: id, valueIndex: 1 });
  const other = uiSurfaceId('msg:C1:1.000001', 'x');
  for (const input of [
    { actionId: uiActionId('ui', 'approval', 0), blockId: uiBlockId('host', id, 1) },
    { actionId: uiActionId('host', 'approval', 0), blockId: uiBlockId('host', id, 1), value: uiValue(other, 0) },
    { actionId: 'chickpea.host.v1.Approve', blockId: uiBlockId('host', id, 1) },
    { actionId: uiActionId('host', 'approval', 0), blockId: `chickpea.host.v1.${id}.approve` },
    { actionId: uiActionId('host', 'approval', 0), blockId: uiBlockId('host', id, 1), value: 'approve' },
  ]) {
    assert.equal(parseUiControl(input), undefined, JSON.stringify(input));
  }
});

// ── store ─────────────────────────────────────────────────────────────────

test('the surface store is write-once, first-wins, namespace-bound, and supersedes by thread', () => {
  let now = NOW;
  const store = new UiSurfaceStoreLogic(openStateDb(':memory:'), () => now);
  const first = store.put(record({ status: 'pending_delivery' }));
  assert.equal(first.status, 'pending_delivery');
  assert.equal(store.put(record({ status: 'open' })).status, 'pending_delivery', 'replay keeps the stored row');
  assert.equal(store.bindMessage(first.id, '2.000001')?.status, 'open');
  assert.equal(store.bindMessage(first.id, '9.000001')?.messageTs, '2.000001', 'first binding wins');

  assert.equal(store.claim({ surfaceId: first.id, resolution: { byUserId: 'U1', at: now, choice: 0 } }, 'ui').claimed, false);
  const claimed = store.claim({ surfaceId: first.id, resolution: { byUserId: 'U1', at: now, choice: 0 } }, 'host');
  assert.equal(claimed.claimed, true);
  assert.equal(store.claim({ surfaceId: first.id, resolution: { byUserId: 'U2', at: now, choice: 1 } }, 'host').claimed, false);
  assert.equal(store.get(first.id)?.resolution?.byUserId, 'U1');

  const expired = store.put(record({ id: 'b'.repeat(32), expiresAt: NOW - 1 }));
  assert.equal(store.claim({ surfaceId: expired.id, resolution: { byUserId: 'U1', at: now, choice: 0 } }, 'host').claimed, false);

  store.put(record({ id: 'c'.repeat(32), turnJobId: 'older' }));
  store.put(record({ id: 'd'.repeat(32), turnJobId: 'current' }));
  const superseded = store.supersede(
    { workspaceId: 'T1', channelId: 'C1', threadTs: '1.000001', agentId: 'agent_a' },
    { exceptTurnJobId: 'current', kinds: ['approval'] },
  );
  assert.deepEqual(superseded.map((surface) => surface.id).sort(), ['b'.repeat(32), 'c'.repeat(32)]);
  assert.equal(store.get('d'.repeat(32))?.status, 'open');
  now += 1;
  assert.equal(store.get('invalid'), undefined);
  assert.throws(() => store.put(record({ id: 'short' })), /id is invalid/);
});

// ── rendering and the limits checker ──────────────────────────────────────

test('open, answered, typed, and closed cards render from state and pass the checker', () => {
  const open = renderUiSurface(record());
  assert.deepEqual(open.blocks.map((block) => block.type), ['section', 'actions', 'context']);
  assert.match(open.text, /Approve this step: click "Save" on example\.com\?/);
  const cases = [
    open,
    renderUiSurface(record({ status: 'resolved', resolution: { byUserId: 'U2', at: NOW, choice: 0 } })),
    renderUiSurface(record({ status: 'resolved', resolution: { byUserId: 'U2', at: NOW, choice: 1, typed: true } })),
    renderUiSurface(record({ status: 'superseded' })),
    renderUiSurface(record({ status: 'expired' })),
    renderUiSurface(record({ spec: { kind: 'approval', approval: 'workspace_change', proposalId: 'p1' } })),
  ];
  for (const rendered of cases) {
    assert.deepEqual(checkSlackBlocks(rendered.blocks, { text: rendered.text }).issues, []);
  }
  assert.match(JSON.stringify(cases[2]!.blocks), /Stopped by <@U2> \(typed reply\)/);
  assert.ok(cases.slice(1, 5).every((rendered) => !rendered.blocks.some((block) => block.type === 'actions')));
  assert.equal(uiResponseTurnText(record(), 0).includes('Approve step button'), true);
});

/** A small deterministic generator, so the property test is reproducible. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const ADVERSARIAL = ['<!channel>', '<!here>', '<!everyone>', '<!subteam^S1|@team>', '&amp;', '<', '>', '*', '_', '`',
  '```', '‮', '😀', '👩‍👩‍👧', '<@U1>', '<https://evil.example|Approve>', 'Approve', ' ', '\\', '"'];

test('property: seeded adversarial approval cards always pass the Slack limits checker', () => {
  const next = random(20260926);
  for (let run = 0; run < 400; run += 1) {
    const pick = () => ADVERSARIAL[Math.floor(next() * ADVERSARIAL.length)]!;
    const length = Math.floor(next() * 400);
    let description = '';
    while (description.length < length) description += pick();
    let host = '';
    while (host.length < Math.floor(next() * 300)) host += pick();
    const statuses = ['open', 'resolved', 'superseded', 'expired', 'failed'] as const;
    const status = statuses[Math.floor(next() * statuses.length)]!;
    const rendered = renderUiSurface(record({
      spec: next() < 0.5
        ? { kind: 'approval', approval: 'browser_step', browserActionId: 'a'.repeat(32), description: description || 'x', host: host || 'h' }
        : { kind: 'approval', approval: 'workspace_change', proposalId: 'p' },
      status,
      ...(status === 'resolved' ? { resolution: { byUserId: 'U9', at: NOW, choice: Math.floor(next() * 2) } } : {}),
    }));
    const check = checkSlackBlocks(rendered.blocks, { text: rendered.text });
    assert.deepEqual(check.issues, [], `run ${run}`);
    assert.doesNotMatch(JSON.stringify(rendered.blocks), /<!(?:channel|here|everyone|subteam)/);
  }
});

test('the checker names malformed payloads instead of throwing', () => {
  const id = 'a'.repeat(32);
  const button = (patch: Record<string, unknown>) => ({
    type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Go' }, action_id: uiActionId('ui', 'actions', 0), value: uiValue(id, 0), ...patch }],
  });
  const expectations: Array<[unknown[], RegExp]> = [
    [Array.from({ length: 51 }, () => ({ type: 'divider' })), /51 blocks exceed/],
    [[button({ value: 'Approve the proposal' })], /not a structural host value/],
    [[button({ action_id: 'chickpea.ui.v1.Approve' })], /not a structural host action id/],
    [[button({ text: { type: 'mrkdwn', text: 'Go' } })], /must be plain_text/],
    [[button({ text: { type: 'plain_text', text: 'x'.repeat(76) } })], /limit is 75/],
    [[button({ url: 'http://example.com', value: undefined })], /https link/],
    [[{ type: 'section', text: { type: 'mrkdwn', text: 'hi <!here>' } }], /broadcast mention/],
    [[{ type: 'section', text: { type: 'mrkdwn', text: 'x'.repeat(3001) } }], /limit is 3000/],
    [[{ type: 'actions', elements: [
      { type: 'button', text: { type: 'plain_text', text: 'A' }, action_id: uiActionId('ui', 'actions', 0), value: uiValue(id, 0) },
      { type: 'button', text: { type: 'plain_text', text: 'B' }, action_id: uiActionId('ui', 'actions', 0), value: uiValue(id, 1) },
    ] }], /duplicates action_id/],
    [[{ type: 'actions', elements: [{ type: 'overflow', action_id: uiActionId('ui', 'actions', 0), options: [] }] }], /overflow menus are excluded/],
    [[{ type: 'input', label: { type: 'plain_text', text: 'Email' }, element: { type: 'email_text_input', action_id: uiActionId('ui', 'form', 0) } }], /modal-only/],
    [[{ type: 'bogus' }], /unsupported block type/],
    [[{ type: 'data_visualization', chart: { title: 't', chart_type: 'pie', labels: ['a', 'b'], series: [{ name: 's', values: [1, 0] }] } }], /pie values must be greater than 0/],
    [[{ type: 'data_visualization' }, { type: 'data_visualization' }, { type: 'data_visualization' }], /3 charts exceed/],
    [[{ type: 'carousel', elements: Array.from({ length: 11 }, () => ({ type: 'card', title: { type: 'mrkdwn', text: 'x' } })) }], /1–10 cards/],
    [[{ type: 'container', elements: [{ type: 'markdown', text: 'x' }] }], /cannot be a markdown block/],
  ];
  for (const [blocks, pattern] of expectations) {
    const check = checkSlackBlocks(blocks);
    assert.equal(check.ok, false);
    assert.ok(check.issues.some((issue) => pattern.test(issue)), `${pattern}: ${check.issues.join('; ')}`);
  }
  assert.deepEqual(checkSlackBlocks('nope' as unknown as unknown[]).issues, ['blocks must be an array']);
  assert.match(checkSlackBlocks([], { text: '<!channel> ping' }).issues[0]!, /broadcast/);
});

// ── ingress parsing ───────────────────────────────────────────────────────

function blockActions(patch: Record<string, unknown> = {}, action: Record<string, unknown> = {}) {
  const id = 'a'.repeat(32);
  return {
    type: 'block_actions',
    team: { id: 'T1' }, user: { id: 'U1' }, api_app_id: 'A1', trigger_id: '123.456.abc',
    container: { type: 'message', channel_id: 'C1', message_ts: '1.000002', is_ephemeral: false },
    channel: { id: 'C1' }, message: { ts: '1.000002', thread_ts: '1.000001' },
    state: { values: {
      [uiBlockId('ui', id, 0)]: { [uiActionId('ui', 'question', 0)]: { type: 'static_select', selected_option: { value: uiValue(id, 2) } } },
      other_block: { x: { type: 'plain_text_input', value: 'secret' } },
    } },
    actions: [{
      type: 'button', action_id: uiActionId('host', 'approval', 0), block_id: uiBlockId('host', id, 1),
      value: uiValue(id, 0), action_ts: '1700000000.12345', ...action,
    }],
    ...patch,
  };
}

test('direct block_actions parse only host-namespace controls, with bounded state', () => {
  const parsed = parseSlackUiBlockAction(blockActions());
  assert.ok(parsed);
  assert.equal(parsed.threadTs, '1.000001');
  assert.equal(parsed.messageTs, '1.000002');
  assert.deepEqual(Object.keys(parsed.state), [uiBlockId('ui', 'a'.repeat(32), 0)], 'non-host blocks are dropped');
  assert.deepEqual(Object.values(parsed.state)[0], { [uiActionId('ui', 'question', 0)]: { type: 'static_select', selected: [uiValue('a'.repeat(32), 2)] } });
  for (const payload of [
    blockActions({}, { action_id: 'chickpea.agent.start' }),
    blockActions({}, { action_id: 'chickpea.private_channel_setup.v1.add' }),
    blockActions({ actions: [] }),
    blockActions({}, { action_ts: 'yesterday' }),
    blockActions({ trigger_id: undefined }),
    blockActions({}, { value: 'x'.repeat(2_001) }),
    blockActions({ type: 'view_submission' }),
  ]) {
    assert.equal(parseSlackUiBlockAction(payload), undefined);
  }
  const selects = parseSlackUiBlockAction(blockActions({}, {
    type: 'multi_users_select', value: undefined, selected_users: ['U2', 'U3'],
  }));
  assert.deepEqual(selects?.selected, ['U2', 'U3']);
  assert.equal(normalizeSlackUiState({ values: { 'chickpea.x': { a: { type: 'x', selected_users: Array(101).fill('U') } } } }), undefined);
  assert.equal(microsecondSlackTs('1700000000.12345'), '1700000000.123450');
  assert.equal(microsecondSlackTs('1700000000.1234567'), '1700000000.123456');
  assert.equal(microsecondSlackTs('nope'), undefined);
});

test('gateway ui_action frames keep normalized selections and refuse unknown or non-host shapes', () => {
  const id = 'a'.repeat(32);
  const frame = {
    protocolVersion: 1, kind: 'interaction.ui_action', deliveryId: 'ui:abc', bindingId: 'binding1',
    workspaceId: 'T1', userId: 'U1', containerType: 'message', channelId: 'C1', messageTs: '1.000002',
    threadTs: '1.000001', isEphemeral: false, viewId: null, actionId: uiActionId('ui', 'question', 0),
    blockId: uiBlockId('ui', id, 0), actionType: 'multi_static_select', value: null,
    selected: [uiValue(id, 1), uiValue(id, 2)],
    state: { [uiBlockId('ui', id, 0)]: { [uiActionId('ui', 'question', 0)]: { type: 'multi_static_select', selected: [uiValue(id, 1)] } } },
    actionTs: '1.000003', triggerId: 't1',
  };
  const parsed = parseGatewayFrameText(JSON.stringify(frame));
  assert.equal(parsed.kind, 'interaction.ui_action');
  assert.deepEqual((parsed as { state: unknown }).state, frame.state);
  assert.deepEqual((parsed as { selected: unknown }).selected, frame.selected);
  for (const bad of [
    { ...frame, raw: {} },
    { ...frame, actionId: 'chickpea.agent.start' },
    { ...frame, actionTs: 'soon' },
    { ...frame, selected: Array(101).fill('x') },
    { ...frame, state: { other: {} } },
    { ...frame, containerType: 'modal' },
  ]) {
    assert.throws(() => parseGatewayFrameText(JSON.stringify(bad)), /protocol error/);
  }
  const submission = parseGatewayFrameText(JSON.stringify({
    protocolVersion: 1, kind: 'interaction.view_submission', deliveryId: 'view:abc', bindingId: 'binding1',
    workspaceId: 'T1', userId: 'U1', viewId: 'V1', callbackId: 'chickpea.ui.v1.form', privateMetadata: '',
    state: { field_block: { a: { type: 'plain_text_input', value: 'hello' } } }, triggerId: null,
  }));
  assert.equal(submission.kind, 'interaction.view_submission');
});
