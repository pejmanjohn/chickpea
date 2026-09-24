import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from './upgrade-cli.fixture.ts';

for (const profile of [undefined, 'customer-login']) test(`current runner upgrades and recovers immutable source with ${profile ?? 'default'} login`, (t) => {
  const f = fixture(t, profile); f.configure();
  const initial = readFileSync(f.remote, 'utf8');
  const preflight = f.run(['--to', 'v0.1.1', '--preflight']);
  assert.equal(preflight.status, 0, preflight.stderr); assert.match(preflight.stdout, /Preflight passed/);
  assert.equal(readFileSync(f.remote, 'utf8'), initial);
  const receipt = join(f.receipts(), readdirSync(f.receipts())[0]!, 'receipt.json');
  assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).stage, 'prepared');
  assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).target.wranglerProfile, profile);
  const resume = f.run(['--resume', receipt], true); assert.equal(resume.status, 0, resume.stderr);
  assert.equal(JSON.parse(readFileSync(f.remote, 'utf8')).version, '0.1.1');
  const recover = f.run(['--recover', receipt], true); assert.equal(recover.status, 0, recover.stderr);
  assert.equal(JSON.parse(readFileSync(f.remote, 'utf8')).version, '0.1.0');
  assert.match(readFileSync(f.log, 'utf8'), /\/internal\/deployment\/recover-delivery/);
  const again = f.run(['--resume', receipt]); assert.equal(again.status, 0, again.stderr); assert.match(again.stdout, /recovered/);
});

test('current runner recovers source after a recorded post-upload interruption', (t) => {
  const f = fixture(t, 'customer-login'); f.configure();
  const failed = f.run(['--to', 'v0.1.1'], true, true);
  assert.equal(failed.status, 1);
  const directory = join(f.receipts(), readdirSync(f.receipts())[0]!);
  const receipt = join(directory, 'receipt.json');
  assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).stage, 'needs-inspection');
  assert.equal(JSON.parse(readFileSync(join(directory, 'deployment.json'), 'utf8')).stage, 'uploaded');
  assert.equal(JSON.parse(readFileSync(f.remote, 'utf8')).version, '0.1.1');
  const recover = f.run(['--recover', receipt], true);
  assert.equal(recover.status, 0, recover.stderr);
  assert.equal(JSON.parse(readFileSync(f.remote, 'utf8')).version, '0.1.0');
  assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).stage, 'recovered');
  assert.match(readFileSync(f.log, 'utf8'), /\/internal\/deployment\/recover-delivery/);
});

test('CLI refuses altered retained source before dependency scripts or deployment', (t) => {
  const f = fixture(t); f.configure();
  const preflight = f.run(['--to', 'v0.1.1', '--preflight']); assert.equal(preflight.status, 0, preflight.stderr);
  const directory = join(f.receipts(), readdirSync(f.receipts())[0]!);
  writeFileSync(join(directory, 'destination/package.json'), '{"version":"9.0.0"}');
  writeFileSync(f.log, '');
  const resume = f.run(['--resume', join(directory, 'receipt.json')]);
  assert.equal(resume.status, 1); assert.match(resume.stderr, /identity or clean-checkout/);
  assert.doesNotMatch(readFileSync(f.log, 'utf8'), /"ci"|"build"|"--skip-build"/);
  assert.equal(JSON.parse(readFileSync(f.remote, 'utf8')).version, '0.1.0');
});

for (const mutation of ['missing destination', 'stripped destination commit', 'tampered destination commit', 'tampered previous commit']) {
  test(`CLI re-resolves both immutable release identities before resume: ${mutation}`, (t) => {
    const f = fixture(t); f.configure();
    const preflight = f.run(['--to', 'v0.1.1', '--preflight']);
    assert.equal(preflight.status, 0, preflight.stderr);
    const directory = join(f.receipts(), readdirSync(f.receipts())[0]!);
    const receiptPath = join(directory, 'receipt.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (mutation === 'missing destination') delete receipt.destination;
    else if (mutation === 'stripped destination commit') delete receipt.destination.commit;
    else if (mutation === 'tampered destination commit') receipt.destination.commit = 'f'.repeat(40);
    else receipt.previous.commit = 'f'.repeat(40);
    writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    writeFileSync(f.log, '');

    const resumed = f.run(['--resume', receiptPath], true);
    assert.equal(resumed.status, 1);
    assert.match(resumed.stderr, /Stored (?:previous|destination) release identity/);
    assert.equal(readFileSync(f.log, 'utf8'), '');
    assert.equal(JSON.parse(readFileSync(f.remote, 'utf8')).version, '0.1.0');
  });
}
