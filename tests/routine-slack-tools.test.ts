import assert from 'node:assert/strict';
import { formatRoutineLocalDateTime, routineNextRunTime } from '../src/routines/message-format.ts';
import test from 'node:test';

import {
  scheduleActionToolResult,
  scheduleToolOperation,
  type SlackManagementSignal,
} from '../src/management/slack-tools.ts';

const signal: SlackManagementSignal = {
  agentId: 'agent_sprout_tool',
  workspaceId: 'T_SLACK_TOOL',
  channelId: 'D_SLACK_TOOL',
  conversationKind: 'im',
  threadTs: '1787883924.314659',
  slackUserId: 'U_SLACK_TOOL',
  eventId: 'Ev_SLACK_TOOL',
  messageTs: '1787883925.000100',
  turnJobId: 'turn_SLACK_TOOL',
};

test('natural five-minute follow-up arguments become fresh private thread work', () => {
  assert.deepEqual(scheduleToolOperation(signal, {
    action: 'create',
    name: 'Inbox follow-up',
    description: 'Check the inbox again after five minutes.',
    taskText: 'Check this again in 5 minutes and tell me anything new.',
    scheduleKind: 'in',
    minutes: 5,
    timezone: 'America/Los_Angeles',
    outputPolicy: 'post_on_change',
  }), {
    itemId: 'schedule',
    kind: 'save_routine',
    agentId: signal.agentId,
    workspaceId: signal.workspaceId,
    destination: { kind: 'current_dm_thread' },
    name: 'Inbox follow-up',
    description: 'Check the inbox again after five minutes.',
    taskText: 'Check this again in 5 minutes and tell me anything new.',
    schedule: { kind: 'in', minutes: 5 },
    timezone: 'America/Los_Angeles',
    outputPolicy: 'post_on_change',
  });
});

test('recurring and run-now arguments use the same first-class schedule action', () => {
  const channelSignal = {
    ...signal,
    channelId: 'C_SLACK_TOOL',
    conversationKind: 'channel' as const,
  };
  assert.deepEqual(scheduleToolOperation(channelSignal, {
    action: 'create',
    name: 'Daily inbox check',
    description: 'Check each morning.',
    taskText: 'Report new inbox items.',
    scheduleKind: 'cron',
    cronExpression: '0 9 * * *',
    timezone: 'America/Los_Angeles',
    outputPolicy: 'post',
  }), {
    itemId: 'schedule',
    kind: 'save_routine',
    agentId: signal.agentId,
    workspaceId: signal.workspaceId,
    channelId: channelSignal.channelId,
    name: 'Daily inbox check',
    description: 'Check each morning.',
    taskText: 'Report new inbox items.',
    schedule: { kind: 'cron', expression: '0 9 * * *' },
    timezone: 'America/Los_Angeles',
    outputPolicy: 'post',
  });
  assert.deepEqual(scheduleToolOperation(signal, {
    action: 'run',
    routineId: 'routine_slack_tool',
  }), {
    itemId: 'schedule',
    kind: 'run_routine',
    workspaceId: signal.workspaceId,
    routineId: 'routine_slack_tool',
  });
});

test('schedule tools provide host-formatted UTC and local due times without model arithmetic', () => {
  const instant = 1788596100000;
  assert.deepEqual(routineNextRunTime(instant, 'UTC'), {
    isoUtc: '2026-09-05T08:15:00.000Z', local: '2026-09-05 08:15:00 UTC',
    display: 'Sep 5, 2026, 8:15 AM UTC', timezone: 'UTC',
  });
  assert.equal(routineNextRunTime(instant, 'America/Los_Angeles')?.local,
    '2026-09-05 01:15:00 America/Los_Angeles');
  assert.equal(routineNextRunTime(Date.UTC(2026, 8, 5), 'UTC')?.local, '2026-09-05 00:00:00 UTC');
  assert.equal(routineNextRunTime(null, 'UTC'), null);
  const nextRunTime = routineNextRunTime(instant, 'UTC');
  const result = scheduleActionToolResult({ outcome: 'applied', effect: 'saved', routineId: 'routine_time', nextRunTime });
  assert.deepEqual(result.nextRunTime, nextRunTime);
  assert.match(String(result.timeInstruction), /Use nextRunTime.display/);
  assert.match(String(result.timeInstruction), /machine-readable timestamp is requested or required/);
  assert.match(String(result.timeInstruction), /copy nextRunTime.isoUtc exactly in code formatting/);
  assert.match(String(result.timeInstruction), /Do not append an IANA timezone identifier/);
});

test('friendly due times preserve calendar dates, DST offsets, and half-hour zones', () => {
  const cases = [
    ['2026-09-10T04:54:00Z', 'America/Los_Angeles', 'Sep 9, 2026, 9:54 PM PDT'],
    ['2026-03-08T09:30:00Z', 'America/Los_Angeles', 'Mar 8, 2026, 1:30 AM PST'],
    ['2026-03-08T10:30:00Z', 'America/Los_Angeles', 'Mar 8, 2026, 3:30 AM PDT'],
    ['2026-11-01T08:30:00Z', 'America/Los_Angeles', 'Nov 1, 2026, 1:30 AM PDT'],
    ['2026-11-01T09:30:00Z', 'America/Los_Angeles', 'Nov 1, 2026, 1:30 AM PST'],
    ['2026-09-09T20:00:00Z', 'Asia/Kolkata', 'Sep 10, 2026, 1:30 AM GMT+5:30'],
  ];
  for (const [iso, zone, expected] of cases) {
    const result = routineNextRunTime(Date.parse(iso!), zone!);
    assert.equal(result?.display, expected);
    assert.equal(result?.isoUtc, new Date(iso!).toISOString());
  }
});

test('one-time preview displays the original wall clock without converting its timezone', () => {
  assert.equal(formatRoutineLocalDateTime('2026-09-09T21:54'), 'Sep 9, 2026, 9:54 PM');
  assert.equal(formatRoutineLocalDateTime('2027-01-01T00:00'), 'Jan 1, 2027, 12:00 AM');
  for (const input of ['2026-09-09T21:54:30', '2026-02-30T10:00', '2026-09-09T24:00', '2026-09-09']) {
    assert.equal(formatRoutineLocalDateTime(input), input, 'unvalidated input must remain visible');
  }
});

test('an applied action in a non-active safe state says it will not run', () => {
  assert.deepEqual(scheduleActionToolResult({
    outcome: 'applied',
    effect: 'saved',
    routineId: 'routine_active_tool',
    routineVersion: 1,
    safeState: 'active',
  }), {
    outcome: 'applied',
    effect: 'saved',
    routineId: 'routine_active_tool',
    routineVersion: 1,
    instruction: 'The action is complete. Do not ask for approval or invoke another scheduling tool. In a DM, the requesting message receives a checkmark reaction; in a Channel, acknowledge the result in your reply. Restate the saved task in one sentence and quote the next run time.',
  });
  assert.deepEqual(scheduleActionToolResult({
    outcome: 'applied',
    effect: 'saved',
    routineId: 'routine_paused_tool',
    routineVersion: 2,
    safeState: 'paused',
  }), {
    outcome: 'applied',
    effect: 'saved',
    routineId: 'routine_paused_tool',
    routineVersion: 2,
    safeState: 'paused',
    instruction: 'The action is complete, but the scheduled work is paused and will not run. Do not ask for approval or invoke another scheduling tool. In a DM, the requesting message receives a checkmark reaction; in a Channel, explicitly state this non-active result in your reply.',
  });
});

test('saved Channel acknowledgements identify the actual delivery destination', () => {
  for (const [deliveryDestination, expected] of [
    ['channel', /new messages in this channel/],
    ['channel_thread', /saved request thread/],
  ] as const) {
    const result = scheduleActionToolResult({
      outcome: 'applied', effect: 'saved', routineId: 'routine_destination', deliveryDestination,
    });
    assert.equal(result.deliveryDestination, deliveryDestination);
    assert.match(String(result.instruction), expected);
  }
});

test('create accepts omitted nonessential description and partial edit leaves fields unset', () => {
  const signal = { agentId: 'agent_test', workspaceId: 'T_TEST', channelId: 'D_TEST', conversationKind: 'im' } as const;
  const created = scheduleToolOperation(signal as never, { action: 'create', name: 'TOEFL update', taskText: 'Report TOEFL bookings using SQL Dash.', scheduleKind: 'in', minutes: 5 });
  assert.ok(created.kind === 'save_routine');
  assert.equal(created.description, '');
  const edited = scheduleToolOperation(signal as never, { action: 'edit', routineId: 'routine_test', expectedVersion: 2, minutes: 10, scheduleKind: 'in' });
  assert.ok(edited.kind === 'save_routine');
  assert.equal(edited.taskText, undefined);
  assert.equal(edited.outputPolicy, undefined);
});

test('schedule tools carry explicit account choices and preserve omission on metadata edits', () => {
  const created = scheduleToolOperation(signal, { action: 'create', name: 'Report', taskText: 'Read Work inbox.',
    scheduleKind: 'in', minutes: 5, requiredConnectionAccountIds: ['connection_work'] });
  assert.ok(created.kind === 'save_routine');
  assert.deepEqual(created.requiredConnectionAccountIds, ['connection_work']);
  const empty = scheduleToolOperation(signal, { action: 'create', name: 'Reminder', taskText: 'Remind me to stretch.',
    scheduleKind: 'in', minutes: 5, requiredConnectionAccountIds: [] });
  assert.ok(empty.kind === 'save_routine');
  assert.deepEqual(empty.requiredConnectionAccountIds, []);
  const renamed = scheduleToolOperation(signal, { action: 'edit', routineId: 'routine_test', expectedVersion: 1, name: 'Renamed' });
  assert.ok(renamed.kind === 'save_routine');
  assert.equal(renamed.requiredConnectionAccountIds, undefined);
});
