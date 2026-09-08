import { isCloudflareTarget } from '../config/runtime-target.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { ProductTelemetryInventoryStore } from './adoption.ts';
import type { ProductTelemetryCapture, ProductTelemetryLifecycle } from './client.ts';
import { createDetachedTelemetryLifecycle, createProductTelemetryRuntime } from './runtime.ts';

export function createPlatformProductTelemetry(input: {
  env?: Record<string, unknown>;
  settings: SettingsStore;
  config?: ProductTelemetryInventoryStore;
  lifecycle?: ProductTelemetryLifecycle;
}): ProductTelemetryCapture {
  const config = input.config;
  return createProductTelemetryRuntime({
    ...(input.env ? { env: input.env } : {}),
    settings: () => input.settings,
    fetch: globalThis.fetch.bind(globalThis),
    lifecycle: input.lifecycle ?? createDetachedTelemetryLifecycle(),
    runtimeTarget: isCloudflareTarget() ? 'cloudflare' : 'node',
    ...(config ? { config: () => config } : {}),
  });
}
