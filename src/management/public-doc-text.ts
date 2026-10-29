/** What a reader keeps of one HTML page. */
export interface HtmlDocText {
  title?: string;
  /** Headings, paragraphs, lists, code and tables as Markdown-like text. */
  text: string;
  /** Every link target in document order, entity-decoded and unresolved. */
  hrefs: string[];
  /** Text past the scan limit was dropped. */
  overflowed: boolean;
}

/** Elements whose content is never page text; the scan jumps to their end tag. */
const RAW_TEXT = new Set([
  'script', 'style', 'noscript', 'template', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes',
  'svg', 'math', 'object', 'canvas', 'select',
]);
/** Site chrome whose text is dropped, though its links are kept: a docs sidebar is how a reader finds the next page. */
const CHROME = new Set(['nav', 'footer', 'aside']);
const HEADINGS = new Map([['h1', '# '], ['h2', '## '], ['h3', '### '], ['h4', '#### '], ['h5', '##### '], ['h6', '###### ']]);
const PARAGRAPHS = new Set([
  'p', 'table', 'ul', 'ol', 'dl', 'blockquote', 'section', 'article', 'main', 'header', 'figure', 'details',
  'hr', 'form', 'fieldset',
]);
const LINES = new Set([
  'div', 'li', 'dt', 'dd', 'tr', 'br', 'summary', 'figcaption', 'caption', 'address', 'label', 'legend',
  'thead', 'tbody', 'tfoot',
]);
const MAX_HREFS = 2_000;

const NAMED_ENTITIES = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', '\''], ['nbsp', ' '],
  ['ndash', '–'], ['mdash', '—'], ['hellip', '…'], ['lsquo', '‘'], ['rsquo', '’'],
  ['ldquo', '“'], ['rdquo', '”'], ['bull', '•'], ['middot', '·'], ['rarr', '→'],
  ['larr', '←'], ['copy', '©'], ['reg', '®'], ['trade', '™'], ['times', '×'],
]);
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g;
const HREF = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/i;

/**
 * Readable text, the title and the link targets of one HTML page, in one
 * pass over the markup that never backtracks, so a hostile page costs time
 * linear in its size. Text past `maxChars` is dropped; links are still read.
 */
export function htmlDocText(html: string, maxChars: number): HtmlDocText {
  const parts: string[] = [];
  const hrefs: string[] = [];
  let length = 0;
  let overflowed = false;
  let title: string | undefined;
  let pendingBreak = 0;
  let pendingSpace = false;
  let afterSpace = true;
  let trailingNewlines = 0;
  let preDepth = 0;
  let preStart = false;
  let chrome: { name: string; depth: number } | undefined;

  const append = (value: string) => {
    if (!value) return;
    if (length >= maxChars) {
      overflowed = true;
      return;
    }
    const separator = pendingBreak > 0 && length > 0 ? '\n'.repeat(Math.max(0, pendingBreak - trailingNewlines))
      : pendingSpace && !afterSpace ? ' ' : '';
    pendingBreak = 0;
    pendingSpace = false;
    const appended = separator + value;
    parts.push(appended);
    length += appended.length;
    afterSpace = /\s$/.test(value);
    let newlines = 0;
    while (newlines < appended.length && appended[appended.length - 1 - newlines] === '\n') newlines += 1;
    trailingNewlines = newlines === appended.length ? trailingNewlines + newlines : newlines;
  };
  const mark = (value: string) => {
    if (!chrome) append(value);
  };
  const lineBreak = (lines: 1 | 2) => {
    if (chrome) return;
    pendingBreak = Math.max(pendingBreak, lines);
    pendingSpace = false;
  };
  const text = (raw: string) => {
    if (chrome) return;
    const value = decodeEntities(raw);
    if (preDepth > 0) {
      append(preStart ? value.replace(/^\r?\n/, '') : value);
      preStart = false;
      return;
    }
    const collapsed = value.replace(/\s+/g, ' ');
    if (collapsed.startsWith(' ')) pendingSpace = true;
    append(collapsed.trim());
    if (collapsed.endsWith(' ')) pendingSpace = true;
  };
  const open = (name: string, selfClosing: boolean) => {
    if (chrome) {
      if (name === chrome.name && !selfClosing) chrome.depth += 1;
      return;
    }
    if (CHROME.has(name)) {
      if (!selfClosing) chrome = { name, depth: 1 };
      return;
    }
    const heading = HEADINGS.get(name);
    if (heading) {
      lineBreak(2);
      mark(heading);
      return;
    }
    switch (name) {
      case 'pre':
        lineBreak(2);
        mark('```');
        lineBreak(1);
        preDepth += 1;
        preStart = true;
        return;
      case 'code':
        if (preDepth === 0) mark('`');
        return;
      case 'li':
        lineBreak(1);
        mark('- ');
        return;
      case 'td':
      case 'th':
        mark('| ');
        return;
    }
    if (PARAGRAPHS.has(name)) lineBreak(2);
    else if (LINES.has(name)) lineBreak(1);
  };
  const close = (name: string) => {
    if (chrome) {
      if (name === chrome.name && --chrome.depth === 0) chrome = undefined;
      return;
    }
    if (HEADINGS.has(name)) {
      lineBreak(2);
      return;
    }
    switch (name) {
      case 'pre':
        if (preDepth === 0) return;
        preDepth -= 1;
        lineBreak(1);
        mark('```');
        lineBreak(2);
        return;
      case 'code':
        if (preDepth === 0) mark('`');
        return;
      case 'td':
      case 'th':
        pendingSpace = true;
        return;
      case 'tr':
        mark('|');
        lineBreak(1);
        return;
    }
    if (PARAGRAPHS.has(name)) lineBreak(2);
    else if (LINES.has(name)) lineBreak(1);
  };
  /** Handles the markup at `at`, which holds `<`, and returns where text resumes. */
  const tag = (at: number): number => {
    if (html.startsWith('<!--', at)) return after(html.indexOf('-->', at + 4), 3);
    const next = html[at + 1];
    if (next === '!' || next === '?') return after(html.indexOf('>', at + 2), 1);
    const closing = next === '/';
    const nameStart = at + (closing ? 2 : 1);
    if (!isLetter(html.charCodeAt(nameStart))) {
      text('<');
      return at + 1;
    }
    let nameEnd = nameStart + 1;
    while (isNameChar(html.charCodeAt(nameEnd))) nameEnd += 1;
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    const end = tagEnd(html, nameEnd);
    if (closing) {
      close(name);
      return after(end, 1);
    }
    const selfClosing = html[end - 1] === '/';
    if (name === 'a' && hrefs.length < MAX_HREFS) {
      const href = hrefOf(html.slice(at, end));
      if (href) hrefs.push(href);
    }
    if (!RAW_TEXT.has(name)) {
      open(name, selfClosing);
      return after(end, 1);
    }
    if (selfClosing || end >= html.length) return after(end, 1);
    const contentEnd = rawTextEnd(html, end + 1, name);
    if (name === 'title' && title === undefined) {
      title = decodeEntities(html.slice(end + 1, contentEnd)).replace(/\s+/g, ' ').trim() || undefined;
    }
    return after(html.indexOf('>', contentEnd), 1);
  };
  const after = (index: number, width: number) => index < 0 || index >= html.length ? html.length : index + width;

  for (let at = 0; at < html.length;) {
    const next = html.indexOf('<', at);
    const textEnd = next < 0 ? html.length : next;
    if (textEnd > at) text(html.slice(at, textEnd));
    at = next < 0 ? html.length : tag(next);
  }
  return {
    ...(title ? { title } : {}),
    text: tidyLines(parts.join('')),
    hrefs,
    overflowed,
  };
}

function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(ENTITY, (match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED_ENTITIES.get(name) ?? match;
    const code = decimal !== undefined ? Number(decimal) : parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}

function hrefOf(tagText: string): string | undefined {
  const match = HREF.exec(tagText);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  return raw === undefined ? undefined : decodeEntities(raw).trim() || undefined;
}

/** The `>` that ends the tag whose attributes start at `from`; a `>` inside a quoted value does not. */
function tagEnd(html: string, from: number): number {
  let quote = '';
  for (let at = from; at < html.length; at += 1) {
    const char = html[at];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === '\'') {
      quote = char;
    } else if (char === '>') {
      return at;
    }
  }
  return html.length;
}

/** Where the end tag of raw-text element `name` starts, or the end of the page. */
function rawTextEnd(html: string, from: number, name: string): number {
  for (let at = html.indexOf('</', from); at >= 0; at = html.indexOf('</', at + 2)) {
    const nameEnd = at + 2 + name.length;
    if (html.slice(at + 2, nameEnd).toLowerCase() === name && !isNameChar(html.charCodeAt(nameEnd))) return at;
  }
  return html.length;
}

/** Trailing spaces gone, and never more than one blank line in a row. */
function tidyLines(text: string): string {
  const lines: string[] = [];
  let blank = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed === '' && blank) continue;
    blank = trimmed === '';
    lines.push(trimmed);
  }
  return lines.join('\n').trim();
}

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isNameChar(code: number): boolean {
  return isLetter(code) || (code >= 48 && code <= 57) || code === 45 || code === 58;
}
