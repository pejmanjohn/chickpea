import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  configurePlatformFunding,
  resetPlatformFundingForTests,
  type PlatformFundingPort,
} from '../src/config/platform-funding.ts';
import { invalidateProviderKeyCache } from '../src/config/provider-keys.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import { createLiveWorkspaceManagementService } from '../src/management/live-service.ts';
import type { ManagementActorContext } from '../src/management/types.ts';
import { useDeploymentKeyring } from './helpers/deployment-keyring.ts';
import { withEnv } from './helpers/env.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';
import { NO_RUN_FEES } from './helpers/platform-funding.ts';

const NOW = Date.UTC(2026, 9, 7, 12);
const DEEPSEEK = 'openrouter/deepseek/deepseek-v4.1-flash';
const OPUS = 'anthropic/claude-opus-5-5';
const UNPRICED = 'anthropic/claude-opus-4-1';
const NO_DEPLOYMENT_KEYS = {
  CHICKPEA_TENANCY: undefined,
  ANTHROPIC_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  ANTHROPIC_BASE_URL: undefined,
  LOCAL_STUB_URL: undefined,
  SLACK_STATE_DB_PATH: ':memory:',
};

function fundedBy(funding: Awaited<ReturnType<PlatformFundingPort['funding']>>) {
  const asked: string[] = [];
  configurePlatformFunding({
    funding: async (installationId) => {
      asked.push(installationId);
      return funding;
    },
    admit: async () => 'admitted',
    charge: async () => undefined,
    ...NO_RUN_FEES,
  });
  return asked;
}

async function workspace(t: TestContext, env: PlatformEnv | undefined) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  resetPlatformFundingForTests();
  invalidateProviderKeyCache();
  useDeploymentKeyring(t);
  const f = await createManagementAdapterFixture('model-readiness');
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => {
    f.close();
    settings.close();
    resetPlatformFundingForTests();
    invalidateProviderKeyCache();
  });
  const service = createLiveWorkspaceManagementService(env, {
    identity: f.identity,
    settings,
    overrides: {
      config: f.config,
      management: f.management,
      memory: f.memory,
      routines: f.routines,
      setupBaseUrl: 'http://localhost',
      now: () => NOW,
    },
  });
  const context: ManagementActorContext = {
    userId: f.owner.user.id,
    membershipId: f.owner.membership.id,
    organizationId: f.owner.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'model-readiness-client' },
  };
  let sequence = 0;
  const createPinned = async (model: string) => {
    const id = `agent_pinned_${++sequence}`;
    const result = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: `create-${id}`,
      operations: [{ itemId: 'create', kind: 'create_agent', agent: {
        id, name: `Pinned ${sequence}`, instructions: 'Answer the team.', enabled: true,
        editPolicy: 'creator_and_admins', model,
        skills: [], mcpServers: [], apiConnections: [], repositories: [],
      } }],
    });
    assert.ok('outcomes' in result, JSON.stringify(result));
    return { id, result };
  };
  const previewPinned = async (model: string) => {
    const preview = await service.previewRecipe(context, { recipe: {
      schemaVersion: 1,
      name: 'Pinned helper',
      agents: [{
        symbol: 'helper', name: `Helper on ${model}`, instructions: 'Answer the team.', enabled: true, model,
        skills: [], mcpRequirements: [], apiRequirements: [], repositoryRequirements: [],
      }],
    } });
    const [agent] = preview.agents;
    assert.ok(agent);
    return {
      setupRequired: agent.setupRequired,
      unavailable: agent.unavailable,
      providerSetup: preview.operations.filter((operation) =>
        operation.kind === 'request_setup' && operation.target.kind === 'provider_credential').length,
    };
  };
  return { f, service, context, createPinned, previewPinned };
}

const hosted = () => scopeInstallationEnv(
  { CHICKPEA_TENANCY: 'installation' } as Record<string, unknown>,
  { installationId: 'inst_model_readiness' },
) as PlatformEnv;

test('a workspace on Chickpea\'s models with no key of its own creates Agents pinned to a model Chickpea\'s models serve', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { f, service, context, createPinned } = await workspace(t, hosted());
    const asked = fundedBy('platform');
    for (const model of [DEEPSEEK, OPUS]) {
      const before = asked.length;
      const { id, result } = await createPinned(model);
      assert.equal(result.status, 'completed', `${model}: ${JSON.stringify(result)}`);
      assert.equal((await f.config.getAgent(id)).model, model);
      assert.equal(asked.length - before, 1, `creating an Agent pinned to ${model} asks the funding port once`);
    }

    const changed = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'change-model',
      operations: [{ itemId: 'update', kind: 'update_agent', agentId: 'agent_pinned_1',
        expectedRevision: 1, patch: { model: OPUS } }],
    });
    assert.equal(changed.status, 'completed', JSON.stringify(changed));
    assert.equal((await f.config.getAgent('agent_pinned_1')).model, OPUS);
  });
});

test('a recipe pinned to a model Chickpea\'s models serve needs no provider setup on Chickpea\'s models', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { previewPinned } = await workspace(t, hosted());
    const asked = fundedBy('platform');
    for (const model of [DEEPSEEK, OPUS]) {
      const before = asked.length;
      assert.deepEqual(await previewPinned(model), { setupRequired: [], unavailable: [], providerSetup: 0 }, model);
      assert.equal(asked.length - before, 1, `previewing a recipe pinned to ${model} asks the funding port once`);
    }
  });
});

test('Chickpea\'s models refuse a pin they do not serve, and say why, with no provider setup', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { createPinned, previewPinned } = await workspace(t, hosted());
    fundedBy('platform');
    const { result } = await createPinned(UNPRICED);
    assert.equal(result.status, 'partial');
    assert.equal(result.outcomes[0]?.code, 'model_provider_unavailable');
    assert.match(result.outcomes[0]?.warning ?? '', /not available on Chickpea's models/);
    assert.match(result.outcomes[0]?.warning ?? '', /omit the model field to inherit the workspace default/);
    assert.deepEqual(await previewPinned(UNPRICED), {
      setupRequired: [],
      unavailable: ["Not available on Chickpea's models. Choose another model."],
      providerSetup: 0,
    });
  });
});

async function refusedForMissingKey({ createPinned, previewPinned }: Awaited<ReturnType<typeof workspace>>) {
  for (const model of [DEEPSEEK, OPUS]) {
    const { result } = await createPinned(model);
    assert.equal(result.status, 'partial', `${model} with no key`);
    assert.equal(result.outcomes[0]?.code, 'model_provider_unavailable');
    assert.match(result.outcomes[0]?.warning ?? '', /provider \w+ is not configured/);
    const provider = model.slice(0, model.indexOf('/'));
    assert.deepEqual(
      await previewPinned(model),
      { setupRequired: [`${provider} model provider`], unavailable: [], providerSetup: 1 },
      `a recipe pinned to ${model} asks for the ${provider} key`,
    );
  }
}

test('a workspace on its own key still needs a key for the pinned provider', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const pinned = await workspace(t, hosted());
    fundedBy('customer');
    await refusedForMissingKey(pinned);
  });
});

test('a standalone deployment still needs a key for the pinned provider, and never asks the funding port', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const pinned = await workspace(t, undefined);
    const asked = fundedBy('platform');
    await refusedForMissingKey(pinned);
    assert.deepEqual(asked, []);
  });
});
