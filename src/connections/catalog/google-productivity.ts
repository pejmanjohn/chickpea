import * as v from 'valibot';

import type { ManagedConnectorDefinition } from './types.ts';

const DEFAULT_RESULT_LIMIT = 256 * 1024;
const Id = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000));
const ShortText = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2_000));
const Content = v.pipe(v.string(), v.minLength(1), v.maxLength(100_000));
const PageToken = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2_000));
const Cell = v.union([
  v.pipe(v.string(), v.maxLength(10_000)),
  v.number(),
  v.boolean(),
  v.null(),
]);
const CellMatrix = v.pipe(
  v.array(v.pipe(v.array(Cell), v.minLength(1), v.maxLength(100))),
  v.minLength(1),
  v.maxLength(500),
  v.check((rows) => JSON.stringify(rows).length <= 100_000, 'Cell data is too large'),
);

const SearchSchema = v.strictObject({
  query: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2_000))),
  pageToken: v.optional(PageToken),
  maxResults: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
});
const SpreadsheetIdSchema = v.strictObject({ spreadsheetId: Id });
const SheetValuesReadSchema = v.strictObject({
  spreadsheetId: Id,
  range: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000)),
  startRow: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000_000))),
  endRow: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000_000))),
  majorDimension: v.optional(v.picklist(['ROWS', 'COLUMNS'])),
  valueRenderOption: v.optional(v.picklist([
    'FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA',
  ])),
});
const SheetLookupSchema = v.strictObject({
  spreadsheetId: Id,
  query: ShortText,
  range: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000))),
  caseSensitive: v.optional(v.boolean()),
});
const SheetCreateSchema = v.strictObject({
  title: ShortText,
  folderId: v.optional(Id),
});
const SheetValuesWriteSchema = v.strictObject({
  spreadsheetId: Id,
  range: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000)),
  values: CellMatrix,
  majorDimension: v.optional(v.picklist(['ROWS', 'COLUMNS'])),
  valueInputOption: v.optional(v.picklist(['RAW', 'USER_ENTERED'])),
});
const SheetAppendSchema = v.strictObject({
  spreadsheetId: Id,
  range: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000)),
  values: CellMatrix,
  valueInputOption: v.optional(v.picklist(['RAW', 'USER_ENTERED'])),
});
const SheetUpsertSchema = v.strictObject({
  spreadsheetId: Id,
  sheetName: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  headers: v.pipe(v.array(ShortText), v.minLength(1), v.maxLength(100)),
  rows: CellMatrix,
  keyColumn: ShortText,
  tableStart: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(32))),
});
const SheetAddSchema = v.strictObject({
  spreadsheetId: Id,
  title: ShortText,
  rowCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100_000))),
  columnCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(18_278))),
  frozenRowCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100_000))),
  frozenColumnCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(18_278))),
  hideGridlines: v.optional(v.boolean()),
  forceUnique: v.optional(v.boolean()),
});

const DocumentStructureSchema = v.strictObject({
  documentId: Id,
  includeTabs: v.optional(v.boolean()),
});
const DocumentTextSchema = v.strictObject({
  documentId: Id,
  includeTabs: v.optional(v.boolean()),
  includeTables: v.optional(v.boolean()),
  includeHeaders: v.optional(v.boolean()),
  includeFooters: v.optional(v.boolean()),
  includeFootnotes: v.optional(v.boolean()),
});
const DocumentExportSchema = v.strictObject({
  documentId: Id,
  filename: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(240))),
});
const DocumentCreateSchema = v.strictObject({
  title: ShortText,
  text: v.optional(v.pipe(v.string(), v.maxLength(100_000))),
});
const DocumentMarkdownCreateSchema = v.strictObject({ title: ShortText, markdown: Content });
const DocumentInsertSchema = v.pipe(
  v.strictObject({
    documentId: Id,
    text: Content,
    appendToEnd: v.optional(v.boolean()),
    insertionIndex: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000_000))),
    tabId: v.optional(Id),
  }),
  v.check(
    (input) => input.appendToEnd === true || input.insertionIndex !== undefined,
    'Choose appendToEnd or insertionIndex',
  ),
);
const DocumentMarkdownUpdateSchema = v.strictObject({
  documentId: Id,
  markdown: Content,
  tabId: v.optional(Id),
});
const DocumentSectionSchema = v.pipe(
  v.strictObject({
    documentId: Id,
    markdown: Content,
    startIndex: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000_000))),
    endIndex: v.optional(v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(10_000_001))),
    tabId: v.optional(Id),
  }),
  v.check(
    (input) => input.endIndex === undefined ||
      (input.startIndex !== undefined && input.endIndex > input.startIndex),
    'endIndex must be greater than startIndex',
  ),
);

const PresentationIdSchema = v.strictObject({ presentationId: Id });
const PresentationPageSchema = v.strictObject({ presentationId: Id, pageObjectId: Id });
const PresentationThumbnailSchema = v.strictObject({
  presentationId: Id,
  pageObjectId: Id,
  size: v.optional(v.picklist(['SMALL', 'MEDIUM', 'LARGE'])),
});
const PresentationCreateSchema = v.strictObject({
  title: ShortText,
  locale: v.optional(v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(35))),
});
const PresentationMarkdownSchema = v.strictObject({ title: ShortText, markdown: Content });
const PresentationCopySchema = v.strictObject({
  templatePresentationId: Id,
  title: ShortText,
  parentFolderId: v.optional(Id),
});
const SlideOperationSchema = v.union([
  v.strictObject({
    kind: v.literal('replace_all_text'),
    findText: ShortText,
    replaceText: v.pipe(v.string(), v.minLength(1), v.maxLength(20_000)),
    matchCase: v.optional(v.boolean()),
  }),
  v.strictObject({
    kind: v.literal('insert_text'),
    objectId: Id,
    text: Content,
    insertionIndex: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10_000_000))),
  }),
  v.strictObject({
    kind: v.literal('create_slide'),
    slideId: v.optional(Id),
    insertionIndex: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10_000))),
    layout: v.optional(v.picklist([
      'BLANK', 'CAPTION_ONLY', 'MAIN_POINT', 'ONE_COLUMN_TEXT', 'SECTION_HEADER',
      'SECTION_TITLE_AND_DESCRIPTION', 'TITLE', 'TITLE_AND_BODY', 'TITLE_AND_TWO_COLUMNS',
      'TITLE_ONLY', 'BIG_NUMBER',
    ])),
  }),
]);
const PresentationBatchSchema = v.pipe(
  v.strictObject({
    presentationId: Id,
    operations: v.pipe(v.array(SlideOperationSchema), v.minLength(1), v.maxLength(25)),
    requiredRevisionId: v.optional(Id),
  }),
  v.check((input) => JSON.stringify(input.operations).length <= 100_000, 'Slide updates are too large'),
);

export const MANAGED_GOOGLE_PRODUCTIVITY_CONNECTORS: readonly ManagedConnectorDefinition[] = [
  {
    id: 'google-sheets', toolkit: 'googlesheets', providerId: 'google', label: 'Google Sheets',
    description: 'Find spreadsheets, read ranges, and make bounded table updates.',
    securityDescription: 'Google sign-in opens through Composio. Chickpea exposes explicit spreadsheet/range tools and never arbitrary Sheets API requests.',
    capabilities: [
      capability('sheets.spreadsheets.search', 'read', 'read', 'google_sheets_search', 'Search accessible Google spreadsheets.', SearchSchema),
      capability('sheets.spreadsheets.metadata', 'read', 'read', 'google_sheets_get_metadata', 'Read bounded spreadsheet and sheet metadata.', SpreadsheetIdSchema),
      capability('sheets.values.get', 'read', 'read', 'google_sheets_get_values', 'Read a bounded A1 range from a spreadsheet.', SheetValuesReadSchema),
      capability('sheets.tables.query', 'read', 'read', 'google_sheets_lookup_row', 'Find the first row containing an exact cell value within an optional A1 range.', SheetLookupSchema),
      capability('sheets.spreadsheets.create', 'write', 'reversible_write', 'google_sheets_create', 'Create a Google spreadsheet.', SheetCreateSchema, 'create Google spreadsheet'),
      capability('sheets.values.update', 'write', 'reversible_write', 'google_sheets_update_values', 'Replace values in one explicit A1 range.', SheetValuesWriteSchema, 'update spreadsheet values'),
      capability('sheets.values.append', 'write', 'reversible_write', 'google_sheets_append_values', 'Append bounded rows to one sheet-qualified range.', SheetAppendSchema, 'append spreadsheet rows'),
      capability('sheets.rows.upsert', 'write', 'reversible_write', 'google_sheets_upsert_rows', 'Update or append rows using one named key column.', SheetUpsertSchema, 'upsert spreadsheet rows'),
      capability('sheets.sheets.add', 'write', 'reversible_write', 'google_sheets_add_sheet', 'Add one bounded grid sheet to a spreadsheet.', SheetAddSchema, 'add spreadsheet sheet'),
    ],
  },
  {
    id: 'google-docs', toolkit: 'googledocs', providerId: 'google', label: 'Google Docs',
    description: 'Find, read, export, create, and update Google documents.',
    securityDescription: 'Google sign-in opens through Composio. Chickpea exposes bounded document operations and excludes sharing, delete, and arbitrary batch requests.',
    capabilities: [
      capability('docs.documents.search', 'read', 'read', 'google_docs_search', 'Search accessible Google documents.', SearchSchema),
      capability('docs.documents.get', 'read', 'read', 'google_docs_get', 'Read the structured content of one Google document.', DocumentStructureSchema),
      capability('docs.documents.text', 'read', 'read', 'google_docs_get_text', 'Read a bounded plain-text rendering of one Google document.', DocumentTextSchema),
      capability('docs.documents.export_pdf', 'read', 'read', 'google_docs_export_pdf', 'Export one Google document as a PDF artifact.', DocumentExportSchema),
      capability('docs.documents.create', 'write', 'reversible_write', 'google_docs_create', 'Create a Google document with optional plain text.', DocumentCreateSchema, 'create Google document'),
      capability('docs.documents.create_markdown', 'write', 'reversible_write', 'google_docs_create_markdown', 'Create a Google document from bounded Markdown.', DocumentMarkdownCreateSchema, 'create Google document from Markdown'),
      capability('docs.documents.insert_text', 'write', 'reversible_write', 'google_docs_insert_text', 'Insert or append plain text at an explicit document location.', DocumentInsertSchema, 'insert text into Google document'),
      capability('docs.documents.update_markdown', 'write', 'reversible_write', 'google_docs_update_markdown', 'Replace one document tab with bounded Markdown.', DocumentMarkdownUpdateSchema, 'replace Google document content'),
      capability('docs.documents.update_section_markdown', 'write', 'reversible_write', 'google_docs_update_section', 'Insert or replace a bounded document section with Markdown.', DocumentSectionSchema, 'update Google document section'),
    ],
  },
  {
    id: 'google-slides', toolkit: 'googleslides', providerId: 'google', label: 'Google Slides',
    description: 'Read presentations and create or update slides through bounded operations.',
    securityDescription: 'Google sign-in opens through Composio. Chickpea excludes delete, sharing, and arbitrary Slides request arrays.',
    capabilities: [
      capability('slides.presentations.get', 'read', 'read', 'google_slides_get_presentation', 'Read bounded presentation and slide metadata.', PresentationIdSchema),
      capability('slides.pages.get', 'read', 'read', 'google_slides_get_page', 'Read one page from a presentation.', PresentationPageSchema),
      capability('slides.pages.thumbnail', 'read', 'read', 'google_slides_get_thumbnail', 'Get a temporary preview URL for one presentation page.', PresentationThumbnailSchema),
      capability('slides.presentations.create', 'write', 'reversible_write', 'google_slides_create', 'Create a blank Google Slides presentation.', PresentationCreateSchema, 'create Google Slides presentation'),
      capability('slides.presentations.create_markdown', 'write', 'reversible_write', 'google_slides_create_markdown', 'Create a Google Slides presentation from bounded Markdown.', PresentationMarkdownSchema, 'create Google Slides from Markdown'),
      capability('slides.presentations.copy_template', 'write', 'reversible_write', 'google_slides_copy_template', 'Copy an accessible Slides template into a new presentation.', PresentationCopySchema, 'copy Google Slides template'),
      capability('slides.presentations.batch_update', 'write', 'reversible_write', 'google_slides_update', 'Apply only reviewed create-slide, insert-text, or replace-text operations.', PresentationBatchSchema, 'update Google Slides presentation'),
    ],
  },
] as const;

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
    connectorToolkit: id.startsWith('sheets.')
      ? 'googlesheets'
      : id.startsWith('docs.')
      ? 'googledocs'
      : 'googleslides',
    accessLane,
    effect,
    toolName,
    description,
    input,
    maxResultBytes: DEFAULT_RESULT_LIMIT,
    ...(sideEffectLabel ? { sideEffectLabel } : {}),
  };
}
