import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuthorizationError } from '../src/auth/permissions.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { signInGroupPolicy } from '../src/config/sign-in-group.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { MANAGED_CONNECTOR_CATALOG } from '../src/connections/catalog/index.ts';
import {
  pollManagedAuthorizationFlow,
  startManagedAuthorizationFlow,
} from '../src/connections/managed-authorization-flow.ts';
import { createManagedConnectionProviderRegistry, type ManagedConnectionProvider } from '../src/connections/managed.ts';
import { notionPageHandle, readAgentPageChoice, type NotionId } from '../src/connections/notion-pages.ts';
import { ComposioManagedConnectionProvider } from '../src/connections/providers/composio.ts';
import { projectEffectiveConnectionAccounts } from '../src/connections/runtime.ts';
import {
  ConnectionAccountService,
  ManagedConnectionConflictError,
  ManagedResourceSelectionError,
} from '../src/connections/store.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';

const WORKSPACE = 'T_SHARED';
const ORGANIZATION = 'organization_shared';
const pageId = (seed: string) => `${seed.padEnd(8, '0')}-0000-4000-8000-${seed.padStart(12, '0')}`;
const PAGES = [
  { id: pageId('b1'), kind: 'page' as const, label: 'Team plan' },
  { id: pageId('b2'), kind: 'page' as const, label: 'Team wiki' },
  { id: pageId('b3'), kind: 'database' as const, label: 'Customer interviews' },
];

function principal(membershipId: string, role: AuthPrincipal['role']): AuthPrincipal {
  return {
    userId: `user_${membershipId}`, membershipId, organizationId: ORGANIZATION, role,
    authenticatorKind: 'test', credentialId: 'credential_test', correlationId: 'correlation_test', machine: false,
  };
}

const MAYA = principal('membership_maya', 'owner');
const BOB = principal('membership_bob', 'admin');
const ZED = principal('membership_zed', 'member');
const NAMES: Record<string, string> = { membership_maya: 'Maya Chen', membership_zed: 'Zed Park' };
const signerName = async (membershipId: string) => NAMES[membershipId];

/** A workspace whose Notion sign-ins all share the same pages; each sign-in's person is set per account. */
async function notionWorkspace() {
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const calls: string[] = [];
  const people = new Map<string, string | null>();
  let nextRef = '';
  const listing = () => ({ pages: PAGES.map((page) => ({ ...page })), complete: true });
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async authorize(input) {
      calls.push(`authorize:${input.accessLane}`);
      return { authorizationUrl: new URL('https://backend.composio.dev/link/notion'), authorizationRef: nextRef };
    },
    async pollAuthorization() {
      return { status: 'active', accountRef: nextRef, toolkit: 'notion' };
    },
    async validate(input) {
      calls.push(`validate:${input.policy.accountRef}`);
      const person = people.has(input.policy.accountRef) ? people.get(input.policy.accountRef) : 'notion:ws-1:user-maya';
      return {
        ...(person ? { person } : {}),
        grantSummary: { items: PAGES.map(({ id, kind, label }) => ({ id, type: kind, label })), truncated: false },
        pages: listing(),
      };
    },
    async listPages(input) {
      calls.push(`list:${input.policy.accountRef}`);
      return listing();
    },
    async execute(input) {
      calls.push(`execute:${input.policy.accountRef}`);
      return { data: {} };
    },
    async revoke(input) {
      calls.push(`revoke:${input.policy.accountRef}`);
    },
  };
  const providers = createManagedConnectionProviderRegistry([provider]);
  for (const [agentId, creator] of [
    ['agent_ops', 'membership_maya'], ['agent_sales', 'membership_maya'],
    ['agent_scout', 'membership_zed'], ['agent_notes', 'membership_zed'],
  ]) {
    await config.createAgent({
      id: agentId!, name: agentId!.replace('agent_', 'Agent '), instructions: 'Use Notion.', enabled: true,
      lifecycle: 'active', configurationGeneration: 1, creatorMembershipId: creator!, editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
  }
  await config.ensureWorkspaceInstallation({ workspaceId: WORKSPACE, transportMode: 'direct', defaultAgentId: 'agent_ops' });
  const flow = {
    config, settings, catalog: MANAGED_CONNECTOR_CATALOG,
    providerContext: { providers, generation: 1, lineage: 'f'.repeat(24) },
  };
  const service = new ConnectionAccountService({
    config, settings, managedProviders: providers,
    randomId: (() => { let next = 0; return () => `shared${++next}`; })(),
  });

  /** Starts a Notion sign-in through the Slack setup door: a new connection, or another sign-in for one. */
  const start = async (actor: AuthPrincipal, agentId: string, ref: string, options: {
    ownerKind?: 'team' | 'member';
    access?: 'read' | 'write';
    connectionAccountId?: string;
  } = {}) => {
    nextRef = ref;
    const agent = await config.getAgent(agentId);
    const started = await startManagedAuthorizationFlow(flow, {
      principal: actor, agent, workspaceId: WORKSPACE,
      ...(options.connectionAccountId
        ? { connectionAccountId: options.connectionAccountId }
        : { ownerKind: options.ownerKind ?? 'team', toolkit: 'notion', access: options.access ?? 'read' }),
    });
    return {
      attempt: started.attempt,
      finish: () => pollManagedAuthorizationFlow(flow, {
        principal: actor, agent, workspaceId: WORKSPACE, browserSecret: started.browserSecret,
      }),
    };
  };
  const connect = async (...input: Parameters<typeof start>) => {
    const polled = await (await start(...input)).finish();
    return polled.status === 'connected' ? polled.account : assert.fail(`expected a connection, got ${polled.status}`);
  };
  const accountOf = async (agentId: string) => {
    const [binding] = await config.listAgentConnectionBindings(agentId);
    const account = (await config.listConnectionAccounts(WORKSPACE))
      .find(({ id }) => id === binding?.connectionAccountId);
    if (!binding || account?.policy.kind !== 'managed') throw new Error(`expected ${agentId}'s Notion account`);
    return { account: { ...account, policy: account.policy }, binding };
  };
  /** Joins another Agent to an Agent's sign-in directly in the store, as an earlier writer would have. */
  const joinDirectly = async (fromAgentId: string, agentId: string, allowedCapabilities: string[]) => {
    const { account: source } = await accountOf(fromAgentId);
    await config.applySignInGroup({
      adapterId: 'composio', accountRef: source.policy.accountRef,
      members: [{ connectionAccountId: source.id, expectedRevision: source.revision }],
      shared: signInGroupPolicy(source.policy),
      join: {
        account: {
          id: `connection_${agentId}`, workspaceId: WORKSPACE, ownerKind: source.ownerKind,
          createdByMembershipId: 'membership_maya', providerId: 'notion', label: 'Notion · Team',
          policy: { ...source.policy, allowedCapabilities },
          secretRefId: `secret_${agentId}`, lifecycle: 'ready',
        },
        binding: {
          agentId, connectionAccountId: `connection_${agentId}`, providerId: 'notion', allowedCapabilities, enabled: true,
        },
      },
    });
  };
  /** Adds an Agent to another Agent's sign-in through the service, as the Admin and Slack doors do. */
  const reuse = async (actor: AuthPrincipal, agentId: string, fromAgentId: string, options: {
    ownerKind?: 'team' | 'member';
    access?: 'read' | 'write';
    pages?: readonly NotionId[];
  } = {}) => service.reuseSignIn({
    principal: actor, agentId, workspaceId: WORKSPACE,
    sourceConnectionId: (await accountOf(fromAgentId)).account.id,
    ownerKind: options.ownerKind ?? 'team', access: options.access ?? 'read',
    choice: options.pages
      ? { mode: 'only', pages: await Promise.all(options.pages.map((page) => notionPageHandle(page))) }
      : { mode: 'all' },
  });
  const reusable = (actor: AuthPrincipal, agentId: string, ownerKind: 'team' | 'member', access: 'read' | 'write' = 'read') =>
    service.listReusableSignIns({ principal: actor, agentId, workspaceId: WORKSPACE, toolkit: 'notion', ownerKind, access, signerName });
  return {
    config, service, calls, people, start, connect, accountOf, joinDirectly, reuse, reusable,
    close() { config.close(); settings.close(); },
  };
}

const READ = MANAGED_CONNECTOR_CATALOG.capabilities('notion', 'read').map(({ id }) => id);
const WRITE = MANAGED_CONNECTOR_CATALOG.capabilities('notion', 'write').map(({ id }) => id);

test('a sign-in that began on read fails closed when its sign-in group needs write by the time it finishes', async () => {
  const notion = await notionWorkspace();
  try {
    const ops = await notion.connect(MAYA, 'agent_ops', 'ca_read');
    assert.deepEqual(ops.policy.kind === 'managed' && ops.policy.signIn, { person: 'notion:ws-1:user-maya', accessLane: 'read' });

    const again = await notion.start(MAYA, 'agent_ops', 'ca_again', { connectionAccountId: ops.id });
    assert.equal(again.attempt.accessLane, 'read', 'the attempt records the lane its credential is issued on');
    await notion.joinDirectly('agent_ops', 'agent_sales', WRITE);
    notion.calls.length = 0;

    assert.equal((await again.finish()).status, 'lost');
    assert.deepEqual(notion.calls, ['revoke:ca_again'], 'only the narrower credential is deleted, and Notion is not asked about it');
    for (const agentId of ['agent_ops', 'agent_sales']) {
      const { account } = await notion.accountOf(agentId);
      assert.equal(account.lifecycle, 'ready');
      assert.equal(account.policy.accountRef, 'ca_read', `${agentId} keeps its sign-in`);
    }
  } finally {
    notion.close();
  }
});

test('a sign-in records the lane it was issued on, not the lane its group needs when it finishes', async () => {
  const notion = await notionWorkspace();
  try {
    const ops = await notion.connect(MAYA, 'agent_ops', 'ca_write', { access: 'write' });
    await notion.joinDirectly('agent_ops', 'agent_sales', READ);
    const again = await notion.start(MAYA, 'agent_sales', 'ca_again', {
      connectionAccountId: (await notion.accountOf('agent_sales')).account.id,
    });
    assert.equal(again.attempt.accessLane, 'write', 'a read-only Agent signs in on the lane its sign-in group needs');
    assert.equal((await notion.service.disconnectForAgent({
      principal: MAYA, agentId: 'agent_ops', connectionAccountId: ops.id,
    })).lifecycle, 'revoked');
    assert.equal((await again.finish()).status, 'connected');
    const { account } = await notion.accountOf('agent_sales');
    assert.deepEqual(account.policy.signIn, { person: 'notion:ws-1:user-maya', accessLane: 'write' });
  } finally {
    notion.close();
  }
});

test('an Admin adds another Agent to the team\'s Notion sign-in without signing in again', async () => {
  const notion = await notionWorkspace();
  try {
    const ops = await notion.connect(MAYA, 'agent_ops', 'ca_team', { access: 'write' });
    notion.calls.length = 0;
    const [offered, ...more] = await notion.reusable(BOB, 'agent_sales', 'team', 'write');
    assert.deepEqual(more, []);
    assert.deepEqual(offered, {
      sourceConnectionId: ops.id, signerName: 'Maya Chen', signedByYou: false,
      pages: await Promise.all(PAGES.map(async ({ id, kind, label }) => ({ handle: await notionPageHandle(id as NotionId), kind, label }))),
      complete: true, agentIds: ['agent_ops'],
    });
    assert.doesNotMatch(JSON.stringify(offered), /0000-4000-8000|ca_team|notion:/, 'no Notion id, credential or person');

    const { account, binding } = await notion.reuse(BOB, 'agent_sales', 'agent_ops', { access: 'write' });
    assert.deepEqual(notion.calls, ['list:ca_team', 'validate:ca_team'], 'Notion is not signed in again');
    const source = (await notion.accountOf('agent_ops')).account;
    assert.equal(account.ownerKind, 'team');
    assert.equal(account.createdByMembershipId, 'membership_bob');
    assert.equal(account.lifecycle, 'ready');
    assert.ok(account.policy.kind === 'managed');
    assert.equal(account.policy.accountRef, 'ca_team');
    assert.equal(account.policy.providerGeneration, source.policy.providerGeneration);
    assert.equal(account.policy.providerLineage, source.policy.providerLineage);
    assert.deepEqual(account.policy.signIn, source.policy.signIn);
    assert.deepEqual(binding.allowedCapabilities, WRITE);
    assert.equal(readAgentPageChoice(binding.resourceConstraints), undefined, 'every page by default');

    const [effective] = projectEffectiveConnectionAccounts(
      await notion.config.listConnectionAccounts(WORKSPACE),
      await notion.config.listAgentConnectionBindings('agent_sales'),
      'membership_bob',
    );
    assert.ok(effective?.policy.kind === 'managed');
    const dispatched: string[] = [];
    const composio = new ComposioManagedConnectionProvider({
      apiKey: 'test-key',
      createClient: async () => ({
        sessions: { async create() { throw new Error('session execution must not be used'); } },
        tools: {
          async execute(_tool, request) {
            dispatched.push(request.connectedAccountId);
            return { data: { markdown: 'Team plan' }, successful: true, error: null };
          },
        },
      }),
    });
    await composio.execute({ policy: effective.policy, capability: 'notion.pages.markdown', arguments: { pageId: PAGES[0]!.id } });
    assert.deepEqual(dispatched, ['ca_team'], 'the joined Agent calls Notion through the shared credential');
  } finally {
    notion.close();
  }
});

test('only its owner reuses a personal Notion sign-in, a Member cannot reuse the team\'s, and no sign-in joins the other owner kind', async () => {
  const notion = await notionWorkspace();
  try {
    notion.people.set('ca_zed', 'notion:ws-1:user-zed');
    await notion.connect(ZED, 'agent_scout', 'ca_zed', { ownerKind: 'member' });
    await notion.connect(MAYA, 'agent_ops', 'ca_team');
    notion.calls.length = 0;

    assert.deepEqual(await notion.reusable(BOB, 'agent_sales', 'member'), [], 'an Admin is not offered someone else\'s personal sign-in');
    await assert.rejects(notion.reuse(BOB, 'agent_sales', 'agent_scout', { ownerKind: 'member' }), AuthorizationError);
    await assert.rejects(notion.reuse(MAYA, 'agent_sales', 'agent_scout', { ownerKind: 'team' }), AuthorizationError,
      'a personal sign-in never joins a team connection');
    await assert.rejects(notion.reusable(ZED, 'agent_notes', 'team'), AuthorizationError);
    await assert.rejects(notion.reuse(ZED, 'agent_notes', 'agent_ops', { ownerKind: 'team' }), AuthorizationError);
    await assert.rejects(notion.reuse(ZED, 'agent_notes', 'agent_ops', { ownerKind: 'member' }), AuthorizationError,
      'the team\'s sign-in never joins a personal connection');
    assert.deepEqual(notion.calls, [], 'a refused reuse asks Notion nothing');

    assert.deepEqual((await notion.reusable(ZED, 'agent_notes', 'member')).map(({ signedByYou, signerName }) => [signedByYou, signerName]),
      [[true, 'Zed Park']]);
    const { account } = await notion.reuse(ZED, 'agent_notes', 'agent_scout', { ownerKind: 'member' });
    assert.equal(account.ownerKind, 'member');
    assert.equal(account.ownerMembershipId, 'membership_zed');
    assert.ok(account.policy.kind === 'managed' && account.policy.accountRef === 'ca_zed');
  } finally {
    notion.close();
  }
});

test('a second Notion row on one Agent and lane, or more access than the sign-in was issued, is refused before Notion is asked', async () => {
  const notion = await notionWorkspace();
  try {
    await notion.connect(MAYA, 'agent_ops', 'ca_read');
    notion.calls.length = 0;
    const before = await notion.config.listConnectionAccounts(WORKSPACE);
    await assert.rejects(notion.reuse(MAYA, 'agent_ops', 'agent_ops'), ManagedConnectionConflictError);
    assert.deepEqual(await notion.reusable(MAYA, 'agent_ops', 'team'), []);
    await assert.rejects(notion.reuse(MAYA, 'agent_sales', 'agent_ops', { access: 'write' }), ManagedConnectionConflictError);
    assert.deepEqual(await notion.reusable(MAYA, 'agent_sales', 'team', 'write'), []);
    assert.deepEqual(notion.calls, []);
    assert.deepEqual(await notion.config.listConnectionAccounts(WORKSPACE), before, 'nothing was written');
    assert.equal((await notion.reusable(MAYA, 'agent_sales', 'team', 'read')).length, 1);
  } finally {
    notion.close();
  }
});

test('a reuse is refused when the sign-in\'s Notion account already backs a connection of the other owner kind', async () => {
  const notion = await notionWorkspace();
  try {
    const ops = await notion.connect(MAYA, 'agent_ops', 'ca_team');
    assert.ok(ops.policy.kind === 'managed');
    // A personal connection for the same Notion person, as an older build could have saved.
    await notion.config.putConnectionAccount({
      id: 'connection_legacy', workspaceId: WORKSPACE, ownerKind: 'member', ownerMembershipId: 'membership_maya',
      createdByMembershipId: 'membership_maya', providerId: 'notion', label: 'Notion · Personal',
      policy: { ...ops.policy, accountRef: 'ca_personal', principalRef: 'chickpea:membership:membership_maya' },
      secretRefId: 'secret_legacy', lifecycle: 'ready',
    });
    await assert.rejects(notion.reuse(MAYA, 'agent_sales', 'agent_ops'), ManagedConnectionConflictError);
    assert.deepEqual(await notion.reusable(MAYA, 'agent_sales', 'team'), []);
  } finally {
    notion.close();
  }
});

test('a reuse can start with only some pages, and refuses a page the sign-in does not list', async () => {
  const notion = await notionWorkspace();
  try {
    await notion.connect(MAYA, 'agent_ops', 'ca_team');
    await assert.rejects(notion.reuse(MAYA, 'agent_sales', 'agent_ops', { pages: [pageId('ee') as NotionId] }),
      (error) => error instanceof ManagedResourceSelectionError && error.code === 'invalid');
    assert.equal((await notion.config.listAgentConnectionBindings('agent_sales')).length, 0);
    const { binding } = await notion.reuse(MAYA, 'agent_sales', 'agent_ops', { pages: [PAGES[1]!.id as NotionId] });
    assert.deepEqual(readAgentPageChoice(binding.resourceConstraints), [PAGES[1]!.id]);
    assert.equal(readAgentPageChoice((await notion.accountOf('agent_ops')).binding.resourceConstraints), undefined,
      'the Agent that signed in keeps every page');
  } finally {
    notion.close();
  }
});

test('signing in again as the same Notion person folds into that person\'s sign-in and deletes exactly its old credential', async () => {
  const notion = await notionWorkspace();
  try {
    await notion.connect(MAYA, 'agent_ops', 'ca_one');
    notion.calls.length = 0;
    const sales = await notion.connect(BOB, 'agent_sales', 'ca_two');
    assert.deepEqual(notion.calls.filter((call) => call.startsWith('revoke:')), ['revoke:ca_one']);
    assert.equal(sales.createdByMembershipId, 'membership_bob');
    const [ops, joined] = await Promise.all([notion.accountOf('agent_ops'), notion.accountOf('agent_sales')]);
    for (const { account } of [ops, joined]) {
      assert.equal(account.lifecycle, 'ready');
      assert.equal(account.policy.accountRef, 'ca_two', 'both Agents use the one new credential');
    }
    assert.deepEqual(signInGroupPolicy(ops.account.policy), signInGroupPolicy(joined.account.policy));
  } finally {
    notion.close();
  }
});

test('a sign-in of a different Notion person, or one Notion named nobody for, keeps its own credential', async () => {
  const notion = await notionWorkspace();
  try {
    await notion.connect(MAYA, 'agent_ops', 'ca_one');
    notion.people.set('ca_bob', 'notion:ws-1:user-bob');
    notion.people.set('ca_nobody', null);
    notion.people.set('ca_nobody_again', null);
    await notion.connect(MAYA, 'agent_sales', 'ca_bob');
    await notion.connect(MAYA, 'agent_scout', 'ca_nobody');
    await notion.connect(MAYA, 'agent_notes', 'ca_nobody_again');
    assert.deepEqual(notion.calls.filter((call) => call.startsWith('revoke:')), []);
    const refs = await Promise.all(['agent_ops', 'agent_sales', 'agent_scout', 'agent_notes'].map(async (agentId) =>
      (await notion.accountOf(agentId)).account.policy.accountRef));
    assert.deepEqual(refs, ['ca_one', 'ca_bob', 'ca_nobody', 'ca_nobody_again'], 'two sign-ins by one member are not one person');
  } finally {
    notion.close();
  }
});
