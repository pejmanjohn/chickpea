import { isCloudflareTarget } from '../config/runtime-target.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { ProductTelemetryCapture, ProductTelemetryLifecycle } from './client.ts';
import { createDetachedTelemetryLifecycle, createProductTelemetryRuntime } from './runtime.ts';

export function createPlatformProductTelemetry(input: {
  env?: Record<string, unknown>;
  settings: SettingsStore;
  lifecycle?: ProductTelemetryLifecycle;
}): ProductTelemetryCapture {
  return createProductTelemetryRuntime({
    ...(input.env ? { env: input.env } : {}),
    settings: () => input.settings,
    fetch: globalThis.fetch.bind(globalThis),
    lifecycle: input.lifecycle ?? createDetachedTelemetryLifecycle(),
    runtimeTarget: isCloudflareTarget() ? 'cloudflare' : 'node',
  });
}
