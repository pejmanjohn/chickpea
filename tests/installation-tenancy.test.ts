import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  assertRuntimePlanInstallation,
  compileRuntimePlanV2,
  deriveLegacyRuntimePlanInstanceId,
  deriveRuntimePlanInstanceId,
  isRuntimePlanInstanceId,
  parseRuntimePlanV2,
  runtimePlanInstanceIdMatches,
} from '../src/agents/runtime-plan.ts';
import { installationAgentObject } from '../src/agents/cloudflare-extension.ts';
import { saveOpenAiAuthMethod } from '../src/config/openai-auth.ts';
import { createSlackTurnInput, parseSlackTurnInput } from '../src/agents/turn-input.ts';
import { CfIdentityStore, CfSettingsStore, FreshTagStateStubs } from '../src/config/cf-state-proxies.ts';
import {
  resolveInstallationEnv,
  scheduledForEachInstallation,
  type InstallationKey,
  type InstallationLookup,
  type InstallationRecord,
} from '../src/config/installation-lookup.ts';
import {
  assertInstallationOwnership,
  installationOwnershipOf,
  installationScopeOf,
  objectInstallationEnv,
  scopeInstallationEnv,
  splitInstallationObjectName,
} from '../src/config/installation-scope.ts';
import {
  applyResolvedProviderKey,
  applyResolvedProviderKeys,
  deleteProviderApiKey,
  invalidateProviderKeyCache,
  isolateBindsModelCredentials,
  resolveProviderApiKey,
  saveProviderApiKey,
} from '../src/config/provider-keys.ts';
import { forgetRegisteredProvider, knownProviderIds } from '../src/config/providers.ts';
import { resolveRuntimeModel } from '../src/config/runtime-model.ts';
import { SettingsStoreLogic, SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { tagStateStub, type TagStateRpc } from '../src/config/state-rpc.ts';
import type { CustomAgentConfig, ResolvedAssignment } from '../src/config/types.ts';
import {
  bindStoreInstallation,
  InstallationBindingLogic,
  STANDALONE_INSTALLATION_IDENTITY,
  storeInstallationIdentity,
} from '../src/identity/installation-binding.ts';
import { IdentityStoreLogic } from '../src/identity/store.ts';
import { sandboxBindingInstalled } from '../src/sandbox/select.ts';
import { ThreadRunnerJobStore } from '../src/slack/thread-runner-jobs.ts';
import { threadRunnerStub } from '../src/slack/thread-runner-rpc.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { NodeStateDb } from '../src/state/node-state-db.ts';

const HOSTED = { CHICKPEA_TENANCY: 'installation' } as const;
const A = { organizationId: 'org_tenant_a', installationId: 'inst_tenant_a' };
const B = { organizationId: 'org_tenant_b', installationId: 'inst_tenant_b' };

const AGENT: CustomAgentConfig = {
  id: 'agent_shared_id',
  kind: 'user',
  revision: 1,
  name: 'Shared',
  instructions: 'Answer the thread.',
  enabled: true,
  model: 'openai/gpt-5.4-mini',
  skills: [],
  mcpServers: [],
  apiConnections: [],
  repositories: [],
};

const TURN: NormalizedSlackTurn = {
  workspaceId: 'T_SHARED',
  channelId: 'C_SHARED',
  eventId: 'E_SHARED',
  text: 'Hello',
  userId: 'U_SHARED',
  actorMembershipId: 'membership_shared',
  messageTs: '1788000000.000200',
  threadTs: '1788000000.000100',
  source: 'app_mention',
  contextMode: 'thread',
};

const ASSIGNMENT: ResolvedAssignment = {
  workspaceId: 'T_SHARED',
  channelId: 'C_SHARED',
  agentId: AGENT.id,
  agent: AGENT,
  runtimeContract: 'chickpea-v1',
  ownerIncarnation: 1,
  model: 'openai/gpt-5.4-mini',
  modelAttribution: { source: 'pinned', providerId: 'openai' },
};

function compiledPlan(env: Record<string, unknown>) {
  const installation = installationOwnershipOf(env);
  return compileRuntimePlanV2({
    ...(installation ? { installation } : {}),
    turn: TURN,
    assignment: ASSIGNMENT,
    instructions: AGENT.instructions,
    memoryEpoch: 1,
  });
}

/**
 * A TAG_STATE namespace whose objects run the same identity and settings
 * wiring TagStateStore does, one SQLite database per object name.
 */
function stateNamespace() {
  const objects = new Map<string, { env: Record<string, unknown>; stub: TagStateRpc }>();
  return {
    objects,
    getByName(name: string): TagStateRpc {
      let object = objects.get(name);
      if (!object) {
        const db = new NodeStateDb(new DatabaseSync(':memory:'));
        const env = objectInstallationEnv({ id: { name } }, HOSTED as Record<string, unknown>);
        const binding = new InstallationBindingLogic(db, env);
        const identity = new IdentityStoreLogic(db, { installation: () => storeInstallationIdentity(binding, env) });
        const settings = new SettingsStoreLogic(db);
        const call = <T>(fn: () => T) => {
          try {
            return Promise.resolve({ ok: true as const, value: fn() });
          } catch (error) {
            return Promise.resolve({
              ok: false as const,
              error: { code: 'internal' as const, message: (error as Error).message },
            });
          }
        };
        const stub = {
          identityExecute: (request: Parameters<IdentityStoreLogic['execute']>[0]) =>
            call(() => identity.execute(request)),
          settingGet: (key: string) => call(() => settings.getSetting(key) ?? null),
          settingSet: (key: string, value: string) => call(() => { settings.setSetting(key, value); return null; }),
          bindInstallation: (input: typeof A) => call(() => bindStoreInstallation(binding, env, input)),
        } as unknown as TagStateRpc;
        object = { env, stub };
        objects.set(name, object);
      }
      return object.stub;
    },
  };
}

test('two installations with colliding IDs keep separate state, and an unscoped env reaches none', async () => {
  const TAG_STATE = stateNamespace();
  const deployment = { ...HOSTED, TAG_STATE };
  const envA = scopeInstallationEnv(deployment, { installationId: A.installationId });
  const envB = scopeInstallationEnv(deployment, { installationId: B.installationId });
  const identity = (env: Record<string, unknown>) =>
    new CfIdentityStore(new FreshTagStateStubs(() => tagStateStub(env)));
  const settings = (env: Record<string, unknown>) =>
    new CfSettingsStore(new FreshTagStateStubs(() => tagStateStub(env)));

  // Before provisioning, identity work fails closed rather than using the standalone IDs.
  await assert.rejects(identity(envA).getAuthControl(), /not provisioned/);
  assert.equal((await tagStateStub(envA).bindInstallation(A)).ok, true);
  assert.equal((await tagStateStub(envB).bindInstallation(B)).ok, true);
  // A store is never rebound, and never bound to another installation's IDs.
  assert.equal((await tagStateStub(envA).bindInstallation({ ...A, organizationId: 'org_other' })).ok, false);
  assert.equal((await tagStateStub(envA).bindInstallation(B)).ok, false);

  for (const [env, ids] of [[envA, A], [envB, B]] as const) {
    const control = await identity(env).ensureAuthControl();
    assert.equal(control.installationId, ids.installationId);
    // Same Slack team, display name and setting key in both: nothing crosses.
    const organization = await identity(env).ensureOrganization({ displayName: 'Shared', slackTeamId: 'T_SHARED' });
    assert.equal(organization.id, ids.organizationId);
  }
  await settings(envA).setSetting('shared.key', 'value-a');
  await settings(envB).setSetting('shared.key', 'value-b');
  assert.equal(await settings(envA).getSetting('shared.key'), 'value-a');
  assert.equal(await settings(envB).getSetting('shared.key'), 'value-b');
  assert.deepEqual([...TAG_STATE.objects.keys()], ['i1~inst_tenant_a~singleton', 'i1~inst_tenant_b~singleton']);

  await assert.rejects(identity(deployment).getAuthControl(), /has none/);
  await assert.rejects(settings(deployment).getSetting('shared.key'), /has none/);
  assert.equal(TAG_STATE.objects.size, 2);
});

test('the installation binding survives a restart and standalone keeps its fixed IDs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-binding-'));
  try {
    const file = join(dir, 'state.db');
    const env = objectInstallationEnv({ id: { name: 'i1~inst_tenant_a~singleton' } }, HOSTED);
    const first = new DatabaseSync(file);
    assert.deepEqual(bindStoreInstallation(new InstallationBindingLogic(new NodeStateDb(first), env), env, A), A);
    first.close();
    const restarted = new InstallationBindingLogic(new NodeStateDb(new DatabaseSync(file)), env);
    assert.deepEqual(storeInstallationIdentity(restarted, env), A);
    assert.deepEqual(bindStoreInstallation(restarted, env, A), A);
    const otherObject = objectInstallationEnv({ id: { name: 'i1~inst_tenant_b~singleton' } }, HOSTED);
    assert.throws(() => storeInstallationIdentity(restarted, otherObject), /another installation/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const standaloneDb = new DatabaseSync(':memory:');
  const standalone = new InstallationBindingLogic(new NodeStateDb(standaloneDb), {});
  assert.equal(
    standaloneDb.prepare("SELECT name FROM sqlite_master WHERE name = 'installation_binding'").get(),
    undefined,
    'a standalone store never creates the binding table',
  );
  assert.deepEqual(storeInstallationIdentity(standalone, {}), STANDALONE_INSTALLATION_IDENTITY);
  assert.throws(() => bindStoreInstallation(standalone, {}, A), /Only this installation/);
  const hosted = objectInstallationEnv({ id: { name: 'i1~installation_oss~singleton' } }, HOSTED);
  assert.throws(
    () => bindStoreInstallation(standalone, hosted, { organizationId: 'org_x', installationId: 'installation_oss' }),
    /globally unique/,
  );
});

test('a hosted plan names its installation, and its instance is scoped to it', () => {
  const standalone = compiledPlan({});
  const planA = compiledPlan(scopeInstallationEnv(HOSTED, { installationId: A.installationId }));
  const planB = compiledPlan(scopeInstallationEnv(HOSTED, { installationId: B.installationId }));
  assert.equal(standalone.installation, undefined);
  assert.deepEqual(planA.installation, { version: 1, installationId: A.installationId });

  const standaloneId = deriveRuntimePlanInstanceId(standalone);
  const idA = deriveRuntimePlanInstanceId(planA);
  const idB = deriveRuntimePlanInstanceId(planB);
  assert.match(standaloneId, /^agent_[a-f0-9]{40}$/);
  assert.equal(idA, `i1~inst_tenant_a~${standaloneId}`);
  assert.equal(idB, `i1~inst_tenant_b~${standaloneId}`);
  for (const id of [standaloneId, idA, idB]) assert.ok(isRuntimePlanInstanceId(id));
  for (const id of ['i1~inst_tenant_a~agent_x', 'i1~bad id~' + standaloneId, 'agent_']) {
    assert.equal(isRuntimePlanInstanceId(id), false);
  }

  // Persisted and read back after a restart: same ownership, same instance.
  const restored = parseRuntimePlanV2(JSON.parse(JSON.stringify(planA)));
  assert.deepEqual(restored.installation, planA.installation);
  assert.equal(deriveRuntimePlanInstanceId(restored), idA);
  assert.ok(runtimePlanInstanceIdMatches(restored, idA));
  assert.equal(runtimePlanInstanceIdMatches(restored, idB), false);
  // The per-plan derivation of earlier releases is scoped the same way, so no
  // derivation of a hosted plan names an unscoped object.
  const legacyA = deriveLegacyRuntimePlanInstanceId(restored);
  assert.match(legacyA, /^i1~inst_tenant_a~agent_[a-f0-9]{40}$/);
  assert.ok(runtimePlanInstanceIdMatches(restored, legacyA));
  assert.equal(runtimePlanInstanceIdMatches(restored, splitInstallationObjectName(legacyA).name), false);
  // The object named by the instance recovers the plan's installation.
  const objectEnv = objectInstallationEnv({ id: { name: idA } }, HOSTED);
  assertInstallationOwnership(restored.installation, objectEnv);
  assertRuntimePlanInstallation(restored, idA);

  // The revision binds the ownership: editing it does not parse.
  assert.throws(
    () => parseRuntimePlanV2({ ...planA, installation: planB.installation }),
    /harnessRevision/,
  );
  assert.throws(() => parseRuntimePlanV2({ ...planA, installation: { version: 1 } }), /malformed/);
  assert.throws(() => assertRuntimePlanInstallation(planA, idB), /another installation/);
  assert.throws(() => assertRuntimePlanInstallation(planA, standaloneId), /another installation/);
  assert.throws(() => assertRuntimePlanInstallation(standalone, idA), /another installation/);
  assertRuntimePlanInstallation(standalone, standaloneId);

  const input = createSlackTurnInput({ turnJobId: 'turn_a', instanceId: idA, runtimePlan: planA });
  assert.equal(parseSlackTurnInput(JSON.stringify(input)).instanceId, idA);
  assert.throws(
    () => parseSlackTurnInput(JSON.stringify({ ...input, instanceId: idB })),
    /another instance/,
  );
});

test('a thread runner keeps the installation of each job across a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-runner-'));
  try {
    const file = join(dir, 'runner.db');
    const ownership = { version: 1 as const, installationId: A.installationId };
    const first = new DatabaseSync(file);
    const store = new ThreadRunnerJobStore(new NodeStateDb(first));
    assert.deepEqual(store.admit({ id: 'job_a', threadKey: 'T_SHARED:C_SHARED:1.0', payload: {}, installation: ownership }, 1), { admitted: true });
    assert.deepEqual(store.admit({ id: 'job_standalone', threadKey: 'T_SHARED:C_SHARED:1.0', payload: {} }, 2), { admitted: true });
    first.close();

    const restarted = new ThreadRunnerJobStore(new NodeStateDb(new DatabaseSync(file)));
    const job = restarted.get('job_a');
    assert.deepEqual(job?.installation, ownership);
    assert.equal(restarted.get('job_standalone')?.installation, undefined);
    const runnerName = 'i1~inst_tenant_a~T_SHARED:C_SHARED:1.0';
    assertInstallationOwnership(job?.installation, objectInstallationEnv({ id: { name: runnerName } }, HOSTED));
    assert.throws(
      () => assertInstallationOwnership(
        job?.installation,
        objectInstallationEnv({ id: { name: 'i1~inst_tenant_b~T_SHARED:C_SHARED:1.0' } }, HOSTED),
      ),
      /another installation/,
    );
    assert.throws(
      () => store.admit({ id: 'job_bad', threadKey: 'k', payload: {}, installation: { version: 1, installationId: '../x' } }, 3),
      /malformed/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('thread runners are named under the installation that hands them a turn', () => {
  const names: string[] = [];
  const SLACK_THREAD_RUNNER = { getByName(name: string) { names.push(name); return {} as never; } };
  threadRunnerStub({ SLACK_THREAD_RUNNER }, 'T1:C1:1.0');
  threadRunnerStub(scopeInstallationEnv({ ...HOSTED, SLACK_THREAD_RUNNER }, { installationId: A.installationId }), 'T1:C1:1.0');
  assert.throws(() => threadRunnerStub({ ...HOSTED, SLACK_THREAD_RUNNER }, 'T1:C1:1.0'), /has none/);
  assert.deepEqual(names, ['T1:C1:1.0', 'i1~inst_tenant_a~T1:C1:1.0']);
});

class MemoryLookup implements InstallationLookup {
  constructor(private readonly records: InstallationRecord[]) {}
  async find(key: InstallationKey) {
    return this.records.find((record) => 'slackTeamId' in key
      ? record.slackTeamId === key.slackTeamId
      : record.identity.installationId === key.installationId);
  }
  async listActive() {
    return this.records.filter((record) => record.status === 'active');
  }
}

test('only an active installation resolves to an env, and cron runs once per active installation', async () => {
  const lookup = new MemoryLookup([
    { identity: { organizationId: 'org_bad', installationId: '../bad' }, slackTeamId: 'T_BAD', status: 'active' },
    { identity: A, slackTeamId: 'T_A', status: 'active' },
    { identity: B, slackTeamId: 'T_B', status: 'suspended' },
    { identity: { organizationId: 'org_c', installationId: 'inst_c' }, slackTeamId: 'T_C', status: 'active' },
  ]);
  const env = await resolveInstallationEnv(lookup, HOSTED as Record<string, unknown>, { slackTeamId: 'T_A' });
  assert.deepEqual(installationScopeOf(env), { installationId: A.installationId });
  assert.deepEqual(
    installationScopeOf(await resolveInstallationEnv(lookup, HOSTED as Record<string, unknown>, { installationId: 'inst_c' })),
    { installationId: 'inst_c' },
  );
  for (const key of [{ slackTeamId: 'T_B' }, { slackTeamId: 'T_UNKNOWN' }, { installationId: B.installationId }]) {
    await assert.rejects(
      resolveInstallationEnv(lookup, HOSTED as Record<string, unknown>, key),
      /No active installation serves this request/,
    );
  }
  const lying: InstallationLookup = { find: async () => ({ identity: A, slackTeamId: 'T_A', status: 'active' }), listActive: async () => [] };
  await assert.rejects(resolveInstallationEnv(lying, HOSTED as Record<string, unknown>, { slackTeamId: 'T_C' }), /another installation/);

  const seen: Array<string | undefined> = [];
  const waits: Promise<unknown>[] = [];
  const handler = scheduledForEachInstallation(
    {
      scheduled: (_controller, scopedEnv) => {
        const installationId = installationScopeOf(scopedEnv)?.installationId;
        seen.push(installationId);
        // A failure in one installation's duties stays with that installation.
        if (installationId === A.installationId) throw new Error('duty failed');
      },
    },
    () => lookup,
  );
  handler.scheduled({ scheduledTime: 1 }, { ...HOSTED }, { waitUntil: (promise) => { waits.push(promise); } });
  while (waits.length) await waits.shift();
  assert.deepEqual(seen, [A.installationId, 'inst_c']);

  // A lookup whose active list is wrong still never runs a suspended installation.
  const stale: InstallationLookup = {
    find: async () => undefined,
    listActive: async () => [{ identity: B, slackTeamId: 'T_B', status: 'suspended' }],
  };
  const ranStale: Array<string | undefined> = [];
  scheduledForEachInstallation(
    { scheduled: (_controller, scopedEnv) => { ranStale.push(installationScopeOf(scopedEnv)?.installationId); } },
    () => stale,
  ).scheduled({ scheduledTime: 2 }, { ...HOSTED }, { waitUntil: (promise) => { waits.push(promise); } });
  while (waits.length) await waits.shift();
  assert.deepEqual(ranStale, []);
});

test('coding sandboxes are not offered to a deployment serving many installations', () => {
  assert.equal(sandboxBindingInstalled({ SANDBOX: {} }), true);
  assert.equal(sandboxBindingInstalled({ ...HOSTED, SANDBOX: {} } as never), false);
});

test('the state store, thread runners and Flue agents serve the installation their name carries', () => {
  const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
  assert.match(source('cloudflare.ts'), /class TagStateStore[\s\S]*?super\(ctx, objectInstallationEnv\(ctx, env\)\)/);
  assert.match(source('slack/thread-runner.ts'), /super\(ctx, objectInstallationEnv\(ctx, env\)\)/);
  assert.match(source('agents/turn-input.ts'), /extends \(\s*installationAgentObject\(Base\)/);
  for (const agent of ['coding-worker.ts', 'routine-execution.ts', 'routine-intent.ts']) {
    assert.match(source(`agents/${agent}`), /export const cloudflare = installationAgentExtension;/);
  }
  assert.match(source('agents/slack-thread.ts'), /export const cloudflare = slackThreadCloudflareExtension;/);
});

test('a Flue agent object hands its base the env of the installation its instance ID names', () => {
  const received: unknown[] = [];
  class FakeAgentBase {
    constructor(_ctx: unknown, env: unknown) { received.push(env); }
  }
  const Agent = installationAgentObject(FakeAgentBase) as new (ctx: { id: { name?: string } }, env: unknown) => object;
  new Agent({ id: { name: 'i1~inst_tenant_a~agent_x' } }, HOSTED);
  new Agent({ id: { name: 'agent_x' } }, HOSTED);
  const standalone = {};
  new Agent({ id: { name: 'agent_x' } }, standalone);
  assert.deepEqual(installationScopeOf(received[0] as Record<string, unknown>), { installationId: A.installationId });
  assert.equal(received[1], HOSTED, 'an unscoped name keeps the unscoped env, which fails closed');
  assert.equal(received[2], standalone, 'standalone is unchanged');
  assert.throws(
    () => new Agent({ id: { name: 'i1~inst_tenant_a~agent_x' } }, standalone),
    /standalone deployment serves no installation/,
    'a standalone deployment never runs an installation-scoped plan against its own stores',
  );
  assert.equal(received.length, 3);
});

test('a deployment serving many installations never binds a model key to the shared isolate', async () => {
  const scoped = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: A.installationId });
  const reads: string[] = [];
  const settings = { getSetting: async (key: string) => { reads.push(key); return 'sk-tenant-a'; } } as never;
  assert.equal(isolateBindsModelCredentials({}), true);
  assert.equal(isolateBindsModelCredentials(scoped), false);
  await assert.rejects(applyResolvedProviderKey('anthropic', scoped, settings), /does not bind model credentials/);
  await applyResolvedProviderKeys(scoped, settings);
  assert.deepEqual(reads, [], 'neither reads a key it may not bind');
});

test('each installation saves and reads its own model keys without binding the isolate', async (t) => {
  invalidateProviderKeyCache();
  forgetRegisteredProvider('anthropic');
  // Any read that missed its installation's cache would open this store.
  const sentinel = join(mkdtempSync(join(tmpdir(), 'chickpea-keys-')), 'ambient.db');
  const previousPath = process.env.SLACK_STATE_DB_PATH;
  process.env.SLACK_STATE_DB_PATH = sentinel;
  t.after(() => {
    if (previousPath === undefined) delete process.env.SLACK_STATE_DB_PATH;
    else process.env.SLACK_STATE_DB_PATH = previousPath;
    rmSync(dirname(sentinel), { recursive: true, force: true });
  });
  const envA = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: A.installationId });
  const envB = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: B.installationId });
  const [settingsA, settingsB] = [new SqliteSettingsStore(':memory:'), new SqliteSettingsStore(':memory:')];
  const [usageA, usageB] = [new SqliteUsageStore(':memory:'), new SqliteUsageStore(':memory:')];
  try {
    await saveProviderApiKey('anthropic', 'sk-tenant-a', envA, settingsA, usageA);
    await saveProviderApiKey('anthropic', 'sk-tenant-b', envB, settingsB, usageB);
    // Saving primed each installation's own cache entry; neither read touches a store.
    assert.equal((await resolveProviderApiKey('anthropic', envA)).apiKey, 'sk-tenant-a');
    assert.equal((await resolveProviderApiKey('anthropic', envB)).apiKey, 'sk-tenant-b');
    assert.equal(knownProviderIds({}).has('anthropic'), false, 'no save bound the shared provider');

    const deleted = await deleteProviderApiKey('anthropic', envA, settingsA, usageA);
    assert.equal(deleted.source, 'missing');
    assert.equal((await resolveProviderApiKey('anthropic', envA)).apiKey, undefined);
    assert.equal((await resolveProviderApiKey('anthropic', envB)).apiKey, 'sk-tenant-b');
    assert.equal(knownProviderIds({}).has('anthropic'), false);
    assert.equal(existsSync(sentinel), false, 'every read was served from its own installation');
  } finally {
    invalidateProviderKeyCache();
    forgetRegisteredProvider('anthropic');
    for (const store of [settingsA, settingsB]) store.close();
    for (const store of [usageA, usageB]) store.close();
  }
});

test('a ChatGPT plan session is never bound to the isolate a deployment shares between installations', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Cloudflare-Workers' } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  await saveOpenAiAuthMethod(settings, 'subscription');
  const env = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: A.installationId });
  await assert.rejects(
    resolveRuntimeModel('agent_plan', 'openai/gpt-5.4', {
      settings,
      env: env as never,
      loadCatalog: async () => { throw new Error('must not load the catalog'); },
    }),
    /does not bind model credentials/,
  );
});
