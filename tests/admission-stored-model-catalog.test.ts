import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { resolveModelPolicyForAssignment } from '../src/config/model-policy.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { resetModelCatalogActivationForTests } from '../src/model-catalog/catalog.ts';
import { loadModelCatalog } from '../src/model-catalog/refresh.ts';
import { acceptModelCatalogCandidate } from '../src/model-catalog/store.ts';
import { withEnv } from './helpers/env.ts';
import { message, withLane } from './helpers/gateway-admission-lane.ts';

/**
 * Admission judges the Workspace default against the installation's stored
 * catalog, as Admin readiness and the runtime do, not against whatever
 * revision this isolate activated on an earlier turn.
 */

const KEPT_MODEL = 'openai/gpt-hosted-kept';
const ADDED_MODEL = 'openai/gpt-hosted-added';

function catalogBytes(revision: number, canonicals: string[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    revision,
    generatedAt: '2026-11-01T00:00:00Z',
    entries: canonicals.map((canonical) => ({
      canonical,
      displayName: canonical,
      lanes: { apiKey: 'openai-platform-responses-terra-tier@1' },
    })),
  }));
}

// Defect caught: a warm isolate that activated hosted revision N on an earlier
// turn refuses a Workspace default that revision N+1 added, although N+1 is
// the stored catalog Admin reported the model ready from. Every turn then got
// the Workspace-default repair reply instead of a run on the model.
test('a DM admits the Workspace default that the stored catalog revision added after this isolate activated an older one', async (t) => {
  resetModelCatalogActivationForTests();
  t.after(resetModelCatalogActivationForTests);
  await withLane(async (lane) => {
    const settings = lane.stores.settings;
    await acceptModelCatalogCandidate(settings, {
      bytes: catalogBytes(7, [KEPT_MODEL]), checkedAt: 1, nextRefreshAt: 2,
    });
    assert.deepEqual(await loadModelCatalog(settings), { status: 'activated', revision: 7 },
      'an earlier turn in this isolate activated revision 7');
    await acceptModelCatalogCandidate(settings, {
      bytes: catalogBytes(8, [KEPT_MODEL, ADDED_MODEL]), checkedAt: 3, nextRefreshAt: 4,
    });
    lane.config.putWorkspaceModelDefault({
      workspaceId: 'T1', modelId: ADDED_MODEL, provenance: 'admin_selected',
      lastChangedByMembershipId: lane.help.creatorMembershipId!,
    }, lane.config.getWorkspaceModelDefault('T1')?.revision ?? 0);

    await lane.admit({
      protocolVersion: 1, kind: 'event.deliver', deliveryId: 'delivery_stored_catalog', bindingId: 'binding1',
      workspaceId: 'T1',
      envelope: {
        workspaceId: 'T1', eventId: 'Ev_stored_catalog', eventTime: 1_000,
        event: message({ channel: 'D1', ts: '7000.000100', text: 'hello' }),
      },
    });

    const [job] = lane.jobs;
    assert.ok(job, 'the DM became a turn');
    assert.equal(job.assignment.model, ADDED_MODEL, 'admission froze the Workspace default');
    assert.equal(job.assignment.modelAttribution?.source, 'workspace_default');
    assert.equal(job.assignment.modelAttribution?.catalogRevision, '8', 'judged by the stored revision');
  });
});

// Defect caught: on a deployment serving many installations, as Cloud is, the
// load reads no installation's catalog or another one's, so a warm isolate
// still judges the default by the revision it activated before.
test('an installation of a deployment serving many is judged by the catalog it stored', async (t) => {
  resetModelCatalogActivationForTests();
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { settings.close(); resetModelCatalogActivationForTests(); });
  await withEnv({ CHICKPEA_TENANCY: undefined }, async () => {
    const env = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_warm' });
    await acceptModelCatalogCandidate(settings, { bytes: catalogBytes(7, [KEPT_MODEL]), checkedAt: 1, nextRefreshAt: 2 });
    assert.equal((await loadModelCatalog(settings, env)).revision, 7);
    await acceptModelCatalogCandidate(settings, {
      bytes: catalogBytes(8, [KEPT_MODEL, ADDED_MODEL]), checkedAt: 3, nextRefreshAt: 4,
    });

    const assignment = await resolveModelPolicyForAssignment({
      workspaceId: 'T1', channelId: 'D1', agentId: 'agent_follows_default',
      agent: {
        id: 'agent_follows_default', kind: 'user', revision: 1, name: 'Follows', instructions: 'Help.',
        enabled: true, skills: [], mcpServers: [], apiConnections: [], repositories: [],
      },
    }, {
      getWorkspaceInstallation: async () => ({ runtimeContract: 'chickpea-v1' }) as never,
      getWorkspaceModelDefault: async () => ({
        workspaceId: 'T1', modelId: ADDED_MODEL, revision: 2, provenance: 'admin_selected',
        lastChangedByMembershipId: 'membership_owner', createdAt: 1, updatedAt: 2,
      }),
    }, settings, process.env, undefined, env);

    assert.equal(assignment.model, ADDED_MODEL);
    assert.equal(assignment.modelAttribution.catalogRevision, '8');
  });
});
