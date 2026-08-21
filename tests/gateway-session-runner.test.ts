import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import {
  GATEWAY_SESSION_SETTING,
  GatewayDeploymentClient,
} from '../src/slack/gateway/client.ts';
import { CHICKPEA_GATEWAY_PROTOCOL_VERSION } from '../src/slack/gateway/protocol.ts';
import {
  GatewaySessionRunner,
  type GatewaySocket,
} from '../src/slack/gateway/session-runner.ts';

const NOW = Date.UTC(2026, 7, 20, 12);

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

test('session runner stop and restart supersede an in-flight start without orphaning a socket', async () => {
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
  try {
    await client.beginClaim();
    await client.refreshClaim();
    const originalCreateSession = client.createSession.bind(client);
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const firstDidEnter = new Promise<void>((resolve) => { firstEntered = resolve; });
    let createCount = 0;
    client.createSession = async (...args) => {
      createCount += 1;
      if (createCount === 1) {
        firstEntered();
        await firstMayFinish;
      }
      return originalCreateSession(...args);
    };
    const runner = new GatewaySessionRunner({
      client,
      onEvent: async () => 'accepted',
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const supersededStart = runner.start();
    await firstDidEnter;
    runner.stop();
    const restarted = runner.start();
    assert.equal(await restarted, true);
    releaseFirst();

    assert.equal(await supersededStart, false);
    assert.equal(sockets.length, 1);
    assert.equal(runner.state()?.health, 'connecting');
    runner.stop();
    assert.equal(sockets[0]!.readyState, 3);
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

test('session runner handles and acknowledges deliveries in socket order', async () => {
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
  const socket = new FakeSocket();
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const handled: string[] = [];
  let runner: GatewaySessionRunner | undefined;
  try {
    await client.beginClaim();
    await client.refreshClaim();
    runner = new GatewaySessionRunner({
      client,
      onEvent: async (delivery) => {
        handled.push(delivery.deliveryId);
        if (delivery.deliveryId === 'delivery_first') await firstMayFinish;
        return 'accepted';
      },
      createSocket: () => socket,
      now: () => NOW,
    });
    assert.equal(await runner.start(), true);
    socket.open();
    await waitFor(() => socket.sent.length === 1);
    socket.message(JSON.stringify({
      protocolVersion: 1, kind: 'session.ready', bindingId: 'binding_test',
      workspaceId: 'TGATEWAY', sessionId: 'session_ordered', heartbeatIntervalMs: 30_000,
      rotateAt: NOW + 15 * 60_000,
    }));
    await waitFor(() => runner?.state()?.health === 'healthy');
    for (const deliveryId of ['delivery_first', 'delivery_second']) {
      socket.message(JSON.stringify({
        protocolVersion: 1,
        kind: 'interaction.agent_selected',
        deliveryId,
        bindingId: 'binding_test',
        workspaceId: 'TGATEWAY',
        userId: 'U_MEMBER',
        agentId: 'agent_default',
      }));
    }
    await waitFor(() => handled.length === 1);
    assert.deepEqual(handled, ['delivery_first']);
    releaseFirst();
    await waitFor(() => handled.length === 2 && socket.sent.length === 3);
    assert.deepEqual(handled, ['delivery_first', 'delivery_second']);
    assert.deepEqual(socket.sent.slice(1).map((raw) => JSON.parse(raw).deliveryId), [
      'delivery_first',
      'delivery_second',
    ]);
  } finally {
    runner?.stop();
    settings.close();
    config.close();
  }
});


class FakeGateway {
  deploymentId = '';

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (url.pathname === '/v1/claims') {
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
        claimId: 'claim_test',
        state: 'bound',
        expiresAt: NOW + 300_000,
        binding: {
          bindingId: 'binding_test',
          deploymentId: this.deploymentId,
          workspaceId: 'TGATEWAY',
          appId: 'AGATEWAY',
          clientId: '123.456',
          botUserId: 'UBOT',
          installerSlackUserId: 'UINSTALLER',
          sessionUrl: 'wss://gateway.chickpea.test/v1/sessions/binding_test',
          installedAt: NOW,
        },
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
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('timed out waiting for asynchronous gateway work');
}

function configStore(): SqliteConfigStore {
  return new SqliteConfigStore(':memory:', {
    agents: [{
      id: 'agent_default',
      name: 'Chickpea',
      instructions: 'Help.',
      enabled: true,
      lifecycle: 'active',
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    }],
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
