import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ErrorCode, type WebClient } from '@slack/web-api';
import { deliverRoutineResult } from '../src/routines/delivery.ts';
import type { RoutineDefinition, RoutineRun, RoutineStore } from '../src/routines/types.ts';
import type { RoutineRuntimeAccess } from '../src/routines/runtime.ts';
import type { SlackArtifactReceipt } from '../src/slack/artifact-receipts.ts';
import type { SlackFileCompletionInput, SlackFileTransport } from '../src/slack/file-transport.ts';
import type { ShadowWorkLifecycle } from '../src/work/lifecycle.ts';

const now = 1789063303000;
function setup(kind: 'root' | 'thread' | 'direct' = 'root', error?: unknown) {
  const channelId = kind === 'direct' ? 'D12345678' : 'C12345678';
  const threadTs = kind === 'root' ? undefined : '1789063300.000100';
  const routine = { id: 'routine_file', workspaceId: 'T12345678', channelId, destination: { kind: kind === 'direct' ? 'direct_thread' : 'channel', ...(threadTs ? { threadTs } : {}) }, agentId: 'agent_smoke' } as unknown as RoutineDefinition;
  const run = { id: 'run_file', deadlineAt: now + 60_000 } as RoutineRun;
  const access = { config: { agentId: 'agent_smoke', agent: { id: 'agent_smoke', name: 'Smoke Amber' } }, publicUrl: 'https://example.com' } as RoutineRuntimeAccess;
  const files: SlackArtifactReceipt[] = [{ schemaVersion: 1, fileId: 'F12345678', filename: 'scheduled.png', kind: 'chart', byteLength: 100, stagedAt: now, destination: { workspaceId: routine.workspaceId, agentId: 'agent_smoke', channelId, ...(threadTs ? { threadTs } : {}) } }];
  const completions: SlackFileCompletionInput[] = [];
  const posts: unknown[] = [];
  const records: Record<string, unknown>[] = [];
  const attempts: Record<string, unknown>[] = [];
  let claimed = false;
  let approved: string | undefined;
  const store = { async claimDelivery() { if (claimed) return 'already_claimed'; claimed = true; return 'claimed'; }, async recordDelivery(value: Record<string, unknown>) { records.push(value); } } as unknown as RoutineStore;
  const workLifecycle = { async beforeDelivery(value: { approvedOutput: string }) {
    if (approved !== undefined) assert.equal(value.approvedOutput, approved, 'fallback must preserve immutable approved output');
    approved = value.approvedOutput; attempts.push(value); return 'attempt_file';
  }, async afterDelivery(value: Record<string, unknown>) { attempts.push(value); } } as unknown as ShadowWorkLifecycle;
  const fileTransport: SlackFileTransport = {
    async stage() { throw new Error('must not stage at delivery'); },
    async complete(input) { completions.push(input); if (error) throw error; return {}; },
    async resolveShare(input) { assert.equal(input.channelId, channelId); assert.equal(input.threadTs, threadTs); return { shared: true, channelId, ts: '1789063305.000200' }; },
  };
  const client = { chat: { async postMessage(input: unknown) { posts.push(input); return { ok: true, channel: channelId, ts: '1789063305.000200' }; } } } as unknown as WebClient;
  const input = { store, run, routine, access, message: 'GRE: $2,400', changeKeyHash: null, artifacts: files, fileTransport, workLifecycle, now: () => now };
  return { input, client, completions, posts, records, attempts, channelId, threadTs };
}

for (const kind of ['root', 'thread', 'direct'] as const) {
  test(`scheduled ${kind} publishes one Agent-authored file/result at its saved destination`, async () => {
    const h = setup(kind);
    assert.deepEqual(await deliverRoutineResult(h.input, h.client), { channelId: h.channelId, messageTs: '1789063305.000200' });
    assert.equal(h.completions.length, 1);
    assert.equal(h.posts.length, 0);
    assert.equal(h.completions[0]!.channelId, h.channelId);
    assert.equal(h.completions[0]!.threadTs, h.threadTs);
    assert.equal(h.completions[0]!.persona?.username, 'Smoke Amber');
    assert.match(JSON.stringify(h.completions[0]!.blocks), /GRE: \$2,400/);
    assert.equal(h.records[0]!.outcome, 'delivered');
    await assert.rejects(deliverRoutineResult(h.input, h.client));
    assert.equal(h.completions.length, 1, 'claim prevents duplicate completion');
  });
}

for (const code of ['internal_error', 'fatal_error']) {
  test(`scheduled ${code} remains unknown with no fallback post`, async () => {
    const h = setup('root', { code: ErrorCode.PlatformError, data: { error: code } });
    await assert.rejects(deliverRoutineResult(h.input, h.client));
    assert.equal(h.completions.length, 1);
    assert.equal(h.posts.length, 0);
    assert.equal(h.records[0]!.outcome, 'unknown');
  });
}

test('scheduled definite rejection renders fallback without changing approved output', async () => {
  const h = setup('root', { code: ErrorCode.PlatformError, data: { error: 'missing_scope' } });
  await deliverRoutineResult(h.input, h.client);
  assert.equal(h.completions.length, 1);
  assert.equal(h.posts.length, 1);
  assert.match(JSON.stringify(h.posts[0]), /could not deliver the requested file attachment/);
  assert.equal(h.records[0]!.outcome, 'delivered');
});

test('scheduled destination mismatch fails before any outward delivery', async () => {
  const h = setup('thread');
  h.input.artifacts[0]!.destination.workspaceId = 'T87654321';
  await assert.rejects(deliverRoutineResult(h.input, h.client));
  assert.equal(h.completions.length, 0);
  assert.equal(h.posts.length, 0);
});
