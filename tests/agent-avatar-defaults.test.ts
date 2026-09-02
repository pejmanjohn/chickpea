import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  DEFAULT_AGENT_AVATAR_FILES,
  defaultAgentAvatarIndex,
  defaultAgentAvatarPng,
  nextDefaultAgentAvatarSeed,
} from '../src/slack/agent-presence/default-avatar-pool.ts';
import { generatedAgentAvatarPng } from '../src/slack/agent-presence/avatar-assets.ts';

const AVATAR_ROOT = fileURLToPath(
  new URL('../assets/chickpea-avatars/agent-defaults/', import.meta.url),
);

test('a shuffled cycle assigns every default avatar before repeating one', () => {
  const seeds: string[] = [];
  const indexes = new Set<number>();

  for (let index = 0; index < DEFAULT_AGENT_AVATAR_FILES.length; index += 1) {
    const seed = nextDefaultAgentAvatarSeed(seeds, `nonce-${index}`);
    seeds.push(seed);
    indexes.add(defaultAgentAvatarIndex(seed));
  }

  assert.equal(DEFAULT_AGENT_AVATAR_FILES.length, 12);
  assert.equal(indexes.size, 12);
  assert.match(nextDefaultAgentAvatarSeed(seeds, 'nonce-repeat'),
    /^chickpea-avatar-v1:\d{2}:nonce-repeat$/);
});

test('the runtime pool is byte-identical to the twelve committed PNG assets', async () => {
  for (let index = 0; index < DEFAULT_AGENT_AVATAR_FILES.length; index += 1) {
    const seed = `chickpea-avatar-v1:${String(index + 1).padStart(2, '0')}:asset-check`;
    const expected = readFileSync(`${AVATAR_ROOT}/${DEFAULT_AGENT_AVATAR_FILES[index]}`);
    assert.deepEqual(Buffer.from(await defaultAgentAvatarPng(seed)), expected);
  }
});

test('legacy generated seeds retain a stable pool assignment', () => {
  assert.equal(defaultAgentAvatarIndex('legacy-agent-seed'),
    defaultAgentAvatarIndex('legacy-agent-seed'));
  assert.notEqual(defaultAgentAvatarIndex('legacy-agent-seed'),
    defaultAgentAvatarIndex('another-legacy-seed'));
});

test('legacy seeds preserve the original immutable 128px renderer', async () => {
  const bytes = await generatedAgentAvatarPng('legacy-agent-seed');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(16), 128);
  assert.equal(view.getUint32(20), 128);
});
