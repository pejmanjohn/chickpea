/**
 * What a copy keeps of a run that may have browsed signed in. Signed-in page
 * content is kept like any other content. The installation's saved website
 * login usernames, the links that can carry a session or a sign-in token, and
 * every link to the hosted browser itself are not.
 */

import { BROWSER_HANDOFF_LINK_LABEL } from '../browser/requester.ts';
import { CREDENTIAL_REPLACEMENT } from '../security/content-validation.ts';

/** The installation's saved website logins, as a copy needs them. */
export interface RunReviewWebsiteLogins {
  /** Each login's site: a hostname, with a port when the login names one. */
  hosts: readonly string[];
  usernames: readonly string[];
}

export const BROWSER_LINK_OMITTED = '[browser link omitted]';
export const URL_PART_OMITTED = '[omitted]';

/**
 * A username this long or longer is removed wherever it appears as a word.
 * A shorter one would erase ordinary words, so it is removed only where it
 * is a whole quoted value in a browser step: the field it was typed into, or
 * the text a browser_act call typed.
 */
export const MIN_USERNAME_CHARS = 4;

/** The shortest start of a username removed where a cut or a `…` ends it. */
export const MIN_CUT_PREFIX_CHARS = 4;

// A URL ends at whitespace, a double quote, Slack's `<` and `>`, or a backslash. A page's address keeps `'`
// and `|` as they are, so neither ends one, and a Slack link's label goes with its URL.
const URL_CHAR = String.raw`[^\s"<>\\]`;
// The JSON escape of `&`, `'`, `+` or `=` does not end a URL: Go, Gson and .NET write them that way.
const ESCAPED_ASCII = String.raw`\\+u00(?:26|27|2[bB]|3[dD])`;
// A slash, which JSON may escape with a backslash: PHP does by default.
const SLASH = String.raw`\\*\/`;
const HOST_START = String.raw`(?<![\p{L}\p{N}.@/_-])`;

const MORE_URL = String.raw`${URL_CHAR}*(?:(?:${ESCAPED_ASCII}|\\+\/)${URL_CHAR}*)*`;
const SCHEME_URL = String.raw`\b(?:https?|wss?):${SLASH}${SLASH}${URL_CHAR}${MORE_URL}`;
// What follows a scheme-less host, which may end in a dot: a port, then a path or a query.
const AFTER_HOST = String.raw`\.?(?::\d+)?(?:${SLASH}${MORE_URL}|[;?#]${URL_CHAR}${MORE_URL})`;
// Any host followed by a path or a query, as a browser step's input may name a page.
const ANY_SCHEMELESS_URL = String.raw`${HOST_START}(?:[a-z0-9-]+\.)+[a-z]{2,}${AFTER_HOST}`;

const HANDOFF_LINK = new RegExp(String.raw`<([^<>|]*)\|${escapeRegExp(BROWSER_HANDOFF_LINK_LABEL)}>`, 'g');
/** What a hand-off message links to: an absolute web address, too long to be a word of other text. */
const HANDOFF_URL = /^https?:\/\/[^\s<>|"\\]{8,}$/i;

/** Shapes of a hosted browser's live view, debugger or connect link, whatever its host. */
function browserLink(scheme: string | undefined, hostname: string, path: string, suffix: string): boolean {
  return /^wss?$/i.test(scheme ?? '') ||
    hostname === 'browserbase.com' || hostname.endsWith('.browserbase.com') ||
    /\/devtools(?:-[a-z]+)?\/(?:browser|page|inspector\.html)\b/i.test(path) ||
    /^\?(?:[^#]*&)?wss?=/i.test(suffix);
}

/**
 * A path segment that looks like a token rather than a word or an ID: long,
 * with a long run that mixes letters and digits or a very long run. A short
 * or word-like token is not recognized.
 */
function tokenShaped(segment: string): boolean {
  if (segment.length < 20) return false;
  return (segment.match(/[A-Za-z0-9]+/g) ?? []).some((run) =>
    run.length >= 24 || (run.length >= 10 && /[A-Za-z]/.test(run) && /\d/.test(run)));
}

export interface WebsiteLoginScrub {
  /**
   * Link rules, on text no other rule has changed: a replacement that holds
   * a space would end a URL early and leave the rest of it. A hosted browser
   * link goes whole, and so does a hand-off message's link wherever else the
   * same text holds it. Every URL loses its userinfo. A URL on a login's site,
   * or any URL in a browser step, keeps its scheme, host and path, loses
   * token-shaped path segments, and loses everything from its first `;`,
   * `?` or `#`. A link inside another one's path or query, as a Slack link's
   * label or a redirect holds it, goes by its own rule.
   */
  links(text: string, browserStep: boolean): string;
  /**
   * Each saved username, in any case, as typed, JSON- or snapshot-escaped,
   * percent- or form-encoded (in part or every character), Slack-escaped, or
   * split across snapshot lines, and its start where a `…` or the end of a
   * `cut` field follows it. An email address's local part goes too, where it
   * stands alone.
   */
  usernames(text: string, options: { browserStep: boolean; cut: boolean }): string;
}

export function websiteLoginScrub(logins: RunReviewWebsiteLogins): WebsiteLoginScrub {
  const hostnames = unique(logins.hosts.map((host) => host.trim().toLowerCase().replace(/:\d+$/, '')).filter(Boolean));
  const loginSite = (hostname: string) =>
    hostnames.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  // Outside a browser step, a link without a scheme is recognized on a login's site and the hosted browser's.
  const knownHosts = [...hostnames.map(escapeRegExp), String.raw`browserbase\.com`].join('|');
  const linkPatterns = {
    anywhere: new RegExp(String.raw`${SCHEME_URL}|${HOST_START}(?:[a-z0-9-]+\.)*(?:${knownHosts})${AFTER_HOST}`, 'giu'),
    browserStep: new RegExp(`${SCHEME_URL}|${ANY_SCHEMELESS_URL}`, 'giu'),
  };
  const scrubLinks = (text: string, browserStep: boolean): string =>
    text.replace(browserStep ? linkPatterns.browserStep : linkPatterns.anywhere, (raw) => scrubLink(raw, browserStep));

  const scrubLink = (matched: string, browserStep: boolean): string => {
    // A plain slash is valid JSON too, so the link comes back without its escapes.
    const raw = matched.replace(/\\+\//g, '/');
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
    const afterScheme = scheme ? raw.slice(scheme[0].length) : raw;
    const authorityEnd = afterScheme.search(/[/;?#]/);
    const authority = authorityEnd < 0 ? afterScheme : afterScheme.slice(0, authorityEnd);
    const rest = authorityEnd < 0 ? '' : afterScheme.slice(authorityEnd);
    const host = authority.slice(authority.lastIndexOf('@') + 1);
    // `host.example.` names the same site as `host.example`.
    const hostname = host.replace(/:\d*$/, '').replace(/\.+$/, '').toLowerCase();
    const pathEnd = rest.search(/[;?#]/);
    const path = pathEnd < 0 ? rest : rest.slice(0, pathEnd);
    const suffix = pathEnd < 0 ? '' : rest.slice(pathEnd);
    if (browserLink(scheme?.[1], hostname, path, suffix)) return BROWSER_LINK_OMITTED;
    const start = `${scheme?.[0] ?? ''}${host}`;
    // What follows the host can hold another link, as a Slack link's label or a redirect's query does.
    if (!browserStep && !loginSite(hostname)) return `${start}${scrubLinks(rest, browserStep)}`;
    const kept = path.split('/').map((segment) => tokenShaped(segment) ? URL_PART_OMITTED : segment).join('/');
    return `${start}${scrubLinks(kept, browserStep)}${suffix ? `?${URL_PART_OMITTED}` : ''}`;
  };

  const names = unique(logins.usernames.map((username) => username.trim()).filter(Boolean));
  // An email address's local part goes where it stands alone too, as a site's greeting writes it.
  const localParts = unique(names.flatMap((name) => {
    const at = name.lastIndexOf('@');
    return at > 0 && at < name.length - 1 ? [name.slice(0, at)] : [];
  })).filter((part) => !names.includes(part));
  const isLong = (name: string) => [...name].length >= MIN_USERNAME_CHARS;
  // A username's own cut start already covers every start of its local part.
  const long = [
    ...names.filter(isLong).map((name) => usernameMatcher(name, { cutStart: true })),
    ...localParts.filter(isLong).map((name) => usernameMatcher(name, { cutStart: false })),
  ];
  const short = [...names, ...localParts].filter((name) => !isLong(name));
  const quoted = short.length
    ? new RegExp(String.raw`(?<=")(?:${short.map((name) => [...name].map(charPattern).join('')).join('|')})(?=\\*")`, 'giu')
    : undefined;

  return {
    links(text, browserStep) {
      // A thread context row lists a message's links again under its text, unescaped (slack/rich-text-links.ts).
      // Anyone can write the label, so only a whole URL counts, and only where it stands alone: a
      // replacement inside other text would break up a URL or a username before its own rule saw it.
      const handoffs = unique([...text.matchAll(HANDOFF_LINK)]
        .flatMap(([, url]) => url ? [url, unescapedSlackText(url)] : [])
        .filter((url) => HANDOFF_URL.test(url)));
      const withoutHandoffs = handoffs.reduce(
        (value, url) => value.replace(
          new RegExp(String.raw`(?<![^\s<"])${escapeRegExp(url)}(?![^\s>|"\\])`, 'g'), BROWSER_LINK_OMITTED),
        text.replace(HANDOFF_LINK, BROWSER_LINK_OMITTED),
      );
      return scrubLinks(withoutHandoffs, browserStep);
    },
    usernames(text, { browserStep, cut }) {
      // Matching reads the text with its percent escapes decoded, so a username encoded letter by
      // letter is found too, and each match is removed from the text as it was written.
      const view = percentDecoded(text);
      const lower = view.text.toLowerCase();
      const holds = (runs: readonly string[]) => runs.every((run) => lower.includes(run));
      const found: Span[] = [];
      const find = (pattern: RegExp) => {
        for (const match of view.text.matchAll(pattern)) found.push(view.written(match.index, match.index + match[0].length));
      };
      for (const matcher of long) {
        if (holds(matcher.runs)) find(matcher.whole());
      }
      if (cut || view.text.includes(CUT_MARK)) {
        for (const matcher of long) {
          if (matcher.prefix && holds(matcher.prefix.runs)) find(matcher.prefix.pattern(cut));
        }
      }
      if (quoted && browserStep) find(quoted);
      return replaceSpans(text, found);
    },
  };
}

const CUT_MARK = '…';
const WORD = /[\p{L}\p{N}]/u;
const ASCII_WORD = /[A-Za-z0-9]/;
const WORD_CHAR = String.raw`[\p{L}\p{N}]`;
// Chinese, Japanese, Korean and Thai put no space between a word and a username beside it.
const UNSPACED_LETTER = String.raw`[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Thai}]`;
// Not inside a word, though an unspaced letter or a JSON or Slack escape may sit right before it.
const WORD_START = String.raw`(?:(?<!${WORD_CHAR})|(?<=${UNSPACED_LETTER}|\\[nrtbf]|\\u[0-9A-Fa-f]{4}|&(?:amp|lt|gt);))`;
const WORD_END = String.raw`(?:(?!${WORD_CHAR})|(?=${UNSPACED_LETTER}))`;
// Where a snapshot ends one node's text and starts the next: `"`, its ref and state, a line break, `- text "`.
const NODE_STATE = String.raw`(?: (?:level=\d+|checked(?:=mixed)?|selected|expanded|disabled))*`;
const NODE_BREAK = String.raw`(?:\\*"(?: \[ref=e\d+\])?${NODE_STATE}(?:\s|\\+[nrt])+-\s[A-Za-z]+\s\\*")?`;
const CUT_AHEAD = String.raw`(?:\s|\\+[nrt])*${CUT_MARK}`;

/**
 * One character of a username in each form a copy's text can hold it, once
 * its percent escapes are decoded. A form writes a space as `+`.
 */
function charPattern(char: string): string {
  if (/\s/u.test(char)) return String.raw`(?:\s+|\+)`;
  const escaped: Record<string, string> = {
    '"': String.raw`\\*"`,
    '\\': String.raw`\\+`,
    '&': '&(?:amp;)?',
    '<': '<|&lt;',
    '>': '>|&gt;',
  };
  // A serializer may write a mark or a non-ASCII letter by its number: a JSON unicode escape, or an HTML entity.
  const code = char.codePointAt(0)!;
  const hex = code.toString(16);
  const numbered = ASCII_WORD.test(char) || code > 0xffff
    ? ''
    : String.raw`|\\+u${hex.padStart(4, '0')}|&#(?:0*${code}|x0*${hex});`;
  return `(?:${escaped[char] ?? escapeRegExp(char)}${numbered})`;
}

interface UsernameMatcher {
  /**
   * The username's runs of ASCII letters and digits, lowercased. Once a
   * field's percent escapes are decoded, no escape a serializer writes
   * changes those characters, and a snapshot breaks a value only at the edge
   * of a run, so a field that lacks one cannot hold the username.
   */
  runs: string[];
  whole(): RegExp;
  /** Absent for a local part, and for a username too short to leave a start of MIN_CUT_PREFIX_CHARS before its end. */
  prefix?: {
    /** The runs of the username's first MIN_CUT_PREFIX_CHARS characters. */
    runs: string[];
    /** The longest start, at least MIN_CUT_PREFIX_CHARS long, that a `…` follows, or the end of a `cut` field. */
    pattern(cut: boolean): RegExp;
  };
}

/** Each pattern compiles on first use, a few milliseconds, and most fields never need it. */
function usernameMatcher(name: string, { cutStart }: { cutStart: boolean }): UsernameMatcher {
  const chars = [...name];
  const start = WORD.test(chars[0]!) ? WORD_START : '';
  const end = WORD.test(chars.at(-1)!) ? WORD_END : '';
  const matcher = { runs: asciiRuns(name), whole: once(() => new RegExp(`${start}${joined(chars)}${end}`, 'giu')) };
  if (!cutStart || chars.length <= MIN_CUT_PREFIX_CHARS) return matcher;
  const required = joined(chars.slice(0, MIN_CUT_PREFIX_CHARS));
  const optional = chars.slice(MIN_CUT_PREFIX_CHARS, -1).reduceRight(
    (tail, char, index) => `(?:${breakBefore(chars, MIN_CUT_PREFIX_CHARS + index)}${charPattern(char)}${tail})?`,
    '',
  );
  const compile = (cut: boolean) =>
    new RegExp(`${start}${required}${optional}(?=${CUT_AHEAD}${cut ? '|$' : ''})`, 'giu');
  const atMark = once(() => compile(false));
  const atMarkOrEnd = once(() => compile(true));
  return {
    ...matcher,
    prefix: {
      runs: asciiRuns(chars.slice(0, MIN_CUT_PREFIX_CHARS).join('')),
      pattern: (cut) => cut ? atMarkOrEnd() : atMark(),
    },
  };
}

function joined(chars: readonly string[]): string {
  return chars.map((char, index) => `${breakBefore(chars, index)}${charPattern(char)}`).join('');
}

/** A snapshot node break may sit before this character unless it continues an ASCII run. */
function breakBefore(chars: readonly string[], index: number): string {
  if (index === 0) return '';
  return ASCII_WORD.test(chars[index - 1]!) && ASCII_WORD.test(chars[index]!) ? '' : NODE_BREAK;
}

/** Where a match starts and ends in a field's text, `[start, end)`. */
type Span = [number, number];

/** `text` with each span replaced; spans that overlap are replaced once, together. */
function replaceSpans(text: string, spans: Span[]): string {
  const merged: Span[] = [];
  for (const [start, end] of spans.sort(([left], [right]) => left - right)) {
    const last = merged.at(-1);
    if (last && start < last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let result = '';
  let from = 0;
  for (const [start, end] of merged) {
    result += `${text.slice(from, start)}${CREDENTIAL_REPLACEMENT}`;
    from = end;
  }
  return result + text.slice(from);
}

interface DecodedView {
  text: string;
  /** Where the view's `[start, end)` was written in the original text. */
  written(start: number, end: number): Span;
}

const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2})+/g;
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** `text` with each percent escape of a UTF-8 character decoded. Other escapes stay as written. */
function percentDecoded(text: string): DecodedView {
  if (!text.includes('%')) return { text, written: (start, end) => [start, end] };
  // For each character of the view, where it starts and ends in `text`.
  const starts: number[] = [];
  const ends: number[] = [];
  let decoded = '';
  const keep = (from: number, to: number) => {
    for (let index = from; index < to; index += 1) {
      starts.push(index);
      ends.push(index + 1);
    }
    decoded += text.slice(from, to);
  };
  let from = 0;
  for (const match of text.matchAll(PERCENT_RUN)) {
    keep(from, match.index);
    const bytes = Uint8Array.from(match[0].slice(1).split('%'), (hex) => parseInt(hex, 16));
    for (let index = 0; index < bytes.length;) {
      const at = match.index + index * 3;
      const char = utf8CharAt(bytes, index);
      if (char === undefined) {
        keep(at, at + 3);
        index += 1;
        continue;
      }
      const end = at + char.bytes * 3;
      for (let unit = 0; unit < char.text.length; unit += 1) {
        starts.push(at);
        ends.push(end);
      }
      decoded += char.text;
      index += char.bytes;
    }
    from = match.index + match[0].length;
  }
  keep(from, text.length);
  return { text: decoded, written: (start, end) => [starts[start]!, ends[end - 1]!] };
}

/** The UTF-8 character that starts at `bytes[index]`, or undefined where none does. */
function utf8CharAt(bytes: Uint8Array, index: number): { text: string; bytes: number } | undefined {
  const lead = bytes[index]!;
  if (lead < 0x80) return { text: String.fromCharCode(lead), bytes: 1 };
  const length = lead < 0xc2 ? 0 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf5 ? 4 : 0;
  if (!length || index + length > bytes.length) return undefined;
  try {
    return { text: strictUtf8.decode(bytes.subarray(index, index + length)), bytes: length };
  } catch {
    return undefined;
  }
}

function asciiRuns(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function once<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
}

function unescapedSlackText(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
