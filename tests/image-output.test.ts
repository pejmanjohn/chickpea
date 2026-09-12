import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import * as v from 'valibot';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { createImageOutputStore, IMAGE_RETENTION_MS, purgeExpiredImageOutputs } from '../src/images/output-store.ts';
import { decodeGeneratedImage, prepareImageOutput } from '../src/images/prepare-output.ts';
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
    const { facts } = decodeGeneratedImage(await fixture(format, transparent));
    assert.deepEqual(facts, { width: 1024, height: 1024, transparent, format });
  }
  assert.equal(decodeGeneratedImage(await fixture('png')).facts.transparent, false, 'an alpha channel alone is not transparency');
  assert.throws(() => decodeGeneratedImage(new Uint8Array([1, 2, 3])));
});

test('compression fits noisy PNG output without changing requested dimensions', async () => {
  const pixels = Buffer.alloc(1024 * 1024 * 3);
  let seed = 42;
  for (let i = 0; i < pixels.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels[i] = seed >>> 24; }
  const png = new Uint8Array(await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer());
  const result = prepareImageOutput(png, 700 * 1024, true);
  assert.ok(result.bytes.length <= 700 * 1024);
  assert.equal(result.compressed, true);
  assert.equal(result.resized, false);
  assert.equal(result.width, 1024);
  assert.equal(result.height, 1024);
  const decoded = await sharp(result.bytes).metadata();
  assert.equal(decoded.width, 1024);
  assert.equal(decoded.format, 'jpeg');
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
