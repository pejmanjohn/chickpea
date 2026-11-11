import assert from 'node:assert/strict';
import { test } from 'node:test';

import { serviceErrorText } from '../src/connections/service-error-text.ts';

// Every credential, identifier and message below is synthetic.
const filter = (text: string) => serviceErrorText(text, ['synthetic-composio-key']);
const keeps = (text: string) => assert.equal(filter(text), text, text);
const drops = (core: string) => assert.equal(filter(`before ${core} after`), 'before […] after', core);

test('a word stays in any script and in a word’s case, with an apostrophe inside it', () => {
  for (const word of [
    'contacts', 'Contacts', 'INVALID', 'objectType', 'HubSpot', 'OAuth', 'URLs', "doesn't", 'don’t',
    'Ungültige', 'недопустимое', '无效的属性', 'twentyLettersInWords',
  ]) {
    keeps(`before ${word} after`);
  }
});

test('a word with a digit, over 20 letters or in a generated key’s case is dropped', () => {
  for (const core of ['syntheticToken42', 'SyntheticTail42', 'twentyOneLettersInWords', 'kQzPmXvTrLwNbHjD', 'aBcDeFgH']) {
    drops(core);
  }
});

test('a number of up to four digits stays, and a longer one is dropped', () => {
  keeps('status 400 after 1000 tries, 0 left');
  for (const core of ['12345', '123456', '4000000000000002']) drops(core);
});

test('an identifier of words stays', () => {
  for (const identifier of [
    'hs_lead_status', 'contacts.email', 'body.parent.page_id', 'requests[0].update_cells.fields', 'INVALID_ARGUMENT',
    'non-existent', 'hs_v2_date_entered_lead', 'line_2', 'oauth2_scope', 'sheets.googleapis.com', 'crm.objects.contacts.read',
  ]) {
    keeps(`before ${identifier} after`);
  }
});

test('an identifier with a forbidden character, too many digits or a long or numbered run is dropped', () => {
  for (const core of [
    'token=value', 'chat:write', 'files/object', 'member@example', 'first%second', 'first&second', 'first+second',
    'first#second', 'first?second', String.raw`first\second`,
    // A word plus a number alone reads as a password.
    'summer24',
    // Digits after a long run are how a synthetic or generated value ends.
    'x_syntheticSecret42',
    'sk_a1_b2_c3',
    'client_secret_syntheticCredentialValueLong',
    '12_synthetic_value',
    `${'ab_'.repeat(21)}abc`,
  ]) {
    drops(core);
  }
});

test('edge punctuation is set aside, and a backslash inside a chunk drops it', () => {
  keeps(`("x"), [0] 'contacts'. {} - — “quoted” …`);
  // JSON escaped twice keeps one backslash before each quote after the single unescape.
  assert.equal(
    filter(String.raw`Property \\\"hs_lead_status\\\" does not exist`),
    String.raw`Property \"hs_lead_status\" does not exist`,
  );
  assert.equal(filter(String.raw`Bearer first\\nSyntheticTail`), 'Bearer […]');
});

test('JSON string escapes are decoded once', () => {
  assert.equal(filter(String.raw`Property "hs_lead_status" is unknown\nTry again`), 'Property "hs_lead_status" is unknown Try again');
  assert.equal(filter(String.raw`Path \/v1\/objects is not allowed`), 'Path […] is not allowed');
  assert.equal(filter(String.raw`Field \\u0041BC failed`), 'Field […] failed');
});

test('the turn key and the shared credential signatures drop their chunk first', () => {
  assert.equal(
    filter(`Rejected synthetic-composio-key, then xoxb-${'1'.repeat(12)}-${'a'.repeat(24)} and Bearer xoxb-${'2'.repeat(12)}-${'b'.repeat(24)}.`),
    'Rejected […] then […] and Bearer […]',
  );
});

test('a run of dropped chunks becomes one marker', () => {
  assert.equal(filter('a %1 %2\n%3 b %4'), 'a […] b […]');
});

test('the text is cut between chunks to 1,000 characters, ending in an ellipsis', () => {
  const words = 'detail '.repeat(200);
  const shown = filter(words);
  assert.equal(shown, `${'detail '.repeat(142).trimEnd()}…`);
  assert.ok(shown.length <= 1_000);
  // A dropped chunk at the cut leaves no marker before the ellipsis.
  assert.equal(filter(`${'detail '.repeat(142)}%dropped ${'detail '.repeat(10)}`), `${'detail '.repeat(142).trimEnd()}…`);
  assert.equal(filter('detail '.repeat(142).trimEnd()), 'detail '.repeat(142).trimEnd());
});

test('only the first 16,384 characters are read, and the chunk the cut lands in is dropped whole', () => {
  // `syntheticpassphrase` is a word, so a cut that kept part of it would show its start.
  const lead = `detail${' '.repeat(16_372)}`;
  const text = `${lead}syntheticpassphrase rest`;
  assert.equal(text.slice(16_378, 16_386), 'syntheti');
  assert.equal(filter(text), 'detail…');
  assert.equal(filter(`${'%a '.repeat(5_461)}%a`), '');
});

/**
 * Synthetic failures written in the styles the services document: HubSpot's, Notion's and
 * Google's error objects, Python's dict repr as an SDK prints them, an HTTP client's status
 * line and Slack's Web API bodies. `keeps` holds what the model needs to correct the request.
 */
const UUID = '00000000-1111-2222-3333-444444444444';
const CORPUS: { text: string; keeps: string[] }[] = [
  {
    text: String.raw`{"status": "error", "message": "Property values were not valid: [{\"isValid\":false,\"message\":\"Property \\\"hs_lead_statu\\\" does not exist\",\"error\":\"PROPERTY_DOESNT_EXIST\",\"name\":\"hs_lead_statu\"}]", "correlationId": "${UUID}", "category": "VALIDATION_ERROR"}`,
    keeps: ['Property values were not valid', String.raw`\"hs_lead_statu\" does not`, '"category": "VALIDATION_ERROR"'],
  },
  {
    text: `{"status": "error", "message": "This app hasn't been granted all required scopes to make this call. Read more about required scopes here: https://developers.example.test/scopes.", "correlationId": "${UUID}", "errors": [{"message": "One or more of the following scopes are required.", "context": {"requiredGranularScopes": ["crm.objects.contacts.read"]}}], "category": "MISSING_SCOPES"}`,
    keeps: ["This app hasn't been granted all required scopes", 'crm.objects.contacts.read', 'MISSING_SCOPES'],
  },
  {
    text: `{"status": "error", "message": "You have reached your secondly limit.", "errorType": "RATE_LIMIT", "correlationId": "${UUID}", "policyName": "SECONDLY"}`,
    keeps: ['You have reached your secondly limit.', '"RATE_LIMIT"', '"SECONDLY"'],
  },
  {
    text: '404 Client Error: Not Found for url: https://api.example.test/crm/v3/objects/contacts/9000000001',
    keeps: ['404 Client Error: Not Found for url: […]'],
  },
  {
    text: "{'status': 'error', 'message': 'Invalid input JSON on line 1, column 42: Unable to find property synthetic_stage on object type contacts', 'category': 'VALIDATION_ERROR', 'subCategory': 'INVALID_PROPERTY'}",
    keeps: ['Unable to find property synthetic_stage on object type contacts', "'INVALID_PROPERTY'"],
  },
  {
    text: String.raw`{"object": "error", "status": 400, "code": "validation_error", "message": "body failed validation: body.parent.page_id should be a valid uuid, instead was \"not-a-uuid\"."}`,
    keeps: ['"status": 400', '"validation_error"', 'body.parent.page_id should be a valid uuid'],
  },
  {
    text: `{"object":"error","status":404,"code":"object_not_found","message":"Could not find database with ID: ${UUID}. Make sure the relevant pages and databases are shared with your integration."}`,
    keeps: ['not find database with ID: […] Make sure the relevant pages and databases are shared'],
  },
  {
    text: '{"object": "error", "status": 429, "code": "rate_limited", "message": "You have been rate limited. Please try again in a few minutes."}',
    keeps: ['"status": 429', '"rate_limited"', 'Please try again in a few minutes.'],
  },
  {
    text: '{"object": "error", "status": 403, "code": "restricted_resource", "message": "Insufficient permissions for this endpoint."}',
    keeps: ['"status": 403', '"restricted_resource"', 'Insufficient permissions for this endpoint.'],
  },
  {
    text: 'body failed validation: body.properties.Stage.select.name should be a string, instead was 42.',
    keeps: ['body.properties.Stage.select.name should be a string, instead was 42.'],
  },
  {
    text: 'Could not find property with name or id: Stage Owner',
    keeps: ['Could not find property with name or id: Stage Owner'],
  },
  {
    text: String.raw`{"error": {"code": 400, "message": "Invalid value at 'requests[0].update_cells.fields', \"userEnteredValue.synthetic\"", "status": "INVALID_ARGUMENT"}}`,
    keeps: ['"code": 400', "'requests[0].update_cells.fields'", 'userEnteredValue.synthetic', 'INVALID_ARGUMENT'],
  },
  {
    text: '{"error": {"code": 403, "message": "Request had insufficient authentication scopes.", "errors": [{"message": "Insufficient Permission", "domain": "global", "reason": "insufficientPermissions"}], "status": "PERMISSION_DENIED", "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "domain": "googleapis.com"}]}}',
    keeps: ['"code": 403', 'insufficient authentication scopes', 'PERMISSION_DENIED', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'],
  },
  {
    text: "Quota exceeded for quota metric 'Read requests' and limit 'Read requests per minute per user' of service 'sheets.googleapis.com' for consumer 'project_number:000000000000'.",
    keeps: ["limit 'Read requests per minute per user' of service 'sheets.googleapis.com' for consumer […]"],
  },
  {
    text: `<HttpError 404 when requesting https://www.example.test/calendar/v3/calendars/primary/events/synthetic?alt=json returned "Not Found". Details: "[{'domain': 'global', 'reason': 'notFound', 'message': 'Not Found'}]">`,
    keeps: ['<HttpError 404 when requesting […] returned "Not Found".', "'notFound'"],
  },
  {
    text: 'Invalid JSON payload received. Unknown name "valueInputOptin": Cannot find field.',
    keeps: ['Unknown name "valueInputOptin": Cannot find field.'],
  },
  {
    text: "The request to the Slack API failed. (url: https://slack.example.test/api/chat.postMessage)\nThe server responded with: {'ok': False, 'error': 'not_in_channel'}",
    keeps: ["The server responded with: {'ok': False, 'error': 'not_in_channel'}"],
  },
  { text: "The server responded with: {'ok': False, 'error': 'ratelimited'}", keeps: ["'error': 'ratelimited'"] },
  {
    text: "The server responded with: {'ok': False, 'error': 'invalid_blocks', 'errors': ['must provide a valid block_id [json-pointer:/blocks/0/block_id]']}",
    keeps: ["'invalid_blocks'", 'must provide a valid block_id'],
  },
  {
    text: "The server responded with: {'ok': False, 'error': 'missing_scope', 'needed': 'chat:write', 'provided': 'channels:read,users:read'}",
    keeps: ["'error': 'missing_scope', 'needed': […]"],
  },
  { text: '{"ok":false,"error":"channel_not_found"}', keeps: [] },
  { text: '{"ok":false,"error":"missing_scope","needed":"chat:write","provided":"channels:read,users:read"}', keeps: [] },
];

/** Whitespace chunks once JSON escapes are decoded: an escaped line break splits, others do not. */
function sourceChunks(text: string): number {
  return text.replace(/\\[nrt]/g, ' ').split(/\s+/).filter(Boolean).length;
}

test('realistic service errors keep their field names, error codes and statuses', (t) => {
  let chunks = 0;
  let kept = 0;
  for (const { text, keeps: phrases } of CORPUS) {
    const shown = filter(text);
    for (const phrase of phrases) assert.ok(shown.includes(phrase), `${phrase}\n  in ${shown}`);
    chunks += sourceChunks(text);
    kept += shown.split(' ').filter((chunk) => chunk && chunk !== '[…]').length;
  }
  t.diagnostic(`${kept} of ${chunks} chunks kept (${(100 * kept / chunks).toFixed(1)}%)`);
  assert.ok(kept / chunks >= 0.9, `${kept} of ${chunks}`);
});

test('compact JSON keeps none of its glued values, a known cost', () => {
  assert.equal(filter('{"ok":false,"error":"channel_not_found"}'), '[…]');
  assert.equal(filter('Request body: {"client_secret":"syntheticClientSecretValue"}'), 'Request body: […]');
});

/** Synthetic keys from a seeded generator (mulberry32), so each run checks the same ones. */
function syntheticKeys(alphabet: string, length: number, count: number): string[] {
  let seed = 0x5eed + length;
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let mixed = Math.imul(seed ^ (seed >>> 15), seed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32;
  };
  return Array.from({ length: count }, () =>
    Array.from({ length }, () => alphabet.charAt(Math.floor(next() * alphabet.length))).join(''));
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const LETTERS = `${LOWER}${LOWER.toUpperCase()}`;
const BASE62 = `${LETTERS}0123456789`;
const shownKeys = (keys: string[]) => keys.filter((key) => filter(`key ${key} rejected`) !== 'key […] rejected');

test('a generated key over 20 characters is dropped', () => {
  const shapes: [string, string[]][] = [
    ['base62, 21 to 64', [21, 24, 32, 40, 64].flatMap((length) => syntheticKeys(BASE62, length, 400))],
    ['hex, 32 to 64', [32, 40, 64].flatMap((length) => syntheticKeys('0123456789abcdef', length, 400))],
    ['base64url, 32 and 43', [32, 43].flatMap((length) => syntheticKeys(`${BASE62}-_`, length, 400))],
    ['base64, 40', syntheticKeys(`${BASE62}+/`, 40, 400)],
    ['a Stripe-style prefix', syntheticKeys(BASE62, 24, 400).map((key) => `sk_live_${key}`)],
    ['a JWT shape', syntheticKeys(`${BASE62}-_`, 36, 400).map((key) => `${key.slice(0, 12)}.${key.slice(12, 24)}.${key.slice(24)}`)],
    ['lowercase letters, 21 to 32', [21, 24, 32].flatMap((length) => syntheticKeys(LOWER, length, 400))],
  ];
  for (const [shape, keys] of shapes) assert.deepEqual(shownKeys(keys), [], shape);
});

test('a short key with no digit can read as a word: always in one case, rarely in mixed case', () => {
  // Exactly 17,711 of the 2^20 case patterns of 20 letters read as a word: 1.69%.
  const mixed = shownKeys(syntheticKeys(LETTERS, 20, 4_000)).length;
  assert.ok(mixed <= 100, `${mixed} of 4,000 mixed-case 20-letter keys`);
  // A 16-character base62 key has no digit 6% of the time: 0.24% read as a word.
  const base62 = shownKeys(syntheticKeys(BASE62, 16, 4_000)).length;
  assert.ok(base62 <= 40, `${base62} of 4,000 16-character base62 keys`);
  assert.deepEqual(shownKeys(syntheticKeys(LOWER, 20, 100)).length, 100);
});

test('a hostile 16 KiB text takes linear time', () => {
  const fill = (unit: string) => unit.repeat(Math.ceil(16_384 / unit.length)).slice(0, 16_384);
  for (const text of [
    `${'.'.repeat(16_383)}x`, fill(String.raw`\"`), fill(String.raw`\n`), fill('%a '), fill('-----BEGIN '),
    fill('xoxb-'), fill(`${'ab_'.repeat(21)}a `), fill('((((((((((((((((a '), fill('aB'),
  ]) {
    const start = performance.now();
    filter(text);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 50, `${elapsed.toFixed(1)} ms for ${text.slice(0, 16)}…`);
  }
});
