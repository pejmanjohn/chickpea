import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readDirectSlackAttachment } from '../src/slack/attachment-client.ts';

const base = { fileId: 'F123', maxBytes: 100, token: 'test-token', workspaceId: 'TCHILD' };
function fixture(changes: Record<string, unknown> = {}, response = new Response('hello', { headers: { 'content-type': 'text/plain' } })) {
  let calls = 0;
  const fetcher: typeof fetch = async (url, options) => {
    calls++;
    // workerd supports manual/follow; error is unsupported before any network I/O.
    assert.equal(options?.redirect, 'manual');
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer test-token');
    if (calls === 1) {
      assert.equal(String(url), 'https://slack.com/api/files.info');
      return Response.json({ ok: true, file: { id: 'F123', name: 'fixture.txt', mimetype: 'text/plain', size: 5,
        url_private: 'https://files.slack.com/files-pri/TPARENT-F123/fixture.txt', ...changes } });
    }
    assert.equal(options?.redirect, 'manual');
    return response;
  };
  return { fetcher, calls: () => calls };
}
test('direct reader accepts authenticated enterprise-parent file URL and returns bounded text', async () => {
  const f = fixture();
  const result = await readDirectSlackAttachment({ ...base, fetch: f.fetcher });
  assert.equal(result.representation, 'text_original');
  assert.equal(new TextDecoder().decode(result.bytes), 'hello');
  assert.equal(f.calls(), 2);
});
for (const [label, changes] of Object.entries({
  otherFile: { id: 'FOTHER' }, external: { is_external: true },
  attackerHost: { url_private: 'https://attacker.example/files-pri/TPARENT-F123/f' },
  otherFileUrl: { url_private: 'https://files.slack.com/files-pri/TPARENT-F999/f' },
  credentials: { url_private: 'https://secret@files.slack.com/files-pri/TPARENT-F123/f' },
  tooLarge: { size: 101 },
})) test(`direct reader rejects ${label} before downloading`, async () => {
  const f = fixture(changes);
  await assert.rejects(readDirectSlackAttachment({ ...base, fetch: f.fetcher }));
  assert.equal(f.calls(), 1);
});
test('direct reader refuses redirects without following credentials', async () => {
  const f = fixture({}, new Response(null, { status: 302, headers: { location: 'https://attacker.example' } }));
  await assert.rejects(readDirectSlackAttachment({ ...base, fetch: f.fetcher }), /attachment_redirect_rejected/);
});
test('direct reader enforces streamed byte ceiling even without content length', async () => {
  const f = fixture({ size: undefined }, new Response('x'.repeat(101)));
  await assert.rejects(readDirectSlackAttachment({ ...base, fetch: f.fetcher }), /attachment_byte_limit_exceeded/);
});
test('direct reader rejects truncated files', async () => {
  const f = fixture({}, new Response('hi'));
  await assert.rejects(readDirectSlackAttachment({ ...base, fetch: f.fetcher }), /attachment_incomplete/);
});
test('direct reader propagates Slack access denial without downloading', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json({ ok: false, error: 'file_not_found' }); };
  await assert.rejects(readDirectSlackAttachment({ ...base, fetch: fetcher }), /file_not_found/);
  assert.equal(calls, 1);
});

test('files.info rejects metadata redirects and cancels without a download', async () => {
  let cancelled = false;
  let calls = 0;
  const fetcher: typeof fetch = async (_url, options) => {
    calls++;
    assert.equal(options?.redirect, 'manual');
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status: 302, headers: { location: 'https://attacker.example' },
    });
  };
  await assert.rejects(readDirectSlackAttachment({ ...base, fetch: fetcher }), /attachment_redirect_rejected/);
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});
test('files.info caps chunked metadata and cancels its stream before JSON parsing', async () => {
  let cancelled = false;
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(128 * 1024)); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'application/json' } });
  };
  await assert.rejects(readDirectSlackAttachment({ ...base, fetch: fetcher }), /attachment_byte_limit_exceeded/);
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});
test('files.info for a 40 KB text file, which inlines its content three times, still reads the file', async () => {
  // Slack's files.info measured 2026-10-30: a 39,902-byte markdown upload returned 1,665,332 bytes,
  // mostly content_highlight_html, then content_html and content.
  const text = 'x'.repeat(40_000);
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    if (calls === 1) {
      return Response.json({
        ok: true,
        file: { id: 'F123', name: 'skill.md', mimetype: 'text/plain', size: text.length,
          url_private_download: 'https://files.slack.com/files-pri/TPARENT-F123/download/skill.md' },
        content: text,
        content_html: `<pre>${text}</pre>`,
        content_highlight_html: `<span class="hl">${text}</span>`.repeat(38),
      });
    }
    return new Response(text, { headers: { 'content-type': 'text/plain' } });
  };
  const result = await readDirectSlackAttachment({ ...base, maxBytes: 8 * 1024 * 1024, fetch: fetcher });
  assert.equal(result.representation, 'text_original');
  assert.equal(result.bytes.byteLength, text.length);
  assert.equal(calls, 2);
});
test('files.info sent compressed reads by its decoded body, not its encoded Content-Length', async () => {
  // Node's fetch asks for compression; Slack answered a 413,023-byte files.info
  // as brotli with Content-Length 11228, and fetch returns the decoded body.
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    if (calls === 1) {
      return new Response(JSON.stringify({ ok: true, file: { id: 'F123', name: 'fixture.txt', mimetype: 'text/plain', size: 5,
        url_private: 'https://files.slack.com/files-pri/TPARENT-F123/fixture.txt' }, content_highlight_html: 'x'.repeat(4096) }), {
        headers: { 'content-type': 'application/json', 'content-encoding': 'br', 'content-length': '512' },
      });
    }
    return new Response('hello', { headers: { 'content-type': 'text/plain' } });
  };
  const result = await readDirectSlackAttachment({ ...base, fetch: fetcher });
  assert.equal(new TextDecoder().decode(result.bytes), 'hello');
});
test('files.info refuses non-JSON metadata before downloading', async () => {
  const fetcher: typeof fetch = async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(readDirectSlackAttachment({ ...base, fetch: fetcher }), /invalid_file_metadata/);
});

test('Slack opaque binary MIME retains authoritative text metadata for strict normalization', async () => {
  const f = fixture({}, new Response('hello', { headers: { 'content-type': 'binary/octet-stream' } }));
  const result = await readDirectSlackAttachment({ ...base, fetch: f.fetcher });
  assert.equal(result.contentType, 'text/plain');
  assert.equal(new TextDecoder().decode(result.bytes), 'hello');
});

test('Slack force-download transport MIME retains authenticated text metadata', async () => {
  const f = fixture({}, new Response('hello', { headers: { 'content-type': 'application/force-download' } }));
  const result = await readDirectSlackAttachment({ ...base, fetch: f.fetcher });
  assert.equal(result.contentType, 'text/plain');
  assert.equal(result.representation, 'text_original');
  assert.equal(new TextDecoder().decode(result.bytes), 'hello');
});
test('Slack text metadata still rejects an HTML download response', async () => {
  const f = fixture({}, new Response('hello', { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(readDirectSlackAttachment({ ...base, fetch: f.fetcher }), /invalid_attachment_response/);
});

const ZIP = Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00);
const SKILL_ACCEPT = ['text_original', 'zip_original'] as const;
function archive(name: string, mimetype: string, downloadType: string, bytes: Uint8Array<ArrayBuffer> = ZIP) {
  return fixture({ name, mimetype, size: bytes.byteLength },
    new Response(bytes, { headers: { 'content-type': downloadType } }));
}

// Slack labels measured 2026-10-30 on real web uploads: a .skill is binary,
// application/octet-stream, served as application/octet-stream.
for (const [name, mimetype, downloadType] of [
  ['skills.zip', 'application/zip', 'application/zip'],
  ['trellis.skill', 'application/octet-stream', 'application/octet-stream'],
  ['writer.SKILL', 'text/plain', 'application/force-download'],
  ['bundle.zip', 'application/x-zip-compressed', 'application/x-zip-compressed'],
] as const) test(`a skill read takes ${name}, labelled ${mimetype}, as zip_original`, async () => {
  const f = archive(name, mimetype, downloadType);
  const result = await readDirectSlackAttachment({ ...base, fetch: f.fetcher, accept: SKILL_ACCEPT });
  assert.deepEqual(
    { representation: result.representation, contentType: result.contentType, filename: result.filename },
    { representation: 'zip_original', contentType: 'application/zip', filename: name },
  );
  assert.deepEqual(result.bytes, ZIP);
});
test('an empty archive, only its end record, reads as zip_original', async () => {
  const empty = Uint8Array.of(0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0));
  const f = archive('empty.zip', 'application/zip', 'application/zip', empty);
  assert.equal((await readDirectSlackAttachment({ ...base, fetch: f.fetcher, accept: SKILL_ACCEPT })).representation, 'zip_original');
});
test('a read that does not accept zip_original reads a plain-text .skill as text', async () => {
  const f = fixture({ name: 'notes.skill', mimetype: 'text/plain' });
  const result = await readDirectSlackAttachment({ ...base, fetch: f.fetcher });
  assert.deepEqual([result.representation, new TextDecoder().decode(result.bytes)], ['text_original', 'hello']);
});
test('a read that does not accept zip_original refuses an archive before downloading it', async () => {
  const f = archive('skills.zip', 'application/zip', 'application/zip');
  await assert.rejects(readDirectSlackAttachment({ ...base, fetch: f.fetcher }), /unsupported_file_type/);
  assert.equal(f.calls(), 1);
});
test('a .markdown upload, which Slack stores as a snippet served as a forced download, reads as text', async () => {
  const f = fixture({ name: 'notes.markdown', filetype: 'markdown', mimetype: 'text/plain' },
    new Response('hello', { headers: { 'content-type': 'application/force-download' } }));
  const result = await readDirectSlackAttachment({ ...base, fetch: f.fetcher, accept: SKILL_ACCEPT });
  assert.deepEqual([result.representation, result.contentType], ['text_original', 'text/plain']);
});
for (const [label, changes] of Object.entries({
  image: { name: 'diagram.png', mimetype: 'image/png' },
  pdf: { name: 'spec.pdf', mimetype: 'application/pdf' },
  convertingOffice: { name: 'notes.docx', filetype: 'docx', mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  externalArchive: { name: 'skills.zip', mimetype: 'application/zip', is_external: true },
})) test(`a skill read refuses ${label} as unsupported before downloading`, async () => {
  const f = fixture(changes);
  await assert.rejects(readDirectSlackAttachment({ ...base, fetch: f.fetcher, accept: SKILL_ACCEPT }), /unsupported_file_type/);
  assert.equal(f.calls(), 1);
});
test('a .zip or .skill that is not a zip, or that Slack serves as a page, is refused', async () => {
  const text = new TextEncoder().encode('hello');
  await assert.rejects(readDirectSlackAttachment({
    ...base, fetch: archive('renamed.zip', 'application/zip', 'application/zip', text).fetcher, accept: SKILL_ACCEPT,
  }), /invalid_slack_file_magic/);
  await assert.rejects(readDirectSlackAttachment({
    ...base, fetch: archive('notes.skill', 'text/plain', 'application/force-download', text).fetcher, accept: SKILL_ACCEPT,
  }), /invalid_slack_file_magic/);
  await assert.rejects(readDirectSlackAttachment({
    ...base, fetch: archive('skills.zip', 'application/zip', 'text/html').fetcher, accept: SKILL_ACCEPT,
  }), /invalid_slack_file_type/);
});
