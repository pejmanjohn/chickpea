import type { GatewayInboundDelivery } from './protocol.ts';

/**
 * Worker-side intake for gateway socket deliveries.
 *
 * The gateway holds Slack's HTTP request open for at most two seconds while it
 * waits for this deployment's durable receipt, then answers 503 and Slack
 * retries. Admission is one state-store round trip, so intake throughput is
 * what keeps a burst of mentions inside that window. This module:
 *
 * - admits deliveries with bounded concurrency, first-in-first-out within one
 *   ordering key (a Slack thread, a DM conversation, a channel, or a user), so
 *   same-thread events keep their socket arrival order while unrelated threads
 *   no longer wait on each other;
 * - acknowledges a delivery Slack retries while this process already admitted
 *   it (or is admitting it) without another store round trip; and
 * - drops events this app's own bot user generated, which every downstream
 *   consumer ignores, before they reach the store at all.
 */

export type GatewayAdmissionOutcome = 'accepted' | 'duplicate' | 'rejected';

export interface GatewayAdmissionContext {
  /** The bound installation's bot user; events it authored are self-generated. */
  botUserId?: string | undefined;
}

/**
 * Self-generated events that no Worker consumer acts on:
 *
 * - `own_message`: a `message` whose top-level author is this bot user (any
 *   subtype except the `message_changed`/`message_deleted` wrappers, which
 *   carry no top-level author). Turn normalization always ignores it
 *   (`self_message`, `bot_message`, or `message_subtype`), and public-context
 *   reconciliation reads only the two wrappers.
 * - `own_message_changed`: an edit of a message this bot user authored. Only
 *   this app can edit its own messages; those edits are how Chickpea streams
 *   and finalizes a reply. Chickpea records each public reply's text itself
 *   when the reply is delivered, so the edit adds nothing to the public-context
 *   ledger (and a late stream snapshot can no longer overwrite that record).
 * - `own_reaction`: `reaction_added` by this bot user (the acknowledgement
 *   reaction). Turn normalization ignores it as `self_message`.
 *
 * Deliberately kept: `message_deleted` (Slack does not say who deleted the
 * message, and a person removing a reply must still leave the ledger),
 * `member_joined_channel` (the bot joining a channel is exactly what the
 * welcome and private-channel setup flows handle), `app_mention`, and
 * everything authored by people or other apps.
 */
export type GatewaySelfGeneratedEvent = 'own_message' | 'own_message_changed' | 'own_reaction';

export function gatewaySelfGeneratedEvent(
  delivery: GatewayInboundDelivery,
  botUserId: string | undefined,
): GatewaySelfGeneratedEvent | undefined {
  if (!botUserId || delivery.kind !== 'event.deliver') return undefined;
  const event = delivery.envelope.event as unknown as Record<string, unknown>;
  if (event.type === 'reaction_added') {
    return event.user === botUserId ? 'own_reaction' : undefined;
  }
  if (event.type !== 'message') return undefined;
  if (event.subtype === 'message_deleted') return undefined;
  if (event.subtype === 'message_changed') {
    return record(event.message)?.user === botUserId ? 'own_message_changed' : undefined;
  }
  return event.user === botUserId ? 'own_message' : undefined;
}

/**
 * The ordering scope of one delivery. Deliveries with the same key are
 * admitted in socket arrival order; different keys may be admitted in
 * parallel. Slack itself does not order separate Events API requests, so
 * arrival order within a thread is the strongest order that ever existed.
 */
export function gatewayDeliveryOrderKey(delivery: GatewayInboundDelivery): string {
  if (delivery.kind === 'interaction.agent_selected') return `user:${delivery.userId}`;
  if (delivery.kind === 'interaction.channel_agent_add') return `channel:${delivery.channelId}`;
  const event = delivery.envelope.event as unknown as Record<string, unknown>;
  const channel = str(event.channel);
  if (event.type === 'reaction_added') {
    const item = record(event.item);
    const itemChannel = str(item?.channel);
    const itemTs = str(item?.ts);
    // A reaction turn's thread is the reacted-to message (turn normalization).
    return itemChannel && itemTs ? `thread:${itemChannel}:${itemTs}` : 'workspace';
  }
  if (event.type === 'message' || event.type === 'app_mention') {
    if (!channel) return 'workspace';
    // Every top-level DM shares one conversation session: order the whole DM.
    if (event.channel_type === 'im' || channel.startsWith('D')) return `channel:${channel}`;
    const subject = event.subtype === 'message_changed'
      ? record(event.message)
      : event.subtype === 'message_deleted' ? record(event.previous_message) : event;
    const root = str(subject?.thread_ts) ?? str(subject?.ts) ?? str(event.deleted_ts) ?? str(event.ts);
    return root ? `thread:${channel}:${root}` : `channel:${channel}`;
  }
  if (channel) return `channel:${channel}`;
  return 'workspace';
}

/**
 * Per-key FIFO with one global in-flight bound. A task holds a slot only while
 * it runs; the next task of the same key starts after its predecessor settles.
 */
export class GatewayKeyedAdmissionQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly waiting: Array<() => void> = [];
  private running = 0;

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Gateway admission concurrency must be a positive integer.');
    }
  }

  get inFlight(): number {
    return this.running;
  }

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(() => this.withSlot(task));
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  private async withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.running < this.limit) {
      this.running += 1;
    } else {
      // A finishing task hands its slot straight to the oldest waiter.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running -= 1;
    }
  }
}

interface RecentDelivery {
  identity: string;
  at: number;
  pending?: Promise<GatewayAdmissionOutcome>;
}

/**
 * Bounded memory of deliveries this process durably admitted (or is
 * admitting). A hit is only ever an `accepted`/`duplicate` store outcome, which
 * the durable inbox would also answer as `duplicate` for 48 hours; a rejected
 * or failed admission is forgotten so its retry reaches the store again.
 */
export class GatewayRecentDeliveries {
  private readonly entries = new Map<string, RecentDelivery>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  lookup(delivery: GatewayInboundDelivery):
    | { state: 'admitted' }
    | { state: 'in_flight'; pending: Promise<GatewayAdmissionOutcome> }
    | undefined {
    const entry = this.entries.get(delivery.deliveryId);
    if (!entry) return undefined;
    // A delivery id reused with another identity is the store's conflict to report.
    if (entry.identity !== deliveryIdentity(delivery)) return undefined;
    if (entry.pending) return { state: 'in_flight', pending: entry.pending };
    if (this.now() - entry.at >= this.ttlMs) {
      this.entries.delete(delivery.deliveryId);
      return undefined;
    }
    return { state: 'admitted' };
  }

  track(delivery: GatewayInboundDelivery, pending: Promise<GatewayAdmissionOutcome>): void {
    const id = delivery.deliveryId;
    const entry: RecentDelivery = { identity: deliveryIdentity(delivery), at: this.now(), pending };
    this.entries.delete(id);
    this.entries.set(id, entry);
    this.evict();
    void pending.then((outcome) => {
      if (this.entries.get(id) !== entry) return;
      if (outcome === 'accepted' || outcome === 'duplicate') {
        delete entry.pending;
        entry.at = this.now();
      } else {
        this.entries.delete(id);
      }
    }, () => {
      if (this.entries.get(id) === entry) this.entries.delete(id);
    });
  }

  /** Oldest first: drop expired entries, then settled ones beyond the bound. */
  private evict(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      const expired = !entry.pending && now - entry.at >= this.ttlMs;
      if (!expired && this.entries.size <= this.maxEntries) break;
      // An in-flight admission is never forgotten: its retry must wait on it.
      // The gateway bounds pending receipts, which bounds these entries too.
      if (entry.pending) continue;
      this.entries.delete(id);
    }
  }
}

export type GatewayIntakeSource = 'store' | 'recent' | 'filter';

export interface GatewayIntakeObservation {
  delivery: GatewayInboundDelivery;
  receivedAt: number;
  outcome: GatewayAdmissionOutcome | 'failed' | 'filtered';
  source: GatewayIntakeSource;
  filterReason?: GatewaySelfGeneratedEvent;
  /** Time spent waiting for this delivery's ordering key and an admission slot. */
  queueMs?: number;
  /** Duration of the durable admission call itself. */
  admitMs?: number;
  /** Admissions running when this delivery was received. */
  inFlight: number;
}

export interface GatewayInboundAdmissionOptions {
  admit(delivery: GatewayInboundDelivery): Promise<GatewayAdmissionOutcome>;
  /** Parallel store admissions across ordering keys. */
  concurrency?: number;
  /** Drop events this app's bot user generated before admission. */
  filterSelfGenerated?: boolean;
  /** Remember admitted delivery ids so Slack retries skip the store. */
  rememberDeliveries?: boolean;
  recentLimit?: number;
  recentTtlMs?: number;
  now?: () => number;
  observe?(observation: GatewayIntakeObservation): void;
}

/**
 * Enough to overlap store round trips during a burst without crowding the
 * singleton state store, which also serves relay alarms and thread-runner
 * hand-offs. Admission itself is one short SQLite transaction there.
 */
export const GATEWAY_ADMISSION_CONCURRENCY = 6;
export const GATEWAY_RECENT_DELIVERY_LIMIT = 512;
export const GATEWAY_RECENT_DELIVERY_TTL_MS = 5 * 60_000;

/** One per process (or Durable Object): its memory outlives socket rotation. */
export class GatewayInboundAdmission {
  private readonly queue: GatewayKeyedAdmissionQueue;
  private readonly recent: GatewayRecentDeliveries | undefined;
  private readonly now: () => number;

  constructor(private readonly options: GatewayInboundAdmissionOptions) {
    this.now = options.now ?? Date.now;
    this.queue = new GatewayKeyedAdmissionQueue(options.concurrency ?? GATEWAY_ADMISSION_CONCURRENCY);
    this.recent = options.rememberDeliveries
      ? new GatewayRecentDeliveries(
        options.recentLimit ?? GATEWAY_RECENT_DELIVERY_LIMIT,
        options.recentTtlMs ?? GATEWAY_RECENT_DELIVERY_TTL_MS,
        this.now,
      )
      : undefined;
  }

  /** Resolves with the ack outcome once this delivery's admission is settled. */
  async deliver(
    delivery: GatewayInboundDelivery,
    context: GatewayAdmissionContext = {},
  ): Promise<GatewayAdmissionOutcome> {
    const receivedAt = this.now();
    const inFlight = this.queue.inFlight;
    const known = this.recent?.lookup(delivery);
    if (known?.state === 'in_flight') {
      // Slack retried while the first copy is still being admitted: answer
      // with its receipt instead of rejecting and provoking another retry.
      const first = await known.pending.catch(() => 'rejected' as const);
      if (first !== 'rejected') {
        this.observe({ delivery, receivedAt, outcome: 'duplicate', source: 'recent', inFlight });
        return 'duplicate';
      }
      // The first copy left no durable receipt; admit this one normally.
      const again = this.recent?.lookup(delivery);
      if (again) return this.deliver(delivery, context);
    } else if (known?.state === 'admitted') {
      this.observe({ delivery, receivedAt, outcome: 'duplicate', source: 'recent', inFlight });
      return 'duplicate';
    }
    const filterReason = this.options.filterSelfGenerated
      ? gatewaySelfGeneratedEvent(delivery, context.botUserId)
      : undefined;
    if (filterReason) {
      this.observe({ delivery, receivedAt, outcome: 'filtered', source: 'filter', filterReason, inFlight });
      return 'accepted';
    }
    let startedAt: number | undefined;
    let observed: GatewayAdmissionOutcome | 'failed' = 'failed';
    const pending = this.queue.run(gatewayDeliveryOrderKey(delivery), async () => {
      startedAt = this.now();
      return this.options.admit(delivery);
    });
    this.recent?.track(delivery, pending);
    try {
      observed = await pending;
      return observed;
    } finally {
      const settledAt = this.now();
      this.observe({
        delivery, receivedAt, outcome: observed, source: 'store', inFlight,
        ...(startedAt !== undefined
          ? { queueMs: startedAt - receivedAt, admitMs: settledAt - startedAt }
          : {}),
      });
    }
  }

  private observe(observation: GatewayIntakeObservation): void {
    try {
      this.options.observe?.(observation);
    } catch {
      // Observation is best effort and never changes the receipt.
    }
  }
}

function deliveryIdentity(delivery: GatewayInboundDelivery): string {
  return `${delivery.kind}\u0000${delivery.bindingId}\u0000${delivery.workspaceId}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
