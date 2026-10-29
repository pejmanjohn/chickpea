import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { AgentSnapshotStore } from '../src/config/snapshot-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { createManagedConnectionProviderRegistry, type ManagedConnectionProvider } from '../src/connections/managed.ts';
import { ConnectionAccountService } from '../src/connections/store.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

const TOKEN = 'notion-routes-token';
const pageId = (seed: string) => `${seed.padEnd(8, '0')}-0000-4000-8000-${seed.padStart(12, '0')}`;
const PAGES = [
  { id: pageId('c1'), kind: 'page' as const, label: 'Q4 Roadmap' },
  { id: pageId('c2'), kind: 'page' as const, label: 'Engineering Wiki' },
  { id: pageId('c3'), kind: 'database' as const, label: 'Customer Interviews' },
];
const SECRET_SHAPES = /0000-4000-8000|ca_team|ca_zed|notion:ws|member:membership|notionPages/;

function principal(membershipId: string, role: AuthPrincipal['role']): AuthPrincipal {
  return {
    userId: `user_${membershipId}`, membershipId, organizationId: 'org_oss', role,
    authenticatorKind: 'test_slack_session', credentialId: 'session_test', correlationId: 'request_test', machine: false,
  };
}
const OWNER = principal('membership_maya', 'owner');
const MEMBER = principal('membership_zed', 'member');
const NAMES: Record<string, string> = { user_membership_maya: 'Maya Chen', user_membership_zed: 'Zed Park' };

async function workspace() {
  const store = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    availability: () => ({ status: 'ready', missingConfiguration: [] }),
    async validate(input) {
      return {
        person: input.policy.accountRef === 'ca_zed' ? 'notion:ws-1:user-zed' : 'notion:ws-1:user-maya',
        grantSummary: { items: PAGES.map(({ id, kind, label }) => ({ id, type: kind, label })), truncated: false },
      };
    },
    async listPages() { return { pages: PAGES.map((page) => ({ ...page })), complete: true }; },
    async execute() { return { data: {} }; },
    async revoke() {},
  };
  const providers = createManagedConnectionProviderRegistry([provider]);
  for (const [id, name, creator] of [
    ['agent_ops', 'Atlas', 'membership_maya'], ['agent_sales', 'Scout', 'membership_maya'],
    ['agent_scout', 'Penny', 'membership_zed'], ['agent_notes', 'Notes', 'membership_zed'],
  ] as const) {
    await store.createAgent({
      id, name, instructions: 'Use Notion.', enabled: true, lifecycle: 'active', configurationGeneration: 1,
      creatorMembershipId: creator, editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
  }
  await store.ensureWorkspaceInstallation({ workspaceId: 'T_TEST', transportMode: 'direct', defaultAgentId: 'agent_ops' });
  const service = new ConnectionAccountService({ config: store, settings, managedProviders: providers });
  const signIn = (actor: AuthPrincipal, agentId: string, ownerKind: 'team' | 'member', accountRef: string) =>
    service.createForAgent({
      principal: actor, agentId, workspaceId: 'T_TEST', ownerKind, providerId: 'notion',
      label: `Notion · ${ownerKind === 'team' ? 'Team' : 'Personal'}`,
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'notion', accountRef,
        principalRef: ownerKind === 'team' ? 'chickpea:organization:org_oss' : `chickpea:membership:${actor.membershipId}`,
        allowedCapabilities: ['notion.content.search', 'notion.pages.markdown'],
      },
    });
  await signIn(OWNER, 'agent_ops', 'team', 'ca_team');
  await signIn(MEMBER, 'agent_scout', 'member', 'ca_zed');
  const people = {
    getMembership: async (id: string) => ({
      id, organizationId: 'org_oss', userId: `user_${id}`, role: id === OWNER.membershipId ? 'owner' : 'member',
      status: 'active', createdAt: 1, updatedAt: 1,
    }),
    getUser: async (id: string) => ({ id, displayName: NAMES[id] ?? null }),
    getMembershipAccessOverlay: async () => undefined,
    recordAuthAudit: async () => undefined,
  } as unknown as IdentityStore;
  const appFor = (actor: AuthPrincipal) => {
    const app = new Hono();
    app.route('/', createAdminRoutes({
      store, settings,
      management: new SqliteManagementStore(':memory:'),
      snapshots: { listLiveRootsByAgent: async () => [] } as unknown as AgentSnapshotStore,
      knownProviders: new Set(['local-stub']),
      managedConnectionProviders: providers,
      ...testAdminAuthority(TOKEN, undefined, people, actor),
    }));
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await app.request(`http://localhost/admin/api/agents/${path}`, {
        method, headers: testAdminHeaders(TOKEN, { 'content-type': 'application/json' }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    return {
      call,
      reusable: (agentId: string, ownerKind: string) =>
        call('GET', `${agentId}/connections/managed/reusable?workspaceId=T_TEST&toolkit=notion&ownerKind=${ownerKind}&access=read`),
      attached: async (agentId: string) =>
        (await call('GET', `${agentId}/connections?workspaceId=T_TEST`)).body.attached as Array<Record<string, any>>,
    };
  };
  return { store, owner: appFor(OWNER), member: appFor(MEMBER), close() { store.close(); settings.close(); } };
}

test('an Owner is offered the team sign-in, adds another Agent with a page limit, and changes it, with no Notion id, credential or person sent', async () => {
  const notion = await workspace();
  try {
    const offered = await notion.owner.reusable('agent_sales', 'team');
    assert.equal(offered.status, 200);
    const [signIn, ...rest] = offered.body.signIns;
    assert.deepEqual(rest, []);
    assert.deepEqual({ ...signIn, pages: undefined }, {
      sourceConnectionId: (await notion.owner.attached('agent_ops'))[0]!.account.id,
      label: 'Maya Chen', signedByYou: true, pageCount: 3, pages: undefined, complete: true, alsoUsedBy: ['Atlas'],
    });
    assert.deepEqual(signIn.pages.map(({ label, kind }: { label: string; kind: string }) => [label, kind]),
      PAGES.map(({ label, kind }) => [label, kind]));

    const added = await notion.owner.call('POST', 'agent_sales/connections/managed/reuse', {
      workspaceId: 'T_TEST', sourceConnectionId: signIn.sourceConnectionId, ownerKind: 'team', access: 'read',
      choice: { mode: 'only', pages: [signIn.pages[0].handle] },
    });
    assert.equal(added.status, 201);
    const [row] = await notion.owner.attached('agent_sales');
    assert.deepEqual(
      [row!.pageMode, row!.pageCount, row!.sharedPageCount, row!.sharedWithOtherAgents, row!.alsoUsedBy, row!.signerName],
      ['only', 1, 3, true, ['Atlas'], 'Maya Chen'],
    );
    assert.deepEqual((await notion.owner.attached('agent_ops'))[0]!.alsoUsedBy, ['Scout']);

    const path = `agent_sales/connections/${encodeURIComponent(row!.account.id)}/pages`;
    const pages = await notion.owner.call('GET', `${path}?workspaceId=T_TEST`);
    assert.equal(pages.status, 200);
    assert.equal(pages.body.mode, 'only');
    assert.deepEqual(pages.body.pages.map(({ chosen }: { chosen: boolean }) => chosen), [true, false, false]);
    assert.deepEqual(pages.body.alsoUsedBy, ['Atlas']);

    const stale = await notion.owner.call('PUT', path, { workspaceId: 'T_TEST', expectedRevision: row!.account.revision + 1, choice: { mode: 'all' } });
    assert.equal(stale.status, 409);
    const saved = await notion.owner.call('PUT', path, { workspaceId: 'T_TEST', expectedRevision: row!.account.revision, choice: { mode: 'all' } });
    assert.equal(saved.status, 200);
    const [after] = await notion.owner.attached('agent_sales');
    assert.deepEqual([after!.pageMode, after!.pageCount], ['all', 3]);

    for (const payload of [offered.body, added.body, pages.body, saved.body, row, after]) {
      assert.doesNotMatch(JSON.stringify(payload), SECRET_SHAPES);
    }
  } finally {
    notion.close();
  }
});

test('a Member is offered only their own sign-in and never sees another Agent\'s name', async () => {
  const notion = await workspace();
  try {
    assert.equal((await notion.member.reusable('agent_notes', 'team')).status, 403);
    const offered = await notion.member.reusable('agent_notes', 'member');
    const [signIn, ...rest] = offered.body.signIns;
    assert.deepEqual(rest, []);
    assert.deepEqual([signIn.label, signIn.signedByYou, 'alsoUsedBy' in signIn], ['Zed Park', true, false]);

    const added = await notion.member.call('POST', 'agent_notes/connections/managed/reuse', {
      workspaceId: 'T_TEST', sourceConnectionId: signIn.sourceConnectionId, ownerKind: 'member', access: 'read',
      choice: { mode: 'all' },
    });
    assert.equal(added.status, 201);
    for (const agentId of ['agent_notes', 'agent_scout']) {
      const [row] = await notion.member.attached(agentId);
      assert.equal(row!.sharedWithOtherAgents, true);
      assert.equal('alsoUsedBy' in row!, false, `${agentId} names no other Agent to a Member`);
    }
    const [row] = await notion.member.attached('agent_notes');
    assert.deepEqual([row!.signerName, row!.signedByYou], ['Zed Park', true]);
    const pages = await notion.member.call('GET', `agent_notes/connections/${encodeURIComponent(row!.account.id)}/pages?workspaceId=T_TEST`);
    assert.equal(pages.status, 200);
    assert.equal('alsoUsedBy' in pages.body, false);
    const teamRow = (await notion.owner.attached('agent_ops'))[0]!;
    assert.equal((await notion.member.call('GET', `agent_ops/connections/${encodeURIComponent(teamRow.account.id)}/pages?workspaceId=T_TEST`)).status, 403);
    assert.doesNotMatch(JSON.stringify([offered.body, added.body, pages.body]), SECRET_SHAPES);
  } finally {
    notion.close();
  }
});

test('a reuse onto an Agent that already has that Notion connection is a conflict, not a server error', async () => {
  const notion = await workspace();
  try {
    const source = (await notion.owner.attached('agent_ops'))[0]!.account.id;
    const conflict = await notion.owner.call('POST', 'agent_ops/connections/managed/reuse', {
      workspaceId: 'T_TEST', sourceConnectionId: source, ownerKind: 'team', access: 'read', choice: { mode: 'all' },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, 'managed_connection_changed');
    const invalid = await notion.owner.call('POST', 'agent_sales/connections/managed/reuse', {
      workspaceId: 'T_TEST', sourceConnectionId: source, ownerKind: 'team', access: 'read',
      choice: { mode: 'only', pages: [PAGES[0]!.id] },
    });
    assert.equal(invalid.status, 400, 'a Notion id is not a page handle');
  } finally {
    notion.close();
  }
});
