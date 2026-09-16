import { randomUUID } from 'node:crypto';

import { isCloudflareTarget } from '../config/runtime-target.ts';
import { openStateDb, resolveStateDbPath } from '../state/node-state-db.ts';
import { runNodeScheduledDuties } from './node-duties.ts';
import { setNodeRoutineSchedulerAvailable } from './runtime-state.ts';

const HEARTBEAT_INTERVAL_MS = 60_000;
const OWNERSHIP_TABLE = 'chickpea_node_runtime_owner';
const OWNERSHIP_ERROR =
  'Another Chickpea Node process is already using the configured state database.';

export interface NodeStateOwnership {
  release(): void;
}

export function acquireNodeStateOwnership(input: {
  statePath?: string;
  pid?: number;
  processAlive?: (pid: number) => boolean;
  token?: string;
} = {}): NodeStateOwnership {
  if (isCloudflareTarget()) throw new Error('Node state ownership is unavailable on Cloudflare.');
  const statePath = input.statePath ?? resolveStateDbPath();
  if (statePath === ':memory:') return { release() {} };
  const pid = input.pid ?? process.pid;
  const token = input.token ?? randomUUID();
  const processAlive = input.processAlive ?? isProcessAlive;
  const db = openStateDb(statePath);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS ${OWNERSHIP_TABLE} (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      owner_token TEXT NOT NULL,
      owner_pid INTEGER NOT NULL,
      acquired_at INTEGER NOT NULL
    )`);
    db.transaction(() => {
      const current = db.get(
        `SELECT owner_token, owner_pid FROM ${OWNERSHIP_TABLE} WHERE singleton = 1`,
      );
      if (current) {
        const ownerPid = Number(current.owner_pid);
        if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || processAlive(ownerPid)) {
          throw new Error(OWNERSHIP_ERROR);
        }
      }
      db.run(`DELETE FROM ${OWNERSHIP_TABLE} WHERE singleton = 1`);
      db.run(
        `INSERT INTO ${OWNERSHIP_TABLE}
          (singleton, owner_token, owner_pid, acquired_at) VALUES (1, ?, ?, ?)`,
        token,
        pid,
        Date.now(),
      );
    });
  } catch (error) {
    db.close();
    throw error;
  }
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      try {
        db.transaction(() => {
          db.run(
            `DELETE FROM ${OWNERSHIP_TABLE} WHERE singleton = 1 AND owner_token = ?`,
            token,
          );
        });
      } finally {
        db.close();
      }
    },
  };
}

interface NodeRoutineSchedulerOptions {
  runHeartbeat?: (at: number, owner: string) => Promise<void>;
  now?: () => number;
  pid?: number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  onError?: (detail: string) => void;
}

export class NodeRoutineScheduler {
  readonly #runHeartbeat: (at: number, owner: string) => Promise<void>;
  readonly #now: () => number;
  readonly #pid: number;
  readonly #setInterval: typeof globalThis.setInterval;
  readonly #clearInterval: typeof globalThis.clearInterval;
  readonly #onError: (detail: string) => void;
  #active = false;
  #queued = false;
  #sequence = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;

  constructor(options: NodeRoutineSchedulerOptions = {}) {
    this.#runHeartbeat = options.runHeartbeat ?? ((at, owner) =>
      runNodeScheduledDuties({ scheduledTime: at, owner }));
    this.#now = options.now ?? Date.now;
    this.#pid = options.pid ?? process.pid;
    this.#setInterval = options.setInterval ?? globalThis.setInterval;
    this.#clearInterval = options.clearInterval ?? globalThis.clearInterval;
    this.#onError = options.onError ?? ((detail) => {
      console.warn(`[chickpea] ${detail}`);
    });
  }

  async start(): Promise<void> {
    if (this.#active) return;
    this.#active = true;
    this.#timer = this.#setInterval(() => this.#wake(), HEARTBEAT_INTERVAL_MS);
    this.#timer.unref?.();
    this.#wake();
  }

  async stop(): Promise<void> {
    if (!this.#active && !this.#running) return;
    this.#active = false;
    this.#queued = false;
    if (this.#timer) this.#clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  #wake(): void {
    if (!this.#active) return;
    if (this.#running) {
      this.#queued = true;
      return;
    }
    this.#running = this.#drain().finally(() => {
      this.#running = undefined;
      // A timer can fire after the drain reads queued=false but before this
      // completion callback clears the in-flight promise. Preserve that edge.
      if (this.#active && this.#queued) this.#wake();
    });
  }

  async #drain(): Promise<void> {
    do {
      this.#queued = false;
      const at = this.#now();
      const owner = `node:${this.#pid}:${at}:${++this.#sequence}`;
      try {
        await this.#runHeartbeat(at, owner);
      } catch (error) {
        this.#onError(boundedScheduledError(error));
      }
    } while (this.#active && this.#queued);
  }
}

interface SchedulerLifecycleTarget {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class NodeRoutineSchedulerLifecycle {
  readonly #create: () => SchedulerLifecycleTarget;
  readonly #setAvailable: (available: boolean) => void;
  #active: SchedulerLifecycleTarget | undefined;
  #transition: Promise<void> = Promise.resolve();

  constructor(input: {
    create?: () => SchedulerLifecycleTarget;
    setAvailable?: (available: boolean) => void;
  } = {}) {
    this.#create = input.create ?? (() => new NodeRoutineScheduler());
    this.#setAvailable = input.setAvailable ?? setNodeRoutineSchedulerAvailable;
  }

  start(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#active) return;
      const scheduler = this.#create();
      this.#active = scheduler;
      // Startup wake can immediately retry a saved schedule action. Publish
      // readiness before that wake constructs its management service.
      this.#setAvailable(true);
      try {
        await scheduler.start();
      } catch (error) {
        this.#active = undefined;
        this.#setAvailable(false);
        await scheduler.stop().catch(() => undefined);
        throw error;
      }
    });
  }

  stop(): Promise<void> {
    return this.#enqueue(async () => {
      const scheduler = this.#active;
      this.#active = undefined;
      try {
        // A retry already in flight can construct its management service after
        // an await. Keep scheduling available until it finishes so shutdown
        // cannot turn that pending action into an unsupported-target failure.
        await scheduler?.stop();
      } finally {
        this.#setAvailable(false);
      }
    });
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#transition.then(operation, operation);
    this.#transition = result.then(() => undefined, () => undefined);
    return result;
  }
}

const productionSchedulerLifecycle = new NodeRoutineSchedulerLifecycle();

export function startNodeRoutineScheduler(): Promise<void> {
  if (isCloudflareTarget()) return Promise.resolve();
  return productionSchedulerLifecycle.start();
}

export function stopNodeRoutineScheduler(): Promise<void> {
  if (isCloudflareTarget()) return Promise.resolve();
  return productionSchedulerLifecycle.stop();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH');
  }
}

function boundedScheduledError(error: unknown): string {
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name)
    ? error.name
    : 'Error';
  return `Node scheduled duties failed (${name}).`;
}
