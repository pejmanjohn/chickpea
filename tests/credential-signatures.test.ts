import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  credentialMarkers,
  hasCredentialLikeContent,
  redactCredentialLikeContent,
} from '../src/security/content-validation.ts';
import { streamableSlackMarkdownPrefix } from '../src/slack/message-format.ts';
import { awsExampleAccessKeyId, pemBegin, syntheticPem } from './helpers/credential-fixtures.ts';

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
  { input: pemBegin('RSA PRIVATE KEY'), redacted: '[credential redacted]' },
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
    input: 'AWS_ACCESS_KEY_ID="abcdefgh12345"',
    redacted: '[credential redacted]"',
  },
];

test('credential markers stay the exact projection the streaming path relies on', () => {
  assert.deepEqual([...credentialMarkers()], [
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
    '-----BEGIN ',
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
