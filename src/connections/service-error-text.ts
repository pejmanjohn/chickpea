import { CREDENTIAL_REPLACEMENT } from '../security/content-validation.ts';
import { redactConnectionText } from './response.ts';

const MAX_SOURCE_CHARS = 16_384;
const MAX_CHARS = 1_000;
/** Stands in for each run of chunks the filter drops. */
const DROPPED = '[…]';

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
 * A credential that reads as words stays: a plain word of up to 20 letters, a passphrase, or
 * words joined by `-`, `_` or `.`. A random key of 20 or fewer characters with no digit
 * sometimes reads as a word too. A longer one never does.
 *
 * At most 1,000 characters come back, cut between chunks and ending in `…` when anything is cut.
 * Only the first 16,384 characters are read, so the cost is linear and bounded.
 */
export function serviceErrorText(text: string, secrets: readonly string[]): string {
  const truncated = text.length > MAX_SOURCE_CHARS;
  // A shared credential signature or the turn's key becomes a NUL, which no class admits.
  const readable = redactConnectionText(unescapeJson(text.slice(0, MAX_SOURCE_CHARS)), secrets)
    .replaceAll(CREDENTIAL_REPLACEMENT, '\u0000');
  const chunks = spaceCompactJson(readable).split(/\s+/);
  // The source cut can land inside a chunk, and no part of a chunk is ever judged alone.
  if (truncated) chunks.pop();
  const shown: string[] = [];
  let length = 0;
  let cut = truncated;
  let valueNext = false;
  let separatorNext = false;
  for (const chunk of chunks) {
    if (!chunk) continue;
    let piece: string;
    if (valueNext) {
      piece = DROPPED;
      valueNext = false;
    } else if (separatorNext && SEPARATOR.test(chunk)) {
      piece = DROPPED;
      valueNext = true;
    } else {
      piece = readsAsLanguage(chunk) ? chunk : DROPPED;
    }
    separatorNext = false;
    const label = secretLabel(chunk);
    if (label === 'value') valueNext = true;
    else if (label === 'separator') separatorNext = true;
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
 * A label that names a secret: whatever follows its `:` or `=` is a value, and the filter drops
 * it even when it reads as a word (`password: hunter`, `"client_secret": "words"`). An auth
 * scheme names its credential the same way (`Bearer first`). A label used as a plain word, as in
 * `token expired`, keeps the next word.
 */
const SECRET_LABEL =
  /(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|authorization|auth|credentials?|session(?:[_-]?id)?|sessid|sid|cookie|signature|sig|otp|private[_-]?key)$/i;
const AUTH_SCHEME = /^(?:bearer|basic)$/i;
const SEPARATOR = /^[:=]$/;

function secretLabel(chunk: string): 'value' | 'separator' | undefined {
  const core = coreOf(chunk);
  if (AUTH_SCHEME.test(core)) return 'value';
  const bare = chunk.replace(/["'`\\]+$/, '');
  if (/[:=]$/.test(bare)) {
    const label = coreOf(bare.slice(0, -1));
    return SECRET_LABEL.test(label) ? 'value' : undefined;
  }
  return SECRET_LABEL.test(core) ? 'separator' : undefined;
}

const JSON_ESCAPED: Readonly<Record<string, string>> ={ '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t' };

/** One layer of JSON string escapes, for readability. A second layer keeps its backslashes. */
function unescapeJson(text: string): string {
  return text.replace(/\\(?:u([\da-fA-F]{4})|(["\\/nrt]))/g, (_, hex: string | undefined, escaped: string) =>
    hex === undefined ? JSON_ESCAPED[escaped]! : String.fromCharCode(Number.parseInt(hex, 16)));
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
