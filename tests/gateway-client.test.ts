import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SqliteSettingsStore,
  type SettingsStore,
} from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { SLACK_SETTING_KEYS } from '../src/slack/credentials.ts';
import {
  GATEWAY_BINDING_SETTING,
  GATEWAY_SESSION_SETTING,
  GatewayDeploymentClient,
} from '../src/slack/gateway/client.ts';
import {
  GATEWAY_DEPLOYMENT_IDENTITY_SETTING,
  verifyGatewayRequestSignature,
} from '../src/slack/gateway/identity.ts';
import {
  CHICKPEA_GATEWAY_PROTOCOL_VERSION,
  type GatewayClientFrame,
  type GatewayPublicKey,
} from '../src/slack/gateway/protocol.ts';
import { gatewayReconnectAt, gatewaySessionHealthy } from '../src/slack/gateway/session.ts';
import { createGatewaySlackTransport } from '../src/slack/transport/gateway.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import {
  resolveSlackInstallationExecutionContext,
  verifySlackInstallationTurnAccess,
} from '../src/slack/installation-execution.ts';
import { createGatewaySlackWebClient } from '../src/slack/gateway/web-client.ts';
import {
  GatewaySessionRunner,
  type GatewaySocket,
} from '../src/slack/gateway/session-runner.ts';
import {
  DEFAULT_CHICKPEA_GATEWAY_URL,
  resolveChickpeaGatewayUrl,
} from '../src/slack/gateway/runtime.ts';

const NOW = Date.UTC(2026, 7, 20, 12);

test('fresh deployments default to the live shared gateway origin', () => {
  const prior = process.env.CHICKPEA_GATEWAY_URL;
  delete process.env.CHICKPEA_GATEWAY_URL;
  try {
    assert.equal(
      resolveChickpeaGatewayUrl(),
      `${DEFAULT_CHICKPEA_GATEWAY_URL}/`,
    );
    assert.equal(
      DEFAULT_CHICKPEA_GATEWAY_URL,
      'https://chickpea-slack-gateway.pejmanjohn.workers.dev',
    );
    assert.throws(
      () => resolveChickpeaGatewayUrl({
        CHICKPEA_GATEWAY_URL: 'https://gateway.example/tenant',
      } as never),
      /HTTPS origin/,
    );
  } finally {
    if (prior === undefined) delete process.env.CHICKPEA_GATEWAY_URL;
    else process.env.CHICKPEA_GATEWAY_URL = prior;
  }
});

test('gateway deployment identity retries after a transient settings failure', async () => {
  const settings = new SqliteSettingsStore(':memory:', () => NOW);
  const config = configStore();
  const gateway = new FakeGateway();
  let failIdentityRead = true;
  const flakySettings = new Proxy(settings, {
    get(target, property) {
      if (property === 'getSetting') {
        return async (key: string) => {
          if (failIdentityRead && key === GATEWAY_DEPLOYMENT_IDENTITY_SETTING) {
            failIdentityRead = false;
            throw new Error('settings temporarily unavailable');
          }
          return target.getSetting(key);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const client = new GatewayDeploymentClient({
    settings: flakySettings,
    config,
    keyring: generateCredentialKeyring('key_gateway'),
    gatewayBaseUrl: 'https://gateway.chickpea.test',
    fetch: gateway.fetch,
    now: () => NOW,
  });
  try {
    await assert.rejects(client.beginClaim(), /temporarily unavailable/);
    const claim = await client.beginClaim();
    assert.equal(claim.claimId, 'claim_test');
  } finally {
    settings.close();
    config.close();
  }
});

test('gateway reconnect replaces only an unreadable deployment identity', async () => {
  const settings = new SqliteSettingsStore(':memory:', () => NOW);
  const config = configStore();
  const gateway = new FakeGateway();
  const first = new GatewayDeploymentClient({
    settings,
    config,
    keyring: generateCredentialKeyring('key_gateway'),
    gatewayBaseUrl: 'https://gateway.chickpea.test',
    fetch: gateway.fetch,
    now: () => NOW,
  });
  try {
    await first.beginClaim();
    const original = JSON.parse(
      (await settings.getSetting(GATEWAY_DEPLOYMENT_IDENTITY_SETTING))!,
    ) as { deploymentId: string };
    await config.ensureWorkspaceInstallation({
      workspaceId: 'TGATEWAY',
      transportMode: 'gateway',
      gatewayBindingId: 'binding_recovery',
    });
    await settings.applySettingsPatch({
      set: [
        { key: GATEWAY_SESSION_SETTING, value: '{"health":"offline"}' },
      ],
    });

    const replacement = new GatewayDeploymentClient({
      settings,
      config,
      keyring: generateCredentialKeyring('key_gateway'),
      gatewayBaseUrl: 'https://gateway.chickpea.test',
      fetch: gateway.fetch,
      now: () => NOW,
    });
    const claim = await replacement.beginClaim(undefined, undefined, { reconnect: true });
    const recovered = JSON.parse(
      (await settings.getSetting(GATEWAY_DEPLOYMENT_IDENTITY_SETTING))!,
    ) as { deploymentId: string };

    assert.equal(claim.claimId, 'claim_test');
    assert.notEqual(recovered.deploymentId, original.deploymentId);
    assert.equal(gateway.requests.at(-1)?.body.reconnectBindingId, 'binding_recovery');
    assert.equal(await settings.getSetting(GATEWAY_BINDING_SETTING), undefined);
    assert.equal(await settings.getSetting(GATEWAY_SESSION_SETTING), undefined);
  } finally {
    settings.close();
    config.close();
  }
});

test('gateway reconnect retains a concurrently replaced deployment identity', async () => {
  const settings = new SqliteSettingsStore(':memory:', () => NOW);
  const config = configStore();
  const gateway = new FakeGateway();
  const firstKeyring = generateCredentialKeyring('key_gateway');
  const replacementKeyring = generateCredentialKeyring('key_gateway');
  const first = new GatewayDeploymentClient({
    settings,
    config,
    keyring: firstKeyring,
    gatewayBaseUrl: 'https://gateway.chickpea.test',
    fetch: gateway.fetch,
    now: () => NOW,
  });
  try {
    await first.beginClaim();
    const replacementSettings = new SqliteSettingsStore(':memory:', () => NOW);
    const replacementConfig = configStore();
    const replacementClient = new GatewayDeploymentClient({
      settings: replacementSettings,
      config: replacementConfig,
      keyring: replacementKeyring,
      gatewayBaseUrl: 'https://gateway.chickpea.test',
      fetch: gateway.fetch,
      now: () => NOW,
    });
    await replacementClient.beginClaim();
    const winningIdentity = (await replacementSettings.getSetting(
      GATEWAY_DEPLOYMENT_IDENTITY_SETTING,
    ))!;
    replacementSettings.close();
    replacementConfig.close();

    let raced = false;
    const racingSettings = new Proxy(settings, {
      get(target, property) {
        if (property === 'applySettingsPatch') {
          return async (patch: Parameters<SettingsStore['applySettingsPatch']>[0]) => {
            if (!raced && patch.expected?.key === GATEWAY_DEPLOYMENT_IDENTITY_SETTING) {
              raced = true;
              await target.setSetting(GATEWAY_DEPLOYMENT_IDENTITY_SETTING, winningIdentity);
            }
            return target.applySettingsPatch(patch);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const client = new GatewayDeploymentClient({
      settings: racingSettings,
      config,
      keyring: replacementKeyring,
      gatewayBaseUrl: 'https://gateway.chickpea.test',
      fetch: gateway.fetch,
      now: () => NOW,
    });

    const claim = await client.beginClaim();
    assert.equal(claim.claimId, 'claim_test');
    assert.equal(
      await settings.getSetting(GATEWAY_DEPLOYMENT_IDENTITY_SETTING),
      winningIdentity,
    );
  } finally {
    settings.close();
    config.close();
  }
});

test('gateway client preserves the Cloudflare global fetch receiver', async () => {
  const settings = new SqliteSettingsStore(':memory:', () => NOW);
  const config = configStore();
  const originalFetch = globalThis.fetch;
  let receiverWasGlobal = false;
  globalThis.fetch = function (this: unknown, _input: string | URL | Request) {
    receiverWasGlobal = this === globalThis;
    return Promise.resolve(new Response(JSON.stringify({
      protocolVersion: 1,
      claimId: 'claim_receiver',
      expiresAt: NOW + 60_000,
      authorizationUrl: 'https://gateway.chickpea.test/install/claim_receiver',
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
  } as typeof fetch;
  try {
    const client = new GatewayDeploymentClient({
      settings,
      config,
      keyring: generateCredentialKeyring('key_gateway'),
      gatewayBaseUrl: 'https://gateway.chickpea.test',
      now: () => NOW,
    });
    await client.beginClaim();
    assert.equal(receiverWasGlobal, true);
  } finally {
    globalThis.fetch = originalFetch;
    settings.close();
    config.close();
  }
});

test('gateway client uses Cloudflare-safe manual redirects and rejects them', async () => {
  const settings = new SqliteSettingsStore(':memory:', () => NOW);
  const config = configStore();
  let observedRedirect: RequestRedirect | undefined;
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    observedRedirect = init?.redirect;
    return new Response(null, {
      status: 302,
      headers: { location: 'https://attacker.example/collect' },
    });
  };
  const client = new GatewayDeploymentClient({
    settings,
    config,
    keyring: generateCredentialKeyring('key_gateway'),
    gatewayBaseUrl: 'https://gateway.chickpea.test',
    fetch,
    now: () => NOW,
  });
  try {
    await assert.rejects(
      client.beginClaim(),
      (error: unknown) => error instanceof SlackTransportError
        && error.code === 'gateway_redirect_rejected',
    );
    assert.equal(observedRedirect, 'manual');
  } finally {
    settings.close();
    config.close();
  }
});

test('shared-app claim binds one workspace without storing Slack credentials', async () => {
  const settings = new SqliteSettingsStore(':memory:', () => NOW);
  const config = configStore();
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const gateway = new FakeGateway();
  const client = new GatewayDeploymentClient({
    settings,
    config,
    identity,
    keyring: generateCredentialKeyring('key_gateway'),
    gatewayBaseUrl: 'https://gateway.chickpea.test',
    fetch: gateway.fetch,
    now: () => NOW,
  });
  try {
    const setup = await identity.reserveSlackSetupTransaction({
      locatorHash: 'a'.repeat(64),
      issuedAt: NOW,
      expiresAt: NOW + 7 * 24 * 60 * 60_000,
      destination: '/admin/onboarding',
      canonicalAdminOrigin: 'https://self-hosted.example',
    });
    const claim = await client.beginClaim(
      'https://self-hosted.example/admin/settings/slack',
      { setupId: setup.id, setupRevision: setup.revision },
    );
    assert.equal(claim.authorizationUrl, 'https://gateway.chickpea.test/install/claim_test');
    assert.equal(
      await settings.getSetting(SLACK_SETTING_KEYS.publicUrl),
      'https://self-hosted.example',
    );
    assert.equal(gateway.requests[0]?.path, '/v1/claims');
    assert.equal(gateway.requests[0]?.body.kind, 'claim.create');
    assert.equal(await verifyGatewayRequestSignature({
      publicKey: gateway.publicKey!,
      request: gateway.requests[0]!.body as never,
    }), true);

    const status = await client.refreshClaim();
    assert.equal(status.state, 'bound');
    assert.equal(client.workspaceId, 'TGATEWAY');
    assert.equal(await settings.getSetting(GATEWAY_BINDING_SETTING) !== undefined, true);
    const installation = await config.getWorkspaceInstallation('TGATEWAY');
    assert.equal(installation?.transportMode, 'gateway');
    assert.equal(installation?.gatewayBindingId, 'binding_test');
    assert.equal(installation?.botUserId, 'UBOT');
    assert.equal(installation?.teamId, 'TGATEWAY');
    assert.equal(installation?.health, 'healthy');
    const installedSetup = await identity.getSlackSetupTransaction(setup.id);
    assert.equal(installedSetup?.state, 'bot_installed');
    assert.equal(installedSetup?.installerSlackUserId, 'UINSTALLER');

    const storedIdentity = await settings.getSetting(GATEWAY_DEPLOYMENT_IDENTITY_SETTING);
    assert.ok(storedIdentity);
    assert.doesNotMatch(storedIdentity, /"d"\s*:/);
    assert.doesNotMatch(storedIdentity, /xox[baprs]-/i);
  } finally {
    settings.close();
    config.close();
    identity.close();
  }
});

test('a gateway reconnect cannot silently rebind a deployment to another workspace', async () => {
  const settings = new SqliteSettingsStore(':memory:', () => NOW);
  const config = configStore();
  const gateway = new FakeGateway();
  const client = new GatewayDeploymentClient({
    settings,
    config,
    keyring: generateCredentialKeyring('key_gateway'),
    gatewayBaseUrl: 'https://gateway.chickpea.test',
    fetch: gateway.fetch,
    now: () => NOW,
  });
  try {
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_ALREADY_BOUND',
      transportMode: 'gateway',
    });
    await client.beginClaim();
    await assert.rejects(
      client.refreshClaim(),
      /already connected to Slack workspace T_ALREADY_BOUND/,
    );
    assert.equal(await config.getWorkspaceInstallation('TGATEWAY'), undefined);
  } finally {
    settings.close();
    config.close();
  }
});

test('gateway transport failures preserve the exact Slack operation for ambiguity handling', async () => {
  const settings = new SqliteSettingsStore(':memory:', () => NOW);
  const config = configStore();
  const gateway = new FakeGateway();
  const keyring = generateCredentialKeyring('key_gateway');
  try {
    const connected = new GatewayDeploymentClient({
      settings,
      config,
      keyring,
      gatewayBaseUrl: 'https://gateway.chickpea.test',
      fetch: gateway.fetch,
      now: () => NOW,
    });
    await connected.beginClaim();
    await connected.refreshClaim();
    const disconnected = new GatewayDeploymentClient({
      settings,
      config,
      keyring,
      gatewayBaseUrl: 'https://gateway.chickpea.test',
      fetch: async () => { throw new Error('network reset'); },
      now: () => NOW,
    });
    await assert.rejects(
      disconnected.call('usergroups.create', {
        name: 'Support', handle: 'support', description: 'Support Agent',
      }),
      (error: unknown) => error instanceof SlackTransportError &&
        error.operation === 'usergroups.create' && error.retryable === true,
    );
  } finally {
    settings.close();
    config.close();
  }
});

test('gateway transport maps only allowlisted tenant-bound Slack operations', async () => {
  const settings = new SqliteSettingsStore(':memory:', () => NOW);
  const config = configStore();
  const gateway = new FakeGateway();
  const client = new GatewayDeploymentClient({
    settings,
    config,
    keyring: generateCredentialKeyring('key_gateway'),
    gatewayBaseUrl: 'https://gateway.chickpea.test',
    fetch: gateway.fetch,
    now: () => NOW,
  });
  try {
    await client.beginClaim();
    await client.refreshClaim();
    const transport = createGatewaySlackTransport(client);
    assert.deepEqual(await transport.lookupMember('U_MEMBER'), {
      id: 'U_MEMBER', teamId: 'TGATEWAY', displayName: 'Ada', email: 'ada@example.test',
      deleted: false, bot: false, appUser: false, restricted: false,
      ultraRestricted: false, stranger: false,
    });
    assert.deepEqual(await transport.listChannels(), {
      channels: [{
        id: 'C_SUPPORT', name: 'support', private: false, member: true, archived: false,
      }],
      truncated: false,
    });
    const group = await transport.createUserGroup({
      name: 'Support', handle: 'support', description: 'Support Agent',
    });
    assert.equal(group.handle, 'support');
    const posted = await transport.postMessage({
      channelId: 'C_SUPPORT', threadTs: '1.1', text: 'Done',
      persona: { name: 'Support', avatarUrl: 'https://cdn.example.test/avatar.png' },
    });
    assert.deepEqual(posted, { channelId: 'C_SUPPORT', ts: '2.2' });
    assert.deepEqual(gateway.operations.map((entry) => entry.operation), [
      'users.info', 'conversations.list', 'usergroups.create', 'chat.postMessage',
    ]);
    assert.ok(gateway.requests.slice(2).every((entry) =>
      entry.body.workspaceId === 'TGATEWAY' && entry.body.bindingId === 'binding_test'
    ));
    assert.ok(await Promise.all(gateway.requests.slice(2).map((entry) =>
      verifyGatewayRequestSignature({ publicKey: gateway.publicKey!, request: entry.body as never })
    )).then((values) => values.every(Boolean)));
  } finally {
    settings.close();
    config.close();
  }
});

test('gateway client publishes an immutable Agent avatar without exposing Slack credentials', async () => {
  const settings = new SqliteSettingsStore(':memory:', () => NOW);
  const config = configStore();
  const gateway = new FakeGateway();
  const client = new GatewayDeploymentClient({
    settings,
    config,
    keyring: generateCredentialKeyring('key_gateway'),
    gatewayBaseUrl: 'https://gateway.chickpea.test',
    fetch: gateway.fetch,
    now: () => NOW,
  });
  try {
    await client.beginClaim();
    await client.refreshClaim();
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const url = await client.publishAvatar({
      workspaceId: 'TGATEWAY', agentId: 'agent_support', revision: 2,
      contentType: 'image/png', bytes,
    });
    assert.equal(url, 'https://cdn.chickpea.test/avatars/binding_test/agent_support/rev_2.png');
    const request = gateway.requests.find(({ path }) => path === '/v1/avatars');
    assert.ok(request);
    assert.equal(request.body.kind, 'avatar.publish');
    assert.equal(request.body.bindingId, 'binding_test');
    assert.equal(request.body.workspaceId, 'TGATEWAY');
    assert.equal(request.body.agentId, 'agent_support');
    assert.equal(request.body.revision, 'rev_2');
    assert.equal(request.body.contentType, 'image/png');
    assert.equal(request.body.data, 'iVBORw0KGgoB');
    assert.equal(await verifyGatewayRequestSignature({
      publicKey: gateway.publicKey!, request: request.body as never,
    }), true);
    assert.doesNotMatch(JSON.stringify(request.body), /xox[baprs]-/i);
  } finally {
    settings.close();
    config.close();
  }
});

test('gateway client requests a fixed generated avatar without sending SVG', async () => {
  const settings = new SqliteSettingsStore(':memory:', () => NOW);
  const config = configStore();
  const gateway = new FakeGateway();
  const client = new GatewayDeploymentClient({
    settings,
    config,
    keyring: generateCredentialKeyring('key_gateway'),
    gatewayBaseUrl: 'https://gateway.chickpea.test',
    fetch: gateway.fetch,
    now: () => NOW,
  });
  try {
    await client.beginClaim();
    await client.refreshClaim();
    const url = await client.generateAvatar({
      workspaceId: 'TGATEWAY', agentId: 'agent_support', revision: 1,
      seed: 'support-seed',
    });
    assert.equal(url, 'https://cdn.chickpea.test/avatars/binding_test/agent_support/rev_1.png');
    const request = gateway.requests.find(({ path }) => path === '/v1/avatars');
    assert.ok(request);
    assert.equal(request.body.kind, 'avatar.generate');
    assert.equal(request.body.seed, 'support-seed');
    assert.equal(Object.hasOwn(request.body, 'data'), false);
    assert.equal(await verifyGatewayRequestSignature({
      publicKey: gateway.publicKey!, request: request.body as never,
    }), true);
  } finally {
    settings.close();
    config.close();
  }
});

test('gateway execution uses the shared app without resolving or storing a bot token', async () => {
  const settings = new SqliteSettingsStore(':memory:', () => NOW);
  const config = configStore();
  const fake = new FakeGateway();
  const client = new GatewayDeploymentClient({
    settings,
    config,
    keyring: generateCredentialKeyring('key_gateway'),
    gatewayBaseUrl: 'https://gateway.chickpea.test',
    fetch: fake.fetch,
    now: () => NOW,
  });
  try {
    await client.beginClaim();
    await client.refreshClaim();
    const execution = await resolveSlackInstallationExecutionContext(
      'TGATEWAY',
      undefined,
      { config, settings, gatewayClient: client },
    );
    assert.equal(execution.transportMode, 'gateway');
    assert.equal(execution.botToken, undefined);
    assert.equal(execution.workspaceId, 'TGATEWAY');
    await verifySlackInstallationTurnAccess(execution, {
      workspaceId: 'TGATEWAY', channelId: 'C_SUPPORT', eventId: 'Ev_access',
      text: 'hello', userId: 'U_MEMBER',
      messageTs: '1.2', threadTs: '1.2', source: 'app_mention', contextMode: 'thread',
    });
    const facade = createGatewaySlackWebClient(client);
    assert.throws(() => (facade as unknown as Record<string, unknown>).admin, /unavailable/);
    assert.deepEqual(fake.operations.map(({ operation }) => operation), [
      'auth.test', 'conversations.info',
    ]);
  } finally {
    settings.close();
    config.close();
  }
});

test('shared-app Slack OIDC returns a bounded identity proof without exposing provider tokens', async () => {
  const settings = new SqliteSettingsStore(':memory:', () => NOW);
  const config = configStore();
  const gateway = new FakeGateway();
  const client = new GatewayDeploymentClient({
    settings,
    config,
    keyring: generateCredentialKeyring('key_gateway'),
    gatewayBaseUrl: 'https://gateway.chickpea.test',
    fetch: gateway.fetch,
    now: () => NOW,
  });
  try {
    await client.beginClaim();
    await client.refreshClaim();
    const authorization = await client.beginOidc({
      clientId: '123.456',
      redirectUri: 'https://self-hosted.example/auth/slack/oidc/callback',
      state: 'state_test',
      nonce: 'nonce_test',
      teamId: 'TGATEWAY',
    });
    assert.equal(authorization.authorizationUrl,
      'https://slack.com/openid/connect/authorize?attempt=oidc_test');
    const proof = await client.exchangeOidc({
      attemptId: 'attempt_test',
      code: 'one_time_code',
      nonce: 'nonce_test',
      expectedTeamId: 'TGATEWAY',
      expectedSlackUserId: 'UINSTALLER',
    });
    assert.deepEqual(proof, {
      slackTeamId: 'TGATEWAY', slackUserId: 'UINSTALLER',
      displayName: 'Installer', contactEmail: 'installer@example.test',
    });
    const oidcRequests = gateway.requests.filter(({ path }) => path.startsWith('/v1/oidc/'));
    assert.deepEqual(oidcRequests.map(({ path }) => path), [
      '/v1/oidc/authorize', '/v1/oidc/exchange',
    ]);
    assert.notEqual(oidcRequests[0]?.body.nonce, oidcRequests[1]?.body.nonce);
    assert.equal(oidcRequests[0]?.body.oidcNonce, 'nonce_test');
    assert.equal(oidcRequests[1]?.body.oidcNonce, 'nonce_test');
    assert.ok(await Promise.all(oidcRequests.map(({ body }) =>
      verifyGatewayRequestSignature({ publicKey: gateway.publicKey!, request: body as never })
    )).then((values) => values.every(Boolean)));
    assert.doesNotMatch(JSON.stringify(proof), /access_token|id_token|xox/i);
  } finally {
    settings.close();
    config.close();
  }
});

test('logical sessions authenticate before delivery, ack once, and fence tenant coordinates', async () => {
  const settings = new SqliteSettingsStore(':memory:', () => NOW);
  const config = configStore();
  const gateway = new FakeGateway();
  const client = new GatewayDeploymentClient({
    settings,
    config,
    keyring: generateCredentialKeyring('key_gateway'),
    gatewayBaseUrl: 'https://gateway.chickpea.test',
    fetch: gateway.fetch,
    now: () => NOW,
  });
  const sent: GatewayClientFrame[] = [];
  const deliveries: string[] = [];
  try {
    await client.beginClaim();
    await client.refreshClaim();
    const session = await client.createSession(
      (frame) => sent.push(frame),
      async (delivery) => {
        deliveries.push(delivery.deliveryId);
        if (delivery.deliveryId === 'delivery_failure') throw new Error('store unavailable');
        return deliveries.length === 1 ? 'accepted' : 'duplicate';
      },
    );
    await session.hello();
    assert.equal(sent[0]?.kind, 'session.hello');
    await session.handle(JSON.stringify({
      protocolVersion: 1,
      kind: 'session.ready',
      bindingId: 'binding_test',
      workspaceId: 'TGATEWAY',
      sessionId: 'session_test',
      heartbeatIntervalMs: 30_000,
      rotateAt: NOW + 15 * 60_000,
    }));
    assert.equal(gatewaySessionHealthy(session.state(), NOW + 1_000), true);
    const delivery = {
      protocolVersion: 1,
      kind: 'event.deliver',
      deliveryId: 'delivery_test',
      bindingId: 'binding_test',
      workspaceId: 'TGATEWAY',
      envelope: {
        workspaceId: 'TGATEWAY', eventId: 'Ev_test', eventTime: NOW,
        event: { type: 'app_mention', channel: 'C_SUPPORT', user: 'U_MEMBER', ts: '1.1', text: '<@UBOT> hello' },
      },
    };
    await session.handle(JSON.stringify(delivery));
    await session.handle(JSON.stringify({ ...delivery, deliveryId: 'delivery_retry' }));
    await session.handle(JSON.stringify({
      protocolVersion: 1,
      kind: 'interaction.agent_selected',
      deliveryId: 'delivery_selection',
      bindingId: 'binding_test',
      workspaceId: 'TGATEWAY',
      userId: 'U_MEMBER',
      agentId: 'agent_default',
    }));
    assert.deepEqual(deliveries, ['delivery_test', 'delivery_retry', 'delivery_selection']);
    assert.deepEqual(sent.slice(-3).map((frame) =>
      frame.kind === 'event.ack' ? frame.outcome : undefined
    ), ['accepted', 'duplicate', 'duplicate']);
    await session.handle(JSON.stringify({ ...delivery, deliveryId: 'delivery_failure' }));
    const failureAck = sent.at(-1);
    assert.equal(failureAck?.kind, 'event.ack');
    assert.equal(failureAck?.kind === 'event.ack' ? failureAck.outcome : undefined, 'rejected');

    await assert.rejects(
      session.handle(JSON.stringify({
        ...delivery,
        deliveryId: 'delivery_wrong_tenant',
        workspaceId: 'T_OTHER',
        envelope: { ...delivery.envelope, workspaceId: 'T_OTHER' },
      })),
      /workspace mismatch/i,
    );
    const failed = session.close('network', () => 0);
    assert.equal(failed.health, 'disconnected');
    assert.equal(failed.retryAt, gatewayReconnectAt(1, NOW, () => 0));
  } finally {
    settings.close();
    config.close();
  }
});

test('session runner reconnects and rotates a renewable logical session', async () => {
  const settings = new SqliteSettingsStore(':memory:', () => NOW);
  const config = configStore();
  const gateway = new FakeGateway();
  const client = new GatewayDeploymentClient({
    settings,
    config,
    keyring: generateCredentialKeyring('key_gateway'),
    gatewayBaseUrl: 'https://gateway.chickpea.test',
    fetch: gateway.fetch,
    now: () => NOW,
  });
  const sockets: FakeSocket[] = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  try {
    await client.beginClaim();
    await client.refreshClaim();
    const runner = new GatewaySessionRunner({
      client,
      onEvent: async () => 'accepted',
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      now: () => NOW,
      setTimer: ((callback: () => void, delay: number) => {
        timers.push({ callback, delay });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimer: () => {},
    });
    assert.equal(await runner.start(), true);
    sockets[0]!.open();
    await waitFor(() => sockets[0]!.sent.length === 1);
    assert.equal(JSON.parse(sockets[0]!.sent[0]!).kind, 'session.hello');
    sockets[0]!.message(JSON.stringify({
      protocolVersion: 1, kind: 'session.ready', bindingId: 'binding_test',
      workspaceId: 'TGATEWAY', sessionId: 'session_test', heartbeatIntervalMs: 30_000,
      rotateAt: NOW + 15 * 60_000,
    }));
    await spin();
    assert.ok(timers.some(({ delay }) => delay === 12 * 60_000));
    assert.ok(timers.some(({ delay }) => delay === 90_000));
    await waitFor(async () => {
      const value = await settings.getSetting(GATEWAY_SESSION_SETTING);
      return value ? JSON.parse(value).health === 'healthy' : false;
    });
    sockets[0]!.fail();
    assert.ok((timers.at(-1)?.delay ?? -1) >= 0);
    await waitFor(async () => {
      const value = await settings.getSetting(GATEWAY_SESSION_SETTING);
      return value ? JSON.parse(value).attempt === 1 : false;
    });
    timers.at(-1)!.callback();
    await waitFor(() => sockets.length === 2);
    sockets[1]!.fail();
    await waitFor(async () => {
      const value = await settings.getSetting(GATEWAY_SESSION_SETTING);
      return value ? JSON.parse(value).attempt === 2 : false;
    });
    runner.stop();
  } finally {
    settings.close();
    config.close();
  }
});

test('session runner reconnects a half-open socket after heartbeat timeout', async () => {
  const settings = new SqliteSettingsStore(':memory:', () => NOW);
  const config = configStore();
  const gateway = new FakeGateway();
  const client = new GatewayDeploymentClient({
    settings,
    config,
    keyring: generateCredentialKeyring('key_gateway'),
    gatewayBaseUrl: 'https://gateway.chickpea.test',
    fetch: gateway.fetch,
    now: () => clock,
  });
  let clock = NOW;
  const socket = new FakeSocket();
  const timers: Array<{ callback: () => void; delay: number }> = [];
  try {
    await client.beginClaim();
    await client.refreshClaim();
    const runner = new GatewaySessionRunner({
      client,
      onEvent: async () => 'accepted',
      createSocket: () => socket,
      now: () => clock,
      setTimer: ((callback: () => void, delay: number) => {
        timers.push({ callback, delay });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimer: () => {},
    });
    await runner.start();
    socket.open();
    await waitFor(() => socket.sent.length === 1);
    socket.message(JSON.stringify({
      protocolVersion: 1, kind: 'session.ready', bindingId: 'binding_test',
      workspaceId: 'TGATEWAY', sessionId: 'session_timeout', heartbeatIntervalMs: 30_000,
      rotateAt: NOW + 15 * 60_000,
    }));
    await spin();
    const heartbeat = timers.findLast(({ delay }) => delay === 90_000);
    assert.ok(heartbeat);
    clock = NOW + 90_001;
    heartbeat.callback();
    await waitFor(async () => {
      const value = await settings.getSetting(GATEWAY_SESSION_SETTING);
      return value ? JSON.parse(value).reason === 'heartbeat_timeout' : false;
    });
    assert.equal(socket.readyState, 3);
    runner.stop();
  } finally {
    settings.close();
    config.close();
  }
});

test('session runner reconnects when the gateway never sends session.ready', async () => {
  const settings = new SqliteSettingsStore(':memory:', () => NOW);
  const config = configStore();
  const gateway = new FakeGateway();
  const client = new GatewayDeploymentClient({
    settings,
    config,
    keyring: generateCredentialKeyring('key_gateway'),
    gatewayBaseUrl: 'https://gateway.chickpea.test',
    fetch: gateway.fetch,
    now: () => clock,
  });
  let clock = NOW;
  const socket = new FakeSocket();
  const timers: Array<{ callback: () => void; delay: number }> = [];
  try {
    await client.beginClaim();
    await client.refreshClaim();
    const runner = new GatewaySessionRunner({
      client,
      onEvent: async () => 'accepted',
      createSocket: () => socket,
      now: () => clock,
      setTimer: ((callback: () => void, delay: number) => {
        timers.push({ callback, delay });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimer: () => {},
    });
    await runner.start();
    socket.open();
    await waitFor(() => socket.sent.length === 1);
    const readyTimeout = timers.find(({ delay }) => delay === 90_000);
    assert.ok(readyTimeout);
    clock = NOW + 90_001;
    readyTimeout.callback();
    await waitFor(async () => {
      const value = await settings.getSetting(GATEWAY_SESSION_SETTING);
      return value ? JSON.parse(value).reason === 'ready_timeout' : false;
    });
    assert.equal(socket.readyState, 3);
    runner.stop();
  } finally {
    settings.close();
    config.close();
  }
});

class FakeGateway {
  readonly requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  readonly operations: Array<{ operation: string; input: Record<string, unknown> }> = [];
  publicKey: GatewayPublicKey | undefined;
  deploymentId = '';

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    this.requests.push({ path: url.pathname, body });
    if (url.pathname === '/v1/claims') {
      this.publicKey = body.publicKey as GatewayPublicKey;
      this.deploymentId = String(body.deploymentId);
      return json({
        protocolVersion: CHICKPEA_GATEWAY_PROTOCOL_VERSION,
        claimId: 'claim_test',
        authorizationUrl: 'https://gateway.chickpea.test/install/claim_test',
        expiresAt: NOW + 300_000,
      });
    }
    if (url.pathname === '/v1/claims/claim_test') {
      return json({
        protocolVersion: CHICKPEA_GATEWAY_PROTOCOL_VERSION,
        claimId: 'claim_test', state: 'bound', expiresAt: NOW + 300_000,
        binding: {
          bindingId: 'binding_test', deploymentId: this.deploymentId,
          workspaceId: 'TGATEWAY', appId: 'AGATEWAY', clientId: '123.456',
          botUserId: 'UBOT', installerSlackUserId: 'UINSTALLER',
          sessionUrl: 'wss://gateway.chickpea.test/v1/sessions/binding_test',
          installedAt: NOW,
        },
      });
    }
    if (url.pathname === '/v1/workspaces/TGATEWAY/operations') {
      const operation = String(body.operation);
      const operationInput = body.input as Record<string, unknown>;
      this.operations.push({ operation, input: operationInput });
      return json({
        protocolVersion: CHICKPEA_GATEWAY_PROTOCOL_VERSION,
        requestId: body.requestId,
        ok: true,
        result: operationResult(operation, operationInput),
      });
    }
    if (url.pathname === '/v1/avatars') {
      const extension = 'png';
      return json({
        url: `https://cdn.chickpea.test/avatars/${body.bindingId}/${body.agentId}/${body.revision}.${extension}`,
      }, 201);
    }
    if (url.pathname === '/v1/oidc/authorize') {
      return json({
        authorizationUrl: 'https://slack.com/openid/connect/authorize?attempt=oidc_test',
        expiresAt: NOW + 300_000,
      });
    }
    if (url.pathname === '/v1/oidc/exchange') {
      return json({
        slackTeamId: 'TGATEWAY', slackUserId: 'UINSTALLER',
        displayName: 'Installer', contactEmail: 'installer@example.test',
      });
    }
    return json({ error: 'not_found' }, 404);
  };
}

class FakeSocket implements GatewaySocket {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event?: { data: unknown }) => void>>();

  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: never): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener as (event?: { data: unknown }) => void);
    this.listeners.set(type, list);
  }
  open(): void {
    this.readyState = 1;
    for (const listener of this.listeners.get('open') ?? []) listener();
  }
  message(data: string): void {
    for (const listener of this.listeners.get('message') ?? []) listener({ data });
  }
  fail(): void {
    for (const listener of this.listeners.get('error') ?? []) listener();
  }
}

async function spin(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await predicate()) return;
    await spin();
  }
  assert.fail('timed out waiting for asynchronous gateway work');
}

function operationResult(operation: string, input: Record<string, unknown>): Record<string, unknown> {
  if (operation === 'users.info') {
    return {
      ok: true,
      user: {
        id: input.user, team_id: 'TGATEWAY', profile: {
          display_name: 'Ada', email: 'ada@example.test',
        },
      },
    };
  }
  if (operation === 'usergroups.create') {
    return {
      ok: true,
      usergroup: {
        id: 'S_SUPPORT', name: input.name, handle: input.handle,
        description: input.description, is_disabled: false, date_update: 42,
      },
    };
  }
  if (operation === 'chat.postMessage') {
    return { ok: true, channel: input.channel, ts: '2.2' };
  }
  if (operation === 'auth.test') {
    return { ok: true, team_id: 'TGATEWAY', user_id: 'UBOT', app_id: 'AGATEWAY' };
  }
  if (operation === 'conversations.info') {
    return {
      ok: true,
      channel: {
        id: input.channel,
        context_team_id: 'TGATEWAY',
        name: 'support',
        is_member: true,
        is_private: false,
      },
    };
  }
  if (operation === 'conversations.list') {
    return {
      ok: true,
      channels: [{
        id: 'C_SUPPORT', name: 'support', is_member: true,
        is_private: false, is_archived: false,
      }],
      response_metadata: { next_cursor: '' },
    };
  }
  return { ok: true };
}

function configStore(): SqliteConfigStore {
  return new SqliteConfigStore(':memory:', {
    agents: [{
      id: 'agent_default', name: 'Chickpea', instructions: 'Help.', enabled: true,
      lifecycle: 'active', skills: [], mcpServers: [], apiConnections: [], repositories: [],
    }],
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
