import type { CompletedSlackArtifactReceipt } from './artifact-receipts.ts';
import {
  appendSlackReplyFooter,
  renderSlackArtifactMessage,
  renderSlackMessage,
  splitSlackMarkdownReply,
  type RenderedSlackMessage,
  type SlackReplyFooter,
  type SlackReplyFormat,
} from './message-format.ts';
import {
  appendSlackTableToRenderedMessage,
  renderSlackTablePresentation,
  type RenderedSlackTablePresentation,
  type SlackTablePresentation,
} from './table-presentation.ts';

/** Host-compiled display components (cards, charts, details), already checked. */
export interface RenderedSlackComponents {
  blocks: Array<Record<string, unknown>>;
  fallbackText: string;
}

/** What rides with the answer's last message besides the footer. */
export interface SlackClosingPresentation {
  table?: SlackTablePresentation;
  components?: RenderedSlackComponents;
}

/** Callers pass a table alone (the original shape) or a table and components. */
export type SlackClosingInput = SlackTablePresentation | SlackClosingPresentation | undefined;

export function slackClosingPresentation(value: SlackClosingInput): SlackClosingPresentation {
  if (!value) return {};
  return 'rows' in value && 'columns' in value ? { table: value } : value as SlackClosingPresentation;
}

/** What only the last message of a reply carries. */
export interface SlackReplyClosing {
  footer: SlackReplyFooter;
  table?: Pick<RenderedSlackTablePresentation, 'block' | 'fallbackText'>;
  /** Added by the Block Kit display components; earlier builds never write it. */
  components?: RenderedSlackComponents;
  files?: readonly CompletedSlackArtifactReceipt[];
}

/** The closing's native blocks and fallback text, table first. */
export interface RenderedSlackReplyExtras {
  table?: RenderedSlackTablePresentation;
  components?: RenderedSlackComponents;
  blocks: unknown[];
  fallbackText: string;
}

function closingExtras(
  table: Pick<RenderedSlackTablePresentation, 'block' | 'fallbackText'> | undefined,
  components: RenderedSlackComponents | undefined,
): { blocks: unknown[]; fallbackText: string } {
  return {
    blocks: [...(table ? [table.block] : []), ...(components?.blocks ?? [])],
    fallbackText: [table?.fallbackText, components?.fallbackText].filter(Boolean).join('\n\n'),
  };
}

export type RenderedSlackReplyPart = RenderedSlackMessage & {
  unfurl_links?: true;
  unfurl_media?: true;
};

/**
 * The messages one canonical answer occupies. Only markdown answers continue;
 * `maxParts: 1` keeps a surface that cannot post follow-ups to one message.
 */
export function slackReplyParts(
  approved: string,
  format: SlackReplyFormat,
  options: Parameters<typeof splitSlackMarkdownReply>[1] = {},
): string[] {
  return format === 'markdown' ? splitSlackMarkdownReply(approved, options) : [approved];
}

/** The native table and display components ride with the footer on the reply's last message. */
export function renderSlackReplyTable(
  value: SlackClosingInput,
  lastPart: string,
): RenderedSlackReplyExtras | undefined {
  const { table, components } = slackClosingPresentation(value);
  const rendered = table
    ? renderSlackTablePresentation(table, Math.max(0, 12_000 - lastPart.length - 2))
    : undefined;
  if (!rendered && !components) return undefined;
  return {
    ...(rendered ? { table: rendered } : {}),
    ...(components ? { components } : {}),
    ...closingExtras(rendered, components),
  };
}

/** The stored closing fields for rendered extras. */
export function slackReplyClosingExtras(
  extras: RenderedSlackReplyExtras | undefined,
): Pick<SlackReplyClosing, 'table' | 'components'> {
  return {
    ...(extras?.table ? { table: { block: extras.table.block, fallbackText: extras.table.fallbackText } } : {}),
    ...(extras?.components ? { components: extras.components } : {}),
  };
}

/**
 * Render one message of a reply. Earlier messages hold answer text only; the
 * closing message adds the table, file links, and the one footer.
 */
export function renderSlackReplyPart(
  text: string,
  format: SlackReplyFormat,
  closing?: SlackReplyClosing,
): RenderedSlackReplyPart {
  const content = renderSlackMessage(text, format);
  if (!closing) return content;
  const extras = closingExtras(closing.table, closing.components);
  if (closing.files?.length) {
    return {
      ...renderSlackArtifactMessage(
        text, format, closing.footer, closing.files, extras.fallbackText || undefined,
      ),
      unfurl_links: true,
      unfurl_media: true,
    };
  }
  return appendSlackReplyFooter(
    extras.blocks.length ? appendSlackTableToRenderedMessage(content, text, extras) : content,
    closing.footer,
  );
}
