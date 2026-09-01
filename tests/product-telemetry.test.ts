import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SettingsPatch, SettingsStore } from '../src/config/settings-store.ts';
import {
  buildProductTelemetryEvent,
  bucketTelemetryCount,
} from '../src/telemetry/events.ts';
import {
  POSTHOG_INGEST_ORIGIN,
  POSTHOG_PROJECT_TOKEN,
  createProductTelemetryClient,
} from '../src/telemetry/client.ts';
import {
  TelemetryIdentityUnavailableError,
  loadOrCreateTelemetryIdentity,
  telemetryPseudonym,
  type TelemetryIdentity,
} from '../src/telemetry/identity.ts';

const INSTALLATION_ID = '018f47ea-6f5b-7a2a-9c7b-8fd70ea7b863';
const IDENTITY: TelemetryIdentity = {
  installationId: INSTALLATION_ID,
  hmacKey: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
};

test('product telemetry rebuilds every event from a closed property allowlist', async () => {
  const secret = 'sk-live-never-send-this';
  const inputs = [
    {
      event: 'workspace_connected', workspaceId: 'T_PRIVATE', transportMode: 'gateway',
    },
    {
      event: 'agent_created', workspaceId: 'T_PRIVATE', agentId: 'agent_private',
      surface: 'admin',
    },
    {
      event: 'connection_ready', workspaceId: 'T_PRIVATE', agentId: 'agent_private',
      connectionKind: 'managed', ownerKind: 'member', surface: 'slack',
    },
    {
      event: 'schedule_created', workspaceId: 'T_PRIVATE', agentId: 'agent_private',
      cadenceKind: 'recurring', destinationKind: 'direct_thread',
    },
    {
      event: 'run_completed', workspaceId: 'T_PRIVATE', agentId: 'agent_private',
      triggerKind: 'interactive', outcome: 'succeeded',
    },
    {
      event: 'installation_active', workspaceCount: 8, userAgentCount: 1,
      readyConnectionCount: 4, enabledScheduleCount: 0,
    },
  ] as const;

  const built = await Promise.all(inputs.map((input) => buildProductTelemetryEvent({
    ...input,
    prompt: secret,
    token: secret,
    url: `https://customer.example/${secret}`,
    channelId: 'C_PRIVATE',
    memberId: 'U_PRIVATE',
    toolArguments: { secret },
    toolResult: secret,
    error: new Error(secret),
  } as never, IDENTITY)));

  assert.deepEqual(built.map((value) => value?.event), [
    'workspace_connected',
    'agent_created',
    'connection_ready',
    'schedule_created',
    'run_completed',
    'installation_active',
  ]);
  assert.deepEqual(Object.keys(built[0]!.properties).sort(), [
    'transport_mode', 'workspace_key',
  ]);
  assert.deepEqual(Object.keys(built[1]!.properties).sort(), [
    'agent_key', 'surface', 'workspace_key',
  ]);
  assert.deepEqual(Object.keys(built[2]!.properties).sort(), [
    'agent_key', 'connection_kind', 'owner_kind', 'surface', 'workspace_key',
  ]);
  assert.deepEqual(Object.keys(built[3]!.properties).sort(), [
    'agent_key', 'cadence_kind', 'destination_kind', 'workspace_key',
  ]);
  assert.deepEqual(Object.keys(built[4]!.properties).sort(), [
    'agent_key', 'agent_origin', 'outcome', 'trigger_kind', 'workspace_key',
  ]);
  assert.deepEqual(built[5]!.properties, {
    workspace_count: '5_plus',
    user_agent_count: '1',
    ready_connection_count: '2_4',
    enabled_schedule_count: '0',
  });

  const serialized = JSON.stringify(built);
  for (const forbidden of [
    secret, 'T_PRIVATE', 'agent_private', 'C_PRIVATE', 'U_PRIVATE',
    'customer.example', 'prompt', 'token', 'url', 'toolArguments', 'toolResult', 'error',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('product telemetry reduces invalid enums to documented safe values', async () => {
  const invalid = 'not-a-real-value';
  assert.deepEqual(
    await buildProductTelemetryEvent({
      event: 'connection_ready',
      workspaceId: 'workspace',
      agentId: 'agent',
      connectionKind: invalid,
      ownerKind: invalid,
      surface: invalid,
    } as never, IDENTITY),
    {
      event: 'connection_ready',
      properties: {
        workspace_key: await telemetryPseudonym(IDENTITY, 'workspace', 'workspace'),
        agent_key: await telemetryPseudonym(IDENTITY, 'agent', 'agent'),
        connection_kind: 'api',
        owner_kind: 'team',
        surface: 'other',
      },
    },
  );
  assert.deepEqual(
    await buildProductTelemetryEvent({
      event: 'run_completed', workspaceId: 'workspace', agentId: 'agent_default',
      triggerKind: invalid, outcome: invalid,
    } as never, IDENTITY),
    {
      event: 'run_completed',
      properties: {
        workspace_key: await telemetryPseudonym(IDENTITY, 'workspace', 'workspace'),
        agent_key: await telemetryPseudonym(IDENTITY, 'agent', 'agent_default'),
        agent_origin: 'seeded',
        trigger_kind: 'interactive',
        outcome: 'failed',
      },
    },
  );
  assert.equal(await buildProductTelemetryEvent({ event: invalid } as never, IDENTITY), undefined);
});

test('telemetry count buckets are coarse and exhaustive', () => {
  assert.deepEqual(
    [0, 1, 2, 4, 5, 100_000, -1, Number.NaN].map(bucketTelemetryCount),
    ['0', '1', '2_4', '2_4', '5_plus', '5_plus', '0', '0'],
  );
});

test('telemetry identity creation converges on one atomic winner', async () => {
  let value: string | undefined;
  let reads = 0;
  const firstReads = Promise.withResolvers<void>();
  const settings = settingsStub({
    async getSetting() {
      reads += 1;
      if (reads <= 2) {
        if (reads === 2) firstReads.resolve();
        await firstReads.promise;
        return undefined;
      }
      return value;
    },
    async applySettingsPatch(patch) {
      if (value !== undefined || patch.expected?.value !== null) return false;
      value = patch.set?.[0]?.value;
      return true;
    },
  });
  let uuidIndex = 0;
  const identities = await Promise.all([
    loadOrCreateTelemetryIdentity({
      settings,
      randomUUID: () => `018f47ea-6f5b-7a2a-9c7b-8fd70ea7b86${uuidIndex++}`,
      randomBytes: () => new Uint8Array(32).fill(1),
    }),
    loadOrCreateTelemetryIdentity({
      settings,
      randomUUID: () => `018f47ea-6f5b-7a2a-9c7b-8fd70ea7b86${uuidIndex++}`,
      randomBytes: () => new Uint8Array(32).fill(2),
    }),
  ]);

  assert.ok(identities[0]);
  assert.deepEqual(identities[0], identities[1]);
  assert.equal(identities[0]!.hmacKey.byteLength, 32);
  assert.equal(await telemetryPseudonym(identities[0]!, 'workspace', 'same-local-id'),
    await telemetryPseudonym(identities[1]!, 'workspace', 'same-local-id'));
  assert.notEqual(await telemetryPseudonym(identities[0]!, 'workspace', 'same-local-id'),
    await telemetryPseudonym(identities[0]!, 'agent', 'same-local-id'));
});

test('malformed stored telemetry identity fails closed without replacement', async () => {
  let writes = 0;
  const settings = settingsStub({
    async getSetting() { return '{"version":1,"installationId":"raw-id","hmacKey":"bad"}'; },
    async applySettingsPatch() { writes += 1; return true; },
  });

  await assert.rejects(
    loadOrCreateTelemetryIdentity({ settings }),
    TelemetryIdentityUnavailableError,
  );
  assert.equal(writes, 0);
});

for (const [name, value] of [
  ['DO_NOT_TRACK', 'YES'],
  ['CHICKPEA_DISABLE_TELEMETRY', ' true '],
] as const) {
  test(`${name} disables identity work before settings or randomness`, async () => {
    let sideEffects = 0;
    const settings = settingsStub({
      async getSetting() { sideEffects += 1; return undefined; },
      async applySettingsPatch() { sideEffects += 1; return true; },
    });
    const identity = await loadOrCreateTelemetryIdentity({
      settings,
      env: { [name]: value },
      randomUUID: () => { sideEffects += 1; return INSTALLATION_ID; },
      randomBytes: () => { sideEffects += 1; return new Uint8Array(32); },
    });

    assert.equal(identity, undefined);
    assert.equal(sideEffects, 0);
  });
}

function settingsStub(overrides: {
  getSetting?: (key: string) => Promise<string | undefined>;
  applySettingsPatch?: (patch: SettingsPatch) => Promise<boolean>;
}): SettingsStore {
  return {
    getSetting: overrides.getSetting ?? (async () => undefined),
    getSettings: async () => [],
    setSetting: async () => undefined,
    deleteSetting: async () => undefined,
    applySettingsPatch: overrides.applySettingsPatch ?? (async () => false),
    mergeSettingStringSet: async () => [],
  };
}

function memorySettings(): SettingsStore {
  let value: string | undefined;
  return settingsStub({
    async getSetting() { return value; },
    async applySettingsPatch(patch) {
      if ((patch.expected?.value ?? null) !== (value ?? null)) return false;
      value = patch.set?.[0]?.value;
      return true;
    },
  });
}

test('telemetry client sends one exact bounded PostHog batch', async () => {
  const requests: Array<{
    input: Parameters<typeof fetch>[0];
    init: Parameters<typeof fetch>[1];
  }> = [];
  const tasks: Promise<void>[] = [];
  const client = createProductTelemetryClient({
    settings: memorySettings(),
    fetch: async (input, init) => {
      requests.push({ input, init });
      return { status: 200 } as Response;
    },
    lifecycle: (task) => tasks.push(task),
    runtimeTarget: 'node',
    telemetryEnvironment: 'test',
    appVersion: '0.0.0',
    now: () => Date.UTC(2026, 8, 1, 17, 30),
    randomUUID: () => INSTALLATION_ID,
    randomBytes: () => new Uint8Array(32).fill(9),
  });

  client.capture({
    event: 'workspace_connected',
    workspaceId: 'T_PRIVATE',
    transportMode: 'direct',
  });
  assert.equal(tasks.length, 1);
  await tasks[0];

  assert.equal(requests.length, 1);
  assert.equal(String(requests[0]!.input), `${POSTHOG_INGEST_ORIGIN}/batch`);
  assert.deepEqual(requests[0]!.init?.headers, { 'content-type': 'application/json' });
  assert.equal(requests[0]!.init?.method, 'POST');
  assert.equal(requests[0]!.init?.redirect, 'manual');
  const body = JSON.parse(String(requests[0]!.init?.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['api_key', 'batch']);
  assert.equal(body.api_key, POSTHOG_PROJECT_TOKEN);
  const batch = body.batch as Array<Record<string, unknown>>;
  assert.equal(batch.length, 1);
  assert.deepEqual(Object.keys(batch[0]!).sort(), [
    'distinct_id', 'event', 'properties', 'timestamp',
  ]);
  assert.equal(batch[0]!.distinct_id, INSTALLATION_ID);
  assert.equal(batch[0]!.timestamp, '2026-09-01T17:30:00.000Z');
  assert.deepEqual(batch[0]!.properties, {
    workspace_key: await telemetryPseudonym({
      installationId: INSTALLATION_ID,
      hmacKey: new Uint8Array(32).fill(9),
    }, 'workspace', 'T_PRIVATE'),
    transport_mode: 'direct',
    schema_version: 1,
    runtime_target: 'node',
    app_version: '0.0.0',
    telemetry_environment: 'test',
    $process_person_profile: false,
    $geoip_disable: true,
  });
});

test('telemetry transport settles HTTP, redirect, network, timeout, and body failures without retries', async () => {
  const outcomes: Array<'redirect' | 'rejected' | 'timeout' | 'body'> = [
    'redirect', 'rejected', 'timeout', 'body',
  ];
  for (const outcome of outcomes) {
    let attempts = 0;
    let bodyReads = 0;
    const tasks: Promise<void>[] = [];
    const client = createProductTelemetryClient({
      settings: memorySettings(),
      fetch: async (_input, init) => {
        attempts += 1;
        if (outcome === 'rejected') throw new Error('private network failure');
        if (outcome === 'timeout') {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        return {
          status: outcome === 'redirect' ? 302 : 500,
          json() { bodyReads += 1; throw new Error('private response body'); },
          text() { bodyReads += 1; throw new Error('private response body'); },
        } as unknown as Response;
      },
      lifecycle: (task) => tasks.push(task),
      runtimeTarget: 'cloudflare',
      telemetryEnvironment: 'development',
      appVersion: '0.0.0',
      randomUUID: () => INSTALLATION_ID,
      randomBytes: () => new Uint8Array(32).fill(7),
      deadlineMs: 10,
    });
    client.capture({
      event: 'agent_created', workspaceId: 'workspace', agentId: 'agent', surface: 'mcp',
    });
    await tasks[0];
    assert.equal(attempts, 1, outcome);
    assert.equal(bodyReads, 0, outcome);
  }
});

test('telemetry transport fails closed before fetch for oversized or hostile input', async () => {
  let fetches = 0;
  const tasks: Promise<void>[] = [];
  const client = createProductTelemetryClient({
    settings: memorySettings(),
    fetch: async () => { fetches += 1; return { status: 200 } as Response; },
    lifecycle: (task) => tasks.push(task),
    runtimeTarget: 'node',
    telemetryEnvironment: 'test',
    appVersion: '0.0.0',
    randomUUID: () => INSTALLATION_ID,
    randomBytes: () => new Uint8Array(32).fill(6),
    maxBatchBytes: 64,
  });
  client.capture({
    event: 'workspace_connected', workspaceId: 'workspace', transportMode: 'direct',
  });
  await tasks[0];
  assert.equal(fetches, 0);

  const hostileTasks: Promise<void>[] = [];
  const hostile = createProductTelemetryClient({
    settings: memorySettings(),
    fetch: async () => { fetches += 1; return { status: 200 } as Response; },
    lifecycle: (task) => hostileTasks.push(task),
    runtimeTarget: 'node',
    telemetryEnvironment: 'test',
    appVersion: '0.0.0',
    randomUUID: () => INSTALLATION_ID,
    randomBytes: () => new Uint8Array(32).fill(6),
  });
  hostile.capture(Object.defineProperty({}, 'event', {
    get() { throw new Error('private getter failure'); },
  }) as never);
  await hostileTasks[0];
  assert.equal(fetches, 0);
});
