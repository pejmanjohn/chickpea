import { isZipSignature } from './zip.ts';

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set<ImageMimeType>(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export type FileKind =
  | { readonly kind: 'image'; readonly mimeType: ImageMimeType }
  | { readonly kind: 'pdf' | 'archive' | 'text' | 'other' };

/**
 * One way to recognize a kind. `bytes` decides when the leading bytes are
 * known; `names` decides when only the name is, as in an archive listing.
 */
interface KindRule {
  readonly kind: FileKind;
  readonly bytes?: (head: Uint8Array, name: string) => boolean;
  readonly names?: RegExp;
}

const OFFICE_NAMES = /\.(?:docx|docm|xlsx|xlsm|pptx|pptm|odt|ods|odp|key|numbers|pages)$/i;
const PDF_NAMES = /\.pdf$/i;
const ARCHIVE_NAMES = /\.(?:zip|skill)$/i;
const TEXT_NAMES = /\.(?:md|markdown|txt|text|csv|tsv|json|jsonl|ndjson|yaml|yml|toml|ini|cfg|conf|env|xml|html?|css|scss|less|svg|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ps1|sql|graphql|gql|log|rst|tex|r|lua|pl|vue|svelte)$/i;
/** How many leading bytes the text rule decodes. */
const TEXT_SNIFF_BYTES = 4_096;
const BINARY_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/;

/** First match wins. Office documents are zips by magic, so they come before archives. */
const KIND_RULES: readonly KindRule[] = [
  {
    kind: { kind: 'image', mimeType: 'image/png' },
    bytes: (head) => startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    names: /\.png$/i,
  },
  { kind: { kind: 'image', mimeType: 'image/jpeg' }, bytes: (head) => startsWith(head, [0xff, 0xd8, 0xff]), names: /\.jpe?g$/i },
  {
    kind: { kind: 'image', mimeType: 'image/gif' },
    bytes: (head) => startsWith(head, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
      startsWith(head, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
    names: /\.gif$/i,
  },
  {
    kind: { kind: 'image', mimeType: 'image/webp' },
    bytes: (head) => startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head.subarray(8), [0x57, 0x45, 0x42, 0x50]),
    names: /\.webp$/i,
  },
  { kind: { kind: 'pdf' }, bytes: (head) => startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d]), names: PDF_NAMES },
  { kind: { kind: 'other' }, bytes: (head, name) => isZipSignature(head) && OFFICE_NAMES.test(name), names: OFFICE_NAMES },
  { kind: { kind: 'archive' }, bytes: isZipSignature, names: ARCHIVE_NAMES },
  { kind: { kind: 'text' }, bytes: looksLikeText, names: TEXT_NAMES },
];

/**
 * What a file is, from its leading bytes when they are known and from its
 * name when they are not. Pass the whole file or at least its first 4 KiB.
 */
export function sniffFileKind(name: string, head?: Uint8Array): FileKind {
  for (const rule of KIND_RULES) {
    const matches = head ? rule.bytes?.(head, name) : rule.names?.test(name);
    if (matches) return rule.kind;
  }
  return { kind: 'other' };
}

const TEXT_APPLICATION_MIME_TYPES = new Set([
  'application/graphql',
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/sql',
  'application/toml',
  'application/typescript',
  'application/x-httpd-php',
  'application/x-javascript',
  'application/x-ndjson',
  'application/x-sh',
  'application/x-yaml',
  'application/xml',
  'application/yaml',
]);

export function isTextMimeType(mimeType: string): boolean {
  return (mimeType.startsWith('text/') && mimeType !== 'text/rtf') || TEXT_APPLICATION_MIME_TYPES.has(mimeType);
}

/** The gateway's Office list (OFFICE_MIME_TYPES, OFFICE_TYPES): it serves these as Slack's PDF copy. */
const DOCUMENT_MIME_TYPES = new Set([
  'application/msword',
  'application/rtf',
  'application/vnd.apple.keynote',
  'application/vnd.apple.numbers',
  'application/vnd.apple.pages',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/rtf',
]);
const DOCUMENT_NAMES = /\.(?:doc|docx|key|keynote|numbers|odp|ods|odt|pages|ppt|pptx|rtf|xls|xlsx)$/i;

export type ReadableFileKind = 'archive' | 'pdf' | 'document' | 'text';

export function readableFileKind(name: string, mimeType?: string): ReadableFileKind | undefined {
  // Slack serves no image as text or a document (an SVG is refused by both readers).
  if (mimeType?.startsWith('image/')) return undefined;
  if (ARCHIVE_NAMES.test(name)) return 'archive';
  if (mimeType === 'application/pdf' || PDF_NAMES.test(name)) return 'pdf';
  if ((mimeType !== undefined && DOCUMENT_MIME_TYPES.has(mimeType)) || DOCUMENT_NAMES.test(name)) return 'document';
  if ((mimeType !== undefined && isTextMimeType(mimeType)) || TEXT_NAMES.test(name)) return 'text';
  return undefined;
}

/** The whole file as text: strict UTF-8 without binary control characters, else undefined. */
export function decodeText(bytes: Uint8Array): string | undefined {
  return strictText(bytes, false);
}

/** The text rule on the leading bytes; a character cut at the sniff boundary is allowed. */
function looksLikeText(head: Uint8Array): boolean {
  return strictText(head.subarray(0, TEXT_SNIFF_BYTES), true) !== undefined;
}

function strictText(bytes: Uint8Array, stream: boolean): string | undefined {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream });
  } catch {
    return undefined;
  }
  return BINARY_CONTROL_CHARACTER.test(text) ? undefined : text;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.byteLength >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}
