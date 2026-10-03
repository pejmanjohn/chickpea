import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
import { tagStateStub } from '../src/config/state-rpc.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { hashRoutineValue } from '../src/routines/ids.ts';
import { RoutineStoreLogic } from '../src/routines/store.ts';
import type { RoutineConfirmationDraft } from '../src/routines/types.ts';
import { CHICKPEA_SLACK_AGENT_BINDING } from '../src/slack/bounded-agent-observation.ts';
import { slackAgentThreadKey } from '../src/slack/thread-key.ts';
import { threadRunnerStub } from '../src/slack/thread-runner-rpc.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { InstallationObjectInventoryLogic } from '../src/state/object-inventory.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { attachStateDb } from '../src/state/schema-lifecycle.ts';
import { opaqueId } from '../src/work/admission.ts';
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
