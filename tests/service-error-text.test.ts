import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scrubServiceErrorText } from '../src/connections/service-error-text.ts';

// Every credential below is synthetic.
const scrub = (text: string) => scrubServiceErrorText(text, ['synthetic-composio-key']);

test('a typical validation error survives whole', () => {
  for (const text of [
    "Property 'x' is not allowed for object type 'contacts'",
    'HTTP 400: Invalid value at \'requests[0].update_cells.fields\' for property hs_analytics_first_touch_converting_campaign',
    '{"error":{"code":400,"message":"Unknown field","status":"INVALID_ARGUMENT"},"errorCode":"PROPERTY_DOESNT_EXIST",' +
      '"private":false,"token":null,"session":""}',
    'POST https://api.example.test/crm/v3/objects/contacts/search failed with 400 Bad Request',
  ]) {
    assert.equal(scrub(text), text);
  }
});

test('the existing redaction still runs: the turn key and the shared signatures', () => {
  assert.equal(
    scrub(`Rejected synthetic-composio-key and xoxb-${'1'.repeat(12)}-${'a'.repeat(24)}`),
    'Rejected [redacted] and [redacted]',
  );
});

test('a Cookie or Set-Cookie header loses every pair after it', () => {
  assert.equal(scrub('Sent Cookie: theme=light; SID=syntheticSession42 to the API'), 'Sent Cookie: [redacted] to the API');
  assert.equal(
    scrub('Set-Cookie: lang=en; sid=syntheticSession42; HttpOnly; Path=/ was returned'),
    'Set-Cookie: [redacted] was returned',
  );
  assert.equal(
    scrub('{"headers":{"Cookie":"theme=light; sid=syntheticSession42"}}'),
    '{"headers":{"Cookie":"[redacted]"}}',
  );
  assert.equal(
    scrub('{"set-cookie": ["lang=en; HttpOnly", "sid=syntheticSession42"], "status": 401}'),
    '{"set-cookie": [redacted], "status": 401}',
  );
  assert.equal(scrub('"cookies": {"sid": "syntheticSession42"}'), '"cookies": [redacted]');
});

test('a secret-named field loses its value in every syntax', () => {
  const cases: [string, string][] = [
    ['client_secret=syntheticClientSecret42 rest', 'client_secret=[redacted] rest'],
    ['X-Api-Key: syntheticApiKey42 rest', 'X-Api-Key: [redacted] rest'],
    ['{"client_secret":"synthetic Client Secret 42"}', '{"client_secret":"[redacted]"}'],
    ["{'client_secret': 'syntheticClientSecret42'}", "{'client_secret': '[redacted]'}"],
    [':password => "syntheticPassword42"', ':password => "[redacted]"'],
    ['("x-session-id", "syntheticSession42")', '("x-session-id", "[redacted]")'],
    ['params[api_key]=syntheticApiKey42', 'params[api_key]=[redacted]'],
    ['"refresh_tokens":["syntheticRefresh42","syntheticRefresh43"]', '"refresh_tokens":[redacted]'],
    ['"credentials":{"client_id":"public-id","client_secret":"syntheticClientSecret42"}', '"credentials":[redacted]'],
    ['<sessionToken>syntheticSession42</sessionToken>', '<sessionToken>[redacted]</sessionToken>'],
    ['token: Bearer syntheticBearerValue', 'token: Bearer [redacted]'],
    ['Authorization: Custom syntheticCustomValue', 'Authorization: Custom [redacted]'],
    ['"Authorization":"Bearer synthetic bearer value"', '"Authorization":"[redacted]"'],
  ];
  for (const [text, scrubbed] of cases) assert.equal(scrub(text), scrubbed, text);
});

test('every secret word names a secret field, in any case and with any separator', () => {
  const names = [
    'client_secret', 'access-token', 'apiKey', 'api.key', 'API KEY', 'password', 'passwd', 'pwd', 'x-auth',
    'credentials', 'sessionId', 'COOKIE', 'cookieValue', 'Signature', 'sig', 'auth_code', 'otp', 'bearer', 'private_key',
    'privatePem',
  ];
  for (const name of names) {
    assert.equal(scrub(`${name}: syntheticValue42 ok`), `${name}: [redacted] ok`, name);
  }
  assert.equal(scrub('otp=123456'), 'otp=[redacted]');
  // A name that is secret only for "code" keeps a status or an error code, never a code value.
  assert.equal(scrub('statusCode=404 error_code=NOT_FOUND code=4/0SyntheticCode'), 'statusCode=404 error_code=NOT_FOUND code=[redacted]');
});

test('escaped and encoded text is decoded, and only the decoded text is scrubbed and returned', () => {
  const field = '{"client_secret":"[redacted]"}';
  const cases: [string, string][] = [
    [String.raw`{\"client_secret\":\"syntheticClientSecret42\"}`, field],
    [String.raw`{\\\"client_secret\\\":\\\"syntheticClientSecret42\\\"}`, field],
    [String.raw`{\u0022client_secret\u0022:\u0022syntheticClientSecret42\u0022}`, field],
    [String.raw`{\x22client_secret\x22:\x22syntheticClientSecret42\x22}`, field],
    ['%7B%22client_secret%22%3A%22syntheticClientSecret42%22%7D', field],
    ['client%5Fsecret=syntheticClientSecret42', 'client_secret=[redacted]'],
    ['client%255Fsecret%253DsyntheticClientSecret42', 'client_secret=[redacted]'],
    ['{&quot;client_secret&quot;:&quot;syntheticClientSecret42&quot;}', field],
    ['{&#34;client_secret&#x22;:&#34;syntheticClientSecret42&#34;}', field],
    ['{&amp;quot;client_secret&amp;quot;:&amp;quot;syntheticClientSecret42&amp;quot;}', field],
    [String.raw`Cookie: sid=syntheticSession42\r\nHost: api.example.test`, 'Cookie: [redacted] Host: api.example.test'],
  ];
  for (const [text, scrubbed] of cases) assert.equal(scrub(text), scrubbed, text);
});

test('a URL keeps no login, query, fragment or token-shaped path segment, with or without a scheme', () => {
  const cases: [string, string][] = [
    [
      String.raw`403 for https:\/\/files.example.test\/object?X-Amz-Signature=syntheticSignature42`,
      '403 for https://files.example.test/object?[redacted]',
    ],
    [
      'GET files.example.test/object?Expires=1700000000&Policy=c3ludGhldGlj',
      'GET files.example.test/object?[redacted]',
    ],
    ['https://app.example.test/callback#state=syntheticState42', 'https://app.example.test/callback#[redacted]'],
    ['https://synthetic-user:synthetic-pass@api.example.test/v1', 'https://api.example.test/v1'],
    ['https://syntheticLoginValue@git.example.test/org/repo.git', 'https://git.example.test/org/repo.git'],
    ['//cdn.example.test/v1/object?Policy=c3ludGhldGlj', '//cdn.example.test/v1/object?[redacted]'],
    ['connect synthetic-user:synthetic-pass@db.example.test:5432 failed', 'connect db.example.test:5432 failed'],
    [
      'POST https://hooks.example.test/services/Zk3pQ9xLm2Rt7VbN4cWd failed',
      'POST https://hooks.example.test/services/[redacted] failed',
    ],
    // Neighbouring segments that are not words count as one token, as a decoded %2F splits one.
    [
      'POST https://hooks.example.test/services/T0SYNTH01/B0SYNTH02/Zk3pQ9xLm2Rt7 failed',
      'POST https://hooks.example.test/services/[redacted] failed',
    ],
    [
      'GET https://api.example.test/v1/tokens/aB3dE5fG7hI9%2FkL1mN3oP5qR7%2FsT9uV1wX3yZ5/info',
      'GET https://api.example.test/v1/tokens/[redacted]/info',
    ],
    ['GET v1/files/Zk3pQ9xLm2Rt7VbN4cWd failed', 'GET v1/files/[redacted] failed'],
    // A segment the long-run rule would split at its tilde.
    ['GET https://cdn.example.test/v1/Zk3pQ9xLm2~Rt7VbN4cWd/file.png', 'GET https://cdn.example.test/v1/[redacted]/file.png'],
    ['GET /crm/v3/objects/contacts/12345678901/associations failed', 'GET /crm/v3/objects/contacts/12345678901/associations failed'],
    ['GET /v1/download?Policy=c3ludGhldGlj&Key-Pair-Id=K2SYNTH failed', 'GET /v1/download?[redacted] failed'],
    [
      'redirect_uri=https%3A%2F%2Fapp.example.test%2Fcb%3Fstate%3DsyntheticState42',
      'redirect_uri=https://app.example.test/cb?[redacted]',
    ],
    ['Did you mean contacts.search?', 'Did you mean contacts.search?'],
  ];
  for (const [text, scrubbed] of cases) assert.equal(scrub(text), scrubbed, text);
});

test('a bearer or basic value outside a header is removed', () => {
  assert.equal(
    scrub('Sent Bearer synthetic.value-42 and Basic c3ludGhldGlj. Basic authentication failed.'),
    'Sent Bearer [redacted] and Basic [redacted] Basic authentication failed.',
  );
});

test('known token prefixes are removed whatever their length', () => {
  for (const token of [
    'sk_live_syntheticStripeCredential42', 'rk_test_synthetic42', 'whsec_synthetic42', 'glpat-synthetic42',
    'ya29.synthetic-access42', 'shpat_synthetic42', 'ntn_synthetic42', 'lin_api_synthetic42', 'ATATTsynthetic42',
    'SG.synthetic42.value42', 'npm_synthetic42', 'figd_synthetic42', `sk-${'synthetic'}OpenAiKey42`,
  ]) {
    assert.equal(scrub(`Invalid API key provided: ${token} today`), 'Invalid API key provided: [redacted] today', token);
  }
});

test('a long base64, base64url or hex run is removed, and a long run of words is not', () => {
  for (const run of [
    'Q2hpY2twZWFTeW50aGV0aWNLZXkxMjM0NTY3ODkw',
    'wJalrXUtnFEMI/K7MDENG+bPxRfiCYSYNTHETIC==',
    '5f3c9a1e7b2d4f6a8c0e1b3d5f7a9c2e',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGljU2lnbmF0dXJl',
  ]) {
    assert.equal(scrub(`Rejected ${run} now`), 'Rejected [redacted] now', run);
  }
  for (const words of [
    'properties.hs_analytics_first_touch_converting_campaign',
    '/crm/v3/objects/contacts/batch/read/associations',
    'firstTouchConvertingCampaignForTheQuarter2',
  ]) {
    assert.equal(scrub(`Unknown ${words} now`), `Unknown ${words} now`, words);
  }
});
