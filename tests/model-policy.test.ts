import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAgentModelPolicy } from '../src/config/model-policy.ts';
import type { CustomAgentConfig, WorkspaceModelDefault } from '../src/config/types.ts';

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
