import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ErrorCode, type WebClient } from '@slack/web-api';
import { WebClientPresenter, deliverPersistedSlackPayload, rejectedFileFallbackPayload } from '../src/slack/web-client-presenter.ts';
import type { SlackArtifactReceipt } from '../src/slack/artifact-receipts.ts';
import type { SlackFileCompletionInput, SlackFileTransport } from '../src/slack/file-transport.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import { resultFromAgentReply } from '../src/slack/flue-dispatch.ts';
import type { AgentReply } from '@flue/runtime';

const target = { workspaceId: 'T12345678', channelId: 'D12345678', threadTs: '1789063000.000100', agentId: 'agent_smoke', agentName: 'Smoke Amber', agentAvatarUrl: 'https://example.com/smoke.png' };
const receipt: SlackArtifactReceipt = {
  schemaVersion: 1, fileId: 'F12345678', filename: 'bookings.png', title: 'Bookings', kind: 'chart', byteLength: 123, stagedAt: 1,
  destination: { workspaceId: target.workspaceId, channelId: target.channelId, threadTs: target.threadTs, agentId: target.agentId },
};
const ts = '1789063001.000200';

function setup(options: { error?: unknown; unresolved?: boolean; ledger?: boolean } = {}) {
  const completions: SlackFileCompletionInput[] = [];
  const posts: Record<string, unknown>[] = [];
  const observations: { phase: string; [key: string]: unknown }[] = [];
  const handoffs: unknown[] = [];
  const client = { chat: { async postMessage(input: Record<string, unknown>) { posts.push(input); return { ok: true, ts }; } } } as unknown as WebClient;
  const transport: SlackFileTransport = {
    async stage() { throw new Error('Final delivery must not stage again'); },
    async complete(input) {
      completions.push(input);
      if (options.error) throw options.error;
      return {};
    },
    async resolveShare() { return options.unresolved ? { shared: false } : { shared: true, channelId: target.channelId, ts }; },
  };
  const presenter = new WebClientPresenter(client, target, {
    async beforeDelivery(input) { observations.push({ phase: 'before', ...input }); return `attempt-${observations.length}`; },
    async afterDelivery(input) { observations.push({ phase: 'after', ...input }); },
  }, { fileTransport: transport, deliverySafety: options.ledger ? 'ledger' : 'legacy', onPublicDelivery(input) { handoffs.push(input); } });
  return { presenter, completions, posts, observations, handoffs };
}

test('PNG and final text publish together with the selected Agent identity and one ownership receipt', async () => {
  const h = setup({ ledger: true });
  await h.presenter.deliverFinal('GRE: $2,400', 'markdown', 'complete', undefined, [receipt]);
  assert.equal(h.completions.length, 1);
  assert.equal(h.posts.length, 0);
  assert.deepEqual(h.completions[0]!.persona, { username: 'Smoke Amber', icon_url: target.agentAvatarUrl });
  assert.deepEqual(h.completions[0]!.files, [{ id: receipt.fileId, title: 'Bookings' }]);
  assert.match(JSON.stringify(h.completions[0]!.blocks), /GRE: \$2,400/);
  assert.match(JSON.stringify(h.completions[0]!.blocks), /Smoke Amber/);
  assert.deepEqual(h.handoffs, [{ messageTs: ts, text: 'GRE: $2,400' }]);
  assert.equal(h.observations.at(-1)!.outcome, 'delivered');
});

for (const error of [new SlackTransportError('files.completeUploadExternal', 'slack_completion_outcome_unknown'), { code: ErrorCode.PlatformError, data: { error: 'internal_error' } }]) {
  for (const ledger of [true, false]) {
    test(`uncertain completion never posts a replacement (ledger=${ledger}, error=${JSON.stringify(error)})`, async () => {
      const h = setup({ error, ledger });
      await assert.rejects(h.presenter.deliverFinal('Chart ready.', 'markdown', 'complete', undefined, [receipt]));
      assert.equal(h.completions.length, 1);
      assert.equal(h.posts.length, 0);
      assert.equal(h.handoffs.length, 0);
      assert.equal(h.observations.at(-1)!.outcome, 'unknown');
    });
  }
}

test('known rejection keeps immutable approved output while rendering an honest fallback', async () => {
  const h = setup({ ledger: true, error: new SlackTransportError('files.completeUploadExternal', 'missing_scope') });
  await h.presenter.deliverFinal('GRE: $2,400', 'markdown', 'complete', undefined, [receipt]);
  assert.equal(h.completions.length, 1);
  assert.equal(h.posts.length, 1);
  assert.match(JSON.stringify(h.posts[0]), /could not deliver the requested file attachment/);
  assert.deepEqual(h.observations.filter((event) => event.phase === 'before').map((event) => event.approvedOutput), ['GRE: $2,400', 'GRE: $2,400']);
  const raw = h.observations.find((event) => event.phase === 'before')!.renderedPayload as string;
  assert.deepEqual(JSON.parse(rejectedFileFallbackPayload(raw)).payload, h.posts[0]);
});

test('unresolved coordinates stay unknown after one completion and mismatched destinations fail before publication', async () => {
  const h = setup({ unresolved: true });
  await assert.rejects(h.presenter.deliverFinal('Chart ready.', 'markdown', 'complete', undefined, [receipt]), /share_unresolved/);
  assert.equal(h.completions.length, 1);
  assert.equal(h.posts.length, 0);
  assert.equal(h.observations.at(-1)!.outcome, 'unknown');
  const wrong = setup();
  await assert.rejects(wrong.presenter.deliverFinal('Chart ready.', 'markdown', 'complete', undefined, [{ ...receipt, destination: { ...receipt.destination, agentId: 'agent_other' } }]));
  assert.equal(wrong.completions.length, 0);
  assert.equal(wrong.posts.length, 0);
});

test('persisted completion replay only reads exact file shares and never treats absence as a rejection', async () => {
  const h = setup();
  await h.presenter.deliverFinal('Chart ready.', 'markdown', 'complete', undefined, [receipt]);
  const raw = h.observations.find((event) => event.phase === 'before')!.renderedPayload as string;
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

test('file-only settled replies retain their host-authored receipts', () => {
  const result = resultFromAgentReply({ submissionId: 'submission_files', text: '', data: { slackArtifactReceipts: [{ schemaVersion: 1, receipts: [receipt] }] } } as unknown as AgentReply, null);
  assert.deepEqual(result.artifacts, [receipt]);
  assert.equal(result.text, 'Requested files');
});
