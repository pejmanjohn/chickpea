import assert from 'node:assert/strict';
import test from 'node:test';
import { scheduleActionRpcResult } from '../src/management/slack-schedule-rpc.ts';
import { ManagementError } from '../src/management/types.ts';
import { invokeCloudflareSlackScheduleAction, scheduleActionToolResult } from '../src/management/slack-tools.ts';

test('RPC preserves fixed request validation guidance without transport retry', async () => {
  let attempts = 0;
  const message = 'The schedule cadence must be explicit in the current Slack request.';
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
  await assert.rejects(scheduleActionRpcResult(async () => { throw new Error('The schedule cadence must be explicit in the current Slack request.'); }));
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
