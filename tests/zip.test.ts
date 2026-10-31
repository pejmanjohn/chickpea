import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createByteBudget,
  isZipSignature,
  openZip,
  ZipArchiveError,
  type ZipErrorCode,
} from '../src/files/zip.ts';
import { buildZip } from './helpers/zip.ts';

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const open = (bytes: Uint8Array, maxEntryBytes = 1024 * 1024, budget = createByteBudget(16 * 1024 * 1024)) =>
  openZip(bytes, { maxEntryBytes, budget });

async function refusal(promise: Promise<unknown>): Promise<ZipErrorCode> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ZipArchiveError, `expected a ZipArchiveError, got ${String(error)}`);
    return error.code;
  }
  assert.fail('expected a refusal');
}

test('lists files by path with their declared sizes, leaving out directories and archive-tool droppings', async () => {
  const archive = open(buildZip([
    { path: 'kit/' },
    { path: 'kit/notes.md', content: '# Plan\n' },
    { path: 'kit/data.csv', content: 'a,b\n1,2\n', method: 0 },
    { path: '__MACOSX/kit/._notes.md', content: 'resource fork' },
    { path: 'kit/.DS_Store', content: 'Bud1' },
    { path: 'kit\\windows.txt', content: 'backslash' },
  ]));
  assert.deepEqual(archive.entries.map(({ path, size }) => `${path} ${size}`), [
    'kit/notes.md 7',
    'kit/data.csv 8',
    'kit/windows.txt 9',
  ]);
  assert.equal(text(await archive.entry('kit/notes.md')!.read()), '# Plan\n');
  assert.equal(text(await archive.entry('kit/data.csv')!.read()), 'a,b\n1,2\n');
  assert.equal(archive.entry('kit/.DS_Store'), undefined);
});

test('skipJunk false keeps directories and droppings for a caller that filters itself', () => {
  const archive = openZip(buildZip([{ path: 'kit/' }, { path: '__MACOSX/._a', content: 'x' }]), {
    maxEntryBytes: 1024, budget: createByteBudget(1024), skipJunk: false,
  });
  assert.deepEqual(archive.entries.map(({ path }) => path), ['kit/', '__MACOSX/._a']);
});

test('an entry over the per-entry limit is refused before any byte is inflated', async () => {
  // The data is not valid deflate, so only a refusal that never inflates says entry_too_large.
  const archive = open(buildZip([{ path: 'big.txt', content: 'not deflate', method: 8, declaredSize: 4096, rawBody: true }]), 1024);
  assert.equal(await refusal(archive.entry('big.txt')!.read()), 'entry_too_large');
});

test('one budget bounds every read across archives, and a refused read takes nothing from it', async () => {
  const budget = createByteBudget(10);
  const first = open(buildZip([{ path: 'a.txt', content: '123456' }]), 1024, budget);
  const second = open(buildZip([{ path: 'b.txt', content: '12345' }, { path: 'c.txt', content: '1234' }]), 1024, budget);
  await first.entry('a.txt')!.read();
  assert.equal(budget.remaining, 4);
  assert.equal(await refusal(second.entry('b.txt')!.read()), 'budget_exceeded');
  assert.equal(budget.remaining, 4);
  assert.equal(text(await second.entry('c.txt')!.read()), '1234');
  assert.equal(budget.remaining, 0);
});

test('an entry that inflates past its declared size stops early and is refused', async (t) => {
  // Count what the inflater emits: a lying header must cost about one chunk, not the real size.
  const Native = globalThis.DecompressionStream;
  let inflated = 0;
  globalThis.DecompressionStream = class extends Native {
    constructor(format: CompressionFormat) {
      super(format);
      const counted = this.readable.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          inflated += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }));
      Object.defineProperty(this, 'readable', { value: counted });
    }
  };
  t.after(() => { globalThis.DecompressionStream = Native; });
  const archive = open(buildZip([{ path: 'liar.txt', content: new Uint8Array(32 * 1024 * 1024), declaredSize: 16 }]));
  assert.equal(await refusal(archive.entry('liar.txt')!.read()), 'size_mismatch');
  assert.ok(inflated < 1024 * 1024, `inflated ${inflated} bytes for a 16-byte entry`);
});

test('whole-archive refusals carry a code and neutral wording', () => {
  const valid = { path: 'ok.txt', content: 'fine' };
  const cases: Array<[Uint8Array, ZipErrorCode]> = [
    [new TextEncoder().encode('not a zip at all'), 'not_a_zip'],
    [buildZip([valid, { path: 'locked.txt', content: 'x', flags: 1 }]), 'encrypted'],
    [buildZip([valid, { path: 'wide.txt', content: 'x', zip64: true }]), 'zip64'],
    [buildZip([valid, { path: '../outside.txt', content: 'x' }]), 'unsafe_path'],
    [buildZip([valid, { path: 'C:/rooted.txt', content: 'x' }]), 'unsafe_path'],
    [buildZip(Array.from({ length: 4 }, (_, index) => ({ path: `f${index}.txt`, method: 0 }))), 'too_many_entries'],
  ];
  for (const [bytes, code] of cases) {
    assert.throws(() => openZip(bytes, { maxEntries: 3, maxEntryBytes: 1024, budget: createByteBudget(1024) }), (error: unknown) => {
      assert.ok(error instanceof ZipArchiveError);
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /upload/i);
      return true;
    });
  }
});

test('per-entry read refusals leave the rest of the archive readable', async () => {
  const archive = open(buildZip([
    { path: 'bzip.txt', content: 'x', method: 12 },
    { path: 'moved.txt', content: 'x', localPath: 'other.txt' },
    { path: 'fine.txt', content: 'fine', method: 0 },
  ]));
  assert.equal(await refusal(archive.entry('bzip.txt')!.read()), 'unsupported_method');
  assert.equal(await refusal(archive.entry('moved.txt')!.read()), 'header_mismatch');
  assert.equal(text(await archive.entry('fine.txt')!.read()), 'fine');
});

test('the zip signature is a local file header or the end record of an empty archive', () => {
  assert.equal(isZipSignature(Uint8Array.of(0x50, 0x4b, 0x03, 0x04)), true);
  assert.equal(isZipSignature(Uint8Array.of(0x50, 0x4b, 0x05, 0x06)), true);
  assert.equal(isZipSignature(Uint8Array.of(0x50, 0x4b, 0x07, 0x08)), false);
  assert.equal(isZipSignature(new Uint8Array()), false);
  assert.deepEqual(open(buildZip([])).entries, []);
});
