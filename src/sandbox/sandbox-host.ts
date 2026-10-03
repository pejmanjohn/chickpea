import {
  assertObjectHostCall,
  CODING_WORKSPACE_EXPORT_NOTE,
  eraseObjectStorage,
  OBJECT_EXPORT_FORMAT,
  type HostObjectStorage,
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

export interface SandboxHostRpc {
  /** The export's one line for a Sandbox: its header and the note why nothing follows. */
  chickpeaHostExportPage(request: ObjectExportRequest): Promise<ObjectExportPage>;
  /**
   * Destroys the container, deletes the latest checkpoint's objects, then
   * every record and the alarm. The host quiesces the installation first
   * (`chickpeaHostCancelPendingWork`), so no container lifecycle event of a
   * stop lands after the erasure; a container still running is destroyed
   * here all the same. Erasure must be the Sandbox's last contact.
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

/** The host functions of one Sandbox, over its env (scoped by its own name) and storage. */
export function sandboxHostFunctions(sandbox: {
  readonly env: Record<string, unknown> | undefined;
  readonly storage: HostObjectStorage;
  /** Whether the container runs now. */
  readonly running: () => boolean;
  /** Destroys the container (the SDK's `destroy`). */
  readonly destroy: () => Promise<void>;
  /** The handle of the checkpoint the Sandbox records, if any. */
  readonly currentCheckpoint: () => Promise<unknown>;
}): SandboxHostRpc {
  const stop = async (): Promise<boolean> => {
    if (!sandbox.running()) return false;
    await sandbox.destroy();
    return true;
  };
  return {
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
      await stop();
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
