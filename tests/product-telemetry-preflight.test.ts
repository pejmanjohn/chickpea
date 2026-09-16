import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// @ts-expect-error Executable verification helper intentionally has no declarations.
import * as productTelemetryPreflight from '../scripts/lib/product-telemetry-preflight.mjs';

const { ProductTelemetryPreflightError, verifyProductTelemetry, writeProductTelemetryReceipt } = productTelemetryPreflight;

const WORKER = 'chickpea-test-fixture';
const SECRET = 'private-provider-credential';

function status(versions: Array<Record<string, unknown>>) {
  return { status: 0, stdout: JSON.stringify({ versions }) };
}

function view(id: string, bindings: Array<Record<string, unknown>>) {
  return {
    status: 0,
    stdout: JSON.stringify({ id, resources: { bindings } }),
  };
}

function plain(name: string, text: string) {
  return { name, type: 'plain_text', text };
}

function preflightError(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ProductTelemetryPreflightError);
    assert.equal((error as { code?: unknown }).code, code);
    return true;
  };
}

test('missing telemetry policy refuses the serving version', async () => {
  const calls: string[][] = [];
  await assert.rejects(verifyProductTelemetry({
    worker: WORKER,
    runWrangler(args: string[]) {
      calls.push(args);
      if (args[0] === 'deployments') return status([{ version_id: 'version-a', percentage: 100 }]);
      return view('version-a', []);
    },
  }), preflightError('UNSAFE_SERVING_VERSION'));

  assert.deepEqual(calls, [
    ['deployments', 'status', '--json', '--name', WORKER],
    ['versions', 'view', 'version-a', '--json', '--name', WORKER],
    ['deployments', 'status', '--json', '--name', WORKER],
  ]);
});

test('explicit test environment and plain-text opt-out both pass', async () => {
  const receipt = await verifyProductTelemetry({
    worker: WORKER,
    accountId: 'A'.repeat(32),
    now: () => Date.parse('2026-09-15T20:30:00.000Z'),
    runWrangler(args: string[]) {
      if (args[0] === 'deployments') return status([
        { version_id: 'version-test', percentage: 60 },
        { version_id: 'version-disabled', percentage: 40 },
      ]);
      if (args[2] === 'version-test') return view('version-test', [
        plain('CHICKPEA_TELEMETRY_ENVIRONMENT', 'test'),
        { name: 'DO_NOT_TRACK', type: 'secret_text' },
      ]);
      return view('version-disabled', [
        plain('CHICKPEA_TELEMETRY_ENVIRONMENT', 'production'),
        plain('CHICKPEA_DISABLE_TELEMETRY', ' YES '),
      ]);
    },
  });

  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.accountId, 'a'.repeat(32));
  assert.equal(receipt.observedAt, '2026-09-15T20:30:00.000Z');
  assert.deepEqual(receipt.versions, [
    {
      version: 'version-disabled',
      traffic: 40,
      environment: 'non_test',
      doNotTrack: 'missing',
      disableTelemetry: 'truthy',
      policy: 'plain_text_opt_out',
    },
    {
      version: 'version-test',
      traffic: 60,
      environment: 'test',
      doNotTrack: 'secret',
      disableTelemetry: 'missing',
      policy: 'test_environment',
    },
  ]);
});

test('split traffic refuses any unsafe serving version after inspecting each one', async () => {
  const views: string[] = [];
  await assert.rejects(verifyProductTelemetry({
    worker: WORKER,
    runWrangler(args: string[]) {
      if (args[0] === 'deployments') return status([
        { version_id: 'version-safe', percentage: 50 },
        { version_id: 'version-unsafe', percentage: 50 },
      ]);
      views.push(args[2]!);
      return view(args[2]!, args[2] === 'version-safe'
        ? [plain('CHICKPEA_TELEMETRY_ENVIRONMENT', 'test')]
        : [plain('CHICKPEA_TELEMETRY_ENVIRONMENT', 'production')]);
    },
  }), preflightError('UNSAFE_SERVING_VERSION'));
  assert.deepEqual(views, ['version-safe', 'version-unsafe']);
});

test('a serving change during inspection refuses the stale snapshot', async () => {
  let statusReads = 0;
  await assert.rejects(verifyProductTelemetry({
    worker: WORKER,
    runWrangler(args: string[]) {
      if (args[0] === 'deployments') {
        statusReads += 1;
        return status([{ version_id: statusReads === 1 ? 'version-a' : 'version-b', percentage: 100 }]);
      }
      return view('version-a', [plain('CHICKPEA_TELEMETRY_ENVIRONMENT', 'test')]);
    },
  }), preflightError('SERVING_SNAPSHOT_CHANGED'));
});

test('provider errors and failure receipts never expose command output', async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'chickpea-telemetry-preflight-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'failure.json');

  let captured: { message: string; receipt: unknown } | undefined;
  try {
    await verifyProductTelemetry({
      worker: WORKER,
      runWrangler() {
        return { status: 1, stdout: SECRET, stderr: SECRET };
      },
    });
  } catch (error) {
    assert.ok(error instanceof ProductTelemetryPreflightError);
    captured = error as { message: string; receipt: unknown };
  }
  assert.ok(captured);
  assert.doesNotMatch(captured.message, new RegExp(SECRET));
  assert.doesNotMatch(JSON.stringify(captured.receipt), new RegExp(SECRET));

  writeProductTelemetryReceipt(output, captured.receipt);
  const written = readFileSync(output, 'utf8');
  assert.doesNotMatch(written, new RegExp(SECRET));
  assert.equal(lstatSync(output).mode & 0o777, 0o600);
  assert.throws(() => writeProductTelemetryReceipt(output, captured!.receipt), /already exists/u);
});

test('secret opt-outs and mismatched version responses cannot establish safety', async () => {
  for (const [response, code] of [
    [view('version-a', [{ name: 'DO_NOT_TRACK', type: 'secret_text', text: '1' }]), 'UNSAFE_SERVING_VERSION'],
    [view('version-other', [plain('CHICKPEA_TELEMETRY_ENVIRONMENT', 'test')]), 'VERSION_ID_MISMATCH'],
  ] as const) {
    await assert.rejects(verifyProductTelemetry({
      worker: WORKER,
      runWrangler(args: string[]) {
        return args[0] === 'deployments'
          ? status([{ version_id: 'version-a', percentage: 100 }])
          : response;
      },
    }), preflightError(code));
  }
});

test('deployment snapshots require unique safe version IDs and finite traffic totaling 100', async () => {
  for (const versions of [
    [],
    [{ version_id: '../unsafe', percentage: 100 }],
    [{ version_id: 'version-a' }],
    [{ version_id: 'version-a', percentage: Number.NaN }],
    [{ version_id: 'version-a', percentage: 90 }],
    [{ version_id: 'version-a', percentage: 50 }, { version_id: 'version-a', percentage: 50 }],
  ]) {
    await assert.rejects(verifyProductTelemetry({
      worker: WORKER,
      runWrangler: () => status(versions),
    }), preflightError('DEPLOYMENT_STATUS_INVALID'));
  }
});

test('CLI prints a bounded failure receipt without requiring an output file', () => {
  const result = spawnSync(process.execPath, [
    'scripts/verify-product-telemetry.mjs', '--worker', '../invalid',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /INVALID_WORKER/u);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.worker, null);
  assert.equal(receipt.failure.code, 'INVALID_WORKER');
});

test('Wrangler profile and environment context are validated and forwarded to every read', async () => {
  const calls: string[][] = [];
  const receipt = await verifyProductTelemetry({
    worker: WORKER,
    providerContext: ['--profile', 'qa.owner_1', '--env', 'amber-qa'],
    runWrangler(args: string[]) {
      calls.push(args);
      return args[0] === 'deployments'
        ? status([{ version_id: 'version-a', percentage: 100 }])
        : view('version-a', [plain('CHICKPEA_TELEMETRY_ENVIRONMENT', 'test')]);
    },
  });
  assert.deepEqual(receipt.providerContext, ['--profile', 'qa.owner_1', '--env', 'amber-qa']);
  assert.deepEqual(calls, [
    ['deployments', 'status', '--json', '--name', WORKER, '--profile', 'qa.owner_1', '--env', 'amber-qa'],
    ['versions', 'view', 'version-a', '--json', '--name', WORKER, '--profile', 'qa.owner_1', '--env', 'amber-qa'],
    ['deployments', 'status', '--json', '--name', WORKER, '--profile', 'qa.owner_1', '--env', 'amber-qa'],
  ]);

  for (const providerContext of [
    ['--profile', '../owner'],
    ['--env', 'bad/value'],
    ['--profile', 'owner', '--profile', 'other'],
  ]) {
    let called = false;
    await assert.rejects(verifyProductTelemetry({
      worker: WORKER,
      providerContext,
      runWrangler() {
        called = true;
        return status([{ version_id: 'version-a', percentage: 100 }]);
      },
    }), preflightError('INVALID_PROVIDER_CONTEXT'));
    assert.equal(called, false);
  }
});
