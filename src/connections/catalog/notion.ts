import * as v from 'valibot';

import type { ManagedConnectorDefinition } from './types.ts';

const DEFAULT_RESULT_LIMIT = 256 * 1024;
const Id = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000));
const ShortText = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2_000));
const Content = v.pipe(v.string(), v.minLength(1), v.maxLength(100_000));
const Cursor = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2_000));

const SearchSchema = v.strictObject({
  query: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2_000))),
  type: v.optional(v.picklist(['all', 'pages', 'databases'])),
  pageSize: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
  startCursor: v.optional(Cursor),
});
const PageIdSchema = v.strictObject({ pageId: Id });
const PageMarkdownSchema = v.strictObject({
  pageId: Id,
  includeTranscript: v.optional(v.boolean()),
});
const DatabaseIdSchema = v.strictObject({ databaseId: Id });
const SortSchema = v.strictObject({
  propertyName: ShortText,
  ascending: v.boolean(),
});
const DatabaseQuerySchema = v.strictObject({
  databaseId: Id,
  sorts: v.optional(v.pipe(v.array(SortSchema), v.maxLength(10))),
  pageSize: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
  startCursor: v.optional(Cursor),
});
const DataSourceQuerySchema = v.strictObject({
  dataSourceId: Id,
  propertyIds: v.optional(v.pipe(v.array(Id), v.maxLength(100))),
  pageSize: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
  startCursor: v.optional(Cursor),
});
const PageCreateSchema = v.strictObject({
  parentId: Id,
  title: ShortText,
  markdown: v.optional(Content),
});
const PagePropertySchema = v.strictObject({
  name: ShortText,
  type: v.picklist([
    'title', 'rich_text', 'number', 'select', 'multi_select', 'date', 'checkbox',
    'url', 'email', 'phone_number', 'status',
  ]),
  value: v.pipe(v.string(), v.maxLength(10_000)),
});
const PagePropertyUpdateSchema = v.pipe(
  v.strictObject({
    pageId: Id,
    properties: v.pipe(v.array(PagePropertySchema), v.minLength(1), v.maxLength(100)),
  }),
  v.check((input) => JSON.stringify(input.properties).length <= 100_000, 'Page properties are too large'),
);
const ContentBlockSchema = v.union([
  v.strictObject({ type: v.literal('divider') }),
  v.strictObject({
    type: v.picklist([
      'paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item',
      'numbered_list_item', 'to_do', 'toggle', 'callout', 'quote',
    ]),
    content: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
  }),
]);
const PageAppendSchema = v.pipe(
  v.strictObject({
    parentBlockId: Id,
    afterBlockId: v.optional(Id),
    blocks: v.pipe(v.array(ContentBlockSchema), v.minLength(1), v.maxLength(100)),
  }),
  v.check((input) => JSON.stringify(input.blocks).length <= 100_000, 'Page blocks are too large'),
);

export const MANAGED_NOTION_CONNECTORS: readonly ManagedConnectorDefinition[] = [{
  id: 'notion-managed',
  toolkit: 'notion',
  providerId: 'notion',
  label: 'Notion',
  description: 'Search, read, create, and update the Notion pages and databases you approve.',
  securityDescription:
    'Notion sign-in opens through Composio. In Notion, choose only the pages and databases Chickpea may use. That provider grant includes descendants Notion makes available; change it later by reconnecting. Chickpea excludes archive, delete, sharing, permissions, and raw block APIs.',
  capabilities: [
    capability('notion.content.search', 'read', 'read', 'notion_search', 'Search accessible Notion pages and databases.', SearchSchema),
    capability('notion.pages.get', 'read', 'read', 'notion_get_page', 'Read one accessible Notion page and its properties.', PageIdSchema),
    capability('notion.pages.markdown', 'read', 'read', 'notion_get_page_markdown', 'Read one accessible Notion page as bounded Markdown.', PageMarkdownSchema),
    capability('notion.databases.get', 'read', 'read', 'notion_get_database', 'Read the schema of one accessible Notion database.', DatabaseIdSchema),
    capability('notion.databases.query', 'read', 'read', 'notion_query_database', 'Query bounded rows from one accessible Notion database.', DatabaseQuerySchema),
    capability('notion.data_sources.query', 'read', 'read', 'notion_query_data_source', 'Query bounded rows from one accessible Notion data source.', DataSourceQuerySchema),
    capability('notion.pages.create', 'write', 'reversible_write', 'notion_create_page', 'Create a child page under an accessible Notion page or database.', PageCreateSchema, 'create Notion page'),
    capability('notion.pages.update_properties', 'write', 'reversible_write', 'notion_update_page_properties', 'Update bounded scalar properties on an accessible Notion page.', PagePropertyUpdateSchema, 'update Notion page properties'),
    capability('notion.pages.append_blocks', 'write', 'reversible_write', 'notion_append_page_blocks', 'Append bounded text-oriented blocks to an accessible Notion page.', PageAppendSchema, 'append Notion page content'),
  ],
}] as const;

function capability(
  id: string,
  accessLane: 'read' | 'write',
  effect: 'read' | 'reversible_write',
  toolName: string,
  description: string,
  input: ManagedConnectorDefinition['capabilities'][number]['input'],
  sideEffectLabel?: string,
): ManagedConnectorDefinition['capabilities'][number] {
  return {
    id,
    connectorToolkit: 'notion',
    accessLane,
    effect,
    toolName,
    description,
    input,
    maxResultBytes: DEFAULT_RESULT_LIMIT,
    ...(sideEffectLabel ? { sideEffectLabel } : {}),
  };
}
