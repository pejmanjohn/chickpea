import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from './upgrade-cli.fixture.ts';

test('CLI rejects conflicting arguments and receipts outside its private directory', (t) => {
  const f = fixture(t);
  assert.match(f.run(['--to', 'v0.1.1', '--recover', '/tmp/receipt.json']).stderr, /exactly one/);
  assert.match(f.run(['--to', 'v0.1.1', '--wrangler-profile', 'other']).stderr, /only during --configure/);
  assert.match(f.run(['--configure', '--account', 'a'.repeat(32), '--worker', 'customer', '--profile', 'core', '--wrangler-profile', '../bad']).stderr, /authentication profile/);
  assert.match(f.run(['--to', 'latest']).stderr, /exact stable/);
  assert.match(f.run(['--configure', '--account', 'a'.repeat(32), '--worker', 'customer', '--profile', 'sandbox', '--url', 'https://customer.example']).stderr, /Sandbox container images/);
  assert.equal(readFileSync(f.log, 'utf8'), '');
  const outside = join(f.base, 'outside'); mkdirSync(outside, { mode: 0o700 });
  writeFileSync(join(outside, 'receipt.json'), '{}', { mode: 0o600 });
  assert.match(f.run(['--resume', join(outside, 'receipt.json')]).stderr, /different upgrade-state/);
  assert.equal(existsSync(join(f.home, '.chickpea/upgrades/installations/default.json')), false);
});


test('CLI refuses unknown historical policy before dependency commands', (t) => {
  const f = fixture(t, undefined, false); f.configure();
  const result = f.run(['--to', 'v0.1.1', '--preflight']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NPM_POLICY_UNKNOWN/);
  assert.doesNotMatch(readFileSync(f.log, 'utf8'), /"ci"|"build"|"--skip-build"/);
  assert.equal(JSON.parse(readFileSync(f.remote, 'utf8')).version, '0.1.0');
});

for (const failure of ['UPGRADE_FIXTURE_DIRTY_SOURCE', 'UPGRADE_FIXTURE_CI_FAIL']) test(`CLI stops before build when dependency preparation fails: ${failure}`, (t) => {
  const f = fixture(t); f.configure();
  const result = f.run(['--to', 'v0.1.1', '--preflight'], false, false, { [failure]: '1' });
  assert.equal(result.status, 1);
  if (failure === 'UPGRADE_FIXTURE_DIRTY_SOURCE') assert.match(result.stderr, /identity or clean-checkout/);
  else {
    assert.match(result.stderr, /NPM_INSTALL_FAILED.*E401/);
    assert.doesNotMatch(result.stderr + result.stdout, /private-registry-token-do-not-print|PRIVATE_SECRET/);
  }
  const commands = readFileSync(f.log, 'utf8');
  assert.match(commands, /"ci"/);
  assert.match(commands, /"--strict-allow-scripts"/);
  assert.doesNotMatch(commands, /"build"|"--skip-build"/);
  assert.equal(JSON.parse(readFileSync(f.remote, 'utf8')).version, '0.1.0');
});
