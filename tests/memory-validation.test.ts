import assert from 'node:assert/strict';
import { test } from 'node:test';

import { slugifyMemoryName } from '../src/memory/slug.ts';
import { validateMemoryContent } from '../src/memory/validation.ts';
import {
  AWS_EXAMPLE_SECRET_ACCESS_KEY,
  awsExampleAccessKeyId,
  pemBegin,
} from './helpers/credential-fixtures.ts';

test('slug normalization is portable, bounded, and has a stable empty fallback', () => {
  assert.equal(slugifyMemoryName('  Café Release — Checklist!  ', '01ABCDEF'), 'cafe-release-checklist');
  assert.equal(slugifyMemoryName('東京', '01ABCDEF'), 'memory-01abcdef');
  assert.equal(slugifyMemoryName('a'.repeat(100), '01ABCDEF').length, 64);
});

test('memory validation uses UTF-8 byte bounds and rejects control characters', () => {
  assert.throws(
    () => validateMemoryContent({ description: 'ok', body: '😀'.repeat(2_049), type: 'fact' }),
    /8192 bytes/,
  );
  assert.throws(
    () => validateMemoryContent({ description: 'ok', body: 'unsafe\u0000body', type: 'fact' }),
    /control characters/,
  );
});

test('memory rejects known credentials while allowing ordinary near-miss prose', () => {
  for (const secret of [
    'xoxb-' + '123456789012-123456789012-abcdefghijklmnopqrstuvwxyz',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890',
    'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    awsExampleAccessKeyId('AKIA'),
    awsExampleAccessKeyId('ASIA'),
    pemBegin('PRIVATE KEY'),
    'TAG_ADMIN_TOKEN=super-secret-value',
    'CHICKPEA_AUTH_SECRET=consumer-install-secret-value',
    'COMPOSIO_API_KEY=managed-connector-project-key',
    'COMPOSIO_WEBHOOK_SECRET=managed-connector-webhook-secret',
    `AWS_SECRET_ACCESS_KEY=${AWS_EXAMPLE_SECRET_ACCESS_KEY}`,
    `aws_secret_access_key = ${AWS_EXAMPLE_SECRET_ACCESS_KEY}`,
    `"AWS_SECRET_ACCESS_KEY": "${AWS_EXAMPLE_SECRET_ACCESS_KEY}"`,
  ]) {
    assert.throws(
      () => validateMemoryContent({ description: 'credential', body: secret, type: 'fact' }),
      /credential-like content/,
    );
  }
  assert.doesNotThrow(() =>
    validateMemoryContent({
      description: 'Authentication note',
      body: 'The Slack token was rotated; ask an operator if access fails.',
      type: 'fact',
    }),
  );
});
