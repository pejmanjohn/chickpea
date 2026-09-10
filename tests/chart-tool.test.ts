import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PNG_SIGNATURE } from '../src/charts/png.ts';
import { chartFilename, createChartArtifactTool } from '../src/sandbox/chart-tool.ts';
import type { SlackArtifactStageInput } from '../src/sandbox/artifact-tool.ts';

const TOOL_RUN_CONTEXT = {
  toolCallId: 'chart-test-call',
  log: { info() {}, warn() {}, error() {} },
} as const;

const BOOKINGS = {
  kind: 'bar' as const,
  title: "Today's bookings by exam",
  labels: ['GRE', 'TOEFL', 'GMAT', 'ACT', 'IELTS', 'SAT'],
  series: [{ values: [2400, 800, 400, 160, 80, 40] }],
  valuePrefix: '$',
};

test('render_chart preserves the upload size hint in a structured failure', async () => {
  const tool = createChartArtifactTool({
    channel: 'C_BOUND',
    async stageArtifact() { return { attached: false, reason: 'too-large', maxBytes: 700 * 1024 }; },
  });
  assert.deepEqual(await tool.run({ ...TOOL_RUN_CONTEXT, data: BOOKINGS }), {
    output: { attached: false, reason: 'too-large', maxBytes: 700 * 1024, filename: 'chart.png' },
  });
});

test('render_chart renders a PNG and stages it for the bound thread', async () => {
  const uploads: SlackArtifactStageInput[] = [];
  const tool = createChartArtifactTool({
    channel: 'C_BOUND',
    threadTs: '1782770400.000300',
    async stageArtifact(input) {
      uploads.push(input);
      return { attached: true, byteLength: input.bytes.byteLength };
    },
  });
  assert.equal(tool.name, 'render_chart');

  const result = await tool.run({ ...TOOL_RUN_CONTEXT, data: BOOKINGS });

  assert.equal(uploads.length, 1);
  const upload = uploads[0]!;
  assert.equal(upload.kind, 'chart');
  assert.equal(upload.filename, 'chart.png');
  assert.equal(upload.title, "Today's bookings by exam");
  assert.deepEqual(upload.bytes.subarray(0, 8), PNG_SIGNATURE);
  assert.deepEqual(result, {
    output: {
      attached: true,
      filename: 'chart.png',
      width: 960,
      height: 540,
      byteLength: upload.bytes.byteLength,
    },
  });
});

test('render_chart reports a missing upload scope without throwing', async () => {
  const tool = createChartArtifactTool({
    channel: 'C_BOUND',
    threadTs: '1782770400.000300',
    async stageArtifact() {
      return { attached: false, reason: 'missing-scope' };
    },
  });
  const result = await tool.run({
    ...TOOL_RUN_CONTEXT,
    data: { ...BOOKINGS, filename: 'bookings by exam.png' },
  });
  assert.deepEqual(result, {
    output: { attached: false, reason: 'missing-scope', filename: 'bookings-by-exam.png' },
  });
});

test('render_chart rejects an inconsistent spec before rendering or posting', async () => {
  let posted = false;
  const tool = createChartArtifactTool({
    channel: 'C_BOUND',
    threadTs: '1782770400.000300',
    async stageArtifact(input) {
      posted = true;
      return { attached: true, byteLength: input.bytes.byteLength };
    },
  });
  await assert.rejects(
    async () => tool.run({
      ...TOOL_RUN_CONTEXT,
      data: { kind: 'bar', labels: ['GRE', 'TOEFL'], series: [{ values: [1] }] },
    }),
    /chart spec is invalid: series 1 has 1 values but there are 2 labels/,
  );
  assert.equal(posted, false);
});

test('chart filenames are reduced to a safe basename with a png suffix', () => {
  assert.equal(chartFilename(undefined), 'chart.png');
  assert.equal(chartFilename('../reports/q3 bookings.svg'), 'q3-bookings.png');
  assert.equal(chartFilename('..'), 'chart.png');
  assert.equal(chartFilename('Bookings_by_exam'), 'Bookings_by_exam.png');
  assert.equal(chartFilename('x'.repeat(100)), `${'x'.repeat(64)}.png`);
});
