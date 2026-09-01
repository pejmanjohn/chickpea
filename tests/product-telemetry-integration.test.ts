import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SettingsStore } from '../src/config/settings-store.ts';
import {
  createDetachedTelemetryLifecycle,
  createProductTelemetryRuntime,
  createWaitUntilTelemetryLifecycle,
  resolveTelemetryEnvironment,
} from '../src/telemetry/runtime.ts';

const INSTALLATION_ID = '018f47ea-6f5b-7a2a-9c7b-8fd70ea7b863';

test('waitUntil lifecycle registers a bounded task without changing the product result', async () => {
  const registered: Promise<unknown>[] = [];
  let fetchStarted = false;
  const telemetry = createProductTelemetryRuntime({
    env: {},
    settings: () => emptySettings(),
    fetch: async () => { fetchStarted = true; return { status: 503 } as Response; },
    lifecycle: createWaitUntilTelemetryLifecycle({
      waitUntil(task) { registered.push(task); },
    }),
    runtimeTarget: 'cloudflare',
    telemetryEnvironment: 'test',
    randomUUID: () => INSTALLATION_ID,
    randomBytes: () => new Uint8Array(32).fill(5),
  });

  const productResult = { delivered: true };
  telemetry.capture({
    event: 'run_completed', workspaceId: 'workspace', agentId: 'agent_default',
    triggerKind: 'interactive', outcome: 'succeeded',
  });
  assert.equal(registered.length, 1);
  assert.deepEqual(productResult, { delivered: true });
  await registered[0];
  assert.equal(fetchStarted, true);
});

test('detached lifecycle handles rejections without an unhandledRejection signal', async () => {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    const settled = Promise.withResolvers<void>();
    const lifecycle = createDetachedTelemetryLifecycle(() => settled.resolve());
    lifecycle(Promise.reject(new Error('private detached failure')));
    await settled.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('opt-out returns a real no-op before settings, endpoint, identity, or fetch construction', () => {
  let sideEffects = 0;
  const telemetry = createProductTelemetryRuntime({
    env: { DO_NOT_TRACK: '1' },
    settings: () => { sideEffects += 1; return emptySettings(); },
    fetch: async () => { sideEffects += 1; return { status: 200 } as Response; },
    lifecycle: () => { sideEffects += 1; },
    runtimeTarget: 'node',
    telemetryEnvironment: 'production',
    randomUUID: () => { sideEffects += 1; return INSTALLATION_ID; },
    randomBytes: () => { sideEffects += 1; return new Uint8Array(32); },
  });
  telemetry.capture({
    event: 'workspace_connected', workspaceId: 'workspace', transportMode: 'direct',
  });
  assert.equal(sideEffects, 0);
});

test('telemetry environments are closed and target-aware', () => {
  assert.equal(resolveTelemetryEnvironment({ NODE_ENV: 'test' }, 'node'), 'test');
  assert.equal(resolveTelemetryEnvironment({ NODE_ENV: 'development' }, 'node'), 'development');
  assert.equal(resolveTelemetryEnvironment({ NODE_ENV: 'production' }, 'node'), 'production');
  assert.equal(resolveTelemetryEnvironment({ NODE_ENV: 'customer-name' }, 'node'), 'development');
  assert.equal(resolveTelemetryEnvironment({}, 'cloudflare'), 'production');
});

function emptySettings(): SettingsStore {
  let value: string | undefined;
  return {
    getSetting: async () => value,
    getSettings: async () => [],
    setSetting: async (_key, next) => { value = next; },
    deleteSetting: async () => { value = undefined; },
    applySettingsPatch: async (patch) => {
      if ((patch.expected?.value ?? null) !== (value ?? null)) return false;
      value = patch.set?.[0]?.value;
      return true;
    },
    mergeSettingStringSet: async () => [],
  };
}
