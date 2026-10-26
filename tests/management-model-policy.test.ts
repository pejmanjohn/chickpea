import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import * as v from 'valibot';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { saveOpenAiAuthMethod } from '../src/config/openai-auth.ts';
import {
  configurePlatformFunding,
  resetPlatformFundingForTests,
} from '../src/config/platform-funding.ts';
import { invalidateProviderKeyCache, PROVIDER_KEY_SETTING_KEYS } from '../src/config/provider-keys.ts';
import { putProviderFavorites } from '../src/config/provider-models.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { createLiveWorkspaceManagementService } from '../src/management/live-service.ts';
import { createManagementModelSources } from '../src/management/model-sources.ts';
import {
  managementOperationValibotSchema,
  managementOperationZodSchema,
} from '../src/management/schemas.ts';
import { invokeWorkspaceManagementTool } from '../src/management/tool-adapter.ts';
import type {
  ManagementActorContext,
  ManagementApplyResult,
  ManagementOperation,
  ManagementWorkspaceSnapshot,
} from '../src/management/types.ts';
import { commitOpenAiSubscriptionCredentials } from '../src/openai-subscription/credentials.ts';
import { useDeploymentKeyring } from './helpers/deployment-keyring.ts';
import { withEnv } from './helpers/env.ts';
import { FAKE_PROVIDER_KEYS } from './helpers/fake-providers.ts';
import {
  createManagementAdapterFixture,
  ownerMcpContext,
  ownerSlackDmContext,
  type ManagementAdapterFixture,
} from './helpers/management-adapter-fixture.ts';
import { NO_RUN_FEES } from './helpers/platform-funding.ts';
import { withPersonApproval } from './helpers/slack-person-approval.ts';

const NOW = Date.UTC(2026, 9, 26, 12);
/** The identity store's clock in the adapter fixture. */
const FIXTURE_NOW = 1_800_000_000_000;
const OPUS = 'anthropic/claude-opus-5-5';
const SONNET = 'anthropic/claude-sonnet-5-5';
const SOL = 'openai/gpt-6.1-sol';
const FLARE = 'openai/gpt-image-2.5-flare';
const CHATGPT_IMAGE = 'openai/chatgpt-image';
const KIMI = 'cloudflare/@cf/moonshotai/kimi-k2.7-code';
const NO_DEPLOYMENT_KEYS = {
  CHICKPEA_TENANCY: undefined,
  ANTHROPIC_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  ANTHROPIC_BASE_URL: undefined,
  OPENAI_BASE_URL: undefined,
  LOCAL_STUB_URL: undefined,
  CLOUDFLARE_API_TOKEN: undefined,
  CLOUDFLARE_ACCOUNT_ID: undefined,
  SLACK_STATE_DB_PATH: ':memory:',
};

type Snapshot = ManagementWorkspaceSnapshot;
type SnapshotAgent = Snapshot['agents'][number];

async function workspace(t: TestContext, env?: PlatformEnv) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  resetPlatformFundingForTests();
  invalidateProviderKeyCache();
  useDeploymentKeyring(t);
  const f = await createManagementAdapterFixture('model-policy');
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
  const workspaceId = f.owner.user.slackTeamId;
  await f.config.materializeChickpeaAgent();
  await f.config.ensureWorkspaceInstallation({
    workspaceId,
    transportMode: 'direct',
    runtimeContract: 'chickpea-v1',
  });
  return { f, settings, service, workspaceId };
}

async function storeKey(settings: SqliteSettingsStore, provider: 'anthropic' | 'openai'): Promise<void> {
  await settings.setSetting(PROVIDER_KEY_SETTING_KEYS[provider], FAKE_PROVIDER_KEYS[provider]);
  invalidateProviderKeyCache();
}

async function connectChatGptPlan(settings: SqliteSettingsStore): Promise<void> {
  await commitOpenAiSubscriptionCredentials({
    accessToken: 'plan-access',
    refreshToken: 'plan-refresh',
    idToken: undefined,
    expiresAt: NOW + 3_600_000,
    accountId: 'plan-account',
  }, {
    settings,
    randomBytes: (length) => new Uint8Array(length).fill(7),
  });
  await saveOpenAiAuthMethod(settings, 'subscription');
}

function agentInput(
  f: ManagementAdapterFixture,
  id: string,
  extra: Partial<CustomAgentConfig> = {},
) {
  return {
    id,
    name: id.replace('agent_', ''),
    instructions: 'Answer the team.',
    enabled: true,
    lifecycle: 'active' as const,
    creatorMembershipId: f.owner.membership.id,
    editPolicy: 'creator_and_admins' as const,
    configurationGeneration: 1,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
    ...extra,
  };
}

async function inspect(
  service: ReturnType<typeof createLiveWorkspaceManagementService>,
  context: ManagementActorContext,
): Promise<Snapshot> {
  const response = await invokeWorkspaceManagementTool({
    service,
    resolveContext: async () => context,
  }, 'inspect_workspace', {});
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { result: Snapshot }).result;
}

let keys = 0;
async function apply(
  service: ReturnType<typeof createLiveWorkspaceManagementService>,
  context: ManagementActorContext,
  operations: ManagementOperation[],
): Promise<ManagementApplyResult> {
  const response = await invokeWorkspaceManagementTool({
    service,
    resolveContext: async () => context,
  }, 'apply_workspace_changes', { idempotencyKey: `model-policy-${++keys}`, operations });
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { result: ManagementApplyResult }).result;
}

async function undo(
  service: ReturnType<typeof createLiveWorkspaceManagementService>,
  context: ManagementActorContext,
  operationId: string,
): Promise<ManagementApplyResult> {
  const response = await invokeWorkspaceManagementTool({
    service,
    resolveContext: async () => context,
  }, 'undo_workspace_change', { operationId, idempotencyKey: `model-policy-undo-${++keys}` });
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { result: ManagementApplyResult }).result;
}

function agent(snapshot: Snapshot, id: string): SnapshotAgent {
  const found = snapshot.agents.find((candidate) => candidate.id === id);
  assert.ok(found, `${id} is inspected`);
  return found;
}

function provider(snapshot: Snapshot, id: Snapshot['providers'][number]['id']) {
  const found = snapshot.providers.find((candidate) => candidate.id === id);
  assert.ok(found, `${id} has a provider row`);
  return found;
}

async function addMember(f: ManagementAdapterFixture): Promise<ManagementActorContext> {
  const locatorHash = 'b'.repeat(64);
  const invitation = await f.identity.createInvitation({
    organizationId: f.owner.membership.organizationId,
    slackTeamId: f.owner.user.slackTeamId,
    slackUserId: 'U11111111',
    displayName: 'Member',
    role: 'admin',
    locatorHash,
    inviterMembershipId: f.owner.membership.id,
    expiresAt: FIXTURE_NOW + 60_000,
  });
  const invited = await f.identity.consumeInvitation({
    invitationId: invitation.id,
    locatorHash,
    slackTeamId: f.owner.user.slackTeamId,
    slackUserId: invitation.slackUserId,
    displayName: 'Member',
    betterAuthUserId: 'ba_user_model_policy_member',
    betterAuthMembershipId: 'ba_member_model_policy_member',
  });
  await f.identity.updateMembershipAuthority({
    membershipId: invited.membership.id,
    role: 'member',
    actorMembershipId: f.owner.membership.id,
    correlationId: 'demote-model-policy',
    authenticationSurface: 'better_auth',
    reasonCode: 'model_policy_test',
  });
  return {
    userId: invited.user.id,
    membershipId: invited.membership.id,
    organizationId: invited.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'model-policy-member' },
  };
}

test('inspect shows the Workspace models, what each Agent runs, and a catalog from the ChatGPT plan with its effort levels', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { f, settings, service, workspaceId } = await workspace(t);
    await storeKey(settings, 'anthropic');
    await connectChatGptPlan(settings);
    await f.config.putWorkspaceModelDefault({
      workspaceId, modelId: OPUS, effort: 'high', provenance: 'admin_selected',
    });
    await f.config.putWorkspaceModelRole({ workspaceId, role: 'coding', modelId: SOL, effort: 'medium' });
    await f.config.createAgent(agentInput(f, 'agent_inherits'));
    await f.config.createAgent(agentInput(f, 'agent_pinned', { model: SOL, modelEffort: 'xhigh' }));
    await f.config.putAgentModelRole({ agentId: 'agent_pinned', role: 'image', modelId: CHATGPT_IMAGE });

    const snapshot = await inspect(service, ownerMcpContext(f));

    assert.deepEqual(snapshot.workspaceModels, {
      chat: { model: OPUS, effort: 'high', revision: 2 },
      image: { model: null, revision: 0 },
      coding: { model: SOL, effort: 'medium', revision: 1 },
    });
    const inherits = agent(snapshot, 'agent_inherits');
    assert.equal(inherits.imageModel, undefined, 'an Agent with no image pin carries none');
    assert.deepEqual(inherits.effectiveModels, {
      model: OPUS,
      modelSource: 'workspace_default',
      effort: 'high',
      imageModel: null,
      imageModelSource: 'workspace_default',
    });
    const pinned = agent(snapshot, 'agent_pinned');
    assert.equal(pinned.imageModel, CHATGPT_IMAGE, 'the pin is in the shape set_agent_image_model takes');
    assert.deepEqual(pinned.effectiveModels, {
      model: SOL,
      modelSource: 'pinned',
      effort: 'xhigh',
      imageModel: CHATGPT_IMAGE,
      imageModelSource: 'pinned',
    });

    const plan = snapshot.modelCatalog.chat.find(({ id }) => id === SOL);
    assert.deepEqual(plan, { id: SOL, efforts: ['low', 'medium', 'high', 'xhigh'] },
      'a ChatGPT plan model lists the levels the plan accepts, which stop at xhigh');
    assert.ok(snapshot.modelCatalog.chat.some(({ id }) => id === OPUS), 'an API-key model is listed too');
    assert.deepEqual(snapshot.modelCatalog.image.map(({ id }) => id), [CHATGPT_IMAGE]);

    assert.deepEqual(
      [provider(snapshot, 'openai'), provider(snapshot, 'anthropic'), provider(snapshot, 'openrouter')]
        .map(({ id, available, access, source }) => ({ id, available, access, source })),
      [
        { id: 'openai', available: true, access: 'chatgpt_plan', source: 'missing' },
        { id: 'anthropic', available: true, access: 'api_key', source: 'stored' },
        { id: 'openrouter', available: false, access: undefined, source: 'missing' },
      ],
    );
  });
});

test('a Workspace on Workers AI reports it available and lists its models with their effort levels', async (t) => {
  const navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Cloudflare-Workers' } });
  t.after(() => {
    if (navigator) Object.defineProperty(globalThis, 'navigator', navigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    resetPlatformFundingForTests();
    invalidateProviderKeyCache();
    const settings = new SqliteSettingsStore(':memory:');
    const env = { AI: { models: async () => [], run: async () => ({}) } } as unknown as PlatformEnv;
    await putProviderFavorites('workers-ai', ['@cf/moonshotai/kimi-k2.7-code'], settings);
    const f = await createManagementAdapterFixture('model-policy-workers-ai', {
      models: createManagementModelSources({ env, settings }),
    });
    t.after(() => {
      f.close();
      settings.close();
    });

    const snapshot = await inspect(f.service, ownerMcpContext(f));

    const workersAi = provider(snapshot, 'workers-ai');
    assert.deepEqual(
      { available: workersAi.available, access: workersAi.access, mutable: workersAi.mutable },
      { available: true, access: 'workers_ai', mutable: false },
    );
    assert.deepEqual(
      snapshot.modelCatalog.chat.find(({ id }) => id === KIMI),
      { id: KIMI, efforts: ['low', 'medium', 'high'] },
    );
  });
});

test('on Chickpea\'s models a provider with no key of the Workspace\'s own is available through the platform', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const hosted = scopeInstallationEnv(
      { CHICKPEA_TENANCY: 'installation' } as Record<string, unknown>,
      { installationId: 'inst_model_policy' },
    ) as PlatformEnv;
    const { f, service } = await workspace(t, hosted);
    configurePlatformFunding({
      funding: async () => 'platform',
      admit: async () => 'admitted',
      charge: async () => undefined,
      ...NO_RUN_FEES,
    });

    const snapshot = await inspect(service, ownerMcpContext(f));

    const anthropic = provider(snapshot, 'anthropic');
    assert.deepEqual(
      { available: anthropic.available, access: anthropic.access, source: anthropic.source },
      { available: true, access: 'platform', source: 'missing' },
    );
    assert.ok(snapshot.modelCatalog.chat.some(({ id }) => id === SONNET), 'a served model is in the catalog');
    assert.equal(snapshot.providers.some(({ id }) => id === 'workers-ai'), false,
      'as on Admin\'s Providers page, a deployment serving many offers no Workers AI');
  });
});

test('an Owner sets the Workspace models over MCP with Admin\'s checks, and undoes a change', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { f, settings, service, workspaceId } = await workspace(t);
    await storeKey(settings, 'openai');
    await f.config.putWorkspaceModelDefault({ workspaceId, modelId: OPUS, provenance: 'admin_selected' });
    const owner = ownerMcpContext(f);

    const chat = await apply(service, owner, [{
      itemId: 'chat', kind: 'set_workspace_model', role: 'chat', model: SOL, modelEffort: 'max', expectedRevision: 2,
    }]);
    assert.equal(chat.status, 'completed', JSON.stringify(chat));
    assert.equal(chat.outcomes[0]?.disposition, 'applied', 'Admin asks nothing, so MCP applies directly');
    assert.equal(chat.outcomes[0]?.undoAvailable, true);
    assert.equal(chat.outcomes[0]?.links?.admin, 'http://localhost/admin/settings/providers');
    assert.deepEqual(
      await f.config.getWorkspaceModelDefault(workspaceId).then((row) => [row?.modelId, row?.effort]),
      [SOL, 'max'],
    );
    const undone = await undo(service, owner, chat.operationId);
    assert.equal(undone.status, 'completed', JSON.stringify(undone));
    assert.deepEqual(
      await f.config.getWorkspaceModelDefault(workspaceId).then((row) => [row?.modelId, row?.effort, row?.revision]),
      [OPUS, undefined, 4],
    );

    const image = await apply(service, owner, [{
      itemId: 'image', kind: 'set_workspace_model', role: 'image', model: FLARE, expectedRevision: 0,
    }]);
    assert.equal(image.outcomes[0]?.disposition, 'applied', JSON.stringify(image));
    assert.equal((await f.config.getWorkspaceModelRole(workspaceId, 'image'))?.modelId, FLARE);

    const coding = await apply(service, owner, [{
      itemId: 'coding', kind: 'set_workspace_model', role: 'coding', model: SOL, modelEffort: 'low', expectedRevision: 0,
    }]);
    assert.equal(coding.outcomes[0]?.disposition, 'applied', JSON.stringify(coding));
    const cleared = await apply(service, owner, [{
      itemId: 'coding-clear', kind: 'set_workspace_model', role: 'coding', model: null, expectedRevision: 1,
    }]);
    assert.equal(cleared.outcomes[0]?.disposition, 'applied', JSON.stringify(cleared));
    assert.equal((await f.config.getWorkspaceModelRole(workspaceId, 'coding'))?.modelId, undefined);

    const refusals: Array<[ManagementOperation, string, RegExp]> = [
      [{ itemId: 'image-effort', kind: 'set_workspace_model', role: 'image', model: FLARE, modelEffort: 'low', expectedRevision: 1 },
        'invalid_request', /^The image model has no effort setting\.$/],
      [{ itemId: 'image-chat', kind: 'set_workspace_model', role: 'image', model: SOL, expectedRevision: 1 },
        'invalid_request', /^openai\/gpt-6\.1-sol is not an image model\.$/],
      [{ itemId: 'chat-unknown', kind: 'set_workspace_model', role: 'chat', model: 'openai/gpt-0-unknown', expectedRevision: 4 },
        'invalid_request', /^The active OpenAI API-key catalog does not support this model\.$/],
      [{ itemId: 'chat-clear', kind: 'set_workspace_model', role: 'chat', model: null, expectedRevision: 4 },
        'invalid_request', /cannot be cleared/],
      [{ itemId: 'coding-no-key', kind: 'set_workspace_model', role: 'coding', model: SONNET, expectedRevision: 2 },
        'invalid_request', /^Set up anthropic in Model providers before choosing anthropic\/claude-sonnet-5-5\.$/],
      [{ itemId: 'coding-effort', kind: 'set_workspace_model', role: 'coding', model: null, modelEffort: 'high', expectedRevision: 2 },
        'effort_requires_model', /^Choose a model before choosing an effort\./],
      [{ itemId: 'stale', kind: 'set_workspace_model', role: 'chat', model: SOL, expectedRevision: 2 },
        'revision_conflict', /./],
    ];
    for (const [operation, code, message] of refusals) {
      const refused = await apply(service, owner, [operation]);
      const [outcome] = refused.outcomes;
      assert.equal(outcome?.disposition, 'failed', `${operation.itemId}: ${JSON.stringify(refused)}`);
      assert.equal(outcome?.code, code, operation.itemId);
      assert.match(outcome?.instruction ?? '', message, operation.itemId);
    }
    assert.deepEqual(
      await f.config.getWorkspaceModelDefault(workspaceId).then((row) => [row?.modelId, row?.revision]),
      [OPUS, 4],
      'no refused change wrote the default',
    );
  });
});

test('an Agent\'s image model is set and undone with Admin\'s checks over MCP', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { f, settings, service } = await workspace(t);
    const owner = ownerMcpContext(f);
    const research = await f.config.createAgent(agentInput(f, 'agent_research'));

    const noKey = await apply(service, owner, [{
      itemId: 'no-key', kind: 'set_agent_image_model', agentId: research.id, expectedRevision: research.revision, model: FLARE,
    }]);
    assert.equal(noKey.outcomes[0]?.code, 'invalid_request');
    assert.equal(noKey.outcomes[0]?.instruction, `Add an OpenAI API key before choosing ${FLARE}.`);

    await storeKey(settings, 'openai');
    const chatModel = await apply(service, owner, [{
      itemId: 'chat-model', kind: 'set_agent_image_model', agentId: research.id, expectedRevision: research.revision, model: SOL,
    }]);
    assert.equal(chatModel.outcomes[0]?.instruction, `${SOL} is not an image model.`);

    const pinned = await apply(service, owner, [{
      itemId: 'pin', kind: 'set_agent_image_model', agentId: research.id, expectedRevision: research.revision, model: FLARE,
    }]);
    assert.equal(pinned.outcomes[0]?.disposition, 'applied', JSON.stringify(pinned));
    assert.equal(pinned.outcomes[0]?.undoAvailable, true);
    assert.equal((await f.config.getAgentModelRole(research.id, 'image'))?.modelId, FLARE);
    assert.equal(agent(await inspect(service, owner), research.id).imageModel, FLARE);

    const undone = await undo(service, owner, pinned.operationId);
    assert.equal(undone.status, 'completed', JSON.stringify(undone));
    assert.equal((await f.config.getAgentModelRole(research.id, 'image'))?.modelId, undefined);
  });
});

test('a Member reads the catalog, cannot set Workspace models, and sets the image model of an Agent they may edit', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { f, settings, service, workspaceId } = await workspace(t);
    await storeKey(settings, 'openai');
    await f.config.putWorkspaceModelDefault({ workspaceId, modelId: SOL, provenance: 'admin_selected' });
    const member = await addMember(f);
    const shared = await f.config.createAgent(agentInput(f, 'agent_shared', { editPolicy: 'all_workspace_members' }));
    const owners = await f.config.createAgent(agentInput(f, 'agent_owners'));

    const snapshot = await inspect(service, member);
    assert.equal(snapshot.workspaceModels, undefined, 'Workspace models are Admin settings');
    assert.deepEqual(snapshot.providers, []);
    assert.ok(snapshot.modelCatalog.chat.some(({ id }) => id === SOL), 'a Member picks models in Admin too');
    assert.equal(agent(snapshot, shared.id).effectiveModels.model, SOL);

    const workspaceChange = await apply(service, member, [{
      itemId: 'chat', kind: 'set_workspace_model', role: 'chat', model: SOL, expectedRevision: 2,
    }]);
    assert.equal(workspaceChange.outcomes[0]?.disposition, 'failed');
    assert.equal(workspaceChange.outcomes[0]?.code, 'operational_access_required');

    const own = await apply(service, member, [{
      itemId: 'shared', kind: 'set_agent_image_model', agentId: shared.id, expectedRevision: shared.revision, model: FLARE,
    }]);
    assert.equal(own.outcomes[0]?.disposition, 'applied', JSON.stringify(own));

    const other = await apply(service, member, [{
      itemId: 'owners', kind: 'set_agent_image_model', agentId: owners.id, expectedRevision: owners.revision, model: FLARE,
    }]);
    assert.equal(other.outcomes[0]?.disposition, 'failed', JSON.stringify(other));
    assert.equal((await f.config.getAgentModelRole(owners.id, 'image'))?.modelId, undefined);
  });
});

test('in Slack a Workspace model change waits for the person\'s approval and an Agent image model applies at once', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { f, settings, service, workspaceId } = await workspace(t);
    await storeKey(settings, 'openai');
    await f.config.putWorkspaceModelDefault({ workspaceId, modelId: OPUS, provenance: 'admin_selected' });
    const research = await f.config.createAgent(agentInput(f, 'agent_research', { name: 'Research' }));
    const dm = ownerSlackDmContext(f);

    const held = await apply(service, dm, [{
      itemId: 'chat', kind: 'set_workspace_model', role: 'chat', model: SOL, modelEffort: 'high', expectedRevision: 2,
    }, {
      itemId: 'image', kind: 'set_agent_image_model', agentId: research.id, expectedRevision: research.revision, model: FLARE,
    }]);
    const [outcome] = held.outcomes;
    assert.equal(outcome?.disposition, 'confirmation_required', JSON.stringify(held));
    assert.equal((await f.config.getWorkspaceModelDefault(workspaceId))?.modelId, OPUS, 'nothing applied yet');
    assert.equal((await f.config.getAgentModelRole(research.id, 'image'))?.modelId, undefined, 'the rest of the call waits too');
    const preview = held.presentation?.markdown ?? '';
    assert.match(preview, /\*\*Workspace — Default model\*\*\n\*\*Before\*\*\n> anthropic\/claude-opus-5-5\n\*\*After\*\*\n> openai\/gpt-6\.1-sol/);
    assert.match(preview, /\*\*Workspace — Default model effort\*\*\n\*\*Before\*\*\n> \(not set\)\n\*\*After\*\*\n> high/);
    assert.match(preview, /\*\*Research — Image model\*\*\n\*\*Before\*\*\n> \(not set\)\n\*\*After\*\*\n> openai\/gpt-image-2\.5-flare/);
    assert.match(held.presentation?.slack ?? '', /\*Workspace — Default model\*/);

    const approved = await service.confirmWorkspaceChange({
      context: withPersonApproval(dm, outcome!.proposalId!),
      proposalId: outcome!.proposalId!,
    });
    assert.equal(approved.status, 'completed', JSON.stringify(approved));
    assert.equal((await f.config.getWorkspaceModelDefault(workspaceId))?.modelId, SOL);
    assert.equal((await f.config.getAgentModelRole(research.id, 'image'))?.modelId, FLARE);

    const cleared = await apply(service, dm, [{
      itemId: 'image-clear', kind: 'set_agent_image_model', agentId: research.id,
      expectedRevision: (await f.config.getAgent(research.id)).revision, model: null,
    }]);
    assert.equal(cleared.outcomes[0]?.disposition, 'applied', JSON.stringify(cleared));
    assert.equal((await f.config.getAgentModelRole(research.id, 'image'))?.modelId, undefined);
  });
});

test('both doors accept the model operations and refuse a role or model they do not know', () => {
  const accepted: unknown[] = [
    { itemId: 'a', kind: 'set_workspace_model', role: 'chat', model: SOL, modelEffort: 'high', expectedRevision: 1 },
    { itemId: 'b', kind: 'set_workspace_model', role: 'coding', model: null, expectedRevision: 2 },
    { itemId: 'c', kind: 'set_agent_image_model', agentId: 'agent_research', expectedRevision: 3, model: null },
  ];
  const refused: unknown[] = [
    { itemId: 'd', kind: 'set_workspace_model', role: 'voice', model: SOL, expectedRevision: 1 },
    { itemId: 'e', kind: 'set_workspace_model', role: 'chat', model: 'no-provider', expectedRevision: 1 },
    { itemId: 'f', kind: 'set_agent_image_model', agentId: 'agent_research', expectedRevision: 3 },
  ];
  for (const operation of accepted) {
    assert.equal(managementOperationZodSchema.safeParse(operation).success, true, JSON.stringify(operation));
    assert.equal(v.safeParse(managementOperationValibotSchema, operation).success, true, JSON.stringify(operation));
  }
  for (const operation of refused) {
    assert.equal(managementOperationZodSchema.safeParse(operation).success, false, JSON.stringify(operation));
    assert.equal(v.safeParse(managementOperationValibotSchema, operation).success, false, JSON.stringify(operation));
  }
});
