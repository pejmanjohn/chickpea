import assert from 'node:assert/strict';
import { test } from 'node:test';

import { emitMemoryMetric } from '../src/memory/telemetry.ts';

test('memory telemetry admits only machine tokens and scalar measurements', () => {
  const original = console.info;
  const lines: unknown[][] = [];
  console.info = (...args: unknown[]) => lines.push(args);
  try {
    emitMemoryMetric('selection', {
      outcome: 'success',
      candidateCount: 4,
      truncated: true,
      reason: 'CANARY private memory body',
      'bad-key': 'also private',
      workspaceId: 'T_PRIVATE',
    });
  } finally {
    console.info = original;
  }

  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.[0], '[chickpea] memory_metric');
  const payload = JSON.parse(String(lines[0]?.[1])) as Record<string, unknown>;
  assert.deepEqual(payload, {
    event: 'selection',
    outcome: 'success',
    candidateCount: 4,
    truncated: true,
    reason: 'other',
  });
  assert.doesNotMatch(JSON.stringify(lines), /CANARY|private memory body|also private|T_PRIVATE|workspaceId/);
});
