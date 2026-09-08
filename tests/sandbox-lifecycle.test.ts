import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLOUDFLARE_SANDBOX_OPTIONS,
  SandboxLifecycleRegistry,
  cloudflareSandboxOptionVariants,
  contentFreeSandboxExec,
  serializeSandboxActivation,
} from '../src/sandbox/lifecycle.ts';
import {
  SandboxSessionCapError,
  SandboxUnavailableError,
} from '../src/sandbox/errors.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { reserveMonthlySandboxSession } from '../src/sandbox/session-cap.ts';
import {
  prepareSandboxTurn,
  requireSandboxTurnId,
} from '../src/sandbox/turn-context.ts';

test('Cloudflare sandbox guardrail options pin sleep and prohibit keep-alive', () => {
  assert.deepEqual(CLOUDFLARE_SANDBOX_OPTIONS, {
    transport: 'rpc',
    keepAlive: false,
    sleepAfter: '5m',
    normalizeId: false,
  });
});

test('Cloudflare sandbox exec keeps model-authored commands out of operational logs', async () => {
  const calls: Array<{ command: string; options?: Record<string, unknown> }> = [];
  const sandbox = contentFreeSandboxExec({
    async exec(command: string, options?: Record<string, unknown>) {
      calls.push({ command, ...(options ? { options } : {}) });
      return { success: true };
    },
  });
  const marker = 'fake-sensitive-command-marker';
  const options = { cwd: '/workspace', env: { EXISTING: 'preserved' } };

  assert.deepEqual(await sandbox.exec(`printf %s ${marker}`, options), { success: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, 'sh -lc "$FLUE_PRIVATE_SANDBOX_COMMAND_V1"');
  assert.equal(calls[0]?.command.includes(marker), false);
  assert.deepEqual(calls[0]?.options, {
    cwd: '/workspace',
    env: {
      EXISTING: 'preserved',
      FLUE_PRIVATE_SANDBOX_COMMAND_V1: `printf %s ${marker}`,
    },
    origin: 'internal',
  });
  assert.deepEqual(options, { cwd: '/workspace', env: { EXISTING: 'preserved' } });
});

test('uppercase thread ids bridge legacy and normalized Sandbox identities during rollout', () => {
  assert.deepEqual(cloudflareSandboxOptionVariants('T_WORKSPACE:C_CHANNEL:123.456'), [
    CLOUDFLARE_SANDBOX_OPTIONS,
    { ...CLOUDFLARE_SANDBOX_OPTIONS, normalizeId: true },
  ]);
  assert.deepEqual(cloudflareSandboxOptionVariants('already-lowercase'), [
    CLOUDFLARE_SANDBOX_OPTIONS,
  ]);
});

test('sandbox creation is serialized per thread and same-isolate cleanup destroys once', async () => {
  let creates = 0;
  let destroys = 0;
  const registry = new SandboxLifecycleRegistry<{ destroy(): Promise<void> }>();
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const factory = async () => {
    creates += 1;
    await ready;
    return {
      async destroy() {
        destroys += 1;
      },
    };
  };

  const first = registry.create('thread-1', factory);
  const second = registry.create('thread-1', factory);
  release?.();
  assert.equal(await first, await second);
  assert.equal(creates, 1);
  assert.equal(registry.hasActive('thread-1'), true);

  assert.equal(await registry.destroy('thread-1'), true);
  assert.equal(await registry.destroy('thread-1'), false);
  assert.equal(destroys, 1);
});

test('cached sandbox acquisition reapplies current turn grants every time', async () => {
  let creates = 0;
  const configured: string[][] = [];
  const registry = new SandboxLifecycleRegistry<{ destroy(): Promise<void> }>();
  const factory = async () => {
    creates += 1;
    return { async destroy() {} };
  };

  await registry.acquire('thread-1', factory, async () => {
    configured.push(['Acme/Old']);
  });
  await registry.acquire('thread-1', factory, async () => {
    configured.push(['Acme/New']);
  });

  assert.equal(creates, 1);
  assert.deepEqual(configured, [['Acme/Old'], ['Acme/New']]);
});

test('sandbox destroy is best-effort when the provider teardown fails', async () => {
  const registry = new SandboxLifecycleRegistry<{ destroy(): Promise<void> }>();
  await registry.create('thread-1', async () => ({
    async destroy() {
      throw new Error('control plane unavailable');
    },
  }));
  assert.equal(await registry.destroy('thread-1'), false);
  assert.equal(registry.hasActive('thread-1'), false);
});

test('the first concurrent sandbox operations share one activation probe', async () => {
  const calls: string[] = [];
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sandbox = serializeSandboxActivation({
    async exists(path: string) {
      calls.push(`exists:${path}`);
      await ready;
      return { exists: true };
    },
    async exec(command: string) {
      calls.push(`exec:${command}`);
      return command;
    },
    async readFile(path: string) {
      calls.push(`read:${path}`);
      return path;
    },
  });

  const exec = sandbox.exec('npm test');
  const read = sandbox.readFile('/workspace/package.json');
  assert.deepEqual(calls, ['exists:/workspace']);
  release?.();
  assert.equal(await exec, 'npm test');
  assert.equal(await read, '/workspace/package.json');
  assert.deepEqual(calls, [
    'exists:/workspace',
    'exec:npm test',
    'read:/workspace/package.json',
  ]);
});

test('sandbox readiness failures become public-safe infrastructure errors', async () => {
  const secret = 'control-plane-secret-do-not-leak';
  const sandbox = serializeSandboxActivation({
    async exists() {
      throw new Error(`Maximum number of running container instances exceeded: ${secret}`);
    },
    async exec(command: string) {
      return command;
    },
  });

  await assert.rejects(
    sandbox.exec('npm test'),
    (err) =>
      err instanceof SandboxUnavailableError &&
      err.type === 'sandbox_unavailable' &&
      !err.message.includes(secret),
  );
});

test('sandbox infrastructure failures after activation keep their safe category', async () => {
  const sandbox = serializeSandboxActivation({
    async exists() {
      return { exists: true };
    },
    async exec(_command: string) {
      throw Object.assign(new Error('internal placement detail'), {
        code: 'CONTAINER_UNAVAILABLE',
      });
    },
  });

  await assert.rejects(
    sandbox.exec('npm test'),
    (err) => err instanceof SandboxUnavailableError,
  );
});

test('deliberate public-safe sandbox refusals pass through activation unchanged', async () => {
  const refusal = new SandboxSessionCapError();
  const sandbox = serializeSandboxActivation(
    {
      async exists() {
        return { exists: true };
      },
      async exec(command: string) {
        return command;
      },
    },
    '/workspace',
    async () => {
      throw refusal;
    },
  );

  await assert.rejects(sandbox.exec('npm test'), (err) => err === refusal);
});

test('monthly cap is reserved once at first activation, not sandbox construction', async () => {
  const store = new SqliteSettingsStore(':memory:');
  let reservations = 0;
  let probes = 0;
  try {
    const sandbox = serializeSandboxActivation(
      {
        async exists() {
          probes += 1;
          return { exists: true };
        },
        async exec(command: string) {
          return command;
        },
        async readFile(path: string) {
          return path;
        },
      },
      '/workspace',
      async () => {
        reservations += 1;
        const reservation = await reserveMonthlySandboxSession({
          store,
          cap: 10,
          reservationId: 'turn-activation',
          now: new Date('2026-07-23T12:00:00Z'),
        });
        assert.equal(reservation.allowed, true);
      },
    );

    assert.equal(reservations, 0);
    assert.equal(probes, 0);
    assert.deepEqual(
      await Promise.all([
        sandbox.exec('npm test'),
        sandbox.readFile('/workspace/package.json'),
      ]),
      ['npm test', '/workspace/package.json'],
    );
    assert.equal(reservations, 1);
    assert.equal(probes, 1);

    const retry = await reserveMonthlySandboxSession({
      store,
      cap: 10,
      reservationId: 'turn-activation',
      now: new Date('2026-07-23T12:00:00Z'),
    });
    assert.equal(retry.alreadyReserved, true);
    assert.equal(retry.count, 1);
  } finally {
    store.close();
  }
});

test('turn id helpers persist and recover the exact per-turn key', async () => {
  let stored: string | undefined;
  const sandbox = {
    async prepareTurn(turnId: string) {
      stored = turnId;
    },
    async getTurnId() {
      return stored;
    },
  };

  await prepareSandboxTurn(sandbox, 'msg:C1:1782770400.000100');
  assert.equal(
    await requireSandboxTurnId(sandbox),
    'msg:C1:1782770400.000100',
  );
});
