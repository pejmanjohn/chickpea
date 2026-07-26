const BLOCK_SIZE = 512;
const MAX_ARCHIVE_FILES = 1_024;
const MAX_ARCHIVE_CONTENT_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface MemoryArchiveFile {
  path: string;
  content: string;
}

export function encodeMemoryArchive(files: readonly MemoryArchiveFile[]): Uint8Array {
  if (files.length > MAX_ARCHIVE_FILES) throw new Error('Memory archive has too many files.');
  const sorted = [...files].sort((left, right) => compareStable(left.path, right.path));
  const paths = new Set<string>();
  let contentBytes = 0;
  const chunks: Uint8Array[] = [];
  for (const file of sorted) {
    assertSafeArchivePath(file.path);
    if (paths.has(file.path)) throw new Error(`Memory archive has duplicate path: ${file.path}`);
    paths.add(file.path);
    const bytes = encoder.encode(file.content);
    contentBytes += bytes.byteLength;
    if (contentBytes > MAX_ARCHIVE_CONTENT_BYTES) throw new Error('Memory archive exceeds size limit.');
    chunks.push(createHeader(file.path, bytes.byteLength), bytes, new Uint8Array(padding(bytes.byteLength)));
  }
  chunks.push(new Uint8Array(BLOCK_SIZE * 2));
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function decodeMemoryArchive(archive: Uint8Array): MemoryArchiveFile[] {
  const files: MemoryArchiveFile[] = [];
  const paths = new Set<string>();
  let contentBytes = 0;
  let offset = 0;
  while (offset + BLOCK_SIZE <= archive.byteLength) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    verifyHeaderChecksum(header);
    if (readAscii(header, 257, 263) !== 'ustar') throw new Error('Only POSIX USTAR archives are supported.');
    const type = header[156];
    if (type !== 0 && type !== 48) throw new Error('Memory archive contains an unsupported entry type.');
    const name = readAscii(header, 0, 100);
    const prefix = readAscii(header, 345, 500);
    const path = prefix ? `${prefix}/${name}` : name;
    assertSafeArchivePath(path);
    if (paths.has(path)) throw new Error(`Memory archive has duplicate path: ${path}`);
    paths.add(path);
    const size = readOctal(header, 124, 136);
    offset += BLOCK_SIZE;
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > archive.byteLength) {
      throw new Error('Memory archive is truncated or has an invalid size.');
    }
    contentBytes += size;
    if (contentBytes > MAX_ARCHIVE_CONTENT_BYTES) throw new Error('Memory archive exceeds size limit.');
    if (files.length >= MAX_ARCHIVE_FILES) throw new Error('Memory archive has too many files.');
    files.push({ path, content: decoder.decode(archive.subarray(offset, offset + size)) });
    offset += size + padding(size);
  }
  return files.sort((left, right) => compareStable(left.path, right.path));
}

export function assertSafeArchivePath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    throw new Error('Memory archive contains an unsafe path.');
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Memory archive contains an unsafe path.');
  }
  const bytes = encoder.encode(path);
  if (bytes.byteLength > 255 || segments.some((segment) => encoder.encode(segment).byteLength > 100)) {
    throw new Error('Memory archive path is too long for USTAR.');
  }
}

function createHeader(path: string, size: number): Uint8Array {
  const header = new Uint8Array(BLOCK_SIZE);
  const split = splitUstarPath(path);
  writeAscii(header, 0, 100, split.name);
  writeOctal(header, 100, 108, 0o644);
  writeOctal(header, 108, 116, 0);
  writeOctal(header, 116, 124, 0);
  writeOctal(header, 124, 136, size);
  writeOctal(header, 136, 148, 0);
  header.fill(32, 148, 156);
  header[156] = 48;
  writeAscii(header, 257, 263, 'ustar');
  header[262] = 0;
  writeAscii(header, 263, 265, '00');
  writeAscii(header, 265, 297, 'chickpea');
  writeAscii(header, 297, 329, 'chickpea');
  if (split.prefix) writeAscii(header, 345, 500, split.prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const octal = checksum.toString(8).padStart(6, '0');
  writeAscii(header, 148, 154, octal);
  header[154] = 0;
  header[155] = 32;
  return header;
}

function splitUstarPath(path: string): { name: string; prefix: string } {
  if (encoder.encode(path).byteLength <= 100) return { name: path, prefix: '' };
  for (let index = path.lastIndexOf('/'); index > 0; index = path.lastIndexOf('/', index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (encoder.encode(prefix).byteLength <= 155 && encoder.encode(name).byteLength <= 100) {
      return { name, prefix };
    }
  }
  throw new Error('Memory archive path is too long for USTAR.');
}

function verifyHeaderChecksum(header: Uint8Array): void {
  const expected = readOctal(header, 148, 156);
  let actual = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index]!;
  }
  if (actual !== expected) throw new Error('Memory archive header checksum is invalid.');
}

function writeAscii(target: Uint8Array, start: number, end: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.byteLength > end - start) throw new Error('USTAR field is too long.');
  target.set(bytes, start);
}

function writeOctal(target: Uint8Array, start: number, end: number, value: number): void {
  const text = value.toString(8).padStart(end - start - 1, '0');
  writeAscii(target, start, end - 1, text);
  target[end - 1] = 0;
}

function readAscii(source: Uint8Array, start: number, end: number): string {
  const bytes = source.subarray(start, end);
  const nul = bytes.indexOf(0);
  return decoder.decode(nul >= 0 ? bytes.subarray(0, nul) : bytes).trimEnd();
}

function readOctal(source: Uint8Array, start: number, end: number): number {
  const value = readAscii(source, start, end).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error('Memory archive contains an invalid octal field.');
  return Number.parseInt(value, 8);
}

function padding(size: number): number {
  return (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

