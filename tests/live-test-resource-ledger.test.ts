import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// @ts-expect-error Intentional executable module has no declaration file.
import { appendLedgerEvent, cleanupPlan, compareInventory, createLedger, readLedger, recordBaseline, recordCleanupVerified, recordResource } from '../scripts/live-test-resource-ledger.mjs';

test('ledger is append-only, exact-ID scoped, secret-free, and cleanup-verifiable', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-resource-ledger-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'ledger.jsonl');
  const created = createLedger(path, { runId: 'agent-first-gate-a-001', now: 1 });
  assert.equal(created.runId, 'agent-first-gate-a-001');
  assert.equal(statSync(path).mode & 0o777, 0o600);

  recordBaseline(path, { provider: 'cloudflare', kind: 'worker', id: 'existing-worker', name: 'Production' });
  recordResource(path, {
    provider: 'cloudflare', kind: 'worker', id: 'chickpea-gate-a',
    name: 'chickpea-gate-a', ownedByRun: true,
  });
  recordResource(path, {
    provider: 'slack', kind: 'slack_channel', id: 'C0GATEA001',
    name: 'cp-gate-a-one', ownedByRun: true,
  });
  assert.deepEqual(cleanupPlan(path).map((target: Record<string, string>) => ({
    provider: target.provider,
    kind: target.kind,
    id: target.id,
    action: target.action,
  })), [
    { provider: 'cloudflare', kind: 'worker', id: 'chickpea-gate-a', action: 'delete' },
    { provider: 'slack', kind: 'slack_channel', id: 'C0GATEA001', action: 'archive' },
  ]);

  recordCleanupVerified(path, {
    provider: 'cloudflare', kind: 'worker', id: 'chickpea-gate-a',
  });
  assert.equal(cleanupPlan(path).some((target: Record<string, string>) => target.kind === 'worker'), false);
  assert.equal(readLedger(path).events.length, 5);
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 5);
});

test('cleanup rejects display names, wildcards, unowned baseline resources, and foreign verification', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-resource-ledger-reject-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'ledger.jsonl');
  createLedger(path, { runId: 'agent-first-gate-a-002' });
  assert.throws(() => recordResource(path, {
    provider: 'slack', kind: 'slack_app', id: 'Chickpea *', ownedByRun: true,
  }), /immutable exact provider ID/);
  recordResource(path, {
    provider: 'cloudflare', kind: 'd1',
    id: '11111111-1111-4111-8111-111111111111', ownedByRun: false,
  });
  assert.throws(() => cleanupPlan(path), /Refusing to clean baseline\/unowned resource/);
  assert.throws(() => recordCleanupVerified(path, {
    provider: 'cloudflare', kind: 'worker', id: 'not-recorded',
  }), /does not match a recorded resource/);
});

test('only an explicitly enumerated baseline Chickpea Slack app may use the cleanup exception', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-resource-ledger-app-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'ledger.jsonl');
  createLedger(path, { runId: 'agent-first-final-cleanup' });
  recordBaseline(path, {
    provider: 'slack', kind: 'slack_app', id: 'A0EXACTCHICKPEA', name: 'Chickpea',
  });
  recordResource(path, {
    provider: 'slack', kind: 'slack_app', id: 'A0EXACTCHICKPEA', name: 'Chickpea',
    ownedByRun: false, baselineAuthorizedChickpeaCleanup: true,
  });
  assert.equal(cleanupPlan(path)[0]?.id, 'A0EXACTCHICKPEA');
  assert.deepEqual(compareInventory(path, []), { equal: true, missing: [], unexpected: [] });
});

test('cleanup orders compute before storage and rejects provider display names as IDs', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-resource-ledger-order-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'ledger.jsonl');
  createLedger(path, { runId: 'agent-first-gate-order' });
  recordResource(path, {
    provider: 'cloudflare', kind: 'capture_store',
    id: '12345678-1234-4234-8234-123456789abc', ownedByRun: true,
  });
  recordResource(path, {
    provider: 'cloudflare', kind: 'capture_worker', id: 'chickpea-capture-gate', ownedByRun: true,
  });
  assert.deepEqual(cleanupPlan(path).map((target: { kind: string }) => target.kind), [
    'capture_worker', 'capture_store',
  ]);
  assert.throws(() => recordResource(path, {
    provider: 'slack', kind: 'slack_app', id: 'Chickpea', ownedByRun: true,
  }), /immutable exact provider ID/);
  assert.throws(() => recordResource(path, {
    provider: 'github', kind: 'generated_repository', id: 'just-a-display-name', ownedByRun: true,
  }), /immutable exact provider ID/);
  assert.throws(() => recordResource(path, {
    provider: 'cloudflare', kind: 'd1', id: 'chickpea-auth-db', ownedByRun: true,
  }), /immutable exact provider ID/);
});

test('ledger rejects secret fields and compares exact baseline inventories', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-resource-ledger-inventory-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'ledger.jsonl');
  createLedger(path, { runId: 'agent-first-gate-a-003' });
  recordBaseline(path, { provider: 'slack', kind: 'slack_app', id: 'A0BASELINE' });
  assert.throws(() => appendLedgerEvent(path, {
    type: 'note', at: Date.now(), apiToken: 'xoxb-forbidden', message: 'bad',
  }), /Secret-bearing ledger field is forbidden/);
  assert.deepEqual(compareInventory(path, [
    { provider: 'slack', kind: 'slack_app', id: 'A0BASELINE' },
  ]), { equal: true, missing: [], unexpected: [] });
  const drift = compareInventory(path, [
    { provider: 'slack', kind: 'slack_app', id: 'A0UNEXPECTED' },
  ]);
  assert.equal(drift.equal, false);
  assert.equal(drift.missing[0]?.id, 'A0BASELINE');
  assert.equal(drift.unexpected[0]?.id, 'A0UNEXPECTED');
});
