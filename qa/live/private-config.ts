import { join } from 'node:path';

import {
  validateTargetSuitePolicy,
  type TargetSuitePolicy,
} from './manifest.ts';
import {
  PHASE_ONE_TARGET_ALIASES,
  type PhaseOneTargetAlias,
} from './schema.ts';

const ENV_ALIAS = /^env-(amber|cobalt|fern)-[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface PrivateTargetAliases extends TargetSuitePolicy {
  readonly targetAlias: PhaseOneTargetAlias;
  readonly transport: 'gateway' | 'events';
  readonly workerAlias: string;
  readonly workspaceAlias: string;
  readonly slackAppAlias: string;
  readonly providerProjectAlias: string;
  readonly evidenceRootAlias: string;
  readonly timezoneAlias: string;
  readonly providerReadOnlyAuthConfigAlias: string;
  readonly bindingAliases: Readonly<Record<string, string>>;
}

/** Public target fields shared with the existing verifier overlay contract. */
export interface DoctorTargetOverlay extends TargetSuitePolicy {
  readonly targetAlias: PhaseOneTargetAlias;
  readonly transport: 'gateway' | 'events';
  readonly workerAlias: string;
  readonly workspaceAlias: string;
  readonly slackAppAlias: string;
  readonly providerProjectAlias: string;
  readonly evidenceRootAlias: string;
}

export interface PrivateLiveConfig {
  schemaVersion: 'chickpea-live-private-config/v1';
  qaTargetAllowlist: PhaseOneTargetAlias[];
  targets: Partial<Record<PhaseOneTargetAlias, PrivateTargetAliases>>;
}

export interface PrivateAliasResolvers {
  readOnly(alias: string): Promise<string>;
  /** Mutating alias authority is intentionally not used by deterministic verification. */
  mutation?: (alias: string) => Promise<string>;
}

export interface DoctorTargetResolution extends TargetSuitePolicy {
  readonly transport: 'gateway' | 'events';
  workerName(): Promise<string>;
  workspaceId(): Promise<string>;
  slackAppId(): Promise<string>;
  providerProjectId(): Promise<string>;
  providerReadOnlyAuthConfigId(): Promise<string>;
  timezone(): Promise<string>;
  evidenceRoot(): Promise<string>;
  targetLockPath(): Promise<string>;
  runJournalPath(runId: string): Promise<string>;
  bindingIdentities(): Promise<Record<string, string>>;
}

export type PrivateConfigErrorCode =
  | 'INVALID_PRIVATE_CONFIG'
  | 'TARGET_NOT_ALLOWLISTED'
  | 'TARGET_ALIAS_MISMATCH'
  | 'PRIVATE_ALIAS_UNAVAILABLE'
  | 'INVALID_RUN_ID';

export class PrivateConfigError extends Error {
  readonly code: PrivateConfigErrorCode;

  constructor(code: PrivateConfigErrorCode) {
    super(code);
    this.name = 'PrivateConfigError';
    this.code = code;
  }
}

/**
 * Resolve exactly one selected Phase 1 target. The environment layer supplies
 * opaque aliases; the verifier owns validation, path derivation, and reads.
 */
export function createDoctorTargetResolution(
  overlayInput: DoctorTargetOverlay,
  config: PrivateLiveConfig,
  resolvers: PrivateAliasResolvers,
): DoctorTargetResolution {
  const overlay = validateOverlay(overlayInput);
  const target = validatePrivateConfig(config);
  if (target.targetAlias !== overlay.targetAlias) {
    throw new PrivateConfigError('TARGET_NOT_ALLOWLISTED');
  }
  if (!sameTarget(target, overlay)) throw new PrivateConfigError('TARGET_ALIAS_MISMATCH');
  const read = memoizedAliasReader(resolvers.readOnly);
  const bindings = Object.entries(target.bindingAliases)
    .sort(([left], [right]) => left.localeCompare(right));

  return Object.freeze({
    targetAlias: target.targetAlias,
    transport: target.transport,
    allowedSuites: target.allowedSuites,
    allowedVariants: target.allowedVariants,
    workerName: () => read(target.workerAlias),
    workspaceId: () => read(target.workspaceAlias),
    slackAppId: () => read(target.slackAppAlias),
    providerProjectId: () => read(target.providerProjectAlias),
    providerReadOnlyAuthConfigId: () => read(target.providerReadOnlyAuthConfigAlias),
    timezone: () => read(target.timezoneAlias),
    evidenceRoot: () => read(target.evidenceRootAlias),
    targetLockPath: async () => join(await read(target.evidenceRootAlias), 'target.lock'),
    runJournalPath: async (runId: string) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(runId)) {
        throw new PrivateConfigError('INVALID_RUN_ID');
      }
      return join(await read(target.evidenceRootAlias), 'runs', `${runId}.jsonl`);
    },
    bindingIdentities: async () => Object.fromEntries(await Promise.all(
      bindings.map(async ([name, alias]) => [name, await read(alias)] as const),
    )),
  });
}

export function validatePrivateConfig(config: PrivateLiveConfig): PrivateTargetAliases {
  if (!isRecord(config)
    || !exactKeys(config, ['schemaVersion', 'qaTargetAllowlist', 'targets'])
    || config.schemaVersion !== 'chickpea-live-private-config/v1'
    || !Array.isArray(config.qaTargetAllowlist)
    || config.qaTargetAllowlist.length !== 1
    || !(PHASE_ONE_TARGET_ALIASES as readonly unknown[]).includes(config.qaTargetAllowlist[0])
    || !isRecord(config.targets)) {
    throw new PrivateConfigError('INVALID_PRIVATE_CONFIG');
  }
  const keys = Object.keys(config.targets);
  const alias = config.qaTargetAllowlist[0]!;
  if (keys.length !== 1 || keys[0] !== alias) {
    throw new PrivateConfigError('INVALID_PRIVATE_CONFIG');
  }
  return validateTarget(config.targets[alias]);
}

function validateTarget(input: unknown): PrivateTargetAliases {
  if (!isRecord(input)
    || !exactKeys(input, [
      'targetAlias', 'transport', 'workerAlias', 'workspaceAlias', 'slackAppAlias',
      'providerProjectAlias', 'evidenceRootAlias', 'timezoneAlias',
      'providerReadOnlyAuthConfigAlias', 'bindingAliases', 'allowedSuites', 'allowedVariants',
    ])
    || !(PHASE_ONE_TARGET_ALIASES as readonly unknown[]).includes(input.targetAlias)
    || (input.transport !== 'gateway' && input.transport !== 'events')
    || !validEnvironmentAlias(input.workerAlias, input.targetAlias)
    || !validEnvironmentAlias(input.workspaceAlias, input.targetAlias)
    || !validEnvironmentAlias(input.slackAppAlias, input.targetAlias)
    || !validEnvironmentAlias(input.providerProjectAlias, input.targetAlias)
    || !validEnvironmentAlias(input.evidenceRootAlias, input.targetAlias)
    || !validEnvironmentAlias(input.timezoneAlias, input.targetAlias)
    || !validEnvironmentAlias(input.providerReadOnlyAuthConfigAlias, input.targetAlias)
    || !isRecord(input.bindingAliases)
    || !('AUTH_DB' in input.bindingAliases)
    || !('TAG_STATE' in input.bindingAliases)
    || Object.entries(input.bindingAliases).some(([binding, alias]) =>
      !/^[A-Z][A-Z0-9_]{0,63}$/u.test(binding)
      || !validEnvironmentAlias(alias, input.targetAlias)
    )) {
    throw new PrivateConfigError('INVALID_PRIVATE_CONFIG');
  }
  let policy: TargetSuitePolicy;
  try {
    policy = validateTargetSuitePolicy({
      targetAlias: input.targetAlias,
      allowedSuites: input.allowedSuites,
      allowedVariants: input.allowedVariants,
    });
  } catch {
    throw new PrivateConfigError('INVALID_PRIVATE_CONFIG');
  }
  return Object.freeze({
    targetAlias: policy.targetAlias,
    transport: input.transport,
    workerAlias: input.workerAlias as string,
    workspaceAlias: input.workspaceAlias as string,
    slackAppAlias: input.slackAppAlias as string,
    providerProjectAlias: input.providerProjectAlias as string,
    evidenceRootAlias: input.evidenceRootAlias as string,
    timezoneAlias: input.timezoneAlias as string,
    providerReadOnlyAuthConfigAlias: input.providerReadOnlyAuthConfigAlias as string,
    bindingAliases: Object.freeze({ ...(input.bindingAliases as Record<string, string>) }),
    allowedSuites: policy.allowedSuites,
    allowedVariants: policy.allowedVariants,
  });
}

function validateOverlay(input: unknown): DoctorTargetOverlay {
  if (!isRecord(input)
    || !(PHASE_ONE_TARGET_ALIASES as readonly unknown[]).includes(input.targetAlias)
    || (input.transport !== 'gateway' && input.transport !== 'events')
    || !validEnvironmentAlias(input.workerAlias, input.targetAlias)
    || !validEnvironmentAlias(input.workspaceAlias, input.targetAlias)
    || !validEnvironmentAlias(input.slackAppAlias, input.targetAlias)
    || !validEnvironmentAlias(input.providerProjectAlias, input.targetAlias)
    || !validEnvironmentAlias(input.evidenceRootAlias, input.targetAlias)) {
    throw new PrivateConfigError('INVALID_PRIVATE_CONFIG');
  }
  let policy: TargetSuitePolicy;
  try {
    policy = validateTargetSuitePolicy({
      targetAlias: input.targetAlias,
      allowedSuites: input.allowedSuites,
      allowedVariants: input.allowedVariants,
    });
  } catch {
    throw new PrivateConfigError('INVALID_PRIVATE_CONFIG');
  }
  return {
    targetAlias: policy.targetAlias,
    transport: input.transport,
    workerAlias: input.workerAlias,
    workspaceAlias: input.workspaceAlias,
    slackAppAlias: input.slackAppAlias,
    providerProjectAlias: input.providerProjectAlias,
    evidenceRootAlias: input.evidenceRootAlias,
    allowedSuites: policy.allowedSuites,
    allowedVariants: policy.allowedVariants,
  };
}

function validEnvironmentAlias(input: unknown, target: unknown): input is string {
  if (typeof input !== 'string' || typeof target !== 'string' || !ENV_ALIAS.test(input)) return false;
  return input.startsWith(`env-${target}-`);
}

function sameTarget(left: PrivateTargetAliases, right: DoctorTargetOverlay): boolean {
  return left.targetAlias === right.targetAlias
    && left.transport === right.transport
    && left.workerAlias === right.workerAlias
    && left.workspaceAlias === right.workspaceAlias
    && left.slackAppAlias === right.slackAppAlias
    && left.providerProjectAlias === right.providerProjectAlias
    && left.evidenceRootAlias === right.evidenceRootAlias
    && sameSet(left.allowedSuites, right.allowedSuites)
    && sameSet(left.allowedVariants, right.allowedVariants);
}

function memoizedAliasReader(readOnly: (alias: string) => Promise<string>) {
  const cache = new Map<string, Promise<string>>();
  return (alias: string): Promise<string> => {
    let pending = cache.get(alias);
    if (pending === undefined) {
      pending = Promise.resolve().then(() => readOnly(alias)).then((value) => {
        if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
          throw new PrivateConfigError('PRIVATE_ALIAS_UNAVAILABLE');
        }
        return value;
      }).catch((error: unknown) => {
        if (error instanceof PrivateConfigError) throw error;
        throw new PrivateConfigError('PRIVATE_ALIAS_UNAVAILABLE');
      });
      cache.set(alias, pending);
    }
    return pending;
  };
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length
    && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function exactKeys(input: object, expected: readonly string[]): boolean {
  const actual = Object.keys(input).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}
