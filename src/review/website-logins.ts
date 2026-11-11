/**
 * What a copy keeps of a run that may have browsed signed in. Signed-in page
 * content is kept like any other content. The installation's saved website
 * login usernames, the links that can carry a session or a sign-in token, and
 * every link to the hosted browser itself are not.
 *
 * No pattern here is built from a saved login or from a record's text. The
 * link rules are fixed patterns that look each host up, and usernames are
 * found by literal search, so no value can make a pattern backtrack or
 * compile without bound. Each rule reads a view of a field with its
 * escapes decoded, and maps what it finds back to where it was written. The
 * work one copy's scrub does is counted, and a copy past its budget, or past
 * the caps on its logins, is not kept.
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

/** The shortest start of a username removed where a cut, a `…` or `...` ends it. */
export const MIN_CUT_PREFIX_CHARS = 4;

/**
 * The most sites, and the most usernames, one copy removes. The catalog holds
 * at most 100 logins and a run's plan as many; past this a copy is not kept,
 * rather than kept with some of them left in.
 */
export const MAX_SCRUB_LOGINS = 500;
/** The longest username a copy removes, the catalog's own limit. A longer one keeps no copy. */
export const MAX_SCRUB_USERNAME_CHARS = 320;
/**
 * The work one copy's scrub may do, in characters read and automaton steps.
 * A copy at the record cap with 500 saved usernames takes about a tenth of it.
 */
export const SCRUB_BUDGET_STEPS = 20_000_000;
/** What reading a host that is not in ASCII costs besides its length: a URL parses it in about the time of 80 steps. */
const HOST_PARSE_STEPS = 80;

/** A copy the scrub stopped: past its budget, or past the caps on its logins. `event` is its only log line. */
export class RunReviewScrubLimit extends Error {
  constructor(readonly event: 'scrub_over_budget' | 'scrub_over_logins') {
    super('The copy is past the scrub\'s limits.');
    this.name = 'RunReviewScrubLimit';
  }
}

/** One copy's budget. Its scrub holds it, and the builder's other work on each field spends from it too. */
export class ScrubBudget {
  #left: number;

  constructor(steps = SCRUB_BUDGET_STEPS) {
    this.#left = steps;
  }

  spend(steps: number): void {
    this.#left -= steps;
    if (this.#left < 0) throw new RunReviewScrubLimit('scrub_over_budget');
  }
}

// The link rules read a field's link view (see linkView below): its JSON escapes decoded, then NFKC without
// default-ignorable code points. So no pattern here reads an escape.

// A URL ends at whitespace, a double quote, Slack's `<` and `>`, or a backslash. A page's address keeps `'`
// and `|` as they are, so neither ends one, and a Slack link's label goes with its URL.
const URL_CHAR = String.raw`[^\s"<>\\]`;
// A dot between a host's labels. A URL reads the ideographic full stop and its halfwidth form as one too.
const DOT = String.raw`[.\u3002\uFF0E\uFF61]`;
// A character of a host's label: a letter in any script, a mark that goes with one, a digit, a hyphen or a percent escape.
const LABEL_CHAR = String.raw`(?:[\p{L}\p{M}\p{N}-]|%[\da-f]{2})`;
// Not inside a word, a percent escape, an email address or a path. A protocol-relative `//` may come right before it.
const HOST_START = String.raw`(?<![\p{L}\p{M}\p{N}.\u3002\uFF0E\uFF61@_-])(?!(?<=%)[\da-f]{2})(?<!(?:^|[^/])\/)`;
// A name whose top-level label is letters, or the ASCII form of a name in another script.
const NAME = String.raw`(?:${LABEL_CHAR}+${DOT})+(?:\p{L}[\p{L}\p{M}]+|xn--[a-z\d-]+)`;
// A host as a link writes one: a name or a bracketed IP address.
const READABLE_HOST = /^(?:[\p{L}\p{M}\p{N}.-]+|\[[\da-f:.]+\])$/iu;

const SCHEME_URL = String.raw`\b(?:https?|wss?):\/\/${URL_CHAR}+`;
// What follows a scheme-less host, which may end in a dot: a port, then a path or a query.
const AFTER_HOST = String.raw`${DOT}?(?::\d+)?(?:\/${URL_CHAR}*|[;?#]${URL_CHAR}+)`;
// Any host a link without a scheme could follow. Only its host is read: it is looked up before the rest of its
// link is read, so a field of hosts that start no link costs one reading.
const SCHEMELESS_HOST = String.raw`${HOST_START}(?<host>(?:${LABEL_CHAR}+${DOT})*${LABEL_CHAR}+|\[[\da-f:.]+\])` +
  String.raw`(?=${DOT}?(?::\d+)?(?:\/|[;?#]${URL_CHAR}))`;
const LINKS = `${SCHEME_URL}|${SCHEMELESS_HOST}`;
/** The rest of a scheme-less link, from the end of its host. */
const REST_OF_LINK = new RegExp(AFTER_HOST, 'yiu');
/** A name no URL can read: it may hide a login's site, so its link goes by the login rule. */
const UNREADABLE_NAME = new RegExp(`^${NAME}$`, 'iu');
/**
 * A host a page's address may have, which starts a link without a scheme anywhere in a browser step: a name,
 * an IPv4 address in four decimal parts, or a bracketed IPv6 address.
 */
const BROWSER_STEP_HOST = new RegExp(String.raw`^(?:${NAME}|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:.]+\])$`, 'iu');

const HANDOFF_LINK = new RegExp(String.raw`<([^<>|]*)\|${escapeRegExp(BROWSER_HANDOFF_LINK_LABEL)}>`, 'g');
const HANDOFF_LABEL = `|${BROWSER_HANDOFF_LINK_LABEL}>`;
/** What a hand-off message links to: an absolute web address, too long to be a word of other text. */
const HANDOFF_URL = /^https?:\/\/[^\s<>|"\\]{8,}$/i;
/** A run of text a hand-off URL could be: nothing that ends one. */
const URL_RUN = /[^\s<>|"\\]+/g;
const BEFORE_URL_RUN = /[\s<"]/;
const AFTER_URL_RUN = /[\s>|"\\]/;

/** Shapes of a hosted browser's live view, debugger or connect link, whatever its host. */
function browserLink(scheme: string | undefined, hostname: string, path: string, suffix: string): boolean {
  return /^wss?$/i.test(scheme ?? '') || browserbaseHost(hostname) ||
    /\/devtools(?:-[a-z]+)?\/(?:browser|page|inspector\.html)\b/i.test(path) ||
    /^\?(?:[^#]*&)?wss?=/i.test(suffix);
}

function browserbaseHost(hostname: string): boolean {
  return hostname === 'browserbase.com' || hostname.endsWith('.browserbase.com');
}

const PLAIN_NAME = /^[a-z\d.-]+$/i;
const IDNA_LABEL = /(?:^|\.)xn--/i;
// A label a URL reads as a number, which makes the host an IPv4 address.
const NUMBER_LABEL = /^(?:\d+|0x[\da-f]*)$/i;

/**
 * Whether a URL gives `host` back as it is written, but for case: ASCII
 * letters, digits, dots and hyphens, with no `xn--` label, which a URL
 * checks, and a last label (before one dot that may end it) that is no
 * number, which makes a URL read the host as an IPv4 address. Any other host
 * is parsed.
 */
function plainName(host: string): boolean {
  if (!PLAIN_NAME.test(host) || IDNA_LABEL.test(host)) return false;
  const end = host.endsWith('.') ? host.length - 1 : host.length;
  const last = host.slice(host.lastIndexOf('.', end - 1) + 1, end);
  return last === '' || !NUMBER_LABEL.test(last);
}

/**
 * A host as a browser reads it, to compare with a login's site: the
 * hostname a URL gives it, without the dots that may end it. A name in
 * another script or a percent escape reads as its ASCII form, and an IPv4
 * address in hex, in octal or in fewer than four parts as its four decimal
 * ones. Undefined for a host no URL can hold.
 */
function asciiHost(host: string, plain = plainName(host)): string | undefined {
  let hostname: string;
  if (plain) {
    hostname = host.toLowerCase();
  } else {
    try {
      hostname = new URL(`https://${host}/`).hostname;
    } catch {
      return undefined;
    }
  }
  let end = hostname.length;
  while (end > 0 && hostname[end - 1] === '.') end -= 1;
  return end > 0 ? hostname.slice(0, end) : undefined;
}

// A path segment a site is unlikely to take as a bearer: a word of up to 20 letters.
const PLAIN_SEGMENT = /^[A-Za-z]{1,20}$/;
// What a sentence may put right after a link.
const SENTENCE_MARKS = '.,!)\'';

/**
 * The path of a link on a login's site, or of any link in a browser step,
 * with each segment omitted that is not a word of up to 20 letters. Any
 * other segment, a number, an ID or a slug as much as a token, may be what
 * the site takes as its sign-in bearer.
 */
function plainPath(path: string): string {
  return path.split('/').map((segment) => segment === '' || PLAIN_SEGMENT.test(segment) ? segment : URL_PART_OMITTED).join('/');
}

export interface WebsiteLoginScrub {
  /**
   * Link rules, on text no other rule has changed: a replacement that holds a
   * space would end a URL early and leave the rest of it. They read the text
   * with its JSON escapes decoded, in NFKC without default-ignorable code
   * points, and a link they rewrite comes back as they read it. A hosted
   * browser link goes whole, and so does a hand-off message's link wherever
   * else the same text holds it. Every URL loses its userinfo. A host is a
   * login's site when the hostname a URL gives it is, whatever script,
   * encoding or IPv4 spelling it is written in. A link without a scheme
   * counts on a login's site or the hosted browser's, or on a name no URL can
   * read; in a browser step, on any name, any IPv4 address in four decimal
   * parts and any bracketed IPv6 address too. A URL on a login's site, or any
   * URL in a browser step, keeps its scheme and host, keeps a path segment
   * only where it is a word of up to 20 letters (so its numbers, IDs and
   * slugs go too), and loses everything from its first `;`, `?` or `#`. So
   * does a URL whose host cannot be read as one, and its host goes too. Only
   * the marks a sentence puts right after the whole URL stay. In Slack's
   * `<url|label>` outside a browser step, the label after the first `|`
   * before the query is text, and goes by these rules as any text does.
   * Elsewhere a link inside another one's path or query, as a Slack link's
   * label or a redirect holds it, goes by its own rule.
   */
  links(text: string, browserStep: boolean): string;
  /**
   * Each saved username, in any case, as typed, JSON- or snapshot-escaped,
   * percent- or form-encoded (in part or every character), Slack-escaped,
   * written by its HTML or JSON number, with any run of whitespace for its
   * own, or split across snapshot nodes, and its start where a `…`, `...` or
   * the end of a `cut` field follows it. An email address's local part goes
   * too, where it stands alone.
   */
  usernames(text: string, options: { browserStep: boolean; cut: boolean }): string;
  /** Counts other work on the copy's fields against the same budget. */
  spend(steps: number): void;
}

/**
 * One copy's scrub, with the copy's budget. Throws RunReviewScrubLimit past
 * the caps on logins, and from any of its methods past the budget.
 */
export function websiteLoginScrub(logins: RunReviewWebsiteLogins): WebsiteLoginScrub {
  const budget = new ScrubBudget();
  const hostnames = new Set(logins.hosts.map((host) => {
    const site = host.trim().replace(/:\d+$/, '');
    return asciiHost(site) ?? site.toLowerCase();
  }).filter(Boolean));
  const names = unique(logins.usernames.map((username) => username.trim()).filter(Boolean));
  if (hostnames.size > MAX_SCRUB_LOGINS || names.length > MAX_SCRUB_LOGINS ||
      names.some((name) => name.length > MAX_SCRUB_USERNAME_CHARS)) {
    throw new RunReviewScrubLimit('scrub_over_logins');
  }
  const longestSite = Math.max(0, ...[...hostnames].map((site) => site.length));
  // The site itself or any host under it, each in its ASCII form. A suffix longer than every site is none of
  // them, so a long host is read only from where one could start.
  const loginSite = (hostname: string): boolean => {
    let at = 0;
    if (hostname.length > longestSite) {
      at = hostname.indexOf('.', hostname.length - longestSite - 1) + 1;
      if (at === 0) return false;
    }
    for (; ; at += 1) {
      if (hostnames.has(hostname.slice(at))) return true;
      at = hostname.indexOf('.', at);
      if (at < 0) return false;
    }
  };
  const readHost = (host: string): string | undefined => {
    const plain = plainName(host);
    budget.spend(plain ? host.length : host.length + HOST_PARSE_STEPS);
    return asciiHost(host, plain);
  };

  // Whether a host without a scheme starts a link: one on a login's site or the hosted browser's, or a name no URL
  // can read, which may hide either. In a browser step any host a page's address may have starts one.
  const startsLink = (host: string, browserStep: boolean): boolean => {
    if (browserStep && BROWSER_STEP_HOST.test(host)) return true;
    const hostname = readHost(host);
    return hostname === undefined ? UNREADABLE_NAME.test(host) : loginSite(hostname) || browserbaseHost(hostname);
  };

  /** `source` with each link its view holds rewritten. A link goes back where it was written, read as the view reads it. */
  const scrubLinks = (source: string, view: Written, browserStep: boolean): string => {
    const { text } = view;
    budget.spend(text.length);
    const pattern = new RegExp(LINKS, 'giu');
    let result = '';
    let from = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      let link = match[0];
      const host = match.groups?.host;
      if (host !== undefined) {
        // Not a link this rule reads: reading goes on after its host, where another link may start.
        if (!startsLink(host, browserStep)) continue;
        REST_OF_LINK.lastIndex = match.index + host.length;
        link += REST_OF_LINK.exec(text)![0];
      }
      // Slack writes a link as `<url|label>`. A browser step holds a page's text, not Slack's.
      const slackLink = !browserStep && text[match.index - 1] === '<';
      const [start, end] = written(view, match.index, match.index + link.length);
      result += `${source.slice(from, Math.max(from, start))}${scrubLink(link, browserStep, slackLink)}`;
      from = Math.max(from, end);
      pattern.lastIndex = match.index + link.length;
    }
    return result + source.slice(from);
  };
  /** Links inside a link the view already read. */
  const scrubRead = (text: string, browserStep: boolean): string => scrubLinks(text, { text }, browserStep);

  const scrubLink = (link: string, browserStep: boolean, slackLink: boolean): string => {
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(link);
    const afterScheme = scheme ? link.slice(scheme[0].length) : link;
    // Userinfo, which no link keeps, ends at the last `@` before the path, whatever it holds.
    const authorityEnd = afterScheme.search(/[/?#]/);
    const authority = authorityEnd < 0 ? afterScheme : afterScheme.slice(0, authorityEnd);
    const hostAndRest = afterScheme.slice(authority.lastIndexOf('@') + 1);
    // `;` and `|` end a host too: no host holds one, and a Slack link's label may follow `|`.
    const hostEnd = hostAndRest.search(/[/;?#|]/);
    const host = hostEnd < 0 ? hostAndRest : hostAndRest.slice(0, hostEnd);
    const rest = hostEnd < 0 ? '' : hostAndRest.slice(hostEnd);
    const name = host.replace(/:\d*$/, '');
    const hostname = readHost(name);
    const readable = hostname !== undefined && READABLE_HOST.test(name);
    const pathEnd = rest.search(/[;?#]/);
    const path = pathEnd < 0 ? rest : rest.slice(0, pathEnd);
    const suffix = pathEnd < 0 ? '' : rest.slice(pathEnd);
    if (browserLink(scheme?.[1], hostname ?? '', path, suffix)) return BROWSER_LINK_OMITTED;
    // A host that cannot be read as one may hide a login's site or a token, so it goes, and its link goes by the login rule.
    const start = `${scheme?.[0] ?? ''}${readable ? host : URL_PART_OMITTED}`;
    // What follows the host can hold another link, as a Slack link's label or a redirect's query does.
    if (!browserStep && readable && !loginSite(hostname)) {
      return `${start}${scrubRead(rest, browserStep)}`;
    }
    budget.spend(rest.length);
    const label = slackLink ? path.indexOf('|') : -1;
    if (label >= 0) return `${start}${plainPath(path.slice(0, label))}|${scrubRead(rest.slice(label + 1), false)}`;
    let end = rest.length;
    while (end > 0 && SENTENCE_MARKS.includes(rest[end - 1]!)) end -= 1;
    const kept = pathEnd < 0 ? plainPath(rest.slice(0, end)) : `${plainPath(path)}?${URL_PART_OMITTED}`;
    return `${start}${kept}${rest.slice(end)}`;
  };

  // An email address's local part goes where it stands alone too, as a site's greeting writes it.
  const named = new Set(names);
  const needles = names.flatMap((name) => {
    const at = name.lastIndexOf('@');
    const local = at > 0 && at < name.length - 1 ? name.slice(0, at) : undefined;
    // A username that holds an escape of its own is searched for as written too, which a serializer escapes again.
    return [
      searchView(name).text.trim(),
      searchView(name, false).text.trim(),
      ...(local !== undefined && !named.has(local) ? [searchView(local).text.trim()] : []),
    ];
  }).filter(Boolean);
  const index = needles.length ? new UsernameIndex(needles, budget) : undefined;

  return {
    links(text, browserStep) {
      budget.spend(text.length);
      const view = linkView(text);
      if (!view.text.includes(HANDOFF_LABEL)) return scrubLinks(text, view, browserStep);
      const handedOff = withoutHandoffs(text, view);
      budget.spend(handedOff.length);
      return scrubLinks(handedOff, linkView(handedOff), browserStep);
    },
    usernames(text, { browserStep, cut }) {
      if (!index) return text;
      budget.spend(text.length);
      const view = searchView(text);
      const found: Span[] = [];
      index.find(view, { quoted: browserStep, cut }, found, budget);
      // A snapshot writes each node's text on its own line, so a username can run across several.
      const joinedView = joined(view);
      if (joinedView) index.find(joinedView, { quoted: false, cut }, found, budget);
      return found.length ? replaceSpans(text, found, CREDENTIAL_REPLACEMENT) : text;
    },
    spend: (steps) => budget.spend(steps),
  };
}

// ---------------------------------------------------------------------------
// Reading a field as the link rules do
// ---------------------------------------------------------------------------

/**
 * `written` as the link rules read it. Each JSON escape is decoded, and a
 * run of backslashes before one reads as a single escape, as a field escaped
 * again writes it. Then the text is in Unicode NFKC, without the
 * default-ignorable code points a URL drops from a host (a soft hyphen, a
 * zero-width character, a variation selector). So a fullwidth or decomposed
 * letter reads as a URL reads it, and a mark that no letter takes stays.
 * Each code unit keeps where it was written, so a link is replaced there.
 */
function linkView(written: string): Written {
  return normalized(jsonDecoded(written));
}

// What a JSON escape other than `\uXXXX` writes.
const JSON_ESCAPED: ReadonlyMap<number, string> = new Map([
  [0x22, '"'], [0x2f, '/'], [0x62, '\b'], [0x66, '\f'], [0x6e, '\n'], [0x72, '\r'], [0x74, '\t'],
]);

/** `text` with each JSON escape decoded. A run of backslashes before no escape reads as one backslash. */
function jsonDecoded(text: string): Written {
  if (!text.includes('\\')) return { text };
  const out = new WrittenText(text.length);
  let from = 0;
  for (let at = text.indexOf('\\'); at >= 0; at = text.indexOf('\\', at)) {
    out.copy({ text }, from, at);
    let next = at + 1;
    while (text.charCodeAt(next) === BACKSLASH) next += 1;
    const unicodeEnd = unicodeEscapeEnd(text, at);
    const escaped = JSON_ESCAPED.get(text.charCodeAt(next));
    // JSON writes a character past U+FFFF as an escape of each half of its pair, so each half reads on its own.
    const end = unicodeEnd >= 0 ? unicodeEnd : escaped === undefined ? next : next + 1;
    out.push(unicodeEnd >= 0 ? String.fromCharCode(escapedUnit(text, unicodeEnd)) : escaped ?? '\\', at, end);
    at = from = end;
  }
  out.copy({ text }, from, text.length);
  return out.done();
}

const NOT_ASCII = /[^\0-\x7f]/;
const NOT_ASCII_RUNS = /[^\0-\x7f]+/g;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const IGNORABLES = /\p{Default_Ignorable_Code_Point}/gu;
// A code point NFKC can join to the one before it: a mark, a default-ignorable one, a Hangul vowel or final
// consonant jamo in any of its forms, a halfwidth kana voicing mark, or a Kirat Rai vowel sign.
const JOINS_BEFORE = /[\p{M}\p{Default_Ignorable_Code_Point}\u1160-\u11FF\u3131-\u318E\uD7B0-\uD7FF\uFF9E-\uFFDC\u{16D67}\u{16D68}]/u;

function nfkc(text: string): string {
  return text.replace(IGNORABLES, '').normalize('NFKC').replace(IGNORABLES, '');
}

/**
 * `view` in NFKC without default-ignorable code points. No ASCII character
 * joins one before it, so each run of other characters is read with the one
 * ASCII character before it, apart from the rest. Inside a run each cluster
 * (a code point and those that join it) keeps where it was written, unless
 * reading the clusters apart would change the run; then the whole run does.
 */
function normalized(view: Written): Written {
  const { text } = view;
  if (!NOT_ASCII.test(text) || (!IGNORABLE.test(text) && text.normalize('NFKC') === text)) return view;
  const out = new WrittenText(text.length);
  // Each cluster read once per field, and whether each code point joins the one before it.
  const reads = new Map<string, string>();
  const joins = new Map<number, boolean>();
  const joinsBefore = (point: number): boolean => {
    if (point < 0x300) return point === 0xad;
    let known = joins.get(point);
    if (known === undefined) joins.set(point, known = JOINS_BEFORE.test(String.fromCodePoint(point)));
    return known;
  };
  // `text[from, at)` is copied as written when the next change comes.
  let from = 0;
  for (const run of text.matchAll(NOT_ASCII_RUNS)) {
    const start = run.index > 0 ? run.index - 1 : 0;
    const end = run.index + run[0].length;
    const segment = text.slice(start, end);
    const read = nfkc(segment);
    if (read === segment) continue;
    const mark = out.mark();
    const markFrom = from;
    let readAt = 0;
    for (let at = start, next = start; at < end && readAt >= 0; at = next) {
      next = at + (text.codePointAt(at)! > 0xffff ? 2 : 1);
      while (next < end && joinsBefore(text.codePointAt(next)!)) next += text.codePointAt(next)! > 0xffff ? 2 : 1;
      const cluster = text.slice(at, next);
      let piece = reads.get(cluster);
      if (piece === undefined) reads.set(cluster, piece = nfkc(cluster));
      if (!read.startsWith(piece, readAt)) {
        readAt = -1;
      } else {
        readAt += piece.length;
        if (piece === cluster) continue;
        out.copy(view, from, at);
        out.push(piece, ...written(view, at, next));
        from = next;
      }
    }
    if (readAt === read.length) continue;
    out.reset(mark);
    out.copy(view, markFrom, start);
    out.push(read, ...written(view, start, end));
    from = end;
  }
  out.copy(view, from, text.length);
  return out.done();
}

/** Text built from parts of a view, each code unit with where it was written. */
class WrittenText {
  #parts: string[] = [];
  #starts: Int32Array;
  #ends: Int32Array;
  #length = 0;

  constructor(capacity: number) {
    this.#starts = new Int32Array(capacity + 16);
    this.#ends = new Int32Array(capacity + 16);
  }

  /** Where the text ends now, for `reset`. */
  mark(): [parts: number, length: number] {
    return [this.#parts.length, this.#length];
  }

  /** The text as it was at `mark`. */
  reset([parts, length]: [parts: number, length: number]): void {
    this.#parts.length = parts;
    this.#length = length;
  }

  /** `view.text[from, to)`, written where the view says. */
  copy(view: Written, from: number, to: number): void {
    if (to <= from) return;
    this.#room(to - from);
    this.#parts.push(view.text.slice(from, to));
    for (let index = from; index < to; index += 1) {
      this.#starts[this.#length] = view.starts ? view.starts[index]! : index;
      this.#ends[this.#length] = view.ends ? view.ends[index]! : index + 1;
      this.#length += 1;
    }
  }

  /** `text`, every code unit of it written at `[start, end)`. */
  push(text: string, start: number, end: number): void {
    this.#room(text.length);
    this.#parts.push(text);
    this.#starts.fill(start, this.#length, this.#length + text.length);
    this.#ends.fill(end, this.#length, this.#length + text.length);
    this.#length += text.length;
  }

  #room(units: number): void {
    if (this.#length + units <= this.#starts.length) return;
    const capacity = Math.max(this.#starts.length * 2, this.#length + units);
    const starts = new Int32Array(capacity);
    const ends = new Int32Array(capacity);
    starts.set(this.#starts);
    ends.set(this.#ends);
    this.#starts = starts;
    this.#ends = ends;
  }

  done(): Written {
    return { text: this.#parts.join(''), starts: this.#starts.subarray(0, this.#length), ends: this.#ends.subarray(0, this.#length) };
  }
}

/**
 * `source` without a hand-off message's link, and without that link's URL
 * wherever else the text holds it. A thread context row lists a message's
 * links again under its text, unescaped (slack/rich-text-links.ts). Anyone
 * can write the label, so only a whole URL counts, and only where it stands
 * alone: a replacement inside other text would break up a URL or a username
 * before its own rule saw it.
 */
function withoutHandoffs(source: string, view: Written): string {
  const { text } = view;
  const spans: Span[] = [];
  const handoffs = new Set<string>();
  for (const match of text.matchAll(HANDOFF_LINK)) {
    spans.push([match.index, match.index + match[0].length]);
    for (const url of match[1] ? [match[1], unescapedSlackText(match[1])] : []) {
      if (HANDOFF_URL.test(url)) handoffs.add(url);
    }
  }
  if (handoffs.size) {
    for (const run of text.matchAll(URL_RUN)) {
      const end = run.index + run[0].length;
      if (handoffs.has(run[0]) && (run.index === 0 || BEFORE_URL_RUN.test(text[run.index - 1]!)) &&
          (end === text.length || AFTER_URL_RUN.test(text[end]!))) spans.push([run.index, end]);
    }
  }
  return replaceSpans(source, spans.map(([start, end]) => written(view, start, end)), BROWSER_LINK_OMITTED);
}

// ---------------------------------------------------------------------------
// Reading a field as the username search does
// ---------------------------------------------------------------------------

/**
 * A field as the username search reads it: percent, form, JSON, HTML-number
 * and Slack escapes decoded once, each run of whitespace, an escaped line
 * break or a form's `+` one space, and every letter case-folded. Each code
 * unit keeps where it was written, so a hit leaves the field as written.
 */
interface SearchView {
  text: string;
  /** Where each code unit of `text` starts and ends in the field as written. */
  starts: Int32Array;
  ends: Int32Array;
  /** A joined view's: 1 where a snapshot node break was taken out right before this index. */
  breaks?: Uint8Array;
}

const BACKSLASH = 0x5c;
const QUOTE = 0x22;
const SLASH_CODE = 0x2f;
const PERCENT = 0x25;
const AMPERSAND = 0x26;
const PLUS = 0x2b;
const SPACE = 0x20;
const LETTER_U = 0x75;
// `\n`, `\r`, `\t`, `\b` and `\f` in JSON.
const ESCAPED_SPACES: ReadonlySet<number> = new Set([0x6e, 0x72, 0x74, 0x62, 0x66]);
const WHITESPACE = /^\s$/u;
const CUT_MARK = '…';
const THREE_DOTS = '...';

/** `written` as the search reads it. Without `decode`, only case and whitespace change. */
function searchView(written: string, decode = true): SearchView {
  const { text, starts, ends } = decode ? percentDecoded(written) : { text: written };
  // Where the source's `[index]` starts and ends in the field as written.
  const startOf = (index: number) => starts ? starts[index]! : index;
  const endOf = (index: number) => ends ? ends[index]! : index + 1;
  const length = text.length;
  const view = new ViewWriter(length);
  for (let index = 0; index < length;) {
    const code = text.charCodeAt(index);
    const escapeEnd = decode ? unicodeEscapeEnd(text, index) : -1;
    if (decode && code === BACKSLASH && escapeEnd < 0) {
      // A serializer that escapes a field again doubles its backslashes, so a run of them reads as one.
      let next = index + 1;
      while (text.charCodeAt(next) === BACKSLASH) next += 1;
      const escaped = text.charCodeAt(next);
      if (escaped === QUOTE || escaped === SLASH_CODE) {
        view.point(escaped, startOf(index), endOf(next));
        index = next + 1;
      } else if (ESCAPED_SPACES.has(escaped)) {
        view.space(startOf(index), endOf(next));
        index = next + 1;
      } else {
        view.point(BACKSLASH, startOf(index), endOf(next - 1));
        index = next;
      }
      continue;
    }
    if (decode && code === AMPERSAND) {
      const entity = entityAt(text, index);
      if (entity) {
        view.point(entity.point, startOf(index), endOf(index + entity.width - 1));
        index += entity.width;
        continue;
      }
    }
    // A code unit as written or JSON-escaped. JSON writes a character past U+FFFF as an escape of each half of
    // its pair, so a high half then a low one, either written either way, read as that one character.
    let unit = escapeEnd < 0 ? code : escapedUnit(text, escapeEnd);
    let end = escapeEnd < 0 ? index + 1 : escapeEnd;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const lowEnd = decode ? unicodeEscapeEnd(text, end) : -1;
      const low = lowEnd < 0 ? text.charCodeAt(end) : escapedUnit(text, lowEnd);
      if (low >= 0xdc00 && low <= 0xdfff) {
        unit = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
        end = lowEnd < 0 ? end + 1 : lowEnd;
      }
    }
    view.point(unit, startOf(index), endOf(end - 1));
    index = end;
  }
  return view.done();
}

/** Where a JSON `\uXXXX` escape that starts at `index`, after any run of backslashes, ends; -1 for none. */
function unicodeEscapeEnd(text: string, index: number): number {
  if (text.charCodeAt(index) !== BACKSLASH) return -1;
  let next = index + 1;
  while (text.charCodeAt(next) === BACKSLASH) next += 1;
  if (text.charCodeAt(next) !== LETTER_U) return -1;
  for (let digit = next + 1; digit <= next + 4; digit += 1) {
    if (hexValue(text.charCodeAt(digit)) < 0) return -1;
  }
  return next + 5;
}

/** The code unit a `\uXXXX` escape that ends at `end` writes. */
function escapedUnit(text: string, end: number): number {
  return parseInt(text.slice(end - 4, end), 16);
}

/** Builds a SearchView one code point at a time. */
class ViewWriter {
  #units: Uint16Array;
  #starts: Int32Array;
  #ends: Int32Array;
  #length = 0;
  #spaced = false;

  constructor(sourceLength: number) {
    // No decoding lengthens a character, and folding case lengthens few (`İ`, `ß`), so the view rarely outgrows its source.
    const capacity = sourceLength + 16;
    this.#units = new Uint16Array(capacity);
    this.#starts = new Int32Array(capacity);
    this.#ends = new Int32Array(capacity);
  }

  point(point: number, start: number, end: number): void {
    if (point < 0x80) {
      if (point === PLUS || point === SPACE || (point >= 0x09 && point <= 0x0d)) this.space(start, end);
      else this.#unit(point >= 0x41 && point <= 0x5a ? point + 0x20 : point, start, end);
      return;
    }
    const char = String.fromCodePoint(point);
    if (WHITESPACE.test(char)) {
      this.space(start, end);
      return;
    }
    // Through upper case, so the letters a case-insensitive match takes as one read as one: ς and σ, ſ and s, ϑ and θ.
    const folded = char.toUpperCase().toLowerCase();
    for (let unit = 0; unit < folded.length; unit += 1) this.#unit(folded.charCodeAt(unit), start, end);
  }

  /** A run of whitespace reads as one space, which spans all of it. */
  space(start: number, end: number): void {
    if (this.#spaced) {
      this.#ends[this.#length - 1] = end;
      return;
    }
    this.#unit(SPACE, start, end);
    this.#spaced = true;
  }

  #unit(unit: number, start: number, end: number): void {
    if (this.#length === this.#units.length) this.#grow();
    this.#units[this.#length] = unit;
    this.#starts[this.#length] = start;
    this.#ends[this.#length] = end;
    this.#length += 1;
    this.#spaced = false;
  }

  #grow(): void {
    const capacity = this.#units.length * 2;
    const units = new Uint16Array(capacity);
    const starts = new Int32Array(capacity);
    const ends = new Int32Array(capacity);
    units.set(this.#units);
    starts.set(this.#starts);
    ends.set(this.#ends);
    this.#units = units;
    this.#starts = starts;
    this.#ends = ends;
  }

  done(): SearchView {
    const parts: string[] = [];
    for (let from = 0; from < this.#length; from += 8192) {
      parts.push(String.fromCharCode(...this.#units.subarray(from, Math.min(from + 8192, this.#length))));
    }
    return { text: parts.join(''), starts: this.#starts.subarray(0, this.#length), ends: this.#ends.subarray(0, this.#length) };
  }
}

/** Text, and where each of its code units was written when that is not where it is. */
interface Written {
  text: string;
  starts?: Int32Array;
  ends?: Int32Array;
}

/** `text` with each percent escape of a UTF-8 character decoded. Other escapes stay as written. */
function percentDecoded(text: string): Written {
  if (!text.includes('%')) return { text };
  const starts = new Int32Array(text.length);
  const ends = new Int32Array(text.length);
  const parts: string[] = [];
  let length = 0;
  let from = 0;
  const keep = (to: number) => {
    parts.push(text.slice(from, to));
    for (let index = from; index < to; index += 1) {
      starts[length] = index;
      ends[length] = index + 1;
      length += 1;
    }
  };
  for (let at = text.indexOf('%'); at >= 0; at = text.indexOf('%', at)) {
    const char = percentCharAt(text, at);
    if (!char) {
      at += 1;
      continue;
    }
    keep(at);
    for (let unit = 0; unit < char.text.length; unit += 1) {
      starts[length] = at;
      ends[length] = at + char.width;
      length += 1;
    }
    parts.push(char.text);
    at += char.width;
    from = at;
  }
  keep(text.length);
  return { text: parts.join(''), starts: starts.subarray(0, length), ends: ends.subarray(0, length) };
}

/** The UTF-8 character whose percent escapes start at `at`, and how much text they take. */
function percentCharAt(text: string, at: number): { text: string; width: number } | undefined {
  const lead = hexByteAt(text, at);
  const bytes = lead < 0 ? 0 : lead < 0x80 ? 1 : lead < 0xc2 ? 0 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf5 ? 4 : 0;
  if (!bytes) return undefined;
  let point = bytes === 1 ? lead : lead & (0xff >> (bytes + 1));
  for (let index = 1; index < bytes; index += 1) {
    const next = hexByteAt(text, at + index * 3);
    if (next < 0x80 || next > 0xbf) return undefined;
    point = (point << 6) | (next & 0x3f);
  }
  // Too long a form, a surrogate, or past Unicode: not a character.
  if ((bytes === 3 && (point < 0x800 || (point >= 0xd800 && point <= 0xdfff))) ||
      (bytes === 4 && (point < 0x10000 || point > 0x10ffff))) return undefined;
  return { text: String.fromCodePoint(point), width: bytes * 3 };
}

function hexByteAt(text: string, at: number): number {
  if (text.charCodeAt(at) !== PERCENT) return -1;
  const high = hexValue(text.charCodeAt(at + 1));
  const low = hexValue(text.charCodeAt(at + 2));
  return high < 0 || low < 0 ? -1 : high * 16 + low;
}

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  return -1;
}

const NAMED_ENTITIES: ReadonlyArray<readonly [string, number]> = [['&amp;', 0x26], ['&lt;', 0x3c], ['&gt;', 0x3e]];
const NUMBERED_ENTITY = /^&#(?:[xX]([0-9A-Fa-f]{1,8})|(\d{1,10}));/;

/** Slack's escapes of `&`, `<` and `>`, and an HTML entity by number. */
function entityAt(text: string, at: number): { point: number; width: number } | undefined {
  for (const [entity, point] of NAMED_ENTITIES) {
    if (text.startsWith(entity, at)) return { point, width: entity.length };
  }
  const numbered = NUMBERED_ENTITY.exec(text.slice(at, at + 14));
  if (!numbered) return undefined;
  const point = numbered[1] ? parseInt(numbered[1], 16) : Number(numbered[2]);
  if (point < 1 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return undefined;
  return { point, width: numbered[0].length };
}

// Where a snapshot ends one node's text and starts the next, as the view reads it:
// `"`, its ref and state, a line break, `- <role> "`.
const NODE_BREAK = /" (?:\[ref=e\d+\] )?(?:(?:level=\d+|checked(?:=mixed)?|selected|expanded|disabled) )*- [a-z]+ "/g;

/** `view` without its snapshot node breaks, or undefined when it has none. */
function joined(view: SearchView): SearchView | undefined {
  const { text } = view;
  if (!text.includes('" ')) return undefined;
  const breaks = [...text.matchAll(NODE_BREAK)];
  if (breaks.length === 0) return undefined;
  const starts = new Int32Array(text.length);
  const ends = new Int32Array(text.length);
  const flags = new Uint8Array(text.length + 1);
  const parts: string[] = [];
  let length = 0;
  let from = 0;
  const keep = (to: number) => {
    parts.push(text.slice(from, to));
    starts.set(view.starts.subarray(from, to), length);
    ends.set(view.ends.subarray(from, to), length);
    length += to - from;
  };
  for (const node of breaks) {
    keep(node.index);
    flags[length] = 1;
    from = node.index + node[0].length;
  }
  keep(text.length);
  return {
    text: parts.join(''),
    starts: starts.subarray(0, length),
    ends: ends.subarray(0, length),
    breaks: flags.subarray(0, length + 1),
  };
}

// ---------------------------------------------------------------------------
// Finding usernames
// ---------------------------------------------------------------------------

const ENDS_SHORT = 1;
const ENDS_LONG = 2;
const WORD = /^[\p{L}\p{N}]$/u;
// Chinese, Japanese, Korean and Thai put no space between a word and a username beside it.
const UNSPACED_LETTER = /^[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Thai}]$/u;
/** How many steps the search takes between two reports to the budget. */
const BUDGET_STRIDE = 1 << 16;

/** Where a match starts and ends in a field's text, `[start, end)`. */
type Span = [number, number];

/**
 * Every username, read as a field is, in one Aho–Corasick automaton: a
 * field's view is read once, whatever the number of usernames, and each hit
 * is checked against the word, length and quote rules. States are numbered
 * breadth first, and each state's children are numbered together in order of
 * their character, so a step is a binary search.
 */
class UsernameIndex {
  readonly #edge: Uint16Array;
  readonly #firstChild: Int32Array;
  readonly #childCount: Int32Array;
  readonly #fail: Int32Array;
  /** The nearest state on the fail chain where a username ends; 0 for none. */
  readonly #output: Int32Array;
  readonly #depth: Int32Array;
  /** `#depth` in code points. */
  readonly #points: Int32Array;
  /** Whether a username ends here, and whether it is short. */
  readonly #ends: Uint8Array;
  readonly #wordFirst: Uint8Array;
  readonly #wordLast: Uint8Array;

  constructor(needles: readonly string[], budget: ScrubBudget) {
    const sorted = unique(needles).sort();
    const capacity = 1 + sorted.reduce((total, needle) => total + needle.length, 0);
    budget.spend(capacity);
    this.#edge = new Uint16Array(capacity);
    this.#firstChild = new Int32Array(capacity);
    this.#childCount = new Int32Array(capacity);
    this.#fail = new Int32Array(capacity);
    this.#output = new Int32Array(capacity);
    this.#depth = new Int32Array(capacity);
    this.#points = new Int32Array(capacity);
    this.#ends = new Uint8Array(capacity);
    this.#wordFirst = new Uint8Array(capacity);
    this.#wordLast = new Uint8Array(capacity);
    // Each state's needles: sorted[low, high) share its prefix.
    const low = new Int32Array(capacity);
    const high = new Int32Array(capacity);
    high[0] = sorted.length;
    let count = 1;
    for (let state = 0; state < count; state += 1) {
      const depth = this.#depth[state]!;
      let needle = low[state]!;
      // A needle that ends here sorts first among those that share its prefix.
      if (state > 0 && sorted[needle]!.length === depth) needle += 1;
      this.#firstChild[state] = count;
      while (needle < high[state]!) {
        const unit = sorted[needle]!.charCodeAt(depth);
        let end = needle + 1;
        while (end < high[state]! && sorted[end]!.charCodeAt(depth) === unit) end += 1;
        const child = count;
        count += 1;
        const text = sorted[needle]!;
        this.#edge[child] = unit;
        low[child] = needle;
        high[child] = end;
        this.#depth[child] = depth + 1;
        this.#points[child] = this.#points[state]! + (unit >= 0xdc00 && unit <= 0xdfff ? 0 : 1);
        this.#wordFirst[child] = state === 0 ? Number(isWord(text.codePointAt(0)!)) : this.#wordFirst[state]!;
        if (text.length === depth + 1) {
          this.#ends[child] = [...text].length < MIN_USERNAME_CHARS ? ENDS_SHORT : ENDS_LONG;
          this.#wordLast[child] = Number(isWord(pointBefore(text, text.length)));
        }
        // Every state nearer the root already has its children, so the fail link is complete.
        const fail = state === 0 ? 0 : this.#fallback(this.#fail[state]!, unit);
        this.#fail[child] = fail;
        this.#output[child] = this.#ends[fail] ? fail : this.#output[fail]!;
        needle = end;
      }
      this.#childCount[state] = count - this.#firstChild[state]!;
    }
  }

  /** Adds to `found`, in the field as written, where `view` holds a username or the start of one before a cut. */
  find(view: SearchView, options: { quoted: boolean; cut: boolean }, found: Span[], budget: ScrubBudget): void {
    const { text } = view;
    let state = 0;
    let steps = text.length;
    for (let at = 0; ; at += 1) {
      if (at === text.length ? options.cut : cutAt(text, at)) steps += this.#cutStart(view, state, at, found);
      if (at === text.length) break;
      const unit = text.charCodeAt(at);
      for (;;) {
        const next = this.#next(state, unit);
        if (next) {
          state = next;
          break;
        }
        if (!state) break;
        state = this.#fail[state]!;
        steps += 1;
      }
      // The longest username that holds here covers every shorter one that ends with it.
      for (let ending = this.#ends[state] ? state : this.#output[state]!; ending; ending = this.#output[ending]!) {
        steps += 1;
        if (this.#holds(view, ending, at + 1, options.quoted)) {
          found.push(written(view, at + 1 - this.#depth[ending]!, at + 1));
          break;
        }
      }
      if (steps >= BUDGET_STRIDE) {
        budget.spend(steps);
        steps = 0;
      }
    }
    budget.spend(steps);
  }

  /** The longest start of a username, at least MIN_CUT_PREFIX_CHARS long, that ends at the cut `at`. */
  #cutStart(view: SearchView, state: number, at: number, found: Span[]): number {
    let steps = 0;
    for (let prefix = state; prefix && this.#points[prefix]! >= MIN_CUT_PREFIX_CHARS; prefix = this.#fail[prefix]!) {
      steps += 1;
      const start = at - this.#depth[prefix]!;
      if (!this.#wordFirst[prefix] || !wordBefore(view, start)) {
        found.push(written(view, start, at));
        break;
      }
    }
    return steps;
  }

  #holds(view: SearchView, state: number, end: number, quoted: boolean): boolean {
    const start = end - this.#depth[state]!;
    if (this.#ends[state] === ENDS_SHORT) {
      return quoted && view.text.charCodeAt(start - 1) === QUOTE && view.text.charCodeAt(end) === QUOTE;
    }
    return (!this.#wordFirst[state] || !wordBefore(view, start)) && (!this.#wordLast[state] || !wordAfter(view, end));
  }

  #fallback(state: number, unit: number): number {
    for (let from = state; ; from = this.#fail[from]!) {
      const next = this.#next(from, unit);
      if (next || !from) return next;
    }
  }

  /** The child of `state` along `unit`, or 0. */
  #next(state: number, unit: number): number {
    let low = this.#firstChild[state]!;
    let high = low + this.#childCount[state]! - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const edge = this.#edge[middle]!;
      if (edge === unit) return middle;
      if (edge < unit) low = middle + 1;
      else high = middle - 1;
    }
    return 0;
  }
}

/** Whether a username's start can end at `at`: a `…` or `...` follows it, after a space at most. */
function cutAt(text: string, at: number): boolean {
  const mark = text.charCodeAt(at) === SPACE ? at + 1 : at;
  return text.startsWith(CUT_MARK, mark) || text.startsWith(THREE_DOTS, mark);
}

/** Whether a word goes on across `at` from before it: not at a snapshot node break, nor beside an unspaced letter. */
function wordBefore(view: SearchView, at: number): boolean {
  if (at === 0 || view.breaks?.[at]) return false;
  const point = pointBefore(view.text, at);
  return isWord(point) && !isUnspaced(point);
}

function wordAfter(view: SearchView, at: number): boolean {
  if (at === view.text.length || view.breaks?.[at]) return false;
  const point = view.text.codePointAt(at)!;
  return isWord(point) && !isUnspaced(point);
}

function pointBefore(text: string, at: number): number {
  const unit = text.charCodeAt(at - 1);
  if (unit >= 0xdc00 && unit <= 0xdfff && at >= 2) {
    const high = text.charCodeAt(at - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.codePointAt(at - 2)!;
  }
  return unit;
}

function isWord(point: number): boolean {
  if (point < 0x80) return (point >= 0x30 && point <= 0x39) || (point >= 0x41 && point <= 0x5a) || (point >= 0x61 && point <= 0x7a);
  return WORD.test(String.fromCodePoint(point));
}

function isUnspaced(point: number): boolean {
  return point >= 0x80 && UNSPACED_LETTER.test(String.fromCodePoint(point));
}

/** Where `[start, end)` of a view was written. */
function written(view: Written, start: number, end: number): Span {
  return view.starts && view.ends ? [view.starts[start]!, view.ends[end - 1]!] : [start, end];
}

/** `text` with each span replaced; spans that overlap are replaced once, together. */
function replaceSpans(text: string, spans: Span[], replacement: string): string {
  const merged: Span[] = [];
  for (const [start, end] of spans.sort(([left], [right]) => left - right)) {
    const last = merged.at(-1);
    if (last && start < last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let result = '';
  let from = 0;
  for (const [start, end] of merged) {
    result += `${text.slice(from, start)}${replacement}`;
    from = end;
  }
  return result + text.slice(from);
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
