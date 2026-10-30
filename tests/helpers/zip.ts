import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipFixtureEntry {
  path: string;
  content?: string | Uint8Array;
  /** 0 stores, 8 deflates; any other value is written as-is with stored bytes. */
  method?: number;
  flags?: number;
  /** Uncompressed size written to the central directory instead of the real one. */
  declaredSize?: number;
  /** Name written to the local header instead of `path`. */
  localPath?: string;
  zip64?: boolean;
}

/** A minimal ZIP writer for synthetic test archives. */
export function buildZip(entries: readonly ZipFixtureEntry[]): Uint8Array<ArrayBuffer> {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.content ?? '');
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(entry.path);
    const localName = Buffer.from(entry.localPath ?? entry.path);
    const checksum = crc32(data);
    const flags = entry.flags ?? 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(localName.length, 26);
    locals.push(local, localName, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.zip64 ? 0xffffffff : body.length, 20);
    central.writeUInt32LE(entry.zip64 ? 0xffffffff : entry.declaredSize ?? data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + localName.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

export function skillMarkdown(name: string | undefined, description: string, body = '# Steps\nDo the work.\n'): string {
  return `---\n${name === undefined ? '' : `name: ${name}\n`}description: ${description}\n---\n${body}`;
}
