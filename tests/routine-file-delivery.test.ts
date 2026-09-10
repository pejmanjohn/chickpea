import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ErrorCode, type WebClient } from '@slack/web-api';
import { canonicalSlackReplyText } from '../src/slack/message-format.ts';
import { deliverRoutineResult } from '../src/routines/delivery.ts';
import type { RoutineDefinition, RoutineRun, RoutineStore } from '../src/routines/types.ts';
import type { RoutineRuntimeAccess } from '../src/routines/runtime.ts';
import type { CompletedSlackArtifactReceipt, SlackArtifactReceipt } from '../src/slack/artifact-receipts.ts';
import type { SlackFileTransport } from '../src/slack/file-transport.ts';
import { ARTIFACT_UNDELIVERED_NOTE } from '../src/slack/web-client-presenter.ts';
import type { ShadowWorkLifecycle } from '../src/work/lifecycle.ts';

const now = 1789063303000;
const messageTs = '1789063305.000200';
const avatarUrl = 'https://example.com/smoke-amber.png';
type Payload = Record<string, unknown>;

function fileBody(input: Payload): string {
  return (input.blocks as Array<{ type: string; text?: { text: string } }> ?? [])
    .filter((block) => block.type === 'section').map((block) => block.text!.text).join('\n');
}
function setup(kind: 'root' | 'thread' | 'direct' = 'root') {
  const channelId = kind === 'direct' ? 'D12345678' : 'C12345678';
  const threadTs = kind === 'root' ? undefined : '1789063300.000100';
  const routine = { id: 'routine_file', workspaceId: 'T12345678', channelId,
    destination: { kind: kind === 'direct' ? 'direct_thread' : 'channel', ...(threadTs ? { threadTs } : {}) },
    agentId: 'agent_smoke' } as unknown as RoutineDefinition;
  const run = { id: 'run_file', deadlineAt: now + 60_000 } as RoutineRun;
  const access = { config: { agentId: 'agent_smoke', agent: { id: 'agent_smoke', name: 'Smoke Amber',
    slackPresence: { avatar: { url: avatarUrl } } }, model: 'openai/test' }, publicUrl: 'https://example.com' } as RoutineRuntimeAccess;
  const completedFiles: CompletedSlackArtifactReceipt[] = ['png', 'csv'].map((extension, index) => ({
    schemaVersion: 2, fileId: `F1234567${index}`, filename: `scheduled.${extension}`,
    kind: extension === 'png' ? 'chart' : 'file', byteLength: 100, stagedAt: now - 1, completedAt: now,
    permalink: `https://example.slack.com/files/U12345678/F1234567${index}/scheduled.${extension}`,
    destination: { workspaceId: routine.workspaceId, agentId: 'agent_smoke', channelId, ...(threadTs ? { threadTs } : {}) },
  }));
  const files: SlackArtifactReceipt[] = [...completedFiles];
  const posts: Payload[] = [];
  const records: Payload[] = [];
  const attempts: Payload[] = [];
  const events: string[] = [];
  const options: { postError?: unknown; response?: Payload; receiptError?: boolean } = {};
  let claimed = false;
  let approved: string | undefined;
  const store = {
    async claimDelivery() { events.push('claim'); if (claimed) return 'already_claimed'; claimed = true; return 'claimed'; },
    async recordDelivery(value: Payload) { events.push('record'); if (options.receiptError) throw new Error('receipt interrupted'); records.push(value); },
  } as unknown as RoutineStore;
  const workLifecycle = {
    async beforeDelivery(value: { approvedOutput: string }) {
      events.push('intent');
      if (approved !== undefined) assert.equal(value.approvedOutput, approved, 'approved output stays immutable');
      approved = value.approvedOutput; attempts.push(value); return 'attempt_file';
    },
    async afterDelivery(value: Payload) { events.push('outcome'); attempts.push(value); },
  } as unknown as ShadowWorkLifecycle;
  const transportCalls: string[] = [];
  const unavailable = (name: string) => async () => { transportCalls.push(name); throw new Error('delivery must not call file transport'); };
  const fileTransport = { stage: unavailable('stage'), stagePrivate: unavailable('stagePrivate'),
    complete: unavailable('complete'), resolveShare: unavailable('resolveShare') } as unknown as SlackFileTransport;
  const client = { chat: { async postMessage(payload: Payload) {
    events.push('post'); posts.push(payload);
    if (options.postError) throw options.postError;
    return options.response ?? { ok: true, channel: channelId, ts: messageTs };
  } } } as unknown as WebClient;
  const input = { store, run, routine, access, message: 'GRE: $2,400', changeKeyHash: 'synthetic-change-key',
    artifacts: files, fileTransport, workLifecycle, now: () => now };
  return { input, client, completedFiles, posts, records, attempts, events, options, transportCalls, channelId, threadTs };
}

function legacyFile(file: CompletedSlackArtifactReceipt): SlackArtifactReceipt {
  const { completedAt: _completedAt, permalink: _permalink, ...staged } = file;
  return { ...staged, schemaVersion: 1 };
}

for (const kind of ['root', 'thread', 'direct'] as const) {
  test(`scheduled ${kind} posts one customized mixed-file result at its saved destination`, async () => {
    const h = setup(kind);
    assert.deepEqual(await deliverRoutineResult(h.input, h.client), { channelId: h.channelId, messageTs });
    assert.equal(h.posts.length, 1);
    assert.deepEqual(h.transportCalls, []);
    const payload = h.posts[0]!;
    assert.equal(payload.channel, h.channelId);
    assert.equal(payload.thread_ts, h.threadTs);
    if (kind === 'root') assert.equal(Object.hasOwn(payload, 'thread_ts'), false);
    assert.equal(payload.username, 'Smoke Amber');
    assert.equal(payload.icon_url, avatarUrl);
    assert.equal(payload.unfurl_links, true);
    assert.equal(payload.unfurl_media, true);
    for (const file of h.completedFiles) {
      const label = `<${file.permalink}|${file.filename}>`;
      assert.ok(String(payload.text).includes(label));
      assert.ok(fileBody(payload).includes(label));
    }
    const blocks = payload.blocks as Array<{ type: string }>;
    assert.ok(blocks.every((block) => block.type === 'section' || block.type === 'context'));
    assert.equal(blocks.filter((block) => block.type === 'context').length, 1);
    assert.deepEqual(blocks.at(-1), { type: 'context', elements: [{ type: 'mrkdwn', text: 'Smoke Amber | openai/test | Scheduled' }] });
    assert.doesNotMatch(JSON.stringify(payload), /Configure/);
    const envelope = JSON.parse(h.attempts[0]!.renderedPayload as string);
    assert.equal(h.attempts[0]!.method, 'slack_chat_post_message');
    assert.equal(h.attempts[0]!.approvedOutput, h.input.message);
    assert.deepEqual(envelope, { method: 'slack_chat_post_message', payload });
    assert.equal(h.records[0]!.outcome, 'delivered');
    assert.equal(h.records[0]!.changeKeyHash, h.input.changeKeyHash);
    assert.deepEqual(h.events, ['claim', 'intent', 'post', 'record', 'outcome']);
    await assert.rejects(deliverRoutineResult(h.input, h.client));
    assert.equal(h.posts.length, 1, 'durable claim prevents a duplicate post');
  });
}

test('scheduled file sections retain long answers and tables while fallback preserves every file link', async () => {
  const h = setup();
  const prefix = 'x'.repeat(11_900);
  h.input.message = `${prefix}\n\n| Exam | Bookings |\n| --- | ---: |\n| GRE | $2,400 |\n| TOEFL | $800 |`;
  await deliverRoutineResult(h.input, h.client);
  const payload = h.posts[0]!;
  const body = fileBody(payload);
  assert.equal(body.slice(0, body.indexOf('Exam')).match(/x/g)?.length, 11_900);
  assert.match(body, /Exam — Bookings\nGRE — \$2,400\nTOEFL — \$800/);
  assert.doesNotMatch(body, /Configure|\[truncated\]/);
  assert.ok(String(payload.text).length <= 4_000);
  for (const file of h.completedFiles) assert.ok(String(payload.text).includes(`<${file.permalink}|${file.filename}>`));
  assert.equal(JSON.stringify(payload.blocks).match(/Scheduled/g)?.length, 1);
  assert.equal(h.posts.length, 1);
});

test('scheduled artifact messages preserve filenames and code literals', async () => {
  const h = setup();
  h.input.message = 'Attached `qa_artifacts_1531.csv`.\n\n```\nrow_total = x_i * y_j\n```';
  h.input.artifacts[1]!.filename = 'qa_artifacts_1531.csv';
  await deliverRoutineResult(h.input, h.client);
  assert.ok(fileBody(h.posts[0]!).startsWith(h.input.message));
  assert.ok(String(h.posts[0]!.text).includes('|qa_artifacts_1531.csv>'));
});

for (const mixed of [false, true]) {
  test(`scheduled legacy receipts produce one honest note${mixed ? ' alongside completed files' : ''}`, async () => {
    const h = setup();
    h.input.artifacts = mixed ? [h.completedFiles[0]!, legacyFile(h.completedFiles[1]!)] : h.completedFiles.map(legacyFile);
    await deliverRoutineResult(h.input, h.client);
    assert.deepEqual(h.transportCalls, []);
    assert.equal(h.posts.length, 1);
    const payload = h.posts[0]!;
    const rendered = JSON.stringify(payload.blocks);
    assert.equal(rendered.split(ARTIFACT_UNDELIVERED_NOTE).length - 1, 1);
    assert.equal(String(payload.text).split(ARTIFACT_UNDELIVERED_NOTE).length - 1, 1);
    assert.equal(payload.unfurl_links, mixed);
    assert.equal(payload.unfurl_media, mixed);
    assert.equal(rendered.includes(h.completedFiles[0]!.permalink), mixed);
    assert.equal(rendered.includes(h.completedFiles[1]!.permalink), false);
    assert.equal(h.attempts[0]!.approvedOutput, h.input.message);
    assert.equal(h.attempts[0]!.method, 'slack_chat_post_message');
    await assert.rejects(deliverRoutineResult(h.input, h.client));
    assert.equal(h.posts.length, 1);
  });
}

test('scheduled no-file messages retain disabled unfurls and ordinary rendering', async () => {
  const h = setup(); h.input.artifacts = [];
  await deliverRoutineResult(h.input, h.client);
  assert.equal(h.posts[0]!.unfurl_links, false);
  assert.equal(h.posts[0]!.unfurl_media, false);
  assert.doesNotMatch(JSON.stringify(h.posts[0]), /could not deliver the requested file attachment|\.slack\.com\/files/);
  assert.deepEqual(h.transportCalls, []);
});

test('a legacy attachment warning survives long-body limits in message and fallback text', async () => {
  const h = setup(); h.input.artifacts = h.completedFiles.map(legacyFile);
  h.input.message = 'x'.repeat(14_000);
  await deliverRoutineResult(h.input, h.client);
  const payload = h.posts[0]!;
  assert.ok(String(payload.text).startsWith(ARTIFACT_UNDELIVERED_NOTE));
  assert.ok(JSON.stringify(payload.blocks).includes(ARTIFACT_UNDELIVERED_NOTE));
  assert.equal(h.attempts[0]!.approvedOutput, canonicalSlackReplyText(h.input.message, 'markdown'));
  assert.deepEqual(h.transportCalls, []);
});

for (const code of ['internal_error', 'fatal_error', 'transport_error']) {
  test(`scheduled artifact post ${code} remains unknown and cannot be posted again`, async () => {
    const h = setup();
    h.options.postError = code === 'transport_error' ? new Error('connection interrupted') : { code: ErrorCode.PlatformError, data: { error: code } };
    await assert.rejects(deliverRoutineResult(h.input, h.client));
    assert.equal(h.records[0]!.outcome, 'unknown');
    assert.equal(h.attempts[1]!.outcome, 'unknown');
    await assert.rejects(deliverRoutineResult(h.input, h.client));
    assert.equal(h.posts.length, 1);
    assert.deepEqual(h.transportCalls, []);
  });
}

test('a definitive artifact post rejection records failure without another message', async () => {
  const h = setup('direct'); h.options.postError = { code: ErrorCode.PlatformError, data: { error: 'cannot_reply_to_message' } };
  await assert.rejects(deliverRoutineResult(h.input, h.client));
  assert.equal(h.records[0]!.outcome, 'failed');
  assert.equal(h.records[0]!.failureClass, 'direct_thread_unavailable');
  await assert.rejects(deliverRoutineResult(h.input, h.client));
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.transportCalls, []);
});

for (const response of [{ ok: true, channel: 'C12345678' }, { ok: true, channel: 'C87654321', ts: messageTs }]) {
  test(`an incomplete or wrong-destination post receipt stays unknown: ${JSON.stringify(response)}`, async () => {
    const h = setup(); h.options.response = response;
    await assert.rejects(deliverRoutineResult(h.input, h.client));
    assert.equal(h.records[0]!.outcome, 'unknown');
    await assert.rejects(deliverRoutineResult(h.input, h.client));
    assert.equal(h.posts.length, 1);
  });
}

test('a crash recording the artifact post receipt preserves the claim and prevents a duplicate', async () => {
  const h = setup(); h.options.receiptError = true;
  await assert.rejects(deliverRoutineResult(h.input, h.client));
  assert.equal(h.attempts.at(-1)!.safeFailureCode, 'delivery_receipt_persist_unknown');
  h.options.receiptError = false;
  await assert.rejects(deliverRoutineResult(h.input, h.client));
  assert.equal(h.posts.length, 1);
});

for (const mismatch of ['workspaceId', 'agentId', 'channelId', 'threadTs'] as const) {
  test(`scheduled artifact ${mismatch} mismatch fails before claiming or posting`, async () => {
    const h = setup('thread'); h.input.artifacts[0]!.destination[mismatch] = 'different';
    await assert.rejects(deliverRoutineResult(h.input, h.client));
    assert.deepEqual(h.events, []);
    assert.deepEqual(h.transportCalls, []);
    assert.equal(h.posts.length, 0);
  });
}
