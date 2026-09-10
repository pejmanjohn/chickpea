import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ErrorCode, type WebClient } from '@slack/web-api';
import { ARTIFACT_UNDELIVERED_NOTE, WebClientPresenter, deliverPersistedSlackPayload, rejectedFileFallbackPayload } from '../src/slack/web-client-presenter.ts';
import type { CompletedSlackArtifactReceipt, SlackArtifactReceipt } from '../src/slack/artifact-receipts.ts';
import type { SlackFileCompletionInput, SlackFileTransport } from '../src/slack/file-transport.ts';
import type { SlackAgentViewPresentation } from '../src/slack/agent-view-presentation.ts';
import { slackClientMessageId } from '../src/slack/transport/message-id.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import { resultFromAgentReply } from '../src/slack/flue-dispatch.ts';
import type { AgentReply } from '@flue/runtime';

const target = { workspaceId: 'T12345678', channelId: 'D12345678', threadTs: '1789063000.000100', userId: 'U12345678', agentId: 'agent_smoke', agentName: 'Smoke Amber', agentAvatarUrl: 'https://example.com/smoke.png', publicUrl: 'https://example.com', modelLabel: 'openai/test' };
const legacyReceipt: SlackArtifactReceipt = {
  schemaVersion: 1, fileId: 'F12345678', filename: 'bookings.png', title: 'Bookings', kind: 'chart', byteLength: 123, stagedAt: 1,
  destination: { workspaceId: target.workspaceId, channelId: target.channelId, threadTs: target.threadTs, agentId: target.agentId },
};
const receipt: CompletedSlackArtifactReceipt = {
  ...legacyReceipt, schemaVersion: 2, completedAt: 2,
  permalink: 'https://fixture.slack.com/files/U12345678/F12345678/bookings.png',
};
const ts = '1789063001.000200';

function messageBody(input: Record<string, unknown>): string {
  return (input.blocks as Array<{ type: string; text?: { text: string } }> ?? [])
    .filter((block) => block.type === 'section').map((block) => block.text!.text).join('');
}

function setup(options: { error?: unknown; ledger?: boolean; presentation?: SlackAgentViewPresentation } = {}) {
  const completions: SlackFileCompletionInput[] = [];
  const posts: Record<string, unknown>[] = [];
  const streams: string[] = [];
  const observations: { phase: string; [key: string]: unknown }[] = [];
  const handoffs: unknown[] = [];
  const client = { chat: {
    async postMessage(input: Record<string, unknown>) {
      posts.push(input);
      if (options.error) throw options.error;
      // Slack need not return message.files synchronously for permalink posts.
      return { ok: true, ts };
    },
    async startStream() { streams.push('start'); return { ok: true, ts }; },
    async stopStream() { streams.push('stop'); return { ok: true }; },
  } } as unknown as WebClient;
  const transport = {
    async stage() { throw new Error('Final delivery must not stage again'); },
    async stagePrivate() { throw new Error('Final delivery must not stage again'); },
    async complete(input: SlackFileCompletionInput) { completions.push(input); throw new Error('Final delivery must not complete files'); },
    async resolveShare() { throw new Error('New finals must not require a share read'); },
  } as SlackFileTransport;
  const presenter = new WebClientPresenter(client, target, {
    async beforeDelivery(input) { observations.push({ phase: 'before', ...input }); return `attempt-${observations.length}`; },
    async afterDelivery(input) { observations.push({ phase: 'after', ...input }); },
  }, { fileTransport: transport, deliverySafety: options.ledger ? 'ledger' : 'legacy',
    ...(options.presentation ? { agentViewPresentation: options.presentation } : {}),
    onPublicDelivery(input) { handoffs.push(input); } });
  return { presenter, completions, posts, streams, observations, handoffs };
}

for (const count of [1, 2, 10]) {
  test(`${count} completed files publish in one ordinary Agent message with one ownership receipt`, async () => {
    const h = setup({ ledger: true });
    const files = Array.from({ length: count }, (_, index): CompletedSlackArtifactReceipt => {
      const fileId = `F1234567${index}`;
      const filename = index === 0 ? 'bookings.png' : `bookings_${index}.csv`;
      return { ...receipt, fileId, filename, kind: index === 0 ? 'chart' : 'file',
        permalink: `https://fixture.slack.com/files/U12345678/${fileId}/${filename}` };
    });
    await h.presenter.deliverFinal('GRE: $2,400', 'markdown', 'complete', undefined, files);
    assert.equal(h.completions.length, 0);
    assert.deepEqual(h.streams, []);
    assert.equal(h.posts.length, 1);
    const post = h.posts[0]!;
    assert.equal(post.channel, target.channelId);
    assert.equal(post.thread_ts, target.threadTs);
    assert.equal(post.username, 'Smoke Amber');
    assert.equal(post.icon_url, target.agentAvatarUrl);
    assert.equal(post.unfurl_links, true);
    assert.equal(post.unfurl_media, true);
    const blocks = post.blocks as Array<{ type: string }>;
    assert.ok(blocks.every((block) => ['section', 'context'].includes(block.type)));
    assert.equal(blocks.filter((block) => block.type === 'context').length, 1);
    assert.deepEqual(blocks.at(-1), {
      type: 'context', elements: [{ type: 'mrkdwn', text: 'Smoke Amber | openai/test | <https://example.com/admin/agents/agent_smoke|Configure>' }],
    });
    for (const file of files) {
      const link = `<${file.permalink}|${file.filename}>`;
      assert.ok(String(post.text).includes(link));
      assert.ok(messageBody(post).includes(link));
    }
    assert.ok(messageBody(post).startsWith('GRE: $2,400'));
    assert.equal(h.observations.filter((event) => event.phase === 'before').length, 1);
    assert.deepEqual(JSON.parse(h.observations[0]!.renderedPayload as string), { method: 'slack_chat_post_message', payload: post });
    assert.equal(h.observations[0]!.approvedOutput, 'GRE: $2,400');
    assert.deepEqual(h.handoffs, [{ messageTs: ts, text: 'GRE: $2,400' }]);
    assert.equal(h.observations.at(-1)!.outcome, 'delivered');
  });
}

test('artifact final retains the existing presentation fallback coordinate and operation envelope', async () => {
  const state: unknown[] = [];
  const presentation = {
    async finalize(...args: unknown[]) { state.push(['finalize', args[5]]); return { handled: false, fallbackPresentation: true, operationId: 'file-final-operation' }; },
    async markFallbackDelivered(messageTs: string) { state.push(['delivered', messageTs]); },
    async markFallbackDeliveryFailed(outcome: string) { state.push(['failed', outcome]); },
  } as unknown as SlackAgentViewPresentation;
  const h = setup({ ledger: true, presentation });
  await h.presenter.deliverFinal('GRE: $2,400', 'markdown', 'complete', undefined, [receipt]);
  assert.deepEqual(state, [['finalize', [receipt]], ['delivered', ts]]);
  assert.equal(h.posts[0]!.client_msg_id, slackClientMessageId('file-final-operation'));
  assert.deepEqual(h.streams, []);
});

test('a final without files keeps the existing stream path', async () => {
  const h = setup({ ledger: true });
  await h.presenter.deliverFinal('GRE: $2,400', 'markdown');
  assert.deepEqual(h.streams, ['start', 'stop']);
  assert.equal(h.posts.length, 0);
  assert.equal(h.completions.length, 0);
  assert.equal(h.observations[0]!.method, 'slack_chat_stream');
});

test('file sections preserve a full-length answer and readable native table rows', async () => {
  const h = setup();
  const lastFigure = '\nFinal figure: $2,400';
  const answer = `${'x'.repeat(12_000 - lastFigure.length)}${lastFigure}`;
  await h.presenter.deliverFinal(answer, 'markdown', 'complete', {
    caption: 'Bookings by exam', presentation: 'static',
    columns: [{ header: 'Exam' }, { header: 'Bookings', type: 'number' }],
    rows: Array.from({ length: 7 }, (_, index) => [`Exam ${index + 1}`, 2400 - index * 100]),
  }, [receipt]);
  const body = messageBody(h.posts[0]!);
  assert.ok(body.startsWith(answer));
  assert.match(body, /Bookings by exam\nExam: Exam 1 \| Bookings: 2400/);
  assert.match(body, /Exam: Exam 7 \| Bookings: 1800/);
  assert.equal(h.posts.length, 1);
  assert.equal(h.completions.length, 0);
});

test('interactive file message preserves the exact named file and code literals', async () => {
  const h = setup();
  const answer = 'Attached `qa_artifacts_1531.csv`.\n\n```\nrow_total = x_i * y_j\n```';
  const file: CompletedSlackArtifactReceipt = { ...receipt, filename: 'qa_artifacts_1531.csv', kind: 'file' };
  await h.presenter.deliverFinal(answer, 'markdown', 'complete', undefined, [file]);
  assert.ok(messageBody(h.posts[0]!).startsWith(answer));
  assert.ok(messageBody(h.posts[0]!).includes(`<${file.permalink}|qa_artifacts_1531.csv>`));
  assert.equal(h.posts.length, 1);
});

for (const error of [new SlackTransportError('chat.postMessage', 'gateway_network', { effectOutcome: 'unknown' }), { code: ErrorCode.PlatformError, data: { error: 'internal_error' } }]) {
  test(`uncertain artifact post uses the existing unknown-delivery outcome without a replacement (${JSON.stringify(error)})`, async () => {
    const h = setup({ error, ledger: true });
    await assert.rejects(h.presenter.deliverFinal('Chart ready.', 'markdown', 'complete', undefined, [receipt]));
    assert.equal(h.completions.length, 0);
    assert.equal(h.posts.length, 1);
    assert.deepEqual(h.streams, []);
    assert.equal(h.handoffs.length, 0);
    assert.equal(h.observations.at(-1)!.outcome, 'unknown');
    assert.equal(h.observations.at(-1)!.safeFailureCode, 'slack_post_unknown');
  });
}

test('rejected artifact post retains the ordinary post failure envelope and does not switch to a file share', async () => {
  const h = setup({ ledger: true, error: new SlackTransportError('chat.postMessage', 'missing_scope', { effectOutcome: 'failed' }) });
  await assert.rejects(h.presenter.deliverFinal('GRE: $2,400', 'markdown', 'complete', undefined, [receipt]));
  assert.equal(h.posts.length, 1);
  assert.equal(h.completions.length, 0);
  assert.equal(h.handoffs.length, 0);
  assert.equal(h.observations.at(-1)!.outcome, 'failed');
  assert.equal(h.observations.at(-1)!.safeFailureCode, 'slack_post_failed');
});

for (const mixed of [false, true]) {
  test(`legacy receipts add one undelivered note without completing files (mixed=${mixed})`, async () => {
    const h = setup({ ledger: true });
    const legacy = { ...legacyReceipt, fileId: 'F87654321' };
    await h.presenter.deliverFinal('GRE: $2,400', 'markdown', 'complete', undefined, mixed ? [legacy, receipt] : [legacy]);
    assert.equal(h.completions.length, 0);
    assert.deepEqual(h.streams, []);
    assert.equal(h.posts.length, 1);
    assert.equal(String(h.posts[0]!.text).split(ARTIFACT_UNDELIVERED_NOTE).length - 1, 1);
    assert.equal(JSON.stringify(h.posts[0]).includes(receipt.permalink), mixed);
    assert.deepEqual(h.observations.filter((event) => event.phase === 'before').map((event) => event.approvedOutput), ['GRE: $2,400']);
    assert.deepEqual(h.handoffs, [{ messageTs: ts, text: `${ARTIFACT_UNDELIVERED_NOTE}\n\nGRE: $2,400` }]);
  });
}

test('legacy attachment notice survives a bounded long answer', async () => {
  const h = setup({ ledger: true });
  const answer = 'x'.repeat(12_000);
  await h.presenter.deliverFinal(answer, 'markdown', 'complete', undefined, [legacyReceipt]);
  assert.ok(String(h.posts[0]!.text).startsWith(ARTIFACT_UNDELIVERED_NOTE));
  assert.equal(h.observations[0]!.approvedOutput, answer);
  assert.equal(h.posts.length, 1);
});

test('mismatched destinations fail before any publication or presentation effect', async () => {
  const h = setup();
  await assert.rejects(h.presenter.deliverFinal('Chart ready.', 'markdown', 'complete', undefined, [{ ...receipt, destination: { ...receipt.destination, agentId: 'agent_other' } }]));
  assert.equal(h.completions.length, 0);
  assert.equal(h.posts.length, 0);
  assert.deepEqual(h.streams, []);
  assert.deepEqual(h.observations, []);
});

function persistedLegacyCompletion(): string {
  return JSON.stringify({
    method: 'slack_files_complete',
    completion: { channel_id: target.channelId, thread_ts: target.threadTs, files: [{ id: legacyReceipt.fileId }], blocks: [] },
    rejectedFallback: { channel: target.channelId, thread_ts: target.threadTs, text: `Chart ready.\n\n${ARTIFACT_UNDELIVERED_NOTE}` },
    share: { channel: target.channelId, threadTs: target.threadTs, fileIds: [legacyReceipt.fileId] },
  });
}

test('persisted completion replay only reads exact file shares and never treats absence as a rejection', async () => {
  const raw = persistedLegacyCompletion();
  let reads = 0;
  let published = 0;
  let shared = true;
  const client = { files: {
    async info() { reads++; return { ok: true, file: { id: receipt.fileId, shares: shared ? { private: { [target.channelId]: [{ ts, thread_ts: target.threadTs }] } } : {} } }; },
    async completeUploadExternal() { published++; throw new Error('must not repeat completion'); },
  } } as unknown as WebClient;
  assert.equal((await deliverPersistedSlackPayload(client, raw)).deliveryRef, `slack:${target.channelId}:${ts}`);
  shared = false;
  await assert.rejects(deliverPersistedSlackPayload(client, raw), (error: any) => error.outcome === 'unknown');
  assert.equal(reads, 2);
  assert.equal(published, 0);
});

test('persisted confirmed rejection still selects its original stored fallback payload', () => {
  const raw = persistedLegacyCompletion();
  assert.deepEqual(JSON.parse(rejectedFileFallbackPayload(raw)), {
    method: 'slack_chat_post_message', payload: JSON.parse(raw).rejectedFallback,
  });
});

test('file-only settled replies retain their host-authored receipts', () => {
  const result = resultFromAgentReply({ submissionId: 'submission_files', text: '', data: { slackArtifactReceipts: [{ schemaVersion: 1, receipts: [receipt] }] } } as unknown as AgentReply, null);
  assert.deepEqual(result.artifacts, [receipt]);
  assert.equal(result.text, 'Requested files');
});
