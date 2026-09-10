import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';

import * as v from 'valibot';

import { fontText } from '../src/charts/bitmap-font.ts';
import { PNG_SIGNATURE } from '../src/charts/png.ts';
import {
  CHART_HEIGHT,
  CHART_WIDTH,
  ChartSpecError,
  chartSpecSchema,
  formatValue,
  PALETTE,
  renderChart,
  validateChartSpec,
  type ChartSpec,
} from '../src/charts/render-chart.ts';

const SERIES_0 = 5;
const TEXT = 1;
const GRID = 2;

/** Synthetic exam bookings; no production figures or transcripts. */
const BOOKINGS_BY_EXAM: ChartSpec = {
  kind: 'bar',
  title: "Today's bookings by exam",
  labels: ['GRE', 'TOEFL', 'GMAT', 'ACT', 'IELTS', 'SAT'],
  series: [{ name: 'Net bookings', values: [2400, 800, 400, 160, 80, 40] }],
  valuePrefix: '$',
};

interface DecodedPng {
  width: number;
  height: number;
  colorType: number;
  palette: number[][];
  pixels: Uint8Array;
}

function decodeIndexedPng(bytes: Uint8Array): DecodedPng {
  assert.deepEqual(bytes.subarray(0, 8), PNG_SIGNATURE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const palette: number[][] = [];
  const idat: Uint8Array[] = [];
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      assert.equal(data[8], 8, 'bit depth');
      colorType = data[9]!;
    } else if (type === 'PLTE') {
      for (let index = 0; index < data.length; index += 3) {
        palette.push([data[index]!, data[index + 1]!, data[index + 2]!]);
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat.map((part) => Buffer.from(part))));
  assert.equal(raw.length, (width + 1) * height);
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (width + 1)], 0, `row ${y} filter`);
    pixels.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  }
  return { width, height, colorType, palette, pixels };
}

/** Per-column pixel counts of `color`, skipping `skipTop` rows so legend swatches are not counted as bars. */
function columnCounts(image: DecodedPng, color: number, skipTop = 0): number[] {
  const counts = new Array<number>(image.width).fill(0);
  for (let y = skipTop; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.pixels[y * image.width + x] === color) counts[x] = (counts[x] ?? 0) + 1;
    }
  }
  return counts;
}

function bars(counts: number[]): number[] {
  const heights: number[] = [];
  let current = 0;
  for (const count of counts) {
    if (count > 0) {
      current = Math.max(current, count);
    } else if (current > 0) {
      heights.push(current);
      current = 0;
    }
  }
  if (current > 0) heights.push(current);
  return heights;
}

function countColor(image: DecodedPng, color: number, region?: { y0: number; y1: number }): number {
  let total = 0;
  const y0 = region?.y0 ?? 0;
  const y1 = region?.y1 ?? image.height;
  for (let y = y0; y < y1; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.pixels[y * image.width + x] === color) total += 1;
    }
  }
  return total;
}

test('the bookings-by-exam request renders a valid indexed PNG with six proportional bars', async () => {
  const started = performance.now();
  const rendered = await renderChart(BOOKINGS_BY_EXAM);
  const elapsed = performance.now() - started;

  assert.equal(rendered.width, CHART_WIDTH);
  assert.equal(rendered.height, CHART_HEIGHT);
  assert.ok(rendered.png.byteLength < 50_000, `png is ${rendered.png.byteLength} bytes`);
  const image = decodeIndexedPng(rendered.png);
  assert.equal(image.width, CHART_WIDTH);
  assert.equal(image.height, CHART_HEIGHT);
  assert.equal(image.colorType, 3);
  assert.deepEqual(image.palette, PALETTE.map((entry) => [...entry]));

  const heights = bars(columnCounts(image, SERIES_0));
  assert.equal(heights.length, 6, 'one bar per exam');
  for (let index = 1; index < heights.length; index += 1) {
    assert.ok(heights[index]! < heights[index - 1]!, 'bars follow the descending values');
  }
  const ratio = heights[0]! / heights[1]!;
  assert.ok(Math.abs(ratio - 2400 / 800) < 0.15, `GRE:TOEFL height ratio ${ratio}`);

  // Title text sits in the top band; tick labels and value labels use the same ink.
  assert.ok(countColor(image, TEXT, { y0: 0, y1: 60 }) > 200, 'title ink');
  assert.ok(countColor(image, GRID) > CHART_WIDTH, 'gridlines');
  // Not an assertion: a Worker-facing budget signal for the record.
  console.info(`render_chart bar: ${elapsed.toFixed(1)} ms, ${rendered.png.byteLength} bytes`);
});

test('rendering is deterministic for identical input', async () => {
  const first = await renderChart(BOOKINGS_BY_EXAM);
  const second = await renderChart(structuredClone(BOOKINGS_BY_EXAM));
  assert.deepEqual(first.png, second.png);
});

test('grouped bars, negative values, and long labels stay inside the canvas', async () => {
  const rendered = await renderChart({
    kind: 'bar',
    title: 'Weekly signups vs. purchases',
    labels: ['Monday morning', 'Tuesday', 'Wednesday afternoon', 'Thursday', 'Friday', 'Saturday', 'Sunday evening'],
    series: [
      { name: 'Signups', values: [120, 98, 143, 110, 87, 45, -30] },
      { name: 'Purchases', values: [12.5, 9, 14.25, 11, 8, 4, 3] },
    ],
  });
  const image = decodeIndexedPng(rendered.png);
  const plotTop = 100; // below the title band and the two-entry legend row
  assert.equal(bars(columnCounts(image, SERIES_0, plotTop)).length, 7);
  assert.equal(bars(columnCounts(image, SERIES_0 + 1, plotTop)).length, 7);
});

test('a line chart draws one connected series per input series', async () => {
  const rendered = await renderChart({
    kind: 'line',
    labels: Array.from({ length: 14 }, (_, index) => `Sep ${index + 1}`),
    series: [
      { name: 'Revenue', values: [1200, 1350, 900, 1600, 1750, 1420, 1100, 1900, 2100, 1800, 1650, 2300, 2450, 2200] },
      { name: 'Refunds', values: [100, 80, 120, 90, 70, 110, 95, 60, 85, 75, 90, 65, 70, 80] },
    ],
    valuePrefix: '$',
  });
  const image = decodeIndexedPng(rendered.png);
  // No title here, so the plot starts high; count every row (the legend swatch adds only a few columns).
  const revenue = columnCounts(image, SERIES_0);
  const nonEmpty = revenue.filter((count) => count > 0).length;
  assert.ok(nonEmpty > 700, `line spans ${nonEmpty} columns`);
  assert.ok(countColor(image, SERIES_0 + 1) > 500, 'second series drawn');
});

test('a pie chart allocates slice area by share and lists every slice in the legend', async () => {
  const rendered = await renderChart({
    kind: 'pie',
    title: 'Share of bookings by exam',
    labels: BOOKINGS_BY_EXAM.labels,
    series: [{ values: BOOKINGS_BY_EXAM.series[0]!.values }],
    valuePrefix: '$',
  });
  const image = decodeIndexedPng(rendered.png);
  const total = 2400 + 800 + 400 + 160 + 80 + 40;
  const sliceCounts = BOOKINGS_BY_EXAM.labels.map((_, index) => countColor(image, SERIES_0 + index));
  const drawn = sliceCounts.reduce((sum, count) => sum + count, 0);
  const share = sliceCounts[0]! / drawn;
  assert.ok(Math.abs(share - 2400 / total) < 0.02, `GRE share ${share}`);
  for (const count of sliceCounts) assert.ok(count > 0, 'every slice has pixels (legend swatch at minimum)');
});

test('input bounds are enforced by the schema and cross-field validation', () => {
  const tooMany = v.safeParse(chartSpecSchema, {
    kind: 'bar',
    labels: Array.from({ length: 41 }, (_, index) => `c${index}`),
    series: [{ values: Array.from({ length: 41 }, () => 1) }],
  });
  assert.equal(tooMany.success, false);
  assert.equal(v.safeParse(chartSpecSchema, {
    kind: 'bar', labels: ['a'], series: [{ values: [Number.NaN] }],
  }).success, false);
  assert.equal(v.safeParse(chartSpecSchema, {
    kind: 'bar', labels: ['a'], series: [{ values: [1] }], decimals: 7,
  }).success, false);

  assert.throws(
    () => validateChartSpec({ kind: 'bar', labels: ['a', 'b'], series: [{ values: [1] }] }),
    (error: unknown) => error instanceof ChartSpecError && /series 1 has 1 values/.test(error.message),
  );
  assert.throws(
    () => validateChartSpec({ kind: 'pie', labels: ['a'], series: [{ values: [1] }, { values: [2] }] }),
    ChartSpecError,
  );
  assert.throws(
    () => validateChartSpec({ kind: 'pie', labels: ['a', 'b'], series: [{ values: [1, -1] }] }),
    ChartSpecError,
  );
  assert.throws(
    () => validateChartSpec({ kind: 'pie', labels: ['a'], series: [{ values: [0] }] }),
    ChartSpecError,
  );
  assert.throws(
    () => validateChartSpec({
      kind: 'pie',
      labels: Array.from({ length: 13 }, (_, index) => `s${index}`),
      series: [{ values: Array.from({ length: 13 }, () => 1) }],
    }),
    /at most 12 slices/,
  );
});

test('the largest permitted chart renders within bounds', async () => {
  const labels = Array.from({ length: 40 }, (_, index) => `Category ${index + 1} with a long name`);
  const rendered = await renderChart({
    kind: 'bar',
    title: 'x'.repeat(80),
    labels,
    series: Array.from({ length: 6 }, (_, seriesIndex) => ({
      name: `Series ${seriesIndex + 1}`,
      values: labels.map((_, index) => (index + 1) * (seriesIndex + 1) * 1234.567),
    })),
    valuePrefix: '$',
    valueSuffix: ' USD',
    decimals: 3,
  });
  assert.equal(decodeIndexedPng(rendered.png).width, CHART_WIDTH);
});

test('extreme values fail validation before drawing, including direct renderer calls', async () => {
  for (const value of [Number.MAX_VALUE, -1e308, 1e308, Number.MIN_VALUE, 1e-300, Infinity, NaN]) {
    const spec: ChartSpec = { kind: 'line', labels: ['A', 'B'], series: [{ values: [0, value] }] };
    assert.equal(v.safeParse(chartSpecSchema, spec).success, false);
    await assert.rejects(renderChart(spec), ChartSpecError);
  }
  for (const value of [1e-9, -1e-9, 1e15, -1e15]) {
    const result = await renderChart({ kind: 'line', labels: ['A', 'B'], series: [{ values: [0, value] }] });
    assert.equal(decodeIndexedPng(result.png).width, CHART_WIDTH);
  }
});

test('a negative bar at the lowest tick keeps its value out of the category row', async () => {
  const chart = decodeIndexedPng((await renderChart({
    kind: 'bar', labels: ['Loss', 'Gain'], series: [{ values: [-100, 50] }],
  })).png);
  // Inspect the gap between the plot and the category labels under the first
  // bar. The value label used to draw into this gap and over the category.
  for (let y = 493; y < 500; y++) {
    for (let x = 200; x < 400; x++) {
      assert.notEqual(chart.pixels[y * chart.width + x], TEXT, `text in label gap at ${x},${y}`);
    }
  }
  assert.ok(chart.pixels.slice(476 * chart.width, 490 * chart.width).includes(TEXT));
});

test('value formatting groups thousands and preserves small nonzero values', () => {
  const auto = { prefix: '$', suffix: '', decimals: 2, trimZeros: true };
  assert.equal(formatValue(2400, auto), '$2,400');
  assert.equal(formatValue(12.5, auto), '$12.50'.replace('.50', '.5'));
  assert.equal(formatValue(-1234.5, auto), '-$1,234.5');
  assert.equal(formatValue(-0.001, auto), '-$1.00e-3');
  const pinned = { prefix: '', suffix: '%', decimals: 1, trimZeros: false };
  assert.equal(formatValue(42, pinned), '42.0%');
});

test('label text folds typographic punctuation and accents into the bitmap font range', () => {
  assert.equal(fontText('Today’s “net” bookings – café'), 'Today\'s "net" bookings - cafe');
  assert.equal(fontText('日本語'), '???');
  assert.equal(fontText('plain ASCII 123'), 'plain ASCII 123');
});
