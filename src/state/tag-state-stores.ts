import { SettingsStoreLogic } from '../config/settings-store.ts';
import { SnapshotStoreLogic } from '../config/snapshot-store.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { ConfigStoreLogic } from '../config/store.ts';
import {
  InstallationBindingLogic,
  storeInstallationIdentity,
} from '../identity/installation-binding.ts';
import { IdentityStoreLogic } from '../identity/store.ts';
import { ManagementStoreLogic } from '../management/store.ts';
import { MemoryStoreLogic } from '../memory/store.ts';
import { RoutineStoreLogic } from '../routines/store.ts';
import { SlackStateLogic } from '../slack/claim-store.ts';
import { GatewayInboxStoreLogic } from '../slack/gateway/inbox.ts';
import { SlackRunPresentationStoreLogic } from '../slack/run-presentations.ts';
import { TurnJobStoreLogic } from '../slack/turn-jobs.ts';
import { UiSurfaceStoreLogic } from '../slack/ui/surface-store.ts';
import { UsageStoreLogic } from '../usage/store.ts';
import { WorkStoreLogic } from '../work/store.ts';
import { InstallationObjectInventoryLogic } from './object-inventory.ts';
import type { StateDb } from './state-db.ts';

/** Every store of the Cloudflare state Durable Object (`TagStateStore`), over its one database. */
export interface TagStateStores {
  installationBinding: InstallationBindingLogic;
  objectInventory: InstallationObjectInventoryLogic;
  identity: IdentityStoreLogic;
  config: ConfigStoreLogic;
  snapshots: SnapshotStoreLogic;
  slack: SlackStateLogic;
  settings: SettingsStoreLogic;
  turnJobs: TurnJobStoreLogic;
  gatewayInbox: GatewayInboxStoreLogic;
  presentations: SlackRunPresentationStoreLogic;
  uiSurfaces: UiSurfaceStoreLogic;
  memory: MemoryStoreLogic;
  routines: RoutineStoreLogic;
  usage: UsageStoreLogic;
  work: WorkStoreLogic;
  management: ManagementStoreLogic;
}

/**
 * Build the state Durable Object's stores over its database. Same
 * construction order as the node backend: each logic class creates its own
 * tables (and the config store runs migrations + seedOnce), so a fresh store
 * is fully seeded before it answers its first RPC. Kept free of
 * `cloudflare:workers` so tests build the same set over Node SQLite.
 */
export function buildTagStateStores(
  db: StateDb,
  env: PlatformEnv,
  options: { gatewayLeaseOwner: string },
): TagStateStores {
  const installationBinding = new InstallationBindingLogic(db, env);
  const objectInventory = new InstallationObjectInventoryLogic(db, env);
  const stores = {
    installationBinding,
    objectInventory,
    identity: new IdentityStoreLogic(db, {
      installation: () => storeInstallationIdentity(installationBinding, env),
    }),
    config: new ConfigStoreLogic(db),
    snapshots: new SnapshotStoreLogic(db),
    slack: new SlackStateLogic(db),
    settings: new SettingsStoreLogic(db),
    turnJobs: new TurnJobStoreLogic(db, Date.now, objectInventory),
    gatewayInbox: new GatewayInboxStoreLogic(db, Date.now, {}, { leaseOwner: options.gatewayLeaseOwner }),
    presentations: new SlackRunPresentationStoreLogic(db),
    uiSurfaces: new UiSurfaceStoreLogic(db),
    memory: new MemoryStoreLogic(db),
    routines: new RoutineStoreLogic(db, Date.now, objectInventory),
    usage: new UsageStoreLogic(db),
    management: new ManagementStoreLogic(db),
  } as Omit<TagStateStores, 'work'>;
  return {
    ...stores,
    work: new WorkStoreLogic(db, {
      env: {
        TAG_RUN_BODY_RETENTION_DAYS:
          typeof env.TAG_RUN_BODY_RETENTION_DAYS === 'string'
            ? env.TAG_RUN_BODY_RETENTION_DAYS
            : undefined,
      },
    }),
  };
}
