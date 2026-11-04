// Plane helpers for the art pipeline. A plane is a flat typed array of one
// value per pixel, row-major, `width` by `height`.
import sharp from 'sharp';

export async function readRgba(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export const PNG = { compressionLevel: 9, adaptiveFiltering: true, palette: false };

export const writePng = (data, width, height, channels, file) => {
  const image = sharp(data, { raw: { width, height, channels } });
  return (channels === 1 ? image.toColourspace('b-w') : image).png(PNG).toFile(file);
};

export const median = (values) => {
  const sorted = Float64Array.from(values).sort();
  return sorted[sorted.length >> 1];
};

export const quantile = (sorted, p) => sorted[Math.round(p * (sorted.length - 1))];

export const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export function hsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max ? d / max : 0, max / 255];
}

// Grayscale morphology over a disk: Math.min erodes, Math.max dilates.
// Pixels beyond the edge count as 0.
export function morph(plane, width, height, radius, op) {
  const offsets = [];
  const r = Math.floor(radius);
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (dx * dx + dy * dy <= radius * radius) offsets.push([dx, dy]);
  }
  const out = new Float32Array(plane.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let v = op === Math.min ? Infinity : -Infinity;
    for (const [dx, dy] of offsets) {
      const sx = x + dx, sy = y + dy;
      v = op(v, sx < 0 || sy < 0 || sx >= width || sy >= height ? 0 : plane[sy * width + sx]);
    }
    out[y * width + x] = v;
  }
  return out;
}

// Separable Gaussian blur, edges clamped.
export function blur(plane, width, height, sigma) {
  const radius = Math.ceil(sigma * 3);
  const kernel = Array.from({ length: radius * 2 + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)));
  const total = kernel.reduce((a, b) => a + b, 0);
  const pass = (src, horizontal) => {
    const dst = new Float32Array(src.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = horizontal ? Math.min(width - 1, Math.max(0, x + k)) : x;
        const sy = horizontal ? y : Math.min(height - 1, Math.max(0, y + k));
        acc += src[sy * width + sx] * kernel[k + radius];
      }
      dst[y * width + x] = acc / total;
    }
    return dst;
  };
  return pass(pass(plane, true), false);
}

// Blur of `values` where `weights` says how much each pixel counts: a fill
// that ignores the pixels with weight 0.
export function normalizedBlur(values, weights, width, height, sigma) {
  const top = blur(values.map((v, i) => v * weights[i]), width, height, sigma);
  const bottom = blur(weights, width, height, sigma);
  return top.map((v, i) => (bottom[i] > 1e-4 ? v / bottom[i] : 0));
}

// 8-connected flood over `allowed` from `seeds`.
export function flood(allowed, width, height, seeds) {
  const filled = new Uint8Array(allowed.length);
  const stack = seeds.filter((i) => allowed[i]);
  for (const i of stack) filled[i] = 1;
  while (stack.length) {
    const i = stack.pop();
    const x = i % width, y = (i / width) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const sx = x + dx, sy = y + dy;
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
      const j = sy * width + sx;
      if (allowed[j] && !filled[j]) { filled[j] = 1; stack.push(j); }
    }
  }
  return filled;
}

// Connected components of a 0/1 plane, largest first, each as pixel indexes.
export function islands(solid, width, height) {
  const seen = new Uint8Array(solid.length);
  const found = [];
  for (let i = 0; i < solid.length; i++) {
    if (!solid[i] || seen[i]) continue;
    const island = flood(solid, width, height, [i]);
    const members = [];
    for (let j = 0; j < island.length; j++) if (island[j]) { seen[j] = 1; members.push(j); }
    found.push(members);
  }
  return found.sort((a, b) => b.length - a.length);
}

// Bounding box [x0, y0, x1, y1] of pixels where `inside(i)` holds.
export function bounds(width, height, inside) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!inside(y * width + x)) continue;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

export function regionIndexes(width, regions) {
  const indexes = [];
  for (const [x0, y0, x1, y1] of regions) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) indexes.push(y * width + x);
  }
  return indexes;
}

// Copy a `channels`-deep image onto a `size` square canvas at an integer
// offset. Refuses to drop a visible pixel; the last channel is coverage.
export function place(data, width, height, channels, size, left, top) {
  const canvas = Buffer.alloc(size * size * channels);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = (y * width + x) * channels;
    const tx = x + left, ty = y + top;
    if (tx < 0 || ty < 0 || tx >= size || ty >= size) {
      if (data[from + channels - 1]) throw new Error('placement clips visible pixels');
      continue;
    }
    data.copy(canvas, (ty * size + tx) * channels, from, from + channels);
  }
  return canvas;
}
