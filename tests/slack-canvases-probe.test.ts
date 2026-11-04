import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SlackCanvasesProbe, type CanvasesProbeMethod, type CanvasesProbeReceipt, type CanvasesProbeSpec } from '../qa/live/probes/slack-canvases.ts';

const spec: CanvasesProbeSpec = { workspaceId: 'TQA', channelIds: ['CQA'], canvasIds: ['FQA'], cleanupCanvasIds: ['FRUN'] };
const auth = { ok: true, team_id: 'TQA', bot_id: 'BQA' };
const response = (data: unknown) => new Response(JSON.stringify(data));

test('canvas probe verifies the bot workspace and refuses overrides, undeclared fixtures and foreign deletes before dispatch', async () => {
  const calls: string[] = [];
  const probe = new SlackCanvasesProbe({ token: 'xoxb-test-only', record: async () => {}, fetch: async url => { calls.push(String(url)); return response(auth); } });
  await assert.rejects(probe.call('unverified', 'canvases.getContent', { canvas_id: 'FQA' }, spec), /Verify bot workspace/);
  await probe.call('auth', 'auth.test', {}, spec);
  for (const [method, input] of [
    ['canvases.getContent', { canvas_id: 'FOTHER' }],
    ['files.info', { file: 'FOTHER' }],
    ['canvases.create', { channel_id: 'COTHER', title: 'x' }],
    ['conversations.canvases.create', { channel_id: 'CQA', token: 'override' }],
    ['canvases.access.set', { canvas_id: 'FQA', channel_ids: ['CQA'], access_level: 'owner' }],
    ['canvases.access.set', { canvas_id: 'FQA', user_ids: ['UQA'], access_level: 'read' }],
    ['canvases.edit', { canvas_id: 'FQA', changes: [{ operation: 'delete', section_id: 'temp:C:1' }] }],
    ['canvases.delete', { canvas_id: 'FQA' }],
    ['files.delete', { file: 'FRUN' }],
  ] as const) {
    await assert.rejects(probe.call('invalid', method as CanvasesProbeMethod, input, spec),
      (error: Error) => !/attempt ID/.test(error.message), method);
  }
  await assert.rejects(probe.call('other-workspace', 'canvases.getContent', { canvas_id: 'FQA' }, { ...spec, workspaceId: 'TOTHER' }));
  assert.equal(calls.length, 1);
});

test('canvas probe records dispatch before a write, never retries an unknown outcome, and keeps the token out of receipts', async () => {
  const receipts: CanvasesProbeReceipt[] = [];
  let calls = 0;
  const probe = new SlackCanvasesProbe({ token: 'xoxb-test-only', record: async r => { receipts.push(r); }, fetch: async () => {
    calls++;
    assert.equal(receipts.at(-1)?.phase, 'dispatching');
    if (calls === 1) return response(auth);
    throw new Error('Possible accepted write; error includes xoxb-test-only');
  } });
  await probe.call('auth', 'auth.test', {}, spec);
  const unknown = await probe.call('create', 'canvases.create', { channel_id: 'CQA', title: 'Probe', document_content: { type: 'markdown', markdown: '# Probe' } }, spec);
  assert.equal(unknown.phase, 'unknown');
  assert.equal(JSON.stringify(receipts).includes('xoxb-test-only'), false);
  await assert.rejects(probe.call('create', 'canvases.create', { channel_id: 'CQA' }, spec), /new, reconciled/);
  assert.equal(calls, 2);
});

test('canvas methods go as JSON and read helpers as form fields', async () => {
  const bodies: { url: string; type: string | null }[] = [];
  const probe = new SlackCanvasesProbe({ token: 'xoxb-test-only', record: async () => {}, fetch: async (url, init) => {
    bodies.push({ url: String(url), type: new Headers(init?.headers).get('content-type') });
    return response(bodies.length === 1 ? auth : { ok: true });
  } });
  await probe.call('auth', 'auth.test', {}, spec);
  await probe.call('info', 'conversations.info', { channel: 'CQA' }, spec);
  await probe.call('lookup', 'canvases.sections.lookup', { canvas_id: 'FQA', criteria: { contains_text: 'Status' } }, spec);
  await probe.call('cleanup', 'canvases.delete', { canvas_id: 'FRUN' }, spec);
  assert.deepEqual(bodies.map(body => [body.url.split('/').at(-1), body.type?.split(';')[0]]), [
    ['auth.test', 'application/x-www-form-urlencoded'],
    ['conversations.info', 'application/x-www-form-urlencoded'],
    ['canvases.sections.lookup', 'application/json'],
    ['canvases.delete', 'application/json'],
  ]);
});
