import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// @ts-expect-error Intentional executable module has no declaration file.
import { automaticCleanupCommand, executeCleanup, renderCleanupPlan, resolveD1NameByExactId } from '../scripts/reset-test-env.mjs';
// @ts-expect-error Intentional executable module has no declaration file.
import { createLedger, recordResource } from '../scripts/live-test-resource-ledger.mjs';

test('reset dry-run consumes only ledger targets and performs no commands', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-reset-dry-run-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledgerPath = join(directory, 'ledger.jsonl');
  createLedger(ledgerPath, { runId: 'gate-a-cleanup' });
  recordResource(ledgerPath, { provider: 'cloudflare', kind: 'worker', id: 'chickpea-gate-a-001', ownedByRun: true });
  recordResource(ledgerPath, { provider: 'slack', kind: 'slack_app', id: 'A0GATEA001', ownedByRun: true });
  let calls = 0;
  let output = '';
  const result = executeCleanup({
    ledgerPath,
    apply: false,
    runCommand: () => { calls += 1; return { status: 0, stdout: '' }; },
    stdout: { write(value: string) { output += value; } },
  });
  assert.equal(calls, 0);
  assert.equal(result.targets.length, 2);
  assert.match(output, /id=A0GATEA001/);
  assert.match(output, /id=chickpea-gate-a-001/);
  assert.doesNotMatch(output, /--prefix|wildcard/);
});

test('Cloudflare and GitHub commands use exact recorded coordinates while Slack stays manual', () => {
  assert.deepEqual(automaticCleanupCommand({ provider: 'cloudflare', kind: 'worker', id: 'worker-exact' }), {
    command: 'node_modules/.bin/wrangler', args: ['delete', 'worker-exact', '--force'], input: 'y\n',
  });
  assert.deepEqual(automaticCleanupCommand({ provider: 'github', kind: 'generated_repository', id: 'owner/exact-repo' }), {
    command: 'gh', args: ['repo', 'delete', 'owner/exact-repo', '--yes'],
  });
  assert.equal(automaticCleanupCommand({ provider: 'slack', kind: 'slack_app', id: 'A0EXACT' }), null);
});

test('D1 deletion resolves its mutable CLI name from one immutable UUID and refuses ambiguity', () => {
  const target = { provider: 'cloudflare', kind: 'd1', id: '11111111-1111-4111-8111-111111111111' };
  assert.equal(resolveD1NameByExactId(target, JSON.stringify([
    { uuid: '11111111-1111-4111-8111-111111111111', name: 'disposable-db' },
    { uuid: '22222222-2222-4222-8222-222222222222', name: 'other-db' },
  ])), 'disposable-db');
  assert.throws(() => resolveD1NameByExactId(target, '[]'), /resolved to 0 resources/);
  assert.throws(() => resolveD1NameByExactId(target, JSON.stringify([
    { uuid: target.id, name: 'one' },
    { uuid: target.id, name: 'two' },
  ])), /resolved to 2 resources/);
});

test('rendered cleanup plan is explicit about operation, provider, kind, and immutable ID', () => {
  assert.equal(renderCleanupPlan([]), 'No pending owned resources.');
  assert.equal(renderCleanupPlan([
    { provider: 'slack', kind: 'slack_channel', id: 'C0EXACT', action: 'archive' },
  ]), '1. ARCHIVE slack/slack_channel id=C0EXACT');
});
