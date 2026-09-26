import assert from 'node:assert/strict';
import { test } from 'node:test';

import { prepareCodingModel } from '../src/agents/coding-worker.ts';
import { compileRuntimePlanV2, type RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import {
  prepareRuntimePlanModel,
  resolveRuntimePlanBashRepositoryAccess,
} from '../src/agents/slack-thread.ts';
import {
  parseTurnEnvelope,
  resetTurnEnvelopeCacheForTests,
  TURN_ENVELOPE_MAX_SETTING_BYTES,
  TURN_ENVELOPE_SETTING_KEYS,
  TurnEnvelopeContext,
  TurnSettingsView,
  type TurnEnvelopeV1,
} from '../src/agents/turn-envelope.ts';
import { GITHUB_SETTING_KEYS } from '../src/config/github-app.ts';
import { SANDBOX_SETTING_KEYS } from '../src/config/sandbox-settings.ts';
import type { SettingsPatch, SettingsStore } from '../src/config/settings-store.ts';
import { getSettingsStore, getSlackStateStore } from '../src/config/state-backend.ts';
import type { CustomAgentConfig, RepositoryGrant, ResolvedAssignment } from '../src/config/types.ts';
import { MODEL_CATALOG_SETTING_KEYS } from '../src/model-catalog/store.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { buildTurnEnvelope } from '../src/slack/turn-envelope-builder.ts';
import { TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';

const NOW = 1_940_000_000_000;
const AGENT_ID = 'agent_envelope';
const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----';
const PROVIDER_KEY = 'sk-ant-envelope-test-secret';

const GRANT: RepositoryGrant = {
  id: 'grant_1',
  installationId: 42,
  accountLogin: 'chickpea',
  fullName: 'chickpea/app',
  enabled: true,
};

test('prepareFlueDispatch freezes the turn envelope once, beside (not inside) the model-visible dispatch', async () => {
  const db = openStateDb(':memory:');
  try {
    const turns = new TurnJobStoreLogic(db, () => NOW);
    const plan = compileRuntimePlanV2({
      turn: turn(), assignment: assignment(), instructions: 'Envelope.', memoryEpoch: 1,
    });
    turns.enqueue({ id: 'turn_envelope', evtKey: 'evt', msgKey: 'msg', turn: turn(), assignment: assignment() });
    turns.freezeRuntimePlan('turn_envelope', plan);
    const first = await buildTurnEnvelope({
      plan,
      settings: memorySettings({ [SANDBOX_SETTING_KEYS.enabled]: 'true' }),
      config: fakeConfig(agent()),
      now: () => NOW,
    });
    assert.ok(first);
    assert.match(first.settingsRevision, /^[a-f0-9]{64}$/);

    const dispatch = turns.prepareFlueDispatch(
      'turn_envelope', 'Do the work', { generation: 'g1' }, undefined, undefined, first,
    );
    assert.deepEqual(turns.getTurnEnvelope('turn_envelope'), first);
    // The model sees the dispatch message; the envelope never rides it.
    assert.doesNotMatch(JSON.stringify(dispatch), /settingsRevision|sandbox\.enabled/);

    // A retry reuses the first freeze, even when handed a newer envelope.
    const newer = await buildTurnEnvelope({
      plan,
      settings: memorySettings({ [SANDBOX_SETTING_KEYS.enabled]: 'false' }),
      config: fakeConfig(agent()),
      now: () => NOW + 1,
    });
    assert.ok(newer);
    assert.notEqual(newer.settingsRevision, first.settingsRevision);
    turns.prepareFlueDispatch('turn_envelope', 'Do the work', { generation: 'g1' }, undefined, undefined, newer);
    assert.equal(turns.getTurnEnvelope('turn_envelope')?.settingsRevision, first.settingsRevision);

    // A dispatch without one (Node, or an older host) stores none.
    turns.enqueue({ id: 'turn_plain', evtKey: 'evt2', msgKey: 'msg2', turn: turn(), assignment: assignment() });
    turns.freezeRuntimePlan('turn_plain', plan);
    turns.prepareFlueDispatch('turn_plain', 'Do the work', { generation: 'g2' });
    assert.equal(turns.getTurnEnvelope('turn_plain'), undefined);
  } finally {
    db.close();
  }
});

test('the envelope freezes only non-secret facts, bounded, with a revision that ignores the clock', async () => {
  const plan = compileRuntimePlanV2({
    turn: turn(), assignment: assignment(), instructions: 'Envelope.', memoryEpoch: 1,
  });
  const settings = memorySettings({
    [SANDBOX_SETTING_KEYS.enabled]: 'true',
    [SANDBOX_SETTING_KEYS.monthlySessionCap]: '25',
    [GITHUB_SETTING_KEYS.appId]: '123',
    [GITHUB_SETTING_KEYS.privateKey]: PRIVATE_KEY,
    'provider.anthropic.apiKey': PROVIDER_KEY,
    [MODEL_CATALOG_SETTING_KEYS.lkg]: 'x'.repeat(TURN_ENVELOPE_MAX_SETTING_BYTES + 1),
  });
  const envelope = await buildTurnEnvelope({ plan, settings, config: fakeConfig(agent()), now: () => NOW });
  assert.ok(envelope);
  const serialized = JSON.stringify(envelope);
  assert.doesNotMatch(serialized, /not-a-real-key|sk-ant-envelope/);
  assert.equal(envelope.githubAppConnected, true);
  assert.equal(envelope.settings[SANDBOX_SETTING_KEYS.enabled], 'true');
  assert.equal(envelope.settings[SANDBOX_SETTING_KEYS.installRequested], null);
  // Too large to freeze: that one setting is read live instead.
  assert.equal(MODEL_CATALOG_SETTING_KEYS.lkg in envelope.settings, false);
  assert.deepEqual(envelope.agent?.repositories, [GRANT]);
  assert.equal('imageModelId' in envelope, false);

  const later = await buildTurnEnvelope({ plan, settings, config: fakeConfig(agent()), now: () => NOW + 60_000 });
  assert.equal(later?.settingsRevision, envelope.settingsRevision);

  // A credential can never be smuggled into the frozen settings.
  assert.throws(
    () => parseTurnEnvelope({ ...envelope, settings: { 'provider.anthropic.apiKey': PROVIDER_KEY } }),
    /may not be frozen/,
  );
});

test('the settings view serves frozen keys, reads everything else live, and never freezes its own writes', async () => {
  const live = countingSettings({
    [SANDBOX_SETTING_KEYS.enabled]: 'false',
    'provider.anthropic.apiKey': PROVIDER_KEY,
  });
  const view = new TurnSettingsView(live.store, { settings: { [SANDBOX_SETTING_KEYS.enabled]: 'true' } });

  assert.equal(await view.getSetting(SANDBOX_SETTING_KEYS.enabled), 'true');
  assert.deepEqual(live.reads, []);
  assert.deepEqual(
    await view.getSettings([SANDBOX_SETTING_KEYS.enabled, 'provider.anthropic.apiKey']),
    ['true', PROVIDER_KEY],
  );
  assert.deepEqual(live.reads, [['provider.anthropic.apiKey']]);

  await view.setSetting(SANDBOX_SETTING_KEYS.enabled, 'false');
  assert.deepEqual(live.writes, [SANDBOX_SETTING_KEYS.enabled]);
  assert.equal(await view.getSetting(SANDBOX_SETTING_KEYS.enabled), 'false');
});

test('a stale frozen fact gets one live re-resolution, and a live failure still fails', async () => {
  const live = memorySettings({ [SANDBOX_SETTING_KEYS.enabled]: 'true' });
  const context = new TurnEnvelopeContext('turn_stale', AGENT_ID, async () =>
    envelopeFor({ [SANDBOX_SETTING_KEYS.enabled]: 'false' }));
  resetTurnEnvelopeCacheForTests();
  const seen: (string | undefined)[] = [];
  const result = await context.withSettings(live, async (settings) => {
    const value = await settings.getSetting(SANDBOX_SETTING_KEYS.enabled);
    seen.push(value);
    if (value !== 'true') throw new Error('stale');
    return value;
  });
  assert.equal(result, 'true');
  assert.deepEqual(seen, ['false', 'true']);

  let attempts = 0;
  await assert.rejects(
    context.withSettings(live, async () => {
      attempts += 1;
      throw new Error('invalid_auth');
    }),
    /invalid_auth/,
  );
  assert.equal(attempts, 2);
});

test('a simulated coding turn reads no frozen fact from the singleton; secrets and writes stay live', async () => {
  resetTurnEnvelopeCacheForTests();
  const plan = repositoryPlan();
  const envelope = envelopeFor({ [SANDBOX_SETTING_KEYS.enabled]: 'true' });
  const stub = countingStateStub({ envelope, liveAgent: agent() });
  // An installed workspace binding, so repository access goes on to mint tokens.
  const env = { TAG_STATE: { getByName: () => stub.rpc }, SANDBOX: {} };

  await withCloudflareUserAgent(async () => {
    const loader = (id: string) => getSlackStateStore(env).getTurnEnvelope!(id);
    const coordinator = new TurnEnvelopeContext('turn_coding', AGENT_ID, loader);
    // Sandbox creation, an image check, and a screenshot check share one preparation.
    for (let call = 0; call < 3; call += 1) await prepareRuntimePlanModel(plan, env, coordinator);
    await resolveRuntimePlanBashRepositoryAccess(plan, env, coordinator);
    // The coding worker finds the same turn in its own context.
    const worker = new TurnEnvelopeContext('turn_coding', AGENT_ID, loader);
    await prepareCodingModel(workerBinding(), env as never, worker);
    // A genuine write still reaches the singleton.
    await new TurnSettingsView(getSettingsStore(env), envelope)
      .setSetting(SANDBOX_SETTING_KEYS.monthlySessionCap, '10');
  });

  assert.equal(stub.count('slackTurnEnvelopeGet'), 1);
  assert.equal(stub.count('configGetAgent'), 0);
  assert.deepEqual(stub.settingKeysRead(), [
    // Minting a repository token needs the App's private key: read live.
    GITHUB_SETTING_KEYS.appId, GITHUB_SETTING_KEYS.appSlug, GITHUB_SETTING_KEYS.privateKey,
  ]);
  assert.deepEqual(stub.writes, [SANDBOX_SETTING_KEYS.monthlySessionCap]);
});

test('without an envelope the same turn reads the singleton for every fact, as before', async () => {
  resetTurnEnvelopeCacheForTests();
  const plan = repositoryPlan();
  const stub = countingStateStub({ envelope: null, liveAgent: agent() });
  const env = { TAG_STATE: { getByName: () => stub.rpc } };

  await withCloudflareUserAgent(async () => {
    for (let call = 0; call < 3; call += 1) await prepareRuntimePlanModel(plan, env);
    await resolveRuntimePlanBashRepositoryAccess(plan, env);
    await prepareCodingModel(workerBinding(), env as never);
  });

  assert.equal(stub.count('slackTurnEnvelopeGet'), 0);
  assert.equal(stub.count('configGetAgent'), 5);
  const keys = stub.settingKeysRead();
  assert.ok(keys.includes(SANDBOX_SETTING_KEYS.enabled));
  assert.ok(keys.includes(MODEL_CATALOG_SETTING_KEYS.mode));
});

test('an Agent disabled at dispatch seals the turn without a singleton read', async () => {
  resetTurnEnvelopeCacheForTests();
  const disabled = { ...envelopeFor({}), agent: { ...envelopeFor({}).agent!, enabled: false } };
  const stub = countingStateStub({ envelope: disabled, liveAgent: agent() });
  const env = { TAG_STATE: { getByName: () => stub.rpc } };
  await withCloudflareUserAgent(async () => {
    const loader = (id: string) => getSlackStateStore(env).getTurnEnvelope!(id);
    await assert.rejects(
      prepareRuntimePlanModel(repositoryPlan(), env, new TurnEnvelopeContext('turn_sealed', AGENT_ID, loader)),
      { name: 'SealedAgentThreadError' },
    );
    await assert.rejects(
      prepareCodingModel(workerBinding(), env as never, new TurnEnvelopeContext('turn_sealed', AGENT_ID, loader)),
      /disabled/,
    );
  });
  assert.equal(stub.count('configGetAgent'), 0);
});

function envelopeFor(settings: Record<string, string | null>): TurnEnvelopeV1 {
  return parseTurnEnvelope({
    schemaVersion: 1,
    settingsRevision: 'a'.repeat(64),
    frozenAt: NOW,
    agentId: AGENT_ID,
    agent: { id: AGENT_ID, kind: 'user', revision: 1, enabled: true, repositories: [GRANT] },
    // As the host freezes it: every frozen key present, absent ones as null.
    settings: {
      ...Object.fromEntries(TURN_ENVELOPE_SETTING_KEYS.map((key) => [key, null])),
      ...settings,
    },
    githubAppConnected: true,
  });
}

function repositoryPlan(): RuntimePlanV2 {
  return compileRuntimePlanV2({
    turn: turn(), assignment: assignment(), instructions: 'Envelope.', memoryEpoch: 1,
  });
}

function workerBinding() {
  return {
    schemaVersion: 1 as const,
    workspaceId: 'workspace_1',
    agentId: AGENT_ID,
    codingModel: { model: 'local-stub/canary', runtimeModel: 'local-stub/canary' },
    repositories: [],
  };
}

function turn(): NormalizedSlackTurn {
  return {
    workspaceId: 'T_envelope', channelId: 'C_envelope', eventId: 'Ev_envelope',
    text: 'Do the work', userId: 'U_member', messageTs: '100.001', threadTs: '100.001',
    source: 'app_mention', contextMode: 'thread', channelType: 'channel',
  };
}

function agent(): CustomAgentConfig {
  return {
    id: AGENT_ID, kind: 'user', revision: 1, name: 'Envelope', instructions: 'Help.', enabled: true,
    skills: [], mcpServers: [], apiConnections: [], repositories: [GRANT],
  };
}

function assignment(): ResolvedAssignment {
  return {
    workspaceId: 'T_envelope', channelId: 'C_envelope', agentId: AGENT_ID,
    model: 'local-stub/canary',
    agent: agent(),
  };
}

function fakeConfig(current: CustomAgentConfig) {
  return {
    getAgent: async () => current,
    getAgentModelRole: async () => undefined,
    getWorkspaceModelRole: async () => undefined,
  };
}

function memorySettings(initial: Record<string, string>): SettingsStore {
  return countingSettings(initial).store;
}

function countingSettings(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  const reads: string[][] = [];
  const writes: string[] = [];
  const store: SettingsStore = {
    getSetting: async (key) => {
      reads.push([key]);
      return values.get(key);
    },
    getSettings: async (keys) => {
      reads.push([...keys]);
      return keys.map((key) => values.get(key));
    },
    setSetting: async (key, value) => {
      writes.push(key);
      values.set(key, value);
    },
    deleteSetting: async (key) => {
      writes.push(key);
      values.delete(key);
    },
    applySettingsPatch: async (patch: SettingsPatch) => {
      for (const write of patch.set ?? []) values.set(write.key, write.value);
      return true;
    },
    mergeSettingStringSet: async () => [],
  };
  return { store, reads, writes };
}

/** A fake singleton stub that records every RPC the Agent-side code makes. */
function countingStateStub(input: { envelope: TurnEnvelopeV1 | null; liveAgent: CustomAgentConfig }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const writes: string[] = [];
  const values = new Map<string, string>();
  const handlers: Record<string, (...args: never[]) => unknown> = {
    slackTurnEnvelopeGet: () => input.envelope,
    configGetAgent: () => input.liveAgent,
    settingGet: (key: string) => values.get(key) ?? null,
    settingGetMany: (keys: readonly string[]) => keys.map((key) => values.get(key) ?? null),
    settingSet: (key: string, value: string) => {
      writes.push(key);
      values.set(key, value);
      return null;
    },
  };
  const rpc = new Proxy({}, {
    get(_target, method: string) {
      return async (...args: unknown[]) => {
        calls.push({ method, args });
        const handler = handlers[method];
        if (!handler) throw new Error(`Unexpected singleton RPC: ${method}`);
        return { ok: true, value: (handler as (...values: unknown[]) => unknown)(...args) };
      };
    },
  });
  return {
    rpc,
    writes,
    count: (method: string) => calls.filter((call) => call.method === method).length,
    settingKeysRead: () => calls.flatMap((call) =>
      call.method === 'settingGet'
        ? [call.args[0] as string]
        : call.method === 'settingGetMany' ? [...(call.args[0] as string[])] : []),
  };
}

async function withCloudflareUserAgent<T>(run: () => Promise<T>): Promise<T> {
  const prototype = Object.getPrototypeOf(globalThis.navigator) as object;
  const original = Object.getOwnPropertyDescriptor(prototype, 'userAgent');
  Object.defineProperty(prototype, 'userAgent', {
    configurable: true,
    enumerable: true,
    value: 'Cloudflare-Workers',
  });
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(prototype, 'userAgent', original);
  }
}
