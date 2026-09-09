import assert from 'node:assert/strict';
import test from 'node:test';
import { invokeSlackScheduleAction } from '../src/management/slack-schedule-actions.ts';

const taskText = 'reply exactly "DUE PRIVATE FIXTURE" in this thread';
const request = 'Private scheduling verification. Create a private one-time follow-up named "Private follow-up" in this DM thread, due September 5, 2026 at 15:49 UTC. At that time reply exactly "DUE PRIVATE FIXTURE" in this thread. Do not run it now, do not use connectors, and do not post anywhere else. Acknowledge the saved due time.';

async function reachesReservation(text: string, date = '2026-09-05T15:49', selectedTask = taskText) {
  let reserved = false;
  const sentinel = new Error('authority validated; stop before reservation');
  try {
    await invokeSlackScheduleAction({
      signal: { agentId: 'agent_fixture', workspaceId: 'T_FIXTURE', channelId: 'D_FIXTURE',
        conversationKind: 'im', threadTs: '1788623000.000001', messageTs: '1788623000.000001',
        slackUserId: 'U_FIXTURE', eventId: 'Ev_fixture', turnJobId: 'turn_fixture', requesterText: text },
      context: { organizationId: 'org_fixture', userId: 'user_fixture', membershipId: 'member_fixture',
        origin: { kind: 'slack', workspaceId: 'T_FIXTURE', channelId: 'D_FIXTURE', conversationKind: 'im',
          slackUserId: 'U_FIXTURE', threadTs: '1788623000.000001', messageTs: '1788623000.000001' } } as never,
      operation: { itemId: 'fixture', kind: 'save_routine', agentId: 'agent_fixture', workspaceId: 'T_FIXTURE',
        destination: { kind: 'current_dm_thread' }, name: 'Private follow-up', description: '',
        taskText: selectedTask, schedule: { kind: 'once', localDateTime: date }, timezone: 'UTC', outputPolicy: 'post' },
      dependencies: { now: () => Date.UTC(2026, 8, 5, 15, 43, 56), routines: {},
        management: { reserveRequest: async () => { reserved = true; throw sentinel; } } } as never,
    });
  } catch (error) {
    if (error !== sentinel) {
      assert.equal((error as { code?: string }).code, 'invalid_request');
      assert.equal(reserved, false);
      return false;
    }
  }
  return reserved;
}

test('interpreted one-shot task reaches reservation without requiring source wording', async () => {
  assert.equal(await reachesReservation(request), true);
  assert.equal(await reachesReservation(request, undefined, 'Reply exactly "DUE PRIVATE FIXTURE" privately without using connectors.'), true);
});
