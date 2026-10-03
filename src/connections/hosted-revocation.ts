/**
 * Revoking an installation's connections on its host's authority: before
 * an installation's data is erased, or when an operator must cut its
 * access. Every connection account (managed, MCP and API) is revoked
 * exactly as its owner's revoke does, in that documented order:
 * dependent schedules pause and the account turns `needs_attention` (a
 * fail-closed intermediate state), a managed account's remote account is
 * deleted at its provider (Composio, never the upstream grant, which is
 * grant-wide), the local secret is tombstoned, the account turns `revoked`
 * and its dependents are marked, then an MCP or API account's OAuth
 * settings are deleted. Core revokes nothing remotely for MCP and API
 * connections.
 *
 * Managed accounts go first: they hold the remote access. Each account
 * succeeds or fails on its own, and a host calls this again until `done`.
 * Standalone is refused.
 */
import { ConnectionAccountRevisionConflictError } from '../config/errors.ts';
import { InstallationContextError, requireInstallationScope } from '../config/installation-scope.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import { getConfigStore, getSettingsStore, type PlatformEnv } from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import type { ConnectionAccount, ConnectionAccountOwnerKind } from '../config/types.ts';
import { resolveDefaultManagedConnectionProviderRegistry, type ManagedConnectionProviderRegistry } from './managed.ts';
import { ManagedProviderRequestError } from './managed-errors.ts';
import { COMPOSIO_KEY_MISSING, COMPOSIO_REVOKE_FAILED } from './providers/composio.ts';
import {
  ConnectionAccountService,
  ConnectionScheduleConflictError,
  deleteRevokedConnectionOAuthSettings,
  ManagedConnectionProviderUnavailableError,
} from './store.ts';

export interface ConnectionRevocationOutcome {
  readonly connectionAccountId: string;
  readonly workspaceId: string;
  readonly kind: ConnectionAccount['policy']['kind'];
  /** Managed accounts: the provider whose remote account was deleted. */
  readonly adapterId?: string;
  readonly ownerKind: ConnectionAccountOwnerKind;
  readonly outcome: 'revoked' | 'already_revoked' | 'failed';
  /** Failed accounts: the error's name, never its detail. */
  readonly error?: string;
  /** Failed accounts: why, as a content-free code (see `revocationFailureCode`). */
  readonly code?: RevocationFailureCode;
}

/**
 * Why one account's revocation failed, read from the error's class or one of
 * the fixed messages Core's provider fails with, never from its detail.
 * `provider_*` codes are about this deployment's provider adapter, `remote_*`
 * codes about the provider's own service:
 * - `provider_not_registered`: no provider serves the managed account's adapter;
 * - `provider_not_configured`: its provider has no key;
 * - `remote_revoke_failed`: the provider did not delete the remote account;
 * - `remote_request_invalid`, `remote_throttled`, `remote_unavailable`,
 *   `remote_outcome_unknown`: the provider's service refused the request, was
 *   rate limited, was down, or left the outcome unknown;
 * - `dependent_schedules_changed`: dependent schedules changed mid-revoke;
 * - `account_changed`: the account changed mid-revoke;
 * - `oauth_settings_cleanup_failed`: revoked, but its OAuth settings remain;
 * - `unclassified`: anything else.
 */
export type RevocationFailureCode =
  | 'provider_not_registered'
  | 'provider_not_configured'
  | 'remote_revoke_failed'
  | (typeof REMOTE_REQUEST_FAILURES)[ManagedProviderRequestError['code']]
  | 'dependent_schedules_changed'
  | 'account_changed'
  | 'oauth_settings_cleanup_failed'
  | 'unclassified';

/** A provider request's own failure, by its code. */
const REMOTE_REQUEST_FAILURES = {
  validation_failed: 'remote_request_invalid',
  throttled: 'remote_throttled',
  provider_unavailable: 'remote_unavailable',
  ambiguous: 'remote_outcome_unknown',
} as const satisfies Record<ManagedProviderRequestError['code'], string>;

export interface InstallationConnectionRevocation {
  readonly accounts: readonly ConnectionRevocationOutcome[];
  readonly revoked: number;
  readonly alreadyRevoked: number;
  readonly failed: number;
  /** Every account in scope is revoked. */
  readonly done: boolean;
}

const KIND_ORDER: Record<ConnectionAccount['policy']['kind'], number> = { managed: 0, mcp: 1, api: 2 };

/**
 * Revoke every connection account of one installation, or only the listed
 * accounts, or only one member's. Safe to repeat: an account already
 * revoked has its dependents and OAuth settings cleaned again and is
 * reported as such.
 */
export async function revokeInstallationConnections(
  env: PlatformEnv,
  options: {
    connectionAccountIds?: readonly string[];
    ownerMembershipId?: string;
    config?: ConfigStore;
    settings?: SettingsStore;
    providers?: ManagedConnectionProviderRegistry;
  } = {},
): Promise<InstallationConnectionRevocation> {
  if (!requireInstallationScope(env)) {
    throw new InstallationContextError(
      'installation_context_missing',
      'Connections are revoked for one installation of a deployment serving many.',
    );
  }
  const config = options.config ?? getConfigStore(env);
  const settings = options.settings ?? getSettingsStore(env);
  const service = new ConnectionAccountService({
    config,
    settings,
    managedProviders: options.providers ?? await resolveDefaultManagedConnectionProviderRegistry(env),
  });
  const accounts: ConnectionAccount[] = [];
  for (const installation of await config.listWorkspaceInstallations()) {
    accounts.push(...await config.listConnectionAccounts(installation.workspaceId));
  }
  const selected = accounts
    .filter((account) => !options.connectionAccountIds || options.connectionAccountIds.includes(account.id))
    .filter((account) => !options.ownerMembershipId || account.ownerMembershipId === options.ownerMembershipId)
    .sort((left, right) => KIND_ORDER[left.policy.kind] - KIND_ORDER[right.policy.kind] ||
      left.workspaceId.localeCompare(right.workspaceId) || left.createdAt - right.createdAt ||
      left.id.localeCompare(right.id));

  const outcomes: ConnectionRevocationOutcome[] = [];
  for (const account of selected) {
    const described = {
      connectionAccountId: account.id,
      workspaceId: account.workspaceId,
      kind: account.policy.kind,
      ...(account.policy.kind === 'managed' ? { adapterId: account.policy.adapterId } : {}),
      ownerKind: account.ownerKind,
    };
    let stage: 'revoke' | 'oauth_cleanup' = 'revoke';
    try {
      const revoked = await service.revokeWithSystemAuthority(account.id);
      stage = 'oauth_cleanup';
      await deleteRevokedConnectionOAuthSettings(revoked, env, settings);
      outcomes.push({ ...described, outcome: account.lifecycle === 'revoked' ? 'already_revoked' : 'revoked' });
    } catch (error) {
      const code = stage === 'oauth_cleanup' ? 'oauth_settings_cleanup_failed' : revocationFailureCode(error);
      const name = error instanceof Error ? error.name : 'Error';
      outcomes.push({ ...described, outcome: 'failed', error: name, code });
      // Content-free: the kind, the provider and the code, never an ID, message or secret.
      console.warn(JSON.stringify({
        component: 'connections', event: 'installation_connection_revoke_failed',
        kind: described.kind, ...(described.adapterId ? { adapterId: described.adapterId } : {}), code,
      }));
    }
  }
  const count = (outcome: ConnectionRevocationOutcome['outcome']) =>
    outcomes.filter((entry) => entry.outcome === outcome).length;
  return {
    accounts: outcomes,
    revoked: count('revoked'),
    alreadyRevoked: count('already_revoked'),
    failed: count('failed'),
    done: count('failed') === 0,
  };
}

function revocationFailureCode(error: unknown): RevocationFailureCode {
  if (error instanceof ManagedConnectionProviderUnavailableError) return 'provider_not_registered';
  if (error instanceof ManagedProviderRequestError) return REMOTE_REQUEST_FAILURES[error.code];
  if (error instanceof ConnectionScheduleConflictError) return 'dependent_schedules_changed';
  if (error instanceof ConnectionAccountRevisionConflictError) return 'account_changed';
  if (error instanceof Error && error.message === COMPOSIO_KEY_MISSING) return 'provider_not_configured';
  if (error instanceof Error && error.message === COMPOSIO_REVOKE_FAILED) return 'remote_revoke_failed';
  return 'unclassified';
}
