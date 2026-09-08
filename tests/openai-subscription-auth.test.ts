import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import {
  OpenAiSubscriptionError,
} from '../src/openai-subscription/errors.ts';
import {
  cancelOpenAiSubscriptionAuthorization,
  confirmOpenAiSubscriptionAccountChange,
  getOpenAiSubscriptionAuthorizationStatus,
  pollOpenAiSubscriptionAuthorization,
  startOpenAiSubscriptionAuthorization,
  type OpenAiSubscriptionAuthorizationDependencies,
} from '../src/openai-subscription/device-auth.ts';
import type {
  OpenAiDeviceAuthorizationPending,
  OpenAiDeviceAuthorizationPoll,
  OpenAiSubscriptionTokenBundle,
} from '../src/openai-subscription/types.ts';

const START_TIME = 1_800_000_000_000;

function tokenBundle(accountId = 'account-primary'): OpenAiSubscriptionTokenBundle {
  return {
    accessToken: `access-${accountId}`,
    refreshToken: `refresh-${accountId}`,
    idToken: `identity-${accountId}`,
    expiresAt: START_TIME + 3_600_000,
    accountId,
  };
}

function authorizationHarness(options: {
  accountId?: string;
  pollStates?: OpenAiDeviceAuthorizationPoll[];
} = {}) {
  let currentTime = START_TIME;
  let startCalls = 0;
  let pollCalls = 0;
  let exchangeCalls = 0;
  const pending: OpenAiDeviceAuthorizationPending = {
    deviceAuthId: 'device-auth-secret',
    userCode: 'CHICK-PEA',
    verificationUri: 'https://auth.openai.com/codex/device',
    intervalMs: 5_000,
    expiresAt: START_TIME + 60_000,
  };
  const pollStates = [...(options.pollStates ?? [{ state: 'pending' }, {
    state: 'approved',
    authorizationCode: 'authorization-code-secret',
    codeVerifier: 'code-verifier-secret',
  }])];
  let randomCounter = 0;
  const protocol = {
    start: async () => {
      startCalls += 1;
      return pending;
    },
    poll: async () => {
      pollCalls += 1;
      return pollStates.shift() ?? { state: 'pending' as const };
    },
    exchange: async () => {
      exchangeCalls += 1;
      return tokenBundle(options.accountId);
    },
  };
  const dependencies = (settings: SqliteSettingsStore): OpenAiSubscriptionAuthorizationDependencies => ({
    settings,
    protocol,
    now: () => currentTime,
    randomBytes: (length) => {
      randomCounter += 1;
      return new Uint8Array(length).fill(randomCounter);
    },
  });
  return {
    dependencies,
    get startCalls() { return startCalls; },
    get pollCalls() { return pollCalls; },
    get exchangeCalls() { return exchangeCalls; },
    advance(ms: number) { currentTime += ms; },
  };
}

test('device authorization requires its browser capability and polls at most once per interval', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const harness = authorizationHarness();
  const dependencies = harness.dependencies(settings);

  const started = await startOpenAiSubscriptionAuthorization(dependencies);
  assert.equal(started.userCode, 'CHICK-PEA');
  assert.equal(started.nextPollAt, START_TIME + 5_000);
  assert.ok(started.attemptCapability.length >= 32);
  assert.equal(harness.startCalls, 1);

  await assert.rejects(
    () => startOpenAiSubscriptionAuthorization(dependencies),
    (error: unknown) =>
      error instanceof OpenAiSubscriptionError && error.code === 'authorization_rate_limited',
  );
  await assert.rejects(
    () => pollOpenAiSubscriptionAuthorization({ attemptCapability: 'wrong-browser' }, dependencies),
    (error: unknown) =>
      error instanceof OpenAiSubscriptionError && error.code === 'attempt_forbidden',
  );
  assert.equal(harness.pollCalls, 0);

  assert.deepEqual(
    await pollOpenAiSubscriptionAuthorization(
      { attemptCapability: started.attemptCapability },
      dependencies,
    ),
    { state: 'pending', expiresAt: START_TIME + 60_000, nextPollAt: START_TIME + 5_000 },
  );
  assert.equal(harness.pollCalls, 0);

  harness.advance(5_000);
  const pending = await Promise.all([
    pollOpenAiSubscriptionAuthorization({ attemptCapability: started.attemptCapability }, dependencies),
    pollOpenAiSubscriptionAuthorization({ attemptCapability: started.attemptCapability }, dependencies),
  ]);
  assert.deepEqual(pending, [
    { state: 'pending', expiresAt: START_TIME + 60_000, nextPollAt: START_TIME + 10_000 },
    { state: 'pending', expiresAt: START_TIME + 60_000, nextPollAt: START_TIME + 10_000 },
  ]);
  assert.equal(harness.pollCalls, 1);

  harness.advance(5_000);
  const connected = await pollOpenAiSubscriptionAuthorization(
    { attemptCapability: started.attemptCapability },
    dependencies,
  );
  assert.equal(connected.state, 'connected');
  assert.equal(harness.pollCalls, 2);
  assert.equal(harness.exchangeCalls, 1);

  const serialized = JSON.stringify({ started: { ...started, attemptCapability: '[removed]' }, connected });
  for (const secret of [
    'device-auth-secret',
    'authorization-code-secret',
    'code-verifier-secret',
    'access-account-primary',
    'refresh-account-primary',
    'identity-account-primary',
    'account-primary',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
});

test('pending authorization survives a process boundary and can be cancelled only once', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const harness = authorizationHarness();
  const started = await startOpenAiSubscriptionAuthorization(harness.dependencies(settings));

  const statusFromAnotherInstance = await getOpenAiSubscriptionAuthorizationStatus(settings);
  assert.deepEqual(statusFromAnotherInstance, {
    state: 'authorizing',
    updatedAt: START_TIME,
  });
  assert.deepEqual(
    await cancelOpenAiSubscriptionAuthorization(
      { attemptCapability: started.attemptCapability },
      harness.dependencies(settings),
    ),
    { state: 'disconnected', updatedAt: START_TIME },
  );
  await assert.rejects(
    () => cancelOpenAiSubscriptionAuthorization(
      { attemptCapability: started.attemptCapability },
      harness.dependencies(settings),
    ),
    (error: unknown) =>
      error instanceof OpenAiSubscriptionError && error.code === 'authorization_missing',
  );

  const restarted = await startOpenAiSubscriptionAuthorization(harness.dependencies(settings));
  assert.notEqual(restarted.attemptCapability, started.attemptCapability);
  assert.equal(harness.startCalls, 2);
});

test('expired authorization is removed without a provider poll', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const harness = authorizationHarness();
  const dependencies = harness.dependencies(settings);
  const started = await startOpenAiSubscriptionAuthorization(dependencies);
  harness.advance(60_001);

  await assert.rejects(
    () => pollOpenAiSubscriptionAuthorization(
      { attemptCapability: started.attemptCapability },
      dependencies,
    ),
    (error: unknown) =>
      error instanceof OpenAiSubscriptionError && error.code === 'authorization_expired',
  );
  assert.equal(harness.pollCalls, 0);
  assert.deepEqual(await getOpenAiSubscriptionAuthorizationStatus(settings), {
    state: 'disconnected',
    updatedAt: START_TIME + 60_001,
    failureCode: 'authorization_expired',
  });
});

test('a changed subscription account stays inactive until explicit confirmation', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());

  const first = authorizationHarness({ pollStates: [{
    state: 'approved',
    authorizationCode: 'authorization-code-secret',
    codeVerifier: 'code-verifier-secret',
  }] });
  const firstStart = await startOpenAiSubscriptionAuthorization(first.dependencies(settings));
  first.advance(5_000);
  const original = await pollOpenAiSubscriptionAuthorization(
    { attemptCapability: firstStart.attemptCapability },
    first.dependencies(settings),
  );
  assert.equal(original.state, 'connected');

  const changed = authorizationHarness({ accountId: 'account-replacement', pollStates: [{
    state: 'approved',
    authorizationCode: 'authorization-code-secret',
    codeVerifier: 'code-verifier-secret',
  }] });
  const changedStart = await startOpenAiSubscriptionAuthorization(changed.dependencies(settings));
  changed.advance(5_000);
  const awaitingConfirmation = await pollOpenAiSubscriptionAuthorization(
    { attemptCapability: changedStart.attemptCapability },
    changed.dependencies(settings),
  );
  assert.equal(awaitingConfirmation.state, 'account_change_confirmation_required');
  assert.notEqual(awaitingConfirmation.accountFingerprint, original.accountFingerprint);

  const confirmed = await confirmOpenAiSubscriptionAccountChange(
    { attemptCapability: changedStart.attemptCapability },
    changed.dependencies(settings),
  );
  assert.equal(confirmed.state, 'connected');
  assert.equal(confirmed.accountFingerprint, awaitingConfirmation.accountFingerprint);
});
