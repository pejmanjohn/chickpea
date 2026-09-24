import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import {
  GITHUB_API_BASE,
  GITHUB_SETTING_KEYS,
  resetGithubAppBotUserRetryForTests,
} from '../src/config/github-app.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import {
  NEUTRAL_GIT_IDENTITY,
  gitIdentityConfigCommand,
  githubAppBotGitIdentity,
  resolveWorkspaceGitIdentity,
} from '../src/sandbox/git-identity.ts';
import { withEnv } from './helpers/env.ts';

const PRIVATE_KEY = String(
  generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }),
);

const NO_ENV_APP = { GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined };

async function connectedSettings(appId = '1234'): Promise<SqliteSettingsStore> {
  const settings = new SqliteSettingsStore(':memory:');
  await settings.setSetting(GITHUB_SETTING_KEYS.appId, appId);
  await settings.setSetting(GITHUB_SETTING_KEYS.appSlug, 'stale-stored-slug');
  await settings.setSetting(GITHUB_SETTING_KEYS.privateKey, PRIVATE_KEY);
  return settings;
}

function githubFetch(options: { slug?: string; botId?: number; userStatus?: number } = {}) {
  const requests: { url: string; authorization: string | null }[] = [];
  const slug = options.slug ?? 'chickpea-735adc';
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    if (url === `${GITHUB_API_BASE}/app`) return Response.json({ id: 1234, slug });
    if (url === `${GITHUB_API_BASE}/users/${encodeURIComponent(`${slug}[bot]`)}`) {
      if (options.userStatus) return new Response('{}', { status: options.userStatus });
      return Response.json({ id: options.botId ?? 987654, login: `${slug}[bot]`, type: 'Bot' });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

test('the App bot identity uses the bot login and its id-prefixed noreply address', () => {
  assert.deepEqual(githubAppBotGitIdentity('chickpea-735adc', 987654), {
    name: 'chickpea-735adc[bot]',
    email: '987654+chickpea-735adc[bot]@users.noreply.github.com',
  });
  assert.throws(() => githubAppBotGitIdentity('Bad Slug', 1));
  assert.throws(() => githubAppBotGitIdentity('chickpea', 0));
});

test('the config command quotes values and carries no credential', () => {
  assert.equal(
    gitIdentityConfigCommand({ name: "O'Brien [bot]", email: '1+b[bot]@users.noreply.github.com' }),
    "git config --global user.name 'O'\\''Brien [bot]' && " +
      "git config --global user.email '1+b[bot]@users.noreply.github.com'",
  );
  assert.throws(() => gitIdentityConfigCommand({ name: 'a\nb', email: 'x@y' }));
  assert.throws(() => gitIdentityConfigCommand({ name: '', email: 'x@y' }));
});

test('a connected App resolves its bot from GET /app once and caches it with the connection', async () => {
  resetGithubAppBotUserRetryForTests();
  const settings = await connectedSettings();
  const { fetchImpl, requests } = githubFetch();
  try {
    await withEnv(NO_ENV_APP, async () => {
      const identity = await resolveWorkspaceGitIdentity(settings, fetchImpl);
      assert.deepEqual(identity, {
        name: 'chickpea-735adc[bot]',
        email: '987654+chickpea-735adc[bot]@users.noreply.github.com',
      });
      // The slug is GitHub's, not the stored one, so a renamed App stays right.
      assert.equal(requests[0]?.url, `${GITHUB_API_BASE}/app`);
      assert.match(requests[0]?.authorization ?? '', /^Bearer ey/);
      // The bot user lookup is public and carries no App credential.
      assert.equal(requests[1]?.authorization, null);

      assert.deepEqual(await resolveWorkspaceGitIdentity(settings, fetchImpl), identity);
      assert.equal(requests.length, 2, 'the cached bot user needs no further GitHub calls');
      const cached = JSON.parse((await settings.getSetting(GITHUB_SETTING_KEYS.botUser))!);
      assert.deepEqual({ ...cached, resolvedAt: typeof cached.resolvedAt }, {
        appId: '1234',
        slug: 'chickpea-735adc',
        id: 987654,
        resolvedAt: 'number',
      });
    });
  } finally {
    settings.close();
  }
});

test('a cached bot user from another App is not reused', async () => {
  resetGithubAppBotUserRetryForTests();
  const settings = await connectedSettings('5555');
  await settings.setSetting(
    GITHUB_SETTING_KEYS.botUser,
    JSON.stringify({ appId: '1234', slug: 'old-app', id: 1 }),
  );
  const { fetchImpl } = githubFetch({ slug: 'chickpea-new', botId: 42 });
  try {
    await withEnv(NO_ENV_APP, async () => {
      assert.equal(
        (await resolveWorkspaceGitIdentity(settings, fetchImpl)).name,
        'chickpea-new[bot]',
      );
    });
  } finally {
    settings.close();
  }
});

test('a day-old cached bot user refreshes, and a failed refresh keeps it', async () => {
  resetGithubAppBotUserRetryForTests();
  const settings = await connectedSettings();
  const dayOld = Date.now() - 25 * 60 * 60 * 1_000;
  await settings.setSetting(
    GITHUB_SETTING_KEYS.botUser,
    JSON.stringify({ appId: '1234', slug: 'chickpea-before', id: 42, resolvedAt: dayOld }),
  );
  try {
    await withEnv(NO_ENV_APP, async () => {
      const down = githubFetch({ slug: 'chickpea-renamed', userStatus: 502 });
      assert.equal(
        (await resolveWorkspaceGitIdentity(settings, down.fetchImpl)).name,
        'chickpea-before[bot]',
      );
      resetGithubAppBotUserRetryForTests();
      const renamed = githubFetch({ slug: 'chickpea-renamed', botId: 42 });
      assert.deepEqual(await resolveWorkspaceGitIdentity(settings, renamed.fetchImpl), {
        name: 'chickpea-renamed[bot]',
        email: '42+chickpea-renamed[bot]@users.noreply.github.com',
      });
    });
  } finally {
    settings.close();
  }
});

test('without a connected App the workspace commits as the neutral Chickpea identity', async () => {
  resetGithubAppBotUserRetryForTests();
  const settings = new SqliteSettingsStore(':memory:');
  const { fetchImpl, requests } = githubFetch();
  try {
    await withEnv(NO_ENV_APP, async () => {
      assert.deepEqual(await resolveWorkspaceGitIdentity(settings, fetchImpl), NEUTRAL_GIT_IDENTITY);
      assert.equal(requests.length, 0);
    });
  } finally {
    settings.close();
  }
  assert.deepEqual(NEUTRAL_GIT_IDENTITY, { name: 'Chickpea', email: 'chickpea@noreply.invalid' });
});

test('a failed bot lookup falls back to the neutral identity and is not retried immediately', async () => {
  resetGithubAppBotUserRetryForTests();
  const settings = await connectedSettings();
  const { fetchImpl, requests } = githubFetch({ userStatus: 403 });
  try {
    await withEnv(NO_ENV_APP, async () => {
      assert.deepEqual(await resolveWorkspaceGitIdentity(settings, fetchImpl), NEUTRAL_GIT_IDENTITY);
      const attempts = requests.length;
      assert.deepEqual(await resolveWorkspaceGitIdentity(settings, fetchImpl), NEUTRAL_GIT_IDENTITY);
      assert.equal(requests.length, attempts, 'a failure backs off instead of calling GitHub every turn');
      assert.equal(await settings.getSetting(GITHUB_SETTING_KEYS.botUser), undefined);
    });
  } finally {
    settings.close();
    resetGithubAppBotUserRetryForTests();
  }
});
