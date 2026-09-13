import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// @ts-expect-error The cross-platform executable .mjs intentionally has no declaration file.
import { runFixtureCli } from '../scripts/verification-fixtures.mjs';
// @ts-expect-error The cross-platform executable .mjs intentionally has no declaration file.
import { fixtureReadiness, validateFixtureInventory } from '../scripts/lib/verification-fixtures.mjs';
// @ts-expect-error The cross-platform executable .mjs intentionally has no declaration file.
import { contextScope } from '../scripts/lib/verification-scope.mjs';

const NOW = Date.parse('2026-09-13T18:00:00.000Z');
const context = { grade: 'deployed', target: 'amber', servingVersion: 'version-1', model: 'anthropic/claude-sonnet-4:20250514',
  actor: 'owner', fixtures: 'fixture-set-1', state: 'state-1', config: 'config-1' };
const scope = contextScope('candidate', context);
const capability = (kind: string) => ({ available: true, kind, scope,
  observedAt: '2026-09-13T17:50:00.000Z', expiresAt: '2026-09-13T19:00:00.000Z',
  evidence: ['private-evidence-ref'] });
const spec = {
  mode: 'changed', purpose: 'verification',
  contexts: { candidate: context },
  capabilities: {
    'candidate.channel': capability('fixture'),
    'candidate.oauth': capability('fixture'),
    'candidate.slack': capability('tool'),
  },
  cases: [
    { id: 'routing', title: 'Routing', context: 'candidate', areas: ['delivery'],
      requires: ['candidate.channel', 'candidate.slack'], proof: ['slack'], maxAttempts: 2, maxWaitMs: 120_000, minObservationMs: 0 },
    { id: 'oauth', title: 'OAuth', context: 'candidate', areas: ['auth'],
      requires: ['candidate.oauth', 'candidate.slack'], proof: ['slack'], maxAttempts: 2, maxWaitMs: 120_000, minObservationMs: 0 },
  ],
};
const entry = (overrides = {}) => ({ lifecycle: 'reusable', allowedOperations: ['read'], resetRights: 'restore',
  registeredModel: 'anthropic/claude-sonnet-4:20250514', credentialHandle: 'keychain-provider-one', owner: null,
  expiresAt: '2026-09-13T19:00:00.000Z', supportedPairs: [{ from: 'v0.1.10', to: 'v0.1.11' }],
  evidenceHash: `sha256:${'a'.repeat(64)}`, ...overrides });
const inventory = (fixtures: Record<string, unknown>) => ({ schemaVersion: 'chickpea-live-fixture-inventory/v1',
  observedAt: '2026-09-13T17:55:00.000Z', fixtures });

test('readiness maps fixture requirements per case and leaves independent cases runnable', () => {
  const result = fixtureReadiness(spec, inventory({
    'candidate.channel': entry(),
    'candidate.oauth': entry({ lifecycle: 'reserved_user_trial', owner: 'maintainer-trial' }),
  }), { operation: 'read', resetRights: 'restore', fromRelease: 'v0.1.10', toRelease: 'v0.1.11' }, NOW);
  assert.equal(result.reservation, 'none');
  assert.equal(result.cases[0].ready, true);
  assert.equal(result.cases[1].ready, false);
  assert.deepEqual(result.cases[1].blockers.map(({ code }: { code: string }) => code), ['fixture_reserved']);
});

test('readiness reports expiry, model, operation, reset and release-pair blockers independently', () => {
  const result = fixtureReadiness(spec, inventory({ 'candidate.channel': entry({
    registeredModel: 'gpt-5', allowedOperations: ['write'], resetRights: 'none',
    expiresAt: '2026-09-13T17:00:00.000Z', supportedPairs: [],
  }) }), { operation: 'read', resetRights: 'restore', fromRelease: 'v0.1.10', toRelease: 'v0.1.11' }, NOW);
  assert.deepEqual(result.cases[0].blockers.map(({ code }: { code: string }) => code),
    ['fixture_expired', 'model_mismatch', 'operation_not_allowed', 'reset_not_authorized', 'unsupported_pair']);
  assert.deepEqual(result.cases[1].blockers, [{ capabilityId: 'candidate.oauth', code: 'fixture_missing' }]);
});

test('inventory validation rejects secrets, filesystem coordinates and malformed credential handles', () => {
  assert.throws(() => validateFixtureInventory(inventory({ 'candidate.channel': entry({ credentialHandle: 'sk-secretvalue123456789' }) })), /Secret-like/u);
  assert.throws(() => validateFixtureInventory(inventory({ 'candidate.channel': entry({ owner: join(homedir(), 'private-fixture') }) })), /Absolute fixture/u);
  assert.throws(() => validateFixtureInventory(inventory({ 'candidate.channel': entry({ credentialHandle: 'keychain/provider' }) })), /Invalid fixture/u);
});

test('registered model keeps the exact provider selector for matching', () => {
  for (const model of ['anthropic/claude-sonnet-4:20250514', 'cloudflare/@cf/zai-org/glm-4.7-flash', '@cf/zai-org/glm-4.7-flash']) {
    const selected = structuredClone(spec);
    selected.contexts.candidate.model = model;
    for (const capability of Object.values(selected.capabilities)) capability.scope = contextScope('candidate', selected.contexts.candidate);
    const fixture = entry({ registeredModel: model });
    const result = fixtureReadiness(selected, inventory({ 'candidate.channel': fixture, 'candidate.oauth': fixture }), {}, NOW);
    assert.equal(result.cases[0].ready, true);
    assert.equal(result.cases[0].fixtures[0].registeredModel, model);
  }
  assert.throws(() => validateFixtureInventory(inventory({ 'candidate.channel': entry({ registeredModel: 'anthropic model' }) })), /Invalid fixture/u);
});

test('readiness rejects malformed attended specs instead of treating dangling requirements as ready', () => {
  assert.throws(() => fixtureReadiness({ contexts: {}, capabilities: {}, cases: [
    { id: 'bad', context: 'missing', requires: ['missing'] },
  ] }, inventory({}), {}, NOW), /Unexpected record fields|Choose changed/u);
});

test('inventory snapshot freshness is bounded even when fixture expiry is open ended', () => {
  const stale = inventory({ 'candidate.channel': entry({ expiresAt: null }), 'candidate.oauth': entry() });
  stale.observedAt = '2026-09-11T17:55:00.000Z';
  const result = fixtureReadiness(spec, stale, {}, NOW);
  assert.equal(result.inventory.freshness, 'stale');
  assert.ok(result.cases[0].blockers.some(({ code }: { code: string }) => code === 'inventory_stale'));
});

test('CLI is read-only and explicitly reports that it creates no reservation', (context) => {
  const base = mkdtempSync(join(tmpdir(), 'chickpea-fixtures-'));
  context.after(() => rmSync(base, { recursive: true, force: true }));
  const specPath = join(base, 'spec.json'), inventoryPath = join(base, 'inventory.json');
  const now = Date.now();
  const cliSpec = structuredClone(spec);
  for (const value of Object.values(cliSpec.capabilities)) {
    value.observedAt = new Date(now - 60_000).toISOString();
    value.expiresAt = new Date(now + 60_000).toISOString();
  }
  const cliInventory = inventory({
    'candidate.channel': entry({ expiresAt: new Date(now + 60_000).toISOString() }),
    'candidate.oauth': entry({ expiresAt: new Date(now + 60_000).toISOString() }),
  });
  cliInventory.observedAt = new Date(now - 60_000).toISOString();
  writeFileSync(specPath, JSON.stringify(cliSpec));
  writeFileSync(inventoryPath, JSON.stringify(cliInventory));
  const before = [readFileSync(specPath), readFileSync(inventoryPath), statSync(specPath).mtimeMs, statSync(inventoryPath).mtimeMs];
  let stdout = '', stderr = '';
  const code = runFixtureCli(['readiness', '--spec', specPath, '--inventory', inventoryPath], {
    stdout: (value: string) => { stdout += value; }, stderr: (value: string) => { stderr += value; },
  });
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).reservation, 'none');
  assert.deepEqual([readFileSync(specPath), readFileSync(inventoryPath), statSync(specPath).mtimeMs, statSync(inventoryPath).mtimeMs], before);
});
