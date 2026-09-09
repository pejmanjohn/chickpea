import assert from 'node:assert/strict';
import test from 'node:test';
import { invokeSlackScheduleAction } from '../src/management/slack-schedule-actions.ts';

const base = { kind: 'save_routine', itemId: 'schedule', agentId: 'agent_test', workspaceId: 'T_TEST', destination: { kind: 'current_dm_thread' }, name: 'TOEFL update', description: 'Bookings update', taskText: 'Report current TOEFL bookings using SQL Dash.', schedule: { kind: 'in', minutes: 5 }, timezone: 'UTC', outputPolicy: 'post' };
const previous = { id: 'routine_test', workspaceId: 'T_TEST', channelId: 'D_TEST', destination: { kind: 'direct_thread' }, deletedAt: null, name: 'Original', description: 'Original description', taskText: 'Report TOEFL bookings using SQL Dash.', timezone: 'America/Los_Angeles', outputPolicy: 'post_on_change', triggerKind: 'schedule', scheduleInput: '0 9 * * 1-5', version: 2 };
async function admitted(requesterText: string, patch: Record<string, unknown> = {}, timezone?: string, stored: unknown = previous) {
  let captured: any;
  const stop = new Error('before reservation');
  const signal = { agentId: 'agent_test', workspaceId: 'T_TEST', channelId: 'D_TEST', threadTs: '1788987692.474889', conversationKind: 'im', slackUserId: 'U_TEST', eventId: 'Ev_test', messageTs: '1788988012.030979', turnJobId: 'turn_test', requesterText, requesterTimezone: timezone };
  // Only the real pre-admission path runs. Persistence is verified separately with stores.
  const input: any = { signal, operation: { ...base, ...patch }, context: { organizationId: 'org_test', userId: 'user_test', membershipId: 'member_test', origin: { kind: 'slack', ...signal } }, dependencies: { now: () => Date.UTC(2030, 5, 10), routines: { getRoutine: async () => stored, listRevisions: async () => [{ version: 2, definition: previous }], listRoutines: async () => [stored] }, management: { reserveRequest: async (request: any) => { captured = request.operations[0]; throw stop; } } } };
  try { await invokeSlackScheduleAction(input); } catch (error) { if (error !== stop) throw error; }
  assert.ok(captured);
  return captured;
}

test('ordinary and contextual requests admit self-contained interpreted tasks', async () => {
  for (const text of ['give me an update on TOEFL bookings in 5 minutes', 'do that again in five minutes', 'can you give me an update on TOEFL bookings in 5 minutes?']) {
    assert.equal((await admitted(text)).taskText, base.taskText);
  }
});
test('partial edits preserve untouched fields and explicit output changes apply', async () => {
  const patch = { routineId: 'routine_test', expectedVersion: 2, name: undefined, description: undefined, taskText: undefined, timezone: undefined, outputPolicy: undefined };
  const result = await admitted('make it every ten minutes', { ...patch, schedule: { kind: 'cron', expression: '*/10 * * * *' } });
  for (const key of ['name', 'description', 'taskText', 'timezone', 'outputPolicy'] as const) assert.equal(result[key], previous[key]);
  const taskOnly = await admitted('include refunds too', { ...patch, schedule: undefined, taskText: 'Report TOEFL bookings and refunds using SQL Dash.', outputPolicy: 'post' });
  assert.deepEqual(taskOnly.schedule, { kind: 'cron', expression: previous.scheduleInput });
  assert.equal(taskOnly.outputPolicy, 'post');
});
test('timezone defaults use host profile and relative delays need no wall-clock zone', async () => {
  assert.equal((await admitted('in five minutes', { timezone: undefined }, 'America/Los_Angeles')).timezone, 'America/Los_Angeles');
  assert.equal((await admitted('in five minutes', { timezone: undefined })).timezone, 'UTC');
  for (const zone of [undefined, 'invalid-zone']) await assert.rejects(admitted('tomorrow morning', { timezone: undefined, schedule: { kind: 'cron', expression: '0 9 * * *' } }, zone), /timezone.*required/i);
});
test('existing schedule operations reject cross-scope IDs and allow contextual controls', async () => {
  const control = { kind: 'control_routine', routineId: 'routine_test', expectedVersion: 2, action: 'pause' };
  assert.equal((await admitted('pause it', control)).action, 'pause');
  for (const patch of [control, { routineId: 'routine_test', expectedVersion: 2 }]) {
    await assert.rejects(admitted('change it', patch, undefined, { ...previous, channelId: 'D_OTHER' }), /not found/);
    await assert.rejects(admitted('change it', patch, undefined, { ...previous, workspaceId: 'T_OTHER' }), /not found/);
  }
});

test('partial edit replay resolves omitted fields from the expected revision', async () => {
  const patch = { routineId: 'routine_test', expectedVersion: 2, name: undefined, description: undefined, taskText: undefined, timezone: undefined, outputPolicy: undefined, schedule: { kind: 'cron', expression: '*/10 * * * *' } };
  const original = await admitted('make it every ten minutes', patch);
  const replay = await admitted('make it every ten minutes', patch, undefined, { ...previous, version: 4, name: 'Changed later', outputPolicy: 'post', taskText: 'Different later task.' });
  assert.deepEqual(replay, original);
});

test('missing control IDs and unavailable expected revisions produce fixed validation errors', async () => {
  await assert.rejects(admitted('pause it', { kind: 'control_routine', routineId: undefined, expectedVersion: 2, action: 'pause' }), /not found/);
  await assert.rejects(admitted('change it', { routineId: 'routine_test', expectedVersion: 99, taskText: undefined }), /Inspect it again/);
});
