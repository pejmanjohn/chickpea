import assert from 'node:assert/strict';
import { test } from 'node:test';
import { posix } from 'node:path';
import type { SessionEnv } from '@flue/runtime';
import {
  createFileDeliveryCompletion, resolveFileDeliveryText, type FileDeliveryState,
} from '../src/slack/file-delivery-completion.ts';
import { MAX_ARTIFACT_BYTES, type ArtifactDestinationBinding, type SlackArtifactStageOutcome } from '../src/sandbox/artifact-tool.ts';
import { createArtifactReceiptAccumulator, type SlackArtifactReceipts } from '../src/slack/artifact-receipts.ts';

function setup(outcome?: SlackArtifactStageOutcome) {
  let state: FileDeliveryState = { pending: [], shellPending: false, generation: 0, outcomes: [], repairRequested: false };
  const discarded: string[] = [];
  const completion = createFileDeliveryCompletion((value) => {
    state = typeof value === 'function' ? value(state) : value;
  }, (ids) => discarded.push(...ids));
  const files = new Map<string, Uint8Array>();
  const uploads: { filename: string; bytes: Uint8Array }[] = [];
  const env = {
    cwd: '/home/user', resolvePath: (path: string) => posix.resolve('/home/user', path),
    async stat(path: string) { if (!files.has(path)) throw new Error('not found'); return { isFile: true, isDirectory: false, size: files.get(path)!.byteLength }; },
    async readFileBuffer(path: string) { return files.get(path)!.slice(); },
  } as SessionEnv;
  const binding: ArtifactDestinationBinding = {
    sandboxKind: 'bash', channel: 'C_BOUND', threadTs: '1789063000.000100',
    async stageArtifact(input) {
      uploads.push(input);
      return outcome ?? { attached: true, byteLength: input.bytes.byteLength, fileId: `F${uploads.length}` };
    },
  };
  function write(path: string, text: string | Uint8Array) {
    const absolute = env.resolvePath(path);
    files.set(absolute, typeof text === 'string' ? new TextEncoder().encode(text) : text);
    completion.mark(absolute);
  }
  return { completion, files, uploads, discarded, env, binding, write };
}

test('Markdown and arbitrary binary deliverables retain exact bytes; an unrelated receipt cannot cover a missing file', async () => {
  const h = setup();
  h.write('report.md', '# Report\nFinal result');
  h.write('export.custom', new Uint8Array([0, 255, 17]));
  await h.completion.deliver(h.env, { path: 'report.md', filename: 'report.md' }, h.binding);
  assert.equal(h.completion.unresolved(), true);
  await h.completion.complete(h.env, [
    { path: 'report.md', filename: 'report.md' }, { path: 'export.custom', filename: 'export.custom' },
  ], h.binding);
  assert.equal(h.completion.unresolved(), false);
  assert.equal(h.uploads.length, 2);
  assert.deepEqual(h.uploads[1]!.bytes, new Uint8Array([0, 255, 17]));
});

test('a revised same-path file replaces its prior receipt; repeated selection does not upload twice', async () => {
  const h = setup();
  h.write('report.md', 'first');
  const input = { path: 'report.md', filename: 'report.md' };
  await h.completion.deliver(h.env, input, h.binding);
  h.write('report.md', 'revised');
  await h.completion.complete(h.env, [input], h.binding);
  await h.completion.complete(h.env, [input], h.binding);
  assert.equal(h.uploads.length, 2);
  assert.deepEqual(h.discarded, ['F1']);
  assert.equal(new TextDecoder().decode(h.uploads[1]!.bytes), 'revised');
  assert.equal(h.completion.state().outcomes[0]!.fileId, 'F2');
});

test('same filename in different source paths never reuses another file receipt', async () => {
  const h = setup(); h.write('one/report.md', 'one'); h.write('two/report.md', 'two');
  await h.completion.complete(h.env, [
    { path: 'one/report.md', filename: 'report.md' }, { path: 'two/report.md', filename: 'report.md' },
  ], h.binding);
  assert.equal(h.uploads.length, 2); assert.deepEqual(h.discarded, []);
});

test('scratch and text-only selection never scans or uploads files, and excludes superseded selections', async () => {
  const h = setup(); h.write('private.txt', 'private'); h.completion.mark();
  await h.completion.complete(h.env, [], h.binding);
  assert.equal(h.completion.unresolved(), false); assert.equal(h.uploads.length, 0);
  h.write('report.md', 'draft');
  await h.completion.deliver(h.env, { path: 'report.md', filename: 'report.md' }, h.binding);
  await h.completion.complete(h.env, [], h.binding);
  assert.deepEqual(h.discarded, ['F1']);
  assert.deepEqual(h.completion.state().outcomes, []);
});

for (const outcome of [
  { attached: false, reason: 'missing-scope' },
  { attached: false, reason: 'unavailable' },
  { attached: false, reason: 'too-large', maxBytes: 700 },
] satisfies SlackArtifactStageOutcome[]) {
  test(`${outcome.reason} remains terminal for exact bytes, with honest bounded inline fallback`, async () => {
    const h = setup(outcome); h.write('report.md', '# Result\n42');
    const input = { path: 'report.md', filename: 'report.md' };
    await h.completion.deliver(h.env, input, h.binding);
    const checked = await h.completion.complete(h.env, [input], h.binding);
    if (outcome.reason === 'too-large') assert.deepEqual(checked.files[0], outcome);
    assert.equal(h.uploads.length, 1);
    const text = resolveFileDeliveryText('Successfully attached everything!', [{ unresolved: false, files: h.completion.state().outcomes }]);
    assert.doesNotMatch(text, /Successfully/); assert.match(text, /couldn't attach report.md/); assert.match(text, /42/);
  });
}

test('a disappeared revision removes its old receipt and does not claim old contents were attached', async () => {
  const h = setup(); h.write('report.md', 'first');
  const input = { path: 'report.md', filename: 'report.md' };
  await h.completion.deliver(h.env, input, h.binding);
  h.files.delete('/home/user/report.md'); h.completion.mark('/home/user/report.md');
  await h.completion.complete(h.env, [input], h.binding);
  assert.deepEqual(h.discarded, ['F1']);
  assert.equal(h.completion.state().outcomes[0]!.attached, false);
});

test('over-cap files fail before reading or staging, while other deliverables succeed', async () => {
  const h = setup(); h.write('huge.bin', new Uint8Array(MAX_ARTIFACT_BYTES + 1)); h.write('small.md', 'ok');
  await h.completion.complete(h.env, [{ path: 'huge.bin', filename: 'huge.bin' }, { path: 'small.md', filename: 'small.md' }], h.binding);
  assert.equal(h.uploads.length, 1);
  const text = resolveFileDeliveryText('done', [{ unresolved: false, files: h.completion.state().outcomes }]);
  assert.match(text, /attached the files I could deliver/); assert.match(text, /huge.bin because it exceeds/);
});

test('file work concurrent with selection stays unchecked and cannot publish a stale revision as complete', async () => {
  const h = setup(); h.write('report.md', 'first');
  const original = h.binding.stageArtifact;
  h.binding.stageArtifact = async (input) => { h.write('report.md', 'second'); return original(input); };
  const result = await h.completion.complete(h.env, [{ path: 'report.md', filename: 'report.md' }], h.binding);
  assert.equal(result.checked, false); assert.equal(h.completion.unresolved(), true);
});

test('removing a superseded receipt preserves unrelated image/file receipts', () => {
  let state = { schemaVersion: 1, receipts: [] } as SlackArtifactReceipts;
  const accumulator = createArtifactReceiptAccumulator((update) => { state = update(state); });
  for (const fileId of ['F1111111', 'F2222222']) accumulator.add({ schemaVersion: 1, fileId, filename: 'file.png', kind: 'image', byteLength: 3, stagedAt: 1,
    destination: { workspaceId: 'T1111111', agentId: 'agent_one', channelId: 'C1111111' } });
  assert.deepEqual(accumulator.remove(['F1111111']).map((receipt) => receipt.fileId), ['F2222222']);
});

test('malformed completion data fails closed; ordinary answers remain unchanged', () => {
  assert.equal(resolveFileDeliveryText('ordinary answer', undefined), 'ordinary answer');
  assert.throws(() => resolveFileDeliveryText('attached', [{}]), /invalid/);
  assert.match(resolveFileDeliveryText('Here is /home/user/report.md', [{ unresolved: true, files: [] }]), /couldn't finish checking/);
});
