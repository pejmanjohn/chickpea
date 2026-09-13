import assert from 'node:assert/strict';
import test from 'node:test';
import { createUpdateChecker } from '../src/release/update-check.ts';

const identity = { version: '0.1.0', sourceCommit: 'a'.repeat(40) };
const release = { tag_name: 'v0.1.1', immutable: true, draft: false, prerelease: false,
  html_url: 'https://github.com/pejmanjohn/chickpea/releases/tag/v0.1.1',
  published_at: '2026-09-07T12:00:00Z', body: '<script>private?</script>' };
const migrations = Object.fromEntries(['d1', 'workerConfiguration', 'identity', 'configuration', 'work']
  .map((name, index) => [name, String(index + 1).repeat(64)]));
const installedManifest = { formatVersion: 1, version: '0.1.0', storageGeneration: 1, supportedOrigins: [],
  recovery: 'previous-code-only', migrations };
const destinationManifest = { ...installedManifest, version: '0.1.1', supportedOrigins: ['0.1.0'] };

function published(version: string) {
  return { ...release, tag_name: `v${version}`,
    html_url: `https://github.com/pejmanjohn/chickpea/releases/tag/v${version}` };
}

function officialFetch(options: {
  installedCommit?: string;
  destinationCommit?: string;
  before?: unknown;
  after?: unknown;
  requests?: string[];
} = {}): typeof fetch {
  const installedCommit = options.installedCommit ?? identity.sourceCommit;
  const destinationCommit = options.destinationCommit ?? 'b'.repeat(40);
  return async (input, init) => {
    const url = String(input);
    options.requests?.push(url);
    assert.equal(init?.redirect, 'manual');
    assert.equal((init?.headers as Record<string, string>)?.Authorization, undefined);
    if (url.endsWith('/releases/latest')) return Response.json(release);
    if (url.endsWith('/releases/tags/v0.1.0')) return Response.json(published('0.1.0'));
    if (url.endsWith('/git/ref/tags/v0.1.0')) return Response.json({ object: { type: 'commit', sha: installedCommit } });
    if (url.endsWith('/git/ref/tags/v0.1.1')) return Response.json({ object: { type: 'commit', sha: destinationCommit } });
    if (url.endsWith(`/contents/release.json?ref=${installedCommit}`)) return Response.json(options.before ?? installedManifest);
    if (url.endsWith(`/contents/release.json?ref=${destinationCommit}`)) return Response.json(options.after ?? destinationManifest);
    return new Response('', { status: 404 });
  };
}

test('checks coalesce and retain dated successful results after a failed refresh', async () => {
  let time = 0; let calls = 0; let fail = false;
  const stableFetch = officialFetch();
  const check = createUpdateChecker({ identity, now: () => time, fetch: async (input, init) => {
    calls++; if (fail && String(input).endsWith('/releases/latest')) throw new Error('secret-token');
    return stableFetch(input, init);
  } });
  const results = await Promise.all([check(), check()]);
  assert.equal(calls, 6);
  assert.equal(results[0].status, 'available');
  assert.equal(results[0].release?.version, '0.1.1');
  assert.equal(results[0].guidedUpdate, 'supported');
  time = 60_000; fail = true;
  const failed = await check(true);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'network');
  assert.equal(failed.lastSuccessfulCheckAt, new Date(0).toISOString());
  assert.equal(failed.release?.version, '0.1.1');
  assert.equal(calls, 7);
  assert.doesNotMatch(JSON.stringify(failed), /secret-token/);
});

test('invalid, mutable, CLI, draft, prerelease and oversized responses never become up to date', async () => {
  for (const value of [null, {}, { ...release, immutable: false }, { ...release, html_url: 'https://example.test/v0.1.1' },
    { ...release, tag_name: 'cli-v0.1.1' }, { ...release, draft: true }, { ...release, prerelease: true },
    { ...release, tag_name: 'v01.1.0' }, { ...release, body: 'x'.repeat(100_000) }]) {
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
    assert.equal((await createUpdateChecker({ identity, fetch: async () => Response.json(published(version)) })()).status, expected);
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
  const stableFetch = officialFetch();
  const check = createUpdateChecker({ identity, now: () => time, fetch: async (input, init) => {
    if (String(input).endsWith('/releases/latest')) calls++;
    return calls === 2 && String(input).endsWith('/releases/latest')
      ? new Response('', { status: 429, headers: { 'retry-after': '300' } })
      : stableFetch(input, init);
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

test('guided updates require immutable installed provenance and compatible pinned manifests', async () => {
  const requests: string[] = [];
  const supported = await createUpdateChecker({ identity, fetch: officialFetch({ requests }) })();
  assert.equal(supported.status, 'available');
  assert.equal(supported.guidedUpdate, 'supported');
  assert.ok(requests.includes(`https://api.github.com/repos/pejmanjohn/chickpea/contents/release.json?ref=${identity.sourceCommit}`));
  assert.ok(requests.includes(`https://api.github.com/repos/pejmanjohn/chickpea/contents/release.json?ref=${'b'.repeat(40)}`));

  const unsupported = await createUpdateChecker({ identity,
    fetch: officialFetch({ after: { ...destinationManifest, supportedOrigins: [] } }) })();
  assert.equal(unsupported.status, 'available');
  assert.equal(unsupported.guidedUpdate, 'unsupported');

  const customCommit = await createUpdateChecker({ identity,
    fetch: officialFetch({ installedCommit: 'c'.repeat(40) }) })();
  assert.equal(customCommit.status, 'available');
  assert.equal(customCommit.guidedUpdate, 'unknown');
});

test('release availability survives an unreadable compatibility manifest', async () => {
  const base = officialFetch();
  for (const manifestResponse of [
    () => new Response('', { status: 503 }),
    () => Response.json('x'.repeat(20_000)),
    () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } }),
  ]) {
    const result = await createUpdateChecker({ identity, timeoutMs: 5, fetch: async (input, init) =>
      String(input).includes('/contents/release.json') ? manifestResponse() : base(input, init) })();
    assert.equal(result.status, 'available');
    assert.equal(result.release?.version, '0.1.1');
    assert.equal(result.guidedUpdate, 'unknown');
  }
});

test('compatibility rate limits preserve availability and suppress retries until reset', async () => {
  let time = Date.UTC(2026, 8, 8, 12); let latestCalls = 0; let limited = true;
  const base = officialFetch();
  const check = createUpdateChecker({ identity, now: () => time, fetch: async (input, init) => {
    if (String(input).endsWith('/releases/latest')) latestCalls++;
    if (limited && String(input).includes('/contents/release.json')) {
      return new Response('', { status: 429, headers: { 'retry-after': '300' } });
    }
    return base(input, init);
  } });
  const result = await check();
  assert.equal(result.status, 'available');
  assert.equal(result.guidedUpdate, 'unknown');
  assert.equal(result.retryAt, new Date(time + 300_000).toISOString());
  time += 299_999; limited = false;
  assert.deepEqual(await check(true), result);
  assert.equal(latestCalls, 1);
  time += 1;
  assert.equal((await check(true)).guidedUpdate, 'supported');
  assert.equal(latestCalls, 2);
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
