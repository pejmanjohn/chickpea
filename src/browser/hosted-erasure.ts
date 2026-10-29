/**
 * What an installation's browser left at the host's Browserbase project,
 * counted for a census and removed for an erasure. The host runs erasure
 * after its gate settles, when nothing new reaches the installation, and
 * before the state store holding these ids is erased
 * (state/installation-objects.ts).
 */
import type { SettingsStore } from '../config/settings-store.ts';
import { dropPendingContextDeletions, pendingContextDeletions } from './context-deletions.ts';
import type { HostedBrowserProvider } from './hosted-provider.ts';
import { forgetWebsiteLoginContext, listWebsiteLogins } from './logins.ts';
import { BrowserProviderError, HostedBrowserRefusal } from './provider.ts';
import { closeBrowserSessionLease, readBrowserSessionUsage } from './session-lease.ts';

/** Counts only: no id, name or host leaves the store. */
export interface BrowserCensus {
  /** Distinct context ids website logins record. */
  readonly contexts: number;
  /** Context ids queued for deletion. */
  readonly queued: number;
  /** Session leases held. */
  readonly leases: number;
  /** The UTC month counted, `YYYY-MM`. */
  readonly month: string;
  /** Browser time metered this month, in seconds (sessions still running are not yet metered). */
  readonly meteredSeconds: number;
}

/** One erasure pass. Run passes until one ends, deletes and leaves nothing. */
export interface BrowserErasePass {
  /** Running sessions this pass ended. */
  readonly ended: number;
  /** Contexts this pass deleted. */
  readonly deleted: number;
  /** Ids the store held whose context the provider no longer had; cleared. */
  readonly alreadyGone: number;
  /** Ids whose record names another project or installation; cleared, never ended or deleted. */
  readonly foreign: number;
  /** Ids a failure or a still-running session kept; still in the store for the next pass. */
  readonly remaining: number;
  /**
   * Sessions the provider lists for the installation, finished or not. Best
   * effort: the list documents no pagination. Their recordings age out at
   * the provider; none can be deleted.
   */
  readonly sessionsListed: number;
  /**
   * A session list, or a session in one, did not show whose it was, so
   * this pass may have missed running sessions and the contexts they name.
   * Counted as no session; run another pass once the provider's list reads
   * as documented.
   */
  readonly listingUnverified: boolean;
}

const RUNNING = new Set(['RUNNING', 'PENDING']);
const END_WAIT_MS = 10_000;
const END_POLL_MS = 1_000;

export async function censusBrowser(store: SettingsStore, now: number): Promise<BrowserCensus> {
  const contexts = new Set((await listWebsiteLogins(store)).flatMap(({ contextId }) => contextId ? [contextId] : []));
  const queued = new Set((await pendingContextDeletions(store)).flatMap(({ contextId }) => contextId ? [contextId] : []));
  const usage = await readBrowserSessionUsage({ store, now });
  return { contexts: contexts.size, queued: queued.size, leases: usage.leases.length, month: usage.month, meteredSeconds: usage.meteredSeconds };
}

/**
 * One pass of erasure. First every running session ends: those the lease
 * row holds, the hand-off sessions queued with a deleted login, and those
 * the provider lists running or pending under the installation's metadata. A queued
 * hand-off leaves the queue only once its session has ended. Then every
 * context is deleted: the ones website logins record
 * (legacy catalog fields included), the queued ones, and every one the
 * provider lists on the installation's sessions, finished ones included,
 * which catches a context nothing recorded. Each goes through the wrapper's
 * ownership check and is cleared from the store as it is settled. A context
 * whose session still runs waits for the next pass. A second pass after a
 * clean one finds nothing to count but the sessions listed.
 */
export async function eraseBrowserPass(input: {
  store: SettingsStore;
  provider: HostedBrowserProvider;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<BrowserErasePass> {
  const { store, provider } = input;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let ended = 0;
  let deleted = 0;
  let alreadyGone = 0;
  let foreign = 0;
  let remaining = 0;

  // Each running session, and the context it would save into when it ends.
  const running = new Map<string, string | undefined>();
  for (const { sessionId, contextId } of (await readBrowserSessionUsage({ store, now: now() })).leases) {
    if (sessionId) running.set(sessionId, contextId);
  }
  for (const { handoffSessionId, contextId } of await pendingContextDeletions(store)) {
    if (handoffSessionId) running.set(handoffSessionId, running.get(handoffSessionId) ?? contextId);
  }
  const runningLists = [await provider.installationSessions('RUNNING'), await provider.installationSessions('PENDING')];
  for (const { id, contextId } of runningLists.flatMap(({ sessions }) => sessions)) running.set(id, contextId ?? running.get(id));
  const stillRunning = new Set<string>();
  const ending: string[] = [];
  for (const sessionId of running.keys()) {
    try {
      await provider.endSession(sessionId);
      ended += 1;
      ending.push(sessionId);
      continue;
    } catch (error) {
      if (isForeign(error)) {
        foreign += 1;
      } else if (!isGone(error) && RUNNING.has(await provider.sessionStatus(sessionId).catch(() => 'RUNNING'))) {
        stillRunning.add(sessionId);
        remaining += 1;
        continue;
      }
    }
    // Ended already, gone, or another installation's: its lease has nothing left to hold.
    await closeBrowserSessionLease({ store, sessionId, now: now() });
  }
  const deadline = now() + END_WAIT_MS;
  for (let waiting = ending; waiting.length > 0;) {
    const statuses = await Promise.all(waiting.map((sessionId) => provider.sessionStatus(sessionId).catch(() => 'RUNNING')));
    waiting = waiting.filter((_, index) => RUNNING.has(statuses[index]!));
    if (waiting.length === 0) break;
    if (now() >= deadline) {
      for (const sessionId of waiting) stillRunning.add(sessionId);
      remaining += waiting.length;
      break;
    }
    await sleep(END_POLL_MS);
  }

  const { sessions: listed, unverified } = await provider.installationSessions();
  const listingUnverified = unverified || runningLists.some((list) => list.unverified);
  if (listingUnverified) console.warn(JSON.stringify({ component: 'hosted_browser', event: 'session_listing_unverified' }));
  const busy = new Set([...stillRunning].flatMap((sessionId) => {
    const contextId = running.get(sessionId) ?? listed.find(({ id }) => id === sessionId)?.contextId;
    return contextId ? [contextId] : [];
  }));
  const recorded = new Map<string, string[]>();
  for (const login of await listWebsiteLogins(store)) {
    if (login.contextId) recorded.set(login.contextId, [...recorded.get(login.contextId) ?? [], login.id]);
  }
  const queued = new Set((await pendingContextDeletions(store)).flatMap(({ contextId }) => contextId ? [contextId] : []));
  const settled = new Set<string>();
  const discovered = listed.flatMap(({ contextId }) => contextId ? [contextId] : []);
  for (const contextId of new Set([...recorded.keys(), ...queued, ...discovered])) {
    const stored = recorded.has(contextId) || queued.has(contextId);
    if (busy.has(contextId)) {
      remaining += 1;
      continue;
    }
    try {
      if (await provider.removeContext(contextId) === 'deleted') deleted += 1;
      else if (stored) alreadyGone += 1;
    } catch (error) {
      if (!isForeign(error)) {
        remaining += 1;
        continue;
      }
      foreign += 1;
    }
    settled.add(contextId);
    for (const loginId of recorded.get(contextId) ?? []) await forgetWebsiteLoginContext(store, loginId, contextId);
  }
  await dropPendingContextDeletions(store, ({ contextId, handoffSessionId }) =>
    (contextId === undefined || settled.has(contextId)) &&
    (handoffSessionId === undefined || !stillRunning.has(handoffSessionId)));
  return { ended, deleted, alreadyGone, foreign, remaining, sessionsListed: listed.length, listingUnverified };
}

function isForeign(error: unknown): boolean {
  return error instanceof HostedBrowserRefusal && error.reason === 'ownership';
}

function isGone(error: unknown): boolean {
  return error instanceof BrowserProviderError && error.status === 404;
}
