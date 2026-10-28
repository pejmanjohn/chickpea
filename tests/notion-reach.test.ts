import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ConfigStore } from '../src/config/store.ts';
import { createManagedConnectionProviderRegistry, invokeManagedConnectionCapability } from '../src/connections/managed.ts';
import { ManagedProviderRequestError } from '../src/connections/managed-errors.ts';
import { parseNotionId, type NotionId } from '../src/connections/notion-pages.ts';
import { ComposioManagedConnectionProvider } from '../src/connections/providers/composio.ts';
import { NotionEdgeCache } from '../src/connections/providers/composio/notion-reach.ts';
import type { EffectiveManagedPolicy } from '../src/connections/types.ts';
import type { IdentityStore } from '../src/identity/types.ts';

const id = (seed: string) => `${seed.padEnd(8, '0')}-0000-4000-8000-${seed.padStart(12, '0')}` as NotionId;
const bare = (value: string) => value.replaceAll('-', '');

// Root ─ Child ─ Grandchild ─ Block
//         └ Tasks database ─ Tasks source ─ Row
// Elsewhere ─ Hidden, Hidden tasks;   Loose and Loose tasks (workspace);   Sub, under a page this credential cannot see
const ROOT = id('a1');
const CHILD = id('a2');
const GRANDCHILD = id('a3');
const BLOCK = id('a4');
const TASKS = id('a5');
const SOURCE = id('a6');
const ROW = id('a7');
const ELSEWHERE = id('b1');
const HIDDEN = id('b2');
const LOOSE = id('b3');
const HIDDEN_TASKS = id('b4');
const LOOSE_TASKS = id('b5');
const FOREIGN_SOURCE = id('b6');
const SUB = id('c1');
const UNSHARED = id('c2');
const DATABASES: Record<string, Record<string, unknown>> = {
  [TASKS]: { type: 'page_id', page_id: CHILD },
  [HIDDEN_TASKS]: { type: 'page_id', page_id: ELSEWHERE },
  [LOOSE_TASKS]: { type: 'workspace', workspace: true },
};

const PAGES: Record<string, Record<string, unknown>> = {
  [ROOT]: { type: 'workspace', workspace: true },
  [CHILD]: { type: 'page_id', page_id: ROOT },
  [GRANDCHILD]: { type: 'page_id', page_id: bare(CHILD) },
  [ROW]: { type: 'data_source_id', data_source_id: SOURCE },
  [ELSEWHERE]: { type: 'workspace', workspace: true },
  [HIDDEN]: { type: 'page_id', page_id: ELSEWHERE },
  [LOOSE]: { type: 'workspace', workspace: true },
  [SUB]: { type: 'page_id', page_id: UNSHARED },
};
const BLOCKS: Record<string, Record<string, unknown>> = {
  ...PAGES,
  ...DATABASES,
  [ROW]: { type: 'database_id', database_id: TASKS },
  [BLOCK]: { type: 'page_id', page_id: GRANDCHILD },
};

const ALL_CAPABILITIES = [
  'notion.content.search', 'notion.pages.get', 'notion.pages.markdown', 'notion.databases.get',
  'notion.databases.query', 'notion.data_sources.query', 'notion.pages.create',
  'notion.pages.update_properties', 'notion.pages.append_blocks',
];

const LOOKUP_TOOLS = new Set(['NOTION_RETRIEVE_PAGE', 'NOTION_FETCH_DATABASE', 'NOTION_FETCH_BLOCK_METADATA']);

function notionWorld(options: {
  /** A lookup of this id finds nothing, as for a page not shared with the credential. */
  failLookup?: string;
  /** A lookup of this id fails for some other reason. */
  errorLookup?: string;
  search?: Array<Record<string, unknown>>;
  /** Extra pages, by id, with their parent. */
  pages?: Record<string, Record<string, unknown>>;
} = {}) {
  const calls: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
  const notFound = { data: {}, successful: false, error: 'object_not_found' };
  const ok = (data: Record<string, unknown>) => ({ data, successful: true, error: null });
  const pages = { ...PAGES, ...options.pages };
  const blocks = { ...BLOCKS, ...options.pages };
  const provider = new ComposioManagedConnectionProvider({
    apiKey: 'test-key',
    createClient: async () => ({
      sessions: { async create() { throw new Error('session execution must not be used'); } },
      tools: {
        async execute(tool, input) {
          const arguments_ = input.arguments;
          calls.push({ tool, arguments: arguments_ });
          // Notion itself accepts an id in any of its forms.
          const target = parseNotionId(arguments_.page_id ?? arguments_.database_id ?? arguments_.block_id) ?? '';
          if (LOOKUP_TOOLS.has(tool)) {
            if (options.failLookup === target) return notFound;
            if (options.errorLookup === target) return { data: {}, successful: false, error: 'rate_limited' };
          }
          switch (tool) {
            case 'NOTION_RETRIEVE_PAGE':
              return pages[target] ? ok({ id: target, object: 'page', parent: pages[target] }) : notFound;
            case 'NOTION_FETCH_DATABASE':
              return DATABASES[target]
                ? ok({
                    id: target, object: 'database', parent: DATABASES[target],
                    data_sources: target === TASKS ? [{ id: SOURCE, name: 'Tasks' }, { id: FOREIGN_SOURCE, name: 'Linked' }] : [],
                  })
                : notFound;
            case 'NOTION_FETCH_BLOCK_METADATA':
              return blocks[target] ? ok({ id: target, object: 'block', parent: blocks[target] }) : notFound;
            case 'NOTION_FETCH_DATA':
              return ok({ results: options.search ?? [], values: [], has_more: false, next_cursor: null, total_count: 99 });
            default:
              return ok({ id: 'written', url: 'https://notion.so/written' });
          }
        },
      },
    }),
  });
  const lookups = () => calls.filter(({ tool }) => LOOKUP_TOOLS.has(tool));
  return { provider, calls, lookups };
}

function scoped(allow?: NotionId[]): EffectiveManagedPolicy {
  return {
    kind: 'managed',
    adapterId: 'composio',
    toolkit: 'notion',
    principalRef: 'chickpea:organization:org_1',
    accountRef: 'ca_notion',
    allowedCapabilities: ALL_CAPABILITIES,
    ...(allow ? { pageScope: { allow: new Set(allow) } } : {}),
  };
}

const ONLY_ROOT = scoped([ROOT]);

const isRefusal = (error: unknown) => error instanceof ManagedProviderRequestError &&
  error.code === 'validation_failed' && error.message === "That Notion page isn't available to this Agent.";

interface GateCase {
  capability: string;
  tool: string;
  /** Agent arguments naming a descendant of ROOT in a non-canonical form. */
  inside: Record<string, unknown>;
  /** The same arguments naming each page outside the chosen ones. */
  outside: Array<Record<string, unknown>>;
  argument: string;
  canonical: NotionId;
  lookups: number;
  /** A read is checked against the object it returns; anything else before it runs. */
  checksAfterRead: boolean;
}

const page = (key: string, extra: Record<string, unknown> = {}) => (target: string) => ({ [key]: target, ...extra });
const gateCase = (
  capability: string, tool: string, argument: string, canonical: NotionId, lookups: number,
  name: (target: string) => Record<string, unknown>, inside: string, outside: string[],
): GateCase => ({
  capability, tool, argument, canonical, lookups,
  inside: name(inside), outside: outside.map(name),
  checksAfterRead: capability === 'notion.pages.get' || capability === 'notion.databases.get',
});

const CASES: GateCase[] = [
  gateCase('notion.pages.get', 'NOTION_RETRIEVE_PAGE', 'page_id', GRANDCHILD, 1,
    page('pageId'), bare(GRANDCHILD), [HIDDEN, LOOSE, SUB]),
  gateCase('notion.pages.markdown', 'NOTION_GET_PAGE_MARKDOWN', 'page_id', GRANDCHILD, 2,
    page('pageId'), GRANDCHILD.toUpperCase(), [HIDDEN, LOOSE, SUB]),
  gateCase('notion.databases.get', 'NOTION_FETCH_DATABASE', 'database_id', TASKS, 1,
    page('databaseId'), bare(TASKS), [HIDDEN_TASKS, LOOSE_TASKS]),
  gateCase('notion.databases.query', 'NOTION_QUERY_DATABASE', 'database_id', TASKS, 2,
    page('databaseId'), `https://www.notion.so/acme/Tasks-${bare(TASKS)}`, [HIDDEN_TASKS, LOOSE_TASKS]),
  gateCase('notion.pages.create', 'NOTION_CREATE_NOTION_PAGE', 'parent_id', GRANDCHILD, 2,
    page('parentId', { title: 'Notes' }), bare(GRANDCHILD), [HIDDEN, LOOSE, SUB]),
  gateCase('notion.pages.update_properties', 'NOTION_UPDATE_ROW_DATABASE', 'row_id', ROW, 4,
    page('pageId', { properties: [{ name: 'Status', type: 'select', value: 'Done' }] }), bare(ROW), [HIDDEN, LOOSE, SUB]),
  gateCase('notion.pages.append_blocks', 'NOTION_ADD_MULTIPLE_PAGE_CONTENT', 'parent_block_id', BLOCK, 3,
    page('parentBlockId', { blocks: [{ type: 'paragraph', content: 'More' }] }), bare(BLOCK), [HIDDEN, LOOSE, SUB]),
];

const dispatchedBy = (gate: GateCase, calls: Array<{ tool: string; arguments: Record<string, unknown> }>) =>
  calls.filter((call) => call.tool === gate.tool && !(gate.checksAfterRead && call !== calls[0]));

for (const gate of CASES) {
  test(`${gate.capability}: a page under a chosen page passes, named by its canonical id`, async () => {
    const { provider, calls } = notionWorld();
    const result = await provider.execute({ policy: ONLY_ROOT, capability: gate.capability, arguments: gate.inside });
    const dispatched = dispatchedBy(gate, calls);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]!.arguments[gate.argument], gate.canonical);
    assert.equal(calls.length - 1, gate.lookups, 'lookups up to the chosen page');
    assert.equal(result.providerToolCallCount, calls.length);
  });

  test(`${gate.capability}: a page outside the chosen pages is refused${
    gate.checksAfterRead ? ' and its content withheld' : ' before it is dispatched'
  }`, async () => {
    for (const outside of gate.outside) {
      const { provider, calls } = notionWorld();
      await assert.rejects(
        provider.execute({ policy: ONLY_ROOT, capability: gate.capability, arguments: outside }),
        isRefusal,
      );
      assert.equal(dispatchedBy(gate, calls).length, gate.checksAfterRead ? 1 : 0);
    }
  });
}

test('a stored page choice reaches the gate on every dispatch of the Agent\'s Notion connection', async () => {
  const account = {
    id: 'connection_notion', workspaceId: 'T', providerId: 'notion', ownerKind: 'team', lifecycle: 'ready',
    policy: { ...scoped(), accountRef: 'ca_notion' },
  };
  const config = {
    async listConnectionAccounts() { return [account]; },
    async listAgentConnectionBindings() {
      return [{
        agentId: 'agent_docs', connectionAccountId: account.id, providerId: 'notion', enabled: true,
        allowedCapabilities: ALL_CAPABILITIES, resourceConstraints: { notionPages: [ROOT] },
      }];
    },
  } as unknown as ConfigStore;
  const identity = {
    async getOrganization() { return { id: 'o', slackTeamId: 'T' }; },
    async getMembership() { return { id: 'm', userId: 'u', organizationId: 'o', status: 'active' }; },
    async getMembershipAccessOverlay() { return null; },
    async getUser() { return { id: 'u', slackTeamId: 'T', slackUserId: 'U' }; },
    async resolveSlackIdentity() { return { user: { id: 'u' }, membership: { id: 'm' }, binding: { membershipId: 'm' } }; },
  } as unknown as IdentityStore;
  const { provider, calls } = notionWorld();
  const invoke = (pageId: string) => invokeManagedConnectionCapability({
    config, identity, providers: createManagedConnectionProviderRegistry([provider]),
    workspaceId: 'T', agentId: 'agent_docs', actorMembershipId: 'm', connectionAccountId: account.id,
    capability: 'notion.pages.markdown', arguments: { pageId },
  });
  await assert.rejects(invoke(HIDDEN), isRefusal);
  assert.equal(calls.some(({ tool }) => tool === 'NOTION_GET_PAGE_MARKDOWN'), false, 'nothing outside the choice is read');
  await invoke(GRANDCHILD);
  assert.equal(calls.at(-1)?.tool, 'NOTION_GET_PAGE_MARKDOWN');
});

test('a page scope on a capability outside the Notion rules is refused before any call', async () => {
  const { provider, calls } = notionWorld();
  await assert.rejects(provider.execute({
    policy: { ...ONLY_ROOT, toolkit: 'hubspot', allowedCapabilities: ['hubspot.owners.list'] },
    capability: 'hubspot.owners.list',
    arguments: {},
  }), isRefusal);
  assert.deepEqual(calls, []);
});

test('the walk stops at the first chosen page, and a parent out of the credential\'s sight ends it short', async () => {
  const lookupsFor = async (allow: NotionId[], pageId: NotionId) => {
    const { provider, lookups } = notionWorld();
    await provider.execute({ policy: scoped(allow), capability: 'notion.pages.markdown', arguments: { pageId } })
      .catch((error: unknown) => assert.ok(isRefusal(error)));
    return lookups().map(({ arguments: arguments_ }) => arguments_.page_id);
  };
  assert.deepEqual(await lookupsFor([CHILD], GRANDCHILD), [GRANDCHILD]);
  assert.deepEqual(await lookupsFor([ROOT], SUB), [SUB, UNSHARED]);
});

test('a lookup that fails during the walk refuses, and so does a page that is not an id', async () => {
  for (const capability of ['notion.pages.markdown', 'notion.pages.create'] as const) {
    for (const world of [{ failLookup: CHILD }, { errorLookup: CHILD }]) {
      const { provider, calls } = notionWorld(world);
      const arguments_ = capability === 'notion.pages.create'
        ? { parentId: GRANDCHILD, title: 'Notes' }
        : { pageId: GRANDCHILD };
      await assert.rejects(provider.execute({ policy: ONLY_ROOT, capability, arguments: arguments_ }), isRefusal);
      assert.equal(calls.some(({ tool }) => tool === 'NOTION_CREATE_NOTION_PAGE' || tool === 'NOTION_GET_PAGE_MARKDOWN'), false);
    }
  }
  const { provider, calls } = notionWorld();
  await assert.rejects(provider.execute({
    policy: ONLY_ROOT, capability: 'notion.pages.markdown', arguments: { pageId: 'Launch plan' },
  }), isRefusal);
  assert.deepEqual(calls, []);
});

test('a scoped Agent cannot create a page from Markdown that names another Notion object', async () => {
  const naming = [
    'Intro\n\n<page url="https://www.notion.so/acme/Salaries-b2000000000040008000000000000b2">Salaries</page>',
    '< Page url="https://notion.so/b2">',
    '<database url="https://notion.so/b4"></database>',
    '<data-source url="https://notion.so/a5"/>',
    '<synced_block url="https://notion.so/a4">',
    '<synced_block_reference url="https://notion.so/a4"/>',
    '<mention-page url="https://notion.so/b2"/>',
    '<MENTION-DATABASE url="https://notion.so/b4"/>',
    '<mention-data-source url="https://notion.so/a5"/>',
  ];
  const harmless = [
    '# Notes\n\nThe <pages> tag, a < b, <b>bold</b>, <mention-user url="https://notion.so/u1"/> and <paged> text.',
    'See https://www.notion.so/acme/Salaries-b2000000000040008000000000000b2 for the figures.',
  ];
  for (const scope of [ONLY_ROOT, scoped([GRANDCHILD])]) {
    for (const markdown of naming) {
      const { provider, calls } = notionWorld();
      await assert.rejects(provider.execute({
        policy: scope, capability: 'notion.pages.create', arguments: { parentId: GRANDCHILD, title: 'Notes', markdown },
      }), isRefusal, markdown);
      assert.deepEqual(calls, [], 'refused before any call');
    }
    for (const markdown of harmless) {
      const { provider, calls } = notionWorld();
      await provider.execute({
        policy: scope, capability: 'notion.pages.create', arguments: { parentId: GRANDCHILD, title: 'Notes', markdown },
      });
      assert.equal(calls.at(-1)?.tool, 'NOTION_CREATE_NOTION_PAGE', markdown);
    }
  }
  // Appended blocks travel as rich text, which Notion never reads as Markdown.
  const { provider: appending, calls: appended } = notionWorld();
  await appending.execute({
    policy: ONLY_ROOT, capability: 'notion.pages.append_blocks',
    arguments: { parentBlockId: BLOCK, blocks: [{ type: 'paragraph', content: naming[0]! }] },
  });
  assert.equal(appended.at(-1)?.tool, 'NOTION_ADD_MULTIPLE_PAGE_CONTENT');

  const { provider: unscoped, calls } = notionWorld();
  await unscoped.execute({
    policy: scoped(), capability: 'notion.pages.create', arguments: { parentId: GRANDCHILD, title: 'Notes', markdown: naming[0] },
  });
  assert.deepEqual(calls.map(({ tool }) => tool), ['NOTION_CREATE_NOTION_PAGE'], 'an unscoped Agent is unchanged');
});

test('a scoped read of a page the sign-in cannot see gets the same refusal as a page outside the scope', async () => {
  for (const [capability, target] of [['notion.pages.get', HIDDEN], ['notion.databases.get', HIDDEN_TASKS]] as const) {
    const refusal = async (pageId: string) => {
      const { provider } = notionWorld();
      const arguments_ = capability === 'notion.pages.get' ? { pageId } : { databaseId: pageId };
      try {
        await provider.execute({ policy: ONLY_ROOT, capability, arguments: arguments_ });
      } catch (error) {
        return error instanceof ManagedProviderRequestError ? [error.code, error.message] : error;
      }
      return assert.fail(`${pageId} was read`);
    };
    assert.deepEqual(await refusal(UNSHARED), await refusal(target), capability);
    assert.deepEqual(await refusal(UNSHARED), ['validation_failed', "That Notion page isn't available to this Agent."]);
  }
});

test('the walk refuses a page more than 24 levels down and a parent cycle, and stops looking', async () => {
  const deep = Array.from({ length: 30 }, (_, level) => id(`f${level.toString(16)}`));
  const [loopA, loopB] = [id('e1'), id('e2')];
  const { provider, lookups } = notionWorld({
    pages: {
      ...Object.fromEntries(deep.map((target, level) => [
        target, { type: 'page_id', page_id: deep[level + 1] ?? ROOT },
      ])),
      [loopA]: { type: 'page_id', page_id: loopB },
      [loopB]: { type: 'page_id', page_id: loopA },
    },
  });
  await assert.rejects(provider.execute({
    policy: ONLY_ROOT, capability: 'notion.pages.markdown', arguments: { pageId: deep[0] },
  }), isRefusal);
  assert.equal(lookups().length, 24, 'the walk stops at 24 levels');

  const before = lookups().length;
  await assert.rejects(provider.execute({
    policy: ONLY_ROOT, capability: 'notion.pages.create', arguments: { parentId: loopA, title: 'Loop' },
  }), isRefusal);
  assert.equal(lookups().length - before, 2, 'a cycle is walked once');
});

test('a data source is placed only by its own parent, never by a database\'s list of data sources', async () => {
  const search = (dataSource: NotionId, database: NotionId) => notionWorld({
    search: [{ id: dataSource, object: 'data_source', parent: { type: 'database_id', database_id: database } }],
  });
  const { provider, lookups } = search(SOURCE, TASKS);
  const query = (dataSourceId: NotionId) => provider.execute({
    policy: ONLY_ROOT, capability: 'notion.data_sources.query', arguments: { dataSourceId },
  });
  await assert.rejects(query(SOURCE), isRefusal);
  assert.deepEqual(lookups(), [], 'no Notion tool reads a data source\'s database');
  await provider.execute({ policy: ONLY_ROOT, capability: 'notion.databases.get', arguments: { databaseId: TASKS } });
  await assert.rejects(query(FOREIGN_SOURCE), isRefusal, 'the Tasks database lists a data source it does not hold');
  await assert.rejects(query(SOURCE), isRefusal);
  await provider.execute({ policy: ONLY_ROOT, capability: 'notion.content.search', arguments: { query: 'tasks' } });
  await query(SOURCE);

  const foreign = search(FOREIGN_SOURCE, HIDDEN_TASKS).provider;
  await foreign.execute({ policy: ONLY_ROOT, capability: 'notion.content.search', arguments: { query: 'linked' } });
  await assert.rejects(foreign.execute({
    policy: ONLY_ROOT, capability: 'notion.data_sources.query', arguments: { dataSourceId: FOREIGN_SOURCE },
  }), isRefusal);
});

test('Agents without a page scope make no extra Notion calls', async () => {
  for (const gate of [...CASES, { capability: 'notion.content.search', inside: { query: 'plans' } }]) {
    const { provider, calls } = notionWorld({ search: [{ id: LOOSE, object: 'page', parent: { type: 'workspace' } }] });
    const result = await provider.execute({ policy: scoped(), capability: gate.capability, arguments: gate.inside });
    assert.equal(calls.length, 1, gate.capability);
    assert.equal(result.providerToolCallCount, 1);
  }
});

test('reads follow cached parent edges; writes look every edge up again', async () => {
  const { provider, lookups } = notionWorld();
  const markdown = () => provider.execute({
    policy: ONLY_ROOT, capability: 'notion.pages.markdown', arguments: { pageId: GRANDCHILD },
  });
  await markdown();
  const cold = lookups().length;
  await markdown();
  assert.equal(lookups().length, cold, 'a second read walks cached edges');

  const create = () => provider.execute({
    policy: ONLY_ROOT, capability: 'notion.pages.create', arguments: { parentId: GRANDCHILD, title: 'Notes' },
  });
  await create();
  const afterFirstWrite = lookups().length;
  assert.equal(afterFirstWrite - cold, 2, 'a write after a cached read looks both edges up again');
  await create();
  assert.equal(lookups().length - afterFirstWrite, 2, 'and so does the next write');

  let revalidations = 0;
  const before = lookups().length;
  await provider.execute({
    policy: ONLY_ROOT, capability: 'notion.pages.create', arguments: { parentId: GRANDCHILD, title: 'Notes' },
    revalidateAuthority: async () => { revalidations += 1; },
  });
  assert.equal(revalidations, lookups().length - before + 1, 'authority is rechecked before every lookup and the write');
});

test('the edge cache expires edges after five minutes and keeps at most 4,096', () => {
  let now = 0;
  const cache = new NotionEdgeCache(() => now);
  cache.set('ca_notion', CHILD, { kind: 'page', id: ROOT });
  cache.set('ca_other', CHILD, { kind: 'workspace' });
  assert.deepEqual(cache.get('ca_notion', CHILD), { kind: 'page', id: ROOT });
  assert.deepEqual(cache.get('ca_other', CHILD), { kind: 'workspace' }, 'edges are per remote account');
  now = 5 * 60_000;
  assert.equal(cache.get('ca_notion', CHILD), undefined);
  now = 0;
  for (let index = 0; index <= 4_096; index += 1) {
    cache.set('ca_notion', id(`c${index.toString(16)}`), { kind: 'workspace' });
  }
  assert.equal(cache.get('ca_notion', id('c0')), undefined, 'the least recently used edge goes first');
  assert.deepEqual(cache.get('ca_notion', id('c1')), { kind: 'workspace' });
});

const SEARCH = [
  { id: CHILD, object: 'page', parent: { type: 'page_id', page_id: ROOT }, properties: {}, url: 'https://notion.so/child' },
  { id: SOURCE, object: 'data_source', parent: { type: 'database_id', database_id: TASKS }, title: [{ plain_text: 'Tasks' }] },
  { id: TASKS, object: 'database', parent: { type: 'page_id', page_id: CHILD }, title: [{ plain_text: 'Tasks' }] },
  { id: ROW, object: 'page', parent: { type: 'data_source_id', data_source_id: SOURCE } },
  { id: HIDDEN, object: 'page', parent: { type: 'page_id', page_id: ELSEWHERE }, title: 'Hidden' },
  { id: LOOSE, object: 'page', parent: { type: 'workspace', workspace: true }, title: 'Loose' },
];

test('search keeps what it can place under a chosen page, drops the rest, and says nothing about what it dropped', async () => {
  const strays = Array.from({ length: 20 }, (_, index) => ({
    id: id(`d${index.toString(16)}`), object: 'page', parent: { type: 'page_id', page_id: id(`e${index.toString(16)}`) },
  }));
  const { provider, lookups } = notionWorld({ search: [...SEARCH, ...strays] });
  const result = await provider.execute({
    policy: ONLY_ROOT, capability: 'notion.content.search', arguments: { query: 'plans' },
  });
  assert.deepEqual((result.data.items as Array<{ id: string }>).map((item) => item.id), [CHILD, SOURCE, TASKS, ROW]);
  assert.equal(lookups().length, 12, 'the strays spend the whole budget and no more');
  assert.doesNotMatch(JSON.stringify(result.data), /total_count|99|Hidden|Loose|parent/);
});
