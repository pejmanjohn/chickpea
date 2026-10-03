import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type { DurableObjectStorage } from 'cloudflare:workers';

import { CHICKPEA_CODING_WORKER_AGENT_NAME, CHICKPEA_ROUTINE_EXECUTION_AGENT_NAME } from '../../src/agents/names.ts';
import {
  objectInstallationEnv,
  scopeInstallationEnv,
  splitInstallationObjectName,
} from '../../src/config/installation-scope.ts';
import type { PlatformEnv } from '../../src/config/state-backend.ts';
import type { RoutinePersistenceTelemetrySink } from '../../src/routines/telemetry.ts';
import type { SandboxPolicyStorage } from '../../src/sandbox/cloudflare-policy.ts';
import { sandboxHostFunctions } from '../../src/sandbox/sandbox-host.ts';
import { sandboxObjectEnv } from '../../src/sandbox/sandbox-object.ts';
import { SandboxWorkspaceState } from '../../src/sandbox/workspace-lifecycle.ts';
import { agentObjectBindingName, CHICKPEA_SLACK_AGENT_BINDING } from '../../src/slack/bounded-agent-observation.ts';
import { ThreadRunnerJobStore } from '../../src/slack/thread-runner-jobs.ts';
import { DoSqlStateDb } from '../../src/state/do-state-db.ts';
import { objectHostFunctions } from '../../src/state/object-host.ts';
import type { AgentStopTarget } from '../../src/state/pending-work.ts';
import { stateStoreHostFunctions } from '../../src/state/state-store-host.ts';
import { buildTagStateStores, type TagStateStores } from '../../src/state/tag-state-stores.ts';

/**
 * A Durable Object's storage over Node SQLite, as the object classes and the
 * host functions see it: synchronous SQL with nesting transactions
 * (savepoints, as `transactionSync` nests), key-value entries, one alarm and
 * `deleteAll`. Real workerd storage is covered by
 * hosted-object-storage-workerd.test.ts.
 */
export class FakeObjectStorage {
  readonly database = new DatabaseSync(':memory:');
  readonly kv = new Map<string, unknown>();
  alarm: number | null = null;
  deleteAllCalls = 0;
  private depth = 0;

  constructor() {
    this.database.exec('PRAGMA foreign_keys = ON;');
  }

  readonly sql = {
    exec: (query: string, ...bindings: unknown[]) => {
      const statement = this.database.prepare(query);
      const values = bindings as SQLInputValue[];
      const rows = statement.columns().length > 0
        ? statement.all(...values).map((row) => ({ ...row }) as Record<string, unknown>)
        : (statement.run(...values), []);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
          return rows[0]!;
        },
        rowsRead: 0,
        rowsWritten: 0,
      };
    },
  };

  transactionSync<T>(fn: () => T): T {
    const savepoint = `chickpea_tx_${this.depth}`;
    this.database.exec(`SAVEPOINT ${savepoint}`);
    this.depth += 1;
    try {
      const result = fn();
      this.depth -= 1;
      this.database.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.depth -= 1;
      this.database.exec(`ROLLBACK TO ${savepoint}`);
      this.database.exec(`RELEASE ${savepoint}`);
      throw error;
    }
  }

  async get(key: string): Promise<unknown> {
    return this.kv.get(key);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.kv.set(key, structuredClone(value));
  }

  async list(options: { startAfter?: string; limit?: number } = {}): Promise<Map<string, unknown>> {
    const keys = [...this.kv.keys()].sort()
      .filter((key) => options.startAfter === undefined || key > options.startAfter)
      .slice(0, options.limit ?? Number.POSITIVE_INFINITY);
    return new Map(keys.map((key) => [key, structuredClone(this.kv.get(key))]));
  }

  async setAlarm(at: number): Promise<void> {
    this.alarm = at;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  /** As on SQLite-backed objects at compatibility date 2026-02-24 or later: tables, entries and the alarm. */
  async deleteAll(): Promise<void> {
    this.deleteAllCalls += 1;
    this.database.exec('PRAGMA foreign_keys = OFF;');
    for (const row of this.database.prepare(
      "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'view')",
    ).all() as Array<{ type: string; name: string }>) {
      this.database.exec(`DROP ${row.type === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS "${row.name}"`);
    }
    this.database.exec('PRAGMA foreign_keys = ON;');
    this.kv.clear();
    this.alarm = null;
  }

  /** The object's own SQL tables, by name. */
  tables(): string[] {
    return (this.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name);
  }

  asDurableObjectStorage(): DurableObjectStorage {
    return this as unknown as DurableObjectStorage;
  }
}

export interface HostedInstallation {
  readonly installationId: string;
  readonly organizationId: string;
  readonly env: PlatformEnv;
  readonly storage: FakeObjectStorage;
  readonly db: DoSqlStateDb;
  readonly stores: TagStateStores;
}

/**
 * One installation of a deployment serving many: its scoped env (with any
 * `bindings`) and its state store's stores, built exactly as `TagStateStore`
 * builds them, over a fake object storage, provisioned with its IDs.
 */
export function hostedInstallation(
  installationId: string,
  bindings: Record<string, unknown> = {},
): HostedInstallation {
  const env = scopeInstallationEnv(
    { CHICKPEA_TENANCY: 'installation', ...bindings } as PlatformEnv,
    { installationId },
  );
  const storage = new FakeObjectStorage();
  const db = new DoSqlStateDb(storage.asDurableObjectStorage());
  const stores = buildTagStateStores(db, env, { gatewayLeaseOwner: `test-${installationId}` });
  const organizationId = `org_${installationId}`;
  stores.installationBinding.bind({ organizationId, installationId });
  return { installationId, organizationId, env, storage, db, stores };
}

interface DeploymentObject {
  readonly binding: string;
  readonly name: string;
  readonly storage: FakeObjectStorage;
  readonly env: PlatformEnv;
  readonly host: Record<string, (request: never) => Promise<unknown>>;
  /** A Sandbox's container: whether it runs, and how often it was destroyed. */
  readonly container?: { running: boolean; destroyed: number };
}

/** The coding worker's Flue binding, as the host functions address it. */
export const CODING_WORKER_BINDING = agentObjectBindingName(CHICKPEA_CODING_WORKER_AGENT_NAME);

/** A Sandbox's workspace record over its fake storage, as the Sandbox class reads it. */
export function sandboxWorkspaceState(storage: FakeObjectStorage): SandboxWorkspaceState {
  return new SandboxWorkspaceState(storage as unknown as SandboxPolicyStorage);
}

/**
 * A deployment serving many installations with every object namespace the
 * host functions address: each object (state store, thread runner, Flue
 * instance) gets the env its own name scopes and answers through the same
 * host functions its class delegates to. Objects are created on first
 * address, as Durable Objects are.
 */
export function hostedDeployment(installationIds: readonly string[], options: {
  stopAgents?: (agents: readonly AgentStopTarget[]) => Promise<{ stopped: number; notStopped: number }>;
  persistenceTelemetrySink?: RoutinePersistenceTelemetrySink;
  /** The deployment's `BACKUP_BUCKET`, shared by every installation. */
  bucket?: object;
} = {}) {
  const objects = new Map<string, DeploymentObject>();
  const installations = new Map<string, HostedInstallation>();
  const platform: Record<string, unknown> = {
    CHICKPEA_TENANCY: 'installation',
    ...(options.bucket ? { BACKUP_BUCKET: options.bucket } : {}),
  };
  const objectFor = (binding: string, name: string): DeploymentObject => {
    const key = `${binding}\n${name}`;
    let object = objects.get(key);
    if (object) return object;
    const env = objectInstallationEnv({ id: { name } }, platform as PlatformEnv);
    const scope = splitInstallationObjectName(name).scope;
    if (binding === 'TAG_STATE') {
      const installation = scope ? installations.get(scope.installationId) : undefined;
      if (!installation) throw new Error(`No installation serves ${name}.`);
      let stores: TagStateStores | undefined = installation.stores;
      object = {
        binding, name, storage: installation.storage, env,
        host: stateStoreHostFunctions({
          env, storage: installation.storage,
          stores: () => stores ??= buildTagStateStores(
            new DoSqlStateDb(installation.storage.asDurableObjectStorage()), env, { gatewayLeaseOwner: 'test' },
          ),
          onErased: () => { stores = undefined; },
          ...(options.stopAgents ? { stopAgents: options.stopAgents } : {}),
          ...(options.persistenceTelemetrySink ? { persistenceTelemetrySink: options.persistenceTelemetrySink } : {}),
        }) as unknown as DeploymentObject['host'],
      };
    } else if (binding === 'SANDBOX') {
      // As the Sandbox class: its env from its own name, its checkpoint bucket the installation's view.
      const storage = new FakeObjectStorage();
      const sandboxEnv = sandboxObjectEnv({
        id: { name },
        storage: { kv: { get: (key: string) => storage.kv.get(key), put: (key: string, value: unknown) => { storage.kv.set(key, value); } } },
      }, platform as PlatformEnv);
      const container = { running: false, destroyed: 0 };
      object = {
        binding, name, storage, env: sandboxEnv, container,
        host: sandboxHostFunctions({
          env: sandboxEnv,
          storage,
          running: () => container.running,
          destroy: async () => { container.running = false; container.destroyed += 1; },
          currentCheckpoint: () => sandboxWorkspaceState(storage).currentCheckpoint(),
        }) as unknown as DeploymentObject['host'],
      };
    } else {
      const storage = new FakeObjectStorage();
      object = {
        binding, name, storage, env,
        host: objectHostFunctions({
          env, storage,
          ...(binding === 'SLACK_THREAD_RUNNER'
            ? {
                cancel: (now: number) => {
                  const { settled, running } = runnerJobs(storage).cancelOpen(now);
                  return { runnerJobs: settled, runnerJobsRunning: running };
                },
              }
            : {}),
        }) as unknown as DeploymentObject['host'],
      };
    }
    objects.set(key, object);
    return object;
  };
  const named = (binding: string) => ({ getByName: (name: string) => objectFor(binding, name).host });
  const byId = (binding: string) => ({
    idFromName: (name: string) => name,
    get: (id: string) => objectFor(binding, id).host,
  });
  Object.assign(platform, {
    TAG_STATE: named('TAG_STATE'),
    SLACK_THREAD_RUNNER: named('SLACK_THREAD_RUNNER'),
    [CHICKPEA_SLACK_AGENT_BINDING]: byId(CHICKPEA_SLACK_AGENT_BINDING),
    [agentObjectBindingName(CHICKPEA_ROUTINE_EXECUTION_AGENT_NAME)]:
      byId(agentObjectBindingName(CHICKPEA_ROUTINE_EXECUTION_AGENT_NAME)),
    [CODING_WORKER_BINDING]: byId(CODING_WORKER_BINDING),
    SANDBOX: byId('SANDBOX'),
  });
  for (const installationId of installationIds) {
    installations.set(installationId, hostedInstallation(installationId, platform));
  }
  return {
    platform: platform as PlatformEnv,
    installation: (installationId: string) => installations.get(installationId)!,
    /** The object a host would reach, creating it as the platform would. */
    object: (binding: string, name: string) => objectFor(binding, name),
    objects: () => [...objects.values()],
  };
}

/** A thread runner's job store over its storage. */
export function runnerJobs(storage: FakeObjectStorage): ThreadRunnerJobStore {
  return new ThreadRunnerJobStore(new DoSqlStateDb(storage.asDurableObjectStorage()));
}
