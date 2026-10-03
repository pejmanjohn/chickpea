import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { installationOwnershipOf, scopedObjectName } from '../src/config/installation-scope.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { REFUSED_SKIP } from '../src/routines/execution.ts';
import { hashRoutineValue } from '../src/routines/ids.ts';
import type { RoutineConfirmationDraft } from '../src/routines/types.ts';
import { CHICKPEA_SLACK_AGENT_BINDING } from '../src/slack/bounded-agent-observation.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { TURN_JOB_TTL_MS, TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import {
  cancelInstallationObjectPendingWork,
  installationStateStoreObject,
} from '../src/state/installation-objects.ts';
import { stopCancelledAgents, type AgentStopTarget } from '../src/state/pending-work.ts';
import { promisify } from '../src/state/async-facade.ts';
import { RoutineUsageRecorder } from '../src/usage/runtime-recorder.ts';
import { opaqueId } from '../src/work/admission.ts';
import {
  hostedDeployment,
  hostedInstallation,
  runnerJobs,
  type HostedInstallation,
} from './helpers/installation-objects.ts';

/**
 * After restoring an installation's objects to an earlier moment, the host
 * stops the work they would start or deliver on their own, so resuming the
 * installation never answers a message twice or posts a stale result.
 */

const UID = 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAV';

function job(id: string, team: string, messageTs: string): TurnJob {
  const assignment: ResolvedAssignment = {
    workspaceId: team, channelId: 'C_PENDING', agentId: 'agent_pending', model: 'local-stub/pending',
    runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
    agent: {
      id: 'agent_pending', kind: 'user', revision: 1, name: 'Pending', instructions: 'Help.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    },
  };
  return {
    id, evtKey: `evt:${id}`, msgKey: `msg:${id}`, assignment,
    turn: {
      workspaceId: team, channelId: 'C_PENDING', eventId: `Ev_${id}`, text: `Question ${id}`,
      userId: 'U_MEMBER', messageTs, threadTs: messageTs, source: 'app_mention',
      contextMode: 'thread', channelType: 'channel',
    },
  };
}

/** A delivered turn, a queued one, and one dispatched to Flue and still running. */
function turns(installation: HostedInstallation, team: string) {
  const { stores, env } = installation;
  const [delivered, queued, running] = ['1800000000.000100', '1800000000.000200', '1800000000.000300']
    .map((messageTs, index) => job(`tj_${team}_${index}`, team, messageTs));
  for (const turn of [delivered!, queued!, running!]) stores.turnJobs.enqueue(turn);
  stores.turnJobs.markDelivered(delivered!.id);
  const frozen = stores.turnJobs.freezeRuntimePlan(running!.id, compileRuntimePlanV2({
    installation: installationOwnershipOf(env)!, turn: running!.turn, assignment: running!.assignment,
    instructions: 'Help.', memoryEpoch: 1,
  }));
  stores.turnJobs.prepareFlueDispatch(running!.id, running!.turn.text, { generation: running!.id });
  stores.turnJobs.recordFlueReceipt(running!.id, {
    submissionId: `sub_${running!.id}`, acceptedAt: '2027-01-15T08:00:00.000Z', uid: UID,
  });
  return { delivered: delivered!, queued: queued!, running: running!, instanceId: frozen.instanceId };
}

/** A queued occurrence, one admitting, and one dispatched with a receipt and its usage admitted. */
async function routines(installation: HostedInstallation, team: string) {
  const routineStore = installation.stores.routines;
  const now = Date.now();
  const occurrence = (suffix: string) => {
    const nextRunAt = now + 3_600_000;
    const draft: Extract<RoutineConfirmationDraft, { action: 'create' }> = {
      action: 'create', routineId: `routine_${team}_${suffix}`,
      definition: {
        name: `Steward ${suffix}`, description: 'Post a status.', taskText: 'Post the project status.',
        triggerKind: 'schedule', scheduleInput: 'Every day at 9am',
        scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: '0 9 * * *' }),
        timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_channel_v1',
      },
      nextRunAt, projectedDailyStarts: 1, reservations: [{ windowStart: nextRunAt, count: 1 }],
    };
    const tokenHash = hashRoutineValue(`token-${team}-${suffix}`);
    const previewHash = hashRoutineValue(JSON.stringify(draft));
    routineStore.putConfirmation({
      confirmationId: `rconfirm_${team}_${suffix}`, tokenHash, actorId: 'U_MEMBER', actorClass: 'member',
      workspaceId: team, channelId: 'C_PENDING', draft, previewHash, expiresAt: now + 900_000,
    });
    const routine = routineStore.confirm({
      tokenHash, actorId: 'U_MEMBER', workspaceId: team, channelId: 'C_PENDING', previewHash,
      idempotencyKey: `routine:confirm:${team}:${suffix}`,
    });
    return routineStore.createOccurrence({
      runId: `rrun_${team}_${suffix}`, idempotencyKey: `routine:${team}:${suffix}`, routineId: routine.id,
      routineVersion: routine.version, scheduledFor: nextRunAt, triggerSource: 'run_now',
      requestedBy: 'U_MEMBER', queuedAt: now, deadlineAt: nextRunAt + 900_000,
    });
  };
  const queued = occurrence('queued');
  const admitting = occurrence('admitting');
  routineStore.startAdmissionAttempt({
    occurrenceId: admitting.id, owner: 'heartbeat', leaseUntil: now + 120_000, invokeStartedAt: now + 1,
  });
  const running = occurrence('running');
  const admission = routineStore.startAdmissionAttempt({
    occurrenceId: running.id, owner: 'heartbeat', leaseUntil: now + 120_000, invokeStartedAt: now + 1,
  });
  const instanceId = scopedObjectName({ installationId: installation.installationId }, opaqueId('routineagent', admission.attemptId));
  routineStore.prepareAgentDispatch({
    occurrenceId: running.id, attempt: admission.attempt, startedAt: now + 2,
    envelope: {
      schemaVersion: 1, attemptId: admission.attemptId, instanceId, idempotencyKey: admission.attemptId,
      message: 'Run the saved task.', initialData: { runtimePlan: 'frozen' },
    },
    resolvedAccessHash: 'a'.repeat(64), resolvedAgentId: 'agent_pending', resolvedAuthorityReceiptId: 'receipt',
    resolvedRunsAsMembershipId: 'membership_owner', model: 'anthropic/claude-haiku-4-5', traceId: `trace_${team}`,
  });
  routineStore.recordAgentReceipt({
    occurrenceId: running.id, attempt: admission.attempt, at: now + 3,
    receipt: { submissionId: 'sub_routine', acceptedAt: '2027-01-15T08:00:00.000Z', uid: UID },
  });
  // Preparing the attempt admitted its usage, as routine execution does.
  await new RoutineUsageRecorder({
    operationId: running.id, executionId: `exec:${running.id}:${admission.attemptId}`, startedAt: now + 2,
    workspaceId: team, channelId: 'C_PENDING', agentId: 'agent_pending', agentLabel: 'Pending',
    routineId: running.routineId, routineLabel: 'Steward running', requestedModel: 'anthropic/claude-haiku-4-5',
    credentialRefId: null, credentialVersion: null, platformEnv: installation.env, persistenceMode: 'durable',
    store: promisify(installation.stores.usage, { close: () => undefined }), now: () => now + 2,
  }).admit();
  installation.db.run(
    `INSERT INTO routine_recovery_deliveries (occurrence_id, claimed_at, status, failure_class, updated_at)
     VALUES (?, 0, 'pending', 'deadline_exceeded', ?)`,
    queued.id, now,
  );
  return { queued, admitting, running, instanceId };
}

function receipts(installation: HostedInstallation) {
  installation.db.run(
    `INSERT INTO management_receipt_outbox (outbox_id, operation_id, destination_json, receipt_json, status,
       attempts, next_attempt_at, created_at, updated_at)
     VALUES ('outbox_pending', 'op_1', '{}', '{}', 'pending', 0, 0, 1, 1),
            ('outbox_delivered', 'op_2', '{}', '{}', 'delivered', 1, 0, 1, 1)`,
  );
}

function snapshot(installation: HostedInstallation) {
  return {
    turns: installation.db.all('SELECT id, delivered, status, recovery_reason FROM turn_jobs ORDER BY id'),
    runs: installation.db.all(
      'SELECT id, status, failure_class, public_error, skip_reason FROM routine_runs ORDER BY id',
    ),
    notices: installation.db.all('SELECT occurrence_id, status FROM routine_recovery_deliveries ORDER BY occurrence_id'),
    receipts: installation.db.all('SELECT outbox_id, status, failure_code FROM management_receipt_outbox ORDER BY outbox_id'),
    usage: installation.db.all('SELECT operation_id, status FROM usage_operations ORDER BY operation_id'),
    alarm: installation.storage.alarm,
  };
}

test('cancelling an installation\'s pending work parks its turns, skips its occurrences, closes its notices and stops its submissions', async () => {
  const stopped: AgentStopTarget[] = [];
  const reports = { info: [] as string[], errors: [] as string[] };
  const deployment = hostedDeployment(['inst_pending_a', 'inst_pending_b'], {
    stopAgents: async (agents) => {
      stopped.push(...agents);
      return { stopped: agents.length, notStopped: 0 };
    },
    persistenceTelemetrySink: {
      info: (message) => reports.info.push(JSON.stringify(message)),
      error: (message) => reports.errors.push(JSON.stringify(message)),
    },
  });
  const a = deployment.installation('inst_pending_a');
  const b = deployment.installation('inst_pending_b');
  const turnsA = turns(a, 'T_A');
  const routinesA = await routines(a, 'T_A');
  receipts(a);
  turns(b, 'T_B');
  await routines(b, 'T_B');
  receipts(b);
  for (const installation of [a, b]) await installation.storage.setAlarm(Date.now() + 1_000);
  const neighbour = snapshot(b);

  const cancelled = await cancelInstallationObjectPendingWork(a.env, installationStateStoreObject(a.env));
  assert.deepEqual(cancelled, {
    alarmCleared: true, turns: 2, routineRuns: 3, routineNotices: 1, managementReceipts: 1,
    agentsStopped: 2, agentsNotStopped: 0,
  });
  assert.deepEqual(stopped, [
    { kind: 'slack_agent', target: { instanceId: turnsA.instanceId, uid: UID } },
    { kind: 'routine_agent', target: { instanceId: routinesA.instanceId, uid: UID } },
  ]);
  const after = snapshot(a);
  assert.equal(after.alarm, null);
  assert.deepEqual(after.turns, [
    { id: turnsA.delivered.id, delivered: 1, status: 'done', recovery_reason: null },
    { id: turnsA.queued.id, delivered: 0, status: 'recovery_required', recovery_reason: 'operator_cancelled' },
    { id: turnsA.running.id, delivered: 0, status: 'recovery_required', recovery_reason: 'operator_cancelled' },
  ]);
  // Skipped exactly as a refused installation's occurrences are: one wording in a member's run history.
  const refused = {
    status: 'skipped', failure_class: REFUSED_SKIP.failureClass, public_error: REFUSED_SKIP.publicError,
    skip_reason: REFUSED_SKIP.skipReason,
  };
  assert.deepEqual(after.runs.map(({ id: _id, ...run }) => run), [refused, refused, refused]);
  // The running occurrence's attempt settles as a refused one's does: its usage terminal is recorded.
  const usage = await a.stores.usage.getOperation(routinesA.running.id);
  assert.equal(usage?.operation.status, 'failed');
  assert.equal(usage?.measurements[0]?.usageUnknownReason, 'provider_request_unknown');
  assert.equal(reports.info.length, 1);
  assert.match(reports.info[0]!, /"usage":"recorded","work":"not_linked"/);
  assert.deepEqual(reports.errors, []);
  assert.deepEqual(after.notices.map(({ status }) => status), ['unknown']);
  assert.deepEqual(after.receipts, [
    { outbox_id: 'outbox_delivered', status: 'delivered', failure_code: null },
    { outbox_id: 'outbox_pending', status: 'failed', failure_code: 'operator_cancelled' },
  ]);
  // No executor picks them up again.
  assert.equal(a.stores.turnJobs.hasPending('legacy'), false);
  assert.deepEqual(a.stores.turnJobs.listPending(), []);
  assert.equal(a.stores.turnJobs.runnerView(turnsA.queued.id).status, 'recovery_required');
  assert.deepEqual(snapshot(b), neighbour, 'the neighbour keeps every pending turn, occurrence and its alarm');

  // A repeat changes nothing new, and asks the still-unsettled submission to stop again.
  stopped.length = 0;
  assert.deepEqual(await cancelInstallationObjectPendingWork(a.env, installationStateStoreObject(a.env)), {
    alarmCleared: true, turns: 0, routineRuns: 0, routineNotices: 0, managementReceipts: 0,
    agentsStopped: 1, agentsNotStopped: 0,
  });
  assert.deepEqual(stopped.map(({ kind }) => kind), ['slack_agent']);
  assert.equal(reports.info.length, 1, 'a settled occurrence is not settled again');
});

test('an installation\'s Owner never sees the turns an operator parked, in the recovery list or the drain counts', async () => {
  const deployment = hostedDeployment(['inst_pending_owner'], {
    stopAgents: async (agents) => ({ stopped: agents.length, notStopped: 0 }),
  });
  const a = deployment.installation('inst_pending_owner');
  turns(a, 'T_A');
  // A turn held for its own reason before the restore: the Owner still sees and resolves it.
  const held = job('tj_T_A_held', 'T_A', '1800000000.000400');
  a.stores.turnJobs.enqueue(held);
  a.stores.turnJobs.markRecoveryRequired(held.id, 'stored_turn_unreadable');

  const cancelled = await cancelInstallationObjectPendingWork(a.env, installationStateStoreObject(a.env));
  assert.equal((cancelled as { turns: number }).turns, 2, 'the operator\'s record counts the turns it parked');
  assert.deepEqual(a.stores.turnJobs.listRecoveryRequired().map(({ id, reason }) => [id, reason]),
    [[held.id, 'stored_turn_unreadable']]);
  assert.deepEqual(a.stores.turnJobs.runtimeDrainCounts(), {
    pendingLegacyTurnJobs: 1, pendingLedgerTurnJobs: 0, pendingSlackInteractionCleanups: 0, recoveryRequiredTurnJobs: 1,
  });
  assert.equal(a.stores.turnJobs.resolveRecoveryRequired(held.id), true);
  assert.deepEqual(a.stores.turnJobs.listRecoveryRequired(), []);
  assert.equal(a.stores.turnJobs.runtimeDrainCounts().recoveryRequiredTurnJobs, 0);
});

test('a dispatched turn whose stored dispatch does not read is counted as not stopped', async (t) => {
  const warned = t.mock.method(console, 'warn', () => undefined);
  const stopped: AgentStopTarget[] = [];
  const deployment = hostedDeployment(['inst_pending_unreadable'], {
    stopAgents: async (agents) => {
      stopped.push(...agents);
      return { stopped: agents.length, notStopped: 0 };
    },
  });
  const a = deployment.installation('inst_pending_unreadable');
  const pending = turns(a, 'T_A');
  a.db.run('UPDATE turn_jobs SET dispatch_envelope_json = ? WHERE id = ?', '{"unreadable"', pending.running.id);

  const cancelled = await cancelInstallationObjectPendingWork(a.env, installationStateStoreObject(a.env)) as {
    turns: number; agentsStopped: number; agentsNotStopped: number;
  };
  assert.deepEqual([cancelled.turns, cancelled.agentsStopped, cancelled.agentsNotStopped], [2, 0, 1]);
  assert.deepEqual(stopped, [], 'nothing names its instance to abort');
  assert.equal(a.stores.turnJobs.runnerView(pending.running.id).status, 'recovery_required', 'it is parked all the same');
  assert.equal(warned.mock.callCount(), 1);
});

test('a settled operator-cancelled turn is purged after the redelivery window; one dispatched and unsettled is kept', async () => {
  const deployment = hostedDeployment(['inst_pending_purge'], {
    stopAgents: async (agents) => ({ stopped: agents.length, notStopped: 0 }),
  });
  const a = deployment.installation('inst_pending_purge');
  const { env, stores } = a;
  // Delivered; queued and never dispatched; dispatched and still running.
  const pending = turns(a, 'T_A');
  // Dispatched in another thread, its submission settled, not yet delivered.
  const settled = job('tj_T_A_settled', 'T_A', '1800000000.000500');
  stores.turnJobs.enqueue(settled);
  stores.turnJobs.freezeRuntimePlan(settled.id, compileRuntimePlanV2({
    installation: installationOwnershipOf(env)!, turn: settled.turn, assignment: settled.assignment,
    instructions: 'Help.', memoryEpoch: 1,
  }));
  stores.turnJobs.prepareFlueDispatch(settled.id, settled.turn.text, { generation: settled.id });
  stores.turnJobs.recordFlueReceipt(settled.id, {
    submissionId: `sub_${settled.id}`, acceptedAt: '2027-01-15T08:00:00.000Z', uid: UID,
  });
  stores.turnJobs.recordFlueSettlement(settled.id, { outcome: 'aborted', settledAt: Date.now(), failureKind: 'agent' });
  // Queued with its 👀 acknowledgment, which no cleanup sweep removes from an undelivered turn.
  const acknowledged = job('tj_T_A_acknowledged', 'T_A', '1800000000.000600');
  stores.turnJobs.enqueue({
    ...acknowledged,
    midRunReceipt: { channelId: acknowledged.turn.channelId, messageTs: acknowledged.turn.messageTs, name: 'eyes' },
  });
  assert.match(String(a.db.get('SELECT progress_json FROM turn_jobs WHERE id = ?', acknowledged.id)?.progress_json),
    /"cleanup":"pending"/);
  // Held for its own reason before the restore.
  const held = job('tj_T_A_held', 'T_A', '1800000000.000400');
  stores.turnJobs.enqueue(held);
  stores.turnJobs.markRecoveryRequired(held.id, 'stored_turn_unreadable');
  await cancelInstallationObjectPendingWork(env, installationStateStoreObject(env));

  /** The turn rows left once a store on a clock `elapsedMs` later purges, as every enqueue does. */
  const remainingAfter = (elapsedMs: number) => {
    const probe = job('tj_probe', 'T_A', '1800000001.000100');
    new TurnJobStoreLogic(a.db, () => Date.now() + elapsedMs, stores.objectInventory).enqueue(probe);
    a.db.run('DELETE FROM turn_jobs WHERE id = ?', probe.id);
    return a.db.all('SELECT id FROM turn_jobs ORDER BY id').map(({ id }) => String(id));
  };
  assert.deepEqual(remainingAfter(TURN_JOB_TTL_MS - 60_000),
    [pending.delivered.id, pending.queued.id, pending.running.id, held.id, settled.id, acknowledged.id].sort(),
    'nothing goes inside the redelivery window');
  // Past it, the delivered turn goes, and so do the cancelled ones never dispatched. The settled
  // one is its live binding's latest dispatched context, kept with the binding as a delivered one is.
  assert.deepEqual(remainingAfter(TURN_JOB_TTL_MS + 60_000), [pending.running.id, held.id, settled.id].sort());
  assert.deepEqual(remainingAfter(31 * 24 * 60 * 60_000), [pending.running.id, held.id].sort(),
    'once its binding expires the settled one goes too; the unsettled dispatch and the held turn stay');
  // The repeat-cancellation contract holds: the unsettled dispatch is asked to stop again.
  const repeat = await cancelInstallationObjectPendingWork(env, installationStateStoreObject(env));
  assert.deepEqual([(repeat as { turns: number }).turns, (repeat as { agentsStopped: number }).agentsStopped], [0, 1]);
});

test('a thread runner settles its waiting jobs unrun, reports the running one, and a Flue instance loses its alarm', async () => {
  const deployment = hostedDeployment(['inst_pending_runner']);
  const a = deployment.installation('inst_pending_runner');
  const pending = turns(a, 'T_A');
  const objects = a.stores.objectInventory.list().objects;
  const runnerObject = objects.find(({ kind }) => kind === 'thread_runner')!;
  const agentObject = objects.find(({ kind }) => kind === 'slack_agent')!;
  const runner = deployment.object('SLACK_THREAD_RUNNER', runnerObject.name);
  const jobs = runnerJobs(runner.storage);
  jobs.admit({ id: pending.queued.id, threadKey: 'thread', payload: {} }, 1);
  jobs.admit({ id: pending.running.id, threadKey: 'thread', payload: {} }, 1);
  jobs.markRunning(pending.running.id);
  jobs.admit({ id: pending.delivered.id, threadKey: 'thread', payload: {} }, 1);
  jobs.settle(pending.delivered.id, 'done', 2);
  await runner.storage.setAlarm(Date.now() + 1_000);

  assert.deepEqual(await cancelInstallationObjectPendingWork(a.env, runnerObject), {
    alarmCleared: true, runnerJobs: 1, runnerJobsRunning: 1,
  });
  assert.equal(runner.storage.alarm, null);
  // The running job's run goes on in its instance: it is reported, not claimed as stopped.
  assert.deepEqual(jobs.status().jobs, { done: 1, recovery_required: 1, running: 1 });
  assert.equal(jobs.get(pending.queued.id)?.state, 'recovery_required');
  // Its run ends as the state store's abort makes it end, and it settles as that.
  jobs.settle(pending.running.id, 'error', 3);
  assert.deepEqual(jobs.status().jobs, { done: 1, error: 1, recovery_required: 1 });
  assert.deepEqual(jobs.runnable(Date.now() + 60_000), []);
  assert.deepEqual(await cancelInstallationObjectPendingWork(a.env, runnerObject), {
    alarmCleared: true, runnerJobs: 0, runnerJobsRunning: 0,
  });

  const agent = deployment.object(CHICKPEA_SLACK_AGENT_BINDING, agentObject.name);
  await agent.storage.setAlarm(Date.now() + 1_000);
  assert.deepEqual(await cancelInstallationObjectPendingWork(a.env, agentObject), { alarmCleared: true });
  assert.equal(agent.storage.alarm, null);
});

test('a cancelled running occurrence settles the attempt its envelope names, not merely the latest admission', async () => {
  const a = hostedInstallation('inst_pending_attempt');
  const { running } = await routines(a, 'T_A');
  const preparing = a.stores.routines.getRun(running.id)!.flueAgentEnvelope!.attemptId;
  // A later admission row the occurrence's dispatch never used.
  a.db.run(
    `INSERT INTO routine_run_admissions (occurrence_id, attempt, attempt_id, flue_run_id, flue_agent_receipt_json,
       invoke_started_at, receipt_at, visible_at, status, safe_error)
     VALUES (?, 2, ?, NULL, NULL, ?, NULL, NULL, 'attempting', NULL)`,
    running.id, `${preparing}_later`, Date.now(),
  );
  const cancelled = a.stores.routines.cancelPendingWork(Date.now(), REFUSED_SKIP);
  assert.deepEqual(cancelled.prepared.map(({ run, admission }) => [run.id, admission.attemptId]), [[running.id, preparing]]);
});

test('a submission whose abort fails is counted, never thrown', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  const agents: AgentStopTarget[] = [
    { kind: 'slack_agent', target: { instanceId: 'i1~inst~agent_a' } },
    { kind: 'routine_agent', target: { instanceId: 'i1~inst~routineagent_b', uid: UID } },
  ];
  const aborted: string[] = [];
  assert.deepEqual(await stopCancelledAgents(agents, async (agent) => {
    if (agent.kind === 'routine_agent') throw new Error('unreachable');
    aborted.push(agent.target.instanceId);
  }), { stopped: 1, notStopped: 1 });
  assert.deepEqual(aborted, ['i1~inst~agent_a']);
});
