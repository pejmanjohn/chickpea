import assert from 'node:assert/strict';
import { test } from 'node:test';

// @ts-expect-error The executable .mjs helper intentionally has no declaration file.
import * as cfSmokeTelemetryModule from '../scripts/lib/cf-smoke-telemetry.mjs';
import type { SettingsStore } from '../src/config/settings-store.ts';
import { createProductTelemetryRuntime } from '../src/telemetry/runtime.ts';

const {
  cloudflareSmokeTelemetryDevVars,
  withCloudflareSmokeTelemetryBindings,
} = cfSmokeTelemetryModule;

const PRODUCTION_OPT_IN = Object.freeze({
  DO_NOT_TRACK: '0',
  CHICKPEA_DISABLE_TELEMETRY: 'false',
  CHICKPEA_TELEMETRY_ENVIRONMENT: 'production',
  CHICKPEA_SOURCE_COMMIT: 'production-source',
});

test('Cloudflare smoke bindings override inherited production telemetry values', () => {
  assert.deepEqual(withCloudflareSmokeTelemetryBindings(PRODUCTION_OPT_IN), {
    ...PRODUCTION_OPT_IN,
    DO_NOT_TRACK: '1',
    CHICKPEA_DISABLE_TELEMETRY: '1',
    CHICKPEA_TELEMETRY_ENVIRONMENT: 'test',
  });

  assert.deepEqual(
    Object.fromEntries(cloudflareSmokeTelemetryDevVars().map((line: string) => line.split('=', 2))),
    {
      DO_NOT_TRACK: '1',
      CHICKPEA_DISABLE_TELEMETRY: '1',
      CHICKPEA_TELEMETRY_ENVIRONMENT: 'test',
    },
  );
});

test('Cloudflare smoke telemetry capture performs no transport or identity work', () => {
  const calls = {
    config: 0,
    fetch: 0,
    identityRead: 0,
    identityWrite: 0,
    lifecycle: 0,
    random: 0,
    settings: 0,
  };
  const settings: SettingsStore = {
    getSetting: async () => { calls.identityRead += 1; return undefined; },
    getSettings: async () => [],
    setSetting: async () => { calls.identityWrite += 1; },
    deleteSetting: async () => undefined,
    applySettingsPatch: async () => { calls.identityWrite += 1; return true; },
    mergeSettingStringSet: async () => [],
  };
  const telemetry = createProductTelemetryRuntime({
    env: withCloudflareSmokeTelemetryBindings(PRODUCTION_OPT_IN),
    settings: () => { calls.settings += 1; return settings; },
    config: () => { calls.config += 1; return {} as never; },
    fetch: async () => { calls.fetch += 1; return { status: 200 } as Response; },
    lifecycle: () => { calls.lifecycle += 1; },
    runtimeTarget: 'cloudflare',
    randomUUID: () => {
      calls.random += 1;
      return '018f47ea-6f5b-7a2a-9c7b-8fd70ea7b863';
    },
    randomBytes: (length) => { calls.random += 1; return new Uint8Array(length); },
  });

  telemetry.capture({
    event: 'run_completed',
    workspaceId: 'smoke-workspace',
    agentId: 'agent_default',
    triggerKind: 'interactive',
    outcome: 'succeeded',
  });

  assert.deepEqual(calls, {
    config: 0,
    fetch: 0,
    identityRead: 0,
    identityWrite: 0,
    lifecycle: 0,
    random: 0,
    settings: 0,
  });
});
