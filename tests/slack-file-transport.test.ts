import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebClient, ErrorCode } from '@slack/web-api';
import { createSlackFileTransport, resolveFileShares, slackFileCompletionFailureOutcome } from '../src/slack/file-transport.ts';
import { createGatewaySlackWebClient } from '../src/slack/gateway/web-client.ts';
import type { GatewayOperationClient } from '../src/slack/gateway/client.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';

const fileId = 'F12345678';
const channelId = 'C12345678';
const ts = '1789063303.098999';
const threadTs = '1789063300.000100';
const input = { files: [{ id: fileId }], channelId, threadTs, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Here is the chart.' } }], persona: { username: 'Smoke Amber', icon_url: 'https://example.com/avatar.png' } };

test('direct staging preserves byte subviews and native completion keeps Agent persona', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    if (String(url).endsWith('getUploadURLExternal')) return Response.json({ ok: true, file_id: fileId, upload_url: 'https://files.slack.com/upload/test' });
    if (String(url).includes('/upload/')) return new Response('OK');
    if (String(url).endsWith('completeUploadExternal')) return Response.json({ ok: true, files: [{ id: fileId }] });
    return Response.json({ ok: true, file: { id: fileId, shares: { public: { [channelId]: [{ ts, thread_ts: threadTs }] } } } });
  };
  const client = new WebClient('xoxb-test', { retryConfig: { retries: 0 }, fetch: fetcher });
  const transport = createSlackFileTransport(client, { fetch: fetcher });
  const bytes = new Uint8Array([99, 1, 2, 3, 99]).subarray(1, 4);
  assert.deepEqual(await transport.stage({ filename: 'chart.png', bytes }), { fileId, byteLength: 3 });
  assert.equal(calls.length, 2, 'staging must not publish');
  assert.deepEqual(Array.from(calls[1]!.init.body as Uint8Array), [1, 2, 3]);
  assert.equal(calls[1]!.init.redirect, 'manual');
  assert.equal(new Headers(calls[1]!.init.headers).has('authorization'), false);
  assert.deepEqual(await transport.complete(input), {});
  const body = new URLSearchParams(String(calls[2]!.init.body));
  assert.equal(body.get('username'), 'Smoke Amber');
  assert.equal(body.get('icon_url'), input.persona.icon_url);
  assert.equal(body.get('channel_id'), channelId);
  assert.deepEqual(JSON.parse(body.get('files')!), input.files);
  assert.deepEqual(await transport.resolveShare({ fileId, channelId, threadTs }), { shared: true, channelId, ts });
});

test('gateway uses stage, native completion and exact-share readback without uploadV2', async () => {
  const operations: string[] = [];
  const client = createGatewaySlackWebClient({ workspaceId: 'T12345678', async call(operation, value) {
    operations.push(operation);
    if (operation === 'chickpea.files.stage') return { file_id: fileId, byteLength: 3 };
    if (operation === 'files.completeUploadExternal') {
      assert.equal(value.username, 'Smoke Amber');
      assert.equal(value.channel_id, channelId);
      return { files: [{ id: fileId }] };
    }
    assert.deepEqual(value, { file: fileId, channel: channelId, thread_ts: threadTs });
    return { shared: true, channel: channelId, ts };
  } } as GatewayOperationClient);
  const transport = createSlackFileTransport(client);
  await transport.stage({ filename: 'file.csv', bytes: new Uint8Array(3) });
  await transport.complete(input);
  await transport.resolveShare({ fileId, channelId, threadTs });
  assert.deepEqual(operations, ['chickpea.files.stage', 'files.completeUploadExternal', 'chickpea.files.getShare']);
});

test('partial completion receipts and inconsistent file shares remain unknown', async () => {
  const client = { files: { completeUploadExternal: async () => ({ ok: true, files: [{ id: fileId }] }) } } as unknown as WebClient;
  const transport = createSlackFileTransport(client);
  await assert.rejects(transport.complete({ ...input, files: [{ id: fileId }, { id: 'F87654321' }] }), (error: unknown) =>
    error instanceof SlackTransportError && error.effectOutcome === 'unknown');
  let reads = 0;
  await assert.rejects(resolveFileShares({ ...transport, async resolveShare() {
    return { shared: true, channelId, ts: `${++reads}.000100` };
  } }, { fileIds: [fileId, 'F87654321'], channelId }), /inconsistent_file_shares/);
});

for (const code of ['internal_error', 'fatal_error', 'already_complete', 'unexpected_error']) {
  test(`${code} never permits a replacement send on either transport`, () => {
    assert.equal(slackFileCompletionFailureOutcome({ code: ErrorCode.PlatformError, data: { error: code } }), 'unknown');
    assert.equal(slackFileCompletionFailureOutcome(new SlackTransportError('files.completeUploadExternal', code)), 'unknown');
  });
}
test('known Slack rejection allows an honest fallback consistently across transports', () => {
  assert.equal(slackFileCompletionFailureOutcome({ code: ErrorCode.PlatformError, data: { error: 'missing_scope' } }), 'failed');
  assert.equal(slackFileCompletionFailureOutcome(new SlackTransportError('files.completeUploadExternal', 'missing_scope')), 'failed');
});
