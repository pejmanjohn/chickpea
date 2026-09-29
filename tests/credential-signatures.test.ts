import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  credentialMarkers,
  credentialMatchRanges,
  hasCredentialLikeContent,
  redactCredentialLikeContent,
  traceCredentialRedaction,
} from '../src/security/content-validation.ts';
import { streamableSlackMarkdownPrefix } from '../src/slack/message-format.ts';
import { awsExampleAccessKeyId, pemBegin, pemEnd, syntheticPem } from './helpers/credential-fixtures.ts';

// Assemble the token-shaped fixture at runtime so repository push protection
// never has to distinguish synthetic test data from a real Slack credential.
const SYNTHETIC_SLACK_TOKEN = ['xox', 'b'].join('') + '-' +
  ['1234567890', 'abcdefghijklmnop'].join('-');
const SYNTHETIC_SLACK_APP_TOKEN = ['x', 'app'].join('') + '-' +
  ['1', 'A0123456789', 'abcdefghijklmnopqrstuvwx'].join('-');
const SYNTHETIC_GITHUB_INSTALLATION_TOKEN = ['gh', 's_'].join('') +
  'abcdefghijklmnopqrstuvwxyz012';

// One sample per credential signature, in table order.
const SAMPLES: readonly { input: string; redacted: string }[] = [
  { input: pemBegin('RSA PRIVATE KEY'), redacted: '[credential redacted]' },
  {
    input: `token ${SYNTHETIC_SLACK_TOKEN} rest`,
    redacted: 'token [credential redacted] rest',
  },
  {
    input: `token ${SYNTHETIC_SLACK_APP_TOKEN} rest`,
    redacted: 'token [credential redacted] rest',
  },
  {
    input: 'key sk-ant-api03-abcdefghijklmnopqrstuvwx here',
    redacted: 'key [credential redacted] here',
  },
  {
    input: 'key sk-proj-abcdefghijklmnopqrstuvwx here',
    redacted: 'key [credential redacted] here',
  },
  {
    input: `token ${SYNTHETIC_GITHUB_INSTALLATION_TOKEN} here`,
    redacted: 'token [credential redacted] here',
  },
  { input: `id ${awsExampleAccessKeyId('AKIA')} here`, redacted: 'id [credential redacted] here' },
  { input: 'key bb_live_abcdefghijkl1234 here', redacted: 'key [credential redacted] here' },
  {
    input: 'CHICKPEA_AUTH_SECRET=supersecretvalue',
    redacted: '[credential redacted]',
  },
  {
    input: 'CHICKPEA_CREDENTIAL_KEY_2026_08=supersecretvalue',
    redacted: '[credential redacted]',
  },
  {
    input: 'COMPOSIO_WEBHOOK_SECRET=webhook-signing-secret',
    redacted: '[credential redacted]',
  },
  {
    input: 'BROWSERBASE_API_KEY=browserbase-key-value',
    redacted: '[credential redacted]',
  },
  {
    input: 'AWS_ACCESS_KEY_ID="abcdefgh12345"',
    redacted: '[credential redacted]"',
  },
];

test('credential markers stay the exact projection the streaming path relies on', () => {
  assert.deepEqual([...credentialMarkers()], [
    '-----BEGIN ',
    'xox',
    'xapp-',
    'sk-ant-',
    'sk-proj-',
    'ghp_',
    'gho_',
    'ghu_',
    'ghs_',
    'ghr_',
    'github_pat_',
    'AKIA',
    'ASIA',
    'bb_live_',
    'bb_test_',
    'CHICKPEA_AUTH_SECRET',
    'CHICKPEA_RECOVERY_TOKEN',
    'CHICKPEA_CREDENTIAL_KEY_',
    'TAG_ADMIN_TOKEN',
    'ADMIN_TOKEN',
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'COMPOSIO_API_KEY',
    'COMPOSIO_WEBHOOK_SECRET',
    'GITHUB_TOKEN',
    'BROWSERBASE_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
  ]);
});

test('all raw GitHub token families and Slack app tokens are redacted', () => {
  const githubTokens = ['p', 'o', 'u', 's', 'r'].map((kind) =>
    ['gh', `${kind}_`, 'abcdefghijklmnopqrstuvwxyz012'].join('')
  );
  for (const token of [SYNTHETIC_SLACK_APP_TOKEN, ...githubTokens]) {
    assert.equal(hasCredentialLikeContent(token), true, token.slice(0, 5));
    assert.equal(redactCredentialLikeContent(token), '[credential redacted]');
  }
});

test('every credential signature is both detected and redacted', () => {
  for (const sample of SAMPLES) {
    assert.equal(hasCredentialLikeContent(sample.input), true, sample.input);
    assert.equal(redactCredentialLikeContent(sample.input), sample.redacted);
  }
});

test('redaction leaves credential-free text untouched and handles several hits at once', () => {
  assert.equal(
    redactCredentialLikeContent('a plain sentence with no secrets'),
    'a plain sentence with no secrets',
  );
  assert.equal(
    redactCredentialLikeContent(`CHICKPEA_AUTH_SECRET=aaaaaaaa and ${awsExampleAccessKeyId('AKIA')}`),
    '[credential redacted] and [credential redacted]',
  );
});

test('PEM redaction removes each supported private-key body and closing armor', () => {
  for (const label of [
    'PRIVATE KEY',
    'RSA PRIVATE KEY',
    'EC PRIVATE KEY',
    'DSA PRIVATE KEY',
    'ED25519 PRIVATE KEY',
    'OPENSSH PRIVATE KEY',
    'ENCRYPTED PRIVATE KEY',
  ]) {
    const pem = syntheticPem(label, [
      'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEA',
      'c2VjcmV0LWJ5dGVzLXRoYXQtbXVzdC1ub3Qtc3Vydml2ZQ==',
    ]);
    const redacted = redactCredentialLikeContent(`before\n${pem}\nafter`);
    assert.equal(redacted, 'before\n[credential redacted]\nafter', label);
    assert.doesNotMatch(redacted, /MIIE|c2VjcmV0|END PRIVATE KEY|END RSA|END EC|END OPENSSH|END ENCRYPTED/);
  }
});

test('truncated algorithm-labeled private keys fail closed through end of input', () => {
  const truncated = [
    'before',
    pemBegin('DSA PRIVATE KEY'),
    'MIIBuwIBAAKBgQDsensitivebodywithoutclosingarmor',
  ].join('\n');
  const redacted = redactCredentialLikeContent(truncated);

  assert.equal(redacted, 'before\n[credential redacted]');
  assert.doesNotMatch(redacted, /DSA|MIIBuw|sensitivebody/);
});

test('traditional encrypted PEM metadata is redacted with its key body', () => {
  const pem = syntheticPem('RSA PRIVATE KEY', [
    'Proc-Type: 4,ENCRYPTED',
    'DEK-Info: AES-256-CBC,0123456789ABCDEF0123456789ABCDEF',
    '',
    'MIIEowIBAAKCAQEAsecretkeybodythatmustnotremain',
  ]);
  const redacted = redactCredentialLikeContent(`before\n${pem}\nafter`);

  assert.equal(redacted, 'before\n[credential redacted]\nafter');
  assert.doesNotMatch(redacted, /Proc-Type|DEK-Info|secretkeybody|END RSA PRIVATE KEY/);
});

test('PEM armor is redacted where these patterns find it', () => {
  // The armor grammar as two patterns: a label has no two hyphens in a row,
  // a BEGIN in the closing dashes of a BEGIN line before it is part of that
  // line, and one in the closing dashes of an END line takes them from its
  // block. Seeded text built from armor pieces (labels with hyphen runs,
  // lines sharing dashes, case and length edges, a Kelvin sign that is not
  // a K) must redact the same ranges.
  const armor = '-'.repeat(5);
  const label = String.raw`(?:[A-Z0-9](?:[A-Z0-9 ]|-(?!-)){0,62} )?PRIVATE KEY`;
  const begin = String.raw`(?<!${armor}BEGIN ${label}-{0,4})${armor}BEGIN `;
  const complete = new RegExp(
    String.raw`${begin}(${label})${armor}[\s\S]{0,262144}?${armor}END \1(?:-{0,4}(?=${armor}BEGIN ${label}${armor})|${armor})`,
    'gi',
  );
  const truncated = new RegExp(String.raw`${begin}${label}${armor}[\s\S]{0,262144}$`, 'gi');
  const found = (text: string, pattern: RegExp) =>
    [...text.matchAll(pattern)].map((match): [number, number] => [match.index, match.index + match[0].length]);
  const marker = '[credential redacted]';
  // Complete blocks, then a truncated block found after they are replaced.
  // It runs to the end, so it takes any complete block after its BEGIN line.
  const redactedRanges = (text: string) => {
    const blocks = found(text, complete);
    const [tail] = found(text.replace(complete, marker), truncated);
    if (!tail) return blocks;
    let [start] = tail;
    for (const [from, to] of blocks) {
      if (from >= start) break;
      start += to - from - marker.length;
    }
    return [...blocks.filter(([from]) => from < start), [start, text.length]];
  };
  const labels = [
    'PRIVATE KEY',
    'RSA PRIVATE KEY',
    'rsa Private key',
    'A PRIVATE KEY',
    'A PRIVATE KEY----- PRIVATE KEY',
    `${'X'.repeat(63)} PRIVATE KEY`,
    `${'X'.repeat(64)} PRIVATE KEY`,
    'EC  PRIVATE KEY',
    'X-Y PRIVATE KEY',
    'X- PRIVATE KEY',
    'X--Y PRIVATE KEY',
    'PRIVATE KEY',
  ];
  const pieces = [
    ...labels.map(pemBegin),
    ...labels.map(pemEnd),
    '\n',
    ' ',
    'Proc-Type: 4,ENCRYPTED',
    'MIIEvgIBADANBg',
    armor,
    '-',
    'BEGIN ',
    'END ',
    'PRIVATE KEY',
  ];
  // xorshift32, so every run builds the same texts.
  let seed = 7;
  const next = (bound: number) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % bound;
  };
  // The ceiling on either side, closed and truncated.
  const body = 'MIIEvgIBADANBgkqhkiG9w0B\n'.repeat(10_923).slice(0, 262_144);
  const texts = ['EC PRIVATE KEY', 'A PRIVATE KEY----- PRIVATE KEY'].flatMap((edge) =>
    [body, `${body}x`].flatMap((filler) =>
      [`${pemBegin(edge)}${filler}${pemEnd(edge)}`, `${pemBegin(edge)}${filler}`]));
  // Lines that share closing dashes, which random pieces rarely build: two
  // and three BEGIN lines in a row, and an END line before a BEGIN line.
  // Each `-----BEGIN ` starts in the dashes before it unless five extra
  // hyphens part them.
  const chained = ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY'];
  for (const first of chained) {
    for (const second of chained) {
      for (let extra = 0; extra <= 5; extra += 1) {
        const two = `${armor}BEGIN ${first}${'-'.repeat(extra)}${pemBegin(second)}`;
        const three = `${two.slice(0, -armor.length)}${'-'.repeat(extra)}${pemBegin(first)}`;
        for (const head of [two, three]) {
          texts.push(head, ...chained.map((label) => `${head}\nbody\n${pemEnd(label)} after`));
        }
        const shared = `${pemBegin(first)}\nbody\n${armor}END ${first}${'-'.repeat(extra)}${pemBegin(second)}\nkey`;
        texts.push(shared, `${shared}\n${pemEnd(second)} after`);
      }
    }
  }
  for (let count = 0; count < 3_000; count += 1) {
    let text = '';
    for (let size = 1 + next(24); size > 0; size -= 1) text += pieces[next(pieces.length)];
    texts.push(text);
  }

  for (const text of texts) {
    const expected = redactedRanges(text);
    const shown = JSON.stringify(text.slice(0, 200));
    assert.deepEqual(credentialMatchRanges(text), expected, shown);
    assert.equal(hasCredentialLikeContent(text), expected.length > 0, shown);
    assert.equal(
      redactCredentialLikeContent(text),
      text.replace(complete, marker).replace(truncated, marker),
      shown,
    );
  }
});

test('a PEM BEGIN line takes the closing dashes of an END line, never of a BEGIN line', () => {
  const armor = '-'.repeat(5);
  // A label with a hyphen run would hold the later BEGIN line, so the
  // stream showed text before it that the whole answer redacted.
  assert.equal(
    redactCredentialLikeContent(`${armor}BEGIN y ${pemBegin('PRIVATE KEY')}\nbody`),
    `${armor}BEGIN y [credential redacted]`,
  );
  // A BEGIN in the closing dashes of the BEGIN line before it belongs to
  // that line, so a later END line cannot take those dashes and unredact it.
  assert.equal(
    redactCredentialLikeContent(
      `${pemBegin('PRIVATE KEY')}BEGIN RSA PRIVATE KEY${armor}\nbody\n${pemEnd('RSA PRIVATE KEY')} after`,
    ),
    '[credential redacted]',
  );
  // One in the closing dashes of an END line takes them, so the key after it
  // is redacted with its own block, closed or not.
  const shared = `${syntheticPem('RSA PRIVATE KEY', ['body'])}BEGIN RSA PRIVATE KEY${armor}\nSECRET`;
  assert.equal(
    redactCredentialLikeContent(`${shared}\n${pemEnd('RSA PRIVATE KEY')} after`),
    '[credential redacted][credential redacted] after',
  );
  assert.equal(redactCredentialLikeContent(`${shared} tail`), '[credential redacted][credential redacted]');
});

test('a token glued to a PEM BEGIN line leaves the key redacted', () => {
  // Token classes take hyphens and letters, so a token matched first took
  // `-----BEGIN` with it and left the key after that line.
  assert.equal(
    redactCredentialLikeContent(`${SYNTHETIC_SLACK_TOKEN}${syntheticPem('RSA PRIVATE KEY', ['SECRET'])} after`),
    '[credential redacted][credential redacted] after',
  );
  assert.equal(
    redactCredentialLikeContent(`key bb_live_abcdefgh${pemBegin('RSA PRIVATE KEY')}\nSECRET tail`),
    'key [credential redacted][credential redacted]',
  );
});

test('a traced redaction maps each kept character back to where it came from', () => {
  const marker = '[credential redacted]';
  const texts = [
    'plain text',
    `a ${SYNTHETIC_SLACK_TOKEN} b @here c`,
    // Two matches of one signature shift what follows the second by both.
    `a ${SYNTHETIC_SLACK_TOKEN} b ${SYNTHETIC_SLACK_TOKEN} @here c`,
    // A later signature reads an earlier one's marker (`[credential`).
    `OPENAI_API_KEY=${SYNTHETIC_SLACK_TOKEN} after`,
    `x <!here ${syntheticPem('RSA PRIVATE KEY', ['body'])}> y ${pemBegin('EC PRIVATE KEY')}\ntail`,
    `\`CHICKPEA_AUTH_SECRET=\`abcdefgh @here\` ${awsExampleAccessKeyId('AKIA')} z`,
  ];
  for (const text of texts) {
    const { text: redacted, source } = traceCredentialRedaction(text);
    assert.equal(redacted, redactCredentialLikeContent(text));
    assert.equal(source(redacted.length), text.length, text);
    for (let at = 0; at < redacted.length; at += 1) {
      // Only the text supplies a character that no marker has.
      if (!marker.includes(redacted[at]!)) {
        assert.equal(text[source(at)], redacted[at], `${JSON.stringify(text)} @${at}`);
      }
    }
  }
});

test('credential ranges are where redaction rewrites the text', () => {
  // After a complete block, an unfinished one is redacted from its own BEGIN
  // line, not the first one in the text.
  const complete = `${pemBegin('PRIVATE KEY')}${pemEnd('PRIVATE KEY')}`;
  const truncated = `${pemBegin('RSA PRIVATE KEY')}\nbody`;
  assert.deepEqual(credentialMatchRanges(`${complete}${truncated}`), [
    [0, complete.length],
    [complete.length, complete.length + truncated.length],
  ]);
  // An unclosed BEGIN line before a complete block redacts through it.
  const text = `a ${pemBegin('EC PRIVATE KEY')}\n${syntheticPem('RSA PRIVATE KEY', ['body'])} b`;
  assert.deepEqual(credentialMatchRanges(text), [[2, text.length]]);
  // A signature that reads an earlier one's marker (`OPENAI_API_KEY=[credential`)
  // covers the text that marker replaced.
  const assignment = `OPENAI_API_KEY=${SYNTHETIC_SLACK_TOKEN}`;
  assert.deepEqual(credentialMatchRanges(`x ${assignment} after`), [[2, 2 + assignment.length]]);
  // One that ends where an earlier marker starts has read none of it.
  const block = `${pemBegin('PRIVATE KEY')}body${pemEnd('PRIVATE KEY')}`;
  assert.deepEqual(credentialMatchRanges(`${block}${SYNTHETIC_SLACK_TOKEN} z`), [
    [0, block.length],
    [block.length, block.length + SYNTHETIC_SLACK_TOKEN.length],
  ]);
});

test('PEM redaction stays linear in unclosed BEGIN lines', () => {
  // Every unclosed BEGIN line used to search up to 256 KiB for its END line,
  // and the streaming path redacts the whole answer on every chunk: one call
  // on 128,000 characters of them took about 670 ms, and streaming 48,000
  // took 35 s of CPU. Reading each END line once takes about 2 ms here, a
  // hundredth of the bound asserted.
  const lines = [
    () => pemBegin('RSA PRIVATE KEY'),
    (index: number) => `${pemBegin(`K${index} PRIVATE KEY`)}\n`,
  ];
  for (const line of lines) {
    let text = 'Intro\n';
    for (let index = 0; text.length < 128_000; index += 1) text += line(index);
    const start = process.cpuUsage();
    assert.equal(redactCredentialLikeContent(text), 'Intro\n[credential redacted]');
    assert.deepEqual(credentialMatchRanges(text), [[6, text.length]]);
    assert.equal(hasCredentialLikeContent(text), true);
    const { user, system } = process.cpuUsage(start);
    assert.ok(user + system < 200_000, `${Math.round((user + system) / 1_000)} ms of CPU`);
  }
});

test('the AWS access-key-id signature stays case-sensitive', () => {
  assert.equal(hasCredentialLikeContent('id akiaiosfodnn7example here'), false);
  assert.equal(
    redactCredentialLikeContent('id akiaiosfodnn7example here'),
    'id akiaiosfodnn7example here',
  );
  assert.equal(hasCredentialLikeContent(`id ${awsExampleAccessKeyId('ASIA')} here`), true);
});

test('streaming withholds a partial credential marker tail until it resolves', () => {
  assert.equal(streamableSlackMarkdownPrefix('secrets ahead AWS_ACC'), 'secrets ahead');
  assert.equal(streamableSlackMarkdownPrefix('secrets ahead sk-a'), 'secrets ahead');
  assert.equal(streamableSlackMarkdownPrefix('secrets ahead xap'), 'secrets ahead');
  assert.equal(streamableSlackMarkdownPrefix('secrets ahead ghs'), 'secrets ahead');
  assert.equal(
    streamableSlackMarkdownPrefix('secrets ahead COMPOSIO_WEBHOOK_SEC'),
    'secrets ahead',
  );
  assert.equal(
    streamableSlackMarkdownPrefix(`token ${SYNTHETIC_SLACK_TOKEN} rest`),
    'token',
  );
  assert.equal(
    streamableSlackMarkdownPrefix(`token ${SYNTHETIC_SLACK_APP_TOKEN} rest`),
    'token',
  );
  assert.equal(
    streamableSlackMarkdownPrefix(`token ${SYNTHETIC_GITHUB_INSTALLATION_TOKEN} rest`),
    'token',
  );
  assert.equal(streamableSlackMarkdownPrefix('nothing secret here'), 'nothing secret here');
});
