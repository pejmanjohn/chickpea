import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { resolveOpenAiAuthMethod } from '../src/config/openai-auth.ts';
import { CfSettingsStore } from '../src/config/cf-state-proxies.ts';
import type { SettingsPatch, SettingsStore } from '../src/config/settings-store.ts';
import type { TagStateRpc } from '../src/config/state-rpc.ts';
import {
  commitOpenAiSubscriptionCredentials,
  disconnectOpenAiSubscription,
  getOpenAiSubscriptionCredentialStatus,
  openAiSubscriptionSettingKeys,
  recordOpenAiSubscriptionAuthenticationFailure,
  resolveOpenAiSubscriptionCredentials,
} from '../src/openai-subscription/credentials.ts';
import { OpenAiSubscriptionError } from '../src/openai-subscription/errors.ts';
import {
  cancelOpenAiSubscriptionAuthorization,
  startOpenAiSubscriptionAuthorization,
} from '../src/openai-subscription/device-auth.ts';
import { accountFingerprint } from '../src/openai-subscription/identity.ts';
import { OpenAiSubscriptionProtocolError } from '../src/openai-subscription/protocol.ts';
import type { OpenAiSubscriptionTokenBundle } from '../src/openai-subscription/types.ts';

const START_TIME = 1_800_000_000_000;

function bundle(overrides: Partial<OpenAiSubscriptionTokenBundle> = {}): OpenAiSubscriptionTokenBundle {
  return {
    accessToken: 'access-original',
    refreshToken: 'refresh-original',
    idToken: 'identity-original',
    expiresAt: START_TIME + 30_000,
    accountId: 'account-primary',
    ...overrides,
  };
}

function randomBytes(fill: number) {
  return (length: number) => new Uint8Array(length).fill(fill);
}

function proxySettings(backing: SettingsStore): CfSettingsStore {
  const stub = {
    settingGet: async (key: string) => ({
      ok: true as const,
      value: (await backing.getSetting(key)) ?? null,
    }),
    settingGetMany: async (keys: readonly string[]) => ({
      ok: true as const,
      value: (await backing.getSettings(keys)).map((value) => value ?? null),
    }),
    settingSet: async (key: string, value: string) => {
      await backing.setSetting(key, value);
      return { ok: true as const, value: null };
    },
    settingDelete: async (key: string) => {
      await backing.deleteSetting(key);
      return { ok: true as const, value: null };
    },
    settingApplyPatch: async (patch: SettingsPatch) => ({
      ok: true as const,
      value: await backing.applySettingsPatch(patch),
    }),
    settingMergeStringSet: async (key: string, values: readonly string[]) => ({
      ok: true as const,
      value: await backing.mergeSettingStringSet(key, values),
    }),
  } as unknown as TagStateRpc;
  return new CfSettingsStore(stub);
}

test('account fingerprints are stable with a persisted key and change when the key is lost', async () => {
  const first = await accountFingerprint('account-primary', new Uint8Array(32).fill(1));
  const same = await accountFingerprint('account-primary', new Uint8Array(32).fill(1));
  const rotated = await accountFingerprint('account-primary', new Uint8Array(32).fill(2));
  assert.equal(first, same);
  assert.notEqual(first, rotated);
  assert.match(first, /^oas_[A-Za-z0-9_-]{22}$/);
});

test('credential state and identity survive a Durable Object proxy round-trip', async (t) => {
  const backing = new SqliteSettingsStore(':memory:');
  t.after(() => backing.close());
  const firstProxy = proxySettings(backing);
  const connected = await commitOpenAiSubscriptionCredentials(
    bundle({ expiresAt: START_TIME + 3_600_000 }),
    { settings: firstProxy, now: () => START_TIME, randomBytes: randomBytes(7) },
  );

  const secondProxy = proxySettings(backing);
  assert.deepEqual(await getOpenAiSubscriptionCredentialStatus(secondProxy), connected);
  assert.deepEqual(
    await resolveOpenAiSubscriptionCredentials({ settings: secondProxy, now: () => START_TIME }),
    {
      accessToken: 'access-original',
      accountId: 'account-primary',
      accountFingerprint: connected.accountFingerprint,
    },
  );
});

test('concurrent refreshes share one rotation and retain an omitted replacement refresh token', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const connected = await commitOpenAiSubscriptionCredentials(bundle(), {
    settings,
    now: () => START_TIME,
    randomBytes: randomBytes(1),
  });

  let refreshCalls = 0;
  let releaseRefresh!: () => void;
  const refreshStarted = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  let continueRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => { continueRefresh = resolve; });
  const refresh = async (): Promise<OpenAiSubscriptionTokenBundle> => {
    refreshCalls += 1;
    releaseRefresh();
    await refreshGate;
    return bundle({
      accessToken: 'access-rotated',
      refreshToken: 'refresh-original',
      expiresAt: START_TIME + 3_600_000,
    });
  };
  const dependencies = {
    settings,
    now: () => START_TIME,
    randomId: () => `owner-${refreshCalls}`,
    sleep: async () => Promise.resolve(),
    refresh,
  };
  const first = resolveOpenAiSubscriptionCredentials(dependencies);
  await refreshStarted;
  const second = resolveOpenAiSubscriptionCredentials(dependencies);
  continueRefresh();
  const resolved = await Promise.all([first, second]);

  assert.equal(refreshCalls, 1);
  assert.deepEqual(resolved, [
    {
      accessToken: 'access-rotated',
      accountId: 'account-primary',
      accountFingerprint: connected.accountFingerprint,
    },
    {
      accessToken: 'access-rotated',
      accountId: 'account-primary',
      accountFingerprint: connected.accountFingerprint,
    },
  ]);
  const raw = await settings.getSetting(openAiSubscriptionSettingKeys().tokens);
  assert.match(raw ?? '', /refresh-original/);
});

test('invalid grant clears usable credentials and requires reconnect without exposing tokens', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const connected = await commitOpenAiSubscriptionCredentials(bundle(), {
    settings,
    now: () => START_TIME,
    randomBytes: randomBytes(1),
  });

  await assert.rejects(
    () => resolveOpenAiSubscriptionCredentials({
      settings,
      now: () => START_TIME,
      randomId: () => 'refresh-owner',
      refresh: async () => {
        throw new OpenAiSubscriptionProtocolError('auth_reconnect_required');
      },
    }),
    (error: unknown) =>
      error instanceof OpenAiSubscriptionError && error.code === 'auth_reconnect_required',
  );
  assert.equal(await settings.getSetting(openAiSubscriptionSettingKeys().tokens), undefined);
  assert.deepEqual(await getOpenAiSubscriptionCredentialStatus(settings), {
    state: 'reconnect_required',
    updatedAt: START_TIME,
    accountFingerprint: connected.accountFingerprint,
    connectedAt: START_TIME,
    failureCode: 'auth_reconnect_required',
  });
  assert.doesNotMatch(
    JSON.stringify(await getOpenAiSubscriptionCredentialStatus(settings)),
    /access-original|refresh-original|identity-original|account-primary/,
  );
});

test('refresh rejects an unexpected account change and keeps the prior safe fingerprint', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const connected = await commitOpenAiSubscriptionCredentials(bundle(), {
    settings,
    now: () => START_TIME,
    randomBytes: randomBytes(1),
  });

  await assert.rejects(
    () => resolveOpenAiSubscriptionCredentials({
      settings,
      now: () => START_TIME,
      randomId: () => 'refresh-owner',
      refresh: async () => bundle({ accountId: 'account-unexpected' }),
    }),
    (error: unknown) =>
      error instanceof OpenAiSubscriptionError && error.code === 'auth_reconnect_required',
  );
  assert.equal(await settings.getSetting(openAiSubscriptionSettingKeys().tokens), undefined);
  assert.equal(
    (await getOpenAiSubscriptionCredentialStatus(settings)).accountFingerprint,
    connected.accountFingerprint,
  );
});

test('missing identity key and repeated authentication failures invalidate credentials', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  await commitOpenAiSubscriptionCredentials(bundle({ expiresAt: START_TIME + 3_600_000 }), {
    settings,
    now: () => START_TIME,
    randomBytes: randomBytes(1),
  });
  await settings.deleteSetting(openAiSubscriptionSettingKeys().identityKey);

  await assert.rejects(
    () => resolveOpenAiSubscriptionCredentials({ settings, now: () => START_TIME }),
    (error: unknown) =>
      error instanceof OpenAiSubscriptionError && error.code === 'auth_reconnect_required',
  );
  assert.equal(await settings.getSetting(openAiSubscriptionSettingKeys().tokens), undefined);

  await commitOpenAiSubscriptionCredentials(bundle({ expiresAt: START_TIME + 3_600_000 }), {
    settings,
    now: () => START_TIME,
    randomBytes: randomBytes(2),
  });
  assert.equal(await recordOpenAiSubscriptionAuthenticationFailure(settings, { now: () => START_TIME }), false);
  assert.equal(await recordOpenAiSubscriptionAuthenticationFailure(settings, { now: () => START_TIME }), true);
  assert.equal(await settings.getSetting(openAiSubscriptionSettingKeys().tokens), undefined);
  assert.equal((await getOpenAiSubscriptionCredentialStatus(settings)).state, 'reconnect_required');
});

test('a stale authentication failure cannot invalidate replacement credentials', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  await commitOpenAiSubscriptionCredentials(bundle({ expiresAt: START_TIME + 3_600_000 }), {
    settings,
    now: () => START_TIME,
    randomBytes: randomBytes(1),
  });
  const stale = await resolveOpenAiSubscriptionCredentials({ settings, now: () => START_TIME });

  await commitOpenAiSubscriptionCredentials(bundle({
    accessToken: 'access-replacement',
    refreshToken: 'refresh-replacement',
    expiresAt: START_TIME + 7_200_000,
  }), {
    settings,
    now: () => START_TIME + 1,
    randomBytes: randomBytes(1),
  });

  assert.equal(await recordOpenAiSubscriptionAuthenticationFailure(settings, {
    credentials: stale,
    limit: 1,
    now: () => START_TIME + 2,
  }), false);
  assert.match(
    await settings.getSetting(openAiSubscriptionSettingKeys().tokens) ?? '',
    /access-replacement/,
  );
  assert.equal((await getOpenAiSubscriptionCredentialStatus(settings)).state, 'connected');
});

test('credential invalidation removes an in-flight reconnect so cancel cannot restore it', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  await commitOpenAiSubscriptionCredentials(bundle({ expiresAt: START_TIME + 3_600_000 }), {
    settings,
    now: () => START_TIME,
    randomBytes: randomBytes(1),
  });
  const credentials = await resolveOpenAiSubscriptionCredentials({ settings, now: () => START_TIME });
  const started = await startOpenAiSubscriptionAuthorization({
    settings,
    now: () => START_TIME + 1,
    randomBytes: randomBytes(2),
    protocol: {
      start: async () => ({
        deviceAuthId: 'replacement-device',
        userCode: 'REPLACE-ME',
        verificationUri: 'https://auth.openai.com/codex/device',
        intervalMs: 5_000,
        expiresAt: START_TIME + 60_000,
      }),
      poll: async () => ({ state: 'pending' }),
      exchange: async () => { throw new Error('must not exchange'); },
    },
  });

  assert.equal(await recordOpenAiSubscriptionAuthenticationFailure(settings, {
    credentials,
    limit: 1,
    now: () => START_TIME + 2,
  }), true);
  await assert.rejects(
    () => cancelOpenAiSubscriptionAuthorization(
      { attemptCapability: started.attemptCapability },
      { settings, now: () => START_TIME + 3 },
    ),
    (error: unknown) =>
      error instanceof OpenAiSubscriptionError && error.code === 'authorization_missing',
  );
  assert.equal((await getOpenAiSubscriptionCredentialStatus(settings)).state, 'reconnect_required');
  assert.equal(await settings.getSetting(openAiSubscriptionSettingKeys().tokens), undefined);
});

test('a first credential commit cannot reactivate the retired Subscription lane', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());

  await commitOpenAiSubscriptionCredentials(bundle({ expiresAt: START_TIME + 3_600_000 }), {
    settings,
    now: () => START_TIME,
    randomBytes: randomBytes(1),
  }, { selectAuthMethod: true });

  assert.equal(await resolveOpenAiAuthMethod(settings), 'api_key');
});

test('disconnect deletes every secret record while preserving a safe disconnected status', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  await commitOpenAiSubscriptionCredentials(bundle(), {
    settings,
    now: () => START_TIME,
    randomBytes: randomBytes(1),
  });
  await settings.setSetting(openAiSubscriptionSettingKeys().pending, 'pending-secret');
  await settings.setSetting(openAiSubscriptionSettingKeys().refreshLease, 'lease-secret');
  await settings.setSetting(openAiSubscriptionSettingKeys().modelCatalog, 'safe-model-cache');

  assert.deepEqual(await disconnectOpenAiSubscription(settings, { now: () => START_TIME }), {
    state: 'disconnected',
    updatedAt: START_TIME,
  });
  const keys = openAiSubscriptionSettingKeys();
  assert.deepEqual(
    await settings.getSettings([
      keys.pending, keys.tokens, keys.refreshLease, keys.identityKey, keys.modelCatalog,
    ]),
    [undefined, undefined, undefined, undefined, undefined],
  );
  assert.deepEqual(await getOpenAiSubscriptionCredentialStatus(settings), {
    state: 'disconnected',
    updatedAt: START_TIME,
  });
});
