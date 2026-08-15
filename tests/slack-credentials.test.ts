import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { SqliteIdentityStore } from '../src/identity/store.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../src/config/types.ts';
import {
  generateCredentialKeyring,
  loadOrCreateNodeCredentialKeyring,
  loadWorkerCredentialKeyring,
  retireNodeCredentialKey,
  stageNodeCredentialKeyRotation,
} from '../src/slack/credential-keyring.ts';
import {
  isTransientSlackApiError,
  readStoredSlackTeamInfo,
  slackBotIdentityInfo,
  slackConversationsList,
  slackIdentityAuthTest,
} from '../src/slack/credentials.ts';
import {
  promoteSlackCredentialBundle,
  resolveSlackControlPlaneAppCredentials,
  invalidateSlackIdentityCredentialCache,
  recoverMissingSlackCredentialBundle,
  resolveSlackIdentityCredentials,
  rotateSlackCredentialEncryption,
  SlackCredentialRecoveryOnlyError,
  stageSlackCredentialBundle,
  writeSlackIdentityCredentials,
} from '../src/slack/identity-credentials.ts';
import {
  decryptSlackSecretEnvelope,
  encryptSlackSecretEnvelope,
} from '../src/slack/secret-envelope.ts';
import { withEnv } from './helpers/env.ts';

test('AES-GCM Slack envelopes round trip and reject tamper, wrong keys, and cross-context swaps', async () => {
  const keyring = generateCredentialKeyring('key_primary');
  const context = {
    deploymentId: 'deployment_immutable',
    identityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
    identityClass: 'workspace_default' as const,
    appId: 'AAPP',
    teamId: 'TACME',
    purpose: 'connected_credentials' as const,
    revision: 'revision_1',
  };
  const secrets = {
    clientId: 'client-id-secret',
    clientSecret: 'client-secret-value',
    signingSecret: 'signing-secret-value',
    botToken: 'xoxb-bot-token-value',
  };

  const first = await encryptSlackSecretEnvelope(keyring, context, secrets);
  const second = await encryptSlackSecretEnvelope(keyring, context, secrets);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.deepEqual(await decryptSlackSecretEnvelope(keyring, context, first), secrets);

  const tampered = {
    ...first,
    ciphertext: `${first.ciphertext.startsWith('A') ? 'B' : 'A'}${first.ciphertext.slice(1)}`,
  };
  await assert.rejects(
    decryptSlackSecretEnvelope(keyring, context, tampered),
    /Slack credential envelope could not be decrypted/,
  );
  await assert.rejects(
    decryptSlackSecretEnvelope(generateCredentialKeyring('key_primary'), context, first),
    /Slack credential envelope could not be decrypted/,
  );
  await assert.rejects(
    decryptSlackSecretEnvelope(keyring, { ...context, teamId: 'TOTHER' }, first),
    /Slack credential envelope could not be decrypted/,
  );
});

test('Node and Worker keyrings are independent, versioned, and Node survives restart at 0600', (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'chickpea-keyring-test-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const keyringPath = path.join(directory, 'credential-keyring.json');
  const authSecret = process.env.CHICKPEA_AUTH_SECRET;
  process.env.CHICKPEA_AUTH_SECRET = 'auth-secret-must-not-be-used';
  try {
    assert.throws(
      () => loadOrCreateNodeCredentialKeyring({ env: { TAG_DB_PATH: ':memory:' } }),
      /requires CHICKPEA_CREDENTIAL_KEYRING_PATH when state is in memory/,
    );
    assert.throws(
      () => loadWorkerCredentialKeyring({}),
      /Cloudflare Slack credential encryption is not provisioned/,
    );
    const first = loadOrCreateNodeCredentialKeyring({ path: keyringPath });
    const serialized = readFileSync(keyringPath, 'utf8');
    const second = loadOrCreateNodeCredentialKeyring({ path: keyringPath });
    assert.deepEqual(second, first);
    assert.equal(statSync(keyringPath).mode & 0o777, 0o600);
    assert.doesNotMatch(serialized, /auth-secret-must-not-be-used/);
    chmodSync(keyringPath, 0o644);
    assert.throws(
      () => loadOrCreateNodeCredentialKeyring({ path: keyringPath }),
      /permissions are unsafe/,
    );
    chmodSync(keyringPath, 0o600);
    const restoredPath = path.join(directory, 'credential-keyring-restored.json');
    copyFileSync(keyringPath, restoredPath);
    chmodSync(restoredPath, 0o600);
    assert.deepEqual(loadOrCreateNodeCredentialKeyring({ path: restoredPath }), first);

    writeFileSync(`${restoredPath}.rotation.lock`, '2147483647', { mode: 0o600 });
    const staged = stageNodeCredentialKeyRotation({
      path: restoredPath,
      expectedCurrentKeyId: first.currentKeyId,
      nextKeyId: 'node_v2',
    });
    assert.equal(staged.currentKeyId, 'node_v2');
    assert.deepEqual(Object.keys(staged.keys).sort(), [first.currentKeyId, 'node_v2'].sort());
    assert.deepEqual(loadOrCreateNodeCredentialKeyring({ path: restoredPath }), staged);
    assert.throws(
      () => retireNodeCredentialKey('node_v2', { path: restoredPath }),
      /cannot retire its current key/,
    );
    const retired = retireNodeCredentialKey(first.currentKeyId, { path: restoredPath });
    assert.deepEqual(Object.keys(retired.keys), ['node_v2']);
    assert.deepEqual(loadOrCreateNodeCredentialKeyring({ path: restoredPath }), retired);
    assert.equal(statSync(restoredPath).mode & 0o777, 0o600);

    const worker = loadWorkerCredentialKeyring({
      CHICKPEA_CREDENTIAL_KEY_CURRENT_ID: 'worker_v2',
      CHICKPEA_CREDENTIAL_KEY_WORKER_V2: first.keys[first.currentKeyId],
      CHICKPEA_CREDENTIAL_KEY_WORKER_V1: generateCredentialKeyring('worker_v1').keys.worker_v1,
    });
    assert.equal(worker.currentKeyId, 'worker_v2');
    assert.deepEqual(Object.keys(worker.keys).sort(), ['worker_v1', 'worker_v2']);
  } finally {
    if (authSecret === undefined) delete process.env.CHICKPEA_AUTH_SECRET;
    else process.env.CHICKPEA_AUTH_SECRET = authSecret;
  }
});

test('encrypted state promotes one complete revision, ignores conflicting env, and fences its cache', async () => {
  const state = new SqliteIdentityStore(':memory:');
  const keyring = generateCredentialKeyring('key_v1');
  const dependencies = { state, keyring };
  try {
    const stagedApp = await stageSlackCredentialBundle(dependencies, {
      identityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      identityClass: 'workspace_default',
      purpose: 'app_credentials',
      expectedActiveRevision: null,
      appId: 'AAPP',
      teamId: null,
      manifestFingerprint: 'manifest-v1',
      secrets: {
        clientId: 'client-id-v1',
        clientSecret: 'client-secret-v1',
        signingSecret: 'signing-secret-v1',
      },
    });
    await promoteSlackCredentialBundle(dependencies, {
      identityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      candidateRevision: stagedApp.revision,
      expectedActiveRevision: null,
    });
    const stagedConnected = await stageSlackCredentialBundle(dependencies, {
      identityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      identityClass: 'workspace_default',
      purpose: 'connected_credentials',
      expectedActiveRevision: stagedApp.revision,
      appId: 'AAPP',
      teamId: 'TACME',
      botUserId: 'UBOT',
      grantedScopes: ['app_mentions:read', 'chat:write'],
      manifestFingerprint: 'manifest-v1',
      secrets: {
        clientId: 'client-id-v1',
        clientSecret: 'client-secret-v1',
        signingSecret: 'signing-secret-v1',
        botToken: 'xoxb-state-v1',
      },
    });
    await promoteSlackCredentialBundle(dependencies, {
      identityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      candidateRevision: stagedConnected.revision,
      expectedActiveRevision: stagedApp.revision,
    });

    await withEnv({
      SLACK_BOT_TOKEN: 'xoxb-conflicting-env',
      SLACK_SIGNING_SECRET: 'conflicting-env-secret',
      SLACK_BOT_USER_ID: 'U_ENV',
    }, async () => {
      assert.deepEqual(
        await resolveSlackIdentityCredentials(
          WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
          undefined,
          dependencies,
        ),
        {
          botToken: 'xoxb-state-v1',
          signingSecret: 'signing-secret-v1',
          botUserId: 'UBOT',
          connectionRevision: stagedConnected.revision,
        },
      );
    });
    assert.deepEqual(
      await resolveSlackControlPlaneAppCredentials(dependencies),
      {
        clientId: 'client-id-v1',
        clientSecret: 'client-secret-v1',
        signingSecret: 'signing-secret-v1',
        connectionRevision: stagedConnected.revision,
        appId: 'AAPP',
        teamId: 'TACME',
      },
    );
    const presentation = new SqliteSettingsStore(':memory:');
    try {
      await presentation.setSetting('slack.teamId', 'TSTALE');
      await presentation.setSetting('slack.teamName', 'Acme Inc');
      assert.deepEqual(
        await readStoredSlackTeamInfo(undefined, presentation, dependencies),
        { teamId: 'TACME', teamName: 'Acme Inc' },
      );
    } finally {
      presentation.close();
    }

    const stagedV2 = await stageSlackCredentialBundle(dependencies, {
      identityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      identityClass: 'workspace_default',
      purpose: 'connected_credentials',
      expectedActiveRevision: stagedConnected.revision,
      appId: 'AAPP',
      teamId: 'TACME',
      botUserId: 'UBOT',
      grantedScopes: ['app_mentions:read', 'chat:write'],
      manifestFingerprint: 'manifest-v1',
      secrets: {
        clientId: 'client-id-v1', clientSecret: 'client-secret-v2',
        signingSecret: 'signing-secret-v2', botToken: 'xoxb-state-v2',
      },
    });
    await promoteSlackCredentialBundle(dependencies, {
      identityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      candidateRevision: stagedV2.revision,
      expectedActiveRevision: stagedConnected.revision,
    });
    assert.equal(
      (await resolveSlackIdentityCredentials(
        WORKSPACE_DEFAULT_SLACK_IDENTITY_ID, undefined, dependencies,
      )).botToken,
      'xoxb-state-v2',
    );
  } finally {
    invalidateSlackIdentityCredentialCache();
    state.close();
  }
});

test('a primed cache cannot bypass AEAD when the active envelope changes in place', async () => {
  const state = new SqliteIdentityStore(':memory:');
  const keyring = generateCredentialKeyring('key_cache_tamper');
  try {
    await writeSlackIdentityCredentials(
      { state, keyring },
      WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      null,
      {
        botToken: 'xoxb-cache-original',
        signingSecret: 'cache-signing-original',
        botUserId: 'UCACHE',
        appId: 'ACACHE',
        teamId: 'TCACHE',
      },
    );
    assert.equal(
      (await resolveSlackIdentityCredentials(
        WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
        undefined,
        { state, keyring },
      )).botToken,
      'xoxb-cache-original',
    );
    const active = (await state.getActiveSlackCredentialRevision(
      WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
    ))!;
    const ciphertext = active.envelope!.ciphertext;
    const tamperedState = new Proxy(state, {
      get(target, property) {
        if (property === 'getActiveSlackCredentialRevision') {
          return async () => ({
            ...active,
            envelope: {
              ...active.envelope!,
              ciphertext: `${ciphertext.startsWith('A') ? 'B' : 'A'}${ciphertext.slice(1)}`,
            },
          });
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await assert.rejects(
      resolveSlackIdentityCredentials(
        WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
        undefined,
        { state: tamperedState, keyring },
      ),
      SlackCredentialRecoveryOnlyError,
    );
    assert.equal((await state.getAuthControl())?.healthGate, 'recovery_only');
  } finally {
    invalidateSlackIdentityCredentialCache();
    state.close();
  }
});

test('deployment AAD and encrypted credentials survive a state-store restart unchanged', async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'chickpea-credential-restart-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, 'tag-state.sqlite');
  const keyring = generateCredentialKeyring('key_restart');
  let deploymentId: string;
  const first = new SqliteIdentityStore(statePath);
  try {
    await writeSlackIdentityCredentials(
      { state: first, keyring },
      WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      null,
      {
        botToken: 'xoxb-restart', signingSecret: 'restart-signing-secret',
        botUserId: 'URESTART', appId: 'ARESTART', teamId: 'TRESTART',
      },
    );
    deploymentId = (await first.getSlackCredentialControl())!.deploymentId;
  } finally {
    first.close();
    invalidateSlackIdentityCredentialCache();
  }
  const restarted = new SqliteIdentityStore(statePath);
  try {
    assert.equal((await restarted.getSlackCredentialControl())?.deploymentId, deploymentId!);
    await withEnv({ CHICKPEA_AUTH_SECRET: 'rotated-unrelated-auth-secret' }, async () => {
      assert.equal(
        (await resolveSlackIdentityCredentials(
          WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
          undefined,
          { state: restarted, keyring },
        )).botToken,
        'xoxb-restart',
      );
    });
  } finally {
    restarted.close();
    invalidateSlackIdentityCredentialCache();
  }
});

test('dedicated bot envelopes cannot supply OIDC authority and rotation rewraps behind an epoch fence', async () => {
  const state = new SqliteIdentityStore(':memory:');
  const original = generateCredentialKeyring('key_v1');
  const nextOnly = generateCredentialKeyring('key_v2');
  const rotating = {
    currentKeyId: 'key_v2',
    keys: { ...original.keys, ...nextOnly.keys },
  };
  try {
    const revision = await writeSlackIdentityCredentials(
      { state, keyring: original },
      'slack_identity_finance',
      null,
      { botToken: 'xoxb-finance', signingSecret: 'finance-secret', botUserId: 'UFINANCE' },
    );
    await assert.rejects(
      resolveSlackControlPlaneAppCredentials(
        { state, keyring: original },
        'slack_identity_finance',
      ),
      /Dedicated Slack identities cannot supply control-plane OIDC credentials/,
    );
    const active = await state.getActiveSlackCredentialRevision('slack_identity_finance');
    assert.ok(active);
    const pendingRotation = await stageSlackCredentialBundle(
      { state, keyring: original },
      {
        identityId: 'slack_identity_finance',
        identityClass: 'dedicated_bot',
        purpose: 'bot_credentials',
        expectedActiveRevision: revision,
        appId: active.appId,
        teamId: active.teamId,
        botUserId: 'UFINANCE',
        secrets: { botToken: 'xoxb-pending', signingSecret: 'pending-secret' },
      },
    );

    const result = await rotateSlackCredentialEncryption(
      { state, keyring: rotating },
      { expectedEpoch: 1, previousKeyId: 'key_v1' },
    );
    assert.equal(result.rewrapped, 2);
    assert.equal(result.remainingPreviousKey, 0);
    assert.equal(
      (await state.getSlackCredentialRevision(
        pendingRotation.identityId,
        pendingRotation.revision,
      ))?.envelope?.keyId,
      'key_v2',
    );
    assert.equal(
      (await resolveSlackIdentityCredentials(
        'slack_identity_finance', undefined, { state, keyring: rotating },
      )).connectionRevision,
      revision,
    );
    await assert.rejects(
      writeSlackIdentityCredentials(
        { state, keyring: original },
        'slack_identity_finance',
        revision,
        { botToken: 'xoxb-stale', signingSecret: 'stale-secret' },
      ),
      /credential encryption epoch changed/,
    );
  } finally {
    state.close();
  }
});

test('a lost live key enters recovery_only and only same-app/team reauthorization can restore service', async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'chickpea-credential-recovery-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, 'tag-state.sqlite');
  const state = new SqliteIdentityStore(statePath);
  const original = generateCredentialKeyring('key_lost');
  const replacement = generateCredentialKeyring('key_recovery');
  const secrets = {
    clientId: 'client-recovery',
    clientSecret: 'client-secret-recovery',
    signingSecret: 'signing-secret-recovery',
    botToken: 'xoxb-recovery-token',
  };
  try {
    const revision = await writeSlackIdentityCredentials(
      { state, keyring: original },
      WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      null,
      {
        ...secrets,
        appId: 'ARECOVERY',
        teamId: 'TRECOVERY',
        botUserId: 'UBOTOLD',
        grantedScopes: ['chat:write'],
        validatedAt: 10,
        manifestFingerprint: 'manifest-recovery',
      },
    );
    await assert.rejects(
      resolveSlackIdentityCredentials(
        WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
        undefined,
        { state, keyring: replacement },
      ),
      (error: unknown) => {
        assert.equal((error as Error).message, 'Slack credentials require deployment recovery.');
        assert.doesNotMatch((error as Error).message, /key_lost|xoxb|secret/i);
        return true;
      },
    );
    assert.equal((await state.getAuthControl())?.healthGate, 'recovery_only');

    await assert.rejects(
      recoverMissingSlackCredentialBundle(
        { state, keyring: generateCredentialKeyring('key_lost') },
        {
          expectedRevision: revision,
          expectedAppId: 'ARECOVERY',
          expectedTeamId: 'TRECOVERY',
          correlationId: 'recovery_attempt_reused_key_id',
          botUserId: 'UBOTNEW',
          grantedScopes: ['chat:write'],
          validatedAt: 20,
          secrets,
        },
      ),
      /requires a new encryption key version/,
    );

    await assert.rejects(
      recoverMissingSlackCredentialBundle(
        { state, keyring: replacement },
        {
          expectedRevision: revision,
          expectedAppId: 'ADIFFERENT',
          expectedTeamId: 'TRECOVERY',
          correlationId: 'recovery_attempt_wrong_app',
          botUserId: 'UBOTNEW',
          grantedScopes: ['chat:write'],
          validatedAt: 20,
          secrets,
        },
      ),
      /preserve the connected app and workspace/,
    );
    const restored = await recoverMissingSlackCredentialBundle(
      { state, keyring: replacement },
      {
        expectedRevision: revision,
        expectedAppId: 'ARECOVERY',
        expectedTeamId: 'TRECOVERY',
        correlationId: 'recovery_attempt_same_realm',
        botUserId: 'UBOTNEW',
        grantedScopes: ['chat:write'],
        validatedAt: 20,
        manifestFingerprint: 'manifest-recovery',
        secrets: { ...secrets, botToken: 'xoxb-reauthorized-token' },
      },
    );
    assert.equal(restored.appId, 'ARECOVERY');
    assert.equal(restored.teamId, 'TRECOVERY');
    assert.equal((await state.getAuthControl())?.healthGate, 'normal');
    assert.equal(
      (await resolveSlackIdentityCredentials(
        WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
        undefined,
        { state, keyring: replacement },
      )).botToken,
      'xoxb-reauthorized-token',
    );
    const audit = await state.listAuditEvents();
    assert.equal(audit.some((event) =>
      event.metadataJson.includes('slack_credentials.missing_key_recovered')
    ), true);
    assert.doesNotMatch(JSON.stringify(audit), /xoxb|client-secret|signing-secret/);
  } finally {
    invalidateSlackIdentityCredentialCache();
    state.close();
  }
  const serialized = readFileSync(statePath).toString('latin1');
  assert.doesNotMatch(serialized, /xoxb-recovery|xoxb-reauthorized|client-secret-recovery|signing-secret-recovery/);
});

test('lost-root recovery refuses a dedicated revision left on any prior rotation key', async () => {
  const state = new SqliteIdentityStore(':memory:');
  const first = generateCredentialKeyring('key_first');
  const secondOnly = generateCredentialKeyring('key_second');
  const rotating = {
    currentKeyId: secondOnly.currentKeyId,
    keys: { ...first.keys, ...secondOnly.keys },
  };
  const replacement = generateCredentialKeyring('key_recovery');
  try {
    const workspaceRevision = await writeSlackIdentityCredentials(
      { state, keyring: first },
      WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      null,
      {
        botToken: 'xoxb-workspace', signingSecret: 'workspace-signing',
        clientId: 'client-workspace', clientSecret: 'client-secret-workspace',
        botUserId: 'UWORKSPACE', appId: 'AWORKSPACE', teamId: 'TWORKSPACE',
        manifestFingerprint: 'manifest-workspace',
      },
    );
    await writeSlackIdentityCredentials(
      { state, keyring: first },
      'slack_identity_prior_key',
      null,
      {
        botToken: 'xoxb-dedicated', signingSecret: 'dedicated-signing',
        botUserId: 'UDEDICATED', appId: 'ADEDICATED', teamId: 'TWORKSPACE',
      },
    );
    const initialControl = (await state.getSlackCredentialControl())!;
    const rotatedControl = await state.beginSlackCredentialRotation({
      expectedEpoch: initialControl.rotationEpoch,
      expectedCurrentKeyId: first.currentKeyId,
      nextKeyId: secondOnly.currentKeyId,
    });
    const workspace = (await state.getActiveSlackCredentialRevision(
      WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
    ))!;
    const context = {
      deploymentId: initialControl.deploymentId,
      identityId: workspace.identityId,
      identityClass: workspace.identityClass,
      appId: workspace.appId,
      teamId: workspace.teamId,
      purpose: workspace.purpose,
      revision: workspace.revision,
    };
    const secrets = await decryptSlackSecretEnvelope(first, context, workspace.envelope!);
    await state.rewrapSlackCredentialRevision({
      identityId: workspace.identityId,
      revision: workspace.revision,
      expectedKeyId: first.currentKeyId,
      expectedRotationEpoch: rotatedControl.rotationEpoch,
      envelope: await encryptSlackSecretEnvelope(rotating, context, secrets),
    });

    await assert.rejects(
      resolveSlackIdentityCredentials(
        WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
        undefined,
        { state, keyring: replacement },
      ),
      /require deployment recovery/,
    );
    await assert.rejects(
      recoverMissingSlackCredentialBundle(
        { state, keyring: replacement },
        {
          expectedRevision: workspaceRevision,
          expectedAppId: 'AWORKSPACE',
          expectedTeamId: 'TWORKSPACE',
          correlationId: 'recovery_prior_dedicated_key',
          botUserId: 'UWORKSPACE',
          grantedScopes: ['chat:write'],
          validatedAt: 30,
          manifestFingerprint: 'manifest-workspace',
          secrets: {
            clientId: 'client-workspace', clientSecret: 'client-secret-workspace',
            signingSecret: 'workspace-signing', botToken: 'xoxb-reauthorized',
          },
        },
      ),
      /Restore the prior key before repairing isolated dedicated Slack identities/,
    );
    assert.equal((await state.getAuthControl())?.healthGate, 'recovery_only');
    assert.equal(
      (await state.getActiveSlackCredentialRevision('slack_identity_prior_key'))?.envelope?.keyId,
      'key_first',
    );
  } finally {
    invalidateSlackIdentityCredentialCache();
    state.close();
  }
});

test('concurrent rotations elect one epoch/key winner and fence the loser', async () => {
  const state = new SqliteIdentityStore(':memory:');
  const original = generateCredentialKeyring('key_original');
  const nextA = generateCredentialKeyring('key_next_a');
  const nextB = generateCredentialKeyring('key_next_b');
  const keyringA = { currentKeyId: nextA.currentKeyId, keys: { ...original.keys, ...nextA.keys } };
  const keyringB = { currentKeyId: nextB.currentKeyId, keys: { ...original.keys, ...nextB.keys } };
  try {
    await writeSlackIdentityCredentials(
      { state, keyring: original },
      'slack_identity_rotation',
      null,
      { botToken: 'xoxb-rotation', signingSecret: 'rotation-secret', botUserId: 'UROTATION' },
    );
    const results = await Promise.allSettled([
      rotateSlackCredentialEncryption(
        { state, keyring: keyringA },
        { expectedEpoch: 1, previousKeyId: 'key_original' },
      ),
      rotateSlackCredentialEncryption(
        { state, keyring: keyringB },
        { expectedEpoch: 1, previousKeyId: 'key_original' },
      ),
    ]);
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
    const control = await state.getSlackCredentialControl();
    assert.equal(control?.rotationEpoch, 2);
    const winner = control?.currentKeyId === keyringA.currentKeyId ? keyringA : keyringB;
    assert.equal(
      (await resolveSlackIdentityCredentials(
        'slack_identity_rotation', undefined, { state, keyring: winner },
      )).botToken,
      'xoxb-rotation',
    );
  } finally {
    state.close();
    invalidateSlackIdentityCredentialCache();
  }
});

test('bounded Slack identity helpers degrade when Slack never settles', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = () => new Promise<Response>(() => {});

    const startedAt = Date.now();
    const identity = await slackBotIdentityInfo('xoxb-timeout', 'U_BOT', { timeoutMs: 20 });
    assert.equal(identity.ok, false);
    assert.equal(identity.error, 'slack_request_timeout');
    assert.ok(Date.now() - startedAt < 250, 'deadline should bound a fetch that never settles');

    const auth = await slackIdentityAuthTest('xoxb-timeout', { timeoutMs: 20 });
    assert.equal(auth.ok, false);
    assert.equal(auth.error, 'slack_request_timeout');

    const channels = await slackConversationsList('xoxb-timeout', { timeoutMs: 20 });
    assert.equal(channels.ok, false);
    assert.equal(channels.error, 'slack_request_timeout');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Slack transient classification covers raw transport and named service failures', async () => {
  const cases: ReadonlyArray<{
    name: string;
    error: string | undefined;
    transient: boolean;
  }> = [
    { name: 'network', error: 'slack_network_error', transient: true },
    { name: 'request timeout', error: 'slack_request_timeout', transient: true },
    { name: 'non-JSON response', error: 'slack_non_json_response', transient: true },
    { name: 'rate limit', error: 'ratelimited', transient: true },
    { name: 'synthetic 500', error: 'slack_http_500', transient: true },
    { name: 'synthetic 599', error: 'slack_http_599', transient: true },
    { name: 'Slack internal error', error: 'internal_error', transient: true },
    { name: 'Slack fatal error', error: 'fatal_error', transient: true },
    { name: 'Slack unavailable', error: 'service_unavailable', transient: true },
    { name: 'Slack request timeout', error: 'request_timeout', transient: true },
    { name: 'invalid token control', error: 'invalid_auth', transient: false },
    { name: 'missing scope control', error: 'missing_scope', transient: false },
    { name: 'missing error control', error: undefined, transient: false },
  ];

  for (const entry of cases) {
    assert.equal(
      isTransientSlackApiError(entry.error),
      entry.transient,
      entry.name,
    );
  }
});

test('Slack truth helpers preserve named JSON and synthetic transient failures', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const scenarios: ReadonlyArray<{
      name: string;
      response: () => Promise<Response>;
      expectedError: string;
    }> = [
      {
        name: 'named JSON 500',
        response: async () => Response.json(
          { ok: false, error: 'internal_error' },
          { status: 500 },
        ),
        expectedError: 'internal_error',
      },
      {
        name: 'synthetic JSON 503',
        response: async () => Response.json({ ok: false }, { status: 503 }),
        expectedError: 'slack_http_503',
      },
      {
        name: 'rate limit',
        response: async () => Response.json(
          { ok: false },
          { status: 429, headers: { 'retry-after': '2' } },
        ),
        expectedError: 'ratelimited',
      },
      {
        name: 'non-JSON response',
        response: async () => new Response('temporarily unavailable'),
        expectedError: 'slack_non_json_response',
      },
      {
        name: 'network failure',
        response: async () => {
          throw new TypeError('network down');
        },
        expectedError: 'slack_network_error',
      },
    ];

    for (const scenario of scenarios) {
      globalThis.fetch = scenario.response;
      const result = await slackIdentityAuthTest(`xoxb-${scenario.name}`);
      assert.equal(result.ok, false, scenario.name);
      assert.equal(result.error, scenario.expectedError, scenario.name);
      assert.equal(isTransientSlackApiError(result.error), true, scenario.name);
    }

    globalThis.fetch = async () => Response.json({ ok: false, error: 'invalid_auth' });
    const invalid = await slackIdentityAuthTest('xoxb-invalid');
    assert.equal(invalid.error, 'invalid_auth');
    assert.equal(isTransientSlackApiError(invalid.error), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('identity credential resolution preserves the default path and isolates dedicated revisions', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const financeRevision = await writeSlackIdentityCredentials(
      settings,
      'slack_identity_finance',
      null,
      {
        botToken: 'xoxb-finance-v1',
        signingSecret: 'finance-secret-v1',
        botUserId: 'UFINANCE',
      },
    );
    const supportRevision = await writeSlackIdentityCredentials(
      settings,
      'slack_identity_support',
      null,
      {
        botToken: 'xoxb-support',
        signingSecret: 'support-secret',
        botUserId: 'USUPPORT',
      },
    );

    await withEnv(
      {
        SLACK_BOT_TOKEN: 'xoxb-default-env',
        SLACK_SIGNING_SECRET: 'default-env-secret',
        SLACK_BOT_USER_ID: 'U_DEFAULT_ENV',
      },
      async () => {
        assert.deepEqual(
          await resolveSlackIdentityCredentials(
            WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
            undefined,
            settings,
          ),
          {
            botToken: undefined,
            signingSecret: undefined,
            botUserId: undefined,
            connectionRevision: null,
          },
        );
        assert.deepEqual(
          await resolveSlackIdentityCredentials(
            'slack_identity_finance',
            undefined,
            settings,
          ),
          {
            botToken: 'xoxb-finance-v1',
            signingSecret: 'finance-secret-v1',
            botUserId: 'UFINANCE',
            connectionRevision: financeRevision,
          },
        );
      },
    );

    const financeRevision2 = await writeSlackIdentityCredentials(
      settings,
      'slack_identity_finance',
      financeRevision,
      {
        botToken: 'xoxb-finance-v2',
        signingSecret: 'finance-secret-v2',
        botUserId: 'UFINANCE',
      },
    );
    assert.deepEqual(
      await resolveSlackIdentityCredentials('slack_identity_finance', undefined, settings),
      {
        botToken: 'xoxb-finance-v2',
        signingSecret: 'finance-secret-v2',
        botUserId: 'UFINANCE',
        connectionRevision: financeRevision2,
      },
    );
    assert.equal(
      (
        await resolveSlackIdentityCredentials(
          'slack_identity_support',
          undefined,
          settings,
        )
      ).connectionRevision,
      supportRevision,
    );
    assert.equal(
      (
        await resolveSlackIdentityCredentials(
          'slack_identity_support',
          undefined,
          settings,
        )
      ).botToken,
      'xoxb-support',
    );
  } finally {
    invalidateSlackIdentityCredentialCache(settings);
    settings.close();
  }
});
