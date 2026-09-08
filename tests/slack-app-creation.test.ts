import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mintSetupCapability } from '../src/auth/setup-capability.mjs';
import {
  openSlackSetupTransaction,
  SlackAppCreationError,
  SlackAppCreationService,
  SLACK_SETUP_TTL_MS,
} from '../src/slack/app-creation.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { buildSlackAppManifest } from '../src/slack/app-manifest.ts';
import { resolveSlackControlPlaneAppCredentials } from '../src/slack/installation-credentials.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { WORKSPACE_SLACK_INSTALLATION_ID } from '../src/config/types.ts';

const NOW = 1_786_000_000_000;
const ORIGIN = 'https://chickpea.example';
const CONFIG_TOKEN = 'xoxe.xoxp-configuration-token-secret';

test('a valid 24-hour capability opens one durable resumable setup transaction', async () => {
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  try {
    const minted = await mintSetupCapability({ now: () => NOW });
    const first = await openSlackSetupTransaction(store, {
      capability: minted.capability,
      authority: minted,
      canonicalAdminOrigin: ORIGIN,
      destination: '/admin/channels',
      now: () => NOW,
    });
    const resumed = await openSlackSetupTransaction(store, {
      capability: minted.capability,
      authority: minted,
      canonicalAdminOrigin: ORIGIN,
      destination: 'https://attacker.example/admin',
      now: () => NOW + 60_000,
    });
    assert.equal(resumed.id, first.id);
    assert.equal(resumed.expiresAt, NOW + SLACK_SETUP_TTL_MS);
    assert.equal(resumed.destination, '/admin/channels');
    assert.doesNotMatch(JSON.stringify(resumed), new RegExp(minted.capability));
    assert.equal((await store.getAuthControl())?.canonicalAdminOrigin, ORIGIN);

    await assert.rejects(
      () => openSlackSetupTransaction(store, {
        capability: minted.capability,
        authority: minted,
        canonicalAdminOrigin: 'https://different.example',
        now: () => NOW + 60_000,
      }),
      (error: unknown) => error instanceof SlackAppCreationError && error.code === 'setup_conflict',
    );

    await assert.rejects(
      () => openSlackSetupTransaction(store, {
        capability: minted.capability,
        authority: minted,
        canonicalAdminOrigin: ORIGIN,
        now: () => NOW + SLACK_SETUP_TTL_MS + 1,
      }),
      (error: unknown) => error instanceof SlackAppCreationError && error.code === 'setup_expired',
    );
  } finally {
    store.close();
  }
});

test('replacement capability invalidates the prior locator while retaining unambiguous app state', async () => {
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const credentials = { state: store, keyring: generateCredentialKeyring('key_v1') };
  try {
    const first = await mintSetupCapability({ now: () => NOW });
    let setup = await openSlackSetupTransaction(store, {
      capability: first.capability, authority: first, canonicalAdminOrigin: ORIGIN, now: () => NOW,
    });
    const service = new SlackAppCreationService({
      identity: store,
      credentials,
      now: () => NOW,
      fetch: successfulCreateFetch(),
    });
    setup = await service.create({
      setupId: setup.id,
      expectedRevision: setup.revision,
      configurationToken: CONFIG_TOKEN,
      manifest: buildSlackAppManifest({ kind: 'workspace_app', origin: ORIGIN }),
    });
    assert.equal(setup.state, 'app_created');
    assert.equal(setup.appId, 'A12345678');

    const replacement = await mintSetupCapability({ now: () => NOW + 1_000 });
    const reissued = await openSlackSetupTransaction(store, {
      capability: replacement.capability,
      authority: replacement,
      canonicalAdminOrigin: ORIGIN,
      now: () => NOW + 1_000,
    });
    assert.equal(reissued.appId, setup.appId);
    assert.equal(reissued.credentialRevision, setup.credentialRevision);
    await assert.rejects(
      () => openSlackSetupTransaction(store, {
        capability: first.capability,
        authority: replacement,
        canonicalAdminOrigin: ORIGIN,
        now: () => NOW + 1_000,
      }),
      (error: unknown) => error instanceof SlackAppCreationError && error.code === 'setup_invalid',
    );
  } finally {
    store.close();
  }
});

test('programmatic creation persists pending before Slack and atomically records encrypted app credentials', async () => {
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const credentials = { state: store, keyring: generateCredentialKeyring('key_v1') };
  const observedStates: string[] = [];
  try {
    const setup = await setupTransaction(store);
    const service = new SlackAppCreationService({
      identity: store,
      credentials,
      now: () => NOW,
      fetch: async (_input: string | URL | Request, init?: RequestInit) => {
        observedStates.push((await store.getSlackSetupTransaction(setup.id))?.state ?? 'missing');
        const requestText = String(init?.body);
        assert.doesNotMatch(requestText, /configuration-token-secret/);
        assert.match(String(new Headers(init?.headers).get('authorization')), /^Bearer xoxe\./);
        return slackResponse({
          ok: true,
          app_id: 'A12345678',
          credentials: {
            client_id: '123.456',
            client_secret: 'client-secret-value',
            signing_secret: 'signing-secret-value',
          },
        });
      },
    });
    const created = await service.create({
      setupId: setup.id,
      expectedRevision: setup.revision,
      configurationToken: CONFIG_TOKEN,
      manifest: buildSlackAppManifest({ kind: 'workspace_app', origin: ORIGIN }),
    });
    assert.deepEqual(observedStates, ['app_creation_pending']);
    assert.equal(created.state, 'app_created');
    assert.equal(created.appId, 'A12345678');
    assert.ok(created.credentialRevision);
    assert.doesNotMatch(JSON.stringify(created), /client-secret|signing-secret|configuration-token/);

    const active = await store.getActiveSlackCredentialRevision(WORKSPACE_SLACK_INSTALLATION_ID);
    assert.equal(active?.revision, created.credentialRevision);
    const decrypted = await resolveSlackControlPlaneAppCredentials(credentials);
    assert.equal(decrypted.clientId, '123.456');
    assert.equal(decrypted.clientSecret, 'client-secret-value');
    assert.equal(decrypted.signingSecret, 'signing-secret-value');
  } finally {
    store.close();
  }
});

test('network ambiguity is durable, redacted, and never auto-retried', async () => {
  let calls = 0;
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const credentials = { state: store, keyring: generateCredentialKeyring('key_v1') };
  try {
    const setup = await setupTransaction(store);
    const service = new SlackAppCreationService({
      identity: store,
      credentials,
      now: () => NOW,
      fetch: async () => {
        calls += 1;
        throw new Error(`network failed ${CONFIG_TOKEN}`);
      },
    });
    await assert.rejects(
      () => service.create({
        setupId: setup.id,
        expectedRevision: setup.revision,
        configurationToken: CONFIG_TOKEN,
        manifest: buildSlackAppManifest({ kind: 'workspace_app', origin: ORIGIN }),
      }),
      (error: unknown) => error instanceof SlackAppCreationError &&
        error.code === 'ambiguous_external_effect' && !error.message.includes(CONFIG_TOKEN),
    );
    const ambiguous = await store.getSlackSetupTransaction(setup.id);
    assert.equal(ambiguous?.state, 'ambiguous_external_effect');
    await assert.rejects(
      () => service.create({
        setupId: setup.id,
        expectedRevision: ambiguous!.revision,
        configurationToken: CONFIG_TOKEN,
        manifest: buildSlackAppManifest({ kind: 'workspace_app', origin: ORIGIN }),
      }),
      /inspect.*adopt.*restart/i,
    );
    assert.equal(calls, 1);
  } finally {
    store.close();
  }
});

test('a chunked oversized Slack response is cancelled at the byte bound and remains ambiguous', async () => {
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const credentials = { state: store, keyring: generateCredentialKeyring('key_v1') };
  let pulls = 0;
  let cancelled = false;
  try {
    const setup = await setupTransaction(store);
    const service = new SlackAppCreationService({
      identity: store,
      credentials,
      now: () => NOW,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(1_024).fill(0x20));
        },
        cancel() { cancelled = true; },
      })),
    });
    await assert.rejects(
      () => service.create({
        setupId: setup.id,
        expectedRevision: setup.revision,
        configurationToken: CONFIG_TOKEN,
        manifest: buildSlackAppManifest({ kind: 'workspace_app', origin: ORIGIN }),
      }),
      (error: unknown) => error instanceof SlackAppCreationError &&
        error.code === 'ambiguous_external_effect',
    );
    assert.equal(cancelled, true);
    assert.ok(pulls <= 66, `expected bounded pulls, received ${pulls}`);
    assert.equal((await store.getSlackSetupTransaction(setup.id))?.state, 'ambiguous_external_effect');
  } finally {
    store.close();
  }
});

test('duplicate-tab creation acquires exactly one pending transition', async () => {
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const credentials = { state: store, keyring: generateCredentialKeyring('key_v1') };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  try {
    const setup = await setupTransaction(store);
    const service = new SlackAppCreationService({
      identity: store,
      credentials,
      now: () => NOW,
      fetch: async () => {
        calls += 1;
        await gate;
        return successfulCreateFetch()('', {});
      },
    });
    const input = {
      setupId: setup.id,
      expectedRevision: setup.revision,
      configurationToken: CONFIG_TOKEN,
      manifest: buildSlackAppManifest({ kind: 'workspace_app' as const, origin: ORIGIN }),
    };
    const first = service.create(input);
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(() => service.create(input), /changed concurrently|already in progress/i);
    release();
    await first;
    assert.equal(calls, 1);
  } finally {
    store.close();
  }
});

test('manual adoption validates exact configuration and converges at app_created', async () => {
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const credentials = { state: store, keyring: generateCredentialKeyring('key_v1') };
  try {
    const setup = await setupTransaction(store);
    const service = new SlackAppCreationService({
      identity: store, credentials, now: () => NOW, fetch: successfulCreateFetch(),
    });
    const manifest = buildSlackAppManifest({ kind: 'workspace_app', origin: ORIGIN });
    const wrong = structuredClone(manifest);
    wrong.oauth_config.redirect_urls![0] = 'https://wrong.example/callback';
    await assert.rejects(
      () => service.adoptManual({
        setupId: setup.id,
        expectedRevision: setup.revision,
        appId: 'A12345678', clientId: '123.456',
        clientSecret: 'client-secret-value', signingSecret: 'signing-secret-value',
        expectedManifest: manifest, observedManifest: wrong,
      }),
      /manifest.*does not match/i,
    );
    const adopted = await service.adoptManual({
      setupId: setup.id,
      expectedRevision: setup.revision,
      appId: 'A12345678', clientId: '123.456',
      clientSecret: 'client-secret-value', signingSecret: 'signing-secret-value',
      expectedManifest: manifest,
      observedManifest: structuredClone({
        ...manifest,
        oauth_config: { ...manifest.oauth_config, pkce_enabled: false },
      }),
    });
    assert.equal(adopted.state, 'app_created');
    assert.doesNotMatch(JSON.stringify(adopted), /client-secret|signing-secret/);
  } finally {
    store.close();
  }
});

test('approval checkpoint survives restart and resume returns to app_created for a fresh OAuth attempt', async () => {
  const store = new SqliteIdentityStore(':memory:', { now: () => NOW });
  try {
    const initial = await setupTransaction(store);
    const service = new SlackAppCreationService({
      identity: store,
      credentials: { state: store, keyring: generateCredentialKeyring('key_v1') },
      now: () => NOW,
      fetch: successfulCreateFetch(),
    });
    const setup = await service.create({
      setupId: initial.id,
      expectedRevision: initial.revision,
      configurationToken: CONFIG_TOKEN,
      manifest: buildSlackAppManifest({ kind: 'workspace_app', origin: ORIGIN }),
    });
    const pending = await store.markSlackSetupApprovalPending({
      setupId: setup.id,
      expectedRevision: setup.revision,
      appId: 'A12345678',
    });
    const restartedStoreView = await store.getSlackSetupTransaction(setup.id);
    assert.deepEqual(restartedStoreView, pending);
    const resumed = await store.resumeSlackSetupAfterApproval({
      setupId: setup.id,
      expectedRevision: pending.revision,
    });
    assert.equal(resumed.state, 'app_created');
    assert.equal(resumed.expiresAt, setup.expiresAt);
    assert.equal('oauthState' in resumed, false);
  } finally {
    store.close();
  }
});

async function setupTransaction(store: SqliteIdentityStore) {
  const minted = await mintSetupCapability({ now: () => NOW });
  return openSlackSetupTransaction(store, {
    capability: minted.capability,
    authority: minted,
    canonicalAdminOrigin: ORIGIN,
    now: () => NOW,
  });
}

function successfulCreateFetch(): typeof fetch {
  return (async () => slackResponse({
    ok: true,
    app_id: 'A12345678',
    credentials: {
      client_id: '123.456',
      client_secret: 'client-secret-value',
      signing_secret: 'signing-secret-value',
    },
  })) as typeof fetch;
}

function slackResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
