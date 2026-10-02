import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import {
  configureComposioPlatformSettings,
  resolveComposioConfiguration,
  type ComposioSettingsStore,
} from '../src/config/composio-settings.ts';
import { InstallationContextError, scopeInstallationEnv } from '../src/config/installation-scope.ts';
import type { SettingsPatch } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { ConnectionAccount } from '../src/config/types.ts';
import {
  ComposioPlatformConfigurationError,
  ComposioPlatformReconciliationRequiredError,
  prepareComposioPlatform,
} from '../src/connections/composio-setup.ts';
import { reconcileInstallationManagedConnections } from '../src/connections/hosted-reconcile.ts';
import type { ComposioAuthConfigLike, ComposioClientLike } from '../src/connections/providers/composio.ts';
import type { ManagedProviderAccountInspection } from '../src/connections/store.ts';

/**
 * After the operator changes the deployment's Composio key and reconciles
 * the platform once, each installation's managed accounts are reconciled on
 * their own, by the host, with the deployment key: only that installation's
 * accounts and principals, never the platform record.
 */

const OLD_KEY = 'ak_hosted_platform_key_before';
const NEW_KEY = 'ak_hosted_platform_key_after';
const DEPLOYMENT = { CHICKPEA_TENANCY: 'installation', CHICKPEA_COMPOSIO_ENVIRONMENT: 'staging' } as const;

/** The platform store a host serves from its registry database; installations read it only. */
class PlatformSettings implements ComposioSettingsStore {
  readonly values = new Map<string, string>();
  writes = 0;

  async getSetting(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async applySettingsPatch(patch: SettingsPatch): Promise<boolean> {
    const fences = [...(patch.expected ? [patch.expected] : []), ...(patch.expectedAll ?? [])];
    if (fences.some(({ key, value }) => (this.values.get(key) ?? null) !== value)) return false;
    this.writes += 1;
    for (const { key, value } of patch.set ?? []) this.values.set(key, value);
    for (const key of patch.delete ?? []) this.values.delete(key);
    return true;
  }
}

/** A Composio project whose auth configs preparation reuses. */
function project(): ComposioClientLike {
  const configs = new Map<string, ComposioAuthConfigLike[]>();
  return {
    authConfigs: {
      list: async (query) => ({ items: query?.toolkit ? [...(configs.get(query.toolkit) ?? [])] : [], nextCursor: null, totalPages: 1 }),
      create: async (toolkit) => {
        const id = `ac_${toolkit}_platform`;
        configs.set(toolkit, [{
          id, name: `Chickpea default — ${toolkit} v1`, toolkit: { slug: toolkit }, status: 'ENABLED',
          credentials: {}, restrictToFollowingTools: [], isComposioManaged: true, createdAt: '2026-10-02T00:00:00.000Z',
          toolAccessConfig: { toolsAvailableForExecution: [], toolsForConnectedAccountCreation: [] },
        }]);
        return { id, authScheme: 'OAUTH2', isComposioManaged: true, toolkit };
      },
      get: async (id) => [...configs.values()].flat().find((item) => item.id === id)!,
    },
    connectedAccounts: { link: async () => { throw new Error('unused'); } },
    sessions: { async create() { throw new Error('unused'); } },
  } as ComposioClientLike;
}

async function platform(t: TestContext) {
  const settings = new PlatformSettings();
  const client = project();
  configureComposioPlatformSettings(() => settings);
  t.after(() => configureComposioPlatformSettings(undefined));
  const prepare = (apiKey: string, reconcile = false) => prepareComposioPlatform({
    env: { ...DEPLOYMENT, COMPOSIO_API_KEY: apiKey }, settings, reconcile, createClient: async () => client,
  });
  await prepare(OLD_KEY);
  const before = await resolveComposioConfiguration({ env: { ...DEPLOYMENT, COMPOSIO_API_KEY: OLD_KEY } });
  return { settings, prepare, generation: before.generation, lineage: before.keyFingerprint! };
}

function principal(installationId: string): string {
  return `chickpea:staging:installation:${installationId}:membership:membership_shared`;
}

/** One installation with colliding local IDs: the same Agent, account and schedule IDs as its neighbour. */
async function installation(t: TestContext, installationId: string, accounts: number, prepared: { generation: number; lineage: string }) {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  t.after(() => config.close());
  await config.createAgent({
    id: 'agent_shared', name: 'Mail', instructions: 'Help with mail.', enabled: true,
    creatorMembershipId: 'membership_shared', editPolicy: 'creator_and_admins',
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  });
  await config.ensureWorkspaceInstallation({ workspaceId: 'T_SHARED', transportMode: 'direct', defaultAgentId: 'agent_shared' });
  const ids: string[] = [];
  for (let index = 0; index < accounts; index += 1) {
    const account = await config.putConnectionAccount({
      id: `connection_shared_${index}`, workspaceId: 'T_SHARED', ownerKind: 'member',
      ownerMembershipId: 'membership_shared', createdByMembershipId: 'membership_shared',
      providerId: 'google', label: 'Work Gmail', lifecycle: 'ready', secretRefId: `secret_shared_${index}`,
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'gmail', principalRef: principal(installationId),
        accountRef: `ca_${installationId}_${index}`, allowedCapabilities: ['gmail.messages.search'],
        providerGeneration: prepared.generation, providerLineage: prepared.lineage,
      },
    }, 0);
    ids.push(account.id);
  }
  await config.putAgentConnectionBinding({
    agentId: 'agent_shared', connectionAccountId: ids[0]!, providerId: 'google',
    allowedCapabilities: ['gmail.messages.search'], enabled: true,
  });
  await config.putAgentScheduleReference({
    scheduleId: 'schedule_shared', agentId: 'agent_shared', workspaceId: 'T_SHARED', channelId: 'C_SHARED',
    createdByMembershipId: 'membership_shared', runsAsMembershipId: 'membership_shared',
    authorityReceiptId: 'authority_shared', requiredConnectionAccountIds: [ids[0]!], state: 'active',
  });
  const env = scopeInstallationEnv({ ...DEPLOYMENT, COMPOSIO_API_KEY: NEW_KEY }, { installationId });
  const accountsOf = async (): Promise<ConnectionAccount[]> => config.listConnectionAccounts('T_SHARED');
  const schedule = async () => (await config.listAgentScheduleReferences('agent_shared'))[0]!;
  return { env, config, accountsOf, schedule };
}

/** Inspections the deployment key would make, answered from what Composio holds. */
function composio(owners: Map<string, string>, answer?: (accountRef: string) => ManagedProviderAccountInspection) {
  const inspected: Array<{ apiKey: string; accountRef: string; principalRef: string }> = [];
  const inspect = async (input: { apiKey: string; accountRef: string; principalRef: string; toolkit: string }) => {
    inspected.push({ apiKey: input.apiKey, accountRef: input.accountRef, principalRef: input.principalRef });
    const override = answer?.(input.accountRef);
    if (override) return override;
    return owners.get(input.accountRef) === input.principalRef ? 'match' as const : 'mismatch' as const;
  };
  return { inspected, inspect };
}

const LATER = () => Date.now() + 60_000;

test('each installation reconciles only its own accounts, with the deployment key, after the operator reconciles once', async (t) => {
  const prepared = await platform(t);
  const a = await installation(t, 'inst_rec_a', 1, prepared);
  const b = await installation(t, 'inst_rec_b', 1, prepared);
  // The operator uploads the new key and reconciles the platform record, once.
  const operator = await prepared.prepare(NEW_KEY, true);
  assert.equal(operator.reconciled, true);
  const after = await resolveComposioConfiguration({ env: a.env });
  const writes = prepared.settings.writes;

  const owners = new Map([['ca_inst_rec_a_0', principal('inst_rec_a')], ['ca_inst_rec_b_0', principal('inst_rec_b')]]);
  const remote = composio(owners);
  assert.deepEqual(await reconcileInstallationManagedConnections(a.env, {
    deadlineAt: LATER(), config: a.config, inspect: remote.inspect,
  }), { restored: 1, needsAttention: 0, retryable: 0, done: true });
  assert.deepEqual(remote.inspected, [{ apiKey: NEW_KEY, accountRef: 'ca_inst_rec_a_0', principalRef: principal('inst_rec_a') }]);
  const [accountA] = await a.accountsOf();
  assert.equal(accountA?.lifecycle, 'ready');
  assert.equal(accountA?.policy.kind === 'managed' && accountA.policy.providerGeneration, after.generation);
  assert.equal(accountA?.policy.kind === 'managed' && accountA.policy.providerLineage, after.keyFingerprint);
  // B, with the same local IDs, was not touched.
  const [accountB] = await b.accountsOf();
  assert.equal(accountB?.policy.kind === 'managed' && accountB.policy.providerGeneration, prepared.generation);

  assert.deepEqual(await reconcileInstallationManagedConnections(b.env, {
    deadlineAt: LATER(), config: b.config, inspect: remote.inspect,
  }), { restored: 1, needsAttention: 0, retryable: 0, done: true });
  assert.equal(prepared.settings.writes, writes, 'installations never write the platform record');
  assert.deepEqual(await reconcileInstallationManagedConnections(a.env, {
    deadlineAt: LATER(), config: a.config, inspect: remote.inspect,
  }), { restored: 0, needsAttention: 0, retryable: 0, done: true }, 'running it again inspects nothing');
  assert.equal(remote.inspected.length, 2);
});

test('an account Composio no longer holds for this installation needs attention, and its schedule pauses', async (t) => {
  const prepared = await platform(t);
  const a = await installation(t, 'inst_rec_a', 1, prepared);
  await prepared.prepare(NEW_KEY, true);
  // Composio reports the account as another installation's.
  const remote = composio(new Map([['ca_inst_rec_a_0', principal('inst_rec_b')]]));
  assert.deepEqual(await reconcileInstallationManagedConnections(a.env, {
    deadlineAt: LATER(), config: a.config, inspect: remote.inspect,
  }), { restored: 0, needsAttention: 1, retryable: 0, done: true });
  assert.equal((await a.accountsOf())[0]?.lifecycle, 'needs_attention');
  const paused = await a.schedule();
  assert.equal(paused.state, 'needs_attention');
  assert.deepEqual(paused.connectionPauseAccountIds, ['connection_shared_0']);
});

test('transient inspections stay retryable, batches continue within the deadline, and a later call finishes', async (t) => {
  const prepared = await platform(t);
  const a = await installation(t, 'inst_rec_a', 30, prepared);
  await prepared.prepare(NEW_KEY, true);
  const owners = new Map(Array.from({ length: 30 }, (_, index) => [`ca_inst_rec_a_${index}`, principal('inst_rec_a')]));

  // Composio is unreachable: nothing changes and everything stays to retry.
  const down = composio(owners, () => 'transient');
  assert.deepEqual(await reconcileInstallationManagedConnections(a.env, {
    deadlineAt: LATER(), config: a.config, inspect: down.inspect,
  }), { restored: 0, needsAttention: 0, retryable: 30, done: false });
  assert.ok((await a.accountsOf()).every((account) => account.policy.kind === 'managed' &&
    account.policy.providerGeneration === prepared.generation));

  // The deadline passes during the first batch of 25: the call stops there.
  let clock = 1_000;
  const slow = composio(owners);
  const timed = async (input: Parameters<typeof slow.inspect>[0]) => { clock += 10; return slow.inspect(input); };
  assert.deepEqual(await reconcileInstallationManagedConnections(a.env, {
    deadlineAt: 1_100, now: () => clock, config: a.config, inspect: timed,
  }), { restored: 25, needsAttention: 0, retryable: 5, done: false });
  assert.deepEqual(await reconcileInstallationManagedConnections(a.env, {
    deadlineAt: LATER(), config: a.config, inspect: slow.inspect,
  }), { restored: 5, needsAttention: 0, retryable: 0, done: true });
});

test('a missing or pending platform record refuses before any inspection; standalone is refused', async (t) => {
  const settings = new PlatformSettings();
  configureComposioPlatformSettings(() => settings);
  t.after(() => configureComposioPlatformSettings(undefined));
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  t.after(() => config.close());
  const env = scopeInstallationEnv({ ...DEPLOYMENT, COMPOSIO_API_KEY: OLD_KEY }, { installationId: 'inst_rec_a' });
  const inspect = async () => { throw new Error('nothing is inspected'); };
  await assert.rejects(reconcileInstallationManagedConnections(env, { deadlineAt: LATER(), config, inspect }),
    (error: unknown) => error instanceof ComposioPlatformConfigurationError && /not prepared/.test(error.message));

  // Prepared under the old key; the new key is deployed but the operator has not reconciled.
  await prepareComposioPlatform({
    env: { ...DEPLOYMENT, COMPOSIO_API_KEY: OLD_KEY }, settings, createClient: async () => project(),
  });
  await assert.rejects(prepareComposioPlatform({
    env: { ...DEPLOYMENT, COMPOSIO_API_KEY: NEW_KEY }, settings, createClient: async () => project(),
  }), ComposioPlatformReconciliationRequiredError);
  const pending = scopeInstallationEnv({ ...DEPLOYMENT, COMPOSIO_API_KEY: NEW_KEY }, { installationId: 'inst_rec_a' });
  await assert.rejects(reconcileInstallationManagedConnections(pending, { deadlineAt: LATER(), config, inspect }),
    (error: unknown) => error instanceof ComposioPlatformConfigurationError && /awaiting the operator/.test(error.message));

  await assert.rejects(reconcileInstallationManagedConnections({ COMPOSIO_API_KEY: OLD_KEY }, {
    deadlineAt: LATER(), config, inspect,
  }), InstallationContextError);
});
