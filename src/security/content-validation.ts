const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

/** A redacted span of text, `[start, end)`. */
type CredentialRange = [number, number];

/**
 * One table behind three consumers: the detector, the redactor, and the plain
 * text markers the Slack streaming path holds back until a token boundary
 * proves terminal redaction can no longer rewrite the tail.
 *
 * Flags are per signature on purpose: the AWS access-key-id shape is
 * case-sensitive today, and widening it to `i` would change what counts as a
 * credential.
 */
const CREDENTIAL_SIGNATURES: readonly (
  | { source: string; flags: string; markers: readonly string[] }
  | { find: (text: string) => CredentialRange[]; markers: readonly string[] }
)[] = [
  { source: String.raw`\bxox[a-z]-[a-z0-9-]{20,}\b`, flags: 'i', markers: ['xox'] },
  { source: String.raw`\bxapp-[a-z0-9-]{20,}\b`, flags: 'i', markers: ['xapp-'] },
  { source: String.raw`\bsk-ant-[a-z0-9_-]{20,}\b`, flags: 'i', markers: ['sk-ant-'] },
  {
    source: String.raw`\bsk-proj-[a-z0-9_-]{20,}(?![a-z0-9_-])`,
    flags: 'i',
    markers: ['sk-proj-'],
  },
  {
    source: String.raw`\b(?:gh[pousr]|github_pat)_[a-z0-9_]{20,}\b`,
    flags: 'i',
    markers: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'],
  },
  { source: String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`, flags: '', markers: ['AKIA', 'ASIA'] },
  { source: String.raw`\bbb_(?:live|test)_[a-z0-9_-]{8,}`, flags: 'i', markers: ['bb_live_', 'bb_test_'] },
  {
    // Consume complete armor, including traditional encrypted-PEM metadata
    // and blank lines. The hard character ceiling bounds malformed input.
    find: completePemArmor,
    markers: ['-----BEGIN '],
  },
  {
    // A truncated PEM has no trustworthy content boundary. Fail closed by
    // removing the bounded remainder instead of exposing key material after
    // merely replacing the BEGIN line.
    find: truncatedPemArmor,
    markers: [],
  },
  {
    source: String.raw`\b(?:CHICKPEA_(?:AUTH_SECRET|RECOVERY_TOKEN|CREDENTIAL_KEY_[A-Z0-9_]+)|TAG_ADMIN_TOKEN|ADMIN_TOKEN|SLACK_(?:BOT|APP)_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|COMPOSIO_(?:API_KEY|WEBHOOK_SECRET)|GITHUB_TOKEN|BROWSERBASE_API_KEY)\s*=\s*[^\s]{8,}`,
    flags: 'i',
    markers: [
      'CHICKPEA_AUTH_SECRET',
      'CHICKPEA_RECOVERY_TOKEN',
      'CHICKPEA_CREDENTIAL_KEY_',
      'TAG_ADMIN_TOKEN',
      'ADMIN_TOKEN',
      'SLACK_BOT_TOKEN',
      'SLACK_APP_TOKEN',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'COMPOSIO_API_KEY',
      'COMPOSIO_WEBHOOK_SECRET',
      'GITHUB_TOKEN',
      'BROWSERBASE_API_KEY',
    ],
  },
  {
    source: String.raw`\bAWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)\b["']?\s*(?:=|:)\s*["']?[a-z0-9/+=]{8,}`,
    flags: 'i',
    markers: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
  },
];

const CREDENTIAL_FINDERS = CREDENTIAL_SIGNATURES.map((signature) => {
  if ('find' in signature) return signature.find;
  const pattern = new RegExp(signature.source, `${signature.flags}g`);
  return (text: string) => [...text.matchAll(pattern)].map((match): CredentialRange =>
    [match.index, match.index + match[0].length]);
});
const CREDENTIAL_MARKERS: readonly string[] = CREDENTIAL_SIGNATURES.flatMap(
  (signature) => signature.markers,
);

export function hasDisallowedControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER_PATTERN.test(value);
}

export function hasCredentialLikeContent(value: string): boolean {
  return CREDENTIAL_FINDERS.some((find) => find(value).length > 0);
}

export function redactCredentialLikeContent(text: string): string {
  return CREDENTIAL_FINDERS.reduce((value, find) => {
    const ranges = find(value);
    if (!ranges.length) return value;
    let redacted = '';
    let from = 0;
    for (const [start, end] of ranges) {
      redacted += `${value.slice(from, start)}[credential redacted]`;
      from = end;
    }
    return redacted + value.slice(from);
  }, text);
}

/** Where `redactCredentialLikeContent` redacts `text`, as `[start, end)` ranges. */
export function credentialMatchRanges(text: string): CredentialRange[] {
  return CREDENTIAL_FINDERS.flatMap((find) => find(text));
}

/** Literal prefixes of the signatures above, for streaming tail suppression. */
export function credentialMarkers(): readonly string[] {
  return CREDENTIAL_MARKERS;
}

// PEM armor lines are `-----BEGIN <label>-----` and `-----END <label>-----`,
// case-insensitive. A label is `PRIVATE KEY`, optionally after a prefix of a
// letter or digit, up to 62 letters, digits, spaces or hyphens, and a space
// (`RSA `, `ENCRYPTED `).
const PEM_BEGIN = /-----BEGIN /gi;
const PEM_END = /-----END /gi;
const PEM_LABEL = /^(?:[A-Z0-9][A-Z0-9 -]{0,62} )?PRIVATE KEY$/i;
const PEM_LABEL_TAIL = /PRIVATE KEY-----/gi;
const PEM_LABEL_MAX = 1 + 62 + 1 + 'PRIVATE KEY'.length;
// The most text armor holds after its BEGIN line: up to the END line, or
// for a truncated block, up to the end of the text.
const PEM_BODY_MAX = 262_144;

/**
 * Complete armor: a BEGIN line, at most `PEM_BODY_MAX` characters, then the
 * first END line with the same label in any case. A BEGIN line whose label
 * reads more than one way (`A PRIVATE KEY----- PRIVATE KEY`) tries its
 * longest reading first. Blocks never overlap; a BEGIN line inside one is
 * body text.
 *
 * Each END line is read once and each BEGIN line looks its label up, so text
 * full of unclosed BEGIN lines stays linear: searching from every BEGIN line
 * was quadratic, and the streaming path redacts the whole answer per chunk.
 */
function completePemArmor(text: string): CredentialRange[] {
  const armor: CredentialRange[] = [];
  let endLines: Map<string, number[]> | undefined;
  let from = 0;
  for (const { index: begin } of text.matchAll(PEM_BEGIN)) {
    if (begin < from) continue;
    const labelStart = begin + '-----BEGIN '.length;
    for (const labelEnd of pemLabelEnds(text, labelStart)) {
      endLines ??= pemEndLines(text);
      const label = text.slice(labelStart, labelEnd).toUpperCase();
      const bodyStart = labelEnd + '-----'.length;
      const starts = endLines.get(label) ?? [];
      const end = starts[firstAtOrAfter(starts, bodyStart)];
      if (end !== undefined && end - bodyStart <= PEM_BODY_MAX) {
        from = end + '-----END '.length + label.length + '-----'.length;
        armor.push([begin, from]);
        break;
      }
    }
  }
  return armor;
}

/** A truncated block: from the first BEGIN line within `PEM_BODY_MAX` of the end, to the end. */
function truncatedPemArmor(text: string): CredentialRange[] {
  for (const { index: begin } of text.matchAll(PEM_BEGIN)) {
    // The longest reading of a label ends last, so it reaches furthest.
    const [labelEnd] = pemLabelEnds(text, begin + '-----BEGIN '.length);
    if (labelEnd !== undefined && text.length - (labelEnd + '-----'.length) <= PEM_BODY_MAX) {
      return [[begin, text.length]];
    }
  }
  return [];
}

/** Where each END line starts, by every label it can close (upper-cased), in order. */
function pemEndLines(text: string): Map<string, number[]> {
  const endLines = new Map<string, number[]>();
  for (const { index: end } of text.matchAll(PEM_END)) {
    const labelStart = end + '-----END '.length;
    for (const labelEnd of pemLabelEnds(text, labelStart)) {
      const label = text.slice(labelStart, labelEnd).toUpperCase();
      const starts = endLines.get(label);
      if (starts) starts.push(end);
      else endLines.set(label, [end]);
    }
  }
  return endLines;
}

/** Where each label that starts at `start` and is closed by `-----` can end, longest first. */
function pemLabelEnds(text: string, start: number): number[] {
  const window = text.slice(start, start + PEM_LABEL_MAX + '-----'.length);
  const ends: number[] = [];
  for (const { index } of window.matchAll(PEM_LABEL_TAIL)) {
    const end = index + 'PRIVATE KEY'.length;
    if (PEM_LABEL.test(window.slice(0, end))) ends.unshift(start + end);
  }
  return ends;
}

/** The index of the first of the ascending `values` at or after `at`. */
function firstAtOrAfter(values: readonly number[], at: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < at) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An empty string is never a usable credential, id, or label. */
export function nonEmpty(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

/** As `nonEmpty`, for values whose surrounding whitespace is not significant. */
export function trimmedNonEmpty(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
