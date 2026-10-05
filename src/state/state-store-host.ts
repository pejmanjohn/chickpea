import { InstallationContextError } from '../config/installation-scope.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { RoutinePersistenceTelemetrySink } from '../routines/telemetry.ts';
import { readSandboxContainerUsage } from '../sandbox/container-lease.ts';
import { readMonthlySandboxSessions } from '../sandbox/session-cap.ts';
import { promisify } from './async-facade.ts';
import {
  assertObjectHostCall,
  eraseObjectStorage,
  exportObjectPage,
  objectRestoreHostFunctions,
  ObjectRestoreError,
  type HostObjectStorage,
  type HostObjectRestoreContext,
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

/**
 * What one installation's state store knows of its coding workspaces: the
 * Sandboxes and coding workers it inventoried, the containers holding a
 * lease now, and this month's metered container time and counted sessions.
 * The R2 checkpoints are counted beside it (state/installation-objects.ts).
 */
export interface StateSandboxCensus {
  readonly objects: { readonly sandbox: number; readonly coding_worker: number };
  /** Containers holding a running lease. */
  readonly runningContainers: number;
  /** The UTC month counted, `YYYY-MM`. */
  readonly month: string;
  /** Container time metered this month, in seconds (runs still going are not yet metered). */
  readonly containerSeconds: number;
  /** Workspace sessions (container starts) counted this month. */
  readonly sessions: number;
}

/** The state store's host functions: every object's, its inventory, and its own pending work. */
export interface StateStoreHostRpc extends Omit<InstallationObjectHostRpc, 'chickpeaHostCancelPendingWork'> {
  chickpeaHostInventory(
    request: ObjectHostRequest & { cursor?: string | null; limit?: number },
  ): Promise<InstallationObjectInventoryPage>;
  chickpeaHostInventoryBackfill(request: ObjectHostRequest): Promise<InstallationObjectBackfill>;
  chickpeaHostSandboxCensus(request: ObjectHostRequest & { now?: number }): Promise<StateSandboxCensus>;
  chickpeaHostExportPage(request: ObjectExportRequest): Promise<ObjectExportPage>;
  chickpeaHostErase(request: ObjectHostRequest): Promise<ObjectEraseResult>;
  chickpeaHostCancelPendingWork(request: ObjectHostRequest): Promise<StatePendingWorkCancellation>;
}

/**
 * The host functions of one installation's state store (`TagStateStore`
 * delegates here), over its env (scoped by its own name), storage and
 * stores. `stores` builds them on demand; `onErased` drops them, and all
 * else the store holds in memory, once the storage is gone. A later call
 * builds an empty, seeded store again, which is why erasure must be the
 * installation's last contact (state/installation-objects.ts).
 */
export function stateStoreHostFunctions(store: {
  readonly env: Record<string, unknown> | undefined;
  readonly storage: HostObjectStorage;
  readonly restoreContext?: HostObjectRestoreContext;
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
  const assertBinding = (installationId: string): void => {
    const bound = store.storage.sql.exec(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'installation_binding'",
    ).toArray().length > 0
      ? store.storage.sql.exec(
        "SELECT installation_id FROM installation_binding WHERE binding_key = 'installation'",
      ).toArray()[0]
      : undefined;
    if (bound && bound.installation_id !== installationId) {
      throw new InstallationContextError(
        'installation_context_mismatch',
        'This state store belongs to another installation.',
      );
    }
  };
  return {
    ...objectRestoreHostFunctions({
      ...store,
      assertOwner: ({ installationId }) => assertBinding(installationId),
      quiesce: async () => quiesceStateStoreForRestore(store.stores()),
    }),
    async chickpeaHostInventory(request) {
      return stores(request).objectInventory.list(request);
    },
    async chickpeaHostInventoryBackfill(request) {
      return stores(request).objectInventory.backfill();
    },
    async chickpeaHostSandboxCensus(request) {
      const local = stores(request);
      const now = request.now ?? Date.now();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error('A census time must be a timestamp.');
      const counts = local.objectInventory.counts();
      const settings = promisify(local.settings, { close: () => undefined });
      const usage = await readSandboxContainerUsage({ store: settings, now });
      const sessions = await readMonthlySandboxSessions(settings, new Date(now));
      return {
        objects: { sandbox: counts.sandbox, coding_worker: counts.coding_worker },
        runningContainers: usage.running,
        month: usage.month,
        containerSeconds: usage.meteredSeconds,
        sessions: sessions.count,
      };
    },
    async chickpeaHostExportPage(request) {
      assertObjectHostCall(store.env, request);
      return exportObjectPage(store.storage, request);
    },
    /** Erased last: its own binding must name the installation too. */
    async chickpeaHostErase(request) {
      const scope = assertObjectHostCall(store.env, request);
      assertBinding(scope.installationId);
      const erased = await eraseObjectStorage(store.storage);
      store.onErased();
      return erased;
    },
    async chickpeaHostCancelPendingWork(request) {
      const local = stores(request);
      const at = Date.now();
      const { agents, agentsUnaddressable, occurrences, ...cancelled } = cancelStatePendingWork(local, at);
      // This store's own Work and usage records, through their async views.
      await settleCancelledOccurrences(occurrences, store.env as PlatformEnv, {
        workStore: promisify(local.work, { close: () => undefined }),
        usageStore: promisify(local.usage, { close: () => undefined }),
        now: () => at,
        ...(store.persistenceTelemetrySink ? { persistenceTelemetrySink: store.persistenceTelemetrySink } : {}),
      });
      await store.storage.deleteAlarm();
      const { stopped, notStopped } = await (store.stopAgents ?? stopCancelledAgents)(agents);
      return {
        alarmCleared: true, ...cancelled, agentsStopped: stopped, agentsNotStopped: notStopped + agentsUnaddressable,
      };
    },
  };
}

/**
 * Before a restore reads the state store's fence and digest: refuse while
 * its alarm still owes work that a new instance arms it for at once
 * (TagStateStore's `resumeAfterRestart`): an alarm turn whose Flue dispatch
 * was in flight, a gateway delivery leased by an earlier instance, or a
 * hand-off to a thread runner not yet confirmed (armed for after a deploy,
 * and re-admitted by the alarm's next run). Any of them would move the
 * storage before scheduling. `cancel_pending` parks the turns; a leased
 * delivery returns to the inbox once the alarm reclaims it.
 */
export function quiesceStateStoreForRestore(
  stores: {
    readonly turnJobs: Pick<TagStateStores['turnJobs'], 'hasInterruptedAlarmDispatch' | 'hasHandoffs'>;
    readonly gatewayInbox: Pick<TagStateStores['gatewayInbox'], 'hasOrphanedLease'>;
  },
): void {
  const owed = [
    stores.turnJobs.hasInterruptedAlarmDispatch() ? 'an alarm turn dispatched' : undefined,
    stores.gatewayInbox.hasOrphanedLease() ? 'a gateway delivery leased by an earlier instance' : undefined,
    stores.turnJobs.hasHandoffs() ? 'a runner hand-off unconfirmed' : undefined,
  ].filter((reason) => reason !== undefined);
  if (owed.length > 0) {
    throw new ObjectRestoreError(
      'restore_object_busy',
      `The state store has work its alarm resumes (${owed.join(', ')}); run cancel_pending, then retry once its alarm has settled what remains.`,
    );
  }
}
