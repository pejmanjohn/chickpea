#!/usr/bin/env node
// Renders review sheets for the Chickpea art kit into <out-dir>:
//   bodies.jpg  every standing body in every palette color with every face;
//   poses.jpg   every pose in every color it allows, with its masks overlaid;
//   edges.png   4x crops of the cut edges that touched the avatar arch.
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

// The edges where the arch touched the body in the render, 4x: the master
// on cream and on near-black, and the same edge in the source render.
async function edges() {
  const crops = [
    { master: 'stand-01-sage', label: 'sage shoulder', at: [75, 100], from: [65, 130] },
    { master: 'stand-02-coral', label: 'coral left edge', at: [55, 150], from: [55, 180] },
    { master: 'stand-02-coral', label: 'coral base', at: [360, 350], from: [360, 380] },
    { master: 'stand-09-warm-oat', label: 'warm oat right edge', at: [360, 170], from: [380, 190] },
  ];
  const side = 110, scale = 4, cell = side * scale, gap = 12;
  const layers = [];
  let labels = '';
  for (const [row, crop] of crops.entries()) {
    const color = manifest().masters[crop.master].color;
    const zoom = async (input, [left, top]) => sharp(input).extract({ left, top, width: side, height: side })
      .resize(cell, cell, { kernel: 'nearest' }).png().toBuffer();
    const body = await renderChickpea({ master: crop.master, color, face: 'none' });
    const on = async (background) => sharp(body).flatten({ background }).png().toBuffer();
    const y = HEADER + row * (cell + gap + 20);
    labels += text(gap, y + 14, `${crop.label}: master on cream, master on near-black, source render`);
    layers.push({ input: await zoom(await on(CANVAS), crop.at), left: gap, top: y + 20 });
    layers.push({ input: await zoom(await on('#202020'), crop.at), left: gap * 2 + cell, top: y + 20 });
    layers.push({ input: await zoom(join(ROOT, 'assets', 'chickpea-avatars', 'agent-defaults', `${color}.png`), crop.from), left: gap * 3 + cell * 2, top: y + 20 });
  }
  const width = gap * 4 + cell * 3, height = HEADER + crops.length * (cell + gap + 20);
  layers.push({ input: svg(width, height, labels), left: 0, top: 0 });
  const file = join(outDir, 'edges.png');
  await sharp({ create: { width, height, channels: 4, background: CANVAS } }).composite(layers).png().toFile(file);
  return file;
}

loaded = await loadKit();
for (const sheet of [bodies, poses, edges]) console.log(await sheet());
