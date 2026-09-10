import * as v from 'valibot';

import {
  fontText,
  GLYPH_ADVANCE,
  GLYPH_HEIGHT,
  GLYPH_WIDTH,
  glyphMasks,
  textHeight,
  textWidth,
} from './bitmap-font.ts';
import { encodeIndexedPng, type RgbColor } from './png.ts';

/**
 * Deterministic chart renderer. It draws bar, line, and pie charts onto a
 * fixed-size palette raster with a bitmap font and encodes an indexed PNG.
 * Every input dimension is bounded so one call costs a predictable amount of
 * CPU and memory on any runtime, including a Worker without a container.
 */

export const CHART_WIDTH = 960;
export const CHART_HEIGHT = 540;
export const CHART_MAX_CATEGORIES = 40;
export const CHART_MAX_SERIES = 6;
export const CHART_MAX_PIE_SLICES = 12;
export const CHART_MAX_VALUE = 1e15;
export const CHART_MIN_NONZERO_VALUE = 1e-9;
const MAX_LABEL_CHARS = 40;
const MAX_TITLE_CHARS = 80;

const label = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_LABEL_CHARS));

export const chartSpecSchema = v.object({
  kind: v.picklist(['bar', 'line', 'pie']),
  title: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_TITLE_CHARS))),
  labels: v.pipe(v.array(label), v.minLength(1), v.maxLength(CHART_MAX_CATEGORIES)),
  series: v.pipe(
    v.array(v.object({
      name: v.optional(label),
      values: v.pipe(
        v.array(v.pipe(v.number(), v.finite(), v.check(validChartValue,
          'chart values must be zero or have a magnitude between 1e-9 and 1e15'))),
        v.minLength(1),
        v.maxLength(CHART_MAX_CATEGORIES),
      ),
    })),
    v.minLength(1),
    v.maxLength(CHART_MAX_SERIES),
  ),
  valuePrefix: v.optional(v.pipe(v.string(), v.maxLength(4))),
  valueSuffix: v.optional(v.pipe(v.string(), v.maxLength(6))),
  decimals: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(3))),
});

export type ChartSpec = v.InferOutput<typeof chartSpecSchema>;

export class ChartSpecError extends Error {
  override name = 'ChartSpecError';
}

function validChartValue(value: number): boolean {
  return Number.isFinite(value) && (value === 0 ||
    (Math.abs(value) >= CHART_MIN_NONZERO_VALUE && Math.abs(value) <= CHART_MAX_VALUE));
}

/** Cross-field checks the schema cannot express. Throws `ChartSpecError`. */
export function validateChartSpec(spec: ChartSpec): void {
  const parsed = v.safeParse(chartSpecSchema, spec);
  if (!parsed.success) throw new ChartSpecError(parsed.issues[0]!.message);
  for (const [index, series] of spec.series.entries()) {
    if (series.values.length !== spec.labels.length) {
      throw new ChartSpecError(
        `series ${index + 1} has ${series.values.length} values but there are ${spec.labels.length} labels`,
      );
    }
  }
  if (spec.kind === 'pie') {
    if (spec.series.length !== 1) {
      throw new ChartSpecError('a pie chart takes exactly one series');
    }
    if (spec.labels.length > CHART_MAX_PIE_SLICES) {
      throw new ChartSpecError(
        `a pie chart supports at most ${CHART_MAX_PIE_SLICES} slices; use a bar chart for more categories`,
      );
    }
    const values = spec.series[0]!.values;
    if (values.some((value) => value < 0)) {
      throw new ChartSpecError('pie chart values must not be negative');
    }
    if (values.reduce((sum, value) => sum + value, 0) <= 0) {
      throw new ChartSpecError('pie chart values must add up to a positive total');
    }
  }
}

export interface RenderedChart {
  png: Uint8Array;
  width: number;
  height: number;
}

export async function renderChart(spec: ChartSpec): Promise<RenderedChart> {
  validateChartSpec(spec);
  const raster = new Raster(CHART_WIDTH, CHART_HEIGHT, Color.background);
  const format = valueFormat(spec);
  let top = PAD;
  if (spec.title) {
    const title = fitText(fontText(spec.title), CHART_WIDTH - PAD * 2, TITLE_SCALE);
    raster.text(
      Math.round((CHART_WIDTH - textWidth(title, TITLE_SCALE)) / 2),
      top,
      title,
      TITLE_SCALE,
      Color.text,
    );
    top += textHeight(TITLE_SCALE) + 16;
  }
  if (spec.kind === 'pie') {
    drawPie(raster, spec, format, top);
  } else {
    top = drawLegend(raster, spec, top);
    drawAxes(raster, spec, format, top);
  }
  const png = await encodeIndexedPng({
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    palette: PALETTE,
    pixels: raster.pixels,
  });
  return { png, width: CHART_WIDTH, height: CHART_HEIGHT };
}

// ---------------------------------------------------------------------------
// Palette and layout constants

const PAD = 24;
const LABEL_SCALE = 2;
const TITLE_SCALE = 3;
const LEGEND_SWATCH = 12;
const MAX_VERTICAL_LABEL_CHARS = 14;

const Color = {
  background: 0,
  text: 1,
  grid: 2,
  axis: 3,
  muted: 4,
} as const;
const SERIES_COLOR_START = 5;

export const PALETTE: readonly RgbColor[] = [
  [0xff, 0xff, 0xff],
  [0x1f, 0x29, 0x33],
  [0xe5, 0xe7, 0xeb],
  [0x6b, 0x72, 0x80],
  [0x4b, 0x55, 0x63],
  // Series colours: six saturated, then six lighter companions.
  [0x2f, 0x6d, 0xb5],
  [0xe2, 0x87, 0x2b],
  [0x3e, 0x9b, 0x5a],
  [0xc9, 0x4c, 0x4c],
  [0x8a, 0x62, 0xb8],
  [0xc9, 0xa2, 0x27],
  [0x8f, 0xb4, 0xe0],
  [0xf2, 0xc0, 0x8c],
  [0x9c, 0xcf, 0xab],
  [0xe6, 0xa1, 0xa1],
  [0xc4, 0xb0, 0xdd],
  [0xe8, 0xd5, 0x8e],
];
const SERIES_COLOR_COUNT = PALETTE.length - SERIES_COLOR_START;

function seriesColor(index: number): number {
  return SERIES_COLOR_START + (index % SERIES_COLOR_COUNT);
}

// ---------------------------------------------------------------------------
// Value formatting

interface ValueFormat {
  prefix: string;
  suffix: string;
  decimals: number;
  /** Auto mode drops trailing zeros so `12.5` and `120` sit together naturally. */
  trimZeros: boolean;
}

function valueFormat(spec: ChartSpec): ValueFormat {
  const allIntegers = spec.series.every((series) => series.values.every(Number.isInteger));
  return {
    prefix: fontText(spec.valuePrefix ?? ''),
    suffix: fontText(spec.valueSuffix ?? ''),
    decimals: spec.decimals ?? (allIntegers ? 0 : 2),
    trimZeros: spec.decimals === undefined,
  };
}

export function formatValue(value: number, format: ValueFormat): string {
  const rounded = Number(value.toFixed(format.decimals));
  // Preserve a nonzero value that the requested decimal precision would hide.
  if ((rounded === 0 && value !== 0) || Math.abs(value) >= 1e12) {
    return `${value < 0 ? '-' : ''}${format.prefix}${Math.abs(value).toExponential(2)}${format.suffix}`;
  }
  const [integer = '0', fractionDigits] = Math.abs(rounded).toFixed(format.decimals).split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = format.trimZeros ? fractionDigits?.replace(/0+$/, '') : fractionDigits;
  const sign = rounded < 0 ? '-' : '';
  return `${sign}${format.prefix}${grouped}${fraction ? `.${fraction}` : ''}${format.suffix}`;
}

// ---------------------------------------------------------------------------
// Axis scale

interface AxisScale {
  low: number;
  high: number;
  ticks: number[];
  tickFormat: ValueFormat;
}

function niceStep(range: number): number {
  const raw = range / 5;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

function axisScale(spec: ChartSpec, format: ValueFormat): AxisScale {
  const values = spec.series.flatMap((series) => series.values);
  let low = Math.min(0, ...values);
  let high = Math.max(0, ...values);
  if (high - low === 0) high = low + 1;
  const step = niceStep(high - low);
  low = Math.floor(low / step) * step;
  high = Math.ceil(high / step) * step;
  if (high <= low) high = low + step;
  const count = Math.round((high - low) / step);
  const ticks = Array.from({ length: count + 1 }, (_, index) => low + index * step);
  const stepDecimals = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  return {
    low,
    high,
    ticks,
    tickFormat: { ...format, decimals: stepDecimals, trimZeros: true },
  };
}

// ---------------------------------------------------------------------------
// Bar and line charts

interface PlotArea {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function drawLegend(raster: Raster, spec: ChartSpec, top: number): number {
  if (spec.series.length < 2) return top;
  const items = spec.series.map((series, index) => ({
    color: seriesColor(index),
    text: fitText(fontText(series.name ?? `Series ${index + 1}`), 240, LABEL_SCALE),
  }));
  let x = PAD;
  let y = top;
  const rowHeight = textHeight(LABEL_SCALE) + 10;
  for (const item of items) {
    const width = LEGEND_SWATCH + 8 + textWidth(item.text, LABEL_SCALE);
    if (x + width > CHART_WIDTH - PAD && x > PAD) {
      x = PAD;
      y += rowHeight;
    }
    raster.fillRect(x, y + 1, LEGEND_SWATCH, LEGEND_SWATCH, item.color);
    raster.text(x + LEGEND_SWATCH + 8, y, item.text, LABEL_SCALE, Color.text);
    x += width + 28;
  }
  return y + rowHeight + 4;
}

function drawAxes(raster: Raster, spec: ChartSpec, format: ValueFormat, top: number): void {
  const scale = axisScale(spec, format);
  const tickLabels = scale.ticks.map((tick) => formatValue(tick, scale.tickFormat));
  const tickWidth = Math.max(...tickLabels.map((text) => textWidth(text, LABEL_SCALE)));
  const x0 = PAD + tickWidth + 12;
  const x1 = CHART_WIDTH - PAD;
  const count = spec.labels.length;
  const slot = (x1 - x0) / count;

  const labels = spec.labels.map((text) => fontText(text));
  const horizontalLabels = labels.every((text) => textWidth(text, LABEL_SCALE) <= slot - 6);
  const categoryLabels = horizontalLabels
    ? labels
    : labels.map((text) => fitText(text, textWidth('x'.repeat(MAX_VERTICAL_LABEL_CHARS), LABEL_SCALE), LABEL_SCALE));
  const bottom = horizontalLabels
    ? textHeight(LABEL_SCALE) + 10
    : Math.max(...categoryLabels.map((text) => textWidth(text, LABEL_SCALE))) + 10;

  const area: PlotArea = { x0, x1, y0: top + 8, y1: CHART_HEIGHT - PAD - bottom };
  const yFor = (value: number): number =>
    Math.round(area.y1 - ((value - scale.low) / (scale.high - scale.low)) * (area.y1 - area.y0));

  // Grid and tick labels.
  scale.ticks.forEach((tick, index) => {
    const y = yFor(tick);
    raster.fillRect(area.x0, y, area.x1 - area.x0, 1, Color.grid);
    const text = tickLabels[index]!;
    raster.text(
      area.x0 - 8 - textWidth(text, LABEL_SCALE),
      y - Math.floor(textHeight(LABEL_SCALE) / 2),
      text,
      LABEL_SCALE,
      Color.muted,
    );
  });
  raster.fillRect(area.x0, area.y0, 1, area.y1 - area.y0 + 1, Color.axis);
  const baseline = yFor(0);
  raster.fillRect(area.x0, baseline, area.x1 - area.x0, 1, Color.axis);

  // Category labels.
  categoryLabels.forEach((text, index) => {
    const center = Math.round(area.x0 + slot * index + slot / 2);
    if (horizontalLabels) {
      raster.text(
        center - Math.round(textWidth(text, LABEL_SCALE) / 2),
        area.y1 + 8,
        text,
        LABEL_SCALE,
        Color.text,
      );
    } else {
      raster.textUp(
        center - Math.floor(textHeight(LABEL_SCALE) / 2),
        area.y1 + 8 + textWidth(text, LABEL_SCALE),
        text,
        LABEL_SCALE,
        Color.text,
      );
    }
  });

  if (spec.kind === 'bar') {
    drawBars(raster, spec, format, area, slot, yFor, baseline);
  } else {
    drawLines(raster, spec, format, area, slot, yFor);
  }
}

function drawBars(
  raster: Raster,
  spec: ChartSpec,
  format: ValueFormat,
  area: PlotArea,
  slot: number,
  yFor: (value: number) => number,
  baseline: number,
): void {
  const seriesCount = spec.series.length;
  const groupWidth = slot * 0.72;
  const barWidth = Math.max(1, Math.floor(groupWidth / seriesCount));
  const labelHeight = textHeight(LABEL_SCALE);
  spec.labels.forEach((_, categoryIndex) => {
    const groupX = area.x0 + slot * categoryIndex + (slot - barWidth * seriesCount) / 2;
    spec.series.forEach((series, seriesIndex) => {
      const value = series.values[categoryIndex]!;
      const x = Math.round(groupX + seriesIndex * barWidth);
      const yValue = yFor(value);
      const barTop = Math.min(yValue, baseline);
      const height = Math.max(value === 0 ? 0 : 1, Math.abs(yValue - baseline));
      const color = seriesColor(seriesIndex);
      raster.fillRect(x, barTop, Math.max(1, barWidth - (seriesCount > 1 ? 2 : 0)), height, color);

      const text = formatValue(value, format);
      const width = textWidth(text, LABEL_SCALE);
      const allowedWidth = seriesCount === 1 ? slot - 4 : barWidth - 2;
      const centerX = x + Math.floor(barWidth / 2);
      if (width <= allowedWidth) {
        const y = value < 0
          ? Math.min(baseline + height + 4, area.y1 - labelHeight - 2)
          : Math.max(area.y0, barTop - labelHeight - 4);
        raster.text(centerX - Math.round(width / 2), y, text, LABEL_SCALE, Color.text);
      } else if (barWidth >= labelHeight + 2 && width <= area.y1 - area.y0) {
        const vertical = fitText(text, barTop - area.y0 - 4, LABEL_SCALE);
        if (value >= 0 && vertical.length > 0) {
          raster.textUp(centerX - Math.floor(labelHeight / 2), barTop - 4, vertical, LABEL_SCALE, Color.text);
        }
      }
    });
  });
}

function drawLines(
  raster: Raster,
  spec: ChartSpec,
  format: ValueFormat,
  area: PlotArea,
  slot: number,
  yFor: (value: number) => number,
): void {
  const thickness = 3;
  const marker = 7;
  const labelHeight = textHeight(LABEL_SCALE);
  spec.series.forEach((series, seriesIndex) => {
    const color = seriesColor(seriesIndex);
    const points = series.values.map((value, index) => ({
      x: Math.round(area.x0 + slot * index + slot / 2),
      y: yFor(value),
      value,
    }));
    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1]!;
      const to = points[index]!;
      raster.line(from.x, from.y, to.x, to.y, color, thickness);
    }
    for (const point of points) {
      raster.fillRect(point.x - (marker >> 1), point.y - (marker >> 1), marker, marker, color);
    }
    if (spec.series.length === 1 && points.length <= 16) {
      const labels = points.map((point) => formatValue(point.value, format));
      // Label every point or none: a lone surviving label reads as an anomaly.
      if (labels.every((text) => textWidth(text, LABEL_SCALE) <= slot - 4)) {
        points.forEach((point, index) => {
          const text = labels[index]!;
          raster.text(
            point.x - Math.round(textWidth(text, LABEL_SCALE) / 2),
            Math.max(area.y0, point.y - marker - labelHeight - 2),
            text,
            LABEL_SCALE,
            Color.text,
          );
        });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Pie chart

function drawPie(raster: Raster, spec: ChartSpec, format: ValueFormat, top: number): void {
  const values = spec.series[0]!.values;
  const total = values.reduce((sum, value) => sum + value, 0);
  const area: PlotArea = { x0: PAD, x1: CHART_WIDTH - PAD, y0: top + 8, y1: CHART_HEIGHT - PAD };
  const radius = Math.floor(Math.min((area.y1 - area.y0) / 2, (area.x1 - area.x0) * 0.28)) - 4;
  const cx = area.x0 + radius + 8;
  const cy = Math.round((area.y0 + area.y1) / 2);

  const boundaries: number[] = [];
  let cumulative = 0;
  for (const value of values) {
    cumulative += value / total;
    boundaries.push(cumulative);
  }
  const radiusSquared = radius * radius;
  for (let y = cy - radius; y <= cy + radius; y += 1) {
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > radiusSquared) continue;
      // Angle measured clockwise from twelve o'clock, in turns.
      let turn = Math.atan2(dx, -dy) / (Math.PI * 2);
      if (turn < 0) turn += 1;
      let slice = boundaries.findIndex((boundary) => turn < boundary);
      if (slice < 0) slice = values.length - 1;
      raster.set(x, y, seriesColor(slice));
    }
  }

  const legendX = cx + radius + 40;
  const rowHeight = textHeight(LABEL_SCALE) + 10;
  const rowsHeight = values.length * rowHeight;
  let y = Math.max(area.y0, cy - Math.round(rowsHeight / 2));
  spec.labels.forEach((rawLabel, index) => {
    const value = values[index]!;
    const percent = ((value / total) * 100).toFixed(1);
    const detail = ` ${formatValue(value, format)} (${percent}%)`;
    const labelText = fitText(
      fontText(rawLabel),
      area.x1 - legendX - LEGEND_SWATCH - 8 - textWidth(detail, LABEL_SCALE),
      LABEL_SCALE,
    );
    raster.fillRect(legendX, y + 1, LEGEND_SWATCH, LEGEND_SWATCH, seriesColor(index));
    raster.text(legendX + LEGEND_SWATCH + 8, y, `${labelText}${detail}`, LABEL_SCALE, Color.text);
    y += rowHeight;
  });
}

// ---------------------------------------------------------------------------
// Text helpers

/** Truncate `text` with a `..` marker until it fits `maxWidth` at `scale`. */
function fitText(text: string, maxWidth: number, scale: number): string {
  if (textWidth(text, scale) <= maxWidth) return text;
  const marker = '..';
  let kept = text.length;
  while (kept > 0 && textWidth(text.slice(0, kept) + marker, scale) > maxWidth) kept -= 1;
  return kept === 0 ? '' : `${text.slice(0, kept)}${marker}`;
}

// ---------------------------------------------------------------------------
// Raster

class Raster {
  readonly pixels: Uint8Array;

  constructor(readonly width: number, readonly height: number, fill: number) {
    this.pixels = new Uint8Array(width * height).fill(fill);
  }

  set(x: number, y: number, color: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.pixels[y * this.width + x] = color;
  }

  fillRect(x: number, y: number, width: number, height: number, color: number): void {
    const left = Math.max(0, Math.round(x));
    const top = Math.max(0, Math.round(y));
    const right = Math.min(this.width, Math.round(x + width));
    const bottom = Math.min(this.height, Math.round(y + height));
    if (right <= left || bottom <= top) return;
    for (let row = top; row < bottom; row += 1) {
      this.pixels.fill(color, row * this.width + left, row * this.width + right);
    }
  }

  /** Bresenham line whose every step stamps a `thickness`-sized square. */
  line(x0: number, y0: number, x1: number, y1: number, color: number, thickness: number): void {
    if (![x0, y0, x1, y1].every(Number.isSafeInteger)) {
      throw new ChartSpecError('chart line coordinates must be finite integers');
    }
    const half = thickness >> 1;
    let x = x0;
    let y = y0;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let error = dx + dy;
    // Bresenham requires at most this many pixel steps; no runtime timer.
    for (let remaining = Math.max(dx, -dy) + 1; remaining > 0; remaining -= 1) {
      this.fillRect(x - half, y - half, thickness, thickness, color);
      if (x === x1 && y === y1) break;
      const doubled = error * 2;
      if (doubled >= dy) {
        error += dy;
        x += sx;
      }
      if (doubled <= dx) {
        error += dx;
        y += sy;
      }
    }
  }

  /** Draw `text` with its top-left corner at (x, y). */
  text(x: number, y: number, text: string, scale: number, color: number): void {
    this.glyphs(text, scale, color, (column, row) => [x + column * scale, y + row * scale]);
  }

  /** Draw `text` rotated to read bottom-to-top, its bottom-left corner at (x, y). */
  textUp(x: number, y: number, text: string, scale: number, color: number): void {
    this.glyphs(text, scale, color, (column, row) => [x + row * scale, y - (column + 1) * scale]);
  }

  private glyphs(
    text: string,
    scale: number,
    color: number,
    place: (column: number, row: number) => [number, number],
  ): void {
    for (let index = 0; index < text.length; index += 1) {
      const masks = glyphMasks(text[index]!);
      for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
        const mask = masks[row]!;
        for (let column = 0; column < GLYPH_WIDTH; column += 1) {
          if (!(mask & (1 << (GLYPH_WIDTH - 1 - column)))) continue;
          const [px, py] = place(index * GLYPH_ADVANCE + column, row);
          this.fillRect(px, py, scale, scale, color);
        }
      }
    }
  }
}
