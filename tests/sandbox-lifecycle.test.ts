import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLOUDFLARE_SANDBOX_OPTIONS,
  SandboxLifecycleRegistry,
  serializeSandboxActivation,
} from '../src/sandbox/lifecycle.ts';

test('Cloudflare sandbox guardrail options pin sleep and prohibit keep-alive', () => {
  assert.deepEqual(CLOUDFLARE_SANDBOX_OPTIONS, {
    keepAlive: false,
    sleepAfter: '5m',
  });
});

test('sandbox creation is serialized per thread and turn completion destroys once', async () => {
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
