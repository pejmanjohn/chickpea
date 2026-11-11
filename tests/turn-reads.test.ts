import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveRuntimePlanInstanceId, type RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import {
  CfConfigStore,
  CfMemoryStateStore,
  CfSettingsStore,
  CfTurnJobsForRunner,
  CfWorkStore,
} from '../src/config/cf-state-proxies.ts';
import { UnknownAgentError } from '../src/config/errors.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { resolveModelCredentialAttribution, rotateInstallationModelCredential } from '../src/config/model-credential-refs.ts';
import { configurePlatformFunding, resetPlatformFundingForTests } from '../src/config/platform-funding.ts';
import { PROVIDER_KEY_IDS } from '../src/config/provider-key-ids.ts';
import { describeProviderKeySources, invalidateProviderKeyCache, PROVIDER_KEY_SETTING_KEYS, resolveProviderApiKey } from '../src/config/provider-keys.ts';
import type { ModelCredentialStore } from '../src/config/settings-store.ts';
import type { AppStores, PlatformEnv } from '../src/config/state-backend.ts';
import type { StateRpcResult, TagStateRpc } from '../src/config/state-rpc.ts';
import { answerStateReads, STATE_READ_BATCH_MAX, TURN_READS_MAX_AGE_MS, TurnReads } from '../src/config/turn-read-batch.ts';
import { endTurnReads, withTurnReads, type StateRead } from '../src/config/turn-reads.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { prepareMemoryTurn } from '../src/memory/runtime.ts';
import { freezeRuntimePlanForTurn } from '../src/slack/run-turn.ts';
import type { PendingTurnJob } from '../src/slack/turn-jobs.ts';
import { prefetchTurnReads, turnPlanReads } from '../src/slack/turn-plan-reads.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { useDeploymentKeyring } from './helpers/deployment-keyring.ts';
import { EVERY_PROVIDER_FUNDED, NO_RUN_FEES } from './helpers/platform-funding.ts';
import {
  ALICE,
  READY_AGENT,
  SLACK_FIXTURES,
  withRunPlanLane,
  type RunPlanLane,
  type SlackFixture,
} from './helpers/run-plan-lane.ts';

type Answer = StateRpcResult<unknown>;
type Answered = Array<readonly [StateRead, Answer | null]>;

const okAnswer = <T>(value: T): StateRpcResult<T> => ({ ok: true, value });

/** A read's own RPC, counted. */
function rpcOf(sent: string[], label: string, value: unknown) {
  return async (): Promise<Answer> => {
    sent.push(label);
    return okAnswer(value);
  };
}

// Defect caught: a batched Agent read serving the lease check's re-read, so a
// change made while the turn prepared is never seen before its run.
test("a prefetched read answers the turn's first identical read; a later one reads the state store", async () => {
  const sent: string[] = [];
  const reads = new TurnReads(Promise.resolve<Answered>([
    [{ method: 'configGetAgent', args: ['agent_a'] }, okAnswer({ id: 'agent_a', revision: 1 })],
  ]));
  assert.deepEqual(await reads.read('configGetAgent', ['agent_a'], rpcOf(sent, 'agent', { id: 'agent_a', revision: 2 })),
    okAnswer({ id: 'agent_a', revision: 1 }));
  assert.deepEqual(await reads.read('configGetAgent', ['agent_a'], rpcOf(sent, 'agent', { id: 'agent_a', revision: 2 })),
    okAnswer({ id: 'agent_a', revision: 2 }), 'the second read is the state store\'s');
  await reads.read('configGetAgent', ['agent_b'], rpcOf(sent, 'other agent', null));
  assert.deepEqual(sent, ['agent', 'other agent']);
});

// Defect caught: kept reads answering for the whole run on a path that never
// reaches dispatch preparation, the only place that ends them.
test('kept reads stop answering once they are older than their maximum age', async () => {
  const sent: string[] = [];
  let now = 1_000;
  const reads = new TurnReads(Promise.resolve<Answered>([
    [{ method: 'settingGetMany', args: [['a']] }, okAnswer(['kept'])],
    [{ method: 'configGetAgent', args: ['agent_a'] }, okAnswer({ id: 'agent_a', revision: 1 })],
  ]), () => now);
  assert.deepEqual(await reads.read('settingGet', ['a'], rpcOf(sent, 'a', 'live')), okAnswer('kept'));
  now += TURN_READS_MAX_AGE_MS + 1;
  assert.deepEqual(await reads.read('configGetAgent', ['agent_a'], rpcOf(sent, 'agent', { id: 'agent_a', revision: 2 })),
    okAnswer({ id: 'agent_a', revision: 2 }), 'an old once-only answer is not used');
  assert.deepEqual(await reads.read('settingGet', ['a'], rpcOf(sent, 'a', 'live')), okAnswer('live'),
    'old settings are read again');
  assert.deepEqual(sent, ['agent', 'a']);
});

// Defects caught: settings answered only for the exact key list batched, or
// read again for every reader; a key outside the batch read on every read.
test('one batched settings read answers every settings read, single or many, until it ends', async () => {
  const sent: string[] = [];
  const reads = new TurnReads(Promise.resolve<Answered>([
    [{ method: 'settingGetMany', args: [['a', 'b', 'c']] }, okAnswer(['1', null, '3'])],
  ]));
  assert.deepEqual(await reads.read('settingGet', ['b'], rpcOf(sent, 'b', 'live')), okAnswer(null));
  assert.deepEqual(await reads.read('settingGetMany', [['c', 'a']], rpcOf(sent, 'c,a', [])), okAnswer(['3', '1']));
  assert.deepEqual(await reads.read('settingGet', ['a'], rpcOf(sent, 'a', 'live')), okAnswer('1'));
  assert.deepEqual(await reads.read('settingGetMany', [['a', 'd']], rpcOf(sent, 'a,d', ['1', '4'])), okAnswer(['1', '4']));
  assert.deepEqual(await reads.read('settingGet', ['d'], rpcOf(sent, 'd', 'other')), okAnswer('4'),
    'a key read once is kept');
  assert.deepEqual(sent, ['a,d']);
  reads.close();
  assert.deepEqual(await reads.read('settingGet', ['a'], rpcOf(sent, 'a', 'live')), okAnswer('live'));
});

// Defects caught: a credential record read for every reader (eight per turn
// on a hosted turn), and one failed read shared by every reader of it.
test("a turn reads each model credential once, and a failed read answers only itself", async () => {
  const sent: string[] = [];
  const reads = new TurnReads(Promise.resolve<Answered>([
    [{ method: 'modelCredentialRead', args: ['anthropic'] }, okAnswer({ version: 3 })],
  ]));
  for (let index = 0; index < 4; index += 1) {
    assert.deepEqual(await reads.read('modelCredentialRead', ['anthropic'], rpcOf(sent, 'anthropic', { version: 4 })),
      okAnswer({ version: 3 }));
  }
  const [first, second] = await Promise.all([
    reads.read('modelCredentialRead', ['openai'], rpcOf(sent, 'openai', null)),
    reads.read('modelCredentialRead', ['openai'], rpcOf(sent, 'openai', null)),
  ]);
  assert.deepEqual([first, second], [okAnswer(null), okAnswer(null)]);
  assert.deepEqual(sent, ['openai'], 'concurrent readers share one read');

  let failures = 0;
  const failing = async (): Promise<Answer> => {
    failures += 1;
    if (failures === 1) throw new Error('disconnected');
    return okAnswer({ version: 1 });
  };
  const shared = reads.read('modelCredentialRead', ['google'], failing);
  const waiting = reads.read('modelCredentialRead', ['google'], failing);
  await assert.rejects(shared, /disconnected/);
  assert.deepEqual(await waiting, okAnswer({ version: 1 }), 'the waiting read sent its own');
  assert.deepEqual(await reads.read('modelCredentialRead', ['google'], failing), okAnswer({ version: 1 }),
    'and its read is kept');
  assert.equal(failures, 2);
});

/** A stub whose RPCs answer from `answers`, logging each one sent; `stateReadBatch` as the state store answers it. */
function loggingStub(answers: Record<string, (...args: never[]) => Promise<Answer>>, log: string[], batch = true): TagStateRpc {
  return new Proxy({}, {
    get: (_target, name) => typeof name !== 'string' || name === 'then' ? undefined : (...args: never[]) => {
      const kind = (args[0] as { kind?: unknown } | undefined)?.kind;
      log.push(typeof kind === 'string' ? `${name}:${kind}` : name);
      if (name === 'stateReadBatch') {
        return batch
          ? answerStateReads((args as unknown[])[0] as readonly StateRead[], answers)
          : Promise.reject(new TypeError('The RPC receiver does not implement the method "stateReadBatch".'));
      }
      const answer = answers[name];
      return answer ? answer(...args) : Promise.resolve({ ok: false, error: { code: 'internal', message: `no ${name}` } });
    },
  }) as TagStateRpc;
}

// Defect caught: a batch answer that failed served to the read, so the read
// fails differently from (or without) the RPC it would have made.
test("a read whose batched answer failed makes its own RPC and fails as that RPC fails", async () => {
  const unknown = { ok: false, error: { code: 'unknown_agent', message: 'Unknown agent agent_gone', details: { agentId: 'agent_gone' } } } as const;
  const log: string[] = [];
  const stub = loggingStub({ configGetAgent: async () => unknown }, log);
  const config = new CfConfigStore(stub);
  const outside = await config.getAgent('agent_gone').catch((error: unknown) => error);
  const reads = new TurnReads(answerStateReads([{ method: 'configGetAgent', args: ['agent_gone'] }], { configGetAgent: async () => unknown })
    .then((answers) => [[{ method: 'configGetAgent', args: ['agent_gone'] }, answers[0] ?? null]] as Answered));
  const inside = await withTurnReads(reads, () => config.getAgent('agent_gone').catch((error: unknown) => error));
  assert.ok(outside instanceof UnknownAgentError && inside instanceof UnknownAgentError);
  assert.equal((inside as Error).message, (outside as Error).message);
  assert.deepEqual(log, ['configGetAgent', 'configGetAgent'], 'the read inside the turn sent its own RPC');
});

// Defects caught: a turn reading its own setting write back from the batch; a
// batch sent before a write answering reads after it; the fold or an intent
// record discarding the previous plan (they write no batched read); the
// plan's freeze leaving it kept.
test("a turn's write drops what is kept for its store, and one made while the batch was out discards that store's answers", async () => {
  const log: string[] = [];
  const settings = new Map<string, string>([['catalog', 'live']]);
  const answers = {
    settingGet: async (key: string) => okAnswer(settings.get(key) ?? null),
    settingGetMany: async (keys: readonly string[]) => okAnswer(keys.map((key) => settings.get(key) ?? null)),
    settingSet: async (key: string, value: string) => { settings.set(key, value); return okAnswer(null); },
    configGetAgent: async (agentId: string) => okAnswer({ id: agentId }),
    threadRunnerTurn: async (op: { kind: string }) => okAnswer(op.kind === 'fold' ? { messages: [] } : null),
  };
  const stub = loggingStub(answers, log);
  const store = new CfSettingsStore(stub);
  const config = new CfConfigStore(stub);
  const turns = new CfTurnJobsForRunner(() => stub);
  const bound = () => turns.getBoundRuntimePlan('agent_key', '1.0', 'membership_a', 'agent_a');
  const boundRead: StateRead = {
    method: 'threadRunnerTurn',
    args: [{ kind: 'getBoundRuntimePlan', continuityKey: 'agent_key', beforeMessageTs: '1.0', actorMembershipId: 'membership_a', agentId: 'agent_a' }],
  };
  const batch = (): Promise<Answered> => Promise.resolve([
    [{ method: 'settingGetMany', args: [['catalog']] }, okAnswer(['batched'])],
    [{ method: 'configGetAgent', args: ['agent_a'] }, okAnswer({ id: 'agent_a', from: 'batch' })],
    [boundRead, okAnswer(null)],
  ]);

  await withTurnReads(new TurnReads(batch()), async () => {
    assert.equal(await store.getSetting('catalog'), 'batched');
    await store.setSetting('catalog', 'written');
    assert.equal(await store.getSetting('catalog'), 'written', 'the turn reads its own write');
    await turns.fold({ headId: 'turn_a', phase: 'start' } as never);
    await turns.recordInteractionIntent('turn_a', { disposition: 'reply', reason: 'substantive_request' });
    log.length = 0;
    assert.equal(await bound(), undefined);
    assert.deepEqual(log, [], 'the fold and the intent record leave the previous plan batched');
  });

  await withTurnReads(new TurnReads(batch()), async () => {
    await turns.freezeRuntimePlan('turn_a', {} as never);
    log.length = 0;
    await bound();
    assert.deepEqual(log, ['threadRunnerTurn:getBoundRuntimePlan'], 'the freeze drops the batched plan');
  });

  let land!: (answered: Answered) => void;
  await withTurnReads(new TurnReads(new Promise<Answered>((resolve) => { land = resolve; })), async () => {
    const written = store.setSetting('catalog', 'during');
    land(await batch());
    await written;
    log.length = 0;
    assert.equal(await store.getSetting('catalog'), 'during', 'a write sent while the batch was out wins');
    assert.deepEqual(await config.getAgent('agent_a'), { id: 'agent_a', from: 'batch' }, 'another store\'s answer stands');
    assert.deepEqual(log, ['settingGet']);
  });
});

// Defect caught: batched answers serving reads after the turn prepared its
// dispatch, or reads made by work a finished turn left running.
test("a turn's reads end when it prepares its dispatch, and with the turn", async () => {
  const log: string[] = [];
  const stub = loggingStub({ configGetAgent: async (agentId: string) => okAnswer({ id: agentId, from: 'store' }) }, log);
  const config = new CfConfigStore(stub);
  const batch = () => new TurnReads(Promise.resolve<Answered>([
    [{ method: 'configGetAgent', args: ['agent_a'] }, okAnswer({ id: 'agent_a', from: 'batch' })],
  ]));
  let later: Promise<unknown> | undefined;
  await withTurnReads(batch(), async () => {
    endTurnReads();
    assert.deepEqual(await config.getAgent('agent_a'), { id: 'agent_a', from: 'store' });
  });
  await withTurnReads(batch(), async () => {
    later = new Promise((resolve) => setTimeout(resolve, 5)).then(() => config.getAgent('agent_a'));
  });
  assert.deepEqual(await later, { id: 'agent_a', from: 'store' });
  assert.deepEqual(log, ['configGetAgent', 'configGetAgent']);
});

// Defects caught: the batch answering a write, a read kind it does not
// cover, or a method the state store does not have; an unbounded batch.
test('the state store answers only the batchable reads, each by its own RPC method', async () => {
  const called: string[] = [];
  const target = {
    settingGet: async (key: string) => { called.push(`settingGet:${key}`); return okAnswer('v'); },
    settingSet: async () => { called.push('settingSet'); return okAnswer(null); },
    memoryExecute: async (request: { kind: string }) => { called.push(`memory:${request.kind}`); return okAnswer({}); },
    workExecute: async (request: { kind: string }) => { called.push(`work:${request.kind}`); return okAnswer({}); },
    threadRunnerTurn: async (op: { kind: string }) => { called.push(`turn:${op.kind}`); return okAnswer(null); },
  };
  const answers = await answerStateReads([
    { method: 'settingGet', args: ['a'] },
    { method: 'settingSet', args: ['a', 'b'] },
    { method: 'memoryExecute', args: [{ kind: 'get_agent_memory', agentId: 'agent_a' }] },
    { method: 'memoryExecute', args: [{ kind: 'put_agent_memory' }] },
    { method: 'workExecute', args: [{ kind: 'get_run', runId: 'run_a' }] },
    { method: 'workExecute', args: [{ kind: 'create_execution' }] },
    { method: 'threadRunnerTurn', args: [{ kind: 'getBoundRuntimePlan' }] },
    { method: 'threadRunnerTurn', args: [{ kind: 'fold' }] },
    { method: 'configGetAgent', args: ['agent_a'] },
  ], target);
  assert.deepEqual(answers, [okAnswer('v'), null, okAnswer({}), null, okAnswer({}), null, okAnswer(null), null, null]);
  assert.deepEqual(called, ['settingGet:a', 'memory:get_agent_memory', 'work:get_run', 'turn:getBoundRuntimePlan']);
  const many = await answerStateReads(
    Array.from({ length: STATE_READ_BATCH_MAX + 5 }, (_, index) => ({ method: 'settingGet', args: [`k${index}`] })),
    target,
  );
  assert.equal(many.length, STATE_READ_BATCH_MAX);
});

/** The state store's RPCs a turn's preparation reads, answered from a lane's Node stores. */
function laneAnswers(stores: AppStores): Record<string, (...args: never[]) => Promise<Answer>> {
  const answer = async (read: () => unknown): Promise<Answer> => {
    try {
      return okAnswer((await read()) ?? null);
    } catch (error) {
      if (error instanceof UnknownAgentError) {
        return { ok: false, error: { code: 'unknown_agent', message: error.message, details: { agentId: error.agentId } } };
      }
      return { ok: false, error: { code: 'internal', message: (error as Error).message } };
    }
  };
  const config = stores.config as unknown as Record<string, (...args: unknown[]) => unknown>;
  const answers: Record<string, (...args: never[]) => Promise<Answer>> = {
    settingGet: (key: string) => answer(() => stores.settings.getSetting(key)),
    settingGetMany: (keys: readonly string[]) =>
      answer(async () => (await stores.settings.getSettings(keys)).map((value) => value ?? null)),
    modelCredentialRead: (providerId: string) =>
      answer(() => (stores.settings as unknown as ModelCredentialStore).readModelCredential(providerId)),
    memoryExecute: (request: { kind: string; agentId: string }) =>
      answer(async () => ({ kind: 'agent_memory', memory: await stores.memory.getAgentMemory(request.agentId) })),
    threadRunnerTurn: () => answer(() => null),
  };
  for (const method of ['getAgent', 'listAgentChannelGrants', 'listConnectionAccounts', 'listAgentConnectionBindings',
    'getAgentModelRole', 'getWorkspaceModelRole', 'getWorkspaceInstallation', 'listSlackPublicContext',
    'getWorkspaceModelDefault', 'listAgents']) {
    answers[`config${method[0]!.toUpperCase()}${method.slice(1)}`] =
      (...args: never[]) => answer(() => config[method]!.apply(stores.config, args));
  }
  return answers;
}

interface Prepared {
  plan?: RuntimePlanV2;
  failure?: string;
  memory: { conversationKey: string; memoryEpoch: number; promptBlock?: string; quarantined?: boolean };
}

/**
 * What a turn of `fixture` prepares (its memory, then the plan it freezes)
 * through the Cf store proxies a thread runner uses, over a state store
 * answered from the lane; with `batched`, inside the reads its batch answers.
 */
async function prepareThroughProxies(
  lane: RunPlanLane,
  fixture: SlackFixture,
  env: PlatformEnv,
  batched: boolean,
  log: string[],
): Promise<Prepared> {
  const stub = loggingStub(laneAnswers(lane.stores), log);
  const scopedEnv = { ...env, TAG_STATE: { getByName: () => stub } } as unknown as PlatformEnv;
  const turn: NormalizedSlackTurn = lane.turn(fixture);
  const assignment: ResolvedAssignment = await lane.assignment(fixture.agentId, fixture.place);
  const config = new CfConfigStore(stub);
  const settings = new CfSettingsStore(stub);
  const turns = new CfTurnJobsForRunner(() => stub);
  const prepare = async (): Promise<Prepared> => {
    const memory = await prepareMemoryTurn({
      turn, assignment, platformEnv: scopedEnv, client: {} as never, botToken: 'xoxb-test', botUserId: 'UBOT',
      dependencies: { config, identity: lane.stores.identity, state: new CfMemoryStateStore(stub) },
    });
    const prepared: Prepared = {
      memory: {
        conversationKey: memory.conversationKey,
        memoryEpoch: memory.memoryEpoch,
        ...(memory.promptBlock ? { promptBlock: memory.promptBlock } : {}),
        ...(memory.quarantined ? { quarantined: true } : {}),
      },
    };
    try {
      const { decision } = await freezeRuntimePlanForTurn({
        turn, assignment, platformEnv: scopedEnv, settingsStore: settings, configStore: config,
        memoryEpoch: Promise.resolve(memory.memoryEpoch),
        persist: (candidate) => ({ runtimePlan: candidate, instanceId: deriveRuntimePlanInstanceId(candidate) }),
        getBoundRuntimePlan: (...args) => turns.getBoundRuntimePlan(...args),
      });
      prepared.plan = decision.runtimePlan;
    } catch (error) {
      prepared.failure = `${(error as Error).name}: ${(error as Error).message}`;
    }
    return prepared;
  };
  invalidateProviderKeyCache();
  if (!batched) return prepare();
  const job = { id: `turn_${fixture.name}`, turn, assignment } as unknown as PendingTurnJob;
  return withTurnReads(prefetchTurnReads(scopedEnv, job), prepare);
}

const HOSTED_INSTALLATION = `inst_${'0123456789abcdef'.repeat(2)}`;

function hostedEnv(): PlatformEnv {
  return scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' } as unknown as PlatformEnv,
    { installationId: HOSTED_INSTALLATION });
}

/** Calls the batch did not answer, apart from the batch itself. */
const separateReads = (log: readonly string[]) => log.filter((entry) => entry !== 'stateReadBatch');

async function assertSamePreparation(lane: RunPlanLane, fixture: SlackFixture, env: PlatformEnv, label: string) {
  const separate: string[] = [];
  const batchedLog: string[] = [];
  const before = await prepareThroughProxies(lane, fixture, env, false, separate);
  const after = await prepareThroughProxies(lane, fixture, env, true, batchedLog);
  assert.deepEqual(after, before, `${label}: the batch prepares what the separate reads prepare`);
  assert.ok(batchedLog.includes('stateReadBatch'), `${label}: the batch was sent`);
  return { separate, batched: separateReads(batchedLog), prepared: after };
}

// Defects caught: a batched read under other arguments than its reader's (it
// then misses, or answers the wrong read), a plan or memory that differs
// from the one the separate reads give, and a turn that still reads the
// state store read by read.
test('the batch prepares the memory and plan the separate reads prepare, for each kind of turn', async (t) => {
  await withRunPlanLane(async (lane) => {
    await lane.stores.memory.putAgentMemory({
      agentId: READY_AGENT, expectedRevision: 0, body: 'The queue closes at five.', actorMembershipId: ALICE,
    } as never);
    for (const fixture of SLACK_FIXTURES) {
      const env = fixture.browserAndSearch ? lane.platformEnv(fixture)! : ({} as PlatformEnv);
      const { separate, batched, prepared } = await assertSamePreparation(lane, fixture, env, fixture.name);
      assert.ok(separate.length > 0, `${fixture.name}: the separate reads reach the state store`);
      assert.deepEqual(batched, [], `${fixture.name}: no read leaves the batch (separately: ${separate.join(' ')})`);
      if (fixture.agentId === READY_AGENT) {
        assert.ok(prepared.plan, `${fixture.name}: a plan froze`);
        assert.match(prepared.memory.promptBlock ?? '', /queue closes at five/, `${fixture.name}: with the memory`);
      } else {
        assert.match(prepared.failure ?? '', /RuntimeModelReadiness/, `${fixture.name}: fails as before`);
      }
    }
  });
  t.diagnostic('fixtures: connections, skills, memory, a website login, the browser, and a model with no key');
});

// Defects caught: a hosted turn reading each saved model credential once per
// reader, and a hosted or platform-funded turn preparing another plan.
test("a hosted turn reads its model credentials in the batch, once, BYOK or platform-funded", async (t) => {
  t.after(() => resetPlatformFundingForTests());
  useDeploymentKeyring(t);
  await withRunPlanLane(async (lane) => {
    const fixture: SlackFixture = { ...SLACK_FIXTURES[1]!, name: 'hosted Channel, by Alice' };
    const env = hostedEnv();
    await lane.stores.config.updateAgent(READY_AGENT, { model: 'anthropic/claude-sonnet-4-6' } as never);
    await rotateInstallationModelCredential('anthropic', { kind: 'save', apiKey: 'sk-ant-test-not-a-key' }, {
      env, settings: lane.stores.settings, usage: lane.stores.usage,
    });
    const byok = await assertSamePreparation(lane, fixture, env, 'BYOK');
    assert.ok(byok.prepared.plan, 'the BYOK plan froze');
    assert.deepEqual(byok.batched, [], 'batched, nothing is read again');

    // Defect caught: a hosted turn's batch reading the installation's stored
    // browser key, which a deployment serving many installations never reads.
    const planned = async (plannedEnv: PlatformEnv) => turnPlanReads(
      { id: 'turn_keys', turn: lane.turn(fixture), assignment: await lane.assignment(READY_AGENT, fixture.place) } as unknown as PendingTurnJob,
      plannedEnv,
    )[0]!.args[0] as string[];
    const browserKeys = (keys: readonly string[]) => keys.filter((key) => key.startsWith('browser.browserbase.'));
    assert.deepEqual(browserKeys(await planned(env)), [], 'hosted, the batch names no stored browser key');
    assert.equal(browserKeys(await planned({} as PlatformEnv)).length, 2, 'standalone, it reads the browser key and project');

    // Defect caught: a hosted turn's batch naming the saved provider-key
    // settings, which a hosted Worker never reads; it reads the credential
    // records instead (tests/model-access-bypass.test.ts allows this module).
    const providerKeySettings = new Set<string>(Object.values(PROVIDER_KEY_SETTING_KEYS));
    const keysJob = { id: 'turn_keys', turn: lane.turn(fixture), assignment: await lane.assignment(READY_AGENT, fixture.place) } as unknown as PendingTurnJob;
    const allReads = (plannedEnv: PlatformEnv | undefined) => turnPlanReads(keysJob, plannedEnv);
    const namedKeySettings = (reads: ReturnType<typeof allReads>) => reads
      .filter((read) => read.method === 'settingGet' || read.method === 'settingGetMany')
      .flatMap((read) => (read.method === 'settingGet' ? [read.args[0]] : read.args[0]) as string[])
      .filter((key) => providerKeySettings.has(key));
    const credentialRecords = (reads: ReturnType<typeof allReads>) => reads
      .filter((read) => read.method === 'modelCredentialRead').map((read) => read.args[0]);
    assert.deepEqual(namedKeySettings(allReads(env)), [], 'hosted, the batch names no provider-key setting');
    assert.deepEqual(credentialRecords(allReads(env)), [...PROVIDER_KEY_IDS], 'hosted, it reads each credential record');
    assert.equal(namedKeySettings(allReads({} as PlatformEnv)).length, PROVIDER_KEY_IDS.length,
      'standalone, a key-backed model reads the saved provider keys');
    assert.deepEqual(credentialRecords(allReads({} as PlatformEnv)), [], 'standalone, no credential record');

    // Defect caught: a caller that passes no env, or one without the tenancy,
    // getting a standalone batch on a deployment that serves many installations.
    const previousTenancy = process.env.CHICKPEA_TENANCY;
    process.env.CHICKPEA_TENANCY = 'installation';
    try {
      for (const [label, omitted] of [['no env', undefined], ['an env without the tenancy', {} as PlatformEnv]] as const) {
        assert.deepEqual(namedKeySettings(allReads(omitted)), [], `hosted by the deployment's variables, ${label}: no provider-key setting`);
        assert.deepEqual(credentialRecords(allReads(omitted)), [...PROVIDER_KEY_IDS], `hosted by the deployment's variables, ${label}: each credential record`);
      }
    } finally {
      if (previousTenancy === undefined) delete process.env.CHICKPEA_TENANCY;
      else process.env.CHICKPEA_TENANCY = previousTenancy;
    }

    // The turn's other credential readers: readiness, usage attribution, and the classifier's key.
    const readCredentials = async (batched: boolean) => {
      const log: string[] = [];
      const stub = loggingStub(laneAnswers(lane.stores), log);
      const scopedEnv = { ...env, TAG_STATE: { getByName: () => stub } } as unknown as PlatformEnv;
      const settings = new CfSettingsStore(stub);
      const read = async () => [
        await describeProviderKeySources(scopedEnv, settings),
        await resolveModelCredentialAttribution('anthropic/claude-sonnet-4-6', scopedEnv, settings, undefined, { registerUsage: false }),
        (await resolveProviderApiKey('anthropic', scopedEnv, settings)).apiKey,
        await describeProviderKeySources(scopedEnv, settings),
      ];
      const job = { id: 'turn_credentials', turn: lane.turn(fixture), assignment: await lane.assignment(READY_AGENT, fixture.place) };
      const answers = batched
        ? await withTurnReads(prefetchTurnReads(scopedEnv, job as unknown as PendingTurnJob), read)
        : await read();
      return { answers, reads: log.filter((call) => call === 'modelCredentialRead').length, log };
    };
    const separate = await readCredentials(false);
    const batched = await readCredentials(true);
    assert.deepEqual(batched.answers, separate.answers, 'the same sources, attribution and key');
    assert.equal(separate.answers[2], 'sk-ant-test-not-a-key');
    assert.ok(separate.reads > PROVIDER_KEY_IDS.length, `separately, each reader reads the records: ${separate.reads}`);
    assert.deepEqual(batched.log, ['stateReadBatch'], 'batched, each record is read once, in the batch');
    t.diagnostic(`credential records read separately: ${separate.reads}; batched: once each, in one batch`);

    configurePlatformFunding({ ...EVERY_PROVIDER_FUNDED, funding: async () => 'platform', admit: async () => 'admitted', charge: async () => undefined, ...NO_RUN_FEES });
    const funded = await assertSamePreparation(lane, fixture, env, 'platform-funded');
    assert.ok(funded.prepared.plan, 'the platform-funded plan froze');
    assert.deepEqual(funded.batched, []);
  });
});

// Defect caught: a new runner whose state store predates the batch (a
// deploy in progress) failing the turn, or preparing it differently.
test('against a state store without the batch, the turn reads as it did', async () => {
  await withRunPlanLane(async (lane) => {
    const fixture = SLACK_FIXTURES[1]!;
    const separate: string[] = [];
    const before = await prepareThroughProxies(lane, fixture, {} as PlatformEnv, false, separate);
    const log: string[] = [];
    const stub = loggingStub(laneAnswers(lane.stores), log, false);
    const env = { TAG_STATE: { getByName: () => stub } } as unknown as PlatformEnv;
    const job = { id: 'turn_old_store', turn: lane.turn(fixture), assignment: await lane.assignment(fixture.agentId, fixture.place) };
    const reads = prefetchTurnReads(env, job as unknown as PendingTurnJob);
    const config = new CfConfigStore(stub);
    const agent = await withTurnReads(reads, () => config.getAgent(READY_AGENT));
    assert.equal(agent.id, READY_AGENT);
    assert.deepEqual(log, ['stateReadBatch', 'configGetAgent'], 'the batch failed; the read made its own RPC');
    assert.ok(before.plan);
  });
});

// Defects caught: an attempt that already holds its dispatch envelope never
// prepares a dispatch, so nothing ended its batched reads, and its settings
// and credential records stayed as read at its start for the whole run; an
// approval turn's Add key card reading the Agent and its connections as
// batched before the state store applied the approval.
test('an attempt that prepares no dispatch gets no batch: one past its preparation, and a management approval', async () => {
  const log: string[] = [];
  const stub = loggingStub({}, log);
  const env = { TAG_STATE: { getByName: () => stub } } as unknown as PlatformEnv;
  const job = {
    id: 'turn_a',
    turn: { workspaceId: 'T1', channelId: 'D1', channelType: 'im', threadTs: '1.0', messageTs: '1.0' },
    assignment: { agentId: READY_AGENT, agent: { id: READY_AGENT } },
  } as unknown as PendingTurnJob;
  const sent = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return log.splice(0);
  };
  assert.equal(prefetchTurnReads(env, { ...job, dispatchEnvelope: { instanceId: 'agent' } } as unknown as PendingTurnJob), undefined,
    'an attempt past its preparation');
  assert.equal(prefetchTurnReads(env, {
    ...job, turn: { ...job.turn, managementApprovalProposalId: 'proposal_a' },
  } as unknown as PendingTurnJob), undefined, 'a management approval');
  assert.deepEqual(await sent(), [], 'and neither sends a batch');
  assert.ok(prefetchTurnReads(env, job) instanceof TurnReads, 'a first attempt of any other turn has its batch');
  assert.deepEqual(await sent(), ['stateReadBatch']);
});

// Defect caught: the Work run and binding a turn's lifecycle opens with left
// out of the batch, or batched under other arguments than the reads send.
test("a runner's batch answers the turn's Work run and the binding its presentation names", async () => {
  const log: string[] = [];
  const run = { id: 'run_work', bindingId: 'binding_work' };
  const binding = { id: 'binding_work', sourceVisibility: 'private' };
  const stub = loggingStub({
    workExecute: async (request: { kind: string }) =>
      okAnswer(request.kind === 'get_run' ? { kind: 'run', run } : { kind: 'binding', binding }),
  }, log);
  const job = {
    id: 'turn_work', runId: run.id,
    turn: { workspaceId: 'T1', channelId: 'D1', channelType: 'im', threadTs: '1.0', messageTs: '1.0' },
    assignment: { agentId: READY_AGENT, agent: { id: READY_AGENT } },
  } as unknown as PendingTurnJob;
  const work = new CfWorkStore(stub);
  const reads = prefetchTurnReads({ TAG_STATE: { getByName: () => stub } } as unknown as PlatformEnv, job, binding.id);
  const read = await withTurnReads(reads, async () => [await work.getRun(run.id as never), await work.getBinding(binding.id as never)]);
  assert.deepEqual(read, [run, binding]);
  assert.deepEqual(log, ['stateReadBatch'], 'neither read left the batch');
});

// Defect caught: a lease check answered from the batch, so an installation
// revoked while the turn prepared still holds its lease before the run.
test("a turn's lease check reads the state store, not the batch", async () => {
  await withRunPlanLane(async (lane) => {
    const fixture = SLACK_FIXTURES[0]!;
    const log: string[] = [];
    const stub = loggingStub(laneAnswers(lane.stores), log);
    const env = { TAG_STATE: { getByName: () => stub } } as unknown as PlatformEnv;
    const turn = lane.turn(fixture);
    const assignment = await lane.assignment(fixture.agentId, fixture.place);
    const job = { id: 'turn_lease', turn, assignment } as unknown as PendingTurnJob;
    const held = await withTurnReads(prefetchTurnReads(env, job), async () => {
      const memory = await prepareMemoryTurn({
        turn, assignment, platformEnv: env, client: {} as never, botToken: 'xoxb-test', botUserId: 'UBOT',
        dependencies: { config: new CfConfigStore(stub), identity: lane.stores.identity, state: new CfMemoryStateStore(stub) },
      });
      const installation = await lane.stores.config.getWorkspaceInstallation(turn.workspaceId);
      await lane.stores.config.updateWorkspaceInstallation(turn.workspaceId, { health: 'revoked' }, installation!.revision);
      return memory.validateLease!();
    });
    assert.equal(held, false, 'the revoked installation ends the lease');
    assert.ok(log.includes('configGetWorkspaceInstallation'), `the check read the installation: ${log.join(' ')}`);
  });
});
