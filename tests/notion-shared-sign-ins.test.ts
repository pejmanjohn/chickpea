import assert from 'node:assert/strict';
import { test } from 'node:test';

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
import { ConnectionAccountService } from '../src/connections/store.ts';
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
  for (const [agentId, creator] of [['agent_ops', 'membership_maya'], ['agent_sales', 'membership_maya'], ['agent_scout', 'membership_zed']]) {
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
  return {
    config, service, calls, people, start, connect, accountOf, joinDirectly,
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
