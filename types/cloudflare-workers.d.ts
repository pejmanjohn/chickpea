/**
 * Minimal ambient declaration for 'cloudflare:workers', scoped to exactly the
 * surface src/cloudflare.ts uses. The alternative — @cloudflare/workers-types —
 * injects a full global DOM-overlapping type universe into the NODE tsc run
 * (this repo typechecks both lanes in one pass), so we declare the handful of
 * shapes we touch instead. The real module exists only on the Cloudflare
 * target; the node build never imports src/cloudflare.ts at runtime.
 *
 * Shapes follow the Workers runtime API (verified against the DO-store spike
 * and the SELECT changes()/rowsWritten probe, 2026-07-06).
 */
declare module 'cloudflare:workers' {
  /**
   * Ambient bindings available to this Worker. Kept local to this declaration
   * because the Node and Cloudflare lanes share one TypeScript project.
   */
  interface WorkerEnv {
    AI: import('@flue/runtime/cloudflare').CloudflareAIBinding;
  }

  const env: WorkerEnv;

  /** One row from `SqlStorage.exec` — column name to SQLite value. */
  type SqlRow = Record<string, string | number | ArrayBuffer | null>;

  interface SqlStorageCursor {
    toArray(): SqlRow[];
    /** Exactly one row or it throws — use only for queries that guarantee it. */
    one(): SqlRow;
    /**
     * Rows written so far by this statement. NOT SQLite `changes()`: it counts
     * index writes too (a single INSERT into a table with a PRIMARY KEY
     * reports 2) — measured, which is why the StateDb adapter derives
     * `changes` from `SELECT changes()` instead.
     */
    rowsWritten: number;
    rowsRead: number;
  }

  interface SqlStorage {
    /** Synchronous inside a DO; bindings use `?` placeholders. */
    exec(query: string, ...bindings: unknown[]): SqlStorageCursor;
  }

  interface DurableObjectStorage {
    sql: SqlStorage;
    /** Synchronous transaction; rolls back when `fn` throws. */
    transactionSync<T>(fn: () => T): T;
    /**
     * Arm the object's single alarm for `scheduledTime` (epoch ms). Awaiting it
     * makes the alarm durable before the caller returns — the turn-relay ack
     * depends on that (the enqueued job survives even if the acking invocation
     * dies the instant after). Only one alarm exists at a time; a later call
     * overwrites the pending time.
     */
    setAlarm(scheduledTime: number): Promise<void>;
    /** The currently-armed alarm time (epoch ms), or null if none. */
    getAlarm(): Promise<number | null>;
    /** Cancel the pending alarm, if any. */
    deleteAlarm(): Promise<void>;
  }

  interface DurableObjectState {
    storage: DurableObjectStorage;
    id: { toString(): string };
  }

  /** Metadata the platform passes to `alarm()` about the current invocation. */
  interface DurableObjectAlarmInfo {
    /** True when this alarm firing is a platform retry of a prior throw. */
    isRetry: boolean;
    /** Zero on the first firing; increments on each at-least-once retry. */
    retryCount: number;
  }

  abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
    /** Optional alarm handler; the platform invokes it when the alarm fires. */
    alarm?(alarmInfo?: DurableObjectAlarmInfo): void | Promise<void>;
  }
}
