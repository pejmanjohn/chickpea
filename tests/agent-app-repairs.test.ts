import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mock, test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Keep the ambient stores a relay drain opens off any on-disk database.
process.env.SLACK_STATE_DB_PATH = ':memory:';

import type { ResolvedAssignment } from '../src/config/types.ts';
import type { SlackStateStore } from '../src/slack/claim-store.ts';
import {
  cacheSlackInstallationExecutionContexts,
  ownBotRun,
  type SlackInstallationExecutionContext,
  SlackInstallationUnavailableError,
  type SlackRunSpeaker,
} from '../src/slack/installation-execution.ts';
import { createLedgerSlackRunHandler } from '../src/slack/ledger-turn-driver.ts';
import { localSlackStateStore } from '../src/slack/local-state-store.ts';
import { wakeNodeTurnRelay } from '../src/slack/node-turn-relay.ts';
import type { SlackSpeaker } from '../src/slack/speaker.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { type PendingTurnJob, TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import type { InteractiveRunClaim, WorkStore } from '../src/work/types.ts';

const OWN_BOT: SlackSpeaker = { kind: 'own_bot', botUserId: 'USUPPORTBOT' };

/** Turns of Support: one stored with its app's own bot, one with Chickpea's, and one stored before speakers were. */
function jobs(): TurnJob[] {
  const speakers: Array<[string, SlackSpeaker | undefined]> = [['own', OWN_BOT], ['chickpea', { kind: 'chickpea_as_agent' }], ['legacy', undefined]];
  return speakers.map(([name, speaker], index) => {
    const ts = `1900000000.00010${index}`;
    const turn: NormalizedSlackTurn = {
      workspaceId: `T_${name.toUpperCase()}`, channelId: `C${name.toUpperCase()}`, eventId: `Ev${name}`, text: 'hello', userId: 'U1',
      messageTs: ts, threadTs: ts, source: 'app_mention', contextMode: 'thread', channelType: 'channel',
      ...(speaker ? { speaker } : {}),
    };
    return {
      id: `turn_${name}`, evtKey: `evt_${name}`, msgKey: `msg_${name}`, turn, runId: `run_${name}`, executionAuthority: 'ledger',
      assignment: { workspaceId: turn.workspaceId, channelId: turn.channelId, agentId: 'agent_support', agent: { id: 'agent_support', kind: 'user' } } as unknown as ResolvedAssignment,
    };
  });
}

const OWN_RUN: SlackRunSpeaker = { agentId: 'agent_support', speaker: OWN_BOT };

/** A resolver that records each run it is asked for and refuses, so nothing past the resolution runs. */
function refusingResolver() {
  const asked: Array<[string, SlackRunSpeaker | undefined]> = [];
  const resolve = async (workspaceId: string, run?: SlackRunSpeaker): Promise<SlackInstallationExecutionContext> => {
    asked.push([workspaceId, run]);
    throw new SlackInstallationUnavailableError(workspaceId, 'test_refused', { retryable: false });
  };
  return { asked, resolve };
}

test("only a run stored with its app's own bot asks for that bot; Chickpea's and older runs keep the installation's", () => {
  const [own, chickpea, legacy] = jobs();
  assert.deepEqual(ownBotRun(own!), OWN_RUN);
  assert.equal(ownBotRun(chickpea!), undefined);
  assert.equal(ownBotRun(legacy!), undefined);
  assert.equal(ownBotRun({ ...chickpea!, turn: { speaker: { kind: 'unavailable', reason: 'app_removed' } } }), undefined);
});

test("the resolver cache passes a run's speaker through and keeps each bot's context apart", async () => {
  const calls: Array<SlackRunSpeaker | undefined> = [];
  const cached = cacheSlackInstallationExecutionContexts(async (workspaceId, run) => {
    calls.push(run);
    return { workspaceId, botUserId: run?.speaker?.kind === 'own_bot' ? run.speaker.botUserId : 'UBOT' } as SlackInstallationExecutionContext;
  });
  assert.equal((await cached('T1')).botUserId, 'UBOT');
  assert.equal((await cached('T1', OWN_RUN)).botUserId, 'USUPPORTBOT');
  assert.equal((await cached('T1', OWN_RUN)).botUserId, 'USUPPORTBOT');
  assert.equal((await cached('T1')).botUserId, 'UBOT');
  assert.deepEqual(calls, [undefined, OWN_RUN], 'each is resolved once');
});

test("a delivered turn still names its app's own bot to a repair while its row is retained", async () => {
  const db = openStateDb(':memory:');
  try {
    const store = new TurnJobStoreLogic(db, () => 1_900_000_000_000);
    for (const job of jobs()) store.enqueue(job);
    store.markDelivered('turn_own');
    assert.deepEqual(store.ownBotRun('turn_own'), OWN_RUN);
    const local = localSlackStateStore({ turnJobs: store, slack: {} as never, work: {} as never, presentations: {} as never });
    assert.deepEqual(await local.ownBotRun!('turn_own'), OWN_RUN, "the Node relay's state store names it too");
    assert.equal(await local.ownBotRun!('turn_chickpea'), undefined);
    assert.equal(store.ownBotRun('turn_chickpea'), undefined);
    assert.equal(store.ownBotRun('turn_legacy'), undefined);
    assert.equal(store.ownBotRun('turn_missing'), undefined);
  } finally {
    db.close();
  }
});

test("the ledger driver resolves a run stored with its app's own bot as that bot, and every other run as before", async () => {
  const { asked, resolve } = refusingResolver();
  for (const job of jobs()) {
    const handler = createLedgerSlackRunHandler({
      work: {} as WorkStore,
      turns: {
        getPendingByRunId: async () => ({ ...job, attempts: 0, progress: {} }) as PendingTurnJob,
        markRecoveryRequired: async () => undefined,
      } as never,
      resolveInstallation: resolve,
    });
    assert.equal((await handler({ run: { id: job.runId }, binding: { adapterKind: 'slack' } } as InteractiveRunClaim)).kind, 'recovery_required');
  }
  assert.deepEqual(asked, [['T_OWN', OWN_RUN], ['T_CHICKPEA', undefined], ['T_LEGACY', undefined]]);
});

test("the Node relay runs, and retries the cleanup of, a run stored with its app's own bot as that bot; every other run as before", async () => {
  const pending = jobs().map((job) => ({ ...job, attempts: 0, progress: { slackInteraction: {} } }) as unknown as PendingTurnJob);
  let listed = false;
  const noop = async () => undefined;
  const state = {
    listPendingTurns: async () => {
      if (listed) return [];
      listed = true;
      return pending;
    },
    turnJobView: async (id: string) => ({ status: 'pending', job: pending.find((job) => job.id === id) }),
    listPendingSlackInteractionCleanups: async () => pending,
    freezeRuntimePlan: noop, prepareFlueDispatch: noop, reconcileFlueExistingInstance: noop, recordFlueReceipt: noop,
    recordFlueSettlement: noop, matchFlueObservation: noop, markTurnRecoveryRequired: noop, recordTurnAttempt: noop,
    recordInteractionIntent: noop, recordSlackInteractionProgress: noop, markTurnDelivered: noop, discardTurn: noop, setActiveWork: noop,
  } as unknown as SlackStateStore;
  const { asked, resolve } = refusingResolver();
  mock.method(console, 'warn', () => undefined);
  mock.method(console, 'error', () => undefined);
  try {
    await wakeNodeTurnRelay(undefined, {
      state,
      work: { claimNextInteractiveRun: async () => undefined } as unknown as WorkStore,
      executeTurn: noop as never,
      resolveInstallation: resolve,
    });
  } finally {
    mock.restoreAll();
  }
  const runsFor = (workspaceId: string) => [...new Set(asked.filter(([asking]) => asking === workspaceId).map(([, run]) => JSON.stringify(run ?? null)))];
  assert.deepEqual(runsFor('T_OWN'), [JSON.stringify(OWN_RUN)], "its turn and its cleanup ask only for the app's own bot");
  assert.deepEqual(runsFor('T_CHICKPEA'), ['null'], 'as the installation, as before');
  assert.deepEqual(runsFor('T_LEGACY'), ['null'], 'as the installation, as before');
  assert.ok(asked.filter(([asking]) => asking === 'T_OWN').length >= 2, 'both the turn and its cleanup asked');
});

/** A production function of src/cloudflare.ts, evaluated with `collaborators` as the names it reads. */
function cloudflareFunction<T>(name: string, collaborators: Record<string, unknown>): T {
  const source = ts.createSourceFile('cloudflare.ts', readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `production ${name} exists`);
  const compiled = ts.transpileModule(`${declaration.getText(source)}\n${name}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(compiled, collaborators) as T;
}

test("the Cloudflare state store repairs, and ends welcomes of, a run stored with its app's own bot as that bot; every other run as before", async () => {
  const db = openStateDb(':memory:');
  try {
    const turnJobs = new TurnJobStoreLogic(db, () => 1_900_000_000_000);
    for (const job of jobs()) turnJobs.enqueue(job);
    const presentations = jobs().map((job) => ({ runId: job.runId, turnJobId: job.id, root: { workspaceId: job.turn.workspaceId } }));
    const asked: Array<[string, SlackRunSpeaker | undefined]> = [];
    const resolve = async (workspaceId: string, run?: SlackRunSpeaker) => {
      asked.push([workspaceId, run]);
      return { client: {} } as SlackInstallationExecutionContext;
    };
    type Resolving = { resolveClient(workspaceId: string, turnJobId: string): Promise<unknown> };
    const resolveEach = async ({ resolveClient }: Resolving) => {
      for (const presentation of presentations) await resolveClient(presentation.root.workspaceId, presentation.turnJobId);
    };
    const repairs = cloudflareFunction<(...args: unknown[]) => Promise<unknown>>('drainTerminalPresentationRepairs', {
      MAX_TURN_DRAIN_BATCH: 10,
      localSlackPresentationState: () => ({}),
      drainSlackPresentationRepairs: async (options: Resolving) => resolveEach(options),
    });
    await repairs({ presentations: { listAutoRepairableV3: () => presentations }, turnJobs }, {}, resolve);
    const expected = [['T_OWN', OWN_RUN], ['T_CHICKPEA', undefined], ['T_LEGACY', undefined]];
    assert.deepEqual(asked, expected, 'terminal repairs');

    asked.length = 0;
    const receipts = cloudflareFunction<(...args: unknown[]) => Promise<unknown>>('drainCloudflareManagementReceipts', {
      localSlackPresentationState: () => ({}),
      drainManagementReceiptOutbox: async (options: { onTerminalFailure(record: object): Promise<void> }) => options.onTerminalFailure({}),
      failAgentWelcomeTurn: async (_record: object, presentation: Resolving) => resolveEach(presentation),
    });
    await receipts({ turnJobs, work: {}, management: {}, config: {} }, {}, resolve);
    assert.deepEqual(asked, expected, "a welcome's presentation, closed when its delivery is given up");
  } finally {
    db.close();
  }
});
