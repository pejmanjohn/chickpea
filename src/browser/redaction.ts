/**
 * Secrets typed into a page this turn, matched in every form the page or the
 * browser tools can show them in.
 *
 * A page may show a typed value with its whitespace collapsed, escaped as
 * JSON, cut short, or URL-encoded, and a snapshot collapses, cuts and escapes
 * it again. The tools redact each raw name, value and message before they
 * transform it, then redact their output once more.
 */

const REDACTED = '[redacted]';

/**
 * A secret shorter than this is replaced only where it is a whole field, such
 * as a revealed password box. Inside text it would erase ordinary words.
 */
const MIN_INLINE_LENGTH = 4;

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

/**
 * A whitespace run of a secret as text or a URL may carry it: any whitespace,
 * so a collapsed or rewrapped form matches, `+`, or an encoded space, tab,
 * line break or no-break space.
 */
const SPACE_FORMS = '(?:\\s|\\+|%20|%0[9a-dA-D]|%[cC]2%[aA]0)+';

/**
 * One character of a secret as text or a URL may carry it: as it is, or
 * percent-encoded in either hex case. A script that joins a typed value into
 * an address leaves some characters as they are and encodes others, so each
 * one matches both ways.
 */
function charForms(char: string): string {
  if (char === ' ') return SPACE_FORMS;
  const encoded = [...new TextEncoder().encode(char)]
    .map((byte) => `%${byte.toString(16).padStart(2, '0').replace(/[a-f]/g, (digit) => `[${digit}${digit.toUpperCase()}]`)}`)
    .join('');
  // The encoded form first: `%` is the start of its own encoding, `%25`.
  return `(?:${encoded}|${escapeRegExp(char)})`;
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
 * Replaces the start of a secret left in front of an ellipsis, as cutting a
 * long value leaves it: the longest prefix of the form that ends there.
 */
function redactCutPrefix(text: string, { form, failure }: CutForm): string {
  if (!text.includes(ELLIPSIS)) return text;
  let result = '';
  let from = 0;
  let matched = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === ELLIPSIS && matched >= MIN_INLINE_LENGTH) {
      result += text.slice(from, Math.max(from, i - matched)) + REDACTED;
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
  private pattern: RegExp | undefined;
  /** Matches all that `pattern` does, and each form with any character percent-encoded or a space as `+`. */
  private encodedPattern: RegExp | undefined;
  private cutForms: CutForm[] = [];

  add(value: string): void {
    const secret = collapse(value);
    if (!secret) return;
    if (secret.length < MIN_INLINE_LENGTH) {
      this.short.add(secret);
      return;
    }
    if (this.inline.has(secret)) return;
    this.inline.add(secret);
    // Longest first, so a secret that contains another is replaced whole.
    const forms = [...new Set([...this.inline].flatMap((each) => [each, escapeQuoted(each)]))]
      .sort((a, b) => b.length - a.length);
    // Each whitespace run matches any whitespace, so a collapsed or rewrapped form matches too.
    this.pattern = new RegExp(forms.map((form) => form.split(' ').map(escapeRegExp).join('\\s+')).join('|'), 'g');
    this.encodedPattern = new RegExp(forms.map((form) => [...form].map(charForms).join('')).join('|'), 'g');
    this.cutForms = forms.map(cutForm);
  }

  redact(text: string): string {
    if (this.short.size > 0 && this.short.has(collapse(text))) return REDACTED;
    if (!this.pattern || !this.encodedPattern) return text;
    // Only text with a `%` or a `+` can hold an encoded form, and the plain pattern is much the faster on the rest.
    let result = text.replace(/[%+]/.test(text) ? this.encodedPattern : this.pattern, REDACTED);
    for (const form of this.cutForms) result = redactCutPrefix(result, form);
    return result;
  }

  /**
   * Also takes each path segment, query key or value and fragment part as one
   * field, decoded with and without `+` as a space. A short secret that is a
   * whole part is found there, and so is a form that shows only once decoded.
   */
  redactUrl(url: string): string {
    return this.redact(url).replace(/[^/?#&=;:@]+/g, (part) => {
      const decoded = [percentDecode(part.replace(/\+/g, ' ')), percentDecode(part)];
      return decoded.some((each) => this.redact(each) !== each) ? REDACTED : part;
    });
  }
}
