import { join } from 'node:path';

import type { LiveTargetOverlay } from './privacy.ts';
import { SUITES, type Suite } from './schema.ts';

const ALIAS = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface PrivateTargetAliases {
  targetAlias: string;
  transport: 'gateway' | 'events';
  workerAlias: string;
  workspaceAlias: string;
  slackAppAlias: string;
  providerProjectAlias: string;
  evidenceRootAlias: string;
  timezoneAlias: string;
  providerReadOnlyAuthConfigAlias: string;
  bindingAliases: Record<string, string>;
  allowedSuites?: Suite[];
  allowedVariants: string[];
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
  readonly transport: 'gateway' | 'events';
  workerName(): Promise<string>;
  workspaceId(): Promise<string>;
  slackAppId(): Promise<string>;
  providerProjectId(): Promise<string>;
  providerReadOnlyAuthConfigId(): Promise<string>;
  timezone(): Promise<string>;
  evidenceRoot(): Promise<string>;
  targetLockPath(): Promise<string>;
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
    transport: target.transport,
    workerName: () => read(target.workerAlias),
    workspaceId: () => read(target.workspaceAlias),
    slackAppId: () => read(target.slackAppAlias),
    providerProjectId: () => read(target.providerProjectAlias),
    providerReadOnlyAuthConfigId: () => read(target.providerReadOnlyAuthConfigAlias),
    timezone: () => read(target.timezoneAlias),
    evidenceRoot: () => read(target.evidenceRootAlias),
    targetLockPath: async () => join(await read(target.evidenceRootAlias), 'target.lock'),
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
    || config.qaTargetAllowlist.length === 0
    || !config.qaTargetAllowlist.every(validAlias)
    || new Set(config.qaTargetAllowlist).size !== config.qaTargetAllowlist.length
    || !isRecord(config.targets)
    || !same(Object.keys(config.targets).sort(), [...config.qaTargetAllowlist].sort())) {
    throw new PrivateConfigError('INVALID_PRIVATE_CONFIG');
  }
  if (!config.qaTargetAllowlist.includes(overlay.targetAlias)) {
    throw new PrivateConfigError('TARGET_NOT_ALLOWLISTED');
  }
  for (const [targetAlias, candidate] of Object.entries(config.targets)) {
    validateTargetAliases(targetAlias, candidate);
  }
  const target = config.targets[overlay.targetAlias];
  if (!isRecord(target)) throw new PrivateConfigError('TARGET_NOT_ALLOWLISTED');
  if (!same([...(target.allowedSuites ?? [])].sort(), [...(overlay.allowedSuites ?? [])].sort())) {
    throw new PrivateConfigError('TARGET_ALIAS_MISMATCH');
  }
  if (!same([...target.allowedVariants].sort(), [...overlay.allowedVariants].sort())) {
    throw new PrivateConfigError('TARGET_ALIAS_MISMATCH');
  }
  if (target.targetAlias !== overlay.targetAlias
    || target.transport !== overlay.transport
    || target.workerAlias !== overlay.workerAlias
    || target.workspaceAlias !== overlay.workspaceAlias
    || target.slackAppAlias !== overlay.slackAppAlias
    || target.providerProjectAlias !== overlay.providerProjectAlias
    || target.evidenceRootAlias !== overlay.evidenceRootAlias) {
    throw new PrivateConfigError('TARGET_ALIAS_MISMATCH');
  }
  return target as unknown as PrivateTargetAliases;
}

function validateTargetAliases(targetKey: string, input: unknown): void {
  if (!isRecord(input)) throw new PrivateConfigError('INVALID_PRIVATE_CONFIG');
  const target = input;
  if (!exactKeys(target, [
    'targetAlias', 'transport', 'workerAlias', 'workspaceAlias', 'slackAppAlias', 'providerProjectAlias',
    'evidenceRootAlias', 'timezoneAlias', 'providerReadOnlyAuthConfigAlias', 'bindingAliases', 'allowedSuites', 'allowedVariants',
  ])
    || !validAlias(target.targetAlias)
    || target.targetAlias !== targetKey
    || (target.transport !== 'gateway' && target.transport !== 'events')
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
    )
    || !validAllowedSuites(target.allowedSuites, targetKey)
    || !Array.isArray(target.allowedVariants)
    || target.allowedVariants.length === 0
    || !target.allowedVariants.every((variantId) => typeof variantId === 'string' && variantId.length > 0)
    || new Set(target.allowedVariants).size !== target.allowedVariants.length) {
    throw new PrivateConfigError('INVALID_PRIVATE_CONFIG');
  }
}

function validAllowedSuites(input: unknown, targetAlias: string): boolean {
  if (input === undefined) return true;
  return Array.isArray(input)
    && input.length > 0
    && input.every((suite) => typeof suite === 'string' && (SUITES as readonly string[]).includes(suite))
    && new Set(input).size === input.length
    && (targetAlias === 'dedicated-qa' || !input.includes('deep'));
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

function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
