import {
  CfAgentSnapshotStore,
  CfConfigStore,
  CfIdentityStore,
  CfMemoryStateStore,
  CfManagementStore,
  CfRoutineStore,
  CfSettingsStore,
  CfSlackStateStore,
  CfUsageStore,
  CfWorkStore,
} from './cf-state-proxies.ts';
import { isCloudflareTarget } from './runtime-target.ts';
import {
  SqliteSettingsStore,
  type EncryptedCredentialStore,
  type SettingsStore,
} from './settings-store.ts';
import { SqliteAgentSnapshotStore, type AgentSnapshotStore } from './snapshot-store.ts';
import { buildRuntimeDrainStatus, tagStateStub } from './state-rpc.ts';
import type { RuntimeDrainStatus } from './state-rpc.ts';
import { SqliteConfigStore, type ConfigStore } from './store.ts';
import { SqliteSlackStateStore, type SlackStateStore } from '../slack/claim-store.ts';
import { resolveStateDbPath } from '../state/node-state-db.ts';
import { SqliteMemoryStateStore } from '../memory/store.ts';
import type { MemoryStateStore } from '../memory/types.ts';
import { SqliteRoutineStore } from '../routines/store.ts';
import type { RoutineStore } from '../routines/types.ts';
import { SqliteUsageStore } from '../usage/store.ts';
import type { UsageStore } from '../usage/types.ts';
import { SqliteWorkStore } from '../work/store.ts';
import type { WorkStore } from '../work/types.ts';
import { SqliteIdentityStore } from '../identity/store.ts';
import type { IdentityStore } from '../identity/types.ts';
import { loadCredentialKeyring } from '../slack/credential-keyring.ts';
import type {
  SlackCredentialDependencies,
  SlackCredentialResolutionDependencies,
} from '../slack/installation-credentials.ts';
import { SqliteManagementStore, type ManagementStore } from '../management/store.ts';

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
  identity: IdentityStore;
  config: ConfigStore;
  snapshots: AgentSnapshotStore;
  slackState: SlackStateStore;
  settings: SettingsStore;
  memory: MemoryStateStore;
  routines: RoutineStore;
  usage: UsageStore;
  work: WorkStore;
  management: ManagementStore;
}

// Node singletons, cached by resolved DB path exactly like the pre-refactor
// getConfigStore: reuse while the path is stable, close-and-reopen when env
// changes it (tests move SLACK_STATE_DB_PATH/TAG_DB_PATH between cases).
interface CachedStore<T extends { close?(): void }> {
  path: string;
  store: T;
}

let cachedConfigStore: CachedStore<SqliteConfigStore> | undefined;
let cachedIdentityStore: CachedStore<SqliteIdentityStore> | undefined;
let cachedSnapshotStore: CachedStore<SqliteAgentSnapshotStore> | undefined;
let cachedSlackStateStore: CachedStore<SqliteSlackStateStore> | undefined;
let cachedSettingsStore: CachedStore<SqliteSettingsStore> | undefined;
let cachedMemoryStore: CachedStore<SqliteMemoryStateStore> | undefined;
let cachedRoutineStore: CachedStore<SqliteRoutineStore> | undefined;
let cachedUsageStore: CachedStore<SqliteUsageStore> | undefined;
let cachedWorkStore: CachedStore<SqliteWorkStore> | undefined;
let cachedManagementStore: CachedStore<SqliteManagementStore> | undefined;

/** Close process-local Node stores without opening another database path. */
export function closeNodeStateStores(): void {
  if (isCloudflareTarget()) return;
  cachedConfigStore?.store.close();
  cachedIdentityStore?.store.close();
  cachedSnapshotStore?.store.close();
  cachedSlackStateStore?.store.close();
  cachedSettingsStore?.store.close();
  cachedMemoryStore?.store.close();
  cachedRoutineStore?.store.close();
  cachedUsageStore?.store.close();
  cachedWorkStore?.store.close();
  cachedManagementStore?.store.close();
  cachedConfigStore = undefined;
  cachedIdentityStore = undefined;
  cachedSnapshotStore = undefined;
  cachedSlackStateStore = undefined;
  cachedSettingsStore = undefined;
  cachedMemoryStore = undefined;
  cachedRoutineStore = undefined;
  cachedUsageStore = undefined;
  cachedWorkStore = undefined;
  cachedManagementStore = undefined;
}

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

export function getIdentityStore(env?: PlatformEnv): IdentityStore {
  if (isCloudflareTarget()) {
    return new CfIdentityStore(tagStateStub(env));
  }
  cachedIdentityStore = nodeCached(
    cachedIdentityStore,
    (path) => new SqliteIdentityStore(path),
  );
  return cachedIdentityStore.store;
}

/** Durable encrypted-credential write dependencies for the current target. */
export function getSlackCredentialDependencies(
  env?: PlatformEnv,
): SlackCredentialDependencies {
  return {
    state: getIdentityStore(env),
    keyring: loadCredentialKeyring(env),
  };
}

/** Lazy read dependencies so a missing live Worker slot can enter recovery_only. */
export function getSlackCredentialResolutionDependencies(
  env?: PlatformEnv,
): SlackCredentialResolutionDependencies {
  return {
    state: getIdentityStore(env),
    ...(env ? { env } : {}),
  };
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

export function getSettingsStore(env?: PlatformEnv): SettingsStore & EncryptedCredentialStore {
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

export function getWorkStore(env?: PlatformEnv): WorkStore {
  if (isCloudflareTarget()) {
    return new CfWorkStore(tagStateStub(env));
  }
  cachedWorkStore = nodeCached(
    cachedWorkStore,
    (path) => new SqliteWorkStore(path),
  );
  return cachedWorkStore.store;
}

export function getManagementStore(env?: PlatformEnv): ManagementStore {
  if (isCloudflareTarget()) {
    return new CfManagementStore(tagStateStub(env));
  }
  cachedManagementStore = nodeCached(
    cachedManagementStore,
    (path) => new SqliteManagementStore(path),
  );
  return cachedManagementStore.store;
}

export async function readRuntimeDrainStatus(env?: PlatformEnv): Promise<RuntimeDrainStatus> {
  if (isCloudflareTarget()) {
    const result = await tagStateStub(env).runtimeDrainStatus();
    if (!result.ok) {
      throw new Error(`Runtime drain state is unavailable (${result.error.code}).`);
    }
    return result.value;
  }

  const [turnJobs, executingRuns, admittingOrRunningRoutineOccurrences] = await Promise.all([
    getSlackStateStore(env).runtimeDrainCounts(),
    getWorkStore(env).countExecutingRuns(),
    getRoutineStore(env).countAdmittingOrRunningOccurrences(),
  ]);
  const categories = {
    ...turnJobs,
    pendingGatewayInboxDeliveries: 0,
    inFlightGatewayInboxDeliveries: 0,
    recoveryRequiredGatewayInboxDeliveries: 0,
    executingRuns,
    admittingOrRunningRoutineOccurrences,
  };
  return buildRuntimeDrainStatus(categories);
}

/**
 * Resolve every store a request handler needs in one call. Handlers pass their
 * platform env through (`c.env` in routes); on Node it is ignored.
 */
export function resolveStores(env?: PlatformEnv): AppStores {
  return {
    identity: getIdentityStore(env),
    config: getConfigStore(env),
    snapshots: getAgentSnapshotStore(env),
    slackState: getSlackStateStore(env),
    settings: getSettingsStore(env),
    memory: getMemoryStateStore(env),
    routines: getRoutineStore(env),
    usage: getUsageStore(env),
    work: getWorkStore(env),
    management: getManagementStore(env),
  };
}
