import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { SandboxPolicyState } from '../src/sandbox/cloudflare-policy.ts';
import {
  putStoredCodingTask,
  settleStoredCodingTask,
  workspaceTaskDispatchKey,
  type CodingTaskRecordV1,
} from '../src/sandbox/coding-task-record.ts';
import { WORKSPACE_WARM_WINDOW_MS } from '../src/sandbox/lifecycle.ts';
import {
  clearWarmWindow,
  holdWarmWindow,
  stopPastWarmWindow,
  type WarmWindowStorage,
} from '../src/sandbox/warm-window.ts';

class MemoryStorage implements WarmWindowStorage {
  readonly values = new Map<string, unknown>();
  reads = 0;

  async get<T>(key: string): Promise<T | undefined> {
    this.reads += 1;
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
}

const NOW = Date.UTC(2026, 9, 5, 16, 52, 58);
const MINUTE = 60_000;

/**
 * One Sandbox Durable Object instance over `storage`, wired as
 * src/cloudflare.ts wires it. It holds nothing in memory, so a restart is a
 * new instance over the same storage.
 */
function sandboxObject(storage: MemoryStorage, container: { running: boolean; stops: number }) {
  return {
    beginTurn: () => clearWarmWindow(storage),
    async endTurn(now: number) {
      if (container.running) await holdWarmWindow(storage, now, WORKSPACE_WARM_WINDOW_MS);
    },
    alarm: (now: number) => stopPastWarmWindow({
      storage,
      running: container.running,
      now,
      stop: async () => {
        container.stops += 1;
        container.running = false;
      },
    }),
  };
}

test('the warm window is the Sandbox SDK\'s 30-minute sleepAfter', () => {
  assert.equal(WORKSPACE_WARM_WINDOW_MS, 30 * MINUTE);
});

test('a restart after a turn\'s end still stops the container a window after the turn ended', async () => {
  const storage = new MemoryStorage();
  const container = { running: true, stops: 0 };
  await sandboxObject(storage, container).endTurn(NOW);

  // Restarted 20 minutes later: the SDK's in-memory deadline would now be 50
  // minutes after the turn ended.
  const restarted = sandboxObject(storage, container);
  await restarted.alarm(NOW + WORKSPACE_WARM_WINDOW_MS - 1);
  assert.equal(container.running, true);
  await restarted.alarm(NOW + WORKSPACE_WARM_WINDOW_MS);
  assert.deepEqual(container, { running: false, stops: 1 });

  // The window is spent: a container started again outside a turn is left to the SDK.
  container.running = true;
  await sandboxObject(storage, container).alarm(NOW + 10 * WORKSPACE_WARM_WINDOW_MS);
  assert.deepEqual(container, { running: true, stops: 1 });
});

test('a shorter window stops the container that much sooner', async () => {
  const storage = new MemoryStorage();
  const container = { running: true, stops: 0 };
  await holdWarmWindow(storage, NOW, 3 * MINUTE);
  const object = sandboxObject(storage, container);
  await object.alarm(NOW + 3 * MINUTE - 1);
  assert.equal(container.running, true);
  await object.alarm(NOW + 3 * MINUTE);
  assert.deepEqual(container, { running: false, stops: 1 });
});

test('a turn\'s start clears the stored window', async () => {
  const storage = new MemoryStorage();
  const container = { running: true, stops: 0 };
  const sandbox = sandboxObject(storage, container);
  await sandbox.endTurn(NOW);
  await sandbox.beginTurn();

  await sandboxObject(storage, container).alarm(NOW + 4 * WORKSPACE_WARM_WINDOW_MS);
  assert.deepEqual(container, { running: true, stops: 0 });
});

test('a coding task of the last turn that has not settled keeps the workspace running', async () => {
  const storage = new MemoryStorage();
  const container = { running: true, stops: 0 };
  await new SandboxPolicyState(storage).prepareTurn('turn-1');
  const taskKey = workspaceTaskDispatchKey('call-1');
  const record: CodingTaskRecordV1 = {
    schemaVersion: 1,
    state: 'dispatch_pending',
    taskKey,
    toolCallId: 'call-1',
    workspace: 'default',
    workspaceId: 'workspace-1',
    instanceId: 'worker-1',
    pendingAt: NOW - 5 * MINUTE,
    timeoutMs: 60 * MINUTE,
  };
  await putStoredCodingTask(storage, 'turn-1', record, NOW - 5 * MINUTE);
  const sandbox = sandboxObject(storage, container);
  await sandbox.endTurn(NOW);

  await sandbox.alarm(NOW + WORKSPACE_WARM_WINDOW_MS + 10 * MINUTE);
  assert.deepEqual(container, { running: true, stops: 0 });

  await settleStoredCodingTask(storage, 'turn-1', taskKey, NOW + WORKSPACE_WARM_WINDOW_MS + 12 * MINUTE);
  await sandbox.alarm(NOW + WORKSPACE_WARM_WINDOW_MS + 13 * MINUTE);
  assert.deepEqual(container, { running: false, stops: 1 });
});

test('with no stored window the alarm stops nothing, and with no container it reads nothing', async () => {
  const storage = new MemoryStorage();
  const container = { running: true, stops: 0 };
  await sandboxObject(storage, container).alarm(NOW + 10 * WORKSPACE_WARM_WINDOW_MS);
  assert.deepEqual(container, { running: true, stops: 0 });

  // A stopped container's alarm, which restore relies on writing nothing,
  // does not touch storage.
  const stopped = new MemoryStorage();
  await holdWarmWindow(stopped, NOW, WORKSPACE_WARM_WINDOW_MS);
  const idle = { running: false, stops: 0 };
  await sandboxObject(stopped, idle).alarm(NOW + 10 * WORKSPACE_WARM_WINDOW_MS);
  assert.equal(stopped.reads, 0);
  assert.equal(stopped.values.size, 1);
  assert.equal(idle.stops, 0);
});

test('the Sandbox stores the window at a turn\'s end, clears it at a turn\'s start, and checks it before the SDK alarm', () => {
  const source = readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8');
  const sandbox = source.slice(source.indexOf('export class Sandbox extends CloudflareSandbox'), source.indexOf('Sandbox.outboundByHost ='));
  const method = (name: string) => {
    const start = sandbox.indexOf(`async ${name}(`);
    assert.ok(start >= 0, name);
    return sandbox.slice(start, sandbox.indexOf('\n  }\n', start));
  };
  assert.match(method('beginWorkspaceTurn'),
    /await requireWorkspaceTurnAdmitted\(this\.env\);\s*await clearWarmWindow\(this\.warmWindowStorage\(\)\);/);
  assert.match(method('endTurn'),
    /localBucket: true,\s*\}\),\s*\}\);\s*if \(this\.containerRunning\(\)\) \{\s*const windowMs = await workspaceWarmWindowMs\(this\.env\);\s*await holdWarmWindow\(this\.warmWindowStorage\(\), Date\.now\(\), windowMs\);\s*\}\s*await this\.settleContainerLease\(\);\s*$/);
  // The SDK's own idle stop, then the SDK's alarm unchanged.
  assert.match(method('alarm'),
    /\{\s*await stopPastWarmWindow\(\{\s*storage: this\.warmWindowStorage\(\),\s*running: this\.containerRunning\(\),\s*now: Date\.now\(\),\s*stop: \(\) => this\.onActivityExpired\(\),\s*\}\);\s*await super\.alarm\(alarmProps\);\s*$/);
  assert.match(sandbox, /private warmWindowStorage\(\): WarmWindowStorage \{\s*return this\.ctx\.storage as unknown as WarmWindowStorage;/);
});
