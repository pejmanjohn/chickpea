/**
 * Text written the way common serializers, browsers and Slack write it. Each
 * producer follows its documented escaping rules; the JavaScript ones are the
 * language's own functions, and a browser's are the URL standard's, which
 * Node implements as browsers do.
 */
import { domainToUnicode } from 'node:url';

export interface Producer {
  name: string;
  /** `text` as this producer writes it, or undefined when it takes no such text (an address bar takes only an address). */
  encode(text: string): string | undefined;
}

const LATIN1_NAMES = (
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute ' +
  'micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig ' +
  'Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash ' +
  'Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc ' +
  'euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml ' +
  'yacute thorn yuml'
).split(' ');

const HTML5_ASCII_NAMES: Readonly<Record<string, string>> = {
  '\t': 'Tab', '\n': 'NewLine', '!': 'excl', '"': 'quot', '#': 'num', '$': 'dollar', '%': 'percnt', '&': 'amp', '\'': 'apos',
  '(': 'lpar', ')': 'rpar', '*': 'ast', '+': 'plus', ',': 'comma', '.': 'period', '/': 'sol', ':': 'colon', ';': 'semi',
  '<': 'lt', '=': 'equals', '>': 'gt', '?': 'quest', '@': 'commat', '[': 'lsqb', '\\': 'bsol', ']': 'rsqb', '^': 'Hat',
  '_': 'lowbar', '`': 'grave', '{': 'lcub', '|': 'verbar', '}': 'rcub',
};

function hexByte(byte: number): string {
  return byte.toString(16).toUpperCase().padStart(2, '0');
}

/** Each UTF-8 byte of a character `keep` does not take as `%XX`, and a space as `space` when one is given. */
function percentEncoded(text: string, keep: RegExp, space?: string): string {
  let out = '';
  for (const char of text) {
    if (space !== undefined && char === ' ') out += space;
    else if (keep.test(char)) out += char;
    else out += [...new TextEncoder().encode(char)].map((byte) => `%${hexByte(byte)}`).join('');
  }
  return out;
}

interface JsonRules {
  /** A code unit written as `\uXXXX` though JSON need not escape it. */
  escape?: (unit: number) => boolean;
  upperHex?: boolean;
}

const SHORT_ESCAPES: ReadonlyMap<number, string> = new Map([
  [0x22, '\\"'], [0x5c, '\\\\'], [0x08, '\\b'], [0x09, '\\t'], [0x0a, '\\n'], [0x0c, '\\f'], [0x0d, '\\r'],
]);

/** A JSON string: `"` and `\` escaped, the control characters JSON names by their short escapes, other ones and `escape`'s by number. */
function jsonString(text: string, { escape = () => false, upperHex = false }: JsonRules = {}): string {
  let out = '"';
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    const short = SHORT_ESCAPES.get(unit);
    if (short) {
      out += short;
    } else if (unit < 0x20 || escape(unit)) {
      const hex = unit.toString(16).padStart(4, '0');
      out += `\\u${upperHex ? hex.toUpperCase() : hex}`;
    } else {
      out += text[index];
    }
  }
  return `${out}"`;
}

function replaced(text: string, table: Readonly<Record<string, string>>): string {
  return text.replace(/[&<>"']/g, (char) => table[char] ?? char);
}

function slackEscaped(text: string): string {
  return replaced(text, { '&': '&amp;', '<': '&lt;', '>': '&gt;' });
}

/**
 * `text` as an address, where it is one as written: a web address whose host is written as a host. Text another
 * producer escaped (`https://b&#252;cher.example/…`, whose host a URL reads as `b&`) is no address a browser shows.
 */
function webAddress(text: string): URL | undefined {
  return /^https?:\/\/[\p{L}\p{M}\p{N}.%:[\]-]+(?:[/?#]\S*)?$/iu.test(text) && URL.canParse(text) ? new URL(text) : undefined;
}

// Each delimiter a builder must escape in a userinfo, and `:`, which only some escape in a password.
const USERINFO_DELIMITERS = '/?#@:';

/**
 * An address and the user and password a URL builder puts in its userinfo. A web address gains a user and a
 * password that each hold `/ ? # @ :`, so what they write must hide neither its host nor what follows it. Other
 * text is the user, and the password after `/ ? # @ :`, in a login site's address.
 */
function userinfoParts(text: string): { url: URL; user: string; password: string } {
  const url = webAddress(text);
  if (url) return { url, user: `ops${USERINFO_DELIMITERS}team`, password: `pass${USERINFO_DELIMITERS}word` };
  return { url: new URL('https://billing.example.com/callback'), user: text, password: `${USERINFO_DELIMITERS}${text}` };
}

/** `text` with a userinfo (see userinfoParts) that `escape` writes. */
function userinfoAddress(text: string, escape: (part: string, password: boolean) => string): string {
  const { url, user, password } = userinfoParts(text);
  return `${url.protocol}//${escape(user, false)}:${escape(password, true)}@${url.host}${url.pathname}${url.search}${url.hash}`;
}

export const PRODUCERS: readonly Producer[] = [
  { name: 'JS JSON.stringify', encode: (text) => JSON.stringify(text) },
  { name: 'JS encodeURI', encode: (text) => encodeURI(text) },
  { name: 'JS encodeURIComponent', encode: (text) => encodeURIComponent(text) },
  { name: 'JS URLSearchParams', encode: (text) => new URLSearchParams({ next: text }).toString() },
  // Python's json.dumps writes every character past ASCII as escapes in lower-case hex, or as itself with ensure_ascii=False.
  { name: 'Python json.dumps', encode: (text) => jsonString(text, { escape: (unit) => unit > 0x7e }) },
  { name: 'Python json.dumps(ensure_ascii=False)', encode: (text) => jsonString(text) },
  // urllib.parse.quote keeps letters, digits, `_.-~` and its default safe `/`; quote_plus keeps no `/` and writes a space as `+`.
  { name: 'Python quote', encode: (text) => percentEncoded(text, /^[A-Za-z0-9_.~/-]$/) },
  { name: 'Python quote_plus', encode: (text) => percentEncoded(text, /^[A-Za-z0-9_.~-]$/, '+') },
  {
    name: 'Python html.escape',
    encode: (text) => replaced(text, { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#x27;' }),
  },
  {
    name: 'Python xmlcharrefreplace',
    encode: (text) => [...text].map((char) => char.codePointAt(0)! > 0x7f ? `&#${char.codePointAt(0)};` : char).join(''),
  },
  // Go's encoding/json escapes `<`, `>`, `&`, U+2028 and U+2029 in lower-case hex for HTML's sake.
  {
    name: 'Go encoding/json',
    encode: (text) => jsonString(text, { escape: (unit) => unit === 0x3c || unit === 0x3e || unit === 0x26 || unit === 0x2028 || unit === 0x2029 }),
  },
  { name: 'Java Jackson', encode: (text) => jsonString(text, { upperHex: true }) },
  { name: 'Ruby to_json', encode: (text) => jsonString(text) },
  // CGI.escape keeps letters, digits and `_.-~`, and writes a space as `+`.
  { name: 'Ruby CGI.escape', encode: (text) => percentEncoded(text, /^[A-Za-z0-9_.~-]$/, '+') },
  {
    name: 'Ruby ERB::Util.html_escape',
    encode: (text) => replaced(text, { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }),
  },
  // urlencode keeps letters, digits and `_.-`, and writes a space as `+`; rawurlencode keeps `~` too and writes `%20`.
  { name: 'PHP urlencode', encode: (text) => percentEncoded(text, /^[A-Za-z0-9_.-]$/, '+') },
  { name: 'PHP rawurlencode', encode: (text) => percentEncoded(text, /^[A-Za-z0-9_.~-]$/) },
  // PHP 8.1's defaults, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML401.
  {
    name: 'PHP htmlspecialchars',
    encode: (text) => replaced(text, { '&': '&amp;', '"': '&quot;', '\'': '&#039;', '<': '&lt;', '>': '&gt;' }),
  },
  {
    name: 'PHP htmlentities',
    encode: (text) => [...replaced(text, { '&': '&amp;', '"': '&quot;', '\'': '&#039;', '<': '&lt;', '>': '&gt;' })].map((char) => {
      const point = char.codePointAt(0)!;
      if (point < 0x80) return char;
      // HTML 4.01 names every Latin-1 character; this helper takes no text past them, whose names it does not hold.
      if (point < 0xa0 || point > 0xff) throw new Error(`No HTML 4.01 name here for U+${point.toString(16)}.`);
      return `&${LATIN1_NAMES[point - 0xa0]};`;
    }).join(''),
  },
  // ENT_QUOTES | ENT_HTML5 names ASCII punctuation too, `%` as `&percnt;` and `/` as `&sol;`. Any name HTML gives a character reads the same.
  {
    name: 'PHP htmlentities(ENT_HTML5)',
    encode: (text) => [...text].map((char) => {
      const point = char.codePointAt(0)!;
      const name = HTML5_ASCII_NAMES[char] ?? (point >= 0xa0 && point <= 0xff ? LATIN1_NAMES[point - 0xa0] : undefined);
      if (name) return `&${name};`;
      if (point < 0x80) return char;
      throw new Error(`No HTML5 name here for U+${point.toString(16)}.`);
    }).join(''),
  },
  // What a browser's address bar shows: the host in its own script, no scheme or `www.`, UTF-8 escapes as their characters.
  {
    name: 'Browser address bar',
    encode: (text) => {
      const url = webAddress(text);
      if (!url) return undefined;
      const host = `${domainToUnicode(url.hostname).replace(/^www\./, '')}${url.port ? `:${url.port}` : ''}`;
      const rest = `${url.pathname}${url.search}${url.hash}`
        .replace(/%[C-F][0-9A-F](?:%[89AB][0-9A-F])+/gi, (escapes) => decodeURIComponent(escapes));
      return rest === '/' ? host : `${host}${rest}`;
    },
  },
  // What a history entry holds: the address as the URL standard writes it, with an ASCII host and escaped path.
  { name: 'Browser history', encode: (text) => webAddress(text)?.href },
  { name: 'Slack mrkdwn escape', encode: slackEscaped },
  {
    name: 'Slack link markup',
    encode: (text) => {
      if (webAddress(text)) return `<${slackEscaped(text)}|the page>`;
      return /^[^\s@<>|]+@[^\s@<>|]+$/.test(text) ? `<mailto:${slackEscaped(text)}|${slackEscaped(text)}>` : undefined;
    },
  },
  { name: 'Redirect parameter', encode: (text) => `https://other.example/redirect?next=${encodeURIComponent(text)}` },
  // A login site that carries a value as one segment of its path, as a `/magic/:token/done` route reads it back.
  // encodeURIComponent writes each `/`, `?`, `#`, `&`, `=` and `;` of the value as its escape.
  { name: 'Login site path segment', encode: (text) => `https://billing.example.com/magic/${encodeURIComponent(text)}/done` },
  // A user and a password in an address's userinfo (see userinfoParts). The URL standard's setters write `/`, `?`,
  // `#`, `@` and `:` as escapes, but keep `%`, `&` and most marks.
  {
    name: 'URL userinfo by the URL setters',
    encode: (text) => {
      const { url, user, password } = userinfoParts(text);
      url.username = user;
      url.password = password;
      return url.href;
    },
  },
  // RFC 3986's userinfo keeps its unreserved characters and sub-delimiters as written, and `:` in a password.
  {
    name: 'URL userinfo by RFC 3986',
    encode: (text) => userinfoAddress(text, (part, password) =>
      percentEncoded(part, password ? /^[A-Za-z0-9._~!$&'()*+,;=:-]$/ : /^[A-Za-z0-9._~!$&'()*+,;=-]$/)),
  },
  // Go's url.UserPassword keeps letters, digits, `-._~` and `$&+,;=`, and escapes the rest, a space as `%20`.
  { name: 'URL userinfo by Go net/url', encode: (text) => userinfoAddress(text, (part) => percentEncoded(part, /^[A-Za-z0-9._~$&+,;=-]$/)) },
];
