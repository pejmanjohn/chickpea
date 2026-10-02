import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { InstallationContextError, scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { ModelResolutionError } from '../src/config/errors.ts';
import { resolveAgentModelPolicy } from '../src/config/model-policy.ts';
import {
  freezeRuntimeModelRoute,
  resolveRuntimeModel,
  safeRuntimeModelRouteEvidence,
} from '../src/config/runtime-model.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import {
  activateBundledModelCatalog,
  activateModelCatalog,
  activeModelCatalogSnapshot,
  listActiveCatalogModels,
  resetModelCatalogActivationForTests,
  resolveActiveCatalogRoute,
} from '../src/model-catalog/catalog.ts';
import { loadModelCatalog } from '../src/model-catalog/refresh.ts';
import { parseModelCatalogBytes } from '../src/model-catalog/schema.ts';
import { acceptModelCatalogCandidate, MODEL_CATALOG_SETTING_KEYS } from '../src/model-catalog/store.ts';
import { withEnv } from './helpers/env.ts';

const HOSTED = { CHICKPEA_TENANCY: 'installation' } as const;
const TENANT_MODEL = 'anthropic/claude-hosted-tenant-only';

function catalogBytes(revision: number, contextWindow = 200_000): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    revision,
    generatedAt: '2026-10-01T00:00:00Z',
    entries: [{
      canonical: TENANT_MODEL,
      displayName: 'Hosted tenant model',
      lanes: { apiKey: 'anthropic-messages-sonnet-tier@1' },
      contextWindow,
      maxTokens: 20_000,
    }],
  }));
}

function installations(t: TestContext) {
  resetModelCatalogActivationForTests();
  const env = (installationId: string) => scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId });
  const stores: SqliteSettingsStore[] = [];
  t.after(() => { for (const store of stores) store.close(); resetModelCatalogActivationForTests(); });
  const settings = () => {
    const store = new SqliteSettingsStore(':memory:');
    stores.push(store);
    return store;
  };
  return { env, settings };
}

test('each installation routes, freezes and lists with the catalog its own settings select', async (t) => {
  await withEnv({ CHICKPEA_TENANCY: undefined }, async () => {
    const { env, settings } = installations(t);
    const [envA, envB] = [env('inst_bundled'), env('inst_hosted')];
    const [settingsA, settingsB] = [settings(), settings()];
    await settingsA.setSetting(MODEL_CATALOG_SETTING_KEYS.mode, 'bundled');
    await acceptModelCatalogCandidate(settingsB, { bytes: catalogBytes(20), checkedAt: 1, nextRefreshAt: 2 });

    // B activates first; A's bundled activation afterwards used to replace the one shared snapshot.
    assert.equal((await loadModelCatalog(settingsB, envB)).status, 'activated');
    assert.equal((await loadModelCatalog(settingsA, envA)).status, 'bundled');

    assert.deepEqual(
      [activeModelCatalogSnapshot(envA).source, activeModelCatalogSnapshot(envB).source, activeModelCatalogSnapshot(envB).revision],
      ['bundled', 'hosted', 20],
    );
    assert.equal(resolveActiveCatalogRoute(TENANT_MODEL, 'anthropic_api_key', envA), undefined);
    assert.ok(resolveActiveCatalogRoute(TENANT_MODEL, 'anthropic_api_key', envB));
    assert.equal(listActiveCatalogModels('anthropic_api_key', envA).some((model) => model.id === 'claude-hosted-tenant-only'), false);
    assert.equal(listActiveCatalogModels('anthropic_api_key', envB).some((model) => model.id === 'claude-hosted-tenant-only'), true);

    // What a run freezes and records comes from its own installation's catalog.
    const frozen = freezeRuntimeModelRoute(TENANT_MODEL, undefined, envB);
    assert.deepEqual({ source: frozen?.source, revision: frozen && 'revision' in frozen ? frozen.revision : undefined },
      { source: 'hosted_catalog', revision: 20 });
    assert.equal(freezeRuntimeModelRoute(TENANT_MODEL, undefined, envA), undefined);
    assert.equal(safeRuntimeModelRouteEvidence(TENANT_MODEL, undefined, undefined, envB).catalogRevision, '20');
    assert.equal(safeRuntimeModelRouteEvidence(TENANT_MODEL, undefined, undefined, envA).catalogRevision, undefined);

    // Admission resolves and attributes the model against the same catalog.
    const resolved = await resolveRuntimeModel('agent', TENANT_MODEL, {
      settings: settingsB, env: envB, requireProviderKey: async () => undefined,
    });
    assert.match(resolved.model, /^chickpea-anthropic-api-r20-/);
    await assert.rejects(resolveRuntimeModel('agent', TENANT_MODEL, {
      settings: settingsA, env: envA, requireProviderKey: async () => undefined,
    }), /not supported by this Chickpea release/);
    const pinned = { id: 'agent', kind: 'user' as const, model: TENANT_MODEL };
    assert.equal(
      resolveAgentModelPolicy({ agent: pinned, runtimeContract: 'chickpea-v1', platformEnv: envB }).attribution.catalogRevision,
      '20',
    );
    assert.throws(() => resolveAgentModelPolicy({ agent: pinned, runtimeContract: 'chickpea-v1', platformEnv: envA }),
      ModelResolutionError);
  });
});

test('a newer revision for one installation never moves another installation\'s catalog', async (t) => {
  await withEnv({ CHICKPEA_TENANCY: undefined }, async () => {
    const { env } = installations(t);
    const [envOlder, envNewer] = [env('inst_older'), env('inst_newer')];
    const candidate = (revision: number, contextWindow: number) => ({
      document: parseModelCatalogBytes(catalogBytes(revision, contextWindow)),
      sha256: String(revision % 10).repeat(64),
    });
    assert.equal(activateModelCatalog(candidate(30, 100_000), envOlder).status, 'activated');
    assert.equal(activateModelCatalog(candidate(31, 300_000), envNewer).status, 'activated');
    assert.equal(activeModelCatalogSnapshot(envOlder).revision, 30);
    assert.equal(resolveActiveCatalogRoute(TENANT_MODEL, 'anthropic_api_key', envOlder)?.model.contextWindow, 100_000);
    assert.equal(resolveActiveCatalogRoute(TENANT_MODEL, 'anthropic_api_key', envNewer)?.model.contextWindow, 300_000);
    // Within an installation activation stays monotonic, as on standalone.
    assert.equal(activateModelCatalog(candidate(29, 50_000), envOlder).snapshot.revision, 30);
    activateBundledModelCatalog(envNewer);
    assert.equal(activeModelCatalogSnapshot(envOlder).revision, 30, 'bundled mode elsewhere changes nothing here');
  });
});

test('without an installation a catalog read gets the bundled catalog and an activation is refused', async (t) => {
  await withEnv({ CHICKPEA_TENANCY: undefined }, async () => {
    const { env } = installations(t);
    activateModelCatalog({ document: parseModelCatalogBytes(catalogBytes(40)), sha256: 'c'.repeat(64) }, env('inst_any'));
    const unscoped = HOSTED as Record<string, unknown>;
    assert.equal(activeModelCatalogSnapshot(unscoped).source, 'bundled');
    assert.equal(resolveActiveCatalogRoute(TENANT_MODEL, 'anthropic_api_key', unscoped), undefined);
    assert.throws(() => activateBundledModelCatalog(unscoped), InstallationContextError);
    // A caller passing no env on such a deployment is treated the same way.
    await withEnv({ CHICKPEA_TENANCY: 'installation' }, async () => {
      assert.equal(activeModelCatalogSnapshot().source, 'bundled');
      assert.throws(() => activateBundledModelCatalog(), InstallationContextError);
    });
  });
});

test('a busy installation is never the one evicted, and an evicted one reloads its own catalog', async (t) => {
  await withEnv({ CHICKPEA_TENANCY: undefined }, async () => {
    const { env, settings } = installations(t);
    // Every installation accepted the same published document.
    const shared = settings();
    await acceptModelCatalogCandidate(shared, { bytes: catalogBytes(60), checkedAt: 1, nextRefreshAt: 2 });
    const [busy, reloading] = [env('inst_busy'), env('inst_reloading')];
    await loadModelCatalog(shared, busy);
    await loadModelCatalog(shared, reloading);
    // 64 more installations arrive; the busy one keeps routing (a read) and reloading (an unchanged activation).
    for (let index = 0; index < 64; index += 1) {
      await loadModelCatalog(shared, env(`inst_arriving_${index}`));
      if (index % 2 === 0) assert.equal(activeModelCatalogSnapshot(busy).revision, 60);
      else await loadModelCatalog(shared, busy);
    }
    assert.equal(activeModelCatalogSnapshot(busy).revision, 60, 'the busy installation kept its catalog');
    assert.equal(activeModelCatalogSnapshot(env('inst_arriving_63')).revision, 60);
    // The least recently used one was evicted: it reads the bundled catalog until its next load.
    assert.equal(activeModelCatalogSnapshot(reloading).source, 'bundled');
    assert.equal((await loadModelCatalog(shared, reloading)).status, 'activated');
    assert.equal(activeModelCatalogSnapshot(reloading).revision, 60);
  });
});

test('past its distinct-document limit an isolate leaves a newly arriving installation on the bundled catalog', async (t) => {
  await withEnv({ CHICKPEA_TENANCY: undefined }, async () => {
    const { env, settings } = installations(t);
    for (let revision = 1; revision <= 16; revision += 1) {
      const store = settings();
      await acceptModelCatalogCandidate(store, { bytes: catalogBytes(revision), checkedAt: 1, nextRefreshAt: 2 });
      assert.equal((await loadModelCatalog(store, env(`inst_document_${revision}`))).status, 'activated');
    }
    const late = settings();
    await acceptModelCatalogCandidate(late, { bytes: catalogBytes(17), checkedAt: 1, nextRefreshAt: 2 });
    const envLate = env('inst_late');
    // Observable as restart_required; admission then resolves this installation against the bundled catalog.
    assert.deepEqual(await loadModelCatalog(late, envLate), { status: 'restart_required', revision: 17 });
    assert.equal(activeModelCatalogSnapshot(envLate).source, 'bundled');
    await assert.rejects(resolveRuntimeModel('agent', TENANT_MODEL, {
      settings: late, env: envLate, requireProviderKey: async () => undefined,
    }), /not supported by this Chickpea release/);
    assert.equal(activeModelCatalogSnapshot(env('inst_document_16')).revision, 16, 'earlier installations are unaffected');
  });
});

test('standalone keeps its one active catalog, with or without an env', async (t) => {
  await withEnv({ CHICKPEA_TENANCY: undefined }, async () => {
    installations(t);
    activateModelCatalog({ document: parseModelCatalogBytes(catalogBytes(50)), sha256: 'd'.repeat(64) });
    assert.equal(activeModelCatalogSnapshot().revision, 50);
    assert.equal(activeModelCatalogSnapshot({}).revision, 50);
    assert.ok(resolveActiveCatalogRoute(TENANT_MODEL, 'anthropic_api_key'));
    activateBundledModelCatalog({});
    assert.equal(activeModelCatalogSnapshot().source, 'bundled');
  });
});
