import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { PROVIDER_KEY_SETTING_KEYS, invalidateProviderKeyCache } from '../src/config/provider-keys.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { FAKE_PROVIDER_KEYS } from './helpers/fake-providers.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

const ADMIN_TOKEN = 'model-roles-admin-token';
const FLARE = 'openai/gpt-image-2.5-flare';
const SUNBURST = 'openai/gpt-image-2.5-sunburst';

function auth(): HeadersInit {
  return testAdminHeaders(ADMIN_TOKEN, { 'content-type': 'application/json' });
}

function harness(principal?: AuthPrincipal) {
  invalidateProviderKeyCache();
  const app = new Hono();
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  app.route('/', createAdminRoutes({
    store: config,
    settings,
    usage,
    ...testAdminAuthority(ADMIN_TOKEN, undefined, undefined, principal),
    knownProviders: new Set(['openai', 'local-stub']),
  }));
  return {
    app,
    config,
    settings,
    close: () => {
      config.close();
      settings.close();
      usage.close();
      invalidateProviderKeyCache();
    },
  };
}

async function installWorkspace(fixture: ReturnType<typeof harness>) {
  const base = await fixture.config.createAgent({
    id: 'agent_base',
    name: 'Base',
    instructions: 'Start.',
    enabled: true,
    lifecycle: 'active',
    model: 'openai/gpt-5.6-sol',
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  await fixture.config.ensureWorkspaceInstallation({
    workspaceId: 'T_TEST',
    transportMode: 'direct',
    runtimeContract: 'chickpea-v1',
    defaultAgentId: base.id,
  });
  return base;
}

async function connectOpenAi(fixture: ReturnType<typeof harness>) {
  await fixture.settings.setSetting(PROVIDER_KEY_SETTING_KEYS.openai, FAKE_PROVIDER_KEYS.openai);
  invalidateProviderKeyCache();
}

test('the image role rejects a chat model and accepts a catalog model once OpenAI is connected', async () => {
  const fixture = harness();
  try {
    await installWorkspace(fixture);

    // Shape-only ids are not enough: the role validates against the catalog.
    const chatModel = await fixture.app.request('/admin/api/workspace-model-roles/image', {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ modelId: 'openai/gpt-5.6-sol', expectedRevision: 0 }),
    });
    assert.equal(chatModel.status, 400);
    assert.deepEqual(await chatModel.json(), {
      error: 'invalid_request',
      message: 'openai/gpt-5.6-sol is not an image model.',
    });

    // A catalog model still needs the provider credential behind it.
    const unconnected = await fixture.app.request('/admin/api/workspace-model-roles/image', {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ modelId: FLARE, expectedRevision: 0 }),
    });
    assert.equal(unconnected.status, 400);
    assert.match(
      (await unconnected.json() as { message: string }).message,
      /Connect the openai provider/,
    );

    await connectOpenAi(fixture);
    const saved = await fixture.app.request('/admin/api/workspace-model-roles/image', {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ modelId: FLARE, expectedRevision: 0 }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), {
      workspaceModelRole: {
        workspaceId: 'T_TEST',
        role: 'image',
        modelId: FLARE,
        revision: 1,
        availableModels: [
          { id: FLARE, name: 'GPT Image 2.5 Flare', providerId: 'openai', acceptsImageInput: true },
          {
            id: SUNBURST,
            name: 'GPT Image 2.5 Sunburst',
            providerId: 'openai',
            acceptsImageInput: true,
          },
        ],
      },
    });

    const read = await fixture.app.request('/admin/api/workspace-model-roles/image', {
      headers: auth(),
    });
    assert.equal(read.status, 200);
    assert.equal(
      (await read.json() as { workspaceModelRole: { modelId: string } }).workspaceModelRole.modelId,
      FLARE,
    );

    // Nothing is seeded and no role beyond the declared ones exists.
    const unknownRole = await fixture.app.request('/admin/api/workspace-model-roles/video', {
      headers: auth(),
    });
    assert.equal(unknownRole.status, 404);
  } finally {
    fixture.close();
  }
});

test('the image model list is empty until its provider has a credential', async () => {
  const fixture = harness();
  try {
    await installWorkspace(fixture);

    const unconnected = await fixture.app.request('/admin/api/image-models', { headers: auth() });
    assert.equal(unconnected.status, 200);
    assert.deepEqual(await unconnected.json(), {
      models: [],
      providers: [{ id: 'openai', configured: false }],
    });

    await connectOpenAi(fixture);
    const connected = await fixture.app.request('/admin/api/image-models', { headers: auth() });
    assert.equal(connected.status, 200);
    assert.deepEqual(await connected.json(), {
      models: [
        {
          id: FLARE,
          name: 'GPT Image 2.5 Flare',
          providerId: 'openai',
          acceptsImageInput: true,
          fasterAndCheaper: true,
        },
        {
          id: SUNBURST,
          name: 'GPT Image 2.5 Sunburst',
          providerId: 'openai',
          acceptsImageInput: true,
          fasterAndCheaper: false,
        },
      ],
      providers: [{ id: 'openai', configured: true }],
    });
    // The chat model list and the image list never share entries.
    const chatModels = await fixture.app.request('/admin/api/models', { headers: auth() });
    assert.equal(chatModels.status, 200);
    const chatBody = await chatModels.text();
    assert.ok(!chatBody.includes('gpt-image-2.5'), 'chat model list must not carry image models');
  } finally {
    fixture.close();
  }
});

test('a stale image role revision conflicts and returns the current value', async () => {
  const fixture = harness();
  try {
    await installWorkspace(fixture);
    await connectOpenAi(fixture);
    const first = await fixture.app.request('/admin/api/workspace-model-roles/image', {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ modelId: FLARE, expectedRevision: 0 }),
    });
    assert.equal(first.status, 200);

    const stale = await fixture.app.request('/admin/api/workspace-model-roles/image', {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ modelId: SUNBURST, expectedRevision: 0 }),
    });
    assert.equal(stale.status, 409);
    const body = await stale.json() as {
      error: string;
      expectedRevision: number;
      actualRevision: number;
      workspaceModelRole: { modelId: string; revision: number };
    };
    assert.equal(body.error, 'model_role_revision_conflict');
    assert.equal(body.expectedRevision, 0);
    assert.equal(body.actualRevision, 1);
    assert.equal(body.workspaceModelRole.modelId, FLARE);
    assert.equal(body.workspaceModelRole.revision, 1);
  } finally {
    fixture.close();
  }
});

test('a workspace member cannot write the image role through Admin', async () => {
  const member: AuthPrincipal = {
    userId: 'user_member',
    membershipId: 'membership_member',
    organizationId: 'org_oss',
    role: 'member',
    authenticatorKind: 'test_slack_session',
    credentialId: 'member_session',
    correlationId: 'member_request',
    machine: false,
  };
  const fixture = harness(member);
  try {
    await installWorkspace(fixture);
    await connectOpenAi(fixture);

    const response = await fixture.app.request('/admin/api/workspace-model-roles/image', {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ modelId: FLARE, expectedRevision: 0 }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'forbidden' });
    assert.equal(await fixture.config.getWorkspaceModelRole('T_TEST', 'image'), undefined);
  } finally {
    fixture.close();
  }
});

test('the image role clears back to unset and can be set again from cleared', async () => {
  const fixture = harness();
  try {
    await installWorkspace(fixture);
    await connectOpenAi(fixture);
    const set = await fixture.app.request('/admin/api/workspace-model-roles/image', {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ modelId: FLARE, expectedRevision: 0 }),
    });
    assert.equal(set.status, 200);

    // A stale revision conflicts before anything is cleared.
    const stale = await fixture.app.request('/admin/api/workspace-model-roles/image', {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ modelId: null, expectedRevision: 0 }),
    });
    assert.equal(stale.status, 409);
    const staleBody = await stale.json() as {
      error: string;
      expectedRevision: number;
      actualRevision: number;
      workspaceModelRole: { modelId: string | null; revision: number };
    };
    assert.equal(staleBody.error, 'model_role_revision_conflict');
    assert.equal(staleBody.expectedRevision, 0);
    assert.equal(staleBody.actualRevision, 1);
    assert.equal(staleBody.workspaceModelRole.modelId, FLARE);

    const cleared = await fixture.app.request('/admin/api/workspace-model-roles/image', {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ modelId: null, expectedRevision: 1 }),
    });
    assert.equal(cleared.status, 200);
    const clearedBody = await cleared.json() as {
      workspaceModelRole: {
        workspaceId: string;
        role: string;
        modelId: string | null;
        revision: number;
        availableModels: unknown[];
      };
    };
    assert.equal(clearedBody.workspaceModelRole.workspaceId, 'T_TEST');
    assert.equal(clearedBody.workspaceModelRole.role, 'image');
    assert.equal(clearedBody.workspaceModelRole.modelId, null);
    assert.equal(clearedBody.workspaceModelRole.revision, 2);
    // The picker list still ships with the cleared projection.
    assert.equal(clearedBody.workspaceModelRole.availableModels.length, 2);
    assert.equal(
      (await fixture.config.getWorkspaceModelRole('T_TEST', 'image'))?.modelId,
      undefined,
    );

    const read = await fixture.app.request('/admin/api/workspace-model-roles/image', {
      headers: auth(),
    });
    assert.equal(read.status, 200);
    assert.deepEqual(
      (await read.json() as { workspaceModelRole: { modelId: string | null; revision: number } })
        .workspaceModelRole.modelId,
      null,
    );

    // Setting again from the cleared state uses the bumped revision.
    const reset = await fixture.app.request('/admin/api/workspace-model-roles/image', {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ modelId: SUNBURST, expectedRevision: 2 }),
    });
    assert.equal(reset.status, 200);
    const resetBody = await reset.json() as {
      workspaceModelRole: { modelId: string; revision: number };
    };
    assert.equal(resetBody.workspaceModelRole.modelId, SUNBURST);
    assert.equal(resetBody.workspaceModelRole.revision, 3);
  } finally {
    fixture.close();
  }
});

test('clearing the image role still requires an Owner or Admin', async () => {
  const member: AuthPrincipal = {
    userId: 'user_member',
    membershipId: 'membership_member',
    organizationId: 'org_oss',
    role: 'member',
    authenticatorKind: 'test_slack_session',
    credentialId: 'member_session',
    correlationId: 'member_request',
    machine: false,
  };
  const fixture = harness(member);
  try {
    await installWorkspace(fixture);
    await connectOpenAi(fixture);
    const response = await fixture.app.request('/admin/api/workspace-model-roles/image', {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ modelId: null, expectedRevision: 0 }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'forbidden' });
  } finally {
    fixture.close();
  }
});

test('an Agent PATCH sets and clears its image override', async () => {
  const fixture = harness();
  try {
    await installWorkspace(fixture);
    await connectOpenAi(fixture);
    await fixture.app.request('/admin/api/workspace-model-roles/image', {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ modelId: FLARE, expectedRevision: 0 }),
    });

    const createdResponse = await fixture.app.request('/admin/api/agents', {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        id: 'agent_analyst',
        name: 'Analyst',
        instructions: 'Make things.',
        enabled: true,
        model: 'openai/gpt-5.6-sol',
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json() as { agent: Record<string, any> }).agent;
    assert.equal(created.imageModel, null);
    assert.deepEqual(created.imageModelPolicy, {
      source: 'workspace_default',
      effectiveModel: FLARE,
    });

    const rejected = await fixture.app.request('/admin/api/agents/agent_analyst', {
      method: 'PATCH',
      headers: auth(),
      body: JSON.stringify({
        expectedRevision: created.revision,
        imageModel: 'openai/gpt-5.6-sol',
      }),
    });
    assert.equal(rejected.status, 400);
    assert.equal(
      await fixture.config.getAgentModelRole('agent_analyst', 'image'),
      undefined,
      'a rejected role choice writes nothing',
    );

    const pinnedResponse = await fixture.app.request('/admin/api/agents/agent_analyst', {
      method: 'PATCH',
      headers: auth(),
      body: JSON.stringify({ expectedRevision: created.revision, imageModel: SUNBURST }),
    });
    assert.equal(pinnedResponse.status, 200);
    const pinned = (await pinnedResponse.json() as { agent: Record<string, any> }).agent;
    assert.equal(pinned.imageModel, SUNBURST);
    assert.deepEqual(pinned.imageModelPolicy, { source: 'pinned', effectiveModel: SUNBURST });

    const clearedResponse = await fixture.app.request('/admin/api/agents/agent_analyst', {
      method: 'PATCH',
      headers: auth(),
      body: JSON.stringify({ expectedRevision: pinned.revision, imageModel: null }),
    });
    assert.equal(clearedResponse.status, 200);
    const cleared = (await clearedResponse.json() as { agent: Record<string, any> }).agent;
    assert.equal(cleared.imageModel, null);
    assert.deepEqual(cleared.imageModelPolicy, {
      source: 'workspace_default',
      effectiveModel: FLARE,
    });
  } finally {
    fixture.close();
  }
});
