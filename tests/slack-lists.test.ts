import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebClient } from '@slack/web-api';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import * as v from 'valibot';
import { SettingsStoreLogic, SqliteSettingsStore } from '../src/config/settings-store.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { TurnJobStoreLogic, TURN_JOB_TTL_MS } from '../src/slack/turn-jobs.ts';
import { missingRequiredSlackBotScopes, unexpectedSlackBotScopes, REQUESTED_SLACK_BOT_SCOPES, REQUIRED_SLACK_BOT_SCOPES } from '../src/slack/scopes.ts';
import { SlackListsService, createSlackListsCall } from '../src/slack/lists/service.ts';
import { ListWriteLedger } from '../src/slack/lists/writes.ts';
import { richTextContent, textCell } from '../src/slack/lists/schema.ts';
import { parseSlackListUrl } from '../src/slack/lists/urls.ts';
import { SLACK_LIST_OPERATIONS, type JsonObject } from '../src/slack/lists/types.ts';
import { assertSlackListsAccess, createSlackListTools } from '../src/slack/lists/tools.ts';
import type { SlackManagementSignal } from '../src/management/slack-tools.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';
import { createGatewaySlackWebClient } from '../src/slack/gateway/web-client.ts';
import { LIST_URL, StrictListsFake, TASK_COLUMNS } from './helpers/slack-lists.ts';

function fixture(t: { after(fn: () => void): void }) {
  const store = new SqliteSettingsStore(':memory:');
  t.after(() => store.close());
  const fake = new StrictListsFake();
  const ledger = new ListWriteLedger(store, 'TWORK', 'turn-one');
  const service = (turn = 'turn-one') => new SlackListsService({ workspaceId: 'TWORK', call: fake.call, ledger: turn === 'turn-one' ? ledger : new ListWriteLedger(store, 'TWORK', turn), timezone: 'America/Los_Angeles' });
  return { store, fake, ledger, service };
}
function task(fake: StrictListsFake) { return fake.lists.get('FEXISTING')!.items[0]!; }
function field(fake: StrictListsFake, id: string) { return task(fake).fields.find(f => f.column_id === id); }
function isWrite(method: string) { return !method.endsWith('.list') && !method.endsWith('.info'); }

test('current actor and Agent authority is rechecked before resolving a Lists transport', async () => {
  const f = await createManagementAdapterFixture('lists-authority');
  try {
    const agent = await f.config.createAgent({ id: 'agent_lists', name: 'Lists', instructions: 'Help', enabled: true, kind: 'user', skills: [], mcpServers: [], apiConnections: [], repositories: [] });
    const plan = { agentId: agent.id, actorMembershipId: f.admin.membership.id };
    const signal: SlackManagementSignal = { agentId: agent.id, workspaceId: f.admin.binding.slackTeamId, channelId: 'CLISTS', threadTs: '1800000000.000001', messageTs: '1800000000.000001', eventId: 'ELISTS', turnJobId: 'turn_lists', slackUserId: f.admin.binding.slackUserId, conversationKind: 'channel' };
    await assert.rejects(assertSlackListsAccess(plan, signal, f.config, f.identity), /access to this channel/);
    await f.config.putAgentChannelGrant({ workspaceId: signal.workspaceId, channelId: signal.channelId, agentId: agent.id, status: 'active', createdByMembershipId: f.admin.membership.id, channelLabel: 'lists' }, 0);
    await assertSlackListsAccess(plan, signal, f.config, f.identity);
    await assert.rejects(assertSlackListsAccess({ ...plan, actorMembershipId: f.owner.membership.id }, signal, f.config, f.identity), /active Chickpea access/);
    const noGrant = { getAgent: f.config.getAgent.bind(f.config), listAgentChannelGrants: async () => [] };
    await assertSlackListsAccess(plan, { ...signal, conversationKind: 'im' }, noGrant, f.identity);
    await assert.rejects(assertSlackListsAccess(plan, { ...signal, conversationKind: 'mpim' }, noGrant, f.identity), /access to this channel/);
    await assert.rejects(assertSlackListsAccess(plan, signal, { ...noGrant, getAgent: async () => ({ ...agent, enabled: false }) }, f.identity), /no longer available/);
    await f.identity.setMembershipAccessOverlay({ membershipId: f.admin.membership.id, organizationId: f.admin.membership.organizationId, accessStatus: 'suspended' });
    await assert.rejects(assertSlackListsAccess(plan, signal, f.config, f.identity), /active Chickpea access/);
  } finally { f.close(); }
});

test('additive Lists scopes preserve core-only chat health and reject unknown grants', () => {
  assert.deepEqual(missingRequiredSlackBotScopes(REQUIRED_SLACK_BOT_SCOPES), []);
  assert.deepEqual(missingRequiredSlackBotScopes(REQUESTED_SLACK_BOT_SCOPES), []);
  assert.deepEqual(unexpectedSlackBotScopes(REQUESTED_SLACK_BOT_SCOPES), []);
  assert.deepEqual(unexpectedSlackBotScopes([...REQUESTED_SLACK_BOT_SCOPES, 'admin:write']), ['admin:write']);
  assert.equal(missingRequiredSlackBotScopes(undefined), undefined);
  assert.ok(REQUESTED_SLACK_BOT_SCOPES.includes('lists:write'));
  assert.ok(!REQUIRED_SLACK_BOT_SCOPES.includes('lists:write'));
});

test('write reservations serialize concurrent calls and fail closed on corrupt or future receipts', async t => {
  const f = fixture(t);
  const reservations = await Promise.all(Array.from({ length: 4 }, (_, i) => f.ledger.reserve(`race-${i}`, 'slackLists.create', { name: `List ${i}` })));
  assert.equal(reservations.filter(r => r.reserved).length, 1);
  for (const raw of ['bad JSON', JSON.stringify({ schemaVersion: 2, workspaceId: 'TWORK', entries: [] })]) {
    await f.store.setSetting(f.ledger.key, raw);
    await assert.rejects(f.ledger.reserve('next', 'slackLists.create', { name: 'Next' }), /unreadable/);
  }
});

test('concurrent tool writes queue through confirmation, while an uncertain first write blocks its sibling', async t => {
  for (const uncertain of [false, true]) {
    const f = fixture(t);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.fake.before = async method => {
      if (method === 'slackLists.items.create') { entered.resolve(); await release.promise; }
    };
    if (uncertain) f.fake.after = (method, response) => { if (method === 'slackLists.items.create') throw new Error('lost response'); return response; };
    const tool = createSlackListTools(async () => f.service()).find(tool => tool.name === 'create_slack_list_item')!;
    const run = tool.run as (context: { toolCallId: string; data: { listUrl: string; title: string }; log: { info(): void; warn(): void; error(): void } }) => Promise<string>;
    const invoke = (title: string) => run({ toolCallId: title, data: { listUrl: LIST_URL, title }, log: { info() {}, warn() {}, error() {} } });
    const first = invoke('First report');
    await entered.promise;
    const second = invoke('Second report');
    await Promise.resolve();
    assert.deepEqual(f.fake.calls.map(call => call.method), ['slackLists.items.list', 'slackLists.items.create']);
    release.resolve();
    assert.deepEqual((await Promise.all([first, second])).map(result => JSON.parse(result).status), uncertain ? ['unverified', 'already_attempted'] : ['confirmed', 'confirmed']);
    assert.equal(f.fake.lists.get('FEXISTING')!.items.length, uncertain ? 1 : 2);
  }
});

test('turn retention purges terminal Lists receipts and retains unresolved turn receipts', () => {
  const db = openStateDb(':memory:');
  let clock = 1_800_000_000_000;
  try {
    const jobs = new TurnJobStoreLogic(db, () => clock);
    const settings = new SettingsStoreLogic(db, () => clock);
    const enqueue = (id: string) => jobs.enqueue({
      id, evtKey: `evt:${id}`, msgKey: `msg:${id}`,
      turn: { workspaceId: 'TWORK', channelId: 'DWORK', eventId: `Ev${id}`, text: 'Synthetic task', userId: 'UHUMAN', messageTs: '1800000000.000100', threadTs: '1800000000.000100', source: 'dm_message', contextMode: 'dm_history', channelType: 'im' },
      assignment: { workspaceId: 'TWORK', channelId: 'DWORK', agentId: 'agent_test', agent: { id: 'agent_test', kind: 'user', revision: 1, name: 'Test', instructions: 'Help.', enabled: true, skills: [], mcpServers: [], apiConnections: [], repositories: [] } },
      runId: `run_${id}`,
    });
    for (const id of ['finished', 'unresolved']) {
      enqueue(id);
      settings.setSetting(`slack_lists.writes.v1:${id}`, 'content-free receipt');
    }
    jobs.markDelivered('finished');
    clock += TURN_JOB_TTL_MS + 1;
    enqueue('trigger');
    assert.equal(settings.getSetting('slack_lists.writes.v1:finished'), undefined);
    assert.equal(settings.getSetting('slack_lists.writes.v1:unresolved'), 'content-free receipt');
  } finally { db.close(); }
});

test('creates and verifies a human task with renamed native columns, Unicode, context, source and exact visible time', async t => {
  const f = fixture(t);
  f.fake.before = async method => {
    if (method === 'slackLists.items.create') {
      const persisted = JSON.parse((await f.store.getSetting(f.ledger.key))!);
      assert.equal(persisted.entries[0].status, 'pending', 'reservation must commit before network');
      assert.equal(JSON.stringify(persisted).includes('Client report'), false, 'no task content in ledger');
    }
  };
  const result = await f.service().createItem('call1', LIST_URL, { title: 'Client report — café 🍋', assignees: ['UPEJ'], details: { text: 'Include campaign results.' }, sourceUrls: ['https://example.slack.com/archives/CWORK/p1234567890123456'], due: { date: '2026-09-15', time: '11:00' } });
  assert.equal(result.status, 'confirmed');
  assert.deepEqual(field(f.fake, 'ColASSIGNEE')?.user, ['UPEJ']);
  assert.deepEqual(field(f.fake, 'ColDUE')?.timestamp, [1789495200]);
  const context = richTextContent(field(f.fake, 'ColDETAILS')?.rich_text);
  assert.match(context, /campaign results/);
  assert.match(context, /https:\/\/example.slack.com\/archives/);
  assert.match(context, /Deadline: 2026-09-15 11:00 \(America\/Los_Angeles\)/);
  assert.match(String((result.item as JsonObject).url), /record_id=RecTASK/);
  assert.deepEqual(f.fake.calls.map(c => c.method), ['slackLists.items.list', 'slackLists.items.create', 'slackLists.items.info']);
});

test('creates a private task List with context column and shares only an explicit recipient', async t => {
  const f = fixture(t);
  const created = await f.service().createList('list1', 'Client tasks');
  assert.equal(created.status, 'confirmed');
  assert.equal(f.fake.grants.length, 0);
  const url = String((created.list as JsonObject).url);
  assert.equal((await f.service().shareList('share1', url, 'view', { channelId: 'CWORK' })).status, 'confirmed');
  assert.deepEqual(f.fake.grants, [{ list_id: 'FNEW1', access_level: 'read', channel_ids: ['CWORK'] }]);
  assert.equal((await f.service().shareList('share2', url, 'edit', { userId: 'UPEJ' })).status, 'confirmed');
  await assert.rejects(f.service().shareList('bad', url, 'edit', { channelId: 'CWORK', userId: 'UPEJ' }), /one explicit/);
});

test('missing or ambiguous context columns stop before a write; creating never copies a neighboring task', async t => {
  const f = fixture(t);
  f.fake.lists.get('FEXISTING')!.columns = TASK_COLUMNS.filter(c => c.id !== 'ColDETAILS');
  await assert.rejects(f.service().createItem('missing', LIST_URL, { title: 'Report', details: { text: 'Do not lose this.' } }), /Choose a text column/);
  assert.equal(f.fake.calls.filter(c => isWrite(c.method)).length, 0);
  f.fake.lists.get('FEXISTING')!.columns = [...TASK_COLUMNS, { id: 'ColNOTES', name: 'Other notes', type: 'text', is_primary_column: false }];
  await assert.rejects(f.service().createItem('ambiguous', LIST_URL, { title: 'Report', due: { date: '2026-09-15', time: '11:00' } }), /Choose a text column/);
  assert.equal((await f.service().createItem('explicit', LIST_URL, { title: 'Report', details: { text: 'Private task context', columnId: 'ColNOTES' } })).status, 'confirmed');
  assert.equal((await f.service().createItem('new', LIST_URL, { title: 'Unrelated task' })).status, 'confirmed');
  assert.deepEqual(f.fake.lists.get('FEXISTING')!.items[1]!.fields.map(c => c.column_id), ['ColTITLE']);
});

test('completion, reopening, reassignment and clearing preserve omitted fields and existing rich links', async t => {
  const f = fixture(t);
  await f.service().createItem('create', LIST_URL, { title: 'Client report', assignees: ['UPEJ'], due: { date: '2026-09-15', time: '11:00' }, details: { text: 'Context' } });
  const id = task(f.fake).id;
  const context = field(f.fake, 'ColDETAILS')!;
  (context.rich_text as JsonObject[]).push({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'link', text: 'Source', url: 'https://example.com/report' }] }] });
  assert.equal((await f.service().updateItem('complete', LIST_URL, id, { completed: true })).status, 'confirmed');
  assert.equal(field(f.fake, 'ColDONE')?.checkbox, true);
  assert.equal((await f.service().updateItem('move', LIST_URL, id, { due: { date: '2026-09-16', time: '10:00' }, assignees: ['USOMEONE'] })).status, 'confirmed');
  const details = richTextContent(field(f.fake, 'ColDETAILS')?.rich_text);
  assert.match(details, /Source \(https:\/\/example.com\/report\)/);
  assert.match(details, /2026-09-16 10:00/);
  assert.doesNotMatch(details, /2026-09-15 11:00/);
  assert.equal((await f.service().updateItem('clear', LIST_URL, id, { completed: false }, ['assignees', 'due'])).status, 'confirmed');
  assert.deepEqual(field(f.fake, 'ColASSIGNEE')?.user, []);
  assert.deepEqual(field(f.fake, 'ColDUE')?.date, []);
  assert.deepEqual(field(f.fake, 'ColDUE')?.timestamp, []);
  assert.equal(field(f.fake, 'ColDONE')?.checkbox, false);
  assert.equal(richTextContent(field(f.fake, 'ColTITLE')?.rich_text), 'Client report');
  assert.doesNotMatch(richTextContent(field(f.fake, 'ColDETAILS')?.rich_text), /Deadline:/);
});

test('invalid dates, DST gaps/folds and conflicting clears cause no writes', async t => {
  const f = fixture(t);
  for (const due of [{ date: '2026-02-30' }, { date: '2026-03-08', time: '02:30' }, { date: '2026-11-01', time: '01:30' }]) {
    await assert.rejects(f.service().createItem('date', LIST_URL, { title: 'Report', due }), /deadline|daylight-saving/i);
  }
  assert.equal(f.fake.calls.filter(c => isWrite(c.method)).length, 0);
  await f.service().createItem('ok', LIST_URL, { title: 'Report' });
  await assert.rejects(f.service().updateItem('clear', LIST_URL, task(f.fake).id, { assignees: ['UPEJ'] }, ['assignees']), /both set and cleared/);
});

test('silent partial updates return actual mismatches and prohibit further writes', async t => {
  const f = fixture(t);
  await f.service().createItem('create', LIST_URL, { title: 'Report', assignees: ['UPEJ'] });
  f.fake.ignoreColumn = 'ColASSIGNEE';
  const result = await f.service().updateItem('partial', LIST_URL, task(f.fake).id, { completed: true, assignees: ['UNEW'] });
  assert.equal(result.status, 'unverified');
  assert.deepEqual(result.mismatchedColumns, ['ColASSIGNEE']);
  assert.equal(field(f.fake, 'ColDONE')?.checkbox, true);
  assert.equal((await f.service().createItem('different-call', LIST_URL, { title: 'Different report' })).status, 'already_attempted');
  assert.equal(f.fake.lists.get('FEXISTING')!.items.length, 1);
});

test('lost response after Slack commits cannot duplicate a task, even with a new call ID or changed arguments', async t => {
  const f = fixture(t);
  f.fake.after = (method, response) => { if (method === 'slackLists.items.create') throw new Error('fetch failed with private token and payload'); return response; };
  const result = await f.service().createItem('first', LIST_URL, { title: 'Report' });
  assert.equal(result.status, 'unverified');
  assert.equal(JSON.stringify(result).includes('private token'), false);
  f.fake.after = undefined;
  const restarted = () => new SlackListsService({ workspaceId: 'TWORK', call: f.fake.call, ledger: new ListWriteLedger(f.store, 'TWORK', 'turn-one') });
  assert.equal((await restarted().createItem('new-call', LIST_URL, { title: 'Report' })).status, 'already_attempted');
  assert.equal((await restarted().createItem('rephrased', LIST_URL, { title: 'Client report' })).status, 'already_attempted');
  assert.equal(f.fake.lists.get('FEXISTING')!.items.length, 1);
  assert.equal((await restarted().readList(LIST_URL)).status, 'read');
});

test('pending reservation survives a crash; confirmed input dedupe is canonical and scoped to one request', async t => {
  const f = fixture(t);
  const first = await f.ledger.reserve('old', 'slackLists.items.create', { list_id: 'FEXISTING', initial_fields: [] });
  assert.equal(first.reserved, true);
  const duplicate = await new ListWriteLedger(f.store, 'TWORK', 'turn-one').reserve('new', 'slackLists.items.create', { initial_fields: [], list_id: 'FEXISTING' });
  assert.equal(duplicate.reserved, false);
  await f.ledger.finish(first.receipt, 'confirmed', { listId: 'FEXISTING', itemId: 'RecKNOWN' });
  assert.equal((await f.ledger.reserve('again', 'slackLists.items.create', { initial_fields: [], list_id: 'FEXISTING' })).reserved, false);
  assert.equal((await new ListWriteLedger(f.store, 'TWORK', 'another-turn').reserve('new', 'slackLists.items.create', { initial_fields: [], list_id: 'FEXISTING' })).reserved, true);
  await assert.rejects(new ListWriteLedger(f.store, 'TOTHER', 'turn-one').reserve('other', 'slackLists.create', { name: 'wrong workspace' }), /unreadable/);
});

test('definitive Slack failures never retry automatically and legacy scopes/gateway errors are actionable', async t => {
  const f = fixture(t);
  for (const code of ['list_not_found', 'missing_scope', 'operation_not_allowed', 'ratelimited']) {
    f.fake.failure = code;
    const start = f.fake.calls.length;
    const result = await f.service(`turn-${code}`).createList(code, 'Tasks');
    assert.equal(result.status, 'not_written');
    assert.equal(result.code, code);
    assert.equal(f.fake.calls.length, start + 1);
  }
});

test('documented validation failures permit a corrected write; unknown and internal service failures remain uncertain', async t => {
  const f = fixture(t);
  for (const code of ['invalid_schema', 'name_too_long', 'too_many_users', 'internal_error', 'fatal_error', 'new_service_error']) {
    const writesBefore = f.fake.calls.filter(call => isWrite(call.method)).length;
    f.fake.failure = code;
    const uncertain = ['internal_error', 'fatal_error', 'new_service_error'].includes(code);
    const result = await f.service(code).createList('first', 'Tasks');
    assert.equal(result.status, uncertain ? 'unverified' : 'not_written');
    f.fake.failure = undefined;
    const corrected = await f.service(code).createList('corrected', 'Corrected tasks');
    assert.equal(corrected.status, uncertain ? 'already_attempted' : 'confirmed');
    assert.equal(f.fake.calls.filter(call => isWrite(call.method)).length - writesBefore, uncertain ? 1 : 2);
  }
});

test('production SDK rejections map definite failures and uncertain gateway writes without retry', async t => {
  const f = fixture(t);
  for (const code of ['list_not_found', 'missing_scope', 'ratelimited', 'slack_list_outcome_unknown']) {
    let calls = 0;
    const client = { apiCall: async () => {
      calls++;
      if (code === 'slack_list_outcome_unknown') throw new SlackTransportError('slackLists.create', code, { retryable: false });
      throw Object.assign(new Error('private SDK diagnostic'), code === 'ratelimited' ? { code: 'slack_webapi_rate_limited_error' } : { code: 'slack_webapi_platform_error', data: { ok: false, error: code } });
    } } as Pick<WebClient, 'apiCall'>;
    const service = new SlackListsService({ workspaceId: 'TWORK', call: createSlackListsCall(client), ledger: new ListWriteLedger(f.store, 'TWORK', `sdk-${code}`) });
    const result = await service.createList('call', 'Tasks');
    assert.equal(result.status, code === 'slack_list_outcome_unknown' ? 'unverified' : 'not_written');
    assert.equal(result.code, code);
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(result), /private SDK diagnostic/);
  }
});

test('clearing a selected context column preserves exact deadline notes unless the deadline is also cleared', async t => {
  const f = fixture(t);
  await f.service().createItem('create', LIST_URL, { title: 'Report', details: { text: 'Keep time visible' }, due: { date: '2026-09-15', time: '11:00' } });
  const id = task(f.fake).id;
  await assert.rejects(f.service().updateItem('clear-note', LIST_URL, id, {}, ['details']), /visible deadline time/);
  f.fake.lists.get('FEXISTING')!.columns.push({ id: 'ColOTHER', name: 'Other context', type: 'text', is_primary_column: false });
  const writesBefore = f.fake.calls.filter(call => isWrite(call.method)).length;
  await assert.rejects(f.service().updateItem('move-note', LIST_URL, id, { details: { text: 'New context', columnId: 'ColOTHER' }, due: { date: '2026-09-16', time: '10:00' } }), /deadline note is in another context column/);
  assert.equal(f.fake.calls.filter(call => isWrite(call.method)).length, writesBefore);
  assert.match(richTextContent(field(f.fake, 'ColDETAILS')?.rich_text), /2026-09-15 11:00/);
  assert.equal((await f.service().updateItem('clear-selected', LIST_URL, id, { details: { text: '', columnId: 'ColDETAILS' } }, ['due'])).status, 'confirmed');
  assert.equal(richTextContent(field(f.fake, 'ColDETAILS')?.rich_text), '');
  assert.deepEqual(parseSlackListUrl('https://example.enterprise.slack.com/lists/TWORK/FEXISTING', 'TWORK'), { listId: 'FEXISTING' });
  assert.throws(() => parseSlackListUrl('https://example.enterprise.slack.com.evil.test/lists/TWORK/FEXISTING', 'TWORK'));
});

test('malformed or mismatched readback cannot report success', async t => {
  const f = fixture(t);
  f.fake.after = (method, response) => method === 'slackLists.items.info' ? { ...response, record: { ...(response.record as JsonObject), list_id: 'FOTHER' } } : response;
  assert.equal((await f.service().createItem('bad-parent', LIST_URL, { title: 'Report' })).status, 'unverified');
  const empty = new SlackListsService({ workspaceId: 'TWORK', call: async () => ({ ok: true }), ledger: f.ledger });
  await assert.rejects(empty.readList(LIST_URL), /unexpected Lists response/);
});

test('duplicate deadline notes require manual cleanup, without implying that a column selection can resolve them', async t => {
  const f = fixture(t);
  await f.service().createItem('create', LIST_URL, { title: 'Report', details: { text: 'Context' }, due: { date: '2026-09-15', time: '11:00' } });
  f.fake.lists.get('FEXISTING')!.columns.push({ id: 'ColOTHER', name: 'Other context', type: 'text', is_primary_column: false });
  await f.service().updateItem('copy-note', LIST_URL, task(f.fake).id, { details: { text: richTextContent(field(f.fake, 'ColDETAILS')?.rich_text), columnId: 'ColOTHER' } });
  const writesBefore = f.fake.calls.filter(call => isWrite(call.method)).length;
  for (const clear of [[], ['due']] as const) {
    await assert.rejects(f.service().updateItem('change', LIST_URL, task(f.fake).id, { details: { text: 'Context', columnId: 'ColDETAILS' }, ...(clear.length ? {} : { due: { date: '2026-09-16' } }) }, [...clear]), /Remove the duplicate deadline notes in Slack.*Choosing a context column cannot resolve this/);
  }
  assert.equal(f.fake.calls.filter(call => isWrite(call.method)).length, writesBefore);
});

test('bounded pages return cursors, preserve unsupported fields, and reject output overflow', async t => {
  const f = fixture(t);
  const data = f.fake.lists.get('FEXISTING')!;
  data.columns.push({ id: 'ColCUSTOM', name: 'Custom status', type: 'select', is_primary_column: false });
  data.items = Array.from({ length: 3 }, (_, n) => ({ id: `RecPAGE${n}`, list_id: 'FEXISTING', fields: [textCell('ColTITLE', `Task ${n}`), { column_id: 'ColCUSTOM', value: 'In progress' }] }));
  const page = await f.service().readList(LIST_URL, undefined, 2);
  assert.equal((page.items as unknown[]).length, 2);
  const next = await f.service().readList(LIST_URL, String(page.nextCursor), 2);
  assert.equal((next.items as unknown[]).length, 1);
  assert.equal(next.nextCursor, '');
  await assert.rejects(f.service().readList(LIST_URL, undefined, 51), /page size/);
  data.items[0]!.fields[0] = textCell('ColTITLE', '漢'.repeat(12_000));
  await assert.rejects(f.service().readList(LIST_URL), /too large/);
});

test('native URLs enforce workspace and item identity; gateway supports only the six reviewed Lists methods', async () => {
  assert.deepEqual(parseSlackListUrl(`${LIST_URL}?record_id=RecEXACT`, 'TWORK'), { listId: 'FEXISTING', itemId: 'RecEXACT' });
  assert.deepEqual(parseSlackListUrl('https://app.slack.com/client/TWORK/unified-files/list/FEXISTING', 'TWORK'), { listId: 'FEXISTING' });
  for (const bad of ['http://example.slack.com/lists/TWORK/FEXISTING', 'https://slack.com.evil.test/lists/TWORK/FEXISTING', 'https://example.slack.com/lists/TOTHER/FEXISTING', `${LIST_URL}?record_id=RecONE&record_id=RecTWO`, 'FEXISTING']) assert.throws(() => parseSlackListUrl(bad, 'TWORK'));
  const calls: string[] = [];
  const client = createGatewaySlackWebClient({ workspaceId: 'TWORK', call: async method => { calls.push(method); return { observed: true }; } });
  const call = createSlackListsCall(client);
  for (const method of SLACK_LIST_OPERATIONS) assert.equal((await call(method, {})).observed, true);
  assert.deepEqual(calls, [...SLACK_LIST_OPERATIONS]);
  await assert.rejects(client.apiCall('slackLists.items.delete', {}), /unavailable/);
});

test('six ordinary tool contracts reject authority overrides, arbitrary fields and bulk sharing', () => {
  const tools = createSlackListTools(async () => { throw new Error('must not run'); });
  assert.equal(tools.length, 6);
  for (const tool of tools) assert.notEqual(tool.durable, true);
  const create = tools.find(t => t.name === 'create_slack_list_item')!;
  assert.equal(v.safeParse(create.input!, { listUrl: LIST_URL, title: 'Report', token: 'xoxb-private' }).success, false);
  assert.equal(v.safeParse(create.input!, { listUrl: LIST_URL, title: 'Report', cells: [{ column_id: 'ColEVIL' }] }).success, false);
  const share = tools.find(t => t.name === 'share_slack_list')!;
  assert.equal(v.safeParse(share.input!, { listUrl: LIST_URL, access: 'owner', userId: 'UPEJ' }).success, false);
});
