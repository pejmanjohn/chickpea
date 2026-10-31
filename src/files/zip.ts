/**
 * A bounded reader for the ZIP subset real tools write for small archives:
 * one disk, no Zip64, no encryption, entries stored (method 0) or deflated
 * (method 8). Entries are listed from the central directory and inflated only
 * on `read()`, which every caller bounds per entry and in total.
 */

const DEFAULT_MAX_ZIP_ENTRIES = 2000;

/** Why an archive, or one entry's read, was refused. Messages are each caller's. */
export type ZipProblem =
  | { readonly code: 'not_a_zip' | 'zip64' | 'split' | 'damaged' | 'encrypted' }
  | { readonly code: 'too_many_entries'; readonly entries: number; readonly limit: number }
  | { readonly code: 'unsafe_path'; readonly path: string }
  | { readonly code: 'unsupported_method'; readonly method: number }
  | { readonly code: 'header_mismatch' | 'size_mismatch' | 'inflate_failed' | 'budget_exceeded' }
  | { readonly code: 'entry_too_large'; readonly size: number; readonly limit: number };

export type ZipErrorCode = ZipProblem['code'];

export class ZipArchiveError extends Error {
  readonly code: ZipErrorCode;
  constructor(readonly problem: ZipProblem) {
    super(neutralMessage(problem));
    this.name = 'ZipArchiveError';
    this.code = problem.code;
  }
}

/** Inflated bytes shared by every read it is passed to, across archives. */
export interface ByteBudget {
  readonly remaining: number;
  /** Takes `bytes` when they fit and reports whether they did; a refusal takes nothing. */
  take(bytes: number): boolean;
}

export function createByteBudget(limit: number): ByteBudget {
  let remaining = limit;
  return {
    get remaining() { return remaining; },
    take(bytes) {
      if (bytes > remaining) return false;
      remaining -= bytes;
      return true;
    },
  };
}

export interface ZipOpenOptions {
  /** More central-directory records than this refuses the archive. Default 2000. */
  maxEntries?: number;
  /** `read()` refuses an entry whose declared size passes this, before inflating. */
  maxEntryBytes: number;
  /** Every `read()` takes its declared size from this before inflating. */
  budget: ByteBudget;
  /** Leave out directories and archive-tool droppings. Default true. */
  skipJunk?: boolean;
}

export interface ZipEntry {
  /** `/`-separated path inside the archive. */
  readonly path: string;
  /** Uncompressed size the central directory declares. */
  readonly size: number;
  /** Inflates the entry, refusing output that differs from `size`. */
  read(): Promise<Uint8Array>;
}

export interface ZipArchive {
  readonly entries: readonly ZipEntry[];
  entry(path: string): ZipEntry | undefined;
}

/** A local file header, or the end record of an empty archive. */
export function isZipSignature(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06));
}

/** Directories and what archive tools add beside content: `__MACOSX/`, `._*`, `.DS_Store`. */
export function isZipJunkPath(path: string): boolean {
  const parts = path.split('/');
  const name = parts[parts.length - 1]!;
  return name === '' || parts.includes('__MACOSX') || name.startsWith('._') || name === '.DS_Store';
}

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_SIZE = 22;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_SIZE = 46;
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_SIZE = 30;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;

export function openZip(bytes: Uint8Array, options: ZipOpenOptions): ZipArchive {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ZIP_ENTRIES;
  const skipJunk = options.skipJunk ?? true;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new ZipArchiveError({ code: 'not_a_zip' });
  const diskNumber = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const diskEntries = view.getUint16(eocd + 8, true);
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (count === UINT16_MAX || centralSize === UINT32_MAX || centralOffset === UINT32_MAX ||
      (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIGNATURE)) {
    throw new ZipArchiveError({ code: 'zip64' });
  }
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== count) {
    throw new ZipArchiveError({ code: 'split' });
  }
  if (count > maxEntries) {
    throw new ZipArchiveError({ code: 'too_many_entries', entries: count, limit: maxEntries });
  }
  if (centralOffset + centralSize > eocd) throw new ZipArchiveError({ code: 'damaged' });

  const names = new TextDecoder();
  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + CENTRAL_SIZE > centralOffset + centralSize || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new ZipArchiveError({ code: 'damaged' });
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const end = offset + CENTRAL_SIZE + nameLength + extraLength + commentLength;
    if (end > centralOffset + centralSize) throw new ZipArchiveError({ code: 'damaged' });
    const rawName = bytes.subarray(offset + CENTRAL_SIZE, offset + CENTRAL_SIZE + nameLength);
    if (compressedSize === UINT32_MAX || size === UINT32_MAX || localOffset === UINT32_MAX) {
      throw new ZipArchiveError({ code: 'zip64' });
    }
    if (flags & 1) throw new ZipArchiveError({ code: 'encrypted' });
    const path = names.decode(rawName).replace(/\\/g, '/');
    if (path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').includes('..')) {
      throw new ZipArchiveError({ code: 'unsafe_path', path });
    }
    offset = end;
    if (skipJunk && isZipJunkPath(path)) continue;
    const record = { rawName, method, compressedSize, size, localOffset, centralOffset };
    entries.push({
      path,
      size,
      read: async () => {
        if (size > options.maxEntryBytes) {
          throw new ZipArchiveError({ code: 'entry_too_large', size, limit: options.maxEntryBytes });
        }
        if (!options.budget.take(size)) throw new ZipArchiveError({ code: 'budget_exceeded' });
        return readEntry(bytes, view, record);
      },
    });
  }
  const byPath = new Map<string, ZipEntry>();
  for (const entry of entries) if (!byPath.has(entry.path)) byPath.set(entry.path, entry);
  return { entries, entry: (path) => byPath.get(path) };
}

function findEndOfCentralDirectory(view: DataView): number {
  const lowest = Math.max(0, view.byteLength - EOCD_SIZE - UINT16_MAX);
  for (let offset = view.byteLength - EOCD_SIZE; offset >= lowest; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE &&
        offset + EOCD_SIZE + view.getUint16(offset + 20, true) === view.byteLength) return offset;
  }
  return -1;
}

async function readEntry(bytes: Uint8Array, view: DataView, entry: {
  rawName: Uint8Array;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  centralOffset: number;
}): Promise<Uint8Array> {
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipArchiveError({ code: 'unsupported_method', method: entry.method });
  }
  const local = entry.localOffset;
  if (local + LOCAL_SIZE > entry.centralOffset || view.getUint32(local, true) !== LOCAL_SIGNATURE) {
    throw new ZipArchiveError({ code: 'header_mismatch' });
  }
  const nameLength = view.getUint16(local + 26, true);
  const dataStart = local + LOCAL_SIZE + nameLength + view.getUint16(local + 28, true);
  const localName = bytes.subarray(local + LOCAL_SIZE, local + LOCAL_SIZE + nameLength);
  if (view.getUint16(local + 8, true) !== entry.method || !sameBytes(localName, entry.rawName) ||
      dataStart + entry.compressedSize > entry.centralOffset) {
    throw new ZipArchiveError({ code: 'header_mismatch' });
  }
  const data = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  const content = entry.method === 0 ? data : await inflateRaw(data, entry.size);
  if (content.byteLength !== entry.size) throw new ZipArchiveError({ code: 'size_mismatch' });
  return content;
}

/** Stops as soon as the output passes `limit`, so a zip bomb costs at most one chunk more. */
async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  writer.write(data as Uint8Array<ArrayBuffer>).catch(() => undefined);
  writer.close().catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new ZipArchiveError({ code: 'size_mismatch' });
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ZipArchiveError) throw error;
    throw new ZipArchiveError({ code: 'inflate_failed' });
  }
  const content = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function neutralMessage(problem: ZipProblem): string {
  switch (problem.code) {
    case 'not_a_zip': return 'This file is not a readable zip archive.';
    case 'zip64': return 'This archive uses Zip64, which is not supported.';
    case 'split': return 'Split zip archives are not supported.';
    case 'damaged': return 'This zip archive is damaged.';
    case 'encrypted': return 'This archive is encrypted.';
    case 'too_many_entries': return `This archive has ${problem.entries} entries. The limit is ${problem.limit}.`;
    case 'unsafe_path': return `This archive has a path outside the archive: ${problem.path}.`;
    case 'unsupported_method': return `This file uses zip compression method ${problem.method}. Only stored and deflated files can be read.`;
    case 'header_mismatch': return 'This file does not match its zip header.';
    case 'size_mismatch': return 'This file does not match its declared size.';
    case 'inflate_failed': return 'This file could not be unpacked.';
    case 'entry_too_large': return `This file unpacks to ${problem.size} bytes. The limit is ${problem.limit}.`;
    case 'budget_exceeded': return 'The files read from these archives exceed the size limit.';
  }
}
