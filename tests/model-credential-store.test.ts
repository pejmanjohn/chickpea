import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { CfSettingsStore, FreshTagStateStubs, replaySafeStateRpc } from '../src/config/cf-state-proxies.ts';
import {
  SettingsStoreLogic,
  SqliteSettingsStore,
  type EncryptedCredentialStore,
  type ModelCredentialStore,
  type PublishModelCredentialInput,
  type RewrapModelCredentialInput,
  type SettingsStore,
} from '../src/config/settings-store.ts';
import type { TagStateRpc } from '../src/config/state-rpc.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { encryptModelProviderKeyEnvelope, type SlackSecretEnvelope } from '../src/slack/secret-envelope.ts';
import { NodeStateDb, openStateDb } from '../src/state/node-state-db.ts';

const REF = 'cred_anthropic_9b1f4c2e-7d3a-4c55-9e0b-1a2b3c4d5e6f';
const keyring = generateCredentialKeyring('key_store');
const nextKeyring = generateCredentialKeyring('key_next');

function envelopeFor(version: number, apiKey: string, encryptWith = keyring): Promise<SlackSecretEnvelope> {
  return encryptModelProviderKeyEnvelope(encryptWith, {
    purpose: 'model_provider_key',
    installationId: 'inst_tenant_a',
    providerId: 'anthropic',
    credentialRefId: REF,
    credentialVersion: version,
  }, apiKey);
}

function publication(expectedVersion: number, envelope?: SlackSecretEnvelope): PublishModelCredentialInput {
  return {
    providerId: 'anthropic',
    expectedVersion,
    credentialRefId: REF,
    version: expectedVersion + 1,
    activeFrom: 1_000 + expectedVersion,
    ...(envelope ? { envelope } : {}),
  };
}

async function storeContract(store: SettingsStore & EncryptedCredentialStore & ModelCredentialStore): Promise<void> {
  assert.equal(await store.readModelCredential('anthropic'), undefined);
  // A plaintext key left by an earlier build never survives a publication.
  await store.setSetting('provider.anthropic.apiKey', 'sk-ant-plaintext-leftover');

  const first = await envelopeFor(1, 'sk-ant-first');
  assert.equal(await store.publishModelCredential(publication(0, first)), true);
  assert.deepEqual(await store.readModelCredential('anthropic'), {
    credentialRefId: REF, version: 1, active: true, activeFrom: 1_000, envelope: first,
  });
  assert.equal(await store.getSetting('provider.anthropic.apiKey'), undefined);

  // Two writers that both read version 1: one publishes, the other changes nothing.
  const [winner, loser] = await Promise.all([envelopeFor(2, 'sk-ant-winner'), envelopeFor(2, 'sk-ant-loser')]);
  assert.deepEqual(
    await Promise.all([store.publishModelCredential(publication(1, winner)), store.publishModelCredential(publication(1, loser))]),
    [true, false],
  );
  assert.deepEqual((await store.readModelCredential('anthropic'))?.envelope, winner);
  assert.equal((await store.readModelCredential('anthropic'))?.version, 2);
  // A replay of the publication that committed finds exactly what it wrote; the loser stays refused.
  assert.equal(await store.publishModelCredential(publication(1, winner)), true);
  assert.equal(await store.publishModelCredential(publication(1, loser)), false);
  assert.equal((await store.readModelCredential('anthropic'))?.version, 2);

  // Deletion advances the version and removes the key; the store keeps no earlier one.
  assert.equal(await store.publishModelCredential(publication(2)), true);
  assert.equal(await store.publishModelCredential(publication(2)), true, 'a replayed deletion succeeds');
  assert.deepEqual(await store.readModelCredential('anthropic'), {
    credentialRefId: REF, version: 3, active: false, activeFrom: 1_002,
  });
  assert.equal(await store.getEncryptedCredentialRevision('model_provider.anthropic'), undefined);
  // A stale writer cannot resurrect a key after deletion.
  assert.equal(await store.publishModelCredential(publication(2, await envelopeFor(3, 'sk-ant-stale'))), false);
  assert.equal((await store.readModelCredential('anthropic'))?.active, false);

  // A later save continues the same reference and version line.
  const fourth = await envelopeFor(4, 'sk-ant-fourth');
  assert.equal(await store.publishModelCredential(publication(3, fourth)), true);
  assert.deepEqual(await store.readModelCredential('anthropic'), {
    credentialRefId: REF, version: 4, active: true, activeFrom: 1_003, envelope: fourth,
  });

  // A version names at most one published key, and nothing malformed is accepted.
  for (const invalid of [
    { ...publication(4, fourth), version: 4 },
    { ...publication(4, fourth), version: 6 },
    { ...publication(4, fourth), providerId: 'Anthropic' },
    { ...publication(4, fourth), credentialRefId: 'short' },
    { ...publication(4, fourth), envelope: { ...fourth, algorithm: 'AES-CBC' as never } },
  ]) {
    await assert.rejects(store.publishModelCredential(invalid), /invalid/, JSON.stringify(invalid).slice(0, 80));
  }
  assert.equal((await store.readModelCredential('anthropic'))?.version, 4);

  // A rewrap re-encrypts the current key under a new key ID, fenced on version and key ID, version unchanged.
  const rewrapped = await envelopeFor(4, 'sk-ant-fourth', nextKeyring);
  const rewrap = { providerId: 'anthropic', expectedVersion: 4, expectedKeyId: 'key_store', envelope: rewrapped };
  assert.equal(await store.rewrapModelCredential({ ...rewrap, expectedVersion: 3 }), false);
  assert.equal(await store.rewrapModelCredential({ ...rewrap, expectedKeyId: 'key_other' }), false);
  assert.equal(await store.rewrapModelCredential(rewrap), true);
  assert.deepEqual(await store.readModelCredential('anthropic'), {
    credentialRefId: REF, version: 4, active: true, activeFrom: 1_003, envelope: rewrapped,
  });
  assert.equal(await store.rewrapModelCredential(rewrap), true, 'a replayed rewrap succeeds');
  // A stale rewrapper that read the old key ID loses to the one that committed.
  assert.equal(await store.rewrapModelCredential({ ...rewrap, envelope: await envelopeFor(4, 'sk-ant-fourth', nextKeyring) }), false);
  await assert.rejects(store.rewrapModelCredential({ ...rewrap, expectedKeyId: 'not a key id' }), /invalid/);
  assert.equal(await store.publishModelCredential(publication(4)), true);
  assert.equal(await store.rewrapModelCredential({ ...rewrap, expectedVersion: 5 }), false, 'nothing to rewrap once deleted');
}

test('the model credential operation fences on the version and publishes or deletes metadata and envelope together', async () => {
  const store = new SqliteSettingsStore(':memory:');
  try {
    await storeContract(store);
  } finally {
    store.close();
  }
});

test('the operation reaches the tenant state object through its RPC with the same results', async () => {
  const logic = new SettingsStoreLogic(new NodeStateDb(new DatabaseSync(':memory:')));
  const call = <T>(fn: () => T) => {
    try {
      // Structured clone stands in for the RPC boundary.
      return Promise.resolve({ ok: true as const, value: structuredClone(fn()) });
    } catch (error) {
      return Promise.resolve({ ok: false as const, error: { code: 'internal' as const, message: (error as Error).message } });
    }
  };
  const stub = {
    settingGet: (key: string) => call(() => logic.getSetting(key) ?? null),
    settingSet: (key: string, value: string) => call(() => { logic.setSetting(key, value); return null; }),
    encryptedCredentialGet: (key: string) => call(() => logic.getEncryptedCredentialRevision(key) ?? null),
    modelCredentialRead: (providerId: string) => call(() => logic.readModelCredential(providerId) ?? null),
    modelCredentialPublish: (input: PublishModelCredentialInput) =>
      call(() => logic.publishModelCredential(structuredClone(input))),
    modelCredentialRewrap: (input: RewrapModelCredentialInput) =>
      call(() => logic.rewrapModelCredential(structuredClone(input))),
  } as unknown as TagStateRpc;
  await storeContract(new CfSettingsStore(new FreshTagStateStubs(() => stub)));

  // A call lost to a disconnect is replayed once: a replay of a committed write succeeds.
  for (const method of ['modelCredentialRead', 'modelCredentialPublish', 'modelCredentialRewrap']) {
    assert.equal(replaySafeStateRpc(method), true, method);
  }
});

test('damaged metadata around a readable version reads at the version the publication fence sees', async () => {
  const store = new SqliteSettingsStore(':memory:');
  try {
    await store.applySettingsPatch({
      set: [
        { key: 'provider.anthropic.credentialVersion', value: '3' },
        { key: 'provider.anthropic.credentialActive', value: 'true' },
        { key: 'provider.anthropic.credentialActiveFrom', value: 'not-a-time' },
      ],
    });
    assert.deepEqual(await store.readModelCredential('anthropic'), {
      credentialRefId: '', version: 3, active: false, activeFrom: 0,
    });
    assert.equal(await store.publishModelCredential(publication(0, await envelopeFor(1, 'sk-ant-first'))), false);
    const repaired = await envelopeFor(4, 'sk-ant-repaired');
    assert.equal(await store.publishModelCredential(publication(3, repaired)), true);
    assert.deepEqual(await store.readModelCredential('anthropic'), {
      credentialRefId: REF, version: 4, active: true, activeFrom: 1_003, envelope: repaired,
    });
  } finally {
    store.close();
  }
});

test('a publication that fails part-way leaves the previous version and key intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-model-credential-'));
  const path = join(dir, 'state.db');
  const store = new SqliteSettingsStore(path);
  try {
    const first = await envelopeFor(1, 'sk-ant-first');
    assert.equal(await store.publishModelCredential(publication(0, first)), true);
    const before = await store.readModelCredential('anthropic');

    const triggerDb = openStateDb(path);
    triggerDb.exec(
      `CREATE TRIGGER block_envelope_write
       BEFORE UPDATE ON app_encrypted_credential_revisions
       BEGIN SELECT RAISE(ABORT, 'envelope write failed'); END`,
    );
    triggerDb.close();
    await assert.rejects(store.publishModelCredential(publication(1, await envelopeFor(2, 'sk-ant-second'))),
      /envelope write failed/);
    // The metadata written before the failing envelope write rolled back with it.
    assert.deepEqual(await store.readModelCredential('anthropic'), before);
    assert.deepEqual(await store.getSettings(['provider.anthropic.credentialVersion', 'provider.anthropic.credentialActive']),
      ['1', 'true']);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only the envelope published with the current reference and version is read as its key', async () => {
  const store = new SqliteSettingsStore(':memory:');
  try {
    const first = await envelopeFor(1, 'sk-ant-first');
    assert.equal(await store.publishModelCredential(publication(0, first)), true);
    // Metadata moved by something other than the operation no longer pairs with the stored envelope.
    await store.setSetting('provider.anthropic.credentialVersion', '2');
    assert.deepEqual(await store.readModelCredential('anthropic'), {
      credentialRefId: REF, version: 2, active: true, activeFrom: 1_000,
    });
    await store.setSetting('provider.anthropic.credentialVersion', '1');
    await store.setSetting('provider.anthropic.credentialRefId', 'cred_anthropic_another-reference');
    assert.equal((await store.readModelCredential('anthropic'))?.envelope, undefined);
  } finally {
    store.close();
  }
});
