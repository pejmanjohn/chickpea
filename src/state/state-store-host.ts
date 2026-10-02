import { InstallationContextError } from '../config/installation-scope.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { RoutinePersistenceTelemetrySink } from '../routines/telemetry.ts';
import { promisify } from './async-facade.ts';
import {
  assertObjectHostCall,
  eraseObjectStorage,
  exportObjectPage,
  type HostObjectStorage,
  type InstallationObjectHostRpc,
  type ObjectEraseResult,
  type ObjectExportPage,
  type ObjectExportRequest,
  type ObjectHostRequest,
} from './object-host.ts';
import type { InstallationObjectBackfill, InstallationObjectInventoryPage } from './object-inventory.ts';
import {
  cancelStatePendingWork,
  settleCancelledOccurrences,
  stopCancelledAgents,
  type AgentStopTarget,
  type StatePendingWorkCancellation,
} from './pending-work.ts';
import type { TagStateStores } from './tag-state-stores.ts';

/** The state store's host functions: every object's, its inventory, and its own pending work. */
export interface StateStoreHostRpc extends Omit<InstallationObjectHostRpc, 'chickpeaHostCancelPendingWork'> {
  chickpeaHostInventory(
    request: ObjectHostRequest & { cursor?: string | null; limit?: number },
  ): Promise<InstallationObjectInventoryPage>;
  chickpeaHostInventoryBackfill(request: ObjectHostRequest): Promise<InstallationObjectBackfill>;
  chickpeaHostExportPage(request: ObjectExportRequest): Promise<ObjectExportPage>;
  chickpeaHostErase(request: ObjectHostRequest): Promise<ObjectEraseResult>;
  chickpeaHostCancelPendingWork(request: ObjectHostRequest): Promise<StatePendingWorkCancellation>;
}

/**
 * The host functions of one installation's state store (`TagStateStore`
 * delegates here), over its env (scoped by its own name), storage and
 * stores. `stores` builds them on demand; `onErased` drops them once the
 * storage is gone, so a later call builds an empty store again.
 */
export function stateStoreHostFunctions(store: {
  readonly env: Record<string, unknown> | undefined;
  readonly storage: HostObjectStorage;
  readonly stores: () => TagStateStores;
  readonly onErased: () => void;
  readonly stopAgents?: (agents: readonly AgentStopTarget[]) => Promise<{ stopped: number; notStopped: number }>;
  /** Where a cancelled occurrence's settlement is reported (the log, by default). */
  readonly persistenceTelemetrySink?: RoutinePersistenceTelemetrySink;
}): StateStoreHostRpc {
  const stores = (request: ObjectHostRequest): TagStateStores => {
    assertObjectHostCall(store.env, request);
    return store.stores();
  };
  return {
    async chickpeaHostInventory(request) {
      return stores(request).objectInventory.list(request);
    },
    async chickpeaHostInventoryBackfill(request) {
      return stores(request).objectInventory.backfill();
    },
    async chickpeaHostExportPage(request) {
      assertObjectHostCall(store.env, request);
      return exportObjectPage(store.storage, request);
    },
    /** Erased last: its own binding must name the installation too. */
    async chickpeaHostErase(request) {
      const scope = assertObjectHostCall(store.env, request);
      const bound = store.storage.sql.exec(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'installation_binding'",
      ).toArray().length > 0
        ? store.storage.sql.exec(
          "SELECT installation_id FROM installation_binding WHERE binding_key = 'installation'",
        ).toArray()[0]
        : undefined;
      if (bound && bound.installation_id !== scope.installationId) {
        throw new InstallationContextError(
          'installation_context_mismatch',
          'This state store belongs to another installation.',
        );
      }
      const erased = await eraseObjectStorage(store.storage);
      store.onErased();
      return erased;
    },
    async chickpeaHostCancelPendingWork(request) {
      const local = stores(request);
      const at = Date.now();
      const { agents, occurrences, ...cancelled } = cancelStatePendingWork(local, at);
      // This store's own Work and usage records, through their async views.
      await settleCancelledOccurrences(occurrences, store.env as PlatformEnv, {
        workStore: promisify(local.work, { close: () => undefined }),
        usageStore: promisify(local.usage, { close: () => undefined }),
        now: () => at,
        ...(store.persistenceTelemetrySink ? { persistenceTelemetrySink: store.persistenceTelemetrySink } : {}),
      });
      await store.storage.deleteAlarm();
      const { stopped, notStopped } = await (store.stopAgents ?? stopCancelledAgents)(agents);
      return { alarmCleared: true, ...cancelled, agentsStopped: stopped, agentsNotStopped: notStopped };
    },
  };
}
