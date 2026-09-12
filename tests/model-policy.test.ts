import assert from 'node:assert/strict';
import test from 'node:test';

import { registerCloudflareBindingProvider } from '../src/cloudflare-provider.ts';
import { ModelResolutionError } from '../src/config/errors.ts';
import {
  imageCapabilityForResolution,
  resolveAgentModelForRole,
  resolveAgentModelPolicy,
  resolveAgentModelRoleFromStore,
} from '../src/config/model-policy.ts';
import { PROVIDER_KEY_SETTING_KEYS } from '../src/config/provider-keys.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { CustomAgentConfig, WorkspaceModelDefault } from '../src/config/types.ts';
import { withEnv } from './helpers/env.ts';

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
// `resolveProviderApiKey` path production actually runs (see
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
        // ever calling `resolveProviderApiKey('workers-ai', ...)`.
        workspaceRole: { modelId: 'workers-ai/@cf/black-forest-labs/flux-2-schnell' },
        settings,
      });

      assert.deepEqual(resolved, { unset: true, reason: 'credential_missing' });
    });
  } finally {
    settings.close();
  }
});
