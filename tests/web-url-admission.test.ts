import assert from 'node:assert/strict';
import test from 'node:test';

import { admitWebUrl, requestTokens, type WebUrlSources } from '../src/web/page.ts';

const REQUEST = 'Our incident codename is Bluebird42, and the vendor is Statusboard';

function sources(overrides: Partial<WebUrlSources> = {}): WebUrlSources {
  return { typed: [], sourced: [], requestTokens: requestTokens(REQUEST), ...overrides };
}

test('a URL the model composes is refused when it carries a long word from the request', () => {
  for (const url of [
    'https://partner.example/leak/bluebird42',
    'https://partner.example/leak/BLUEBIRD42',
    'https://partner.example/leak/%42luebird42',
    'https://bluebird42.partner.example/',
    'https://partner.example/a-statusboard-b',
  ]) {
    assert.deepEqual(admitWebUrl(url, sources()), { admitted: false, reason: 'request_text' }, url);
  }
  const admitted = admitWebUrl('https://docs.vendor.example/api/rate-limits', sources());
  assert.equal(admitted.admitted && admitted.url.href, 'https://docs.vendor.example/api/rate-limits',
    'a composed URL with only short or unrelated words is read');
});
