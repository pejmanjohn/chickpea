import { saveConnectionAccountSecret, tombstoneConnectionAccountSecret } from '../config/connector-secrets.ts';
import { isMcpToolReviewRequired } from '../config/mcp-access.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import type { AgentConnectionBinding, ConnectionAccount } from '../config/types.ts';
import type { ProductTelemetryCapture } from '../telemetry/client.ts';
import type { ProductTelemetryEventInput } from '../telemetry/events.ts';

/** The stores a connection credential is written through. */
export interface ConnectionCredentialStores {
  config: Pick<ConfigStore, 'putConnectionAccount'>;
  settings: SettingsStore;
  platformEnv?: PlatformEnv | undefined;
  productTelemetry?: ProductTelemetryCapture | undefined;
}

type ConnectionReadySurface = Extract<ProductTelemetryEventInput, { event: 'connection_ready' }>['surface'];

interface ConnectionEntry {
  account: ConnectionAccount;
  binding: AgentConnectionBinding;
}

/** Mark an account ready, fenced on the revision it was read at. */
export async function markConnectionAccountReady(
  stores: Pick<ConnectionCredentialStores, 'config' | 'productTelemetry'>,
  { account, binding }: ConnectionEntry,
  changes: Partial<Pick<ConnectionAccount, 'policy' | 'identity'>>,
  surface: ConnectionReadySurface,
): Promise<ConnectionAccount> {
  const ready = await stores.config.putConnectionAccount(
    { ...account, ...changes, lifecycle: 'ready' },
    account.revision,
  );
  if (account.lifecycle !== 'ready' &&
      !(ready.policy.kind === 'mcp' && isMcpToolReviewRequired(ready.policy))) {
    stores.productTelemetry?.capture({
      event: 'connection_ready',
      workspaceId: ready.workspaceId,
      agentId: binding.agentId,
      connectionKind: ready.policy.kind,
      ownerKind: ready.ownerKind,
      surface,
    });
  }
  return ready;
}

/**
 * Save a credential into its account's secret slot and mark the account
 * ready. When marking it ready fails and `retired` reports the slot no longer
 * serves the credential policy it was read with, the credential is
 * tombstoned so it cannot outlive that policy.
 */
export async function saveConnectionCredential(
  stores: ConnectionCredentialStores,
  entry: ConnectionEntry,
  credential: string,
  options: {
    changes?: Partial<Pick<ConnectionAccount, 'policy' | 'identity'>>;
    surface: ConnectionReadySurface;
    retired: () => Promise<boolean | undefined>;
  },
): Promise<ConnectionAccount> {
  const { secretRefId } = entry.account;
  await saveConnectionAccountSecret(secretRefId, credential, stores.platformEnv, stores.settings);
  try {
    return await markConnectionAccountReady(stores, entry, options.changes ?? {}, options.surface);
  } catch (error) {
    if (await options.retired() === true) {
      await tombstoneConnectionAccountSecret(secretRefId, stores.platformEnv, stores.settings);
    }
    throw error;
  }
}
