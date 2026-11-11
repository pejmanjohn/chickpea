/**
 * Secrets typed into a page this turn, matched in every form the page or the
 * browser tools can show them in.
 *
 * A page may show a typed value with its whitespace collapsed, escaped as
 * JSON or HTML, in another letter case, cut short, or URL-encoded, and a
 * snapshot collapses, cuts and escapes it again. The tools redact each raw
 * name, value and message before they transform it, then redact their output
 * once more. This is the second layer: a field that holds a password or code
 * is hidden whatever it holds (`BrowserPage.snapshot`), and no picture of a
 * page that could show one leaves the browser (`BrowserPage.screenshot`).
 */
import { RedactionBudget } from './redaction-budget.ts';

export const REDACTED = '[redacted]';

/**
 * A secret shorter than this is replaced only where it is a whole field, such
 * as a revealed password box. Inside text it would erase ordinary words.
 */
const MIN_INLINE_LENGTH = 4;

/**
 * A secret at least this long also matches in another letter case, as a page
 * that upper-cases text shows it. A shorter one would match ordinary words.
 */
const CASELESS_MIN_LENGTH = 8;

/** A secret of only this many digits or more, such as a one-time code, also matches with its digits grouped. */
const GROUPED_DIGITS = /^\d{6,}$/;

const ELLIPSIS = '…';

/** Escapes text as a snapshot quotes it. JSON escapes `\` and `"` the same way. */
export function escapeQuoted(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function caselessHex(hex: string): string {
  return hex.replace(/[a-f]/g, (digit) => `[${digit}${digit.toUpperCase()}]`);
}

/** HTML's no-break space, in any of its references. */
const HTML_SPACE = '&nbsp;|&#0*160;|&#[xX]0*[aA]0;';

/** A whitespace run of a secret in page text: any whitespace, so a collapsed or rewrapped form matches, or a no-break space reference. */
const TEXT_SPACE = `(?:\\s|${HTML_SPACE})+`;

/**
 * A whitespace run of a secret as text or a URL may carry it: as in text,
 * `+`, or an encoded space, tab, line break or no-break space.
 */
const ENCODED_SPACE = `(?:\\s|\\+|%20|%0[9a-dA-D]|%[cC]2%[aA]0|${HTML_SPACE})+`;

const JSON_ESCAPED = new Set(['"', '\\', '/']);
const HTML_NAMES: Record<string, string> = { '"': 'quot', "'": 'apos', '&': 'amp', '<': 'lt', '>': 'gt' };

/** A character percent-encoded as UTF-8, in either hex case. */
function percentEncoded(char: string): string {
  return [...new TextEncoder().encode(char)].map((byte) => `%${caselessHex(byte.toString(16).padStart(2, '0'))}`).join('');
}

/**
 * The patterns for one character of a secret escaped, as page text may carry
 * it: JSON's `\"`, `\\` and `\/` (PHP escapes the slash), `é` for a
 * character outside ASCII (Python's default), and HTML's named and numeric
 * references. Only characters that encoders escape get them. `encoded` lets
 * a JSON escape's own characters be percent-encoded, as JSON in a query is.
 */
function escapedForms(char: string, encoded: boolean): string[] {
  const either = (text: string) => (encoded ? `(?:${percentEncoded(text)}|${escapeRegExp(text)})` : escapeRegExp(text));
  const forms: string[] = [];
  if (JSON_ESCAPED.has(char)) forms.push(either('\\') + either(char));
  const code = char.codePointAt(0)!;
  const name = HTML_NAMES[char];
  if (code > 0x7e) {
    const units = Array.from({ length: char.length }, (_, index) => char.charCodeAt(index));
    forms.push(units.map((unit) => `${either('\\')}u${caselessHex(unit.toString(16).padStart(4, '0'))}`).join(''));
  }
  if (name || code > 0x7e) forms.push(`&#0*${code};`, `&#[xX]0*${caselessHex(code.toString(16))};`);
  if (name) forms.push(`&${name};`);
  return forms;
}

/**
 * One character of a secret in any form text may carry it: as it is, in
 * either case for a long secret, or escaped. `encoded` adds percent-encoding:
 * a script that joins a typed value into an address leaves some characters as
 * they are and encodes others, so each one matches both ways.
 */
function charPattern(char: string, options: { caseless: boolean; encoded: boolean }): string {
  if (char === ' ') return options.encoded ? ENCODED_SPACE : TEXT_SPACE;
  const lower = char.toLowerCase();
  const upper = char.toUpperCase();
  const literal = options.caseless && lower !== upper && lower.length === 1 && upper.length === 1
    ? `[${lower}${upper}]`
    : escapeRegExp(char);
  // Longer forms first: `%` and `\` start their own escapes, `%25` and `\\`.
  const forms = [...(options.encoded ? [percentEncoded(char)] : []), ...escapedForms(char, options.encoded), literal];
  return forms.length === 1 ? literal : `(?:${forms.join('|')})`;
}

function secretPattern(secret: string, encoded: boolean): string {
  const options = { caseless: secret.length >= CASELESS_MIN_LENGTH, encoded };
  const separator = GROUPED_DIGITS.test(secret) ? (encoded ? '(?:[\\s.+-]|%20)?' : '[\\s.-]?') : '';
  return [...secret].map((char) => charPattern(char, options)).join(separator);
}

/** Decodes each run of %XX escapes; a run that is not valid UTF-8 stays as it is. */
function percentDecode(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

interface CutForm {
  form: string;
  /** Knuth-Morris-Pratt failure table of `form`. */
  failure: number[];
}

function cutForm(form: string): CutForm {
  const failure = new Array<number>(form.length).fill(0);
  for (let i = 1, k = 0; i < form.length; i += 1) {
    while (k > 0 && form[i] !== form[k]) k = failure[k - 1]!;
    if (form[i] === form[k]) k += 1;
    failure[i] = k;
  }
  return { form, failure };
}

/**
 * Replaces the start of a secret left in front of an ellipsis or three dots,
 * as cutting a long value leaves it: the longest prefix of the form that ends
 * there.
 */
function replaceCutPrefix(text: string, { form, failure }: CutForm, replacement: string): string {
  if (!text.includes(ELLIPSIS) && !text.includes('...')) return text;
  let result = '';
  let from = 0;
  let matched = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    const cut = char === ELLIPSIS || (char === '.' && text.startsWith('...', i));
    if (cut && matched >= MIN_INLINE_LENGTH) {
      // A prefix that reaches back into the last replacement extends it.
      if (i - matched >= from) result += text.slice(from, i - matched) + replacement;
      from = i;
    }
    while (matched > 0 && (matched === form.length || form[matched] !== char)) matched = failure[matched - 1]!;
    if (form[matched] === char) matched += 1;
  }
  return result + text.slice(from);
}

export class TypedSecrets {
  private readonly short = new Set<string>();
  private readonly inline = new Set<string>();
  /** Each inline secret, composed and decomposed. */
  private variants: string[] = [];
  private pattern: RegExp | undefined;
  /** Matches all that `pattern` does, and each form with any character percent-encoded or a space as `+`. */
  private encodedPattern: RegExp | undefined;
  private cutForms: CutForm[] = [];
  /** Matching work per character of text, for `pattern` and for `encodedPattern`. */
  private weight = { plain: 0, encoded: 0 };

  /** No secret has been typed. */
  get empty(): boolean {
    return this.short.size === 0 && this.inline.size === 0;
  }

  add(value: string): void {
    const secret = collapse(value);
    if (!secret) return;
    if (secret.length < MIN_INLINE_LENGTH) {
      this.short.add(secret);
      return;
    }
    if (this.inline.has(secret)) return;
    this.inline.add(secret);
    // Composed and decomposed, so a page that normalizes the text differently still matches.
    // Longest first, so a secret that contains another is replaced whole.
    const variants = [...new Set([...this.inline].flatMap((each) => [each, each.normalize('NFC'), each.normalize('NFD')]))]
      .sort((a, b) => b.length - a.length);
    this.variants = variants;
    this.pattern = new RegExp(variants.map((each) => secretPattern(each, false)).join('|'), 'g');
    this.encodedPattern = new RegExp(variants.map((each) => secretPattern(each, true)).join('|'), 'g');
    this.cutForms = [...new Set(variants.flatMap((each) => [each, escapeQuoted(each)]))]
      .sort((a, b) => b.length - a.length)
      .map(cutForm);
    // Matching work at each character of text grows with the pattern's size, and each cut form scans the text once.
    const passes = this.cutForms.length + 1;
    this.weight = { plain: this.pattern.source.length + passes, encoded: this.encodedPattern.source.length + passes };
  }

  /** Throws `RedactionBudgetError` when matching the text would exceed the budget, before any matching. */
  redact(text: string, budget: RedactionBudget = new RedactionBudget()): string {
    return this.replace(text, REDACTED, budget);
  }

  /** Whether the text shows a typed secret in any form `redact` replaces. */
  shows(text: string, budget: RedactionBudget = new RedactionBudget()): boolean {
    return this.redact(text, budget) !== text;
  }

  /**
   * Whether the whole text is the start of a typed secret, 4 characters or
   * longer, as a form field that cut what was typed into it holds it. In
   * another letter case too when the secret is 8 characters or more.
   */
  startsSecret(text: string): boolean {
    const value = collapse(text);
    if (value.length < MIN_INLINE_LENGTH) return false;
    return this.variants.some((secret) => secret.startsWith(value) ||
      (secret.length >= CASELESS_MIN_LENGTH && secret.toLowerCase().startsWith(value.toLowerCase())));
  }

  /**
   * Also takes each path segment, query key or value and fragment part as one
   * field, decoded with and without `+` as a space. A short secret that is a
   * whole part is found there, and so is a form that shows only once decoded.
   */
  redactUrl(url: string, budget: RedactionBudget = new RedactionBudget()): string {
    return this.redact(url, budget).replace(/[^/?#&=;:@]+/g, (part) => {
      const decoded = [percentDecode(part.replace(/\+/g, ' ')), percentDecode(part)];
      return decoded.some((each) => this.shows(each, budget)) ? REDACTED : part;
    });
  }

  private replace(text: string, replacement: string, budget: RedactionBudget): string {
    if (this.short.size > 0) {
      budget.spend(text.length);
      if (this.short.has(collapse(text))) return replacement;
    }
    if (!this.pattern || !this.encodedPattern) return text;
    // Only text with a `%` or a `+` can hold an encoded form, and the plain pattern is much the faster on the rest.
    const encoded = /[%+]/.test(text);
    budget.spend(text.length * (encoded ? this.weight.encoded : this.weight.plain));
    let result = text.replace(encoded ? this.encodedPattern : this.pattern, replacement);
    for (const form of this.cutForms) result = replaceCutPrefix(result, form, replacement);
    return result;
  }
}
