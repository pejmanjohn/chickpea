import assert from 'node:assert/strict';
import test from 'node:test';
import { createUpdateChecker } from '../src/release/update-check.ts';

const identity = { version: '0.1.0', sourceCommit: 'a'.repeat(40) };
const release = { tag_name: 'v0.1.1', draft: false, prerelease: false, published_at: '2026-09-07T12:00:00Z', body: '<script>private?</script>' };

test('checks coalesce and retain dated successful results after a failed refresh', async () => {
  let time = 0; let calls = 0; let fail = false;
  const check = createUpdateChecker({ identity, now: () => time, fetch: async () => {
    calls++; if (fail) throw new Error('secret-token');
    return Response.json(release);
  } });
  const results = await Promise.all([check(), check()]);
  assert.equal(calls, 1);
  assert.equal(results[0].status, 'available');
  assert.equal(results[0].release?.version, '0.1.1');
  time = 60_000; fail = true;
  const failed = await check(true);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'network');
  assert.equal(failed.lastSuccessfulCheckAt, new Date(0).toISOString());
  assert.equal(failed.release?.version, '0.1.1');
  assert.doesNotMatch(JSON.stringify(failed), /secret-token/);
});

test('invalid, CLI, draft, prerelease and oversized responses never become up to date', async () => {
  for (const value of [null, {}, { ...release, tag_name: 'cli-v0.1.1' }, { ...release, draft: true }, { ...release, prerelease: true }, { ...release, tag_name: 'v01.1.0' }, { ...release, body: 'x'.repeat(100_000) }]) {
    const result = await createUpdateChecker({ identity, fetch: async () => Response.json(value) })();
    assert.equal(result.status, 'failed');
  }
  const rateLimit = await createUpdateChecker({ identity, fetch: async () => new Response('', { status: 429 }) })();
  assert.equal(rateLimit.error, 'rate-limited');
  const none = await createUpdateChecker({ identity, fetch: async () => new Response('', { status: 404 }) })();
  assert.equal(none.status, 'no-release');
});

test('comparison handles numeric minor versions and unknown source identity honestly', async () => {
  for (const [version, expected] of [['0.1.0', 'current'], ['0.0.9', 'current'], ['0.10.0', 'available']] as const) {
    assert.equal((await createUpdateChecker({ identity, fetch: async () => Response.json({ ...release, tag_name: `v${version}` }) })()).status, expected);
  }
  assert.equal((await createUpdateChecker({ identity: { ...identity, sourceCommit: null }, fetch: async () => Response.json(release) })()).status, 'unversioned');
});

test('a hung fetch or stalled response body settles as timeout', async () => {
  for (const fetcher of [
    async () => new Promise<Response>(() => {}),
    async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } }),
  ]) {
    const result = await createUpdateChecker({ identity, fetch: fetcher, timeoutMs: 5 })();
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'timeout');
  }
});
