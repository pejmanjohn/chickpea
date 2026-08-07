import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PersonalTokenService } from '../src/auth/personal-token.ts';
import { TokenSessionService } from '../src/auth/token-session.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'recover-auth.mjs');
const RECOVERY = 'offline-recovery-token-with-at-least-thirty-two-characters';
const ORIGIN = 'https://chickpea.example.com';

function run(path: string, args: string[], proof = RECOVERY) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', SCRIPT, '--state-db', path, ...args],
    {
      cwd: ROOT,
      encoding: 'utf8',
      input: `${proof}\n`,
      env: { ...process.env, CHICKPEA_RECOVERY_TOKEN: RECOVERY },
    },
  );
}

async function tokenFixture(path: string) {
  const identity = new SqliteIdentityStore(path);
  const organization = await identity.ensureOrganization({ displayName: 'Chickpea' });
  await identity.createOwnerClaim({ organizationId: organization.id, email: 'owner@example.com' });
  const owner = await identity.claimOwner({
    organizationId: organization.id,
    provider: 'operator_token',
    issuer: 'urn:chickpea:operator',
    subject: 'owner-subject',
    verifiedEmail: 'owner@example.com',
  });
  await identity.updateOrganizationAuth({
    organizationId: organization.id,
    authMode: 'token_active',
    canonicalAdminOrigin: ORIGIN,
  });
  const personal = new PersonalTokenService(identity);
  const first = await personal.create(owner.user.id, 'First');
  const second = await personal.create(owner.user.id, 'Second');
  const browser = await new TokenSessionService(identity).create(first.record, owner.membership.id);
  identity.close();
  return { first, second, browser };
}

test('offline recovery rotates one owner token and revokes prior sessions', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-auth-recovery-'));
  const path = join(directory, 'state.sqlite');
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = await tokenFixture(path);

  const result = run(path, ['--owner-email', 'OWNER@example.com', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(RECOVERY));
  const replacement = result.stdout.match(/chp_pat_[A-Za-z0-9_-]+/)?.[0];
  assert.ok(replacement);
  assert.equal(result.stdout.match(/chp_pat_/g)?.length, 1);

  const identity = new SqliteIdentityStore(path);
  const summary = await identity.exportSummary();
  assert.equal(summary.personalTokens.filter((token) => token.status === 'active').length, 1);
  assert.equal(summary.personalTokens.filter((token) => token.status === 'revoked').length, 2);
  assert.equal(summary.browserSessions.every((session) => session.revokedAt !== null), true);
  await assert.rejects(() => new PersonalTokenService(identity).authenticate(fixture.first.token, true));
  await assert.rejects(() => new PersonalTokenService(identity).authenticate(fixture.second.token, true));
  assert.equal((await new PersonalTokenService(identity).authenticate(replacement, true)).role, 'owner');
  identity.close();
});

test('wrong recovery proof and dry-run mode do not mutate deployment state', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-auth-recovery-denied-'));
  const path = join(directory, 'state.sqlite');
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  await tokenFixture(path);

  const denied = run(path, ['--owner-email', 'owner@example.com', '--yes'], 'wrong-proof');
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /not accepted/);
  const dryRun = run(path, ['--owner-email', 'owner@example.com']);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /Dry run only/);

  const identity = new SqliteIdentityStore(path);
  const summary = await identity.exportSummary();
  assert.equal(summary.personalTokens.filter((token) => token.status === 'active').length, 2);
  assert.equal(summary.browserSessions.every((session) => session.revokedAt === null), true);
  identity.close();
});

test('explicit token-mode bootstrap creates one owner and a show-once token', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-auth-bootstrap-'));
  const path = join(directory, 'state.sqlite');
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const result = run(path, [
    '--bootstrap-token-mode', '--owner-email', 'owner@example.com', '--origin', ORIGIN, '--yes',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Copy this personal token now/);
  const identity = new SqliteIdentityStore(path);
  assert.equal((await identity.getOrganization())?.authMode, 'token_active');
  assert.equal((await identity.listMemberships()).length, 1);
  identity.close();
});

test('invalid bootstrap input leaves no partial owner claim and can be retried', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-auth-bootstrap-retry-'));
  const path = join(directory, 'state.sqlite');
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const invalid = run(path, [
    '--bootstrap-token-mode', '--owner-email', 'owner@example.com',
    '--origin', 'https://chickpea.example.com/path', '--yes',
  ]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /origin is invalid/i);
  const identity = new SqliteIdentityStore(path);
  assert.equal(await identity.getOrganization(), undefined);
  assert.equal(await identity.getOwnerClaim(), undefined);
  identity.close();

  const retry = run(path, [
    '--bootstrap-token-mode', '--owner-email', 'owner@example.com', '--origin', ORIGIN, '--yes',
  ]);
  assert.equal(retry.status, 0, retry.stderr);
});

test('recovery executable has no HTTP transport or recovery route', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /from ['"]hono['"]/);
  assert.doesNotMatch(source, /node:https/);
});
