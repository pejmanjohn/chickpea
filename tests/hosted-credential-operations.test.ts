import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';

import {
  createInstallationModelAccessResolver,
  installationModelAccessGrant,
  RuntimeModelReadinessError,
} from '../src/config/installation-model-access.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  ModelCredentialKeyringUnavailableError,
  readHostedModelCredential,
  resetModelKeyringWarningForTests,
  rewrapHostedModelCredentials,
  rotateInstallationModelCredential,
} from '../src/config/model-credential-refs.ts';
import { invalidateProviderKeyCache, resolveProviderApiKey } from '../src/config/provider-keys.ts';
import { SqliteSettingsStore, type RewrapModelCredentialInput } from '../src/config/settings-store.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import {
  invalidateSlackInstallationCredentialCache,
  writeHostedSlackBotCredentials,
} from '../src/slack/installation-credentials.ts';
import type { CredentialKeyring } from '../src/slack/secret-envelope.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { useDeploymentKeyring } from './helpers/deployment-keyring.ts';
import { withEnv } from './helpers/env.ts';

/**
 * What a host's operator jobs and cron call per installation: each runs for
 * one installation's scoped env and stores, is safe to repeat, and fails on
 * its own. Two installations share the deployment's one keyring.
 */

const HOSTED = { CHICKPEA_TENANCY: 'installation' } as const;
const NO_DEPLOYMENT_KEYS = {
  CHICKPEA_TENANCY: undefined, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined,
};
const KEY_A = 'sk-ant-operations-tenant-a';
const KEY_B = 'sk-ant-operations-tenant-b';

interface Installation {
  env: PlatformEnv;
  identity: SqliteIdentityStore;
  settings: SqliteSettingsStore;
}

/** Two installations, each with a Slack bot bundle and a saved model key under the deployment keyring. */
async function installations(t: TestContext) {
  invalidateProviderKeyCache();
  invalidateSlackInstallationCredentialCache();
  const keyring = useDeploymentKeyring(t);
  const usage = new SqliteUsageStore(':memory:');
  const make = (installationId: string): Installation => ({
    env: scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId }),
    identity: new SqliteIdentityStore(':memory:'),
    settings: new SqliteSettingsStore(':memory:'),
  });
  const a = make('inst_ops_a');
  const b = make('inst_ops_b');
  t.after(() => {
    for (const installation of [a, b]) { installation.identity.close(); installation.settings.close(); }
    usage.close();
    invalidateSlackInstallationCredentialCache();
    resetModelKeyringWarningForTests();
  });
  for (const [installation, apiKey, team] of [[a, KEY_A, 'T_OPS_A'], [b, KEY_B, 'T_OPS_B']] as const) {
    await writeHostedSlackBotCredentials({ state: installation.identity, keyring }, null, {
      botToken: `xoxb-${team.toLowerCase()}`, botUserId: 'UBOT', appId: 'AHOSTED', teamId: team,
      grantedScopes: ['chat:write'], validatedAt: 1_700_000_000_000,
    });
    await rotateInstallationModelCredential('anthropic', { kind: 'save', apiKey }, {
      env: installation.env, settings: installation.settings, usage, keyring,
    });
  }
  /** The deployment keyring gains `key_next` as its current key, keeping the first. */
  const rotate = (): CredentialKeyring => {
    const next = generateCredentialKeyring('key_next');
    const rotated = { currentKeyId: next.currentKeyId, keys: { ...keyring.keys, ...next.keys } };
    writeFileSync(process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH!, `${JSON.stringify({ version: 1, ...rotated })}\n`, { mode: 0o600 });
    return rotated;
  };
  return { a, b, keyring, usage, rotate };
}

test('a keyring that will not load is logged once and reads as unavailable, never as setup required; saving still refuses', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { a, b, usage } = await installations(t);
    const grantA = (await installationModelAccessGrant('anthropic', a.env, 'run', a.settings))!;
    await rotateInstallationModelCredential('anthropic', { kind: 'delete' }, { env: b.env, settings: b.settings, usage });
    writeFileSync(process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH!, 'not a keyring', { mode: 0o600 });
    resetModelKeyringWarningForTests();
    const warned: string[] = [];
    t.mock.method(console, 'warn', (line: string) => { warned.push(line); });

    const resolver = createInstallationModelAccessResolver({ settings: () => a.settings });
    const unavailable = (error: unknown) => error instanceof ModelCredentialKeyringUnavailableError &&
      !(error instanceof RuntimeModelReadinessError);
    await assert.rejects(resolver.resolve(grantA, a.env), unavailable, 'a run is told it is unavailable, not to set up again');
    await assert.rejects(resolveProviderApiKey('anthropic', a.env, a.settings), unavailable);
    await assert.rejects(readHostedModelCredential('anthropic', { env: a.env, settings: a.settings }), unavailable);
    // An installation with no saved key is told the truth: it needs setup.
    assert.deepEqual(await resolveProviderApiKey('anthropic', b.env, b.settings), { apiKey: undefined, source: 'missing' });
    assert.deepEqual(warned.map((line) => JSON.parse(line)),
      [{ component: 'model_credentials', event: 'keyring_unavailable' }], 'logged once per isolate');
    // Saving still loads the keyring strictly.
    await assert.rejects(rotateInstallationModelCredential('anthropic', { kind: 'save', apiKey: KEY_B }, {
      env: b.env, settings: b.settings, usage,
    }));
  });
});

test('a standalone keyring failure logs nothing on this path', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    useDeploymentKeyring(t);
    writeFileSync(process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH!, 'not a keyring', { mode: 0o600 });
    resetModelKeyringWarningForTests();
    t.after(() => resetModelKeyringWarningForTests());
    const warned = t.mock.method(console, 'warn', () => {});
    const settings = new SqliteSettingsStore(':memory:');
    t.after(() => settings.close());
    assert.deepEqual(await resolveProviderApiKey('anthropic', undefined, settings), { apiKey: undefined, source: 'missing' });
    assert.equal(warned.mock.callCount(), 0);
  });
});

test('a rewrap counts only a key that will not decrypt as remaining, and lets a store error through', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { a, b, rotate } = await installations(t);
    const rotated = rotate();
    // A's envelope is tampered with: it cannot be opened, so it cannot be rewrapped.
    const stored = (await a.settings.getEncryptedCredentialRevision('model_provider.anthropic'))!;
    await a.settings.replaceEncryptedCredentialRevision({
      key: stored.key, expectedRevision: stored.revision, revision: stored.revision, contextId: stored.contextId,
      envelope: { ...stored.envelope, ciphertext: `${stored.envelope.ciphertext.slice(0, -4)}AAAA` },
    });
    assert.deepEqual(await rewrapHostedModelCredentials({ env: a.env, settings: a.settings, keyring: rotated }),
      { rewrapped: [], alreadyCurrent: [], remaining: ['anthropic'] });

    // B's store fails mid-rewrap: the error propagates instead of a false remainder.
    const failing = Object.create(b.settings) as SqliteSettingsStore;
    failing.rewrapModelCredential = async () => { throw new Error('state store unavailable'); };
    await assert.rejects(rewrapHostedModelCredentials({ env: b.env, settings: failing, keyring: rotated }),
      /state store unavailable/);
    assert.deepEqual(await rewrapHostedModelCredentials({ env: b.env, settings: b.settings, keyring: rotated }),
      { rewrapped: ['anthropic'], alreadyCurrent: [], remaining: [] }, 'a retry finishes it');
  });
});

test('a rewrap is judged from the state it leaves: a replay after a later rewrap, or a concurrent save, is already current', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { a, b, usage, rotate } = await installations(t);
    const rotated = rotate();

    // A's write commits, a later rewrap under a newer key supersedes it, and the
    // replayed call answers false. The key is not left under the old key.
    const later = generateCredentialKeyring('key_later');
    const laterKeyring = { currentKeyId: later.currentKeyId, keys: { ...rotated.keys, ...later.keys } };
    const replayed = Object.create(a.settings) as SqliteSettingsStore;
    replayed.rewrapModelCredential = async (input: RewrapModelCredentialInput) => {
      assert.equal(await a.settings.rewrapModelCredential(input), true);
      await rewrapHostedModelCredentials({ env: a.env, settings: a.settings, keyring: laterKeyring });
      return a.settings.rewrapModelCredential(input);
    };
    assert.deepEqual(await rewrapHostedModelCredentials({ env: a.env, settings: replayed, keyring: rotated }),
      { rewrapped: [], alreadyCurrent: ['anthropic'], remaining: [] });

    // B's Owner saves a new key while the drive runs: it is under the current key already.
    const saving = Object.create(b.settings) as SqliteSettingsStore;
    saving.rewrapModelCredential = async (input: RewrapModelCredentialInput) => {
      await rotateInstallationModelCredential('anthropic', { kind: 'save', apiKey: 'sk-ant-saved-meanwhile' }, {
        env: b.env, settings: b.settings, usage, keyring: rotated,
      });
      return b.settings.rewrapModelCredential(input);
    };
    assert.deepEqual(await rewrapHostedModelCredentials({ env: b.env, settings: saving, keyring: rotated }),
      { rewrapped: [], alreadyCurrent: ['anthropic'], remaining: [] });
    assert.equal((await resolveProviderApiKey('anthropic', b.env, b.settings)).apiKey, 'sk-ant-saved-meanwhile');
  });
});
