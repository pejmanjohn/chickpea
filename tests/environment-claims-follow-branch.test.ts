import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

// @ts-expect-error Executable JavaScript helper.
import { runEnvironmentCli } from '../scripts/chickpea-environment.mjs';
// @ts-expect-error Executable JavaScript helper.
import { claimEnvironment, environmentMarkerPath, readEnvironmentRegistry, reclaimEnvironment } from '../scripts/lib/environment-registry.mjs';
// @ts-expect-error Executable JavaScript helper.
import { carryEnvironmentSchemaAdvancementIntent, writeEnvironmentSchemaAdvancementIntent } from '../scripts/lib/environment-preflight.mjs';
import { fixture, git, localContract } from './environment-preflight.fixture.ts';

function cli() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = { hostFingerprint: 'host-fixture', sourceAdvisory: false, stdout: (value: string) => stdout.push(value), stderr: (value: string) => stderr.push(value) };
  return { io, stdout, stderr };
}

function commit(worktree: string, name: string) {
  writeFileSync(join(worktree, `${name}.txt`), `${name}\n`);
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-m', name);
  return git(worktree, 'rev-parse', 'HEAD');
}

test('restamp moves this worktree\'s own claim to its new HEAD; release works after commits and branch switches', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const flags = ['--root', f.root, '--worktree', f.worktree];
  const claimRun = cli();
  assert.equal(await runEnvironmentCli(['claim', 'amber', ...flags], claimRun.io), 0, claimRun.stderr.join(''));
  const first = JSON.parse(claimRun.stdout.join(''));

  const moved = commit(f.worktree, 'fix');
  const restampRun = cli();
  assert.equal(await runEnvironmentCli(['restamp', 'amber', ...flags], restampRun.io), 0, restampRun.stderr.join(''));
  const restamped = JSON.parse(restampRun.stdout.join(''));
  assert.equal(restamped.restamped, true);
  assert.equal(restamped.previousRevision, first.claimedRevision);
  assert.equal(restamped.claimedRevision, moved);
  assert.equal(restamped.schemaIntent, 'none');
  const registry = readEnvironmentRegistry({ root: f.root, hostFingerprint: 'host-fixture' });
  assert.equal(registry.targets.amber.claim.claimedRevision, moved);
  assert.notEqual(registry.targets.amber.claim.leaseNonce, first.leaseNonce, 'the nonce rotates');
  const marker = JSON.parse(readFileSync(environmentMarkerPath(f.worktree), 'utf8'));
  assert.equal(marker.claimedRevision, moved, 'the worktree marker follows the claim');
  assert.equal(registry.audit.at(-1).event, 'claim_reclaimed');

  // Another commit and a branch switch: release still gives the lane back.
  commit(f.worktree, 'second');
  git(f.worktree, 'switch', '-q', '-c', 'feature/other');
  const releaseRun = cli();
  assert.equal(await runEnvironmentCli(['release', 'amber', ...flags], releaseRun.io), 0, releaseRun.stderr.join(''));
  assert.equal(JSON.parse(releaseRun.stdout.join('')).released, true);
  assert.equal(readEnvironmentRegistry({ root: f.root, hostFingerprint: 'host-fixture' }).targets.amber.claim, null);
});

test('restamp never takes another worktree\'s lane, and has no claim to move without one', async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  const other = join(f.parent, 'other');
  git(f.parent, 'clone', '-q', f.worktree, other);
  claimEnvironment('amber', { ...f.options, worktreePath: f.worktree });
  for (const worktree of [other]) {
    const run = cli();
    assert.equal(await runEnvironmentCli(['restamp', 'amber', '--root', f.root, '--worktree', worktree], run.io), 2);
    assert.match(run.stderr.join(''), /CLAIM_OWNER_MISMATCH/);
  }
  const unclaimed = cli();
  assert.equal(await runEnvironmentCli(['restamp', 'cobalt', '--root', f.root, '--worktree', other], unclaimed.io), 2);
  assert.match(unclaimed.stderr.join(''), /CLAIM_REQUIRED/);
  const secondLane = cli();
  assert.equal(await runEnvironmentCli(['restamp', 'cobalt', '--root', f.root, '--worktree', f.worktree], secondLane.io), 2);
  assert.match(secondLane.stderr.join(''), /WORKTREE_ALREADY_CLAIMED/, 'a worktree holding one lane cannot restamp into another');
  const owner = readEnvironmentRegistry({ root: f.root, hostFingerprint: 'host-fixture' }).targets.amber.claim.canonicalWorktreePath;
  assert.equal(owner, f.worktree, 'the lane still belongs to its holder');
});

test('a restamp carries this worktree\'s schema-advancement intent to the new claim', (context) => {
  const f = fixture();
  context.after(() => rmSync(f.parent, { recursive: true, force: true }));
  claimEnvironment('amber', f.options);
  const contract = { ...localContract(), schemaGeneration: 'd1:0003_reviewed;do:v10' };
  const written = writeEnvironmentSchemaAdvancementIntent('amber', contract.schemaGeneration, { ...f.options, localContract: contract });
  commit(f.worktree, 'rebased');
  let previous: { leaseNonce: string } | undefined;
  const claim = reclaimEnvironment('amber', { ...f.options, requireSameWorktree: true, onReclaimed: (change: { previous: { leaseNonce: string } }) => { previous = change.previous; } });
  assert.equal(previous?.leaseNonce, written.claimNonce);
  assert.equal(carryEnvironmentSchemaAdvancementIntent('amber', previous?.leaseNonce, { ...f.options, localContract: contract }), 'carried');
  const intentPath = join(f.records[0]!.evidenceRoot, 'schema-advancement-intent.json');
  const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  assert.equal(intent.claimNonce, claim.leaseNonce);
  assert.equal(intent.toGeneration, contract.schemaGeneration);
  assert.equal(carryEnvironmentSchemaAdvancementIntent('amber', 'not-this-claim', { ...f.options, localContract: contract }), 'other_claim');
  // A candidate whose contract no longer names that successor leaves the intent stale, untouched.
  const before = readFileSync(intentPath, 'utf8');
  reclaimEnvironment('amber', { ...f.options, requireSameWorktree: true });
  assert.match(carryEnvironmentSchemaAdvancementIntent('amber', claim.leaseNonce, { ...f.options, localContract: localContract() }), /^stale:/);
  assert.equal(readFileSync(intentPath, 'utf8'), before);
});

test('env --help prints the command list; no arguments prints it as an error', async () => {
  const help = cli();
  assert.equal(await runEnvironmentCli(['--help'], help.io), 0);
  assert.match(help.stdout.join(''), /restamp <lane>.*\n.*rebase/s);
  assert.match(help.stdout.join(''), /schema-advance <lane>/);
  const none = cli();
  assert.equal(await runEnvironmentCli([], none.io), 2);
  assert.match(none.stderr.join(''), /Usage: npm run env/);
});
