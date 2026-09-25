import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBashTool, sandboxFromDriver, type Sandbox } from '@flue/runtime';

import {
  SANDBOX_CONNECTION_DROPPED_MESSAGE,
  SANDBOX_CONNECTION_DROPPED_WHILE_OPENING_MESSAGE,
  SandboxConnectionDroppedError,
  SandboxUnavailableError,
} from '../src/sandbox/errors.ts';
import { contentFreeSandboxExec, serializeSandboxActivation } from '../src/sandbox/lifecycle.ts';
import { isSandboxDisconnect, reconnectingSandboxStub } from '../src/sandbox/reconnect.ts';
import { defaultOnlyWorkspaceRoster, DEFAULT_WORKSPACE_NAME } from '../src/sandbox/workspace-limits.ts';
import { WorkspaceSession, type WorkspaceSandboxStub } from '../src/sandbox/workspace-session.ts';
import { createWorkspaceTools } from '../src/sandbox/workspace-tools.ts';

// The exact error the Violet lane's coding worker saw when Cloudflare replaced
// the Sandbox Durable Object instance under a running task (2026-09-24).
function instanceReplaced(): Error {
  return new Error(
    'Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.',
  );
}

/**
 * The shape `@cloudflare/sandbox` 0.12.4 actually throws for exec, exists,
 * readFile, writeFile and the other methods its `getSandbox` proxy wraps
 * (`createPlatformInterruptedError`): the platform error survives only as
 * `cause`, and the wrapper carries no `retryable` flag. The SDK cannot load
 * under Node (it imports `cloudflare:workers`), so this mirrors its class.
 */
class OperationInterruptedError extends Error {
  constructor(
    readonly errorResponse: { code: string; message: string; context: Record<string, unknown> },
    options: { cause: unknown },
  ) {
    super(errorResponse.message, options);
    this.name = 'OperationInterruptedError';
  }
  get code() {
    return this.errorResponse.code;
  }
  get context() {
    return this.errorResponse.context;
  }
}

function sdkWrapped(platformError: Error, operation: string): Error {
  return new OperationInterruptedError({
    code: 'OPERATION_INTERRUPTED',
    message: `Sandbox operation ${operation} was interrupted while the platform was updating the sandbox runtime`,
    context: {
      reason: 'runtime_replaced',
      operation,
      phase: 'durable_object_call',
      admitted: 'unknown',
      retryable: false,
    },
  }, { cause: platformError });
}

type ExecResult = { success: boolean; exitCode: number; stdout: string; stderr: string };

interface FakeStub {
  exists(path: string): Promise<{ exists: boolean }>;
  exec(command: string, options?: Record<string, unknown>): Promise<ExecResult>;
  getState(): Promise<{ status: string }>;
}

/**
 * A namespace whose stubs die when the instance is "replaced": every call on
 * a stub minted before the replacement rejects, like Workers does.
 */
function replaceableNamespace(behavior: {
  exec?: (command: string, stub: number) => Promise<ExecResult>;
  /** Throw what the SDK's wrapped methods throw instead of the raw platform error. */
  sdkWrapped?: boolean;
} = {}) {
  let instance = 0;
  const log: string[] = [];
  let minted = 0;
  const mint = (): FakeStub => {
    const stubNumber = ++minted;
    const boundInstance = instance;
    const alive = (operation = 'sandbox.getState') => {
      if (boundInstance === instance) return;
      if (behavior.sdkWrapped && operation !== 'sandbox.getState') {
        throw sdkWrapped(new Error('Durable Object reset because its code was updated.'), operation);
      }
      throw instanceReplaced();
    };
    return {
      async exists(path) {
        log.push(`exists#${stubNumber}`);
        alive('sandbox.exists');
        return { exists: path.length > 0 };
      },
      async exec(command) {
        log.push(`exec#${stubNumber}:${command}`);
        alive('sandbox.exec');
        if (behavior.exec) return behavior.exec(command, stubNumber);
        return { success: true, exitCode: 0, stdout: 'ok', stderr: '' };
      },
      async getState() {
        alive();
        return { status: 'running' };
      },
    };
  };
  return {
    log,
    mint,
    get minted() {
      return minted;
    },
    replace() {
      instance += 1;
    },
  };
}

const noSleep = async () => {};

test('disconnect classification matches instance replacement and resets, never command failures', () => {
  assert.equal(isSandboxDisconnect(instanceReplaced()), true);
  assert.equal(isSandboxDisconnect(new Error('Durable Object reset because its code was updated.')), true);
  assert.equal(isSandboxDisconnect(new Error('Network connection lost.')), true);
  assert.equal(isSandboxDisconnect(Object.assign(new Error('internal error'), { retryable: true })), true);

  // Overloaded objects must not be hammered with retries.
  assert.equal(
    isSandboxDisconnect(Object.assign(new Error('Network connection lost.'), { retryable: true, overloaded: true })),
    false,
  );
  // Genuine failures from the Sandbox's own code.
  assert.equal(isSandboxDisconnect(Object.assign(new Error('Command failed: exit 1'), { remote: true })), false);
  assert.equal(isSandboxDisconnect(new Error('ENOENT: no such file or directory')), false);
  assert.equal(isSandboxDisconnect(Object.assign(new Error('aborted'), { name: 'AbortError' })), false);
  assert.equal(isSandboxDisconnect(undefined), false);

  // The SDK's wrapped shape: the platform error only as the cause.
  assert.equal(isSandboxDisconnect(sdkWrapped(new Error('Network connection lost.'), 'sandbox.exec')), true);
  assert.equal(
    isSandboxDisconnect(sdkWrapped(Object.assign(new Error('x'), { retryable: true }), 'sandbox.readFile')),
    true,
  );
  assert.equal(isSandboxDisconnect(new Error('Durable Object reset because its code was updated.')), true);
  // An interruption from a container lifetime change is not a stub disconnect.
  const lifetime = new OperationInterruptedError(
    { code: 'OPERATION_INTERRUPTED', message: 'interrupted', context: { reason: 'sandbox_lifetime_changed' } },
    { cause: new Error('sandbox destroyed') },
  );
  assert.equal(isSandboxDisconnect(lifetime), false);
  // A cause chain that loops never hangs the walk.
  const looped = new Error('outer') as Error & { cause?: unknown };
  looped.cause = looped;
  assert.equal(isSandboxDisconnect(looped), false);
});

test("the SDK's wrapped interruption is retried on a fresh stub for an idempotent call", async () => {
  const namespace = replaceableNamespace({ sdkWrapped: true });
  const stub = reconnectingSandboxStub(namespace.mint, { sleep: noSleep });
  await stub.exists('/workspace');
  namespace.replace();
  assert.deepEqual(await stub.exists('/workspace'), { exists: true });
  assert.deepEqual(namespace.log, ['exists#1', 'exists#1', 'exists#2']);
});

test("the SDK's wrapped interruption under exec reports connection_dropped and the next call works", async () => {
  const namespace = replaceableNamespace({ sdkWrapped: true });
  const stub = contentFreeSandboxExec(
    serializeSandboxActivation(reconnectingSandboxStub(namespace.mint, { sleep: noSleep }), '/workspace'),
  );
  await stub.exec('true');
  namespace.replace();
  await assert.rejects(stub.exec('npm test'), (error: unknown) => {
    assert.ok(error instanceof SandboxConnectionDroppedError);
    assert.equal(error.message, SANDBOX_CONNECTION_DROPPED_MESSAGE);
    return true;
  });
  assert.equal((await stub.exec('ls')).exitCode, 0);
  // The wrapper hides the command text; the dropped exec ran once, on stub 1.
  assert.equal(namespace.log.filter((entry) => entry.startsWith('exec#1')).length, 2, 'never replayed');
  assert.equal(namespace.log.filter((entry) => entry.startsWith('exec#2')).length, 1);
  assert.equal(namespace.minted, 2);
});

test('an idempotent call is retried transparently on a fresh stub', async () => {
  const namespace = replaceableNamespace();
  const stub = reconnectingSandboxStub(namespace.mint, { sleep: noSleep });
  assert.deepEqual(await stub.exists('/workspace'), { exists: true });
  namespace.replace();
  assert.deepEqual(await stub.exists('/workspace'), { exists: true });
  assert.deepEqual(namespace.log, ['exists#1', 'exists#1', 'exists#2']);
  assert.equal(namespace.minted, 2);
});

test('a dropped command is not replayed; it reports an unknown outcome and the next call reconnects', async () => {
  const namespace = replaceableNamespace();
  const stub = reconnectingSandboxStub(namespace.mint, { sleep: noSleep });
  await stub.exists('/workspace');
  namespace.replace();

  await assert.rejects(stub.exec('sleep 280'), (error: unknown) => {
    assert.ok(error instanceof SandboxConnectionDroppedError);
    assert.equal(error.message, SANDBOX_CONNECTION_DROPPED_MESSAGE);
    assert.match(error.message, /workspace and its files are intact/);
    assert.match(error.message, /outcome of this operation is unknown/);
    return true;
  });
  assert.equal(namespace.log.filter((entry) => entry.startsWith('exec')).length, 1, 'never replayed');

  assert.equal((await stub.exec('git log -1')).stdout, 'ok');
  assert.deepEqual(namespace.log.slice(-1), ['exec#2:git log -1']);
  assert.equal(namespace.minted, 2);
});

test('a genuine command failure is not reclassified and keeps the stub', async () => {
  const namespace = replaceableNamespace({
    async exec(command) {
      if (command === 'false') throw Object.assign(new Error('Command failed: exit 1'), { remote: true });
      return { success: true, exitCode: 0, stdout: 'ok', stderr: '' };
    },
  });
  const stub = reconnectingSandboxStub(namespace.mint, { sleep: noSleep });
  await assert.rejects(stub.exec('false'), (error: unknown) => {
    assert.ok(!(error instanceof SandboxConnectionDroppedError));
    assert.equal((error as Error).message, 'Command failed: exit 1');
    return true;
  });
  await stub.exec('true');
  assert.equal(namespace.minted, 1);
});

test('retries are bounded when every fresh stub is also disconnected', async () => {
  let minted = 0;
  const pauses: number[] = [];
  const stub = reconnectingSandboxStub(
    () => {
      minted += 1;
      return {
        async exists(_path: string): Promise<boolean> {
          throw instanceReplaced();
        },
      };
    },
    { sleep: async (ms: number) => void pauses.push(ms) },
  );
  await assert.rejects(stub.exists('/workspace'), SandboxUnavailableError);
  assert.equal(minted, 3, 'one call plus two retries');
  assert.deepEqual(pauses, [100, 500]);
});

test('concurrent calls failing on one dead stub share a single replacement', async () => {
  const namespace = replaceableNamespace();
  const stub = reconnectingSandboxStub(namespace.mint, { sleep: noSleep });
  await stub.exists('/workspace');
  namespace.replace();
  await Promise.all(Array.from({ length: 6 }, () => stub.exists('/workspace')));
  assert.equal(namespace.minted, 2);
});

test('an optional method a minted stub lacks still reads as absent', async () => {
  const stub = reconnectingSandboxStub<{ exists(): Promise<boolean>; getTurnProgress?: () => Promise<unknown> }>(
    () => ({ async exists() { return true; } }),
  );
  await stub.exists();
  assert.equal(stub.getTurnProgress, undefined);
  assert.equal((stub as unknown as { then?: unknown }).then, undefined, 'never thenable');
});

test('a reconnect under the activation layer never re-runs activation or counts a second session', async () => {
  const namespace = replaceableNamespace();
  let activations = 0;
  const stub = contentFreeSandboxExec(
    serializeSandboxActivation(reconnectingSandboxStub(namespace.mint, { sleep: noSleep }), '/workspace', async () => {
      activations += 1;
    }),
  );
  await stub.exec('true');
  namespace.replace();
  await assert.rejects(stub.exec('npm test'), SandboxConnectionDroppedError);
  assert.equal((await stub.exec('true')).exitCode, 0);
  assert.deepEqual(await stub.exists('/workspace/package.json'), { exists: true });
  assert.equal(activations, 1);
});

test("the worker's bash tool shows the model the actionable message, and its next command works", async () => {
  const namespace = replaceableNamespace();
  const stub = contentFreeSandboxExec(
    serializeSandboxActivation(reconnectingSandboxStub(namespace.mint, { sleep: noSleep }), '/workspace'),
  );
  // Mirrors @flue/runtime/cloudflare's driver, which cannot load under Node.
  const sandbox = sandboxFromDriver({
    async readFile() { return ''; },
    async readFileBuffer() { return new Uint8Array(); },
    async writeFile() {},
    async stat() { throw new Error('unused'); },
    async readdir() { return []; },
    async exists(path: string) { return (await stub.exists(path)).exists; },
    async mkdir() {},
    async rm() {},
    async exec(command: string) {
      const result = await stub.exec(command);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
  } as never, '/workspace');
  const bash = createBashTool(sandbox as never);
  await bash.execute('call-1', { command: 'true' }, undefined);
  namespace.replace();
  await assert.rejects(
    bash.execute('call-2', { command: 'sleep 280' }, undefined),
    (error: unknown) => (error as Error).message === SANDBOX_CONNECTION_DROPPED_MESSAGE,
  );
  const next = await bash.execute('call-3', { command: 'git log -1' }, undefined);
  assert.match(JSON.stringify(next), /ok/);
});

test('workspace_exec returns a connection_dropped result and the next call reaches a fresh stub', async () => {
  const log: string[] = [];
  let instance = 0;
  let minted = 0;
  const mintStub = async (): Promise<WorkspaceSandboxStub> => {
    minted += 1;
    const bound = instance;
    const alive = () => {
      if (bound !== instance) throw instanceReplaced();
    };
    const call = (name: string) => async () => {
      log.push(name);
      alive();
    };
    const stub = {
      getTurnId: async () => 'turn-1',
      prepareTurn: call('prepareTurn'),
      endTurn: call('endTurn'),
      beginWorkspaceTurn: async () => ({ state: 'fresh', reservationId: 'turn-1', restorable: false }),
      configureEgress: call('configureEgress'),
      restoreWorkspace: async () => 'restored',
      exists: async () => {
        alive();
        return true;
      },
      describeWorkspace: async () => ({ running: true, hasCheckpoint: false }),
      discardWorkspace: call('discardWorkspace'),
      destroy: call('destroy'),
      applyGitIdentity: call('applyGitIdentity'),
      async exec(command: string) {
        log.push(`exec:${command}`);
        alive();
        return { success: true, exitCode: 0, stdout: `ran ${command}`, stderr: '' };
      },
    };
    return stub as WorkspaceSandboxStub;
  };
  let reservations = 0;
  const target: WorkspaceSession = new WorkspaceSession({
    id: 'sandbox_' + 'c'.repeat(40),
    name: DEFAULT_WORKSPACE_NAME,
    agentId: 'agent-1',
    grants: [],
    credentialMode: 'app',
    mintStub,
    reserveSession: async () => {
      reservations += 1;
      return true;
    },
    toSandbox: async (stub) => ({
      async exec(command: string) {
        const result = await (stub as unknown as { exec(command: string): Promise<ExecResult> }).exec(command);
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      },
    }) as unknown as Sandbox,
  });
  const roster = defaultOnlyWorkspaceRoster();
  const tools = Object.fromEntries(
    createWorkspaceTools({
      resolve: (name, access = 'use') => {
        if (access === 'use') roster.admit(name);
        return name === DEFAULT_WORKSPACE_NAME ? target : undefined;
      },
    }).map((tool) => [tool.name, tool]),
  );
  const run = async (command: string) =>
    ((await tools.workspace_exec!.run({
      toolCallId: 'call',
      log: { info() {}, warn() {}, error() {} },
      data: { command },
    } as never)) as { output: Record<string, unknown> }).output;

  assert.equal((await run('npm ci')).ok, true);
  instance += 1;
  assert.deepEqual(await run('npm test'), {
    ok: false,
    reason: 'connection_dropped',
    message: SANDBOX_CONNECTION_DROPPED_MESSAGE,
  });
  const next = await run('git status');
  assert.equal(next.ok, true);
  assert.equal(next.stdout, 'ran git status');
  assert.equal(log.filter((entry) => entry === 'exec:npm test').length, 1, 'never replayed');
  assert.equal(minted, 2);
  assert.equal(reservations, 1, 'a reconnect is not a second session');

  // The turn still ends on a fresh stub, whatever the session holds.
  const ender = reconnectingSandboxStub(mintStub, { sleep: noSleep });
  await ender.endTurn();
  assert.equal(log.at(-1), 'endTurn');
});

test('a drop while opening the workspace keeps the container and tells the model to reopen it', async () => {
  const log: string[] = [];
  let dropNextBegin = true;
  const mintStub = async (): Promise<WorkspaceSandboxStub> => ({
    getTurnId: async () => 'turn-1',
    prepareTurn: async () => void log.push('prepareTurn'),
    endTurn: async () => void log.push('endTurn'),
    beginWorkspaceTurn: async () => {
      log.push('beginWorkspaceTurn');
      if (dropNextBegin) {
        dropNextBegin = false;
        throw sdkWrapped(new Error('Network connection lost.'), 'sandbox.beginWorkspaceTurn');
      }
      return { state: 'warm', reservationId: 'turn-1', restorable: false };
    },
    configureEgress: async () => void log.push('configureEgress'),
    restoreWorkspace: async () => 'restored',
    exists: async () => true,
    describeWorkspace: async () => ({ running: true, hasCheckpoint: false }),
    discardWorkspace: async () => void log.push('discardWorkspace'),
    destroy: async () => void log.push('destroy'),
    applyGitIdentity: async () => undefined,
  });
  const target: WorkspaceSession = new WorkspaceSession({
    id: 'sandbox_' + 'd'.repeat(40),
    name: DEFAULT_WORKSPACE_NAME,
    agentId: 'agent-1',
    grants: [],
    credentialMode: 'app',
    mintStub,
    reserveSession: async () => true,
    toSandbox: async () => ({}) as Sandbox,
  });
  await assert.rejects(target.open(), (error: unknown) => {
    assert.ok(error instanceof SandboxConnectionDroppedError);
    assert.equal(error.message, SANDBOX_CONNECTION_DROPPED_WHILE_OPENING_MESSAGE);
    assert.doesNotMatch(error.message, /intact|reset/);
    return true;
  });
  // A retried coordinator reopens the workspace its coding worker is still
  // using; the drop must not destroy that container under the worker.
  assert.ok(!log.includes('destroy'), 'a dropped connection never destroys the container');
  // The next open reconnects and succeeds.
  assert.equal(await target.open(), 'warm');
  assert.deepEqual(log, ['beginWorkspaceTurn', 'beginWorkspaceTurn', 'configureEgress']);
});
