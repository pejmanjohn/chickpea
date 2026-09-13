export interface UpgradeMigrations {
  d1: string;
  workerConfiguration: string;
  identity: string;
  configuration: string;
  work: string;
}

export interface UpgradeManifest {
  formatVersion: 1;
  version: string;
  storageGeneration: number;
  supportedOrigins: string[];
  recovery: 'previous-code-only' | 'gateway-transport-then-previous-code';
  migrations: UpgradeMigrations;
}

export type UpgradeCompatibility =
  | {
      status: 'supported';
      reason: 'unchanged-storage' | 'reviewed-configuration-transition';
    }
  | {
      status: 'unsupported';
      reason:
        | 'destination-not-newer'
        | 'origin-not-declared'
        | 'storage-generation-changed'
        | 'migration-content-changed';
    };

export function validateUpgradeManifest(value: unknown): UpgradeManifest;

export function evaluateUpgradeCompatibility(
  before: unknown,
  after: unknown,
): UpgradeCompatibility;
