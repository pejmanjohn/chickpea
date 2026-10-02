import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';

import {
  censusInstallationCredentials,
  CredentialKeyringChangedError,
  migrateInstallationPlaintextModelCredentials,
  rewrapInstallationCredentials,
  type InstallationRewrapResult,
} from '../src/config/hosted-credential-operations.ts';
import {
  createInstallationModelAccessResolver,
  installationModelAccessGrant,
  RuntimeModelReadinessError,
} from '../src/config/installation-model-access.ts';
import { InstallationContextError, scopeInstallationEnv } from '../src/config/installation-scope.ts';
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
  resolveSlackInstallationCredentials,
  writeHostedSlackBotCredentials,
} from '../src/slack/installation-credentials.ts';
import { HOSTED_SLACK_INSTALLATION_ID } from '../src/config/types.ts';
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

function drive(installation: Installation, previousKeyId: string, keyring: CredentialKeyring, extra: object = {}) {
  return rewrapInstallationCredentials(installation.env, {
    previousKeyId, keyring, identity: installation.identity, settings: installation.settings, ...extra,
  });
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

test('a drive rewraps each installation on its own; one failing installation leaves the other done, and a retry finishes it', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { a, b, keyring, rotate } = await installations(t);
    const previousKeyId = keyring.currentKeyId;
    const rotated = rotate();
    const failingB = { ...b, settings: Object.create(b.settings) as SqliteSettingsStore };
    failingB.settings.rewrapModelCredential = async () => { throw new Error('tenant store unavailable'); };

    // As a host's drive runs it: one bounded step per installation, each settling alone.
    const results = await Promise.allSettled([a, failingB].map((installation) =>
      drive(installation, previousKeyId, rotated, { expectedCurrentKeyId: 'key_next' })));
    assert.equal(results[0]!.status, 'fulfilled');
    assert.equal(results[1]!.status, 'rejected');
    const doneA = (results[0] as PromiseFulfilledResult<InstallationRewrapResult>).value;
    assert.deepEqual(doneA.slack, { rewrapped: 1 });
    assert.deepEqual(doneA.modelKeys, { rewrapped: ['anthropic'], alreadyCurrent: [], remaining: [] });
    assert.deepEqual(doneA.census.slackCredentials, { key_next: 1 });
    assert.deepEqual(doneA.census.encryptedSettings, { model_provider: { key_next: 1 } });
    assert.deepEqual(doneA.unrewrappable, []);
    assert.equal(doneA.done, true);

    // B's Slack bundle moved before its store failed; the retry finishes and repeats nothing.
    const retried = await drive(b, previousKeyId, rotated, { expectedCurrentKeyId: 'key_next' });
    assert.equal(retried.done, true);
    assert.deepEqual(retried.census.slackCredentials, { key_next: 1 });
    const again = await drive(a, previousKeyId, rotated);
    assert.deepEqual([again.slack, again.modelKeys, again.done],
      [{ rewrapped: 0 }, { rewrapped: [], alreadyCurrent: [], remaining: [] }, true], 'running it again changes nothing');

    // Both still read their own credentials once the old slot is retired.
    const retired = { currentKeyId: 'key_next', keys: { key_next: rotated.keys.key_next! } };
    writeFileSync(process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH!, `${JSON.stringify({ version: 1, ...retired })}\n`, { mode: 0o600 });
    invalidateSlackInstallationCredentialCache();
    for (const [installation, apiKey, token] of [[a, KEY_A, 'xoxb-t_ops_a'], [b, KEY_B, 'xoxb-t_ops_b']] as const) {
      assert.equal((await resolveProviderApiKey('anthropic', installation.env, installation.settings)).apiKey, apiKey);
      const slack = await resolveSlackInstallationCredentials(HOSTED_SLACK_INSTALLATION_ID, installation.env,
        { state: installation.identity, env: installation.env });
      assert.equal(slack.botToken, token);
    }
  });
});

test('the census counts every encrypted class, and a class no rewrap covers blocks retiring the key', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { a, keyring, rotate } = await installations(t);
    const previousKeyId = keyring.currentKeyId;
    // A website login saved under the old key (the browser is off hosted, but its data is counted).
    const model = (await a.settings.getEncryptedCredentialRevision('model_provider.anthropic'))!;
    await a.settings.replaceEncryptedCredentialRevision({
      key: 'website_login.login_1', expectedRevision: null, revision: 'v1', contextId: 'login_context_000001',
      envelope: model.envelope,
    });
    const rotated = rotate();
    const result = await drive(a, previousKeyId, rotated);
    assert.deepEqual(result.census.encryptedSettings, {
      model_provider: { key_next: 1 },
      website_login: { [previousKeyId]: 1 },
    });
    assert.deepEqual(result.unrewrappable, ['website_login']);
    assert.equal(result.done, false, 'the previous key may not be retired');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY_A));
  });
});

test('a drive whose keyring changed stops with keyring_changed before it touches anything', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { a, keyring, rotate } = await installations(t);
    const rotated = rotate();
    await assert.rejects(drive(a, keyring.currentKeyId, rotated, { expectedCurrentKeyId: 'key_other' }),
      (error: unknown) => error instanceof CredentialKeyringChangedError && error.code === 'keyring_changed');
    const census = await censusInstallationCredentials(a.env, { identity: a.identity, settings: a.settings });
    assert.deepEqual(census.slackCredentials, { [keyring.currentKeyId]: 1 });
    assert.deepEqual(census.encryptedSettings, { model_provider: { [keyring.currentKeyId]: 1 } });
    await assert.rejects(drive(a, 'key_next', rotated), /previous key is the deployment keyring's current key/);
  });
});

test('the plaintext migration entry point encrypts a key an earlier build saved; the census reports presence only', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { a, b, usage } = await installations(t);
    await a.settings.setSetting('provider.openai.apiKey', 'sk-openai-saved-in-the-clear');
    const before = await censusInstallationCredentials(a.env, { identity: a.identity, settings: a.settings });
    assert.deepEqual(before.plaintextModelKeys, ['openai']);
    assert.doesNotMatch(JSON.stringify(before), /sk-openai/);
    assert.deepEqual(await migrateInstallationPlaintextModelCredentials(a.env, { settings: a.settings, usage }),
      { migrated: ['openai'], removed: [] });
    assert.deepEqual((await censusInstallationCredentials(a.env, { identity: a.identity, settings: a.settings })).plaintextModelKeys, []);
    assert.equal((await resolveProviderApiKey('openai', a.env, a.settings)).apiKey, 'sk-openai-saved-in-the-clear');
    assert.deepEqual(await migrateInstallationPlaintextModelCredentials(a.env, { settings: a.settings, usage }),
      { migrated: [], removed: [] }, 'running it again changes nothing');
    // The neighbour had nothing in the clear and is untouched.
    assert.deepEqual(await migrateInstallationPlaintextModelCredentials(b.env, { settings: b.settings, usage }),
      { migrated: [], removed: [] });
  });
});

test('every operation refuses a standalone env', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  const identity = new SqliteIdentityStore(':memory:');
  t.after(() => { settings.close(); identity.close(); });
  const keyring = generateCredentialKeyring('key_standalone');
  for (const operation of [
    () => rewrapInstallationCredentials({}, { previousKeyId: 'key_old', keyring, identity, settings }),
    () => censusInstallationCredentials({}, { identity, settings }),
    () => migrateInstallationPlaintextModelCredentials({}, { settings }),
  ]) {
    await assert.rejects(operation(), InstallationContextError);
  }
});
