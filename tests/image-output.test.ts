import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import * as v from 'valibot';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { createImageOutputStore, IMAGE_RETENTION_MS, purgeExpiredImageOutputs } from '../src/images/output-store.ts';
import { decodeGeneratedImage, prepareImageOutput, prepareImageInspection } from '../src/images/prepare-output.ts';
import { validImageSize } from '../src/images/output-controls.ts';
import { createImageArtifactTool, createRecoverImageTool, type ImageArtifactToolOptions } from '../src/sandbox/image-tool.ts';
import { buildThreadImageInventory } from '../src/slack/thread-images.ts';
import { findImageModel } from '../src/model-catalog/image-profiles.ts';
import type { ImageInspection } from '../src/images/inspect-output.ts';

const destination = { workspaceId: 'TTEST', agentId: 'agent_test', channelId: 'CTEST', threadTs: '1789000000.000100' };
async function fixture(format: 'png' | 'jpeg' | 'webp' = 'png', transparent = false) {
  return new Uint8Array(await sharp({ create: {
    width: 1024, height: 1024, channels: 4, background: { r: 20, g: 160, b: 90, alpha: transparent ? 0.4 : 1 },
  } }).toFormat(format).toBuffer());
}

test('image controls enforce provider geometry, including custom dimensions', () => {
  for (const size of ['auto', '1024x1024', '1536x1024', '1024x1536', '1536x864', '3840x2160']) assert.ok(validImageSize(size), size);
  for (const size of ['1080x1080', '256x256', '4000x2000', '3840x3840', '3000x500', '1024X1024', '0x1024']) assert.equal(validImageSize(size), false, size);
});

test('dimensions and transparency are decoded from PNG, JPEG, and WebP pixels', async () => {
  for (const format of ['png', 'jpeg', 'webp'] as const) {
    const transparent = format !== 'jpeg';
    const { facts } = await decodeGeneratedImage(await fixture(format, transparent));
    assert.deepEqual(facts, { width: 1024, height: 1024, transparent, format });
  }
  assert.equal((await decodeGeneratedImage(await fixture('png'))).facts.transparent, false, 'an alpha channel alone is not transparency');
  await assert.rejects(() => decodeGeneratedImage(new Uint8Array([1, 2, 3])));
});

test('compression fits noisy PNG output without changing requested dimensions', async () => {
  const pixels = Buffer.alloc(1024 * 1024 * 3);
  let seed = 42;
  for (let i = 0; i < pixels.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels[i] = seed >>> 24; }
  const png = new Uint8Array(await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer());
  const result = await prepareImageOutput(png, 700 * 1024, true);
  assert.ok(result.bytes.length <= 700 * 1024);
  assert.equal(result.compressed, true);
  assert.equal(result.resized, false);
  assert.equal(result.width, 1024);
  assert.equal(result.height, 1024);
  const decoded = await sharp(result.bytes).metadata();
  assert.equal(decoded.width, 1024);
  assert.equal(decoded.format, 'jpeg');
});

test('inspection composites alpha without changing retained PNG or WebP bytes', async () => {
  for (const format of ['png', 'webp'] as const) {
    const bytes = await fixture(format, true), original = bytes.slice();
    const preview = await prepareImageInspection(bytes);
    const facts = (await decodeGeneratedImage(preview.bytes)).facts;
    assert.deepEqual(bytes, original);
    assert.deepEqual(facts, { width: 1024, height: 1024, transparent: false, format: 'png' });
    const { data, info } = await sharp(preview.bytes).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.channels, 3);
    assert.notDeepEqual([...data.subarray(0, 3)], [...data.subarray(32 * 3, 32 * 3 + 3)], 'checkerboard remains visible through alpha');
  }
});

test('large opaque reference photos bypass pixel decoding, while unresolved alpha stays bounded', async () => {
  for (const format of ['jpeg', 'png', 'webp'] as const) {
    const bytes = new Uint8Array(await sharp({ create: { width: 4032, height: 3024, channels: 3, background: '#123456' } }).toFormat(format).toBuffer());
    await assert.rejects(() => decodeGeneratedImage(bytes), /image_pixel_limit/);
    const preview = await prepareImageInspection(bytes);
    assert.equal(preview.bytes, bytes);
    assert.equal(preview.mimeType, `image/${format}`);
  }
  const largeAlpha = new Uint8Array(await sharp({ create: { width: 4032, height: 3024, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } }).png().toBuffer());
  await assert.rejects(() => prepareImageInspection(largeAlpha), /image_pixel_limit/, 'never bypass alpha compositing or allocate unbounded pixels');
});

test('retained bytes survive a new store instance, stay destination-bound, and are physically purged at TTL', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  let now = 100;
  try {
    const store = createImageOutputStore(settings, destination, () => now);
    const bytes = new Uint8Array(600_000).fill(91);
    const saved = await store.save(bytes, { format: 'png' });
    const restarted = createImageOutputStore(settings, destination, () => now);
    assert.deepEqual((await restarted.read(saved.id))?.bytes, bytes);
    assert.equal(await createImageOutputStore(settings, { ...destination, channelId: 'COTHER' }, () => now).read(saved.id), undefined);
    assert.equal(await createImageOutputStore(settings, { ...destination, agentId: 'other' }, () => now).read(saved.id), undefined);
    now += IMAGE_RETENTION_MS;
    await purgeExpiredImageOutputs(settings, now);
    assert.equal(await restarted.read(saved.id), undefined);
    assert.equal(await settings.getSetting(`generated_images:v1:${saved.id}:0`), undefined);
    assert.equal(await settings.getSetting(`generated_images:v1:${saved.id}:meta`), undefined);
  } finally { settings.close(); }
});

function steps(records = new Map<string, unknown>()) {
  return { records, async do<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    if (records.has(name)) return structuredClone(records.get(name)) as T;
    const result = await fn(); records.set(name, JSON.parse(JSON.stringify(result))); return result;
  } };
}
async function setup(bytes: Uint8Array, inspect: () => ImageInspection = () => ({ status: 'checked', verdict: 'pass', observations: 'The logo and headline match.' })) {
  const settings = new SqliteSettingsStore(':memory:');
  const state = { generations: 0, edits: 0, stages: [] as Uint8Array[], failStage: false };
  const reservations = new Map<string, number>();
  const options: ImageArtifactToolOptions = {
    acceptsImageInput: true,
    inventory: buildThreadImageInventory({ conversationKey: 'test', threadRecords: [] }),
    outputStore: createImageOutputStore(settings, destination),
    reserveImageCall(id, count) {
      const available = 4 - [...reservations.values()].reduce((a, b) => a + b, 0);
      if (reservations.has(id)) return { ok: true, remaining: available };
      if (available < count) return { ok: false, remaining: available };
      reservations.set(id, count); return { ok: true, remaining: available - count };
    },
    async resolveTransport() { return { maxBytes: 700 * 1024 }; },
    async resolveClient() { return { ok: true, client: {
      profile: findImageModel('openai/gpt-image-2.5-flare')!,
      async generate(request) { state.generations++; return { ok: true, images: Array.from({ length: request.count ?? 1 }, () => bytes), appliedModel: 'openai/gpt-image-2.5-flare', appliedSize: 'auto', appliedFormat: 'png' }; },
      async edit() { state.edits++; return { ok: true, images: [bytes], appliedModel: 'openai/gpt-image-2.5-flare', appliedSize: 'auto', appliedFormat: 'png' }; },
    } }; },
    async createImageReader() { return { usedBytes: () => 0, read: async () => ({ ok: true, bytes, mimeType: 'image/png', filename: 'logo.png' }) }; },
    async inspectOutput() { return inspect(); },
    async stageArtifact(input) {
      if (state.failStage) return { attached: false, reason: 'unavailable', detail: 'private_stage_failed' };
      state.stages.push(input.bytes); return { attached: true, byteLength: input.bytes.length };
    },
  };
  return { options, state, settings };
}
async function invoke(tool: ReturnType<typeof createImageArtifactTool> | ReturnType<typeof createRecoverImageTool>, data: object, step = steps()) {
  return (tool.run as (context: unknown) => Promise<{ output: any }>)({ data: v.parse(tool.input, data), toolCallId: 'call_test', step });
}

test('conversation recovery shares the original file without a new upload, decoding, or a provider', async () => {
  const bytes = await fixture('webp', true);
  const { options, state, settings } = await setup(bytes);
  try {
    delete options.outputStore;
    options.acceptsImageInput = false;
    options.resolveClient = async () => { throw new Error('must not resolve image provider'); };
    options.reserveImageCall = () => { throw new Error('must not reserve a generation'); };
    options.inventory = buildThreadImageInventory({ conversationKey: 'test', threadRecords: [
      { conversationKey: 'test', fileId: 'F_EDITED', filename: 'edited.webp', mimeType: 'image/webp', origin: 'agent', messageTs: '1789000000.000100', permalink: 'https://example.slack.com/files/U1/F_EDITED/edited.webp' },
      { conversationKey: 'other', fileId: 'F_OTHER', filename: 'other.webp', mimeType: 'image/webp', origin: 'agent', messageTs: '1789000000.000200' },
    ] });
    let reads = 0;
    let shares = 0;
    options.prepareOutput = () => { throw new Error('must not decode or compress an exact resend'); };
    options.resolveTransport = async () => { throw new Error('must not upload an exact resend'); };
    options.reuseImage = async input => {
      shares++; assert.equal(input.record.fileId, 'F_EDITED'); assert.equal(input.filename, 'resent.webp');
      return { attached: true, byteLength: input.byteLength };
    };
    options.createImageReader = async () => ({ usedBytes: () => bytes.length, read: async record => {
      reads += 1; assert.equal(record.fileId, 'F_EDITED');
      return { ok: true, bytes, mimeType: 'image/webp', filename: 'edited.webp' };
    } });
    const tool = createRecoverImageTool(options), checkpoint = steps();
    const result = await invoke(tool, { image: 'img:1', filename: 'resent' }, checkpoint);
    assert.equal(result.output.attached, true);
    assert.equal(result.output.sourceImage, 'img:1');
    assert.equal(result.output.savedImage, undefined);
    assert.equal(result.output.reusedExistingFile, true);
    assert.equal(result.output.originalFilename, 'edited.webp');
    assert.equal(result.output.renamed, false);
    assert.equal(result.output.resized, false);
    assert.deepEqual(state.stages, []);
    await invoke(tool, { image: 'img:1', filename: 'resent' }, steps(checkpoint.records));
    assert.equal(reads, 1); assert.equal(shares, 1, 'completed recovery does not repeat access or staging');
    assert.equal((await invoke(tool, { image: 'img:2' })).output.detail, 'not_found');
    options.createImageReader = async () => ({ usedBytes: () => 0, read: async () => ({ ok: false, reason: 'input-unavailable', detail: 'missing_scope' }) });
    assert.equal((await invoke(tool, { image: 'img:1' })).output.detail, 'missing_scope');
    assert.equal(state.stages.length, 0);
    delete options.reuseImage;
    assert.equal((await invoke(tool, { image: 'img:1' })).output.reason, 'original_file_unavailable', 'never silently falls back to a new upload');
  } finally { settings.close(); }
});

test('an interrupted generation reattaches retained bytes without another provider call', async () => {
  const { options, state, settings } = await setup(await fixture());
  try {
    const tool = createImageArtifactTool(options);
    const recorded = steps();
    await assert.rejects(invoke(tool, { prompt: 'A square logo', size: '1024x1024' }, {
      records: recorded.records,
      async do<T>(name: string, fn: () => T | Promise<T>) { const result = await recorded.do(name, fn); if (name === 'generate') throw new Error('crash'); return result; },
    }));
    const result = await invoke(createImageArtifactTool(options), { prompt: 'A square logo', size: '1024x1024' }, steps(recorded.records));
    assert.equal(result.output.attached, true);
    assert.equal(result.output.appliedSize, '1024x1024');
    assert.equal(result.output.files[0].inspection.verdict, 'pass');
    assert.equal(state.generations, 1);
    assert.equal(state.stages.length, 1);
    await invoke(tool, { prompt: 'A square logo', size: '1024x1024' }, steps(recorded.records));
    assert.equal(state.stages.length, 1);
    assert.equal(JSON.stringify([...recorded.records.values()]).includes(Buffer.from(state.stages[0]!).toString('base64')), false);
  } finally { settings.close(); }
});

test('failed upload recovery reuses bytes and a completed retry never stages twice', async () => {
  const bytes = await fixture();
  const { options, state, settings } = await setup(bytes);
  try {
    state.failStage = true;
    const first = await invoke(createImageArtifactTool(options), { prompt: 'A square logo' });
    assert.equal(first.output.attached, false);
    assert.ok(first.output.savedImage);
    state.failStage = false;
    const tool = createRecoverImageTool(options);
    const recorded = steps();
    const result = await invoke(tool, { image: first.output.savedImage }, recorded);
    assert.equal(result.output.attached, true);
    assert.equal(state.generations, 1);
    assert.deepEqual(state.stages, [bytes]);
    await invoke(tool, { image: first.output.savedImage }, steps(recorded.records));
    assert.equal(state.stages.length, 1);
  } finally { settings.close(); }
});

test('three variations allow one inspected correction within the four-image budget', async () => {
  let inspections = 0;
  const { options, state, settings } = await setup(await fixture(), () => {
    inspections++;
    return { status: 'checked', verdict: inspections === 1 ? 'needs_changes' : 'pass', observations: 'Correct the misspelled headline.' };
  });
  try {
    const result = await invoke(createImageArtifactTool(options), { prompt: 'A single square ad', count: 3 });
    assert.equal(state.generations, 1);
    assert.equal(state.edits, 1);
    assert.equal(inspections, 4);
    assert.equal(result.output.files.length, 3);
    assert.equal(result.output.files[0].corrected, true);
    assert.equal(options.reserveImageCall('extra', 1).ok, false);
  } finally { settings.close(); }
});

test('unmet explicit transparency is not delivered or reported as completed', async () => {
  const { options, state, settings } = await setup(await fixture('png', false));
  try {
    const result = await invoke(createImageArtifactTool(options), { prompt: 'A transparent logo', background: 'transparent' });
    assert.equal(result.output.attached, false);
    assert.equal(result.output.detail, 'output_requirements_not_met');
    assert.equal(state.stages.length, 0);
    assert.equal(state.edits, 1);
    const retry = await invoke(createRecoverImageTool(options), { image: result.output.savedImage });
    assert.equal(retry.output.reason, 'output_requirements_not_met');
    assert.equal(state.stages.length, 0);
  } finally { settings.close(); }
});

test('a replay after a corrected variation cannot spend the same correction reservation twice', async () => {
  const { options, state, settings } = await setup(await fixture(), () => ({ status: 'checked', verdict: 'needs_changes', observations: 'Incorrect headline.' }));
  try {
    const recorded = steps();
    await assert.rejects(invoke(createImageArtifactTool(options), { prompt: 'A square ad', count: 3 }, {
      records: recorded.records,
      async do<T>(name: string, fn: () => T | Promise<T>) {
        const result = await recorded.do(name, fn);
        if (name === 'finalize:1') throw new Error('crash after prepared correction');
        return result;
      },
    }));
    const result = await invoke(createImageArtifactTool(options), { prompt: 'A square ad', count: 3 }, steps(recorded.records));
    assert.equal(result.output.files.length, 3);
    assert.equal(state.edits, 1);
    assert.equal(state.generations, 1);
  } finally { settings.close(); }
});

test('transparent objects do not impose a transparent background and unavailable inspection stays explicit', async () => {
  const { options, state, settings } = await setup(await fixture(), () => ({ status: 'unavailable', observations: 'No vision model.' }));
  try {
    const object = await invoke(createImageArtifactTool(options), { prompt: 'A transparent glass vase on a blue table' });
    assert.equal(object.output.attached, true);
    assert.equal(state.edits, 0);
    const delivered = await invoke(createImageArtifactTool(options), { prompt: 'An opaque logo', background: 'opaque' });
    assert.equal(delivered.output.files[0].inspection.status, 'unavailable');
  } finally { settings.close(); }
});

test('retention failures never discard a deliverable or repeat paid generation', async () => {
  const { options, state, settings } = await setup(await fixture());
  try {
    options.outputStore = { save: async () => { throw new Error('cache unavailable'); }, read: async () => undefined, remove: async () => {} };
    const result = await invoke(createImageArtifactTool(options), { prompt: 'A square ad', size: '1024x1024' });
    assert.equal(result.output.attached, true);
    assert.equal(result.output.files[0].savedImage, undefined);
    assert.equal(state.generations, 1);
    assert.equal(state.stages.length, 1);
  } finally { settings.close(); }
});

test('replay uses a later retained copy when the first retention write failed', async () => {
  const { options, state, settings } = await setup(await fixture());
  try {
    const store = options.outputStore!;
    let saves = 0;
    options.outputStore = { ...store, async save(bytes, metadata) {
      if (++saves === 1) throw new Error('transient cache failure');
      return store.save(bytes, metadata);
    } };
    const recorded = steps();
    await assert.rejects(invoke(createImageArtifactTool(options), { prompt: 'A square ad' }, {
      records: recorded.records,
      async do<T>(name: string, fn: () => T | Promise<T>) {
        const result = await recorded.do(name, fn);
        if (name === 'finalize:1') throw new Error('crash before upload');
        return result;
      },
    }));
    const result = await invoke(createImageArtifactTool(options), { prompt: 'A square ad' }, steps(recorded.records));
    assert.equal(result.output.attached, true);
    assert.ok(result.output.files[0].savedImage);
    assert.equal(state.generations, 1);
    assert.equal(state.stages.length, 1);
  } finally { settings.close(); }
});

test('an unavailable correction on replay preserves the retained original and its inspection', async () => {
  const bytes = await fixture();
  const { options, state, settings } = await setup(bytes, () => ({ status: 'checked', verdict: 'needs_changes', observations: 'Headline needs correction.' }));
  try {
    const store = options.outputStore!;
    let saves = 0;
    options.outputStore = { ...store, async save(image, metadata) {
      if (++saves === 3) throw new Error('correction cache unavailable');
      return store.save(image, metadata);
    } };
    const recorded = steps();
    await assert.rejects(invoke(createImageArtifactTool(options), { prompt: 'A square ad' }, {
      records: recorded.records,
      async do<T>(name: string, fn: () => T | Promise<T>) {
        const result = await recorded.do(name, fn);
        if (name === 'correct:1') throw new Error('crash after correction');
        return result;
      },
    }));
    const result = await invoke(createImageArtifactTool(options), { prompt: 'A square ad' }, steps(recorded.records));
    assert.equal(result.output.attached, true);
    assert.equal(result.output.files[0].corrected, false);
    assert.equal(result.output.files[0].inspection.verdict, 'needs_changes');
    assert.deepEqual(state.stages, [bytes]);
    assert.equal(state.edits, 1);
    assert.equal(state.generations, 1);
  } finally { settings.close(); }
});

test('explicit opaque output refuses actual transparency, including upload recovery', async () => {
  const { options, state, settings } = await setup(await fixture('png', true));
  try {
    const result = await invoke(createImageArtifactTool(options), { prompt: 'An opaque logo', background: 'opaque' });
    assert.equal(result.output.detail, 'output_requirements_not_met');
    assert.equal(state.edits, 1);
    const recovery = await invoke(createRecoverImageTool(options), { image: result.output.savedImage });
    assert.equal(recovery.output.reason, 'output_requirements_not_met');
    assert.equal(state.stages.length, 0);
  } finally { settings.close(); }
});

test('replay after prepared or finalized unretained corrections delivers truthful original facts', async () => {
  for (const crashStep of ['prepare-correction:1', 'finalize:1']) {
    const bytes = await fixture();
    const { options, state, settings } = await setup(bytes, () => ({ status: 'checked', verdict: 'needs_changes', observations: 'Incorrect headline.' }));
    try {
      const store = options.outputStore!;
      let saves = 0;
      options.outputStore = { ...store, async save(image, metadata) {
        if (++saves >= 3) throw new Error('cache unavailable after original');
        return store.save(image, metadata);
      } };
      const recorded = steps();
      await assert.rejects(invoke(createImageArtifactTool(options), { prompt: 'A square ad' }, {
        records: recorded.records,
        async do<T>(name: string, fn: () => T | Promise<T>) {
          const result = await recorded.do(name, fn);
          if (name === crashStep) throw new Error('crash before upload');
          return result;
        },
      }));
      const result = await invoke(createImageArtifactTool(options), { prompt: 'A square ad' }, steps(recorded.records));
      assert.equal(result.output.attached, true, crashStep);
      assert.equal(result.output.files[0].corrected, false);
      assert.equal(result.output.files[0].inspection.verdict, 'needs_changes');
      assert.ok(result.output.files[0].savedImage);
      assert.deepEqual(state.stages, [bytes]);
      assert.equal(state.edits, 1);
      const replay = await invoke(createImageArtifactTool(options), { prompt: 'A square ad' }, steps(recorded.records));
      assert.deepEqual(replay, result);
      assert.equal(state.stages.length, 1);
    } finally { settings.close(); }
  }
});

test('corrupt cache indices recover without breaking reads and corrupt metadata stays unavailable', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const store = createImageOutputStore(settings, destination);
    const id = 'saved:11111111-1111-1111-1111-111111111111';
    for (const invalid of ['{invalid json', '{}', '[{"id":"bad"}]']) {
      await settings.setSetting('generated_images:v1:index', invalid);
      assert.equal(await store.read(id), undefined);
      assert.equal(await settings.getSetting('generated_images:v1:index'), '[]');
      assert.ok((await store.save(new Uint8Array([1]), {})).id);
    }
    const saved = await store.save(new Uint8Array([2]), {});
    await settings.setSetting(`generated_images:v1:${saved.id}:meta`, '{invalid');
    assert.equal(await store.read(saved.id), undefined);
  } finally { settings.close(); }
});

test('cache read outages return unavailable from recovery and saved-image edits', async () => {
  const { options, settings } = await setup(await fixture());
  try {
    options.outputStore = { ...options.outputStore!, async read() { throw new Error('cache offline'); } };
    const image = 'saved:11111111-1111-1111-1111-111111111111';
    assert.equal((await invoke(createRecoverImageTool(options), { image })).output.reason, 'expired_or_unavailable');
    assert.equal((await invoke(createImageArtifactTool(options), { prompt: 'Edit this', inputs: [image] })).output.reason, 'input-unavailable');
  } finally { settings.close(); }
});

test('correction uses original bytes before transport compression and never drops a fourth reference', async () => {
  const bytes = await fixture();
  const compressed = await fixture('jpeg');
  const { options, state, settings } = await setup(bytes, () => ({ status: 'checked', verdict: 'needs_changes', observations: 'Correct headline.' }));
  try {
    options.prepareOutput = () => ({ bytes: compressed, width: 1024, height: 1024, format: 'jpeg', transparent: false, compressed: true, resized: false });
    const resolve = options.resolveClient;
    options.resolveClient = async () => {
      const resolved = await resolve();
      assert.ok(resolved.ok);
      const edit = resolved.client.edit;
      resolved.client.edit = async (request) => {
        assert.deepEqual(request.inputs[0]!.bytes, bytes);
        assert.equal(request.inputs[0]!.mimeType, 'image/png');
        return edit(request);
      };
      return resolved;
    };
    const result = await invoke(createImageArtifactTool(options), { prompt: 'A square ad' });
    assert.equal(result.output.files[0].corrected, true);
    assert.equal(state.edits, 1);
    const image = await options.outputStore!.save(bytes, { format: 'png' });
    const referenced = await invoke(createImageArtifactTool(options), { prompt: 'An ad using all references', inputs: Array(4).fill(image.id) });
    assert.equal(referenced.output.files[0].corrected, false);
    assert.equal(state.edits, 2, 'one explicit edit, with no correction that would drop a reference');
  } finally { settings.close(); }
});

test('unchanged images reuse retention without extending TTL; expiry never resurrects a handle', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  let now = 1;
  try {
    const store = createImageOutputStore(settings, destination, () => now);
    const first = await store.save(new Uint8Array([1,2,3]), { format: 'png' });
    now += 1000;
    const next = await store.save(new Uint8Array([1,2,3]), { format: 'png', width: 1024 });
    assert.deepEqual(next, first);
    assert.equal(JSON.parse((await settings.getSetting('generated_images:v1:index'))!).length, 1);
    assert.equal((await store.read(first.id))?.metadata.width, 1024);
    now += IMAGE_RETENTION_MS;
    const later = await store.save(new Uint8Array([1,2,3]), { format: 'png' });
    assert.notEqual(later.id, first.id);
    assert.equal(await store.read(first.id), undefined);
  } finally { settings.close(); }
});

test('the global cache evicts oldest bytes across scopes and keeps constraints separate', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const a = createImageOutputStore(settings, destination);
    const b = createImageOutputStore(settings, { ...destination, channelId: 'COTHER' });
    const bytes = new Uint8Array(8 * 1024 * 1024);
    const first = await a.save(bytes, { size: 'auto' });
    for (let i = 1; i <= 8; i++) { bytes[0] = i; await b.save(bytes, { size: 'auto' }); }
    assert.equal(await a.read(first.id), undefined);
    assert.equal(await settings.getSetting(`generated_images:v1:${first.id}:0`), undefined);
    const index = JSON.parse((await settings.getSetting('generated_images:v1:index'))!);
    assert.equal(index.reduce((sum: number, item: { bytes: number }) => sum + item.bytes, 0), 64 * 1024 * 1024);
    const plain = await a.save(new Uint8Array([1]), { background: 'opaque' });
    const transparent = await a.save(new Uint8Array([1]), { background: 'transparent' });
    assert.notEqual(plain.id, transparent.id);
    assert.equal((await a.read(plain.id))?.metadata.background, 'opaque');
  } finally { settings.close(); }
});
