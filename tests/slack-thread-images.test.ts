import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hydrateSlackContextViaWebClient } from '../src/slack/web-client-context.ts';
import {
  buildThreadImageInventory,
  collectThreadImageRecords,
  createThreadImageReader,
  DEFAULT_THREAD_IMAGE_FILE_LIMIT_BYTES,
  DEFAULT_THREAD_IMAGE_TOTAL_LIMIT_BYTES,
  MAX_THREAD_IMAGE_ENTRIES,
  MAX_THREAD_IMAGES_ATTRIBUTE_CHARS,
  parseThreadImageRecords,
  serializeThreadImageRecords,
  slackThreadImageConversationKey,
  type ThreadImageRecord,
} from '../src/slack/thread-images.ts';
import type { SlackArtifactReceipt } from '../src/slack/artifact-receipts.ts';
import type { GatewayAttachmentClient, GatewayAttachmentRead } from '../src/slack/gateway/client.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';

function threadTurn(overrides: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return {
    workspaceId: 'T1',
    channelId: 'C1',
    eventId: 'Ev1',
    text: 'make an ad from this logo',
    userId: 'U_HUMAN',
    messageTs: '2000.000000',
    threadTs: '1000.000000',
    source: 'implicit_thread_reply',
    contextMode: 'thread',
    ...overrides,
  };
}

const CONVERSATION_KEY = slackThreadImageConversationKey(threadTurn());

function imageFile(id: string, name = 'logo.png', overrides: Record<string, unknown> = {}) {
  return { id, name, mimetype: 'image/png', filetype: 'png', size: 1_024, ...overrides };
}

function personUpload(ts: string, files: unknown[], text = '') {
  return { type: 'message', subtype: 'file_share', user: 'U_HUMAN', text, ts, files };
}

function botFileShare(ts: string, files: unknown[]) {
  return { type: 'message', subtype: 'file_share', bot_id: 'B1', user: 'U_BOT', text: '', ts, files };
}

function fakeReplies(messages: unknown[]) {
  return {
    conversations: {
      async replies() {
        return { ok: true, messages };
      },
    },
  };
}

function record(overrides: Partial<ThreadImageRecord> = {}): ThreadImageRecord {
  return {
    conversationKey: CONVERSATION_KEY,
    fileId: 'F00000000AA',
    filename: 'logo.png',
    mimeType: 'image/png',
    origin: 'person',
    messageTs: '1001.000000',
    ...overrides,
  };
}

function fakeAttachmentClient(
  handler: (fileId: string, maxBytes: number) => Promise<GatewayAttachmentRead>,
): GatewayAttachmentClient & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async readAttachment(fileId, maxBytes) {
      calls += 1;
      return handler(fileId, maxBytes);
    },
  };
}

function imageRead(fileId: string, byteLength = 8): GatewayAttachmentRead {
  return {
    fileId,
    filename: 'logo.png',
    representation: 'image_original',
    contentType: 'image/png',
    bytes: new Uint8Array(byteLength),
  };
}

function failingClient(code: string) {
  return fakeAttachmentClient(async () => {
    throw Object.assign(new Error(code), { code });
  });
}

function receipt(overrides: Partial<SlackArtifactReceipt> = {}): SlackArtifactReceipt {
  return {
    schemaVersion: 1,
    fileId: 'F00000000ZZ',
    filename: 'ad.png',
    kind: 'chart',
    byteLength: 2_048,
    stagedAt: 10,
    destination: { workspaceId: 'T1', agentId: 'agent_analyst', channelId: 'C1', threadTs: '1000.000000' },
    ...overrides,
  } as SlackArtifactReceipt;
}

test('the thread fetch inventories person uploads and the Agent\'s own file shares in thread order', async () => {
  const turn = threadTurn();
  const context = await hydrateSlackContextViaWebClient(
    fakeReplies([
      { user: 'U_HUMAN', type: 'message', text: 'here is the brief', ts: '1000.000000' },
      personUpload('1001.000000', [imageFile('F00000000AA', 'logo.png')], 'our logo'),
      personUpload('1002.000000', [imageFile('F00000000BB', 'palette.png')], 'and the palette'),
      botFileShare('1003.000000', [imageFile('F00000000CC', 'draft-ad.png')]),
    ]) as never,
    turn,
  );

  const inventory = buildThreadImageInventory({
    threadRecords: context.images,
    conversationKey: CONVERSATION_KEY,
  });
  assert.deepEqual(
    inventory.entries.map((entry) => [entry.handle, entry.origin, entry.filename]),
    [
      ['img:1', 'person', 'logo.png'],
      ['img:2', 'person', 'palette.png'],
      ['img:3', 'agent', 'draft-ad.png'],
    ],
  );
});

test('rows the context projection drops still yield handles', async () => {
  const turn = threadTurn();
  const context = await hydrateSlackContextViaWebClient(
    fakeReplies([
      botFileShare('1001.000000', [imageFile('F00000000CC', 'draft-ad.png')]),
      personUpload('1002.000000', [imageFile('F00000000AA', 'logo.png')], ''),
    ]) as never,
    turn,
  );

  // The projection is unchanged: a bot row and a caption-less row reach no
  // prompt message, so only the trigger remains.
  assert.deepEqual(context.messages.map((message) => message.ts), [turn.messageTs]);
  assert.equal(context.messages.every((message) => message.isTrigger), true);

  const inventory = buildThreadImageInventory({
    threadRecords: context.images,
    conversationKey: CONVERSATION_KEY,
  });
  assert.deepEqual(
    inventory.entries.map((entry) => [entry.handle, entry.origin]),
    [['img:1', 'agent'], ['img:2', 'person']],
  );
});

test('an image staged in the current response takes the next handle', () => {
  const inventory = buildThreadImageInventory({
    threadRecords: [record()],
    currentResponseReceipts: [receipt(), receipt({ fileId: 'F00000000YY', filename: 'notes.csv', kind: 'file' })],
    conversationKey: CONVERSATION_KEY,
  });
  assert.deepEqual(
    inventory.entries.map((entry) => [entry.handle, entry.origin, entry.filename]),
    [['img:1', 'person', 'logo.png'], ['img:2', 'agent', 'ad.png']],
  );
  const resolved = inventory.resolveHandle('img:2');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok && resolved.record.fileId, 'F00000000ZZ');
});

test('the manifest carries no Slack file id and never reuses the attachment ordinal form', () => {
  const inventory = buildThreadImageInventory({
    threadRecords: [record(), record({ fileId: 'F00000000BB', origin: 'agent', filename: 'draft-ad.png' })],
    currentResponseReceipts: [receipt()],
    conversationKey: CONVERSATION_KEY,
  });
  assert.match(inventory.manifest, /- handle=img:1 \| origin=person \| filename="logo\.png" \| mime=image\/png/);
  assert.match(inventory.manifest, /handle=img:3 \| origin=agent/);
  assert.doesNotMatch(inventory.manifest, /ordinal=/);
  for (const fileId of ['F00000000AA', 'F00000000BB', 'F00000000ZZ']) {
    assert.equal(inventory.manifest.includes(fileId), false);
  }
});

test('a handle outside the current conversation is refused without a fetch', async () => {
  const inventory = buildThreadImageInventory({
    threadRecords: [record({ conversationKey: 'T1:C_OTHER:1000.000000' })],
    conversationKey: CONVERSATION_KEY,
  });
  assert.deepEqual(inventory.entries, []);
  assert.deepEqual(inventory.resolveHandle('img:1'), {
    ok: false, reason: 'input-unavailable', detail: 'not_found',
  });
  assert.deepEqual(inventory.resolveHandle('not-a-handle'), {
    ok: false, reason: 'input-unavailable', detail: 'not_found',
  });

  // A record built for another conversation cannot be smuggled past the scope
  // check by holding onto this turn's inventory.
  const foreign = buildThreadImageInventory({
    threadRecords: [record()],
    conversationKey: 'T1:C_OTHER:1000.000000',
  });
  assert.deepEqual(foreign.entries, []);
  const client = fakeAttachmentClient(async (fileId) => imageRead(fileId));
  const reader = createThreadImageReader({ client });
  assert.equal(foreign.resolveHandle('img:1').ok, false);
  assert.equal(client.calls(), 0);
  assert.equal(reader.usedBytes(), 0);
});

test('an oversized input, and a set over the turn budget, are refused before any fetch', async () => {
  const client = fakeAttachmentClient(async (fileId, maxBytes) => imageRead(fileId, maxBytes));
  const reader = createThreadImageReader({ client });

  const oversized = await reader.read(record({
    byteLength: DEFAULT_THREAD_IMAGE_FILE_LIMIT_BYTES + 1,
  }));
  assert.deepEqual(oversized, { ok: false, reason: 'input-unavailable', detail: 'too_large' });
  assert.equal(client.calls(), 0);

  const half = Math.floor(DEFAULT_THREAD_IMAGE_TOTAL_LIMIT_BYTES / 2) + 1;
  const budgeted = createThreadImageReader({
    client: fakeAttachmentClient(async (fileId) => imageRead(fileId, half)),
  });
  const first = await budgeted.read(record({ byteLength: half }));
  assert.equal(first.ok, true);
  const second = await budgeted.read(record({ fileId: 'F00000000BB', byteLength: half }));
  assert.deepEqual(second, { ok: false, reason: 'input-unavailable', detail: 'too_large' });
  assert.equal(budgeted.usedBytes(), half);
});

test('Slack and gateway failures map to the input-unavailable vocabulary', async () => {
  for (const [code, detail] of [
    ['file_not_found', 'not_found'],
    ['missing_scope', 'missing_scope'],
    ['unsupported_file_type', 'unsupported_type'],
    ['attachment_byte_limit_exceeded', 'too_large'],
    ['gateway_not_connected', 'transport'],
  ] as const) {
    const reader = createThreadImageReader({ client: failingClient(code) });
    assert.deepEqual(
      await reader.read(record()),
      { ok: false, reason: 'input-unavailable', detail },
      code,
    );
  }

  // A gateway transport error carries its code on the error, not the message.
  const transport = createThreadImageReader({
    client: fakeAttachmentClient(async () => { throw new Error('socket hang up'); }),
  });
  assert.deepEqual(await transport.read(record()), {
    ok: false, reason: 'input-unavailable', detail: 'transport',
  });
});

test('a non-image file is refused as unsupported, before and after the read', async () => {
  const client = fakeAttachmentClient(async (fileId) => imageRead(fileId));
  const reader = createThreadImageReader({ client });
  assert.deepEqual(await reader.read(record({ filename: 'notes.csv', mimeType: 'text/csv' })), {
    ok: false, reason: 'input-unavailable', detail: 'unsupported_type',
  });
  assert.equal(client.calls(), 0);

  const textReader = createThreadImageReader({
    client: fakeAttachmentClient(async (fileId) => ({
      fileId,
      filename: 'notes.csv',
      representation: 'text_original',
      contentType: 'text/csv',
      bytes: new Uint8Array(4),
    })),
  });
  assert.deepEqual(await textReader.read(record()), {
    ok: false, reason: 'input-unavailable', detail: 'unsupported_type',
  });
  assert.equal(textReader.usedBytes(), 0);
});

test('a resolved handle reads bytes through the attachment client under the per-file cap', async () => {
  let requestedMax = 0;
  const client = fakeAttachmentClient(async (fileId, maxBytes) => {
    requestedMax = maxBytes;
    return imageRead(fileId, 16);
  });
  const reader = createThreadImageReader({ client });
  const inventory = buildThreadImageInventory({
    threadRecords: [record()],
    conversationKey: CONVERSATION_KEY,
  });
  const resolved = inventory.resolveHandle('img:1');
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const read = await reader.read(resolved.record);
  assert.deepEqual(read, {
    ok: true, bytes: new Uint8Array(16), mimeType: 'image/png', filename: 'logo.png',
  });
  assert.equal(requestedMax, DEFAULT_THREAD_IMAGE_FILE_LIMIT_BYTES);
  assert.equal(reader.usedBytes(), 16);
});

test('raw row collection ignores rows and files that cannot be addressed', () => {
  assert.deepEqual(
    collectThreadImageRecords(
      [
        personUpload('1001.000000', [imageFile('F00000000AA', 'logo.png')]),
        personUpload('1002.000000', [imageFile('F00000000BB', 'notes.pdf', { mimetype: 'application/pdf' })]),
        personUpload('1003.000000', [{ id: 'not-a-file-id', name: 'x.png', mimetype: 'image/png' }]),
        personUpload('not-a-ts', [imageFile('F00000000CC')]),
        { user: 'U_HUMAN', type: 'message', text: 'no files here', ts: '1004.000000' },
      ],
      CONVERSATION_KEY,
    ).map((entry) => entry.fileId),
    ['F00000000AA'],
  );
});

function wireRecord(overrides: Partial<ThreadImageRecord> = {}): ThreadImageRecord {
  return {
    conversationKey: CONVERSATION_KEY,
    fileId: 'F00000000AA',
    filename: 'logo.png',
    mimeType: 'image/png',
    origin: 'person',
    messageTs: '1001.000000',
    byteLength: 1_024,
    ...overrides,
  };
}

test('the dispatch wire form round-trips records without their conversation key', () => {
  const records = [
    wireRecord(),
    wireRecord({ fileId: 'F00000000BB', filename: 'chart.png', origin: 'agent', messageTs: '1002.000000' }),
  ];
  const encoded = serializeThreadImageRecords(records);
  assert.ok(encoded);
  // The wire never names a conversation: the Agent stamps its own.
  assert.equal(encoded.includes('conversationKey'), false);
  assert.deepEqual(parseThreadImageRecords(encoded, CONVERSATION_KEY), records);
  // A record parsed under another plan's key belongs to that conversation only.
  assert.deepEqual(
    parseThreadImageRecords(encoded, 'T9:C9:9.9').map((entry) => entry.conversationKey),
    ['T9:C9:9.9', 'T9:C9:9.9'],
  );
});

test('an empty or unserializable record list omits the attribute', () => {
  assert.equal(serializeThreadImageRecords(undefined), undefined);
  assert.equal(serializeThreadImageRecords([]), undefined);
  // Staged receipts have no message of their own and never cross the wire.
  assert.equal(serializeThreadImageRecords([wireRecord({ messageTs: '' })]), undefined);
  assert.equal(serializeThreadImageRecords([wireRecord({ fileId: 'not-a-file-id' })]), undefined);
});

test('the wire parser is fail-closed on every malformed input', () => {
  const cases: unknown[] = [
    undefined,
    '',
    'not json',
    '{"fileId":"F00000000AA"}',
    JSON.stringify([{ ...wireRecord(), fileId: 'not-a-file-id' }]),
    JSON.stringify([{ ...wireRecord(), mimeType: 'application/pdf' }]),
    JSON.stringify([{ ...wireRecord(), origin: 'system' }]),
    JSON.stringify([{ ...wireRecord(), messageTs: 'not-a-ts' }]),
    JSON.stringify([{ ...wireRecord(), byteLength: -1 }]),
    JSON.stringify([{ somethingElse: true }]),
    JSON.stringify(['F00000000AA']),
  ];
  for (const value of cases) {
    assert.deepEqual(parseThreadImageRecords(value, CONVERSATION_KEY), [], String(value).slice(0, 40));
  }
  // A single bad entry rejects the whole list rather than half-trusting it.
  assert.deepEqual(
    parseThreadImageRecords(
      JSON.stringify([{ ...wireRecord(), conversationKey: undefined }, { fileId: 'nope' }]),
      CONVERSATION_KEY,
    ),
    [],
  );
  assert.deepEqual(parseThreadImageRecords(JSON.stringify([wireRecord()]), ''), []);
});

test('the wire form is bounded by entry count and encoded size', () => {
  const many = Array.from({ length: MAX_THREAD_IMAGE_ENTRIES + 10 }, (_value, index) =>
    wireRecord({ fileId: `F0000000${String(index).padStart(3, '0')}`, messageTs: `${2000 + index}.000000` }));
  const encoded = serializeThreadImageRecords(many);
  assert.ok(encoded);
  const parsed = parseThreadImageRecords(encoded, CONVERSATION_KEY);
  assert.equal(parsed.length, MAX_THREAD_IMAGE_ENTRIES);
  // The newest survive an overflowing thread.
  assert.equal(parsed.at(-1)?.fileId, many.at(-1)?.fileId);

  const wide = Array.from({ length: MAX_THREAD_IMAGE_ENTRIES }, (_value, index) =>
    wireRecord({
      fileId: `F0000000${String(index).padStart(3, '0')}`,
      filename: `${'n'.repeat(250)}.png`,
      messageTs: `${3000 + index}.000000`,
    }));
  const wideEncoded = serializeThreadImageRecords(wide);
  assert.ok(wideEncoded);
  assert.ok(wideEncoded.length <= MAX_THREAD_IMAGES_ATTRIBUTE_CHARS);
  assert.equal(parseThreadImageRecords(wideEncoded, CONVERSATION_KEY).length, MAX_THREAD_IMAGE_ENTRIES);
  assert.deepEqual(parseThreadImageRecords('x'.repeat(MAX_THREAD_IMAGES_ATTRIBUTE_CHARS + 1), CONVERSATION_KEY), []);
});
