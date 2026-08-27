import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const SCRIPT = join(process.cwd(), 'scripts/verify-semantic-activity-status-live.mjs');

const manifest = {
  syntheticMailbox: true,
  readOnlyQuery: true,
  unmodifiedTiming: true,
  diagnosticTrace: true,
  progressMessageCalls: 0,
  priorVersionRestored: true,
  rawCaptureDeleted: true,
};

test('live verifier derives the 90 percent gate from isolated event captures', () => {
  const fixture = createFixture();
  try {
    const output = runVerifier(fixture.args);
    assert.equal(output.ok, true);
    assert.equal(output.eligibleManagedTurns, 10);
    assert.equal(output.specificAcknowledgedTurns, 9);
    assert.equal(output.specificAcknowledgedRatio, 0.9);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('live verifier rejects unrelated phase acknowledgements and manifest counts', () => {
  const fixture = createFixture({ diagnosticWorkingFamily: 'unknown' });
  try {
    assert.throws(() => runVerifier(fixture.args), /managed_connector\/working phase was not acknowledged/);
    writeFileSync(fixture.manifestPath, JSON.stringify({
      ...manifest,
      eligibleManagedTurns: 10,
      specificAcknowledgedTurns: 9,
    }));
    assert.throws(() => runVerifier(fixture.args), /false !== true/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function createFixture(options: { diagnosticWorkingFamily?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'semantic-activity-verifier-'));
  const manifestPath = join(directory, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const args: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const path = join(directory, `normal-${index}.jsonl`);
    writeEvents(path, [
      event('activity.work', {
        family: 'managed_connector', outcome: 'succeeded', durationMs: 1_500,
      }),
      event('activity.transport', {
        surface: 'assistant_status',
        outcome: index < 9 ? 'acknowledged' : 'rejected',
        family: 'managed_connector',
        phase: 'working',
      }),
      event('activity.clear', {
        surface: 'assistant_status', outcome: 'acknowledged', late: false,
      }),
    ]);
    args.push('--normal-events', path);
  }
  const diagnosticPath = join(directory, 'diagnostic.jsonl');
  const phases = [
    ['unknown', 'thinking'],
    ['managed_connector', 'working'],
    ['managed_connector', 'reviewing'],
    ['response', 'drafting'],
  ] as const;
  const diagnosticEvents = phases.flatMap(([family, phase]) => [
    event('activity.produced', { family, phase, observed: phase !== 'thinking' }),
    event('activity.transport', {
      surface: 'assistant_status',
      outcome: 'acknowledged',
      family: phase === 'working'
        ? options.diagnosticWorkingFamily ?? family
        : family,
      phase,
    }),
  ]);
  diagnosticEvents.push(event('activity.clear', {
    surface: 'assistant_status', outcome: 'acknowledged', late: false,
  }));
  writeEvents(diagnosticPath, diagnosticEvents);
  args.push('--diagnostic-events', diagnosticPath, '--manifest', manifestPath);
  return { directory, manifestPath, args };
}

function runVerifier(args: string[]) {
  return JSON.parse(execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })) as Record<string, unknown>;
}

function event(name: string, fields: Record<string, unknown>) {
  return { schemaVersion: 1, event: name, ...fields };
}

function writeEvents(path: string, events: readonly Record<string, unknown>[]): void {
  writeFileSync(path, events.map((value) => JSON.stringify(value)).join('\n'));
}
