import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  credentialMarkers,
  hasCredentialLikeContent,
  redactCredentialLikeContent,
} from '../src/security/content-validation.ts';
import { streamableSlackMarkdownPrefix } from '../src/slack/message-format.ts';

// Assemble the token-shaped fixture at runtime so repository push protection
// never has to distinguish synthetic test data from a real Slack credential.
const SYNTHETIC_SLACK_TOKEN = ['xox', 'b'].join('') + '-' +
  ['1234567890', 'abcdefghijklmnop'].join('-');

// One sample per credential signature, in table order.
const SAMPLES: readonly { input: string; redacted: string }[] = [
  {
    input: `token ${SYNTHETIC_SLACK_TOKEN} rest`,
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
    input: 'pat ghp_abcdefghijklmnopqrstuvwxyz012 here',
    redacted: 'pat [credential redacted] here',
  },
  { input: 'id AKIAIOSFODNN7EXAMPLE here', redacted: 'id [credential redacted] here' },
  { input: '-----BEGIN RSA PRIVATE KEY-----', redacted: '[credential redacted]' },
  {
    input: 'CHICKPEA_AUTH_SECRET=supersecretvalue',
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
    'sk-ant-',
    'sk-proj-',
    'ghp_',
    'github_pat_',
    'AKIA',
    'ASIA',
    '-----BEGIN ',
    'CHICKPEA_AUTH_SECRET',
    'CHICKPEA_RECOVERY_TOKEN',
    'TAG_ADMIN_TOKEN',
    'ADMIN_TOKEN',
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GITHUB_TOKEN',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
  ]);
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
    redactCredentialLikeContent('CHICKPEA_AUTH_SECRET=aaaaaaaa and AKIAIOSFODNN7EXAMPLE'),
    '[credential redacted] and [credential redacted]',
  );
});

test('the AWS access-key-id signature stays case-sensitive', () => {
  assert.equal(hasCredentialLikeContent('id akiaiosfodnn7example here'), false);
  assert.equal(
    redactCredentialLikeContent('id akiaiosfodnn7example here'),
    'id akiaiosfodnn7example here',
  );
  assert.equal(hasCredentialLikeContent('id ASIAIOSFODNN7EXAMPLE here'), true);
});

test('streaming withholds a partial credential marker tail until it resolves', () => {
  assert.equal(streamableSlackMarkdownPrefix('secrets ahead AWS_ACC'), 'secrets ahead');
  assert.equal(streamableSlackMarkdownPrefix('secrets ahead sk-a'), 'secrets ahead');
  assert.equal(
    streamableSlackMarkdownPrefix(`token ${SYNTHETIC_SLACK_TOKEN} rest`),
    'token',
  );
  assert.equal(streamableSlackMarkdownPrefix('nothing secret here'), 'nothing secret here');
});
