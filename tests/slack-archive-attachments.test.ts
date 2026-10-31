import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { archiveListing, MAX_LISTED_ARCHIVE_ENTRIES } from '../src/slack/archive-attachments.ts';
import {
  ARCHIVE_PAGE_CHARACTERS,
  createReadArchiveFileTool,
  MAX_ARCHIVE_READS_PER_TURN,
  readArchiveFile,
  type ReadArchiveFileResult,
} from '../src/slack/archive-file-tool.ts';
import { createSlackAttachmentAnalysis, formatSlackAttachmentSignal } from '../src/slack/attachment-context.ts';
import { MAX_SLACK_ATTACHMENT_CHARACTERS, normalizeSlackAttachments } from '../src/slack/attachment-normalization.ts';
import type { GatewayAttachmentClient, GatewayAttachmentRead } from '../src/slack/gateway/client.ts';
import type { GatewayAttachmentRepresentation } from '../src/slack/gateway/protocol.ts';
import { makeTextPdf } from './helpers/pdf.ts';
import { buildZip } from './helpers/zip.ts';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/zip/${name}`, import.meta.url)));
const zipRead = (fileId: string, filename: string, bytes: Uint8Array): GatewayAttachmentRead =>
  ({ fileId, filename, representation: 'zip_original', contentType: 'application/zip', bytes });

interface ReadCall { fileId: string; maxBytes: number; accept?: readonly GatewayAttachmentRepresentation[] }

/** A reader that serves a zip only when asked for zip_original, as both real readers do. */
function zipReader(files: Record<string, GatewayAttachmentRead>, calls: ReadCall[] = []): GatewayAttachmentClient {
  return {
    async readAttachment(fileId, maxBytes, _signal, accept) {
      calls.push({ fileId, maxBytes, ...(accept ? { accept } : {}) });
      const read = files[fileId];
      if (!read) throw Object.assign(new Error('file_not_found'), { code: 'file_not_found' });
      if (read.representation === 'zip_original' && !accept?.includes('zip_original')) {
        throw Object.assign(new Error('unsupported_file_type'), { code: 'unsupported_file_type' });
      }
      return read;
    },
  };
}

test('the analysis asks for zip_original and lists a zip by path, kind and size, without junk', async () => {
  const calls: ReadCall[] = [];
  const result = await normalizeSlackAttachments({
    fileIds: ['F_ZIP'],
    gateway: zipReader({ F_ZIP: zipRead('F_ZIP', 'kit.zip', fixture('ditto.zip')) }, calls),
  });
  assert.deepEqual(calls.map(({ accept }) => accept), [
    ['image_original', 'text_original', 'pdf_original', 'slack_pdf_conversion', 'zip_original'],
  ]);
  assert.equal(result.failures.length, 0);
  const [archive] = result.attachments;
  assert.equal(archive?.kind, 'archive');
  assert.equal(archive?.kind === 'archive' ? archive.handle : undefined, 'file:1');
  assert.equal(archive?.kind === 'archive' ? archive.text : undefined, [
    'Zip archive file:1: its file list, not file contents.',
    '4 files:',
    '- kit/logo.png (image, 71 B)',
    '- kit/notes.md (text, 55 B)',
    '- kit/data/table.csv (text, 30 B)',
    '- kit/report.pdf (pdf, 601 B)',
  ].join('\n'));
});

test('a gateway that predates accept gets one retry without it, so other files still read', async () => {
  const calls: ReadCall[] = [];
  const result = await normalizeSlackAttachments({
    fileIds: ['F_TEXT'],
    gateway: {
      async readAttachment(fileId, maxBytes, _signal, accept) {
        calls.push({ fileId, maxBytes, ...(accept ? { accept } : {}) });
        if (accept) throw Object.assign(new Error('old gateway'), { code: 'gateway_attachment_unsupported', retryable: false });
        return { fileId, filename: 'notes.txt', representation: 'text_original', contentType: 'text/plain', bytes: new TextEncoder().encode('hello') };
      },
    },
  });
  assert.deepEqual(calls.map(({ accept }) => accept !== undefined), [true, false]);
  assert.deepEqual(result.attachments.map(({ kind }) => kind), ['text']);
});

test('an archive the reader refuses fails with advice to re-zip or attach the files, never convert_file', async () => {
  const crowded = buildZip(Array.from({ length: 2_001 }, (_, index) => ({ path: `f${index}.txt`, method: 0 })));
  const result = await normalizeSlackAttachments({
    fileIds: ['F_LOCKED', 'F_CROWDED'],
    gateway: zipReader({
      F_LOCKED: zipRead('F_LOCKED', 'locked.zip', fixture('zip-encrypted.zip')),
      F_CROWDED: zipRead('F_CROWDED', 'crowded.zip', crowded),
    }),
  });
  assert.deepEqual(result.failures.map(({ filename, code, nextAction }) => ({ filename, code, nextAction })), [
    { filename: 'locked.zip', code: 'archive_encrypted', nextAction: 'rezip_archive' },
    { filename: 'crowded.zip', code: 'archive_too_many_entries', nextAction: 'split_file' },
  ]);
});

test('a listing names at most 200 files, counts the rest and the refused, and fits one attachment', async () => {
  const longName = `${'deep/'.repeat(80)}file`;
  const entries = [
    ...Array.from({ length: 250 }, (_, index) => ({ path: `${longName}-${index}.md`, content: 'x', method: 0 })),
    { path: '__MACOSX/._junk', content: 'x' },
    { path: `${longName}-0.md`, content: 'again' },
  ];
  const result = await normalizeSlackAttachments({
    fileIds: ['F_BIG'],
    gateway: zipReader({ F_BIG: zipRead('F_BIG', 'big.zip', buildZip(entries)) }),
  });
  const [archive] = result.attachments;
  assert.ok(archive?.kind === 'archive');
  const lines = archive.text.split('\n');
  assert.equal(lines[1], '250 files:');
  assert.equal(lines.filter((line) => line.startsWith('- ')).length, MAX_LISTED_ARCHIVE_ENTRIES);
  assert.ok(lines.filter((line) => line.startsWith('- ')).every((line) => line.includes('…')), 'long paths are cut for display');
  assert.ok(lines.includes('50 more files are not listed.'));
  assert.match(archive.text, /1 more entries were left out because they repeat a path/);
  assert.doesNotMatch(archive.text, /__MACOSX/);
  assert.ok(Array.from(archive.text).length <= MAX_SLACK_ATTACHMENT_CHARACTERS);
});

test('the manifest names the archive handle and how to read a file, and a listing survives the observation filter', async () => {
  const listing = archiveListing(fixture('ditto.zip'), 'file:1');
  const result = await createSlackAttachmentAnalysis({
    intake: { kind: 'ready', request: 'Summarize the notes in this zip.', count: 2, fileIds: ['F_ZIP', 'F_LOCKED'] },
    gateway: zipReader({
      F_ZIP: zipRead('F_ZIP', 'kit.zip', fixture('ditto.zip')),
      F_LOCKED: zipRead('F_LOCKED', 'locked.zip', fixture('zip-encrypted.zip')),
    }),
    prompt: async () => ({ text: `Attachment 1 - kit.zip:\n${listing}` }),
  });
  const body = formatSlackAttachmentSignal(result).body;
  assert.match(body, /- ordinal=1 \| filename="kit\.zip" \| representation=zip_original \| handle=file:1 \| status=success \| code=listed \| next_action="Only the file list was read\. To read a file inside, call read_archive_file with file \\"file:1\\" and the file's exact path\."/);
  assert.match(body, /- ordinal=2 \| filename="locked\.zip" \| status=failure \| code=archive_encrypted \| next_action="Re-create the zip without a password using standard compression, or attach the files directly \(up to four per message\), then retry\."/);
  assert.ok(body.includes(listing), 'the file list reaches the Agent verbatim');
  assert.doesNotMatch(body, /Convert the file/);
});

const KIT = fixture('zip-r.zip');
const read = (path: string, offset = 0, bytes = KIT) => readArchiveFile({ bytes, file: 'file:1', path, offset });

test('a text file inside an archive reads as text', async () => {
  assert.deepEqual(await read('kit/notes.md'), {
    ok: true, file: 'file:1', path: 'kit/notes.md', kind: 'text',
    text: '# Synthetic plan\n\nThis file is synthetic test content.\n',
  });
});

test('long text pages 50,000 characters at a time and never splits a surrogate pair', async () => {
  const text = `${'a'.repeat(ARCHIVE_PAGE_CHARACTERS - 1)}😀${'b'.repeat(10)}`;
  const bytes = buildZip([{ path: 'long.txt', content: text }]);
  const first = await read('long.txt', 0, bytes);
  assert.ok(first.ok && first.kind === 'text');
  assert.equal(first.text, 'a'.repeat(ARCHIVE_PAGE_CHARACTERS - 1));
  assert.equal(first.nextOffset, ARCHIVE_PAGE_CHARACTERS - 1);
  const second = await read('long.txt', first.nextOffset!, bytes);
  assert.ok(second.ok && second.kind === 'text');
  assert.equal(second.text, `😀${'b'.repeat(10)}`);
  assert.equal(second.nextOffset, undefined);
  assert.deepEqual(await read('long.txt', text.length + 1, bytes), {
    ok: false, error: `offset is past the end of this file, which has ${text.length.toLocaleString('en-US')} characters.`,
  });
});

test('a PDF inside an archive reads as its extracted text, paged the same way', async () => {
  const bytes = buildZip([{ path: 'docs/report.pdf', content: makeTextPdf(['Quarterly result: 42', 'Second page']) }]);
  assert.deepEqual(await read('docs/report.pdf', 0, bytes), {
    ok: true, file: 'file:1', path: 'docs/report.pdf', kind: 'pdf',
    text: '--- Page 1 of 2 ---\nQuarterly result: 42\n--- Page 2 of 2 ---\nSecond page',
  });
  const fromKit = await read('kit/report.pdf');
  assert.ok(fromKit.ok && fromKit.kind === 'pdf' && fromKit.text.includes('Synthetic report: 42 units'));
});

test('a PDF with more text than one analyzed attachment still pages', async () => {
  const page = Array.from({ length: 25 }, () => 'x'.repeat(80)).join('\n');
  const long = buildZip([{ path: 'long.pdf', content: makeTextPdf(Array.from({ length: 40 }, () => page)) }]);
  const first = await read('long.pdf', 0, long);
  assert.ok(first.ok && first.kind === 'pdf', JSON.stringify(first));
  assert.equal(first.text.length, ARCHIVE_PAGE_CHARACTERS);
  assert.equal(first.nextOffset, ARCHIVE_PAGE_CHARACTERS);
  const second = await read('long.pdf', first.nextOffset!, long);
  assert.ok(second.ok && second.kind === 'pdf' && second.nextOffset === undefined);
  assert.ok(second.text.endsWith('x'.repeat(80)));
});

test('images, nested archives and other binaries are described, not read', async () => {
  const bytes = buildZip([
    { path: 'inner.zip', content: buildZip([{ path: 'x.txt', content: 'x' }]) },
    { path: 'model.bin', content: Uint8Array.of(0, 1, 2, 3) },
    { path: 'budget.xlsx', content: buildZip([{ path: '[Content_Types].xml', content: '<Types/>' }]) },
  ]);
  const described = async (path: string, archive = bytes) => {
    const result = await read(path, 0, archive);
    assert.ok(result.ok && 'note' in result && 'size' in result, path);
    return { kind: result.kind, size: result.size };
  };
  assert.deepEqual(await described('kit/logo.png', KIT), { kind: 'image', size: '71 B' });
  assert.deepEqual(await described('model.bin'), { kind: 'other', size: '4 B' });
  assert.equal((await described('inner.zip')).kind, 'archive');
  assert.equal((await described('budget.xlsx')).kind, 'other');
});

test('a path that is not in the archive lists the exact paths to choose from', async () => {
  assert.deepEqual(await read('notes.md'), {
    ok: false,
    error: 'No file in this archive has that exact path. Use one of these paths.',
    paths: ['kit/logo.png', 'kit/notes.md', 'kit/data/table.csv', 'kit/report.pdf'],
  });
});

test('archive and entry refusals say what the person can do', async () => {
  const bytes = buildZip([
    { path: 'bzip.txt', content: 'x', method: 12 },
    { path: 'huge.txt', content: 'x', declaredSize: 9 * 1024 * 1024 },
  ]);
  assert.deepEqual(await read('bzip.txt', 0, bytes), {
    ok: false,
    error: 'This file uses zip compression method 12, which Chickpea cannot read. Ask for the archive re-created with standard zip compression, or for the files attached directly.',
  });
  assert.deepEqual(await read('huge.txt', 0, bytes), {
    ok: false,
    error: 'This file unpacks to 9.0 MB, over the 8.0 MB limit. Ask for it split or attached directly.',
  });
  assert.deepEqual(await read('kit/notes.md', 0, fixture('zip-encrypted.zip')), {
    ok: false,
    error: 'This archive is password-protected. Ask for it again without a password, or for the files attached directly.',
  });
});

let instance = 0;
function archiveTool(fileIds: string[], client: GatewayAttachmentClient) {
  instance += 1;
  return createReadArchiveFileTool({
    instanceId: `archive-tool-${instance}`,
    turnKey: 'turn_archive',
    fileIds,
    client: async () => client,
  });
}
async function call(tool: ReturnType<typeof archiveTool>, data: { file: string; path: string; offset?: number }, toolCallId: string) {
  return JSON.parse(String(await tool.run({ data, toolCallId, log: { info() {}, warn() {}, error() {} } }))) as ReadArchiveFileResult;
}

test('a handle resolves only to the current message\'s file IDs, and one archive downloads once per turn', async () => {
  const calls: ReadCall[] = [];
  const tool = archiveTool(['F_PDF', 'F_KIT'], zipReader({ F_KIT: zipRead('F_KIT', 'kit.zip', KIT) }, calls));
  const notes = await call(tool, { file: 'file:2', path: 'kit/notes.md' }, 'c1');
  const table = await call(tool, { file: 'file:2', path: 'kit/data/table.csv' }, 'c2');
  assert.ok(notes.ok && table.ok);
  assert.deepEqual(calls, [{ fileId: 'F_KIT', maxBytes: 8 * 1024 * 1024, accept: ['zip_original'] }]);
  assert.deepEqual(await call(tool, { file: 'file:3', path: 'kit/notes.md' }, 'c3'), {
    ok: false, error: 'file:3 is not a file on the current message. Use a handle from the attachment manifest.',
  });
  assert.equal(calls.length, 1);
});

test('a handle that names a file that is not a zip is refused plainly', async () => {
  const tool = archiveTool(['F_PDF'], zipReader({}));
  const notZip: GatewayAttachmentClient = {
    async readAttachment() { throw Object.assign(new Error('unsupported'), { code: 'unsupported_file_type' }); },
  };
  assert.deepEqual(await call(archiveTool(['F_PDF'], notZip), { file: 'file:1', path: 'a.md' }, 'c1'), {
    ok: false, error: 'file:1 is not a zip archive, so files inside it cannot be read.',
  });
  assert.deepEqual(await call(tool, { file: 'file:1', path: 'a.md' }, 'c1'), {
    ok: false, error: 'Chickpea could not download this archive from Slack. Try once more; if it fails again, ask for it attached again.',
  });
});

test(`a turn reads at most ${MAX_ARCHIVE_READS_PER_TURN} times; a replayed call keeps its read`, async () => {
  const tool = archiveTool(['F_KIT'], zipReader({ F_KIT: zipRead('F_KIT', 'kit.zip', KIT) }));
  for (let index = 0; index < MAX_ARCHIVE_READS_PER_TURN; index += 1) {
    assert.equal((await call(tool, { file: 'file:1', path: 'kit/notes.md' }, `c${index}`)).ok, true);
  }
  assert.equal((await call(tool, { file: 'file:1', path: 'kit/notes.md' }, 'c0')).ok, true);
  assert.deepEqual(await call(tool, { file: 'file:1', path: 'kit/notes.md' }, 'one-too-many'), {
    ok: false, error: `This turn has used its ${MAX_ARCHIVE_READS_PER_TURN} archive reads. Answer with what has been read, and say what is left.`,
  });
});
