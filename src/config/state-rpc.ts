import type { AssignmentLookupOptions } from './resolver.ts';
import type { ConfigAgentPatch } from './store.ts';
import type { AgentSnapshot, ChannelAssignment, CustomAgentConfig, ResolvedAssignment } from './types.ts';
import type { NormalizedSlackTurn } from '../slack/types.ts';

/**
 * Wire contract between the Cloudflare store proxies and the TagStateStore
 * Durable Object (src/cloudflare.ts). Lives in a target-neutral module so BOTH
 * sides compile against the one definition — the DO implements it, the proxies
 * consume it, and a drift between them is a type error instead of a runtime
 * RPC surprise.
 *
 * Every method returns an explicit `{ok}` envelope rather than throwing across
 * the RPC boundary: workerd serializes thrown errors down to a bare
 * message-only Error, which would force the proxies to re-classify domain
 * errors by matching message text (the exact fragility src/config/errors.ts
 * exists to prevent). The envelope carries a stable machine `code` plus the
 * constructor args, so the proxy re-throws the SAME typed errors the node
 * backend throws and route boundaries stay `instanceof`-based on both targets.
 *
 * Args and returns are JSON-clonable; `undefined` results travel as `null`
 * (structured clone would carry `undefined`, but keeping the wire shape plain
 * JSON keeps it dumpable/loggable and independent of clone semantics).
 */

export type StateRpcErrorCode =
  | 'unknown_agent'
  | 'agent_exists'
  | 'agent_still_assigned'
  | 'internal';

export interface StateRpcError {
  code: StateRpcErrorCode;
  /** Human-readable failure text (safe to log; never shown to Slack users). */
  message: string;
  /** Typed-error constructor args, keyed per code (e.g. agentId, keys). */
  details?: Record<string, string>;
}

export type StateRpcResult<T> = { ok: true; value: T } | { ok: false; error: StateRpcError };

/**
 * A queued Slack turn, handed from the events handler to the state Durable
 * Object so its `alarm()` can run the turn AFTER the events ack — the Cloudflare
 * turn-horizon fix. On Cloudflare a turn driven inside the events invocation's
 * `waitUntil` is cancelled ~30s after the response, killing any longer model
 * turn; a DO alarm handler gets the platform's 15-minute wall-time budget
 * instead, so the alarm relay is what lets a slow keyless turn finish and
 * deliver. Every field is JSON-clonable (the whole job crosses the RPC boundary
 * and is persisted as JSON): `turn` is the normalized turn, `assignment` is the
 * SAME resolved assignment/snapshot the handler already computed (re-resolving
 * in the alarm could drift), and `id` is the idempotency key (the message
 * claim key) so a duplicate enqueue is ignored.
 */
export interface TurnJob {
  id: string;
  evtKey: string;
  msgKey: string;
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
}

/**
 * Flat RPC surface of the state Durable Object stub: all four store domains
 * (config, snapshots, slack claims/threads, settings), one method per
 * operation, promise-returning as seen from the caller side of the stub.
 */
export interface TagStateRpc {
  // -- config: agents ------------------------------------------------------
  configListAgents(): Promise<StateRpcResult<CustomAgentConfig[]>>;
  configGetAgent(agentId: string): Promise<StateRpcResult<CustomAgentConfig>>;
  configCreateAgent(agent: CustomAgentConfig): Promise<StateRpcResult<CustomAgentConfig>>;
  configUpdateAgent(
    agentId: string,
    patch: ConfigAgentPatch,
  ): Promise<StateRpcResult<CustomAgentConfig>>;
  configDeleteAgent(agentId: string): Promise<StateRpcResult<boolean>>;
  // -- config: assignments -------------------------------------------------
  configListAssignments(): Promise<StateRpcResult<ChannelAssignment[]>>;
  configGetAssignment(
    workspaceId: string,
    channelId: string,
  ): Promise<StateRpcResult<ChannelAssignment | null>>;
  configListAssignmentsForAgent(agentId: string): Promise<StateRpcResult<ChannelAssignment[]>>;
  configPutAssignment(assignment: ChannelAssignment): Promise<StateRpcResult<ChannelAssignment>>;
  configDeleteAssignment(
    workspaceId: string,
    channelId: string,
  ): Promise<StateRpcResult<boolean>>;
  configFind(
    workspaceId: string,
    channelId: string,
    options?: AssignmentLookupOptions,
  ): Promise<StateRpcResult<ChannelAssignment | null>>;
  // -- agent snapshots -----------------------------------------------------
  snapshotGet(threadKey: string): Promise<StateRpcResult<AgentSnapshot | null>>;
  snapshotPutIfAbsent(
    threadKey: string,
    snapshot: AgentSnapshot,
  ): Promise<StateRpcResult<AgentSnapshot>>;
  // -- slack claims + thread registry --------------------------------------
  claim(key: string): Promise<StateRpcResult<boolean>>;
  release(key: string): Promise<StateRpcResult<null>>;
  threadStart(key: string): Promise<StateRpcResult<null>>;
  threadHas(key: string): Promise<StateRpcResult<boolean>>;
  // -- operator settings ---------------------------------------------------
  settingGet(key: string): Promise<StateRpcResult<string | null>>;
  settingSet(key: string, value: string): Promise<StateRpcResult<null>>;
  settingDelete(key: string): Promise<StateRpcResult<null>>;
  // -- turn relay (Cloudflare turn-horizon fix) ----------------------------
  /**
   * Persist a turn job and arm the alarm so `alarm()` runs it past the events
   * ack. Resolves only after the write + `setAlarm` are durable, so the caller
   * can ack Slack knowing the turn survives regardless of the events
   * invocation's fate. Idempotent by `job.id` (a duplicate enqueue is ignored).
   */
  enqueueTurn(job: TurnJob): Promise<StateRpcResult<null>>;
}

/**
 * Minimal structural view of the `env.TAG_STATE` Durable Object namespace
 * binding — just enough to obtain the singleton stub. Declared here (not via
 * workers-types) so the node lane compiles without Cloudflare's global types.
 */
export interface TagStateNamespace {
  getByName(name: string): TagStateRpc;
}

/**
 * The one state DO instance. ALL app state lives in a single named instance:
 * a singleton is what makes claim dedupe race-free (single-threaded DO) and
 * keeps every domain in one SQLite file, exactly like the node lane's
 * one-file state DB.
 */
export const TAG_STATE_INSTANCE = 'singleton';

/** Resolve the singleton state-DO stub from the worker/agent platform env. */
export function tagStateStub(env: Record<string, unknown> | undefined): TagStateRpc {
  if (!env) {
    throw new Error(
      'Cloudflare state backend requires the platform env (route handlers pass c.env; ' +
        'the agent passes getCloudflareContext().env)',
    );
  }
  const namespace = (env as { TAG_STATE?: TagStateNamespace }).TAG_STATE;
  if (!namespace || typeof namespace.getByName !== 'function') {
    throw new Error(
      'TAG_STATE Durable Object binding is missing — check wrangler.jsonc durable_objects.bindings',
    );
  }
  return namespace.getByName(TAG_STATE_INSTANCE);
}
