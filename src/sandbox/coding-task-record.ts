import * as v from 'valibot';

import type { SandboxPolicyStorage } from './cloudflare-policy.ts';

/**
 * Durable active-task records (KTD4): one per coding job a response delegates
 * with `workspace_task`, kept on the run's Sandbox Durable Object (the
 * thread's, or a guest's own) under the host turn. A stop aborts and confirms every coding worker named here: once
 * the coordinator is aborted, Flue discards the tool's own result, so a
 * confirmation from inside the tool can never reach the stop note.
 *
 * Every workspace of a run is its own Sandbox Durable Object, so the
 * records live on the run's default one (which also keeps the workspace
 * roster), and a stop finds every job whichever workspace it runs in.
 */

/**
 * The dispatch idempotency key of one `workspace_task` call. Flue derives the
 * worker submission id from it, so it names the job before the worker has
 * accepted it; each record is keyed by it.
 */
export function workspaceTaskDispatchKey(toolCallId: string): string {
  return `workspace_task:${toolCallId}`;
}

const Id = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const Epoch = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER));

const RECORD_FIELDS = {
  schemaVersion: v.literal(1),
  /** {@link workspaceTaskDispatchKey}: one record per worker submission. */
  taskKey: v.pipe(v.string(), v.minLength(1), v.maxLength(240)),
  toolCallId: Id,
  /** The workspace name the job runs in. */
  workspace: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  /** That workspace's Sandbox Durable Object id, where egress records its pull request. */
  workspaceId: Id,
  /** The coding worker's Flue instance id; a stop aborts it. */
  instanceId: Id,
  /** When the dispatch was about to be sent (epoch ms). */
  pendingAt: Epoch,
  /** The job's own deadline, counted from `acceptedAt`. */
  timeoutMs: Epoch,
};

export const CodingTaskRecordSchema = v.variant('state', [
  /** Written before the dispatch: the worker may or may not have the job. */
  v.object({ ...RECORD_FIELDS, state: v.literal('dispatch_pending') }),
  /** The worker accepted the job: its dispatch receipt. */
  v.object({
    ...RECORD_FIELDS,
    state: v.literal('accepted'),
    submissionId: Id,
    uid: Id,
    /** Flue's ISO acceptance time; a later wait takes its remaining time from here. */
    acceptedAt: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  }),
]);

export type CodingTaskRecordV1 = v.InferOutput<typeof CodingTaskRecordSchema>;

export function parseCodingTaskRecord(value: unknown): CodingTaskRecordV1 | undefined {
  const parsed = v.safeParse(CodingTaskRecordSchema, value);
  return parsed.success ? parsed.output : undefined;
}

/** The Sandbox Durable Object methods the records travel through. */
export interface SandboxCodingTaskStub {
  readCodingTasks(turnId: string): Promise<CodingTaskRecordV1[]>;
  putCodingTask(turnId: string, record: CodingTaskRecordV1): Promise<void>;
  settleCodingTask(turnId: string, taskKey: string): Promise<void>;
}

const CODING_TASKS_STORAGE_KEY = 'chickpea.sandbox.coding-tasks.v1';
/**
 * Host turns whose records are kept at once. A settled job drops its record,
 * so only a turn whose job never settled (a coordinator that died, a stop
 * that could not confirm) leaves one; the oldest go first.
 */
const MAX_CODING_TASK_TURNS = 8;
/** More than one response can start; a bound, not a limit. */
const MAX_CODING_TASKS_PER_TURN = 8;

// Each write below reads and writes the one storage key with no other I/O
// in between, so the Sandbox Durable Object's input gate keeps two jobs of
// one response from losing each other's record.

interface StoredCodingTaskTurn {
  turnId: string;
  updatedAt: number;
  tasks: CodingTaskRecordV1[];
}

interface StoredCodingTasks {
  schemaVersion: 1;
  turns: StoredCodingTaskTurn[];
}

/** A host turn's records. */
export async function readStoredCodingTasks(
  storage: SandboxPolicyStorage,
  turnId: unknown,
): Promise<CodingTaskRecordV1[]> {
  const id = requireTurnId(turnId);
  const stored = parseStoredCodingTasks(await storage.get(CODING_TASKS_STORAGE_KEY));
  return stored.turns.find((turn) => turn.turnId === id)?.tasks ?? [];
}

/** Write or replace one job's record under its host turn. */
export async function putStoredCodingTask(
  storage: SandboxPolicyStorage,
  turnId: unknown,
  record: unknown,
  now: number,
): Promise<void> {
  const id = requireTurnId(turnId);
  const parsed = parseCodingTaskRecord(record);
  if (!parsed) throw new TypeError('Coding task record is invalid.');
  const stored = parseStoredCodingTasks(await storage.get(CODING_TASKS_STORAGE_KEY));
  const current = stored.turns.find((turn) => turn.turnId === id);
  const tasks = [...(current?.tasks ?? []).filter((task) => task.taskKey !== parsed.taskKey), parsed]
    .slice(-MAX_CODING_TASKS_PER_TURN);
  const turns = [
    { turnId: id, updatedAt: now, tasks },
    ...stored.turns.filter((turn) => turn.turnId !== id),
  ]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_CODING_TASK_TURNS);
  await storage.put<StoredCodingTasks>(CODING_TASKS_STORAGE_KEY, { schemaVersion: 1, turns });
}

/** Drop a job's record once its submission settled or a stop reconciled it. */
export async function settleStoredCodingTask(
  storage: SandboxPolicyStorage,
  turnId: unknown,
  taskKey: unknown,
  now: number,
): Promise<void> {
  const id = requireTurnId(turnId);
  if (typeof taskKey !== 'string') throw new TypeError('Coding task key is invalid.');
  const stored = parseStoredCodingTasks(await storage.get(CODING_TASKS_STORAGE_KEY));
  const current = stored.turns.find((turn) => turn.turnId === id);
  if (!current?.tasks.some((task) => task.taskKey === taskKey)) return;
  const tasks = current.tasks.filter((task) => task.taskKey !== taskKey);
  const turns = stored.turns.flatMap((turn) => {
    if (turn.turnId !== id) return [turn];
    return tasks.length > 0 ? [{ turnId: id, updatedAt: now, tasks }] : [];
  });
  await storage.put<StoredCodingTasks>(CODING_TASKS_STORAGE_KEY, { schemaVersion: 1, turns });
}

function requireTurnId(turnId: unknown): string {
  if (typeof turnId !== 'string' || turnId.length < 1 || turnId.length > 200) {
    throw new TypeError('Coding task turn id is invalid.');
  }
  return turnId;
}

/** Persisted state is data from an earlier release: keep only well-formed entries. */
function parseStoredCodingTasks(value: unknown): StoredCodingTasks {
  const record = value as Partial<StoredCodingTasks> | undefined;
  if (!record || typeof record !== 'object' || record.schemaVersion !== 1 || !Array.isArray(record.turns)) {
    return { schemaVersion: 1, turns: [] };
  }
  const turns: StoredCodingTaskTurn[] = [];
  for (const turn of record.turns as unknown[]) {
    const entry = turn as Partial<StoredCodingTaskTurn> | undefined;
    if (
      !entry || typeof entry.turnId !== 'string' || entry.turnId.length < 1 || entry.turnId.length > 200 ||
      !Number.isFinite(entry.updatedAt) || !Array.isArray(entry.tasks)
    ) {
      continue;
    }
    const tasks = (entry.tasks as unknown[]).flatMap((task) => {
      const parsed = parseCodingTaskRecord(task);
      return parsed ? [parsed] : [];
    });
    if (tasks.length > 0) turns.push({ turnId: entry.turnId, updatedAt: entry.updatedAt as number, tasks });
  }
  return { schemaVersion: 1, turns };
}
