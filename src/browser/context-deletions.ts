/**
 * Browser objects at the provider that no website login records any more:
 * the saved context and open hand-off session of a deleted login, or a
 * context a bind created but could not record. Each is queued in the same
 * write that drops its last record, so a crash never strands one, and leaves
 * the queue only once the provider confirms it gone, or once it is older
 * than the provider could still be asked about. Work maintenance retries
 * whatever remains, oldest first, and an entry that fails again goes behind
 * the rest, so a few that always fail never hold up the others.
 */
import type { SettingsStore } from '../config/settings-store.ts';
import { BROWSER_PROVIDER_ID_PATTERN, BrowserProviderError, type BrowserProvider } from './provider.ts';

export const PENDING_CONTEXT_DELETIONS_SETTING = 'browser.pendingContextDeletions';

/** At least one id is present. */
export interface PendingContextDeletion {
  contextId?: string;
  handoffSessionId?: string;
  queuedAt: number;
  /** Times the provider was asked and the entry stayed; absent before the first. */
  attempts?: number;
}

/**
 * An entry this old is dropped: its context has outlived any reconnect of
 * the project it was made in, or the provider has refused it for a month.
 */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Only a backstop for the row's size; the age bound is what empties it. */
const MAX_PENDING = 1_000;
/** Each sweep's share, so a long queue never holds up the rest of maintenance. */
const PER_SWEEP = 25;
const MAX_CAS_ATTEMPTS = 12;

/** The queue row with `entries` appended: what a caller writes in its own compare-and-set. */
export function withPendingContextDeletions(raw: string | undefined, entries: readonly PendingContextDeletion[]): string {
  const queued = [...parsePendingContextDeletions(raw), ...entries];
  if (queued.length > MAX_PENDING) {
    console.warn('[chickpea] The browser context deletion queue is full; its oldest entries were dropped');
  }
  return JSON.stringify(queued.slice(-MAX_PENDING));
}

/** Queue objects for deletion on their own, when no other record changes with them. */
export async function queueContextDeletions(
  store: Pick<SettingsStore, 'getSetting' | 'applySettingsPatch'>,
  entries: readonly PendingContextDeletion[],
): Promise<void> {
  await updateQueue(store, (raw) => withPendingContextDeletions(raw, entries));
}

/**
 * End each entry's hand-off session, then delete its context, and drop the
 * entries the provider confirmed gone. A failed step keeps its entry (less
 * any step that finished), counted and moved behind the rest, for the next
 * sweep. Never throws for the provider.
 */
export async function settleContextDeletions(
  store: Pick<SettingsStore, 'getSetting' | 'applySettingsPatch'>,
  provider: BrowserProvider,
  entries: readonly PendingContextDeletion[],
): Promise<void> {
  const outcomes = new Map<string, PendingContextDeletion | undefined>();
  for (const entry of entries) {
    const remaining = await settle(provider, entry);
    outcomes.set(entryKey(entry), remaining && { ...remaining, attempts: (entry.attempts ?? 0) + 1 });
  }
  await dequeue(store, outcomes);
}

/**
 * One sweep of the queue with the install's provider. Entries past the age
 * bound are dropped first. With no provider (a standalone install with no
 * browser key) the rest wait, since a person may connect the same project
 * again.
 */
export async function drainContextDeletions(input: {
  store: Pick<SettingsStore, 'getSetting' | 'applySettingsPatch'>;
  provider: () => Promise<BrowserProvider | undefined>;
  now?: () => number;
}): Promise<void> {
  const now = (input.now ?? Date.now)();
  const queued = parsePendingContextDeletions(await input.store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING));
  const expired = queued.filter((entry) => now - entry.queuedAt > MAX_AGE_MS);
  if (expired.length) {
    console.warn('[chickpea] Browser contexts queued for deletion for 30 days were dropped from the queue');
    await dequeue(input.store, new Map(expired.map((entry) => [entryKey(entry), undefined])));
  }
  const batch = queued.filter((entry) => now - entry.queuedAt <= MAX_AGE_MS).slice(0, PER_SWEEP);
  if (!batch.length) return;
  const provider = await input.provider();
  if (provider) await settleContextDeletions(input.store, provider, batch);
}

function parsePendingContextDeletions(raw: string | undefined): PendingContextDeletion[] {
  if (raw === undefined) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const { contextId, handoffSessionId, queuedAt, attempts } = item as Record<string, unknown>;
    const id = (candidate: unknown) => typeof candidate === 'string' && BROWSER_PROVIDER_ID_PATTERN.test(candidate) ? candidate : undefined;
    const context = id(contextId);
    const handoff = id(handoffSessionId);
    if ((!context && !handoff) || typeof queuedAt !== 'number') return [];
    return [{
      ...(context ? { contextId: context } : {}),
      ...(handoff ? { handoffSessionId: handoff } : {}),
      queuedAt,
      ...(Number.isSafeInteger(attempts) && (attempts as number) > 0 ? { attempts: attempts as number } : {}),
    }];
  });
}

/** What is left of an entry once the provider has been asked: undefined when nothing is. */
async function settle(provider: BrowserProvider, entry: PendingContextDeletion): Promise<PendingContextDeletion | undefined> {
  const { handoffSessionId, ...rest } = entry;
  // A context is deleted only once the session that would save into it has ended.
  if (handoffSessionId && !await ended(provider, handoffSessionId)) return entry;
  if (!rest.contextId) return undefined;
  try {
    await provider.deleteContext(rest.contextId);
    return undefined;
  } catch {
    return rest;
  }
}

async function ended(provider: BrowserProvider, sessionId: string): Promise<boolean> {
  try {
    await provider.endSession(sessionId);
    return true;
  } catch (error) {
    if (error instanceof BrowserProviderError && error.status === 404) return true;
    // A session that already ended may refuse a release.
    const status = await provider.sessionStatus(sessionId).catch(() => 'RUNNING');
    return status !== 'RUNNING' && status !== 'PENDING';
  }
}

/**
 * Drop each settled entry, or move what remains of it behind every entry it
 * was not settled with. Entries queued meanwhile stay.
 */
async function dequeue(
  store: Pick<SettingsStore, 'getSetting' | 'applySettingsPatch'>,
  outcomes: ReadonlyMap<string, PendingContextDeletion | undefined>,
): Promise<void> {
  await updateQueue(store, (raw) => {
    const queued = parsePendingContextDeletions(raw);
    const untouched = queued.filter((entry) => !outcomes.has(entryKey(entry)));
    const remaining = queued.flatMap((entry) => {
      const outcome = outcomes.has(entryKey(entry)) ? outcomes.get(entryKey(entry)) : undefined;
      return outcome ? [outcome] : [];
    });
    const next = [...untouched, ...remaining];
    return next.length ? JSON.stringify(next) : null;
  });
}

/** Compare-and-set the queue row; `null` deletes it. Throws once contention outlasts the attempts. */
async function updateQueue(
  store: Pick<SettingsStore, 'getSetting' | 'applySettingsPatch'>,
  change: (raw: string | undefined) => string | null,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const raw = await store.getSetting(PENDING_CONTEXT_DELETIONS_SETTING);
    const next = change(raw);
    if (next === (raw ?? null)) return;
    const written = await store.applySettingsPatch({
      expected: { key: PENDING_CONTEXT_DELETIONS_SETTING, value: raw ?? null },
      ...(next === null
        ? { delete: [PENDING_CONTEXT_DELETIONS_SETTING] }
        : { set: [{ key: PENDING_CONTEXT_DELETIONS_SETTING, value: next }] }),
    });
    if (written) return;
  }
  throw new Error('The browser context deletion queue could not be updated.');
}

function entryKey(entry: PendingContextDeletion): string {
  return JSON.stringify([entry.contextId ?? null, entry.handoffSessionId ?? null, entry.queuedAt]);
}
