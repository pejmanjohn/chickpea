/**
 * A bounded reader for the ZIP subset skill archives use: one disk, no Zip64,
 * no encryption, entries stored (method 0) or deflated (method 8). Entries are
 * listed from the central directory and inflated only on `read()`.
 */

export const MAX_ZIP_ENTRIES = 2000;
export const NOT_A_ZIP_ARCHIVE = 'This file is not a readable zip archive.';

export interface ZipEntry {
  /** Normalized `/`-separated path; directories end with `/`. */
  path: string;
  /** Uncompressed size the central directory declares. */
  size: number;
  /** Inflates the entry, refusing output that differs from `size`. */
  read(): Promise<Uint8Array>;
}

export class ZipArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipArchiveError';
  }
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

export function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new ZipArchiveError(NOT_A_ZIP_ARCHIVE);
  const diskNumber = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const diskEntries = view.getUint16(eocd + 8, true);
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (count === UINT16_MAX || centralSize === UINT32_MAX || centralOffset === UINT32_MAX ||
      (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIGNATURE)) {
    throw new ZipArchiveError('This archive uses Zip64, which upload does not support.');
  }
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== count) {
    throw new ZipArchiveError('Split zip archives are not supported.');
  }
  if (count > MAX_ZIP_ENTRIES) {
    throw new ZipArchiveError(`This archive has ${count} entries. The limit is ${MAX_ZIP_ENTRIES}.`);
  }
  if (centralOffset + centralSize > eocd) throw new ZipArchiveError('This zip archive is damaged.');

  const names = new TextDecoder();
  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + CENTRAL_SIZE > centralOffset + centralSize || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new ZipArchiveError('This zip archive is damaged.');
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
    if (end > centralOffset + centralSize) throw new ZipArchiveError('This zip archive is damaged.');
    const rawName = bytes.subarray(offset + CENTRAL_SIZE, offset + CENTRAL_SIZE + nameLength);
    if (compressedSize === UINT32_MAX || size === UINT32_MAX || localOffset === UINT32_MAX) {
      throw new ZipArchiveError('This archive uses Zip64, which upload does not support.');
    }
    if (flags & 1) throw new ZipArchiveError('This archive is encrypted.');
    const path = names.decode(rawName).replace(/\\/g, '/');
    if (path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').includes('..')) {
      throw new ZipArchiveError(`This archive has a path outside the archive: ${path}.`);
    }
    entries.push({
      path,
      size,
      read: () => readEntry(bytes, view, { rawName, method, compressedSize, size, localOffset, centralOffset }),
    });
    offset = end;
  }
  return entries;
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
    throw new ZipArchiveError(`This file uses zip compression method ${entry.method}. Upload reads stored and deflated files.`);
  }
  const local = entry.localOffset;
  if (local + LOCAL_SIZE > entry.centralOffset || view.getUint32(local, true) !== LOCAL_SIGNATURE) {
    throw new ZipArchiveError('This file does not match its zip header.');
  }
  const nameLength = view.getUint16(local + 26, true);
  const dataStart = local + LOCAL_SIZE + nameLength + view.getUint16(local + 28, true);
  const localName = bytes.subarray(local + LOCAL_SIZE, local + LOCAL_SIZE + nameLength);
  if (view.getUint16(local + 8, true) !== entry.method || !sameBytes(localName, entry.rawName) ||
      dataStart + entry.compressedSize > entry.centralOffset) {
    throw new ZipArchiveError('This file does not match its zip header.');
  }
  const data = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  const content = entry.method === 0 ? data : await inflateRaw(data, entry.size);
  if (content.byteLength !== entry.size) throw new ZipArchiveError('This file does not match its declared size.');
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
        throw new ZipArchiveError('This file does not match its declared size.');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ZipArchiveError) throw error;
    throw new ZipArchiveError('This file could not be unpacked.');
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
