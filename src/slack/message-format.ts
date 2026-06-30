export const slackMarkdownBlockTextLimit = 12_000;
export const slackFallbackTextLimit = 4_000;

export type SlackReplyFormat = 'plain_text' | 'mrkdwn' | 'markdown';

export interface SlackMarkdownBlock {
  type: 'markdown';
  text: string;
}

export type SlackMessageBlock = SlackMarkdownBlock;

export interface RenderedSlackMessage {
  text: string;
  blocks?: SlackMessageBlock[];
  mrkdwn?: boolean;
}

export function renderSlackMessage(text: string, format: SlackReplyFormat): RenderedSlackMessage {
  const normalized = normalizeMessageText(text);

  if (format === 'markdown') {
    return {
      text: markdownFallbackText(normalized),
      blocks: [
        {
          type: 'markdown',
          text: truncateText(normalized, slackMarkdownBlockTextLimit),
        },
      ],
    };
  }

  if (format === 'plain_text') {
    return {
      text: truncateText(escapeSlackControlCharacters(normalized), slackFallbackTextLimit),
      mrkdwn: false,
    };
  }

  return {
    text: truncateText(normalized, slackFallbackTextLimit),
  };
}

export function markdownFallbackText(markdown: string): string {
  const withoutCodeFences = markdown.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1');
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

function normalizeMessageText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim() || '(empty reply)';
}

function escapeSlackControlCharacters(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  const suffix = '\n\n[truncated]';
  return `${text.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}
