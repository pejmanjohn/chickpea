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

test('redirects are inspected without following a different release endpoint', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0; let cancelled = false;
    const result = await createUpdateChecker({ identity, fetch: async (_input, init) => {
      calls++;
      assert.equal(init?.redirect, 'manual');
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
        status, headers: { Location: 'https://untrusted.example/releases/latest' },
      });
    } })();
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'invalid-response');
    assert.equal(result.release, undefined);
  }
});

test('rate limits use bounded upstream cooldowns and tolerate missing or invalid headers', async () => {
  const time = Date.UTC(2026, 8, 8, 12);
  const cases: Array<[HeadersInit, number]> = [
    [{ 'retry-after': '120' }, 120_000],
    [{ 'retry-after': new Date(time + 180_000).toUTCString() }, 180_000],
    [{ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(time / 1_000 + 240) }, 240_000],
    [{ 'retry-after': '120', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(time / 1_000 + 300) }, 300_000],
    [{ 'retry-after': '120', 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': String(time / 1_000 + 300) }, 120_000],
    [{ 'retry-after': '1' }, 60_000],
    [{ 'retry-after': '864000' }, 24 * 60 * 60_000],
    [{}, 15 * 60_000],
    [{ 'retry-after': 'nonsense', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'not-a-timestamp' }, 15 * 60_000],
    [{ 'retry-after': new Date(time - 60_000).toUTCString(), 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(time / 1_000 - 1) }, 15 * 60_000],
    [{ 'retry-after': new Date(time + 180_000).toISOString() }, 15 * 60_000],
    [{ 'retry-after': '-10', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1e12' }, 15 * 60_000],
    [{ 'retry-after': '9'.repeat(400) }, 15 * 60_000],
  ];
  for (const status of [403, 429]) {
    for (const [headers, delay] of cases) {
      let cancelled = false;
      const check = createUpdateChecker({ identity, now: () => time, fetch: async () =>
        new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers }) });
      const result = await check();
      assert.equal(result.error, 'rate-limited');
      assert.equal(result.retryAt, new Date(time + delay).toISOString(), JSON.stringify(headers));
      assert.equal(cancelled, true);
    }
  }
});

test('manual and automatic checks respect rate-limit expiry while retaining a dated release', async () => {
  let time = Date.UTC(2026, 8, 8, 12); let calls = 0;
  const check = createUpdateChecker({ identity, now: () => time, fetch: async () => {
    calls++;
    return calls === 2
      ? new Response('', { status: 429, headers: { 'retry-after': '300' } })
      : Response.json(release);
  } });
  const success = await check();
  time += 30_000;
  const limited = await check(true);
  assert.equal(limited.status, 'failed');
  assert.equal(limited.lastSuccessfulCheckAt, success.checkedAt);
  assert.deepEqual(limited.release, success.release);
  const retryAt = Date.parse(limited.retryAt!);
  for (const nextTime of [time + 30_000, retryAt - 1]) {
    time = nextTime;
    assert.deepEqual(await Promise.all([check(), check(true)]), [limited, limited]);
    assert.equal(calls, 2);
  }
  time = retryAt;
  const recovered = await Promise.all([check(true), check()]);
  assert.equal(calls, 3);
  assert.equal(recovered[0].status, 'available');
  assert.equal(recovered[0].retryAt, undefined);
  assert.equal(recovered[0].lastSuccessfulCheckAt, undefined);
  assert.equal(recovered[0].checkedAt, new Date(time).toISOString());
});

test('ordinary failures retain the short retry window without a rate-limit timestamp', async () => {
  let time = 0; let calls = 0;
  const check = createUpdateChecker({ identity, now: () => time, fetch: async () => {
    calls++;
    return new Response('', { status: 503 });
  } });
  assert.equal((await check()).retryAt, undefined);
  time = 29_999; await check(true); assert.equal(calls, 1);
  time = 30_000; await check(true); assert.equal(calls, 2);
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
