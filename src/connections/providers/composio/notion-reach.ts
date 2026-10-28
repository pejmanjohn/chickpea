import { isRecord } from '../../../security/content-validation.ts';
import type { NotionCapabilityId } from '../../catalog/notion.ts';
import { ManagedAuthorityDeniedError } from '../../managed-errors.ts';
import { parseNotionId, type NotionId, type NotionPageScope } from '../../notion-pages.ts';

export type NotionRef = { kind: 'page' | 'database' | 'data_source' | 'block'; id: NotionId };

export type NotionParent = NotionRef | { kind: 'workspace' };

/** The one refusal, whether a page is outside the Agent's scope or not visible at all. */
export const NOTION_PAGE_UNAVAILABLE = "That Notion page isn't available to this Agent.";

export class NotionPageUnavailableError extends Error {
  readonly name = 'NotionPageUnavailableError';

  constructor() {
    super(NOTION_PAGE_UNAVAILABLE);
  }
}

/**
 * A Notion `parent` object. A page in a data source names its database when
 * Notion says which one. Undefined when it names nothing Chickpea can follow.
 */
export function notionParent(value: unknown): NotionParent | undefined {
  if (!isRecord(value)) return undefined;
  const ref = (kind: NotionRef['kind'], raw: unknown): NotionRef | undefined => {
    const id = parseNotionId(raw);
    return id ? { kind, id } : undefined;
  };
  switch (value.type) {
    case 'workspace': return { kind: 'workspace' };
    case 'page_id': return ref('page', value.page_id);
    case 'database_id': return ref('database', value.database_id);
    case 'data_source_id':
      return ref('database', value.database_id) ?? ref('data_source', value.data_source_id);
    case 'block_id': return ref('block', value.block_id);
    default: return undefined;
  }
}

type NotionScopeRule =
  | { phase: 'search' }
  | { phase: 'after'; argument: string; kind: 'page' | 'database' }
  | {
      phase: 'before';
      argument: string;
      kind: NotionRef['kind'];
      lookups: 'cached' | 'live';
      /** The argument that carries Notion-flavored Markdown, which may name other Notion objects. */
      content?: string;
    };

/** A Notion capability without a rule here does not compile. */
const NOTION_SCOPE_RULES = {
  'notion.content.search': { phase: 'search' },
  'notion.pages.get': { phase: 'after', argument: 'page_id', kind: 'page' },
  'notion.pages.markdown': { phase: 'before', argument: 'page_id', kind: 'page', lookups: 'cached' },
  'notion.databases.get': { phase: 'after', argument: 'database_id', kind: 'database' },
  'notion.databases.query': { phase: 'before', argument: 'database_id', kind: 'database', lookups: 'cached' },
  'notion.data_sources.query': {
    phase: 'before', argument: 'data_source_id', kind: 'data_source', lookups: 'cached',
  },
  // Pages and databases are blocks too, so a parent of either kind resolves through block metadata.
  'notion.pages.create': {
    phase: 'before', argument: 'parent_id', kind: 'block', lookups: 'live', content: 'markdown',
  },
  'notion.pages.update_properties': { phase: 'before', argument: 'row_id', kind: 'page', lookups: 'live' },
  // Block content travels as rich text, never as Markdown, so it cannot name another object.
  'notion.pages.append_blocks': { phase: 'before', argument: 'parent_block_id', kind: 'block', lookups: 'live' },
} as const satisfies Record<NotionCapabilityId, NotionScopeRule>;

/**
 * Notion-flavored Markdown tags that name another Notion object. `<page url>`
 * moves an existing page under the new one; the others embed or mention a
 * page the walk never checked. A scoped Agent's content may carry none of them.
 */
const NOTION_OBJECT_TAG =
  /<\s*(?:page|database|data-source|synced_block|synced_block_reference|mention-page|mention-database|mention-data-source)\b/i;

function namesNotionObject(content: unknown): boolean {
  return typeof content === 'string' && NOTION_OBJECT_TAG.test(content);
}

const MAX_WALK_DEPTH = 24;
const SEARCH_LOOKUP_BUDGET = 12;

type NotionLookupTool = 'NOTION_RETRIEVE_PAGE' | 'NOTION_FETCH_DATABASE' | 'NOTION_FETCH_BLOCK_METADATA';

/**
 * One Notion read through the invocation's client, which rechecks the
 * Agent's authority first. Undefined when the provider reports a failure.
 */
export type NotionLookup = (
  tool: NotionLookupTool,
  arguments_: Record<string, unknown>,
) => Promise<Record<string, unknown> | undefined>;

/**
 * Parent edges Notion reported, per remote account. Edges, never verdicts:
 * a scope that changes still decides every walk afresh.
 */
export class NotionEdgeCache {
  private readonly edges = new Map<string, { parent: NotionParent; expiresAt: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly capacity = 4_096,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  get(accountRef: string, id: NotionId): NotionParent | undefined {
    const key = `${accountRef}\u0000${id}`;
    const edge = this.edges.get(key);
    if (!edge) return undefined;
    this.edges.delete(key);
    if (edge.expiresAt <= this.now()) return undefined;
    this.edges.set(key, edge);
    return edge.parent;
  }

  set(accountRef: string, id: NotionId, parent: NotionParent): void {
    const key = `${accountRef}\u0000${id}`;
    this.edges.delete(key);
    this.edges.set(key, { parent, expiresAt: this.now() + this.ttlMs });
    for (const oldest of this.edges.keys()) {
      if (this.edges.size <= this.capacity) break;
      this.edges.delete(oldest);
    }
  }
}

export interface NotionScopeGate {
  /** Whether the capability reads first and checks the object it returns. */
  readonly checksAfterRead: boolean;
  /** Refuses a target outside the scope before dispatch; names it by the canonical id it checked. */
  before(toolArguments: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Refuses a read object outside the scope, and drops search results it cannot place inside it. */
  after(data: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * An Agent limited to some pages reaches a Notion object only when the
 * object or one of its ancestors is one of them. Walks parents up to 24
 * levels; the workspace, a parent the credential cannot see, an unknown
 * parent, a cycle or a failed lookup refuses. Reads may follow cached
 * edges; writes look every edge up live.
 */
export function notionScopeGate(input: {
  capability: NotionCapabilityId;
  scope: NotionPageScope;
  accountRef: string;
  cache: NotionEdgeCache;
  lookup: NotionLookup;
}): NotionScopeGate {
  const rule: NotionScopeRule = NOTION_SCOPE_RULES[input.capability];
  const { allow } = input.scope;
  const cached = (id: NotionId) => input.cache.get(input.accountRef, id);
  const remember = (id: NotionId, parent: NotionParent) => input.cache.set(input.accountRef, id, parent);
  let checked: NotionId | undefined;

  const read = async (
    tool: NotionLookupTool,
    arguments_: Record<string, unknown>,
    budget?: { left: number },
  ): Promise<Record<string, unknown> | undefined> => {
    if (budget) {
      if (budget.left <= 0) return undefined;
      budget.left -= 1;
    }
    try {
      return await input.lookup(tool, arguments_);
    } catch (error) {
      if (error instanceof ManagedAuthorityDeniedError) throw error;
      return undefined;
    }
  };

  /** The parent `object` names for `ref`; a database row resolves to its database where Notion allows. */
  const parentFromObject = async (
    ref: NotionRef,
    object: Record<string, unknown>,
    live: boolean,
    budget?: { left: number },
  ): Promise<NotionParent | undefined> => {
    let parent = notionParent(object.parent);
    if (parent?.kind === 'data_source' && ref.kind === 'page') {
      const known = live ? undefined : cached(parent.id);
      if (known) {
        parent = known;
      } else {
        // Block metadata names a row's database where the page object names only its data source.
        const database = notionParent((await read('NOTION_FETCH_BLOCK_METADATA', { block_id: ref.id }, budget))?.parent);
        if (database?.kind === 'database') parent = database;
      }
    }
    if (parent) remember(ref.id, parent);
    return parent;
  };

  const parentOf = async (
    ref: NotionRef,
    live: boolean,
    budget?: { left: number },
  ): Promise<NotionParent | undefined> => {
    // No Notion tool reads a data source's database; only the data source's own object places it.
    if (ref.kind === 'data_source') return live ? undefined : cached(ref.id);
    if (!live) {
      const known = cached(ref.id);
      if (known) return known;
    }
    const object = ref.kind === 'page'
      ? await read('NOTION_RETRIEVE_PAGE', { page_id: ref.id }, budget)
      : ref.kind === 'database'
        ? await read('NOTION_FETCH_DATABASE', { database_id: ref.id }, budget)
        : await read('NOTION_FETCH_BLOCK_METADATA', { block_id: ref.id }, budget);
    return object && parentFromObject(ref, object, live, budget);
  };

  /** Whether `target` is inside the scope; `object` is the target as Notion returned it, when it did. */
  const reaches = async (
    target: NotionRef,
    live: boolean,
    budget?: { left: number },
    object?: Record<string, unknown>,
  ): Promise<boolean> => {
    if (allow.has(target.id)) return true;
    let step = object ? await parentFromObject(target, object, live, budget) : await parentOf(target, live, budget);
    const seen = new Set([target.id]);
    for (let depth = 1; step && step.kind !== 'workspace'; depth += 1) {
      if (allow.has(step.id)) return true;
      if (depth === MAX_WALK_DEPTH || seen.has(step.id)) return false;
      seen.add(step.id);
      step = await parentOf(step, live, budget);
    }
    return false;
  };

  const filterSearch = async (data: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const enveloped = isRecord(data.data);
    const source = enveloped ? data.data as Record<string, unknown> : data;
    const results = Array.isArray(source.results) ? source.results : [];
    const values = Array.isArray(source.values) ? source.values : [];
    const placed = results.flatMap((item): Array<{ ref: NotionRef; item: Record<string, unknown> }> => {
      const id = isRecord(item) ? parseNotionId(item.id) : undefined;
      if (!id || !isRecord(item)) return [];
      const parent = notionParent(item.parent);
      if (parent && parent.kind !== 'data_source') remember(id, parent);
      const kind = item.object === 'data_source' ? 'data_source' : item.object === 'database' ? 'database' : 'page';
      return [{ ref: { kind, id }, item }];
    });
    const budget = { left: SEARCH_LOOKUP_BUDGET };
    const allowed = new Set<NotionId>();
    for (const { ref, item } of placed) {
      if (await reaches(ref, false, budget, item)) allowed.add(ref.id);
    }
    const keep = (item: unknown) => {
      const id = isRecord(item) ? parseNotionId(item.id) : undefined;
      return id !== undefined && allowed.has(id);
    };
    const {
      results: _results, values: _values, items: _items, pages: _pages, databases: _databases,
      total_count: _count, ...rest
    } = source;
    const filtered = { ...rest, results: results.filter(keep), values: values.filter(keep) };
    return enveloped ? { ...data, data: filtered } : filtered;
  };

  return {
    checksAfterRead: rule.phase === 'after',
    async before(toolArguments) {
      if (rule.phase === 'search') return toolArguments;
      const id = parseNotionId(toolArguments[rule.argument]);
      if (!id) throw new NotionPageUnavailableError();
      checked = id;
      if (rule.phase === 'before') {
        if (rule.content !== undefined && namesNotionObject(toolArguments[rule.content])) {
          throw new NotionPageUnavailableError();
        }
        if (!await reaches({ kind: rule.kind, id }, rule.lookups === 'live')) throw new NotionPageUnavailableError();
      }
      return { ...toolArguments, [rule.argument]: id };
    },
    async after(data) {
      if (rule.phase === 'search') return filterSearch(data);
      if (rule.phase !== 'after' || !checked) return data;
      const object = isRecord(data.data) ? data.data as Record<string, unknown> : data;
      if (object.id !== undefined && parseNotionId(object.id) !== checked) throw new NotionPageUnavailableError();
      if (!await reaches({ kind: rule.kind, id: checked }, false, undefined, object)) {
        throw new NotionPageUnavailableError();
      }
      return data;
    },
  };
}
