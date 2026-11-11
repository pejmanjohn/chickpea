import { CREDENTIAL_REPLACEMENT } from '../security/content-validation.ts';
import { redactConnectionText } from './response.ts';

const REDACTED = '[redacted]';

/**
 * A connected service's error text, scrubbed for the model to read. It errs hard toward
 * removal: the text is low-value prose, so a removed word costs the model little. Escapes are
 * decoded first, and the decoded text is what is scrubbed and returned, so an escape cannot
 * hide a credential from a rule. The status, field names and ordinary words stay, so the
 * model can still correct its request.
 *
 * A credential under 32 characters in plain prose, with no field name, header, URL or known
 * prefix around it, has no shape to find and stays.
 */
export function scrubServiceErrorText(text: string, secrets: readonly string[]): string {
  const redacted = redactConnectionText(decoded(text), secrets).replaceAll(CREDENTIAL_REPLACEMENT, REDACTED);
  return SCRUB_RULES.reduce((scrubbed, scrub) => scrub(scrubbed), redacted).replace(/ {2,}/g, ' ').trim();
}

const HTML_ENTITIES: Readonly<Record<string, string>> = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' };

/** The character a code names, when it is printable ASCII; otherwise the escape stays. */
function ascii(escape: string, code: number): string {
  return code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : escape;
}

/**
 * One layer of each escape a serializer or an HTTP client adds: JSON at any depth, `\x`,
 * percent and HTML. Each one shortens the text, so applying them until nothing changes ends.
 */
const ESCAPES: readonly ((text: string) => string)[] = [
  (text) => text.replace(/\\+u([\da-f]{4})/gi, (escape, hex: string) => ascii(escape, Number.parseInt(hex, 16))),
  (text) => text.replace(/\\+x([\da-f]{2})/gi, (escape, hex: string) => ascii(escape, Number.parseInt(hex, 16))),
  (text) => text.replace(/%([\da-f]{2})/gi, (escape, hex: string) => ascii(escape, Number.parseInt(hex, 16))),
  (text) => text.replace(/&#(x[\da-f]+|\d+);/gi, (escape, code: string) =>
    ascii(escape, /^x/i.test(code) ? Number.parseInt(code.slice(1), 16) : Number(code))),
  (text) => text.replace(/&(quot|apos|amp|lt|gt);/gi, (_, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? ''),
  (text) => text.replace(/\\+[nrt]/g, ' '),
  (text) => text.replace(/\\+(?=["'/])/g, ''),
];

function decoded(text: string): string {
  let current = text;
  for (;;) {
    const next = ESCAPES.reduce((value, decode) => decode(value), current);
    if (next === current) return current;
    current = next;
  }
}

const SECRET_WORDS_BUT_CODE = 'secret|token|key|passw(?:or)?d|pwd|auth|credential|session|cookie|sig|otp|bearer|private';
const SECRET_WORD = `${SECRET_WORDS_BUT_CODE}|code`;
const SECRET_NAME_BUT_CODE = new RegExp(SECRET_WORDS_BUT_CODE, 'i');
/** HTTP authentication schemes: IANA's registry, then common unregistered ones. */
const AUTH_SCHEME = 'basic|bearer|concealed|digest|dpop|gnap|hoba|mutual|negotiate|oauth|privatetoken|' +
  'scram-sha-1|scram-sha-256|vapid|token|apikey|api-key|key|ssws|ntlm|aws4-hmac-sha256';

/** Values no credential takes: none, a boolean, a status-sized number, or a removal already made. */
const PLAIN_VALUE = /^(?:|null|none|true|false|\d{1,3}|\[redacted\])$/i;
/** An error code such as `INVALID_ARGUMENT`, which stays under a name secret only for "code". */
const ERROR_CODE = /^[a-z]+(?:_[a-z]+)+$/i;

function keepsValue(name: string, value: string): boolean {
  return PLAIN_VALUE.test(value) || (!SECRET_NAME_BUT_CODE.test(name) && ERROR_CODE.test(value));
}

/**
 * A secret-named field in any syntax: `key=value`, `key: value`, `"key":"value"`,
 * `'key': 'value'`, `:key => value`, `("key", "value")` and `params[key]=value`. A value in
 * quotes, brackets or braces goes whole, to its end or to the end of the text. A known
 * authentication scheme stays in front of its value, and after an Authorization name any word
 * counts as one.
 */
const SECRET_FIELD = new RegExp(
  String.raw`(?<![\w.-])([\w.-]*(?:${SECRET_WORD})[\w.-]*)` +
    String.raw`((?:["'\]]?\s*(?:=>|:=|[:=])|["']\s*,)\s*)` +
    String.raw`(?:("[^"]*"?|'[^']*'?|\[[^\]]*\]?|\{[^}]*\}?)` +
    String.raw`|(?:(${AUTH_SCHEME}|(?<=authori[sz]ation\W*)[a-z][\w-]*)\s+(?=[^\s"'\x60]))?([^\s"'\x60,;)}\]]+))`,
  'gi',
);

function scrubSecretField(
  match: string,
  name: string,
  separator: string,
  enclosed: string | undefined,
  scheme: string | undefined,
  bare: string | undefined,
): string {
  if (enclosed === undefined) {
    if (!scheme && keepsValue(name, bare ?? '')) return match;
    return `${name}${separator}${scheme ? `${scheme} ` : ''}${REDACTED}`;
  }
  const open = enclosed.charAt(0);
  if (open === '[' || open === '{') return keepsValue(name, enclosed) ? match : `${name}${separator}${REDACTED}`;
  const close = enclosed.length > 1 && enclosed.endsWith(open) ? open : '';
  return keepsValue(name, enclosed.slice(1, enclosed.length - close.length))
    ? match
    : `${name}${separator}${open}${REDACTED}${close}`;
}

/** An XML element with a secret name: `<sessionToken>…</sessionToken>`. */
const SECRET_ELEMENT = new RegExp(String.raw`(<([\w.:-]*(?:${SECRET_WORD})[\w.:-]*)(?:\s[^>]*)?>)([^<]*)`, 'gi');

/** A URL with a scheme or a leading `//`, or a host followed by a path, a query or a fragment. */
const URL_LIKE =
  /(?:\b[a-z][a-z\d+.-]*:)?\/\/[^\s"'<>]+|(?<![\w.@/-])(?:[^\s"'<>@/]+@)?(?:[a-z\d-]+\.)+[a-z]{2,}(?::\d{1,5})?(?=[/?#])[^\s"'<>]*/gi;

/** A URL without its login, query or fragment, or a path segment that reads as a token. */
function scrubUrl(url: string): string {
  const tailAt = url.search(/[?#]/);
  const head = tailAt < 0 ? url : url.slice(0, tailAt);
  const tail = tailAt < 0 ? '' : url.slice(tailAt);
  return scrubPath(head.replace(/^((?:[a-z][a-z\d+.-]*:)?\/\/)?[^/@]*@/i, '$1')) +
    (tail.length > 1 ? `${tail.charAt(0)}${REDACTED}` : tail);
}

/**
 * A path without the segments that read as a token. Neighbouring segments that are not words
 * count as one, because a decoded `%2F` or base64's own `/` can split one token into several.
 */
function scrubPath(path: string): string {
  const kept: string[] = [];
  let tokenLike: string[] = [];
  const close = () => {
    if (tokenLike.join('/').length >= 16) kept.push(REDACTED);
    else kept.push(...tokenLike);
    tokenLike = [];
  };
  for (const segment of path.split('/')) {
    if (readsAsWords(segment)) {
      close();
      kept.push(segment);
    } else {
      tokenLike.push(segment);
    }
  }
  close();
  return kept.join('/');
}

/**
 * Documented token prefixes the shared signature table lacks: Stripe secret, restricted and
 * webhook keys, GitLab tokens, Google OAuth access tokens, Shopify, Notion, Linear, Atlassian,
 * SendGrid, npm and Figma tokens, and OpenAI-style `sk-` keys. The table already has Slack,
 * GitHub, Google API, AWS, Anthropic, OpenAI project, HubSpot and Browserbase keys.
 */
const TOKEN_PREFIX = new RegExp(
  String.raw`\b(?:(?:sk|rk)_(?:live|test)_|whsec_|gl(?:pat|dt|rt|ptt|cbt|oas|soat)-|ya29\.|shp(?:at|ca|pa|ss)_|` +
    String.raw`ntn_|lin_(?:api|oauth)_|ATATT|SG\.|npm_|figd_|sk-(?=[\w-]{16}))[\w+/=-]+(?:\.[\w+/=-]+)*`,
  'g',
);

/** A word, a camelCase word, an acronym or a number, with up to three digits after a word. */
const WORD = /^(?:\d{1,8}|[A-Z]{1,20}\d{0,3}|[A-Z]?[a-z]{1,20}(?:[A-Z][a-z]{1,20})*\d{0,3})$/;

/** Made of words, the way a field name, a path segment or a host is. A key, a hash or base64 is not. */
function readsAsWords(run: string): boolean {
  return run.split(/[^A-Za-z\d]+/).every((piece) => !piece || WORD.test(piece));
}

/** Each rule removes what the ones before it left; a later rule never sees a removed value. */
const SCRUB_RULES: readonly ((text: string) => string)[] = [
  // A Cookie or Set-Cookie header's value: every `name=value` pair after it, joined by `;`. A
  // list or an object of them is a secret field's, which goes whole.
  (text) => text.replace(
    /\b((?:set-)?cookies?["']?\s*[:=]\s*["']?)(?=[^\s[{])[^\s;"']*(?:\s*;\s*[^\s;"']*)*/gi,
    (_, head: string) => `${head}${REDACTED}`,
  ),
  (text) => text.replace(URL_LIKE, scrubUrl),
  // A query after a path with no host, such as `/object?Signature=…`.
  (text) => text.replace(/(?<=[\w/.-])\?(?=[^\s"'<>]*=)[^\s"'<>]+/g, `?${REDACTED}`),
  // A login before a host with no scheme and no path: `user:password@db.example.test:5432`.
  (text) => text.replace(/(?<![^\s"'<>(=,])[^\s"'<>@/]*:[^\s"'<>@/]*@(?=[a-z\d-]+\.)/gi, ''),
  (text) => text.replace(SECRET_FIELD, scrubSecretField),
  (text) => text.replace(SECRET_ELEMENT, (match, open: string, name: string, value: string) =>
    keepsValue(name, value) ? match : `${open}${REDACTED}`),
  // Outside a header, a bearer or basic value holds a digit or a mark; the word after
  // "Bearer" or "Basic" in prose holds neither.
  (text) => text.replace(/\b((?:Bearer|Basic)\s+)(?=[\w.~+/=-]*[\d._~+/=])[\w.~+/=-]{8,}/gi, `$1${REDACTED}`),
  (text) => text.replace(TOKEN_PREFIX, REDACTED),
  // A key, a hash, a JWT or a base64 value: 32 or more base64, base64url or hex characters
  // that are not words. A run with a slash is a path, or base64, and goes segment by segment.
  (text) => text.replace(/(?<![\w+/.-])[\w+/.-]{16,}={0,2}/g, (run) => {
    if (run.includes('/')) return scrubPath(run);
    return run.length >= 32 && !readsAsWords(run) ? REDACTED : run;
  }),
];
