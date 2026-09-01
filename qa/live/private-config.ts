import type { LiveTargetOverlay } from './privacy.ts';

const ALIAS = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export interface PrivateTargetAliases {
  targetAlias: string;
  workerAlias: string;
  workspaceAlias: string;
  slackAppAlias: string;
  providerProjectAlias: string;
  evidenceRootAlias: string;
  timezoneAlias: string;
  providerReadOnlyAuthConfigAlias: string;
  bindingAliases: Record<string, string>;
}

export interface PrivateLiveConfig {
  schemaVersion: 'chickpea-live-private-config/v1';
  qaTargetAllowlist: string[];
  targets: Record<string, PrivateTargetAliases>;
}

export interface PrivateAliasResolvers {
  readOnly(alias: string): Promise<string>;
  /** Mutating authority is deliberately unavailable to the doctor resolution. */
  mutation?: (alias: string) => Promise<string>;
}

export interface DoctorTargetResolution {
  readonly targetAlias: string;
  workerName(): Promise<string>;
  workspaceId(): Promise<string>;
  slackAppId(): Promise<string>;
  providerProjectId(): Promise<string>;
  providerReadOnlyAuthConfigId(): Promise<string>;
  timezone(): Promise<string>;
  evidenceRoot(): Promise<string>;
  bindingIdentities(): Promise<Record<string, string>>;
}

export type PrivateConfigErrorCode =
  | 'INVALID_PRIVATE_CONFIG'
  | 'TARGET_NOT_ALLOWLISTED'
  | 'TARGET_ALIAS_MISMATCH'
  | 'PRIVATE_ALIAS_UNAVAILABLE';

export class PrivateConfigError extends Error {
  readonly code: PrivateConfigErrorCode;

  constructor(code: PrivateConfigErrorCode) {
    super(code);
    this.name = 'PrivateConfigError';
    this.code = code;
  }
}

/**
 * Validate the private alias map without resolving any referenced value. The
 * v1 runner intentionally accepts one positive QA target and no wildcard.
 */
export function createDoctorTargetResolution(
  overlay: LiveTargetOverlay,
  config: PrivateLiveConfig,
  resolvers: PrivateAliasResolvers,
): DoctorTargetResolution {
  const target = validatePrivateConfig(overlay, config);
  const read = memoizedAliasReader(resolvers.readOnly);
  const bindingEntries = Object.entries(target.bindingAliases).sort(([left], [right]) =>
    left.localeCompare(right)
  );

  return Object.freeze({
    targetAlias: overlay.targetAlias,
    workerName: () => read(target.workerAlias),
    workspaceId: () => read(target.workspaceAlias),
    slackAppId: () => read(target.slackAppAlias),
    providerProjectId: () => read(target.providerProjectAlias),
    providerReadOnlyAuthConfigId: () => read(target.providerReadOnlyAuthConfigAlias),
    timezone: () => read(target.timezoneAlias),
    evidenceRoot: () => read(target.evidenceRootAlias),
    bindingIdentities: async () => Object.fromEntries(await Promise.all(
      bindingEntries.map(async ([binding, alias]) => [binding, await read(alias)] as const),
    )),
  });
}

function validatePrivateConfig(
  overlay: LiveTargetOverlay,
  config: PrivateLiveConfig,
): PrivateTargetAliases {
  if (!isRecord(config)
    || config.schemaVersion !== 'chickpea-live-private-config/v1'
    || !Array.isArray(config.qaTargetAllowlist)
    || config.qaTargetAllowlist.length !== 1
    || !config.qaTargetAllowlist.every(validAlias)
    || !isRecord(config.targets)
    || Object.keys(config.targets).length !== 1) {
    throw new PrivateConfigError('INVALID_PRIVATE_CONFIG');
  }
  if (config.qaTargetAllowlist[0] !== overlay.targetAlias) {
    throw new PrivateConfigError('TARGET_NOT_ALLOWLISTED');
  }
  const target = config.targets[overlay.targetAlias];
  if (!isRecord(target)) throw new PrivateConfigError('TARGET_NOT_ALLOWLISTED');
  if (!exactKeys(target, [
    'targetAlias', 'workerAlias', 'workspaceAlias', 'slackAppAlias', 'providerProjectAlias',
    'evidenceRootAlias', 'timezoneAlias', 'providerReadOnlyAuthConfigAlias', 'bindingAliases',
  ])
    || !validAlias(target.targetAlias)
    || !validAlias(target.workerAlias)
    || !validAlias(target.workspaceAlias)
    || !validAlias(target.slackAppAlias)
    || !validAlias(target.providerProjectAlias)
    || !validAlias(target.evidenceRootAlias)
    || !validAlias(target.timezoneAlias)
    || !validAlias(target.providerReadOnlyAuthConfigAlias)
    || !isRecord(target.bindingAliases)
    || Object.keys(target.bindingAliases).length === 0
    || Object.entries(target.bindingAliases).some(([binding, alias]) =>
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(binding) || !validAlias(alias)
    )) {
    throw new PrivateConfigError('INVALID_PRIVATE_CONFIG');
  }
  if (target.targetAlias !== overlay.targetAlias
    || target.workerAlias !== overlay.workerAlias
    || target.workspaceAlias !== overlay.workspaceAlias
    || target.slackAppAlias !== overlay.slackAppAlias
    || target.providerProjectAlias !== overlay.providerProjectAlias
    || target.evidenceRootAlias !== overlay.evidenceRootAlias) {
    throw new PrivateConfigError('TARGET_ALIAS_MISMATCH');
  }
  return target as unknown as PrivateTargetAliases;
}

function memoizedAliasReader(readOnly: (alias: string) => Promise<string>) {
  const values = new Map<string, Promise<string>>();
  return (alias: string): Promise<string> => {
    let pending = values.get(alias);
    if (pending === undefined) {
      pending = Promise.resolve()
        .then(() => readOnly(alias))
        .then((value) => {
          if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
            throw new PrivateConfigError('PRIVATE_ALIAS_UNAVAILABLE');
          }
          return value;
        })
        .catch((error: unknown) => {
          if (error instanceof PrivateConfigError) throw error;
          throw new PrivateConfigError('PRIVATE_ALIAS_UNAVAILABLE');
        });
      values.set(alias, pending);
    }
    return pending;
  };
}

function validAlias(input: unknown): input is string {
  return typeof input === 'string' && ALIAS.test(input);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function exactKeys(input: object, allowed: readonly string[]): boolean {
  const keys = Object.keys(input);
  const accepted = new Set(allowed);
  return keys.every((key) => accepted.has(key));
}
