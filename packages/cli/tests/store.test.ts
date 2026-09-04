import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { describeError, redactSensitive, CliError } from '../src/errors.ts';
import { normalizeDeploymentOrigin } from '../src/origin.ts';
import { resolveConfigDir, tokensExpired, withExpiry } from '../src/store.ts';
import { temporaryStore } from './helpers/run-cli.ts';

test('config dir honours XDG_CONFIG_HOME and falls back to ~/.config/chickpea', () => {
  assert.equal(resolveConfigDir({ XDG_CONFIG_HOME: '/xdg' }, '/home/u'), path.join('/xdg', 'chickpea'));
  assert.equal(resolveConfigDir({}, '/home/u'), path.join('/home/u', '.config', 'chickpea'));
  assert.equal(resolveConfigDir({ XDG_CONFIG_HOME: 'relative' }, '/home/u'), path.join('/home/u', '.config', 'chickpea'));
});

test('credential file is written 0600 inside a 0700 directory, keyed by origin, and deletable', () => {
  const store = temporaryStore();
  assert.equal(existsSync(store.path), false);
  store.write({
    origin: 'https://one.example',
    client: { client_id: 'client_1' },
    tokens: { access_token: 'a', token_type: 'Bearer', refresh_token: 'r', expires_at: 10 },
    updatedAt: '',
  });
  store.write({ origin: 'https://two.example', updatedAt: '' });
  assert.equal(statSync(store.path).mode & 0o777, 0o600);
  assert.equal(statSync(store.directory).mode & 0o777, 0o700);
  const parsed = JSON.parse(readFileSync(store.path, 'utf8')) as { version: number; deployments: Record<string, unknown> };
  assert.equal(parsed.version, 1);
  assert.deepEqual(Object.keys(parsed.deployments).sort(), ['https://one.example', 'https://two.example']);
  assert.equal(store.read('https://one.example')?.tokens?.refresh_token, 'r');
  assert.equal(store.delete('https://one.example'), true);
  assert.equal(store.delete('https://one.example'), false);
  assert.equal(store.read('https://one.example'), undefined);
  assert.equal(store.list().length, 1);

  writeFileSync(store.path, '{not json', { mode: 0o600 });
  assert.throws(() => store.read('https://two.example'), (error: unknown) => error instanceof CliError && error.code === 'STORE_CORRUPT');
});

test('expiry is derived from expires_in and checked with skew', () => {
  const tokens = withExpiry({ access_token: 'a', token_type: 'Bearer', expires_in: 1200 }, 1_000_000);
  assert.equal(tokens.expires_at, 1_000_000 + 1_200_000);
  assert.equal(tokensExpired(tokens, 1_000_000), false);
  assert.equal(tokensExpired(tokens, 1_000_000 + 1_200_000 - 29_000), true);
  assert.equal(tokensExpired(undefined, 0), true);
  assert.equal(tokensExpired({ access_token: 'a', token_type: 'Bearer' }, 0), false);
});

test('deployment origins are normalized like the server resource rules', () => {
  assert.equal(normalizeDeploymentOrigin('https://chickpea.example/'), 'https://chickpea.example');
  assert.equal(normalizeDeploymentOrigin('chickpea.example'), 'https://chickpea.example');
  assert.equal(normalizeDeploymentOrigin('https://chickpea.example/mcp'), 'https://chickpea.example');
  assert.equal(normalizeDeploymentOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(normalizeDeploymentOrigin('http://localhost:8787/'), 'http://localhost:8787');
  for (const bad of ['http://chickpea.example', 'https://u:p@chickpea.example', 'https://chickpea.example/admin', 'https://chickpea.example/?x=1', 'not a url']) {
    assert.throws(() => normalizeDeploymentOrigin(bad), (error: unknown) => error instanceof CliError && error.code === 'INVALID_URL', bad);
  }
});

test('error text never carries codes, tokens, or setup capabilities', () => {
  const noisy = 'failed for http://127.0.0.1:1/callback?code=abc123&state=zzz with Bearer eyJhbGciOiJFZERTQSJ9.payload and https://x/admin/setup#setup=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and xoxb-1-2-3';
  const clean = redactSensitive(noisy);
  assert.doesNotMatch(clean, /abc123|zzz|eyJhbGci|AAAAAAAA|xoxb-1/);
  const record = describeError(new Error(noisy));
  assert.equal(record.code, 'UNEXPECTED');
  assert.doesNotMatch(record.message, /abc123|eyJhbGci|xoxb/);
  const unauthorized = Object.assign(new Error('Authentication failed'), { name: 'UnauthorizedError' });
  assert.equal(describeError(unauthorized).code, 'SESSION_EXPIRED');
});
