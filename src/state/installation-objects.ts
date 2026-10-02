/**
 * What a host serving many installations calls, from an operator job, to
 * enumerate, export, erase and quiet the Durable Objects one installation
 * owns. Each function takes that installation's scoped env
 * (`scopeInstallationEnv`), addresses only objects its name scopes to it, and
 * passes the installation along so the object checks it against its own
 * name; a standalone deployment is refused.
 *
 * The installation's objects are its state store (implicit, named after the
 * installation) and those its inventory records (state/object-inventory.ts).
 * Erasure order is the host's: every inventoried object first, the state
 * store last, after copying its inventory.
 */
import { CHICKPEA_ROUTINE_EXECUTION_AGENT_NAME } from '../agents/names.ts';
import {
  deploymentTenancy,
  InstallationContextError,
  requireInstallationScope,
  splitInstallationObjectName,
  type InstallationScope,
} from '../config/installation-scope.ts';
import { tagStateInstanceName, tagStateStub } from '../config/state-rpc.ts';
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
} from './object-host.ts';
import type {
  InstallationObjectBackfill,
  InstallationObjectInventoryPage,
  InstallationObjectKind,
} from './object-inventory.ts';
import type { StatePendingWorkCancellation } from './pending-work.ts';
import type { StateStoreHostRpc } from './state-store-host.ts';

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
 * ledger saw run that nothing can name any more. Safe to repeat.
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

/**
 * Delete every table, key-value entry and the alarm of one object. Refused
 * unless `confirmInstallationId` repeats the installation, as an operator
 * confirms an erasure. The state store also refuses when it is bound to
 * another installation. Irreversible within Chickpea; Cloudflare may keep the
 * data recoverable through its point-in-time history for up to 30 days.
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
 * runner its open jobs. Run while the installation is suspended, after a
 * restore. Safe to repeat.
 */
export async function cancelInstallationObjectPendingWork(
  env: Record<string, unknown>,
  object: InstallationObject,
): Promise<ObjectPendingWorkCancellation | StatePendingWorkCancellation> {
  const scope = hostScope(env);
  return objectStub(env, scope, object).chickpeaHostCancelPendingWork({ installationId: scope.installationId });
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

/** Any object's host functions; the state store's cancellation reports more. */
type AnyObjectHostRpc = Omit<InstallationObjectHostRpc, 'chickpeaHostCancelPendingWork'> & {
  chickpeaHostCancelPendingWork(
    request: { installationId: string },
  ): Promise<ObjectPendingWorkCancellation | StatePendingWorkCancellation>;
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
      : undefined;
  if (!bindingName) throw new Error('Unknown installation object kind.');
  const namespace = env[bindingName] as IdNamespace | undefined;
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
