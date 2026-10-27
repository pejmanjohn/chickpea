import assert from 'node:assert/strict';
import { test } from 'node:test';

import { environmentRoutineDueResponse } from '../src/admin/environment-routine-due.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import type { RoutineDefinition } from '../src/routines/types.ts';

const SEED_TOKEN = 'S'.repeat(43);
const NOW = Date.UTC(2026, 9, 27, 12);
const laneEnv = { CHICKPEA_ENV_TARGET: 'amber', CHICKPEA_ENV_SEED_TOKEN: SEED_TOKEN } as unknown as PlatformEnv;

function call({ env = laneEnv, authorization = `Bearer ${SEED_TOKEN}`, body = '{"routineId":"routine_smoke"}', routine }: {
  env?: PlatformEnv; authorization?: string; body?: string; routine?: (now: number) => Partial<RoutineDefinition> | undefined;
} = {}) {
  const marked: string[] = [];
  const response = environmentRoutineDueResponse({
    authorization,
    env,
    readBody: async () => body,
    now: () => NOW,
    markDueNow: async (routineId, now) => {
      marked.push(routineId);
      const found = (routine ?? ((at) => ({ state: 'active', nextRunAt: at })))(now);
      return found as RoutineDefinition | undefined;
    },
  });
  return { response, marked };
}

test('the due-now route answers only the lane seed token on a QA target', async () => {
  for (const { env, authorization } of [
    { env: laneEnv, authorization: '' },
    { env: laneEnv, authorization: `Bearer ${'T'.repeat(43)}` },
    { env: { CHICKPEA_ENV_SEED_TOKEN: SEED_TOKEN } as unknown as PlatformEnv, authorization: `Bearer ${SEED_TOKEN}` },
  ]) {
    const { response, marked } = call({ env, authorization });
    const answer = await response;
    assert.equal(answer.status, 404);
    assert.equal(await answer.text(), '{}');
    assert.deepEqual(marked, [], 'nothing is touched without the lane token');
  }
});

test('the due-now route makes one active routine due now and refuses the rest', async () => {
  const ok = await call().response;
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { routineId: 'routine_smoke', state: 'active', nextRunAt: NOW });

  assert.equal((await call({ body: '{"routineId":"../x"}' }).response).status, 400);
  assert.equal((await call({ body: 'not json' }).response).status, 400);
  assert.equal((await call({ routine: () => undefined }).response).status, 404);
  const paused = await call({ routine: () => ({ state: 'paused', nextRunAt: null }) }).response;
  assert.equal(paused.status, 409);
  assert.deepEqual(await paused.json(), { error: 'routine_not_due', state: 'paused' });
});
