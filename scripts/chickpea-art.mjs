#!/usr/bin/env node
// Renders Chickpea art from the kit in assets/chickpea: a master body in any
// palette color, with a face from the kit's face set. See docs/chickpea-art.md.
//
//   npm run art:chickpea -- <master> <color> <out.png|out.webp> [--face NAME|none] [--size N] [--shadow]
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// sRGB <-> CIELAB (D65).
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const labF = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const labFInverse = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
const clamp01 = (value) => Math.min(1, Math.max(0, value));

export function toLab(r, g, b) {
  const R = linear(r / 255), G = linear(g / 255), B = linear(b / 255);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  return [116 * labF(Y) - 16, 500 * (labF(X) - labF(Y)), 200 * (labF(Y) - labF(Z))];
}

export function toRgb(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const X = labFInverse(fx) * 0.95047, Y = labFInverse(fy), Z = labFInverse(fz) * 1.08883;
  const R = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  const G = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  const B = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  return [R, G, B].map((c) => Math.round(255 * clamp01(gamma(clamp01(c)))));
}

export const labToHex = (lab) => `#${toRgb(...lab).map((c) => c.toString(16).padStart(2, '0')).join('')}`;

// Lightness quantiles each palette entry and body records, by probability.
export const LIGHTNESS_QUANTILES = [0.02, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 0.98];

const KIT = fileURLToPath(new URL('../assets/chickpea/', import.meta.url));
const PNG = { compressionLevel: 9, adaptiveFiltering: true, palette: false };
const WEBP = { quality: 90, alphaQuality: 100, effort: 6 };

let kit;
export function loadKit() {
  kit ??= Promise.all(['palette.json', 'manifest.json'].map(async (file) => JSON.parse(await readFile(join(KIT, file), 'utf8'))))
    .then(([palette, manifest]) => ({ palette, manifest }));
  return kit;
}

async function plane(file, channels) {
  const image = sharp(join(KIT, file));
  const { data, info } = await (channels === 1 ? image.extractChannel(0) : image.ensureAlpha()).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// Map lightness by rank: piecewise-linear between the source body's quantiles
// and the target color's. Past the ends, follow the outer segment, never
// steeper than 1, so the tails never stretch.
export function toneMap(L, from, to) {
  const last = from.length - 1;
  const edge = (span, target) => (span > 0 ? Math.min(1, target / span) : 1);
  if (L <= from[0]) return to[0] + (L - from[0]) * edge(from[1] - from[0], to[1] - to[0]);
  if (L >= from[last]) return to[last] + (L - from[last]) * edge(from[last] - from[last - 1], to[last] - to[last - 1]);
  let k = 0;
  while (L > from[k + 1]) k++;
  const span = from[k + 1] - from[k];
  return span > 0 ? to[k] + ((L - from[k]) / span) * (to[k + 1] - to[k]) : to[k];
}

// 1px inner shadow of a face feature: how much of a pixel's 3x3 neighborhood
// the feature does not cover, weighted toward the feature's lower edge.
function creamShade(coverage, width, height, x, y) {
  const at = (sx, sy) => (sx < 0 || sy < 0 || sx >= width || sy >= height ? 0 : coverage[sy * width + sx] / 255);
  let lowest = 1;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) lowest = Math.min(lowest, at(x + dx, y + dy));
  const rim = at(x, y) - lowest;
  const below = clamp01(at(x, y) - at(x, y + 1));
  return clamp01(0.5 * rim + 0.5 * below);
}

// The fill of a face feature pixel: flat ink, or cream that darkens toward
// its rim like the real deep-moss and midnight-indigo renders.
function faceFill(kind, faces, shade) {
  if (kind === 'ink') return faces.ink.lab;
  const [L, a, b] = faces.cream.lab;
  return [L - 38 * shade, a + 4 * shade, b - 6 * shade];
}

function recolor(rgba, mask, face, entry, target, faces) {
  const out = Buffer.from(rgba);
  const sourceChroma = Math.hypot(entry.body[1], entry.body[2]);
  const [, ta, tb] = target.body.lab;
  const ink = faces.ink.lab;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const lab = toLab(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    const w = face ? face.data[i] / 255 : 0;
    // Under a pose's own face, recover the felt by unmixing the ink out.
    const felt = w === 0 ? lab : w > 0.95 ? entry.body : lab.map((v, c) => (v - w * ink[c]) / (1 - w));
    const k = sourceChroma > 1 ? Math.hypot(felt[1], felt[2]) / sourceChroma : 1;
    let result = [toneMap(felt[0], entry.lightness, target.lightness), ta * k, tb * k];
    if (w > 0) {
      const fill = faceFill(target.face, faces, creamShade(face.data, face.width, face.height, i % face.width, (i / face.width) | 0));
      result = result.map((v, c) => v * (1 - w) + fill[c] * w);
    }
    const rgb = toRgb(...result);
    const m = mask[i] / 255;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(rgba[i * 4 + c] * (1 - m) + rgb[c] * m);
  }
  return out;
}

// Composite a face matte onto a body so its anchor lands on the body's.
function placeFace(body, size, matte, offset, kind, faces) {
  const out = Buffer.from(body);
  for (let y = 0; y < matte.height; y++) for (let x = 0; x < matte.width; x++) {
    const tx = x + offset[0], ty = y + offset[1];
    if (tx < 0 || ty < 0 || tx >= size || ty >= size) continue;
    const i = ty * size + tx;
    const w = (matte.data[y * matte.width + x] / 255) * (body[i * 4 + 3] / 255);
    if (!w) continue;
    const fill = toRgb(...faceFill(kind, faces, creamShade(matte.data, matte.width, matte.height, x, y)));
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(body[i * 4 + c] * (1 - w) + fill[c] * w);
  }
  return out;
}

// A soft contact shadow under the body, behind it.
async function withShadow(rgba, size, mask, groundY) {
  let x0 = size, x1 = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 255) continue;
    x0 = Math.min(x0, i % size); x1 = Math.max(x1, i % size);
  }
  const rx = (x1 - x0) * 0.42, cx = (x0 + x1) / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><defs><filter id="s" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${rx * 0.06}"/></filter></defs><ellipse cx="${cx}" cy="${groundY - rx * 0.02}" rx="${rx}" ry="${rx * 0.07}" fill="#000" fill-opacity="0.32" filter="url(#s)"/></svg>`;
  return sharp(Buffer.from(svg)).composite([{ input: rgba, raw: { width: size, height: size, channels: 4 } }]).raw().toBuffer();
}

// Renders `master` in palette `color` as a transparent PNG (or WebP with
// format 'webp'). A standing body takes `face` from the kit's face set
// (default: the face its render had; 'none' for the bare body); a pose
// carries its own face. In the master's native color with no face change the
// master's pixels come back unchanged; outside the body mask nothing changes.
export async function renderChickpea({ master, color, face, size, format = 'png', shadow = false }) {
  const { palette, manifest } = await loadKit();
  const entry = manifest.masters[master];
  if (!entry) throw new Error(`Unknown master "${master}". Masters: ${Object.keys(manifest.masters).join(', ')}`);
  const target = palette.colors[color];
  if (!target) throw new Error(`Unknown color "${color}". Colors: ${Object.keys(palette.colors).join(', ')}`);
  if (color !== entry.color && !entry.recolor) throw new Error(`${master} is not recolorable: ${entry.reason}`);
  const isStand = entry.kind === 'stand';
  if (!isStand && face !== undefined) throw new Error(`${master} is a pose and carries its own face`);
  const faceName = isStand ? face ?? entry.face.native : undefined;
  if (faceName !== undefined && faceName !== 'none' && !manifest.faces[faceName]) {
    throw new Error(`Unknown face "${faceName}". Faces: none, ${Object.keys(manifest.faces).join(', ')}`);
  }
  const native = manifest.size;
  const body = await plane(entry.file, 4);
  const mask = (await plane(entry.mask, 1)).data;
  let rgba = body.data;
  if (color !== entry.color) {
    const poseFace = isStand ? undefined : await plane(entry.face.matte, 1);
    rgba = recolor(rgba, mask, poseFace, entry, target, palette.faces);
  }
  if (faceName !== undefined && faceName !== 'none') {
    const matte = await plane(manifest.faces[faceName].file, 1);
    const anchor = manifest.faces[faceName].anchor;
    const offset = [Math.round(entry.face.anchor[0] - anchor[0]), Math.round(entry.face.anchor[1] - anchor[1])];
    rgba = placeFace(rgba, native, matte, offset, target.face, palette.faces);
  }
  if (shadow) rgba = await withShadow(rgba, native, mask, entry.groundY);
  let image = sharp(rgba, { raw: { width: native, height: native, channels: 4 } });
  if (size !== undefined && size !== native) image = image.resize(size, size, { kernel: 'lanczos3' });
  return format === 'webp' ? image.webp(WEBP).toBuffer() : image.png(PNG).toBuffer();
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  args.splice(index, 2);
  return value;
}

async function main(argv) {
  const args = [...argv];
  const face = option(args, '--face');
  const size = option(args, '--size');
  const shadow = args.includes('--shadow');
  const [master, color, out, ...rest] = args.filter((arg) => arg !== '--shadow');
  if (!out || rest.length) {
    throw new Error('Usage: npm run art:chickpea -- <master> <color> <out.png|out.webp> [--face NAME|none] [--size N] [--shadow]');
  }
  const format = { '.png': 'png', '.webp': 'webp' }[extname(out).toLowerCase()];
  if (!format) throw new Error(`${out} must end in .png or .webp`);
  if (size !== undefined && !/^[1-9]\d*$/.test(size)) throw new Error('--size must be a positive integer');
  const bytes = await renderChickpea({ master, color, face, format, shadow, ...(size ? { size: Number(size) } : {}) });
  await writeFile(resolve(out), bytes);
  console.log(`Wrote ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
