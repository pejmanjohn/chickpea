import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Release tooling JavaScript helper.
import { compareUpgradePreservation, verifyUpgradePreservationFiles } from '../scripts/verify-upgrade-preservation.mjs';

function fixture(next = false): any {
  const workerVersion = `${next ? 'b' : 'a'}`.repeat(8) + '-1111-2222-3333-444444444444';
  const secretNames = ['CHICKPEA_AUTH_SECRET', 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID', 'CHICKPEA_CREDENTIAL_KEY_V1'];
  const observedAt = next ? '2026-09-08T12:05:00Z' : '2026-09-08T12:00:00Z';
  return { schema: 1, observedAt,
    target: { account: 'a'.repeat(32), worker: 'customer', profile: 'core', url: 'https://customer.example' },
    installation: { exists: true, versions: [{ version_id: workerVersion, percentage: 100 }], fingerprint: `${workerVersion}:100`, secretNames,
      bindings: [
        { name: 'AUTH_DB', type: 'd1', id: 'private-database-id' },
        { name: 'TAG_STATE', type: 'durable_object_namespace', namespace_id: 'private-namespace-id', class_name: 'TagStateStore' },
        ...secretNames.map((name) => ({ name, type: 'secret_text' })),
        ...Object.entries({ CHICKPEA_APP_VERSION: next ? '0.1.1' : '0.1.0', CHICKPEA_SOURCE_COMMIT: (next ? 'b' : 'a').repeat(40),
          CHICKPEA_SETUP_CAPABILITY_DIGEST: 'x'.repeat(43), CHICKPEA_SETUP_CAPABILITY_ISSUED_AT: '1780000000000',
          SLACK_TAG_MODEL: 'private-model-value' }).map(([name, text]) => ({ name, text, type: 'plain_text' })),
      ] },
    serviceConfiguration: { source: 'cloudflare-api', observedAt, values: { routes: [{ pattern: 'private.example/*', zone_id: 'private-zone' }],
      crons: [{ cron: '0 * * * *' }], observability: { enabled: true, head_sampling_rate: 1 }, logpush: false,
      tailConsumers: [], workersDev: { enabled: true, previews_enabled: false } } },
  };
}

test('version changes preserve installation state with only fingerprints in the result', () => {
  const before = fixture(), after = fixture(true);
  after.target.url += '/';
  after.installation.bindings.reverse();
  const report = compareUpgradePreservation(before, after);
  assert.equal(report.status, 'preserved');
  assert.deepEqual(report.differences, []);
  assert.equal(report.before.resourceDigest, report.after.resourceDigest);
  assert.notEqual(report.before.servingFingerprint, report.after.servingFingerprint);
  assert.doesNotMatch(JSON.stringify(report), /private-|CHICKPEA_AUTH_SECRET|customer\.example|xxxxxxxx/);
});

test('resource, authority, secret-name and service drift reports categories without values', () => {
  const before = fixture(), after = fixture(true);
  after.installation.bindings.find((b: any) => b.name === 'AUTH_DB').id = 'private-replacement';
  after.installation.bindings.find((b: any) => b.name === 'CHICKPEA_SETUP_CAPABILITY_DIGEST').text = 'y'.repeat(43);
  after.installation.secretNames.push('PRIVATE_ADDED_SECRET');
  after.installation.bindings.push({ name: 'PRIVATE_ADDED_SECRET', type: 'secret_text' });
  const values = after.serviceConfiguration.values;
  values.routes = []; values.crons = []; values.observability.enabled = false;
  values.logpush = true; values.tailConsumers = [{ service: 'private-tail' }]; values.workersDev.enabled = false;
  const report = compareUpgradePreservation(before, after);
  assert.equal(report.status, 'changed');
  assert.deepEqual(report.differences, ['resources', 'variables', 'secretNames', 'serviceConfiguration.routes',
    'serviceConfiguration.crons', 'serviceConfiguration.observability', 'serviceConfiguration.logpush',
    'serviceConfiguration.tailConsumers', 'serviceConfiguration.workersDev']);
  assert.doesNotMatch(JSON.stringify(report), /private-|PRIVATE_ADDED_SECRET|yyyyyyyy/);
});

test('different targets, missing capture authority, malformed identity and missing secrets are refused', () => {
  for (const edit of [
    (v: any) => { v.target.worker = 'other'; },
    (v: any) => { v.target.url = 'https://other.example'; },
    (v: any) => { delete v.serviceConfiguration; },
    (v: any) => { delete v.serviceConfiguration.values.crons; },
    (v: any) => { v.serviceConfiguration.source = 'guessed'; },
    (v: any) => { v.serviceConfiguration.values.workersDev = {}; },
    (v: any) => { v.observedAt = '2026-09-07T12:00:00Z'; },
    (v: any) => { v.installation.fingerprint = 'untrusted-value'; },
    (v: any) => { v.installation.secretNames = []; },
    (v: any) => { v.installation.bindings.find((b: any) => b.type === 'secret_text').text = 'credential-value'; },
    (v: any) => { v.installation.versions[0].percentage = 50; v.installation.fingerprint = v.installation.versions[0].version_id + ':50'; },
  ]) {
    const value = fixture(true); edit(value);
    assert.throws(() => compareUpgradePreservation(fixture(), value));
  }
});

test('reports require private outside-Git paths and never overwrite existing evidence', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'chickpea-upgrade-preservation-'));
  try {
    const before = path.join(directory, 'before.json'), after = path.join(directory, 'after.json'), output = path.join(directory, 'report.json');
    writeFileSync(before, JSON.stringify(fixture()), { mode: 0o600 });
    writeFileSync(after, JSON.stringify(fixture(true)), { mode: 0o600 });
    assert.equal(verifyUpgradePreservationFiles({ before, after, output }).status, 'preserved');
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const report = readFileSync(output, 'utf8');
    assert.throws(() => verifyUpgradePreservationFiles({ before, after, output }), /EEXIST/);
    assert.equal(readFileSync(output, 'utf8'), report);
    assert.throws(() => verifyUpgradePreservationFiles({ before, after, output: path.resolve('should-not-write.json') }), /outside Git/);
    const link = path.join(directory, 'linked.json'); symlinkSync(before, link);
    assert.throws(() => verifyUpgradePreservationFiles({ before: link, after, output: path.join(directory, 'unused.json') }), /private|regular/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('CLI distinguishes preserved, changed and refused captures', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'chickpea-preservation-cli-'));
  try {
    const before = path.join(directory, 'before.json'), after = path.join(directory, 'after.json');
    writeFileSync(before, JSON.stringify(fixture()), { mode: 0o600 });
    writeFileSync(after, JSON.stringify(fixture(true)), { mode: 0o600 });
    const script = fileURLToPath(new URL('../scripts/verify-upgrade-preservation.mjs', import.meta.url));
    const invoke = (name: string) => spawnSync(process.execPath, [script, '--before', before, '--after', after,
      '--output', path.join(directory, name)], { encoding: 'utf8' });
    const preserved = invoke('preserved.json');
    assert.equal(preserved.status, 0, preserved.stderr);
    assert.equal(JSON.parse(preserved.stdout).status, 'preserved');
    const changed = fixture(true); changed.serviceConfiguration.values.logpush = true;
    writeFileSync(after, JSON.stringify(changed));
    const difference = invoke('changed.json');
    assert.equal(difference.status, 1, difference.stderr);
    assert.deepEqual(JSON.parse(difference.stdout).differences, ['serviceConfiguration.logpush']);
    assert.equal(invoke('changed.json').status, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
