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
  // PEM armor first: a token's class takes hyphens and letters in any case,
  // so a token glued to a BEGIN line (`xoxb-…-----BEGIN …`) would consume
  // its dashes and `BEGIN` and leave the key after it. A token inside armor
  // goes with the block.
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
  return traceCredentialRedaction(text).text;
}

export const CREDENTIAL_REPLACEMENT = '[credential redacted]';

/**
 * `redactCredentialLikeContent(text)`, and `source(at)`: where the character
 * at `at` of it came from in `text`, for a character `text` supplied rather
 * than a `[credential redacted]` marker, or the end.
 */
export function traceCredentialRedaction(text: string): {
  text: string;
  source: (at: number) => number;
} {
  const { text: redacted, stages } = redactionStages(text);
  return { text: redacted, source: (at) => positionsBefore(stages)(at) };
}

/**
 * Where `redactCredentialLikeContent` rewrites `text`, as `[start, end)`
 * ranges in order that never overlap; the rest of `text` stays as written.
 * A range that reads an earlier signature's marker (`OPENAI_API_KEY=` before
 * a redacted token) covers the text that marker replaced. Ranges that only
 * touch stay separate.
 */
export function credentialMatchRanges(text: string): CredentialRange[] {
  const { stages } = redactionStages(text);
  // No signature starts inside a marker, so only an end can land in one and
  // each stage's ranges stay in order as they map back.
  const found = stages.flatMap((ranges, stage) => {
    const before = positionsBefore(stages.slice(0, stage));
    return ranges.map(([start, end]): CredentialRange => [before(start), before(end, true)]);
  });
  const merged: CredentialRange[] = [];
  for (const [start, end] of found.sort(([a], [b]) => a - b)) {
    const last = merged.at(-1);
    if (last && start < last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * The redacted text, and each matching signature's ranges in the text it
 * read. Each signature reads what the ones before it left (the truncated PEM
 * finder reads the text after complete blocks are replaced), so a position
 * maps back one signature at a time.
 */
function redactionStages(text: string): { text: string; stages: CredentialRange[][] } {
  const stages: CredentialRange[][] = [];
  let redacted = text;
  for (const find of CREDENTIAL_FINDERS) {
    const ranges = find(redacted);
    if (!ranges.length) continue;
    stages.push(ranges);
    let replaced = '';
    let from = 0;
    for (const [start, end] of ranges) {
      replaced += `${redacted.slice(from, start)}${CREDENTIAL_REPLACEMENT}`;
      from = end;
    }
    redacted = replaced + redacted.slice(from);
  }
  return { text: redacted, stages };
}

/**
 * Where positions sat before `stages` replaced their ranges, asked in
 * ascending order, so one walk of each stage answers them all. Inside a
 * marker, a position is its range's start, and a range end that reads any
 * of the marker is its range's end.
 */
function positionsBefore(stages: readonly CredentialRange[][]): (at: number, isEnd?: boolean) => number {
  const walks = stages.map((ranges) => {
    let next = 0;
    let shift = 0;
    return (at: number, isEnd: boolean): number => {
      for (; next < ranges.length; next += 1) {
        const [start, end] = ranges[next]!;
        const marker = start - shift;
        if (at < marker) break;
        if (at < marker + CREDENTIAL_REPLACEMENT.length) return isEnd && at > marker ? end : start;
        shift += end - start - CREDENTIAL_REPLACEMENT.length;
      }
      return at + shift;
    };
  });
  return (at, isEnd = false) => walks.reduceRight((position, walk) => walk(position, isEnd), at);
}

/** Literal prefixes of the signatures above, for streaming tail suppression. */
export function credentialMarkers(): readonly string[] {
  return CREDENTIAL_MARKERS;
}

// PEM armor lines are `-----BEGIN <label>-----` and `-----END <label>-----`,
// case-insensitive. A label is `PRIVATE KEY`, optionally after a prefix of a
// letter or digit, up to 62 letters, digits, spaces or single hyphens, and a
// space (`RSA `, `ENCRYPTED `). With no two hyphens in a row, a label never
// holds another armor line's dashes, so it reads one way: up to the first
// `PRIVATE KEY-----` after its line's start.
const PEM_BEGIN = /-----BEGIN /gi;
const PEM_END = /-----END /gi;
const PEM_LABEL_AT = /(?:[A-Z0-9](?:[A-Z0-9 ]|-(?!-)){0,62} )?PRIVATE KEY(?=-----)/iy;
const PEM_LABEL_MAX = 1 + 62 + 1 + 'PRIVATE KEY'.length;
// The most text armor holds after its BEGIN line: up to the END line, or
// for a truncated block, up to the end of the text.
const PEM_BODY_MAX = 262_144;

/**
 * Complete armor: a BEGIN line, at most `PEM_BODY_MAX` characters, then the
 * first END line with the same label in any case. Blocks never overlap; a
 * BEGIN line inside one is body text. A BEGIN line in the closing dashes of
 * the END line before it (`…KEY-----BEGIN …`) takes those dashes: left in
 * that block, they would hide the BEGIN line from the truncated finder and
 * show the key after it.
 *
 * Each END line is read once and each BEGIN line looks its label up, so text
 * full of unclosed BEGIN lines stays linear: searching from every BEGIN line
 * was quadratic, and the streaming path redacts the whole answer per chunk.
 */
function completePemArmor(text: string): CredentialRange[] {
  const armor: CredentialRange[] = [];
  let endLines: Map<string, number[]> | undefined;
  let from = 0;
  for (const { begin, labelEnd } of pemBeginLines(text)) {
    // The last block ends with its END line's closing dashes; a BEGIN line
    // that starts in them takes them.
    if (from - '-----'.length <= begin && begin < from) armor.at(-1)![1] = from = begin;
    if (begin < from) continue;
    endLines ??= pemEndLines(text);
    const label = text.slice(begin + '-----BEGIN '.length, labelEnd).toUpperCase();
    const bodyStart = labelEnd + '-----'.length;
    const starts = endLines.get(label) ?? [];
    const end = starts[firstAtOrAfter(starts, bodyStart)];
    if (end !== undefined && end - bodyStart <= PEM_BODY_MAX) {
      from = end + '-----END '.length + label.length + '-----'.length;
      armor.push([begin, from]);
    }
  }
  return armor;
}

/** A truncated block: from the first BEGIN line within `PEM_BODY_MAX` of the end, to the end. */
function truncatedPemArmor(text: string): CredentialRange[] {
  const line = pemBeginLines(text).find(({ labelEnd }) =>
    text.length - (labelEnd + '-----'.length) <= PEM_BODY_MAX);
  return line ? [[line.begin, text.length]] : [];
}

/**
 * Each BEGIN line with a valid label: where it starts and its label ends. A
 * `-----BEGIN ` in the closing dashes of the BEGIN line before it
 * (`…KEY-----BEGIN …`) belongs to that line; were it another, the block it
 * opens would take those dashes, and the earlier line with them.
 */
function pemBeginLines(text: string): Array<{ begin: number; labelEnd: number }> {
  const lines: Array<{ begin: number; labelEnd: number }> = [];
  let closed = 0;
  for (const { index: begin } of text.matchAll(PEM_BEGIN)) {
    const labelEnd = pemLabelEnd(text, begin + '-----BEGIN '.length);
    if (labelEnd === undefined) continue;
    if (begin >= closed) lines.push({ begin, labelEnd });
    closed = labelEnd + '-----'.length;
  }
  return lines;
}

const PEM_BEGIN_LINE_MAX = '-----BEGIN '.length + PEM_LABEL_MAX + '-----'.length;

/**
 * The start of the PEM BEGIN line `at` falls inside, else `at`, reading
 * nothing at or after `end`. Whether a `-----BEGIN ` starts a line depends
 * only on the line before it, so a window of two lines' length before `at`
 * decides it.
 */
export function pemBeginLineStart(text: string, at: number, end = text.length): number {
  const from = Math.max(0, at - 2 * PEM_BEGIN_LINE_MAX);
  const window = text.slice(from, Math.min(end, at + PEM_BEGIN_LINE_MAX));
  const line = pemBeginLines(window).find(({ begin, labelEnd }) =>
    from + begin < at && at < from + labelEnd + '-----'.length);
  return line ? from + line.begin : at;
}

/** Where each END line starts, by the label it closes (upper-cased), in order. */
function pemEndLines(text: string): Map<string, number[]> {
  const endLines = new Map<string, number[]>();
  for (const { index: end } of text.matchAll(PEM_END)) {
    const labelStart = end + '-----END '.length;
    const labelEnd = pemLabelEnd(text, labelStart);
    if (labelEnd === undefined) continue;
    const label = text.slice(labelStart, labelEnd).toUpperCase();
    const starts = endLines.get(label);
    if (starts) starts.push(end);
    else endLines.set(label, [end]);
  }
  return endLines;
}

/** Where the label that starts at `start` and is closed by `-----` ends, if it is one. */
function pemLabelEnd(text: string, start: number): number | undefined {
  PEM_LABEL_AT.lastIndex = start;
  const label = PEM_LABEL_AT.exec(text);
  return label ? start + label[0].length : undefined;
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
