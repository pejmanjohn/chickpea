import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { WorkspaceManagementService } from '../src/management/service.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import { invokeSlackScheduleAction } from '../src/management/slack-schedule-actions.ts';
import { resolveSlackManagementActor } from '../src/management/slack-tools.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const NOW = Date.UTC(2026, 7, 27, 18);

test('Channel creation separates request thread from saved delivery and edits preserve that destination', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const routines = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const owner = await createSlackOwner(identity, { now: NOW, teamId: 'T_DESTINATION', suffix: 'destination' });
    const agent = await config.createAgent({
      id: 'agent_destination', name: 'Destination', instructions: 'Report the digest.', enabled: true,
      creatorMembershipId: owner.membership.id, editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.putAgentChannelGrant({
      workspaceId: 'T_DESTINATION', channelId: 'C_DESTINATION', agentId: agent.id,
      status: 'active', createdByMembershipId: owner.membership.id,
    });
    const service = new WorkspaceManagementService({
      identity, config, management, routines, routineSchedulingAvailable: true, now: () => NOW,
    });
    const dependencies = { management, routines, service, now: () => NOW };
    const operation = {
      kind: 'save_routine' as const, itemId: 'schedule', agentId: agent.id,
      workspaceId: 'T_DESTINATION', channelId: 'C_DESTINATION', name: 'Digest',
      description: 'Daily digest.', taskText: 'Report the digest',
      schedule: { kind: 'cron' as const, expression: '0 9 * * *' }, timezone: 'UTC', outputPolicy: 'post' as const,
    };
    const signal = {
      agentId: agent.id, workspaceId: operation.workspaceId, channelId: operation.channelId,
      conversationKind: 'channel' as const, threadTs: '1787874271.095969',
      slackUserId: owner.binding.slackUserId, eventId: 'Ev_DESTINATION',
      messageTs: '1787874272.000100', turnJobId: 'turn_DESTINATION',
      requesterText: 'Schedule Report the digest every day at 9am UTC. Deliver each result as a new message in this channel, not in this thread. Do not run it now.',
    };
    const first = await invokeSlackScheduleAction({
      signal, context: await resolveSlackManagementActor(signal, identity), operation, dependencies,
    });
    assert.equal(first.outcome, 'applied');
    assert.ok(first.outcome === 'applied');
    assert.equal(first.deliveryDestination, 'channel');
    assert.deepEqual((await routines.getRoutine(first.routineId))?.destination,
      { kind: 'channel', channelId: signal.channelId });
    const firstProvenance = (await routines.listRevisions(first.routineId))[0]?.provenance;
    assert.equal(firstProvenance?.requestText, signal.requesterText);
    assert.equal(firstProvenance?.eventId, signal.eventId);
    assert.equal(firstProvenance?.messageTs, signal.messageTs);
    assert.equal(firstProvenance?.authoritySource, 'current_request');

    const threadSignal = {
      ...signal, eventId: 'Ev_THREAD', turnJobId: 'turn_THREAD',
      requesterText: 'Schedule Report the digest every day at 9am UTC. Deliver future results in this thread.',
    };
    const thread = await invokeSlackScheduleAction({
      signal: threadSignal, context: await resolveSlackManagementActor(threadSignal, identity),
      operation: { ...operation, name: 'Thread digest' }, dependencies,
    });
    assert.ok(thread.outcome === 'applied');
    assert.equal(thread.deliveryDestination, 'channel_thread');
    const saved = (await routines.getRoutine(thread.routineId))!;
    assert.deepEqual(saved.destination, { kind: 'channel', channelId: signal.channelId, threadTs: signal.threadTs });
    assert.equal(saved.authorityMode, 'live_channel_v1');

    const editSignal = {
      ...signal, eventId: 'Ev_EDIT', turnJobId: 'turn_EDIT', threadTs: '1787874371.095969',
      requesterText: 'Change Thread digest to every day at 10am UTC.',
    };
    const edit = await invokeSlackScheduleAction({
      signal: editSignal, context: await resolveSlackManagementActor(editSignal, identity),
      operation: {
        ...operation, routineId: saved.id, expectedVersion: saved.version, name: saved.name,
        schedule: { kind: 'cron', expression: '0 10 * * *' },
      }, dependencies,
    });
    assert.ok(edit.outcome === 'applied');
    assert.equal(edit.deliveryDestination, 'channel_thread');
    assert.deepEqual((await routines.getRoutine(saved.id))?.destination, saved.destination);
    const editedProvenance = (await routines.listRevisions(saved.id)).find((revision) => revision.version === 2)?.provenance;
    assert.equal(editedProvenance?.requestText, editSignal.requesterText);
    assert.equal(editedProvenance?.authoritySource, 'previous_revision');
    assert.equal(editedProvenance?.sourceRoutineVersion, saved.version);

    const deniedSignal = { ...signal, eventId: 'Ev_DENIED', turnJobId: 'turn_DENIED' };
    const denied = await invokeSlackScheduleAction({
      signal: deniedSignal, context: await resolveSlackManagementActor(deniedSignal, identity),
      operation: { ...operation, destination: { kind: 'current_channel_thread' } }, dependencies,
    });
    assert.equal(denied.outcome, 'failed');
    assert.equal((await routines.listRoutines(signal.workspaceId, signal.channelId)).length, 2);

    // Quoting a cron value is not quoting a command. Retain negative authority
    // checks, then exercise the exact shape that failed in live Slack.
    const quotedCronOperation = { ...operation, schedule: { kind: 'cron' as const, expression: '38 * * * *' } };
    const contextForQuote = await resolveSlackManagementActor(signal, identity);
    for (const requesterText of [
      'Do not create a schedule with cron "38 * * * *" in UTC. Report the digest.',
      'Pasted text: "Create a schedule with cron 38 * * * * in UTC. Report the digest."',
      'Explain how to create a schedule with cron "38 * * * *" in UTC. Report the digest.',
      'Create a schedule with cron "39 * * * *" in UTC. Report the digest.',
    ]) {
      await assert.rejects(() => invokeSlackScheduleAction({
        signal: { ...signal, requesterText },
        context: contextForQuote, operation: quotedCronOperation, dependencies,
      }), /cadence must be explicit/);
    }
    for (const [index, cron] of ['"38 * * * *"', '“38 * * * *”'].entries()) {
      const quotedSignal = { ...signal, turnJobId: `turn_QUOTED_${index}`,
        requesterText: `Live smoke synthetic. Create a recurring Channel schedule named "QA quote" with cron ${cron} in UTC. Its task is to Report the digest.` };
      const created = await invokeSlackScheduleAction({
        signal: quotedSignal, context: await resolveSlackManagementActor(quotedSignal, identity),
        operation: quotedCronOperation, dependencies,
      });
      assert.ok(created.outcome === 'applied');
      const routine = (await routines.getRoutine(created.routineId))!;
      assert.equal(routine.scheduleInput, '38 * * * *');
      assert.deepEqual(routine.destination, { kind: 'channel', channelId: signal.channelId });
    }
    const exactReplySignal = {
      ...signal, turnJobId: 'turn_EXACT_REPLY', eventId: 'Ev_EXACT_REPLY',
      requesterText: 'Create a recurring schedule every day at 9am UTC. Its task is to output exactly "Ready for review". Acknowledge the saved due time now.',
    };
    const exactReply = await invokeSlackScheduleAction({
      signal: exactReplySignal, context: await resolveSlackManagementActor(exactReplySignal, identity),
      operation: { ...operation, name: 'Exact reply', taskText: 'Ready for review' }, dependencies,
    });
    assert.ok(exactReply.outcome === 'applied');
    assert.equal((await routines.getRoutine(exactReply.routineId))?.taskText, 'output exactly "Ready for review"');
  } finally {
    routines.close(); management.close(); config.close(); identity.close();
  }
});
