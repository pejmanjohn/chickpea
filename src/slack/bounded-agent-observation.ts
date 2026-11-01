import type { AgentReply, ConversationStreamChunk, DispatchReceipt } from '@flue/runtime';
import { AgentInstanceNotFoundError, AgentRunError } from '@flue/runtime';
import { replyFromSnapshot } from '@flue/runtime/internal';

import { CHICKPEA_SLACK_AGENT_NAME } from '../agents/names.ts';
import type { FlueDispatchReceiptV1 } from './turn-job-types.ts';

/**
 * Bounded observation of an agent submission from another Durable Object.
 *
 * Why not Flue's `read()`: on Cloudflare it holds a long-poll request open
 * inside the agent object for the whole turn. In workerd every outbound
 * subrequest an actor makes is attributed to its latest not-yet-completed
 * incoming request, so while that long-poll is open the agent's own calls
 * (state RPCs back to TagStateStore, and the provider request itself) become
 * children of TagStateStore's request, and TagStateStore's outbound calls made
 * while an agent RPC is in flight become children of that RPC. Each round trip
 * adds hops until the platform's subrequest depth limit rejects an outbound
 * call. The confirmed production symptom (2026-09-09) is the Slack gateway
 * rejecting the relay's call with a subrequest-depth cause on a follow-up turn,
 * which left the turn without a stream coordinate and stuck on "working". The
 * same mechanism could explain the earlier edge-generated provider 503s, but
 * that link is not proven.
 *
 * This reader never holds a request open: it issues immediate reads of the
 * conversation updates view (no `live` parameter, which the route answers at
 * once) and sleeps whenever a read reports the stream caught up, so no
 * cross-object nesting can accumulate and no busy loop can form. Once
 * settlement is observed it reads the history view once for the reply, with
 * Flue's own settled-failure semantics (`AgentRunError`), instead of Flue's
 * `read()`, which would replay the conversation it has already seen.
 */

export interface AgentUpdatesRoute {
  (request: Request): Promise<Response>;
}

export interface BoundedObservationTarget {
  agentName: string;
  instanceId: string;
  submissionId: string;
  onEvent?: (chunk: ConversationStreamChunk) => void;
  signal?: AbortSignal;
  /**
   * True while the last delivered chunk says a long quiet wait is expected
   * (a coding worker step has started). Only consulted when `adaptive` is on.
   */
  isIdleCandidate?: () => boolean;
  /**
   * Seeds the hint for a reattached observation, whose replay may not end on
   * the milestone start: it holds until the first chunk delivered after the
   * first caught-up page.
   */
  initialIdleCandidate?: boolean;
}

/**
 * Backs the caught-up poll off geometrically once the stream has been quiet
 * for `idleAfterMs` and the target reports an idle candidate; any delivered
 * chunk ends the backoff.
 */
export interface AdaptivePollPolicy {
  idleAfterMs: number;
  maxIntervalMs: number;
  factor: number;
}

const DEFAULT_ADAPTIVE_POLICY: AdaptivePollPolicy = { idleAfterMs: 10_000, maxIntervalMs: 5_000, factor: 2 };

export interface BoundedObservationOptions {
  /** Delay before the next caught-up read once the stream has gone quiet; a hot stream waits at most 150 ms. */
  pollIntervalMs?: number;
  /** Test seam; production sleeps with a real timer. */
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Enables the adaptive backoff; omitted fields take the defaults. */
  adaptive?: Partial<AdaptivePollPolicy>;
  /** Test seam for the idle clock; production uses `Date.now`. */
  now?: () => number;
}

export interface ObservedSettlement {
  outcome: string;
  error?: unknown;
}

/**
 * A caught-up stream is read again after 150 ms while a chunk has arrived in
 * the last 3 s, and after 750 ms once it has gone quiet. A person waits on two
 * moments, the first streamed text and the settlement after the last token,
 * and each is noticed on average half a poll late, so the fast cadence covers
 * the seconds around them. The slow cadence keeps the agent object's request
 * count small through a long model call.
 */
const DEFAULT_POLL_INTERVAL_MS = 750;
const HOT_POLL_INTERVAL_MS = 150;
const HOT_WINDOW_MS = 3_000;
const SETTLEMENT_CHUNK = 'submission-settled';
const RESET_CHUNK = 'conversation-reset';
// Flue prepends this to every updates page, so a page is idle when the
// checkpoint is its only chunk; raw length never means content.
const CHECKPOINT_CHUNK = 'stream-checkpoint';
const NEXT_OFFSET_HEADER = 'Stream-Next-Offset';
const UP_TO_DATE_HEADER = 'Stream-Up-To-Date';

export async function observeAgentSettlementBounded(
  route: AgentUpdatesRoute,
  target: BoundedObservationTarget,
  options: BoundedObservationOptions = {},
): Promise<ObservedSettlement> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const hotPollIntervalMs = Math.min(HOT_POLL_INTERVAL_MS, pollIntervalMs);
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  const adaptive = options.adaptive ? { ...DEFAULT_ADAPTIVE_POLICY, ...options.adaptive } : undefined;
  let interval = pollIntervalMs;
  let lastChunkAt = now();
  let seeded = target.initialIdleCandidate === true;
  let caughtUpOnce = false;
  const base = agentViewBase(target.agentName, target.instanceId);
  let offset = '-1';
  for (;;) {
    throwIfAborted(target.signal);
    const response = await readAgentView(route, target, `${base}?view=updates&offset=${encodeURIComponent(offset)}`);
    const chunks = await response.json() as ConversationStreamChunk[];
    let settlement: ObservedSettlement | undefined;
    let delivered = 0;
    for (const chunk of chunks) {
      if ((chunk as { type: string }).type === CHECKPOINT_CHUNK) continue;
      delivered += 1;
      target.onEvent?.(chunk);
      settlement ??= settlementFromChunk(chunk, target.submissionId);
    }
    if (settlement) return settlement;
    if (delivered > 0) {
      lastChunkAt = now();
      if (caughtUpOnce) seeded = false;
    }
    const next = response.headers.get(NEXT_OFFSET_HEADER);
    const advanced = next !== null && next !== offset;
    if (next !== null) offset = next;
    // A caught-up page (declared by the route, or an idle page whose cursor
    // did not move) waits without holding any request open inside the agent
    // object. Only a lagging page, with more data already behind it, reads
    // again at once.
    const caughtUp = response.headers.get(UP_TO_DATE_HEADER) === 'true' ||
      (delivered === 0 && !advanced);
    if (!caughtUp) continue;
    caughtUpOnce = true;
    const quietMs = now() - lastChunkAt;
    const idle = adaptive && (seeded || target.isIdleCandidate?.() === true) &&
      quietMs >= adaptive.idleAfterMs;
    interval = idle ? Math.min(adaptive.maxIntervalMs, interval * adaptive.factor)
      : quietMs < HOT_WINDOW_MS ? hotPollIntervalMs : pollIntervalMs;
    await sleep(interval, target.signal);
  }
}

/**
 * Whether an agent submission has settled, as the instance's stream holds it
 * now: one pass over the updates view through the agent's namespace that
 * never waits.
 */
export async function agentSubmissionSettledBounded(
  env: Record<string, unknown> | undefined,
  target: Pick<BoundedObservationTarget, 'agentName' | 'instanceId' | 'submissionId'>,
): Promise<boolean> {
  const bindingName = agentObjectBindingName(target.agentName);
  const binding = agentObjectNamespace(env, bindingName);
  if (!binding) throw new AgentObjectBindingUnavailableError(bindingName);
  const caughtUp = new Error('caught up');
  try {
    await observeAgentSettlementBounded(agentObjectRoute(binding, target.instanceId), target, {
      sleep: () => Promise.reject(caughtUp),
    });
    return true;
  } catch (error) {
    if (error === caughtUp) return false;
    throw error;
  }
}

/** Mirrors Flue's settlement detection on the updates stream. */
function settlementFromChunk(chunk: ConversationStreamChunk, submissionId: string): ObservedSettlement | undefined {
  const record = chunk as unknown as Record<string, unknown>;
  if (record.type === SETTLEMENT_CHUNK && record.submissionId === submissionId) {
    return {
      outcome: String(record.outcome),
      ...(record.error === undefined ? {} : { error: record.error }),
    };
  }
  if (record.type === RESET_CHUNK) {
    const snapshot = record.snapshot as { settlements?: Array<Record<string, unknown>> } | undefined;
    const settled = snapshot?.settlements?.find((entry) => entry.submissionId === submissionId);
    if (settled) {
      return {
        outcome: String(settled.outcome),
        ...(settled.error === undefined ? {} : { error: settled.error }),
      };
    }
  }
  return undefined;
}

export interface BoundedReplyReaderInput {
  handle: { read(receipt: DispatchReceipt): Promise<AgentReply> };
  instanceId: string;
  receipt: FlueDispatchReceiptV1;
  onEvent: (chunk: ConversationStreamChunk) => void;
  signal?: AbortSignal;
  isIdleCandidate?: () => boolean;
  initialIdleCandidate?: boolean;
}

export type BoundedReplyReader = (input: BoundedReplyReaderInput) => Promise<AgentReply>;

/**
 * Build the reader for one agent. `resolveRoute` returns a function that
 * delivers a request to the instance's Durable Object; Cloudflare wraps the
 * agent namespace binding, tests supply a fake.
 */
export function createBoundedAgentReplyReader(input: {
  agentName: string;
  resolveRoute: (instanceId: string) => AgentUpdatesRoute | Promise<AgentUpdatesRoute>;
  pollIntervalMs?: number;
  sleep?: BoundedObservationOptions['sleep'];
  adaptive?: BoundedObservationOptions['adaptive'];
  now?: BoundedObservationOptions['now'];
}): BoundedReplyReader {
  return async ({ instanceId, receipt, onEvent, signal, isIdleCandidate, initialIdleCandidate }) => {
    const route = await input.resolveRoute(instanceId);
    const target = { agentName: input.agentName, instanceId };
    const settlement = await observeAgentSettlementBounded(route, {
      ...target,
      submissionId: receipt.submissionId,
      onEvent,
      ...(signal ? { signal } : {}),
      ...(isIdleCandidate ? { isIdleCandidate } : {}),
      ...(initialIdleCandidate ? { initialIdleCandidate } : {}),
    }, {
      ...(input.pollIntervalMs !== undefined ? { pollIntervalMs: input.pollIntervalMs } : {}),
      ...(input.sleep ? { sleep: input.sleep } : {}),
      ...(input.adaptive ? { adaptive: input.adaptive } : {}),
      ...(input.now ? { now: input.now } : {}),
    });
    if (settlement.outcome !== 'completed') {
      throw new AgentRunError({
        outcome: settlement.outcome === 'aborted' ? 'aborted' : 'failed',
        submissionId: receipt.submissionId,
        ...(settlement.error === undefined ? {} : { cause: settlement.error }),
      });
    }
    const history = await readAgentView(route, target, `${agentViewBase(input.agentName, instanceId)}?view=history`);
    const snapshot = await history.json() as AgentConversationSnapshot;
    return { ...replyFromSnapshot(snapshot, receipt.submissionId), uid: receipt.uid, submissionId: receipt.submissionId };
  };
}

function agentViewBase(agentName: string, instanceId: string): string {
  return `https://flue.invalid/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}`;
}

/** One immediate read of an agent view; a missing stream means the instance is gone. */
async function readAgentView(
  route: AgentUpdatesRoute,
  target: Pick<BoundedObservationTarget, 'agentName' | 'instanceId'>,
  url: string,
): Promise<Response> {
  const response = await route(new Request(url));
  if (response.ok) return response;
  if (response.status === 404) {
    const body = await response.json().catch(() => undefined) as { error?: { type?: string } } | undefined;
    if (body?.error?.type === 'stream_not_found') {
      throw new AgentInstanceNotFoundError({ id: target.instanceId });
    }
  }
  throw new Error(`Bounded agent observation for "${target.agentName}" failed with status ${response.status}.`);
}

/** The agent's Durable Object namespace binding, as the Worker env exposes it. */
export interface AgentObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

/**
 * Flue names each agent's Durable Object binding from its identity:
 * `FLUE_<IDENTITY>_AGENT` with `-` folded to `_`. The generated Worker config
 * is the source of truth; `tests/bounded-agent-observation.test.ts` pins the
 * literal this rule must produce for the Slack agent.
 */
export function agentObjectBindingName(agentName: string): string {
  return `FLUE_${agentName.toUpperCase().replace(/-/g, '_')}_AGENT`;
}

export const CHICKPEA_SLACK_AGENT_BINDING = agentObjectBindingName(CHICKPEA_SLACK_AGENT_NAME);

export class AgentObjectBindingUnavailableError extends Error {
  constructor(binding: string) {
    super(`Durable Object binding "${binding}" is unavailable; the agent reply cannot be observed.`);
    this.name = 'AgentObjectBindingUnavailableError';
  }
}

/**
 * The Cloudflare reader for one agent (the Slack agent by default). It
 * reaches the agent object through its namespace exactly as Flue's own router
 * does; ids from `idFromName` carry the name the SDK needs, so no
 * name-bootstrap RPC is required. A missing binding fails here, before any
 * dispatch, instead of silently returning to the long-poll read this module
 * exists to replace.
 */
export function createCloudflareBoundedAgentReplyReader(
  env: Record<string, unknown> | undefined,
  agentName: string = CHICKPEA_SLACK_AGENT_NAME,
): BoundedReplyReader {
  const bindingName = agentObjectBindingName(agentName);
  const binding = agentObjectNamespace(env, bindingName);
  if (!binding) throw new AgentObjectBindingUnavailableError(bindingName);
  return createBoundedAgentReplyReader({
    agentName,
    adaptive: {},
    resolveRoute: (instanceId) => agentObjectRoute(binding, instanceId),
  });
}

function agentObjectNamespace(
  env: Record<string, unknown> | undefined,
  bindingName: string,
): AgentObjectNamespace | undefined {
  const binding = env?.[bindingName] as AgentObjectNamespace | undefined;
  return binding && typeof binding.idFromName === 'function' && typeof binding.get === 'function'
    ? binding
    : undefined;
}

function agentObjectRoute(binding: AgentObjectNamespace, instanceId: string): AgentUpdatesRoute {
  const stub = binding.get(binding.idFromName(instanceId));
  return (request) => stub.fetch(request);
}

type AgentConversationSnapshot = Extract<ConversationStreamChunk, { type: 'conversation-reset' }>['snapshot'];

/**
 * One immediate read of an agent instance's newest `limit` history messages,
 * through its namespace as the bounded reader reaches it. Undefined where
 * the deployment has no such binding or the read is refused.
 */
export async function readAgentHistoryBounded(
  env: Record<string, unknown> | undefined,
  instanceId: string,
  limit: number,
  agentName: string = CHICKPEA_SLACK_AGENT_NAME,
): Promise<AgentConversationSnapshot | undefined> {
  const binding = agentObjectNamespace(env, agentObjectBindingName(agentName));
  if (!binding) return undefined;
  const response = await agentObjectRoute(binding, instanceId)(
    new Request(`${agentViewBase(agentName, instanceId)}?view=history&limit=${limit}`),
  );
  return response.ok ? await response.json() as AgentConversationSnapshot : undefined;
}

/** An abort whose reason was not an Error; the reader never throws a bare value. */
export class BoundedObservationAbortedError extends Error {
  constructor() {
    super('Bounded agent observation aborted.');
    this.name = 'BoundedObservationAbortedError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new BoundedObservationAbortedError();
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
