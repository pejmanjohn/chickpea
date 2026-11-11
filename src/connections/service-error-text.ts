import { CREDENTIAL_REPLACEMENT } from '../security/content-validation.ts';
import { redactConnectionText } from './response.ts';

const MAX_SOURCE_CHARS = 16_384;
const MAX_CHARS = 1_000;
/** Stands in for each run of chunks the filter drops. */
const DROPPED = '[…]';
/** What a credential or a secret's value becomes before the split. No class admits it. */
const HIDDEN = '\u0000';

/**
 * A connected service's error text, reduced to what reads as language, for the model to read.
 *
 * An allowlist, not a scrubber: free-form error text always has another shape a scrubber misses,
 * so nothing is searched for. The text splits on whitespace, and a chunk stays only when, once
 * its edge punctuation is set aside, it is a word, a short number or an identifier made of
 * words. Every other chunk, such as a URL, a `key=value` pair, an email address, a long number
 * or a generated key, becomes one `[…]` with its neighbours. The status, field names, error
 * codes and ordinary words stay, so the model can still correct its request.
 *
 * Before the split, the value of each secret label and auth scheme goes whole, even when it reads
 * as words (`"client_secret": "…"`, `password: …`, `Bearer …`). See `hideSecretValues`.
 *
 * A credential that reads as words and has no secret label stays: a plain word of up to 20
 * letters, a passphrase, or words joined by `-`, `_` or `.`. A random key of 20 or fewer
 * characters with no digit sometimes reads as a word too. A longer one never does.
 *
 * At most 1,000 characters come back, cut between chunks and ending in `…` when anything is cut.
 * Only the first 16,384 characters are read, so the cost is linear and bounded.
 */
export function serviceErrorText(text: string, secrets: readonly string[]): string {
  const truncated = text.length > MAX_SOURCE_CHARS;
  const redacted = redactConnectionText(unescapeJson(text.slice(0, MAX_SOURCE_CHARS)), secrets)
    .replaceAll(CREDENTIAL_REPLACEMENT, HIDDEN);
  const readable = hideSecretValues(redacted).replaceAll(ESCAPED_QUOTE, '"');
  const chunks = spaceCompactJson(readable).split(/\s+/);
  // The source cut can land inside a chunk, and no part of a chunk is ever judged alone.
  if (truncated) chunks.pop();
  const shown: string[] = [];
  let length = 0;
  let cut = truncated;
  for (const chunk of chunks) {
    if (!chunk) continue;
    const piece = readsAsLanguage(chunk) ? chunk : DROPPED;
    if (piece === DROPPED && shown.at(-1) === DROPPED) continue;
    const grown = length + (shown.length ? 1 : 0) + piece.length;
    if (grown > MAX_CHARS) {
      cut = true;
      break;
    }
    shown.push(piece);
    length = grown;
  }
  if (!cut) return shown.join(' ');
  while (shown.length && (length >= MAX_CHARS || shown.at(-1) === DROPPED)) {
    length -= shown.pop()!.length + (shown.length ? 1 : 0);
  }
  return shown.length ? `${shown.join(' ')}…` : '';
}

/**
 * Compact JSON glues a whole object into one chunk, which the filter drops. A space after each
 * key's colon and before each key splits it into keys and values, each judged alone, so a raw
 * body such as `{"ok":false,"error":"channel_not_found"}` reads as it would pretty-printed.
 */
function spaceCompactJson(text: string): string {
  return text.replace(/\{(?=")/g, '{ ').replace(/":(?=\S)/g, '": ').replace(/,(?=")/g, ', ');
}

/**
 * Words that name a secret, each also in the plural. A label names a secret when any of its
 * parts is one, split at `_ . -` and where the case changes (`client_key`, `X-Api-Key`,
 * `privateKey`, `APISecret`), or when it ends in one once its separators are gone
 * (`clientsecret`, `PHPSESSID`). A secret word that is not a label, as in `token expired`, is a
 * word like any other.
 */
const SECRET_WORDS = [
  'password', 'passwd', 'pwd', 'pass', 'passcode', 'passphrase', 'pin', 'secret', 'token', 'key', 'apikey',
  'auth', 'authorization', 'credential', 'credentials', 'session', 'sessionid', 'sessid', 'sid', 'cookie',
  'cookies', 'signature', 'sig', 'otp', 'jwt', 'bearer', 'private',
];
const LABEL_PARTS = /[_.\-]+|(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u;

const withSingular = (word: string) => word.endsWith('s') ? [word, word.slice(0, -1)] : [word];

function namesASecret(name: string): boolean {
  const isSecretWord = (part: string) =>
    withSingular(part.toLowerCase()).some((form) => SECRET_WORDS.includes(form));
  if (name.split(LABEL_PARTS).some(isSecretWord)) return true;
  const joined = name.replace(/[_.\-]/g, '').toLowerCase();
  return withSingular(joined).some((form) => SECRET_WORDS.some((word) => form.endsWith(word)));
}

/**
 * A label: a whole run of letters, digits and `_ . -`, its closing quote if it has one, then `:`
 * or `=`. Or an auth scheme as a word before whitespace. Starting only where a run starts keeps
 * the search linear, so a name has no length limit.
 */
const LABEL = /(?<![\p{L}\p{N}_.\-])([\p{L}\p{N}_.\-]+)(?:\\*["'`\uE000])?[ \t]*[:=]|(?<![\p{L}\p{N}_])(?:bearer|basic)(?=\s)/giu;
/** Spaces, and line breaks a space or tab continues: a folded line. */
const BLANK = /(?:[ \t]|(?:\r\n?|\n)(?=[ \t]))*/y;
/** What an escaped quote decodes to while secret values are found, so it never ends their string. */
const ESCAPED_QUOTE = '\uE000';
const QUOTES = new Set(['"', "'", '`', ESCAPED_QUOTE]);
const CLOSERS: Readonly<Record<string, string>> = { '{': '}', '[': ']' };

/**
 * Each value a secret label or an auth scheme names, as one hidden character, with the label
 * kept. A value has an extent, and a whitespace chunk is not it: a quoted value ends at its
 * closing quote, an object or array at its closing bracket, and any other value, or an auth
 * scheme's, at the end of its line, folded lines included, or at a `,`, `;` or `&` outside
 * quotes. A value with no end takes the rest of the text.
 */
function hideSecretValues(text: string): string {
  let kept = '';
  let from = 0;
  LABEL.lastIndex = 0;
  for (let match = LABEL.exec(text); match; match = LABEL.exec(text)) {
    const name = match[1];
    if (name !== undefined && !namesASecret(name)) continue;
    const start = skipBlank(text, LABEL.lastIndex);
    const end = name === undefined ? lineEnd(text, start) : valueEnd(text, start);
    if (end === start) continue;
    kept += `${text.slice(from, start)}${HIDDEN}`;
    from = LABEL.lastIndex = end;
  }
  return kept + text.slice(from);
}

function skipBlank(text: string, at: number): number {
  BLANK.lastIndex = at;
  BLANK.exec(text);
  return BLANK.lastIndex;
}

function valueEnd(text: string, start: number): number {
  let quote = start;
  while (text.charAt(quote) === '\\') quote += 1;
  if (QUOTES.has(text.charAt(quote))) return closingQuote(text, quote);
  if (CLOSERS[text.charAt(start)]) return closingBracket(text, start);
  return lineEnd(text, start);
}

function lineEnd(text: string, start: number): number {
  for (let at = start; at < text.length; at += 1) {
    const character = text.charAt(at);
    if (QUOTES.has(character)) {
      at = closingQuote(text, at) - 1;
    } else if (character === ',' || character === ';' || character === '&') {
      return at;
    } else if (character === '\n' || character === '\r') {
      const folded = skipBlank(text, at);
      if (folded === at) return at;
      at = folded - 1;
    }
  }
  return text.length;
}

/** Past the bracket that closes the one at `open`, skipping strings. A wrong closer is no end. */
function closingBracket(text: string, open: number): number {
  const closers: string[] = [];
  for (let at = open; at < text.length; at += 1) {
    const character = text.charAt(at);
    const closer = CLOSERS[character];
    if (QUOTES.has(character)) {
      at = closingQuote(text, at) - 1;
    } else if (closer) {
      closers.push(closer);
    } else if (character === '}' || character === ']') {
      if (closers.pop() !== character) return text.length;
      if (!closers.length) return at + 1;
    }
  }
  return text.length;
}

/**
 * Past the quote that closes the one at `open`: the same character after as many backslashes,
 * since a quote escaped inside the string has more of them.
 */
function closingQuote(text: string, open: number): number {
  const quote = text.charAt(open);
  const escapes = backslashesBefore(text, open);
  for (let at = text.indexOf(quote, open + 1); at !== -1; at = text.indexOf(quote, at + 1)) {
    if (backslashesBefore(text, at) === escapes) return at + 1;
  }
  return text.length;
}

function backslashesBefore(text: string, at: number): number {
  let start = at;
  while (start > 0 && text.charAt(start - 1) === '\\') start -= 1;
  return at - start;
}

const JSON_ESCAPED: Readonly<Record<string, string>> = {
  '"': ESCAPED_QUOTE, '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t',
};

/**
 * One layer of JSON string escapes, for readability. A second layer keeps its backslashes. An
 * escaped quote decodes to `ESCAPED_QUOTE` until secret values are hidden, and a character that
 * already reads as one is hidden.
 */
function unescapeJson(text: string): string {
  return text.replaceAll(ESCAPED_QUOTE, HIDDEN).replace(
    /\\(?:u([\da-fA-F]{4})|(["\\/nrt]))/g,
    (_, hex: string | undefined, escaped: string) => {
      if (hex === undefined) return JSON_ESCAPED[escaped]!;
      const character = String.fromCharCode(Number.parseInt(hex, 16));
      return character === '"' ? ESCAPED_QUOTE : character === ESCAPED_QUOTE ? HIDDEN : character;
    },
  );
}

/**
 * Edge punctuation, which a chunk's class ignores. A backslash is one, because a field name in
 * JSON escaped twice keeps one after the single unescape (`\"hs_lead_status\"`). Inside a
 * chunk, a backslash still drops it.
 */
const LEADING = new Set('([{<"\'`\\“‘«*|-–—');
const TRAILING = new Set(')]}>"\'`\\.,;:!?…”’»*|-–—');

const UPPER = String.raw`[\p{Lu}\p{Lt}]`;
const LOWER = String.raw`[\p{Ll}\p{Lm}\p{Lo}\p{M}]`;
/**
 * Letters in a word's case, in any script: lower, Capitalized, UPPER, camelCase, or an acronym
 * before lower letters (`OAuth`, `URLs`). Mixed case in any other order is how generated keys
 * read.
 */
const CASED = String.raw`(?:${UPPER}*${LOWER}+(?:${UPPER}${LOWER}+)*|${UPPER}+)`;
const MAX_WORD_CHARS = 20;
/** A word, with an apostrophe inside it (`doesn't`). It holds no digit. */
const WORD = new RegExp(String.raw`^${CASED}(?:['’]${CASED})*$`, 'u');
/** A status, a count or a limit. A longer number can be an account, a phone or a one-time code. */
const NUMBER = /^\d{1,4}$/;
const MAX_IDENTIFIER_CHARS = 64;
const MAX_IDENTIFIER_DIGITS = 2;
/**
 * A digit pair may follow a short run of letters, as a version or an ordinal does (`v2`,
 * `line2`). A synthetic or generated value ends a long run in digits (`syntheticToken42`).
 */
const MAX_LETTERS_BEFORE_DIGITS = 8;
/** One part of an identifier: words, then up to two digits, then an index (`requests[0]`). */
const IDENTIFIER_PART = new RegExp(String.raw`^(${CASED})?(\d{1,2})?(?:\[\d{1,2}\])?$`, 'u');
const IDENTIFIER_SEPARATOR = /[_.-]/;

/**
 * A field or property name, an error code or a host: parts joined by `_`, `.` or `-`, or one
 * part with an index. It starts with a letter, and a word plus a number alone (`summer24`) is
 * how a password reads, so a lone part needs its index.
 */
function isIdentifier(core: string): boolean {
  if (core.length > MAX_IDENTIFIER_CHARS) return false;
  if (!IDENTIFIER_SEPARATOR.test(core) && !core.includes('[')) return false;
  if ((core.match(/\d/g)?.length ?? 0) > MAX_IDENTIFIER_DIGITS) return false;
  return core.split(IDENTIFIER_SEPARATOR).every((part, index) => {
    const match = IDENTIFIER_PART.exec(part);
    if (!part || !match) return false;
    const [, letters = '', digits] = match;
    if (index === 0 && !letters) return false;
    return letters.length <= MAX_WORD_CHARS && (!digits || letters.length <= MAX_LETTERS_BEFORE_DIGITS);
  });
}

/** A chunk without its edge punctuation. */
function coreOf(chunk: string): string {
  let start = 0;
  let end = chunk.length;
  while (start < end && LEADING.has(chunk.charAt(start))) start += 1;
  while (end > start && TRAILING.has(chunk.charAt(end - 1))) end -= 1;
  return chunk.slice(start, end);
}

/** A chunk whose core, inside its edge punctuation, is empty, a word, a number or an identifier. */
function readsAsLanguage(chunk: string): boolean {
  const core = coreOf(chunk);
  return !core ||
    (core.length <= MAX_WORD_CHARS && WORD.test(core)) ||
    NUMBER.test(core) ||
    isIdentifier(core);
}
