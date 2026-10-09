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
import { invokeSlackWorkspaceManagementTool } from '../src/management/slack-tools.ts';
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
  const createPinned = async (model: string | undefined) => {
    const id = `agent_pinned_${++sequence}`;
    const result = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: `create-${id}`,
      operations: [{ itemId: 'create', kind: 'create_agent', agent: {
        id, name: `Pinned ${sequence}`, instructions: 'Answer the team.', enabled: true,
        editPolicy: 'creator_and_admins', ...(model ? { model } : {}),
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
  let changes = 0;
  const changeModels = (changesToApply: Array<{ agentId: string; expectedRevision: number; model: string }>) =>
    service.applyWorkspaceChanges({
      context,
      idempotencyKey: `change-${++changes}`,
      operations: changesToApply.map(({ agentId, expectedRevision, model }, index) => ({
        itemId: `update_${index}`, kind: 'update_agent' as const, agentId, expectedRevision, patch: { model },
      })),
    });
  // The model list an Agent managing itself grounds model questions in.
  const selfManagedModels = async (model: string) => {
    const workspaceId = f.owner.user.slackTeamId;
    const agent = await f.config.createAgent({
      id: 'agent_self', name: 'Self', instructions: 'Answer the team.', enabled: true, lifecycle: 'active',
      creatorMembershipId: f.owner.membership.id, editPolicy: 'creator_and_admins', configurationGeneration: 1,
      model, skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await f.config.materializeChickpeaAgent();
    const installation = await f.config.ensureWorkspaceInstallation({
      workspaceId, transportMode: 'direct', defaultAgentId: agent.id, teamId: workspaceId,
      appId: 'A_MODEL_READINESS', botUserId: 'U_CHICKPEA',
    });
    await f.config.updateWorkspaceInstallation(workspaceId, { runtimeContract: 'chickpea-v1' }, installation.revision);
    const inspected = await invokeSlackWorkspaceManagementTool({
      signal: {
        agentId: agent.id, workspaceId, channelId: 'D_MODEL_READINESS', threadTs: '400.1',
        slackUserId: f.owner.binding.slackUserId, eventId: 'Ev_MODEL_READINESS', messageTs: '400.2',
        turnJobId: 'turn_MODEL_READINESS',
      },
      identity: f.identity,
      service,
      name: 'inspect_workspace',
      args: {},
    });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    const { result } = inspected as { ok: true; result: { selfManagement: { availableModels: Array<{ id: string }> } } };
    return result.selfManagement.availableModels.map(({ id }) => id);
  };
  return { f, service, context, createPinned, previewPinned, changeModels, selfManagedModels };
}

const hosted = () => scopeInstallationEnv(
  { CHICKPEA_TENANCY: 'installation' } as Record<string, unknown>,
  { installationId: 'inst_model_readiness' },
) as PlatformEnv;

test('a workspace on Chickpea\'s models with no key of its own creates Agents pinned to a model Chickpea\'s models serve', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { f, createPinned, changeModels } = await workspace(t, hosted());
    const asked = fundedBy('platform');
    for (const model of [DEEPSEEK, OPUS]) {
      const before = asked.length;
      const { id, result } = await createPinned(model);
      assert.equal(result.status, 'completed', `${model}: ${JSON.stringify(result)}`);
      assert.equal((await f.config.getAgent(id)).model, model);
      assert.equal(asked.length - before, 1, `creating an Agent pinned to ${model} asks the funding port once`);
    }

    const refused = await changeModels([{ agentId: 'agent_pinned_1', expectedRevision: 1, model: UNPRICED }]);
    assert.ok('outcomes' in refused);
    assert.equal(refused.status, 'partial');
    assert.equal(refused.outcomes[0]?.code, 'model_provider_unavailable');
    assert.match(
      refused.outcomes[0]?.warning ?? '',
      /^Cannot change the Agent's model to anthropic\/claude-opus-4-1: it is not available on Chickpea's models\. If the requester did not select a model, leave the model unchanged\./,
    );
    assert.equal((await f.config.getAgent('agent_pinned_1')).model, DEEPSEEK, 'a refused change leaves the model as it was');

    const before = asked.length;
    const changed = await changeModels([
      { agentId: 'agent_pinned_1', expectedRevision: 1, model: OPUS },
      { agentId: 'agent_pinned_2', expectedRevision: 1, model: DEEPSEEK },
    ]);
    assert.equal(changed.status, 'completed', JSON.stringify(changed));
    assert.equal((await f.config.getAgent('agent_pinned_1')).model, OPUS);
    assert.equal((await f.config.getAgent('agent_pinned_2')).model, DEEPSEEK);
    assert.equal(asked.length - before, 1, 'one request changing two models asks the funding port once');
  });
});

test('an Agent managing itself on Chickpea\'s models lists the models they serve, and each one creates', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { createPinned, selfManagedModels } = await workspace(t, hosted());
    fundedBy('platform');
    const listed = await selfManagedModels(OPUS);
    assert.ok(listed.includes('anthropic/claude-sonnet-5-5'), `a served model besides its own pin is listed: ${listed.join(', ')}`);
    assert.ok(!listed.includes(UNPRICED), 'a model Chickpea\'s models do not serve is not listed');
    for (const model of listed) {
      const { result } = await createPinned(model);
      assert.equal(result.status, 'completed', `${model} is listed, so it creates: ${JSON.stringify(result)}`);
    }
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

async function refusedForMissingKey(
  { f, createPinned, previewPinned, changeModels, selfManagedModels }: Awaited<ReturnType<typeof workspace>>,
) {
  const inheriting = await createPinned(undefined);
  assert.equal(inheriting.result.status, 'completed', 'an Agent on the workspace default needs no key');
  for (const model of [DEEPSEEK, OPUS]) {
    const changed = await changeModels([{ agentId: inheriting.id, expectedRevision: 1, model }]);
    assert.ok('outcomes' in changed);
    assert.equal(changed.outcomes[0]?.code, 'model_provider_unavailable', `changing to ${model} with no key`);
    assert.match(changed.outcomes[0]?.warning ?? '', /^Cannot change the Agent's model to .+: provider \w+ is not configured\./);
    assert.equal((await f.config.getAgent(inheriting.id)).model, undefined);

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
  assert.deepEqual(await selfManagedModels(OPUS), [OPUS], 'with no key an Agent managing itself lists only its own pin');
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
