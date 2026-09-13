const MAX_RICH_TEXT_NODES = 256;
const MAX_RICH_TEXT_LINKS = 8;
const MAX_RICH_TEXT_URL_LENGTH = 2_048;

/**
 * Slack's fallback `text` can contain only the display label for a native rich
 * text link. Preserve the authenticated URL alongside that fallback so the
 * runtime sees the same destination the human saw in Slack.
 */
export function preserveSlackRichTextLinks(
  text: string | undefined,
  blocks: unknown,
): string {
  const base = text?.trim() ?? '';
  const links = richTextUrls(blocks).filter((url) => !base.includes(url));
  if (links.length === 0) return base;
  const suffix = `Links in this Slack message:\n${links.map((url) => `- ${url}`).join('\n')}`;
  return base ? `${base}\n\n${suffix}` : suffix;
}

function richTextUrls(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) return [];
  const urls: string[] = [];
  const seen = new Set<string>();
  let visited = 0;

  const visit = (value: unknown): void => {
    if (visited >= MAX_RICH_TEXT_NODES || urls.length >= MAX_RICH_TEXT_LINKS) return;
    visited += 1;
    if (!isRecord(value)) return;

    if (typeof value.url === 'string') {
      const url = validHttpUrl(value.url);
      if (url && !seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
    if (Array.isArray(value.elements)) {
      for (const element of value.elements) visit(element);
    }
  };

  for (const block of blocks) {
    if (!isRecord(block) || block.type !== 'rich_text') continue;
    visit(block);
  }
  return urls;
}

function validHttpUrl(value: string): string | undefined {
  if (
    value.length === 0 ||
    value.length > MAX_RICH_TEXT_URL_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.username ||
      parsed.password
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
