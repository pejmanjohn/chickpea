import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';

import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { createGatewaySlackWebClient } from '../src/slack/gateway/web-client.ts';
import { CANVAS_NOT_AVAILABLE, createSlackCanvasesCall, SlackCanvasService } from '../src/slack/canvases/service.ts';
import { createSlackCanvasTools, SLACK_CANVAS_TOOL_NAMES } from '../src/slack/canvases/tools.ts';
import { SLACK_CANVAS_OPERATIONS, type JsonObject, type SlackCanvasOperation } from '../src/slack/canvases/types.ts';
import { parseSlackCanvasUrl, verifiedCanvasPermalink } from '../src/slack/canvases/urls.ts';
import { ListWriteLedger } from '../src/slack/lists/writes.ts';
import {
  slackReadConversationFacts,
  type SlackReadAuthorityPorts,
  type SlackReadConversationFacts,
} from '../src/slack/reading/authority.ts';
import { SLACK_READ_MESSAGES } from '../src/slack/reading/errors.ts';

const WORKSPACE = 'TWORK';
const REQUESTER = 'UDANA';
const BOT = 'UCHICKPEA';
const CURRENT = { channelId: 'CCURRENT', threadTs: '1800000000.000100', messageTs: '1800000000.000200' };
const link = (id: string) => `https://acme.slack.com/docs/${WORKSPACE}/${id}`;

interface FakeCanvas { content: string; owner: string; title: string; channels?: string[]; groups?: string[]; linked?: string }

/** Slack as the canvas methods answer it, refusing anything the docs do not allow. */
class FakeCanvasSlack {
  readonly calls: { method: SlackCanvasOperation; input: JsonObject }[] = [];
  readonly canvases = new Map<string, FakeCanvas>();
  readonly failures = new Map<SlackCanvasOperation, { error: string; detail?: string }>();
  sections: string[] = ['temp:C:ONE'];
  private next = 1;

  readonly call = async (method: SlackCanvasOperation, input: JsonObject): Promise<JsonObject> => {
    this.calls.push({ method, input });
    const failure = this.failures.get(method);
    if (failure) return { ok: false, ...failure };
    switch (method) {
      case 'files.info': {
        const canvas = this.canvases.get(String(input.file));
        if (!canvas) return { ok: false, error: 'file_not_found' };
        return { ok: true, file: {
          id: input.file, title: canvas.title, user: canvas.owner, permalink: `${link(String(input.file))}?origin=team`,
          channels: canvas.channels ?? [], groups: canvas.groups ?? [], ims: [],
          ...(canvas.linked ? { linked_channel_id: canvas.linked } : {}),
        } };
      }
      case 'canvases.getContent': {
        const canvas = this.canvases.get(String(input.canvas_id));
        assert.equal(input.content_type, 'markdown');
        return canvas ? { ok: true, content: canvas.content } : { ok: false, error: 'canvas_not_found' };
      }
      case 'canvases.sections.lookup':
        return { ok: true, sections: this.sections.map((id) => ({ id })) };
      case 'conversations.canvases.create':
      case 'canvases.create': {
        const id = `FNEW${this.next++}`;
        const content = input.document_content as { type: string; markdown: string };
        assert.equal(content.type, 'markdown');
        this.canvases.set(id, { content: content.markdown, owner: BOT, title: String(input.title), channels: [String(input.channel_id)] });
        return { ok: true, canvas_id: id };
      }
      case 'canvases.edit':
        return this.canvases.has(String(input.canvas_id)) ? { ok: true } : { ok: false, error: 'canvas_not_found' };
    }
  };

  writes(): string[] {
    return this.calls.filter((call) => !['files.info', 'canvases.getContent', 'canvases.sections.lookup'].includes(call.method)).map((call) => call.method);
  }
}

function facts(overrides: Partial<SlackReadConversationFacts> & { id: string }): SlackReadConversationFacts {
  return { teamId: WORKSPACE, im: false, mpim: false, private: false, member: true, shared: false, ...overrides };
}

function fixture(t: { after(fn: () => void): void }, options: {
  conversations?: Record<string, SlackReadConversationFacts | undefined>;
  members?: Record<string, string[]>;
  grants?: string[];
  managementAgent?: boolean;
  hosted?: boolean;
  turn?: string;
} = {}) {
  const store = new SqliteSettingsStore(':memory:');
  t.after(() => store.close());
  const slack = new FakeCanvasSlack();
  const conversations = options.conversations ?? {
    [CURRENT.channelId]: facts({ id: CURRENT.channelId, canvasId: 'FCHANNEL' }),
    COTHER: facts({ id: 'COTHER', canvasId: 'FOTHER' }),
    GSECRET: facts({ id: 'GSECRET', private: true }),
  };
  const members = options.members ?? { COTHER: [REQUESTER], GSECRET: [] };
  const grants = options.grants ?? ['COTHER', 'GSECRET'];
  const authority: SlackReadAuthorityPorts = {
    workspaceId: WORKSPACE,
    managementAgent: options.managementAgent ?? false,
    requesterSlackUserId: REQUESTER,
    current: CURRENT,
    assertActive: async () => {},
    conversation: async (id) => conversations[id],
    isMember: async (id, user) => (members[id] ?? []).includes(user),
    hasActiveGrant: async (id) => grants.includes(id),
  };
  slack.canvases.set('FCHANNEL', { content: '# Runbook\n\nRestart the worker.\n', owner: 'UHUMAN', title: 'Runbook', linked: CURRENT.channelId });
  slack.canvases.set('FOTHER', { content: '# Deploys\n', owner: 'UHUMAN', title: 'Deploys', linked: 'COTHER' });
  slack.canvases.set('FSECRET', { content: '# Secret plan\n', owner: BOT, title: 'Secret', groups: ['GSECRET'] });
  slack.canvases.set('FREPORT', { content: '# Report\n', owner: BOT, title: 'Report', channels: ['COTHER'] });
  slack.canvases.set('FPEOPLE', { content: '# Notes\n', owner: 'UHUMAN', title: 'Notes', channels: ['COTHER'] });
  slack.canvases.set('FHIDDEN', { content: '# Hidden\n', owner: 'UHUMAN', title: 'Hidden', groups: ['GSECRET'] });
  const ledger = new ListWriteLedger(store, WORKSPACE, options.turn ?? 'turn-one', 'canvas');
  const service = () => new SlackCanvasService({ workspaceId: WORKSPACE, botUserId: BOT, call: slack.call, authority, ledger, hosted: options.hosted });
  return { slack, service, conversations };
}

async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return { code: (error as { code: string }).code, message: (error as Error).message };
  }
  assert.fail('expected a refusal');
}

test('with no target the Agent reads this conversation\'s canvas as Markdown', async (t) => {
  const f = fixture(t);
  const result = await f.service().read({});
  assert.equal(result.status, 'read');
  assert.equal(result.content, '# Runbook\n\nRestart the worker.\n');
  assert.deepEqual(result.canvas, { id: 'FCHANNEL' });
  assert.equal((result.conversation as { current: boolean }).current, true);
  assert.deepEqual(f.slack.calls.map((call) => call.input.canvas_id), ['FCHANNEL'], 'the channel canvas from conversations.info, read once');
});

test('a conversation without a canvas says so and reads nothing', async (t) => {
  const f = fixture(t, { conversations: { [CURRENT.channelId]: facts({ id: CURRENT.channelId }) } });
  assert.equal((await failure(f.service().read({}))).code, 'no_canvas');
  assert.deepEqual(f.slack.calls, []);
});

test('a long canvas comes back in pages that fit the tool limit and join to the whole canvas', async (t) => {
  const f = fixture(t);
  const line = `${'Ünïcödé 漢字 "quoted" text '.repeat(8)}\n`;
  f.slack.canvases.get('FCHANNEL')!.content = line.repeat(600);
  const whole = f.slack.canvases.get('FCHANNEL')!.content;
  let read = '';
  let offset: number | undefined = 0;
  let pages = 0;
  while (offset !== undefined) {
    const page = await f.service().read({ offset });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 32_768, 'every page fits the tool limit');
    assert.equal(page.totalCharacters, whole.length);
    read += String(page.content);
    offset = page.nextOffset as number | undefined;
    pages += 1;
    assert.ok(pages < 50, 'paging makes progress');
  }
  assert.equal(read, whole, 'no content is lost or repeated between pages');
  assert.ok(pages > 2);
  assert.equal((await failure(f.service().read({ offset: whole.length + 10 }))).code, 'invalid_offset');
});

test('another channel\'s canvas follows read_slack_channel\'s authority exactly', async (t) => {
  const f = fixture(t);
  const other = await f.service().read({ channel: '<#COTHER|deploys>' });
  assert.equal(other.content, '# Deploys\n');
  assert.equal((other.conversation as { id: string; current: boolean }).current, false);

  const notMember = fixture(t, { members: { COTHER: [] } });
  assert.equal((await failure(notMember.service().read({ channel: 'COTHER' }))).code, 'not_available');
  const noGrant = fixture(t, { grants: [] });
  assert.equal((await failure(noGrant.service().read({ channel: 'COTHER' }))).code, 'needs_agent_access');
  const noBot = fixture(t, { conversations: {
    [CURRENT.channelId]: facts({ id: CURRENT.channelId }),
    COTHER: facts({ id: 'COTHER', canvasId: 'FOTHER', member: false }),
  } });
  assert.equal((await failure(noBot.service().read({ channel: 'https://acme.slack.com/archives/COTHER' }))).code, 'needs_bot_invite');
  for (const refused of [notMember, noGrant, noBot]) assert.deepEqual(refused.slack.calls, [], 'a refused read never asks Slack for the canvas');
});

test('a canvas link reads only through a conversation the requester and Agent may read', async (t) => {
  const f = fixture(t);
  const viaChannel = await f.service().read({ canvasUrl: `<${link('FREPORT')}|Report>` });
  assert.equal(viaChannel.content, '# Report\n');
  assert.deepEqual(viaChannel.canvas, { id: 'FREPORT', title: 'Report', link: link('FREPORT') });

  const current = await f.service().read({ canvasUrl: link('FCHANNEL') });
  assert.equal((current.conversation as { current: boolean }).current, true);

  const secret = await failure(f.service().read({ canvasUrl: link('FSECRET') }));
  const missing = await failure(f.service().read({ canvasUrl: link('FMISSING') }));
  assert.deepEqual(secret, { code: 'not_available', message: CANVAS_NOT_AVAILABLE });
  assert.deepEqual(missing, secret, 'a canvas in a channel the requester cannot read looks like one that does not exist');
  assert.ok(!f.slack.calls.some((call) => call.method === 'canvases.getContent' && ['FSECRET', 'FMISSING'].includes(String(call.input.canvas_id))));

  const noGrant = fixture(t, { grants: [] });
  assert.deepEqual(await failure(noGrant.service().read({ canvasUrl: link('FREPORT') })),
    { code: 'needs_agent_access', message: SLACK_READ_MESSAGES.needs_agent_access }, 'a member of the canvas\'s channel learns the Agent needs adding there');
});

test('@Chickpea and a conversation shared with another organization read only the current conversation\'s canvas', async (t) => {
  const chickpea = fixture(t, { managementAgent: true });
  assert.equal((await failure(chickpea.service().read({ canvasUrl: link('FREPORT') }))).code, 'current_conversation_only');
  assert.equal((await chickpea.service().read({})).status, 'read');

  const shared = fixture(t, { conversations: {
    [CURRENT.channelId]: facts({ id: CURRENT.channelId, canvasId: 'FCHANNEL', shared: true }),
    COTHER: facts({ id: 'COTHER', canvasId: 'FOTHER' }),
  } });
  const refusal = await failure(shared.service().read({ canvasUrl: link('FREPORT') }));
  assert.deepEqual(refusal, { code: 'shared_conversation_only', message: SLACK_READ_MESSAGES.shared_conversation_only });
  assert.equal((await failure(shared.service().read({ channel: 'COTHER' }))).code, 'shared_conversation_only');
  assert.equal((await shared.service().read({})).content, '# Runbook\n\nRestart the worker.\n');
});

test('canvas links name a canvas in this workspace only', () => {
  assert.equal(parseSlackCanvasUrl('https://acme.slack.com/docs/TWORK/F0ABC123', WORKSPACE), 'F0ABC123');
  assert.equal(parseSlackCanvasUrl('<https://acme.enterprise.slack.com/docs/TWORK/F0ABC123/|plan>', WORKSPACE), 'F0ABC123');
  assert.throws(() => parseSlackCanvasUrl('https://acme.slack.com/docs/TOTHER/F0ABC123', WORKSPACE), /this Slack workspace/);
  for (const bad of ['http://acme.slack.com/docs/TWORK/F0ABC123', 'https://slack.com.evil.test/docs/TWORK/F0ABC123',
    'https://acme.slack.com/archives/C0ABC123', 'https://acme.slack.com/docs/TWORK/C0ABC123', 'F0ABC123']) {
    assert.throws(() => parseSlackCanvasUrl(bad, WORKSPACE), /canvas link/, bad);
  }
  assert.equal(verifiedCanvasPermalink(`${link('F0ABC123')}?x=1#h`, WORKSPACE, 'F0ABC123'), link('F0ABC123'));
  assert.equal(verifiedCanvasPermalink(link('F0OTHER'), WORKSPACE, 'F0ABC123'), undefined);
});

test('conversations.info gives a channel its canvas; malformed values give none', () => {
  assert.equal(slackReadConversationFacts({ id: 'C1', properties: { canvas: { file_id: 'F0CANVAS', is_empty: false } } })?.canvasId, 'F0CANVAS');
  for (const properties of [undefined, {}, { canvas: null }, { canvas: { file_id: 'C0NOTAFILE' } }, { canvas: { file_id: 7 } }]) {
    assert.equal(slackReadConversationFacts({ id: 'C1', properties })?.canvasId, undefined);
  }
});

test('creating in a channel without a canvas makes the channel canvas and returns its link', async (t) => {
  const f = fixture(t, { conversations: { [CURRENT.channelId]: facts({ id: CURRENT.channelId }) } });
  const result = await f.service().create('call-1', 'Q3 report', '# Q3\n\nRevenue grew.');
  assert.deepEqual(result, {
    status: 'created',
    canvas: { id: 'FNEW1', title: 'Q3 report', link: link('FNEW1') },
    placement: 'channel_canvas',
    message: 'Created this channel\'s canvas. People in the channel can view and edit it.',
  });
  assert.deepEqual(f.slack.calls[0], { method: 'conversations.canvases.create', input: {
    channel_id: CURRENT.channelId, title: 'Q3 report', document_content: { type: 'markdown', markdown: '# Q3\n\nRevenue grew.' },
  } });
});

test('a channel that has a canvas gets a new canvas added to it, also when Slack reports the canvas first', async (t) => {
  const f = fixture(t);
  const result = await f.service().create('call-1', 'Brief', '# Brief');
  assert.equal(result.placement, 'channel_tab');
  assert.deepEqual(f.slack.writes(), ['canvases.create']);
  assert.equal(f.slack.calls[0]!.input.channel_id, CURRENT.channelId, 'channel_id gives the channel access in the same call');

  const stale = fixture(t, { conversations: { [CURRENT.channelId]: facts({ id: CURRENT.channelId }) } });
  stale.slack.failures.set('conversations.canvases.create', { error: 'channel_canvas_already_exists' });
  const fallback = await stale.service().create('call-1', 'Plan', '# Plan');
  assert.equal(fallback.status, 'created');
  assert.equal(fallback.placement, 'channel_tab');
  assert.deepEqual(stale.slack.writes(), ['conversations.canvases.create', 'canvases.create']);
});

test('free-plan limits come back as a clear message and nothing is created', async (t) => {
  for (const error of ['free_team_canvas_tab_already_exists', 'free_teams_cannot_create_standalone_canvases']) {
    const f = fixture(t);
    f.slack.failures.set('canvases.create', { error });
    const result = await f.service().create('call-1', 'Brief', '# Brief');
    assert.deepEqual(result, {
      status: 'not_written',
      code: error,
      message: 'On this Slack workspace\'s free plan, a channel can have only one canvas, and this channel already has one. Nothing was created. Offer to add to the channel\'s canvas instead.',
    });
    f.slack.failures.clear();
    assert.equal((await f.service().create('call-2', 'Brief', '# Brief')).status, 'created', 'a refused write does not block the next one');
  }
  const editing = fixture(t);
  editing.slack.failures.set('canvases.edit', { error: 'free_teams_cannot_edit_standalone_canvases' });
  const result = await editing.service().update('call-1', { canvasUrl: link('FREPORT'), operation: 'append', markdown: 'More' });
  assert.equal(result.status, 'not_written');
  assert.match(String(result.message), /free plan, only a channel's own canvas can be edited/);
});

test('a canvas is created only in a channel', async (t) => {
  for (const kind of [{ im: true }, { mpim: true }]) {
    const f = fixture(t, { conversations: { [CURRENT.channelId]: facts({ id: CURRENT.channelId, ...kind }) } });
    assert.equal((await failure(f.service().create('call-1', 'Notes', '# Notes'))).code, 'channel_only');
    assert.deepEqual(f.slack.calls, []);
  }
  const hidden = fixture(t, { conversations: {} });
  assert.equal((await failure(hidden.service().create('call-1', 'Notes', '# Notes'))).code, 'channel_unavailable');
});

test('an identical creation is made once, and an uncertain one blocks further writes in the request', async (t) => {
  const f = fixture(t);
  assert.equal((await f.service().create('call-1', 'Brief', '# Brief')).status, 'created');
  const again = await f.service().create('call-2', 'Brief', '# Brief');
  assert.equal(again.status, 'already_attempted');
  assert.deepEqual(f.slack.writes(), ['canvases.create']);

  const uncertain = fixture(t);
  uncertain.slack.failures.set('canvases.create', { error: 'internal_error' });
  assert.equal((await uncertain.service().create('call-1', 'Brief', '# Brief')).status, 'unverified');
  uncertain.slack.failures.clear();
  const blocked = await uncertain.service().update('call-2', { operation: 'append', markdown: 'More' });
  assert.equal(blocked.status, 'already_attempted');
  assert.equal(blocked.previousStatus, 'unknown');
  assert.deepEqual(uncertain.slack.writes(), ['canvases.create']);
});

test('appending and replacing one section edit the canvas the way Slack documents', async (t) => {
  const f = fixture(t);
  const appended = await f.service().update('call-1', { operation: 'append', markdown: '## Today\n- shipped' });
  assert.equal(appended.status, 'updated');
  assert.deepEqual(f.slack.calls.at(-1), { method: 'canvases.edit', input: {
    canvas_id: 'FCHANNEL', changes: [{ operation: 'insert_at_end', document_content: { type: 'markdown', markdown: '## Today\n- shipped' } }],
  } });

  await f.service().update('call-2', { operation: 'replace_section', sectionText: 'Restart', markdown: 'Restart the worker twice.' });
  assert.deepEqual(f.slack.calls.at(-2), { method: 'canvases.sections.lookup', input: { canvas_id: 'FCHANNEL', criteria: { contains_text: 'Restart' } } });
  assert.deepEqual(f.slack.calls.at(-1)!.input.changes, [{ operation: 'replace', section_id: 'temp:C:ONE', document_content: { type: 'markdown', markdown: 'Restart the worker twice.' } }]);

  for (const [sections, code] of [[[], 'section_not_found'], [['temp:C:ONE', 'temp:C:TWO'], 'section_ambiguous']] as const) {
    f.slack.sections = [...sections];
    const before = f.slack.writes().length;
    assert.equal((await failure(f.service().update('call-3', { operation: 'replace_section', sectionText: 'Status', markdown: 'Done' }))).code, code);
    assert.equal(f.slack.writes().length, before, 'an unclear section changes nothing');
  }
  assert.equal((await failure(f.service().update('call-4', { operation: 'append', sectionText: 'x', markdown: 'y' }))).code, 'invalid_section');
});

test('only this conversation\'s canvas and canvases Chickpea created can be edited', async (t) => {
  const f = fixture(t);
  assert.equal((await f.service().update('call-1', { canvasUrl: link('FREPORT'), operation: 'append', markdown: 'More' })).status, 'updated');
  assert.equal((await f.service().update('call-2', { canvasUrl: link('FCHANNEL'), operation: 'append', markdown: 'More' })).status, 'updated');
  assert.equal((await failure(f.service().update('call-3', { canvasUrl: link('FPEOPLE'), operation: 'append', markdown: 'More' }))).code, 'not_editable');
  assert.deepEqual(await failure(f.service().update('call-4', { canvasUrl: link('FSECRET'), operation: 'append', markdown: 'More' })),
    { code: 'not_available', message: CANVAS_NOT_AVAILABLE }, 'Chickpea\'s canvas in a channel the requester cannot read stays unseen');
  assert.deepEqual(await failure(f.service().update('call-5', { canvasUrl: link('FHIDDEN'), operation: 'append', markdown: 'More' })),
    { code: 'not_available', message: CANVAS_NOT_AVAILABLE }, 'a refusal never says who owns a canvas the requester cannot read');
  assert.deepEqual(f.slack.calls.filter((call) => call.method === 'canvases.edit').map((call) => call.input.canvas_id), ['FREPORT', 'FCHANNEL']);
});

test('without the canvas scopes every tool says an Owner must update Chickpea\'s Slack permissions', async (t) => {
  const hosted = 'This workspace has not given Chickpea the Slack canvas permissions yet. A Chickpea Owner can update them in Chickpea Admin. Ordinary chat can continue.';
  const selfHosted = 'This Slack installation needs the canvas read/write permissions. Its owner must update the app scopes and reinstall through the existing Slack setup flow. Ordinary chat can continue.';
  for (const [isHosted, message] of [[true, hosted], [false, selfHosted]] as const) {
    const f = fixture(t, { hosted: isHosted });
    for (const method of ['canvases.getContent', 'canvases.create', 'canvases.edit', 'canvases.sections.lookup'] as const) {
      f.slack.failures.set(method, { error: 'missing_scope' });
    }
    assert.equal((await failure(f.service().read({}))).message, message);
    assert.deepEqual(await f.service().create('call-1', 'Brief', '# Brief'), { status: 'not_written', code: 'missing_scope', message });
    assert.deepEqual(await f.service().update('call-2', { operation: 'append', markdown: 'x' }), { status: 'not_written', code: 'missing_scope', message });
    assert.equal((await failure(f.service().update('call-3', { operation: 'replace_section', sectionText: 'x', markdown: 'y' }))).message, message);
  }
});

test('tool results carry structured refusals, Slack\'s Markdown detail, and the hosted copy', async (t) => {
  const f = fixture(t, { hosted: true });
  const tools = createSlackCanvasTools(async () => f.service());
  const run = (name: string, data: JsonObject) => tools.find((tool) => tool.name === name)!.run({ data, toolCallId: `tool-${name}`, signal: undefined } as never);
  f.slack.failures.set('canvases.getContent', { error: 'missing_scope' });
  assert.deepEqual(JSON.parse(await run('read_slack_canvas', {}) as string), {
    status: 'not_read', code: 'missing_scope',
    message: 'This workspace has not given Chickpea the Slack canvas permissions yet. A Chickpea Owner can update them in Chickpea Admin. Ordinary chat can continue.',
  });
  f.slack.failures.set('canvases.create', { error: 'canvas_creation_failed', detail: "'content' error: line 3: Unsupported block type (List) within block quote" });
  const created = JSON.parse(await run('create_slack_canvas', { title: 'Brief', markdown: '> - x' }) as string);
  assert.equal(created.status, 'not_written');
  assert.equal(created.detail, "'content' error: line 3: Unsupported block type (List) within block quote");
  const refused = JSON.parse(await run('read_slack_canvas', { canvasUrl: link('FSECRET') }) as string);
  assert.deepEqual(refused, { status: 'not_read', code: 'not_available', message: CANVAS_NOT_AVAILABLE });
});

test('the three tool contracts take no Slack IDs or operations beyond the reviewed ones', () => {
  const tools = createSlackCanvasTools(async () => { throw new Error('must not run'); });
  assert.deepEqual(tools.map((tool) => tool.name), [...SLACK_CANVAS_TOOL_NAMES]);
  for (const tool of tools) assert.notEqual(tool.durable, true);
  const schema = (name: string) => tools.find((tool) => tool.name === name)!.input!;
  assert.equal(v.safeParse(schema('create_slack_canvas'), { title: 'Brief', markdown: '# Brief', channel_id: 'COTHER' }).success, false);
  assert.equal(v.safeParse(schema('create_slack_canvas'), { title: 'Brief', markdown: '   ' }).success, false);
  assert.equal(v.safeParse(schema('create_slack_canvas'), { title: 'Brief', markdown: 'x'.repeat(100_001) }).success, false);
  assert.equal(v.safeParse(schema('update_slack_canvas'), { operation: 'delete', markdown: 'x' }).success, false);
  assert.equal(v.safeParse(schema('update_slack_canvas'), { operation: 'append', markdown: 'x', section_id: 'temp:C:ONE' }).success, false);
  assert.equal(v.safeParse(schema('read_slack_canvas'), { canvasUrl: link('FREPORT'), token: 'xoxb-private' }).success, false);
});

test('the gateway carries exactly the reviewed canvas methods', async () => {
  const calls: string[] = [];
  const client = createGatewaySlackWebClient({ workspaceId: WORKSPACE, call: async (method) => { calls.push(method); return { observed: true }; } });
  const call = createSlackCanvasesCall(client);
  for (const method of SLACK_CANVAS_OPERATIONS) assert.equal((await call(method, {})).observed, true);
  assert.deepEqual(calls, [...SLACK_CANVAS_OPERATIONS]);
  for (const method of ['canvases.delete', 'canvases.access.set', 'canvases.access.delete']) {
    await assert.rejects(client.apiCall(method, {}), /unavailable/, method);
  }
});
