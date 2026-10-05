import {
  InstallationContextError,
  scopedObjectName,
  splitInstallationObjectName,
  validInstallationIdentityId,
} from '../config/installation-scope.ts';
import { TAG_STATE_INSTANCE } from '../config/state-rpc.ts';
import type { InstallationObject } from './installation-objects.ts';

const RESTORE_ORDER: Readonly<Record<InstallationObject['kind'], number>> = {
  thread_runner: 0,
  slack_agent: 1,
  routine_agent: 2,
  coding_worker: 3,
  sandbox: 4,
  state_store: 5,
};

/**
 * A pure restore plan from every page of the pre-restore inventory. It adds the
 * implicit state store, restores runners and agents first, and the state store
 * last so restoring its inventory cannot hide objects still awaiting restore.
 * Accepts a census that already includes the state store too. Never mutates input.
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
