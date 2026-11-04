// Cutout steps for Chickpea art: a coarse Vision lift, an unmixed edge,
// rim decontamination, and face inpainting. See docs/chickpea-art.md.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toLab } from '../chickpea-art.mjs';
import { blur, flood, hsv, islands, median, morph, normalizedBlur, readRgba, smoothstep, writePng } from './raster.mjs';

const LIFT_SOURCE = fileURLToPath(new URL('./lift.swift', import.meta.url));

// Paint arch-colored pixels connected to the top rows to `background`, so
// Vision sees the chickpea alone. The dilation that covers the arch's soft
// edge stops at pixels near the body's own color, so it never bites the body.
export function paintOutArch({ data, width, height }, window, background, body) {
  const labs = Array.from({ length: width * height }, (_, i) => toLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]));
  const matches = new Uint8Array(width * height);
  for (let i = 0; i < matches.length; i++) {
    const [h, s, v] = hsv(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    matches[i] = window.hues.some(([lo, hi]) => h >= lo && h < hi) && s >= window.minSaturation &&
      v >= window.values[0] && v <= window.values[1] ? 1 : 0;
  }
  const topRows = Array.from({ length: width * Math.round(height * 0.12) }, (_, i) => i);
  const arch = morph(flood(matches, width, height, topRows), width, height, 2.5, Math.max);
  const painted = Buffer.from(data);
  for (let i = 0; i < arch.length; i++) {
    const nearBody = Math.hypot(...labs[i].map((v, c) => v - body[c])) < 30;
    if (arch[i] && !nearBody) painted.set(background, i * 4);
  }
  return { data: painted, width, height };
}

// Vision's subject lift (macOS only): the coarse alpha of the subject under
// the image's lower center, or of every subject with `all`.
let liftBinary;
export async function visionLift(image, scratch, name, { all = false } = {}) {
  if (!liftBinary) {
    liftBinary = join(scratch, 'lift');
    execFileSync('swiftc', ['-O', LIFT_SOURCE, '-o', liftBinary], { stdio: 'inherit' });
  }
  const input = join(scratch, `${name}.in.png`), output = join(scratch, `${name}.lift.png`);
  await writePng(image.data, image.width, image.height, 4, input);
  execFileSync(liftBinary, [input, output, ...(all ? ['--all'] : [])], { stdio: ['ignore', 'ignore', 'inherit'] });
  const lifted = await readRgba(output);
  return Float32Array.from({ length: image.width * image.height }, (_, i) => lifted.data[i * 4 + 3]);
}

// A coarse alpha for a render on a flat background: opaque wherever a pixel
// is clearly not the background color.
export function keyMatte({ data, width, height }, background, threshold = 40) {
  return Float32Array.from({ length: width * height }, (_, i) =>
    (Math.sqrt(dist2([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]], background)) > threshold ? 255 : 0));
}

// Recompute alpha in the band just inside the coarse edge by unmixing each
// pixel between the body color and the scene color next to it: alpha is how
// far the pixel sits from the scene color toward the body, through
// smoothstep(0.3, 0.8). Both colors are local averages, the body's from the
// opaque core and the scene's from just outside the coarse mask, so a dark
// base unmixes against the floor under it, not against a dark doorway
// elsewhere. Where no scene pixel is near, the nearest of `sceneColors`
// stands in. Nothing outside the coarse mask is added back.
export function unmixMatte({ data, width, height }, coarse, sceneColors, band = 4) {
  const n = width * height;
  const channel = (c) => Float32Array.from({ length: n }, (_, i) => data[i * 4 + c]);
  const core = morph(coarse.map((a) => (a >= 250 ? 1 : 0)), width, height, band, Math.min);
  const outside = coarse.map((a) => (a ? 0 : 1));
  const body = [0, 1, 2].map((c) => normalizedBlur(channel(c), core, width, height, 4));
  const scene = [0, 1, 2].map((c) => normalizedBlur(channel(c), outside, width, height, 4));
  const bodyWeight = blur(core, width, height, 4);
  const sceneWeight = blur(outside, width, height, 4);
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (core[i]) { alpha[i] = 255; continue; }
    if (!coarse[i] || bodyWeight[i] < 1e-3) { alpha[i] = Math.round(coarse[i]); continue; }
    const px = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
    const fg = body.map((plane) => plane[i]);
    const bg = sceneWeight[i] > 0.02
      ? scene.map((plane) => plane[i])
      : sceneColors.reduce((best, color) => (dist2(px, color) < dist2(px, best) ? color : best));
    // Where the body and the scene color are too close to tell apart (a dark
    // base on a dark floor), the unmix is noise; keep Vision's alpha there.
    const trust = smoothstep(45, 90, Math.sqrt(dist2(fg, bg)));
    alpha[i] = Math.round(coarse[i] * (1 - trust) + 255 * unmix(px, fg, bg) * trust);
  }
  return alpha;
}

// How much of `px` is `fg` rather than `bg`: its position along the line
// from bg to fg, through smoothstep(0.3, 0.8).
export function unmix(px, fg, bg) {
  const d = fg.map((v, c) => v - bg[c]);
  const along = ((px[0] - bg[0]) * d[0] + (px[1] - bg[1]) * d[1] + (px[2] - bg[2]) * d[2]) / Math.max(1, dist2(fg, bg));
  return smoothstep(0.3, 0.8, along);
}

const dist2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;

// Shave an alpha by a pixel and soften it: a 1-bit edge gets anti-aliasing,
// and an unmixed edge loses its stray specks.
export function softenHardEdge(alpha, width, height) {
  return blur(morph(alpha, width, height, 1, Math.min), width, height, 0.7).map(Math.round);
}

// Fit a smooth contour to the base, where a body met a floor close to its
// own color: blur the solid shape and threshold it with a 2px ramp, in a
// band over the lowest 40 rows of the body and fading in over 15 rows
// above. `near` limits it to pixels around the body (a pose's props keep
// their edges). The rest of the silhouette is unchanged. Returns the alpha
// and `rim`, the pixels within 3px of the new base edge, whose colors still
// follow the old one and need decontaminating.
export function smoothBase(alpha, width, height, near = () => true) {
  const solid = Float32Array.from(alpha, (a) => (a >= 128 ? 1 : 0));
  const contour = blur(solid, width, height, 7);
  let bottom = -1;
  for (let i = 0; i < alpha.length; i++) if (solid[i] && near(i)) bottom = Math.max(bottom, (i / width) | 0);
  const band = (i) => (near(i) ? smoothstep(bottom - 55, bottom - 40, (i / width) | 0) : 0);
  const smoothed = Float32Array.from(alpha, (a, i) => a * (1 - band(i)) + 255 * smoothstep(0.4, 0.6, contour[i]) * band(i));
  const inner = morph(smoothed.map((a) => (a >= 245 ? 1 : 0)), width, height, 3, Math.min);
  return { alpha: smoothed, rim: (i) => band(i) > 0 && !inner[i] };
}

// Give every pixel under the opaque core's rim the core's nearby color, so no
// scene tint survives on a soft edge. `rim` widens the rim to more pixels
// (opaque ones whose color still carries the old edge). Returns RGBA with
// `alpha`, by default keeping only the largest visible island.
export function decontaminate({ data, width, height }, alpha, { largestOnly = true, rim: widen = () => false } = {}) {
  const n = width * height;
  const core = Float32Array.from(alpha, (a, i) => (a >= 245 && !widen(i) ? 1 : 0));
  const rim = [0, 1, 2].map((c) => normalizedBlur(Float32Array.from({ length: n }, (_, i) => data[i * 4 + c]), core, width, height, 3));
  const weight = blur(core, width, height, 3);
  const out = Buffer.alloc(n * 4);
  const keep = Uint8Array.from(alpha, (a) => (a ? 1 : 0));
  if (largestOnly) {
    keep.fill(0);
    for (const i of islands(Uint8Array.from(alpha, (a) => (a ? 1 : 0)), width, height)[0]) keep[i] = 1;
  }
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const useRim = !core[i] && weight[i] > 1e-4;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = useRim ? Math.round(Math.min(255, rim[c][i])) : data[i * 4 + c];
    out[i * 4 + 3] = alpha[i];
  }
  return out;
}

// Face features: interior pixels far from the felt around them, darker (and
// near black) for ink faces and lighter for cream ones. The felt around a pixel is a median
// over about 44px, which a feature is too small to sway and which follows
// the soft shading at the base. Returns the feature core and the region to
// repaint (the core plus 4px, which covers anti-aliasing and the cream
// faces' dark rim).
export function findFace(rgba, width, height, kind) {
  const n = width * height;
  const opaque = Float32Array.from({ length: n }, (_, i) => (rgba[i * 4 + 3] >= 250 ? 1 : 0));
  const interior = morph(opaque, width, height, 8, Math.min);
  const lightness = Float32Array.from({ length: n }, (_, i) => toLab(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2])[0]);
  const felt = localMedian(lightness, opaque, width, height);
  const sign = kind === 'ink' ? -1 : 1;
  // Ink is near black; shading creases are only darker than the felt.
  const core = Uint8Array.from({ length: n }, (_, i) =>
    (interior[i] && sign * (lightness[i] - felt[i]) > 20 && (kind !== 'ink' || lightness[i] < 25) ? 1 : 0));
  const region = morph(core, width, height, 4, Math.max).map((v, i) => (v && rgba[i * 4 + 3] ? 1 : 0));
  return { core, region };
}

// Median of `values` over opaque pixels in an 11x11 window of 4px blocks,
// read back bilinearly at full size.
function localMedian(values, opaque, width, height, block = 4, radius = 5) {
  const bw = Math.ceil(width / block), bh = Math.ceil(height / block);
  const means = new Float32Array(bw * bh).fill(NaN);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let sum = 0, count = 0;
    for (let y = by * block; y < Math.min(height, (by + 1) * block); y++) {
      for (let x = bx * block; x < Math.min(width, (bx + 1) * block); x++) {
        if (opaque[y * width + x]) { sum += values[y * width + x]; count++; }
      }
    }
    if (count === block * block) means[by * bw + bx] = sum / count;
  }
  const medians = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const window = [];
    for (let y = Math.max(0, by - radius); y <= Math.min(bh - 1, by + radius); y++) {
      for (let x = Math.max(0, bx - radius); x <= Math.min(bw - 1, bx + radius); x++) {
        if (!Number.isNaN(means[y * bw + x])) window.push(means[y * bw + x]);
      }
    }
    medians[by * bw + bx] = window.length ? median(window) : 0;
  }
  return Float32Array.from({ length: width * height }, (_, i) => {
    const fx = Math.min(bw - 1, Math.max(0, (i % width) / block - 0.5));
    const fy = Math.min(bh - 1, Math.max(0, ((i / width) | 0) / block - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(bw - 1, x0 + 1), y1 = Math.min(bh - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const at = (x, y) => medians[y * bw + x];
    return (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
  });
}

// Repaint `region` with felt: a normalized-convolution fill of the colors
// around it, plus the high-frequency felt texture from `shift` px above.
export function inpaint(rgba, width, height, region, shift = 70) {
  const n = width * height;
  const keep = Float32Array.from({ length: n }, (_, i) => (!region[i] && rgba[i * 4 + 3] >= 250 ? 1 : 0));
  const channel = (c) => Float32Array.from({ length: n }, (_, i) => rgba[i * 4 + c]);
  const fill = [0, 1, 2].map((c) => normalizedBlur(channel(c), keep, width, height, 12));
  const low = [0, 1, 2].map((c) => blur(channel(c), width, height, 2.5));
  const out = Buffer.from(rgba);
  for (let i = 0; i < n; i++) {
    if (!region[i]) continue;
    const x = i % width, y = (i / width) | 0;
    const j = Math.max(0, y - shift) * width + x;
    for (let c = 0; c < 3; c++) {
      const texture = rgba[j * 4 + c] - low[c][j];
      out[i * 4 + c] = Math.round(Math.min(255, Math.max(0, fill[c][i] + texture)));
    }
  }
  return out;
}

// Ink coverage of each face pixel, unmixed by lightness between the ink and
// the felt: the repainted felt under it, or the body's median felt, whichever
// gives more coverage, so a pixel never stays half ink because the repaint
// came out dark.
export function inkCoverage(original, repainted, region, inkL, feltL = 0) {
  const unmix = (felt, L) => (felt - L) / Math.max(1, felt - inkL);
  return Uint8Array.from({ length: region.length }, (_, i) => {
    if (!region[i]) return 0;
    const [L] = toLab(original[i * 4], original[i * 4 + 1], original[i * 4 + 2]);
    const [felt] = toLab(repainted[i * 4], repainted[i * 4 + 1], repainted[i * 4 + 2]);
    // Felt texture mottles the ink; full coverage from 75% unmixed keeps
    // the features solid.
    return Math.round(255 * Math.min(1, Math.max(0, Math.max(unmix(felt, L), unmix(feltL, L)) / 0.75)));
  });
}

export const medianLab = (labs) => [0, 1, 2].map((c) => median(labs.map((lab) => lab[c])));
