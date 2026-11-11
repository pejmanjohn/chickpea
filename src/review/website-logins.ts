/**
 * What a copy keeps of a run that may have browsed signed in. Signed-in page
 * content is kept like any other content. The installation's saved website
 * login usernames, the links that can carry a session or a sign-in token, and
 * every link to the hosted browser itself are not.
 *
 * No pattern here is built from a saved login or from a record's text. The
 * link rules are fixed patterns that look each host up, and usernames are
 * found by literal search, so no value can make a pattern backtrack or
 * compile without bound. The work one copy's scrub does is counted, and a
 * copy past its budget, or past the caps on its logins, is not kept.
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

// A URL ends at whitespace, a double quote, Slack's `<` and `>`, or a backslash. A page's address keeps `'`
// and `|` as they are, so neither ends one, and a Slack link's label goes with its URL.
const URL_CHAR = String.raw`[^\s"<>\\]`;
// The JSON escape of `&`, `'`, `+` or `=` does not end a URL: Go, Gson and .NET write them that way.
const ESCAPED_ASCII = String.raw`\\+u00(?:26|27|2[bB]|3[dD])`;
// A slash, which JSON may escape with a backslash: PHP does by default.
const SLASH = String.raw`\\*\/`;
// Not inside a word, an email address or a path. A protocol-relative `//` may come before it.
const HOST_START = String.raw`(?<![\p{L}\p{N}.@_-])(?<!(?:^|[^/])\/)`;
// A host as a link writes one: a name or a bracketed IP address.
const READABLE_HOST = /^(?:[\p{L}\p{N}.-]+|\[[\da-f:.]+\])$/iu;

const MORE_URL = String.raw`${URL_CHAR}*(?:(?:${ESCAPED_ASCII}|\\+\/)${URL_CHAR}*)*`;
const SCHEME_URL = String.raw`\b(?:https?|wss?):${SLASH}${SLASH}${URL_CHAR}${MORE_URL}`;
// What follows a scheme-less host, which may end in a dot: a port, then a path or a query.
const AFTER_HOST = String.raw`\.?(?::\d+)?(?:${SLASH}${MORE_URL}|[;?#]${URL_CHAR}${MORE_URL})`;
// Any host followed by a path or a query, as a browser step's input may name a page.
const ANY_SCHEMELESS_URL = String.raw`${HOST_START}(?:[a-z0-9-]+\.)+[a-z]{2,}${AFTER_HOST}`;
// Outside a browser step, a link without a scheme counts on a login's site or the hosted browser's. Any
// host a link could follow is read, and only its host: it is looked up before the rest of its link is
// read, so a field of hosts on no login's site costs one reading.
const SCHEMELESS_HOST = String.raw`${HOST_START}(?<host>(?:[\p{L}\p{N}-]+\.)*[\p{L}\p{N}-]+|\[[\da-f:.]+\])` +
  String.raw`(?=\.?(?::\d+)?(?:${SLASH}|[;?#]${URL_CHAR}))`;
const LINKS_ANYWHERE = `${SCHEME_URL}|${SCHEMELESS_HOST}`;
const LINKS_IN_BROWSER_STEP = `${SCHEME_URL}|${ANY_SCHEMELESS_URL}`;
/** The rest of a scheme-less link on a login's site, from the end of its host. */
const REST_OF_LINK = new RegExp(AFTER_HOST, 'yiu');

const HANDOFF_LINK = new RegExp(String.raw`<([^<>|]*)\|${escapeRegExp(BROWSER_HANDOFF_LINK_LABEL)}>`, 'g');
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
   * `?` or `#`. So does a URL whose host cannot be read as one, and its host
   * goes too. A link inside
   * another one's path or query, as a Slack link's label or a redirect holds
   * it, goes by its own rule.
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
  const hostnames = new Set(logins.hosts.map((host) => host.trim().toLowerCase().replace(/:\d+$/, '')).filter(Boolean));
  const names = unique(logins.usernames.map((username) => username.trim()).filter(Boolean));
  if (hostnames.size > MAX_SCRUB_LOGINS || names.length > MAX_SCRUB_LOGINS ||
      names.some((name) => name.length > MAX_SCRUB_USERNAME_CHARS)) {
    throw new RunReviewScrubLimit('scrub_over_logins');
  }
  // The site itself or any host under it.
  const loginSite = (hostname: string): boolean => {
    for (let at = 0; ; at += 1) {
      if (hostnames.has(hostname.slice(at))) return true;
      at = hostname.indexOf('.', at);
      if (at < 0) return false;
    }
  };

  const scrubLinks = (text: string, browserStep: boolean): string => {
    budget.spend(text.length);
    const pattern = new RegExp(browserStep ? LINKS_IN_BROWSER_STEP : LINKS_ANYWHERE, 'giu');
    let result = '';
    let from = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      let link = match[0];
      const host = match.groups?.host;
      if (host !== undefined) {
        const hostname = host.toLowerCase();
        // Not a link this rule reads: reading goes on after its host, where another link may start.
        if (!loginSite(hostname) && !browserbaseHost(hostname)) continue;
        REST_OF_LINK.lastIndex = match.index + host.length;
        link += REST_OF_LINK.exec(text)![0];
      }
      result += `${text.slice(from, match.index)}${scrubLink(link, browserStep)}`;
      from = match.index + link.length;
      pattern.lastIndex = from;
    }
    return result + text.slice(from);
  };

  const scrubLink = (matched: string, browserStep: boolean): string => {
    // A plain slash is valid JSON too, so the link comes back without its escapes.
    const raw = matched.replace(/\\+\//g, '/');
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
    const afterScheme = scheme ? raw.slice(scheme[0].length) : raw;
    // Userinfo, which no link keeps, ends at the last `@` before the path, whatever it holds.
    const authorityEnd = afterScheme.search(/[/?#]/);
    const authority = authorityEnd < 0 ? afterScheme : afterScheme.slice(0, authorityEnd);
    const hostAndRest = afterScheme.slice(authority.lastIndexOf('@') + 1);
    // `;` and `|` end a host too: no host holds one, and a Slack link's label may follow `|`.
    const hostEnd = hostAndRest.search(/[/;?#|]/);
    const host = hostEnd < 0 ? hostAndRest : hostAndRest.slice(0, hostEnd);
    const rest = hostEnd < 0 ? '' : hostAndRest.slice(hostEnd);
    // `host.example.` names the same site as `host.example`.
    const hostname = host.replace(/:\d*$/, '').replace(/\.+$/, '').toLowerCase();
    const readable = READABLE_HOST.test(hostname);
    const pathEnd = rest.search(/[;?#]/);
    const path = pathEnd < 0 ? rest : rest.slice(0, pathEnd);
    const suffix = pathEnd < 0 ? '' : rest.slice(pathEnd);
    if (browserLink(scheme?.[1], hostname, path, suffix)) return BROWSER_LINK_OMITTED;
    // A host that cannot be read as one may hide a login's site or a token, so it goes, and its link goes by the login rule.
    const start = `${scheme?.[0] ?? ''}${readable ? host : URL_PART_OMITTED}`;
    // What follows the host can hold another link, as a Slack link's label or a redirect's query does.
    if (!browserStep && readable && !loginSite(hostname)) {
      return `${start}${scrubLinks(rest, browserStep)}`;
    }
    const kept = path.split('/').map((segment) => tokenShaped(segment) ? URL_PART_OMITTED : segment).join('/');
    return `${start}${scrubLinks(kept, browserStep)}${suffix ? `?${URL_PART_OMITTED}` : ''}`;
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
      // A thread context row lists a message's links again under its text, unescaped (slack/rich-text-links.ts).
      // Anyone can write the label, so only a whole URL counts, and only where it stands alone: a
      // replacement inside other text would break up a URL or a username before its own rule saw it.
      const handoffs = new Set([...text.matchAll(HANDOFF_LINK)]
        .flatMap(([, url]) => url ? [url, unescapedSlackText(url)] : [])
        .filter((url) => HANDOFF_URL.test(url)));
      const linked = text.replace(HANDOFF_LINK, BROWSER_LINK_OMITTED);
      const withoutHandoffs = handoffs.size === 0 ? linked : linked.replace(URL_RUN, (run, at: number, whole: string) =>
        handoffs.has(run) && (at === 0 || BEFORE_URL_RUN.test(whole[at - 1]!)) &&
          (at + run.length === whole.length || AFTER_URL_RUN.test(whole[at + run.length]!))
          ? BROWSER_LINK_OMITTED
          : run);
      return scrubLinks(withoutHandoffs, browserStep);
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
      return found.length ? replaceSpans(text, found) : text;
    },
    spend: (steps) => budget.spend(steps),
  };
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
function written(view: SearchView, start: number, end: number): Span {
  return [view.starts[start]!, view.ends[end - 1]!];
}

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

function unescapedSlackText(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
