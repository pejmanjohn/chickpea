import type { ManagedBindingResourceConstraints } from '../config/types.ts';
import { sha256Hex } from '../security/digest.ts';

declare const notionIdBrand: unique symbol;

/** A Notion page, database, data source or block id in its canonical form: lowercase, dashed. */
export type NotionId = string & { readonly [notionIdBrand]: true };

export const NOTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The binding resource-constraint key that holds an Agent's page choice. */
export const NOTION_PAGES_KEY = 'notionPages';

/** At most this many pages in one Agent's choice or one page list. */
export const MAX_NOTION_PAGES = 256;

/** A page or database a Notion credential lists. */
export interface NotionListedPage {
  id: NotionId;
  kind: 'page' | 'database';
  label: string;
  /** The page or database Notion names as its parent; a data source stands for its database. */
  parent?: NotionId;
}

export interface NotionPageListing {
  pages: NotionListedPage[];
  /** False when Notion had more to list than Chickpea read. */
  complete: boolean;
}

/** A listed page or database that no other listed page contains. */
export type NotionPageRoot = Omit<NotionListedPage, 'parent'>;

/** An Agent limited to some pages reaches only those and what is inside them. */
export interface NotionPageScope {
  allow: ReadonlySet<NotionId>;
}

/** Accepts a dashed id, a bare 32-hex id, or a notion.so URL that ends in one. */
export function parseNotionId(raw: unknown): NotionId | undefined {
  if (typeof raw !== 'string' || raw.length > 2_000) return undefined;
  const value = raw.trim();
  if (/^https?:\/\//i.test(value)) return notionIdFromUrl(value);
  if (/^[0-9a-f]{32}$/i.test(value)) return dashed(value.toLowerCase());
  return NOTION_ID_PATTERN.test(value.toLowerCase()) ? value.toLowerCase() as NotionId : undefined;
}

function notionIdFromUrl(value: string): NotionId | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'notion.so' && !host.endsWith('.notion.so')) return undefined;
  const segment = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
  const match = /(?:^|-)([0-9a-f]{32})$/i.exec(segment);
  return match ? dashed(match[1]!.toLowerCase()) : undefined;
}

function dashed(hex: string): NotionId {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as NotionId;
}

/** How the browser names a listed page: the same for one page every time, and never its Notion id. */
export async function notionPageHandle(id: NotionId): Promise<string> {
  return `page_${(await sha256Hex(`${NOTION_PAGES_KEY}\u0000${id}`)).slice(0, 32)}`;
}

/** An Agent's scope from its binding; none leaves Notion's own grant as the boundary. */
export function agentPageScope(
  constraints: ManagedBindingResourceConstraints | undefined,
): NotionPageScope | undefined {
  const choice = readAgentPageChoice(constraints);
  return choice === undefined ? undefined : { allow: new Set(choice) };
}

export function samePageScope(
  left: NotionPageScope | undefined,
  right: NotionPageScope | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.allow.size === right.allow.size && [...left.allow].every((id) => right.allow.has(id));
}

/** The listed pages no other listed page contains, at most 256. */
export function pageRoots(listing: NotionPageListing): { roots: NotionListedPage[]; complete: boolean } {
  const listed = new Set(listing.pages.map(({ id }) => id));
  const roots = listing.pages.filter((page) => page.parent === undefined || !listed.has(page.parent));
  return { roots: roots.slice(0, MAX_NOTION_PAGES), complete: listing.complete && roots.length <= MAX_NOTION_PAGES };
}

/** An Agent's "Only these pages" choice; undefined means all pages. Entries that do not parse are dropped. */
export function readAgentPageChoice(
  constraints: ManagedBindingResourceConstraints | undefined,
): NotionId[] | undefined {
  const handles: unknown = constraints?.[NOTION_PAGES_KEY];
  if (handles === undefined) return undefined;
  if (!Array.isArray(handles)) return [];
  return unique(handles.flatMap((handle) => {
    const id = parseNotionId(handle);
    return id && id === handle ? [id] : [];
  }));
}

export function writeAgentPageChoice(
  constraints: ManagedBindingResourceConstraints | undefined,
  choice: readonly NotionId[] | undefined,
): ManagedBindingResourceConstraints {
  const { [NOTION_PAGES_KEY]: _previous, ...rest } = constraints ?? {};
  if (choice === undefined) return rest;
  const ids = unique(choice);
  if (ids.length > MAX_NOTION_PAGES) throw new Error('An Agent can be limited to at most 256 Notion pages');
  return { ...rest, [NOTION_PAGES_KEY]: ids };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
