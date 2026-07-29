import {
  CfAgentSnapshotStore,
  CfConfigStore,
  CfMemoryStateStore,
  CfRoutineStore,
  CfSettingsStore,
  CfSlackStateStore,
  CfUsageStore,
} from './cf-state-proxies.ts';
import { isCloudflareTarget } from './runtime-target.ts';
import { SqliteSettingsStore, type SettingsStore } from './settings-store.ts';
import { SqliteAgentSnapshotStore, type AgentSnapshotStore } from './snapshot-store.ts';
import { tagStateStub } from './state-rpc.ts';
import { SqliteConfigStore, type ConfigStore } from './store.ts';
import { SqliteSlackStateStore, type SlackStateStore } from '../slack/claim-store.ts';
import { resolveStateDbPath } from '../state/node-state-db.ts';
import { SqliteMemoryStateStore } from '../memory/store.ts';
import type { MemoryStateStore } from '../memory/types.ts';
import { SqliteRoutineStore } from '../routines/store.ts';
import type { RoutineStore } from '../routines/types.ts';
import { SqliteUsageStore } from '../usage/store.ts';
import type { UsageStore } from '../usage/types.ts';

export { isCloudflareTarget } from './runtime-target.ts';

/**
 * Backend selection for the app's state stores.
 *
 * Consumers call the factories here instead of constructing stores, so the
 * choice of backend lives in ONE module: on Node every factory returns a
 * process-cached SQLite-backed store (same file-backed DB path resolution as
 * always); on the Cloudflare target the factories return Durable Object RPC
 * proxies instead, which require the platform `env` (the worker's bindings —
 * route handlers pass `c.env`, the agent passes its Cloudflare context env).
 * Node ignores the argument, so call sites thread it through unconditionally.
 */

/**
 * Opaque platform environment (the Cloudflare worker `env` bindings object).
 * Meaningless on Node — accepted and ignored so call sites are target-neutral.
 */
export type PlatformEnv = Record<string, unknown>;

/** The full store set a request handler consumes, resolved for one target. */
export interface AppStores {
  config: ConfigStore;
  snapshots: AgentSnapshotStore;
  slackState: SlackStateStore;
  settings: SettingsStore;
  memory: MemoryStateStore;
  routines: RoutineStore;
  usage: UsageStore;
}

// Node singletons, cached by resolved DB path exactly like the pre-refactor
// getConfigStore: reuse while the path is stable, close-and-reopen when env
// changes it (tests move SLACK_STATE_DB_PATH/TAG_DB_PATH between cases).
interface CachedStore<T extends { close?(): void }> {
  path: string;
  store: T;
}

let cachedConfigStore: CachedStore<SqliteConfigStore> | undefined;
let cachedSnapshotStore: CachedStore<SqliteAgentSnapshotStore> | undefined;
let cachedSlackStateStore: CachedStore<SqliteSlackStateStore> | undefined;
let cachedSettingsStore: CachedStore<SqliteSettingsStore> | undefined;
let cachedMemoryStore: CachedStore<SqliteMemoryStateStore> | undefined;
let cachedRoutineStore: CachedStore<SqliteRoutineStore> | undefined;
let cachedUsageStore: CachedStore<SqliteUsageStore> | undefined;

function nodeCached<T extends { close(): void }>(
  cached: CachedStore<T> | undefined,
  create: (path: string) => T,
): CachedStore<T> {
  const path = resolveStateDbPath();
  if (cached?.path === path) {
    return cached;
  }
  cached?.store.close();
  return { path, store: create(path) };
}

// On Cloudflare the factories return fresh Durable Object RPC proxies instead
// of process singletons: the stub is per-env (bindings are request-scoped on
// the worker side) and cheap to mint, while the DO behind it is the real
// singleton — `tagStateStub` (state-rpc.ts) resolves the one named instance
// and throws a wiring-bug error when `env`/TAG_STATE is missing.

export function getConfigStore(env?: PlatformEnv): ConfigStore {
  if (isCloudflareTarget()) {
    return new CfConfigStore(tagStateStub(env));
  }
  cachedConfigStore = nodeCached(cachedConfigStore, (path) => new SqliteConfigStore(path));
  return cachedConfigStore.store;
}

export function getAgentSnapshotStore(env?: PlatformEnv): AgentSnapshotStore {
  if (isCloudflareTarget()) {
    return new CfAgentSnapshotStore(tagStateStub(env));
  }
  cachedSnapshotStore = nodeCached(
    cachedSnapshotStore,
    (path) => new SqliteAgentSnapshotStore(path),
  );
  return cachedSnapshotStore.store;
}

export function getSlackStateStore(env?: PlatformEnv): SlackStateStore {
  if (isCloudflareTarget()) {
    return new CfSlackStateStore(tagStateStub(env));
  }
  cachedSlackStateStore = nodeCached(
    cachedSlackStateStore,
    (path) => new SqliteSlackStateStore(path),
  );
  return cachedSlackStateStore.store;
}

export function getSettingsStore(env?: PlatformEnv): SettingsStore {
  if (isCloudflareTarget()) {
    return new CfSettingsStore(tagStateStub(env));
  }
  cachedSettingsStore = nodeCached(cachedSettingsStore, (path) => new SqliteSettingsStore(path));
  return cachedSettingsStore.store;
}

export function getMemoryStateStore(env?: PlatformEnv): MemoryStateStore {
  if (isCloudflareTarget()) {
    return new CfMemoryStateStore(tagStateStub(env));
  }
  cachedMemoryStore = nodeCached(
    cachedMemoryStore,
    (path) => new SqliteMemoryStateStore(path),
  );
  return cachedMemoryStore.store;
}

export function getRoutineStore(env?: PlatformEnv): RoutineStore {
  if (isCloudflareTarget()) {
    return new CfRoutineStore(tagStateStub(env));
  }
  cachedRoutineStore = nodeCached(
    cachedRoutineStore,
    (path) => new SqliteRoutineStore(path),
  );
  return cachedRoutineStore.store;
}

export function getUsageStore(env?: PlatformEnv): UsageStore {
  if (isCloudflareTarget()) {
    return new CfUsageStore(tagStateStub(env));
  }
  cachedUsageStore = nodeCached(
    cachedUsageStore,
    (path) => new SqliteUsageStore(path),
  );
  return cachedUsageStore.store;
}

/**
 * Resolve every store a request handler needs in one call. Handlers pass their
 * platform env through (`c.env` in routes); on Node it is ignored.
 */
export function resolveStores(env?: PlatformEnv): AppStores {
  return {
    config: getConfigStore(env),
    snapshots: getAgentSnapshotStore(env),
    slackState: getSlackStateStore(env),
    settings: getSettingsStore(env),
    memory: getMemoryStateStore(env),
    routines: getRoutineStore(env),
    usage: getUsageStore(env),
  };
}
