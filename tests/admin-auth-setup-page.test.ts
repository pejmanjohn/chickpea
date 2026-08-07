import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderAuthSetupPage } from '../src/admin/page.ts';

test('Access setup page covers new and existing Zero Trust teams accessibly', () => {
  const html = renderAuthSetupPage({ state: 'fresh' });
  assert.match(html, /Create Zero Trust organization/i);
  assert.match(html, /existing Zero Trust organization/i);
  assert.match(html, /Cloudflare account identity provider/i);
  assert.match(html, /one-time PIN/i);
  assert.match(html, /\/admin/);
  assert.match(html, /\/admin\/\*/);
  assert.match(html, /<label[^>]*for="owner-email"/i);
  assert.match(html, /@media/i);
});
