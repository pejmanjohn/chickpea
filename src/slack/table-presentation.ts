import * as v from 'valibot';

import {
  hasDisallowedControlCharacter,
  redactCredentialLikeContent,
} from '../security/content-validation.ts';
import {
  markdownFallbackText,
  type RenderedSlackMessage,
} from './message-format.ts';

export const SLACK_PRESENT_TABLE_TOOL_NAME = 'present_table';
export const SLACK_TABLE_PRESENTATION_DATA_NAME = 'slackTablePresentation';
const SLACK_PRESENT_TABLE_ACKNOWLEDGEMENT =
  'Table recorded. Finish with a short conclusion that does not repeat the rows.';

export const SLACK_PRESENT_TABLE_INSTRUCTION = [
  'Use prose or bullets instead of a table for a yes/no answer, sequential steps, one record, three or fewer simple facts, or rows that would contain long explanations.',
  'For a small static comparison embedded in ordinary prose, write a compact Markdown table directly in the answer. Use Markdown for six or fewer data rows; keep it to four short columns and never force prose into cells.',
  'Call present_table exactly once only when at least seven verified structured rows are a substantial part of the answer. Gather the data first, call it before the final answer text, and do not repeat its rows in prose.',
  'Choose static when the reader needs a read-only snapshot with stable columns, wrapping, alignment, or typed numbers. Choose explore when sorting, filtering, or pagination would help, including longer rankings, queues, inventories, and metric results.',
  'Do not combine present_table with stream_answer. If the full result exceeds 200 rows, 20 columns, or 20,000 cell characters, summarize the important rows and provide the complete result as an artifact when that capability is available.',
  'The caption must say what the rows represent. The row-header column must uniquely name each row. Mark a column numeric only when every value in it is a real number so Slack can sort it numerically.',
].join(' ');

const SlackTableCellSchema = v.union([
  v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
  v.number(),
]);

const SlackTableColumnSchema = v.strictObject({
  header: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  type: v.optional(v.picklist(['text', 'number'])),
  align: v.optional(v.picklist(['left', 'center', 'right'])),
  wrap: v.optional(v.boolean()),
});

export const SlackTablePresentationSchema = v.strictObject({
  caption: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  presentation: v.picklist(['static', 'explore']),
  columns: v.pipe(
    v.array(SlackTableColumnSchema),
    v.minLength(1),
    v.maxLength(20),
  ),
  rows: v.pipe(
    v.array(v.pipe(v.array(SlackTableCellSchema), v.minLength(1), v.maxLength(20))),
    v.minLength(1),
    v.maxLength(200),
  ),
  pageSize: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
  rowHeaderIndex: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(19))),
});

type SlackTableCell = string | number;
type SlackTableColumn = v.InferOutput<typeof SlackTableColumnSchema>;
export type SlackTablePresentation = v.InferOutput<typeof SlackTablePresentationSchema>;

interface SlackRawTextTableCell {
  type: 'raw_text';
  text: string;
}

interface SlackRawNumberTableCell {
  type: 'raw_number';
  value: number;
  text: string;
}

type SlackNativeTableCell = SlackRawTextTableCell | SlackRawNumberTableCell;

interface SlackTableBlock {
  type: 'table';
  rows: SlackNativeTableCell[][];
  column_settings: Array<{
    align?: 'left' | 'center' | 'right';
    is_wrapped?: boolean;
  }>;
}

interface SlackDataTableBlock {
  type: 'data_table';
  caption: string;
  rows: SlackNativeTableCell[][];
  page_size: number;
  row_header_column_index: number;
}

export type SlackNativeTableBlock = SlackTableBlock | SlackDataTableBlock;

export interface RenderedSlackTablePresentation {
  kind: SlackNativeTableBlock['type'];
  block: SlackNativeTableBlock;
  fallbackMarkdown: string;
  fallbackText: string;
}

export function createSlackPresentTableTool(
  writePresentation: (presentation: SlackTablePresentation) => void,
) {
  let presentationRecorded = false;
  return {
    name: SLACK_PRESENT_TABLE_TOOL_NAME,
    description:
      'Present at least seven verified structured rows as a Slack-native static or explorable table. Use Markdown instead for six or fewer rows; never use this for one record.',
    input: SlackTablePresentationSchema,
    output: v.string(),
    run: ({ data }: { data: SlackTablePresentation }) => {
      if (presentationRecorded) {
        throw new Error('Only one native Slack table may be presented in an answer.');
      }
      const presentation = parseSlackTablePresentation(data);
      writePresentation(presentation);
      presentationRecorded = true;
      return { output: SLACK_PRESENT_TABLE_ACKNOWLEDGEMENT };
    },
  };
}

export function parseSlackTablePresentation(value: unknown): SlackTablePresentation {
  const parsed = v.safeParse(SlackTablePresentationSchema, value);
  if (!parsed.success) throw new Error('Slack table presentation is invalid.');

  const presentation: SlackTablePresentation = {
    caption: safeTableText(parsed.output.caption, 'Table caption'),
    presentation: parsed.output.presentation,
    columns: parsed.output.columns.map((column) => ({
      header: safeTableText(column.header, 'Table header'),
      ...(column.type ? { type: column.type } : {}),
      ...(column.align ? { align: column.align } : {}),
      ...(column.wrap === undefined ? {} : { wrap: column.wrap }),
    })),
    rows: parsed.output.rows.map((row) => row.map((cell) =>
      typeof cell === 'number' ? cell : safeTableText(cell, 'Table cell')
    )),
    ...(parsed.output.pageSize === undefined ? {} : { pageSize: parsed.output.pageSize }),
    ...(parsed.output.rowHeaderIndex === undefined
      ? {}
      : { rowHeaderIndex: parsed.output.rowHeaderIndex }),
  };

  const width = presentation.columns.length;
  if (presentation.rows.length === 1) {
    throw new Error(
      'A single record should be answered with prose or bullets, not a native Slack table.',
    );
  }
  if (presentation.rows.some((row) => row.length !== width)) {
    throw new Error('Every Slack table row must have the same number of cells as the columns.');
  }
  const rowHeaderIndex = presentation.rowHeaderIndex ?? 0;
  if (rowHeaderIndex >= width) {
    throw new Error('Slack table rowHeaderIndex must identify an existing column.');
  }
  for (let columnIndex = 0; columnIndex < width; columnIndex += 1) {
    if (presentation.columns[columnIndex]?.type !== 'number') continue;
    for (const row of presentation.rows) {
      const cell = row[columnIndex];
      if (typeof cell === 'number' && Number.isFinite(cell)) continue;
      if (typeof cell === 'string' && PLAIN_NUMBER_PATTERN.test(cell)) {
        const numeric = Number(cell);
        if (Number.isFinite(numeric)) {
          row[columnIndex] = numeric;
          continue;
        }
      }
      throw new Error(
        'Every cell in a numeric Slack table column must be a number or plain numeric string.',
      );
    }
  }
  if (presentation.rows.length <= 6) {
    throw new Error(
      'Six or fewer data rows should use a compact Markdown table, not a native Slack table.',
    );
  }
  if (tableCellCharacterCount(presentation) > 20_000) {
    throw new Error('Slack table cells exceed the 20,000-character data-table limit.');
  }
  return presentation;
}

export function parseSlackTablePresentations(value: unknown): SlackTablePresentation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1) {
    throw new Error('A Slack answer may contain at most one native table presentation.');
  }
  return value.map(parseSlackTablePresentation);
}

export function renderSlackTablePresentation(
  value: SlackTablePresentation,
  fallbackMarkdownLimit = 12_000,
): RenderedSlackTablePresentation {
  const presentation = parseSlackTablePresentation(value);
  const kind = nativeTableKind(presentation);
  const header = presentation.columns.map(({ header: text }) => ({
    type: 'raw_text' as const,
    text,
  }));
  const rows = [
    header,
    ...presentation.rows.map((row) => row.map((cell, columnIndex) =>
      nativeCell(cell, presentation.columns[columnIndex]!)
    )),
  ];
  const block: SlackNativeTableBlock = kind === 'data_table'
    ? {
        type: 'data_table',
        caption: presentation.caption,
        rows,
        page_size: presentation.pageSize ?? Math.min(10, presentation.rows.length),
        row_header_column_index: presentation.rowHeaderIndex ?? 0,
      }
    : {
        type: 'table',
        rows,
        column_settings: presentation.columns.map((column) => ({
          align: column.align ?? (column.type === 'number' ? 'right' : 'left'),
          is_wrapped: column.wrap ?? column.type !== 'number',
        })),
      };
  return {
    kind,
    block,
    fallbackMarkdown: tableFallbackMarkdown(presentation, fallbackMarkdownLimit),
    fallbackText: tableFallbackText(presentation),
  };
}

export function appendSlackTableToRenderedMessage(
  rendered: RenderedSlackMessage,
  sourceText: string,
  table: RenderedSlackTablePresentation,
): RenderedSlackMessage {
  return {
    ...rendered,
    text: markdownFallbackText(`${sourceText}\n\n${table.fallbackText}`),
    blocks: [...(rendered.blocks ?? []), table.block],
  };
}

function tableCellCharacterCount(presentation: SlackTablePresentation): number {
  return presentation.columns.reduce((sum, column) => sum + column.header.length, 0) +
    presentation.rows.reduce<number>((sum, row) =>
      sum + row.reduce<number>((rowSum, cell) => rowSum + String(cell).length, 0), 0
    );
}

function nativeTableKind(presentation: SlackTablePresentation): SlackNativeTableBlock['type'] {
  return presentation.presentation === 'explore' ||
      presentation.rows.length + 1 > 100 ||
      tableCellCharacterCount(presentation) > 10_000
    ? 'data_table'
    : 'table';
}

function nativeCell(
  cell: SlackTableCell,
  column: SlackTableColumn,
): SlackNativeTableCell {
  if (column.type === 'number') {
    const value = cell as number;
    return { type: 'raw_number', value, text: String(value) };
  }
  return { type: 'raw_text', text: String(cell) };
}

function tableFallbackMarkdown(
  presentation: SlackTablePresentation,
  limit: number,
): string {
  const safeLimit = Math.max(0, Math.floor(limit));
  const header = `| ${presentation.columns.map((column) => markdownCell(column.header)).join(' | ')} |`;
  const separator = `| ${presentation.columns.map((column) =>
    column.type === 'number' || column.align === 'right' ? '---:' : '---'
  ).join(' | ')} |`;
  const prefix = `**${presentation.caption}**\n\n${header}\n${separator}`;
  if (prefix.length > safeLimit) return truncate(prefix, safeLimit);

  const lines = [prefix];
  let shown = 0;
  for (const row of presentation.rows) {
    const line = `| ${row.map((cell) => markdownCell(String(cell))).join(' | ')} |`;
    const possibleNote = shown + 1 < presentation.rows.length
      ? `\n_Showing ${shown + 1} of ${presentation.rows.length} rows._`
      : '';
    if (`${lines.join('\n')}\n${line}${possibleNote}`.length > safeLimit) break;
    lines.push(line);
    shown += 1;
  }
  if (shown < presentation.rows.length) {
    lines.push(`_Showing ${shown} of ${presentation.rows.length} rows._`);
  }
  return truncate(lines.join('\n'), safeLimit);
}

function tableFallbackText(presentation: SlackTablePresentation): string {
  const lines = [presentation.caption];
  for (const row of presentation.rows) {
    lines.push(presentation.columns.map((column, index) =>
      `${column.header}: ${String(row[index])}`
    ).join(' | '));
  }
  return lines.join('\n');
}

function markdownCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function safeTableText(value: string, label: string): string {
  if (hasDisallowedControlCharacter(value)) {
    throw new Error(`${label} contains a disallowed control character.`);
  }
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (!normalized) throw new Error(`${label} cannot be empty.`);
  return redactCredentialLikeContent(normalized)
    .replace(/\[credential redacted\](?: redacted\])+/g, '[credential redacted]');
}

const PLAIN_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= 0) return '';
  const suffix = '\n[truncated]';
  return limit <= suffix.length
    ? value.slice(0, limit)
    : `${value.slice(0, limit - suffix.length)}${suffix}`;
}
