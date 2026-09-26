import { credentialMarkers, redactCredentialLikeContent } from '../security/content-validation.ts';
import type { CompletedSlackArtifactReceipt } from './artifact-receipts.ts';
import type { SlackNativeTableBlock } from './table-presentation.ts';

export const slackMarkdownBlockTextLimit = 12_000;
const slackFallbackTextLimit = 4_000;
const slackSectionTextLimit = 3_000;
const slackFileContentBlockLimit = 49;

export const SLACK_ACTION_LINK_INSTRUCTION = [
  'In Slack replies, never display a raw URL for an action link supplied by Chickpea or a tool.',
  'When a tool result includes actionLinks, render every item as a Markdown link using its supplied label: [label](url).',
  'For any other action URL, choose concise action-oriented link text that describes what opening it does. Apply this rule to future link types without waiting for a link-specific instruction.',
  'Keep a URL visible only when the requester asked for the URL itself or the exact URL is meaningful data.',
].join(' ');

export type SlackReplyFormat = 'plain_text' | 'mrkdwn' | 'markdown';

interface SlackMarkdownBlock {
  type: 'markdown';
  text: string;
}

interface SlackMrkdwnTextElement {
  type: 'mrkdwn';
  text: string;
}

interface SlackContextBlock {
  type: 'context';
  elements: SlackMrkdwnTextElement[];
}

interface SlackPlainTextObject {
  type: 'plain_text';
  text: string;
  emoji: false;
}

interface SlackSectionBlock {
  type: 'section';
  text: SlackPlainTextObject | SlackMrkdwnTextElement;
}

type SlackMessageBlock =
  | SlackMarkdownBlock
  | SlackSectionBlock
  | SlackContextBlock
  | SlackNativeTableBlock;

export interface RenderedSlackMessage {
  text: string;
  blocks?: SlackMessageBlock[];
  mrkdwn?: boolean;
}

interface SlackAdminUrlParams {
  agentId?: string;
  channelId?: string;
}

/** Presentation data returned by Slack-facing tools for any current or future action URL. */
export interface SlackActionLink {
  url: string;
  label: string;
}

export function slackActionLink(url: string, label: string): SlackActionLink {
  return { url, label };
}

export interface SlackReplyFooter {
  agentName: string;
  // Omitted when the model cannot be resolved — the footer drops the segment
  // rather than leaking a diagnostic placeholder into user-facing chrome.
  modelLabel?: string | undefined;
  agentId: string;
  publicUrl?: string | undefined;
  /** Omit the Admin link while keeping Agent/model attribution. */
  includeConfigureLink?: boolean | undefined;
  memoryItems?: readonly string[] | undefined;
  scheduled?: boolean | undefined;
}

export function renderSlackMessage(text: string, format: SlackReplyFormat): RenderedSlackMessage {
  const displayText = canonicalSlackReplyText(text, format);

  if (format === 'markdown') {
    return {
      text: markdownFallbackText(displayText),
      blocks: [
        {
          type: 'markdown',
          text: truncateText(displayText, slackMarkdownBlockTextLimit),
        },
      ],
    };
  }

  if (format === 'plain_text') {
    return {
      text: truncateText(escapeSlackControlCharacters(displayText), slackFallbackTextLimit),
      mrkdwn: false,
    };
  }

  return {
    text: truncateText(displayText, slackFallbackTextLimit),
  };
}

/** Classic Block Kit content and footer for the native file-share message. */
export function renderSlackFileBlocks(
  text: string,
  format: SlackReplyFormat,
  footer: SlackReplyFooter,
  tableText?: string,
): Array<SlackSectionBlock | SlackContextBlock> {
  return [
    ...renderSlackFileContent(text, format, tableText, slackFileContentBlockLimit),
    renderSlackReplyFooterBlock(footer),
  ];
}

/** Private Slack files become attachments on an ordinary persona-authored post.
 * Keep links outside generated code spans and reserve room for every file.
 * This classic section/context shape is verified across desktop, web and mobile.
 */
export function renderSlackArtifactMessage(
  text: string,
  format: SlackReplyFormat,
  footer: SlackReplyFooter,
  files: readonly CompletedSlackArtifactReceipt[],
  tableText?: string,
): RenderedSlackMessage {
  const links = files.map((file) => {
    // Receipt validation bounds the encoded URL and excludes Slack delimiters.
    const url = new URL(file.permalink).href;
    const label = escapeSlackControlCharacters(redactCredentialLikeContent(file.filename)
      .replace(/[|\r\n\u0000-\u001f\u007f]/g, ' '));
    const shortLabel = splitSlackText(label, 256)[0]?.trim() || 'Download file';
    return `<${url}|${shortLabel}>`;
  }).join('\n');
  const linkChunks = splitSlackFileSections(links);
  const content = renderSlackFileContent(
    text, format, tableText, slackFileContentBlockLimit - linkChunks.length,
  );
  const fallbackBody = [renderSlackMessage(text, format).text,
    tableText ? renderSlackMessage(tableText, 'plain_text').text : '',
  ].filter(Boolean).join('\n\n');
  // 4,000 is Slack's recommendation, not its 40,000-character hard limit.
  // Ten long file URLs can exceed the recommendation on their own. Preserve
  // every link and a bounded answer instead of silently dropping attachments.
  const bodyBudget = Math.max(1_000, slackFallbackTextLimit - links.length - 2);
  return {
    text: [truncateText(fallbackBody, bodyBudget), links].filter(Boolean).join('\n\n'),
    blocks: [
      ...content,
      ...linkChunks.map((text): SlackSectionBlock => ({
        type: 'section', text: { type: 'mrkdwn', text },
      })),
      renderSlackReplyFooterBlock(footer),
    ],
  };
}

function renderSlackFileContent(
  text: string,
  format: SlackReplyFormat,
  tableText: string | undefined,
  maxBlocks: number,
): SlackSectionBlock[] {
  const displayText = truncateText(canonicalSlackReplyText(text, format), slackMarkdownBlockTextLimit);
  const body = format === 'markdown'
    ? fileReplyMrkdwnText(displayText)
    : format === 'plain_text' ? escapeSlackControlCharacters(displayText) : displayText;
  const sections = [body];
  if (tableText) {
    sections.push(escapeSlackControlCharacters(truncateText(
      canonicalSlackReplyText(tableText, 'plain_text'),
      slackMarkdownBlockTextLimit,
    )));
  }
  const content = sections.join('\n\n');
  let plainText = format === 'plain_text';
  let chunks = plainText
    ? splitSlackText(content, slackSectionTextLimit)
    : splitSlackFileSections(content);
  if (chunks.length > maxBlocks) {
    // Protecting many separate code/link spans can exceed Slack's 50-block
    // message limit. Repack the bounded canonical source without losing data
    // or expanding a Unicode URL through percent encoding. The 12,000-character
    // body and table fit after escaping, with one block left for the footer.
    chunks = splitSlackText([
      escapeSlackControlCharacters(displayText), ...sections.slice(1),
    ].join('\n\n'), slackSectionTextLimit);
    plainText = true;
  }
  if (chunks.length > maxBlocks) {
    chunks = chunks.slice(0, maxBlocks);
    const last = chunks.length - 1;
    chunks[last] = truncateText(`${chunks[last]}\n\n[truncated]`, slackSectionTextLimit);
  }
  return chunks.map((text): SlackSectionBlock => ({
      type: 'section',
      text: plainText
        ? { type: 'plain_text', text, emoji: false }
        : { type: 'mrkdwn', text },
    }));
}

function splitSlackFileSections(text: string): string[] {
  const sections: string[] = [];
  let current = '';
  const flush = () => {
    if (current) sections.push(current);
    current = '';
  };
  const append = (token: string) => {
    if (current.length + token.length > slackSectionTextLimit) flush();
    current += token;
  };
  for (const segment of text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`|<https?:\/\/[^>\n]+>)/g)) {
    if (!segment) continue;
    const fence = segment.startsWith('```') ? '```'
      : /^`[^`\n]+`$/.test(segment) ? '`' : '';
    const link = /^<https?:\/\/[^>\n]+>$/.test(segment);
    if (!fence && !link) {
      for (const token of segment.match(/&(?:amp|lt|gt);|[\s\S]/gu) ?? []) append(token);
      continue;
    }
    const closed = fence && segment.length >= fence.length * 2 && segment.endsWith(fence);
    const token = fence && !closed ? `${segment}${fence}` : segment;
    if (token.length <= slackSectionTextLimit) {
      append(token);
      continue;
    }
    // Reopen code in each section. An oversized link is shown in full as a
    // literal instead of splitting its URL into misleading clickable pieces.
    const delimiter = fence || '```';
    const literal = fence
      ? segment.slice(fence.length, closed ? -fence.length : undefined)
      : segment.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    flush();
    for (const chunk of splitSlackText(literal, slackSectionTextLimit - delimiter.length * 2)) {
      append(`${delimiter}${chunk}${delimiter}`);
    }
  }
  flush();
  return sections;
}

/** Keep escaped Slack controls and Unicode code points intact at a boundary. */
function splitSlackText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const token of text.match(/&(?:amp|lt|gt);|[\s\S]/gu) ?? []) {
    if (current.length + token.length > limit) {
      chunks.push(current);
      current = '';
    }
    current += token;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Canonical credential-safe text shared by every terminal Slack delivery path. */
export function canonicalSlackReplyText(text: string, format: SlackReplyFormat): string {
  const normalized = normalizeMessageText(text);
  return format === 'markdown'
    ? canonicalSlackMarkdownText(normalized)
    : redactCredentialLikeContent(normalized);
}

/**
 * Canonical answer formatter shared by progressive and terminal delivery. It
 * never truncates: `splitSlackMarkdownReply` divides a long answer into
 * messages that each fit Slack's markdown limit.
 */
export function canonicalSlackMarkdownText(text: string): string {
  const normalized = normalizeMessageText(text);
  return redactCredentialLikeContent(sanitizeSlackMarkdownLinks(normalized));
}

/** Follow-up messages a long reply may use after its first message. */
export const slackReplyContinuationLimit = 3;

/** Ends the last message of a reply that did not fit in every allowed message. */
export const SLACK_REPLY_SHORTENED_NOTE =
  'This answer was shortened to fit in Slack; ask me for the rest if you need it.';

const SLACK_FENCE_LINE = /^ {0,3}(`{3,})/;

/**
 * Blocks one reply message may render into. Slack turns a `markdown` block
 * into its own blocks (a header per heading, a rich_text per run of text, a
 * block per code fence, table and divider) and refuses a message over 50
 * blocks with `msg_blocks_too_long`. The last message also carries a footer
 * and may carry a native table, so parts keep a margin below the limit.
 */
export const slackMarkdownPartBlockLimit = 40;

/**
 * What each header block costs against Slack's message size, beyond its
 * text. Measured against chat.postMessage with a `markdown` block: a message
 * is accepted while its rendered characters plus about 100 per header block
 * stay under about 13,200 (20 headers left room for 10,563 characters of
 * prose, 40 headers for 7,875). Counting the overhead against the 12,000
 * markdown limit keeps a header-dense part inside that bound with margin.
 * Code fences, tables and dividers were not measured and add nothing.
 */
export const SLACK_HEADER_BLOCK_OVERHEAD_CHARS = 100;

/** How one markdown message is expected to render, conservatively. */
export interface SlackMarkdownRenderedShape {
  /** Upper-bound estimate of the blocks Slack renders the markdown into. */
  blocks: number;
  /** Header blocks among them. */
  headerBlocks: number;
  /**
   * Characters Slack counts: the text with `&`, `<` and `>` escaped as
   * entities, plus `SLACK_HEADER_BLOCK_OVERHEAD_CHARS` per header block.
   */
  countedLength: number;
}

/** Bounds one reply message's rendered shape; the defaults are Slack's. */
export interface SlackMarkdownShapeBudget {
  maxBlocks?: number;
  maxCountedLength?: number;
  /**
   * Characters each header block counts beyond its text. Defaults to
   * `SLACK_HEADER_BLOCK_OVERHEAD_CHARS`; a plan frozen before that bound
   * existed recomputes its first message with 0.
   */
  headerBlockOverhead?: number;
}

const SLACK_HEADING_LINE = /^ {0,3}#{1,6}(?:\s|$)/;
const SLACK_DIVIDER_LINE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SLACK_TABLE_LINE = /^\s*\|/;

/**
 * Offsets of the lines where Slack's markdown rendering starts a new block.
 * Deliberately generous: a fence, table or divider also ends the text run
 * around it, so the count is an upper bound on what Slack produces.
 */
function slackMarkdownBlockStarts(text: string): Array<{ at: number; header: boolean }> {
  const starts: Array<{ at: number; header: boolean }> = [];
  let fence: string | undefined;
  let inRun = false;
  let inTable = false;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const line = text.slice(lineStart, newline < 0 ? text.length : newline);
    const marker = SLACK_FENCE_LINE.exec(line)?.[1];
    if (fence) {
      if (marker && marker.length >= fence.length && !line.trim().slice(marker.length)) {
        fence = undefined;
      }
    } else if (marker) {
      starts.push({ at: lineStart, header: false });
      fence = marker;
      inRun = false;
      inTable = false;
    } else if (SLACK_HEADING_LINE.test(line) || SLACK_DIVIDER_LINE.test(line)) {
      starts.push({ at: lineStart, header: SLACK_HEADING_LINE.test(line) });
      inRun = false;
      inTable = false;
    } else if (SLACK_TABLE_LINE.test(line)) {
      if (!inTable) starts.push({ at: lineStart, header: false });
      inTable = true;
      inRun = false;
    } else if (line.trim()) {
      if (!inRun) starts.push({ at: lineStart, header: false });
      inRun = true;
      inTable = false;
    } else {
      inTable = false;
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  return starts;
}

function slackCountedCharLength(char: string): number {
  return char === '&' ? 5 : char === '<' || char === '>' ? 4 : char.length;
}

/** Characters Slack counts for this text once it escapes `&`, `<` and `>`. */
export function slackEscapedTextLength(text: string): number {
  let countedLength = 0;
  for (const char of text) countedLength += slackCountedCharLength(char);
  return countedLength;
}

/** The conservative rendered shape of one markdown reply message. */
export function slackMarkdownRenderedShape(
  text: string,
  headerBlockOverhead = SLACK_HEADER_BLOCK_OVERHEAD_CHARS,
): SlackMarkdownRenderedShape {
  const starts = slackMarkdownBlockStarts(text);
  const headerBlocks = starts.filter((start) => start.header).length;
  return {
    blocks: starts.length,
    headerBlocks,
    countedLength: slackEscapedTextLength(text) + headerBlocks * headerBlockOverhead,
  };
}

/** Whether one markdown reply message fits Slack's rendered-block limits. */
export function slackMarkdownPartFits(
  text: string,
  budget: SlackMarkdownShapeBudget = {},
): boolean {
  const shape = slackMarkdownRenderedShape(text, budget.headerBlockOverhead);
  return shape.blocks <= (budget.maxBlocks ?? slackMarkdownPartBlockLimit) &&
    shape.countedLength <= (budget.maxCountedLength ?? slackMarkdownBlockTextLimit);
}

/**
 * The longest prefix of `text` whose rendered shape fits the budget: it ends
 * before the line that would open one block too many, and before the
 * character that would take Slack's escaped count over the limit.
 */
export function slackMarkdownShapePrefixLength(
  text: string,
  budget: SlackMarkdownShapeBudget,
): number {
  const maxBlocks = Math.max(1, budget.maxBlocks ?? slackMarkdownPartBlockLimit);
  const maxCounted = budget.maxCountedLength ?? slackMarkdownBlockTextLimit;
  const headerOverhead = budget.headerBlockOverhead ?? SLACK_HEADER_BLOCK_OVERHEAD_CHARS;
  if (maxBlocks === Infinity && maxCounted === Infinity) return text.length;
  const starts = slackMarkdownBlockStarts(text);
  let end = starts.length > maxBlocks ? Math.max(0, starts[maxBlocks]!.at - 1) : text.length;
  let counted = 0;
  let nextStart = 0;
  for (let at = 0; at < end; at += 1) {
    // A heading's block overhead counts from its first character, so a cut
    // never keeps a header whose cost the message cannot pay.
    while (nextStart < starts.length && starts[nextStart]!.at <= at) {
      if (starts[nextStart]!.header) counted += headerOverhead;
      nextStart += 1;
    }
    counted += slackCountedCharLength(text[at]!);
    if (counted > maxCounted) {
      end = at;
      break;
    }
  }
  return end;
}

interface SlackReplyCut {
  /** Characters of the remaining text that belong to this message. */
  end: number;
  /** Characters skipped before the next message (a newline or space). */
  skip: number;
  /** Opening fence line when the cut falls inside a code block. */
  fence?: { opener: string; closer: string };
}

/** How `splitSlackMarkdownReply` divides an answer into messages. */
export interface SlackReplySplitOptions extends SlackMarkdownShapeBudget {
  /** Keep an already streamed prefix inside the first message. */
  minFirstPartLength?: number;
  /** Reserve room in the first message for a marker the caller appends. */
  firstPartLimit?: number;
  maxParts?: number;
  /** Characters of every message; smaller when Slack refused a larger part. */
  partLimit?: number;
  /**
   * Split by raw characters alone, as builds before the rendered-shape bound
   * did. Only a plan frozen by such a build uses it, so the first message it
   * recomputes still ends exactly where that plan's follow-ups begin.
   */
  rawLengthOnly?: boolean;
}

/**
 * Split a canonical markdown answer into at most 1 + `slackReplyContinuationLimit`
 * messages of `slackMarkdownBlockTextLimit` characters. Each message is also
 * sized by what Slack renders it into: at most `slackMarkdownPartBlockLimit`
 * blocks and at most the markdown limit once `&`, `<` and `>` are escaped.
 * Cuts prefer a heading, then a paragraph or code-fence boundary, then a line,
 * and never fall inside a link or inline code span. A cut inside a fenced block
 * closes that fence and reopens it with the same info string in the next
 * message. Text beyond the last allowed message is dropped and that message
 * ends with the shortened note.
 *
 * `minFirstPartLength` keeps an already streamed prefix inside the first
 * message, even past the rendered-shape bound, because Slack already shows it.
 */
export function splitSlackMarkdownReply(
  text: string,
  options: SlackReplySplitOptions = {},
): string[] {
  const maxParts = Math.max(1, options.maxParts ?? 1 + slackReplyContinuationLimit);
  const raw = options.rawLengthOnly === true;
  const maxBlocks = raw ? Infinity : Math.max(2, options.maxBlocks ?? slackMarkdownPartBlockLimit);
  const partLimit = Math.min(
    Math.max(1, options.partLimit ?? slackMarkdownBlockTextLimit),
    slackMarkdownBlockTextLimit,
  );
  const maxCounted = raw ? Infinity : options.maxCountedLength ?? partLimit;
  const parts: string[] = [];
  let rest = text;
  while (rest) {
    const index = parts.length;
    const charLimit = index === 0
      ? Math.min(options.firstPartLimit ?? partLimit, partLimit)
      : partLimit;
    const min = index === 0 ? Math.min(options.minFirstPartLength ?? 0, charLimit) : 0;
    const budget = {
      maxCountedLength: maxCounted,
      ...(options.headerBlockOverhead !== undefined
        ? { headerBlockOverhead: options.headerBlockOverhead }
        : {}),
    };
    // A first-message bound (an update's, or room for a marker) is a bound
    // on what Slack counts too: its escaped text. The header overhead was
    // measured against the markdown message limit, not these bounds.
    const firstBudget = index === 0 && options.firstPartLimit !== undefined && !raw
      ? { maxCountedLength: options.firstPartLimit, headerBlockOverhead: 0 }
      : undefined;
    const shaped = (blocks: number) => Math.max(
      Math.min(
        charLimit,
        slackMarkdownShapePrefixLength(rest, { ...budget, maxBlocks: blocks }),
        firstBudget
          ? slackMarkdownShapePrefixLength(rest, { ...firstBudget, maxBlocks: blocks })
          : Infinity,
      ),
      min,
      1,
    );
    let limit = shaped(maxBlocks);
    if (rest.length <= limit) {
      parts.push(rest);
      break;
    }
    const last = index === maxParts - 1;
    // The note is one more paragraph, so the last message leaves it a block.
    if (last) limit = Math.max(1, shaped(maxBlocks - 1) - SLACK_REPLY_SHORTENED_NOTE.length - 2);
    const cut = chooseSlackReplyCut(rest, limit, Math.min(min, limit));
    let head = rest.slice(0, cut.end);
    let tail = rest.slice(cut.end + cut.skip);
    if (cut.fence) {
      head = `${head}\n${cut.fence.closer}`;
      tail = `${cut.fence.opener}\n${tail}`;
    } else {
      head = head.trimEnd();
      tail = tail.replace(/^\s*\n/, '');
    }
    if (last) {
      parts.push(`${head}\n\n${SLACK_REPLY_SHORTENED_NOTE}`);
      break;
    }
    parts.push(head);
    rest = tail;
  }
  return parts.length > 0 ? parts : [text];
}

function chooseSlackReplyCut(text: string, limit: number, min: number): SlackReplyCut {
  type Tier = 'heading' | 'paragraph' | 'line' | 'fence' | 'table';
  const boundaries: Array<{ at: number; tier: Tier; fence?: SlackReplyCut['fence'] }> = [];
  const fences: Array<{ from: number; to: number; opener: string; closer: string }> = [];
  let open: { from: number; opener: string; closer: string } | undefined;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    const marker = SLACK_FENCE_LINE.exec(line)?.[1];
    let closedHere = false;
    if (open) {
      if (marker && marker.length >= open.closer.length && !line.trim().slice(marker.length)) {
        fences.push({ from: open.from, to: lineStart, opener: open.opener, closer: open.closer });
        open = undefined;
        closedHere = true;
      }
    } else if (marker) {
      open = { from: lineEnd + 1, opener: line.trim(), closer: marker };
    }
    if (newline < 0) break;
    const nextEnd = text.indexOf('\n', newline + 1);
    const next = text.slice(newline + 1, nextEnd < 0 ? text.length : nextEnd);
    if (open) {
      // Inside a code block: any line may end a message except right before
      // the closing fence, which would leave an empty reopened block.
      const nextMarker = SLACK_FENCE_LINE.exec(next)?.[1];
      if (!(nextMarker && nextMarker.length >= open.closer.length) && newline >= open.from) {
        boundaries.push({
          at: newline,
          tier: 'fence',
          fence: { opener: open.opener, closer: open.closer },
        });
      }
    } else if (/^#{1,6}\s/.test(next)) {
      boundaries.push({ at: newline, tier: 'heading' });
    } else if (!line.trim() || !next.trim() || closedHere || SLACK_FENCE_LINE.test(next)) {
      boundaries.push({ at: newline, tier: 'paragraph' });
    } else if (/^\s*\|/.test(line) && /^\s*\|/.test(next)) {
      boundaries.push({ at: newline, tier: 'table' });
    } else {
      boundaries.push({ at: newline, tier: 'line' });
    }
    lineStart = newline + 1;
  }
  if (open) fences.push({ from: open.from, to: text.length, opener: open.opener, closer: open.closer });

  const fits = (at: number, fence?: SlackReplyCut['fence']) =>
    at >= Math.max(1, min) && at + (fence ? fence.closer.length + 1 : 0) <= limit;
  const pick = (tiers: readonly Tier[], from: number): SlackReplyCut | undefined => {
    for (let i = boundaries.length - 1; i >= 0; i -= 1) {
      const boundary = boundaries[i]!;
      if (boundary.at < from || !tiers.includes(boundary.tier) ||
          !fits(boundary.at, boundary.fence)) continue;
      return { end: boundary.at, skip: 1, ...(boundary.fence ? { fence: boundary.fence } : {}) };
    }
    return undefined;
  };
  const half = Math.max(min, Math.floor(limit / 2));
  const lineCut = pick(['heading'], Math.max(min, Math.floor(limit * 0.75))) ??
    pick(['heading', 'paragraph'], half) ??
    pick(['line'], half) ??
    pick(['fence', 'table'], half) ??
    pick(['heading', 'paragraph', 'line', 'fence', 'table'], min);
  if (lineCut) return lineCut;

  // One line longer than the window: cut at a space, else between characters,
  // outside links, inline code, bare URLs, and surrogate pairs.
  const fenceAt = (at: number) => fences.find((fence) => at > fence.from && at < fence.to);
  const protectedSpans = [...text.matchAll(
    /\[[^\]\n]*\]\([^)\n]*\)|<[^>\n]*>|`[^`\n]+`|https?:\/\/[^\s<>()[\]]+/g,
  )].map((match) => ({ from: match.index, to: match.index + match[0].length }));
  const safe = (at: number) => {
    const code = text.charCodeAt(at - 1);
    if (code >= 0xd800 && code <= 0xdbff) return false;
    if (fenceAt(at)) return true;
    return !protectedSpans.some((span) => at > span.from && at < span.to);
  };
  let hard: number | undefined;
  for (let at = limit; at >= Math.max(1, min); at -= 1) {
    const fence = fenceAt(at);
    const closer = fence ? { opener: fence.opener, closer: fence.closer } : undefined;
    if (!fits(at, closer) || !safe(at)) continue;
    if (text[at] === ' ') return { end: at, skip: 1, ...(closer ? { fence: closer } : {}) };
    hard ??= at;
    if (at < half) break;
  }
  const at = hard ?? Math.max(1, min);
  const fence = fenceAt(at);
  return { end: at, skip: 0, ...(fence ? { fence: { opener: fence.opener, closer: fence.closer } } : {}) };
}

/**
 * Return the cumulative prefix that is safe to expose before generation ends.
 * Potential links, emphasized URLs, and credential-shaped tokens remain in the
 * in-memory tail until their closing delimiter arrives. The returned value is
 * therefore monotone and a prefix of `canonicalSlackMarkdownText(final)`.
 */
export function streamableSlackMarkdownPrefix(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/^\s+/, '');
  if (!normalized) return '';
  const unsafeFrom = earliestUnsafeTail(normalized);
  const stable = normalized.slice(0, unsafeFrom).trimEnd();
  if (!stable) return '';
  return canonicalSlackMarkdownText(stable);
}

// Slack's markdown renderer can treat the closing `*` in a strong span as part
// of an auto-linked URL (`**https://example.test/4**` -> URL ending in `*`).
// Drop only the unsafe outer emphasis while preserving ordinary bold text and
// literal examples inside inline/fenced code.
export function sanitizeSlackMarkdownLinks(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      return segment.replace(/\*\*([^*\n]*https?:\/\/[^*\n]+)\*\*/g, '$1');
    })
    .join('');
}

function earliestUnsafeTail(value: string): number {
  let unsafeFrom = value.length;
  const lower = value.toLowerCase();

  // Hold a full credential marker and its non-whitespace tail until a token
  // boundary proves that terminal redaction can no longer rewrite it.
  for (const marker of credentialMarkers()) {
    const markerLower = marker.toLowerCase();
    const full = lower.lastIndexOf(markerLower);
    if (full >= 0 && !value.slice(full).includes('\n')) {
      unsafeFrom = Math.min(unsafeFrom, full);
    }
    const maximumPrefix = Math.min(markerLower.length - 1, value.length);
    for (let length = maximumPrefix; length > 0; length -= 1) {
      if (lower.endsWith(markerLower.slice(0, length))) {
        unsafeFrom = Math.min(unsafeFrom, value.length - length);
        break;
      }
    }
  }

  // A link or Slack `<...>` reference still being written sits on the last
  // line. Once a line ends, a `[` or `<` on it was literal text (a CDATA
  // example, a shell redirect): holding it would freeze the stream until
  // some later `)` or `>` happened to appear.
  const lastLineStart = value.lastIndexOf('\n') + 1;
  const openLink = value.lastIndexOf('[');
  const lastClosedLink = value.lastIndexOf(')');
  if (openLink >= lastLineStart && openLink > lastClosedLink) {
    unsafeFrom = Math.min(unsafeFrom, openLink);
  }
  const openAngle = value.lastIndexOf('<');
  if (openAngle >= lastLineStart && openAngle > value.lastIndexOf('>')) {
    unsafeFrom = Math.min(unsafeFrom, openAngle);
  }
  // Emphasis around a URL is rewritten per line; an unpaired `**` on an
  // earlier line (`**kwargs`, `2**10`) is literal and must not hold the rest.
  const emphasis = value.lastIndexOf('**');
  if (emphasis >= lastLineStart && countToken(value.slice(lastLineStart), '**') % 2 === 1) {
    unsafeFrom = Math.min(unsafeFrom, emphasis);
  }
  const trailingTicks = value.match(/`{1,2}$/)?.[0];
  if (trailingTicks) unsafeFrom = Math.min(unsafeFrom, value.length - trailingTicks.length);
  if (value.endsWith('*') && !value.endsWith('**')) {
    unsafeFrom = Math.min(unsafeFrom, value.length - 1);
  }
  // A Markdown table row can look complete several tokens before the model
  // adds its newline. Hold the whole trailing row so Slack never flashes a
  // partially populated table during progressive delivery.
  const trailingLineStart = value.lastIndexOf('\n') + 1;
  if (/^\s*\|/.test(value.slice(trailingLineStart)) && !value.endsWith('\n')) {
    unsafeFrom = Math.min(unsafeFrom, trailingLineStart);
  }
  return unsafeFrom;
}

function countToken(value: string, token: string): number {
  let count = 0;
  for (let at = 0; (at = value.indexOf(token, at)) >= 0; at += token.length) count += 1;
  return count;
}

export function appendSlackReplyFooter(
  rendered: RenderedSlackMessage,
  footer: SlackReplyFooter,
): RenderedSlackMessage {
  const contentBlocks =
    rendered.blocks && rendered.blocks.length > 0 ? rendered.blocks : [contentBlockFor(rendered)];

  return {
    text: rendered.text,
    blocks: [...contentBlocks, renderSlackReplyFooterBlock(footer)],
  };
}

// Wrap a block-less rendered message so the footer can be attached. A plain_text
// final (mrkdwn:false) must stay literal — a markdown block would parse it, so
// it becomes a plain_text section block; markdown/mrkdwn content keeps parsing.
function contentBlockFor(rendered: RenderedSlackMessage): SlackMessageBlock {
  const text = truncateText(rendered.text, slackMarkdownBlockTextLimit);
  if (rendered.mrkdwn === false) {
    return { type: 'section', text: { type: 'plain_text', text, emoji: false } };
  }
  return { type: 'markdown', text };
}

/**
 * The footer's model label. A turn in which a coding worker ran names the
 * model that did the code work too, as attribution: "<agent> · coding: <coding>".
 * It stays the Agent's model alone when no worker ran or both models match.
 */
export function replyFooterModelLabel(input: {
  agentModel: string | undefined;
  codingModel?: string;
  codingWorkerRan: boolean;
}): string | undefined {
  const { agentModel, codingModel } = input;
  if (!agentModel || !input.codingWorkerRan || !codingModel || codingModel === agentModel) {
    return agentModel;
  }
  return `${agentModel} · coding: ${codingModel}`;
}

export function renderSlackReplyFooterBlock(footer: SlackReplyFooter): SlackContextBlock {
  const segments = [escapeSlackControlCharacters(footer.agentName)];
  if (footer.modelLabel) {
    segments.push(escapeSlackControlCharacters(footer.modelLabel));
  }
  if (footer.includeConfigureLink !== false) {
    segments.push(renderSlackConfigureLink(footer.publicUrl, { agentId: footer.agentId }));
  }
  if (footer.scheduled) segments.push('Scheduled');
  for (const item of footer.memoryItems ?? []) {
    segments.push(escapeSlackControlCharacters(item));
  }
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: segments.join(' | ') }],
  };
}

// The one place that turns a public URL into the Slack-visible "Configure" link
// (an mrkdwn <url|label>, or plain "Configure" when no URL is configured). Both
// the reply footer and the channel onboarding message render through this so the
// link syntax and copy never drift between them.
function renderSlackConfigureLink(
  publicUrl: string | undefined,
  params: SlackAdminUrlParams = {},
): string {
  const adminUrl = buildSlackAdminUrl(publicUrl, params);
  return adminUrl ? renderSlackActionLink(adminUrl, 'Configure') : 'Configure';
}

/** Render a product-owned action URL without exposing it as the link text. */
export function renderSlackActionLink(link: SlackActionLink): string;
export function renderSlackActionLink(url: string, label: string): string;
export function renderSlackActionLink(
  urlOrLink: string | SlackActionLink,
  label?: string,
): string {
  const link = typeof urlOrLink === 'string'
    ? slackActionLink(urlOrLink, label ?? 'Open link')
    : urlOrLink;
  const safeLabel = escapeSlackControlCharacters(link.label)
    .replace(/[\r\n\u0000-\u001f\u007f|]+/g, ' ')
    .replace(/[*_~`]/g, '')
    .slice(0, 80)
    .trim() || 'Open link';
  const trimmed = link.url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return safeLabel;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username || parsed.password) {
    return safeLabel;
  }
  const safeUrl = escapeSlackControlCharacters(parsed.toString()).replace(/\|/g, '%7C');
  return `<${safeUrl}|${safeLabel}>`;
}

/** Render the same action-link data for Slack's standard Markdown block. */
export function renderSlackMarkdownActionLink(link: SlackActionLink): string {
  const safeLabel = link.label
    .replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ')
    .replace(/([\\\[\]])/g, '\\$1')
    .slice(0, 80)
    .trim() || 'Open link';
  let parsed: URL;
  try {
    parsed = new URL(link.url.trim());
  } catch {
    return safeLabel;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username || parsed.password) {
    return safeLabel;
  }
  const safeUrl = parsed.toString().replace(/\(/g, '%28').replace(/\)/g, '%29');
  return `[${safeLabel}](${safeUrl})`;
}

// The channel onboarding disclosure posted when the bot itself joins a channel.
// Rendered here (the presentation layer) so all Slack-visible chrome — footer,
// configure link, onboarding — lives in one place and stays unit-testable.
export function renderChannelOnboarding(params: {
  botUserId: string;
  channelId: string;
  publicUrl: string | undefined;
}): string {
  const configure = renderSlackConfigureLink(params.publicUrl, { channelId: params.channelId });
  return [
    'Chickpea is ready in this Channel.',
    `Mention an Agent handle or <@${params.botUserId}> to start a thread; Chickpea never joins unmentioned Channel conversations.`,
    'Once an Agent owns a thread, Channel members can continue without repeating the mention.',
    `${configure} the Agents available in this Channel.`,
  ].join(' ');
}

// The ephemeral nudge for an explicit mention in a channel that has no enabled
// assignment. Fail-closed stays intact — the channel itself gets nothing — but
// the person who mentioned the bot learns why it stayed silent, visible only
// to them.
export function renderUnassignedChannelHint(params: {
  botUserId: string;
  channelId: string;
  publicUrl: string | undefined;
}): string {
  const configure = renderSlackConfigureLink(params.publicUrl, { channelId: params.channelId });
  return [
    `No Agent is available in this Channel yet, so <@${params.botUserId}> cannot reply here.`,
    `${configure} the Agents available in this Channel.`,
  ].join(' ');
}

export function buildSlackAdminUrl(
  publicUrl: string | undefined,
  params: SlackAdminUrlParams = {},
): string | undefined {
  const trimmed = publicUrl?.trim();
  if (!trimmed) {
    return undefined;
  }

  let url: URL;
  try {
    // '/admin' is root-absolute, so it replaces any path on the base — the
    // base's own path and trailing slash are irrelevant.
    url = new URL('/admin', trimmed);
  } catch {
    return undefined;
  }

  // Only http(s) may become a clickable Configure link. A misconfigured
  // publicUrl with another scheme (ftp:, javascript:) or embedded userinfo
  // (https://evil@real-host) falls back to the plain "Configure" label rather
  // than presenting a misleading link under a trusted affordance.
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    return undefined;
  }

  if (params.agentId) {
    url.pathname = `/admin/agents/${encodeURIComponent(params.agentId)}`;
  }
  if (params.channelId) {
    url.searchParams.set('channel', params.channelId);
  }
  return url.toString();
}

export function markdownFallbackText(markdown: string): string {
  const fallback = readableMarkdownText(markdown).trim();
  return truncateText(escapeSlackControlCharacters(fallback || '(empty reply)'), slackFallbackTextLimit);
}

function readableMarkdownText(markdown: string): string {
  const withoutCodeFences = linearizeMarkdownTables(
    markdown.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1'),
  );
  return withoutCodeFences
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/^\s{0,3}[-*+]\s+/gm, '- ')
    .replace(/[ \t]+\n/g, '\n');
}

function fileReplyMrkdwnText(markdown: string): string {
  // Native Slack mrkdwn understands code fences and inline backticks. Protect
  // those literals before converting prose so filenames, expressions, and
  // example links retain their exact characters. An unfinished fence can be
  // the result of the canonical answer limit and still needs literal handling.
  return markdown.split(/(```[\s\S]*?(?:```|$))/g).map((segment, index) => index % 2 === 1
    ? escapeSlackControlCharacters(segment)
    : fileReplyProseText(segment)
  ).join('').trim() || '(empty reply)';
}

function fileReplyProseText(markdown: string): string {
  const content = linearizeMarkdownTables(markdown)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '- ');
  // Convert complete Markdown links and unambiguous inline style pairs. Escape
  // all other text, including malformed links and Slack control syntax, before
  // adding the trusted footer.
  // Keep the entire canonical answer; the 4,000-character fallback is only a
  // notification preview, not the body of the file-share message.
  return renderSlackInlineMarkdown(content);
}

const markdownToMrkdwnDelimiters = [
  { markdown: '~~', mrkdwn: '~' },
  { markdown: '**', mrkdwn: '*' },
  { markdown: '__', mrkdwn: '*' },
] as const;

function renderSlackInlineMarkdown(source: string): string {
  const pieces: string[] = [];
  const open: Array<{ delimiter: string; piece: number }> = [];
  let at = 0;
  while (at < source.length) {
    if (source[at] === '\n') {
      // Inline styles do not span lines. Leave any unmatched opening markers
      // as written and start the next line with a fresh delimiter stack.
      open.length = 0;
      pieces.push('\n');
      at += 1;
      continue;
    }

    const code = inlineCodeSpanAt(source, at);
    if (code) {
      pieces.push(escapeSlackControlCharacters(source.slice(at, code.next)));
      at = code.next;
      continue;
    }

    const link = source.slice(at).match(/^(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/);
    if (link) {
      pieces.push(link[1]
        ? escapeSlackControlCharacters(link[2]!)
        : renderSlackActionLink(link[3]!, link[2]!));
      at += link[0].length;
      continue;
    }

    let handledDelimiter = false;
    for (const delimiter of markdownToMrkdwnDelimiters) {
      if (!source.startsWith(delimiter.markdown, at)) continue;
      const opening = open.findLastIndex((candidate) =>
        candidate.delimiter === delimiter.markdown);
      if (opening >= 0 && canCloseMarkdownDelimiter(source, at, delimiter.markdown)) {
        pieces[open[opening]!.piece] = delimiter.mrkdwn;
        pieces.push(delimiter.mrkdwn);
        open.splice(opening);
        at += delimiter.markdown.length;
        handledDelimiter = true;
      } else if (canOpenMarkdownDelimiter(source, at, delimiter.markdown)) {
        open.push({
          delimiter: delimiter.markdown,
          piece: pieces.push(delimiter.markdown) - 1,
        });
        at += delimiter.markdown.length;
        handledDelimiter = true;
      }
      break;
    }
    if (handledDelimiter) continue;

    pieces.push(escapeSlackControlCharacters(source[at]!));
    at += 1;
  }
  return pieces.join('');
}

function inlineCodeSpanAt(source: string, start: number): { next: number } | undefined {
  if (source[start] !== '`') return undefined;
  let runLength = 1;
  while (source[start + runLength] === '`') runLength += 1;
  const delimiter = '`'.repeat(runLength);
  let close = source.indexOf(delimiter, start + runLength);
  while (close >= 0 && (source[close - 1] === '`' || source[close + runLength] === '`')) {
    close = source.indexOf(delimiter, close + runLength);
  }
  if (close < 0 || source.slice(start + runLength, close).includes('\n')) return undefined;
  return { next: close + runLength };
}

function canOpenMarkdownDelimiter(source: string, start: number, delimiter: string): boolean {
  const before = source[start - 1];
  const after = source[start + delimiter.length];
  if (!after || /\s/u.test(after) || isEscapedMarkdownDelimiter(source, start)) return false;
  if (delimiter === '~~' && (before === '~' || after === '~')) return false;
  return delimiter === '~~' || !before || !/[\p{L}\p{N}_]/u.test(before);
}

function canCloseMarkdownDelimiter(source: string, start: number, delimiter: string): boolean {
  const before = source[start - 1];
  const after = source[start + delimiter.length];
  if (!before || /\s/u.test(before) || isEscapedMarkdownDelimiter(source, start)) return false;
  if (delimiter === '~~' && (before === '~' || after === '~')) return false;
  return delimiter === '~~' || !after || !/[\p{L}\p{N}_]/u.test(after);
}

function isEscapedMarkdownDelimiter(source: string, start: number): boolean {
  let backslashes = 0;
  for (let at = start - 1; at >= 0 && source[at] === '\\'; at -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function linearizeMarkdownTables(markdown: string): string {
  return markdown
    .split('\n')
    .flatMap((line) => {
      if (/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*\|?)\s*$/.test(line)) {
        return [];
      }
      if (!/^\s*\|.*\|\s*$/.test(line)) return [line];
      const cells = line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim().replace(/\\\|/g, '|'));
      return [cells.join(' — ')];
    })
    .join('\n');
}

function normalizeMessageText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim() || '(empty reply)';
}

export function escapeSlackControlCharacters(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  const suffix = '\n\n[truncated]';
  return `${text.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}
