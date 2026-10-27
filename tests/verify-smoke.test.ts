import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// @ts-expect-error Executable helpers are JavaScript, shared with the CLI.
import { parseArguments, runCases } from '../scripts/verify-smoke.mjs';
// @ts-expect-error Executable helpers are JavaScript, shared with the CLI.
import { appendSmokeLedger, readSmokeLedger, SMOKE_LEDGER_SCHEMA, smokePassed } from '../scripts/lib/smoke-ledger.mjs';
// @ts-expect-error Executable helpers are JavaScript, shared with the CLI.
import { SMOKE_CASES } from '../scripts/lib/smoke-cases.mjs';

const SHA = 'a'.repeat(40);
const line = (overrides: Record<string, unknown> = {}) => ({
  schema: SMOKE_LEDGER_SCHEMA, coreSha: SHA, lane: 'amber', profile: 'core',
  workerVersion: '5504e066-9504-4924-9861-993392bf7a2f', result: 'pass',
  startedAt: '2026-10-27T05:00:00.000Z', finishedAt: '2026-10-27T05:09:00.000Z', durationMs: 540_000, deployMs: 60_000,
  cases: SMOKE_CASES.map((entry: { id: string }) => ({ id: entry.id, result: 'pass', category: null, durationMs: 20_000 })),
  evidence: '/private/run', ...overrides,
});

test('the smoke ledger keeps owner-only lines and names a commit passed only on an all-pass run', (context) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'smoke-ledger-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'smoke-ledger.jsonl');
  const failed = line({ coreSha: 'b'.repeat(40), result: 'fail', cases: [{ id: 'dm-reply', result: 'fail', category: 'model', durationMs: 1 }] });
  appendSmokeLedger(failed, file);
  appendSmokeLedger(line(), file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
  writeFileSync(file, `${readFileSync(file, 'utf8')}not json\n${JSON.stringify(line({ coreSha: 'c'.repeat(40), cases: [{ id: 'x', result: 'fail', category: null, durationMs: 1 }] }))}\n`);

  const entries = readSmokeLedger(file);
  assert.equal(entries.length, 2, 'a malformed line and a pass that hides a failed case are both skipped');
  assert.equal(smokePassed(entries, SHA), true);
  assert.equal(smokePassed(entries, 'b'.repeat(40)), false, 'a failed run never passes its commit');
  assert.equal(smokePassed(entries, 'c'.repeat(40)), false);
  appendSmokeLedger(line({ coreSha: 'd'.repeat(40), cases: [{ id: 'dm-reply', result: 'pass', category: null, durationMs: 1 }] }), file);
  assert.equal(smokePassed(readSmokeLedger(file), 'd'.repeat(40)), false, 'a run of a chosen subset never passes its commit');
  assert.throws(() => appendSmokeLedger(line({ result: 'pass', cases: [{ id: 'dm-reply', result: 'blocked', category: 'tool', durationMs: 0 }] }), file), /malformed/);
  assert.deepEqual(readSmokeLedger(path.join(dir, 'missing.jsonl')), []);
});

test('smoke cases wait on their needs, run independent cases together, and block on a failed need', async () => {
  const order: string[] = [];
  const cases = [
    { id: 'slow', async run() { await new Promise((resolve) => setTimeout(resolve, 30)); order.push('slow'); return { result: 'pass', category: null, summary: 'ok' }; } },
    { id: 'fast', async run() { order.push('fast'); return { result: 'fail', category: 'model', summary: 'no marker' }; } },
    { id: 'after-slow', needs: ['slow'], async run(_world: unknown, shared: Record<string, unknown>) { order.push('after-slow'); return { result: shared.x ? 'fail' : 'pass', category: null, summary: 'ok' }; } },
    { id: 'after-fast', needs: ['fast'], async run() { order.push('after-fast'); return { result: 'pass', category: null, summary: 'ran' }; } },
    { id: 'throws', async run() { throw new Error('tab closed'); } },
  ];
  const outcomes = await runCases(cases, {});
  assert.deepEqual(order, ['fast', 'slow', 'after-slow'], 'independent cases start together; a blocked case never runs');
  assert.deepEqual(outcomes.map((outcome: { id: string; result: string }) => [outcome.id, outcome.result]), [
    ['slow', 'pass'], ['fast', 'fail'], ['after-slow', 'pass'], ['after-fast', 'blocked'], ['throws', 'fail'],
  ]);
  assert.equal(outcomes[3].category, 'model', 'a blocked case carries its need\'s failure category');
  assert.equal(outcomes[4].category, 'tool');
  assert.match(outcomes[4].summary, /tab closed/);
});

test('the smoke refuses unknown lanes, relative paths and unknown cases', () => {
  assert.throws(() => parseArguments(['--lane', 'fern']), /Choose a lane/);
  assert.throws(() => parseArguments(['--lane', 'amber', '--candidate', 'relative']), /absolute/);
  assert.throws(() => parseArguments(['--lane', 'amber', '--cases', 'dm-reply,nope']), /Unknown cases: nope/);
  const options = parseArguments(['--lane', 'amber', '--skip-deploy', '--no-ledger', '--cases', 'dm-reply'], { cwd: '/abs' });
  assert.deepEqual([options.deploy, options.ledger, options.cases, options.candidate], [false, null, ['dm-reply'], '/abs']);
});
