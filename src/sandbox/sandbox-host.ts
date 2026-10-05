import {
  assertObjectHostCall,
  CODING_WORKSPACE_EXPORT_NOTE,
  eraseObjectStorage,
  OBJECT_EXPORT_FORMAT,
  objectRestoreHostFunctions,
  ObjectRestoreError,
  type HostObjectStorage,
  type HostObjectRestoreContext,
  type InstallationObjectRestoreRpc,
  type ObjectEraseResult,
  type ObjectExportPage,
  type ObjectExportRecord,
  type ObjectExportRequest,
  type ObjectHostRequest,
} from '../state/object-host.ts';
import { deleteCheckpointObjects } from './checkpoint-bucket.ts';
import { checkpointBucket } from './checkpoint-sweep.ts';

/**
 * What a host serving many installations may ask of a coding workspace's
 * Sandbox Durable Object (state/installation-objects.ts), beside what every
 * installation object answers. Each call refuses on standalone and for any
 * installation but the one the Sandbox's name scopes.
 *
 * A Sandbox holds the workspace's container, its latest checkpoint's handle
 * and operational records (rosters, coding-task records, the egress policy).
 * None of it is exported: the files are a working copy of the tenant's
 * repositories, and the records only run the workspace. Kept free of
 * `cloudflare:workers`: the Sandbox class delegates here, and tests run it
 * over Node.
 */

/** A Sandbox's cancellation: it stops the container and keeps its alarm. */
export interface SandboxPendingWorkCancellation {
  /**
   * Always false: a Sandbox's alarm is the container runtime's own, which
   * only runs a container's lifecycle (including the stop that settles its
   * lease) and deletes itself once the container has stopped.
   */
  readonly alarmCleared: false;
  /** Whether a running container was stopped. */
  readonly containerStopped: boolean;
}

export interface SandboxContainerStop {
  /** Whether a running container was stopped; false when none ran. */
  readonly stopped: boolean;
}

export interface SandboxHostRpc extends InstallationObjectRestoreRpc {
  /** The export's one line for a Sandbox: its header and the note why nothing follows. */
  chickpeaHostExportPage(request: ObjectExportRequest): Promise<ObjectExportPage>;
  /**
   * Destroys the container, settles its stop, deletes the latest
   * checkpoint's objects, then every record and the alarm. The alarm is how
   * the container runtime would run a stop's `onStop`, so the erasure
   * settles the stop itself: it waits, at most
   * `CONTAINER_STOP_RECORD_DEADLINE_MS`, for the runtime to record the
   * container's stop, so the record lands before the deletion, then releases
   * the container's lease and meters its run. A record later than that
   * deadline would leave the runtime's own state key (its status, no tenant
   * data) behind; the erasure logs it. Erasure must be the Sandbox's last
   * contact.
   */
  chickpeaHostErase(request: ObjectHostRequest): Promise<ObjectEraseResult>;
  /** Stops the container, as `chickpeaHostStopContainer`. */
  chickpeaHostCancelPendingWork(request: ObjectHostRequest): Promise<SandboxPendingWorkCancellation>;
  /**
   * Destroys the container if it runs, keeping every record and the latest
   * checkpoint, so the thread restores on its next turn. The stop settles the
   * container's lease and meters its run (the Sandbox's `onStop`). Work since
   * the last turn ended is lost.
   */
  chickpeaHostStopContainer(request: ObjectHostRequest): Promise<SandboxContainerStop>;
}

/** How long an erasure waits for the container runtime to record a destroyed container's stop. */
export const CONTAINER_STOP_RECORD_DEADLINE_MS = 5_000;
const CONTAINER_STOP_RECORD_POLL_MS = 50;

/**
 * Wait until the Containers SDK's state (`getState`) reads stopped: its
 * monitor records that once it sees a destroyed container exit. True once
 * recorded; false, logged, past the deadline.
 */
export async function containerStopRecorded(
  state: () => Promise<{ status: string }>,
  options: { deadlineMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + (options.deadlineMs ?? CONTAINER_STOP_RECORD_DEADLINE_MS);
  for (;;) {
    const { status } = await state();
    if (status === 'stopped' || status === 'stopped_with_code') return true;
    if (Date.now() >= deadline) {
      // Content-free: names no installation or Sandbox.
      console.warn(JSON.stringify({ component: 'sandbox_host', event: 'stop_record_deadline' }));
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? CONTAINER_STOP_RECORD_POLL_MS));
  }
}

/** The host functions of one Sandbox, over its env (scoped by its own name) and storage. */
export function sandboxHostFunctions(sandbox: {
  readonly env: Record<string, unknown> | undefined;
  readonly storage: HostObjectStorage;
  readonly restoreContext?: HostObjectRestoreContext;
  /** Whether the container runs now. */
  readonly running: () => boolean;
  /** Destroys the container (the SDK's `destroy`). */
  readonly destroy: () => Promise<void>;
  /** Waits, bounded, until the container runtime has recorded the stop of the container just destroyed. */
  readonly stopRecorded: () => Promise<unknown>;
  /** Releases a stopped container's lease and meters its run, as the Sandbox's `onStop` does. */
  readonly releaseLease: () => Promise<void>;
  /** The handle of the checkpoint the Sandbox records, if any. */
  readonly currentCheckpoint: () => Promise<unknown>;
}): SandboxHostRpc {
  const stop = async (): Promise<boolean> => {
    if (!sandbox.running()) return false;
    await sandbox.destroy();
    return true;
  };
  return {
    ...objectRestoreHostFunctions({
      ...sandbox,
      assertRestorable: () => {
        if (sandbox.running()) {
          throw new ObjectRestoreError('restore_object_busy', 'Stop the Sandbox container before preparing a restore.');
        }
      },
    }),
    async chickpeaHostExportPage(request) {
      assertObjectHostCall(sandbox.env, request);
      if (request.mode !== 'portable' && request.mode !== 'full') {
        throw new Error('Export mode must be portable or full.');
      }
      // The page is whole: a cursor can only come from somewhere else.
      if (request.cursor) throw new Error('The export cursor is malformed.');
      const header: ObjectExportRecord = {
        t: 'object', format: OBJECT_EXPORT_FORMAT, mode: request.mode, note: CODING_WORKSPACE_EXPORT_NOTE,
      };
      return { lines: `${JSON.stringify(header)}\n`, records: 1, nextCursor: null };
    },
    async chickpeaHostErase(request) {
      assertObjectHostCall(sandbox.env, request);
      // The erasure deletes the alarm that would run the stop's `onStop`:
      // settle it here, also for a container that stopped before.
      if (await stop()) await sandbox.stopRecorded();
      await sandbox.releaseLease();
      // Deleted through the Sandbox's own bucket: the installation's prefix.
      // A failure keeps every record, so a retry finds the handle again.
      const bucket = checkpointBucket(sandbox.env);
      const checkpoint = await sandbox.currentCheckpoint();
      if (bucket && checkpoint !== undefined) await deleteCheckpointObjects(bucket, checkpoint);
      return eraseObjectStorage(sandbox.storage);
    },
    async chickpeaHostCancelPendingWork(request) {
      assertObjectHostCall(sandbox.env, request);
      return { alarmCleared: false, containerStopped: await stop() };
    },
    async chickpeaHostStopContainer(request) {
      assertObjectHostCall(sandbox.env, request);
      return { stopped: await stop() };
    },
  };
}
