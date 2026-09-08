import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { CfSettingsStore } from '../src/config/cf-state-proxies.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { SettingsPatch, SettingsStore } from '../src/config/settings-store.ts';
import type { TagStateRpc } from '../src/config/state-rpc.ts';
import {
  acceptModelCatalogCandidate,
  acquireModelCatalogRefreshLease,
  readModelCatalogLkg,
  releaseModelCatalogRefreshLease,
} from '../src/model-catalog/store.ts';

function candidate(revision: number, suffix = '') {
  const bytes = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    revision,
    generatedAt: '2026-07-29T20:00:00Z',
    entries: [{
      canonical: `openai/gpt-concurrent-${revision}${suffix}`,
      lanes: { apiKey: 'openai-platform-responses-terra-tier@1' },
    }],
  }));
  return {
    bytes,
    checkedAt: revision * 1_000,
    nextRefreshAt: revision * 1_000 + 10_000,
  };
}

function proxySettings(backing: SettingsStore): CfSettingsStore {
  const stub = {
    settingGet: async (key: string) => ({
      ok: true as const,
      value: (await backing.getSetting(key)) ?? null,
    }),
    settingGetMany: async (keys: readonly string[]) => ({
      ok: true as const,
      value: (await backing.getSettings(keys)).map((value) => value ?? null),
    }),
    settingSet: async (key: string, value: string) => {
      await backing.setSetting(key, value);
      return { ok: true as const, value: null };
    },
    settingDelete: async (key: string) => {
      await backing.deleteSetting(key);
      return { ok: true as const, value: null };
    },
    settingApplyPatch: async (patch: SettingsPatch) => ({
      ok: true as const,
      value: await backing.applySettingsPatch(patch),
    }),
    settingMergeStringSet: async (key: string, values: readonly string[]) => ({
      ok: true as const,
      value: await backing.mergeSettingStringSet(key, values),
    }),
  } as unknown as TagStateRpc;
  return new CfSettingsStore(stub);
}

test('concurrent candidate acceptance converges on the highest revision', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());

  const results = await Promise.all([
    acceptModelCatalogCandidate(settings, candidate(7)),
    acceptModelCatalogCandidate(settings, candidate(9)),
    acceptModelCatalogCandidate(settings, candidate(8)),
  ]);

  const lkg = await readModelCatalogLkg(settings);
  assert.equal(lkg?.document.revision, 9);
  assert.equal(lkg?.sha256, createHash('sha256').update(candidate(9).bytes).digest('hex'));
  assert.equal(results.some((result) => result.status === 'accepted'), true);
});

test('equal bytes are idempotent, equal revision different bytes is equivocation, and lower is ignored', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const current = candidate(10);
  assert.equal((await acceptModelCatalogCandidate(settings, current)).status, 'accepted');
  assert.equal((await acceptModelCatalogCandidate(settings, current)).status, 'unchanged');
  assert.equal(
    (await acceptModelCatalogCandidate(settings, candidate(10, '-other'))).status,
    'equivocation',
  );
  assert.equal((await acceptModelCatalogCandidate(settings, candidate(9))).status, 'stale');
  assert.equal((await readModelCatalogLkg(settings))?.document.revision, 10);
});

test('refresh leases use exact raw CAS and only their owner may release them', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const first = await acquireModelCatalogRefreshLease(settings, 'owner-a', 1_000);
  assert.equal(first.acquired, true);
  assert.equal((await acquireModelCatalogRefreshLease(settings, 'owner-b', 1_001)).acquired, false);
  assert.equal(await releaseModelCatalogRefreshLease(settings, 'owner-b'), false);
  assert.equal(await releaseModelCatalogRefreshLease(settings, 'owner-a'), true);
  assert.equal((await acquireModelCatalogRefreshLease(settings, 'owner-b', 1_002)).acquired, true);
});

test('catalog CAS and lease behavior is identical through the Cloudflare settings proxy', async (t) => {
  const backing = new SqliteSettingsStore(':memory:');
  t.after(() => backing.close());
  const firstProxy = proxySettings(backing);

  await Promise.all([
    acceptModelCatalogCandidate(firstProxy, candidate(22)),
    acceptModelCatalogCandidate(firstProxy, candidate(24)),
    acceptModelCatalogCandidate(firstProxy, candidate(23)),
  ]);
  assert.equal((await readModelCatalogLkg(proxySettings(backing)))?.document.revision, 24);

  assert.equal(
    (await acquireModelCatalogRefreshLease(firstProxy, 'worker-a', 10_000)).acquired,
    true,
  );
  assert.equal(
    (await acquireModelCatalogRefreshLease(proxySettings(backing), 'worker-b', 10_001)).acquired,
    false,
  );
  assert.equal(await releaseModelCatalogRefreshLease(proxySettings(backing), 'worker-b'), false);
  assert.equal(await releaseModelCatalogRefreshLease(proxySettings(backing), 'worker-a'), true);
});
