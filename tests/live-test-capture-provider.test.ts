import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// @ts-expect-error Intentional executable module has no declaration file.
import { CAPTURE_PROVIDER_SCHEMA, evaluateCaptureRequest, openAiCaptureStream, renderCaptureProviderWorker, renderCaptureWranglerConfig, validateCaptureConfiguration, writeCaptureProviderBundle } from '../scripts/live-test-capture-provider.mjs';

const configuration = {
  runMarker: 'gate-a-001',
  responseText: 'Capture accepted.',
  assertions: [
    { id: 'agent-a-present', model: 'gate-a-001:case-agent-a', needle: 'AGENT_A_CANARY', expect: 'present' },
    { id: 'agent-b-absent', model: 'gate-a-001:case-agent-a', needle: 'AGENT_B_CANARY', expect: 'absent' },
    { id: 'channel-two-absent', model: 'gate-a-001:case-agent-a', needle: 'CHANNEL_TWO_CANARY', expect: 'absent' },
  ],
};

test('capture configuration and evaluator prove positive and negative provider-input boundaries', () => {
  assert.equal(validateCaptureConfiguration(configuration).schema, CAPTURE_PROVIDER_SCHEMA);
  const passed = evaluateCaptureRequest(
    JSON.stringify({ model: 'gate-a-001:case-agent-a', messages: [{ role: 'system', content: 'AGENT_A_CANARY' }] }),
    configuration,
    'gate-a-001:case-agent-a',
  );
  assert.deepEqual(passed.map((item: { id: string; passed: boolean }) => [item.id, item.passed]), [
    ['agent-a-present', true],
    ['agent-b-absent', true],
    ['channel-two-absent', true],
  ]);
  const failed = evaluateCaptureRequest(
    JSON.stringify({ model: 'gate-a-001:case-agent-a', messages: [{ role: 'system', content: 'AGENT_A_CANARY AGENT_B_CANARY' }] }),
    configuration,
    'gate-a-001:case-agent-a',
  );
  assert.equal(failed.find((item: { id: string }) => item.id === 'agent-b-absent')?.passed, false);
});

test('capture provider rejects malformed, duplicate, oversized, and unscoped assertions', () => {
  assert.throws(() => validateCaptureConfiguration({ ...configuration, assertions: [] }), /needs 1-64 assertions/);
  assert.throws(() => validateCaptureConfiguration({
    ...configuration,
    assertions: [configuration.assertions[0], configuration.assertions[0]],
  }), /Duplicate assertion ID/);
  assert.throws(() => validateCaptureConfiguration({
    ...configuration,
    assertions: [{ ...configuration.assertions[0], needle: '' }],
  }), /Invalid assertion needle/);
  assert.throws(() => validateCaptureConfiguration({
    ...configuration,
    assertions: [{ ...configuration.assertions[0], model: 'foreign-run:case-agent-a' }],
  }), /must carry the exact run marker/);
  assert.throws(() => evaluateCaptureRequest('x'.repeat(262_145), configuration, 'case-agent-a'), /exceeds/);
});

test('generated Worker exposes only protected configure/results and OpenAI streaming surfaces', () => {
  const source = renderCaptureProviderWorker();
  assert.match(source, /\/__capture\/configure/);
  assert.match(source, /\/__capture\/results/);
  assert.match(source, /\/v1\/chat\/completions/);
  assert.match(source, /CAPTURE_ADMIN_KEY/);
  assert.match(source, /CAPTURE_API_KEY/);
  assert.match(source, /DELETE FROM capture_results/);
  assert.doesNotMatch(source, /INSERT INTO .*(?:raw|prompt|body)/i);
  assert.doesNotMatch(source, /console\.(?:log|error)/);
  const stream = openAiCaptureStream('Capture accepted.', 'case-agent-a');
  assert.match(stream, /text|Capture accepted/);
  assert.match(stream, /data: \[DONE\]/);
});

test('bundle is private by default and Wrangler config has one exact disposable D1 binding', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-capture-provider-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundle = writeCaptureProviderBundle(directory, {
    workerName: 'chickpea-capture-gate-a',
    databaseName: 'chickpea-capture-db-gate-a',
    databaseId: '12345678-1234-4234-8234-123456789abc',
  });
  assert.equal(statSync(bundle.workerSource).mode & 0o777, 0o600);
  assert.equal(statSync(bundle.wranglerConfig).mode & 0o777, 0o600);
  const config = JSON.parse(readFileSync(bundle.wranglerConfig, 'utf8'));
  assert.equal(config.name, 'chickpea-capture-gate-a');
  assert.deepEqual(config.d1_databases, [{
    binding: 'CAPTURE_DB',
    database_name: 'chickpea-capture-db-gate-a',
    database_id: '12345678-1234-4234-8234-123456789abc',
  }]);
  assert.equal('containers' in config, false);
  assert.equal('vars' in config, false);
  assert.match(renderCaptureWranglerConfig({
    workerName: 'capture-worker',
    databaseName: 'capture-db',
    databaseId: '12345678-1234-4234-8234-123456789abc',
  }), /CAPTURE_DB/);
});
