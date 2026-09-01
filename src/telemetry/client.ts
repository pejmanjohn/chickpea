import type { SettingsStore } from '../config/settings-store.ts';
import {
  buildProductTelemetryEvent,
  type ProductTelemetryEvent,
  type ProductTelemetryEventInput,
} from './events.ts';
import {
  loadOrCreateTelemetryIdentity,
  productTelemetryDisabled,
} from './identity.ts';
import {
  claimDailyAdoptionSnapshot,
  type ProductTelemetryInventoryStore,
} from './adoption.ts';

export const POSTHOG_INGEST_ORIGIN = 'https://us.i.posthog.com';
export const POSTHOG_PROJECT_TOKEN = 'phc_naCFTFeQnRCscQz56o35i6itkkCKWa4EsjzovGiHpcFt';
export const PRODUCT_TELEMETRY_SCHEMA_VERSION = 1;

const MAX_BATCH_BYTES = 32 * 1024;
const DELIVERY_DEADLINE_MS = 5_000;

export type ProductTelemetryRuntimeTarget = 'cloudflare' | 'node';
export type ProductTelemetryEnvironment = 'production' | 'development' | 'test';
export type ProductTelemetryLifecycle = (task: Promise<void>) => void;

export interface ProductTelemetryCapture {
  capture(event: ProductTelemetryEventInput): void;
}

export interface ProductTelemetryClientOptions {
  settings: SettingsStore;
  fetch: typeof globalThis.fetch;
  lifecycle: ProductTelemetryLifecycle;
  runtimeTarget: ProductTelemetryRuntimeTarget;
  telemetryEnvironment: ProductTelemetryEnvironment;
  appVersion: string;
  env?: Record<string, unknown>;
  now?: () => number;
  randomUUID?: () => string;
  randomBytes?: (length: number) => Uint8Array;
  config?: ProductTelemetryInventoryStore;
  /** Test-only dependency override; production composition never supplies it. */
  host?: string;
  /** Test-only dependency override; production composition never supplies it. */
  token?: string;
  /** Test-only bound override. */
  maxBatchBytes?: number;
  /** Test-only deadline override. */
  deadlineMs?: number;
}

const NOOP_TELEMETRY: ProductTelemetryCapture = Object.freeze({ capture() {} });

export function createProductTelemetryClient(
  options: ProductTelemetryClientOptions,
): ProductTelemetryCapture {
  if (productTelemetryDisabled(options.env)) return NOOP_TELEMETRY;

  const endpoint = fixedEndpoint(options.host ?? POSTHOG_INGEST_ORIGIN);
  const token = options.token ?? POSTHOG_PROJECT_TOKEN;
  const maxBatchBytes = options.maxBatchBytes ?? MAX_BATCH_BYTES;
  const deadlineMs = options.deadlineMs ?? DELIVERY_DEADLINE_MS;

  return {
    capture(event) {
      const task = deliverEvent(event, {
        ...options,
        endpoint,
        token,
        maxBatchBytes,
        deadlineMs,
      }).catch(() => undefined);
      try {
        options.lifecycle(task);
      } catch {
        // The guarded request is already in flight. Product behavior is never
        // allowed to depend on a host lifecycle adapter being available.
      }
    },
  };
}

interface DeliveryOptions extends ProductTelemetryClientOptions {
  endpoint: string;
  token: string;
  maxBatchBytes: number;
  deadlineMs: number;
}

async function deliverEvent(
  input: ProductTelemetryEventInput,
  options: DeliveryOptions,
): Promise<void> {
  try {
    const identity = await loadOrCreateTelemetryIdentity({
      settings: options.settings,
      ...(options.env ? { env: options.env } : {}),
      ...(options.randomUUID ? { randomUUID: options.randomUUID } : {}),
      ...(options.randomBytes ? { randomBytes: options.randomBytes } : {}),
    });
    if (!identity) return;
    const event = await buildProductTelemetryEvent(input, identity);
    if (!event) return;
    const adoption = options.config
      ? await claimDailyAdoptionSnapshot({
          settings: options.settings,
          config: options.config,
          ...(options.now ? { now: options.now } : {}),
        })
      : undefined;
    const adoptionEvent = adoption
      ? await buildProductTelemetryEvent(adoption, identity)
      : undefined;
    const timestamp = new Date((options.now ?? Date.now)()).toISOString();
    const body = serializeBatch(
      adoptionEvent ? [event, adoptionEvent] : [event],
      identity.installationId,
      timestamp,
      options,
    );
    if (!body) return;
    await boundedFetch(options.fetch, options.endpoint, body, options.deadlineMs);
  } catch {
    // Identity, serialization, timers, and transport all fail closed. Product
    // telemetry is advisory and cannot change a customer-visible operation.
  }
}

function serializeBatch(
  events: readonly ProductTelemetryEvent[],
  distinctId: string,
  timestamp: string,
  options: DeliveryOptions,
): string | undefined {
  let body: string;
  try {
    body = JSON.stringify({
      api_key: options.token,
      batch: events.map((event) => ({
        event: event.event,
        distinct_id: distinctId,
        timestamp,
        properties: {
          ...event.properties,
          schema_version: PRODUCT_TELEMETRY_SCHEMA_VERSION,
          runtime_target: options.runtimeTarget,
          app_version: options.appVersion,
          telemetry_environment: options.telemetryEnvironment,
          $process_person_profile: false,
          $geoip_disable: true,
        },
      })),
    });
  } catch {
    return undefined;
  }
  return new TextEncoder().encode(body).byteLength <= options.maxBatchBytes ? body : undefined;
}

async function boundedFetch(
  fetchFn: typeof globalThis.fetch,
  endpoint: string,
  body: string,
  deadlineMs: number,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, deadlineMs);
  });
  const request = Promise.resolve().then(() => fetchFn(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    redirect: 'manual',
    signal: controller.signal,
  })).then(() => undefined, () => undefined);
  await Promise.race([request, deadline]);
  if (timer !== undefined) clearTimeout(timer);
}

function fixedEndpoint(host: string): string {
  const parsed = new URL(host);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search ||
      parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error('Product telemetry host must be an HTTPS origin.');
  }
  return `${parsed.origin}/batch`;
}
