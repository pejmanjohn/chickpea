/**
 * What a host serving many installations calls, from an operator job, to
 * enumerate, export, restore, erase and quiet the Durable Objects one installation
 * owns. Each function takes that installation's scoped env
 * (`scopeInstallationEnv`), addresses only objects its name scopes to it, and
 * passes the installation along so the object checks it against its own
 * name; a standalone deployment is refused.
 *
 * The installation's objects are its state store (implicit, named after the
 * installation) and those its inventory records (state/object-inventory.ts).
 * Erasure order is the host's: every inventoried object first, then the
 * installation's coding workspace checkpoints (`eraseInstallationCheckpoints`),
 * the state store last, after copying its inventory.
 *
 * A coding workspace's Sandbox answers like any object, from its own host
 * functions (sandbox/sandbox-host.ts): its export is a header and a note,
 * its erasure first destroys its container, settles the stop (waiting for
 * the container runtime's record of it, and releasing the lease the deleted
 * alarm would have) and deletes its latest checkpoint, and its cancellation
 * stops its container, as `stopInstallationSandboxContainer` does for a
 * suspension. So a running container needs no stop before its erasure, and
 * its lease is released in the state store before that is erased.
 *
 * Erasure must be an installation's last contact with its objects. Core
 * cannot refuse to construct an object, and constructing one creates its
 * schema: any later contact, these functions included (an inventory read, a
 * backfill, an export), re-creates the object empty and schema-initialized,
 * and the state store seeded. Nothing marks an erased object, by design:
 * erasure leaves nothing behind. So the host must route nothing to an
 * installation once erasure starts, gating every path on its registry's
 * `deleted` state.
 */
import { CHICKPEA_CODING_WORKER_AGENT_NAME, CHICKPEA_ROUTINE_EXECUTION_AGENT_NAME } from '../agents/names.ts';
import {
  deploymentTenancy,
  InstallationContextError,
  requireInstallationScope,
  splitInstallationObjectName,
  type InstallationScope,
} from '../config/installation-scope.ts';
import { tagStateInstanceName, tagStateStub } from '../config/state-rpc.ts';
import { installationCheckpointBucket } from '../sandbox/checkpoint-bucket.ts';
import { sandboxNamespace } from '../sandbox/sandbox-object.ts';
import type {
  SandboxContainerStop,
  SandboxHostRpc,
  SandboxPendingWorkCancellation,
} from '../sandbox/sandbox-host.ts';
import {
  agentObjectBindingName,
  CHICKPEA_SLACK_AGENT_BINDING,
} from '../slack/bounded-agent-observation.ts';
import type {
  InstallationObjectHostRpc,
  ObjectEraseResult,
  ObjectExportMode,
  ObjectExportPage,
  ObjectPendingWorkCancellation,
  ObjectRestoreBookmarks,
  ObjectRestoreRequest,
} from './object-host.ts';
import type {
  InstallationObjectBackfill,
  InstallationObjectInventoryPage,
  InstallationObjectKind,
} from './object-inventory.ts';
import type { StatePendingWorkCancellation } from './pending-work.ts';
import type { StateSandboxCensus, StateStoreHostRpc } from './state-store-host.ts';

/** One object of an installation: its state store, or an inventoried object. */
export interface InstallationObject {
  readonly kind: 'state_store' | InstallationObjectKind;
  /** The exact Durable Object name. */
  readonly name: string;
}

/** The installation's state store, as an object. */
export function installationStateStoreObject(env: Record<string, unknown>): InstallationObject {
  hostScope(env);
  return { kind: 'state_store', name: tagStateInstanceName(env) };
}

/** A page of the installation's inventoried objects (the state store is not among them). */
export async function listInstallationObjects(
  env: Record<string, unknown>,
  options: { cursor?: string | null; limit?: number } = {},
): Promise<InstallationObjectInventoryPage> {
  const scope = hostScope(env);
  return stateStore(env).chickpeaHostInventory({ installationId: scope.installationId, ...options });
}

/**
 * Record the objects created before the inventory existed, from what the
 * installation's stores still hold, and count the Flue instances the Work
 * ledger saw run that nothing can name any more: a lower bound on what
 * cannot be addressed, since runners whose turns aged out leave no trace.
 * Safe to repeat.
 */
export async function backfillInstallationObjects(
  env: Record<string, unknown>,
): Promise<InstallationObjectBackfill> {
  const scope = hostScope(env);
  return stateStore(env).chickpeaHostInventoryBackfill({ installationId: scope.installationId });
}

/** One page of an object's storage as JSON Lines; pass `nextCursor` back until it is null. */
export async function exportInstallationObject(
  env: Record<string, unknown>,
  object: InstallationObject,
  options: { mode: ObjectExportMode; cursor?: string | null; maxBytes?: number },
): Promise<ObjectExportPage> {
  const scope = hostScope(env);
  return objectStub(env, scope, object).chickpeaHostExportPage({ installationId: scope.installationId, ...options });
}

/** restore_prepare: read one object's current fence and its bookmark for T while suspended. */
export async function readInstallationObjectRestoreBookmarks(
  env: Record<string, unknown>,
  object: InstallationObject,
  timestamp: number,
): Promise<ObjectRestoreBookmarks> {
  const scope = hostScope(env);
  return objectStub(env, scope, object).chickpeaHostRestoreBookmarks({ installationId: scope.installationId, timestamp });
}

/**
 * restore_apply: restore one object using its prepared bookmarks, then abort it.
 * The host must keep the installation suspended and handle an interrupted RPC
 * by reconciling the object's state, not by blindly retrying with a new fence.
 */
export async function restoreInstallationObject(
  env: Record<string, unknown>,
  object: InstallationObject,
  options: Pick<ObjectRestoreRequest, 'expectedCurrentBookmark' | 'targetBookmark'> & { confirmInstallationId: string },
): Promise<void> {
  const scope = hostScope(env);
  if (options.confirmInstallationId !== scope.installationId) {
    throw new InstallationContextError(
      'installation_context_mismatch',
      'Restore must be confirmed with the installation it restores.',
    );
  }
  return objectStub(env, scope, object).chickpeaHostRestore({
    installationId: scope.installationId,
    expectedCurrentBookmark: options.expectedCurrentBookmark,
    targetBookmark: options.targetBookmark,
  });
}

/**
 * Delete every table, key-value entry and the alarm of one object. Refused
 * unless `confirmInstallationId` repeats the installation, as an operator
 * confirms an erasure. The state store also refuses when it is bound to
 * another installation. Irreversible within Chickpea; Cloudflare may keep the
 * data recoverable through its point-in-time history for up to 30 days. It
 * must be the object's last contact: any later call re-creates it, empty
 * (see above).
 */
export async function eraseInstallationObject(
  env: Record<string, unknown>,
  object: InstallationObject,
  options: { confirmInstallationId: string },
): Promise<ObjectEraseResult> {
  const scope = hostScope(env);
  if (options.confirmInstallationId !== scope.installationId) {
    throw new InstallationContextError(
      'installation_context_mismatch',
      'Erasure must be confirmed with the installation it erases.',
    );
  }
  return objectStub(env, scope, object).chickpeaHostErase({ installationId: scope.installationId });
}

/**
 * Stop the work one object would start or deliver on its own: its alarm,
 * and for the state store every pending turn, unfinished routine occurrence
 * and undelivered notice or receipt (state/pending-work.ts); for a thread
 * runner its open jobs that are not running (it reports those still
 * running, which settle as their runs end); for a coding workspace's
 * Sandbox its running container, keeping its alarm (see
 * `SandboxPendingWorkCancellation`). Run while the installation is
 * suspended, after a restore. Safe to repeat.
 */
export async function cancelInstallationObjectPendingWork(
  env: Record<string, unknown>,
  object: InstallationObject,
): Promise<ObjectPendingWorkCancellation | StatePendingWorkCancellation | SandboxPendingWorkCancellation> {
  const scope = hostScope(env);
  return objectStub(env, scope, object).chickpeaHostCancelPendingWork({ installationId: scope.installationId });
}

/**
 * Suspension: stop one coding workspace's container if it runs. Its records
 * and latest checkpoint stay, so the thread restores on its next turn once
 * the installation resumes; work since its last turn ended is lost. The stop
 * settles the container's lease and meters its run. Safe to repeat.
 */
export async function stopInstallationSandboxContainer(
  env: Record<string, unknown>,
  object: InstallationObject,
): Promise<SandboxContainerStop> {
  const scope = hostScope(env);
  if (object.kind !== 'sandbox') throw new Error('Only a coding workspace Sandbox has a container to stop.');
  const sandbox = objectStub(env, scope, object) as unknown as SandboxHostRpc;
  return sandbox.chickpeaHostStopContainer({ installationId: scope.installationId });
}

/** One page of a checkpoint erasure. */
export interface CheckpointErasePage {
  /** Objects deleted by this call. */
  readonly deleted: number;
  /** Pass back for the next page; null once the listing reached the prefix's end. */
  readonly nextCursor: string | null;
}

/** R2 deletes at most 1,000 keys a call and lists at most 1,000 a page. */
const CHECKPOINT_PAGE = 1_000;

/**
 * Erasure: delete one page of the installation's coding workspace
 * checkpoints, everything under its prefix of the shared bucket, orphans
 * included. Refused unless `installationId` repeats the installation, as an
 * operator confirms an erasure. Idempotent: a cursor replayed after a crash
 * deletes what is still there from its place on, and a pass from no cursor
 * to a null cursor deletes every object present when it began (run one more
 * from no cursor to confirm: it deletes none). A deployment without the
 * bucket binding has nothing to delete.
 */
export async function eraseInstallationCheckpoints(
  env: Record<string, unknown>,
  installationId: string,
  cursor?: string | null,
): Promise<CheckpointErasePage> {
  const scope = hostScope(env);
  if (installationId !== scope.installationId) {
    throw new InstallationContextError(
      'installation_context_mismatch',
      'Erasure must be confirmed with the installation it erases.',
    );
  }
  const bucket = installationCheckpointBucket<CheckpointListing>(env);
  if (!bucket) return { deleted: 0, nextCursor: null };
  const startAfter = cursor ? decodeCheckpointCursor(cursor) : undefined;
  const listing = await bucket.list({ limit: CHECKPOINT_PAGE, ...(startAfter === undefined ? {} : { startAfter }) });
  const keys = listing.objects.map((object) => object.key);
  if (keys.length > 0) await bucket.delete(keys);
  const last = keys.at(-1);
  return { deleted: keys.length, nextCursor: listing.truncated && last !== undefined ? encodeCheckpointCursor(last) : null };
}

/** An installation's coding workspaces, for a census. */
export interface InstallationSandboxCensus extends StateSandboxCensus {
  /**
   * Its checkpoint prefix: objects and bytes, and whether every object was
   * counted (a census lists at most 50 pages). Null on a deployment without
   * the bucket binding.
   */
  readonly checkpoints: { readonly objects: number; readonly bytes: number; readonly complete: boolean } | null;
}

const CENSUS_CHECKPOINT_PAGES = 50;

/**
 * A census of the installation's coding workspaces: its Sandbox and coding
 * worker objects, running container leases, this month's metered container
 * time and sessions (from its state store), and its checkpoint prefix's
 * objects and bytes. Reads only; the leases and meters it counts are never
 * exported and go with the state store's erasure.
 */
export async function censusInstallationSandbox(
  env: Record<string, unknown>,
  options: { now?: number } = {},
): Promise<InstallationSandboxCensus> {
  const scope = hostScope(env);
  const state = await stateStore(env).chickpeaHostSandboxCensus({
    installationId: scope.installationId,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const bucket = installationCheckpointBucket<CheckpointListing>(env);
  if (!bucket) return { ...state, checkpoints: null };
  let objects = 0;
  let bytes = 0;
  let cursor: string | undefined;
  for (let page = 0; page < CENSUS_CHECKPOINT_PAGES; page += 1) {
    const listing = await bucket.list({ limit: CHECKPOINT_PAGE, ...(cursor === undefined ? {} : { cursor }) });
    objects += listing.objects.length;
    bytes += listing.objects.reduce((total, object) => total + (Number.isFinite(object.size) ? object.size : 0), 0);
    if (!listing.truncated || !listing.cursor) return { ...state, checkpoints: { objects, bytes, complete: true } };
    cursor = listing.cursor;
  }
  return { ...state, checkpoints: { objects, bytes, complete: false } };
}

/** The slice of the installation's checkpoint bucket a host function reads. */
interface CheckpointListing {
  list(options: { limit: number; cursor?: string; startAfter?: string }): Promise<{
    objects: Array<{ key: string; size: number }>;
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string[]): Promise<void>;
}

function encodeCheckpointCursor(after: string): string {
  return Buffer.from(JSON.stringify({ v: 1, after }), 'utf8').toString('base64url');
}

function decodeCheckpointCursor(cursor: string): string {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown; after?: unknown };
    if (value?.v === 1 && typeof value.after === 'string' && value.after.length > 0) return value.after;
  } catch {
    // Reported below.
  }
  throw new Error('The checkpoint cursor is malformed.');
}

function hostScope(env: Record<string, unknown>): InstallationScope {
  if (deploymentTenancy(env) !== 'installation') {
    throw new InstallationContextError(
      'installation_context_invalid',
      'Host functions run only on a deployment serving many installations.',
    );
  }
  return requireInstallationScope(env)!;
}

function stateStore(env: Record<string, unknown>): StateStoreHostRpc {
  return tagStateStub(env) as unknown as StateStoreHostRpc;
}

interface NamedNamespace {
  getByName(name: string): unknown;
}

interface IdNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): unknown;
}

/** Any object's host functions; the state store's and a Sandbox's cancellations report more. */
type AnyObjectHostRpc = Omit<InstallationObjectHostRpc, 'chickpeaHostCancelPendingWork'> & {
  chickpeaHostCancelPendingWork(
    request: { installationId: string },
  ): Promise<ObjectPendingWorkCancellation | StatePendingWorkCancellation | SandboxPendingWorkCancellation>;
};

/** The stub of one object this installation owns, by kind and exact name. */
function objectStub(
  env: Record<string, unknown>,
  scope: InstallationScope,
  object: InstallationObject,
): AnyObjectHostRpc {
  if (object.kind === 'state_store') {
    if (object.name !== tagStateInstanceName(env)) throw foreignObject();
    return stateStore(env);
  }
  if (splitInstallationObjectName(object.name).scope?.installationId !== scope.installationId) {
    throw foreignObject();
  }
  if (object.kind === 'thread_runner') {
    const namespace = env.SLACK_THREAD_RUNNER as NamedNamespace | undefined;
    if (typeof namespace?.getByName !== 'function') throw missingBinding('SLACK_THREAD_RUNNER');
    return namespace.getByName(object.name) as AnyObjectHostRpc;
  }
  const bindingName = object.kind === 'slack_agent'
    ? CHICKPEA_SLACK_AGENT_BINDING
    : object.kind === 'routine_agent'
      ? agentObjectBindingName(CHICKPEA_ROUTINE_EXECUTION_AGENT_NAME)
      : object.kind === 'coding_worker'
        ? agentObjectBindingName(CHICKPEA_CODING_WORKER_AGENT_NAME)
        : object.kind === 'sandbox' ? 'SANDBOX' : undefined;
  if (!bindingName) throw new Error('Unknown installation object kind.');
  // A Sandbox is addressed as the Sandbox SDK addresses it, by its exact name.
  const namespace = (object.kind === 'sandbox' ? sandboxNamespace(env) : env[bindingName]) as IdNamespace | undefined;
  if (typeof namespace?.idFromName !== 'function' || typeof namespace.get !== 'function') {
    throw missingBinding(bindingName);
  }
  return namespace.get(namespace.idFromName(object.name)) as AnyObjectHostRpc;
}

function foreignObject(): InstallationContextError {
  return new InstallationContextError(
    'installation_context_mismatch',
    'The object belongs to another installation.',
  );
}

function missingBinding(name: string): Error {
  return new Error(`Durable Object binding ${name} is unavailable.`);
}
