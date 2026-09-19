import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { runDoctor } from '../src/doctor.ts';
import { FakeDeployment } from './helpers/fake-deployment.ts';
import { runCli, temporaryStore } from './helpers/run-cli.ts';

const deployments = {
  ready: new FakeDeployment({ mode: 'ready' }),
  incomplete: new FakeDeployment({ mode: 'setup-incomplete' }),
  wrongOrigin: new FakeDeployment({ mode: 'wrong-origin' }),
};

before(async () => {
  for (const deployment of Object.values(deployments)) await deployment.start();
});
after(async () => {
  for (const deployment of Object.values(deployments)) await deployment.stop();
});

test('doctor passes every public check on a ready deployment', async () => {
  const report = await runDoctor(deployments.ready.url);
  assert.equal(report.ok, true);
  assert.equal(report.setupIncomplete, false);
  assert.deepEqual(report.checks.map((check) => [check.id, check.ok]), [
    ['protected_resource', true],
    ['authorization_server', true],
    ['jwks', true],
    ['mcp_challenge', true],
  ]);

  const result = await runCli(['doctor', deployments.ready.url], { store: temporaryStore() });
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.filter((line) => line.startsWith('PASS')).length, 4);
  assert.match(lines.at(-1) ?? '', /^Doctor: ready/);
});

test('doctor explains a 404 on the auth surface as unfinished setup and exits 1', async () => {
  const result = await runCli(['doctor', deployments.incomplete.url], { store: temporaryStore() });
  assert.equal(result.code, 1);
  assert.equal(result.stdout.split('\n').filter((line) => line.startsWith('FAIL')).length, 4);
  assert.match(result.stdout, /has not finished setup/);
  assert.match(result.stdout, /Doctor: 4 checks failed\. The deployment has not finished setup\./);

  const json = await runCli(['doctor', deployments.incomplete.url, '--json'], { store: temporaryStore() });
  assert.equal(json.code, 1);
  const report = JSON.parse(json.stdout) as { ok: boolean; setupIncomplete: boolean; checks: unknown[] };
  assert.equal(report.ok, false);
  assert.equal(report.setupIncomplete, true);
  assert.equal(report.checks.length, 4);
});

test('doctor rejects an authorization server that cannot issue renewable credentials', async () => {
  for (const missing of ['offline_access', 'refresh_token']) {
    const report = await runDoctor(deployments.ready.url, {
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (!String(input).includes('/.well-known/oauth-authorization-server/')) return response;
        const metadata = await response.json() as Record<string, unknown>;
        const field = missing === 'offline_access' ? 'scopes_supported' : 'grant_types_supported';
        metadata[field] = (metadata[field] as string[]).filter((value) => value !== missing);
        return Response.json(metadata);
      },
    });
    assert.equal(report.ok, false);
    const auth = report.checks.find((check) => check.id === 'authorization_server');
    assert.equal(auth?.ok, false);
    assert.ok(auth?.detail.includes(missing));
    assert.equal(report.checks.find((check) => check.id === 'protected_resource')?.ok, true);
  }
});

test('doctor fails when the metadata names a different origin than the one used', async () => {
  const report = await runDoctor(deployments.wrongOrigin.url);
  assert.equal(report.ok, false);
  assert.equal(report.setupIncomplete, false);
  const resource = report.checks.find((check) => check.id === 'protected_resource');
  assert.equal(resource?.ok, false);
  assert.match(resource?.detail ?? '', /https:\/\/other\.example\/mcp/);
  assert.match(resource?.detail ?? '', /canonical origin differs/);
  const challenge = report.checks.find((check) => check.id === 'mcp_challenge');
  assert.equal(challenge?.ok, false);
  assert.match(challenge?.detail ?? '', /not on http:\/\/127\.0\.0\.1/);
  assert.equal(report.checks.find((check) => check.id === 'jwks')?.ok, true);
});

test('doctor reports an unreachable deployment without throwing', async () => {
  const report = await runDoctor('http://127.0.0.1:1');
  assert.equal(report.ok, false);
  for (const check of report.checks) assert.match(check.detail, /request failed/);
});

test('doctor rejects a non-HTTPS remote URL before any request', async () => {
  const result = await runCli(['doctor', 'http://chickpea.example'], { store: temporaryStore() });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^chickpea: INVALID_URL: /);
  assert.equal(result.stdout, '');
});
