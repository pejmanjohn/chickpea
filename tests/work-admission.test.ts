import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
  type ResolvedAssignment,
  type SlackIdentity,
} from '../src/config/types.ts';
import { ConfigStoreLogic, SqliteConfigStore } from '../src/config/store.ts';
import { RoutineStoreLogic } from '../src/routines/store.ts';
import { normalizeRoutineSchedule } from '../src/routines/schedule.ts';
import { SlackStateLogic } from '../src/slack/claim-store.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import {
  assignmentUsesSlackIdentity,
  resolveSlackIdentityDmAssignment,
} from '../src/slack/identity-admission.ts';
import { TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import {
  prepareSlackShadowAdmission,
  resolveSlackAdmissionTruth,
} from '../src/slack/work-admission.ts';
import { WorkStoreLogic } from '../src/work/store.ts';

const NOW = 1_800_000_000_000;

function assignment(): ResolvedAssignment {
  return {
    workspaceId: 'T_home',
    channelId: 'C_public',
    agentId: 'agent_default',
    slackIdentityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
    agent: {
      id: 'agent_default',
      revision: 1,
      name: 'Default',
      instructions: 'Help the team.',
      enabled: true,
      model: 'openai/gpt-5.6-sol',
      skills: [
        { name: 'asana', description: 'Use Asana', instructions: 'Do work', enabled: true },
      ],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    },
  };
}

function turn(overrides: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return {
    workspaceId: 'T_home',
    channelId: 'C_public',
    eventId: 'Ev_1',
    slackIdentityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
    text: 'Prepare the launch brief',
    userId: 'U_member',
    messageTs: '100.001',
    threadTs: '100.000',
    source: 'app_mention',
    contextMode: 'thread',
    channelType: 'channel',
    ...overrides,
  };
}

test('legacy DM bindings cannot change the one workspace Slack execution identity', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [assignment().agent], assignments: [] });
  const financeIdentity: SlackIdentity = {
    id: 'slack_identity_finance',
    ingressKey: 'finance_ingress_0123456789abcdef',
    kind: 'dedicated',
    lifecycle: 'connected',
    teamId: 'T_home',
    appId: 'A_FINANCE',
    botUserId: 'U_FINANCE',
    dmState: 'on',
    dmAgentId: 'agent_default',
    credentialProvenance: 'stored',
    connectionRevision: 1,
    health: 'healthy',
    createdAt: NOW,
    updatedAt: NOW,
  };
  await store.createSlackIdentity(financeIdentity);

  const dm = await resolveSlackIdentityDmAssignment(
    financeIdentity,
    'T_home',
    'D_FINANCE',
    store,
  );
  assert.equal(dm?.agentId, 'agent_default');
  assert.equal(dm?.slackIdentityId, undefined);
  assert.equal(assignmentUsesSlackIdentity(dm as ResolvedAssignment, financeIdentity.id), false);
  assert.equal(
    assignmentUsesSlackIdentity(dm as ResolvedAssignment, WORKSPACE_DEFAULT_SLACK_IDENTITY_ID),
    true,
  );
  assert.equal(assignmentUsesSlackIdentity(assignment(), financeIdentity.id), false);

  const off = { ...financeIdentity, dmState: 'off' as const };
  assert.equal(
    await resolveSlackIdentityDmAssignment(off, 'T_home', 'D_FINANCE', store),
    undefined,
  );
  store.close();
});

test('Slack Run correlation uses the one workspace app reference without credentials', () => {
  const input = prepareSlackShadowAdmission({
    turn: turn({ slackIdentityId: 'slack_identity_finance' }),
    assignment: { ...assignment(), slackIdentityId: 'slack_identity_finance' },
    sourceVisibility: 'public',
    admittedAt: NOW,
  });
  assert.equal(input.safeConfig.slackIdentityId, WORKSPACE_DEFAULT_SLACK_IDENTITY_ID);
  assert.doesNotMatch(JSON.stringify(input.safeConfig), /xoxb-|botToken|signingSecret/i);
});

test('Slack admission reuses one Work and Binding, sequences Runs, and dedupes fanout', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new WorkStoreLogic(db, { now: () => NOW });
    const firstInput = prepareSlackShadowAdmission({
      turn: turn(),
      assignment: assignment(),
      sourceVisibility: 'public',
      admittedAt: NOW,
    });
    const first = store.admitShadowRun(firstInput);
    const replay = store.admitShadowRun({
      ...prepareSlackShadowAdmission({
        turn: turn({ eventId: 'Ev_mirrored' }),
        assignment: assignment(),
        sourceVisibility: 'public',
        admittedAt: NOW + 1,
      }),
      auditEventId: firstInput.auditEventId,
      auditIdempotencyKey: firstInput.auditIdempotencyKey,
    });
    const second = store.admitShadowRun(
      prepareSlackShadowAdmission({
        turn: turn({ eventId: 'Ev_2', messageTs: '100.002', text: 'Add a budget table' }),
        assignment: assignment(),
        sourceVisibility: 'public',
        admittedAt: NOW + 2,
      }),
    );

    assert.equal(replay.replayed, true);
    assert.equal(replay.run.id, first.run.id);
    assert.equal(second.work.id, first.work.id);
    assert.equal(second.binding.id, first.binding.id);
    assert.equal(first.run.admissionSequence, 1);
    assert.equal(second.run.admissionSequence, 2);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM ledger_content')?.count, 2);
    assert.equal(first.run.executionAuthority, 'legacy');
    assert.equal(first.run.status, 'admitted');
  } finally {
    db.close();
  }
});

test('Slack canonical identities are scoped by workspace', () => {
  const first = prepareSlackShadowAdmission({
    turn: turn(),
    assignment: assignment(),
    sourceVisibility: 'public',
    admittedAt: NOW,
  });
  const other = prepareSlackShadowAdmission({
    turn: turn({ workspaceId: 'T_other' }),
    assignment: { ...assignment(), workspaceId: 'T_other' },
    sourceVisibility: 'public',
    admittedAt: NOW,
  });
  assert.notEqual(first.work.id, other.work.id);
  assert.notEqual(first.binding.id, other.binding.id);
  assert.notEqual(first.run.id, other.run.id);
});

test('selector rollback changes only future Run authority on the same Binding', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new WorkStoreLogic(db, { now: () => NOW });
    const ledger = store.admitShadowRun(prepareSlackShadowAdmission({
      turn: turn(),
      assignment: assignment(),
      sourceVisibility: 'public',
      executionAuthority: 'ledger',
      admittedAt: NOW,
    }));
    const legacy = store.admitShadowRun(prepareSlackShadowAdmission({
      turn: turn({ eventId: 'Ev_rollback', messageTs: '100.002' }),
      assignment: assignment(),
      sourceVisibility: 'public',
      executionAuthority: 'legacy',
      admittedAt: NOW + 1,
    }));
    assert.equal(ledger.binding.id, legacy.binding.id);
    assert.equal(ledger.run.executionAuthority, 'ledger');
    assert.equal(legacy.run.executionAuthority, 'legacy');
    assert.equal(store.getRun(ledger.run.id)?.executionAuthority, 'ledger');
  } finally {
    db.close();
  }
});

test('Slack truth admits only a positively verified same-workspace active human', async () => {
  const eligible = await resolveSlackAdmissionTruth(turn(), 'U_bot', {
    async user() {
      return {
        ok: true,
        user: {
          id: 'U_member',
          teamId: 'T_home',
          deleted: false,
          bot: false,
          appUser: false,
          restricted: false,
          ultraRestricted: false,
          stranger: false,
        },
      };
    },
    async conversation() {
      return {
        ok: true,
        facts: {
          id: 'C_public',
          name: 'general',
          private: false,
          archived: false,
          frozen: false,
          shared: false,
          externallyShared: false,
          organizationShared: false,
          pendingShared: false,
          member: true,
          teamId: 'T_home',
        },
      };
    },
  });
  assert.deepEqual(eligible, {
    eligible: true,
    reason: 'eligible',
    sourceVisibility: 'public',
    actorTrustTier: 'member',
  });

  for (const user of [
    { teamId: undefined },
    { teamId: 'T_other' },
    { teamId: 'T_home', restricted: true },
    { teamId: 'T_home', bot: true },
    { teamId: 'T_home', deleted: true },
  ]) {
    const denied = await resolveSlackAdmissionTruth(turn(), 'U_bot', {
      async user() {
        return {
          ok: true,
          user: {
            id: 'U_member',
            teamId: user.teamId,
            deleted: user.deleted ?? false,
            bot: user.bot ?? false,
            appUser: false,
            restricted: user.restricted ?? false,
            ultraRestricted: false,
            stranger: false,
          },
        };
      },
      async conversation() {
        return { ok: false };
      },
    });
    assert.equal(denied.eligible, false);
  }
});

test('Slack truth rejects a member whose canonical Chickpea membership is deactivated', async () => {
  const result = await resolveSlackAdmissionTruth(turn(), 'U_bot', {
    async user() {
      return {
        ok: true,
        user: {
          id: 'U_member', teamId: 'T_home', deleted: false, bot: false,
          appUser: false, restricted: false, ultraRestricted: false, stranger: false,
        },
      };
    },
    async conversation() {
      return {
        ok: true,
        facts: {
          id: 'C_public', name: 'general', private: false, archived: false,
          frozen: false, shared: false, externallyShared: false,
          organizationShared: false, pendingShared: false, member: true,
          teamId: 'T_home',
        },
      };
    },
  }, async () => false);
  assert.deepEqual(result, { eligible: false, reason: 'deactivated_actor' });
});

test('Slack claims, Run, content, thread registration, and relay row commit atomically', () => {
  const db = openStateDb(':memory:');
  try {
    const slack = new SlackStateLogic(db, () => NOW);
    const turnJobs = new TurnJobStoreLogic(db, () => NOW);
    const presentations = new SlackRunPresentationStoreLogic(db, () => NOW);
    const work = new WorkStoreLogic(db, { now: () => NOW });
    const normalized = turn();
    const resolved = assignment();
    const admission = prepareSlackShadowAdmission({
      turn: normalized,
      assignment: resolved,
      sourceVisibility: 'public',
      admittedAt: NOW,
    });
    const input = {
      evtKey: 'evt:Ev_1',
      msgKey: 'msg:C_public:100.001',
      threadKey: 'slack-thread:T_home:C_public:100.000',
      admission,
      turnJob: {
        id: 'msg:C_public:100.001',
        evtKey: 'evt:Ev_1',
        msgKey: 'msg:C_public:100.001',
        turn: normalized,
        assignment: resolved,
        runId: admission.run.id,
      },
      presentation: {
        root: {
          workspaceId: normalized.workspaceId,
          channelId: normalized.channelId,
          threadTs: normalized.threadTs,
          requesterUserId: normalized.userId,
        },
        taskLabels: ['Prepare the brief', 'Check the evidence'],
        features: { progressiveStreaming: true, nativeTasks: true },
      },
    };
    const admitted = slack.admitCanonical(input, work, turnJobs, presentations);
    assert.equal(admitted.claimed, true);
    assert.equal(slack.has(input.threadKey), true);
    assert.equal(turnJobs.listPending()[0]?.runId, admission.run.id);
    assert.deepEqual(
      presentations.get(admission.run.id)?.plan?.tasks.map((task) => task.title),
      ['Prepare the brief', 'Check the evidence'],
    );
    assert.deepEqual(presentations.get(admission.run.id)?.features, {
      progressiveStreaming: true,
      nativeTasks: true,
    });

    const mirrored = slack.admitCanonical(
      { ...input, evtKey: 'evt:Ev_mirrored' },
      work,
      turnJobs,
      presentations,
    );
    assert.deepEqual(mirrored, { claimed: false });
    assert.equal(slack.claim('evt:Ev_mirrored'), true, 'losing event claim was released');
    assert.equal(db.get('SELECT COUNT(*) AS count FROM runs')?.count, 1);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM turn_jobs')?.count, 1);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM slack_run_presentations')?.count, 1);
  } finally {
    db.close();
  }
});

test('presentation creation failure rolls back claims, Work, and TurnJob atomically', () => {
  const db = openStateDb(':memory:');
  try {
    const slack = new SlackStateLogic(db, () => NOW);
    const turns = new TurnJobStoreLogic(db, () => NOW);
    const presentations = new SlackRunPresentationStoreLogic(db, () => NOW);
    const work = new WorkStoreLogic(db, { now: () => NOW });
    const normalized = turn();
    const resolved = assignment();
    const admission = prepareSlackShadowAdmission({
      turn: normalized,
      assignment: resolved,
      sourceVisibility: 'public',
      admittedAt: NOW,
    });
    assert.throws(() => slack.admitCanonical({
      evtKey: 'evt:presentation-bad',
      msgKey: 'msg:presentation-bad',
      threadKey: 'thread:presentation-bad',
      admission,
      turnJob: {
        id: 'msg:presentation-bad',
        evtKey: 'evt:presentation-bad',
        msgKey: 'msg:presentation-bad',
        turn: normalized,
        assignment: resolved,
        runId: admission.run.id,
      },
      presentation: {
        root: {
          workspaceId: normalized.workspaceId,
          channelId: normalized.channelId,
          threadTs: normalized.threadTs,
          requesterUserId: normalized.userId,
        },
        taskLabels: ['invalid\nlabel'],
      },
    }, work, turns, presentations), /task title/i);
    assert.equal(slack.claim('evt:presentation-bad'), true);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM runs')?.count, 0);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM turn_jobs')?.count, 0);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM slack_run_presentations')?.count, 0);
  } finally {
    db.close();
  }
});

test('Slack configuration resolution completes before any event or message claim mutation', () => {
  const source = readFileSync(new URL('../src/channels/slack.ts', import.meta.url), 'utf8');
  const resolutionStart = source.indexOf('// e. Resolve the config for this turn');
  const claimStart = source.indexOf('let claimsHeldByCanonicalAdmission', resolutionStart);
  assert.ok(resolutionStart >= 0 && claimStart > resolutionStart);
  const preClaimResolution = source.slice(resolutionStart, claimStart);
  assert.doesNotMatch(preClaimResolution, /state\.(?:claim|release|admitCanonical)\s*\(/);
});

test('failed canonical admission rolls back Slack claims and all ledger writes', () => {
  const db = openStateDb(':memory:');
  try {
    const slack = new SlackStateLogic(db, () => NOW);
    const work = new WorkStoreLogic(db, { now: () => NOW });
    const admission = prepareSlackShadowAdmission({
      turn: turn(),
      assignment: assignment(),
      sourceVisibility: 'public',
      admittedAt: NOW,
    });
    admission.safeConfig = { ...admission.safeConfig, configuredModel: 'https://secret.invalid' };
    assert.throws(
      () =>
        slack.admitCanonical(
          {
            evtKey: 'evt:bad',
            msgKey: 'msg:bad',
            threadKey: 'thread:bad',
            admission,
          },
          work,
        ),
      /model/i,
    );
    assert.equal(slack.claim('evt:bad'), true);
    assert.equal(slack.claim('msg:bad'), true);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM runs')?.count, 0);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM ledger_content')?.count, 0);
  } finally {
    db.close();
  }
});

test('a TurnJob authority mismatch rolls back claims, Run, and relay payload', () => {
  const db = openStateDb(':memory:');
  try {
    const slack = new SlackStateLogic(db, () => NOW);
    const turns = new TurnJobStoreLogic(db, () => NOW);
    const work = new WorkStoreLogic(db, { now: () => NOW });
    const normalized = turn();
    const resolved = assignment();
    const admission = prepareSlackShadowAdmission({
      turn: normalized,
      assignment: resolved,
      sourceVisibility: 'public',
      executionAuthority: 'ledger',
      admittedAt: NOW,
    });
    assert.throws(() => slack.admitCanonical({
      evtKey: 'evt:mismatch', msgKey: 'msg:mismatch', threadKey: 'thread:mismatch',
      admission,
      turnJob: {
        id: 'msg:mismatch', evtKey: 'evt:mismatch', msgKey: 'msg:mismatch',
        turn: normalized, assignment: resolved, runId: admission.run.id,
        executionAuthority: 'legacy',
      },
    }, work, turns), /authority does not match/i);
    assert.equal(slack.claim('evt:mismatch'), true);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM runs')?.count, 0);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM turn_jobs')?.count, 0);
  } finally {
    db.close();
  }
});

test('Routine creation links a canonical Work/Binding and an occurrence links one legacy Run', () => {
  const db = openStateDb(':memory:');
  try {
    const config = new ConfigStoreLogic(db, { agents: [], assignments: [] });
    config.createAgent(assignment().agent);
    config.putAssignment({
      workspaceId: 'T_home',
      channelId: 'C_public',
      agentId: 'agent_default',
    });
    const routines = new RoutineStoreLogic(db, () => NOW);
    const projection = normalizeRoutineSchedule('0 * * * *', 'UTC', NOW);
    const routine = routines.save({
      actorId: 'U_member',
      actorClass: 'member',
      workspaceId: 'T_home',
      channelId: 'C_public',
      sourceVisibility: 'public',
      idempotencyKey: 'routine:test:create',
      draft: {
        action: 'create',
        routineId: 'routine_shadow_link',
        definition: {
          name: 'Launch report',
          description: 'Prepare the launch report.',
          taskText: 'Prepare the launch report.',
          triggerKind: 'schedule',
          scheduleInput: '0 * * * *',
          scheduleJson: projection.scheduleJson,
          timezone: 'UTC',
          outputPolicy: 'post',
          authorityMode: 'live_channel_v1',
        },
        nextRunAt: projection.nextRunAt,
        projectedDailyStarts: projection.projectedDailyStarts,
        reservations: projection.reservations,
      },
    });
    assert.ok(routine.workId);
    assert.ok(routine.bindingId);

    const occurrence = routines.createOccurrence({
      runId: 'rrun_shadow_link',
      idempotencyKey: 'routine:test:run-now',
      routineId: routine.id,
      routineVersion: routine.version,
      scheduledFor: NOW,
      triggerSource: 'run_now',
      requestedBy: 'U_member',
      queuedAt: NOW,
      deadlineAt: NOW + 60_000,
    });
    assert.ok(occurrence.canonicalRunId);
    const run = new WorkStoreLogic(db, { now: () => NOW }).getRun(
      occurrence.canonicalRunId as never,
    );
    assert.equal(run?.workId, routine.workId);
    assert.equal(run?.bindingId, routine.bindingId);
    assert.equal(run?.executionAuthority, 'legacy');
    assert.equal(run?.coordinatorKind, 'flue_workflow');
    assert.equal(run?.status, 'admitted');
    assert.equal(db.get('SELECT COUNT(*) AS count FROM run_executions')?.count, 0);
  } finally {
    db.close();
  }
});
