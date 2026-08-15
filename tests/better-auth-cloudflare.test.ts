import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  cloudflareLoginIdentityAllowed,
  cloudflareLoginSourceAllowed,
  cloudflarePasswordPrimitive,
  type CloudflareBetterAuthEnv,
} from '../src/auth/better-auth-cloudflare.ts';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_SECONDS } from '../src/auth/better-auth.ts';
import { setCookieValues } from '../src/auth/cookies.ts';
import { DUMMY_PASSWORD_RECORD, nativePasswordPrimitive } from '../src/auth/password.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');
const WORKER_FIXTURE = join(ROOT, 'tests', 'fixtures', 'better-auth', 'private-seam-worker.ts');
const MIGRATIONS = join(ROOT, 'tests', 'fixtures', 'better-auth', '1.6.26');
const WORKER_SECRET = 'u0-worker-secret-is-stable-across-isolate-restarts';

test('Cloudflare KDF work shards dummy attempts by source and real verifiers by salt', async () => {
  const names: string[] = [];
  const env = fakeEnvironment(names);
  const firstSource = cloudflarePasswordPrimitive(env, 'source-a');
  const secondSource = cloudflarePasswordPrimitive(env, 'source-b');
  await firstSource.verify({ hash: DUMMY_PASSWORD_RECORD, password: 'wrong password' });
  await secondSource.verify({ hash: DUMMY_PASSWORD_RECORD, password: 'wrong password' });
  const realRecord = await nativePasswordPrimitive().hash('several unrelated words 5729');
  await firstSource.verify({ hash: realRecord, password: 'wrong password' });

  assert.equal(names.length, 3);
  assert.notEqual(names[0], names[1], 'unknown-account work must not funnel to one global DO');
  assert.notEqual(names[0], names[2], 'real verifier work must use its credential salt shard');
  assert.match(names[0] ?? '', /^kdf-verify:/);
});

test('Cloudflare source and existing-identity throttles use separate bounded shards', async () => {
  const names: string[] = [];
  const env = fakeEnvironment(names);
  assert.equal(await cloudflareLoginSourceAllowed(env, 'source-a'), true);
  assert.equal(await cloudflareLoginIdentityAllowed(env, 'owner@example.com'), true);
  assert.equal(names.length, 2);
  assert.match(names[0] ?? '', /^source-rate:/);
  assert.match(names[1] ?? '', /^identity-rate:/);
});

test('production private seam survives real workerd, D1, and isolate restart', {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-u0-auth-'));
  const persistTo = join(root, 'persist');
  const configPath = join(root, 'wrangler.json');
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  writeFileSync(configPath, JSON.stringify({
    name: 'chickpea-u0-auth-seam',
    main: WORKER_FIXTURE,
    compatibility_date: '2026-08-08',
    compatibility_flags: ['nodejs_compat'],
    d1_databases: [{
      binding: 'AUTH_DB',
      database_name: 'chickpea-u0-auth',
      database_id: '00000000-0000-0000-0000-000000000100',
      migrations_dir: MIGRATIONS,
    }],
  }, null, 2));

  const migrated = spawnSync(WRANGLER, [
    'd1', 'migrations', 'apply', 'AUTH_DB', '--local',
    '--persist-to', persistTo, '--config', configPath,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  });
  assert.equal(migrated.status, 0, migrated.stdout + migrated.stderr);

  let worker: WorkerHandle | undefined;
  try {
    worker = startWorker(configPath, persistTo, port);
    const health = await waitForWorker(worker, origin);
    assert.deepEqual(health.indexes, [
      'account_providerId_accountId_uidx',
      'member_organizationId_userId_uidx',
    ]);

    const first = await postJson(origin, '/test/reconcile', identityBody('T100', 'U100'));
    assert.equal(first.response.status, 200, first.text);
    const same = await postJson(origin, '/test/reconcile', identityBody('T100', 'U100'));
    assert.equal(same.response.status, 200, same.text);
    assert.deepEqual(same.body, first.body, 'the exact tuple must be find-before-create idempotent');

    const conflict = await postJson(origin, '/test/reconcile', {
      ...identityBody('T100', 'U100'),
      expectedUserId: 'different-better-auth-user',
    });
    assert.equal(conflict.response.status, 409, conflict.text);

    const otherTeam = await postJson(origin, '/test/reconcile', identityBody('T200', 'U100'));
    assert.equal(otherTeam.response.status, 200, otherTeam.text);
    assert.notEqual(otherTeam.body.userId, first.body.userId);
    assert.equal(first.body.accountId, 'slack:T100:U100');
    assert.equal(otherTeam.body.accountId, 'slack:T200:U100');

    const beforeAdmission = await getJson(origin, '/test/snapshot');
    assert.equal(beforeAdmission.body.sessions.length, 0);
    assert.deepEqual(
      beforeAdmission.body.members.map((member: { role: string }) => member.role),
      ['member', 'member'],
    );
    for (const user of beforeAdmission.body.users as Array<{
      email: string;
      emailVerified: number;
    }>) {
      assert.match(user.email, /^[a-f0-9]{48}@identity\.invalid$/);
      assert.equal(user.emailVerified, 0);
      assert.doesNotMatch(user.email, /T100|T200|U100/);
    }

    const pending = await postJson(origin, '/test/finalize', {
      ...identityBody('T300', 'U300'),
      operationId: 'operation-pending',
      status: 'reserved',
      chickpeaRole: 'owner',
    });
    assert.equal(pending.response.status, 403, pending.text);
    assert.deepEqual(setCookieValues(pending.response.headers), []);

    const injected = await postJson(origin, '/test/unmarked-private', {
      ...identityBody('T300', 'U300'),
      operationId: 'operation-active-unmarked',
      injectedUserId: first.body.userId,
    });
    assert.equal(injected.response.status, 403, injected.text);
    assert.deepEqual(setCookieValues(injected.response.headers), []);

    for (const probe of [
      { method: 'GET', path: '/api/auth/callback/slack?code=x&state=y' },
      { method: 'POST', path: '/api/auth/sign-in/social', body: { provider: 'slack' } },
      { method: 'POST', path: '/api/auth/sign-up/email', body: { email: 'x@example.com' } },
      { method: 'POST', path: '/api/auth/organization/create', body: { name: 'Attacker' } },
      {
        method: 'POST',
        path: '/api/auth/chickpea-private/issue-session',
        body: { operationId: 'operation-active-unmarked', userId: first.body.userId },
      },
    ]) {
      const response = await fetch(`${origin}${probe.path}`, {
        method: probe.method,
        ...(probe.method === 'POST' ? { headers: mutationHeaders(origin) } : {}),
        ...(probe.body ? { body: JSON.stringify(probe.body) } : {}),
      });
      assert.equal(response.status, 404, `${probe.method} ${probe.path}`);
      assert.deepEqual(setCookieValues(response.headers), []);
    }

    const dontRemember = signedCookie('true', WORKER_SECRET);
    const admitted = await postJson(origin, '/test/finalize', {
      ...identityBody('T300', 'U300'),
      operationId: 'operation-active',
      status: 'active',
      chickpeaRole: 'owner',
    }, { cookie: `better-auth.dont_remember=${dontRemember}` });
    assert.equal(admitted.response.status, 200, admitted.text);
    assert.deepEqual(Object.keys(admitted.body).sort(), [
      'membershipId',
      'ok',
      'operationId',
      'organizationId',
    ]);
    const setCookies = setCookieValues(admitted.response.headers);
    assert.equal(setCookies.length, 2, setCookies.join('\n'));
    assert.equal(setCookies.some((value) => /better-auth\.session_token=/.test(value)), true);
    assert.equal(setCookies.some((value) => /better-auth\.dont_remember=/.test(value)), true);
    for (const cookie of setCookies) assert.match(cookie, /HttpOnly/i);
    const cookie = setCookies.map((value) => value.split(';', 1)[0]).join('; ');

    const snapshot = await getJson(origin, '/test/snapshot');
    assert.equal(snapshot.body.sessions.length, 1);
    const session = snapshot.body.sessions[0] as Record<string, unknown>;
    const createdAt = epoch(session.createdAt);
    assert.equal(
      Math.abs(epoch(session.expiresAt) - createdAt - SESSION_IDLE_SECONDS * 1_000) < 5_000,
      true,
    );
    assert.equal(
      Math.abs(epoch(session.absoluteExpiresAt) - createdAt - SESSION_ABSOLUTE_MS) < 5_000,
      true,
    );

    const followUp = await fetch(`${origin}/api/auth/get-session`, { headers: { cookie } });
    assert.equal(followUp.status, 200);
    const admittedUserId = (await followUp.json() as { user?: { id?: string } }).user?.id;
    assert.equal(typeof admittedUserId, 'string');

    await stopWorker(worker);
    worker = startWorker(configPath, persistTo, port);
    await waitForWorker(worker, origin);
    const restarted = await fetch(`${origin}/api/auth/get-session`, { headers: { cookie } });
    assert.equal(restarted.status, 200);
    assert.equal((await restarted.json() as { user?: { id?: string } }).user?.id, admittedUserId);

    const expired = await postJson(origin, '/test/expire-sessions', {});
    assert.equal(expired.response.status, 200, expired.text);
    const afterAbsoluteExpiry = await fetch(`${origin}/api/auth/get-session`, {
      headers: { cookie },
    });
    assert.equal(await afterAbsoluteExpiry.json(), null);
    assert.equal((await getJson(origin, '/test/snapshot')).body.sessions.length, 0);
  } finally {
    if (worker) await stopWorker(worker);
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeEnvironment(names: string[]): CloudflareBetterAuthEnv {
  return {
    AUTH_DB: {} as CloudflareBetterAuthEnv['AUTH_DB'],
    CHICKPEA_RECOVERY_TOKEN: '6a'.repeat(32),
    AUTH_GUARD: {
      getByName(name: string) {
        names.push(name);
        return {
          async hashPassword() { return DUMMY_PASSWORD_RECORD; },
          async verifyPassword() { return false; },
          async allow() { return true; },
        };
      },
    },
  };
}

interface WorkerHandle {
  child: ChildProcess;
  output(): string;
}

function startWorker(configPath: string, persistTo: string, port: number): WorkerHandle {
  const child = spawn(WRANGLER, [
    'dev', '--config', configPath, '--port', String(port), '--persist-to', persistTo,
  ], {
    cwd: ROOT,
    env: { ...process.env, CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => { output += String(chunk); });
  child.stderr?.on('data', (chunk) => { output += String(chunk); });
  return { child, output: () => output };
}

async function stopWorker(handle: WorkerHandle): Promise<void> {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      handle.child.kill('SIGKILL');
      resolve();
    }, 5_000);
    handle.child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    handle.child.kill('SIGTERM');
  });
}

async function waitForWorker(
  handle: WorkerHandle,
  origin: string,
): Promise<{ ok: boolean; indexes: string[] }> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) {
      throw new Error(`wrangler dev exited early (${handle.child.exitCode}):\n${handle.output()}`);
    }
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return await response.json() as { ok: boolean; indexes: string[] };
    } catch {
      // Keep waiting for workerd to bind the requested port.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`wrangler dev did not become ready:\n${handle.output()}`);
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function identityBody(slackTeamId: string, slackUserId: string) {
  return { slackTeamId, slackUserId, displayName: `${slackTeamId} ${slackUserId}` };
}

function mutationHeaders(origin: string, extra: Record<string, string> = {}) {
  return {
    origin,
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
    ...extra,
  };
}

async function postJson(
  origin: string,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: mutationHeaders(origin, headers),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    response,
    text,
    body: text ? JSON.parse(text) as Record<string, any> : {},
  };
}

async function getJson(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return { response, body: JSON.parse(text) as Record<string, any> };
}

function signedCookie(value: string, secret: string): string {
  const signature = createHmac('sha256', secret).update(value).digest('base64');
  return encodeURIComponent(`${value}.${signature}`);
}

function epoch(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = new Date(String(value)).getTime();
  if (Number.isNaN(parsed)) throw new Error(`Invalid persisted date: ${String(value)}`);
  return parsed;
}
