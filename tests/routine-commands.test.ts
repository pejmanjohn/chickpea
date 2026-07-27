import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  handleRoutineSlackRequest,
  parseRoutineCommand,
} from '../src/routines/commands.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import type { RoutineCapability } from '../src/routines/scheduler-adapter.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';

const NOW = Date.UTC(2026, 6, 27, 12);
const enabled: RoutineCapability = {
  target: 'cloudflare', available: true, enabled: true, reason: 'enabled',
};

function turn(text: string, eventId = `Ev_${Math.random().toString(36).slice(2)}`): NormalizedSlackTurn {
  return {
    workspaceId: 'T_TEST', channelId: 'C_TEST', eventId, text, userId: 'U_MEMBER',
    messageTs: '1785000000.000100', threadTs: '1785000000.000100',
    source: 'app_mention', contextMode: 'channel_history',
  };
}

test('exact routine commands parse without model interpretation', () => {
  assert.deepEqual(parseRoutineCommand('!routines'), { kind: 'list' });
  assert.deepEqual(parseRoutineCommand('<@U_BOT> !routines <#C_OTHER|ops>'), {
    kind: 'list', channelMention: '<#C_OTHER|ops>',
  });
  assert.deepEqual(parseRoutineCommand('!routines pause routine_one'), {
    kind: 'control', action: 'pause', routineId: 'routine_one',
  });
  assert.deepEqual(parseRoutineCommand('!routines confirm abcdef'), {
    kind: 'confirm', token: 'abcdef',
  });
  assert.deepEqual(parseRoutineCommand('!routines nonsense'), { kind: 'invalid' });
});

test('natural-language creation is draft-only until exact confirmation, then controls are deterministic', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  const options = {
    store,
    capability: enabled,
    now: () => NOW,
    parseIntent: async () => ({
      action: 'create' as const,
      name: 'Support steward',
      description: 'Triages support requests.',
      taskText: 'Review new support requests, update their labels, and post a summary.',
      scheduleExpression: '0 9 * * 1-5',
      timezone: 'America/Los_Angeles',
      timezoneWasDefaulted: false,
      outputPolicy: 'post' as const,
    }),
  };
  try {
    const preview = await handleRoutineSlackRequest(
      turn('Every weekday, triage support requests and post a summary.', 'Ev_create'),
      undefined,
      options,
    );
    assert.match(preview ?? '', /Create routine preview/);
    assert.match(preview ?? '', /uses this channel's current Chickpea access each time it runs/i);
    assert.match(preview ?? '', /Creator: <@U_MEMBER>/);
    assert.match(preview ?? '', /separate just-in-time human confirmation/i);
    assert.equal((await store.listRoutines()).length, 0);
    const token = preview?.match(/!routines confirm ([A-Za-z0-9._-]+)/)?.[1];
    assert.ok(token);

    const createdText = await handleRoutineSlackRequest(
      turn(`!routines confirm ${token}`, 'Ev_confirm'), undefined, options,
    );
    assert.match(createdText ?? '', /Routine .* is active/);
    const [routine] = await store.listRoutines('T_TEST', 'C_TEST');
    assert.ok(routine);
    assert.equal(routine.taskText, 'Review new support requests, update their labels, and post a summary.');

    const list = await handleRoutineSlackRequest(turn('!routines', 'Ev_list'), undefined, options);
    assert.match(list ?? '', new RegExp(routine.id));
    const paused = await handleRoutineSlackRequest(
      turn(`!routines pause ${routine.id}`, 'Ev_pause'), undefined, options,
    );
    assert.match(paused ?? '', /now \*paused\*/);
    const runNow = await handleRoutineSlackRequest(
      turn(`!routines run ${routine.id}`, 'Ev_run'), undefined, options,
    );
    assert.match(runNow ?? '', /Queued one occurrence/);
    assert.equal((await store.listRuns({ routineId: routine.id })).length, 1);

    const deletion = await handleRoutineSlackRequest(
      turn(`!routines delete ${routine.id}`, 'Ev_delete'), undefined, options,
    );
    assert.match(deletion ?? '', /Delete routine/);
    assert.equal((await store.getRoutine(routine.id))?.deletedAt, null);
    const deleteToken = deletion?.match(/!routines confirm ([A-Za-z0-9._-]+)/)?.[1];
    assert.ok(deleteToken);
    await handleRoutineSlackRequest(
      turn(`!routines confirm ${deleteToken}`, 'Ev_delete_confirm'), undefined, options,
    );
    assert.notEqual((await store.getRoutine(routine.id))?.deletedAt, null);
  } finally {
    store.close();
  }
});

test('an omitted timezone proposes the Slack profile zone and an unrelated edit preserves it', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  const base = {
    store,
    capability: enabled,
    now: () => NOW,
    resolveDefaultTimezone: async () => 'America/New_York',
  };
  try {
    const preview = await handleRoutineSlackRequest(
      turn('Every weekday, post the support summary.', 'Ev_timezone_create'),
      undefined,
      {
        ...base,
        parseIntent: async () => ({
          action: 'create' as const,
          name: 'Support summary',
          taskText: 'Post the support summary.',
          scheduleExpression: '0 9 * * 1-5',
          timezone: 'UTC',
          timezoneWasDefaulted: true,
          outputPolicy: 'post' as const,
        }),
      },
    );
    assert.match(preview ?? '', /America\/New_York/);
    assert.match(preview ?? '', /proposed from your Slack profile/);
    const token = preview?.match(/!routines confirm ([A-Za-z0-9._-]+)/)?.[1];
    assert.ok(token);
    await handleRoutineSlackRequest(
      turn(`!routines confirm ${token}`, 'Ev_timezone_confirm'), undefined, base,
    );
    const [created] = await store.listRoutines('T_TEST', 'C_TEST');
    assert.equal(created?.timezone, 'America/New_York');

    const editPreview = await handleRoutineSlackRequest(
      turn('Edit the routine every weekday with a shorter summary.', 'Ev_timezone_edit'),
      undefined,
      {
        ...base,
        resolveDefaultTimezone: async () => 'Europe/London',
        parseIntent: async () => ({
          action: 'edit' as const,
          routineId: created!.id,
          taskText: 'Post a shorter support summary.',
          scheduleExpression: '0 9 * * 1-5',
          timezone: 'UTC',
          timezoneWasDefaulted: true,
        }),
      },
    );
    assert.match(editPreview ?? '', /America\/New_York/);
    assert.doesNotMatch(editPreview ?? '', /Europe\/London/);
  } finally {
    store.close();
  }
});

test('unsupported targets are explicit and unauthorized IDs are non-disclosing', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const unavailable: RoutineCapability = {
      target: 'node', available: false, enabled: false, reason: 'unsupported_target',
    };
    const text = await handleRoutineSlackRequest(turn('!routines'), undefined, {
      store, capability: unavailable, now: () => NOW,
    });
    assert.match(text ?? '', /Cloudflare-only/);
    const missing = await handleRoutineSlackRequest(turn('!routines show routine_secret'), undefined, {
      store, capability: unavailable, now: () => NOW,
    });
    assert.equal(missing, 'That routine or channel was not found or is unavailable.');
  } finally {
    store.close();
  }
});

test('intent parser infrastructure failures fall through to the ordinary Slack turn', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const result = await handleRoutineSlackRequest(
      turn('Summarize the weekly release notes.', 'Ev_parser_unavailable'),
      undefined,
      {
        store,
        capability: enabled,
        now: () => NOW,
        parseIntent: async () => { throw new Error('intent service unavailable'); },
      },
    );
    assert.equal(result, undefined);
  } finally {
    store.close();
  }
});
