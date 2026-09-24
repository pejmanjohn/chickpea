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
  let state: FileDeliveryState = { pending: [], shellPending: false, generation: 0, outcomes: [], repairRequested: false, stagingAttempted: false };
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
      uploads.push({ ...input, bytes: input.bytes as Uint8Array });
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

test('retained prepared files are refreshed after later file work even when omitted from the final selection', async () => {
  const h = setup(); h.write('report.md', 'first');
  await h.completion.deliver(h.env, { path: 'report.md', filename: 'report.md' }, h.binding);
  h.write('report.md', 'revised');
  await h.completion.complete(h.env, [], h.binding);
  assert.equal(h.uploads.length, 2);
  assert.deepEqual(h.discarded, ['F1']);
  assert.equal(new TextDecoder().decode(h.uploads[1]!.bytes), 'revised');
  h.completion.mark();
  await h.completion.complete(h.env, [], h.binding);
  assert.equal(h.uploads.length, 2);
});

test('scratch selection preserves prepared files; withdrawing a deliverable is explicit and reported', async () => {
  const h = setup(); h.write('private.txt', 'private'); h.completion.mark();
  await h.completion.complete(h.env, [], h.binding);
  assert.equal(h.completion.unresolved(), false); assert.equal(h.uploads.length, 0);
  h.write('report.md', 'draft');
  await h.completion.deliver(h.env, { path: 'report.md', filename: 'report.md' }, h.binding);
  const retained = await h.completion.complete(h.env, [], h.binding);
  assert.deepEqual(retained.retained, ['report.md']);
  assert.deepEqual(h.discarded, []);
  const withdrawn = await h.completion.complete(h.env, [], h.binding, ['report.md']);
  assert.deepEqual(withdrawn.discarded, ['report.md']);
  assert.deepEqual(h.discarded, ['F1']);
  assert.deepEqual(h.completion.state().outcomes, []);
});

test('correcting an unreadable path or invalid filename remains safe before any upload', async () => {
  const h = setup(); h.write('report.md', 'report');
  await assert.rejects(() => h.completion.deliver(h.env, { path: 'typo.md', filename: 'report.md' }, h.binding), /not found/);
  await assert.rejects(() => h.completion.deliver(h.env, { path: 'report.md', filename: 'bad\nname.md' }, h.binding), /control characters/);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.completion.state().stagingAttempted, false);
  await h.completion.deliver(h.env, { path: 'report.md', filename: 'report.md' }, h.binding);
  await h.completion.complete(h.env, [], h.binding);
  assert.equal(h.uploads.length, 1);
  assert.equal(resolveFileDeliveryText('The report is attached.', [{ unresolved: false, files: h.completion.state().outcomes }]), 'The report is attached.');
});

test('a bad path in final selection cannot prevent another file from being delivered', async () => {
  const h = setup(); h.write('report.md', 'report');
  const result = await h.completion.complete(h.env, [
    { path: 'missing.md', filename: 'missing.md' }, { path: 'report.md', filename: 'report.md' },
  ], h.binding);
  assert.equal(result.checked, false); assert.equal(h.completion.unresolved(), true); assert.equal(h.uploads.length, 1);
  assert.deepEqual(result.needsCorrection, [{ path: '/home/user/missing.md', filename: 'missing.md', detail: 'source_unavailable' }]);
  assert.deepEqual(result.files[0], { attached: false, reason: 'unavailable', detail: 'source_unavailable' });
  assert.equal(result.files[1]!.attached, true);
});

test('a missing selected source stays pending through an empty completion, then a corrected path retains good files', async () => {
  const h = setup(); h.write('actual.md', 'small'); h.write('other.csv', 'value\n1');
  const good = { path: 'other.csv', filename: 'other.csv' };
  await h.completion.complete(h.env, [{ path: 'typo.md', filename: 'small.md' }, good], h.binding);
  const omitted = await h.completion.complete(h.env, [], h.binding);
  assert.equal(omitted.checked, false);
  assert.deepEqual(omitted.retained, ['other.csv']);
  assert.equal(h.uploads.length, 1);
  const corrected = await h.completion.complete(h.env, [{ path: 'actual.md', filename: 'small.md' }], h.binding, ['typo.md']);
  assert.equal(corrected.checked, true);
  assert.deepEqual(corrected.needsCorrection, []);
  assert.deepEqual(corrected.retained, ['other.csv', 'small.md']);
  assert.equal(h.uploads.length, 2);
  assert.deepEqual(h.discarded, []);
});

test('an empty unavailable file has an honest fallback instead of an empty content block', async () => {
  const h = setup({ attached: false, reason: 'unavailable' }); h.write('empty.txt', '');
  await h.completion.complete(h.env, [{ path: 'empty.txt', filename: 'empty.txt' }], h.binding);
  const text = resolveFileDeliveryText('done', [{ unresolved: false, files: h.completion.state().outcomes }]);
  assert.match(text, /The file is empty/);
  assert.doesNotMatch(text, /```/);
});

test('an invalid source can be explicitly withdrawn without reading outside the workspace', async () => {
  const h = setup();
  const binding = { ...h.binding, sandboxKind: 'cloudflare' as const };
  const file = { path: '/tmp/mistaken.md', filename: 'report.md' };
  const failed = await h.completion.complete(h.env, [file], binding);
  assert.equal(failed.checked, false);
  await assert.rejects(() => h.completion.complete(h.env, [file], binding, [file.path]), /both selected and excluded/);
  const withdrawn = await h.completion.complete(h.env, [], binding, [file.path]);
  assert.equal(withdrawn.checked, true);
  assert.deepEqual(withdrawn.discarded, ['report.md']);
  assert.equal(h.uploads.length, 0);
});

test('relative Cloudflare filenames resolve to the same tracked workspace file', async () => {
  const h = setup();
  h.env.resolvePath = (path) => posix.resolve('/workspace', path);
  h.env.exec = async () => ({ stdout: '', stderr: '', exitCode: 0 });
  h.env.rm = async () => {};
  h.env.stat = async () => ({ isFile: true, isDirectory: false, size: 3 });
  h.env.readFileBuffer = async () => new Uint8Array([1, 2, 3]);
  h.write('report.md', 'yes');
  const result = await h.completion.complete(h.env, [{ path: 'report.md', filename: 'report.md' }], { ...h.binding, sandboxKind: 'cloudflare' });
  assert.equal(result.checked, true); assert.equal(result.files[0]!.attached, true);
  assert.equal(h.completion.state().outcomes[0]!.path, '/workspace/report.md');
  assert.equal(h.completion.unresolved(), false);
});

test('unavailable file size is never misreported as an exceeded limit', async () => {
  const h = setup(); h.write('report.md', 'yes');
  h.env.stat = async () => ({ isFile: true, isDirectory: false, size: -1 });
  const result = await h.completion.complete(h.env, [{ path: 'report.md', filename: 'report.md' }], h.binding);
  assert.deepEqual(result.files[0], { attached: false, reason: 'unavailable', detail: 'source_unavailable' });
  assert.equal(h.uploads.length, 0);
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

test('a file prepared from a coding workspace is re-read from that workspace at completion', async () => {
  const h = setup();
  const workspaceReads: string[] = [];
  const workspaceEnv = {
    cwd: '/workspace', resolvePath: (path: string) => posix.resolve('/workspace', path),
    async exec() { return { stdout: '', stderr: '', exitCode: 0 }; },
    async stat() { return { isFile: true, isDirectory: false, size: 3 }; },
    async readFileBuffer(path: string) { workspaceReads.push(path); return new Uint8Array([1, 2, 3]); },
    async rm() {},
  } as unknown as SessionEnv;
  const workspaces = { sandbox: async (name: string) => (name === 'main' ? workspaceEnv : undefined) };
  // post_artifact { workspace } delivers from the workspace.
  const first = await h.completion.deliver(workspaceEnv, { path: '/workspace/r2.sh', filename: 'r2.sh' },
    { ...h.binding, sandboxKind: 'cloudflare', sourceWorkspace: 'main' });
  assert.equal(first.attached, true);
  assert.equal(h.completion.state().outcomes[0]?.workspace, 'main');

  // Completion runs on the Agent's own virtual sandbox, where the path does
  // not exist; it must reuse the workspace receipt instead of failing it.
  const completed = await h.completion.complete(h.env, [{ path: '/workspace/r2.sh', filename: 'r2.sh' }],
    h.binding, [], workspaces);
  assert.equal(completed.checked, true);
  assert.deepEqual(completed.needsCorrection, []);
  assert.equal(h.uploads.length, 1, 'unchanged bytes are not uploaded twice');
  assert.ok(workspaceReads.length >= 2, 'both reads went to the workspace');
  assert.equal(h.completion.unresolved(), false);

  // Without the workspace source the same selection is a correctable failure,
  // never a silent success.
  const h2 = setup();
  await h2.completion.deliver(workspaceEnv, { path: '/workspace/r2.sh', filename: 'r2.sh' },
    { ...h2.binding, sandboxKind: 'cloudflare', sourceWorkspace: 'main' });
  const unavailable = await h2.completion.complete(h2.env, [{ path: '/workspace/r2.sh', filename: 'r2.sh' }], h2.binding);
  assert.equal(unavailable.checked, false);
  assert.equal(unavailable.needsCorrection[0]?.detail, 'source_unavailable');
});
