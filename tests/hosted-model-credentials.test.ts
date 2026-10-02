import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createAssistantMessageEventStream,
  createProvider,
  type AssistantMessage,
  type Context,
  type Model,
  type StreamOptions,
} from '@earendil-works/pi-ai';

import {
  configureInstallationAdmission,
  resetInstallationAdmissionForTests,
} from '../src/config/installation-admission.ts';
import {
  createInstallationModelAccessResolver,
  installationModelAccessGrant,
  RuntimeModelReadinessError,
  withStatelessModelAccess,
} from '../src/config/installation-model-access.ts';
import { installationScopeOf, scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  configureModelAccessResolver,
  createModelAccessInterceptor,
  resetModelAccessForTests,
  type AttemptModelAccess,
} from '../src/config/model-access.ts';
import {
  ModelCredentialConflictError,
  ModelCredentialRevisionError,
  ModelCredentialUnavailableError,
  installationModelCredentialVersion,
  migratePlaintextModelCredentials,
  readHostedModelCredential,
  resolveModelCredentialAttribution,
  rewrapHostedModelCredentials,
  rotateInstallationModelCredential,
  storedCredentialMetadata,
  type ModelCredentialAction,
} from '../src/config/model-credential-refs.ts';
import { registerPiProvider, registeredPiProvider } from '../src/config/pi-provider-registry.ts';
import {
  deleteProviderApiKey,
  describeProviderKeySources,
  invalidateProviderKeyCache,
  resolveProviderApiKey,
  saveProviderApiKey,
  type ProviderKeyId,
} from '../src/config/provider-keys.ts';
import { SqliteSettingsStore, type PublishModelCredentialInput } from '../src/config/settings-store.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { useDeploymentKeyring } from './helpers/deployment-keyring.ts';
import { withEnv } from './helpers/env.ts';

const HOSTED = { CHICKPEA_TENANCY: 'installation' } as const;
const NO_DEPLOYMENT_KEYS = {
  CHICKPEA_TENANCY: undefined,
  ANTHROPIC_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  ANTHROPIC_BASE_URL: undefined,
  LOCAL_STUB_URL: undefined,
};
const KEY_1 = 'sk-ant-hosted-tenant-key-one';
const KEY_2 = 'sk-ant-hosted-tenant-key-two';
const AGENT_OPERATION = { type: 'agent', operationId: 'op', operationKind: 'prompt' } as const;

/** Two installations of a deployment serving many, sharing the deployment's credential keyring. */
function hostedInstallations(t: TestContext) {
  resetModelAccessForTests();
  invalidateProviderKeyCache();
  // The host's registry admits both, as a deployment serving many installs it.
  configureInstallationAdmission(async () => 'admitted');
  const envA = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: 'inst_a' });
  const envB = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: 'inst_b' });
  const settings = new Map([['inst_a', new SqliteSettingsStore(':memory:')], ['inst_b', new SqliteSettingsStore(':memory:')]]);
  const usage = new SqliteUsageStore(':memory:');
  const keyring = useDeploymentKeyring(t);
  t.after(() => {
    for (const store of settings.values()) store.close();
    usage.close();
    resetModelAccessForTests();
    resetInstallationAdmissionForTests();
  });
  const settingsOf = (env: PlatformEnv | undefined) => settings.get(installationScopeOf(env)?.installationId ?? '')!;
  // Every reader and writer loads the deployment keyring, as in production.
  configureModelAccessResolver(createInstallationModelAccessResolver({ settings: settingsOf }));
  const rotate = (env: PlatformEnv, action: ModelCredentialAction, extra: { expectedVersion?: number } = {}) =>
    rotateInstallationModelCredential('anthropic', action, { env, settings: settingsOf(env), usage, ...extra });
  const read = (env: PlatformEnv, expected?: { credentialRefId: string; version: number }) =>
    readHostedModelCredential('anthropic', { env, settings: settingsOf(env) }, expected);
  return { envA, envB, settingsOf, usage, keyring, rotate, read };
}

function recordingProvider(sent: Array<{ step: string; apiKey: string | undefined }>): Model<'anthropic-messages'> {
  const model = {
    id: 'probe-model', name: 'Probe model', api: 'anthropic-messages', provider: 'anthropic',
    baseUrl: 'https://provider.invalid', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_000, maxTokens: 1_024,
  } as Model<'anthropic-messages'>;
  const stream = (_model: Model<string>, context: Context, options?: StreamOptions) => {
    const last = context.messages.at(-1);
    sent.push({ step: typeof last?.content === 'string' ? last.content : '', apiKey: options?.apiKey });
    const output = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: 'anthropic-messages', provider: 'anthropic',
      model: 'probe-model', stopReason: 'stop', timestamp: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    queueMicrotask(() => { output.push({ type: 'done', reason: 'stop', message }); output.end(); });
    return output;
  };
  registerPiProvider(createProvider({
    id: 'anthropic',
    auth: { apiKey: { name: 'probe', resolve: async () => ({ auth: {} }) } },
    models: [model],
    api: { stream, streamSimple: stream },
  }));
  return model;
}

function modelCall(model: Model<string>, step: string) {
  return registeredPiProvider(model.provider)!.streamSimple(model, {
    systemPrompt: 'probe', messages: [{ role: 'user', content: step, timestamp: 1 }],
  }, {}).result();
}

/** Every value the settings store holds in either realm, to look for a key in the clear. */
async function storedText(store: SqliteSettingsStore): Promise<string> {
  const keys = ['credentialRefId', 'credentialVersion', 'credentialActive', 'credentialActiveFrom', 'apiKey']
    .map((suffix) => `provider.anthropic.${suffix}`);
  return JSON.stringify([await store.getSettings(keys), await store.getEncryptedCredentialRevision('model_provider.anthropic')]);
}

test('an installation of a deployment serving many keeps its key only encrypted, with usage attribution per version', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { envA, settingsOf, usage, rotate, read } = hostedInstallations(t);
    const first = await rotate(envA, { kind: 'save', apiKey: KEY_1 });
    assert.equal(first.version, 1);
    assert.equal(await settingsOf(envA).getSetting('provider.anthropic.apiKey'), undefined);
    const envelope = await settingsOf(envA).getEncryptedCredentialRevision('model_provider.anthropic');
    assert.deepEqual({ revision: envelope?.revision, contextId: envelope?.contextId }, { revision: 'v1', contextId: first.credentialRefId });
    assert.equal((await storedText(settingsOf(envA))).includes(KEY_1), false, 'no stored value carries the key');
    assert.equal((await read(envA))?.apiKey, KEY_1);

    // Usage attribution keeps one stable reference and a version per key.
    const attributed = await resolveModelCredentialAttribution('anthropic/claude-haiku-4-5', envA, settingsOf(envA), usage);
    assert.deepEqual(
      { ref: attributed?.credentialRefId, version: attributed?.version, source: attributed?.sourceKind },
      { ref: first.credentialRefId, version: 1, source: 'stored' },
    );
    const second = await rotate(envA, { kind: 'save', apiKey: KEY_2 });
    assert.deepEqual({ ref: second.credentialRefId, version: second.version }, { ref: first.credentialRefId, version: 2 });
    const rows = await usage.listCredentials('anthropic');
    assert.notEqual(rows.find((row) => row.version === 1)?.retiredAt, null);
    assert.equal(rows.find((row) => row.version === 2)?.retiredAt, null);
    assert.equal((await storedCredentialMetadata('anthropic', settingsOf(envA)))?.version, 2,
      'revision readers (management, setup) see the same metadata');
  });
});

test('a read for a superseded version is a revision change, never the newer key', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { envA, rotate, read } = hostedInstallations(t);
    const first = await rotate(envA, { kind: 'save', apiKey: KEY_1 });
    await rotate(envA, { kind: 'save', apiKey: KEY_2 });
    await assert.rejects(read(envA, { credentialRefId: first.credentialRefId, version: 1 }), (error: unknown) =>
      error instanceof ModelCredentialRevisionError && error.expectedVersion === 1 &&
      !error.message.includes(KEY_1) && !error.message.includes(KEY_2));
    assert.equal((await read(envA, { credentialRefId: first.credentialRefId, version: 2 }))?.apiKey, KEY_2);
    await assert.rejects(read(envA, { credentialRefId: 'cred_anthropic_other', version: 2 }), ModelCredentialRevisionError);
  });
});

test('two concurrent rotations: one publishes, the other gets a version conflict and changes nothing', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { envA, settingsOf, usage, keyring, rotate, read } = hostedInstallations(t);
    const first = await rotate(envA, { kind: 'save', apiKey: KEY_1 });
    // Both writers read version 1 and encrypt for version 2 before either publishes.
    const publications: boolean[] = [];
    const spying = Object.create(settingsOf(envA)) as SqliteSettingsStore;
    spying.publishModelCredential = async (input) => {
      const published = await settingsOf(envA).publishModelCredential(input);
      publications.push(published);
      return published;
    };
    const writer = (apiKey: string) => rotateInstallationModelCredential('anthropic', { kind: 'save', apiKey },
      { env: envA, settings: spying, usage, keyring, expectedVersion: 1 });
    const results = await Promise.allSettled([writer('sk-ant-writer-one'), writer('sk-ant-writer-two')]);
    assert.deepEqual(publications, [true, false], 'the store fenced the second publication');
    assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
    const lost = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    assert.ok(lost.reason instanceof ModelCredentialConflictError);
    const winner = results.findIndex((result) => result.status === 'fulfilled');
    const current = await read(envA, { credentialRefId: first.credentialRefId, version: 2 });
    assert.equal(current?.apiKey, winner === 0 ? 'sk-ant-writer-one' : 'sk-ant-writer-two');

    // Without an expected version (Admin's save), both land in order on distinct versions.
    const unfenced = await Promise.all([
      rotate(envA, { kind: 'save', apiKey: 'sk-ant-admin-one' }),
      rotate(envA, { kind: 'save', apiKey: 'sk-ant-admin-two' }),
    ]);
    assert.deepEqual(unfenced.map((metadata) => metadata.version).sort(), [3, 4]);
    const latest = await read(envA);
    assert.equal(latest?.metadata.version, 4);
    assert.equal(latest?.apiKey, unfenced.find((metadata) => metadata.version === 4) === unfenced[0] ? 'sk-ant-admin-one' : 'sk-ant-admin-two');
  });
});

test('a failure between encryption and publication leaves the previous version and key in place', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { envA, settingsOf, usage, keyring, read } = hostedInstallations(t);
    const first = await rotateInstallationModelCredential('anthropic', { kind: 'save', apiKey: KEY_1 },
      { env: envA, settings: settingsOf(envA), usage, keyring });
    const frozen = await installationModelAccessGrant('anthropic', envA, 'run_before', settingsOf(envA));

    // The store call that would publish fails (a lost connection, a crash) after the key was encrypted.
    const published: PublishModelCredentialInput[] = [];
    const failing = Object.create(settingsOf(envA)) as SqliteSettingsStore;
    failing.publishModelCredential = async (input) => { published.push(input); throw new Error('state store unavailable'); };
    await assert.rejects(rotateInstallationModelCredential('anthropic', { kind: 'save', apiKey: KEY_2 },
      { env: envA, settings: failing, usage, keyring }), /state store unavailable/);
    assert.equal(published.length, 1);
    assert.equal(JSON.stringify(published[0]).includes(KEY_2), false, 'only ciphertext reached the store call');

    // A failure before the store call (the usage registry) publishes nothing either.
    const brokenUsage = Object.create(usage) as SqliteUsageStore;
    brokenUsage.putCredential = async () => { throw new Error('usage store unavailable'); };
    await assert.rejects(rotateInstallationModelCredential('anthropic', { kind: 'delete' },
      { env: envA, settings: settingsOf(envA), usage: brokenUsage, keyring }), /usage store unavailable/);

    assert.deepEqual(await read(envA, { credentialRefId: first.credentialRefId, version: 1 }),
      { apiKey: KEY_1, metadata: first });
    await withModelCall(frozen!, envA, KEY_1);
  });
});

async function withModelCall(grant: NonNullable<Awaited<ReturnType<typeof installationModelAccessGrant>>>, env: PlatformEnv, expected: string) {
  const sent: Array<{ step: string; apiKey: string | undefined }> = [];
  const model = recordingProvider(sent);
  const interceptor = createModelAccessInterceptor({
    lookup: async () => ({ env, grant }),
    installationGrants: async () => [],
  });
  await interceptor(AGENT_OPERATION, { instanceId: 'agent_check', submissionId: 'sub_check' }, () => modelCall(model, 'check'));
  assert.deepEqual(sent, [{ step: 'check', apiKey: expected }]);
}

test('deletion fails the next attempt closed while the running attempt keeps its frozen version', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { envA, envB, settingsOf, rotate } = hostedInstallations(t);
    await rotate(envA, { kind: 'save', apiKey: KEY_1 });
    await rotate(envB, { kind: 'save', apiKey: KEY_2 });
    const sent: Array<{ step: string; apiKey: string | undefined }> = [];
    const model = recordingProvider(sent);
    const grantA = (await installationModelAccessGrant('anthropic', envA, 'sub_a', settingsOf(envA)))!;
    const grantB = (await installationModelAccessGrant('anthropic', envB, 'sub_b', settingsOf(envB)))!;
    const records = new Map<string, AttemptModelAccess>([['agent_a', { env: envA, grant: grantA }], ['agent_b', { env: envB, grant: grantB }]]);
    const interceptor = createModelAccessInterceptor({
      lookup: async (context) => records.get(context.instanceId!)!,
      installationGrants: async () => [],
    });
    const attempt = (instanceId: string, run: () => Promise<unknown>) =>
      interceptor(AGENT_OPERATION, { instanceId, submissionId: `sub_${instanceId}` }, run);

    await attempt('agent_a', async () => {
      await modelCall(model, 'A-before-delete');
      await rotate(envA, { kind: 'delete' });
      await modelCall(model, 'A-after-delete-same-attempt');
    });
    assert.deepEqual(sent, [
      { step: 'A-before-delete', apiKey: KEY_1 },
      { step: 'A-after-delete-same-attempt', apiKey: KEY_1 },
    ]);

    sent.length = 0;
    await assert.rejects(attempt('agent_a', () => modelCall(model, 'A-next-attempt')), ModelCredentialRevisionError);
    assert.equal(await installationModelAccessGrant('anthropic', envA, 'run', settingsOf(envA)), undefined);
    assert.deepEqual(await resolveProviderApiKey('anthropic', envA, settingsOf(envA)), { apiKey: undefined, source: 'missing' });
    await assert.rejects(
      withStatelessModelAccess('anthropic/claude-haiku-4-5', { env: envA, settings: settingsOf(envA), runId: 'classifier' }, async () => undefined),
      (error: unknown) => error instanceof RuntimeModelReadinessError && error.status === 'provider_setup_required',
    );
    await attempt('agent_b', () => modelCall(model, 'B-unaffected'));
    assert.deepEqual(sent, [{ step: 'B-unaffected', apiKey: KEY_2 }]);
    assert.equal(await settingsOf(envA).getEncryptedCredentialRevision('model_provider.anthropic'), undefined,
      'the deleted key is gone, not kept as history');
  });
});

test('an envelope opens only in its own installation and with the deployment keyring', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { envA, envB, settingsOf, keyring, rotate, read } = hostedInstallations(t);
    const saved = await rotate(envA, { kind: 'save', apiKey: KEY_1 });
    // Copy A's whole credential (metadata and envelope) into B's store.
    const row = (await settingsOf(envA).getEncryptedCredentialRevision('model_provider.anthropic'))!;
    for (const [suffix, value] of Object.entries({ credentialRefId: saved.credentialRefId, credentialVersion: '1', credentialActive: 'true', credentialActiveFrom: String(saved.activeFrom) })) {
      await settingsOf(envB).setSetting(`provider.anthropic.${suffix}`, value);
    }
    await settingsOf(envB).replaceEncryptedCredentialRevision({ key: row.key, expectedRevision: null, revision: row.revision, contextId: row.contextId, envelope: row.envelope });
    const grantB = (await installationModelAccessGrant('anthropic', envB, 'run', settingsOf(envB)))!;
    // It will not decrypt for B; a turn gets the repair a missing key gets.
    await assert.rejects(withModelCall(grantB, envB, KEY_1), (error: unknown) =>
      error instanceof RuntimeModelReadinessError && error.status === 'provider_setup_required' &&
      !error.message.includes(KEY_1));
    await assert.rejects(resolveProviderApiKey('anthropic', envB, settingsOf(envB)), (error: unknown) =>
      error instanceof ModelCredentialUnavailableError && !error.message.includes(KEY_1));

    // Other material under the same key ID fails to decrypt; a keyring without that key ID reads nothing.
    await assert.rejects(
      readHostedModelCredential('anthropic', { env: envA, settings: settingsOf(envA), keyring: generateCredentialKeyring(keyring.currentKeyId) }),
      ModelCredentialUnavailableError,
    );
    assert.equal(await readHostedModelCredential('anthropic', { env: envA, settings: settingsOf(envA), keyring: generateCredentialKeyring('key_other') }), undefined);
    assert.equal((await read(envA))?.apiKey, KEY_1);
  });
});

test('a key whose keyring slot was retired reads as missing everywhere, and a rewrap first keeps it', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { envA, envB, settingsOf, keyring, rotate } = hostedInstallations(t);
    const savedA = await rotate(envA, { kind: 'save', apiKey: KEY_1 });
    await rotate(envB, { kind: 'save', apiKey: KEY_2 });
    const frozenA = (await installationModelAccessGrant('anthropic', envA, 'run_frozen', settingsOf(envA)))!;

    // The deployment keyring gains a new current key; A is rewrapped before the old slot goes, B is not.
    const next = generateCredentialKeyring('key_next');
    const rotated = { currentKeyId: next.currentKeyId, keys: { ...keyring.keys, ...next.keys } };
    writeFileSync(process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH!, `${JSON.stringify({ version: 1, ...rotated })}\n`, { mode: 0o600 });
    assert.deepEqual(await rewrapHostedModelCredentials({ env: envA, settings: settingsOf(envA), keyring: rotated }),
      { rewrapped: ['anthropic'], alreadyCurrent: [], remaining: [] });
    assert.deepEqual(await rewrapHostedModelCredentials({ env: envA, settings: settingsOf(envA), keyring: rotated }),
      { rewrapped: [], alreadyCurrent: [], remaining: [] }, 'nothing left under the old key');
    assert.equal((await settingsOf(envA).getEncryptedCredentialRevision('model_provider.anthropic'))?.envelope.keyId, 'key_next');
    assert.equal((await storedCredentialMetadata('anthropic', settingsOf(envA)))?.version, savedA.version, 'the version stays');

    // Retire the old slot.
    const retired = { currentKeyId: next.currentKeyId, keys: next.keys };
    writeFileSync(process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH!, `${JSON.stringify({ version: 1, ...retired })}\n`, { mode: 0o600 });

    // A still works, even for the run frozen before the rewrap.
    await withModelCall(frozenA, envA, KEY_1);
    assert.equal((await describeProviderKeySources(envA, settingsOf(envA))).anthropic, 'stored');

    // B's key is unreadable now, and every reader says so the same way.
    assert.equal((await describeProviderKeySources(envB, settingsOf(envB))).anthropic, 'missing');
    assert.deepEqual(await resolveProviderApiKey('anthropic', envB, settingsOf(envB)), { apiKey: undefined, source: 'missing' });
    assert.equal(await installationModelAccessGrant('anthropic', envB, 'run', settingsOf(envB)), undefined);
    await assert.rejects(
      withStatelessModelAccess('anthropic/claude-haiku-4-5', { env: envB, settings: settingsOf(envB), runId: 'classifier' }, async () => undefined),
      (error: unknown) => error instanceof RuntimeModelReadinessError && error.status === 'provider_setup_required',
    );
    assert.deepEqual(await rewrapHostedModelCredentials({ env: envB, settings: settingsOf(envB), keyring: retired }),
      { rewrapped: [], alreadyCurrent: [], remaining: ['anthropic'] }, 'a key under a lost key ID cannot be rewrapped');
    // Saving the key again repairs it.
    await rotate(envB, { kind: 'save', apiKey: KEY_2 });
    assert.equal((await resolveProviderApiKey('anthropic', envB, settingsOf(envB))).apiKey, KEY_2);
  });
});

test('damaged metadata reads at the version the fence sees, and the next save repairs it', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { envA, settingsOf, usage, rotate } = hostedInstallations(t);
    await settingsOf(envA).applySettingsPatch({
      set: [
        { key: 'provider.anthropic.credentialVersion', value: '3' },
        { key: 'provider.anthropic.credentialActive', value: 'true' },
      ],
    });
    assert.equal(await installationModelCredentialVersion('anthropic', envA, settingsOf(envA)), 3,
      'management and setup fence on the same version');
    assert.equal((await describeProviderKeySources(envA, settingsOf(envA))).anthropic, 'missing');
    const repaired = await rotateInstallationModelCredential('anthropic', { kind: 'save', apiKey: KEY_1 },
      { env: envA, settings: settingsOf(envA), usage, expectedVersion: 3 });
    assert.equal(repaired.version, 4);
    assert.match(repaired.credentialRefId, /^cred_anthropic_/);
    assert.equal((await resolveProviderApiKey('anthropic', envA, settingsOf(envA))).apiKey, KEY_1);
    assert.equal((await rotate(envA, { kind: 'save', apiKey: KEY_2 })).version, 5);
  });
});

test('Admin, management and setup saves go through the encrypted operation; standalone keeps its settings key', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-hosted-keys-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await withEnv({ ...NO_DEPLOYMENT_KEYS, CHICKPEA_CREDENTIAL_KEYRING_PATH: join(dir, 'keyring.json') }, async () => {
    invalidateProviderKeyCache();
    const env = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: 'inst_admin' });
    const hosted = new SqliteSettingsStore(':memory:');
    const standalone = new SqliteSettingsStore(':memory:');
    const usage = new SqliteUsageStore(':memory:');
    t.after(() => { hosted.close(); standalone.close(); usage.close(); invalidateProviderKeyCache(); });

    await saveProviderApiKey('anthropic', KEY_1, env, hosted, usage);
    assert.equal(await hosted.getSetting('provider.anthropic.apiKey'), undefined);
    assert.equal((await describeProviderKeySources(env, hosted)).anthropic, 'stored');
    assert.deepEqual(await resolveProviderApiKey('anthropic', env, hosted), { apiKey: KEY_1, source: 'stored' });
    // Setup's fenced replacement, then management's removal.
    await assert.rejects(saveProviderApiKey('anthropic', KEY_2, env, hosted, usage, 0), ModelCredentialConflictError);
    await saveProviderApiKey('anthropic', KEY_2, env, hosted, usage, 1);
    assert.deepEqual(await resolveProviderApiKey('anthropic', env, hosted), { apiKey: KEY_2, source: 'stored' });
    assert.deepEqual(await deleteProviderApiKey('anthropic', env, hosted, usage), { apiKey: undefined, source: 'missing' });
    assert.equal((await storedCredentialMetadata('anthropic', hosted))?.version, 3);

    await saveProviderApiKey('anthropic', KEY_1, undefined, standalone, usage);
    assert.equal(await standalone.getSetting('provider.anthropic.apiKey'), KEY_1);
    assert.equal(await standalone.getEncryptedCredentialRevision('model_provider.anthropic'), undefined);
    assert.deepEqual(await resolveProviderApiKey('anthropic', undefined, standalone), { apiKey: KEY_1, source: 'stored' });
  });
});

test('an encrypted credential needs its installation, and a store that can hold it', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { envA, settingsOf, usage, keyring, rotate } = hostedInstallations(t);
    await rotate(envA, { kind: 'save', apiKey: KEY_1 });
    const unscoped = HOSTED as Record<string, unknown>;
    await assert.rejects(rotateInstallationModelCredential('anthropic', { kind: 'save', apiKey: KEY_2 },
      { env: unscoped, settings: settingsOf(envA), usage, keyring }), /has none/);
    await assert.rejects(readHostedModelCredential('anthropic', { env: unscoped, settings: settingsOf(envA), keyring }), /has none/);
    const plain = { getSetting: async () => undefined } as unknown as SqliteSettingsStore;
    await assert.rejects(rotateInstallationModelCredential('openai' as ProviderKeyId, { kind: 'save', apiKey: KEY_2 },
      { env: envA, settings: plain, usage, keyring }), /cannot hold encrypted model credentials/);
  });
});

/** A key an earlier build saved in the clear for a hosted installation, with its metadata. */
async function legacyPlaintextKey(store: SqliteSettingsStore, apiKey: string, active = true) {
  await store.applySettingsPatch({
    set: [
      { key: 'provider.anthropic.apiKey', value: apiKey },
      { key: 'provider.anthropic.credentialRefId', value: 'cred_anthropic_legacy-plaintext-reference' },
      { key: 'provider.anthropic.credentialVersion', value: '1' },
      { key: 'provider.anthropic.credentialActive', value: String(active) },
      { key: 'provider.anthropic.credentialActiveFrom', value: '10' },
    ],
  });
}

test('the explicit migration encrypts a hosted plaintext key once, under the next version', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { envA, settingsOf, usage, keyring, read } = hostedInstallations(t);
    const legacyRef = 'cred_anthropic_legacy-plaintext-reference';
    await legacyPlaintextKey(settingsOf(envA), KEY_1);
    assert.equal(await installationModelAccessGrant('anthropic', envA, 'run_legacy', settingsOf(envA)), undefined,
      'a hosted installation never uses a key kept in the clear');
    await usage.putCredential({
      credentialRefId: legacyRef, version: 1, providerId: 'anthropic', sourceKind: 'stored',
      label: 'Stored Anthropic credential', scopeLabel: null, unknownRotation: false, activeFrom: 10,
    });

    const migrate = () => migratePlaintextModelCredentials({ env: envA, settings: settingsOf(envA), usage, keyring });
    assert.deepEqual(await migrate(), { migrated: ['anthropic'], removed: [] });
    assert.equal(await settingsOf(envA).getSetting('provider.anthropic.apiKey'), undefined);
    assert.equal((await read(envA, { credentialRefId: legacyRef, version: 2 }))?.apiKey, KEY_1);
    await assert.rejects(read(envA, { credentialRefId: legacyRef, version: 1 }), ModelCredentialRevisionError);
    const rows = await usage.listCredentials('anthropic');
    assert.notEqual(rows.find((row) => row.version === 1)?.retiredAt, null);
    assert.equal(rows.find((row) => row.version === 2)?.retiredAt, null);

    // Idempotent: nothing is left to migrate.
    assert.deepEqual(await migrate(), { migrated: [], removed: [] });
    assert.equal((await storedCredentialMetadata('anthropic', settingsOf(envA)))?.version, 2);
  });
});

test('the migration removes a stale plaintext without reviving a deleted key, and refuses standalone', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { envA, envB, settingsOf, usage, keyring, rotate } = hostedInstallations(t);
    await legacyPlaintextKey(settingsOf(envA), KEY_1, false);
    assert.deepEqual(await migratePlaintextModelCredentials({ env: envA, settings: settingsOf(envA), usage, keyring }),
      { migrated: [], removed: ['anthropic'] });
    assert.equal(await settingsOf(envA).getSetting('provider.anthropic.apiKey'), undefined);
    assert.equal(await settingsOf(envA).getEncryptedCredentialRevision('model_provider.anthropic'), undefined);
    assert.equal((await storedCredentialMetadata('anthropic', settingsOf(envA)))?.version, 1);

    // Beside an encrypted key, the encrypted key stands and its version does not move.
    await rotate(envB, { kind: 'save', apiKey: KEY_2 });
    await settingsOf(envB).setSetting('provider.anthropic.apiKey', 'sk-ant-stray-plaintext');
    assert.deepEqual(await migratePlaintextModelCredentials({ env: envB, settings: settingsOf(envB), usage, keyring }),
      { migrated: [], removed: ['anthropic'] });
    assert.equal((await readHostedModelCredential('anthropic', { env: envB, settings: settingsOf(envB), keyring }))?.apiKey, KEY_2);
    assert.equal((await storedCredentialMetadata('anthropic', settingsOf(envB)))?.version, 1);

    const standalone = new SqliteSettingsStore(':memory:');
    t.after(() => standalone.close());
    await standalone.setSetting('provider.anthropic.apiKey', KEY_1);
    await assert.rejects(migratePlaintextModelCredentials({ env: undefined, settings: standalone, usage, keyring }),
      /Only an installation of a deployment serving many/);
    assert.equal(await standalone.getSetting('provider.anthropic.apiKey'), KEY_1);
  });
});

test('nothing runs the plaintext migration on its own', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const callers = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.ts'))
    .filter((path) => readFileSync(join(root, path), 'utf8').includes('migratePlaintextModelCredentials('));
  assert.deepEqual(callers, [join('config', 'model-credential-refs.ts')],
    'only its definition: an operator invokes it explicitly');
});
