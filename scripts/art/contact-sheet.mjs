#!/usr/bin/env node
// Renders review sheets for the Chickpea art kit into <out-dir>:
//   bodies.jpg  every standing body in every palette color with every face;
//   poses.jpg   every pose in every color it allows, with its masks overlaid;
//   edges.png   4x crops of the cut edges where the avatar arch touched a
//               body, and of both corners of every master's base;
//   seams.png   6x crops of the seams where a pose's props meet its body.
// Usage: node scripts/art/contact-sheet.mjs <out-dir> [--tile N]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { loadKit, renderChickpea } from '../chickpea-art.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const KIT = join(ROOT, 'assets', 'chickpea');
const argv = process.argv.slice(2);
const outDir = argv[0];
if (!outDir || outDir.startsWith('--')) throw new Error('Usage: node scripts/art/contact-sheet.mjs <out-dir> [--tile N]');
const TILE = argv.includes('--tile') ? Number(argv[argv.indexOf('--tile') + 1]) : 128;
const LABEL = 170;
const HEADER = 30;
const CANVAS = '#f4ebd8';
mkdirSync(outDir, { recursive: true });

const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const text = (x, y, value, anchor = 'start', size = 13) =>
  `<text x="${x}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" fill="#3b3220" text-anchor="${anchor}">${escape(value)}</text>`;
const svg = (width, height, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`);

async function grid(file, rows, columns, render) {
  const width = LABEL + columns.length * TILE, height = HEADER + rows.length * TILE;
  const layers = [];
  let labels = columns.map((column, index) => text(LABEL + index * TILE + TILE / 2, 20, column, 'middle', 11)).join('');
  for (const [row, { label, note }] of rows.entries()) {
    const top = HEADER + row * TILE;
    labels += text(8, top + TILE / 2, label) + (note ? text(8, top + TILE / 2 + 16, note, 'start', 11) : '');
    for (const [column, name] of columns.entries()) {
      const tile = await render(rows[row], name);
      if (tile) layers.push({ input: tile, left: LABEL + column * TILE, top });
    }
  }
  layers.push({ input: svg(width, height, labels), left: 0, top: 0 });
  await sharp({ create: { width, height, channels: 4, background: CANVAS } }).composite(layers).flatten({ background: CANVAS })
    .jpeg({ quality: 88 }).toFile(file);
  return file;
}

async function bodies() {
  const { palette, manifest } = await loadKit();
  const rows = Object.entries(manifest.masters).filter(([, entry]) => entry.kind === 'stand')
    .flatMap(([master, entry]) => Object.keys(manifest.faces).map((face) => ({
      master, face, label: `${master}`, note: `face ${face}${face === entry.face.native ? ' (native)' : ''}`,
    })));
  return grid(join(outDir, 'bodies.jpg'), rows, Object.keys(palette.colors),
    ({ master, face }, color) => renderChickpea({ master, color, face, size: TILE }));
}

async function overlay(entry) {
  const { data: rgba } = await sharp(join(KIT, entry.file)).raw().toBuffer({ resolveWithObject: true });
  const read = async (file) => (await sharp(join(KIT, file)).extractChannel(0).raw().toBuffer({ resolveWithObject: true })).data;
  const mask = await read(entry.mask), face = await read(entry.face.matte);
  const out = Buffer.alloc(rgba.length);
  for (let i = 0; i < mask.length; i++) {
    const m = (mask[i] / 255) * 0.6, f = face[i] / 255;
    for (let c = 0; c < 3; c++) {
      const tinted = rgba[i * 4 + c] * (1 - m) + [255, 0, 255][c] * m;
      out[i * 4 + c] = Math.round(tinted * (1 - f) + [0, 200, 255][c] * f);
    }
    out[i * 4 + 3] = rgba[i * 4 + 3];
  }
  return sharp(out, { raw: { width: manifest().size, height: manifest().size, channels: 4 } }).resize(TILE, TILE).png().toBuffer();
}

let loaded;
const manifest = () => loaded.manifest;

async function poses() {
  const { palette } = loaded;
  const rows = Object.entries(manifest().masters).filter(([, entry]) => entry.kind === 'pose').map(([master, entry]) => ({
    master, entry, label: master, note: entry.recolor ? '' : 'recolor: false',
  }));
  return grid(join(outDir, 'poses.jpg'), rows, ['body | face mask', ...Object.keys(palette.colors)], ({ master, entry }, color) => {
    if (color === 'body | face mask') return overlay(entry);
    if (!entry.recolor && color !== entry.color) return undefined;
    return renderChickpea({ master, color, size: TILE });
  });
}

// 4x crops of cut edges: the master on cream, on near-black, and the same
// place in its source render, found through the manifest's `source`
// transform. First the edges where the avatar arch touched a body, then both
// corners of every master's base.
async function edges() {
  const scale = 4, gap = 12, labelHeight = 20;
  const arch = [
    { master: 'stand-01-sage', label: 'sage shoulder', box: [75, 100, 110, 110] },
    { master: 'stand-02-coral', label: 'coral left edge', box: [55, 150, 110, 110] },
    { master: 'stand-09-warm-oat', label: 'warm oat right edge', box: [360, 170, 110, 110] },
  ];
  // Each base's corners: the body's extent 20 rows above its ground line.
  const bases = Object.entries(manifest().masters).map(([master, entry]) => {
    const row = entry.groundY - 20;
    return { master, row, find: async () => {
      const { data } = await sharp(join(KIT, entry.mask)).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
      let left = manifest().size, right = -1;
      for (let x = 0; x < manifest().size; x++) if (data[row * manifest().size + x] === 255) { left = Math.min(left, x); right = Math.max(right, x); }
      return [left, right];
    } };
  });
  const cells = async (master, box) => {
    const entry = manifest().masters[master];
    const [x, y, width, height] = box;
    const zoom = (input, region) => sharp(input).extract(region).resize(width * scale, height * scale, { kernel: 'nearest' }).png().toBuffer();
    const body = await renderChickpea({ master, color: entry.color, ...(entry.kind === 'stand' ? { face: 'none' } : {}) });
    const on = async (background) => sharp(body).flatten({ background }).png().toBuffer();
    const { file, scale: s, offset } = entry.source;
    const sourcePath = join(ROOT, file);
    const meta = await sharp(sourcePath).metadata();
    const sx = Math.max(0, Math.round((x - offset[0]) / s)), sy = Math.max(0, Math.round((y - offset[1]) / s));
    const region = { left: sx, top: sy, width: Math.min(meta.width - sx, Math.round(width / s)), height: Math.min(meta.height - sy, Math.round(height / s)) };
    const source = await sharp(await sharp(sourcePath).flatten({ background: CANVAS }).png().toBuffer()).extract(region)
      .resize(width * scale, height * scale, { kernel: 'nearest' }).png().toBuffer();
    return [await zoom(await on(CANVAS), { left: x, top: y, width, height }), await zoom(await on('#202020'), { left: x, top: y, width, height }), source];
  };
  const layers = [];
  let labels = '', y = 0, width = 0;
  for (const crop of arch) {
    labels += text(gap, y + 14, `${crop.label}: master on cream, master on near-black, source render`);
    const row = await cells(crop.master, crop.box);
    row.forEach((input, k) => layers.push({ input, left: gap + k * (crop.box[2] * scale + gap), top: y + labelHeight }));
    width = Math.max(width, gap + row.length * (crop.box[2] * scale + gap));
    y += labelHeight + crop.box[3] * scale + gap;
  }
  for (const base of bases) {
    const [left, right] = await base.find();
    const boxes = [[Math.max(0, left - 30), base.row - 16, 110, 40], [Math.min(manifest().size - 110, right - 80), base.row - 16, 110, 40]];
    labels += text(gap, y + 14, `${base.master} base, left and right: master on cream, master on near-black, source render`);
    const row = [...await cells(base.master, boxes[0]), ...await cells(base.master, boxes[1])];
    row.forEach((input, k) => layers.push({ input, left: gap + k * (110 * scale + gap) + (k >= 3 ? gap * 2 : 0), top: y + labelHeight }));
    width = Math.max(width, gap * 3 + row.length * (110 * scale + gap));
    y += labelHeight + 40 * scale + gap;
  }
  layers.push({ input: svg(width, y, labels), left: 0, top: 0 });
  const file = join(outDir, 'edges.png');
  await sharp({ create: { width, height: y, channels: 4, background: CANVAS } }).composite(layers).png().toFile(file);
  return file;
}

// The seams where a pose's props meet its body, 6x, in the brand color and
// two recolors: props keep their colors and no brand orange stays behind.
async function seams() {
  const crops = [
    { master: 'pose-moving-in', label: 'moving-in strap and hand', box: [95, 285, 90, 90] },
    { master: 'pose-coding-done', label: 'coding-done laptop', box: [150, 330, 90, 90] },
    { master: 'pose-chat', label: 'chat bubble', box: [380, 200, 90, 90] },
  ];
  const colors = ['brand', '10-midnight-indigo', '08-seafoam'];
  const scale = 6, gap = 12, labelHeight = 20, cell = 90 * scale;
  const layers = [];
  let labels = '', y = 0;
  for (const crop of crops) {
    labels += text(gap, y + 14, `${crop.label}: ${colors.join(', ')}`);
    const [left, top, width, height] = crop.box;
    for (const [k, color] of colors.entries()) {
      const image = await sharp(await renderChickpea({ master: crop.master, color })).flatten({ background: CANVAS }).png().toBuffer();
      const input = await sharp(image).extract({ left, top, width, height }).resize(cell, cell, { kernel: 'nearest' }).png().toBuffer();
      layers.push({ input, left: gap + k * (cell + gap), top: y + labelHeight });
    }
    y += labelHeight + cell + gap;
  }
  const width = gap + colors.length * (cell + gap);
  layers.push({ input: svg(width, y, labels), left: 0, top: 0 });
  const file = join(outDir, 'seams.png');
  await sharp({ create: { width, height: y, channels: 4, background: CANVAS } }).composite(layers).png().toFile(file);
  return file;
}

loaded = await loadKit();
for (const sheet of [bodies, poses, edges, seams]) console.log(await sheet());
