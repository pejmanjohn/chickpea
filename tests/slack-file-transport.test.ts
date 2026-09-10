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
const permalink = `https://example-workspace.slack.com/files/U12345678/${fileId}/file.csv`;
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
  assert.deepEqual(JSON.parse(body.get('blocks')!), input.blocks);
  assert.equal(body.has('initial_comment'), false);
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
      assert.deepEqual(value.blocks, input.blocks);
      assert.equal(value.initial_comment, undefined);
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

test('direct and gateway completion send the same full initial comment without blocks', async () => {
  const initialComment = `${'x'.repeat(5_000)}\n\nSmoke Amber | <https://example.com/admin|Configure>`;
  let directPayload: Record<string, string> | undefined;
  const direct = new WebClient('xoxb-test', { retryConfig: { retries: 0 }, fetch: async (_url, init) => {
    directPayload = Object.fromEntries(new URLSearchParams(String(init!.body)));
    return Response.json({ ok: true, files: [{ id: fileId }] });
  } });
  let gatewayPayload: Record<string, unknown> | undefined;
  const gateway = createGatewaySlackWebClient({ workspaceId: 'T12345678', async call(operation, value) {
    assert.equal(operation, 'files.completeUploadExternal');
    gatewayPayload = value;
    return { files: [{ id: fileId }] };
  } } as GatewayOperationClient);
  for (const client of [direct, gateway]) {
    await createSlackFileTransport(client).complete({ ...input, initialComment });
  }
  for (const payload of [directPayload, gatewayPayload]) {
    assert.equal(payload?.initial_comment, initialComment);
    assert.equal(payload?.blocks, undefined);
    assert.equal(payload?.channel_id, channelId);
    assert.equal(payload?.thread_ts, threadTs);
    assert.equal(payload?.username, input.persona.username);
    assert.equal(payload?.icon_url, input.persona.icon_url);
  }
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

test('direct private staging completes once without a destination and preserves byte subviews', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    if (String(url).endsWith('getUploadURLExternal')) return Response.json({ ok: true, file_id: fileId, upload_url: 'https://files.slack.com/upload/test' });
    if (String(url).includes('/upload/')) return new Response('OK');
    assert.ok(String(url).endsWith('completeUploadExternal'));
    return Response.json({ ok: true, files: [{ id: fileId, permalink, size: 3 }] });
  };
  const transport = createSlackFileTransport(new WebClient('xoxb-test', { retryConfig: { retries: 0 }, fetch: fetcher }), { fetch: fetcher });
  const bytes = new Uint8Array([99, 1, 2, 3, 99]).subarray(1, 4);
  assert.deepEqual(await transport.stagePrivate({ filename: 'file.csv', title: 'Synthetic data', bytes }), { fileId, permalink, byteLength: 3 });
  assert.equal(calls.length, 3);
  assert.deepEqual(Array.from(calls[1]!.init.body as Uint8Array), [1, 2, 3]);
  const completion = new URLSearchParams(String(calls[2]!.init.body));
  assert.deepEqual(JSON.parse(completion.get('files')!), [{ id: fileId, title: 'Synthetic data' }]);
  for (const field of ['channel_id', 'channel', 'channels', 'thread_ts', 'initial_comment', 'blocks', 'username', 'icon_url']) {
    assert.equal(completion.has(field), false, field);
  }
});

test('gateway private staging uses the existing destination-free uploadV2 operation once', async () => {
  const operations: string[] = [];
  const bytes = new Uint8Array([99, 1, 2, 3, 99]).subarray(1, 4);
  const transport = createSlackFileTransport(createGatewaySlackWebClient({ workspaceId: 'T12345678', async call(operation, value) {
    operations.push(operation);
    assert.deepEqual(Object.keys(value).sort(), ['file', 'filename', 'title']);
    assert.equal(value.filename, 'file.csv');
    assert.equal(value.title, 'Synthetic data');
    assert.deepEqual(Array.from(value.file as Uint8Array), [1, 2, 3]);
    return { files: [{ id: fileId, permalink, size: 3 }] };
  } } as GatewayOperationClient));
  assert.deepEqual(await transport.stagePrivate({ filename: 'file.csv', title: 'Synthetic data', bytes, altText: 'Chart text' }), { fileId, permalink, byteLength: 3 });
  assert.deepEqual(operations, ['files.uploadV2']);
});

for (const gateway of [false, true]) {
  test(`private completion rejects malformed receipts without retry or share readback (gateway=${gateway})`, async () => {
    for (const response of [
      { ok: false }, { ok: true }, { ok: true, files: [] },
      { ok: true, files: [{ id: fileId }] },
      { ok: true, files: [{ id: fileId, permalink: permalink.replace(fileId, 'F87654321') }] },
      { ok: true, files: [{ id: fileId, permalink: permalink.replace('example-workspace.slack.com', 'example.com') }] },
      { ok: true, files: [{ id: fileId, permalink, size: 4 }] },
      { ok: true, files: [{ id: fileId, permalink }, { id: fileId, permalink }] },
    ]) {
      let completions = 0;
      const client = gateway ? createGatewaySlackWebClient({ workspaceId: 'T12345678', async call(operation) {
        assert.equal(operation, 'files.uploadV2');
        completions++;
        return response;
      } } as GatewayOperationClient) : { files: {
        async getUploadURLExternal() { return { ok: true, file_id: fileId, upload_url: 'https://files.slack.com/upload/test' }; },
        async completeUploadExternal() { completions++; return response; },
      } } as unknown as WebClient;
      const transport = createSlackFileTransport(client, { fetch: async () => new Response('OK') });
      await assert.rejects(transport.stagePrivate({ filename: 'file.csv', bytes: new Uint8Array(3) }), (error: unknown) =>
        error instanceof SlackTransportError && error.code === 'invalid_private_completion_receipt' && error.effectOutcome === 'unknown' && !error.retryable);
      assert.equal(completions, 1);
    }
  });

  test(`lost private completion response is never retried (gateway=${gateway})`, async () => {
    let completions = 0;
    const fail = async () => { completions++; throw new Error('Response was lost.'); };
    const client = gateway ? createGatewaySlackWebClient({ workspaceId: 'T12345678', async call(operation) {
      assert.equal(operation, 'files.uploadV2');
      return fail();
    } } as GatewayOperationClient) : { files: {
      async getUploadURLExternal() { return { ok: true, file_id: fileId, upload_url: 'https://files.slack.com/upload/test' }; },
      completeUploadExternal: fail,
    } } as unknown as WebClient;
    await assert.rejects(createSlackFileTransport(client, { fetch: async () => new Response('OK') })
      .stagePrivate({ filename: 'file.csv', bytes: new Uint8Array(3) }), /Response was lost/);
    assert.equal(completions, 1);
  });
}

test('direct private completion must return the exact staged file id', async () => {
  const other = 'F87654321';
  const client = { files: {
    async getUploadURLExternal() { return { ok: true, file_id: fileId, upload_url: 'https://files.slack.com/upload/test' }; },
    async completeUploadExternal() { return { ok: true, files: [{ id: other, permalink: permalink.replace(fileId, other) }] }; },
  } } as unknown as WebClient;
  await assert.rejects(createSlackFileTransport(client, { fetch: async () => new Response('OK') })
    .stagePrivate({ filename: 'file.csv', bytes: new Uint8Array(3) }), /invalid_private_completion_receipt/);
});
