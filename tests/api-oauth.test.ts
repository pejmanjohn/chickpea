import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ApiOAuthError,
  apiOAuthSettingKeys,
  completeApiOAuthAuthorization,
  describeApiOAuthSources,
  resolveApiOAuthAccessToken,
  saveApiOAuthClient,
  startApiOAuthAuthorization,
} from '../src/config/api-oauth.ts';
import {
  SqliteSettingsStore,
  type SettingsPatch,
  type SettingsStore,
} from '../src/config/settings-store.ts';

const REF = { agentId: 'agent_google', connectionId: 'google-workspace' };
const CALLBACK_URL = 'https://chickpea.example.test/oauth/api/callback';
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];

function fakeGoogle(options: {
  exchangeError?: string;
  expiresIn?: number;
  refreshError?: string;
} = {}) {
  let exchanges = 0;
  let refreshes = 0;
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push({ url: request.url, authorization: request.headers.get('authorization') });
    if (request.url === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(await request.text());
      assert.equal(body.get('client_id'), 'google-client-id');
      assert.equal(body.get('client_secret'), 'google-client-secret');
      if (body.get('grant_type') === 'authorization_code') {
        exchanges += 1;
        assert.equal(body.get('code'), 'provider-code');
        assert.equal(body.get('redirect_uri'), CALLBACK_URL);
        assert.ok(body.get('code_verifier'));
        if (options.exchangeError) {
          return Response.json({ error: options.exchangeError }, { status: 400 });
        }
        return Response.json({
          access_token: 'access-initial',
          refresh_token: 'refresh-initial',
          token_type: 'Bearer',
          expires_in: options.expiresIn ?? 3600,
          scope: SCOPES.join(' '),
        });
      }
      if (body.get('grant_type') === 'refresh_token') {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(body.get('refresh_token'), 'refresh-initial');
        if (options.refreshError) {
          return Response.json({ error: options.refreshError }, { status: 400 });
        }
        return Response.json({
          access_token: 'access-refreshed',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
    }
    if (request.url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      assert.equal(request.headers.get('authorization'), 'Bearer access-initial');
      return Response.json({
        sub: 'provider-user-id-must-not-persist',
        email: 'operator@example.com',
        name: 'Operator Name',
        picture: 'https://example.com/private-avatar.png',
      });
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };
  return {
    fetchFn,
    calls,
    counts: {
      get exchanges() { return exchanges; },
      get refreshes() { return refreshes; },
    },
  };
}

test('Google BYO OAuth keeps client credentials write-only and starts PKCE with offline consent', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  let nonce = 0;
  try {
    await saveApiOAuthClient(
      REF,
      { provider: 'google', clientId: 'google-client-id', clientSecret: 'google-client-secret' },
      settings,
    );
    assert.deepEqual(await describeApiOAuthSources(REF, settings), {
      client: 'stored',
      tokens: 'missing',
    });

    const started = await startApiOAuthAuthorization(
      {
        ref: REF,
        provider: 'google',
        callbackUrl: CALLBACK_URL,
        scopes: SCOPES,
        returnAgentId: 'agent_return',
      },
      { settings, randomId: () => `nonce-${++nonce}` },
    );
    assert.equal(started.authorizationUrl.origin, 'https://accounts.google.com');
    assert.equal(started.authorizationUrl.pathname, '/o/oauth2/v2/auth');
    assert.equal(started.authorizationUrl.searchParams.get('client_id'), 'google-client-id');
    assert.equal(started.authorizationUrl.searchParams.get('redirect_uri'), CALLBACK_URL);
    assert.equal(started.authorizationUrl.searchParams.get('access_type'), 'offline');
    assert.equal(started.authorizationUrl.searchParams.get('prompt'), 'consent');
    assert.equal(started.authorizationUrl.searchParams.get('include_granted_scopes'), null);
    assert.equal(started.authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(started.authorizationUrl.searchParams.get('code_challenge'));
    assert.match(started.authorizationUrl.searchParams.get('scope') ?? '', /openid/);
    assert.equal(JSON.stringify(started).includes('google-client-secret'), false);
    assert.equal(JSON.stringify(started).includes('codeVerifier'), false);

    const stored = (await settings.getSettings(apiOAuthSettingKeys(REF))).join('\n');
    assert.match(stored, /google-client-secret/);
    assert.match(stored, /codeVerifier/);
  } finally {
    settings.close();
  }
});

test('a transient post-write connection check preserves existing OAuth settings', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  let checks = 0;
  try {
    await saveApiOAuthClient(
      REF,
      { provider: 'google', clientId: 'google-client-id', clientSecret: 'google-client-secret' },
      settings,
    );
    await settings.setSetting(apiOAuthSettingKeys(REF)[2], 'existing-token-bundle');

    await assert.rejects(
      startApiOAuthAuthorization(
        { ref: REF, provider: 'google', callbackUrl: CALLBACK_URL, scopes: SCOPES },
        {
          settings,
          randomId: () => 'nonce',
          validateConnection: () => {
            checks += 1;
            if (checks === 1) return true;
            throw new Error('temporary config-store failure');
          },
        },
      ),
      /temporary config-store failure/,
    );

    const [client, pending, tokens] = await settings.getSettings(apiOAuthSettingKeys(REF));
    assert.match(client ?? '', /google-client-secret/);
    assert.match(pending ?? '', /codeVerifier/);
    assert.equal(tokens, 'existing-token-bundle');
  } finally {
    settings.close();
  }
});

test('Google callback consumes state, stores tokens, and returns only bounded account identity', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const google = fakeGoogle();
  try {
    await saveApiOAuthClient(
      REF,
      { provider: 'google', clientId: 'google-client-id', clientSecret: 'google-client-secret' },
      settings,
    );
    const started = await startApiOAuthAuthorization(
      {
        ref: REF,
        provider: 'google',
        callbackUrl: CALLBACK_URL,
        scopes: SCOPES,
        returnAgentId: 'agent_return',
      },
      { settings, randomId: () => 'nonce' },
    );
    const completed = await completeApiOAuthAuthorization(
      { code: 'provider-code', state: started.state },
      { settings, fetchFn: google.fetchFn },
    );
    assert.deepEqual(completed, {
      ref: REF,
      provider: 'google',
      identity: { accountName: 'operator@example.com' },
      returnAgentId: 'agent_return',
    });
    assert.equal(google.counts.exchanges, 1);
    assert.deepEqual(await describeApiOAuthSources(REF, settings), {
      client: 'stored',
      tokens: 'stored',
    });
    assert.equal(
      await resolveApiOAuthAccessToken(
        { ref: REF, provider: 'google' },
        { settings, fetchFn: google.fetchFn },
      ),
      'access-initial',
    );
    const stored = (await settings.getSettings(apiOAuthSettingKeys(REF))).join('\n');
    assert.doesNotMatch(stored, /provider-user-id|private-avatar|Operator Name/);
  } finally {
    settings.close();
  }
});

test('failed Google exchange retains the initiating Agent callback context', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const google = fakeGoogle({ exchangeError: 'invalid_grant' });
  try {
    await saveApiOAuthClient(
      REF,
      { provider: 'google', clientId: 'google-client-id', clientSecret: 'google-client-secret' },
      settings,
    );
    const started = await startApiOAuthAuthorization(
      {
        ref: REF,
        provider: 'google',
        callbackUrl: CALLBACK_URL,
        scopes: SCOPES,
        returnAgentId: 'agent_return',
      },
      { settings, randomId: () => 'nonce' },
    );

    await assert.rejects(
      completeApiOAuthAuthorization(
        { code: 'provider-code', state: started.state },
        { settings, fetchFn: google.fetchFn },
      ),
      (error: unknown) =>
        error instanceof ApiOAuthError &&
        error.code === 'oauth_unavailable' &&
        error.callbackContext?.ref.agentId === REF.agentId &&
        error.callbackContext.returnAgentId === 'agent_return',
    );
  } finally {
    settings.close();
  }
});

test('a superseded Agent-owned Google OAuth attempt cannot exchange or replace newer state', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const google = fakeGoogle();
  let currentRevision = 1;
  try {
    await saveApiOAuthClient(
      REF,
      { provider: 'google', clientId: 'google-client-id', clientSecret: 'google-client-secret' },
      settings,
    );
    const dependencies = {
      settings,
      fetchFn: google.fetchFn,
      randomId: () => 'nonce',
      validateConnection: (
        _ref: typeof REF,
        _provider: 'google',
        accountRevision?: number,
      ) => {
        if (accountRevision !== currentRevision) {
          throw new ApiOAuthError('oauth_attempt_superseded', 'OAuth attempt was superseded');
        }
        return true;
      },
    };
    const started = await startApiOAuthAuthorization(
      {
        ref: REF,
        provider: 'google',
        callbackUrl: CALLBACK_URL,
        scopes: SCOPES,
        accountRevision: 1,
      },
      dependencies,
    );
    currentRevision = 2;

    await assert.rejects(
      completeApiOAuthAuthorization(
        { code: 'provider-code', state: started.state },
        dependencies,
      ),
      (error: unknown) =>
        error instanceof ApiOAuthError && error.code === 'oauth_attempt_superseded',
    );
    assert.equal(google.counts.exchanges, 0);
    assert.equal(await settings.getSetting(apiOAuthSettingKeys(REF)[2]), undefined);
  } finally {
    settings.close();
  }
});

test('an older Google OAuth start cannot replace a newer pending authorization', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const olderAttemptId = '11111111-1111-4111-8111-111111111111';
  const newerAttemptId = '22222222-2222-4222-8222-222222222222';
  try {
    await saveApiOAuthClient(
      REF,
      { provider: 'google', clientId: 'google-client-id', clientSecret: 'google-client-secret' },
      settings,
    );
    await startApiOAuthAuthorization({
      ref: REF,
      provider: 'google',
      callbackUrl: CALLBACK_URL,
      scopes: SCOPES,
      accountRevision: 2,
      oauthAttemptId: newerAttemptId,
    }, {
      settings,
      randomId: () => 'newer-nonce',
      validateConnection: () => true,
    });
    const pendingKey = apiOAuthSettingKeys(REF)[1];
    const newerPending = await settings.getSetting(pendingKey);

    await assert.rejects(
      startApiOAuthAuthorization({
        ref: REF,
        provider: 'google',
        callbackUrl: CALLBACK_URL,
        scopes: SCOPES,
        accountRevision: 1,
        oauthAttemptId: olderAttemptId,
      }, {
        settings,
        randomId: () => 'older-nonce',
        validateConnection: () => true,
      }),
      (error: unknown) =>
        error instanceof ApiOAuthError && error.code === 'oauth_attempt_superseded',
    );
    assert.equal(await settings.getSetting(pendingKey), newerPending);
  } finally {
    settings.close();
  }
});

test('a slower Agent-owned Google OAuth callback cannot overwrite newer credentials', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const google = fakeGoogle();
  const olderAttemptId = '11111111-1111-4111-8111-111111111111';
  const newerAttemptId = '22222222-2222-4222-8222-222222222222';
  try {
    await saveApiOAuthClient(
      REF,
      { provider: 'google', clientId: 'google-client-id', clientSecret: 'google-client-secret' },
      settings,
    );
    const older = await startApiOAuthAuthorization({
      ref: REF,
      provider: 'google',
      callbackUrl: CALLBACK_URL,
      scopes: SCOPES,
      accountRevision: 1,
      oauthAttemptId: olderAttemptId,
    }, {
      settings,
      fetchFn: google.fetchFn,
      randomId: () => 'older-nonce',
      validateConnection: () => true,
    });
    const tokenKey = apiOAuthSettingKeys(REF)[2];
    const newerRaw = JSON.stringify({
      provider: 'google',
      accessToken: 'access-winner',
      tokenType: 'Bearer',
      obtainedAt: Date.now(),
      accountRevision: 2,
      oauthAttemptId: newerAttemptId,
    });
    await settings.setSetting(tokenKey, newerRaw);

    await assert.rejects(
      completeApiOAuthAuthorization(
        { code: 'provider-code', state: older.state },
        { settings, fetchFn: google.fetchFn, validateConnection: () => true },
      ),
      (error: unknown) =>
        error instanceof ApiOAuthError && error.code === 'oauth_attempt_superseded',
    );
    assert.equal(google.counts.exchanges, 1);
    assert.equal(await settings.getSetting(tokenKey), newerRaw);
    assert.equal(await resolveApiOAuthAccessToken(
      { ref: REF, provider: 'google' },
      {
        settings,
        validateConnection: (_ref, _provider, _revision, attemptId) =>
          attemptId === undefined || attemptId === newerAttemptId,
      },
    ), 'access-winner');
  } finally {
    settings.close();
  }
});

test('expired Google tokens refresh once across concurrent callers and preserve the refresh token', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const google = fakeGoogle({ expiresIn: 1 });
  let now = 1_000_000;
  const dependencies = {
    settings,
    fetchFn: google.fetchFn,
    now: () => now,
    randomId: (() => { let nonce = 0; return () => `nonce-${++nonce}`; })(),
  };
  try {
    await saveApiOAuthClient(
      REF,
      { provider: 'google', clientId: 'google-client-id', clientSecret: 'google-client-secret' },
      settings,
    );
    const started = await startApiOAuthAuthorization(
      { ref: REF, provider: 'google', callbackUrl: CALLBACK_URL, scopes: SCOPES },
      dependencies,
    );
    await completeApiOAuthAuthorization(
      { code: 'provider-code', state: started.state },
      dependencies,
    );
    now += 2_000;

    assert.deepEqual(
      await Promise.all([
        resolveApiOAuthAccessToken({ ref: REF, provider: 'google' }, dependencies),
        resolveApiOAuthAccessToken({ ref: REF, provider: 'google' }, dependencies),
      ]),
      ['access-refreshed', 'access-refreshed'],
    );
    assert.equal(google.counts.refreshes, 1);
    const stored = (await settings.getSettings(apiOAuthSettingKeys(REF))).join('\n');
    assert.match(stored, /refresh-initial/);
  } finally {
    settings.close();
  }
});

test('an expired refresh lease can be recovered without timing out first', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const google = fakeGoogle({ expiresIn: 1 });
  let now = 1_000_000;
  const dependencies = {
    settings,
    fetchFn: google.fetchFn,
    now: () => now,
    randomId: () => 'new-owner',
    sleep: async (milliseconds: number) => { now += milliseconds; },
  };
  try {
    await saveApiOAuthClient(
      REF,
      { provider: 'google', clientId: 'google-client-id', clientSecret: 'google-client-secret' },
      settings,
    );
    const started = await startApiOAuthAuthorization(
      { ref: REF, provider: 'google', callbackUrl: CALLBACK_URL, scopes: SCOPES },
      dependencies,
    );
    await completeApiOAuthAuthorization(
      { code: 'provider-code', state: started.state },
      dependencies,
    );
    now += 2_000;
    await settings.setSetting(
      apiOAuthSettingKeys(REF)[3],
      JSON.stringify({ owner: 'stalled-owner', expiresAt: now + 20_000 }),
    );

    assert.equal(
      await resolveApiOAuthAccessToken({ ref: REF, provider: 'google' }, dependencies),
      'access-refreshed',
    );
    assert.equal(google.counts.refreshes, 1);
    assert.equal(await settings.getSetting(apiOAuthSettingKeys(REF)[3]), undefined);
  } finally {
    settings.close();
  }
});

test('an invalid Google refresh grant deletes unusable tokens and requires reauthorization', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const google = fakeGoogle({ expiresIn: 1, refreshError: 'invalid_grant' });
  let now = 1_000_000;
  const reauthorizationRequired: Array<{ ref: typeof REF; provider: 'google' }> = [];
  const dependencies = {
    settings,
    fetchFn: google.fetchFn,
    now: () => now,
    randomId: (() => { let nonce = 0; return () => `nonce-${++nonce}`; })(),
    onReauthorizationRequired: (ref: typeof REF, provider: 'google') => {
      reauthorizationRequired.push({ ref, provider });
    },
  };
  try {
    await saveApiOAuthClient(
      REF,
      { provider: 'google', clientId: 'google-client-id', clientSecret: 'google-client-secret' },
      settings,
    );
    const started = await startApiOAuthAuthorization(
      { ref: REF, provider: 'google', callbackUrl: CALLBACK_URL, scopes: SCOPES },
      dependencies,
    );
    await completeApiOAuthAuthorization(
      { code: 'provider-code', state: started.state },
      dependencies,
    );
    now += 2_000;

    await assert.rejects(
      resolveApiOAuthAccessToken({ ref: REF, provider: 'google' }, dependencies),
      (error: unknown) => error instanceof ApiOAuthError && error.code === 'reauthorization_required',
    );
    assert.deepEqual(await describeApiOAuthSources(REF, settings), {
      client: 'stored',
      tokens: 'missing',
    });
    assert.equal(await settings.getSetting(apiOAuthSettingKeys(REF)[3]), undefined);
    assert.deepEqual(reauthorizationRequired, [{ ref: REF, provider: 'google' }]);
  } finally {
    settings.close();
  }
});

test('an invalid-grant refresh loser returns the token stored by the winning refresher', async () => {
  const backing = new SqliteSettingsStore(':memory:');
  const tokenKey = apiOAuthSettingKeys(REF)[2];
  let replaceOnDelete = false;
  const settings: SettingsStore = {
    getSetting: (key) => backing.getSetting(key),
    getSettings: (keys) => backing.getSettings(keys),
    setSetting: (key, value) => backing.setSetting(key, value),
    deleteSetting: (key) => backing.deleteSetting(key),
    mergeSettingStringSet: (key, values) => backing.mergeSettingStringSet(key, values),
    applySettingsPatch: async (patch: SettingsPatch) => {
      if (replaceOnDelete && patch.delete?.includes(tokenKey)) {
        replaceOnDelete = false;
        const winner = JSON.parse((await backing.getSetting(tokenKey))!) as Record<string, unknown>;
        winner.accessToken = 'access-from-winner';
        winner.expiresIn = 3600;
        winner.obtainedAt = now;
        await backing.setSetting(tokenKey, JSON.stringify(winner));
        return false;
      }
      return backing.applySettingsPatch(patch);
    },
  };
  const google = fakeGoogle({ expiresIn: 1, refreshError: 'invalid_grant' });
  let now = 1_000_000;
  let reauthorizationRequired = 0;
  const dependencies = {
    settings,
    fetchFn: google.fetchFn,
    now: () => now,
    randomId: () => 'nonce',
    validateConnection: () => true,
    onReauthorizationRequired: () => {
      reauthorizationRequired += 1;
    },
  };
  try {
    await saveApiOAuthClient(
      REF,
      { provider: 'google', clientId: 'google-client-id', clientSecret: 'google-client-secret' },
      settings,
    );
    const started = await startApiOAuthAuthorization(
      { ref: REF, provider: 'google', callbackUrl: CALLBACK_URL, scopes: SCOPES },
      dependencies,
    );
    await completeApiOAuthAuthorization(
      { code: 'provider-code', state: started.state },
      dependencies,
    );
    now += 2_000;
    replaceOnDelete = true;

    assert.equal(
      await resolveApiOAuthAccessToken({ ref: REF, provider: 'google' }, dependencies),
      'access-from-winner',
    );
    assert.equal(google.counts.refreshes, 1);
    assert.equal(reauthorizationRequired, 0);
  } finally {
    backing.close();
  }
});
