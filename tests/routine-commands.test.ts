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
const canManageChannel = async () => true;

function turn(text: string, eventId = `Ev_${Math.random().toString(36).slice(2)}`): NormalizedSlackTurn {
  return {
    workspaceId: 'T_TEST', channelId: 'C_TEST', eventId, text, userId: 'U_MEMBER',
    messageTs: '1785000000.000100', threadTs: '1785000000.000100',
    source: 'app_mention', contextMode: 'channel_history',
  };
}

function assertSavedReceipt(text: string | undefined, creator = 'U_MEMBER'): void {
  assert.match(text ?? '', /Next three:/);
  assert.match(text ?? '', new RegExp(`Creator: <@${creator}>`));
  assert.match(
    text ?? '',
    /This routine uses this channel's current Chickpea access each time it runs\./,
  );
  assert.match(text ?? '', /Resource limits:/);
  assert.match(text ?? '', /may perform writes when this saved task requests them/i);
  assert.match(text ?? '', /saved task is the approval for effects it explicitly requests/i);
  assert.doesNotMatch(text ?? '', /!routines confirm/);
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

test('natural-language creation persists in one message while deletion stays confirmed', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  const options = {
    store,
    capability: enabled,
    now: () => NOW,
    canManageChannel,
    parseIntent: async () => ({
      action: 'create' as const,
      name: 'Support steward',
      description: 'Triages support requests.',
      taskText: 'Triage new support requests and post a summary.',
      scheduleExpression: '0 9 * * 1-5',
      timezone: 'America/Los_Angeles',
      timezoneWasDefaulted: false,
      outputPolicy: 'post' as const,
    }),
  };
  try {
    const createdText = await handleRoutineSlackRequest(
      turn('Every weekday, Triage new support requests and post a summary.', 'Ev_create'),
      undefined,
      options,
    );
    assert.match(createdText ?? '', /was created and is \*active\*/);
    assertSavedReceipt(createdText);
    const replayText = await handleRoutineSlackRequest(
      turn('Every weekday, Triage new support requests and post a summary.', 'Ev_create'),
      undefined,
      options,
    );
    assert.equal(replayText, createdText);
    const [routine] = await store.listRoutines('T_TEST', 'C_TEST');
    assert.ok(routine);
    assert.equal((await store.listRoutines('T_TEST', 'C_TEST')).length, 1);
    assert.equal(routine.taskText, 'Triage new support requests and post a summary.');
    const [createdRevision] = await store.listRevisions(routine.id);
    assert.deepEqual(createdRevision?.provenance, {
      sourceKind: 'slack_request',
      requestText: 'Every weekday, Triage new support requests and post a summary.',
      requestHash: createdRevision?.provenance?.requestHash,
      eventId: 'Ev_create',
      messageTs: '1785000000.000100',
      threadTs: '1785000000.000100',
      sourceRoutineId: null,
      sourceRoutineVersion: null,
      authoritySource: 'current_request',
      definitionHash: createdRevision?.definitionHash,
    });

    const list = await handleRoutineSlackRequest(turn('!routines', 'Ev_list'), undefined, options);
    assert.match(list ?? '', new RegExp(routine.id));
    const detail = await handleRoutineSlackRequest(
      turn(`!routines show ${routine.id}`, 'Ev_show'), undefined, options,
    );
    assert.match(detail ?? '', /Source request: Every weekday, Triage new support requests and post a summary\./);
    const paused = await handleRoutineSlackRequest(
      turn(`!routines pause ${routine.id}`, 'Ev_pause'), undefined, options,
    );
    assert.match(paused ?? '', /now \*paused\*/);
    const runNow = await handleRoutineSlackRequest(
      turn(`!routines run ${routine.id}`, 'Ev_run'), undefined, options,
    );
    assert.match(runNow ?? '', /Queued one occurrence/);
    assert.equal((await store.listRuns({ routineId: routine.id })).length, 1);

    const clonedText = await handleRoutineSlackRequest(
      turn(`!routines clone ${routine.id}`, 'Ev_clone'), undefined, options,
    );
    assert.match(clonedText ?? '', /was created and is \*active\*/);
    assertSavedReceipt(clonedText);
    assert.equal((await store.listRoutines('T_TEST', 'C_TEST')).length, 2);
    const cloned = (await store.listRoutines('T_TEST', 'C_TEST')).find((item) => item.id !== routine.id);
    assert.ok(cloned);
    assert.equal(cloned.taskText, routine.taskText);
    assert.equal((await store.listRevisions(cloned.id))[0]?.provenance?.sourceKind, 'slack_clone');
    assert.equal((await store.listRevisions(cloned.id))[0]?.provenance?.sourceRoutineId, routine.id);

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
    assert.equal((await store.listRevisions(routine.id))[0]?.provenance?.requestText, null);
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
    canManageChannel,
  };
  try {
    const createdText = await handleRoutineSlackRequest(
      turn('Every weekday, Post the support summary.', 'Ev_timezone_create'),
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
    assert.match(createdText ?? '', /America\/New_York/);
    assert.match(createdText ?? '', /selected from your Slack profile/);
    assertSavedReceipt(createdText);
    const [created] = await store.listRoutines('T_TEST', 'C_TEST');
    assert.equal(created?.timezone, 'America/New_York');

    const editedText = await handleRoutineSlackRequest(
      turn('Edit the routine "Support summary" to run every weekday.', 'Ev_timezone_edit'),
      undefined,
      {
        ...base,
        resolveDefaultTimezone: async () => 'Europe/London',
        parseIntent: async () => ({
          action: 'edit' as const,
          routineName: 'Support summary',
          taskText: undefined,
          scheduleExpression: '0 9 * * 1-5',
          timezone: 'UTC',
          timezoneWasDefaulted: true,
        }),
      },
    );
    assert.match(editedText ?? '', /was updated/);
    assert.match(editedText ?? '', /America\/New_York/);
    assert.doesNotMatch(editedText ?? '', /Europe\/London/);
    assertSavedReceipt(editedText);
    assert.equal((await store.getRoutine(created!.id))?.taskText, 'Post the support summary.');
  } finally {
    store.close();
  }
});

test('the normalized task cannot add an effect absent from the source Slack request', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const result = await handleRoutineSlackRequest(
      turn('Every weekday, summarize the support queue.', 'Ev_source_bound'),
      undefined,
      {
        store,
        capability: enabled,
        now: () => NOW,
        canManageChannel,
        parseIntent: async () => ({
          action: 'create' as const,
          name: 'Unsafe normalization',
          taskText: 'Update the connected project tracker and post a summary.',
          scheduleExpression: '0 9 * * 1-5',
          timezone: 'UTC',
          timezoneWasDefaulted: false,
          outputPolicy: 'post' as const,
        }),
      },
    );
    assert.match(result ?? '', /exact part of the original Slack request/i);
    assert.equal((await store.listRoutines('T_TEST', 'C_TEST')).length, 0);
  } finally {
    store.close();
  }
});

test('the normalized task cannot redirect an approved effect to a different target', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const result = await handleRoutineSlackRequest(
      turn('Every weekday, update the connected project tracker.', 'Ev_source_target_bound'),
      undefined,
      {
        store,
        capability: enabled,
        now: () => NOW,
        canManageChannel,
        parseIntent: async () => ({
          action: 'create' as const,
          name: 'Unsafe target normalization',
          taskText: 'Update the billing account.',
          scheduleExpression: '0 9 * * 1-5',
          timezone: 'UTC',
          timezoneWasDefaulted: false,
          outputPolicy: 'post' as const,
        }),
      },
    );
    assert.match(result ?? '', /exact part of the original Slack request/i);
    assert.equal((await store.listRoutines('T_TEST', 'C_TEST')).length, 0);
  } finally {
    store.close();
  }
});

test('the task cannot extract a write from a negated source clause', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const result = await handleRoutineSlackRequest(
      turn('Every day, Do not delete PROJ-123; summarize the queue.', 'Ev_negated_delete'),
      undefined,
      {
        store,
        capability: enabled,
        now: () => NOW,
        canManageChannel,
        parseIntent: async () => ({
          action: 'create' as const,
          name: 'Unsafe deletion',
          taskText: 'delete PROJ-123',
          scheduleExpression: '0 9 * * *',
          timezone: 'UTC',
          timezoneWasDefaulted: false,
          outputPolicy: 'post' as const,
        }),
      },
    );
    assert.match(result ?? '', /cannot discard a negative directive/i);
    assert.equal((await store.listRoutines('T_TEST', 'C_TEST')).length, 0);
  } finally {
    store.close();
  }
});

test('the task cannot redirect concrete identifiers or append a new write', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  const attempts = [
    {
      text: 'Every weekday, Update PROJ-123.',
      taskText: 'Update PROJ-999.',
      eventId: 'Ev_project_redirect',
    },
    {
      text: 'Every weekday, Update repository alpha.',
      taskText: 'Update repository beta.',
      eventId: 'Ev_repo_redirect',
    },
    {
      text: 'Every weekday, Summarize the support queue.',
      taskText: 'Summarize the support queue and delete PROJ-123.',
      eventId: 'Ev_appended_write',
    },
  ];
  try {
    for (const attempt of attempts) {
      const result = await handleRoutineSlackRequest(turn(attempt.text, attempt.eventId), undefined, {
        store,
        capability: enabled,
        now: () => NOW,
        canManageChannel,
        parseIntent: async () => ({
          action: 'create' as const,
          name: attempt.eventId,
          taskText: attempt.taskText,
          scheduleExpression: '0 9 * * 1-5',
          timezone: 'UTC',
          timezoneWasDefaulted: false,
          outputPolicy: 'post' as const,
        }),
      });
      assert.match(result ?? '', /exact part of the original Slack request/i);
    }
    assert.equal((await store.listRoutines('T_TEST', 'C_TEST')).length, 0);
  } finally {
    store.close();
  }
});

test('an edit with omitted taskText inherits exactly the prior task', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const create = await handleRoutineSlackRequest(
      turn('Every weekday, Update PROJ-123.', 'Ev_inherit_create'),
      undefined,
      {
        store, capability: enabled, now: () => NOW, canManageChannel,
        parseIntent: async () => ({
          action: 'create' as const,
          name: 'Project updater',
          taskText: 'Update PROJ-123.',
          scheduleExpression: '0 9 * * 1-5',
          timezone: 'UTC',
          timezoneWasDefaulted: false,
          outputPolicy: 'post' as const,
        }),
      },
    );
    assert.match(create ?? '', /was created/);
    const [routine] = await store.listRoutines('T_TEST', 'C_TEST');
    assert.ok(routine);

    const edited = await handleRoutineSlackRequest(
      turn('Edit the routine "Project updater" to run hourly.', 'Ev_inherit_edit'),
      undefined,
      {
        store, capability: enabled, now: () => NOW, canManageChannel,
        parseIntent: async () => ({
          action: 'edit' as const,
          routineName: 'Project updater',
          scheduleExpression: '0 * * * *',
          timezone: 'UTC',
          timezoneWasDefaulted: false,
        }),
      },
    );
    assert.match(edited ?? '', /was updated/);
    const revisions = await store.listRevisions(routine!.id);
    assert.equal((await store.getRoutine(routine!.id))?.taskText, 'Update PROJ-123.');
    const editedRevision = revisions.find((revision) => revision.version === 2);
    assert.equal(editedRevision?.provenance?.authoritySource, 'previous_revision');
    assert.equal(editedRevision?.provenance?.sourceRoutineVersion, 1);
  } finally {
    store.close();
  }
});

test('one-time Slack requests save one future occurrence with an exact receipt', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const result = await handleRoutineSlackRequest(
      turn('Tomorrow at 9:30am, Post the launch report.', 'Ev_once_create'),
      undefined,
      {
        store,
        capability: enabled,
        now: () => NOW,
        canManageChannel,
        resolveDefaultTimezone: async () => 'America/Los_Angeles',
        parseIntent: async () => ({
          action: 'create' as const,
          triggerKind: 'once' as const,
          name: 'Launch report',
          taskText: 'Post the launch report.',
          scheduleExpression: '2026-07-28T09:30',
          timezone: 'America/Los_Angeles',
          timezoneWasDefaulted: true,
          outputPolicy: 'post' as const,
        }),
      },
    );
    assert.match(result ?? '', /Scheduled for:/);
    assert.doesNotMatch(result ?? '', /Next three:/);
    const [routine] = await store.listRoutines('T_TEST', 'C_TEST');
    assert.equal(routine?.triggerKind, 'once');
    assert.equal(routine?.projectedDailyStarts, 0);
    assert.equal(new Date(routine!.nextRunAt!).toISOString(), '2026-07-28T16:30:00.000Z');
    const runNow = await handleRoutineSlackRequest(
      turn(`!routines run ${routine!.id}`, 'Ev_once_run'),
      undefined,
      { store, capability: enabled, now: () => NOW, canManageChannel },
    );
    assert.match(runNow ?? '', /runs only at its scheduled time/i);
    const clone = await handleRoutineSlackRequest(
      turn(`!routines clone ${routine!.id}`, 'Ev_once_clone'),
      undefined,
      { store, capability: enabled, now: () => NOW, canManageChannel },
    );
    assert.match(clone ?? '', /new one-time job with a future time/i);
    assert.equal((await store.listRuns({ routineId: routine!.id })).length, 0);
  } finally {
    store.close();
  }
});

test('natural-language controls resolve an exact quoted name and stop on ambiguity', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  const create = async (eventId: string) => handleRoutineSlackRequest(
    turn('Every weekday, Post the support summary.', eventId),
    undefined,
    {
      store,
      capability: enabled,
      now: () => NOW,
      canManageChannel,
      parseIntent: async () => ({
        action: 'create' as const,
        name: 'Friday rollup',
        taskText: 'Post the support summary.',
        scheduleExpression: '0 9 * * 1-5',
        timezone: 'UTC',
        timezoneWasDefaulted: false,
        outputPolicy: 'post' as const,
      }),
    },
  );
  try {
    await create('Ev_name_one');
    const unique = await handleRoutineSlackRequest(
      turn('Pause the routine "Friday rollup".', 'Ev_name_pause'),
      undefined,
      {
        store, capability: enabled, now: () => NOW, canManageChannel,
        parseIntent: async () => ({ action: 'pause' as const, routineName: 'Friday rollup' }),
      },
    );
    assert.match(unique ?? '', /now \*paused\*/);

    await create('Ev_name_two');
    const ambiguous = await handleRoutineSlackRequest(
      turn('Disable the routine "Friday rollup".', 'Ev_name_ambiguous'),
      undefined,
      {
        store, capability: enabled, now: () => NOW, canManageChannel,
        parseIntent: async () => ({ action: 'disable' as const, routineName: 'Friday rollup' }),
      },
    );
    assert.match(ambiguous ?? '', /More than one routine is named/);
    assert.equal((await store.listRoutines('T_TEST', 'C_TEST')).filter((routine) => routine.state === 'disabled').length, 0);
  } finally {
    store.close();
  }
});

test('natural-language management rejects model actions not stated exactly once in Slack', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    await handleRoutineSlackRequest(
      turn('Every weekday, Post the daily report.', 'Ev_action_create'),
      undefined,
      {
        store, capability: enabled, now: () => NOW, canManageChannel,
        parseIntent: async () => ({
          action: 'create' as const,
          name: 'Daily report',
          taskText: 'Post the daily report.',
          scheduleExpression: '0 9 * * 1-5',
          timezone: 'UTC',
          timezoneWasDefaulted: false,
          outputPolicy: 'post' as const,
        }),
      },
    );
    const [routine] = await store.listRoutines('T_TEST', 'C_TEST');
    assert.ok(routine);
    const mismatches = [
      { text: 'Show the routine "Daily report".', action: 'run' as const, eventId: 'Ev_show_run' },
      { text: 'Pause the routine "Daily report".', action: 'disable' as const, eventId: 'Ev_pause_disable' },
      { text: 'Show and clone the routine "Daily report".', action: 'clone' as const, eventId: 'Ev_show_clone' },
    ];
    for (const mismatch of mismatches) {
      const result = await handleRoutineSlackRequest(turn(mismatch.text, mismatch.eventId), undefined, {
        store, capability: enabled, now: () => NOW, canManageChannel,
        parseIntent: async () => ({
          action: mismatch.action,
          routineName: 'Daily report',
        }),
      });
      assert.match(result ?? '', /does not unambiguously authorize that routine action/i);
    }
    assert.equal((await store.getRoutine(routine!.id))?.state, 'active');
    assert.equal((await store.listRuns({ routineId: routine!.id })).length, 0);
    assert.equal((await store.listRoutines('T_TEST', 'C_TEST')).length, 1);
  } finally {
    store.close();
  }
});

test('a model-selected name must be a whole literal name in the current message', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    await handleRoutineSlackRequest(
      turn('Every weekday, Post the port status.', 'Ev_name_anchor_create'),
      undefined,
      {
        store, capability: enabled, now: () => NOW, canManageChannel,
        parseIntent: async () => ({
          action: 'create' as const, name: 'Port', taskText: 'Post the port status.',
          scheduleExpression: '0 9 * * 1-5', timezone: 'UTC',
          timezoneWasDefaulted: false, outputPolicy: 'post' as const,
        }),
      },
    );
    const response = await handleRoutineSlackRequest(
      turn('Show the report routine.', 'Ev_name_anchor_show'),
      undefined,
      {
        store, capability: enabled, now: () => NOW, canManageChannel,
        parseIntent: async () => ({ action: 'show' as const, routineName: 'Port' }),
      },
    );
    assert.equal(response, 'That routine or channel was not found or is unavailable.');
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
      store, capability: unavailable, now: () => NOW, canManageChannel,
    });
    assert.match(text ?? '', /Cloudflare-only/);
    const missing = await handleRoutineSlackRequest(turn('!routines show routine_secret'), undefined, {
      store, capability: unavailable, now: () => NOW, canManageChannel,
    });
    assert.equal(missing, 'That routine or channel was not found or is unavailable.');
  } finally {
    store.close();
  }
});

test('routine saves and ID controls reauthorize current channel membership', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  let authorized = true;
  let parserCalls = 0;
  const options = {
    store,
    capability: enabled,
    now: () => NOW,
    canManageChannel: async () => authorized,
    parseIntent: async () => {
      parserCalls += 1;
      return {
        action: 'create' as const,
        name: 'Membership-bound routine',
        taskText: 'Post a current status summary.',
        scheduleExpression: '0 * * * *',
        timezone: 'UTC',
        timezoneWasDefaulted: false,
        outputPolicy: 'post' as const,
      };
    },
  };
  try {
    const created = await handleRoutineSlackRequest(
      turn('Every hour, Post a current status summary.', 'Ev_auth_create'),
      undefined,
      options,
    );
    assert.match(created ?? '', /was created/);
    const [routine] = await store.listRoutines('T_TEST', 'C_TEST');
    assert.ok(routine);

    authorized = false;
    const deniedCreate = await handleRoutineSlackRequest(
      turn('Every hour, Post another status summary.', 'Ev_auth_denied'),
      undefined,
      options,
    );
    assert.equal(deniedCreate, 'That routine or channel was not found or is unavailable.');
    assert.equal(parserCalls, 1);
    assert.equal((await store.listRoutines('T_TEST', 'C_TEST')).length, 1);

    const deniedShow = await handleRoutineSlackRequest(
      turn(`!routines show ${routine.id}`, 'Ev_auth_show'),
      undefined,
      options,
    );
    assert.equal(deniedShow, 'That routine or channel was not found or is unavailable.');
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
        canManageChannel,
        parseIntent: async () => { throw new Error('intent service unavailable'); },
      },
    );
    assert.equal(result, undefined);
  } finally {
    store.close();
  }
});
