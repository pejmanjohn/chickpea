import { isZipSignature } from './zip.ts';

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

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
const TEXT_NAMES = /\.(?:md|markdown|txt|text|csv|tsv|json|jsonl|ndjson|yaml|yml|toml|ini|cfg|conf|env|xml|html?|css|scss|less|svg|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ps1|sql|graphql|gql|log|rst|tex|r|lua|pl|vue|svelte)$/i;
/** How many leading bytes the text rule decodes. */
const TEXT_SNIFF_BYTES = 4_096;

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
  { kind: { kind: 'pdf' }, bytes: (head) => startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d]), names: /\.pdf$/i },
  { kind: { kind: 'other' }, bytes: (head, name) => isZipSignature(head) && OFFICE_NAMES.test(name), names: OFFICE_NAMES },
  { kind: { kind: 'archive' }, bytes: isZipSignature, names: /\.(?:zip|skill)$/i },
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

/** Strict UTF-8 without binary control characters; a sequence cut at the sniff boundary is allowed. */
function looksLikeText(head: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, TEXT_SNIFF_BYTES), { stream: true });
  } catch {
    return false;
  }
  return !/[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/.test(text);
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.byteLength >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}
