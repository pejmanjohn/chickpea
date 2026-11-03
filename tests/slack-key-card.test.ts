import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkSlackBlocks } from '../src/slack/ui/block-kit-limits.ts';
import {
  KEY_CHECK_STALE_MS,
  KEY_FIELD_ACTION_ID,
  keyCardTransition,
  keyFieldBlockId,
  keyModalView,
  keyRowTransition,
  parseKeyFormMetadata,
  readKeySubmission,
  renderKeyCard,
  type KeyCardSpec,
  type KeyRow,
  type KeyRowState,
  type KeySetupFacts,
} from '../src/slack/ui/key-card.ts';
import { KEY_FORM_CALLBACK_ID, isKeyFormAction, parseUiControl, uiSurfaceId, type UiSurfaceRecord } from '../src/slack/ui/surface.ts';

const NOW = 1_800_000_000_000;
const CARD_ID = uiSurfaceId('msg:C1:1800000000.000100', 'host-key-card');
const BINDING = 'v2:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

function row(overrides: Partial<KeyRow> = {}): KeyRow {
  return {
    setupOperationId: 'setup_one',
    connectionId: 'connection_one',
    kind: 'api_credential',
    label: 'Linear',
    destinations: ['https://api.linear.app/graphql'],
    state: { is: 'waiting' },
    ...overrides,
  };
}

function card(rows: KeyRow[], overrides: Partial<UiSurfaceRecord> = {}): UiSurfaceRecord & { spec: KeyCardSpec } {
  return {
    id: CARD_ID,
    namespace: 'host',
    workspaceId: 'T1',
    channelId: 'C1',
    threadTs: '1800000000.000100',
    conversationThreadTs: '1800000000.000100',
    conversationKind: 'channel',
    agentId: 'agent_ops',
    turnJobId: 'msg:C1:1800000000.000100',
    requesterUserId: 'U1',
    spec: { kind: 'key_card', agentName: 'Ops', rows },
    status: 'open',
    messageTs: '1800000000.000200',
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + 86_400_000,
    ...overrides,
  } as UiSurfaceRecord & { spec: KeyCardSpec };
}

const LIVE: KeySetupFacts = {
  setup: { status: 'pending', expiresAt: NOW + 60_000, credentialBinding: BINDING },
  target: { binding: BINDING, valuePrefix: 'Bearer ', ownerKind: 'team', destinations: ['https://api.linear.app/graphql'] },
};

function submission(value: string, overrides: Partial<{ userId: string; privateMetadata: string }> = {}) {
  return {
    workspaceId: 'T1',
    userId: overrides.userId ?? 'U1',
    privateMetadata: overrides.privateMetadata ?? `${CARD_ID}|setup_one|${BINDING}`,
    state: { [keyFieldBlockId(CARD_ID)]: { [KEY_FIELD_ACTION_ID]: { type: 'plain_text_input', value } } },
  };
}

test('a row moves only along its state machine', () => {
  const checking: KeyRowState = { is: 'checking', since: NOW };
  const cases: Array<[KeyRowState, Parameters<typeof keyRowTransition>[1], KeyRowState | undefined]> = [
    [{ is: 'waiting' }, { kind: 'check', at: NOW }, checking],
    [{ is: 'rejected' }, { kind: 'check', at: NOW }, checking],
    [checking, { kind: 'check', at: NOW + 1_000 }, undefined],
    [checking, { kind: 'check', at: NOW + KEY_CHECK_STALE_MS }, { is: 'checking', since: NOW + KEY_CHECK_STALE_MS }],
    [checking, { kind: 'saved', check: 'ok' }, { is: 'added' }],
    [checking, { kind: 'saved', check: 'not_permitted' }, { is: 'added_warning', check: 'not_permitted' }],
    [checking, { kind: 'unsaved', because: 'rejected' }, { is: 'rejected' }],
    [checking, { kind: 'unsaved', because: 'changed' }, { is: 'superseded' }],
    [checking, { kind: 'unsaved', because: 'expired' }, { is: 'expired' }],
    [checking, { kind: 'unsaved', because: 'error' }, { is: 'waiting' }],
    [{ is: 'rejected' }, { kind: 'unsaved', because: 'rejected' }, undefined],
    [{ is: 'waiting' }, { kind: 'saved', check: 'ok' }, undefined],
    [{ is: 'waiting' }, { kind: 'expired', at: NOW }, { is: 'expired' }],
    [{ is: 'rejected' }, { kind: 'superseded', at: NOW }, { is: 'superseded' }],
    [checking, { kind: 'expired', at: NOW + 1_000 }, undefined],
    [{ is: 'added' }, { kind: 'check', at: NOW }, undefined],
    [{ is: 'expired' }, { kind: 'superseded', at: NOW }, undefined],
    [{ is: 'superseded' }, { kind: 'saved', check: 'ok' }, undefined],
  ];
  for (const [from, event, to] of cases) {
    assert.deepEqual(keyRowTransition(from, event), to, `${from.is} on ${event.kind}`);
  }
});

test('a card transition changes only the named row', () => {
  const spec = card([row(), row({ setupOperationId: 'setup_two', label: 'Notion' })]).spec;
  const next = keyCardTransition(spec, 'setup_two', { kind: 'check', at: NOW });
  assert.deepEqual(next?.rows.map((candidate) => candidate.state.is), ['waiting', 'checking']);
  assert.equal(keyCardTransition(spec, 'setup_missing', { kind: 'check', at: NOW }), undefined);
});

test('one waiting row renders its button for the requester only, bound to this card', () => {
  const record = card([row()]);
  const rendered = renderKeyCard(record, record.spec);
  assert.equal(checkSlackBlocks(rendered.blocks, { text: rendered.text }).ok, true);
  const text = JSON.stringify(rendered.blocks);
  assert.match(text, /:key: \*Linear\* needs an API key/);
  assert.match(text, /Only <@U1> can add it\./);
  const actions = rendered.blocks.find((block) => block.type === 'actions') as { block_id: string; elements: Array<Record<string, string>> };
  const button = actions.elements[0]!;
  assert.equal((button.text as unknown as { text: string }).text, 'Add key');
  assert.equal(isKeyFormAction(button.action_id!), true);
  assert.deepEqual(parseUiControl({ actionId: button.action_id!, blockId: actions.block_id, value: button.value! }), {
    namespace: 'host', kind: 'key_add', surfaceId: CARD_ID, valueIndex: 0,
  });
});

test('a rejected row offers Try again and a finished card collapses to its lines', () => {
  const rejected = card([row({ state: { is: 'rejected' } })]);
  const shown = JSON.stringify(renderKeyCard(rejected, rejected.spec).blocks);
  assert.match(shown, /:x: api\.linear\.app rejected that key, so it wasn't saved\./);
  assert.match(shown, /"Try again"/);

  const done = card([
    row({ state: { is: 'added' } }),
    row({ setupOperationId: 'setup_two', label: 'Notion', kind: 'mcp_credentials', state: { is: 'expired' } }),
    row({ setupOperationId: 'setup_three', label: 'Sentry', state: { is: 'added_warning', check: 'not_permitted' } }),
  ]);
  const collapsed = renderKeyCard(done, done.spec);
  assert.equal(collapsed.blocks.length, 1);
  assert.equal(checkSlackBlocks(collapsed.blocks, { text: collapsed.text }).ok, true);
  assert.deepEqual((collapsed.blocks[0]!.text as { text: string }).text.split('\n'), [
    ':white_check_mark: <@U1> added the *Linear* key.',
    '*Notion*: This key request expired. Ask Ops for a new one.',
    ':white_check_mark: <@U1> added the *Sentry* key. The service turned down Chickpea\'s check, so the key may be missing a permission.',
  ]);
});

test('several rows each carry their own button and status', () => {
  const record = card([
    row(),
    row({ setupOperationId: 'setup_two', label: 'Notion', kind: 'mcp_credentials', state: { is: 'checking', since: NOW } }),
  ]);
  const rendered = renderKeyCard(record, record.spec);
  assert.equal(checkSlackBlocks(rendered.blocks, { text: rendered.text }).ok, true);
  const text = JSON.stringify(rendered.blocks);
  assert.match(text, /:key: \*2 connections need a key\*/);
  assert.match(text, /\*Notion\*\\nChecking the key with api\.linear\.app…/);
  assert.match(text, /Only <@U1> can add them\./);
  assert.equal((text.match(/chickpea\.host\.v1\.key_add\./g) ?? []).length, 1, 'only the waiting row has a button');
});

test('the form names where the key goes and who it serves, and carries no key', () => {
  const record = card([row()]);
  const view = keyModalView({ card: record, row: record.spec.rows[0]!, target: LIVE.target! });
  assert.equal(view.callback_id, KEY_FORM_CALLBACK_ID);
  assert.deepEqual(parseKeyFormMetadata(view.private_metadata as string), {
    cardId: CARD_ID, setupOperationId: 'setup_one', binding: BINDING,
  });
  const text = JSON.stringify(view);
  for (const expected of [
    '"Add API key"', '"Save key"', '"Cancel"', '*Linear* for Ops', 'Sent only to `https://api.linear.app/graphql`',
    '"Paste the key"', 'Ops uses this key for everyone who asks it.',
    'Only you can see this while you type. It won\'t be posted in Slack, and Ops uses it without ever seeing it.',
  ]) assert.ok(text.includes(expected), expected);

  const personal = keyModalView({
    card: record,
    row: row({ kind: 'mcp_credentials' }),
    target: { ...LIVE.target!, ownerKind: 'member' },
  });
  assert.match(JSON.stringify(personal), /"Add access token".*Ops uses this key only when you ask it\./s);
});

test('a submission keeps the key only when it is one clean value for a live row', () => {
  const record = card([row()]);
  const read = (value: string, overrides: Parameters<typeof submission>[1] = {}, facts = LIVE, at = NOW) =>
    readKeySubmission({ submission: submission(value, overrides), card: record, facts, now: at });
  const error = (reading: ReturnType<typeof read>) => {
    assert.equal(reading.ok, false);
    return reading.ok ? '' : (reading.responseAction.errors as Record<string, string>)[keyFieldBlockId(CARD_ID)];
  };

  const ok = read('  Bearer lin_api_123\n');
  assert.ok(ok.ok);
  assert.equal(ok.key, 'lin_api_123', 'the connection adds Bearer itself');
  assert.equal(error(read('   ')), 'Paste the key.');
  assert.equal(error(read('lin api')), 'Paste only the key. It can\'t contain spaces or line breaks.');
  assert.equal(error(read('lin\napi')), 'Paste only the key. It can\'t contain spaces or line breaks.');
  assert.equal(error(read('k'.repeat(3_001))), 'This key is too long for Slack. Ask Ops for a setup link instead.');
  assert.equal(error(read('lin_api_123', { userId: 'U2' })), 'Only <@U1> can add this key.');
  assert.equal(error(read('lin_api_123', {}, { ...LIVE, setup: { ...LIVE.setup!, status: 'expired' } })),
    'This key request expired. Ask Ops for a new one.');
  assert.equal(error(read('lin_api_123', {}, LIVE, NOW + 60_000)), 'This key request expired. Ask Ops for a new one.');
  assert.equal(error(read('lin_api_123', {}, { ...LIVE, target: { ...LIVE.target!, binding: 'v2:changed' } })),
    'Where this key goes changed after this form opened. Close it and ask Ops for a new one.');
  assert.equal(error(read('lin_api_123', { privateMetadata: `${CARD_ID}|setup_one|v2:older` })),
    'Where this key goes changed after this form opened. Close it and ask Ops for a new one.');
  const unknown = read('lin_api_123', { privateMetadata: 'not-a-card' });
  assert.deepEqual(unknown.ok ? undefined : unknown.responseAction, { response_action: 'clear' });
  assert.equal(error(read('lin_api_123', { privateMetadata: `${'f'.repeat(32)}|setup_one|${BINDING}` })),
    undefined, 'another card id names no field of this form');

  const checking = card([row({ state: { is: 'checking', since: NOW } })]);
  const busy = readKeySubmission({ submission: submission('lin_api_123'), card: checking, facts: LIVE, now: NOW + 1 });
  assert.equal(busy.ok ? undefined : busy.refusal, 'busy');
});
