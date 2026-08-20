import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
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
import {
  resolveSlackIdentityExecutionContext,
  verifySlackIdentityTurnAccess,
} from '../src/slack/identity-execution.ts';
import { createGatewaySlackWebClient } from '../src/slack/gateway/web-client.ts';
import {
  GatewaySessionRunner,
  type GatewaySocket,
} from '../src/slack/gateway/session-runner.ts';

const NOW = Date.UTC(2026, 7, 20, 12);

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
    const defaultIdentity = await config.getSlackIdentity(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID);
    assert.equal(defaultIdentity.teamId, 'TGATEWAY');
    assert.equal(defaultIdentity.botUserId, 'UBOT');
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
      'users.info', 'usergroups.create', 'chat.postMessage',
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
    const execution = await resolveSlackIdentityExecutionContext(
      WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      undefined,
      { config, settings, gatewayClient: client },
    );
    assert.equal(execution.transportMode, 'gateway');
    assert.equal(execution.botToken, undefined);
    assert.equal(execution.teamId, 'TGATEWAY');
    await verifySlackIdentityTurnAccess(execution, {
      workspaceId: 'TGATEWAY', channelId: 'C_SUPPORT', eventId: 'Ev_access',
      slackIdentityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID, text: 'hello', userId: 'U_MEMBER',
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
    assert.equal(timers.at(-1)?.delay, 12 * 60_000);
    await waitFor(async () => {
      const value = await settings.getSetting(GATEWAY_SESSION_SETTING);
      return value ? JSON.parse(value).health === 'healthy' : false;
    });
    sockets[0]!.fail();
    assert.ok((timers.at(-1)?.delay ?? -1) >= 0);
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
  return { ok: true };
}

function configStore(): SqliteConfigStore {
  return new SqliteConfigStore(':memory:', {
    agents: [{
      id: 'agent_default', name: 'Chickpea', instructions: 'Help.', enabled: true,
      lifecycle: 'active', skills: [], mcpServers: [], apiConnections: [], repositories: [],
    }],
    assignments: [],
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
