/**
 * One gate for Slack history reads. An app that is not listed on the Slack
 * Marketplace may call `conversations.history` and `conversations.replies`
 * once a minute per workspace, each method counted on its own. Every reader
 * of a workspace asks this gate first, and a Slack rate limit one reader hits
 * holds every other reader until Slack's retry-after passes.
 *
 * The budget lives in the state store (one row per workspace and method), so
 * it is shared by every isolate. When the state store cannot answer (an older
 * build during a rollout, a disconnect), this isolate paces itself from its
 * own copy rather than stopping reads or turning the budget off.
 */
import { emitRuntimeLatency, type RuntimeLatencySink } from '../observability/runtime-latency.ts';
import type { SlackStateStore } from './claim-store.ts';
import type { SlackReadMethod } from './run-presentations.ts';
import { SlackTransportError } from './transport/types.ts';

export type { SlackReadMethod } from './run-presentations.ts';

export type SlackReadGateDecision = { ok: true } | { ok: false; retryAt: number };

export interface SlackReadGate {
  /** Reserve one read. Ungated gates always return ok. */
  reserve(method: SlackReadMethod): Promise<SlackReadGateDecision>;
  /** Record a Slack rate-limit answer (retry-after in ms, clamped to 1..900000). Never throws. */
  rateLimited(method: SlackReadMethod, retryAfterMs: number | undefined): Promise<void>;
  /** True when this gate enforces the shared budget (shared-app installs). */
  readonly gated: boolean;
}

/** The pace of the local fallback: the shared budget's own window. */
const LOCAL_READ_WINDOW_MS = 60_000;
const DEFAULT_READ_RETRY_AFTER_MS = 60_000;
const MAX_READ_RETRY_AFTER_MS = 15 * 60_000;
/** Entries past their window are pruned once the map grows beyond this. */
const LOCAL_READ_ENTRY_LIMIT = 1_024;
/** At most one local-pacing warning per isolate in this window. */
const LOCAL_READ_WARNING_MS = 60_000;

/** When this isolate may next read, per workspace and method. */
const localNextReadAt = new Map<string, number>();
let lastLocalWarningAt = Number.NEGATIVE_INFINITY;

const OK: SlackReadGateDecision = Object.freeze({ ok: true });

export const UNGATED_SLACK_READS: SlackReadGate = Object.freeze({
  gated: false,
  reserve: async () => OK,
  rateLimited: async () => {},
});

export function createSlackReadGate(input: {
  state: Pick<SlackStateStore, 'reserveSlackRead' | 'applySlackReadCooldown'> | undefined;
  workspaceId: string;
  gated: boolean;
  /** Test clock; defaults to Date.now. */
  now?: () => number;
}): SlackReadGate {
  if (!input.gated) return UNGATED_SLACK_READS;
  const { state, workspaceId } = input;
  const now = input.now ?? Date.now;
  const shared = state?.reserveSlackRead && state.applySlackReadCooldown
    ? {
        reserve: state.reserveSlackRead.bind(state),
        cooldown: state.applySlackReadCooldown.bind(state),
      }
    : undefined;

  const reserveLocally = (method: SlackReadMethod): SlackReadGateDecision => {
    const key = localKey(workspaceId, method);
    const at = now();
    const nextAt = localNextReadAt.get(key);
    if (nextAt !== undefined && nextAt > at) return { ok: false, retryAt: nextAt };
    pruneLocal(at);
    localNextReadAt.set(key, at + LOCAL_READ_WINDOW_MS);
    return OK;
  };

  return Object.freeze({
    gated: true,
    async reserve(method: SlackReadMethod): Promise<SlackReadGateDecision> {
      if (!shared) return reserveLocally(method);
      try {
        const reservation = await shared.reserve(workspaceId, method);
        return reservation.outcome === 'reserved'
          ? OK
          : { ok: false, retryAt: reservation.retryAt };
      } catch (error) {
        warnLocal('reserveSlackRead', error, now());
        return reserveLocally(method);
      }
    },
    async rateLimited(method: SlackReadMethod, retryAfterMs: number | undefined): Promise<void> {
      const delay = clampRetryAfterMs(retryAfterMs);
      // Kept locally too: it is what this isolate paces by if the state
      // store stops answering before the cooldown ends.
      const key = localKey(workspaceId, method);
      localNextReadAt.set(key, Math.max(localNextReadAt.get(key) ?? 0, now() + delay));
      if (!shared) return;
      try {
        await shared.cooldown(workspaceId, method, delay);
      } catch (error) {
        warnLocal('applySlackReadCooldown', error, now());
      }
    },
  });
}

/**
 * The retry delay, in ms, a Slack failure asks for: an @slack/web-api
 * rate-limit rejection (`retryAfter`, seconds) or a gateway
 * {@link SlackTransportError} (`retryAfterMs`). Undefined when it names none.
 */
export function slackRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  if (isSlackTransportError(error)) {
    const hint = (error as { retryAfterMs?: unknown }).retryAfterMs;
    return positiveFinite(hint) ? Math.ceil(hint) : undefined;
  }
  const record = error as { code?: unknown; retryAfter?: unknown };
  if (record.code === 'slack_webapi_rate_limited_error' && positiveFinite(record.retryAfter)) {
    return Math.ceil(record.retryAfter * 1_000);
  }
  return undefined;
}

/** Whether Slack (directly, or through the gateway) answered a rate limit. */
export function isSlackRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if (isSlackTransportError(error)) {
    return (error as { code?: unknown }).code === 'ratelimited';
  }
  const record = error as { code?: unknown; data?: unknown; statusCode?: unknown };
  if (record.code === 'slack_webapi_rate_limited_error') return true;
  if (record.code === 'slack_webapi_http_error') return Number(record.statusCode) === 429;
  if (record.code === 'slack_webapi_platform_error' && record.data &&
      typeof record.data === 'object') {
    return (record.data as { error?: unknown }).error === 'ratelimited';
  }
  return false;
}

function isSlackTransportError(error: object): boolean {
  return error instanceof SlackTransportError ||
    (error as { name?: unknown }).name === 'SlackTransportError';
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function clampRetryAfterMs(retryAfterMs: number | undefined): number {
  if (typeof retryAfterMs !== 'number' || Number.isNaN(retryAfterMs)) {
    return DEFAULT_READ_RETRY_AFTER_MS;
  }
  return Math.min(MAX_READ_RETRY_AFTER_MS, Math.max(1, Math.ceil(retryAfterMs)));
}

function localKey(workspaceId: string, method: SlackReadMethod): string {
  return `${workspaceId}\u0000${method}`;
}

function pruneLocal(at: number): void {
  if (localNextReadAt.size < LOCAL_READ_ENTRY_LIMIT) return;
  for (const [key, nextAt] of localNextReadAt) {
    if (nextAt <= at) localNextReadAt.delete(key);
  }
}

function warnLocal(operation: string, error: unknown, at: number): void {
  if (at - lastLocalWarningAt < LOCAL_READ_WARNING_MS) return;
  lastLocalWarningAt = at;
  console.warn('[chickpea] Slack reads paced locally', {
    operation,
    error: error instanceof Error ? error.name : typeof error,
  });
}

/**
 * One content-free record per Slack history or replies read, so the shared
 * app's limits (rows returned per call, which end of a thread a capped page
 * comes from, refusals) can be confirmed from Worker logs. No message text,
 * ids, or timestamps leave; only counts, booleans, and fixed tokens.
 */
export function emitSlackRead(input: {
  source: 'prefetch' | 'tool';
  method: SlackReadMethod;
  gated: boolean;
  outcome: 'ok' | 'refused' | 'rate_limited';
  limit?: number;
  rows?: ReadonlyArray<{ ts?: string }>;
  /** A thread's root ts, to report whether the page included it. */
  rootTs?: string;
  /** The message the read had to reach (a turn's trigger), if any. */
  anchorTs?: string;
  hasCursor?: boolean;
}, sink?: RuntimeLatencySink): void {
  const stamps = (input.rows ?? []).map((row) => Number(row.ts)).filter(Number.isFinite);
  const replies = input.rootTs ? stamps.filter((ts) => ts !== Number(input.rootTs)) : stamps;
  const ascending = replies.every((ts, index) => index === 0 || ts >= replies[index - 1]!);
  const descending = replies.every((ts, index) => index === 0 || ts <= replies[index - 1]!);
  emitRuntimeLatency('slack_read', {
    source: input.source,
    method: input.method === 'conversations.replies' ? 'replies' : 'history',
    outcome: input.outcome,
    gated: input.gated,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.rows ? { returned: input.rows.length } : {}),
    ...(input.rows && input.rootTs ? { includesRoot: stamps.includes(Number(input.rootTs)) } : {}),
    ...(input.rows && input.anchorTs ? { reachesAnchor: stamps.some((ts) => ts >= Number(input.anchorTs)) } : {}),
    ...(input.hasCursor !== undefined ? { hasCursor: input.hasCursor } : {}),
    ...(replies.length > 1 ? { order: ascending ? 'oldest_first' : descending ? 'newest_first' : 'mixed' } : {}),
  }, sink);
}
