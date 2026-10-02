import {
  deploymentTenancy,
  InstallationContextError,
  requireInstallationScope,
  validInstallationIdentityId,
} from '../config/installation-scope.ts';
import { schemaInstallRequired, type StateDb } from '../state/state-db.ts';

/** The organization and installation an identity store's records belong to. */
export interface InstallationIdentity {
  readonly organizationId: string;
  readonly installationId: string;
}

/** A standalone deployment is one installation with these fixed IDs. */
export const STANDALONE_INSTALLATION_IDENTITY: InstallationIdentity = Object.freeze({
  organizationId: 'org_oss',
  installationId: 'installation_oss',
});

/**
 * The globally unique IDs a multi-installation host assigned to this state
 * store, written once when it provisions the installation. Only a store
 * serving many installations creates its table, outside the identity schema
 * ledger, so a standalone store never migrates for it and an earlier release
 * ignores it.
 */
export class InstallationBindingLogic {
  private readonly db: StateDb;
  private bound: InstallationIdentity | undefined;

  constructor(db: StateDb, env: Record<string, unknown> | undefined) {
    this.db = db;
    if (deploymentTenancy(env) === 'installation' && schemaInstallRequired(db)) {
      db.exec(`CREATE TABLE IF NOT EXISTS installation_binding (
        binding_key TEXT PRIMARY KEY CHECK (binding_key = 'installation'),
        organization_id TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        bound_at INTEGER NOT NULL
      )`);
    }
  }

  get(): InstallationIdentity | undefined {
    if (this.bound) return this.bound;
    const row = this.db.get(
      "SELECT organization_id, installation_id FROM installation_binding WHERE binding_key = 'installation'",
    );
    if (!row) return undefined;
    this.bound = Object.freeze({
      organizationId: String(row.organization_id),
      installationId: String(row.installation_id),
    });
    return this.bound;
  }

  /** Idempotent for the same IDs; a store is never rebound to others. */
  bind(input: InstallationIdentity, now = Date.now()): InstallationIdentity {
    const identity = {
      organizationId: validInstallationIdentityId(input.organizationId, 'organization'),
      installationId: validInstallationIdentityId(input.installationId, 'installation'),
    };
    if (identity.organizationId === STANDALONE_INSTALLATION_IDENTITY.organizationId ||
        identity.installationId === STANDALONE_INSTALLATION_IDENTITY.installationId) {
      throw new InstallationContextError(
        'installation_context_invalid',
        'A hosted installation needs its own globally unique IDs.',
      );
    }
    this.db.run(
      `INSERT INTO installation_binding (binding_key, organization_id, installation_id, bound_at)
       VALUES ('installation', ?, ?, ?) ON CONFLICT(binding_key) DO NOTHING`,
      identity.organizationId, identity.installationId, now,
    );
    const bound = this.get();
    if (bound?.organizationId !== identity.organizationId || bound.installationId !== identity.installationId) {
      throw new InstallationContextError(
        'installation_context_mismatch',
        'This state store belongs to another installation.',
      );
    }
    return bound;
  }
}

/**
 * The IDs a state store serving `env` writes identity records under: the
 * standalone ones, or the ones its host bound to this installation.
 */
export function storeInstallationIdentity(
  binding: InstallationBindingLogic,
  env: Record<string, unknown> | undefined,
): InstallationIdentity {
  const scope = requireInstallationScope(env);
  if (!scope) return STANDALONE_INSTALLATION_IDENTITY;
  const bound = binding.get();
  if (!bound) {
    throw new InstallationContextError('installation_context_missing', 'This installation is not provisioned yet.');
  }
  if (bound.installationId !== scope.installationId) {
    throw new InstallationContextError('installation_context_mismatch', 'This state store belongs to another installation.');
  }
  return bound;
}

/** Provisioning: bind the store serving `env` to the IDs its host assigned. */
export function bindStoreInstallation(
  binding: InstallationBindingLogic,
  env: Record<string, unknown> | undefined,
  identity: InstallationIdentity,
): InstallationIdentity {
  const scope = requireInstallationScope(env);
  if (!scope || identity.installationId !== scope.installationId) {
    throw new InstallationContextError('installation_context_mismatch', 'Only this installation can be bound here.');
  }
  return binding.bind(identity);
}
