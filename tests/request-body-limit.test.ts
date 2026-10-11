import assert from 'node:assert/strict';
import test from 'node:test';

import { readBoundedRequestBody } from '../src/security/request-body-limit.ts';

for (const [label, contentLength, reason] of [
  ['oversized', '2', 'body_too_large'],
  ['malformed', 'not-a-length', 'invalid_content_length'],
] as const) {
  test(`cancels an unread request body on ${label} Content-Length rejection`, async () => {
    let cancelled = false;
    const request = new Request('https://chickpea.test/ingress', {
      method: 'POST',
      headers: { 'content-length': contentLength },
      body: new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      duplex: 'half',
    } as RequestInit);

    const result = await readBoundedRequestBody(request, 1);

    assert.deepEqual(result, { ok: false, reason });
    assert.equal(cancelled, true);
  });
}
