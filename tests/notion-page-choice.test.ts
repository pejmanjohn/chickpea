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
import { ManagedProviderRequestError } from '../src/connections/managed-errors.ts';
import { createManagedConnectionProviderRegistry, type ManagedConnectionProvider } from '../src/connections/managed.ts';
import { pageRoots, parseNotionId, readAgentPageChoice, type NotionId } from '../src/connections/notion-pages.ts';
import { ComposioManagedConnectionProvider } from '../src/connections/providers/composio.ts';
import { projectEffectiveConnectionAccounts } from '../src/connections/runtime.ts';
import {
  ConnectionAccountService,
  ManagedResourceSelectionError,
  toConnectionAccountView,
} from '../src/connections/store.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';

const WORKSPACE = 'T_PAGES';
const id = (seed: string) => `${seed.padEnd(8, '0')}-0000-4000-8000-${seed.padStart(12, '0')}` as NotionId;

interface NotionPage { id: NotionId; title: string; parent?: NotionId }
const notionPage = (seed: string, title: string, parent?: NotionPage): NotionPage =>
  ({ id: id(seed), title, ...(parent ? { parent: parent.id } : {}) });

const TEAM_PLAN = notionPage('a1', 'Team plan');
const TEAM_PLAN_NOTES = notionPage('a2', 'Team plan notes', TEAM_PLAN);
const TEAM_WIKI = notionPage('a3', 'Team wiki');
const TEAM_ROADMAP = notionPage('a4', 'Team roadmap');
const PAGES = [TEAM_PLAN, TEAM_PLAN_NOTES, TEAM_WIKI, TEAM_ROADMAP];
const titles = (...pages: NotionPage[]) => pages.map(({ title }) => title).sort();
const ALL_SHARED = titles(TEAM_PLAN, TEAM_PLAN_NOTES, TEAM_WIKI);

function principal(membershipId: string): AuthPrincipal {
  return {
    userId: `user_${membershipId}`, membershipId, organizationId: 'organization_pages', role: 'owner',
    authenticatorKind: 'test', credentialId: 'credential_test', correlationId: 'correlation_test', machine: false,
  };
}

const MAYA = principal('membership_maya');

const isRefusal = (error: unknown) => error instanceof ManagedProviderRequestError &&
  error.code === 'validation_failed' && error.message === "That Notion page isn't available to this Agent.";

/** One Notion workspace whose sign-ins share what Maya checked in Notion's picker, and everything under it. */
async function notionWorkspace() {
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const byId = new Map(PAGES.map((page) => [page.id, page]));
  const shared = new Set([TEAM_PLAN.id, TEAM_WIKI.id]);
  const visible = (target: NotionId) => {
    for (let page = byId.get(target); page; page = page.parent ? byId.get(page.parent) : undefined) {
      if (shared.has(page.id)) return true;
    }
    return false;
  };
  const listing = () => ({
    pages: PAGES.filter(({ id: pageId }) => visible(pageId)).map(({ id: pageId, title, parent }) =>
      ({ id: pageId, kind: 'page' as const, label: title, ...(parent ? { parent } : {}) })),
    complete: true,
  });
  let accountRef = '';
  let listings = 0;
  const signIns: ManagedConnectionProvider = {
    id: 'composio',
    async authorize() {
      return { authorizationUrl: new URL('https://backend.composio.dev/link/notion'), authorizationRef: accountRef };
    },
    async pollAuthorization() {
      return { status: 'active', accountRef, toolkit: 'notion' };
    },
    async validate() {
      const pages = listing();
      return {
        person: 'notion:ws-1:user-maya',
        grantSummary: {
          items: pageRoots(pages).roots.map(({ id: rootId, kind, label }) => ({ id: rootId, type: kind, label })),
          truncated: false,
        },
        pages,
      };
    },
    async listPages() {
      listings += 1;
      return listing();
    },
    async execute() { return { data: {} }; },
    async revoke() {},
  };
  const providers = createManagedConnectionProviderRegistry([signIns]);
  const service = new ConnectionAccountService({ config, settings, managedProviders: providers });
  const ok = (data: Record<string, unknown>) => ({ data, successful: true, error: null });
  const notion = new ComposioManagedConnectionProvider({
    apiKey: 'test-key',
    createClient: async () => ({
      sessions: { async create() { throw new Error('session execution must not be used'); } },
      tools: {
        async execute(tool, input) {
          const target = parseNotionId(input.arguments.page_id ?? input.arguments.block_id);
          const page = target && byId.get(target);
          if (!page || !visible(page.id)) return { data: {}, successful: false, error: 'object_not_found' };
          if (tool === 'NOTION_GET_PAGE_MARKDOWN') return ok({ markdown: page.title });
          return ok({
            id: page.id, object: 'page',
            parent: page.parent ? { type: 'page_id', page_id: page.parent } : { type: 'workspace', workspace: true },
          });
        },
      },
    }),
  });
  for (const agentId of ['agent_ops', 'agent_sales']) {
    await config.createAgent({
      id: agentId, name: agentId, instructions: 'Use Notion.', enabled: true, lifecycle: 'active',
      configurationGeneration: 1, creatorMembershipId: 'membership_maya', editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
  }
  await config.ensureWorkspaceInstallation({ workspaceId: WORKSPACE, transportMode: 'direct', defaultAgentId: 'agent_ops' });
  const dependencies = {
    config, settings, catalog: MANAGED_CONNECTOR_CATALOG,
    providerContext: { providers, generation: 1, lineage: 'f'.repeat(24) },
  };

  /** Signs Agent Ops in to Notion through the Slack setup door, or signs its connection in again. */
  const connect = async (ref: string, connectionAccountId?: string) => {
    accountRef = ref;
    const agent = await config.getAgent('agent_ops');
    const started = await startManagedAuthorizationFlow(dependencies, {
      principal: MAYA, agent, workspaceId: WORKSPACE,
      ...(connectionAccountId
        ? { connectionAccountId }
        : { ownerKind: 'team' as const, toolkit: 'notion', access: 'read' as const }),
    });
    const polled = await pollManagedAuthorizationFlow(dependencies, {
      principal: MAYA, agent, workspaceId: WORKSPACE, browserSecret: started.browserSecret,
    });
    return polled.status === 'connected' ? polled.account : assert.fail(`expected a connection, got ${polled.status}`);
  };
  const accountOf = async (agentId: string) => {
    const [binding] = await config.listAgentConnectionBindings(agentId);
    const account = (await config.listConnectionAccounts(WORKSPACE))
      .find(({ id: accountId }) => accountId === binding?.connectionAccountId);
    if (!binding || account?.policy.kind !== 'managed') throw new Error(`expected ${agentId}'s Notion account`);
    return { account: { ...account, policy: account.policy }, binding };
  };
  const choose = async (agentId: string, choice: Parameters<ConnectionAccountService['setAgentPages']>[0]['choice']) => {
    const { account } = await accountOf(agentId);
    return service.setAgentPages({
      principal: MAYA, agentId, connectionAccountId: account.id, expectedRevision: account.revision, choice,
    });
  };
  /** The pages an Agent can read, by title. */
  const reached = async (agentId: string) => {
    const [accounts, bindings] = await Promise.all([
      config.listConnectionAccounts(WORKSPACE), config.listAgentConnectionBindings(agentId),
    ]);
    const [effective] = projectEffectiveConnectionAccounts(accounts, bindings, 'membership_maya');
    if (effective?.policy.kind !== 'managed') throw new Error(`expected ${agentId}'s effective Notion policy`);
    const policy = effective.policy;
    // Without a scope Chickpea asks Notion directly, and Notion refuses what it does not share.
    const unreachable = (error: unknown) => isRefusal(error) || (!policy.pageScope &&
      error instanceof ManagedProviderRequestError && error.code === 'provider_unavailable');
    const reads = await Promise.all(PAGES.map(async (page) => {
      try {
        await notion.execute({ policy, capability: 'notion.pages.markdown', arguments: { pageId: page.id } });
        return [page.title];
      } catch (error) {
        if (unreachable(error)) return [];
        throw error;
      }
    }));
    return reads.flat().sort();
  };
  return {
    config, service, shared, connect, accountOf, choose, reached, listings: () => listings,
    close() { config.close(); settings.close(); },
  };
}

type Workspace = Awaited<ReturnType<typeof notionWorkspace>>;

/** Agent Ops connects Notion for the team; Agent Sales joins the same sign-in. */
async function sharedTeamSignIn(notion: Workspace) {
  const ops = await notion.connect('ca_team');
  if (ops.policy.kind !== 'managed') throw new Error('expected a managed account');
  const capabilities = (await notion.accountOf('agent_ops')).binding.allowedCapabilities;
  await notion.config.applySignInGroup({
    adapterId: 'composio', accountRef: 'ca_team',
    members: [{ connectionAccountId: ops.id, expectedRevision: ops.revision }],
    shared: signInGroupPolicy(ops.policy),
    join: {
      account: {
        id: 'connection_sales', workspaceId: WORKSPACE, ownerKind: 'team', createdByMembershipId: 'membership_maya',
        providerId: 'notion', label: 'Notion · Team', secretRefId: 'secret_sales', lifecycle: 'ready',
        policy: { ...ops.policy, allowedCapabilities: capabilities },
      },
      binding: {
        agentId: 'agent_sales', connectionAccountId: 'connection_sales', providerId: 'notion',
        allowedCapabilities: capabilities, enabled: true,
      },
    },
  });
}

test('an Agent is offered the roots its sign-in lists, and may limit itself to those only', async () => {
  const notion = await notionWorkspace();
  try {
    const ops = await notion.connect('ca_team');
    const team = { principal: MAYA, agentId: 'agent_ops', connectionAccountId: ops.id };
    assert.deepEqual(await notion.service.agentPages(team), {
      mode: 'all',
      pages: [
        { id: TEAM_PLAN.id, kind: 'page', label: 'Team plan', chosen: true },
        { id: TEAM_WIKI.id, kind: 'page', label: 'Team wiki', chosen: true },
      ],
      complete: true,
    });
    assert.deepEqual(await notion.reached('agent_ops'), ALL_SHARED);

    const refused = (error: unknown) => error instanceof ManagedResourceSelectionError && error.code === 'invalid';
    for (const pages of [[TEAM_PLAN_NOTES.id], [TEAM_ROADMAP.id], [id('ee')], ['Team plan']]) {
      await assert.rejects(notion.choose('agent_ops', { mode: 'only', pages }), refused, pages[0]);
    }
    await assert.rejects(notion.service.setAgentPages({
      ...team, expectedRevision: ops.revision - 1, choice: { mode: 'only', pages: [TEAM_PLAN.id] },
    }), (error) => error instanceof ManagedResourceSelectionError && error.code === 'stale');
    await assert.rejects(notion.service.setAgentPages({
      ...team, principal: { ...principal('membership_zed'), role: 'member' },
      expectedRevision: ops.revision, choice: { mode: 'only', pages: [TEAM_PLAN.id] },
    }), AuthorizationError, 'someone who cannot edit the Agent cannot limit it');
    assert.deepEqual(await notion.reached('agent_ops'), ALL_SHARED, 'a refused choice changes nothing');

    const limited = await notion.choose('agent_ops', { mode: 'only', pages: [TEAM_PLAN.id.replaceAll('-', '')] });
    assert.equal(limited.account.revision, ops.revision + 1, 'a choice moves the account revision like any other edit');
    await assert.rejects(notion.service.setAgentPages({
      ...team, expectedRevision: ops.revision, choice: { mode: 'all' },
    }), (error) => error instanceof ManagedResourceSelectionError && error.code === 'stale');
    assert.deepEqual(readAgentPageChoice((await notion.accountOf('agent_ops')).binding.resourceConstraints), [TEAM_PLAN.id]);
    assert.deepEqual(await notion.reached('agent_ops'), titles(TEAM_PLAN, TEAM_PLAN_NOTES));
    assert.deepEqual((await notion.service.agentPages(team)).pages.map(({ label, chosen }) => [label, chosen]), [
      ['Team plan', true], ['Team wiki', false],
    ]);

    await notion.choose('agent_ops', { mode: 'only', pages: [] });
    assert.deepEqual(await notion.reached('agent_ops'), [], 'an empty choice reaches nothing');
    await notion.choose('agent_ops', { mode: 'all' });
    assert.equal((await notion.service.agentPages(team)).mode, 'all');
    assert.deepEqual(await notion.reached('agent_ops'), ALL_SHARED);
  } finally {
    notion.close();
  }
});

test('a page choice of another mode, or of more than 256 pages, is refused before Notion is asked', async () => {
  const notion = await notionWorkspace();
  try {
    await notion.connect('ca_team');
    await notion.choose('agent_ops', { mode: 'only', pages: [TEAM_PLAN.id] });
    const listed = notion.listings();
    const refused = (error: unknown) => error instanceof ManagedResourceSelectionError && error.code === 'invalid';
    const tooMany = Array.from({ length: 257 }, (_, index) => id(`f${index.toString(16)}`));
    for (const choice of [{ mode: 'none' }, { mode: 'only' }, { mode: 'only', pages: tooMany }, { pages: [TEAM_PLAN.id] }]) {
      await assert.rejects(notion.choose('agent_ops', choice as never), refused, JSON.stringify(choice).slice(0, 40));
    }
    assert.equal(notion.listings(), listed, 'Notion was not asked');
    assert.deepEqual(readAgentPageChoice((await notion.accountOf('agent_ops')).binding.resourceConstraints), [TEAM_PLAN.id]);
    assert.deepEqual(await notion.reached('agent_ops'), titles(TEAM_PLAN, TEAM_PLAN_NOTES), 'the choice is unchanged');
  } finally {
    notion.close();
  }
});

test('limiting one Agent to some pages does not narrow another Agent on the same sign-in', async () => {
  const notion = await notionWorkspace();
  try {
    await sharedTeamSignIn(notion);
    await notion.choose('agent_ops', { mode: 'only', pages: [TEAM_WIKI.id] });
    assert.deepEqual(await notion.reached('agent_ops'), titles(TEAM_WIKI));
    assert.deepEqual(await notion.reached('agent_sales'), ALL_SHARED);
  } finally {
    notion.close();
  }
});

test('signing in again removes pages Notion no longer lists from every Agent\'s choice', async () => {
  const notion = await notionWorkspace();
  try {
    await sharedTeamSignIn(notion);
    await notion.choose('agent_ops', { mode: 'only', pages: [TEAM_PLAN.id, TEAM_WIKI.id] });
    await notion.choose('agent_sales', { mode: 'only', pages: [TEAM_WIKI.id] });
    notion.shared.delete(TEAM_WIKI.id);
    const { account } = await notion.accountOf('agent_ops');
    await notion.connect('ca_team_2', account.id);
    const choice = async (agentId: string) => readAgentPageChoice((await notion.accountOf(agentId)).binding.resourceConstraints);
    assert.deepEqual(await choice('agent_ops'), [TEAM_PLAN.id]);
    assert.deepEqual(await choice('agent_sales'), []);

    notion.shared.add(TEAM_WIKI.id);
    assert.deepEqual(await notion.reached('agent_sales'), [], 'sharing the page again in Notion does not choose it again');
  } finally {
    notion.close();
  }
});

test('Admin rows show only the grant titles their Agent may reach, and never page ids', async () => {
  const notion = await notionWorkspace();
  try {
    await sharedTeamSignIn(notion);
    await notion.choose('agent_sales', { mode: 'only', pages: [TEAM_WIKI.id] });
    const ops = (await notion.accountOf('agent_ops')).account;
    const sales = (await notion.accountOf('agent_sales')).account;

    const views = await notion.service.listViews(WORKSPACE);
    const shown = (accountId: string) => {
      const policy = views.find(({ id: viewId }) => viewId === accountId)?.policy;
      return policy?.kind === 'managed' ? policy.grantSummary?.items.map(({ label }) => label) : undefined;
    };
    assert.deepEqual(ops.policy.grantSummary?.items.map(({ label }) => label), ['Team plan', 'Team wiki'], 'the stored grant');
    assert.deepEqual(shown(ops.id), ['Team plan', 'Team wiki']);
    assert.deepEqual(shown(sales.id), ['Team wiki']);
    assert.deepEqual((await notion.service.view(sales)).policy, views.find(({ id: viewId }) => viewId === sales.id)?.policy);
    assert.doesNotMatch(JSON.stringify(views), /notionPages|[0-9a-f]{8}-0000-4000-8000/);

    const unbound = toConnectionAccountView(sales).policy;
    assert.deepEqual(unbound.kind === 'managed' && unbound.grantSummary?.items, [], 'without its binding a row names no page');
  } finally {
    notion.close();
  }
});
