import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { registerCloudflareBindingProvider } from '../src/cloudflare-provider.ts';
import { ModelResolutionError } from '../src/config/errors.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { rotateInstallationModelCredential } from '../src/config/model-credential-refs.ts';
import {
  imageCapabilityForResolution,
  resolveAgentModelForRole,
  resolveAgentModelPolicy,
  resolveAgentModelRoleFromStore,
  resolveCodingModelForPlan,
} from '../src/config/model-policy.ts';
import { configurePlatformFunding, resetPlatformFundingForTests } from '../src/config/platform-funding.ts';
import { invalidateProviderKeyCache, PROVIDER_KEY_SETTING_KEYS } from '../src/config/provider-keys.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import type { CustomAgentConfig, WorkspaceModelDefault } from '../src/config/types.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { useDeploymentKeyring } from './helpers/deployment-keyring.ts';
import { withEnv } from './helpers/env.ts';
import { OPENAI_SUBSCRIPTION_IMAGE_MODEL_ID } from '../src/model-catalog/image-profiles.ts';

function agent(overrides: Partial<CustomAgentConfig> = {}): CustomAgentConfig {
  return {
    id: 'agent_support',
    kind: overrides.kind ?? 'user',
    revision: 1,
    name: 'Support',
    instructions: 'Help customers.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
    ...overrides,
  };
}

const workspaceDefault: WorkspaceModelDefault = {
  workspaceId: 'TACME',
  modelId: 'openai/gpt-5.6-sol',
  revision: 4,
  provenance: 'admin_selected',
  lastChangedByMembershipId: 'membership_owner',
  createdAt: 1,
  updatedAt: 2,
};

test('Chickpea and inheriting user Agents freeze the same Workspace default revision', () => {
  const chickpea = resolveAgentModelPolicy({
    agent: agent({ id: 'agent_chickpea', name: 'Chickpea', kind: 'system' }),
    runtimeContract: 'chickpea-v1',
    workspaceDefault,
  });
  const support = resolveAgentModelPolicy({
    agent: agent(),
    runtimeContract: 'chickpea-v1',
    workspaceDefault,
  });

  assert.deepEqual(chickpea, support);
  assert.deepEqual(support, {
    model: 'openai/gpt-5.6-sol',
    attribution: {
      source: 'workspace_default',
      workspaceDefaultRevision: 4,
      providerId: 'openai',
      catalogRevision: '0',
    },
  });
});

test('a pinned user Agent ignores later Workspace default revisions', () => {
  const pinned = resolveAgentModelPolicy({
    agent: agent({ model: 'anthropic/claude-opus-4-1' }),
    runtimeContract: 'chickpea-v1',
    workspaceDefault,
  });
  const afterDefaultChange = resolveAgentModelPolicy({
    agent: agent({ model: 'anthropic/claude-opus-4-1' }),
    runtimeContract: 'chickpea-v1',
    workspaceDefault: { ...workspaceDefault, modelId: 'openai/gpt-5.7', revision: 5 },
  });

  assert.deepEqual(afterDefaultChange, pinned);
  assert.deepEqual(pinned.attribution, {
    source: 'pinned',
    providerId: 'anthropic',
    catalogRevision: '0',
  });
});

test('an activated catalog model removed from the supported lane returns static repair state', () => {
  assert.throws(
    () => resolveAgentModelPolicy({
      agent: agent(),
      runtimeContract: 'chickpea-v1',
      workspaceDefault: { ...workspaceDefault, modelId: 'openai/gpt-removed' },
    }),
    (error: unknown) => error instanceof Error &&
      error.name === 'ModelResolutionError' &&
      'repair' in error &&
      (error as { repair?: { status?: string; providerId?: string } }).repair?.status === 'unsupported' &&
      (error as { repair?: { status?: string; providerId?: string } }).repair?.providerId === 'openai',
  );
});

test('activated policy never falls back to SLACK_TAG_MODEL', () => {
  const { modelId: _modelId, ...unreadyDefault } = workspaceDefault;
  assert.throws(
    () => resolveAgentModelPolicy({
      agent: agent(),
      runtimeContract: 'chickpea-v1',
      workspaceDefault: unreadyDefault,
      env: { SLACK_TAG_MODEL: 'openai/should-not-run' },
    }),
    /Workspace default is not ready/,
  );
  assert.throws(
    () => resolveAgentModelPolicy({
      agent: agent({ id: 'agent_chickpea', name: 'Chickpea', kind: 'system', model: 'openai/no' }),
      runtimeContract: 'chickpea-v1',
      workspaceDefault,
    }),
    /Chickpea cannot use a pinned model/,
  );
});

test('legacy policy retains the environment fallback during Stage 1', () => {
  assert.deepEqual(resolveAgentModelPolicy({
    agent: agent(),
    runtimeContract: 'legacy',
    env: { SLACK_TAG_MODEL: 'openai/gpt-5.4' },
  }), {
    model: 'openai/gpt-5.4',
    attribution: { source: 'legacy_environment', providerId: 'openai' },
  });
});


test('Cloudflare compaction warning uses registered metadata instead of the provider prefix', (t) => {
  registerCloudflareBindingProvider({ run: async () => ({ response: 'unused' }) });
  const warnings = t.mock.method(console, 'warn', () => {});
  for (const model of ['cloudflare/@cf/zai-org/glm-5.3-flash', 'cloudflare/@cf/zai-org/glm-5.2']) {
    resolveAgentModelPolicy({ agent: agent({ model }), runtimeContract: 'chickpea-v1' });
  }
  assert.equal(warnings.mock.callCount(), 0);
  const unknown = { agent: agent({ model: 'cloudflare/@cf/test/unregistered' }), runtimeContract: 'chickpea-v1' } as const;
  resolveAgentModelPolicy(unknown);
  resolveAgentModelPolicy(unknown);
  assert.equal(warnings.mock.callCount(), 1);
  assert.match(String(warnings.mock.calls[0]?.arguments[0]), /no declared context window/);
});

const imageWorkspaceRole = { modelId: 'openai/gpt-image-2.5-flare' };
const credentialPresent = async () => true;

test('an Agent image pin wins over the Workspace image default', async () => {
  const resolved = await resolveAgentModelForRole({
    role: 'image',
    agent: agent(),
    agentRole: { modelId: 'openai/gpt-image-2.5-sunburst' },
    workspaceRole: imageWorkspaceRole,
    hasProviderCredential: credentialPresent,
  });

  assert.deepEqual(resolved, {
    modelId: 'openai/gpt-image-2.5-sunburst',
    providerId: 'openai',
    source: 'pinned',
  });
});

test('an Agent with no image pin follows the Workspace image default', async () => {
  assert.deepEqual(
    await resolveAgentModelForRole({
      role: 'image',
      agent: agent(),
      workspaceRole: imageWorkspaceRole,
      hasProviderCredential: credentialPresent,
    }),
    { modelId: 'openai/gpt-image-2.5-flare', providerId: 'openai', source: 'workspace_default' },
  );
  assert.deepEqual(
    await resolveAgentModelForRole({
      role: 'image',
      agent: agent({ id: 'agent_chickpea', kind: 'system' }),
      workspaceRole: imageWorkspaceRole,
      hasProviderCredential: credentialPresent,
    }),
    { modelId: 'openai/gpt-image-2.5-flare', providerId: 'openai', source: 'workspace_default' },
  );
});

test('an unfilled image role resolves to unset instead of throwing', async () => {
  assert.deepEqual(
    await resolveAgentModelForRole({
      role: 'image',
      agent: agent(),
      hasProviderCredential: credentialPresent,
    }),
    { unset: true, reason: 'role_unset' },
  );
});

test('an image model whose provider has no credential resolves to unset', async () => {
  const asked: string[] = [];
  assert.deepEqual(
    await resolveAgentModelForRole({
      role: 'image',
      agent: agent(),
      agentRole: { modelId: 'openai/gpt-image-2.5-sunburst' },
      workspaceRole: imageWorkspaceRole,
      hasProviderCredential: async (providerId) => {
        asked.push(providerId);
        return false;
      },
    }),
    { unset: true, reason: 'credential_missing' },
  );
  assert.deepEqual(asked, ['openai']);
});

test('Chickpea cannot pin an image model, exactly as it cannot pin a chat model', async () => {
  await assert.rejects(
    () => resolveAgentModelForRole({
      role: 'image',
      agent: agent({ id: 'agent_chickpea', name: 'Chickpea', kind: 'system' }),
      agentRole: { modelId: 'openai/gpt-image-2.5-sunburst' },
      workspaceRole: imageWorkspaceRole,
      hasProviderCredential: credentialPresent,
    }),
    (error: unknown) =>
      error instanceof ModelResolutionError &&
      /Chickpea cannot use a pinned image model/.test(error.message),
  );
});

test('the frozen image capability carries the shape, never the model id', async () => {
  const flare = await resolveAgentModelForRole({
    role: 'image',
    agent: agent(),
    workspaceRole: imageWorkspaceRole,
    hasProviderCredential: credentialPresent,
  });
  const sunburst = await resolveAgentModelForRole({
    role: 'image',
    agent: agent(),
    workspaceRole: { modelId: 'openai/gpt-image-2.5-sunburst' },
    hasProviderCredential: credentialPresent,
  });

  assert.deepEqual(imageCapabilityForResolution(flare), {
    role: 'image',
    filled: true,
    acceptsImageInput: true,
  });
  assert.deepEqual(imageCapabilityForResolution(flare), imageCapabilityForResolution(sunburst));
  assert.deepEqual(imageCapabilityForResolution({ unset: true, reason: 'role_unset' }), {
    role: 'image',
    filled: false,
    acceptsImageInput: false,
  });
  // An unknown model declares nothing, and an undeclared capability is absent.
  assert.deepEqual(
    imageCapabilityForResolution({
      modelId: 'openai/not-in-the-catalog',
      providerId: 'openai',
      source: 'pinned',
    }),
    { role: 'image', filled: true, acceptsImageInput: false },
  );
});

test('the subscription image capability freezes its one-output and provider-chosen controls', () => {
  assert.deepEqual(imageCapabilityForResolution({
    modelId: OPENAI_SUBSCRIPTION_IMAGE_MODEL_ID,
    providerId: 'openai',
    source: 'workspace_default',
  }), {
    role: 'image',
    filled: true,
    acceptsImageInput: false,
    maxOutputsPerCall: 1,
    supportsOutputControls: false,
  });
});

test('a cleared Workspace role row resolves unset, not to a stale model', async () => {
  // Clearing the Workspace default leaves the row in place with its revision
  // bumped and no model. Resolution must read that as unset so the compile path
  // freezes an unfilled capability instead of reaching for an adapter.
  const resolved = await resolveAgentModelRoleFromStore({
    role: 'image',
    workspaceId: 'TACME',
    agent: agent(),
    reader: {
      async getWorkspaceModelRole(workspaceId, role) {
        return {
          workspaceId,
          role,
          revision: 2,
          createdAt: 1,
          updatedAt: 2,
        };
      },
      async getAgentModelRole() {
        return undefined;
      },
    },
    hasProviderCredential: credentialPresent,
  });

  assert.deepEqual(resolved, { unset: true, reason: 'role_unset' });
  assert.deepEqual(
    imageCapabilityForResolution(resolved),
    { role: 'image', filled: false, acceptsImageInput: false },
  );
});

test('role resolution reads both rows from the store for one Agent and Workspace', async () => {
  const reads: string[] = [];
  const resolved = await resolveAgentModelRoleFromStore({
    role: 'image',
    workspaceId: 'TACME',
    agent: agent(),
    reader: {
      async getWorkspaceModelRole(workspaceId, role) {
        reads.push(`workspace:${workspaceId}:${role}`);
        return undefined;
      },
      async getAgentModelRole(agentId, role) {
        reads.push(`agent:${agentId}:${role}`);
        return {
          agentId,
          role,
          modelId: 'openai/gpt-image-2.5-flare',
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        };
      },
    },
    hasProviderCredential: credentialPresent,
  });

  assert.deepEqual(resolved, {
    modelId: 'openai/gpt-image-2.5-flare',
    providerId: 'openai',
    source: 'pinned',
  });
  assert.deepEqual(reads.sort(), ['agent:agent_support:image', 'workspace:TACME:image']);
});

// The tests below exercise the production credential gate,
// `defaultProviderCredentialCheck`, by omitting `hasProviderCredential` so
// resolution falls through to the real `isProviderKeyId` +
// `describeProviderKeySources` path production actually runs (see
// src/agents/slack-thread.ts and the run-turn compile path, neither of which
// supplies a stub). Every other test in this file injects
// `hasProviderCredential`, which bypasses this gate entirely.

test('a stored OpenAI key fills the image role via the real credential gate', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting(PROVIDER_KEY_SETTING_KEYS.openai, 'sk-stored-image-role-key');

    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const resolved = await resolveAgentModelForRole({
        role: 'image',
        agent: agent(),
        workspaceRole: imageWorkspaceRole,
        settings,
      });

      assert.deepEqual(resolved, {
        modelId: 'openai/gpt-image-2.5-flare',
        providerId: 'openai',
        source: 'workspace_default',
      });
    });
  } finally {
    settings.close();
  }
});

test('a missing OpenAI key resolves the image role to credential_missing via the real credential gate', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const resolved = await resolveAgentModelForRole({
        role: 'image',
        agent: agent(),
        workspaceRole: imageWorkspaceRole,
        settings,
      });

      assert.deepEqual(resolved, { unset: true, reason: 'credential_missing' });
    });
  } finally {
    settings.close();
  }
});

test('an env OpenAI key fills the image role via the real credential gate, ahead of a stored key', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    // Deliberately leave no stored key: the env var alone must satisfy the
    // gate, proving the check is not silently reading only the settings row.
    await withEnv({ OPENAI_API_KEY: 'sk-env-image-role-key' }, async () => {
      const resolved = await resolveAgentModelForRole({
        role: 'image',
        agent: agent(),
        workspaceRole: imageWorkspaceRole,
        settings,
      });

      assert.deepEqual(resolved, {
        modelId: 'openai/gpt-image-2.5-flare',
        providerId: 'openai',
        source: 'workspace_default',
      });
    });
  } finally {
    settings.close();
  }
});

test('a provider id with no key lane resolves credential_missing via the real credential gate, even with unrelated credentials present', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting(PROVIDER_KEY_SETTING_KEYS.openai, 'sk-unrelated-provider-key');

    await withEnv({ OPENAI_API_KEY: 'sk-unrelated-env-key' }, async () => {
      const resolved = await resolveAgentModelForRole({
        role: 'image',
        agent: agent(),
        // workers-ai is a real, known provider id but has no key-bearing
        // lane (no PROVIDER_KEY_SETTING_KEYS / PROVIDER_KEY_ENV_VARS entry),
        // so the gate must short-circuit via `isProviderKeyId` rather than
        // ever looking up a key source for 'workers-ai'.
        workspaceRole: { modelId: 'workers-ai/@cf/black-forest-labs/flux-2-schnell' },
        settings,
      });

      assert.deepEqual(resolved, { unset: true, reason: 'credential_missing' });
    });
  } finally {
    settings.close();
  }
});

test('a connected Node subscription fills the generic image role without an API key', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.setSetting('openai.subscription.status', JSON.stringify({
      version: 1,
      state: 'connected',
      updatedAt: 1,
      connectedAt: 1,
    }));
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const resolved = await resolveAgentModelForRole({
        role: 'image',
        agent: agent(),
        workspaceRole: { modelId: OPENAI_SUBSCRIPTION_IMAGE_MODEL_ID },
        settings,
      });
      assert.deepEqual(resolved, {
        modelId: OPENAI_SUBSCRIPTION_IMAGE_MODEL_ID,
        providerId: 'openai',
        source: 'workspace_default',
      });
    });
  } finally {
    settings.close();
  }
});

test('the provider credential seam cannot enable subscription images on Cloudflare', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Cloudflare-Workers' },
  });
  try {
    const resolved = await resolveAgentModelForRole({
      role: 'image',
      agent: agent(),
      workspaceRole: { modelId: OPENAI_SUBSCRIPTION_IMAGE_MODEL_ID },
      hasProviderCredential: async () => true,
    });
    assert.deepEqual(resolved, { unset: true, reason: 'credential_missing' });
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

const NOW = Date.UTC(2026, 9, 7, 12);
const AFTER_IMAGE_PRICES_STALE = Date.UTC(2027, 6, 1);
const NO_DEPLOYMENT_KEYS = {
  CHICKPEA_TENANCY: undefined,
  ANTHROPIC_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  OPENAI_BASE_URL: undefined,
};
const FLARE_FROM_WORKSPACE = {
  modelId: 'openai/gpt-image-2.5-flare',
  providerId: 'openai',
  source: 'workspace_default' as const,
};

/** One installation of a deployment serving many, with the host's funding answer and no saved key. */
function hostedInstallation(t: TestContext, funding: () => Promise<'platform' | 'customer'>) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  t.mock.method(console, 'warn', () => {});
  resetPlatformFundingForTests();
  invalidateProviderKeyCache();
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  t.after(() => {
    settings.close();
    usage.close();
    resetPlatformFundingForTests();
    invalidateProviderKeyCache();
  });
  configurePlatformFunding({
    funding,
    admit: async () => 'admitted',
    charge: async () => {},
    priceMultiplier: async () => 1,
  });
  const env = scopeInstallationEnv(
    { CHICKPEA_TENANCY: 'installation' },
    { installationId: 'inst_credits' },
  ) as PlatformEnv;
  const imageRole = () => resolveAgentModelForRole({
    role: 'image',
    agent: agent(),
    workspaceRole: imageWorkspaceRole,
    env,
    settings,
  });
  return { env, settings, usage, imageRole };
}

test('Chickpea credits fill the image role of a platform-funded installation that saved no key', async (t) => {
  const { imageRole } = hostedInstallation(t, async () => 'platform');
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    assert.deepEqual(await imageRole(), FLARE_FROM_WORKSPACE);
    t.mock.timers.setTime(AFTER_IMAGE_PRICES_STALE);
    assert.deepEqual(
      await imageRole(),
      { unset: true, reason: 'credential_missing' },
      'credits serve only a model with a current price',
    );
  });
});

test('a customer-funded installation that saved no key still resolves the image role to credential_missing', async (t) => {
  const { imageRole } = hostedInstallation(t, async () => 'customer');
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    assert.deepEqual(await imageRole(), { unset: true, reason: 'credential_missing' });
  });
});

test('a funding read that fails leaves the image role on the installation\'s own key', async (t) => {
  const keyring = useDeploymentKeyring(t);
  const { env, settings, usage, imageRole } = hostedInstallation(t, async () => {
    throw new Error('billing registry unreachable');
  });
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    assert.deepEqual(await imageRole(), { unset: true, reason: 'credential_missing' });
    await rotateInstallationModelCredential(
      'openai',
      { kind: 'save', apiKey: 'sk-saved-openai-key' },
      { env, settings, usage, keyring },
    );
    assert.deepEqual(await imageRole(), FLARE_FROM_WORKSPACE);
  });
});

function codingReader(workspaceModel?: string, agentModel?: string) {
  return {
    async getWorkspaceModelRole(workspaceId: string, role: 'image' | 'coding') {
      return role === 'coding' && workspaceModel
        ? { workspaceId, role, modelId: workspaceModel, revision: 1, createdAt: 1, updatedAt: 1 }
        : undefined;
    },
    async getAgentModelRole(agentId: string, role: 'image' | 'coding') {
      return role === 'coding' && agentModel
        ? { agentId, role, modelId: agentModel, revision: 1, createdAt: 1, updatedAt: 1 }
        : undefined;
    },
  };
}

const AGENT_ROUTE = { model: 'openai/gpt-5.6-sol', runtimeModel: 'openai/gpt-5.6-sol' };

test('an unset coding role runs on the Agent model without calling it a fallback', async () => {
  let resolved = 0;
  const frozen = await resolveCodingModelForPlan({
    workspaceId: 'T1',
    agent: agent(),
    reader: codingReader(),
    agentRoute: AGENT_ROUTE,
    resolveRoute: async () => {
      resolved += 1;
      return { runtimeModel: 'unused' };
    },
  });
  assert.equal(resolved, 0);
  assert.deepEqual(frozen, {
    ...AGENT_ROUTE,
    attribution: { role: 'coding', source: 'agent_model', providerId: 'openai', fallback: false },
  });
});

test('the coding role resolves pinned, then Workspace default, to its own route', async () => {
  const resolveRoute = async (model: string) => ({ runtimeModel: `route:${model}` });
  const workspace = await resolveCodingModelForPlan({
    workspaceId: 'T1',
    agent: agent(),
    reader: codingReader('anthropic/claude-opus-5-5'),
    agentRoute: AGENT_ROUTE,
    resolveRoute,
  });
  assert.deepEqual(workspace, {
    model: 'anthropic/claude-opus-5-5',
    runtimeModel: 'route:anthropic/claude-opus-5-5',
    attribution: { role: 'coding', source: 'workspace_default', providerId: 'anthropic', fallback: false },
  });
  const pinned = await resolveCodingModelForPlan({
    workspaceId: 'T1',
    agent: agent(),
    reader: codingReader('anthropic/claude-opus-5-5', 'anthropic/claude-fable-5-1'),
    agentRoute: AGENT_ROUTE,
    resolveRoute,
  });
  assert.equal(pinned.model, 'anthropic/claude-fable-5-1');
  assert.equal(pinned.attribution.source, 'pinned');

  // A role naming the Agent's own model reuses its frozen route.
  const same = await resolveCodingModelForPlan({
    workspaceId: 'T1',
    agent: agent(),
    reader: codingReader(AGENT_ROUTE.model),
    agentRoute: { ...AGENT_ROUTE, runtimeModel: 'frozen-agent-route' },
    resolveRoute: async () => assert.fail('the Agent route is already frozen'),
  });
  assert.equal(same.runtimeModel, 'frozen-agent-route');
  assert.equal(same.attribution.source, 'workspace_default');
});

test('a coding model that cannot be used falls back silently to the Agent model', async () => {
  const frozen = await resolveCodingModelForPlan({
    workspaceId: 'T1',
    agent: agent(),
    reader: codingReader('anthropic/claude-opus-5-5'),
    agentRoute: AGENT_ROUTE,
    resolveRoute: async () => {
      throw new ModelResolutionError('No anthropic key.');
    },
  });
  assert.deepEqual(frozen, {
    ...AGENT_ROUTE,
    attribution: { role: 'coding', source: 'agent_model', providerId: 'openai', fallback: true },
  });

  // The system Agent may not hold a pin; its turn still gets the Agent model.
  const system = await resolveCodingModelForPlan({
    workspaceId: 'T1',
    agent: agent({ kind: 'system' }),
    reader: codingReader(undefined, 'anthropic/claude-opus-5-5'),
    agentRoute: AGENT_ROUTE,
    resolveRoute: async () => assert.fail('a refused pin never resolves'),
  });
  assert.equal(system.model, AGENT_ROUTE.model);
  assert.equal(system.attribution.fallback, true);
});
