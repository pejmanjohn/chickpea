import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { sniffFileKind } from '../src/files/magic.ts';
import { createByteBudget, openZip, ZipArchiveError } from '../src/files/zip.ts';

// Archives of one synthetic kit written by real tools; scripts/build-zip-fixtures.mjs regenerates them.
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/zip/${name}`, import.meta.url)));
const open = (name: string) => openZip(fixture(name), { maxEntryBytes: 1024 * 1024, budget: createByteBudget(8 * 1024 * 1024) });

const KIT_FILES = ['kit/data/table.csv', 'kit/logo.png', 'kit/notes.md', 'kit/report.pdf'];

for (const name of ['zip-r.zip', 'ditto.zip', 'python-stored.zip', 'python-deflated.zip', 'python-comment.zip']) {
  test(`${name}: lists the kit without directories or macOS droppings and reads every file`, async () => {
    const archive = open(name);
    assert.deepEqual(archive.entries.map(({ path }) => path).sort(), KIT_FILES);
    assert.deepEqual(archive.refused, []);
    const read = async (path: string) => archive.entry(path)!.read();
    assert.equal(new TextDecoder().decode(await read('kit/notes.md')), '# Synthetic plan\n\nThis file is synthetic test content.\n');
    assert.equal(new TextDecoder().decode(await read('kit/data/table.csv')), 'region,units\nnorth,12\nsouth,7\n');
    assert.deepEqual(sniffFileKind('kit/report.pdf', await read('kit/report.pdf')), { kind: 'pdf' });
    assert.deepEqual(sniffFileKind('kit/logo.png', await read('kit/logo.png')), { kind: 'image', mimeType: 'image/png' });
  });
}

test('an empty archive from a real tool opens with no entries', () => {
  assert.deepEqual(open('python-empty.zip').entries, []);
});

test('a password-protected archive from zip -P is refused as encrypted', () => {
  assert.throws(() => open('zip-encrypted.zip'), (error: unknown) =>
    error instanceof ZipArchiveError && error.code === 'encrypted');
});
