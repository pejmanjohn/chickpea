import assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import {
  decryptModelProviderKeyEnvelope,
  decryptSlackSecretEnvelope,
  encryptModelProviderKeyEnvelope,
  encryptSlackSecretEnvelope,
  type ModelProviderKeyEnvelopeContext,
} from '../src/slack/secret-envelope.ts';

const KEY = 'sk-ant-envelope-tenant-key';
const CONTEXT: ModelProviderKeyEnvelopeContext = {
  purpose: 'model_provider_key',
  installationId: 'inst_tenant_a',
  providerId: 'anthropic',
  credentialRefId: 'cred_anthropic_0f6c2a',
  credentialVersion: 3,
};

test('a model provider key opens only under the installation, provider, reference and version it was published for', async () => {
  const keyring = generateCredentialKeyring('key_model');
  const envelope = await encryptModelProviderKeyEnvelope(keyring, CONTEXT, KEY);
  assert.equal(await decryptModelProviderKeyEnvelope(keyring, CONTEXT, envelope), KEY);
  assert.equal(JSON.stringify(envelope).includes(KEY), false, 'the envelope never carries the key in the clear');

  for (const changed of [
    { installationId: 'inst_tenant_b' },
    { providerId: 'openai' },
    { credentialRefId: 'cred_anthropic_other' },
    // A grant frozen to the superseded version cannot open the newer key, nor the reverse.
    { credentialVersion: 2 },
    { credentialVersion: 4 },
  ]) {
    await assert.rejects(
      decryptModelProviderKeyEnvelope(keyring, { ...CONTEXT, ...changed }, envelope),
      (error: unknown) => error instanceof Error &&
        error.message === 'Model credential envelope could not be decrypted.' && !error.message.includes(KEY),
      JSON.stringify(changed),
    );
  }
  await assert.rejects(decryptModelProviderKeyEnvelope(generateCredentialKeyring('key_model'), CONTEXT, envelope));
  await assert.rejects(
    decryptModelProviderKeyEnvelope(keyring, CONTEXT, { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}AA` }),
  );
  await assert.rejects(encryptModelProviderKeyEnvelope(keyring, { ...CONTEXT, credentialVersion: 0 }, KEY),
    /context is invalid/);
  await assert.rejects(
    encryptModelProviderKeyEnvelope(keyring, { ...CONTEXT, purpose: 'chatgpt_plan' as never }, KEY),
    /context is invalid/,
  );
});

test('model and Slack envelopes share the established encoding and never open as each other', async () => {
  const keyring = generateCredentialKeyring('key_shared');
  const model = await encryptModelProviderKeyEnvelope(keyring, CONTEXT, KEY);
  const slackContext = {
    deploymentId: CONTEXT.installationId,
    identityId: CONTEXT.providerId,
    identityClass: 'workspace_installation' as const,
    appId: CONTEXT.credentialRefId,
    teamId: null,
    purpose: 'managed_connector_project_key' as const,
    revision: String(CONTEXT.credentialVersion),
  };
  const slack = await encryptSlackSecretEnvelope(keyring, slackContext, { apiKey: KEY });

  // Version 1 AES-GCM-256, the current key, a 96-bit nonce and base64url ciphertext, as before.
  for (const envelope of [model, slack]) {
    assert.deepEqual(Object.keys(envelope).sort(), ['algorithm', 'ciphertext', 'keyId', 'nonce', 'version']);
    assert.equal(envelope.version, 1);
    assert.equal(envelope.algorithm, 'AES-GCM-256');
    assert.equal(envelope.keyId, 'key_shared');
    assert.match(envelope.nonce, /^[A-Za-z0-9_-]{16}$/);
    assert.match(envelope.ciphertext, /^[A-Za-z0-9_-]+$/);
  }
  await assert.rejects(decryptSlackSecretEnvelope(keyring, slackContext, model));
  await assert.rejects(decryptModelProviderKeyEnvelope(keyring, CONTEXT, slack));
  assert.deepEqual(await decryptSlackSecretEnvelope(keyring, slackContext, slack), { apiKey: KEY });
});
