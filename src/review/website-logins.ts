/**
 * What a copy keeps of a run that may have browsed signed in. Signed-in page
 * content is kept like any other content. The installation's saved website
 * login usernames, the links that can carry a session or a sign-in token, and
 * every link to the hosted browser itself are not.
 *
 * No pattern here is built from a saved login or from a record's text. The
 * link rules are fixed patterns that look each host up, and usernames are
 * found by literal search, so no value can make a pattern backtrack or
 * compile without bound. Each rule reads a view of a field with its JSON
 * escapes, HTML character references and percent escapes decoded, however
 * they nest, and maps what it finds back to where it was written. The
 * work one copy's scrub does is counted, and a copy past its budget, or past
 * the caps on its logins, is not kept.
 */

import { BROWSER_HANDOFF_LINK_LABEL } from '../browser/requester.ts';
import { CREDENTIAL_REPLACEMENT } from '../security/content-validation.ts';
import { htmlNamedReference } from './html-references.ts';

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
 * A copy at the record cap with 500 saved usernames takes at most about a fifth of it.
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

// The link rules read a field's link view (see linkView below): its escapes decoded, then NFKC without
// default-ignorable code points. So no pattern here reads an escape.

// A URL ends at whitespace, a double quote, Slack's `<` and `>`, or a backslash. A page's address keeps `'`
// and `|` as they are, so neither ends one, and a Slack link's label goes with its URL.
const URL_CHAR = String.raw`[^\s"<>\\]`;
// A dot between a host's labels. A URL reads the ideographic full stop and its halfwidth form as one too.
const DOT = String.raw`[.\u3002\uFF0E\uFF61]`;
// A character of a host's label: a letter in any script, a mark that goes with one, a digit, a hyphen or a percent escape.
const LABEL_CHAR = String.raw`(?:[\p{L}\p{M}\p{N}-]|%[\da-f]{2})`;
// Not inside a word, a percent escape or a path. A protocol-relative `//` may come right before it, and so may an `@`,
// as written or as percent decoding wrote it, though a host behind one starts a link only in an authority behind `//`
// (see authorityStart), not in an email address.
const HOST_START = String.raw`(?<![\p{L}\p{M}\p{N}.\u3002\uFF0E\uFF61_-])(?!(?<=%)[\da-f]{2})(?<!(?:^|[^/])\/)`;
// A name whose top-level label is letters, or the ASCII form of a name in another script.
const NAME = String.raw`(?:${LABEL_CHAR}+${DOT})+(?:\p{L}[\p{L}\p{M}]+|xn--[a-z\d-]+)`;
// A host as a link writes one: a name or a bracketed IP address.
const READABLE_HOST = /^(?:[\p{L}\p{M}\p{N}.-]+|\[[\da-f:.]+\])$/iu;

// A `/` and a `;`, `?` or `#`, each as written or as the stand-in percent decoding wrote (see withStandIns). Only a
// scheme's `//` and the end of a host read them either way: no host holds one, and an address percent-encoded whole
// is still one address. Past its host, the stand-in is the address's data, and so it is in its userinfo (see linkHost).
const SLASH = String.raw`[/\u{F002F}]`;
const HOST_END_MARK = String.raw`[;?#\u{F003B}\u{F003F}\u{F0023}]`;
const SCHEME_URL = String.raw`\b(?:https?|wss?):${SLASH}{2}${URL_CHAR}+`;
// What follows a scheme-less host, which may end in a dot: a port, then a path or a query.
const AFTER_HOST = String.raw`${DOT}?(?::\d+)?(?:${SLASH}${URL_CHAR}*|${HOST_END_MARK}${URL_CHAR}+)`;
// Any host a link without a scheme could follow. Only its host is read: it is looked up before the rest of its
// link is read, so a field of hosts that start no link costs one reading.
const SCHEMELESS_HOST = String.raw`${HOST_START}(?<host>(?:${LABEL_CHAR}+${DOT})*${LABEL_CHAR}+|\[[\da-f:.]+\])` +
  String.raw`(?=${DOT}?(?::\d+)?(?:${SLASH}|${HOST_END_MARK}${URL_CHAR}))`;
const SCHEME = new RegExp(String.raw`^([a-z][a-z0-9+.-]*):${SLASH}{2}`, 'iu');
// The end of an authority as written, and as percent decoding wrote it, and what ends a userinfo either way.
const AUTHORITY_END = /[/?#]/;
const DECODED_AUTHORITY_END = /[\u{F002F}\u{F003F}\u{F0023}]/u;
const AT_SIGNS = /[@\u{F0040}]/gu;
// `;` and `|` end a host too: no host holds one, and a Slack link's label may follow `|`.
const HOST_END = new RegExp(String.raw`${SLASH}|${HOST_END_MARK}|\|`, 'gu');
const LINKS = `${SCHEME_URL}|${SCHEMELESS_HOST}`;
// What opens an authority without a scheme: `//`, as written or as percent decoding wrote it, which opens one only
// where none is open. Anything else that ends a link, and a `/`, `?` or `#` as written, closes it.
const AUTHORITY_MARKS = /(?<open>\/{2,})|(?<encoded>\u{F002F}{2,})|[\s"<>\\/?#]/gu;
// An `@` percent decoding wrote, as its stand-in (see withStandIns).
const ENCODED_AT_SIGN = '\u{F0040}';
/** The rest of a scheme-less link, from the end of its host. */
const REST_OF_LINK = new RegExp(AFTER_HOST, 'yiu');
/** A name no URL can read: it may hide a login's site, so its link goes by the login rule. */
const UNREADABLE_NAME = new RegExp(`^${NAME}$`, 'iu');
/**
 * A host a page's address may have, which starts a link without a scheme anywhere in a browser step: a name,
 * an IPv4 address in four decimal parts, or a bracketed IPv6 address.
 */
const BROWSER_STEP_HOST = new RegExp(String.raw`^(?:${NAME}|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:.]+\])$`, 'iu');

// The hand-off label, each of its spaces written as one, as a form's `+`, or percent-encoded, which the link view
// reads as a stand-in (see withStandIns); and Slack's brackets around a link, as written or percent-encoded.
const HANDOFF_LABEL_TEXT = escapeRegExp(BROWSER_HANDOFF_LINK_LABEL).replace(/ /g, String.raw`[ +\u{F0020}]`);
const HANDOFF_LINK = new RegExp(String.raw`[<\u{F003C}]([^<>|\u{F003C}\u{F003E}]*)\|${HANDOFF_LABEL_TEXT}[>\u{F003E}]`, 'gu');
const HANDOFF_LABEL = new RegExp(String.raw`\|${HANDOFF_LABEL_TEXT}[>\u{F003E}]`, 'u');
/** What a hand-off message links to: an absolute web address, too long to be a word of other text. */
const HANDOFF_URL = new RegExp(String.raw`^https?:${SLASH}{2}[^\s<>|"\\]{8,}$`, 'iu');
const NO_HANDOFFS: ReadonlySet<string> = new Set();

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

/**
 * A saved site as the scrub compares it: without one leading `www.` label,
 * which a browser's address bar hides, unless that would leave one label.
 * Any host under what is left counts as the site (see loginSite).
 */
function withoutWww(site: string): string {
  return /^www\.[^.]+\./.test(site) ? site.slice(4) : site;
}

// A path segment a site is unlikely to take as a bearer: a word of up to 20 letters.
const PLAIN_SEGMENT = /^[A-Za-z]{1,20}$/;
// What a sentence may put right after a link.
const SENTENCE_MARKS = '.,!)\'';

/**
 * The path of a link on a login's site, or of any link in a browser step,
 * with each segment omitted that is not a word of up to 20 letters. Any
 * other segment, a number, an ID or a slug as much as a token, may be what
 * the site takes as its sign-in bearer. Only a `/` as written divides one: a
 * `/` percent decoding wrote is a stand-in (see withStandIns), so
 * `abc%2Fdef` is the one segment a site's server decodes it to, and goes.
 */
function plainPath(path: string): string {
  return path.split('/').map((segment) => segment === '' || PLAIN_SEGMENT.test(segment) ? segment : URL_PART_OMITTED).join('/');
}

/**
 * A link's host with its port, where it ends, and the hostname a URL gives it. It is readable where a URL reads it
 * and a link can write it as it is.
 */
type LinkHost = { host: string; end: number } & ({ readable: true; hostname: string } | { readable: false; hostname: string | undefined });

export interface WebsiteLoginScrub {
  /**
   * Link rules, on text no other rule has changed: a replacement that holds a
   * space would end a URL early and leave the rest of it. They read the text
   * with its escapes decoded (see `decoded`), in NFKC without default-ignorable
   * code points. A link they rewrite comes back as they read it, and one they
   * leave stays as it was written. A hosted browser link goes whole, and so
   * do a hand-off message's link and every link in the same text that holds
   * its URL. Every URL loses its userinfo: everything before the last `@` of
   * its authority, which ends at the first `/`, `?` or `#` as written. One of
   * them, or an `@`, that percent decoding wrote is the userinfo's data, unless
   * the link reads only as an address encoded once more (see linkHost). A host
   * is a login's site when the
   * hostname a URL gives it is that site without one leading `www.`, or any
   * host under it, whatever script, encoding or IPv4 spelling it is written
   * in. A link without a scheme
   * counts on a login's site or the hosted browser's, or on a name no URL can
   * read; in a browser step, on any name, any IPv4 address in four decimal
   * parts and any bracketed IPv6 address too. Behind `//` and a userinfo, as
   * written or percent-encoded, it counts on any site, and starts where its
   * userinfo does; behind an email address's `@` it does not start. A URL on a login's site, or any
   * URL in a browser step, keeps its scheme and host, keeps a path segment
   * only where it is a word of up to 20 letters (so its numbers, IDs and
   * slugs go too), and loses everything from its first `;`, `?` or `#`. One
   * that percent decoding wrote is the address's data past its host, so a
   * segment that holds it goes whole. So does a URL whose host cannot be read
   * as one, and its host goes too. Only
   * the marks a sentence puts right after the whole URL stay. In Slack's
   * `<url|label>` outside a browser step, the label after the first `|`
   * before the query is text, and goes by these rules as any text does.
   * Elsewhere a link inside another one's path or query, as a Slack link's
   * label or a redirect holds it, goes by its own rule.
   */
  links(text: string, browserStep: boolean): string;
  /**
   * Each saved username, in any case, as typed, snapshot-escaped, with its
   * JSON escapes, HTML character references and percent or form encoding
   * however they nest (see `decoded`), with any run of whitespace for its
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
  const maps = new ViewMaps();
  const hostnames = new Set(logins.hosts.map((host) => {
    const site = host.trim().replace(/:\d+$/, '');
    return withoutWww(asciiHost(site) ?? site.toLowerCase());
  }).filter(Boolean));
  const names = unique(logins.usernames.map((username) => username.trim()).filter(Boolean));
  if (hostnames.size > MAX_SCRUB_LOGINS || names.length > MAX_SCRUB_LOGINS ||
      names.some((name) => name.length > MAX_SCRUB_USERNAME_CHARS)) {
    throw new RunReviewScrubLimit('scrub_over_logins');
  }
  const longestSite = Math.max(0, ...[...hostnames].map((site) => site.length));
  // The site itself or any host under it, each in its ASCII form and the site without one leading `www.`. So a
  // link with `www.` or without it, as an address bar shows it, counts, and so does `accounts.` or `login.` before
  // the site. A suffix longer than every site is none of them, so a long host is read only from where one could start.
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

  // Whether a link holds a hand-off URL, as written or percent-encoded. Looking for each URL reads the link once.
  const holdsHandoff = (link: string, handoffs: ReadonlySet<string>): boolean => {
    budget.spend(handoffs.size * link.length);
    const read = standingForEach(link);
    for (const url of handoffs) if (read.includes(url)) return true;
    return false;
  };

  // Whether a host without a scheme starts a link: one on a login's site or the hosted browser's, or a name no URL
  // can read, which may hide either. In a browser step any host a page's address may have starts one.
  const startsLink = (host: string, browserStep: boolean): boolean => {
    if (browserStep && BROWSER_STEP_HOST.test(host)) return true;
    const hostname = readHost(host);
    return hostname === undefined ? UNREADABLE_NAME.test(host) : loginSite(hostname) || browserbaseHost(hostname);
  };

  /**
   * `source` with each link its view holds rewritten. A link the rules change goes back where it was written, read
   * as the view reads it; one they leave stays as written. `handoffs` are the field's hand-off URLs.
   */
  const scrubLinks = (source: string, view: Written, browserStep: boolean, handoffs: ReadonlySet<string>): string => {
    const { text } = view;
    budget.spend(text.length);
    const pattern = new RegExp(LINKS, 'giu');
    // Where the authority behind the last `//` read starts, or -1 where none is open, and the next mark after it.
    let authority = -1;
    let read = 0;
    let mark: RegExpExecArray | null | undefined;
    /** The start of the authority without a scheme that `at` is in, or -1. Each mark is read once. */
    const authorityStart = (at: number): number => {
      for (;;) {
        if (mark === undefined) {
          AUTHORITY_MARKS.lastIndex = read;
          mark = AUTHORITY_MARKS.exec(text);
        }
        if (!mark || mark.index >= at) return authority;
        read = mark.index + mark[0].length;
        if (mark.groups?.open !== undefined || (mark.groups?.encoded !== undefined && authority < 0)) authority = read;
        else if (mark.groups?.encoded === undefined) authority = -1;
        mark = undefined;
      }
    };
    let result = '';
    let from = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      let at = match.index;
      let link = match[0];
      const host = match.groups?.host;
      if (host !== undefined) {
        // A host behind an `@` is an email address's, or a path's, but in an authority behind `//` it starts a link
        // whatever site it is: its userinfo starts the link, and goes.
        if (text[at - 1] === '@' || text.endsWith(ENCODED_AT_SIGN, at)) {
          at = authorityStart(at);
          if (at < 0) continue;
        } else if (!startsLink(host, browserStep)) {
          // Not a link this rule reads: reading goes on after its host, where another link may start.
          continue;
        }
        REST_OF_LINK.lastIndex = match.index + host.length;
        link = text.slice(at, match.index) + link + REST_OF_LINK.exec(text)![0];
      }
      // Slack writes a link as `<url|label>`. A browser step holds a page's text, not Slack's.
      const slackLink = !browserStep && text[at - 1] === '<';
      const rewritten = scrubLink(link, browserStep, slackLink, handoffs);
      pattern.lastIndex = at + link.length;
      if (rewritten === link) continue;
      const [start, end] = written(view, at, at + link.length);
      result += `${source.slice(from, Math.max(from, start))}${withoutStandIns(rewritten)}`;
      from = Math.max(from, end);
    }
    return result + source.slice(from);
  };
  /** Links inside a link the view already read. */
  const scrubRead = (text: string, browserStep: boolean, handoffs: ReadonlySet<string>): string =>
    scrubLinks(text, { text }, browserStep, handoffs);

  /** The host that starts at `start` of what follows a link's scheme, with its port. */
  const hostAt = (afterScheme: string, start: number): LinkHost => {
    HOST_END.lastIndex = start;
    const end = HOST_END.exec(afterScheme)?.index ?? afterScheme.length;
    const host = afterScheme.slice(start, end);
    const name = host.replace(/:\d*$/, '');
    const hostname = readHost(name);
    return hostname !== undefined && READABLE_HOST.test(name)
      ? { host, end, readable: true, hostname }
      : { host, end, readable: false, hostname };
  };

  /**
   * The host of a link, given what follows its scheme. Everything before it is userinfo, which no link keeps,
   * whatever it holds. A link whose `//` is written reads as a URL reads it: its authority ends at the first `/`, `?`
   * or `#` as written, and its host follows the last `@` as written. One percent decoding wrote is the userinfo's
   * data, as a URL's setters write a username or a password.
   *
   * A link reads otherwise where it may be an address percent-encoded once more: one without a scheme, one whose
   * `//` decoding wrote, and one whose host would end at a `/`, `?`, `#` or `;` decoding wrote, which no URL reads
   * as written. Its authority may end at any `/`, `?` or `#` decoding wrote, and its userinfo at any `@`, and an
   * `@` may follow in its path, as an email address there writes one. So it is read from the first host it can
   * have that is a login site or the hosted browser's, or that no URL can read and may hide either, and otherwise
   * from the one after its last `@`.
   */
  const linkHost = (afterScheme: string, writtenScheme: boolean): LinkHost => {
    const authorityEnd = afterScheme.search(AUTHORITY_END);
    const authority = authorityEnd < 0 ? afterScheme : afterScheme.slice(0, authorityEnd);
    if (writtenScheme) {
      const written = hostAt(afterScheme, authority.lastIndexOf('@') + 1);
      const next = afterScheme.codePointAt(written.end);
      if (next === undefined || next < STAND_IN) return written;
    }
    // A host starts the authority or follows an `@`, and the authority can end after it only before the next `@`.
    let from = 0;
    AT_SIGNS.lastIndex = 0;
    for (let sign = AT_SIGNS.exec(authority); sign; sign = AT_SIGNS.exec(authority)) {
      if (DECODED_AUTHORITY_END.test(authority.slice(from, sign.index))) {
        const read = hostAt(afterScheme, from);
        if (!read.readable || loginSite(read.hostname) || browserbaseHost(read.hostname)) return read;
      }
      from = sign.index + sign[0].length;
    }
    return hostAt(afterScheme, from);
  };

  const scrubLink = (link: string, browserStep: boolean, slackLink: boolean, handoffs: ReadonlySet<string>): string => {
    const scheme = SCHEME.exec(link);
    const afterScheme = scheme ? link.slice(scheme[0].length) : link;
    const { host, end: hostEnd, readable, hostname } = linkHost(afterScheme, scheme?.[0].endsWith('//') === true);
    const rest = afterScheme.slice(hostEnd);
    // A `;`, `?` or `#` as written starts the query. One percent decoding wrote is the path's data.
    const pathEnd = rest.search(/[;?#]/);
    const path = pathEnd < 0 ? rest : rest.slice(0, pathEnd);
    // A hosted browser's link has its shape in any encoding, so it is read with every stand-in as its character.
    const decodedRest = standingForEach(rest);
    const decodedEnd = decodedRest.search(/[;?#]/);
    if (browserLink(scheme?.[1], hostname ?? '', decodedEnd < 0 ? decodedRest : decodedRest.slice(0, decodedEnd),
      decodedEnd < 0 ? '' : decodedRest.slice(decodedEnd))) return BROWSER_LINK_OMITTED;
    if (handoffs.size && holdsHandoff(link, handoffs)) return BROWSER_LINK_OMITTED;
    // A host that cannot be read as one may hide a login's site or a token, so it goes, and its link goes by the login rule.
    const start = `${scheme?.[0] ?? ''}${readable ? host : URL_PART_OMITTED}`;
    // What follows the host can hold another link, as a Slack link's label or a redirect's query does.
    if (!browserStep && readable && !loginSite(hostname)) {
      return `${start}${scrubRead(rest, browserStep, handoffs)}`;
    }
    budget.spend(rest.length);
    const label = slackLink ? path.indexOf('|') : -1;
    if (label >= 0) return `${start}${plainPath(path.slice(0, label))}|${scrubRead(rest.slice(label + 1), false, handoffs)}`;
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
      searchView(decoded(name, maps, budget)).text.trim(),
      searchView({ text: name }).text.trim(),
      ...(local !== undefined && !named.has(local) ? [searchView(decoded(local, maps, budget)).text.trim()] : []),
    ];
  }).filter(Boolean);
  const index = needles.length ? new UsernameIndex(needles, budget) : undefined;

  return {
    links(text, browserStep) {
      budget.spend(text.length);
      const view = linkView(text, maps, budget);
      if (!HANDOFF_LABEL.test(view.text)) return scrubLinks(text, view, browserStep, NO_HANDOFFS);
      const handedOff = withoutHandoffs(text, view);
      budget.spend(handedOff.text.length);
      return scrubLinks(handedOff.text, linkView(handedOff.text, maps, budget), browserStep, handedOff.urls);
    },
    usernames(text, { browserStep, cut }) {
      if (!index) return text;
      budget.spend(text.length);
      const view = searchView(decoded(text, maps, budget));
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
// Reading a field with its escapes decoded
// ---------------------------------------------------------------------------

/** Text, and where each of its code units was written when that is not where it is. */
interface Written {
  text: string;
  starts?: Int32Array;
  ends?: Int32Array;
  /** 1 where percent decoding wrote a code unit, or wrote part of the escape that did. */
  percent?: Uint8Array;
}

/** Where one pass over a field writes its view's maps. */
interface MapBuffers {
  starts: Int32Array;
  ends: Int32Array;
  percent: Uint8Array;
}

/**
 * The two sets of maps a field's views write into in turn, each pass into
 * the set the view it reads does not use. A copy reuses them field after
 * field, so a view lasts until the pass after the next one.
 */
class ViewMaps {
  readonly #sets: readonly [MapBuffers, MapBuffers] = [
    { starts: new Int32Array(0), ends: new Int32Array(0), percent: new Uint8Array(0) },
    { starts: new Int32Array(0), ends: new Int32Array(0), percent: new Uint8Array(0) },
  ];

  /** Where a pass that reads `view` writes. */
  for(view: Written): MapBuffers {
    const [first, second] = this.#sets;
    return view.starts?.buffer === first.starts.buffer ? second : first;
  }
}

/**
 * The most passes that decode one field: an address percent-encoded three
 * times over, inside one more encoding of any kind.
 */
const DECODE_PASSES = 4;
const ESCAPE_START = /[\\&%]/;
const ESCAPE_STARTS = /[\\&%]/g;

/**
 * `written` with its escapes decoded, each code unit mapped to where it was
 * written. One pass decodes every JSON escape, HTML character reference and
 * percent escape of a UTF-8 character the text holds. A pass that decodes
 * any is repeated, up to DECODE_PASSES, so text one serializer wrote inside
 * another's reads as it was first written, whatever the order: JSON in HTML,
 * HTML in JSON, either in a percent-encoded address, or an address
 * percent-encoded again (`%253A`). A form's `+` stays; the username search
 * reads it as a space, and the hand-off rule reads its label with either.
 */
function decoded(written: string, maps: ViewMaps, budget: ScrubBudget): Written {
  let view: Written = { text: written };
  for (let pass = 0; pass < DECODE_PASSES && ESCAPE_START.test(view.text); pass += 1) {
    budget.spend(view.text.length);
    const next = decodedOnce(view, maps.for(view));
    if (!next) break;
    view = next;
  }
  return view;
}

/** `view` with each escape it holds decoded, or undefined when none reads as other than it is written. */
function decodedOnce(view: Written, buffers: MapBuffers): Written | undefined {
  const { text } = view;
  let out: WrittenText | undefined;
  let from = 0;
  ESCAPE_STARTS.lastIndex = 0;
  for (let match = ESCAPE_STARTS.exec(text); match; match = ESCAPE_STARTS.exec(text)) {
    const at = match.index;
    const escape = escapeAt(text, at);
    if (!escape) continue;
    ESCAPE_STARTS.lastIndex = escape.end;
    if (escape.end === at + 1 && escape.text === text[at]) continue;
    out ??= new WrittenText(text.length, buffers);
    out.copy(view, from, at);
    out.push(escape.text, view, at, escape.end, escape.percent);
    from = escape.end;
  }
  if (!out) return undefined;
  out.copy(view, from, text.length);
  return out.done();
}

/** What an escape that starts at `at` writes, and where it ends. */
interface Escape {
  text: string;
  end: number;
  percent?: boolean;
}

function escapeAt(text: string, at: number): Escape | undefined {
  const code = text.charCodeAt(at);
  if (code === BACKSLASH) return jsonEscapeAt(text, at);
  if (code === AMPERSAND) return referenceAt(text, at);
  return percentEscapeAt(text, at);
}

// What a JSON escape other than `\uXXXX` writes.
const JSON_ESCAPED: ReadonlyMap<number, string> = new Map([
  [0x22, '"'], [0x2f, '/'], [0x62, '\b'], [0x66, '\f'], [0x6e, '\n'], [0x72, '\r'], [0x74, '\t'],
]);

/**
 * A JSON escape behind any run of backslashes, which reads as that one
 * escape, as a field escaped again writes it. A run before no escape reads as
 * one backslash. JSON writes a character past U+FFFF as an escape of each
 * half of its pair, so each half reads on its own and joins the other there.
 */
function jsonEscapeAt(text: string, at: number): Escape {
  const unicodeEnd = unicodeEscapeEnd(text, at);
  if (unicodeEnd >= 0) return { text: String.fromCharCode(escapedUnit(text, unicodeEnd)), end: unicodeEnd };
  let next = at + 1;
  while (text.charCodeAt(next) === BACKSLASH) next += 1;
  const escaped = JSON_ESCAPED.get(text.charCodeAt(next));
  return escaped === undefined ? { text: '\\', end: next } : { text: escaped, end: next + 1 };
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

const NUMBERED_REFERENCE = /&#(?:[xX]([\da-fA-F]{1,8})|(\d{1,10}));/y;
// The longest name HTML gives a character, `CounterClockwiseContourIntegral`, has 31 letters.
const NAMED_REFERENCE = /&([A-Za-z][A-Za-z\d]{1,30});/y;

/**
 * An HTML character reference by number, or by any name HTML gives one,
 * with the semicolon every serializer writes. Slack's `&amp;`, `&lt;` and
 * `&gt;` are among them.
 */
function referenceAt(text: string, at: number): Escape | undefined {
  NUMBERED_REFERENCE.lastIndex = at;
  const numbered = NUMBERED_REFERENCE.exec(text);
  if (numbered) {
    const point = numbered[1] ? parseInt(numbered[1], 16) : Number(numbered[2]);
    if (point < 1 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return undefined;
    return { text: String.fromCodePoint(point), end: at + numbered[0].length };
  }
  NAMED_REFERENCE.lastIndex = at;
  const named = NAMED_REFERENCE.exec(text);
  const characters = named ? htmlNamedReference(named[1]!) : undefined;
  return characters === undefined ? undefined : { text: characters, end: at + named![0].length };
}

/** The UTF-8 character whose percent escapes start at `at`. Escapes of no character stay as written. */
function percentEscapeAt(text: string, at: number): Escape | undefined {
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
  return { text: String.fromCodePoint(point), end: at + bytes * 3, percent: true };
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

// ---------------------------------------------------------------------------
// Reading a field as the link rules do
// ---------------------------------------------------------------------------

/**
 * `written` as the link and hand-off rules read it: its escapes decoded,
 * each character that came through percent decoding and would end a link
 * read as a stand-in that ends none (see withStandIns), then in Unicode NFKC
 * without the default-ignorable code points a URL drops from a host (a soft
 * hyphen, a zero-width character, a variation selector). So a fullwidth or
 * decomposed letter reads as a URL reads it, and a mark that no letter takes
 * stays.
 */
function linkView(written: string, maps: ViewMaps, budget: ScrubBudget): Written {
  return normalized(withStandIns(decoded(written, maps, budget), maps), maps);
}

// What ends a link (see URL_CHAR), and what divides one: a path's `/`, and what starts a query, a fragment, a
// parameter, its value or a matrix part, or ends a userinfo.
const ADDRESS_STRUCTURE = /[\s"<>\\/?#&=;@]/g;
/** Where a stand-in for a character of an address's structure is: that character's code point past this one, in a private-use plane. */
const STAND_IN = 0xf0000;
const STAND_INS = /[\u{F0000}-\u{FFFFD}]/gu;

/**
 * `view` with each character that would end or divide a link a stand-in
 * that does neither, where it came through percent decoding: `%20`, `%2F`,
 * `%3F`, `%2520`, `%5C%22` (an escaped quote), or `&percnt;2F` from a
 * serializer that names `%` in HTML. Percent encoding is an address's own,
 * so what it writes is the address's data, as a browser and the site's
 * server read it: `/magic/abc%2Fdef` has the one segment `abc/def`, and
 * decoding never ends or splits a link the written text does not. Only a
 * scheme's `//` and the end of a host read a stand-in as its character (see
 * SLASH). A JSON or HTML escape of any of these characters reads as the text
 * before it was serialized, which the rules read as they read any text: no
 * URL serializer writes a quote or a space in an address.
 */
function withStandIns(view: Written, maps: ViewMaps): Written {
  const { text, percent } = view;
  if (!percent?.includes(1)) return view;
  let out: WrittenText | undefined;
  let from = 0;
  for (const end of text.matchAll(ADDRESS_STRUCTURE)) {
    const at = end.index;
    if (!percent[at]) continue;
    out ??= new WrittenText(text.length, maps.for(view));
    out.copy(view, from, at);
    out.push(String.fromCodePoint(STAND_IN + text.charCodeAt(at)), view, at, at + 1);
    from = at + 1;
  }
  if (!out) return view;
  out.copy(view, from, text.length);
  return out.done();
}

/** `text` with each stand-in read as the character it stands for. */
function standingForEach(text: string): string {
  return text.replace(STAND_INS, (char) => String.fromCodePoint(char.codePointAt(0)! - STAND_IN));
}

/** A link as the rules rewrote it, with each stand-in percent-encoded again. */
function withoutStandIns(link: string): string {
  return link.replace(STAND_INS, (char) => encodeURIComponent(String.fromCodePoint(char.codePointAt(0)! - STAND_IN)));
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

// What the link rules read as a link's structure: whitespace, and ASCII other than a letter or a digit.
const STRUCTURE = /[\s\x00-\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]/;

/**
 * A cluster as the link rules read it: in NFKC without default-ignorable
 * code points, unless NFKC would turn it into or out of whitespace or ASCII
 * punctuation (`¨` into a space and a mark, a fullwidth `＂`, `／` or `．`,
 * `<` and a combining long solidus into `≮`). A browser reads those as
 * written in a link, so they stay, and NFKC never ends, splits or hides a
 * link the written text does not.
 */
function clusterRead(cluster: string): string {
  const bare = cluster.replace(IGNORABLES, '');
  const read = nfkc(bare);
  return read !== bare && (STRUCTURE.test(read) || STRUCTURE.test(bare)) ? bare : read;
}

/**
 * `view` in NFKC without default-ignorable code points, cluster by cluster:
 * a code point and those that join it. No ASCII character joins one before
 * it, so only runs of other characters, with the ASCII character before
 * each, are read. Each cluster keeps where it was written.
 */
function normalized(view: Written, maps: ViewMaps): Written {
  const { text } = view;
  if (!NOT_ASCII.test(text) || (!IGNORABLE.test(text) && text.normalize('NFKC') === text)) return view;
  const out = new WrittenText(text.length, maps.for(view));
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
    if (nfkc(segment) === segment) continue;
    for (let at = start, next = start; at < end; at = next) {
      next = at + (text.codePointAt(at)! > 0xffff ? 2 : 1);
      while (next < end && joinsBefore(text.codePointAt(next)!)) next += text.codePointAt(next)! > 0xffff ? 2 : 1;
      const cluster = text.slice(at, next);
      let read = reads.get(cluster);
      if (read === undefined) reads.set(cluster, read = clusterRead(cluster));
      if (read === cluster) continue;
      out.copy(view, from, at);
      out.push(read, view, at, next);
      from = next;
    }
  }
  out.copy(view, from, text.length);
  return out.done();
}

/** Text built from parts of a view, each code unit with where it was written, in `buffers`. */
class WrittenText {
  #parts: string[] = [];
  #buffers: MapBuffers;
  #length = 0;

  constructor(capacity: number, buffers: MapBuffers) {
    this.#buffers = buffers;
    this.#room(capacity);
  }

  /** `view.text[from, to)`, written where the view says. */
  copy(view: Written, from: number, to: number): void {
    if (to <= from) return;
    this.#room(to - from);
    this.#parts.push(view.text.slice(from, to));
    const { starts, ends, percent } = this.#buffers;
    for (let index = from; index < to; index += 1) {
      starts[this.#length] = view.starts ? view.starts[index]! : index;
      ends[this.#length] = view.ends ? view.ends[index]! : index + 1;
      percent[this.#length] = view.percent ? view.percent[index]! : 0;
      this.#length += 1;
    }
  }

  /** `text` in place of `view.text[from, to)`, every code unit of it written where all of that was. */
  push(text: string, view: Written, from: number, to: number, percentEscape = false): void {
    this.#room(text.length);
    this.#parts.push(text);
    const [start, end] = written(view, from, to);
    let percent = percentEscape;
    for (let index = from; !percent && view.percent && index < to; index += 1) percent = view.percent[index] === 1;
    this.#buffers.starts.fill(start, this.#length, this.#length + text.length);
    this.#buffers.ends.fill(end, this.#length, this.#length + text.length);
    this.#buffers.percent.fill(percent ? 1 : 0, this.#length, this.#length + text.length);
    this.#length += text.length;
  }

  #room(units: number): void {
    const { starts, ends, percent } = this.#buffers;
    if (this.#length + units <= starts.length) return;
    const capacity = Math.max(starts.length * 2, this.#length + units);
    this.#buffers.starts = new Int32Array(capacity);
    this.#buffers.ends = new Int32Array(capacity);
    this.#buffers.percent = new Uint8Array(capacity);
    this.#buffers.starts.set(starts.subarray(0, this.#length));
    this.#buffers.ends.set(ends.subarray(0, this.#length));
    this.#buffers.percent.set(percent.subarray(0, this.#length));
  }

  done(): Written {
    const { starts, ends, percent } = this.#buffers;
    return {
      text: this.#parts.join(''),
      starts: starts.subarray(0, this.#length),
      ends: ends.subarray(0, this.#length),
      percent: percent.subarray(0, this.#length),
    };
  }
}

/**
 * `source` without a hand-off message's link, as the view reads it, and the
 * URLs those links hold. A thread context row lists a message's links again
 * under its text, unescaped (slack/rich-text-links.ts), so a link that holds
 * one of those URLs goes too, wherever else the field holds it (see
 * holdsHandoff). Anyone can write the label, so only a whole URL counts.
 */
function withoutHandoffs(source: string, view: Written): { text: string; urls: ReadonlySet<string> } {
  const spans: Span[] = [];
  const urls = new Set<string>();
  for (const match of view.text.matchAll(HANDOFF_LINK)) {
    spans.push(written(view, match.index, match.index + match[0].length));
    if (match[1] && HANDOFF_URL.test(match[1])) urls.add(standingForEach(match[1]));
  }
  return { text: replaceSpans(source, spans, BROWSER_LINK_OMITTED), urls };
}

// ---------------------------------------------------------------------------
// Reading a field as the username search does
// ---------------------------------------------------------------------------

/**
 * A field as the username search reads it: its escapes decoded (see
 * `decoded`), each run of whitespace or a form's `+` one space, and every
 * letter case-folded. Each code unit keeps where it was written, so a hit
 * leaves the field as written.
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
const PERCENT = 0x25;
const AMPERSAND = 0x26;
const PLUS = 0x2b;
const SPACE = 0x20;
const LETTER_U = 0x75;
const WHITESPACE = /^\s$/u;
const CUT_MARK = '…';
const THREE_DOTS = '...';

/** `view` as the search reads it. JSON writes a character past U+FFFF as two escapes, which read here as one character. */
function searchView({ text, starts, ends }: Written): SearchView {
  const out = new ViewWriter(text.length);
  for (let index = 0; index < text.length;) {
    const point = text.codePointAt(index)!;
    const next = index + (point > 0xffff ? 2 : 1);
    out.point(point, starts ? starts[index]! : index, ends ? ends[next - 1]! : next);
    index = next;
  }
  return out.done();
}

/** Builds a SearchView one code point at a time. */
class ViewWriter {
  #units: Uint16Array;
  #starts: Int32Array;
  #ends: Int32Array;
  #length = 0;
  #spaced = false;

  constructor(sourceLength: number) {
    // Folding case lengthens few characters (`İ`, `ß`), so the view rarely outgrows its source.
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

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
