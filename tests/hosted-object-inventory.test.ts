import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { WebClient } from '@slack/web-api';
import ts from 'typescript';

import { compileRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import { createSlackTurnInput, stageSlackTurnInputOnAgentObject } from '../src/agents/turn-input.ts';
import {
  installationObjectName,
  installationOwnershipOf,
  InstallationContextError,
  scopedObjectName,
  scopeInstallationEnv,
} from '../src/config/installation-scope.ts';
import type { AppStores } from '../src/config/state-backend.ts';
import { tagStateStub } from '../src/config/state-rpc.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { hashRoutineValue } from '../src/routines/ids.ts';
import { RoutineStoreLogic } from '../src/routines/store.ts';
import type { RoutineConfirmationDraft } from '../src/routines/types.ts';
import { CHICKPEA_SLACK_AGENT_BINDING } from '../src/slack/bounded-agent-observation.ts';
import { runTurn } from '../src/slack/run-turn.ts';
import { slackAgentThreadKey } from '../src/slack/thread-key.ts';
import { threadRunnerStub } from '../src/slack/thread-runner-rpc.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import { promisify } from '../src/state/async-facade.ts';
import { InstallationObjectInventoryLogic } from '../src/state/object-inventory.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { attachStateDb } from '../src/state/schema-lifecycle.ts';
import { opaqueId } from '../src/work/admission.ts';
import type { RunId } from '../src/work/types.ts';
import { hostedInstallation, type HostedInstallation } from './helpers/installation-objects.ts';

/**
 * Every Durable Object an installation's work addresses is recorded in its
 * state store's inventory before anything can address it, so a host can
 * enumerate the installation's objects to export, restore or erase them.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = 1_800_000_000_000;
const TEAM = 'T_INVENTORY';
const CHANNEL = 'C_INVENTORY';
const DM = 'D_INVENTORY';

function turn(overrides: Partial<NormalizedSlackTurn> & Pick<NormalizedSlackTurn, 'messageTs'>): NormalizedSlackTurn {
  return {
    workspaceId: TEAM, channelId: CHANNEL, eventId: `Ev_${overrides.messageTs}`,
    text: 'Help', userId: 'U_MEMBER', threadTs: overrides.messageTs,
    source: 'app_mention', contextMode: 'thread', channelType: 'channel',
    ...overrides,
  };
}

function assignment(agentId = 'agent_owner', overrides: Partial<ResolvedAssignment> = {}): ResolvedAssignment {
  return {
    workspaceId: TEAM, channelId: CHANNEL, agentId, model: 'local-stub/inventory',
    runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
    agent: {
      id: agentId, kind: 'user', revision: 1, name: agentId, instructions: 'Help.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    },
    ...overrides,
  };
}

/** A DM, a channel root, a thread follow-up and an Agent ask answered by a guest. */
function slackWorkload(): TurnJob[] {
  const root = '1800000000.000100';
  return [
    {
      id: 'tj_dm', evtKey: 'evt:dm', msgKey: 'msg:dm',
      turn: turn({ messageTs: '1800000000.000050', channelId: DM, source: 'dm_message', channelType: 'im', contextMode: 'dm_history' }),
      assignment: assignment('agent_owner', { channelId: DM }),
    },
    { id: 'tj_root', evtKey: 'evt:root', msgKey: 'msg:root', turn: turn({ messageTs: root }), assignment: assignment() },
    {
      id: 'tj_followup', evtKey: 'evt:followup', msgKey: 'msg:followup',
      turn: turn({ messageTs: '1800000000.000200', threadTs: root, source: 'implicit_thread_reply' }),
      assignment: assignment(),
    },
    {
      id: 'tj_ask', evtKey: 'evt:ask', msgKey: 'msg:ask',
      turn: turn({
        messageTs: '1800000000.000300', threadTs: root, source: 'agent_mention',
        agentAsk: { fromAgentId: 'agent_owner', fromAgentName: 'Owner', originMessageTs: '1800000000.000200' },
      }),
      assignment: assignment('agent_guest', { threadGuest: true }),
    },
  ];
}

/** Durable Object namespaces that remember every name addressed through them. */
function recordingBindings() {
  const addressed: Array<{ binding: string; name: string }> = [];
  return {
    addressed,
    bindings: {
      TAG_STATE: { getByName: (name: string) => { addressed.push({ binding: 'TAG_STATE', name }); return {}; } },
      SLACK_THREAD_RUNNER: {
        getByName: (name: string) => { addressed.push({ binding: 'SLACK_THREAD_RUNNER', name }); return {}; },
      },
      [CHICKPEA_SLACK_AGENT_BINDING]: {
        idFromName: (name: string) => { addressed.push({ binding: CHICKPEA_SLACK_AGENT_BINDING, name }); return name; },
        get: () => ({ setName: async () => undefined, chickpeaStageTurnInput: async () => undefined }),
      },
    },
  };
}

function inventoryNames(installation: HostedInstallation): Set<string> {
  const names = new Set<string>();
  let cursor: string | null | undefined;
  do {
    const page = installation.stores.objectInventory.list({ cursor, limit: 2 });
    for (const object of page.objects) names.add(`${object.kind}:${object.name}`);
    cursor = page.nextCursor;
  } while (cursor);
  return names;
}

/** The installation's stores as a turn inside its state store reaches them. */
function promisifiedAppStores(installation: HostedInstallation): AppStores {
  const port = <L extends object>(logic: L) => promisify(logic, { close: () => undefined });
  const { stores } = installation;
  return {
    identity: port(stores.identity), config: port(stores.config), snapshots: port(stores.snapshots),
    slackState: port(stores.slack), settings: port(stores.settings), memory: port(stores.memory),
    routines: port(stores.routines), usage: port(stores.usage), work: port(stores.work), management: port(stores.management),
  } as unknown as AppStores;
}

/** Run one Slack turn the way an executor does, addressing objects through the real addressing functions. */
async function runSlackTurn(installation: HostedInstallation, job: TurnJob): Promise<void> {
  const { stores, env } = installation;
  stores.turnJobs.enqueue(job);
  // The state store hands the turn to its thread's runner, and later reaches
  // that runner again for its presentation, stop notices and observed status.
  assert.equal(stores.turnJobs.assignRunner(job.id), true);
  threadRunnerStub(env, slackAgentThreadKey(job.turn, job.assignment));
  stores.turnJobs.confirmRunner(job.id);
  const runnerKey = stores.turnJobs.runnerThreadKey(job.id, slackAgentThreadKey);
  assert.ok(runnerKey);
  threadRunnerStub(env, runnerKey);
  const runtimePlan = compileRuntimePlanV2({
    installation: installationOwnershipOf(env)!, turn: job.turn, assignment: job.assignment,
    instructions: 'Help.', memoryEpoch: 1,
  });
  const frozen = stores.turnJobs.freezeRuntimePlan(job.id, runtimePlan);
  const envelope = stores.turnJobs.prepareFlueDispatch(job.id, job.turn.text, {
    generation: job.id, executor: 'runner', runnerKey,
  });
  assert.equal(envelope.instanceId, frozen.instanceId);
  await stageSlackTurnInputOnAgentObject(env, CHICKPEA_SLACK_AGENT_BINDING, createSlackTurnInput({
    turnJobId: job.id, instanceId: envelope.instanceId, runtimePlan: frozen.runtimePlan,
  }));
  stores.turnJobs.recordFlueReceipt(job.id, {
    submissionId: `sub_${job.id}`, acceptedAt: '2027-01-15T08:00:00.000Z', uid: 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  });
  const observed = stores.turnJobs.matchFlueObservation(envelope.instanceId, `sub_${job.id}`);
  assert.equal(observed?.runnerKey, runnerKey);
  threadRunnerStub(env, observed.runnerKey!);
}

const ROUTINE_DRAFT: Extract<RoutineConfirmationDraft, { action: 'create' }> = {
  action: 'create',
  routineId: 'routine_inventory',
  definition: {
    name: 'Inventory steward', description: 'Post a status.', taskText: 'Post the project status.',
    triggerKind: 'schedule', scheduleInput: 'Every day at 9am',
    scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: '0 9 * * *' }),
    timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_channel_v1',
  },
  nextRunAt: 0,
  projectedDailyStarts: 1,
  reservations: [],
};

/** Admit and dispatch one routine attempt, returning the Flue instance its execution initializes. */
function runRoutineOccurrence(routines: RoutineStoreLogic, installationId: string, suffix: string): string {
  // The state store's routines run on the real clock.
  const now = Date.now();
  const nextRunAt = now + 3_600_000;
  const tokenHash = hashRoutineValue(`token-${suffix}`);
  const draft = {
    ...ROUTINE_DRAFT, routineId: `routine_${suffix}`, nextRunAt,
    reservations: [{ windowStart: nextRunAt, count: 1 }],
  };
  const previewHash = hashRoutineValue(JSON.stringify(draft));
  routines.putConfirmation({
    confirmationId: `rconfirm_${suffix}`, tokenHash, actorId: 'U_MEMBER', actorClass: 'member',
    workspaceId: TEAM, channelId: CHANNEL, draft, previewHash, expiresAt: now + 900_000,
  });
  const routine = routines.confirm({
    tokenHash, actorId: 'U_MEMBER', workspaceId: TEAM, channelId: CHANNEL, previewHash,
    idempotencyKey: `routine:confirm:${suffix}`,
  });
  const run = routines.createOccurrence({
    runId: `rrun_${suffix}`, idempotencyKey: `routine:${suffix}:slot`, routineId: routine.id,
    routineVersion: routine.version, scheduledFor: nextRunAt, triggerSource: 'run_now',
    requestedBy: 'U_MEMBER', queuedAt: now, deadlineAt: nextRunAt + 900_000,
  });
  const admission = routines.startAdmissionAttempt({
    occurrenceId: run.id, owner: 'heartbeat', leaseUntil: now + 120_000, invokeStartedAt: now + 1,
  });
  // As routine execution names an attempt's instance under its installation.
  const instanceId = scopedObjectName({ installationId }, opaqueId('routineagent', admission.attemptId));
  assert.equal(routines.prepareAgentDispatch({
    occurrenceId: run.id, attempt: admission.attempt, startedAt: now + 2,
    envelope: {
      schemaVersion: 1, attemptId: admission.attemptId, instanceId, idempotencyKey: admission.attemptId,
      message: 'Run the saved task.', initialData: { runtimePlan: 'frozen' },
    },
    resolvedAccessHash: 'a'.repeat(64), resolvedAgentId: 'agent_owner', resolvedAuthorityReceiptId: 'receipt',
    resolvedRunsAsMembershipId: 'membership_owner', model: 'anthropic/claude-haiku-4-5', traceId: `trace_${suffix}`,
  }), 'started');
  return instanceId;
}

test('every object a DM, a channel turn, a thread follow-up, an Agent ask and a routine address is in the inventory', async () => {
  const recording = recordingBindings();
  const installation = hostedInstallation('inst_inventory_a', recording.bindings);
  const neighbour = hostedInstallation('inst_inventory_b');
  for (const job of slackWorkload()) await runSlackTurn(installation, job);
  const routineInstance = runRoutineOccurrence(installation.stores.routines, installation.installationId, 'a');
  tagStateStub(installation.env);

  const names = inventoryNames(installation);
  const kindOf: Record<string, string> = {
    SLACK_THREAD_RUNNER: 'thread_runner',
    [CHICKPEA_SLACK_AGENT_BINDING]: 'slack_agent',
  };
  const addressed = recording.addressed.filter(({ binding }) => binding !== 'TAG_STATE');
  // Per turn: the runner at hand-off, for its presentation and for observed status; the transcript at staging.
  assert.equal(addressed.length, 4 * 4);
  for (const { binding, name } of addressed) {
    assert.ok(names.has(`${kindOf[binding]}:${name}`), `${binding} ${name} is in the inventory`);
  }
  // Routine execution initializes its attempt's instance by the envelope's ID.
  assert.ok(names.has(`routine_agent:${routineInstance}`));
  // The state store is implicit: its name is the installation's.
  assert.deepEqual(recording.addressed.filter(({ binding }) => binding === 'TAG_STATE').map(({ name }) => name),
    [installationObjectName(installation.env, 'singleton')]);
  // An owner's thread runner, its transcript and the guest's own transcript, per conversation.
  assert.deepEqual(installation.stores.objectInventory.counts(), { coding_worker: 0, routine_agent: 1, sandbox: 0, slack_agent: 3, thread_runner: 2 });
  for (const name of names) assert.match(name, /^[a-z_]+:i1~inst_inventory_a~/, 'every name is scoped to its installation');
  assert.deepEqual(neighbour.stores.objectInventory.counts(), { coding_worker: 0, routine_agent: 0, sandbox: 0, slack_agent: 0, thread_runner: 0 });
});

test('retention never prunes the inventory', async () => {
  const installation = hostedInstallation('inst_inventory_retention', recordingBindings().bindings);
  for (const job of slackWorkload()) await runSlackTurn(installation, job);
  runRoutineOccurrence(installation.stores.routines, installation.installationId, 'retention');
  for (const job of slackWorkload()) installation.stores.turnJobs.markDelivered(job.id);
  const before = inventoryNames(installation);

  // A year later: turn rows, conversation bindings and routine runs are all purged.
  const later = Date.now() + 400 * 24 * 60 * 60 * 1_000;
  const turns = new TurnJobStoreLogic(installation.db, () => later, installation.stores.objectInventory);
  turns.enqueue({ ...slackWorkload()[1]!, id: 'tj_later', evtKey: 'evt:later', msgKey: 'msg:later' });
  installation.stores.routines.transitionRun({
    occurrenceId: 'rrun_retention', from: ['running'], to: 'failed', at: Date.now(),
    failureClass: 'deadline_exceeded', publicError: 'The routine occurrence expired.',
  });
  new RoutineStoreLogic(installation.db, () => later).cleanupRetention();
  assert.equal(installation.db.get('SELECT COUNT(*) AS count FROM slack_agent_bindings')?.count, 0);
  assert.equal(installation.db.get("SELECT COUNT(*) AS count FROM routine_runs WHERE id = 'rrun_retention'")?.count, 0);
  assert.deepEqual([...before].filter((name) => !inventoryNames(installation).has(name)), []);
});

test('the backfill recovers the names that survive from before the inventory, and counts a lower bound of what cannot be named', async () => {
  const installation = hostedInstallation('inst_inventory_backfill', recordingBindings().bindings);
  // A release before the inventory wrote these rows: nothing recorded them.
  const legacyTurns = new TurnJobStoreLogic(installation.db);
  const legacyRoutines = new RoutineStoreLogic(installation.db);
  const legacy = { ...installation, stores: { ...installation.stores, turnJobs: legacyTurns } };
  for (const job of slackWorkload().slice(1, 3)) await runSlackTurn(legacy, job);
  const routineInstance = runRoutineOccurrence(legacyRoutines, installation.installationId, 'backfill');
  // Fixture rows only: their parents are not part of this test.
  installation.db.exec('PRAGMA foreign_keys = OFF');
  // A thread whose ownership moved once: two incarnations of its runner.
  installation.db.run(
    `INSERT INTO config_agent_thread_routes (workspace_id, channel_id, thread_ts, agent_id, agent_generation,
       owner_incarnation, revision, updated_at) VALUES (?, ?, ?, ?, 1, 2, 1, ?)`,
    TEAM, CHANNEL, '1700000000.000100', CHICKPEA_AGENT_ID, NOW,
  );
  // The Work ledger saw an instance run whose name aged out of every store.
  installation.db.run(
    `INSERT INTO run_executions (id, run_id, attempt_number, fencing_token, executor_kind, agent_name,
       flue_instance_ref, canonical_model, model_invocation_status, started_at, finished_at, outcome)
     VALUES ('rexec_gone', 'run_gone', 1, 1, 'agent', 'chickpea-slack-v2', ?, 'm', 'settled', ?, ?, 'succeeded')`,
    opaqueId('flueinstance', scopedObjectName({ installationId: installation.installationId }, 'agent_gone')), NOW, NOW,
  );
  installation.db.exec('PRAGMA foreign_keys = ON');
  assert.deepEqual(installation.stores.objectInventory.counts(), { coding_worker: 0, routine_agent: 0, sandbox: 0, slack_agent: 0, thread_runner: 0 });

  const backfill = installation.stores.objectInventory.backfill();
  assert.deepEqual(backfill, {
    // One thread's runner from the turns, plus incarnations 1 and 2 of the routed thread.
    recovered: { coding_worker: 0, routine_agent: 1, sandbox: 0, slack_agent: 1, thread_runner: 3 },
    // The Flue instance the Work ledger saw. A runner whose turns aged out
    // leaves no reference anywhere, so the residue is a lower bound.
    unknownResidue: 1,
  });
  const names = inventoryNames(installation);
  assert.ok(names.has(`routine_agent:${routineInstance}`));
  const root = slackWorkload()[1]!;
  assert.ok(names.has(`thread_runner:${installationObjectName(installation.env, slackAgentThreadKey(root.turn, root.assignment))}`));
  assert.ok(names.has(`thread_runner:${installationObjectName(installation.env, `${TEAM}:${CHANNEL}:1700000000.000100:owner-i2`)}`));
  assert.deepEqual(installation.stores.objectInventory.backfill(), backfill, 'a repeat changes nothing');
});

test('an approval typed after the thread passed to a new Agent leaves no Flue instance the inventory cannot name', async () => {
  // Hosted run 4: Chickpea created an Agent in its DM, the thread passed to
  // that Agent (owner incarnation 2), and the person typed "approve". The
  // host applied the proposal without a Flue instance, yet the Work ledger
  // gave the execution a reference made up from Chickpea's thread key: a
  // census counted it as residue that erasure could not reach.
  const installation = hostedInstallation('inst_inventory_approval', recordingBindings().bindings);
  const root = '1800000001.000100';
  const chickpea = assignment(CHICKPEA_AGENT_ID, { channelId: DM });
  const dmTurn = (messageTs: string, text: string): NormalizedSlackTurn => turn({
    messageTs, threadTs: root, channelId: DM, source: 'dm_message', channelType: 'im', contextMode: 'dm_history', text,
  });
  await runSlackTurn(installation, {
    id: 'tj_create', evtKey: 'evt:create', msgKey: 'msg:create',
    turn: dmTurn(root, 'Create a tips Agent with a weekly schedule'), assignment: chickpea,
  });
  // The handoff: the thread's route names the new Agent, its second owner.
  installation.db.exec('PRAGMA foreign_keys = OFF');
  installation.db.run(
    `INSERT INTO config_agent_thread_routes (workspace_id, channel_id, thread_ts, agent_id, agent_generation,
       owner_incarnation, revision, updated_at) VALUES (?, ?, ?, 'agent_tips', 1, 2, 1, ?)`,
    TEAM, DM, root, NOW,
  );
  installation.db.exec('PRAGMA foreign_keys = ON');

  const approve: NormalizedSlackTurn = {
    ...dmTurn('1800000001.000300', 'approve'),
    actorMembershipId: 'membership_owner',
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
    managementApprovalProposalId: 'proposal_tips_schedule',
  };
  const work = promisify(installation.stores.work, { close: () => undefined });
  const admitted = await work.admitShadowRun(prepareSlackShadowAdmission({
    turn: approve, assignment: chickpea, sourceVisibility: 'private', admittedAt: Date.now(),
  }));
  const delivered: string[] = [];
  const client = {
    chat: {
      postMessage: async (input: { text: string }) => {
        delivered.push(input.text);
        return { ok: true, channel: DM, ts: '1800000001.000400' };
      },
    },
  } as unknown as WebClient;
  await runTurn(approve, chickpea, installation.env, {
    client,
    turnId: 'tj_approve',
    runId: admitted.run.id,
    workStore: work,
    settingsStore: promisify(installation.stores.settings, { close: () => undefined }),
    publicUrl: null,
    usageRecordingEnabled: false,
    agentPrompt: async () => assert.fail('an approval never reaches the Agent'),
    invokeManagementApproval: async () => ({ kind: 'message', text: 'Applied the approved changes.' }),
  });
  assert.deepEqual(delivered, ['Applied the approved changes.']);
  const [execution, ...others] = await work.listRunExecutions(admitted.run.id as RunId);
  assert.deepEqual(others, []);
  assert.equal(execution?.rawSettlementStatus, 'host_management_approval_succeeded');
  assert.equal(execution?.flueInstanceRef, null, 'the host ran no Flue instance');

  // Every Flue instance the Work ledger references is one the inventory names.
  const named = new Set([...inventoryNames(installation)]
    .filter((name) => /^(slack_agent|routine_agent):/.test(name))
    .map((name) => opaqueId('flueinstance', name.slice(name.indexOf(':') + 1))));
  const referenced = installation.db.all('SELECT flue_instance_ref FROM run_executions WHERE flue_instance_ref IS NOT NULL')
    .map((row) => String(row.flue_instance_ref));
  assert.deepEqual(referenced.filter((ref) => !named.has(ref)), []);
  assert.equal(installation.stores.objectInventory.backfill().unknownResidue, 0);

  // An approval an earlier release ran kept that made-up reference: still no residue.
  installation.db.exec('PRAGMA foreign_keys = OFF');
  installation.db.run(
    `INSERT INTO run_executions (id, run_id, attempt_number, fencing_token, executor_kind, agent_name,
       flue_instance_ref, canonical_model, model_invocation_status, started_at, finished_at, raw_settlement_status, outcome)
     VALUES ('rexec_legacy_approval', 'run_legacy_approval', 1, 1, 'agent', ?, ?, 'm', 'not_invoked', ?, ?,
       'host_management_approval_succeeded', 'succeeded')`,
    CHICKPEA_AGENT_ID, opaqueId('flueinstance', slackAgentThreadKey(approve, chickpea)), NOW, NOW,
  );
  installation.db.exec('PRAGMA foreign_keys = ON');
  assert.equal(installation.stores.objectInventory.backfill().unknownResidue, 0);
});

test('a hosted turn never freezes a runtime plan its recording store did not', async () => {
  const installation = hostedInstallation('inst_inventory_unrecorded', recordingBindings().bindings);
  const job = slackWorkload()[1]!;
  let prompted = false;
  await assert.rejects(
    runTurn(job.turn, job.assignment, installation.env, {
      client: {} as WebClient,
      turnId: job.id,
      publicUrl: null,
      usageRecordingEnabled: false,
      settingsStore: promisify(installation.stores.settings, { close: () => undefined }),
      appStores: promisifiedAppStores(installation),
      agentPrompt: async () => { prompted = true; throw new Error('not reached'); },
    }),
    (error: unknown) => error instanceof InstallationContextError && /record its runtime plan/.test(error.message),
  );
  assert.equal(prompted, false);
  assert.equal(installation.stores.objectInventory.counts().slack_agent, 0);
});

test('standalone keeps no inventory and records nothing', () => {
  const db = openStateDb(':memory:');
  try {
    const inventory = new InstallationObjectInventoryLogic(db, {});
    const turns = new TurnJobStoreLogic(db, () => NOW, inventory);
    turns.enqueue(slackWorkload()[1]!);
    assert.equal(inventory.enabled, false);
    assert.equal(db.get("SELECT name FROM sqlite_master WHERE name = 'installation_object_inventory'"), undefined);
    assert.throws(() => inventory.list(), InstallationContextError);
  } finally {
    db.close();
  }
});

test('a warm attach issues no schema work for the inventory and keeps recording', () => {
  const db = openStateDb(':memory:');
  try {
    const env = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_inventory_warm' });
    new InstallationObjectInventoryLogic(db, env);
    const statements: string[] = [];
    const attached = attachStateDb(db);
    const watched = { ...attached, schema: 'attach' as const, exec: (sql: string) => { statements.push(sql); attached.exec(sql); } };
    const inventory = new InstallationObjectInventoryLogic(watched, env);
    assert.deepEqual(statements, []);
    inventory.recordThreadRunner(`${TEAM}:${CHANNEL}:1800000000.000100:owner-i1`);
    assert.deepEqual(inventory.counts(), { coding_worker: 0, routine_agent: 0, sandbox: 0, slack_agent: 0, thread_runner: 1 });
  } finally {
    db.close();
  }
});

test('an installation records only instances its own name scopes', () => {
  const installation = hostedInstallation('inst_inventory_own');
  assert.throws(
    () => installation.stores.objectInventory.recordAgentInstance('slack_agent', 'i1~inst_other~agent_x'),
    InstallationContextError,
  );
  assert.throws(
    () => installation.stores.objectInventory.recordAgentInstance('routine_agent', 'routineagent_unscoped'),
    InstallationContextError,
  );
});

/**
 * Every place Core addresses a Durable Object, pinned by its code (the call's
 * line, and the next one when the call continues there), with what covers
 * the names it addresses under installation tenancy. A new site, or a site
 * whose code changes, fails here until its names are recorded where they are
 * first persisted and the site is listed again.
 */
const ADDRESSING_SITES: Record<string, { covered: string; sites: readonly string[] }> = {
  'config/state-rpc.ts': {
    covered: 'state store, named after the installation',
    sites: ['return namespace.getByName(tagStateInstanceName(env));'],
  },
  'slack/thread-runner-rpc.ts': {
    covered: 'thread_runner, recorded at turn enqueue',
    sites: ['return namespace.getByName(installationObjectName(env, threadKey));'],
  },
  'agents/turn-input.ts': {
    covered: 'slack_agent, recorded when the turn freezes its plan',
    sites: ['const stub = binding.get(binding.idFromName(input.instanceId));'],
  },
  'slack/bounded-agent-observation.ts': {
    covered: 'slack_agent of a dispatched envelope',
    sites: ['const stub = binding.get(binding.idFromName(instanceId));'],
  },
  'slack/flue-dispatch.ts': {
    covered: 'slack_agent of a dispatched envelope (Flue init)',
    sites: ['return init(agent, { id: target.instanceId, ...(target.uid === undefined ? {} : { uid: target.uid }) });'],
  },
  'routines/execution.ts': {
    covered: 'routine_agent, recorded with the attempt envelope (Flue init)',
    sites: [
      'const handle = dependencies.handle ?? init(ChickpeaRoutineExecution, { id: prepared.envelope.instanceId,',
      "const attempt = handle ?? init( (await import('../agents/routine-execution.ts')).ChickpeaRoutineExecution,",
    ],
  },
  'state/pending-work.ts': {
    covered: 'routine_agent of a persisted envelope (Flue init)',
    sites: ['await init(ChickpeaRoutineExecution, { id: agent.target.instanceId,'],
  },
  'state/installation-objects.ts': {
    covered: 'host functions, recorded names only',
    sites: [
      'return namespace.getByName(object.name) as AnyObjectHostRpc;',
      'return namespace.get(namespace.idFromName(object.name)) as AnyObjectHostRpc;',
    ],
  },
  'admin/routes.ts': {
    covered: 'gateway session: standalone only',
    sites: [
      "await namespace.get(namespace.idFromName('deployment')).restart();",
      "const stub = namespace.get(namespace.idFromName('deployment'));",
    ],
  },
  'slack/gateway/cloudflare-session.ts': {
    covered: 'gateway session: returns early under tenancy',
    sites: ["await namespace.get(namespace.idFromName('deployment')).wake();"],
  },
  'sandbox/sandbox-object.ts': {
    covered: 'sandbox, recorded by sandboxStub (the only opener of a named Sandbox) before it opens one',
    sites: ['return getSandbox(binding as Parameters<typeof getSandbox>[0], name, options as Parameters<typeof getSandbox>[2]);'],
  },
  'sandbox/egress-outbound.ts': {
    covered: "sandbox: the container's own, already recorded when its workspace was opened",
    sites: ['const stub = platformEnv.SANDBOX.get(platformEnv.SANDBOX.idFromString(ctx.containerId));'],
  },
  'sandbox/hosted-limits.ts': {
    covered: "sandbox: a lease's key is the Sandbox's own ID, which it wrote into its installation's store",
    sites: ['const stub = namespace.get(namespace.idFromString(key));'],
  },
  'sandbox/select.ts': {
    covered: 'Container probe: one deployment object that holds no installation data',
    sites: ['const stub = namespace.get(namespace.idFromName(SANDBOX_CONTAINER_PROBE_NAME));'],
  },
  'sandbox/coding-task-stop.ts': {
    covered: 'coding_worker of a task record, written only after the worker was recorded',
    sites: ['const stub = binding.get(binding.idFromName(instanceId));'],
  },
  'agents/coding-worker-staging.ts': {
    covered: 'coding_worker, recorded by the coordinator just before it stages the binding',
    sites: ['const stub = namespace.get(namespace.idFromName(instanceId));'],
  },
  'agents/coding-worker-task.ts': {
    covered: 'coding_worker, recorded before its task record and dispatch (Flue init)',
    sites: ['return init(CodingWorker, { id: instanceId });'],
  },
};

const ADDRESSING = /\.(?:getByName|idFromName|idFromString|newUniqueId)\(|\b(?:getAgentByName|getServerByName|getSandbox)\(|(?<![.\w])init\(/g;

test('every Durable Object addressing site in Core is covered by the inventory or never runs under tenancy', () => {
  const sourceRoot = join(ROOT, 'src');
  const found: Record<string, string[]> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts')) {
        const lines = readFileSync(path, 'utf8').split('\n');
        lines.forEach((line, index) => {
          // Comment lines name these calls too; only code addresses objects.
          if (/^\s*(?:\*|\/\/|\/\*)/.test(line)) return;
          const site = line.trim();
          // A call that continues on the next line is pinned with it, which carries its first argument.
          const pinned = /[({]$/.test(site) ? `${site} ${lines[index + 1]?.trim() ?? ''}` : site;
          for (const _match of line.match(ADDRESSING) ?? []) (found[relative(sourceRoot, path)] ??= []).push(pinned);
        });
      }
    }
  };
  walk(sourceRoot);
  assert.deepEqual(
    found,
    Object.fromEntries(Object.entries(ADDRESSING_SITES).map(([file, { sites }]) => [file, [...sites]])),
    'record a new addressing site\'s names in the object inventory, then list it here',
  );
});

/**
 * Every place Core names a Flue instance: derives one from a runtime plan,
 * or references one in the Work ledger. A name is safe only when it comes
 * from a plan its recording store froze (TurnJobStore.freezeRuntimePlan) or
 * an envelope its store persisted, both recorded in the inventory first. A
 * reference made up from anything else (a thread key, a fallback) names an
 * object nothing recorded: a census counts it as residue erasure cannot
 * reach. A new site, or a site whose code changes, fails here until it is
 * listed again with what records its name.
 */
const FLUE_INSTANCE_NAMING_SITES: Record<string, { covered: string; sites: readonly string[] }> = {
  'slack/turn-jobs.ts': {
    covered: 'recorded in the transaction that freezes the plan',
    sites: ['freezeRuntimePlan: deriveRuntimePlanInstanceId(plan)'],
  },
  'slack/run-turn.ts': {
    covered: 'standalone only: a hosted turn without the recording store is refused before this',
    sites: [
      "createSlackShadowLifecycle input: opaqueId('flueinstance', runtimePlanDecision.instanceId)",
      'freezeRuntimePlanForTurn: deriveRuntimePlanInstanceId(candidate)',
    ],
  },
  'agents/turn-input.ts': {
    covered: 'compares a staged plan with the instance it was staged for; names nothing',
    sites: ['resolveSlackTurnRenderInput: deriveRuntimePlanInstanceId(input.initialData)'],
  },
  'routines/execution.ts': {
    covered: "the attempt envelope's instance, recorded with the envelope",
    sites: ["createWorkExecutionLifecycle input: opaqueId('flueinstance', envelope.instanceId)"],
  },
  'work/trace-correlation.ts': {
    covered: "a log correlation of a running Flue instance's own observation",
    sites: ["emitRuntimeCorrelation: opaqueId('flueinstance', observation.instanceId)"],
  },
};

test('every Flue instance Core names comes from a recorded plan or envelope, never a fallback', () => {
  const sourceRoot = join(ROOT, 'src');
  const found: Record<string, string[]> = {};
  const enclosing = (node: ts.Node, source: ts.SourceFile): string => {
    for (let current = node.parent; current; current = current.parent) {
      if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) {
        return current.name.getText(source);
      }
      // An argument object of a named call (`createX({ ... })`).
      if (ts.isObjectLiteralExpression(current) && ts.isCallExpression(current.parent) &&
          ts.isIdentifier(current.parent.expression)) {
        return `${current.parent.expression.text} input`;
      }
      if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) &&
          (ts.isArrowFunction(current.initializer!) || ts.isFunctionExpression(current.initializer!))) {
        return current.name.text;
      }
    }
    return '(module)';
  };
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!path.endsWith('.ts')) continue;
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const [first, second] = node.arguments;
          const site = node.expression.text === 'deriveRuntimePlanInstanceId'
            ? `deriveRuntimePlanInstanceId(${node.arguments.map((arg) => arg.getText(source)).join(', ')})`
            : node.expression.text === 'opaqueId' && first && ts.isStringLiteral(first) && first.text === 'flueinstance'
              ? `opaqueId('flueinstance', ${second?.getText(source) ?? ''})`
              : undefined;
          if (site) {
            (found[relative(sourceRoot, path)] ??= []).push(`${enclosing(node, source)}: ${site}`);
            // A Work ledger reference names exactly one recorded instance: no fallback, no computed key.
            if (site.startsWith('opaqueId')) {
              assert.match(second?.getText(source) ?? '', /^[A-Za-z_]\w*(?:\.\w+)*\.instanceId$/,
                `${relative(sourceRoot, path)} references a Flue instance it did not take from a recorded plan or envelope`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  };
  walk(sourceRoot);
  assert.deepEqual(
    found,
    Object.fromEntries(Object.entries(FLUE_INSTANCE_NAMING_SITES).map(([file, { sites }]) => [file, [...sites]])),
    'take a new Flue instance name from a recorded plan or envelope, then list it here',
  );
});
