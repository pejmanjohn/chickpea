import { isCloudflareTarget } from '../config/runtime-target.ts';
import {
  deriveRuntimePlanInstanceId,
  parseRuntimePlanV2,
  runtimePlanInstanceIdMatches,
  type AdmittedRuntimePlanData,
  type RuntimePlanV2,
} from './runtime-plan.ts';

/**
 * The turn input: what one Slack turn's render needs that Flue cannot carry.
 *
 * A thread's Flue instance is its durable transcript, so it outlives any one
 * plan: the speaker, the Agent's configuration, its memory, and its model all
 * change between turns. Flue's creation data is recorded once, and everything
 * in a delivery is rendered into the model's transcript, so the host stages
 * each turn's frozen plan beside the instance before it dispatches, keyed by
 * the TurnJob id. The render reads it synchronously: Flue fixes the model,
 * the MCP servers, and the sandbox from the first render of a submission,
 * before any async hook runs.
 *
 * Cloudflare: a table in the agent Durable Object's own SQLite, written by
 * the host through `chickpeaStageTurnInput` (see slackThreadCloudflareExtension)
 * and read through Flue's Cloudflare context. Node: the agent runs in the
 * host process; the host keeps the input in process and in its state DB.
 */
export const SLACK_TURN_INPUT_SCHEMA_VERSION = 1 as const;

/** Agent memory bodies are capped at 64 KiB; this leaves room for framing. */
const MAX_MEMORY_BLOCK_BYTES = 80 * 1024;
/** Stays under Durable Object SQLite's 2 MB row limit. */
const MAX_TURN_INPUT_BYTES = 1_500_000;
/** Staged inputs kept per instance (one thread): enough for retries and recovery. */
export const MAX_STAGED_TURN_INPUTS = 64;
const MAX_TURN_JOB_ID_CHARS = 200;

export interface SlackTurnInputV1 {
  schemaVersion: typeof SLACK_TURN_INPUT_SCHEMA_VERSION;
  turnJobId: string;
  instanceId: string;
  /** Kept as admitted; parsing re-validates it against its harness revision. */
  runtimePlan: AdmittedRuntimePlanData;
  /** This turn's Agent memory, rendered as an instruction. */
  memoryBlock?: string;
}

export interface SlackTurnInput {
  turnJobId: string;
  instanceId: string;
  runtimePlan: RuntimePlanV2;
  memoryBlock?: string;
}

export function createSlackTurnInput(input: {
  turnJobId: string;
  instanceId: string;
  runtimePlan: RuntimePlanV2 | AdmittedRuntimePlanData;
  memoryBlock?: string | undefined;
}): SlackTurnInputV1 {
  const record: SlackTurnInputV1 = {
    schemaVersion: SLACK_TURN_INPUT_SCHEMA_VERSION,
    turnJobId: input.turnJobId,
    instanceId: input.instanceId,
    runtimePlan: structuredClone(input.runtimePlan) as AdmittedRuntimePlanData,
    ...(input.memoryBlock ? { memoryBlock: input.memoryBlock } : {}),
  };
  parseSlackTurnInput(record);
  return record;
}

export function serializeSlackTurnInput(input: SlackTurnInputV1): string {
  const json = JSON.stringify(input);
  if (new TextEncoder().encode(json).byteLength > MAX_TURN_INPUT_BYTES) {
    throw new Error('Slack turn input is too large to stage.');
  }
  return json;
}

/** Strict: an input this release cannot read fails the turn rather than guessing. */
export function parseSlackTurnInput(value: unknown): SlackTurnInput {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Slack turn input must be an object.');
  }
  const record = parsed as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'turnJobId', 'instanceId', 'runtimePlan', 'memoryBlock']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`Slack turn input has an unknown field: ${key}.`);
  }
  if (record.schemaVersion !== SLACK_TURN_INPUT_SCHEMA_VERSION) {
    throw new Error('Slack turn input schemaVersion is unsupported.');
  }
  const turnJobId = validTurnJobId(record.turnJobId);
  if (typeof record.instanceId !== 'string' || !/^agent_[a-f0-9]{40}$/.test(record.instanceId)) {
    throw new Error('Slack turn input instanceId is invalid.');
  }
  const runtimePlan = parseRuntimePlanV2(record.runtimePlan);
  if (!runtimePlanInstanceIdMatches(record.runtimePlan as AdmittedRuntimePlanData, record.instanceId)) {
    throw new Error('Slack turn input plan belongs to another instance.');
  }
  let memoryBlock: string | undefined;
  if (record.memoryBlock !== undefined) {
    if (typeof record.memoryBlock !== 'string' || record.memoryBlock.length === 0 ||
        new TextEncoder().encode(record.memoryBlock).byteLength > MAX_MEMORY_BLOCK_BYTES) {
      throw new Error('Slack turn input memoryBlock is invalid.');
    }
    memoryBlock = record.memoryBlock;
  }
  return {
    turnJobId,
    instanceId: record.instanceId,
    runtimePlan,
    ...(memoryBlock ? { memoryBlock } : {}),
  };
}

export function validTurnJobId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TURN_JOB_ID_CHARS) {
    throw new Error('Slack turn input turnJobId is invalid.');
  }
  return value;
}

/** Minimal structural view of Durable Object (and test) SQLite storage. */
export interface TurnInputSql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

const TURN_INPUT_TABLE = 'chickpea_turn_inputs';

function ensureTurnInputTable(sql: TurnInputSql): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${TURN_INPUT_TABLE} (
      turn_job_id TEXT PRIMARY KEY,
      input_json TEXT NOT NULL,
      staged_at INTEGER NOT NULL
    )`,
  );
}

/**
 * Agent-object side of staging. The first write for a TurnJob wins: its plan
 * is frozen, and a retry must see what the first attempt dispatched against.
 */
export function writeStagedTurnInput(sql: TurnInputSql, json: string, now: number): void {
  const input = parseSlackTurnInput(json);
  ensureTurnInputTable(sql);
  sql.exec(
    `INSERT INTO ${TURN_INPUT_TABLE} (turn_job_id, input_json, staged_at) VALUES (?, ?, ?)
     ON CONFLICT(turn_job_id) DO NOTHING`,
    input.turnJobId, json, now,
  );
  sql.exec(
    `DELETE FROM ${TURN_INPUT_TABLE} WHERE turn_job_id NOT IN (
       SELECT turn_job_id FROM ${TURN_INPUT_TABLE} ORDER BY staged_at DESC, rowid DESC LIMIT ?
     )`,
    MAX_STAGED_TURN_INPUTS,
  );
}

export function readStagedTurnInputJson(sql: TurnInputSql, turnJobId: string): string | undefined {
  ensureTurnInputTable(sql);
  const row = sql.exec(
    `SELECT input_json FROM ${TURN_INPUT_TABLE} WHERE turn_job_id = ?`,
    turnJobId,
  ).toArray()[0];
  return typeof row?.input_json === 'string' ? row.input_json : undefined;
}

/**
 * The branded descriptor Flue's generated Cloudflare entry reads from the
 * agent module's `cloudflare` export. Built here without importing
 * `@flue/runtime/cloudflare`, whose graph needs `cloudflare:workers` and so
 * cannot load where this shared module also runs (Node). The brand is Flue's
 * global-registry symbol; a mismatch fails the Cloudflare build loudly.
 */
export const FLUE_CLOUDFLARE_EXTENSION_BRAND = Symbol.for('@flue/runtime/cloudflare-extension');

interface AgentObjectInstance {
  ctx: { storage: { sql: TurnInputSql } };
}

type AgentObjectClass = new (...args: never[]) => object;

export const slackThreadCloudflareExtension = {
  base: (Base: AgentObjectClass): AgentObjectClass =>
    class ChickpeaSlackThreadObject extends (Base as new (...args: never[]) => AgentObjectInstance) {
      /** Host RPC: stage one turn's input before its dispatch. */
      chickpeaStageTurnInput(json: string): void {
        if (typeof json !== 'string') throw new Error('Slack turn input must be serialized.');
        writeStagedTurnInput(this.ctx.storage.sql, json, Date.now());
      }
    },
  [FLUE_CLOUDFLARE_EXTENSION_BRAND]: true as const,
};

interface AgentObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): {
    setName?(name: string): Promise<void>;
    chickpeaStageTurnInput(json: string): Promise<void>;
  };
}

/**
 * Host side on Cloudflare: address the thread's agent object the way Flue's
 * dispatch does (by instance name) and stage the input there.
 */
export async function stageSlackTurnInputOnAgentObject(
  env: Record<string, unknown> | undefined,
  bindingName: string,
  input: SlackTurnInputV1,
): Promise<void> {
  const binding = env?.[bindingName] as AgentObjectNamespace | undefined;
  if (!binding || typeof binding.idFromName !== 'function' || typeof binding.get !== 'function') {
    throw new Error(`Agent object binding ${bindingName} is unavailable.`);
  }
  const json = serializeSlackTurnInput(input);
  const stub = binding.get(binding.idFromName(input.instanceId));
  // Flue's own addressing (getAgentByName) names the object first; a staging
  // call can be the object's first contact on a thread's first turn.
  await stub.setName?.(input.instanceId);
  await stub.chickpeaStageTurnInput(json);
}

type CloudflareContextReader = () => { storage: { sql: TurnInputSql } };
let cloudflareContext: CloudflareContextReader | undefined;
if (isCloudflareTarget()) {
  // Loaded once at module evaluation so a render can read synchronously. The
  // Worker bundle already contains the module, so this settles long before a
  // render; one that somehow does not fails its turn, which retries.
  void import('@flue/runtime/cloudflare')
    .then((module) => { cloudflareContext = module.getCloudflareContext as unknown as CloudflareContextReader; })
    .catch(() => undefined);
}

/** Node: the agent renders in the host process, so staging also lands here. */
const inProcessTurnInputs = new Map<string, string>();

export function rememberInProcessTurnInput(input: SlackTurnInputV1): void {
  inProcessTurnInputs.delete(input.turnJobId);
  inProcessTurnInputs.set(input.turnJobId, serializeSlackTurnInput(input));
  while (inProcessTurnInputs.size > 256) {
    const oldest = inProcessTurnInputs.keys().next().value;
    if (oldest === undefined) break;
    inProcessTurnInputs.delete(oldest);
  }
}

/**
 * The staged input for this turn, or undefined when none was staged. On Node
 * a process restart loses the in-process copy; `durableRead` reads the host's
 * state DB for that case.
 */
export function readStagedSlackTurnInput(
  turnJobId: string,
  durableRead?: (turnJobId: string) => string | undefined,
): SlackTurnInput | undefined {
  let json: string | undefined;
  if (isCloudflareTarget()) {
    if (!cloudflareContext) throw new Error('Cloudflare context is not loaded yet.');
    json = readStagedTurnInputJson(cloudflareContext().storage.sql, turnJobId);
  } else {
    json = inProcessTurnInputs.get(turnJobId) ?? durableRead?.(turnJobId);
  }
  if (json === undefined) return undefined;
  const input = parseSlackTurnInput(json);
  if (input.turnJobId !== turnJobId) throw new Error('Staged Slack turn input belongs to another turn.');
  return input;
}

/**
 * Which plan and memory the render uses. A staged input for the turn always
 * wins. Without one, an instance created by a release that addressed
 * instances by exact plan runs its creation data, which is that plan; a
 * thread instance (the current derivation) must never fall back to its
 * creation plan, which may name another speaker's authority or an older
 * configuration. A render with no Slack turn behind it (a bare harness) uses
 * the creation data.
 */
export function resolveSlackTurnRenderInput(input: {
  instanceId: string;
  initialData: RuntimePlanV2;
  turnJobId: string | undefined;
  /** `durable`: also consult a store outside this process (Node restart). */
  read: (turnJobId: string, durable: boolean) => SlackTurnInput | undefined;
}): { runtimePlan: RuntimePlanV2; memoryBlock?: string } {
  if (input.turnJobId === undefined) return { runtimePlan: input.initialData };
  const threadInstance = deriveRuntimePlanInstanceId(input.initialData) === input.instanceId;
  const staged = input.read(input.turnJobId, threadInstance);
  if (staged) {
    if (staged.instanceId !== input.instanceId) {
      throw new Error('Staged Slack turn input belongs to another instance.');
    }
    return {
      runtimePlan: staged.runtimePlan,
      ...(staged.memoryBlock ? { memoryBlock: staged.memoryBlock } : {}),
    };
  }
  if (threadInstance) {
    throw new Error('This Slack turn has no staged input for its thread instance.');
  }
  return { runtimePlan: input.initialData };
}
