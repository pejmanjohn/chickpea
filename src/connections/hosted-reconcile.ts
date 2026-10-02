/**
 * After the operator changes a deployment's Composio key, `prepare
 * --reconcile` bumps the platform record's provider generation, and every
 * installation's managed accounts still carry the previous one: they report
 * reconnect, and the schedules that depend on them pause. Admin's retry
 * reconciles a standalone installation, but under installation tenancy it is
 * refused, so a host drives this per installation instead.
 *
 * Each call works through one installation's accounts with the deployment
 * key, exactly as Admin's retry loop does, until none is left to inspect, a
 * batch makes no progress, or its deadline passes. The installation's account
 * revisions are the checkpoint, so a host simply calls it again until it is
 * done. It never completes the platform's reconciliation: that stays the
 * operator's, once, for the whole deployment.
 */
import { resolveComposioConfiguration } from '../config/composio-settings.ts';
import { InstallationContextError, requireInstallationScope } from '../config/installation-scope.ts';
import { getConfigStore, type PlatformEnv } from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import { ComposioPlatformConfigurationError } from './composio-setup.ts';
import { inspectComposioConnectedAccount } from './providers/composio.ts';
import { reconcileManagedProviderAccounts, type ManagedProviderAccountInspection } from './store.ts';

type Inspect = (input: {
  apiKey: string;
  accountRef: string;
  principalRef: string;
  toolkit: string;
  signal: AbortSignal;
}) => Promise<ManagedProviderAccountInspection>;

export interface InstallationReconciliation {
  /** Accounts confirmed under the platform's current generation in this call. */
  readonly restored: number;
  /** Accounts that need their owner to reconnect, recorded in this call. */
  readonly needsAttention: number;
  /** Accounts still to inspect: over the batch cap, transient, or conflicting. */
  readonly retryable: number;
  /** Nothing is left to reconcile in this installation. */
  readonly done: boolean;
}

/**
 * Reconcile one installation's managed connections with the deployment's
 * prepared Composio platform. Refused on standalone, and while the platform
 * record is missing or itself awaiting reconciliation.
 */
export async function reconcileInstallationManagedConnections(
  env: PlatformEnv,
  options: {
    /** When to stop starting batches, in epoch milliseconds. */
    deadlineAt: number;
    /** Account inspections per batch (Composio requests), 1 to 100. */
    maxInspections?: number;
    config?: ConfigStore;
    inspect?: Inspect;
    now?: () => number;
  },
): Promise<InstallationReconciliation> {
  if (!requireInstallationScope(env)) {
    throw new InstallationContextError(
      'installation_context_missing',
      'Managed connections are reconciled for one installation of a deployment serving many.',
    );
  }
  const resolved = await resolveComposioConfiguration({ env });
  // A changed or damaged platform record is the operator's to reconcile first.
  if (resolved.reconciliationPending) {
    throw new ComposioPlatformConfigurationError(
      'The deployment\'s Composio platform is awaiting the operator\'s reconcile.',
    );
  }
  if (!resolved.apiKey || resolved.authConfigGeneration === undefined) {
    throw new ComposioPlatformConfigurationError('The deployment\'s Composio platform is not prepared.');
  }
  const apiKey = resolved.apiKey;
  const now = options.now ?? Date.now;
  const config = options.config ?? getConfigStore(env);
  const inspectAccount = options.inspect ?? inspectComposioConnectedAccount;
  const lineage = resolved.keyFingerprint ?? resolved.lastKeyFingerprint ?? '0'.repeat(24);
  let restored = 0;
  let needsAttention = 0;
  let retryable = 0;
  while (now() < options.deadlineAt) {
    const signal = AbortSignal.timeout(Math.max(1, options.deadlineAt - now()));
    const batch = await reconcileManagedProviderAccounts(config, {
      adapterId: 'composio',
      generation: resolved.generation,
      lineage,
      maxInspections: options.maxInspections ?? 25,
      inspect: async (account) => signal.aborted ? 'transient' : inspectAccount({ apiKey, ...account, signal }),
    });
    restored += batch.restored;
    needsAttention += batch.needsAttention;
    retryable = batch.retryable;
    if (batch.retryable === 0) return { restored, needsAttention, retryable, done: true };
    // No progress: what remains is transient or conflicting, and waits for the next call.
    if (batch.restored + batch.needsAttention === 0) break;
  }
  return { restored, needsAttention, retryable, done: false };
}
