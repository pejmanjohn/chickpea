import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  beginOnboardingJourney,
  completeOnboardingJourney,
  ONBOARDING_JOURNEY_KEY,
  parseOnboardingJourney,
  readOnboardingJourney,
  startOnboardingTry,
} from '../src/config/onboarding-state.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';

test('onboarding journey is resumable and completes monotonically', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const begun = await beginOnboardingJourney(settings, 100);
  assert.equal((await beginOnboardingJourney(settings, 200)).revision, begun.revision);

  const trying = await startOnboardingTry(settings, {
    expectedRevision: begun.revision,
    workspaceId: 'T123',
    channelId: 'C456',
    channelName: '#general',
    tryStartedAt: 300,
  });
  assert.equal(trying.journey.selectedChannelName, 'general');
  const completed = await completeOnboardingJourney(settings, trying.revision, 400);
  assert.equal(completed.journey.state, 'complete');
  assert.equal((await readOnboardingJourney(settings))?.journey.completedAt, 400);
  assert.equal((await completeOnboardingJourney(settings, completed.revision, 500)).revision, completed.revision);
  settings.close();
});

test('onboarding journey rejects stale and malformed state', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const begun = await beginOnboardingJourney(settings, 100);
  const trying = await startOnboardingTry(settings, {
    expectedRevision: begun.revision,
    workspaceId: 'T123',
    channelId: 'C456',
    channelName: 'general',
    tryStartedAt: 300,
  });
  await assert.rejects(() => startOnboardingTry(settings, {
    expectedRevision: begun.revision,
    workspaceId: 'T123',
    channelId: 'C999',
    channelName: 'random',
  }), /concurrently/);
  assert.equal((await readOnboardingJourney(settings))?.revision, trying.revision);

  await settings.setSetting(ONBOARDING_JOURNEY_KEY, '{"version":1,"state":"complete"}');
  await assert.rejects(() => readOnboardingJourney(settings), /invalid/);
  assert.throws(() => parseOnboardingJourney('{}'), /invalid/);
  settings.close();
});

test('onboarding v2 rejects the old application schema instead of dual-reading it', () => {
  assert.equal(ONBOARDING_JOURNEY_KEY, 'onboarding.journey.v2');
  assert.throws(
    () => parseOnboardingJourney('{"version":1,"state":"active","startedAt":100}'),
    /invalid/,
  );
});
