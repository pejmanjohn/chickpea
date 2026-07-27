import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isRoutineIntentCandidate, parseRoutineIntent } from '../src/routines/intent.ts';
import { route as routineIntentRoute } from '../src/agents/routine-intent.ts';
import { getInternalAgentToken } from '../src/slack/internal-auth.ts';

test('the lexical prefilter admits clear recurring-work requests but not routine discussion', () => {
  assert.equal(
    isRoutineIntentCandidate('Every weekday, summarize support requests and post the digest.'),
    true,
  );
  assert.equal(isRoutineIntentCandidate('How do routines work?'), false);
  assert.equal(isRoutineIntentCandidate('Summarize this thread now.'), false);
  assert.equal(isRoutineIntentCandidate('!routines show routine_one'), false);
});

test('the tool-less parser output is schema-bound and non-matches fall through', async () => {
  const context = {
    workspaceId: 'T_TEST', channelId: 'C_TEST', eventId: 'Ev1',
    text: 'Every weekday, summarize support requests and post the digest.',
  };
  const parsed = await parseRoutineIntent(context, undefined, async () => JSON.stringify({
    action: 'create', name: 'Support digest', taskText: 'Summarize support requests and post the digest.',
    scheduleExpression: '0 9 * * 1-5', timezone: 'America/Los_Angeles',
    timezoneWasDefaulted: false, outputPolicy: 'post',
  }));
  assert.equal(parsed?.action, 'create');
  assert.equal(parsed?.scheduleExpression, '0 9 * * 1-5');

  assert.equal(
    await parseRoutineIntent(context, undefined, async () => '{"action":"none"}'),
    undefined,
  );
  assert.equal(
    await parseRoutineIntent(context, undefined, async () => '{"action":"create","extra":true}'),
    undefined,
  );
});

test('the generated routine-intent Agent route is internal-only', async () => {
  const context = (token?: string) => ({
    req: { header: () => token },
    json: (body: unknown, status: number) => Response.json(body, { status }),
  });
  const denied = await routineIntentRoute(
    context() as never,
    async () => undefined,
  );
  assert.equal(denied instanceof Response ? denied.status : 0, 401);
  let reached = false;
  await routineIntentRoute(
    context(getInternalAgentToken()) as never,
    async () => { reached = true; },
  );
  assert.equal(reached, true);
});
