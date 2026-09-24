import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';

import {
  createRuntimePlanArtifactTools,
} from '../src/agents/slack-thread.ts';
import type { RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { openRecordingDownload, RECORDING_TIMEOUT_MS } from '../src/browser/tools.ts';
import { createConnectionScopedFetch, type ResolvedApiConnection } from '../src/config/egress.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import {
  createRecordingHandleStore,
  RECORDING_RETENTION_MS,
  resolveUploadFile,
  type UploadFileResolution,
} from '../src/connections/file-handles.ts';
import {
  buildMultipartBody,
  buildRawBody,
  prepareRequestBody,
} from '../src/connections/file-upload-body.ts';
import {
  ATTACH_FILE_TO_CONNECTION_TOOL_NAME,
  CONNECTION_UPLOAD_TIMEOUT_MS,
  CONNECTION_UPLOAD_TOOL_TIMEOUT_MS,
  createAttachFileToConnectionTool,
  planAllowsConnectionFileUpload,
  type AttachFileToConnectionOptions,
} from '../src/connections/file-upload-tool.ts';
import { createImageOutputStore, IMAGE_RETENTION_MS } from '../src/images/output-store.ts';
import { createArtifactReceiptAccumulator } from '../src/slack/artifact-receipts.ts';
import { buildThreadImageInventory } from '../src/slack/thread-images.ts';
import { fakeBrowserProvider } from './helpers/fake-cdp-socket.ts';

/** Every byte value, so any text re-encoding (0x80+ → U+FFFD) is caught. */
const BINARY = Uint8Array.from({ length: 512 }, (_, index) => index % 256);
const TOKEN = 'asana-secret-token-0123456789';

const ASANA: ResolvedApiConnection = {
  allowedHosts: ['app.asana.com'],
  pathPrefixes: ['/api/1.0'],
  headerName: 'Authorization',
  headerValue: `Bearer ${TOKEN}`,
  allowedMethods: ['GET', 'POST', 'PUT'],
};

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function bodyBytes(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof ReadableStream) return new Uint8Array(await new Response(body).arrayBuffer());
  throw new Error(`unexpected body ${typeof body}`);
}

/** The file part's bytes and the text fields of a multipart body. */
function parseMultipart(body: Uint8Array, contentType: string) {
  const boundary = /boundary=(.+)$/.exec(contentType)![1]!;
  const buffer = Buffer.from(body);
  const parts: { headers: string; content: Buffer }[] = [];
  const delimiter = Buffer.from(`--${boundary}`);
  let start = buffer.indexOf(delimiter);
  while (start >= 0) {
    const next = buffer.indexOf(delimiter, start + delimiter.length);
    if (next < 0) break;
    const part = buffer.subarray(start + delimiter.length + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    parts.push({ headers: part.subarray(0, split).toString('latin1'), content: part.subarray(split + 4) });
    start = next;
  }
  assert.ok(buffer.subarray(buffer.length - boundary.length - 6).equals(Buffer.from(`--${boundary}--\r\n`)));
  return parts;
}

/** Chunks produced on demand, counting how many the consumer has pulled. */
function countingSource(chunks: Uint8Array[]) {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[pulled]!);
      pulled += 1;
    },
  });
  return { stream, pulled: () => pulled };
}

test('multipart bodies carry binary files byte-exact, fields first and the file last', () => {
  const built = buildMultipartBody({
    fields: [['parent', '1209876543210']],
    fileField: 'file',
    file: { filename: 'shot "one".png', contentType: 'image/png', content: BINARY },
    boundary: 'test-boundary',
  });
  assert.equal(built.contentType, 'multipart/form-data; boundary=test-boundary');
  assert.ok(built.body instanceof Uint8Array);
  assert.equal(built.byteLength, built.body.byteLength);
  const parts = parseMultipart(built.body, built.contentType);
  assert.equal(parts.length, 2);
  assert.match(parts[0]!.headers, /name="parent"/);
  assert.equal(parts[0]!.content.toString(), '1209876543210');
  assert.match(parts[1]!.headers, /name="file"; filename="shot \\"one\\".png"\r\nContent-Type: image\/png/);
  assert.ok(parts[1]!.content.equals(Buffer.from(BINARY)));
});

test('multipart refuses a field name that could forge a part header', () => {
  assert.throws(() => buildMultipartBody({
    fields: [['a"\r\nContent-Type: text/html', 'x']],
    fileField: 'file',
    file: { filename: 'a.png', contentType: 'image/png', content: BINARY },
  }), /invalid_form_field_name/);
});

test('a streamed file is framed without buffering and matches the in-memory body exactly', async () => {
  const chunkSize = 64 * 1024;
  const chunks = Array.from({ length: 32 }, (_, index) =>
    Uint8Array.from({ length: chunkSize }, (_, offset) => (index * 7 + offset) % 256));
  const whole = concat(chunks);
  const source = countingSource(chunks);
  const streamed = buildMultipartBody({
    fields: [['parent', '42']],
    fileField: 'file',
    file: { filename: 'rec.mp4', contentType: 'video/mp4', content: { stream: source.stream, byteLength: whole.byteLength } },
    boundary: 'b',
  });
  const inMemory = buildMultipartBody({
    fields: [['parent', '42']],
    fileField: 'file',
    file: { filename: 'rec.mp4', contentType: 'video/mp4', content: whole },
    boundary: 'b',
  });
  assert.ok(streamed.body instanceof ReadableStream);
  assert.equal(streamed.byteLength, inMemory.byteLength);
  const reader = streamed.body.getReader();
  const received: Uint8Array[] = [];
  for (let i = 0; i < 3; i++) received.push((await reader.read()).value!);
  // Three reads: the header, then two file chunks. Beyond a chunk or two of
  // stream read-ahead, the rest is still unread at the source.
  assert.ok(source.pulled() <= 4, `pulled ${source.pulled()} of ${chunks.length} chunks`);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received.push(value);
  }
  assert.equal(source.pulled(), chunks.length);
  assert.deepEqual(concat(received), inMemory.body);
});

test('a streamed source that ends short of its declared length fails instead of sending', async () => {
  const short = buildRawBody({
    filename: 'rec.mp4',
    contentType: 'video/mp4',
    content: { stream: countingSource([BINARY]).stream, byteLength: BINARY.byteLength + 1 },
  });
  await assert.rejects(bodyBytes(short.body), /upload_source_length_mismatch/);
  const long = buildRawBody({
    filename: 'rec.mp4',
    contentType: 'video/mp4',
    content: { stream: countingSource([BINARY, BINARY]).stream, byteLength: BINARY.byteLength },
  });
  await assert.rejects(bodyBytes(long.body), /upload_source_length_mismatch/);
});

test('on Node a streamed body is spooled to a file-backed Blob, byte-exact, then removed', async () => {
  const built = buildRawBody({
    filename: 'rec.mp4',
    contentType: 'video/mp4',
    content: { stream: countingSource([BINARY, BINARY]).stream, byteLength: BINARY.byteLength * 2 },
  });
  const prepared = await prepareRequestBody(built.body, built.byteLength, 'file');
  assert.ok(prepared.body instanceof Blob);
  assert.equal(prepared.contentLength, undefined);
  assert.deepEqual(await bodyBytes(prepared.body), concat([BINARY, BINARY]));
  await prepared.cleanup();
  const streamed = await prepareRequestBody(
    buildRawBody({ filename: 'a', contentType: 'video/mp4', content: { stream: countingSource([BINARY]).stream, byteLength: BINARY.byteLength } }).body,
    BINARY.byteLength,
    'stream',
  );
  assert.ok(streamed.body instanceof ReadableStream);
  assert.equal(streamed.contentLength, BINARY.byteLength);
});

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: Uint8Array | undefined;
  rawBody: unknown;
}

/**
 * Stub the platform fetch the connection scopes call: DoH answers resolve
 * every host to a public address, and every other request is captured.
 */
async function withStubbedNetwork<T>(
  respond: (request: CapturedRequest) => Response,
  run: (requests: CapturedRequest[]) => Promise<T>,
): Promise<T> {
  const previous = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
      const type = new URL(url).searchParams.get('type');
      return Response.json({ Status: 0, Answer: type === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [] });
    }
    const request: CapturedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      rawBody: init?.body,
      body: init?.body === undefined || init.body === null ? undefined : await bodyBytes(init.body),
    };
    requests.push(request);
    return respond(request);
  }) as typeof fetch;
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = previous;
  }
}

function uploadTool(
  resolveFile: (handle: string) => Promise<UploadFileResolution>,
  overrides: Partial<AttachFileToConnectionOptions> = {},
) {
  const tool = createAttachFileToConnectionTool({
    resolveFetch: async () => {
      const fetch = await createConnectionScopedFetch([ASANA], { cloudflare: true, timeoutMs: 60_000 });
      return fetch ? { fetch, secrets: [ASANA.headerValue, TOKEN] } : undefined;
    },
    resolveFile,
    streamMode: 'stream',
    ...overrides,
  });
  return async (data: Record<string, unknown>): Promise<any> => {
    const parsed = v.parse(tool.input as v.GenericSchema, data);
    const result = await (tool.run as (context: unknown) => Promise<{ output: unknown }>)({
      data: parsed,
      toolCallId: 'call_1',
      log: { info() {}, warn() {}, error() {} },
    });
    return JSON.parse(JSON.stringify(result.output));
  };
}

const PNG_FILE = async (): Promise<UploadFileResolution> =>
  ({ ok: true, file: { filename: 'screenshot.png', contentType: 'image/png', content: BINARY } });

test('the tool sends real bytes as multipart through the connection scope, with its credential', async () => {
  const run = uploadTool(PNG_FILE);
  await withStubbedNetwork(
    () => Response.json({ data: { gid: '555', name: 'screenshot.png', permalink_url: 'https://app.asana.com/0/0/555', echoed: `Bearer ${TOKEN}` } }, { status: 200 }),
    async (requests) => {
      const output = await run({
        file: 'saved:00000000-0000-4000-8000-000000000001',
        url: 'https://app.asana.com/api/1.0/attachments',
        fields: { parent: '1209876543210' },
      });
      assert.equal(requests.length, 1);
      const [request] = requests;
      assert.equal(request!.method, 'POST');
      assert.equal(request!.headers.get('authorization'), `Bearer ${TOKEN}`);
      const parts = parseMultipart(request!.body!, request!.headers.get('content-type')!);
      assert.equal(parts[0]!.content.toString(), '1209876543210');
      assert.match(parts[1]!.headers, /name="file"; filename="screenshot.png"/);
      assert.ok(parts[1]!.content.equals(Buffer.from(BINARY)), 'file bytes arrive unchanged, including 0x80-0xff');
      assert.equal(output.ok, true);
      assert.equal(output.status, 200);
      assert.equal(output.byteLength, BINARY.byteLength);
      assert.equal(output.response.data.permalink_url, 'https://app.asana.com/0/0/555');
      assert.doesNotMatch(JSON.stringify(output), new RegExp(TOKEN));
    },
  );
});

test('the tool refuses hosts, paths, methods, and schemes the connection does not allow', async () => {
  const run = uploadTool(PNG_FILE);
  await withStubbedNetwork(() => new Response('{}'), async (requests) => {
    const cases: [Record<string, unknown>, string][] = [
      [{ url: 'https://evil.example/api/1.0/attachments' }, 'url_not_allowed'],
      [{ url: 'https://app.asana.com/api/2.0/attachments' }, 'url_not_allowed'],
      [{ url: 'https://app.asana.com/api/1.0x/attachments' }, 'url_not_allowed'],
      [{ url: 'http://app.asana.com/api/1.0/attachments' }, 'url_not_allowed'],
      [{ url: 'https://user:pw@app.asana.com/api/1.0/attachments' }, 'url_not_allowed'],
      [{ url: 'https://app.asana.com/api/1.0/attachments', method: 'PATCH' }, 'method_not_allowed'],
    ];
    for (const [input, reason] of cases) {
      const output = await run({ file: 'saved:00000000-0000-4000-8000-000000000001', ...input });
      assert.equal(output.ok, false, JSON.stringify(input));
      assert.equal(output.sent, false);
      assert.equal(output.reason, reason, JSON.stringify(input));
    }
    assert.equal(requests.length, 0, 'no refused request reached the network');
  });
});

test('a redirect off the connection host is reported and never followed', async () => {
  const run = uploadTool(PNG_FILE);
  await withStubbedNetwork(
    (request) => request.url.startsWith('https://app.asana.com/')
      ? new Response(null, { status: 307, headers: { location: 'https://evil.example/collect' } })
      : new Response('stolen'),
    async (requests) => {
      const output = await run({
        file: 'saved:00000000-0000-4000-8000-000000000001',
        url: 'https://app.asana.com/api/1.0/attachments',
      });
      assert.deepEqual(requests.map((request) => request.url), ['https://app.asana.com/api/1.0/attachments']);
      assert.equal(output.ok, false);
      assert.equal(output.status, 307);
      assert.match(output.note, /does not follow redirects/);
    },
  );
});

test('a streamed recording goes to the platform fetch as a stream with its exact length', async () => {
  const chunks = [BINARY, BINARY, BINARY];
  const source = countingSource(chunks);
  const run = uploadTool(async () => ({
    ok: true,
    file: { filename: 'browser-session.mp4', contentType: 'video/mp4', content: { stream: source.stream, byteLength: BINARY.byteLength * 3 } },
  }));
  await withStubbedNetwork(() => Response.json({ data: { gid: '9' } }), async (requests) => {
    const output = await run({
      file: 'rec:00000000-0000-4000-8000-000000000002',
      url: 'https://app.asana.com/api/1.0/attachments',
      fields: { parent: '7' },
    });
    assert.equal(output.ok, true);
    const [request] = requests;
    assert.ok(request!.rawBody instanceof ReadableStream, 'the body is streamed, not assembled in memory');
    assert.equal(Number(request!.headers.get('content-length')), request!.body!.byteLength);
    const parts = parseMultipart(request!.body!, request!.headers.get('content-type')!);
    assert.ok(parts[1]!.content.equals(Buffer.from(concat(chunks))));
  });
});

test('raw encoding sends the file itself as the request body', async () => {
  const run = uploadTool(PNG_FILE);
  await withStubbedNetwork(() => Response.json({ ok: true }), async (requests) => {
    await run({
      file: 'saved:00000000-0000-4000-8000-000000000001',
      url: 'https://app.asana.com/api/1.0/attachments',
      encoding: 'raw',
      method: 'PUT',
    });
    assert.equal(requests[0]!.method, 'PUT');
    assert.equal(requests[0]!.headers.get('content-type'), 'image/png');
    assert.deepEqual(requests[0]!.body, BINARY);
  });
});

test('an unavailable handle or missing connection is refused before any request', async () => {
  await withStubbedNetwork(() => new Response('{}'), async (requests) => {
    const missing = await uploadTool(async () => ({ ok: false, detail: 'expired_or_unavailable' }))({
      file: 'saved:00000000-0000-4000-8000-000000000001',
      url: 'https://app.asana.com/api/1.0/attachments',
    });
    assert.equal(missing.reason, 'file_unavailable');
    assert.equal(missing.detail, 'expired_or_unavailable');
    const noConnection = await uploadTool(PNG_FILE, { resolveFetch: async () => undefined })({
      file: 'img:1',
      url: 'https://app.asana.com/api/1.0/attachments',
    });
    assert.equal(noConnection.reason, 'no_connection');
    assert.equal(requests.length, 0);
  });
  // The call is bounded as a whole, beyond the request's own timeout.
  const bounded = createAttachFileToConnectionTool({ resolveFetch: async () => undefined, resolveFile: PNG_FILE, streamMode: 'stream' });
  assert.equal((bounded as { timeoutMs?: number }).timeoutMs, CONNECTION_UPLOAD_TOOL_TIMEOUT_MS);
  assert.ok(CONNECTION_UPLOAD_TOOL_TIMEOUT_MS > CONNECTION_UPLOAD_TIMEOUT_MS + RECORDING_TIMEOUT_MS);
  assert.throws(() => v.parse(
    createAttachFileToConnectionTool({ resolveFetch: async () => undefined, resolveFile: PNG_FILE, streamMode: 'stream' }).input as v.GenericSchema,
    { file: 'F0123456789', url: 'https://app.asana.com/api/1.0/attachments' },
  ));
});

const DESTINATION = { workspaceId: 'T1', agentId: 'agent_a', channelId: 'C1', threadTs: '1789000000.000100' };

test('saved and recording handles resolve only in their own thread and Agent, and expire', async () => {
  let now = Date.UTC(2026, 8, 23);
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const images = createImageOutputStore(settings, DESTINATION, () => now);
    const recordings = createRecordingHandleStore(settings, DESTINATION, () => now);
    const saved = await images.save(BINARY, { format: 'png', source: 'browser_screenshot' });
    const recording = await recordings.save({ sessionId: 'sess-1', filename: 'browser-session.mp4', byteLength: 3 });
    const opened: string[] = [];
    const sources = (destination: object) => ({
      images: createImageOutputStore(settings, destination, () => now),
      recordings: createRecordingHandleStore(settings, destination, () => now),
      openRecording: async (sessionId: string) => {
        opened.push(sessionId);
        return { stream: countingSource([new Uint8Array(3)]).stream, byteLength: 3 };
      },
    });

    const own = await resolveUploadFile(saved.id, sources(DESTINATION));
    assert.equal(own.ok, true);
    assert.ok(own.ok && own.file.filename === 'screenshot.png' && own.file.contentType === 'image/png');
    assert.deepEqual(own.ok && own.file.content, BINARY);
    const ownRecording = await resolveUploadFile(recording.id, sources(DESTINATION));
    assert.ok(ownRecording.ok && !(ownRecording.file.content instanceof Uint8Array), 'a recording resolves to a stream');
    assert.deepEqual(opened, ['sess-1']);

    for (const other of [
      { ...DESTINATION, threadTs: '1789000000.000200' },
      { ...DESTINATION, agentId: 'agent_b' },
      { ...DESTINATION, channelId: 'C2' },
    ]) {
      assert.deepEqual(await resolveUploadFile(saved.id, sources(other)), { ok: false, detail: 'expired_or_unavailable' });
      assert.deepEqual(await resolveUploadFile(recording.id, sources(other)), { ok: false, detail: 'expired_or_unavailable' });
    }
    assert.deepEqual(opened, ['sess-1'], 'a foreign handle never reaches the provider');

    now += Math.max(IMAGE_RETENTION_MS, RECORDING_RETENTION_MS) + 1;
    assert.deepEqual(await resolveUploadFile(saved.id, sources(DESTINATION)), { ok: false, detail: 'expired_or_unavailable' });
    assert.deepEqual(await resolveUploadFile(recording.id, sources(DESTINATION)), { ok: false, detail: 'expired_or_unavailable' });
  } finally {
    settings.close();
  }
});

test('img handles resolve only against this conversation inventory', async () => {
  const conversationKey = 'T1:C1:1789000000.000100';
  const inventory = buildThreadImageInventory({
    conversationKey,
    threadRecords: [{
      conversationKey, fileId: 'F0123456789', filename: 'bug.png', mimeType: 'image/png',
      origin: 'person', messageTs: '1789000000.000150',
    }],
  });
  const reads: string[] = [];
  const sources = {
    inventory,
    createImageReader: async () => ({
      read: async (record: { fileId: string; filename: string; mimeType: string }) => {
        reads.push(record.fileId);
        return { ok: true as const, bytes: BINARY, mimeType: record.mimeType, filename: record.filename };
      },
    }),
  };
  const own = await resolveUploadFile('img:1', sources);
  assert.ok(own.ok && own.file.filename === 'bug.png');
  assert.deepEqual(await resolveUploadFile('img:2', sources), { ok: false, detail: 'not_found' });
  const foreign = buildThreadImageInventory({
    conversationKey: 'T1:C1:1789000000.000999',
    threadRecords: [{
      conversationKey, fileId: 'F0123456789', filename: 'bug.png', mimeType: 'image/png',
      origin: 'person', messageTs: '1789000000.000150',
    }],
  });
  assert.deepEqual(await resolveUploadFile('img:1', { ...sources, inventory: foreign }), { ok: false, detail: 'not_found' });
  assert.deepEqual(reads, ['F0123456789']);
});

test('a recording is re-opened from the provider as a stream when its length is declared', async () => {
  const { provider } = fakeBrowserProvider({
    async listRecordingDownloads() {
      return [{ pageId: 'p1', status: 'COMPLETED', downloadUrl: 'https://recordings.example/sess-1.mp4?sig=abc' }];
    },
  });
  let response: Response | undefined;
  const content = await openRecordingDownload(provider, 'sess-1', {
    fetch: (async () => {
      response = new Response(countingSource([BINARY]).stream, { headers: { 'content-length': String(BINARY.byteLength) } });
      return response;
    }) as typeof fetch,
    sleep: async () => undefined,
  });
  assert.ok(content && !(content instanceof Uint8Array));
  assert.equal(content.byteLength, BINARY.byteLength);
  assert.equal(response!.bodyUsed, false, 'the download is handed on unread');
  assert.deepEqual(await bodyBytes(content.stream), BINARY);
});

const PLAN: RuntimePlanV2 = {
  schemaVersion: 2,
  continuityPolicy: 'synthetic-test',
  agentId: 'agent_upload',
  conversation: {
    workspaceId: 'T12345678',
    channelId: 'C12345678',
    threadTs: '1789000000.000100',
    surface: 'channel_thread',
    continuityKey: `agent_${'a1b2c3d4'.repeat(5)}`,
  },
  model: 'faux/upload-tool',
  instructions: 'Answer the request.',
  memoryEpoch: 1,
  skills: [],
  mcpConnections: [],
  apiConnections: [],
  repositories: [],
  sandbox: { mode: 'bash' },
  artifactDestination: { kind: 'slack_conversation', channelId: 'C12345678', threadTs: '1789000000.000100' },
  harnessRevision: 'f'.repeat(64),
};

function connection(methods: string[]): RuntimePlanV2['apiConnections'][number] {
  return {
    id: 'conn_asana', presetId: 'asana', allowedHosts: ['app.asana.com'], pathPrefixes: ['/api/1.0'],
    allowedMethods: methods, headerName: 'Authorization', headerValuePrefix: 'Bearer ', authMode: 'credential',
  };
}

test('the upload tool mounts only with a writable API connection its actor can use', () => {
  const accumulator = createArtifactReceiptAccumulator((update) => {
    update({ schemaVersion: 1, receipts: [] });
  });
  const mounted = (plan: RuntimePlanV2) => createRuntimePlanArtifactTools(plan, accumulator, () => {})
    .some((tool) => tool.name === ATTACH_FILE_TO_CONNECTION_TOOL_NAME);
  const actor = { actorMembershipId: 'mem_1' };
  assert.equal(mounted({ ...PLAN, ...actor }), false, 'no connection');
  assert.equal(mounted({ ...PLAN, ...actor, apiConnections: [connection(['GET', 'HEAD'])] }), false, 'read-only connection');
  assert.equal(mounted({ ...PLAN, apiConnections: [connection(['GET', 'POST'])] }), false, 'no actor to resolve credentials');
  assert.equal(mounted({ ...PLAN, ...actor, apiConnections: [connection(['GET', 'POST', 'PUT'])] }), true);
  assert.equal(mounted({ ...PLAN, ...actor, apiConnections: [connection(['get', 'patch'])] }), true);
});

test('planAllowsConnectionFileUpload needs an actor and a writable API connection', () => {
  const writable = [{ allowedMethods: ['GET', 'post'] }];
  assert.equal(planAllowsConnectionFileUpload({ actorMembershipId: 'mem_1', apiConnections: writable }), true);
  assert.equal(planAllowsConnectionFileUpload({ apiConnections: writable }), false);
  assert.equal(planAllowsConnectionFileUpload({ actorMembershipId: 'mem_1', apiConnections: [{ allowedMethods: ['GET'] }] }), false);
  assert.equal(planAllowsConnectionFileUpload({ actorMembershipId: 'mem_1', apiConnections: [] }), false);
});
