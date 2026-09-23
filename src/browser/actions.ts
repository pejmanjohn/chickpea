/**
 * Pending browser actions: a data-changing step an Agent wants to take on a
 * website login that allows actions, held until the person who asked replies
 * exactly "approve" (or "stop") in the same Slack thread.
 *
 * A record is bound to one workspace, conversation thread, Agent, and Slack
 * person, lives at most 15 minutes, and is spent once. Admission marks it
 * approved and binds it to the approving message; the turn that message
 * starts claims it, which consumes it. Records sit in bounded settings rows
 * (a clone of the OAuth continuation pattern) and carry no secret.
 */
import type { SettingsStore } from '../config/settings-store.ts';
import {
  addSettingStringSetValues,
  readSettingStringSet,
  removeSettingStringSetValues,
  updateJsonSetting,
} from '../config/setting-string-set.ts';
import { sha256HexNode } from '../security/digest.ts';
import type { BrowserAction } from './page.ts';

export const BROWSER_ACTION_TTL_MS = 15 * 60_000;
const RECORD_PREFIX = 'browseraction_';
const THREAD_PREFIX = 'browseraction_thread_';
const INDEX_KEY = 'browseraction_index';
const ID_PATTERN = /^[a-f0-9]{32}$/;
/** Spent or expired records are kept this long for a late claim to explain itself. */
const RETAIN_SETTLED_MS = 60 * 60_000;

export type BrowserActionStatus = 'pending' | 'approved' | 'consumed' | 'expired';
/** At most this many form-filling steps are replayed before an approved action. */
export const MAX_BROWSER_FORM_STEPS = 20;

/**
 * A form-filling step taken on the page before the data-changing one. An
 * approved action runs in a new browser session, so these are replayed first
 * to restore what was typed or chosen.
 */
export interface BrowserFormStep {
  role: string;
  name: string;
  occurrence: number;
  action: BrowserAction;
  text?: string;
  key?: string;
}

export interface BrowserActionRecord {
  id: string;
  workspaceId: string;
  actorSlackUserId: string;
  actorMembershipId?: string;
  agentId: string;
  channelId: string;
  threadTs: string;
  loginId: string;
  host: string;
  url: string;
  title: string;
  /** The ref at the time of asking; refs are not stable across sessions. */
  ref: string;
  /** Accessibility role and name, used to find the element again after approval. */
  role: string;
  name: string;
  /** Which of the elements sharing that role and name (0-based). */
  occurrence: number;
  action: BrowserAction;
  text?: string;
  key?: string;
  submit?: boolean;
  /** Form-filling steps on this page to replay before the action. */
  prelude?: BrowserFormStep[];
  description: string;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  status: BrowserActionStatus;
  /** The Slack message that approved it; only the turn for that message may claim it. */
  approvedMessageTs?: string;
}

/** Where a browser action is being asked for or claimed from. */
export interface BrowserActionScope {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  agentId: string;
  actorSlackUserId: string;
  actorMembershipId?: string;
}

export type BrowserActionErrorCode = 'not_found' | 'wrong_scope' | 'not_approved' | 'consumed' | 'expired';

export class BrowserActionError extends Error {
  readonly name = 'BrowserActionError';
  constructor(readonly code: BrowserActionErrorCode) {
    super(`Browser action ${code.replace('_', ' ')}`);
  }
}

export type CreateBrowserActionInput = BrowserActionScope & Pick<BrowserActionRecord,
  'loginId' | 'host' | 'url' | 'title' | 'ref' | 'role' | 'name' | 'occurrence' | 'action' | 'description'
> & {
  text?: string;
  key?: string;
  submit?: boolean;
  prelude?: readonly BrowserFormStep[];
  now?: number;
  randomId?: () => string;
};

/**
 * Store a pending action and point its thread at it. A newer request in the
 * same thread for the same Agent replaces the pointer, so only the latest
 * question can be approved.
 */
export async function createBrowserAction(
  settings: SettingsStore,
  input: CreateBrowserActionInput,
): Promise<BrowserActionRecord> {
  const now = input.now ?? Date.now();
  const id = (input.randomId ?? (() => crypto.randomUUID().replaceAll('-', '')))();
  if (!ID_PATTERN.test(id)) throw new BrowserActionError('not_found');
  const record: BrowserActionRecord = {
    id,
    workspaceId: input.workspaceId,
    actorSlackUserId: input.actorSlackUserId,
    ...(input.actorMembershipId ? { actorMembershipId: input.actorMembershipId } : {}),
    agentId: input.agentId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    loginId: input.loginId,
    host: input.host,
    url: input.url,
    title: input.title.slice(0, 300),
    ref: input.ref,
    role: input.role,
    name: input.name.slice(0, 300),
    occurrence: input.occurrence,
    action: input.action,
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.key === undefined ? {} : { key: input.key }),
    ...(input.submit === undefined ? {} : { submit: input.submit }),
    ...(input.prelude?.length
      ? { prelude: input.prelude.slice(-MAX_BROWSER_FORM_STEPS).map((step) => ({ ...step })) }
      : {}),
    description: input.description.slice(0, 200),
    createdAt: now,
    expiresAt: now + BROWSER_ACTION_TTL_MS,
    updatedAt: now,
    status: 'pending',
  };
  // Index first: a crash can leave a harmless index entry, never an
  // unswept record.
  await addSettingStringSetValues(settings, INDEX_KEY, [id]);
  await settings.applySettingsPatch({
    set: [
      { key: recordKey(id), value: JSON.stringify(record) },
      { key: threadKey(input), value: id },
    ],
  });
  return record;
}

export async function getBrowserAction(
  settings: SettingsStore,
  id: string,
): Promise<BrowserActionRecord | undefined> {
  if (!ID_PATTERN.test(id)) return undefined;
  const raw = await settings.getSetting(recordKey(id));
  return raw ? safeParse(raw) : undefined;
}

/**
 * Admission: answer the pending action for this thread, Agent, and person.
 * "approve" marks it approved for the replying message; "stop" spends it.
 * The caller matches the reply text (slackBrowserActionReply). Returns
 * undefined when nothing is pending for exactly this scope.
 */
export async function resolveBrowserActionReply(input: {
  settings: SettingsStore;
  word: 'approve' | 'stop';
  scope: BrowserActionScope;
  messageTs: string;
  now?: number;
}): Promise<{ kind: 'approved' | 'stopped'; id: string } | undefined> {
  const { word } = input;
  const id = await input.settings.getSetting(threadKey(input.scope));
  if (!id || !ID_PATTERN.test(id)) return undefined;
  const now = input.now ?? Date.now();
  const outcome = await updateRecord(input.settings, id, (record) => {
    if (record.status !== 'pending' || !sameScope(record, input.scope)) return undefined;
    if (record.expiresAt <= now) return { ...record, status: 'expired', updatedAt: now };
    return word === 'approve'
      ? { ...record, status: 'approved', approvedMessageTs: input.messageTs, updatedAt: now }
      : { ...record, status: 'consumed', updatedAt: now };
  });
  if (!outcome || outcome.status === 'expired') return undefined;
  return { kind: word === 'approve' ? 'approved' : 'stopped', id };
}

/**
 * The approved turn claims its action once: same scope, approved by this
 * turn's own message, not expired. Claiming consumes it.
 */
export async function claimApprovedBrowserAction(input: {
  settings: SettingsStore;
  id: string;
  scope: BrowserActionScope;
  messageTs: string;
  now?: number;
}): Promise<BrowserActionRecord> {
  const now = input.now ?? Date.now();
  const outcome: { failure?: BrowserActionErrorCode } = {};
  const claimed = await updateRecord(input.settings, input.id, (record) => {
    delete outcome.failure;
    if (!sameScope(record, input.scope)) {
      outcome.failure = 'wrong_scope';
      return undefined;
    }
    if (record.status === 'consumed') {
      outcome.failure = 'consumed';
      return undefined;
    }
    if (record.status === 'expired' || record.expiresAt <= now) {
      outcome.failure = 'expired';
      return record.status === 'expired' ? undefined : { ...record, status: 'expired', updatedAt: now };
    }
    if (record.status !== 'approved' || record.approvedMessageTs !== input.messageTs) {
      outcome.failure = 'not_approved';
      return undefined;
    }
    return { ...record, status: 'consumed', updatedAt: now };
  });
  if (!claimed) throw new BrowserActionError(outcome.failure ?? 'not_found');
  if (outcome.failure) throw new BrowserActionError(outcome.failure);
  return claimed;
}

/**
 * Expire overdue records and delete settled ones after a retention window.
 * Bounded per call; runs opportunistically when a new action is asked. With
 * `minIndexSize`, a smaller index is left alone: expiry is also enforced at
 * claim time, so sweeping is only cleanup.
 */
export async function sweepBrowserActions(input: {
  settings: SettingsStore;
  now?: number;
  limit?: number;
  minIndexSize?: number;
}): Promise<{ expired: number; removed: number }> {
  const now = input.now ?? Date.now();
  let expired = 0;
  let removed = 0;
  const ids = await indexIds(input.settings);
  if (ids.length <= (input.minIndexSize ?? 0)) return { expired, removed };
  for (const id of ids.slice(0, input.limit ?? 25)) {
    const raw = await input.settings.getSetting(recordKey(id));
    const record = raw ? safeParse(raw) : undefined;
    if (!raw || !record) {
      if (raw) await input.settings.deleteSetting(recordKey(id));
      await removeIndexId(input.settings, id);
      removed += 1;
      continue;
    }
    const live = record.status === 'pending' || record.status === 'approved';
    if (live && record.expiresAt <= now) {
      const changed = await input.settings.applySettingsPatch({
        expected: { key: recordKey(id), value: raw },
        set: [{ key: recordKey(id), value: JSON.stringify({ ...record, status: 'expired', updatedAt: now }) }],
      });
      if (changed) expired += 1;
      continue;
    }
    if (!live && record.updatedAt + RETAIN_SETTLED_MS <= now) {
      const pointer = threadKey(record);
      const pointed = await input.settings.getSetting(pointer);
      const changed = await input.settings.applySettingsPatch({
        expected: { key: recordKey(id), value: raw },
        delete: [recordKey(id), ...(pointed === id ? [pointer] : [])],
      });
      if (changed) {
        await removeIndexId(input.settings, id);
        removed += 1;
      }
    }
  }
  return { expired, removed };
}

function sameScope(record: BrowserActionRecord, scope: BrowserActionScope): boolean {
  return record.workspaceId === scope.workspaceId &&
    record.channelId === scope.channelId &&
    record.threadTs === scope.threadTs &&
    record.agentId === scope.agentId &&
    record.actorSlackUserId === scope.actorSlackUserId &&
    (record.actorMembershipId === undefined || record.actorMembershipId === scope.actorMembershipId);
}

/** Compare-and-set one record; `change` returns the next record or undefined to leave it. */
async function updateRecord(
  settings: SettingsStore,
  id: string,
  change: (record: BrowserActionRecord) => BrowserActionRecord | undefined,
): Promise<BrowserActionRecord | undefined> {
  if (!ID_PATTERN.test(id)) return undefined;
  const next = await updateJsonSetting<BrowserActionRecord>(
    settings,
    recordKey(id),
    (record) => (record ? change(record) : undefined),
    safeParse,
  );
  return next ?? undefined;
}

function recordKey(id: string): string {
  return `${RECORD_PREFIX}${id}`;
}

function threadKey(scope: Pick<BrowserActionScope, 'workspaceId' | 'channelId' | 'threadTs' | 'agentId'>): string {
  return `${THREAD_PREFIX}${sha256HexNode(`${scope.workspaceId}\n${scope.channelId}\n${scope.threadTs}\n${scope.agentId}`).slice(0, 40)}`;
}

function indexIds(settings: SettingsStore): Promise<string[]> {
  return readSettingStringSet(settings, INDEX_KEY, (id) => ID_PATTERN.test(id));
}

function removeIndexId(settings: SettingsStore, id: string): Promise<void> {
  return removeSettingStringSetValues(settings, INDEX_KEY, [id]);
}

const ACTIONS = new Set<string>(['click', 'type', 'press', 'select', 'scroll', 'hover', 'clear']);
const STATUSES = new Set<string>(['pending', 'approved', 'consumed', 'expired']);

function safeParse(raw: string): BrowserActionRecord | undefined {
  try {
    return parseRecord(raw);
  } catch {
    return undefined;
  }
}

function parseRecord(raw: string): BrowserActionRecord | undefined {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const strings = ['id', 'workspaceId', 'actorSlackUserId', 'agentId', 'channelId', 'threadTs', 'loginId',
    'host', 'url', 'title', 'ref', 'role', 'name', 'description'] as const;
  if (strings.some((key) => typeof value[key] !== 'string')) return undefined;
  if (!ID_PATTERN.test(value.id as string) || !ACTIONS.has(String(value.action)) ||
      !STATUSES.has(String(value.status)) || typeof value.occurrence !== 'number' ||
      typeof value.createdAt !== 'number' || typeof value.expiresAt !== 'number' ||
      typeof value.updatedAt !== 'number') {
    return undefined;
  }
  return value as unknown as BrowserActionRecord;
}
