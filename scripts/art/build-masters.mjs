#!/usr/bin/env node
// Rebuilds the Chickpea art kit in assets/chickpea from the committed avatar
// renders and onboarding poses: faceless standing bodies, face mattes, pose
// masters, body and face masks, palette.json and manifest.json.
// macOS only (Vision); the committed kit is the source of truth.
// Usage: node scripts/art/build-masters.mjs [--debug DIR]
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { LIGHTNESS_QUANTILES, labToHex, toLab } from '../chickpea-art.mjs';
import {
  decontaminate, findFace, inkCoverage, inpaint, keyMatte, medianLab, paintOutArch, softenHardEdge, unmixMatte, visionLift,
} from './cutout.mjs';
import {
  bounds, flood, islands, median, morph, place, quantile, readRgba, regionIndexes, writePng,
} from './raster.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const KIT = join(ROOT, 'assets', 'chickpea');
const SIZE = 512;
const GROUND_Y = 448;
const BODY_HEIGHT = 384;

// Standing chickpeas: palette key, display name, the face the render
// carries, and whether that face is ink or cream. The twelve avatar renders
// sit in an arch scene; a new render made to docs/chickpea-art.md names its
// `file` and has a flat background (`scene: 'flat'`).
const avatarStand = (key, name, face, kind) => ({ key, name, face, kind, file: `assets/chickpea-avatars/agent-defaults/${key}.png`, scene: 'avatar' });
const STANDS = [
  avatarStand('01-sage', 'Sage', 'smile', 'ink'),
  avatarStand('02-coral', 'Coral', 'o', 'ink'),
  avatarStand('03-lilac', 'Lilac', 'line', 'ink'),
  avatarStand('04-mineral-blue', 'Mineral blue', 'smile', 'ink'),
  avatarStand('05-dusty-rose', 'Dusty rose', 'o', 'ink'),
  avatarStand('06-deep-moss', 'Deep moss', 'smile', 'cream'),
  avatarStand('07-periwinkle', 'Periwinkle', 'line', 'ink'),
  avatarStand('08-seafoam', 'Seafoam', 'smile', 'ink'),
  avatarStand('09-warm-oat', 'Warm oat', 'o', 'ink'),
  avatarStand('10-midnight-indigo', 'Midnight indigo', 'line', 'cream'),
  avatarStand('11-apricot', 'Apricot', 'smile', 'ink'),
  avatarStand('12-muted-berry', 'Muted berry', 'o', 'ink'),
];

// Each face matte comes from an ink face on a light body: a standing
// render's key, or a second render that differs only in the face
// (`{ file, scene }`).
const FACE_SOURCES = { smile: '08-seafoam', line: '07-periwinkle', o: '09-warm-oat' };

// Where the arch touches the chickpea, Vision lifts both as one subject, so
// the arch is painted to the background first. Hue is HSV hue in [0, 1).
const RED_ORANGE_ARCH = { hues: [[0, 0.072], [0.97, 1]], minSaturation: 0.52, values: [0, 1] };
const ARCH_PAINT = {
  '01-sage': RED_ORANGE_ARCH,
  '09-warm-oat': RED_ORANGE_ARCH,
  '02-coral': { hues: [[0.85, 0.995]], minSaturation: 0.3, values: [0, 0.45] },
};

// The avatar scene behind the chickpea, sampled where every render shows it.
const AVATAR_SCENE = {
  background: [[4, 100, 20, 400], [492, 100, 508, 400]],
  floor: [[4, 496, 30, 510], [482, 496, 508, 510]],
  arch: [[240, 20, 272, 36]],
  doorway: [[236, 60, 276, 80]],
};
const FLAT_SCENE = { background: [[0, 0, 16, 16], [SIZE - 16, 0, SIZE, 16], [0, SIZE - 16, 16, SIZE], [SIZE - 16, SIZE - 16, SIZE, SIZE]] };
const BODY_SAMPLES = [[120, 280, 180, 420], [330, 280, 390, 420]];

// Poses: the onboarding scenes are already cut out; a new pose names its
// `file`, rendered to docs/chickpea-art.md on a flat background.
const onboardingPose = (pose, fields = {}) => ({ pose, file: `assets/onboarding/pose-${pose}.webp`, ...fields });
const POSES = [
  onboardingPose('hello'),
  onboardingPose('chat'),
  onboardingPose('celebrate'),
  onboardingPose('coding'),
  onboardingPose('coding-done'),
  onboardingPose('moving-in'),
  onboardingPose('setup', { recolor: false, reason: 'The hard hat shares the body\'s color and touches it, so no color rule separates them.' }),
];

// A body part a prop hides the join of (an arm behind a strap) is a felt
// island at least this large; confetti and sparkles are smaller.
const MIN_BODY_ISLAND = 2000;
// Enclosed holes up to this size are anti-aliased seams around face features.
const MAX_SEAM_HOLE = 300;

const rgbHex = (rgb) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
const round1 = (value) => Math.round(value * 10) / 10;
const color = (lab) => {
  const rounded = lab.map(round1);
  return { lab: rounded, hex: labToHex(rounded) };
};
const labAt = (rgba, i) => toLab(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);

// A source at the kit's size; a larger render (the spec asks for 1024) is
// scaled down first.
async function readSource(file) {
  const path = join(ROOT, file);
  const { width, height } = await sharp(path).metadata();
  if (width !== height) throw new Error(`${file} must be square`);
  if (width === SIZE) return readRgba(path);
  const { data } = await sharp(path).ensureAlpha().resize(SIZE, SIZE).raw().toBuffer({ resolveWithObject: true });
  return { data, width: SIZE, height: SIZE };
}

function sample(rgba, regions) {
  const indexes = regionIndexes(SIZE, regions);
  return [0, 1, 2].map((c) => median(indexes.map((i) => rgba[i * 4 + c])));
}

// Felt statistics of a body: Lab median and lightness quantiles over opaque
// pixels at least 3px inside, without face pixels (`skip`).
function feltStats(rgba, mask, skip = () => false) {
  const inner = morph(Float32Array.from({ length: SIZE * SIZE }, (_, i) => (mask[i] === 255 && rgba[i * 4 + 3] === 255 ? 1 : 0)), SIZE, SIZE, 3, Math.min);
  const labs = [];
  for (let i = 0; i < inner.length; i++) if (inner[i] && !skip(i)) labs.push(labAt(rgba, i));
  const sorted = Float64Array.from(labs.map((lab) => lab[0])).sort();
  return { lab: medianLab(labs), lightness: LIGHTNESS_QUANTILES.map((p) => round1(quantile(sorted, p))) };
}

// Scale a standing cut to BODY_HEIGHT, put its lowest point on the ground
// line and center it. Returns the master, plus functions that carry another
// plane or a point of the cut through the same transform.
async function normalizeStand(rgba) {
  const [x0, y0, x1, y1] = bounds(SIZE, SIZE, (i) => rgba[i * 4 + 3] > 128);
  const pad = 6;
  const crop = { left: x0 - pad, top: y0 - pad, width: x1 - x0 + 1 + pad * 2, height: y1 - y0 + 1 + pad * 2 };
  const resize = (data, channels, width, height) => {
    const resized = sharp(data, { raw: { width: SIZE, height: SIZE, channels } }).extract(crop).resize(width, height, { fit: 'fill' });
    return (channels === 1 ? resized.extractChannel(0) : resized).raw().toBuffer();
  };
  // Resampling rounds the body's extent, so try scales around the estimate
  // until one lands on BODY_HEIGHT exactly.
  const estimate = BODY_HEIGHT / (y1 - y0 + 1);
  for (const step of [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6]) {
    const scale = estimate * (1 + step * 0.001);
    const width = Math.round(crop.width * scale), height = Math.round(crop.height * scale);
    const data = await resize(rgba, 4, width, height);
    const [bx0, by0, bx1, by1] = bounds(width, height, (i) => data[i * 4 + 3] > 128);
    if (by1 - by0 + 1 !== BODY_HEIGHT) continue;
    const left = Math.round(SIZE / 2 - (bx0 + bx1 + 1) / 2), top = GROUND_Y - by1;
    return {
      master: place(data, width, height, 4, SIZE, left, top),
      carry: async (plane) => place(await resize(Buffer.from(plane), 1, width, height), width, height, 1, SIZE, left, top),
      point: ([x, y]) => [round1((x - crop.left) * (width / crop.width) + left), round1((y - crop.top) * (height / crop.height) + top)],
    };
  }
  throw new Error(`no scale near ${estimate} gives a body ${BODY_HEIGHT}px tall`);
}

const centroid = (members) => [0, 1].map((axis) =>
  members.reduce((sum, i) => sum + (axis ? (i / SIZE) | 0 : i % SIZE), 0) / members.length);

// The eyes: the topmost pair of face features side by side.
function eyes(core) {
  const features = islands(core, SIZE, SIZE).filter((members) => members.length >= 50).map(centroid);
  const pairs = features.flatMap((a, k) => features.slice(k + 1).map((b) => [a, b].sort((p, q) => p[0] - q[0])))
    .filter(([a, b]) => b[0] - a[0] >= 60 && Math.abs(a[1] - b[1]) <= 0.25 * (b[0] - a[0]))
    .sort((p, q) => p[0][1] + p[1][1] - q[0][1] - q[1][1]);
  if (!pairs.length) throw new Error(`no pair of eyes among the face features at ${features.map((p) => p.map(Math.round).join(',')).join('; ')}`);
  return pairs[0];
}

// The face's anchor: the midpoint between the eyes.
function eyeMidpoint(core) {
  const [a, b] = eyes(core);
  return [(a[0] + b[0]) / 2 + 0.5, (a[1] + b[1]) / 2 + 0.5];
}

// Contact shadow under the base leaves short drips below it. A column whose
// base sits more than a pixel below the median base line of the 61 columns
// around it fades out over a pixel at that line; other columns keep their
// soft edge.
function trimBase(alpha) {
  const base = Array.from({ length: SIZE }, (_, x) => {
    for (let y = SIZE - 1; y >= 0; y--) if (alpha[y * SIZE + x] >= 128) return y;
    return -1;
  });
  const out = Float32Array.from(alpha);
  for (let x = 0; x < SIZE; x++) {
    if (base[x] < 0) continue;
    const line = median(base.slice(Math.max(0, x - 30), x + 31).filter((y) => y >= 0));
    if (base[x] <= line + 1) continue;
    for (let y = line + 1; y < SIZE; y++) out[y * SIZE + x] *= Math.max(0, line + 2 - y);
  }
  return out;
}

async function buildStand({ key, name, face, kind, file, scene: layout }, scratch, inkL) {
  const render = await readSource(file);
  const samples = layout === 'avatar' ? AVATAR_SCENE : FLAT_SCENE;
  const scene = Object.fromEntries(Object.entries(samples).map(([part, regions]) => [part, sample(render.data, regions)]));
  const bodyGuess = medianLab(regionIndexes(SIZE, BODY_SAMPLES).map((i) => labAt(render.data, i)));
  const prepared = ARCH_PAINT[key] ? paintOutArch(render, ARCH_PAINT[key], scene.background, bodyGuess) : render;
  const coarse = await visionLift(prepared, scratch, key);
  // Where a floor or arch corner leaves a translucent shelf, the soft edge
  // stops 2.5px out from the solid body.
  // Opening and closing by 3px round off the steps a floor or pillar corner leaves.
  const smooth = (alpha, first, second) => morph(morph(alpha, SIZE, SIZE, 3, first), SIZE, SIZE, 3, second);
  const unmixed = Float32Array.from(unmixMatte(render, coarse, Object.values(scene)));
  const soft = softenHardEdge(smooth(smooth(unmixed, Math.max, Math.min), Math.min, Math.max), SIZE, SIZE);
  const reach = morph(soft.map((a) => (a >= 230 ? 1 : 0)), SIZE, SIZE, 2.5, Math.max);
  const cut = decontaminate(render, trimBase(soft.map((a, i) => a * reach[i])));
  const { core, region } = findFace(cut, SIZE, SIZE, kind);
  const faceless = inpaint(cut, SIZE, SIZE, region);
  const normalized = await normalizeStand(faceless);
  const mask = Buffer.from(Uint8Array.from({ length: SIZE * SIZE }, (_, i) => (normalized.master[i * 4 + 3] ? 255 : 0)));
  const faceLabs = [];
  for (let i = 0; i < core.length; i++) if (core[i]) faceLabs.push(labAt(cut, i));
  return {
    key, name, kind, face, layout, scene, mask,
    master: normalized.master,
    faceAnchor: normalized.point(eyeMidpoint(core)),
    faceLab: medianLab(faceLabs),
    coverage: inkL === undefined ? undefined : await normalized.carry(inkCoverage(cut, faceless, region, inkL)),
    ...feltStats(normalized.master, mask),
  };
}

// Crop a face's coverage plane to its features plus a margin.
async function faceMatte(stand) {
  const [x0, y0, x1, y1] = bounds(SIZE, SIZE, (i) => stand.coverage[i] > 0);
  const margin = 4;
  const left = x0 - margin, top = y0 - margin, width = x1 - x0 + 1 + margin * 2, height = y1 - y0 + 1 + margin * 2;
  const data = await sharp(stand.coverage, { raw: { width: SIZE, height: SIZE, channels: 1 } })
    .extract({ left, top, width, height }).extractChannel(0).raw().toBuffer();
  return { data, width, height, anchor: [round1(stand.faceAnchor[0] - left), round1(stand.faceAnchor[1] - top)] };
}

// The onboarding poses are hard-cut; lossy WebP leaves their alpha at 253
// with a haze of 1s around it.
function hardAlpha(rgba) {
  return Float32Array.from({ length: SIZE * SIZE }, (_, i) => (rgba[i * 4 + 3] >= 128 ? 255 : 0));
}

// White where recoloring applies: felt connected to the body (or a body-sized
// felt island), the dark shading and face ink it touches, and the small seams
// those enclose. Black for props and for holes that hold another color, like
// a tongue.
function poseBodyMask(rgba) {
  const n = SIZE * SIZE;
  const felt = new Uint8Array(n), strong = new Uint8Array(n), ink = new Uint8Array(n);
  const hue = new Float32Array(n), lightness = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!rgba[i * 4 + 3]) continue;
    const [L, a, b] = labAt(rgba, i);
    const C = Math.hypot(a, b), h = (Math.atan2(b, a) * 180) / Math.PI;
    hue[i] = h;
    lightness[i] = L;
    const bodyHue = h >= 48 && h <= 92 && L > 25;
    felt[i] = bodyHue && C >= 0.74 * L ? 1 : 0;
    strong[i] = bodyHue && C >= 0.95 * L && rgba[i * 4 + 3] >= 128 ? 1 : 0;
    ink[i] = L < 40 && (C < 8 || (h >= 15 && h <= 74)) ? 1 : 0;
  }
  const seeds = islands(strong, SIZE, SIZE).filter((island, index) => index === 0 || island.length >= MIN_BODY_ISLAND).flat();
  const body = flood(felt.map((f, i) => (f || ink[i] ? 1 : 0)), SIZE, SIZE, seeds);
  const mask = Buffer.from(Uint8Array.from(body, (v) => (v ? 255 : 0)));
  const holes = Uint8Array.from(body, (v, i) => (v || !rgba[i * 4 + 3] ? 0 : 1));
  for (const hole of islands(holes, SIZE, SIZE)) {
    const enclosed = hole.every((i) => [1, -1, SIZE, -SIZE].every((d) => body[i + d] || holes[i + d]));
    // A seam has the body's or the ink's hue, or is as dark as ink; a tongue is neither.
    const seam = median(hole.map((i) => hue[i])) >= 46 || median(hole.map((i) => lightness[i])) < 40;
    if (enclosed && seam && hole.length <= MAX_SEAM_HOLE) for (const i of hole) mask[i] = 255;
  }
  const grown = morph(Float32Array.from(mask), SIZE, SIZE, 1, Math.max);
  for (let i = 0; i < n; i++) if (!mask[i] && grown[i] && rgba[i * 4 + 3]) mask[i] = 128;
  return mask;
}

// A pose's own face: ink inside the body, with its coverage unmixed against
// the felt repainted under it.
function poseFace(rgba, mask, inkL, feltL) {
  // Hide what lies outside the body, but not the holes it encloses (a
  // tongue), so the ink around them still reads as interior.
  const border = [];
  for (let k = 0; k < SIZE; k++) border.push(k, (SIZE - 1) * SIZE + k, k * SIZE, k * SIZE + SIZE - 1);
  const outside = flood(Uint8Array.from(mask, (v) => (v ? 0 : 1)), SIZE, SIZE, border);
  const masked = Buffer.from(rgba);
  for (let i = 0; i < SIZE * SIZE; i++) if (outside[i]) masked[i * 4 + 3] = 0;
  const { core } = findFace(masked, SIZE, SIZE, 'ink');
  // Only features around the eyes are face; a dark gap by a hand is not.
  const [left, right] = eyes(core);
  const spacing = right[0] - left[0], eyeY = (left[1] + right[1]) / 2;
  const inFace = ([x, y]) => x >= left[0] - 0.6 * spacing && x <= right[0] + 0.6 * spacing && y >= eyeY - 0.5 * spacing && y <= eyeY + 0.9 * spacing;
  const faceCore = new Float32Array(SIZE * SIZE);
  for (const members of islands(core, SIZE, SIZE)) if (inFace(centroid(members))) for (const i of members) faceCore[i] = 1;
  const region = morph(faceCore, SIZE, SIZE, 4, Math.max).map((v, i) => (v && masked[i * 4 + 3] ? 1 : 0));
  return Buffer.from(inkCoverage(rgba, inpaint(masked, SIZE, SIZE, region), region, inkL, feltL));
}

const bodyBounds = (rgba, mask) => bounds(SIZE, SIZE, (i) => mask[i] === 255 && rgba[i * 4 + 3] > 128);

async function buildPose({ pose, file, recolor = true, reason }, inkL) {
  const source = await readSource(file);
  const cutOut = regionIndexes(SIZE, FLAT_SCENE.background).some((i) => source.data[i * 4 + 3] < 255);
  // A cut-out source has a hard 1-bit alpha to soften. A flat-background
  // render is keyed against its background, which keeps props that float
  // free of the body (Vision drops those), then unmixed at the edge.
  const background = sample(source.data, FLAT_SCENE.background);
  const alpha = cutOut
    ? softenHardEdge(hardAlpha(source.data), SIZE, SIZE)
    : softenHardEdge(Float32Array.from(unmixMatte(source, keyMatte(source, background), [background])), SIZE, SIZE);
  const soft = decontaminate(source, alpha, { largestOnly: false });
  const sourceMask = poseBodyMask(soft);
  const [x0, , x1, y1] = bodyBounds(soft, sourceMask);
  const [ax0, , ax1] = bounds(SIZE, SIZE, (i) => soft[i * 4 + 3] > 0);
  const dx = Math.min(Math.max(Math.round(SIZE / 2 - (x0 + x1 + 1) / 2), 2 - ax0), SIZE - 3 - ax1);
  const dy = GROUND_Y - y1;
  const master = place(soft, SIZE, SIZE, 4, SIZE, dx, dy);
  const mask = place(sourceMask, SIZE, SIZE, 1, SIZE, dx, dy);
  const face = poseFace(master, mask, inkL, feltStats(master, mask).lab[0]);
  return { pose, recolor, reason, master, mask, face, ...feltStats(master, mask, (i) => face[i] > 0) };
}

async function overlay(pose, file) {
  const out = Buffer.alloc(SIZE * SIZE * 3);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const a = pose.master[i * 4 + 3] / 255, m = (pose.mask[i] / 255) * 0.55, f = pose.face[i] / 255;
    for (let c = 0; c < 3; c++) {
      const base = pose.master[i * 4 + c] * a + 128 * (1 - a);
      const tinted = base * (1 - m) + [255, 0, 255][c] * m;
      out[i * 3 + c] = Math.round(tinted * (1 - f) + [0, 229, 255][c] * f);
    }
  }
  const ground = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><line x1="0" y1="${GROUND_Y + 0.5}" x2="${SIZE}" y2="${GROUND_Y + 0.5}" stroke="#00ff00" stroke-dasharray="4 4"/></svg>`;
  await sharp(out, { raw: { width: SIZE, height: SIZE, channels: 3 } }).composite([{ input: Buffer.from(ground) }]).png().toFile(file);
}

function palette(stands, poses, faces) {
  const hello = poses.find(({ pose }) => pose === 'hello');
  return {
    version: 1,
    lightnessQuantiles: LIGHTNESS_QUANTILES,
    faces,
    colors: {
      ...Object.fromEntries(stands.map((stand) => [stand.key, {
        name: stand.name,
        body: color(stand.lab),
        face: stand.kind,
        lightness: stand.lightness,
        ...(stand.layout === 'avatar' ? { avatar: Object.fromEntries(Object.entries(stand.scene).map(([part, rgb]) => [part, rgbHex(rgb)])) } : {}),
      }])),
      brand: { name: 'Chickpea orange', body: color(hello.lab), face: 'ink', lightness: hello.lightness },
    },
  };
}

function manifest(stands, poses, mattes) {
  return {
    version: 1,
    size: SIZE,
    groundY: GROUND_Y,
    bodyHeight: BODY_HEIGHT,
    faces: Object.fromEntries(Object.entries(mattes).map(([face, matte]) => [face, {
      file: `faces/${face}.png`, anchor: matte.anchor, from: matte.from,
    }])),
    masters: Object.fromEntries([
      ...stands.map((stand) => [`stand-${stand.key}`, {
        file: `masters/stand-${stand.key}.png`,
        kind: 'stand',
        color: stand.key,
        mask: `masters/stand-${stand.key}.body.png`,
        groundY: bodyBounds(stand.master, stand.mask)[3],
        body: stand.lab.map(round1),
        lightness: stand.lightness,
        face: { native: stand.face, anchor: stand.faceAnchor },
        recolor: true,
      }]),
      ...poses.map((pose) => [`pose-${pose.pose}`, {
        file: `masters/pose-${pose.pose}.png`,
        kind: 'pose',
        pose: pose.pose,
        color: 'brand',
        mask: `masters/pose-${pose.pose}.body.png`,
        groundY: bodyBounds(pose.master, pose.mask)[3],
        body: pose.lab.map(round1),
        lightness: pose.lightness,
        face: { matte: `masters/pose-${pose.pose}.face.png` },
        recolor: pose.recolor,
        ...(pose.reason ? { reason: pose.reason } : {}),
      }]),
    ]),
  };
}

// Pretty JSON with each array of numbers on one line.
const json = (value) => `${JSON.stringify(value, null, 2).replace(/\[\s+([-\d.,\s]+?)\s+\]/g, (_, inner) => `[${inner.split(/,\s*/).join(', ')}]`)}\n`;

const argv = process.argv.slice(2);
const debug = argv.includes('--debug') ? argv[argv.indexOf('--debug') + 1] : undefined;
for (const dir of ['masters', 'faces']) mkdirSync(join(KIT, dir), { recursive: true });
if (debug) mkdirSync(debug, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'chickpea-art-'));

const firstPass = [];
for (const stand of STANDS) firstPass.push(await buildStand(stand, scratch));
const faceColors = {
  ink: color(medianLab(firstPass.filter(({ kind }) => kind === 'ink').map(({ faceLab }) => faceLab))),
  cream: color(medianLab(firstPass.filter(({ kind }) => kind === 'cream').map(({ faceLab }) => faceLab))),
};
const inkL = faceColors.ink.lab[0];
const stands = firstPass;
const mattes = {};
for (const [face, source] of Object.entries(FACE_SOURCES)) {
  const recipe = typeof source === 'string'
    ? STANDS.find(({ key }) => key === source)
    : { key: `face-${face}`, name: face, face, kind: 'ink', ...source };
  mattes[face] = { ...await faceMatte(await buildStand(recipe, scratch, inkL)), from: typeof source === 'string' ? source : source.file };
}
const poses = [];
for (const pose of POSES) poses.push(await buildPose(pose, inkL));

for (const stand of stands) {
  await writePng(stand.master, SIZE, SIZE, 4, join(KIT, 'masters', `stand-${stand.key}.png`));
  await writePng(stand.mask, SIZE, SIZE, 1, join(KIT, 'masters', `stand-${stand.key}.body.png`));
}
for (const [face, matte] of Object.entries(mattes)) await writePng(matte.data, matte.width, matte.height, 1, join(KIT, 'faces', `${face}.png`));
for (const pose of poses) {
  await writePng(pose.master, SIZE, SIZE, 4, join(KIT, 'masters', `pose-${pose.pose}.png`));
  await writePng(pose.mask, SIZE, SIZE, 1, join(KIT, 'masters', `pose-${pose.pose}.body.png`));
  await writePng(pose.face, SIZE, SIZE, 1, join(KIT, 'masters', `pose-${pose.pose}.face.png`));
  if (debug) await overlay(pose, join(debug, `pose-${pose.pose}.overlay.png`));
}
writeFileSync(join(KIT, 'palette.json'), json(palette(stands, poses, faceColors)));
writeFileSync(join(KIT, 'manifest.json'), json(manifest(stands, poses, mattes)));
console.log(`Wrote ${stands.length} bodies, ${Object.keys(mattes).length} faces and ${poses.length} poses to ${KIT}`);
console.log('allowedBinaryFiles lines for scripts/lib/source-export-policy.mjs:');
for (const dir of ['faces', 'masters']) {
  for (const file of readdirSync(join(KIT, dir)).filter((name) => name.endsWith('.png')).sort()) {
    const hash = createHash('sha256').update(readFileSync(join(KIT, dir, file))).digest('hex');
    console.log(`  [exportPath('assets', 'chickpea', '${dir}', '${file}'), '${hash}'],`);
  }
}
