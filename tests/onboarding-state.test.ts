import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  beginOnboardingJourney,
  completeOnboardingJourney,
  ONBOARDING_JOURNEY_KEY,
  parseOnboardingJourney,
  readOnboardingJourney,
  selectOnboardingProvider,
  startOnboardingTry,
} from '../src/config/onboarding-state.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';

test('onboarding journey is resumable and completes monotonically', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const begun = await beginOnboardingJourney(settings, 100);
  assert.equal((await beginOnboardingJourney(settings, 200)).revision, begun.revision);

  const providerSelected = await selectOnboardingProvider(settings, {
    expectedRevision: begun.revision,
    workspaceId: 'T123',
    providerId: 'anthropic',
  });
  assert.equal(providerSelected.journey.selectedWorkspaceId, 'T123');
  assert.equal(providerSelected.journey.selectedProviderId, 'anthropic');

  const trying = await startOnboardingTry(settings, {
    expectedRevision: providerSelected.revision,
    agentId: 'agent_chickpea',
    modelId: 'anthropic/claude-sonnet-5',
    slackUserId: 'U123',
    tryStartedAt: 300,
  });
  assert.equal(trying.journey.agentId, 'agent_chickpea');
  assert.equal(trying.journey.selectedModelId, 'anthropic/claude-sonnet-5');
  assert.equal(trying.journey.trySlackUserId, 'U123');
  const completed = await completeOnboardingJourney(settings, trying.revision, 400);
  assert.equal(completed.journey.state, 'complete');
  assert.equal((await readOnboardingJourney(settings))?.journey.completedAt, 400);
  assert.equal((await completeOnboardingJourney(settings, completed.revision, 500)).revision, completed.revision);
  settings.close();
});

test('onboarding journey rejects stale and malformed state', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const begun = await beginOnboardingJourney(settings, 100);
  const providerSelected = await selectOnboardingProvider(settings, {
    expectedRevision: begun.revision,
    workspaceId: 'T123',
    providerId: 'openai',
  });
  const trying = await startOnboardingTry(settings, {
    expectedRevision: providerSelected.revision,
    agentId: 'agent_chickpea',
    modelId: 'openai/gpt-5.6-terra',
    slackUserId: 'U123',
    tryStartedAt: 300,
  });
  await assert.rejects(() => selectOnboardingProvider(settings, {
    expectedRevision: begun.revision,
    workspaceId: 'T123',
    providerId: 'anthropic',
  }), /concurrently/);
  assert.equal((await readOnboardingJourney(settings))?.revision, trying.revision);

  await settings.setSetting(ONBOARDING_JOURNEY_KEY, '{"version":1,"state":"complete"}');
  await assert.rejects(() => readOnboardingJourney(settings), /invalid/);
  assert.throws(() => parseOnboardingJourney('{}'), /invalid/);
  settings.close();
});

test('onboarding provider and model selections stay ordered and provider-scoped', () => {
  const workspace = {
    version: 2,
    state: 'active',
    startedAt: 100,
    selectedWorkspaceId: 'T123',
  };
  assert.throws(
    () => parseOnboardingJourney(JSON.stringify({
      version: 2,
      state: 'active',
      startedAt: 100,
      selectedProviderId: 'anthropic',
    })),
    /invalid/,
  );
  assert.throws(
    () => parseOnboardingJourney(JSON.stringify({
      ...workspace,
      agentId: 'agent_chickpea',
      selectedProviderId: 'anthropic',
      selectedModelId: 'openai/gpt-5.6-terra',
      trySlackUserId: 'U123',
      tryStartedAt: 300,
    })),
    /invalid/,
  );
  assert.equal(
    parseOnboardingJourney(JSON.stringify({
      ...workspace,
      agentId: 'agent_chickpea',
      selectedProviderId: 'cloudflare',
      selectedModelId: 'cloudflare/@cf/zai-org/glm-5.2',
      trySlackUserId: 'U123',
      tryStartedAt: 300,
    })).selectedModelId,
    'cloudflare/@cf/zai-org/glm-5.2',
  );
});

test('onboarding continues to read journeys that reached Try before provider selection existed', () => {
  const legacy = parseOnboardingJourney(JSON.stringify({
    version: 2,
    state: 'active',
    startedAt: 100,
    agentId: 'agent_default',
    selectedWorkspaceId: 'T123',
    selectedChannelId: 'C456',
    selectedChannelName: 'general',
    tryStartedAt: 300,
  }));
  assert.equal(legacy.tryStartedAt, 300);
  assert.equal(legacy.selectedProviderId, undefined);
});

test('onboarding v2 rejects the old application schema instead of dual-reading it', () => {
  assert.equal(ONBOARDING_JOURNEY_KEY, 'onboarding.journey.v2');
  assert.throws(
    () => parseOnboardingJourney('{"version":1,"state":"active","startedAt":100}'),
    /invalid/,
  );
});
