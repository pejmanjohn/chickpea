import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readableFileKind } from '../src/files/magic.ts';
import { createSlackAttachmentAnalysis, formatSlackAttachmentSignal } from '../src/slack/attachment-context.ts';
import { normalizeSlackAttachments } from '../src/slack/attachment-normalization.ts';
import { createReadSlackFileTool, FILE_PAGE_CHARACTERS, type ReadSlackFileResult } from '../src/slack/slack-file-tool.ts';
import type { GatewayAttachmentClient, GatewayAttachmentRead } from '../src/slack/gateway/client.ts';
import type { GatewayAttachmentRepresentation } from '../src/slack/gateway/protocol.ts';
import { fileHandleIds } from '../src/slack/thread-files.ts';
import { makeTextPdf } from './helpers/pdf.ts';
import { buildZip } from './helpers/zip.ts';

const encode = (text: string) => new TextEncoder().encode(text);
const textRead = (fileId: string, filename: string, text: string, contentType = 'text/markdown'): GatewayAttachmentRead =>
  ({ fileId, filename, representation: 'text_original', contentType, bytes: encode(text) });
const pdfRead = (fileId: string, filename: string, pages: string[]): GatewayAttachmentRead =>
  ({ fileId, filename, representation: 'pdf_original', contentType: 'application/pdf', bytes: makeTextPdf(pages) });

interface ReadCall { fileId: string; accept?: readonly GatewayAttachmentRepresentation[] }

function reader(files: Record<string, GatewayAttachmentRead | Error>, calls: ReadCall[] = []): GatewayAttachmentClient {
  return {
    async readAttachment(fileId, _maxBytes, _signal, accept) {
      calls.push({ fileId, ...(accept ? { accept } : {}) });
      const read = files[fileId];
      if (read instanceof Error) throw read;
      if (!read) throw Object.assign(new Error('file_not_found'), { code: 'file_not_found' });
      return read;
    },
  };
}

const failure = (code: string) => Object.assign(new Error(code), { code });

let instance = 0;
function fileTool(fileIds: readonly string[], client: GatewayAttachmentClient, imageHandle?: (fileId: string) => string | undefined) {
  instance += 1;
  return createReadSlackFileTool({
    instanceId: `file-tool-${instance}`,
    turnKey: 'turn_files',
    fileIds: fileHandleIds(fileIds, []),
    client: async () => client,
    ...(imageHandle ? { imageHandle } : {}),
  });
}

let callId = 0;
async function call(tool: ReturnType<typeof fileTool>, data: { file: string; path?: string; offset?: number }) {
  callId += 1;
  const output = await tool.run({ data, toolCallId: `call-${callId}`, log: { info() {}, warn() {}, error() {} } });
  return JSON.parse(String(output)) as ReadSlackFileResult;
}

test('readable kinds take a handle by name or Slack type; images and unserved files do not', () => {
  assert.equal(readableFileKind('Q3 pack.ZIP', 'application/octet-stream'), 'archive');
  assert.equal(readableFileKind('brand.skill'), 'archive');
  assert.equal(readableFileKind('scan', 'application/pdf'), 'pdf');
  assert.equal(readableFileKind('notes.md', 'text/plain'), 'text');
  assert.equal(readableFileKind('export', 'application/json'), 'text');
  assert.equal(readableFileKind('script.py'), 'text');
  assert.equal(readableFileKind('memo.rtf', 'text/rtf'), undefined);
  assert.equal(readableFileKind('demo.mp4', 'video/mp4'), undefined);
  assert.equal(readableFileKind('archive.tar.gz', 'application/gzip'), undefined);
});

test('a text file reads in 50,000-character pages, and the token past the first page needs nextOffset', async () => {
  const text = `${'n'.repeat(52_000)} TOKEN-PLUM-58 ${'m'.repeat(7_985)}`;
  assert.equal(text.length, 60_000);
  const calls: ReadCall[] = [];
  const tool = fileTool(['F0NOTES0001'], reader({ F0NOTES0001: textRead('F0NOTES0001', 'notes.md', text) }, calls));
  const first = await call(tool, { file: 'file:1' });
  assert.ok(first.ok && first.kind === 'text' && 'text' in first);
  assert.equal(first.name, 'notes.md');
  assert.equal(first.text.length, FILE_PAGE_CHARACTERS);
  assert.equal(first.nextOffset, FILE_PAGE_CHARACTERS);
  assert.doesNotMatch(first.text, /TOKEN-PLUM-58/);
  const second = await call(tool, { file: 'file:1', offset: first.nextOffset! });
  assert.ok(second.ok && second.kind === 'text' && 'text' in second);
  assert.match(second.text, /TOKEN-PLUM-58/);
  assert.equal(second.nextOffset, undefined);
  assert.deepEqual(calls, [{
    fileId: 'F0NOTES0001', accept: ['image_original', 'text_original', 'pdf_original', 'slack_pdf_conversion', 'zip_original'],
  }], 'one read with the analysis representations serves both pages');
});

test('text that is not UTF-8, or arrives under a type the analysis refuses, is refused with its name', async () => {
  const latin1: GatewayAttachmentRead = {
    fileId: 'F0LATIN0001', filename: 'old.txt', representation: 'text_original', contentType: 'text/plain', bytes: Uint8Array.of(0x63, 0x61, 0x66, 0xe9),
  };
  const rtf = textRead('F0RTF000001', 'memo.rtf', '{\\rtf1 hi}', 'text/rtf');
  const tool = fileTool(['F0LATIN0001', 'F0RTF000001'], reader({ F0LATIN0001: latin1, F0RTF000001: rtf }));
  const refusal = 'This file is not UTF-8 text, so it cannot be read here. Ask for it as plain text or a PDF.';
  assert.deepEqual(await call(tool, { file: 'file:1' }), { ok: false, error: refusal, name: 'old.txt' });
  assert.deepEqual(await call(tool, { file: 'file:2' }), { ok: false, error: refusal, name: 'memo.rtf' });
});

test('a PDF reads as its extracted text, page markers included, and says when a page has no text layer', async () => {
  const tool = fileTool(['F0PDF000001', 'F0SCAN00001'], reader({
    F0PDF000001: pdfRead('F0PDF000001', 'board.pdf', ['Agenda', 'Fact on page two: TOKEN-FIG-31']),
    F0SCAN00001: pdfRead('F0SCAN00001', 'scan.pdf', ['Cover', '']),
  }));
  assert.deepEqual(await call(tool, { file: 'file:1' }), {
    ok: true, file: 'file:1', kind: 'pdf',
    text: '--- Page 1 of 2 ---\nAgenda\n--- Page 2 of 2 ---\nFact on page two: TOKEN-FIG-31', name: 'board.pdf',
  });
  const scanned = await call(tool, { file: 'file:2' });
  assert.ok(scanned.ok && 'note' in scanned);
  assert.equal(scanned.note, 'Some pages have no text layer, such as scanned pages, so their content is missing here.');
});

test('a damaged PDF is refused with its name and no exception', async () => {
  const broken: GatewayAttachmentRead = {
    fileId: 'F0BROKEN001', filename: 'broken.pdf', representation: 'pdf_original', contentType: 'application/pdf',
    bytes: encode('%PDF-1.4 not really'),
  };
  assert.deepEqual(await call(fileTool(['F0BROKEN001'], reader({ F0BROKEN001: broken })), { file: 'file:1' }), {
    ok: false, error: 'This PDF could not be read; it may be damaged. Ask for it attached directly.', name: 'broken.pdf',
  });
});

test('an image points to its img:N handle when the request lists one, and otherwise says this tool reads no images', async () => {
  const image: GatewayAttachmentRead = {
    fileId: 'F0LOGO00001', filename: 'logo.png', representation: 'image_original', contentType: 'image/png', bytes: Uint8Array.of(1),
  };
  const listed = fileTool(['F0LOGO00001'], reader({ F0LOGO00001: image }), (fileId) => fileId === 'F0LOGO00001' ? 'img:3' : undefined);
  assert.deepEqual(await call(listed, { file: 'file:1' }), {
    ok: true, file: 'file:1', kind: 'image', name: 'logo.png',
    note: 'This is an image. Use its handle img:3 from the request\'s image list; read_slack_file reads no images.',
  });
  const unlisted = fileTool(['F0LOGO00001'], reader({ F0LOGO00001: image }));
  assert.deepEqual(await call(unlisted, { file: 'file:1' }), {
    ok: true, file: 'file:1', kind: 'image', name: 'logo.png', note: 'This is an image, and read_slack_file cannot read images.',
  });
});

test('each refusal from the reader says what to do, and none is a thrown error', async () => {
  const cases: Array<[Error, string]> = [
    [failure('unsupported_file_type'), 'This kind of file cannot be read here, such as audio, video or another binary file.'],
    [failure('conversion_pending'), 'Slack is still preparing a readable copy. Try again shortly.'],
    [failure('file_deleted'), 'This file is no longer in Slack. Ask for it attached again.'],
    [failure('attachment_byte_limit_exceeded'), 'This file is over 8 MB, so it cannot be read here. Ask for a smaller file, or for the files inside a zip attached directly.'],
    [failure('invalid_slack_file_magic'), 'This file is named like a zip archive but is not one, so it cannot be read here.'],
    [failure('ratelimited'), 'Chickpea could not download this file from Slack. Try once more; if it fails again, ask for it attached again.'],
  ];
  for (const [error, message] of cases) {
    assert.deepEqual(await call(fileTool(['F0FILE00001'], reader({ F0FILE00001: error })), { file: 'file:1' }), { ok: false, error: message });
  }
});

test('a reply naming another file than the one asked for is refused before anything is read from it', async () => {
  const tool = fileTool(['F0ASKED0001'], reader({ F0ASKED0001: textRead('F0OTHER0001', 'other.md', 'TOKEN-WRONG') }));
  const result = await call(tool, { file: 'file:1' });
  assert.deepEqual(result, {
    ok: false, error: 'Chickpea could not download this file from Slack. Try once more; if it fails again, ask for it attached again.',
  });
});

test('a path into a file that is not a zip is refused, and offset past the end says how long the file is', async () => {
  const tool = fileTool(['F0NOTES0001'], reader({ F0NOTES0001: textRead('F0NOTES0001', 'notes.md', 'short') }));
  assert.deepEqual(await call(tool, { file: 'file:1', path: 'notes.md' }), {
    ok: false, error: 'file:1 is not a zip archive. Leave path out to read it.', name: 'notes.md',
  });
  assert.deepEqual(await call(tool, { file: 'file:1', offset: 6 }), {
    ok: false, error: 'offset is past the end of this file, which has 5 characters.', name: 'notes.md',
  });
});

test('two opened files stay cached per turn; a third evicts the least recent, and a failed open is not kept', async () => {
  const calls: ReadCall[] = [];
  let flaky = 0;
  const files: Record<string, GatewayAttachmentRead | Error> = {
    F0FIRST0001: textRead('F0FIRST0001', 'a.md', 'first'),
    F0SECOND001: pdfRead('F0SECOND001', 'b.pdf', ['second']),
    F0THIRD0001: { ...textRead('F0THIRD0001', 'c.zip', ''), representation: 'zip_original', contentType: 'application/zip', bytes: buildZip([{ path: 'c.md', content: 'third' }]) },
  };
  const base = reader(files, calls);
  const client: GatewayAttachmentClient = {
    async readAttachment(fileId, maxBytes, signal, accept) {
      if (fileId === 'F0FLAKY0001' && flaky++ === 0) {
        calls.push({ fileId });
        throw failure('ratelimited');
      }
      return fileId === 'F0FLAKY0001'
        ? (calls.push({ fileId }), textRead(fileId, 'd.md', 'fourth'))
        : base.readAttachment(fileId, maxBytes, signal, accept);
    },
  };
  const tool = fileTool(['F0FIRST0001', 'F0SECOND001', 'F0THIRD0001', 'F0FLAKY0001'], client);
  const downloads = () => calls.map(({ fileId }) => fileId);
  for (const file of ['file:1', 'file:2', 'file:1', 'file:2']) assert.equal((await call(tool, { file })).ok, true);
  assert.deepEqual(downloads(), ['F0FIRST0001', 'F0SECOND001'], 'comparing two files downloads each once');
  assert.equal((await call(tool, { file: 'file:3', path: 'c.md' })).ok, true);
  assert.equal((await call(tool, { file: 'file:2' })).ok, true);
  assert.equal((await call(tool, { file: 'file:1' })).ok, true);
  assert.deepEqual(downloads(), ['F0FIRST0001', 'F0SECOND001', 'F0THIRD0001', 'F0FIRST0001'], 'the least recent file was evicted');
  assert.equal((await call(tool, { file: 'file:4' })).ok, false);
  assert.equal((await call(tool, { file: 'file:4' })).ok, true);
  assert.deepEqual(downloads().slice(-2), ['F0FLAKY0001', 'F0FLAKY0001'], 'the failed open was retried, not cached');
});

test('a handle outside the host\'s list reaches no download', async () => {
  const calls: ReadCall[] = [];
  const tool = fileTool(['F0NOTES0001'], reader({ F0NOTES0001: textRead('F0NOTES0001', 'notes.md', 'x') }, calls));
  for (const file of ['file:2', 'file:999']) {
    assert.deepEqual(await call(tool, { file }), {
      ok: false, error: `${file} is not one of this conversation's files. Use a handle from the request's file list or the attachment manifest.`,
    });
  }
  assert.deepEqual(calls, []);
});

test('the attachment manifest names a handle for every readable current file, and an over-long text file\'s failure names its own', async () => {
  const image: GatewayAttachmentRead = {
    fileId: 'F0LOGO00001', filename: 'logo.png', representation: 'image_original', contentType: 'image/png',
    bytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  };
  const result = await createSlackAttachmentAnalysis({
    intake: { kind: 'ready', request: 'Compare these.', count: 4, fileIds: ['F0NOTES0001', 'F0PDF000001', 'F0LOGO00001', 'F0LONG00001'] },
    gateway: reader({
      F0NOTES0001: textRead('F0NOTES0001', 'notes.md', '# Notes'),
      F0PDF000001: pdfRead('F0PDF000001', 'report.pdf', ['Report']),
      F0LOGO00001: image,
      F0LONG00001: textRead('F0LONG00001', 'long.txt', 'x'.repeat(70_000), 'text/plain'),
    }),
    prompt: async () => ({ text: 'Attachment 1 - notes.md: a heading.' }),
  });
  const lines = formatSlackAttachmentSignal(result).body.split('\n').filter((line) => line.startsWith('- ordinal='));
  assert.deepEqual(lines, [
    '- ordinal=1 | filename="notes.md" | representation=text_original | handle=file:1 | status=success | code=analyzed | next_action="To read the file itself, call read_slack_file with file \\"file:1\\"."',
    '- ordinal=2 | filename="report.pdf" | representation=pdf_original | handle=file:2 | status=success | code=analyzed | next_action="To read the file itself, call read_slack_file with file \\"file:2\\"."',
    '- ordinal=3 | filename="logo.png" | representation=image_original | status=success | code=analyzed | next_action="none"',
    '- ordinal=4 | filename="long.txt" | handle=file:4 | status=failure | code=attachment_character_limit_exceeded | next_action="This file is too long for the analysis. To read it, call read_slack_file with file \\"file:4\\"; when the result has nextOffset, call again with it as offset."',
  ]);
});

test('only an over-long text file\'s failure names a handle: broken text and unreadable files do not', async () => {
  const result = await normalizeSlackAttachments({
    fileIds: ['F0BROKEN001', 'F0VIDEO0001', 'F0LONGPDF01'],
    gateway: reader({
      F0BROKEN001: { ...textRead('F0BROKEN001', 'broken.txt', ''), bytes: Uint8Array.of(0xc3, 0x28) },
      F0VIDEO0001: failure('unsupported_file_type'),
      F0LONGPDF01: pdfRead('F0LONGPDF01', 'long.pdf',
        Array.from({ length: 40 }, () => Array.from({ length: 25 }, () => 'y'.repeat(80)).join('\n'))),
    }),
  });
  assert.deepEqual(result.failures.map(({ code, handle }) => ({ code, handle })), [
    { code: 'text_utf8_invalid', handle: undefined },
    { code: 'unsupported_file_type', handle: undefined },
    { code: 'attachment_character_limit_exceeded', handle: undefined },
  ]);
});
