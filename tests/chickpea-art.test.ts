import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// @ts-expect-error Art kit JavaScript generator.
import { LIGHTNESS_QUANTILES, labToHex, renderChickpea, toLab, toneMap } from '../scripts/chickpea-art.mjs';
import { DEFAULT_AGENT_AVATAR_FILES } from '../src/slack/agent-presence/default-avatar-pool.ts';

type Lab = [number, number, number];
type Color = { lab: Lab; hex: string };
type PaletteEntry = {
  name: string;
  body: Color;
  face: 'ink' | 'cream';
  lightness: number[];
  avatar?: { background: string; floor: string; arch: string; doorway: string };
};
type Palette = { version: number; lightnessQuantiles: number[]; faces: { ink: Color; cream: Color }; colors: Record<string, PaletteEntry> };
type Master = {
  file: string;
  kind: 'stand' | 'pose';
  pose?: string;
  color: string;
  mask: string;
  groundY: number;
  body: Lab;
  lightness: number[];
  face: { native: string; anchor: [number, number] } | { matte: string };
  recolor: boolean;
  reason?: string;
};
type Manifest = {
  version: number;
  size: number;
  groundY: number;
  bodyHeight: number;
  faces: Record<string, { file: string; anchor: [number, number]; from: string }>;
  masters: Record<string, Master>;
};
type Render = (options: { master: string; color: string; face?: string; size?: number; format?: 'png' | 'webp'; shadow?: boolean }) => Promise<Buffer>;

const KIT = fileURLToPath(new URL('../assets/chickpea/', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/chickpea-art.mjs', import.meta.url));
const palette = JSON.parse(readFileSync(join(KIT, 'palette.json'), 'utf8')) as Palette;
const manifest = JSON.parse(readFileSync(join(KIT, 'manifest.json'), 'utf8')) as Manifest;
const render = renderChickpea as Render;
const AVATAR_COLORS = DEFAULT_AGENT_AVATAR_FILES.map((file) => file.replace(/\.png$/, ''));
const HEX = /^#[0-9a-f]{6}$/;

async function rgba(input: string | Buffer) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function gray(file: string) {
  const { channels } = await sharp(join(KIT, file)).metadata();
  const { data, info } = await sharp(join(KIT, file)).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels };
}

const ascending = (values: number[]) => values.every((value, index) => index === 0 || value >= values[index - 1]!);
const lightnessAt = (data: Buffer, i: number) => (toLab as (r: number, g: number, b: number) => Lab)(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!)[0];
const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!;

test('the palette holds the twelve avatar colors and the brand orange, each with a body, face and tone curve', () => {
  assert.equal(palette.version, 1);
  assert.deepEqual(palette.lightnessQuantiles, LIGHTNESS_QUANTILES);
  for (const key of [...AVATAR_COLORS, 'brand']) assert.ok(palette.colors[key], key);
  for (const face of [palette.faces.ink, palette.faces.cream]) {
    assert.match(face.hex, HEX);
    assert.equal(face.lab.length, 3);
  }
  assert.ok(palette.faces.cream.lab[0] > 70 && palette.faces.ink.lab[0] < 15, 'cream is light and ink is near black');
  for (const [key, entry] of Object.entries(palette.colors)) {
    assert.ok(entry.name.length > 0, key);
    assert.match(entry.body.hex, HEX, key);
    assert.equal(entry.body.hex, labToHex(entry.body.lab), `${key} hex matches its Lab`);
    assert.equal(entry.lightness.length, LIGHTNESS_QUANTILES.length, key);
    assert.ok(ascending(entry.lightness), `${key} lightness quantiles ascend`);
    assert.ok(entry.lightness[0]! <= entry.body.lab[0] && entry.body.lab[0] <= entry.lightness.at(-1)!, `${key} median sits inside its quantiles`);
    if (AVATAR_COLORS.includes(key)) {
      assert.deepEqual(Object.keys(entry.avatar ?? {}), ['background', 'floor', 'arch', 'doorway'], key);
      for (const hex of Object.values(entry.avatar!)) assert.match(hex, HEX, key);
    } else {
      assert.equal(entry.avatar, undefined, `${key} has no avatar scene`);
    }
  }
  const cream = AVATAR_COLORS.filter((key) => palette.colors[key]!.face === 'cream');
  assert.deepEqual(cream, ['06-deep-moss', '10-midnight-indigo']);
  assert.equal(palette.colors.brand!.face, 'ink');
});

test('every manifest file exists at the size the manifest records, on one ground line', async () => {
  assert.equal(manifest.version, 1);
  const size = manifest.size;
  for (const [name, face] of Object.entries(manifest.faces)) {
    const matte = await gray(face.file);
    assert.equal(matte.channels, 1, name);
    assert.ok(face.anchor[0] > 0 && face.anchor[0] < matte.width && face.anchor[1] > 0 && face.anchor[1] < matte.height, `${name} anchor inside its matte`);
    assert.ok(palette.colors[face.from], `${name} comes from a palette render`);
  }
  for (const [name, entry] of Object.entries(manifest.masters)) {
    assert.ok(palette.colors[entry.color], `${name} native color is in the palette`);
    assert.equal(entry.lightness.length, LIGHTNESS_QUANTILES.length, name);
    assert.ok(ascending(entry.lightness), name);
    const master = await rgba(join(KIT, entry.file));
    assert.deepEqual([master.width, master.height], [size, size], name);
    const mask = await gray(entry.mask);
    assert.deepEqual([mask.width, mask.height, mask.channels], [size, size, 1], `${name} mask`);
    let lowest = -1, top = size;
    for (let i = 0; i < size * size; i++) {
      if (mask.data[i] !== 255 || master.data[i * 4 + 3]! <= 128) continue;
      lowest = Math.max(lowest, Math.floor(i / size));
      top = Math.min(top, Math.floor(i / size));
    }
    assert.equal(entry.groundY, manifest.groundY, `${name} sits on the common ground line`);
    assert.equal(lowest, entry.groundY, `${name} body base is at its ground line`);
    if (entry.kind === 'stand') {
      assert.ok('native' in entry.face && manifest.faces[entry.face.native], `${name} native face is in the set`);
      assert.equal(lowest - top + 1, manifest.bodyHeight, `${name} body height`);
      for (let i = 0; i < size * size; i++) {
        assert.equal(mask.data[i], master.data[i * 4 + 3]! > 0 ? 255 : 0, `${name} mask is the alpha's footprint`);
      }
    } else {
      assert.ok('matte' in entry.face, name);
      const matte = await gray(entry.face.matte);
      assert.deepEqual([matte.width, matte.height, matte.channels], [size, size, 1], `${name} face matte`);
      assert.equal(entry.recolor || Boolean(entry.reason), true, `${name} says why it cannot be recolored`);
    }
  }
});

test('a master in its native color, with no face added, comes back pixel for pixel', async () => {
  for (const [name, entry] of Object.entries(manifest.masters)) {
    const options = entry.kind === 'stand' ? { master: name, color: entry.color, face: 'none' } : { master: name, color: entry.color };
    const output = await rgba(await render(options));
    const master = await rgba(join(KIT, entry.file));
    assert.ok(output.data.equals(master.data), name);
  }
});

test('a recolor changes only pixels inside the body mask and never the alpha', async () => {
  for (const [name, color] of [['pose-celebrate', '07-periwinkle'], ['pose-moving-in', '10-midnight-indigo'], ['stand-02-coral', '08-seafoam']] as const) {
    const entry = manifest.masters[name]!;
    const master = await rgba(join(KIT, entry.file));
    const mask = await gray(entry.mask);
    const output = await rgba(await render({ master: name, color, ...(entry.kind === 'stand' ? { face: 'none' } : {}) }));
    let inside = 0;
    for (let i = 0; i < mask.data.length; i++) {
      assert.equal(output.data[i * 4 + 3], master.data[i * 4 + 3], `${name} alpha at ${i}`);
      if (mask.data[i]) {
        if (output.data.readUInt32BE(i * 4) !== master.data.readUInt32BE(i * 4)) inside++;
        continue;
      }
      assert.equal(output.data.readUInt32BE(i * 4), master.data.readUInt32BE(i * 4), `${name} pixel ${i} outside the mask`);
    }
    assert.ok(inside > 10_000, `${name} recolored its body`);
  }
});

test('a recolored body takes the target color\'s lightness and hue', async () => {
  for (const [name, color] of [['stand-03-lilac', '09-warm-oat'], ['stand-09-warm-oat', '10-midnight-indigo'], ['pose-hello', '04-mineral-blue']] as const) {
    const entry = manifest.masters[name]!;
    const output = await rgba(await render({ master: name, color, ...(entry.kind === 'stand' ? { face: 'none' } : {}) }));
    const mask = await gray(entry.mask);
    const face = 'matte' in entry.face ? await gray(entry.face.matte) : undefined;
    const labs: Lab[] = [];
    for (let i = 0; i < mask.data.length; i++) {
      if (mask.data[i] === 255 && output.data[i * 4 + 3] === 255 && !face?.data[i]) {
        labs.push((toLab as (r: number, g: number, b: number) => Lab)(output.data[i * 4]!, output.data[i * 4 + 1]!, output.data[i * 4 + 2]!));
      }
    }
    const target = palette.colors[color]!.body.lab;
    const [L, a, b] = [0, 1, 2].map((c) => median(labs.map((lab) => lab[c]!)));
    assert.ok(Math.abs(L! - target[0]) < 2, `${name} in ${color}: L ${L} vs ${target[0]}`);
    assert.ok(Math.hypot(a! - target[1], b! - target[2]) < 4, `${name} in ${color}: ab ${a},${b} vs ${target[1]},${target[2]}`);
  }
});

test('the tone curve maps quantile to quantile and never stretches the tails', () => {
  const map = toneMap as (L: number, from: number[], to: number[]) => number;
  const from = [20, 30, 40, 45, 50, 55, 60, 70, 80];
  const to = [10, 15, 20, 30, 40, 50, 60, 65, 70];
  from.forEach((L, k) => assert.equal(map(L, from, to), to[k]));
  assert.equal(map(47.5, from, to), 35);
  assert.equal(map(10, from, to), 5, 'below the range, the outer slope (0.5)');
  assert.equal(map(90, from, to), 75, 'above the range, the outer slope (0.5)');
  assert.equal(map(90, to, from), 100, 'a steeper outer slope (2) is capped at 1');
});

async function facePixels(name: string, face: string, color: string) {
  const entry = manifest.masters[name]!;
  const bare = await rgba(await render({ master: name, color, face: 'none' }));
  const withFace = await rgba(await render({ master: name, color, face }));
  const matte = await gray(manifest.faces[face]!.file);
  const anchor = manifest.faces[face]!.anchor;
  const native = 'anchor' in entry.face ? entry.face.anchor : [0, 0];
  const offset = [Math.round(native[0]! - anchor[0]), Math.round(native[1]! - anchor[1])];
  const solid: number[] = [], changedOutside: number[] = [];
  for (let i = 0; i < bare.data.length / 4; i++) {
    const x = i % manifest.size - offset[0]!, y = Math.floor(i / manifest.size) - offset[1]!;
    const inMatte = x >= 0 && y >= 0 && x < matte.width && y < matte.height ? matte.data[y * matte.width + x]! : 0;
    const changed = bare.data.readUInt32BE(i * 4) !== withFace.data.readUInt32BE(i * 4);
    if (inMatte === 255) solid.push(lightnessAt(withFace.data, i));
    else if (!inMatte && changed) changedOutside.push(i);
  }
  return { solid, changedOutside, bodyL: palette.colors[color]!.body.lab[0] };
}

test('a face lands on any body at the body\'s face anchor and changes nothing else', async () => {
  for (const [name, face] of [['stand-01-sage', 'o'], ['stand-10-midnight-indigo', 'smile'], ['stand-07-periwinkle', 'line']] as const) {
    const { solid, changedOutside } = await facePixels(name, face, manifest.masters[name]!.color);
    assert.ok(solid.length > 300, `${name} shows the ${face} face`);
    assert.deepEqual(changedOutside, [], `${name} with ${face} changes only pixels under the face`);
  }
});

test('faces are ink on ink palette entries and cream on cream ones', async () => {
  for (const color of Object.keys(palette.colors)) {
    const { solid, bodyL } = await facePixels('stand-08-seafoam', 'smile', color);
    const L = median(solid);
    if (palette.colors[color]!.face === 'cream') {
      assert.ok(L > bodyL + 30 && Math.abs(L - palette.faces.cream.lab[0]) < 6, `${color} face is cream (L ${L})`);
    } else {
      assert.ok(Math.abs(L - palette.faces.ink.lab[0]) < 3, `${color} face is ink (L ${L})`);
    }
  }
  const pose = manifest.masters['pose-hello']!;
  const matte = await gray((pose.face as { matte: string }).matte);
  for (const [color, kind] of [['10-midnight-indigo', 'cream'], ['01-sage', 'ink']] as const) {
    const output = await rgba(await render({ master: 'pose-hello', color }));
    const solid: number[] = [];
    for (let i = 0; i < matte.data.length; i++) if (matte.data[i] === 255) solid.push(lightnessAt(output.data, i));
    const L = median(solid);
    assert.ok(Math.abs(L - palette.faces[kind].lab[0]) < 6, `pose-hello face in ${color} is ${kind} (L ${L})`);
  }
});

test('the generator is deterministic across calls, formats and sizes', async () => {
  for (const options of [
    { master: 'stand-06-deep-moss', color: 'brand', face: 'o' },
    { master: 'pose-coding', color: '06-deep-moss', format: 'webp' as const },
    { master: 'stand-12-muted-berry', color: '03-lilac', size: 96, shadow: true },
  ]) {
    const first = await render(options);
    await render({ master: 'pose-chat', color: '02-coral' });
    assert.ok(first.equals(await render(options)), JSON.stringify(options));
  }
  const small = await sharp(await render({ master: 'stand-08-seafoam', color: '08-seafoam', size: 128, format: 'webp' })).metadata();
  assert.deepEqual([small.format, small.width, small.height, small.hasAlpha], ['webp', 128, 128, true]);
});

test('the generator refuses unknown names and impossible requests', async () => {
  await assert.rejects(render({ master: 'stand-99-nope', color: 'brand' }), /Unknown master/);
  await assert.rejects(render({ master: 'stand-01-sage', color: 'chartreuse' }), /Unknown color/);
  await assert.rejects(render({ master: 'stand-01-sage', color: 'brand', face: 'wink' }), /Unknown face/);
  await assert.rejects(render({ master: 'pose-hello', color: 'brand', face: 'smile' }), /carries its own face/);
  const fixed = Object.entries(manifest.masters).find(([, entry]) => !entry.recolor);
  if (fixed) await assert.rejects(render({ master: fixed[0], color: '01-sage' }), /not recolorable/);
});

test('the CLI writes the requested image', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-art-'));
  try {
    const out = join(dir, 'pea.webp');
    const result = spawnSync(process.execPath, [SCRIPT, 'stand-04-mineral-blue', '06-deep-moss', out, '--face', 'line', '--size', '64'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const bytes = readFileSync(out);
    assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP');
    const refused = spawnSync(process.execPath, [SCRIPT, 'stand-04-mineral-blue', 'brand'], { encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Usage: npm run art:chickpea/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
