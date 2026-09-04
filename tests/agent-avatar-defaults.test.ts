import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createHash } from 'node:crypto';

import {
  DEFAULT_AGENT_AVATAR_FILES,
  defaultAgentAvatarIndex,
  defaultAgentAvatarPng,
  nextDefaultAgentAvatarSeed,
  isDefaultAgentAvatarSeed,
} from '../src/slack/agent-presence/default-avatar-pool.ts';
import {
  agentAvatarUrlForPresentation,
  generatedAgentAvatarPng,
  readAgentAvatarAsset,
} from '../src/slack/agent-presence/avatar-assets.ts';
import { ConfigStoreLogic } from '../src/config/store.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { createDemoStarterAgent } from '../src/config/seed.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

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

test('all automatic rendering, including unversioned seeds, uses a committed gallery image', async () => {
  const hashes = new Set(DEFAULT_AGENT_AVATAR_FILES.map((file) => digest(readFileSync(`${AVATAR_ROOT}/${file}`))));
  for (const seed of ['legacy-agent-seed', 'agent_default', '', 'chickpea-avatar-v1:99:invalid']) {
    assert.ok(hashes.has(digest(await generatedAgentAvatarPng(seed))), seed);
  }
});

test('direct creation and seed fixtures persist approved defaults before the first read', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new ConfigStoreLogic(db, { agents: [createDemoStarterAgent()] });
    const indexes = new Set<number>();
    indexes.add(defaultAgentAvatarIndex(store.getAgent('agent_default').slackPresence!.avatar.seed!));
    for (let index = 1; index < 12; index += 1) {
      const agent = store.createAgent({ ...createDemoStarterAgent(), id: `agent_${index}` });
      assert.equal(agent.slackPresence?.avatar.revision, 1);
      assert.ok(isDefaultAgentAvatarSeed(agent.slackPresence!.avatar.seed!));
      indexes.add(defaultAgentAvatarIndex(agent.slackPresence!.avatar.seed!));
    }
    assert.equal(indexes.size, 12);
  } finally { db.close(); }
});

test('upgrade replaces legacy defaults once while preserving historical URLs and custom uploads', async () => {
  const db = openStateDb(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const original = new ConfigStoreLogic(db, { agents: [createDemoStarterAgent()] });
    const before = original.getAgent('agent_default');
    const legacyPresence = {
      ...before.slackPresence!,
      avatar: { kind: 'generated', revision: 1, seed: 'agent_default', url: 'https://gateway.test/avatars/agent_default/rev_1.png' },
    };
    // Simulate a persisted pre-upgrade row, without using the fixed create path.
    db.run('UPDATE config_agents SET slack_presence_json = ? WHERE id = ?', JSON.stringify(legacyPresence), before.id);
    const uploaded = original.createAgent({
      ...createDemoStarterAgent(), id: 'custom_upload',
      slackPresence: { ...before.slackPresence!, avatar: { kind: 'uploaded', revision: 3, url: 'https://images.test/custom.png' } },
    });
    const approved = original.createAgent({ ...createDemoStarterAgent(), id: 'already_approved' });
    const migratedStore = new ConfigStoreLogic(db, { agents: [] });
    const migrated = migratedStore.getAgent(before.id);
    const avatar = migrated.slackPresence!.avatar;
    assert.equal(migrated.revision, before.revision + 1);
    assert.equal(migrated.configurationGeneration, before.configurationGeneration);
    assert.equal(avatar.revision, 2);
    assert.ok(isDefaultAgentAvatarSeed(avatar.seed!));
    assert.equal(avatar.url, undefined);
    assert.equal(agentAvatarUrlForPresentation(migrated, 'https://worker.test'), 'https://worker.test/assets/agents/agent_default/avatar/2');
    assert.deepEqual(migratedStore.getAgent(uploaded.id), uploaded);
    assert.deepEqual(migratedStore.getAgent(approved.id), approved);
    const current = await readAgentAvatarAsset({ settings, agentId: before.id, revision: 2, avatar });
    assert.deepEqual(current?.bytes, await defaultAgentAvatarPng(avatar.seed!));
    const historical = await readAgentAvatarAsset({ settings, agentId: before.id, revision: 1, avatar });
    // Captured from the original renderer before this change, not computed by it.
    assert.equal(digest(historical!.bytes), '7b3502a870bc1d0d79c8bf35230239f1d503f1510c48cccb9c5f3b41a52088d9');
    assert.equal(await readAgentAvatarAsset({ settings, agentId: before.id, revision: 3, avatar }), undefined);
    assert.deepEqual(new ConfigStoreLogic(db, { agents: [] }).getAgent(before.id), migrated);

    const customReplacement = migratedStore.updateAgent(before.id, {
      slackPresence: { ...migrated.slackPresence!, avatar: { kind: 'uploaded', revision: 3, url: 'https://images.test/replacement.png' } },
    });
    for (const revision of [1, 2]) {
      const bytes = await readAgentAvatarAsset({ settings, agentId: before.id, revision, avatar: customReplacement.slackPresence!.avatar });
      assert.deepEqual(bytes?.bytes, revision === 1 ? historical?.bytes : current?.bytes);
    }
  } finally { db.close(); settings.close?.(); }
});

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
