import assert from 'node:assert/strict';
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
    instruction: 'The action is complete. Do not ask for approval or invoke another scheduling tool. In a DM, the requesting message receives a checkmark reaction; in a Channel, acknowledge the result in your reply.',
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
