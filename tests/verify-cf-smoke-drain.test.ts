import assert from 'node:assert/strict';
import { test } from 'node:test';

// @ts-expect-error The executable .mjs intentionally has no declaration file.
import { runDrainCheck } from '../scripts/lib/cf-drain-check.mjs';

const ZERO_STATUS = {
  drained: true,
  categories: {
    pendingLegacyTurnJobs: 0,
    pendingLedgerTurnJobs: 0,
    pendingSlackInteractionCleanups: 0,
    recoveryRequiredTurnJobs: 0,
    executingRuns: 0,
    admittingOrRunningRoutineOccurrences: 0,
  },
};

test('drain-only smoke accepts an authenticated all-zero deployment without exposing the token', async () => {
  const requests: Array<{
    url: string;
    authorization: string | null;
    cache: RequestCache | undefined;
    hasDeadline: boolean;
    redirect: RequestRedirect | undefined;
  }> = [];
  const result = await runDrainCheck({
    baseUrl: 'https://chickpea.example.test/',
    personalToken: 'operator-secret',
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get('authorization'),
        cache: init?.cache,
        hasDeadline: init?.signal instanceof AbortSignal,
        redirect: init?.redirect,
      });
      return new Response(JSON.stringify(ZERO_STATUS), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.deepEqual(result, ZERO_STATUS);
  assert.deepEqual(requests, [{
    url: 'https://chickpea.example.test/admin/api/runtime/drain',
    authorization: 'Bearer operator-secret',
    cache: 'no-store',
    hasDeadline: true,
    redirect: 'error',
  }]);
  assert.doesNotMatch(JSON.stringify(result), /operator-secret/);
});

test('drain-only smoke accepts a Better Auth browser session without a legacy token', async () => {
  let cookie = '';
  await runDrainCheck({
    baseUrl: 'https://chickpea.example.test/',
    sessionCookie: 'better-auth.session_token=opaque-session',
    fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
      cookie = new Headers(init?.headers).get('cookie') ?? '';
      return new Response(JSON.stringify(ZERO_STATUS), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(cookie, 'better-auth.session_token=opaque-session');
});

test('drain-only smoke blocks cutover on nonzero, malformed, or unauthorized state', async () => {
  await assert.rejects(
    () => runDrainCheck({
      baseUrl: 'https://chickpea.example.test',
      personalToken: 'operator-secret',
      fetchImpl: async () => new Response(JSON.stringify({
        ...ZERO_STATUS,
        drained: false,
        categories: { ...ZERO_STATUS.categories, executingRuns: 1 },
      }), { status: 200 }),
    }),
    /deployment is not drained.*executingRuns=1/,
  );
  await assert.rejects(
    () => runDrainCheck({
      baseUrl: 'https://chickpea.example.test',
      personalToken: 'operator-secret',
      fetchImpl: async () => new Response(JSON.stringify({ drained: true }), { status: 200 }),
    }),
    /invalid runtime drain response/,
  );
  await assert.rejects(
    () => runDrainCheck({
      baseUrl: 'https://chickpea.example.test',
      personalToken: 'operator-secret',
      fetchImpl: async () => new Response(JSON.stringify({
        ...ZERO_STATUS,
        drained: false,
      }), { status: 200 }),
    }),
    /invalid runtime drain response/,
  );
  await assert.rejects(
    () => runDrainCheck({
      baseUrl: 'https://chickpea.example.test',
      personalToken: 'operator-secret',
      fetchImpl: async () => new Response(JSON.stringify({
        ...ZERO_STATUS,
        categories: { ...ZERO_STATUS.categories, pendingLedgerTurnJobs: -1 },
      }), { status: 200 }),
    }),
    /invalid runtime drain response/,
  );
  await assert.rejects(
    () => runDrainCheck({
      baseUrl: 'https://chickpea.example.test',
      personalToken: 'operator-secret',
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
    }),
    /runtime drain request failed \(HTTP 401\)/,
  );
});

test('offline recovery credential is not treated as an Admin drain credential', async () => {
  let authorization = '';
  await assert.rejects(
    () => runDrainCheck({
      baseUrl: 'https://chickpea.example.test',
      personalToken: 'offline-recovery-value',
      fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
        authorization = new Headers(init?.headers).get('authorization') ?? '';
        return new Response('unauthorized', { status: 401 });
      },
    }),
    /runtime drain request failed \(HTTP 401\)/,
  );
  assert.equal(authorization, 'Bearer offline-recovery-value');
});
