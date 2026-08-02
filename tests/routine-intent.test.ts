import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isRoutineIntentCandidate,
  parseRoutineIntent,
  promptRoutineIntentAgent,
} from '../src/routines/intent.ts';
import { ROUTINE_INTENT_DATA_NAME } from '../src/agents/routine-intent.ts';

test('the lexical prefilter admits clear recurring-work requests but not routine discussion', () => {
  assert.equal(
    isRoutineIntentCandidate('Every weekday, summarize support requests and post the digest.'),
    true,
  );
  assert.equal(isRoutineIntentCandidate('How do routines work?'), false);
  assert.equal(isRoutineIntentCandidate('Summarize this thread now.'), false);
  assert.equal(isRoutineIntentCandidate('!routines show routine_one'), false);
  assert.equal(isRoutineIntentCandidate('Tomorrow at 9am, send the launch report.'), true);
  assert.equal(isRoutineIntentCandidate('On July 30, send the launch report.'), true);
  assert.equal(isRoutineIntentCandidate('In two hours, remind the channel about the launch.'), true);
  assert.equal(isRoutineIntentCandidate('Disable the Friday rollup.'), true);
});

test('the parser accepts one-time schedules and name-based management actions', async () => {
  const onceContext = {
    workspaceId: 'T_TEST', channelId: 'C_TEST', eventId: 'Ev_once',
    text: 'Tomorrow at 9am, send the launch report.', defaultTimezone: 'America/Los_Angeles',
  };
  const once = await parseRoutineIntent(onceContext, undefined, async () => ({
    action: 'create', triggerKind: 'once', name: 'Launch report',
    taskText: 'Send the launch report.', scheduleExpression: '2026-07-29T09:00',
    timezone: 'America/Los_Angeles', timezoneWasDefaulted: true, outputPolicy: 'post',
  }));
  assert.equal(once?.triggerKind, 'once');

  const control = await parseRoutineIntent(
    { ...onceContext, eventId: 'Ev_pause', text: 'Pause the routine "Friday rollup".' },
    undefined,
    async () => ({ action: 'pause', routineName: 'Friday rollup' }),
  );
  assert.deepEqual(control, { action: 'pause', routineName: 'Friday rollup' });
});

test('the tool-less parser output is schema-bound and non-matches fall through', async () => {
  const context = {
    workspaceId: 'T_TEST', channelId: 'C_TEST', eventId: 'Ev1',
    text: 'Every weekday, summarize support requests and post the digest.',
  };
  const parsed = await parseRoutineIntent(context, undefined, async () => ({
    action: 'create', name: 'Support digest', taskText: 'Summarize support requests and post the digest.',
    scheduleExpression: '0 9 * * 1-5', timezone: 'America/Los_Angeles',
    timezoneWasDefaulted: false, outputPolicy: 'post',
  }));
  assert.equal(parsed?.action, 'create');
  assert.equal(parsed?.scheduleExpression, '0 9 * * 1-5');

  assert.equal(
    await parseRoutineIntent(context, undefined, async () => ({ action: 'none' })),
    undefined,
  );
  assert.equal(
    await parseRoutineIntent(context, undefined, async () => ({ action: 'create', extra: true })),
    undefined,
  );
});

test('intent reads exactly one named data value and ignores free-form assistant JSON', async () => {
  const context = {
    workspaceId: 'T_TEST', channelId: 'C_TEST', eventId: 'Ev_data',
    text: 'Every weekday, post the digest.', defaultTimezone: 'UTC',
  };
  const handle = (data: Record<string, unknown[]>, text = '{"action":"delete"}') => ({
    async dispatch() {
      return {
        submissionId: 'submission_intent',
        acceptedAt: new Date().toISOString(),
        uid: 'uid_intent',
      };
    },
    async read() {
      return { submissionId: 'submission_intent', text, data };
    },
  });
  const value = { action: 'create', name: 'Digest', taskText: 'post the digest', outputPolicy: 'post' };
  assert.deepEqual(
    await promptRoutineIntentAgent(context, undefined, handle({ [ROUTINE_INTENT_DATA_NAME]: [value] })),
    value,
  );
  assert.equal(await promptRoutineIntentAgent(context, undefined, handle({})), undefined);
  assert.equal(
    await promptRoutineIntentAgent(
      context,
      undefined,
      handle({ [ROUTINE_INTENT_DATA_NAME]: [value, { action: 'none' }] }),
    ),
    undefined,
  );
});
