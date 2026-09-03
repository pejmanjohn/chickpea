import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// @ts-expect-error Intentional executable module has no declaration file.
import { automaticCleanupCommand, executeCleanup, readLiveCleanupResource, renderCleanupPlan, resolveD1NameByExactId } from '../scripts/reset-test-env.mjs';
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

test('mutable-name provider deletion remains manual without an immutable conditional primitive', () => {
  assert.equal(automaticCleanupCommand({ provider: 'cloudflare', kind: 'worker', id: 'worker-exact' }), null);
  assert.equal(automaticCleanupCommand({ provider: 'cloudflare', kind: 'd1', id: 'database-exact' }), null);
  assert.equal(automaticCleanupCommand({ provider: 'github', kind: 'generated_repository', id: 'owner/exact-repo' }), null);
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

test('apply validates the complete receipt plan before the first provider command', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-reset-authority-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledgerPath = join(directory, 'ledger.jsonl');
  createLedger(ledgerPath, { runId: 'gate-receipt-cleanup' });
  recordResource(ledgerPath, {
    provider: 'cloudflare', kind: 'worker', id: 'disposable-worker-1', ownedByRun: true,
  });
  recordResource(ledgerPath, {
    provider: 'github', kind: 'generated_repository', id: 'owner/disposable-1', ownedByRun: true,
  });
  let commands = 0;
  assert.throws(() => executeCleanup({
    ledgerPath, apply: true, target: 'amber', receiptPaths: ['one', 'mixed'],
    authorizeCleanup: () => { throw new Error('CLEANUP_RECEIPT_MISMATCH'); },
    runCommand: () => { commands += 1; return { status: 0, stdout: '' }; },
    stdout: { write() {} },
  }), /CLEANUP_RECEIPT_MISMATCH/);
  assert.equal(commands, 0);
});

test('live Worker cleanup readback binds immutable version and forwards exact provider context', () => {
  const calls: string[][] = [];
  const digest = `sha256:${'a'.repeat(64)}`;
  const readback = readLiveCleanupResource({
    target: 'amber', provider: 'cloudflare', kind: 'worker', id: 'disposable-worker',
    immutableId: 'version-immutable', creationIntentDigest: digest,
  }, {
    providerContext: ['--profile', 'lane-owner', '--env', 'amber'],
    now: () => Date.parse('2026-09-01T12:00:00.000Z'),
    runCommand: ({ args }: { args: string[] }) => {
      calls.push(args);
      if (args[0] === 'deployments') {
        return { status: 0, stdout: JSON.stringify({ versions: [{ version_id: 'version-immutable', percentage: 100 }] }) };
      }
      return { status: 0, stdout: JSON.stringify({ resources: { bindings: [{
        name: 'CHICKPEA_RESOURCE_CREATION_INTENT_DIGEST', type: 'plain_text', text: digest,
      }] } }) };
    },
  });
  assert.equal(readback.immutableId, 'version-immutable');
  assert.equal(readback.observedAt, '2026-09-01T12:00:00.000Z');
  assert.deepEqual(calls.map((args) => args.slice(-4)), [
    ['--profile', 'lane-owner', '--env', 'amber'],
    ['--profile', 'lane-owner', '--env', 'amber'],
  ]);
});

test('deleted and recreated mutable Worker name fails readback before any delete', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-reset-recreated-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledgerPath = join(directory, 'ledger.jsonl');
  createLedger(ledgerPath, { runId: 'gate-recreated-worker' });
  recordResource(ledgerPath, {
    provider: 'cloudflare', kind: 'worker', id: 'same-mutable-name', ownedByRun: true,
  });
  const digest = `sha256:${'b'.repeat(64)}`;
  let deletes = 0;
  let reads = 0;
  assert.throws(() => executeCleanup({
    ledgerPath, apply: true, target: 'amber', receiptPaths: ['receipt.json'],
    environmentOptions: { providerContext: ['--profile', 'lane-owner'] },
    authorizeCleanup: (_targets: unknown, options: {
      readProviderResource: (resource: Record<string, string>) => unknown,
    }) => {
      options.readProviderResource({
        target: 'amber', provider: 'cloudflare', kind: 'worker', id: 'same-mutable-name',
        immutableId: 'version-original', creationIntentDigest: digest,
      });
      return [];
    },
    runCommand: ({ args }: { args: string[] }) => {
      if (args[0] === 'delete') deletes += 1;
      else reads += 1;
      if (args[0] === 'deployments') {
        return { status: 0, stdout: JSON.stringify({ versions: [{ version_id: 'version-recreated', percentage: 100 }] }) };
      }
      return { status: 0, stdout: JSON.stringify({ resources: { bindings: [{
        name: 'CHICKPEA_RESOURCE_CREATION_INTENT_DIGEST', type: 'plain_text', text: digest,
      }] } }) };
    },
    stdout: { write() {} },
  }), /identity changed/);
  assert.equal(reads, 2);
  assert.equal(deletes, 0);
});

test('provider identity is reread at the command boundary before mutable-name deletion', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-reset-boundary-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledgerPath = join(directory, 'ledger.jsonl');
  createLedger(ledgerPath, { runId: 'gate-cleanup-boundary' });
  recordResource(ledgerPath, {
    provider: 'cloudflare', kind: 'worker', id: 'mutable-worker', ownedByRun: true,
  });
  const intentDigest = `sha256:${'c'.repeat(64)}`;
  let reads = 0;
  let deletes = 0;
  const authority = {
    target: 'amber', provider: 'cloudflare', kind: 'worker', id: 'mutable-worker',
    immutableId: 'version-original', creationIntentDigest: intentDigest,
  };
  assert.throws(() => executeCleanup({
    ledgerPath, apply: true, target: 'amber', receiptPaths: ['receipt.json'],
    environmentOptions: {
      readProviderResource: () => {
        reads += 1;
        return {
          ...authority,
          immutableId: reads === 1 ? 'version-original' : 'version-recreated',
          observedAt: '2026-09-01T12:00:00.000Z',
        };
      },
    },
    authorizeCleanup: (_targets: unknown, options: {
      readProviderResource: (resource: Record<string, string>) => unknown,
    }) => {
      options.readProviderResource(authority);
      return [authority];
    },
    runCommand: ({ args }: { args: string[] }) => {
      if (args[0] === 'delete') deletes += 1;
      return { status: 0, stdout: '' };
    },
    stdout: { write() {} },
  }), /identity changed|readback/i);
  assert.equal(reads, 2);
  assert.equal(deletes, 0);
});

test('replacement after the final authority read cannot trigger a mutable-name delete', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-reset-post-boundary-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledgerPath = join(directory, 'ledger.jsonl');
  createLedger(ledgerPath, { runId: 'gate-post-boundary-replacement' });
  recordResource(ledgerPath, {
    provider: 'cloudflare', kind: 'worker', id: 'mutable-worker', ownedByRun: true,
  });
  const authority = {
    target: 'amber', provider: 'cloudflare', kind: 'worker', id: 'mutable-worker',
    immutableId: 'version-original', creationIntentDigest: `sha256:${'d'.repeat(64)}`,
  };
  let replaced = false;
  let deletes = 0;
  const result = executeCleanup({
    ledgerPath, apply: true, target: 'amber', receiptPaths: ['receipt.json'],
    environmentOptions: {
      readProviderResource: () => ({
        ...authority, observedAt: '2026-09-01T12:00:00.000Z',
      }),
      afterCleanupBoundaryRead: () => { replaced = true; },
    },
    authorizeCleanup: () => [authority],
    runCommand: ({ args }: { args: string[] }) => {
      if (args[0] === 'delete') deletes += 1;
      return { status: 0, stdout: '' };
    },
    stdout: { write() {} },
  });
  assert.equal(replaced, true);
  assert.equal(deletes, 0);
  assert.equal(result.completed.length, 0);
  assert.equal(result.manual.length, 1);
});
