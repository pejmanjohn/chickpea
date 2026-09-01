import type { SettingsStore } from '../config/settings-store.ts';
import { envValue } from '../config/env-value.ts';
import {
  createProductTelemetryClient,
  type ProductTelemetryCapture,
  type ProductTelemetryEnvironment,
  type ProductTelemetryLifecycle,
  type ProductTelemetryRuntimeTarget,
} from './client.ts';
import { productTelemetryDisabled } from './identity.ts';

export const CHICKPEA_APP_VERSION = '0.0.0';

interface ProductTelemetryRuntimeOptions {
  env?: Record<string, unknown>;
  settings: () => SettingsStore;
  fetch: typeof globalThis.fetch;
  lifecycle: ProductTelemetryLifecycle;
  runtimeTarget: ProductTelemetryRuntimeTarget;
  telemetryEnvironment?: ProductTelemetryEnvironment;
  appVersion?: string;
  randomUUID?: () => string;
  randomBytes?: (length: number) => Uint8Array;
}

const NOOP_TELEMETRY: ProductTelemetryCapture = Object.freeze({ capture() {} });

/**
 * Target-neutral composition helper. The settings factory is deliberately
 * lazy so either opt-out is a total no-op before any state or crypto work.
 */
export function createProductTelemetryRuntime(
  options: ProductTelemetryRuntimeOptions,
): ProductTelemetryCapture {
  if (productTelemetryDisabled(options.env)) return NOOP_TELEMETRY;
  return createProductTelemetryClient({
    settings: options.settings(),
    fetch: options.fetch,
    lifecycle: options.lifecycle,
    runtimeTarget: options.runtimeTarget,
    telemetryEnvironment: options.telemetryEnvironment ??
      resolveTelemetryEnvironment(options.env, options.runtimeTarget),
    appVersion: options.appVersion ?? CHICKPEA_APP_VERSION,
    ...(options.env ? { env: options.env } : {}),
    ...(options.randomUUID ? { randomUUID: options.randomUUID } : {}),
    ...(options.randomBytes ? { randomBytes: options.randomBytes } : {}),
  });
}

export function createWaitUntilTelemetryLifecycle(context: {
  waitUntil(task: Promise<unknown>): void;
}): ProductTelemetryLifecycle {
  return (task) => context.waitUntil(task.catch(() => undefined));
}

/**
 * Hono exposes executionCtx only on Workers. Its Node implementation throws
 * when the property is read, so the fallback must cover both an absent and a
 * throwing context without changing the product operation.
 */
export function createRequestTelemetryLifecycle(context: {
  readonly executionCtx?: { waitUntil(task: Promise<unknown>): void };
}): ProductTelemetryLifecycle {
  try {
    const executionContext = context.executionCtx;
    if (executionContext) return createWaitUntilTelemetryLifecycle(executionContext);
  } catch {
    // Node requests do not have an ExecutionContext.
  }
  return createDetachedTelemetryLifecycle();
}

export function createDetachedTelemetryLifecycle(
  onSettled?: () => void,
): ProductTelemetryLifecycle {
  return (task) => {
    void task.catch(() => undefined).finally(() => onSettled?.());
  };
}

export function resolveTelemetryEnvironment(
  env: Record<string, unknown> | undefined,
  target: ProductTelemetryRuntimeTarget,
): ProductTelemetryEnvironment {
  const value = envValue(env, 'CHICKPEA_TELEMETRY_ENVIRONMENT') ?? envValue(env, 'NODE_ENV');
  if (value === 'production' || value === 'development' || value === 'test') return value;
  return target === 'cloudflare' ? 'production' : 'development';
}
