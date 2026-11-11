import type { StateRpcResult } from './state-rpc.ts';
import type { StateRead, TurnReadScope } from './turn-reads.ts';

/**
 * A thread runner's turn prepares over a dozen rounds to the state store. It
 * sends the reads it can name up front as one `stateReadBatch`, beside its
 * fold claim, and `TurnReads` answers its Cf store proxies from that:
 *
 * - settings and model credential records answer every read until the turn
 *   prepares its dispatch, as if read at its start; one outside the batch
 *   is read once, then kept;
 * - any other batched read answers only the turn's first identical read, so
 *   a later read of it goes to the state store, and a lease check always
 *   does (`outsideTurnReads`);
 * - only successful answers are kept: every error comes from a read's own RPC;
 * - a write the turn sends drops what is kept for its store, and one sent
 *   while the batch was out discards the batch's answers for that store.
 *
 * A state store without the batch, or one that fails it, answers nothing
 * from it, and the turn reads as it did.
 */

export const STATE_READ_BATCH_MAX = 64;

/** `kinds` limits a multi-kind method to its read kinds. */
const BATCH_READS: Record<string, { kinds?: ReadonlySet<string> }> = {
  settingGet: {},
  settingGetMany: {},
  modelCredentialRead: {},
  configGetAgent: {},
  configListAgentChannelGrants: {},
  configListConnectionAccounts: {},
  configListAgentConnectionBindings: {},
  configGetAgentModelRole: {},
  configGetWorkspaceModelRole: {},
  configGetWorkspaceInstallation: {},
  configListSlackPublicContext: {},
  memoryExecute: { kinds: new Set(['get_agent_memory']) },
  workExecute: { kinds: new Set(['get_run', 'get_binding']) },
  threadRunnerTurn: { kinds: new Set(['getBoundRuntimePlan']) },
};

function batchable(read: StateRead): boolean {
  if (!Object.hasOwn(BATCH_READS, read.method) || !Array.isArray(read.args)) return false;
  const { kinds } = BATCH_READS[read.method]!;
  const kind = (read.args[0] as { kind?: unknown } | null | undefined)?.kind;
  return !kinds || (typeof kind === 'string' && kinds.has(kind));
}

/** The state store's side: each batchable read answered by its own RPC method; null otherwise. */
export async function answerStateReads(
  reads: readonly StateRead[],
  target: object,
): Promise<Array<StateRpcResult<unknown> | null>> {
  const answers: Array<StateRpcResult<unknown> | null> = [];
  for (const read of reads.slice(0, STATE_READ_BATCH_MAX)) {
    const method = (target as Record<string, unknown>)[read.method];
    answers.push(batchable(read) && typeof method === 'function'
      ? await (method as (...args: unknown[]) => Promise<StateRpcResult<unknown>>).apply(target, [...read.args])
      : null);
  }
  return answers;
}

type Store = 'settings' | 'config' | 'memory' | 'work' | 'turn';

function storeOf(method: string): Store | undefined {
  if (/^(?:setting|modelCredential|encryptedCredential)/.test(method)) return 'settings';
  if (method.startsWith('config')) return 'config';
  if (method === 'memoryExecute') return 'memory';
  if (method === 'workExecute') return 'work';
  if (method === 'threadRunnerTurn') return 'turn';
  return undefined;
}

/**
 * The store a call writes, when the write may change a batched read. Of a
 * turn row's operations only the plan's freeze does (the bound plan).
 */
function writtenStore(method: string, op: string | undefined): Store | undefined {
  const store = storeOf(method);
  if (store === 'turn') return op === 'freezeRuntimePlan' ? store : undefined;
  if (store === 'memory' || store === 'work') return op !== undefined && /^(?:get|list|find|count|has|latest|next)_/.test(op) ? undefined : store;
  return store && !/^(?:setting|modelCredential|encryptedCredential|config)(?:Get|List|Read|Census|Summarize|Preflight)/.test(method)
    ? store
    : undefined;
}

const readKey = (read: StateRead) => `${read.method} ${JSON.stringify(read.args)}`;

/**
 * How long a turn's kept reads answer at most. Dispatch preparation ends them
 * well before this; the bound covers any path that never reaches it.
 */
export const TURN_READS_MAX_AGE_MS = 10_000;

export class TurnReads implements TurnReadScope {
  /** Null is an absent setting. */
  private readonly settings = new Map<string, string | null>();
  private readonly credentials = new Map<string, Promise<StateRpcResult<unknown>>>();
  private readonly once = new Map<string, StateRpcResult<unknown>>();
  /** Bumped by a settings write, so a read sent before it is not kept. */
  private settingsWrites = 0;
  /** Stores written while the batch was out. */
  private readonly written = new Set<Store>();
  private readonly prefetched: Promise<void>;
  private open = true;
  private readonly openedAt: number;

  constructor(
    prefetch: Promise<ReadonlyArray<readonly [StateRead, StateRpcResult<unknown> | null]> | undefined>,
    private readonly now: () => number = Date.now,
  ) {
    this.openedAt = now();
    this.prefetched = prefetch.then((answered) => {
      if (!this.open || !answered) return;
      for (const [read, answer] of answered) {
        if (!answer?.ok || this.written.has(storeOf(read.method)!)) continue;
        if (read.method === 'modelCredentialRead') {
          this.credentials.set(String(read.args[0]), Promise.resolve(answer));
        } else if (read.method === 'settingGet' || read.method === 'settingGetMany') {
          this.keepSettings(read, answer.value);
        } else {
          this.once.set(readKey(read), answer);
        }
      }
    }, () => undefined);
  }

  async read<T>(
    method: string,
    args: readonly unknown[],
    send: () => Promise<StateRpcResult<T>>,
  ): Promise<StateRpcResult<T>> {
    if (!this.open) return send();
    await this.prefetched;
    if (this.now() - this.openedAt > TURN_READS_MAX_AGE_MS) this.close();
    if (!this.open) return send();
    if (method === 'settingGet' || method === 'settingGetMany') return this.readSettings({ method, args }, send);
    if (method === 'modelCredentialRead') return this.readCredential(String(args[0]), send);
    const key = readKey({ method, args });
    const answer = this.once.get(key);
    if (!answer) return send();
    this.once.delete(key);
    return answer as StateRpcResult<T>;
  }

  sent(method: string, op: string | undefined): void {
    const store = writtenStore(method, op);
    if (!store) return;
    this.written.add(store);
    if (store === 'settings') {
      this.settingsWrites += 1;
      this.settings.clear();
      this.credentials.clear();
      return;
    }
    for (const key of this.once.keys()) {
      if (storeOf(key.slice(0, key.indexOf(' '))) === store) this.once.delete(key);
    }
  }

  close(): void {
    this.open = false;
    this.settings.clear();
    this.credentials.clear();
    this.once.clear();
  }

  private async readSettings<T>(read: StateRead, send: () => Promise<StateRpcResult<T>>): Promise<StateRpcResult<T>> {
    const keys = (read.method === 'settingGet' ? [read.args[0]] : read.args[0]) as readonly string[];
    if (keys.every((key) => this.settings.has(key))) {
      const values = keys.map((key) => this.settings.get(key)!);
      return { ok: true, value: (read.method === 'settingGet' ? values[0] : values) as T };
    }
    const writes = this.settingsWrites;
    const answer = await send();
    if (answer.ok && this.open && writes === this.settingsWrites) this.keepSettings(read, answer.value);
    return answer;
  }

  private keepSettings(read: StateRead, value: unknown): void {
    if (read.method === 'settingGet') {
      this.settings.set(String(read.args[0]), (value as string | null) ?? null);
      return;
    }
    const values = value as ReadonlyArray<string | null>;
    (read.args[0] as readonly string[]).forEach((key, index) => this.settings.set(key, values[index] ?? null));
  }

  private readCredential<T>(providerId: string, send: () => Promise<StateRpcResult<T>>): Promise<StateRpcResult<T>> {
    const kept = this.credentials.get(providerId) as Promise<StateRpcResult<T>> | undefined;
    // A shared read that failed answers no one else: each then reads on its own.
    if (kept) {
      const retry = () => this.readCredential(providerId, send);
      return kept.then((answer) => (answer.ok ? answer : retry()), retry);
    }
    const sent = send();
    this.credentials.set(providerId, sent);
    const drop = () => { if (this.credentials.get(providerId) === sent) this.credentials.delete(providerId); };
    sent.then((answer) => { if (!answer.ok) drop(); }, drop);
    return sent;
  }
}
