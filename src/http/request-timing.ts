import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request wall-clock breakdown for Admin responses, reported through the
 * standard `Server-Timing` header so browser resource timing exposes it.
 *
 * Buckets are named by the caller (`auth`, `do`, `d1`, ...) and accumulate
 * duration and call count per request. Outside a request (Durable Object
 * alarms, Slack turns) `timed` is a plain passthrough.
 */

/**
 * Wall clock of the first request this isolate served. Workers freeze the
 * clock at 0 during module evaluation, so the age is measured from the first
 * request instead; the first request itself reports `isolate;dur=0`.
 */
let firstRequestAt: number | undefined;

interface Bucket { dur: number; count: number }

interface RequestTiming {
  startedAt: number;
  buckets: Map<string, Bucket>;
}

const storage = new AsyncLocalStorage<RequestTiming>();

export function runWithRequestTiming<T>(fn: () => Promise<T>): Promise<T> {
  firstRequestAt ??= Date.now();
  return storage.run({ startedAt: performance.now(), buckets: new Map() }, fn);
}

export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const timing = storage.getStore();
  if (!timing) return fn();
  const started = performance.now();
  try {
    return await fn();
  } finally {
    const bucket = timing.buckets.get(name) ?? { dur: 0, count: 0 };
    bucket.dur += performance.now() - started;
    bucket.count += 1;
    timing.buckets.set(name, bucket);
  }
}

export function serverTimingHeader(): string | undefined {
  const timing = storage.getStore();
  if (!timing) return undefined;
  const parts = [
    `total;dur=${(performance.now() - timing.startedAt).toFixed(1)}`,
    `isolate;dur=${Date.now() - (firstRequestAt ?? Date.now())}`,
  ];
  for (const [name, bucket] of timing.buckets) {
    parts.push(`${name};dur=${bucket.dur.toFixed(1)};desc="n=${bucket.count}"`);
  }
  return parts.join(', ');
}
