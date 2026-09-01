import { credentialMarkers, redactCredentialLikeContent } from '../security/content-validation.ts';
import type { SlackNativeTableBlock } from './table-presentation.ts';

export const slackMarkdownBlockTextLimit = 12_000;
const slackFallbackTextLimit = 4_000;

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
  text: SlackPlainTextObject;
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
  /** Private scheduled-work replies keep Agent/model attribution without an Admin link. */
  includeConfigureLink?: boolean | undefined;
  memoryItems?: readonly string[] | undefined;
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

/** Canonical credential-safe text shared by every terminal Slack delivery path. */
export function canonicalSlackReplyText(text: string, format: SlackReplyFormat): string {
  const normalized = normalizeMessageText(text);
  return format === 'markdown'
    ? canonicalSlackMarkdownText(normalized)
    : redactCredentialLikeContent(normalized);
}

/** Canonical answer formatter shared by progressive and terminal delivery. */
export function canonicalSlackMarkdownText(text: string): string {
  const normalized = normalizeMessageText(text);
  return truncateText(
    redactCredentialLikeContent(sanitizeSlackMarkdownLinks(normalized)),
    slackMarkdownBlockTextLimit,
  );
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

  const openLink = value.lastIndexOf('[');
  const lastClosedLink = value.lastIndexOf(')');
  if (openLink > lastClosedLink) {
    unsafeFrom = Math.min(unsafeFrom, openLink);
  }
  const openAngle = value.lastIndexOf('<');
  if (openAngle > value.lastIndexOf('>')) {
    unsafeFrom = Math.min(unsafeFrom, openAngle);
  }
  const emphasis = value.lastIndexOf('**');
  if (emphasis >= 0 && countToken(value, '**') % 2 === 1) {
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

export function renderSlackReplyFooterBlock(footer: SlackReplyFooter): SlackContextBlock {
  const segments = [escapeSlackControlCharacters(footer.agentName)];
  if (footer.modelLabel) {
    segments.push(escapeSlackControlCharacters(footer.modelLabel));
  }
  if (footer.includeConfigureLink !== false) {
    segments.push(renderSlackConfigureLink(footer.publicUrl, { agentId: footer.agentId }));
  }
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
    url.searchParams.set('agent', params.agentId);
  }
  if (params.channelId) {
    url.searchParams.set('channel', params.channelId);
  }
  return url.toString();
}

export function markdownFallbackText(markdown: string): string {
  const withoutCodeFences = linearizeMarkdownTables(
    markdown.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1'),
  );
  const fallback = withoutCodeFences
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
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  return truncateText(escapeSlackControlCharacters(fallback || '(empty reply)'), slackFallbackTextLimit);
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
