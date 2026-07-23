import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import slackThreadAgent from '../src/agents/slack-thread.ts';
import type { EffectiveSlackConfig } from '../src/config/effective-config.ts';
import { GITHUB_SETTING_KEYS } from '../src/config/github-app.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import {
  getOrCreateSnapshot,
  snapshotFromEffectiveConfig,
  SqliteAgentSnapshotStore,
} from '../src/config/snapshot-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { ChannelAssignment, CustomAgentConfig } from '../src/config/types.ts';
import { THREAD_TTL_MS } from '../src/slack/claim-store.ts';
import { withEnv } from './helpers/env.ts';

const AGENT_ID = 'agent_snapshot_unit';
const THREAD_KEY = 'T_SNAPSHOT:C_SNAPSHOT:1782771900.000100';
const NEW_THREAD_KEY = 'T_SNAPSHOT:C_SNAPSHOT:1782771901.000100';
const ALPHA = 'SNAPSHOT_UNIT_ALPHA: original profile instructions.';
const BETA = 'SNAPSHOT_UNIT_BETA: edited profile instructions.';

function agent(overrides: Partial<CustomAgentConfig> = {}): CustomAgentConfig {
  return {
    id: AGENT_ID,
    name: 'Snapshot Unit Profile',
    instructions: ALPHA,
    enabled: true,
    model: 'local-stub/snapshot-unit',
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
    ...overrides,
  };
}

function assignment(overrides: Partial<ChannelAssignment> = {}): ChannelAssignment {
  return {
    workspaceId: 'T_SNAPSHOT',
    channelId: 'C_SNAPSHOT',
    agentId: AGENT_ID,
    enabled: true,
    ...overrides,
  };
}

function effConfig(channelId: string, instructions: string = ALPHA): EffectiveSlackConfig {
  return {
    workspaceId: 'T_SNAPSHOT',
    channelId,
    agentId: AGENT_ID,
    agent: agent(),
    model: 'local-stub/snapshot-unit',
    provider: 'local-stub',
    instructions,
    instructionLayers: [],
  };
}

test('agent snapshots are purged past the thread TTL, bounding the table', async () => {
  let now = 1_000_000;
  const store = new SqliteAgentSnapshotStore(':memory:', () => now);
  try {
    await getOrCreateSnapshot(store, 'T_SNAPSHOT:C_OLD:1', () => effConfig('C_OLD'), () => now);
    assert.ok(await store.get('T_SNAPSHOT:C_OLD:1'));

    // Advance past the TTL, then write another snapshot (which triggers a purge).
    now += THREAD_TTL_MS + 1;
    await getOrCreateSnapshot(store, 'T_SNAPSHOT:C_NEW:1', () => effConfig('C_NEW'), () => now);

    assert.equal(
      await store.get('T_SNAPSHOT:C_OLD:1'),
      undefined,
      'the expired snapshot must be purged',
    );
    assert.ok(await store.get('T_SNAPSHOT:C_NEW:1'), 'the fresh snapshot must remain');
  } finally {
    store.close();
  }
});

test('putIfAbsent is write-once: a losing writer gets the PERSISTED row back', async () => {
  // Two stores on the same file DB model concurrent callers with independent
  // SQLite connections.
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-snapshot-race-'));
  const dbPath = join(dir, 'state.db');
  // Pin the store clock: putIfAbsent TTL-purges rows older than now - TTL, and
  // the fixture createdAt values must stay inside that window.
  const now = () => 10_000;
  const winner = new SqliteAgentSnapshotStore(dbPath, now);
  const loser = new SqliteAgentSnapshotStore(dbPath, now);
  try {
    const first = snapshotFromEffectiveConfig(effConfig('C_RACE', ALPHA), 1_000);
    const second = snapshotFromEffectiveConfig(effConfig('C_RACE', BETA), 2_000);

    const persisted = await winner.putIfAbsent('T_SNAPSHOT:C_RACE:1', first);
    assert.equal(persisted.instructions, ALPHA);

    // The losing writer's build is discarded; it must act on the stored row.
    const observed = await loser.putIfAbsent('T_SNAPSHOT:C_RACE:1', second);
    assert.equal(observed.instructions, ALPHA);
    assert.equal(observed.createdAt, 1_000);

    // getOrCreateSnapshot serves the frozen row without re-resolving.
    const served = await getOrCreateSnapshot(loser, 'T_SNAPSHOT:C_RACE:1', () => {
      throw new Error('must not re-resolve a frozen thread');
    });
    assert.equal(served.instructions, ALPHA);
  } finally {
    winner.close();
    loser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent snapshots freeze repository grants with the effective profile', () => {
  const repositories = [
    {
      id: 'repo-snapshot',
      installationId: 42,
      accountLogin: 'magoosh',
      fullName: 'magoosh/chickpea',
      enabled: true,
    },
  ];
  const config = effConfig('C_REPOSITORIES');
  config.agent = agent({ repositories });

  const snapshot = snapshotFromEffectiveConfig(config, 1_000);

  assert.deepEqual(snapshot.repositories, repositories);
});

test('slack-thread uses frozen repository grants with a live token that stays out of model-visible surfaces', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-repository-snapshot-'));
  const dbPath = join(dir, 'state.db');
  const threadKey = 'T_SNAPSHOT:C_SNAPSHOT:1782771902.000100';
  const tokenSentinel = 'LIVE-INSTALLATION-TOKEN-MUST-STAY-AT-EGRESS';
  const frozenGrant = {
    id: 'repo-frozen',
    installationId: 420_042,
    accountLogin: 'Acme',
    fullName: 'Acme/Frozen',
    enabled: true,
  };

  try {
    const seed = new SqliteConfigStore(dbPath, { agents: [], assignments: [] });
    await seed.createAgent(agent({ repositories: [frozenGrant] }));
    await seed.putAssignment(assignment());
    seed.close();

    await withEnv(
      {
        SLACK_STATE_DB_PATH: dbPath,
        SLACK_TAG_MODEL: undefined,
        ANTHROPIC_API_KEY: undefined,
        CLOUDFLARE_API_TOKEN: undefined,
        CLOUDFLARE_ACCOUNT_ID: undefined,
        GITHUB_APP_ID: undefined,
        GITHUB_APP_PRIVATE_KEY: undefined,
        GITHUB_PAT: undefined,
      },
      async () => {
        // Freeze the channel thread before GitHub credentials exist.
        await slackThreadAgent.initialize({ id: threadKey, env: {} });

        const editor = new SqliteConfigStore(dbPath, { agents: [], assignments: [] });
        await editor.updateAgent(AGENT_ID, {
          repositories: [
            {
              ...frozenGrant,
              id: 'repo-edited',
              fullName: 'Acme/EditedAfterSnapshot',
            },
          ],
        });
        editor.close();

        const privateKey = String(
          generateKeyPairSync('rsa', { modulusLength: 2_048 }).privateKey.export({
            type: 'pkcs8',
            format: 'pem',
          }),
        );
        const settings = new SqliteSettingsStore(dbPath);
        await settings.setSetting(GITHUB_SETTING_KEYS.appId, 'snapshot-live-app');
        await settings.setSetting(GITHUB_SETTING_KEYS.privateKey, privateKey);
        settings.close();

        const previousFetch = globalThis.fetch;
        let tokenRequestBody: Record<string, unknown> | undefined;
        globalThis.fetch = async (input, init) => {
          assert.match(String(input), /\/app\/installations\/420042\/access_tokens$/);
          tokenRequestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json({
            token: tokenSentinel,
            expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
          });
        };
        try {
          const initialized = await slackThreadAgent.initialize({ id: threadKey, env: {} });
          assert.deepEqual(tokenRequestBody?.repositories, ['Frozen']);
          assert.equal(initialized.skills?.some((skill) => skill.name === 'repositories'), true);
          assert.equal(initialized.skills?.some((skill) => skill.name === 'github-api'), false);
          assert.doesNotMatch(String(initialized.instructions), new RegExp(tokenSentinel));
          assert.doesNotMatch(JSON.stringify(initialized.skills), new RegExp(tokenSentinel));
          assert.doesNotMatch(JSON.stringify(initialized), new RegExp(tokenSentinel));

          const snapshots = new SqliteAgentSnapshotStore(dbPath);
          const snapshot = await snapshots.get(threadKey);
          snapshots.close();
          assert.deepEqual(snapshot?.repositories, [frozenGrant]);
          assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(tokenSentinel));
        } finally {
          globalThis.fetch = previousFetch;
        }
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('slack-thread freezes effective config per durable thread id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-thread-snapshot-'));
  const dbPath = join(dir, 'state.db');

  try {
    const seed = new SqliteConfigStore(dbPath, { agents: [], assignments: [] });
    await seed.createAgent(agent());
    await seed.putAssignment(assignment());
    seed.close();

    await withEnv(
      {
        SLACK_STATE_DB_PATH: dbPath,
        SLACK_TAG_MODEL: undefined,
        ANTHROPIC_API_KEY: undefined,
        CLOUDFLARE_API_TOKEN: undefined,
        CLOUDFLARE_ACCOUNT_ID: undefined,
      },
      async () => {
        const first = await slackThreadAgent.initialize({ id: THREAD_KEY, env: {} });
        assert.match(String(first.instructions), /SNAPSHOT_UNIT_ALPHA/);

        const editor = new SqliteConfigStore(dbPath, { agents: [], assignments: [] });
        await editor.updateAgent(AGENT_ID, { instructions: BETA });
        editor.close();

        const sameThread = await slackThreadAgent.initialize({ id: THREAD_KEY, env: {} });
        assert.match(String(sameThread.instructions), /SNAPSHOT_UNIT_ALPHA/);
        assert.doesNotMatch(String(sameThread.instructions), /SNAPSHOT_UNIT_BETA/);

        const newThread = await slackThreadAgent.initialize({ id: NEW_THREAD_KEY, env: {} });
        assert.match(String(newThread.instructions), /SNAPSHOT_UNIT_BETA/);

        const disabler = new SqliteConfigStore(dbPath, { agents: [], assignments: [] });
        await disabler.updateAgent(AGENT_ID, { enabled: false });
        disabler.close();

        const disabledSameThread = await slackThreadAgent.initialize({ id: THREAD_KEY, env: {} });
        assert.match(String(disabledSameThread.instructions), /SNAPSHOT_UNIT_ALPHA/);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
