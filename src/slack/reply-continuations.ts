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

/** What only the last message of a reply carries. */
export interface SlackReplyClosing {
  footer: SlackReplyFooter;
  table?: RenderedSlackTablePresentation;
  files?: readonly CompletedSlackArtifactReceipt[];
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

/** The native table rides with the footer on the reply's last message. */
export function renderSlackReplyTable(
  table: SlackTablePresentation | undefined,
  lastPart: string,
): RenderedSlackTablePresentation | undefined {
  return table
    ? renderSlackTablePresentation(table, Math.max(0, 12_000 - lastPart.length - 2))
    : undefined;
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
  if (closing.files?.length) {
    return {
      ...renderSlackArtifactMessage(
        text, format, closing.footer, closing.files, closing.table?.fallbackText,
      ),
      unfurl_links: true,
      unfurl_media: true,
    };
  }
  return appendSlackReplyFooter(
    closing.table ? appendSlackTableToRenderedMessage(content, text, closing.table) : content,
    closing.footer,
  );
}

/** Rendered follow-up messages; the last one closes the reply. */
export function renderSlackReplyContinuations(
  continuations: readonly string[],
  format: SlackReplyFormat,
  closing: SlackReplyClosing,
): Array<{ text: string; payload: string }> {
  return continuations.map((text, index) => ({
    text,
    payload: JSON.stringify(renderSlackReplyPart(
      text,
      format,
      index === continuations.length - 1 ? closing : undefined,
    )),
  }));
}
