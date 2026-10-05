import {
  InstallationContextError,
  requireInstallationScope,
  scopedObjectName,
  splitInstallationObjectName,
  validInstallationIdentityId,
} from '../config/installation-scope.ts';
import { TAG_STATE_INSTANCE } from '../config/state-rpc.ts';
import { readInstallationObjectRestoreBookmarks, type InstallationObject } from './installation-objects.ts';
import type { ObjectRestoreBookmarks } from './object-host.ts';

/**
 * Schedule and restart order. Restored objects write to each other when they
 * next wake: a Sandbox restored inside a turn records its container's stop
 * and releases its lease in the state store, a runner's resumed job calls the
 * state store, and the state store hands turns to runners. No order keeps
 * every such write off an object still awaiting its restore, so apply
 * schedules every object before restarting any (object-host.ts). Restarts
 * then run callee first: the state store, which every other kind writes to,
 * then Sandboxes, which write only to it, then runners, Flue agents and
 * coding workers. A write to an object not restarted yet is discarded by its
 * restore; the post-restore cancellation settles what that leaves.
 */
const RESTORE_ORDER: Readonly<Record<InstallationObject['kind'], number>> = {
  state_store: 0,
  sandbox: 1,
  thread_runner: 2,
  slack_agent: 3,
  routine_agent: 4,
  coding_worker: 5,
};

/**
 * A pure restore plan from every page of the pre-restore inventory, in
 * `RESTORE_ORDER`. It adds the implicit state store and accepts a census that
 * already includes it. The plan is the host's saved census, so restoring the
 * state store's inventory first hides nothing from it. Never mutates input.
 */
export function buildInstallationRestorePlan(
  installationId: string,
  inventory: readonly InstallationObject[],
): InstallationObject[] {
  const scope = { installationId: validInstallationIdentityId(installationId, 'installation') };
  const stateStoreName = scopedObjectName(scope, TAG_STATE_INSTANCE);
  const seen = new Set<string>();
  const objects = inventory.map(({ kind, name }) => {
    if (!Object.hasOwn(RESTORE_ORDER, kind)) throw new Error('Unknown installation object kind.');
    if (splitInstallationObjectName(name).scope?.installationId !== scope.installationId ||
        (kind === 'state_store' && name !== stateStoreName)) {
      throw new InstallationContextError('installation_context_mismatch', 'The object belongs to another installation.');
    }
    const key = `${kind}:${name}`;
    if (seen.has(key)) throw new Error('The restore inventory contains a duplicate object.');
    seen.add(key);
    return { kind, name };
  });
  if (!objects.some(({ kind }) => kind === 'state_store')) objects.push({ kind: 'state_store', name: stateStoreName });
  return objects.sort((left, right) => RESTORE_ORDER[left.kind] - RESTORE_ORDER[right.kind] ||
    (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/** One census entry: an object and, from the inventory, when its name was first recorded. */
export type InstallationCensusObject = InstallationObject & { readonly firstSeenAt?: number };

export interface InstallationRestorePreparation {
  readonly timestamp: number;
  /** In plan order, with the fence and target apply must present for each. */
  readonly prepared: ReadonlyArray<{ readonly object: InstallationObject; readonly bookmarks: ObjectRestoreBookmarks }>;
  /** Recorded after T, so without storage at T: neither restored nor erased. */
  readonly skipped: ReadonlyArray<{
    readonly object: InstallationObject;
    readonly reason: 'younger_than_target';
    readonly firstSeenAt: number;
  }>;
  /** Objects whose bookmarks could not be read. Apply must not be offered while any remain. */
  readonly failed: ReadonlyArray<{ readonly object: InstallationObject; readonly error: unknown }>;
}

/**
 * restore_prepare over a whole census: read every planned object's bookmarks
 * at T, serially in plan order, and report each object's outcome rather than
 * stop at the first. An object whose name the inventory first recorded after
 * T is skipped with `younger_than_target`: Core records a name before
 * anything addresses the object, so the object had no storage at T and
 * `getBookmarkForTime(T)` has no documented answer for it. Names a backfill
 * recorded carry the backfill's time instead, so a backfill after T marks
 * older objects as younger too; review the skipped list before apply. The
 * state store is never skipped.
 */
export async function prepareInstallationRestore(
  env: Record<string, unknown>,
  census: readonly InstallationCensusObject[],
  timestamp: number,
): Promise<InstallationRestorePreparation> {
  const scope = requireInstallationScope(env);
  if (!scope) {
    throw new InstallationContextError(
      'installation_context_invalid',
      'Host functions run only on a deployment serving many installations.',
    );
  }
  const plan = buildInstallationRestorePlan(scope.installationId, census);
  const firstSeen = new Map(census.map((object) => [`${object.kind}:${object.name}`, object.firstSeenAt]));
  const prepared: Array<InstallationRestorePreparation['prepared'][number]> = [];
  const skipped: Array<InstallationRestorePreparation['skipped'][number]> = [];
  const failed: Array<InstallationRestorePreparation['failed'][number]> = [];
  for (const object of plan) {
    const firstSeenAt = firstSeen.get(`${object.kind}:${object.name}`);
    if (object.kind !== 'state_store' && typeof firstSeenAt === 'number' && firstSeenAt > timestamp) {
      skipped.push({ object, reason: 'younger_than_target', firstSeenAt });
      continue;
    }
    try {
      prepared.push({ object, bookmarks: await readInstallationObjectRestoreBookmarks(env, object, timestamp) });
    } catch (error) {
      failed.push({ object, error });
    }
  }
  return { timestamp, prepared, skipped, failed };
}
