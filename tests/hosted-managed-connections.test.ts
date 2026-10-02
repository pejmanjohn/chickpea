import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { AuthorizationError } from '../src/auth/permissions.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import {
  completeComposioReconciliation,
  ComposioConfigurationMutationError,
  composioConfigurationIsMutable,
  configureComposioPlatformSettings,
  disableStoredComposioConfiguration,
  recordComposioPreparationResult,
  resolveComposioConfiguration,
  saveStoredComposioProjectKey,
  type ComposioSettingsStore,
} from '../src/config/composio-settings.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore, type SettingsPatch } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { MANAGED_CONNECTOR_CATALOG } from '../src/connections/catalog/index.ts';
import {
  ComposioPlatformConfigurationError,
  ComposioPlatformReconciliationRequiredError,
  ComposioSetupInProgressError,
  prepareComposioPlatform,
  prepareResolvedComposioManagedAuthConfigs,
} from '../src/connections/composio-setup.ts';
import {
  beginManagedAuthorization,
  recordManagedAuthorizationRequest,
} from '../src/connections/managed-authorization.ts';
import {
  managedPrincipalRef,
  pollManagedAuthorizationFlow,
  startManagedAuthorizationFlow,
  type ManagedAuthorizationProviderContext,
} from '../src/connections/managed-authorization-flow.ts';
import { resolveManagedAuthorizationProviderContext } from '../src/connections/managed-provider-context.ts';
import {
  createManagedConnectionProviderRegistry,
  type ManagedConnectionProvider,
} from '../src/connections/managed.ts';
import {
  ComposioManagedConnectionProvider,
  type ComposioAuthConfigLike,
  type ComposioClientLike,
  type ComposioConnectedAccount,
} from '../src/connections/providers/composio.ts';
import { ConnectionAccountService } from '../src/connections/store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

const PLATFORM_KEY = 'ak_hosted_platform_project_key';
const HOSTED = {
  CHICKPEA_TENANCY: 'installation',
  COMPOSIO_API_KEY: PLATFORM_KEY,
  CHICKPEA_COMPOSIO_ENVIRONMENT: 'staging',
} as const;
const PREPARATION = 'managed.composio.environment_preparation';
const LEASE = 'managed.composio.setup_lease';
const TOOLKITS = MANAGED_CONNECTOR_CATALOG.list().map(({ toolkit }) => toolkit);
const ADMIN_TOKEN = 'hosted-managed-connections-token';

function hostedEnv(installationId: string, overrides: Record<string, unknown> = {}) {
  return scopeInstallationEnv({ ...HOSTED, ...overrides }, { installationId });
}

/** The platform store a host serves from its registry database. */
class PlatformSettings implements ComposioSettingsStore {
  readonly values = new Map<string, string>();
  writes = 0;
  reads = 0;

  async getSetting(key: string): Promise<string | undefined> {
    this.reads += 1;
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

/** One shared Composio project: auth configs plus the connected accounts it links. */
class FakeComposioProject {
  readonly configs = new Map<string, ComposioAuthConfigLike[]>();
  readonly accounts = new Map<string, { userId: string; toolkit: string; status: string }>();
  readonly links: Array<{ userId: string; authConfigId: string; accountRef: string }> = [];
  readonly revoked: string[] = [];
  creates = 0;
  clients = 0;
  listDelay: Promise<void> | undefined;

  client(): ComposioClientLike {
    this.clients += 1;
    return {
      authConfigs: {
        list: async (query) => {
          // Only preparation lists by toolkit; key validation lists unfiltered.
          if (query?.toolkit) await this.listDelay;
          const items = query?.toolkit ? [...(this.configs.get(query.toolkit) ?? [])] : [];
          return { items, nextCursor: null, totalPages: 1 };
        },
        create: async (toolkit) => {
          this.creates += 1;
          const id = `ac_${toolkit}_platform`;
          this.configs.set(toolkit, [...(this.configs.get(toolkit) ?? []), compatible(toolkit, id)]);
          return { id, authScheme: 'OAUTH2', isComposioManaged: true, toolkit };
        },
        get: async (id) => {
          const value = [...this.configs.values()].flat().find((item) => item.id === id);
          if (!value) throw new Error('missing auth config');
          return value;
        },
      },
      connectedAccounts: {
        link: async (userId, authConfigId) => {
          const accountRef = `ca_${this.links.length + 1}`;
          const toolkit = authConfigId.replace(/^ac_/, '').replace(/_platform$/, '');
          this.links.push({ userId, authConfigId, accountRef });
          this.accounts.set(accountRef, { userId, toolkit, status: 'ACTIVE' });
          return { id: accountRef, redirectUrl: `https://connect.composio.dev/link/${accountRef}` };
        },
      },
      sessions: {
        async create() { throw new Error('sessions are unused here'); },
      },
    };
  }

  async getConnectedAccount(input: { accountRef: string }): Promise<ComposioConnectedAccount> {
    const account = this.accounts.get(input.accountRef);
    if (!account) throw new Error('missing connected account');
    return {
      id: input.accountRef,
      status: account.status,
      isDisabled: false,
      toolkit: account.toolkit,
      userId: account.userId,
    };
  }

  /** The provider an installation builds from the platform configuration it resolves. */
  async providerContext(
    env: Record<string, unknown>,
    settings: SqliteSettingsStore,
  ): Promise<ManagedAuthorizationProviderContext> {
    const resolved = await resolveComposioConfiguration({ env, settings });
    const generation = resolved.generation;
    const lineage = resolved.keyFingerprint ?? '0'.repeat(24);
    const provider = new ComposioManagedConnectionProvider({
      ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
      authConfigIds: resolved.authConfigIds,
      createClient: async () => this.client(),
      getConnectedAccount: (input) => this.getConnectedAccount(input),
      revokeAccount: async ({ accountRef }) => { this.revoked.push(accountRef); },
    });
    return {
      providers: createManagedConnectionProviderRegistry([provider], { composio: { generation, lineage } }),
      generation,
      lineage,
      platformEnv: env,
    };
  }
}

function compatible(toolkit: string, id: string): ComposioAuthConfigLike {
  return {
    id,
    name: `Chickpea default — ${toolkit} v1`,
    toolkit: { slug: toolkit },
    status: 'ENABLED',
    credentials: {},
    restrictToFollowingTools: [],
    isComposioManaged: true,
    createdAt: '2026-10-02T00:00:00.000Z',
    toolAccessConfig: { toolsAvailableForExecution: [], toolsForConnectedAccountCreation: [] },
  };
}

async function withPlatform(
  run: (input: { platform: PlatformSettings; project: FakeComposioProject }) => Promise<void>,
): Promise<void> {
  const platform = new PlatformSettings();
  const project = new FakeComposioProject();
  configureComposioPlatformSettings(() => platform);
  try {
    await run({ platform, project });
  } finally {
    configureComposioPlatformSettings(undefined);
  }
}

async function prepare(platform: PlatformSettings, project: FakeComposioProject) {
  return prepareComposioPlatform({
    env: HOSTED,
    settings: platform,
    createClient: async () => project.client(),
  });
}

/** Colliding local identities: both installations have the same IDs inside. */
function principal(overrides: Partial<AuthPrincipal> = {}): AuthPrincipal {
  return {
    userId: 'user_shared',
    membershipId: 'membership_shared',
    organizationId: 'org_shared',
    role: 'owner',
    authenticatorKind: 'better_auth',
    credentialId: 'credential_shared',
    correlationId: 'correlation_shared',
    machine: false,
    ...overrides,
  };
}

interface Installation {
  env: Record<string, unknown>;
  config: SqliteConfigStore;
  settings: SqliteSettingsStore;
  agent: CustomAgentConfig;
  close(): void;
}

async function installation(installationId: string): Promise<Installation> {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const agent = await config.createAgent({
    id: 'agent_shared',
    name: 'Shared',
    creatorMembershipId: 'membership_shared',
    editPolicy: 'creator_and_admins',
    lifecycle: 'active',
    configurationGeneration: 1,
    instructions: 'Use managed connections.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  await config.ensureWorkspaceInstallation({
    workspaceId: 'T_SHARED', transportMode: 'direct', defaultAgentId: agent.id,
  });
  return {
    env: hostedEnv(installationId),
    config,
    settings,
    agent,
    close: () => { config.close(); settings.close(); },
  };
}

async function connect(
  project: FakeComposioProject,
  target: Installation,
  input: { ownerKind?: 'member' | 'team'; connectionAccountId?: string; toolkit?: string } = {},
) {
  const dependencies = {
    config: target.config,
    settings: target.settings,
    catalog: MANAGED_CONNECTOR_CATALOG,
    providerContext: await project.providerContext(target.env, target.settings),
  };
  const started = await startManagedAuthorizationFlow(dependencies, {
    principal: principal(),
    agent: target.agent,
    workspaceId: 'T_SHARED',
    ...(input.connectionAccountId
      ? { connectionAccountId: input.connectionAccountId }
      : { ownerKind: input.ownerKind ?? 'member', toolkit: input.toolkit ?? 'gmail', access: 'read' as const }),
  });
  return { dependencies, started };
}

async function managedSettingKeys(settings: SqliteSettingsStore): Promise<string[]> {
  const keys = [PREPARATION, LEASE, 'managed.composio.configuration'];
  const values = await settings.getSettings(keys);
  return keys.filter((_, index) => values[index] !== undefined);
}

test('installations read one platform preparation and never write it or their own copy', async () => {
  await withPlatform(async ({ platform, project }) => {
    const prepared = await prepare(platform, project);
    assert.equal(prepared.status, 'ready');
    assert.equal(project.creates, TOOLKITS.length);
    const writes = platform.writes;
    const a = { env: hostedEnv('inst_a'), settings: new SqliteSettingsStore(':memory:') };
    const b = { env: hostedEnv('inst_b'), settings: new SqliteSettingsStore(':memory:') };
    try {
      const [resolvedA, resolvedB] = await Promise.all([
        resolveComposioConfiguration(a),
        resolveComposioConfiguration(b),
      ]);
      for (const resolved of [resolvedA, resolvedB]) {
        assert.equal(resolved.source, 'env');
        assert.equal(resolved.readOnly, true);
        assert.equal(resolved.apiKey, PLATFORM_KEY);
        assert.equal(resolved.generation, prepared.generation);
        assert.deepEqual(resolved.authConfigIds.gmail, {
          read: 'ac_gmail_platform', write: 'ac_gmail_platform',
        });
      }
      assert.equal(platform.writes, writes);
      assert.deepEqual(await managedSettingKeys(a.settings), []);
      assert.deepEqual(await managedSettingKeys(b.settings), []);
    } finally {
      a.settings.close();
      b.settings.close();
    }
  });
});

test('two installations connect at once against one preparation without creating auth configs', async () => {
  await withPlatform(async ({ platform, project }) => {
    await prepare(platform, project);
    const creates = project.creates;
    const writes = platform.writes;
    const a = await installation('inst_a');
    const b = await installation('inst_b');
    try {
      // The Slack setup flow's resolver hands the flow the env that names principals.
      assert.equal(
        (await resolveManagedAuthorizationProviderContext({ settings: a.settings, platformEnv: a.env }))
          .platformEnv,
        a.env,
      );
      const [flowA, flowB] = await Promise.all([connect(project, a), connect(project, b)]);
      const poll = (target: Installation, flow: Awaited<ReturnType<typeof connect>>) =>
        pollManagedAuthorizationFlow(flow.dependencies, {
          principal: principal(),
          agent: target.agent,
          workspaceId: 'T_SHARED',
          browserSecret: flow.started.browserSecret,
        });
      const [resultA, resultB] = await Promise.all([poll(a, flowA), poll(b, flowB)]);

      assert.equal(project.creates, creates);
      assert.equal(platform.writes, writes);
      assert.deepEqual(project.links.map(({ authConfigId }) => authConfigId), [
        'ac_gmail_platform', 'ac_gmail_platform',
      ]);
      assert.deepEqual(project.links.map(({ userId }) => userId).sort(), [
        'chickpea:staging:installation:inst_a:membership:membership_shared',
        'chickpea:staging:installation:inst_b:membership:membership_shared',
      ]);
      assert.equal(resultA.status, 'connected');
      assert.equal(resultB.status, 'connected');
      const [accountsA, accountsB] = await Promise.all([
        a.config.listConnectionAccounts('T_SHARED'),
        b.config.listConnectionAccounts('T_SHARED'),
      ]);
      assert.equal(accountsA.length, 1);
      assert.equal(accountsB.length, 1);
      const policyA = accountsA[0]!.policy;
      const policyB = accountsB[0]!.policy;
      assert.ok(policyA.kind === 'managed' && policyB.kind === 'managed');
      assert.equal(policyA.principalRef, 'chickpea:staging:installation:inst_a:membership:membership_shared');
      assert.equal(policyB.principalRef, 'chickpea:staging:installation:inst_b:membership:membership_shared');
      assert.notEqual(policyA.accountRef, policyB.accountRef);
      assert.deepEqual(await managedSettingKeys(a.settings), []);
      assert.deepEqual(await managedSettingKeys(b.settings), []);
    } finally {
      a.close();
      b.close();
    }
  });
});

test('a callback cannot attach an account another installation authorized', async () => {
  await withPlatform(async ({ platform, project }) => {
    await prepare(platform, project);
    const a = await installation('inst_a');
    const b = await installation('inst_b');
    try {
      await connect(project, a);
      const { dependencies, started } = await connect(project, b);
      const [linkA, linkB] = project.links;
      // Composio reports B's pending request as the account A's member owns:
      // the remote principal names A, so B refuses it.
      project.accounts.set(linkB!.accountRef, { ...project.accounts.get(linkA!.accountRef)! });

      const result = await pollManagedAuthorizationFlow(dependencies, {
        principal: principal(),
        agent: b.agent,
        workspaceId: 'T_SHARED',
        browserSecret: started.browserSecret,
      });

      assert.deepEqual(result, { status: 'terminal', reason: 'failed' });
      assert.deepEqual(await b.config.listConnectionAccounts('T_SHARED'), []);
      assert.deepEqual(project.revoked, [linkB!.accountRef]);
    } finally {
      a.close();
      b.close();
    }
  });
});

test('an attempt recorded for another installation is never polled or imported', async () => {
  await withPlatform(async ({ platform, project }) => {
    await prepare(platform, project);
    const a = await installation('inst_a');
    const b = await installation('inst_b');
    try {
      const { started } = await connect(project, a);
      // A copy of A's attempt state lands in B's store (colliding member IDs
      // share the setting key) with the browser secret that opened it.
      const key = `connections.managed.authorization.${await memberKey('membership_shared')}`;
      await b.settings.setSetting(key, (await a.settings.getSetting(key))!);
      const linksBefore = project.links.length;
      let polls = 0;
      const providerContext = await project.providerContext(b.env, b.settings);
      const counted = providerContext.providers.get('composio')!;
      const original = counted.pollAuthorization!.bind(counted);
      counted.pollAuthorization = async (input) => { polls += 1; return original(input); };

      await assert.rejects(pollManagedAuthorizationFlow({
        config: b.config,
        settings: b.settings,
        catalog: MANAGED_CONNECTOR_CATALOG,
        providerContext,
      }, {
        principal: principal(),
        agent: b.agent,
        workspaceId: 'T_SHARED',
        browserSecret: started.browserSecret,
      }), AuthorizationError);

      assert.equal(polls, 0);
      assert.equal(project.links.length, linksBefore);
      assert.deepEqual(await b.config.listConnectionAccounts('T_SHARED'), []);
      assert.deepEqual(project.revoked, []);
    } finally {
      a.close();
      b.close();
    }
  });
});

test('reconnect and revoke reach only their owner and keep resource restrictions', async () => {
  await withPlatform(async ({ platform, project }) => {
    await prepare(platform, project);
    const a = await installation('inst_a');
    const b = await installation('inst_b');
    try {
      const ownerRef = 'chickpea:staging:installation:inst_a:membership:membership_shared';
      project.accounts.set('ca_owner_analytics', {
        userId: ownerRef, toolkit: 'google_analytics', status: 'ACTIVE',
      });
      const { account } = await a.config.createAgentOwnedConnection({
        account: {
          id: 'connection_shared', workspaceId: 'T_SHARED', ownerKind: 'member',
          ownerMembershipId: 'membership_shared', createdByMembershipId: 'membership_shared',
          providerId: 'google', label: 'Analytics · Personal', secretRefId: 'secret_shared',
          lifecycle: 'ready',
          policy: {
            kind: 'managed', adapterId: 'composio', toolkit: 'google_analytics',
            principalRef: ownerRef, accountRef: 'ca_owner_analytics',
            allowedCapabilities: ['analytics.reports.run'],
            resourceConstraints: {
              propertyIds: [{ handle: 'property_primary', providerRef: 'properties/1', label: 'Primary' }],
            },
            providerGeneration: 1,
            providerLineage: (await project.providerContext(a.env, a.settings)).lineage,
          },
        },
        binding: {
          agentId: 'agent_shared', connectionAccountId: 'connection_shared', providerId: 'google',
          allowedCapabilities: ['analytics.reports.run'],
          resourceConstraints: { propertyIds: ['property_primary'] }, enabled: true,
        },
      });

      // B has the same local IDs but none of A's accounts: nothing to reach.
      const contextB = await project.providerContext(b.env, b.settings);
      await assert.rejects(new ConnectionAccountService({
        config: b.config, settings: b.settings, managedProviders: contextB.providers,
      }).revoke({ principal: principal(), connectionAccountId: account.id }), /Unknown connection account/);
      await assert.rejects(
        connect(project, b, { connectionAccountId: account.id }),
        /Unknown connection account/,
      );

      // Another member of A neither reconnects nor revokes the owner's account.
      const contextA = await project.providerContext(a.env, a.settings);
      const memberA = principal({ membershipId: 'membership_other', userId: 'user_other', role: 'member' });
      await assert.rejects(startManagedAuthorizationFlow({
        config: a.config, settings: a.settings, catalog: MANAGED_CONNECTOR_CATALOG, providerContext: contextA,
      }, {
        principal: memberA, agent: a.agent, workspaceId: 'T_SHARED', connectionAccountId: account.id,
      }), AuthorizationError);
      await assert.rejects(new ConnectionAccountService({
        config: a.config, settings: a.settings, managedProviders: contextA.providers,
      }).revoke({ principal: memberA, connectionAccountId: account.id }), AuthorizationError);
      assert.deepEqual(project.revoked, []);

      // The owner reconnects under the same remote principal; restrictions stay.
      const { dependencies, started } = await connect(project, a, { connectionAccountId: account.id });
      assert.equal(project.links.at(-1)?.userId, ownerRef);
      const result = await pollManagedAuthorizationFlow(dependencies, {
        principal: principal(), agent: a.agent, workspaceId: 'T_SHARED',
        browserSecret: started.browserSecret,
      });
      assert.equal(result.status, 'connected');
      const [reconnected] = await a.config.listConnectionAccounts('T_SHARED');
      assert.ok(reconnected?.policy.kind === 'managed');
      assert.equal(reconnected.policy.accountRef, project.links.at(-1)?.accountRef);
      assert.equal(reconnected.policy.principalRef, ownerRef);
      assert.deepEqual(reconnected.policy.resourceConstraints, {
        propertyIds: [{ handle: 'property_primary', providerRef: 'properties/1', label: 'Primary' }],
      });
      assert.deepEqual(
        (await a.config.getAgentConnectionBindingForAccount(account.id))?.resourceConstraints,
        { propertyIds: ['property_primary'] },
      );
      assert.deepEqual(project.revoked, ['ca_owner_analytics']);

      // The owner revokes exactly that remote account; B is untouched.
      await new ConnectionAccountService({
        config: a.config, settings: a.settings, managedProviders: contextA.providers,
      }).revoke({ principal: principal(), connectionAccountId: account.id });
      assert.deepEqual(project.revoked, ['ca_owner_analytics', reconnected.policy.accountRef]);
      assert.deepEqual(await b.config.listConnectionAccounts('T_SHARED'), []);
    } finally {
      a.close();
      b.close();
    }
  });
});

test('remote principals name the environment and installation under tenancy only', () => {
  const member = principal();
  assert.equal(
    managedPrincipalRef(member, 'member', hostedEnv('inst_a')),
    'chickpea:staging:installation:inst_a:membership:membership_shared',
  );
  assert.equal(
    managedPrincipalRef(member, 'team', hostedEnv('inst_a')),
    'chickpea:staging:installation:inst_a:organization:org_shared',
  );
  assert.equal(managedPrincipalRef(member, 'member', hostedEnv('inst_a', {
    CHICKPEA_COMPOSIO_ENVIRONMENT: 'production',
  })), 'chickpea:production:installation:inst_a:membership:membership_shared');
  // Unqualified names are never issued where the project is shared.
  assert.equal(managedPrincipalRef(member, 'member', HOSTED), undefined);
  assert.equal(managedPrincipalRef(member, 'member', hostedEnv('inst_a', {
    CHICKPEA_COMPOSIO_ENVIRONMENT: '',
  })), undefined);
  assert.equal(managedPrincipalRef(member, 'member', hostedEnv('inst_a', {
    CHICKPEA_COMPOSIO_ENVIRONMENT: 'Staging Env',
  })), undefined);
  // Standalone keeps today's references exactly.
  assert.equal(managedPrincipalRef(member, 'member', {}), 'chickpea:membership:membership_shared');
  assert.equal(managedPrincipalRef(member, 'team', undefined), 'chickpea:organization:org_shared');
});

test('a tenant setting never supplies or overrides the deployment key', async () => {
  await withPlatform(async ({ platform, project }) => {
    await prepare(platform, project);
    const settings = new SqliteSettingsStore(':memory:');
    const keyring = generateCredentialKeyring('hosted_override_test');
    const dependencies = { settings, credentials: { store: settings, keyring } };
    try {
      // An installation store that already holds a project key of its own.
      await saveStoredComposioProjectKey('ak_tenant_owned_project_key', dependencies);
      const env = hostedEnv('inst_a');
      const withDeploymentKey = await resolveComposioConfiguration({ env, ...dependencies });
      assert.equal(withDeploymentKey.apiKey, PLATFORM_KEY);
      assert.equal(withDeploymentKey.source, 'env');

      const withoutDeploymentKey = await resolveComposioConfiguration({
        env: hostedEnv('inst_a', { COMPOSIO_API_KEY: '' }), ...dependencies,
      });
      assert.equal(withoutDeploymentKey.source, 'missing');
      assert.equal(withoutDeploymentKey.readOnly, true);
      assert.equal(withoutDeploymentKey.apiKey, undefined);

      for (const candidate of [env, hostedEnv('inst_a', { COMPOSIO_API_KEY: '' })]) {
        assert.equal(composioConfigurationIsMutable({ env: candidate }), false);
        await assert.rejects(
          saveStoredComposioProjectKey('ak_replacement', { env: candidate, ...dependencies }),
          ComposioConfigurationMutationError,
        );
        await assert.rejects(
          disableStoredComposioConfiguration({ env: candidate, ...dependencies }),
          ComposioConfigurationMutationError,
        );
      }
    } finally {
      settings.close();
    }
  });
});

test('without a platform store or environment name connections stay unavailable', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const unconfigured = await resolveComposioConfiguration({ env: hostedEnv('inst_a'), settings });
    assert.equal(unconfigured.source, 'missing');
    assert.equal(unconfigured.readOnly, true);
    await withPlatform(async () => {
      const unnamed = await resolveComposioConfiguration({
        env: hostedEnv('inst_a', { CHICKPEA_COMPOSIO_ENVIRONMENT: '' }), settings,
      });
      assert.equal(unnamed.source, 'missing');
      assert.equal(unnamed.readOnly, true);
    });
    assert.deepEqual(await managedSettingKeys(settings), []);
  } finally {
    settings.close();
  }
});

test('only the operator prepares or reconciles the shared project', async () => {
  await withPlatform(async ({ platform, project }) => {
    const settings = new SqliteSettingsStore(':memory:');
    const env = hostedEnv('inst_a');
    try {
      for (const options of [{ env, settings }, { env }]) {
        await assert.rejects(prepareResolvedComposioManagedAuthConfigs({
          ...options, createClient: async () => project.client(),
        }), ComposioConfigurationMutationError);
        await assert.rejects(
          completeComposioReconciliation(1, options),
          ComposioConfigurationMutationError,
        );
        await assert.rejects(recordComposioPreparationResult({
          expectedGeneration: 1, authConfigIds: {}, status: 'ready',
        }, options), ComposioConfigurationMutationError);
      }
      assert.equal(project.clients, 0);
      assert.equal(platform.writes, 0);
      assert.deepEqual(await managedSettingKeys(settings), []);

      await assert.rejects(prepareComposioPlatform({
        env: { COMPOSIO_API_KEY: PLATFORM_KEY }, settings: platform,
        createClient: async () => project.client(),
      }), ComposioPlatformConfigurationError);
      await assert.rejects(prepareComposioPlatform({
        env: { ...HOSTED, CHICKPEA_COMPOSIO_ENVIRONMENT: '' }, settings: platform,
        createClient: async () => project.client(),
      }), ComposioPlatformConfigurationError);
      await assert.rejects(prepareComposioPlatform({
        env: { ...HOSTED, COMPOSIO_API_KEY: '' }, settings: platform,
        createClient: async () => project.client(),
      }), ComposioPlatformConfigurationError);
      assert.equal(platform.writes, 0);
    } finally {
      settings.close();
    }
  });
});

test('concurrent operator runs share the platform lease and create each default once', async () => {
  await withPlatform(async ({ platform, project }) => {
    let release!: () => void;
    project.listDelay = new Promise((resolve) => { release = resolve; });
    const first = prepare(platform, project);
    await waitFor(() => platform.values.has(LEASE));
    const second = await prepare(platform, project).catch((error: unknown) => error);
    release();
    assert.equal((await first).status, 'ready');
    assert.ok(second instanceof ComposioSetupInProgressError);
    assert.equal(project.creates, TOOLKITS.length);
    assert.equal(platform.values.has(LEASE), false);

    const rerun = await prepare(platform, project);
    assert.equal(rerun.status, 'ready');
    assert.equal(rerun.reconciled, false);
    assert.equal(project.creates, TOOLKITS.length);
  });
});

test('a changed deployment key waits for an explicit operator reconcile', async () => {
  await withPlatform(async ({ platform, project }) => {
    const first = await prepare(platform, project);
    assert.equal(first.generation, 1);
    const rotated = { ...HOSTED, COMPOSIO_API_KEY: 'ak_rotated_platform_key' };
    const recorded = platform.values.get(PREPARATION);

    await assert.rejects(prepareComposioPlatform({
      env: rotated, settings: platform, createClient: async () => project.client(),
    }), (error: unknown) => error instanceof ComposioPlatformReconciliationRequiredError &&
      error.generation === 2);
    assert.equal(platform.values.get(PREPARATION), recorded);
    const pending = await resolveComposioConfiguration({
      env: scopeInstallationEnv(rotated, { installationId: 'inst_a' }),
    });
    assert.equal(pending.reconciliationPending, true);
    assert.deepEqual(pending.authConfigIds, {});

    const accepted = await prepareComposioPlatform({
      env: rotated, settings: platform, reconcile: true, createClient: async () => project.client(),
    });
    assert.equal(accepted.reconciled, true);
    assert.equal(accepted.generation, 2);
    assert.equal(accepted.status, 'ready');
    const resolved = await resolveComposioConfiguration({
      env: scopeInstallationEnv(rotated, { installationId: 'inst_a' }),
    });
    assert.equal(resolved.reconciliationPending, false);
    assert.equal(resolved.generation, 2);
    assert.equal(resolved.authConfigIds.gmail?.read, 'ac_gmail_platform');
  });
});

function hostedAdmin(installationId: string, overrides: Parameters<typeof createAdminRoutes>[0] = {}) {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const app = new Hono();
  app.route('/', createAdminRoutes({
    store: config,
    settings,
    knownProviders: new Set(['local-stub']),
    ...testAdminAuthority(ADMIN_TOKEN),
    ...overrides,
  }));
  const env = hostedEnv(installationId);
  return {
    config,
    settings,
    request: (path: string, init: RequestInit = {}) => app.request(path, {
      ...init,
      headers: { ...testAdminHeaders(ADMIN_TOKEN), 'content-type': 'application/json', ...init.headers },
    }, env),
    close: () => { config.close(); settings.close(); },
  };
}

test('hosted Admin never asks for a Composio key and refuses project-wide setup', async () => {
  await withPlatform(async ({ platform, project }) => {
    await prepare(platform, project);
    const clients = project.clients;
    const writes = platform.writes;
    const admin = hostedAdmin('inst_admin', { composioCreateClient: async () => project.client() });
    try {
      const status = await admin.request('/admin/api/settings/connectors/composio');
      assert.equal(status.status, 200, await status.clone().text());
      const body = await status.json() as {
        provider: { source: string; readOnly: boolean; configured: boolean; connectors: Array<{ status: string }> };
        recovery?: unknown;
      };
      assert.equal(body.provider.source, 'env');
      assert.equal(body.provider.readOnly, true);
      assert.equal(body.provider.configured, true);
      assert.ok(body.provider.connectors.every(({ status: value }) => value === 'ready'));
      assert.equal(body.recovery, undefined);
      assert.equal('lastSetupResult' in body.provider, false);

      for (const [path, payload] of [
        ['/admin/api/settings/connectors/composio/setup', { projectKey: 'ak_customer_key' }],
        ['/admin/api/settings/connectors/composio/retry', {}],
        ['/admin/api/settings/connectors/composio/disable', {}],
      ] as const) {
        const response = await admin.request(path, { method: 'POST', body: JSON.stringify(payload) });
        assert.equal(response.status, 409, `${path}: ${await response.clone().text()}`);
        assert.equal(
          (await response.json() as { error: string }).error,
          'composio_configuration_deployment_managed',
        );
      }
      assert.equal(project.clients, clients);
      assert.equal(platform.writes, writes);
      assert.deepEqual(await managedSettingKeys(admin.settings), []);
      assert.equal(await admin.settings.getEncryptedCredentialRevision('composio_project'), undefined);

      // A damaged platform record still never turns into a key form.
      platform.values.set(PREPARATION, '{not json');
      const damaged = await admin.request('/admin/api/settings/connectors/composio');
      assert.equal(damaged.status, 200, await damaged.clone().text());
      const damagedBody = await damaged.json() as { provider: { readOnly: boolean; reconciliationPending: boolean } };
      assert.equal(damagedBody.provider.readOnly, true);
      assert.equal(damagedBody.provider.reconciliationPending, true);
    } finally {
      admin.close();
    }
  });
});

test('hosted Admin names its installation in new authorizations and polls only its own', async () => {
  const authorized: string[] = [];
  let polls = 0;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize(input) {
      authorized.push(input.principalRef);
      return {
        authorizationUrl: new URL('https://connect.composio.dev/link/hosted'),
        authorizationRef: 'ca_hosted_admin',
      };
    },
    async pollAuthorization() { polls += 1; return { status: 'pending' }; },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() {},
  };
  const admin = hostedAdmin('inst_admin', {
    managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await admin.config.createAgent({
      id: 'agent_support', name: 'Support', creatorMembershipId: 'membership_test_owner',
      editPolicy: 'creator_and_admins', instructions: 'Answer.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await admin.config.ensureWorkspaceInstallation({
      workspaceId: 'T_TEST', teamId: 'T_TEST', transportMode: 'direct', defaultAgentId: 'agent_support',
    });
    const started = await admin.request('/admin/api/agents/agent_support/connections/managed/start', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'T_TEST', ownerKind: 'member', toolkit: 'gmail', access: 'read' }),
    });
    assert.equal(started.status, 200, await started.clone().text());
    assert.deepEqual(authorized, [
      'chickpea:staging:installation:inst_admin:membership:membership_test_owner',
    ]);

    // An attempt naming another installation, as if copied into this store.
    const pollWith = async (principalRef: string) => {
      const key = `connections.managed.authorization.${await memberKey('membership_test_owner')}`;
      await admin.settings.deleteSetting(key);
      const attempt = await beginManagedAuthorization({
        settings: admin.settings,
        input: {
          workspaceId: 'T_TEST', agentId: 'agent_support', actorMembershipId: 'membership_test_owner',
          ownerKind: 'member', providerId: 'google', adapterId: 'composio', toolkit: 'gmail',
          label: 'Gmail · Personal', principalRef,
          allowedCapabilities: ['gmail.profile.read'], bindingCapabilities: ['gmail.profile.read'],
          providerGeneration: 1, providerLineage: '0'.repeat(24),
        },
      });
      await recordManagedAuthorizationRequest({
        settings: admin.settings, actorMembershipId: 'membership_test_owner',
        browserSecret: attempt.browserSecret, authorizationRef: 'ca_hosted_admin',
      });
      return admin.request('/admin/api/agents/agent_support/connections/managed/poll', {
        method: 'POST',
        body: '{}',
        headers: { cookie: `__Secure-chickpea_managed_authorization=${attempt.browserSecret}` },
      });
    };
    const foreign = await pollWith('chickpea:staging:installation:inst_other:membership:membership_test_owner');
    assert.equal(foreign.status, 403, await foreign.clone().text());
    assert.equal(polls, 0);
    const own = await pollWith('chickpea:staging:installation:inst_admin:membership:membership_test_owner');
    assert.equal(own.status, 202, await own.clone().text());
    assert.equal(polls, 1);
  } finally {
    admin.close();
  }
});

test('standalone ignores a configured platform store and keeps its own preparation', async () => {
  const untouchable: ComposioSettingsStore = {
    async getSetting() { throw new Error('standalone read the platform store'); },
    async applySettingsPatch() { throw new Error('standalone wrote the platform store'); },
  };
  configureComposioPlatformSettings(() => untouchable);
  const settings = new SqliteSettingsStore(':memory:');
  const project = new FakeComposioProject();
  try {
    const env = { COMPOSIO_API_KEY: 'ak_standalone_project_key' };
    const prepared = await prepareResolvedComposioManagedAuthConfigs({
      env, settings, createClient: async () => project.client(),
    });
    assert.equal(prepared.status, 'ready');
    const resolved = await resolveComposioConfiguration({ env, settings });
    assert.equal(resolved.authConfigIds.gmail?.read, 'ac_gmail_platform');
    assert.deepEqual(await managedSettingKeys(settings), [PREPARATION]);
    assert.equal(composioConfigurationIsMutable({ env: {} }), true);
  } finally {
    configureComposioPlatformSettings(undefined);
    settings.close();
  }
});

async function memberKey(membershipId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(membershipId),
  ));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(condition(), 'condition never held');
}
