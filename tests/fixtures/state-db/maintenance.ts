// Public, synthetic fixtures shared by Node behavior tests and workerd metering.
// Construct history through store methods so canonical links and JSON remain valid.
import { RoutineStoreLogic } from '../../../src/routines/store.ts';
import { hashRoutineValue } from '../../../src/routines/ids.ts';
import { WorkStoreLogic } from '../../../src/work/store.ts';
import { SlackRunPresentationStoreLogic } from '../../../src/slack/run-presentations.ts';
import { TurnJobStoreLogic } from '../../../src/slack/turn-jobs.ts';
import type { TurnJob } from '../../../src/slack/turn-job-types.ts';
import type { StateDb, SqlParam } from '../../../src/state/state-db.ts';

export const NOW = 1_800_000_000_000;
export const DAY = 86_400_000;
export const MAINTENANCE_INDEXES = [
  'ledger_content_expiry_idx',
  'slack_run_presentations_finalized_idx',
  'slack_run_presentations_hard_expiry_idx',
  'turn_jobs_pending_idx',
  'routine_runs_delivery_lease_idx',
  'routine_runs_status_finished_idx',
  'routine_confirmations_consumed_idx',
] as const;

export function recordingDb(inner: StateDb) {
  const statements: Array<{ sql: string; params: SqlParam[] }> = [];
  const db: StateDb = {
    ...(inner.schema ? { schema: inner.schema } : {}),
    run(sql, ...params) { statements.push({ sql, params }); return inner.run(sql, ...params); },
    get(sql, ...params) { statements.push({ sql, params }); return inner.get(sql, ...params); },
    all(sql, ...params) { statements.push({ sql, params }); return inner.all(sql, ...params); },
    exec(sql) { statements.push({ sql, params: [] }); inner.exec(sql); },
    transaction: (fn) => inner.transaction(fn),
  };
  return { db, statements };
}

export function turnJob(id: string, executionAuthority: 'legacy' | 'ledger' = 'legacy'): TurnJob {
  return {
    id, evtKey: `evt:${id}`, msgKey: `msg:${id}`, executionAuthority,
    turn: {
      workspaceId: 'T_TEST', channelId: 'C_TEST', userId: 'U_TEST',
      eventId: `Ev_${id}`, text: 'Synthetic fixture', messageTs: '1800000000.000001',
      threadTs: '1800000000.000001', source: 'app_mention', contextMode: 'thread',
    },
    assignment: {
      workspaceId: 'T_TEST', channelId: 'C_TEST', agentId: 'agent_default',
      agent: {
        id: 'agent_default', kind: 'user', revision: 1, name: 'Default',
        instructions: 'Help.', enabled: true, skills: [], mcpServers: [],
        apiConnections: [], repositories: [],
      },
    },
  };
}

export function presentationInput(id: string) {
  return {
    runId: id, turnJobId: `turn_${id}`, bindingId: `binding_${id}`,
    workBindingGeneration: 1, runFencingToken: 0,
    persona: { name: 'Fixture', avatarUrl: 'https://example.com/avatar.png', avatarRevision: 1 },
    root: {
      workspaceId: 'T_TEST', channelId: 'C_TEST', requesterUserId: 'U_TEST',
      threadTs: '1800000000.000001',
    },
  } as const;
}

export function maintenanceFixture(db: StateDb, history = 100) {
  let clock = NOW - history * 3_600_000;
  const routines = new RoutineStoreLogic(db, () => clock);
  const work = new WorkStoreLogic(db, { now: () => clock, env: {} });
  const presentations = new SlackRunPresentationStoreLogic(db, () => clock);
  const turns = new TurnJobStoreLogic(db, () => clock);
  const definition = {
    name: 'Read fixture', description: 'Synthetic maintenance history.',
    taskText: 'Summarize the channel.', triggerKind: 'schedule' as const,
    scheduleInput: '0 9 * * *',
    scheduleJson: '{"version":1,"kind":"cron","expression":"0 9 * * *"}',
    timezone: 'UTC', outputPolicy: 'post' as const, authorityMode: 'live_channel_v1' as const,
  };
  const draft = {
    action: 'create' as const, routineId: 'routine_meter', definition,
    nextRunAt: clock + 3_600_000, projectedDailyStarts: 1,
    reservations: [{ windowStart: clock + 3_600_000, count: 1 }],
  };
  const tokenHash = hashRoutineValue('fixture');
  const previewHash = hashRoutineValue(JSON.stringify(draft));
  routines.putConfirmation({
    confirmationId: 'rconfirm_meter', tokenHash, actorId: 'U_TEST', actorClass: 'member',
    workspaceId: 'T_TEST', channelId: 'C_TEST', draft, previewHash, expiresAt: clock + 60_000,
  });
  const routine = routines.confirm({
    tokenHash, actorId: 'U_TEST', workspaceId: 'T_TEST', channelId: 'C_TEST',
    previewHash, idempotencyKey: 'create-meter',
  });
  for (let i = 0; i < history; i += 1) {
    clock += 3_600_000;
    const run = routines.createOccurrence({
      runId: `rrun_meter_${i}`, idempotencyKey: `meter-${i}`,
      routineId: routine.id, routineVersion: routine.version, scheduledFor: clock,
      triggerSource: 'schedule', requestedBy: null, queuedAt: clock, deadlineAt: clock + 60_000,
    });
    routines.transitionRun({ occurrenceId: run.id, from: ['queued'], to: 'cancelled', at: clock + 1 });
  }
  clock = NOW;
  routines.control({
    routineId: routine.id, expectedVersion: routine.version, action: 'pause',
    actorId: 'U_TEST', actorClass: 'member', idempotencyKey: 'pause-meter',
  });
  for (let i = 0; i < history; i += 1) {
    work.putContent({ sensitivity: 'private', body: `fixture ${i}` });
    presentations.create(presentationInput(`run_presentation_${i}`));
    turns.enqueue(turnJob(`turn_meter_${i}`));
    turns.markDelivered(`turn_meter_${i}`);
    routines.putConfirmation({
      confirmationId: `rconfirm_fresh_${i}`, tokenHash: hashRoutineValue(`fresh-${i}`),
      actorId: 'U_TEST', actorClass: 'member', workspaceId: 'T_TEST', channelId: 'C_TEST',
      draft, previewHash, expiresAt: NOW + 60_000,
    });
  }
  routines.cleanupRetention();
  return {
    routines, work, presentations, turns,
    setClock(at: number) { clock = at; },
    tick() {
      return {
        routines: routines.cleanupRetention(),
        due: routines.claimDueSchedules({ now: clock, owner: 'meter', limit: 10 }),
        content: work.purgeContent(clock, 100), presentations: presentations.maintain(100),
        legacy: turns.hasPending('legacy'), ledger: turns.hasPending('ledger'),
        admissions: routines.listRuns({ statuses: ['queued', 'admitting', 'running'], limit: 100 }),
      };
    },
  };
}
