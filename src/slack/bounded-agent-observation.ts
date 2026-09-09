import type { AgentReply, ConversationStreamChunk, DispatchReceipt } from '@flue/runtime';
import { AgentInstanceNotFoundError } from '@flue/runtime';

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
 * settlement is observed it defers to Flue's `read()`, which then completes in
 * bounded immediate requests and preserves Flue's settled failure semantics.
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
}

export interface BoundedObservationOptions {
  /** Delay before the next read once a read reports the stream caught up. */
  pollIntervalMs?: number;
  /** Test seam; production sleeps with a real timer. */
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface ObservedSettlement {
  outcome: string;
  error?: unknown;
}

/**
 * Slack progressive updates are batched at 250 ms and rate limited beyond
 * that, so a 750 ms cadence costs no visible latency while keeping the agent
 * object's request count small during a long model call.
 */
const DEFAULT_POLL_INTERVAL_MS = 750;
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
  const sleep = options.sleep ?? abortableSleep;
  const base = `https://flue.invalid/agents/${encodeURIComponent(target.agentName)}/${encodeURIComponent(target.instanceId)}`;
  let offset = '-1';
  for (;;) {
    throwIfAborted(target.signal);
    const response = await route(new Request(`${base}?view=updates&offset=${encodeURIComponent(offset)}`));
    if (!response.ok) {
      if (response.status === 404) {
        const body = await response.json().catch(() => undefined) as { error?: { type?: string } } | undefined;
        if (body?.error?.type === 'stream_not_found') {
          throw new AgentInstanceNotFoundError({ id: target.instanceId });
        }
      }
      throw new Error(`Bounded agent observation for "${target.agentName}" failed with status ${response.status}.`);
    }
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
    const next = response.headers.get(NEXT_OFFSET_HEADER);
    const advanced = next !== null && next !== offset;
    if (next !== null) offset = next;
    // A caught-up page (declared by the route, or an idle page whose cursor
    // did not move) waits without holding any request open inside the agent
    // object. Only a lagging page, with more data already behind it, reads
    // again at once.
    const caughtUp = response.headers.get(UP_TO_DATE_HEADER) === 'true' ||
      (delivered === 0 && !advanced);
    if (caughtUp) await sleep(pollIntervalMs, target.signal);
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
}): BoundedReplyReader {
  return async ({ handle, instanceId, receipt, onEvent, signal }) => {
    const route = await input.resolveRoute(instanceId);
    await observeAgentSettlementBounded(route, {
      agentName: input.agentName,
      instanceId,
      submissionId: receipt.submissionId,
      onEvent,
      ...(signal ? { signal } : {}),
    }, {
      ...(input.pollIntervalMs !== undefined ? { pollIntervalMs: input.pollIntervalMs } : {}),
      ...(input.sleep ? { sleep: input.sleep } : {}),
    });
    // Settled: Flue's read now completes in immediate bounded requests and
    // keeps its settled-failure semantics (AgentRunError) for the caller.
    return handle.read(receipt as DispatchReceipt);
  };
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
    super(`Durable Object binding "${binding}" is unavailable; the Slack agent reply cannot be observed.`);
    this.name = 'AgentObjectBindingUnavailableError';
  }
}

/**
 * The Cloudflare reader for the Slack agent. It reaches the agent object
 * through its namespace exactly as Flue's own router does; ids from
 * `idFromName` carry the name the SDK needs, so no name-bootstrap RPC is
 * required. A missing binding fails here, before any dispatch, instead of
 * silently returning to the long-poll read this module exists to replace.
 */
export function createCloudflareBoundedAgentReplyReader(
  env: Record<string, unknown> | undefined,
): BoundedReplyReader {
  const binding = env?.[CHICKPEA_SLACK_AGENT_BINDING] as AgentObjectNamespace | undefined;
  if (!binding || typeof binding.idFromName !== 'function' || typeof binding.get !== 'function') {
    throw new AgentObjectBindingUnavailableError(CHICKPEA_SLACK_AGENT_BINDING);
  }
  return createBoundedAgentReplyReader({
    agentName: CHICKPEA_SLACK_AGENT_NAME,
    resolveRoute: (instanceId) => {
      const stub = binding.get(binding.idFromName(instanceId));
      return (request) => stub.fetch(request);
    },
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Bounded agent observation aborted.');
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
