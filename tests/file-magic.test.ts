import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sniffFileKind } from '../src/files/magic.ts';
import { buildZip } from './helpers/zip.ts';

const bytes = (...values: number[]) => Uint8Array.from(values);
const kind = (name: string, head?: Uint8Array) => {
  const sniffed = sniffFileKind(name, head);
  return sniffed.kind === 'image' ? sniffed.mimeType : sniffed.kind;
};

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const GIF = new TextEncoder().encode('GIF89a....');
const WEBP = new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ');
const PDF = new TextEncoder().encode('%PDF-1.7\n');

test('known bytes decide the kind whatever the name says', () => {
  assert.equal(kind('photo', PNG), 'image/png');
  assert.equal(kind('notes.txt', JPEG), 'image/jpeg');
  assert.equal(kind('a.gif', GIF), 'image/gif');
  assert.equal(kind('a.bin', WEBP), 'image/webp');
  assert.equal(kind('scan.png', PDF), 'pdf');
  assert.equal(kind('bundle.dat', buildZip([])), 'archive');
  assert.equal(kind('readme.png', new TextEncoder().encode('# Just markdown\n')), 'text');
  assert.equal(kind('empty.md', new Uint8Array()), 'text');
});

test('known bytes that match no signature are text only when they decode as strict UTF-8 without control bytes', () => {
  assert.equal(kind('table.csv', new TextEncoder().encode('naïve,café\n')), 'text');
  assert.equal(kind('table.csv', bytes(0x61, 0x00, 0x62)), 'other');
  assert.equal(kind('table.csv', bytes(0xc3, 0x28)), 'other');
  assert.equal(kind('riff.wav', new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WAVEfmt ')), 'other');
  // A multi-byte character cut at the sniff boundary is still text.
  const cut = new TextEncoder().encode(`${'a'.repeat(4_095)}é`);
  assert.equal(kind('long.txt', cut), 'text');
});

test('office documents are zips by magic but never archives', () => {
  const zip = buildZip([{ path: '[Content_Types].xml', content: '<Types/>' }]);
  assert.equal(kind('budget.xlsx', zip), 'other');
  assert.equal(kind('deck.PPTX', zip), 'other');
  assert.equal(kind('budget.xlsx'), 'other');
  // An office name on image bytes is still the image the bytes prove.
  assert.equal(kind('photo.docx', PNG), 'image/png');
});

test('without bytes the name decides, as in an archive listing', () => {
  assert.equal(kind('logos/primary.PNG'), 'image/png');
  assert.equal(kind('photo.jpeg'), 'image/jpeg');
  assert.equal(kind('report.pdf'), 'pdf');
  assert.equal(kind('inner/skills.zip'), 'archive');
  assert.equal(kind('pack.skill'), 'archive');
  assert.equal(kind('notes/plan.md'), 'text');
  assert.equal(kind('src/main.py'), 'text');
  assert.equal(kind('model.bin'), 'other');
  assert.equal(kind('Makefile'), 'other');
});
