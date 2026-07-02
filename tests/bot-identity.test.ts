import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { defaultBotIdentity, IdentityStore } from '../src/config/identity.ts';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const MANIFEST_PATH = join(REPO_ROOT, 'slack-app-manifest.json');

test('IdentityStore returns the seeded install-wide avatar path', () => {
  const identity = new IdentityStore().get();

  assert.deepEqual(identity, defaultBotIdentity);
  assert.deepEqual(Object.keys(identity), ['avatarPath']);
  assert.equal(identity.avatarPath, 'assets/bot-avatar.png');
});

test('Slack manifest owns a non-empty bot display name', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
    display_information?: { name?: unknown; description?: unknown };
    features?: { bot_user?: { display_name?: unknown } };
  };
  const displayName = manifest.display_information?.name;
  const description = manifest.display_information?.description;

  assert.ok(typeof displayName === 'string');
  assert.notEqual(displayName.trim(), '');
  assert.equal(
    manifest.features?.bot_user?.display_name,
    displayName,
    'bot user display name should match the app display name',
  );
  assert.ok(typeof description === 'string');
  assert.notEqual(description.trim(), '');
});

test('default avatar path resolves to a square PNG at least 512px wide', () => {
  const avatarPath = join(REPO_ROOT, defaultBotIdentity.avatarPath);
  assert.ok(existsSync(avatarPath), `expected ${defaultBotIdentity.avatarPath} to exist`);

  const bytes = readFileSync(avatarPath);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR');

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert.equal(width, height);
  assert.ok(width >= 512, `expected avatar to be at least 512px square, got ${width}x${height}`);
});
