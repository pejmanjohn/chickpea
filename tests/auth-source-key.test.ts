import assert from 'node:assert/strict';
import { test } from 'node:test';

import { requestAuthSourceKey } from '../src/auth/source-key.ts';

test('Node auth buckets ignore client-supplied Cloudflare forwarding headers', () => {
  const request = new Request('https://chickpea.example.com/admin/setup', {
    headers: { 'cf-connecting-ip': '203.0.113.10' },
  });
  assert.equal(requestAuthSourceKey(request, false), 'local:chickpea.example.com');
  assert.equal(requestAuthSourceKey(request, true), '203.0.113.10');
});
