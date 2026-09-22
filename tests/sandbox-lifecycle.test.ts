import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { test } from 'node:test';

import {
  CLOUDFLARE_SANDBOX_OPTIONS,
  acquireSandbox,
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

// Workers binds each Durable Object stub to the I/O context that minted it.
// This fake namespace enforces the same rule so a stub cached across agent DOs
// fails exactly like production (Cobalt, 2026-09-22).
function durableObjectContexts() {
  const current = new AsyncLocalStorage<string>();
  let minted = 0;
  let destroyed = 0;
  const namespace = {
    get(threadId: string) {
      minted += 1;
      const owner = current.getStore();
      const guard = () => {
        if (current.getStore() !== owner) {
          throw new Error(
            'Cannot perform I/O on behalf of a different Durable Object. (I/O type: OutgoingFactory)',
          );
        }
      };
      return {
        threadId,
        owner,
        async getTurnId() {
          guard();
          return `turn-for-${current.getStore()}`;
        },
        async destroy() {
          guard();
          destroyed += 1;
        },
      };
    },
  };
  return {
    namespace,
    runIn: <T>(durableObject: string, fn: () => Promise<T>) => current.run(durableObject, fn),
    counts: () => ({ minted, destroyed }),
  };
}

test('follow-up turns in another agent DO never reuse a stub minted by the first DO', async () => {
  const contexts = durableObjectContexts();
  // Mirrors the module-level resolver in slack-thread.ts: one closure shared
  // by every agent DO in the isolate.
  const acquireForThread = (threadId: string) =>
    acquireSandbox(
      async () => contexts.namespace.get(threadId),
      async (sandbox) => {
        await sandbox.getTurnId();
      },
    );

  const first = await contexts.runIn('agent-do-a', () => acquireForThread('thread-1'));
  const second = await contexts.runIn('agent-do-b', () => acquireForThread('thread-1'));

  assert.equal(first.owner, 'agent-do-a');
  assert.equal(second.owner, 'agent-do-b');
  assert.notEqual(first, second);
  assert.equal(
    await contexts.runIn('agent-do-b', () => second.getTurnId()),
    'turn-for-agent-do-b',
  );
  await assert.rejects(
    contexts.runIn('agent-do-b', () => first.getTurnId()),
    /different Durable Object/,
  );
  assert.deepEqual(contexts.counts(), { minted: 2, destroyed: 0 });
});

test('sandbox acquisition reapplies current turn grants every time', async () => {
  let creates = 0;
  const configured: string[][] = [];
  const factory = async () => {
    creates += 1;
    return { async destroy() {} };
  };

  await acquireSandbox(factory, async () => {
    configured.push(['Acme/Old']);
  });
  await acquireSandbox(factory, async () => {
    configured.push(['Acme/New']);
  });

  assert.equal(creates, 2);
  assert.deepEqual(configured, [['Acme/Old'], ['Acme/New']]);
});

test('failed configuration destroys the handle in the acquiring DO and rethrows', async () => {
  const contexts = durableObjectContexts();
  await assert.rejects(
    contexts.runIn('agent-do-a', () =>
      acquireSandbox(
        async () => contexts.namespace.get('thread-1'),
        async () => {
          throw new Error('Sandbox turn context was not prepared before agent dispatch');
        },
      ),
    ),
    /turn context was not prepared/,
  );
  assert.deepEqual(contexts.counts(), { minted: 1, destroyed: 1 });
});

test('sandbox destroy is best-effort when the provider teardown fails', async () => {
  await assert.rejects(
    acquireSandbox(
      async () => ({
        async destroy() {
          throw new Error('control plane unavailable');
        },
      }),
      async () => {
        throw new Error('egress policy rejected');
      },
    ),
    /egress policy rejected/,
  );
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
