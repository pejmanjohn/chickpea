import assert from 'node:assert/strict';
import test from 'node:test';
import { scheduleActionRpcResult } from '../src/management/slack-schedule-rpc.ts';
import { ManagementError } from '../src/management/types.ts';
import {
  invokeCloudflareSlackScheduleAction,
  scheduleActionToolResult,
  throwCorrectableScheduleRefusal,
} from '../src/management/slack-tools.ts';

test('RPC preserves fixed request validation guidance without transport retry', async () => {
  let attempts = 0;
  const message = 'The scheduled work was not found.';
  const result = await invokeCloudflareSlackScheduleAction({
    stub: { slackScheduleActionInvoke: async () => {
      attempts++;
      return scheduleActionRpcResult(async () => { throw new ManagementError('invalid_request', message); });
    } }, signal: {} as never, operation: {} as never,
  });
  assert.equal(attempts, 1);
  assert.deepEqual(result, { outcome: 'failed', code: 'invalid_request', message });
  assert.equal(scheduleActionToolResult(result).message, message);
});

test('transport exceptions still retry while unknown exception text never becomes tool guidance', async () => {
  let attempts = 0;
  const result = await invokeCloudflareSlackScheduleAction({
    stub: { slackScheduleActionInvoke: async () => {
      attempts++;
      return scheduleActionRpcResult(async () => {
        if (attempts === 1) throw new Error('connection interrupted');
        return { outcome: 'pending', actionId: 'action_test' };
      });
    } }, signal: {} as never, operation: {} as never,
  });
  assert.equal(attempts, 2);
  assert.equal(result.outcome, 'pending');
  const privateError = new ManagementError('invalid_request', 'private request or credential body');
  await assert.rejects(scheduleActionRpcResult(async () => { throw privateError; }), e => e === privateError);
  await assert.rejects(scheduleActionRpcResult(async () => { throw new Error('The scheduled work was not found.'); }));
});

test('real pre-admission schedule validation returns before any state reservation', async () => {
  const { invokeSlackScheduleAction } = await import('../src/management/slack-schedule-actions.ts');
  const result = await scheduleActionRpcResult(() => invokeSlackScheduleAction({
    signal: { workspaceId: 'T_ALLOWED', conversationKind: 'channel' } as never,
    operation: { workspaceId: 'T_OTHER', kind: 'save_routine' } as never,
    context: {} as never,
    // No stores exist: validation must complete before any reservation or mutation.
    dependencies: {} as never,
  }));
  assert.deepEqual(result, { outcome: 'failed', code: 'invalid_request', message: 'The schedule workspace must match this conversation.' });
});

test('unavailable revision guidance crosses RPC without a transport retry', async () => {
  const message = 'The scheduled work changed. Inspect it again before editing.';
  assert.deepEqual(await scheduleActionRpcResult(async () => { throw new ManagementError('invalid_request', message); }), { outcome: 'failed', code: 'invalid_request', message });
});

test('an edit that changes the task without its connection choice is refused before anything is recorded', async () => {
  const { invokeSlackScheduleAction } = await import('../src/management/slack-schedule-actions.ts');
  const { ROUTINE_CONNECTIONS_REQUIRED_MESSAGE } = await import('../src/routines/slack-command.ts');
  const current = { id: 'routine_tip', version: 2, deletedAt: null, workspaceId: 'T_TIP', channelId: 'C_TIP',
    destination: { kind: 'channel' }, taskText: 'Post one cooking tip.', name: 'Weekly tip', description: '',
    timezone: 'UTC', triggerKind: 'schedule', scheduleInput: '0 9 * * 1', outputPolicy: 'post' };
  let reserved = 0;
  const reached = new Error('reached-reservation');
  const signal = { agentId: 'agent_tip', workspaceId: 'T_TIP', channelId: 'C_TIP', conversationKind: 'channel',
    threadTs: '1.1', requesterText: 'make it a baking tip', turnJobId: 'turn_tip' };
  const edit = (fields: Record<string, unknown>) => scheduleActionRpcResult(() => invokeSlackScheduleAction({
    signal: signal as never,
    operation: { kind: 'save_routine', itemId: 'schedule', agentId: 'agent_tip', workspaceId: 'T_TIP',
      channelId: 'C_TIP', routineId: current.id, ...fields } as never,
    context: { origin: { kind: 'slack', ...signal } } as never,
    dependencies: {
      routines: { getRoutine: async () => current,
        listRevisions: async () => [{ version: 1, definition: { ...current, taskText: 'Post one tip.' } }] },
      management: { reserveRequest: async () => { reserved++; throw reached; } },
    } as never,
  }));
  const refused = await edit({ expectedVersion: 2, taskText: 'Post one baking tip.' });
  assert.deepEqual(refused, { outcome: 'failed', code: 'invalid_request', message: ROUTINE_CONNECTIONS_REQUIRED_MESSAGE });
  assert.equal(reserved, 0);
  // The tool raises it like the create pre-check, so the Agent corrects the call.
  assert.throws(() => throwCorrectableScheduleRefusal(refused), (error) => error instanceof ManagementError &&
    error.code === 'invalid_request' && error.message === ROUTINE_CONNECTIONS_REQUIRED_MESSAGE);
  throwCorrectableScheduleRefusal({ outcome: 'failed', code: 'routine_connections_required' });
  // The save decides the rest: an unchanged task, a declared choice, or a stale version.
  for (const fields of [
    { expectedVersion: 2, taskText: '  Post one   cooking tip. ' },
    { expectedVersion: 2, taskText: 'Post one baking tip.', requiredConnectionAccountIds: [] },
    { expectedVersion: 2, name: 'Renamed tip' },
    { expectedVersion: 1, taskText: 'Post one baking tip.' },
  ]) await assert.rejects(edit(fields), (error) => error === reached);
  assert.equal(reserved, 4);
});
