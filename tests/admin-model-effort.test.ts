import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { PROVIDER_KEY_SETTING_KEYS, invalidateProviderKeyCache } from '../src/config/provider-keys.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { FAKE_PROVIDER_KEYS } from './helpers/fake-providers.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

const ADMIN_TOKEN = 'model-effort-admin-token';
const OPUS = 'anthropic/claude-opus-5-5';
const HAIKU = 'anthropic/claude-haiku-4-5';
// Pi maps xhigh but not max for this model.
const GPT = 'openai/gpt-5.5';

async function withAdmin(run: (fixture: {
  request: (path: string, method?: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
  config: SqliteConfigStore;
}) => Promise<void>): Promise<void> {
  invalidateProviderKeyCache();
  const app = new Hono();
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  app.route('/', createAdminRoutes({
    store: config,
    settings,
    usage,
    ...testAdminAuthority(ADMIN_TOKEN),
    knownProviders: new Set(['openai', 'anthropic']),
  }));
  try {
    await settings.setSetting(PROVIDER_KEY_SETTING_KEYS.openai, FAKE_PROVIDER_KEYS.openai);
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_EFFORT',
      transportMode: 'direct',
      runtimeContract: 'chickpea-v1',
      defaultAgentId: (await config.createAgent({
        id: 'agent_base',
        name: 'Base',
        instructions: 'Start.',
        enabled: true,
        lifecycle: 'active',
        skills: [],
        mcpServers: [],
        apiConnections: [],
        repositories: [],
      })).id,
    });
    await run({
      config,
      request: async (path, method = 'GET', body) => {
        const response = await app.request(path, {
          method,
          headers: testAdminHeaders(ADMIN_TOKEN, { 'content-type': 'application/json' }),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: await response.json() as Record<string, unknown> };
      },
    });
  } finally {
    config.close();
    settings.close();
    usage.close();
    invalidateProviderKeyCache();
  }
}

test('the effort endpoint lists a model\'s levels and the standard one', async () => {
  await withAdmin(async ({ request }) => {
    assert.deepEqual((await request(`/admin/api/model-efforts?model=${encodeURIComponent(OPUS)}`)).body, {
      model: OPUS,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      standard: 'medium',
    });
    assert.deepEqual((await request(`/admin/api/model-efforts?model=${encodeURIComponent(HAIKU)}`)).body, {
      model: HAIKU,
      efforts: ['low', 'medium', 'high'],
      standard: 'medium',
    });
    assert.deepEqual((await request('/admin/api/model-efforts?model=local-stub%2Fmodel')).body, {
      model: 'local-stub/model',
      efforts: [],
      standard: null,
    });
    assert.equal((await request('/admin/api/model-efforts')).status, 400);
  });
});

test('the Workspace default saves an effort its model accepts and stores none when omitted', async () => {
  await withAdmin(async ({ request }) => {
    // The installation bootstrap wrote revision 1 with no model.
    const rejected = await request('/admin/api/workspace-model-default', 'PUT', {
      modelId: GPT, effort: 'max', expectedRevision: 1,
    });
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.error, 'effort_not_supported');

    const saved = await request('/admin/api/workspace-model-default', 'PUT', {
      modelId: GPT, effort: 'xhigh', expectedRevision: 1,
    });
    assert.equal(saved.status, 200);
    const workspaceDefault = saved.body.workspaceDefault as Record<string, unknown>;
    assert.equal(workspaceDefault.effort, 'xhigh');
    assert.deepEqual(workspaceDefault.efforts, ['low', 'medium', 'high', 'xhigh']);
    assert.equal(workspaceDefault.standardEffort, 'medium');
    assert.equal(
      ((await request('/admin/api/workspace-model-default')).body.workspaceDefault as Record<string, unknown>).effort,
      'xhigh',
    );

    const omitted = await request('/admin/api/workspace-model-default', 'PUT', {
      modelId: GPT, expectedRevision: workspaceDefault.revision,
    });
    assert.equal((omitted.body.workspaceDefault as Record<string, unknown>).effort, null);
  });
});

test('the coding role carries an effort and the image role refuses one', async () => {
  await withAdmin(async ({ request }) => {
    const saved = await request('/admin/api/workspace-model-roles/coding', 'PUT', {
      modelId: GPT, effort: 'high', expectedRevision: 0,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const role = saved.body.workspaceModelRole as Record<string, unknown>;
    assert.equal(role.effort, 'high');
    assert.deepEqual(role.efforts, ['low', 'medium', 'high', 'xhigh']);
    assert.equal(role.standardEffort, 'medium');

    const unsupported = await request('/admin/api/workspace-model-roles/coding', 'PUT', {
      modelId: GPT, effort: 'max', expectedRevision: role.revision,
    });
    assert.equal(unsupported.body.error, 'effort_not_supported');
    const modelless = await request('/admin/api/workspace-model-roles/coding', 'PUT', {
      modelId: null, effort: 'high', expectedRevision: role.revision,
    });
    assert.equal(modelless.status, 422);
    assert.equal(modelless.body.error, 'effort_requires_model');

    const image = await request('/admin/api/workspace-model-roles/image', 'PUT', {
      modelId: 'openai/gpt-image-2.5-flare', effort: 'high', expectedRevision: 0,
    });
    assert.equal(image.status, 400);
  });
});

test('an Agent pins its effort with its model and follows the default\'s otherwise', async () => {
  await withAdmin(async ({ request }) => {
    const agent = (fields: Record<string, unknown>) => ({
      id: 'agent_effort', name: 'Effort', instructions: 'Think.', enabled: true, ...fields,
    });
    const unsupported = await request('/admin/api/agents', 'POST', agent({ model: HAIKU, modelEffort: 'max' }));
    assert.equal(unsupported.status, 422);
    assert.equal(unsupported.body.error, 'effort_not_supported');

    await request('/admin/api/workspace-model-default', 'PUT', { modelId: GPT, effort: 'low', expectedRevision: 1 });
    const following = await request('/admin/api/agents', 'POST', agent({ id: 'agent_following' }));
    const followingPolicy = (following.body.agent as Record<string, Record<string, unknown>>).modelPolicy!;
    assert.equal(followingPolicy.effort, 'low', 'an inheriting Agent shows the default\'s effort');
    assert.deepEqual(followingPolicy.efforts, ['low', 'medium', 'high', 'xhigh']);

    const created = await request('/admin/api/agents', 'POST', agent({ model: OPUS, modelEffort: 'max' }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const pinned = created.body.agent as Record<string, Record<string, unknown> | unknown>;
    assert.equal(pinned.modelEffort, 'max');
    assert.deepEqual(pinned.modelPolicy, {
      source: 'pinned',
      effectiveModel: OPUS,
      effort: 'max',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      standardEffort: 'medium',
      live: true,
      workspaceDefaultRevision: 2,
    });

    let revision = (pinned as { revision: number }).revision;
    const patch = async (fields: Record<string, unknown>) => {
      const response = await request('/admin/api/agents/agent_effort', 'PATCH', { expectedRevision: revision, ...fields });
      if (response.status === 200) revision = (response.body.agent as { revision: number }).revision;
      return response;
    };
    const switched = await patch({ model: HAIKU });
    assert.equal((switched.body.agent as Record<string, unknown>).modelEffort, null, 'a new model clears the effort');
    assert.equal((await patch({ modelEffort: 'max' })).body.error, 'effort_not_supported');
    assert.equal(((await patch({ modelEffort: 'medium' })).body.agent as Record<string, unknown>).modelEffort, 'medium');

    const unpinned = (await patch({ model: null })).body.agent as Record<string, Record<string, unknown>>;
    assert.equal(unpinned.modelEffort, null);
    assert.equal(unpinned.modelPolicy!.source, 'workspace_default');
    assert.equal(unpinned.modelPolicy!.effort, 'low');
    assert.equal((await patch({ modelEffort: 'high' })).body.error, 'effort_requires_model');
    const modelless = await request('/admin/api/agents', 'POST', agent({ id: 'agent_modelless', modelEffort: 'high' }));
    assert.equal(modelless.status, 422);
    assert.equal(modelless.body.error, 'effort_requires_model');
  });
});
