import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readDirectSlackAttachment } from '../src/slack/attachment-client.ts';

const base = { fileId: 'F123', maxBytes: 100, token: 'test-token', workspaceId: 'TCHILD' };
function fixture(changes: Record<string, unknown> = {}, response = new Response('hello', { headers: { 'content-type': 'text/plain' } })) {
  let calls = 0;
  const fetcher: typeof fetch = async (url, options) => {
    calls++;
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
