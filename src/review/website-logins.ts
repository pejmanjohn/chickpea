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

// A URL ends at whitespace, a quote, Slack's `<`, `>` and `|`, or a backslash.
const URL_CHAR = String.raw`[^\s"'<>|\\]`;
// A browser step holds a tool's JSON, not prose or Slack markup, and a page's address keeps `'` and `|` as they are.
const STEP_URL_CHAR = String.raw`[^\s"<>\\]`;
// The JSON escape of `&`, `'`, `+` or `=` does not end a URL: Go, Gson and .NET write them that way.
const ESCAPED_ASCII = String.raw`\\+u00(?:26|27|2[bB]|3[dD])`;
const HOST_START = String.raw`(?<![\p{L}\p{N}.@/_-])`;

/** A URL with a scheme, and what follows a scheme-less host, over one class of URL characters. */
function urlPatterns(char: string): { scheme: string; afterHost: string } {
  const more = String.raw`${char}*(?:${ESCAPED_ASCII}${char}*)*`;
  return {
    scheme: String.raw`\b(?:https?|wss?):\/\/${char}${more}`,
    afterHost: String.raw`(?::\d+)?(?:\/${more}|[;?#]${char}${more})`,
  };
}

const TEXT_URL = urlPatterns(URL_CHAR);
const STEP_URL = urlPatterns(STEP_URL_CHAR);
// Any host followed by a path or a query, as a browser step's input may name a page.
const ANY_SCHEMELESS_URL = String.raw`${HOST_START}(?:[a-z0-9-]+\.)+[a-z]{2,}${STEP_URL.afterHost}`;

const HANDOFF_LINK = new RegExp(String.raw`<([^<>|]*)\|${escapeRegExp(BROWSER_HANDOFF_LINK_LABEL)}>`, 'g');

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
   * `?` or `#`.
   */
  links(text: string, browserStep: boolean): string;
  /**
   * Each saved username, in any case, as typed, JSON- or snapshot-escaped,
   * percent- or form-encoded, Slack-escaped, or split across snapshot lines,
   * and its start where a `…` or the end of a `cut` field follows it.
   */
  usernames(text: string, options: { browserStep: boolean; cut: boolean }): string;
}

export function websiteLoginScrub(logins: RunReviewWebsiteLogins): WebsiteLoginScrub {
  const hostnames = unique(logins.hosts.map((host) => host.trim().toLowerCase().replace(/:\d+$/, '')).filter(Boolean));
  const loginSite = (hostname: string) =>
    hostnames.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  const loginSchemeless = hostnames.length
    ? String.raw`${HOST_START}(?:[a-z0-9-]+\.)*(?:${hostnames.map(escapeRegExp).join('|')})${TEXT_URL.afterHost}`
    : undefined;
  const linkPatterns = {
    anywhere: new RegExp([TEXT_URL.scheme, loginSchemeless].filter(Boolean).join('|'), 'giu'),
    browserStep: new RegExp([STEP_URL.scheme, ANY_SCHEMELESS_URL].join('|'), 'giu'),
  };

  const scrubLink = (raw: string, browserStep: boolean): string => {
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
    const afterScheme = scheme ? raw.slice(scheme[0].length) : raw;
    const authorityEnd = afterScheme.search(/[/;?#]/);
    const authority = authorityEnd < 0 ? afterScheme : afterScheme.slice(0, authorityEnd);
    const rest = authorityEnd < 0 ? '' : afterScheme.slice(authorityEnd);
    const host = authority.slice(authority.lastIndexOf('@') + 1);
    const hostname = host.replace(/:\d*$/, '').toLowerCase();
    const pathEnd = rest.search(/[;?#]/);
    const path = pathEnd < 0 ? rest : rest.slice(0, pathEnd);
    const suffix = pathEnd < 0 ? '' : rest.slice(pathEnd);
    if (browserLink(scheme?.[1], hostname, path, suffix)) return BROWSER_LINK_OMITTED;
    const start = `${scheme?.[0] ?? ''}${host}`;
    if (!browserStep && !loginSite(hostname)) return `${start}${rest}`;
    const kept = path.split('/').map((segment) => tokenShaped(segment) ? URL_PART_OMITTED : segment).join('/');
    return `${start}${kept}${suffix ? `?${URL_PART_OMITTED}` : ''}`;
  };

  // Longest first, so a username that holds another goes whole.
  const names = unique(logins.usernames.map((username) => username.trim()).filter(Boolean))
    .sort((left, right) => right.length - left.length);
  const long = names.filter((name) => [...name].length >= MIN_USERNAME_CHARS).map(usernameMatcher);
  const short = names.filter((name) => [...name].length < MIN_USERNAME_CHARS);
  const quoted = short.length
    ? new RegExp(String.raw`(?<=")(?:${short.map((name) => [...name].map(charPattern).join('')).join('|')})(?=\\*")`, 'giu')
    : undefined;

  return {
    links(text, browserStep) {
      // A thread context row lists a message's links again under its text, unescaped (slack/rich-text-links.ts).
      const handoffs = unique([...text.matchAll(HANDOFF_LINK)]
        .flatMap(([, url]) => url ? [url, unescapedSlackText(url)] : []));
      return handoffs
        .reduce((value, url) => value.split(url).join(BROWSER_LINK_OMITTED), text.replace(HANDOFF_LINK, BROWSER_LINK_OMITTED))
        .replace(browserStep ? linkPatterns.browserStep : linkPatterns.anywhere, (raw) => scrubLink(raw, browserStep));
    },
    usernames(text, { browserStep, cut }) {
      const lower = text.toLowerCase();
      const holds = (runs: readonly string[]) => runs.every((run) => lower.includes(run));
      let result = text;
      for (const matcher of long) {
        if (holds(matcher.runs)) result = result.replace(matcher.whole(), CREDENTIAL_REPLACEMENT);
      }
      if (cut || result.includes(CUT_MARK)) {
        for (const matcher of long) {
          if (matcher.prefix && holds(matcher.prefix.runs)) result = result.replace(matcher.prefix.pattern(cut), CREDENTIAL_REPLACEMENT);
        }
      }
      if (quoted && browserStep) result = result.replace(quoted, CREDENTIAL_REPLACEMENT);
      return result;
    },
  };
}

const CUT_MARK = '…';
const WORD = /[\p{L}\p{N}]/u;
const ASCII_WORD = /[A-Za-z0-9]/;
const WORD_CHAR = String.raw`[\p{L}\p{N}]`;
// Chinese, Japanese, Korean and Thai put no space between a word and a username beside it.
const UNSPACED_LETTER = String.raw`[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Thai}]`;
// Not inside a word, though an unspaced letter or a JSON, percent or Slack escape may sit right before it.
const WORD_START = String.raw`(?:(?<!${WORD_CHAR})|(?<=${UNSPACED_LETTER}|\\[nrtbf]|\\u[0-9A-Fa-f]{4}|%[0-9A-Fa-f]{2}|&(?:amp|lt|gt);))`;
const WORD_END = String.raw`(?:(?!${WORD_CHAR})|(?=${UNSPACED_LETTER}))`;
// Where a snapshot ends one node's text and starts the next: `"`, its ref and state, a line break, `- text "`.
const NODE_STATE = String.raw`(?: (?:level=\d+|checked(?:=mixed)?|selected|expanded|disabled))*`;
const NODE_BREAK = String.raw`(?:\\*"(?: \[ref=e\d+\])?${NODE_STATE}(?:\s|\\+[nrt])+-\s[A-Za-z]+\s\\*")?`;
const CUT_AHEAD = String.raw`(?:\s|\\+[nrt])*${CUT_MARK}`;

const encoder = new TextEncoder();

/** One character of a username in each form a copy's text can hold it. */
function charPattern(char: string): string {
  if (/\s/u.test(char)) return String.raw`(?:\s+|\+|%20)`;
  const percent = [...encoder.encode(char)].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');
  const escaped: Record<string, string> = {
    '"': String.raw`\\*"`,
    '\\': String.raw`\\+`,
    '&': '&(?:amp;)?',
    '<': '<|&lt;',
    '>': '>|&gt;',
  };
  return `(?:${escaped[char] ?? escapeRegExp(char)}|${percent})`;
}

interface UsernameMatcher {
  /**
   * The username's runs of ASCII letters and digits, lowercased. No encoder
   * or escape changes those characters, and a snapshot breaks a value only
   * at the edge of a run, so a field that lacks one cannot hold the username.
   */
  runs: string[];
  whole(): RegExp;
  /** Absent for a username too short to leave a start of MIN_CUT_PREFIX_CHARS before its end. */
  prefix?: {
    /** The runs of the username's first MIN_CUT_PREFIX_CHARS characters. */
    runs: string[];
    /** The longest start, at least MIN_CUT_PREFIX_CHARS long, that a `…` follows, or the end of a `cut` field. */
    pattern(cut: boolean): RegExp;
  };
}

/** Each pattern compiles on first use, a few milliseconds, and most fields never need it. */
function usernameMatcher(name: string): UsernameMatcher {
  const chars = [...name];
  const start = WORD.test(chars[0]!) ? WORD_START : '';
  const end = WORD.test(chars.at(-1)!) ? WORD_END : '';
  const matcher = { runs: asciiRuns(name), whole: once(() => new RegExp(`${start}${joined(chars)}${end}`, 'giu')) };
  if (chars.length <= MIN_CUT_PREFIX_CHARS) return matcher;
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
