import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  ASSERTION_TOKENS,
  CLEANUP_RESULTS,
  OBSERVER_IDS,
  PRIMARY_RESULTS,
  SUITES,
  type AssertionToken,
  type CleanupResult,
  type ObserverId,
  type PrimaryResult,
  type Suite,
} from '../schema.ts';
import type { RunReport } from '../state.ts';
import { isNodeError } from './errors.ts';

export type EvidenceSafetyErrorCode =
  | 'UNSAFE_EVIDENCE_ROOT'
  | 'INVALID_EVIDENCE'
  | 'UNSAFE_EVIDENCE'
  | 'EVIDENCE_EXISTS';

export class EvidenceSafetyError extends Error {
  readonly code: EvidenceSafetyErrorCode;

  constructor(code: EvidenceSafetyErrorCode) {
    super(code);
    this.name = 'EvidenceSafetyError';
    this.code = code;
  }
}

export interface EvidenceRun {
  readonly directory: string;
  readonly runId: string;
}

export interface FailureCapsule {
  schemaVersion: 'chickpea-live-failure/v1';
  runId: string;
  result: Exclude<PrimaryResult, 'pass'>;
  variantId: string;
  stepId: string;
  observerIds: readonly ObserverId[];
  expectedTokens: readonly AssertionToken[];
  observedTokens: readonly AssertionToken[];
  revisions: { before: string; observed: string };
  attempt: number;
  pollTiming: { attempts: number; elapsedMs: number; deadlineMs: number };
  upstreamErrorCategory:
    | 'none'
    | 'provider_unavailable'
    | 'provider_rate_limited'
    | 'authority_denied'
    | 'target_drift'
    | 'observer_timeout'
    | 'cleanup_ambiguous';
  cleanup: { beforeAliases: readonly string[]; afterAliases: readonly string[] };
}

export interface SafeRunSummary {
  schemaVersion: 'chickpea-live-summary/v1';
  runId: string;
  suite: Suite;
  manifestDigest: string;
  targetFingerprint: string;
  repositoryRevision: string;
  servingVersion: string;
  aggregate: RunReport['aggregate'];
  declaredVariantIds: readonly string[];
  executedVariantIds: readonly string[];
  primaryCounts: Record<PrimaryResult, number>;
  cleanupCounts: Record<CleanupResult, number>;
  postflight: {
    targetIdentityMatches: boolean;
    missingCount: number;
    unexpectedCount: number;
    unresolvedCount: number;
  };
}

export function createEvidenceRun(input: {
  parent: string;
  runId: string;
  repositoryRoot: string;
  packageRoots?: readonly string[];
}): EvidenceRun {
  requireAlias(input.runId);
  const parent = canonicalDirectory(input.parent);
  const forbiddenRoots = [input.repositoryRoot, ...(input.packageRoots ?? [])].map(canonicalDirectory);
  if (forbiddenRoots.some((root) => isWithin(parent, root))) fail('UNSAFE_EVIDENCE_ROOT');
  const directory = resolve(parent, input.runId);
  if (!isWithin(directory, parent) || directory === parent) fail('UNSAFE_EVIDENCE_ROOT');
  try {
    mkdirSync(directory, { mode: 0o700, recursive: false });
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') fail('EVIDENCE_EXISTS');
    throw error;
  }
  return Object.freeze({ directory, runId: input.runId });
}

export function writeFailureCapsule(run: EvidenceRun, input: FailureCapsule): string {
  validateFailureCapsule(input);
  if (input.runId !== run.runId) fail('INVALID_EVIDENCE');
  return writeJson(run.directory, `failure.${input.variantId}.json`, input);
}

export function writeRunSummary(run: EvidenceRun, input: SafeRunSummary): string {
  validateRunSummary(input);
  if (input.runId !== run.runId) fail('INVALID_EVIDENCE');
  return writeJson(run.directory, 'summary.json', input);
}

function validateFailureCapsule(input: FailureCapsule): void {
  requireRecord(input);
  exactKeys(input, [
    'schemaVersion', 'runId', 'result', 'variantId', 'stepId', 'observerIds',
    'expectedTokens', 'observedTokens', 'revisions', 'attempt', 'pollTiming',
    'upstreamErrorCategory', 'cleanup',
  ]);
  if (input.schemaVersion !== 'chickpea-live-failure/v1'
    || !(PRIMARY_RESULTS as readonly string[]).includes(input.result)) fail('INVALID_EVIDENCE');
  requireAlias(input.runId);
  requireAlias(input.variantId);
  requireAlias(input.stepId);
  requireEnumArray(input.observerIds, OBSERVER_IDS);
  requireEnumArray(input.expectedTokens, ASSERTION_TOKENS);
  requireEnumArray(input.observedTokens, ASSERTION_TOKENS);
  requireRecord(input.revisions);
  exactKeys(input.revisions, ['before', 'observed']);
  requireSafeScalar(input.revisions.before);
  requireSafeScalar(input.revisions.observed);
  requirePositive(input.attempt);
  requireRecord(input.pollTiming);
  exactKeys(input.pollTiming, ['attempts', 'elapsedMs', 'deadlineMs']);
  requirePositive(input.pollTiming.attempts);
  requireNonNegative(input.pollTiming.elapsedMs);
  requirePositive(input.pollTiming.deadlineMs);
  if (![
    'none', 'provider_unavailable', 'provider_rate_limited', 'authority_denied',
    'target_drift', 'observer_timeout', 'cleanup_ambiguous',
  ].includes(input.upstreamErrorCategory)) fail('INVALID_EVIDENCE');
  requireRecord(input.cleanup);
  exactKeys(input.cleanup, ['beforeAliases', 'afterAliases']);
  for (const alias of [...input.cleanup.beforeAliases, ...input.cleanup.afterAliases]) requireAlias(alias);
  rejectUnsafe(input);
}

function validateRunSummary(input: SafeRunSummary): void {
  requireRecord(input);
  exactKeys(input, [
    'schemaVersion', 'runId', 'suite', 'manifestDigest', 'targetFingerprint',
    'repositoryRevision', 'servingVersion', 'aggregate', 'declaredVariantIds',
    'executedVariantIds', 'primaryCounts', 'cleanupCounts', 'postflight',
  ]);
  if (input.schemaVersion !== 'chickpea-live-summary/v1'
    || !(SUITES as readonly string[]).includes(input.suite)
    || !['pass', 'fail', 'blocked', 'ambiguous', 'infrastructure_error', 'cleanup_failed', 'incomplete']
      .includes(input.aggregate)) fail('INVALID_EVIDENCE');
  requireAlias(input.runId);
  requireDigest(input.manifestDigest);
  requireDigest(input.targetFingerprint);
  requireSafeScalar(input.repositoryRevision);
  requireSafeScalar(input.servingVersion);
  for (const variantId of [...input.declaredVariantIds, ...input.executedVariantIds]) requireAlias(variantId);
  validateCountRecord(input.primaryCounts, PRIMARY_RESULTS);
  validateCountRecord(input.cleanupCounts, CLEANUP_RESULTS);
  requireRecord(input.postflight);
  exactKeys(input.postflight, [
    'targetIdentityMatches', 'missingCount', 'unexpectedCount', 'unresolvedCount',
  ]);
  if (typeof input.postflight.targetIdentityMatches !== 'boolean') fail('INVALID_EVIDENCE');
  requireNonNegative(input.postflight.missingCount);
  requireNonNegative(input.postflight.unexpectedCount);
  requireNonNegative(input.postflight.unresolvedCount);
  rejectUnsafe(input);
}

function validateCountRecord(
  input: Record<string, number>,
  keys: readonly string[],
): void {
  requireRecord(input);
  exactKeys(input, keys);
  for (const key of keys) requireNonNegative(input[key]);
}

function writeJson(directory: string, fileName: string, input: unknown): string {
  const path = resolve(directory, fileName);
  if (!isWithin(path, directory)) fail('UNSAFE_EVIDENCE_ROOT');
  let descriptor: number;
  try {
    descriptor = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') fail('EVIDENCE_EXISTS');
    throw error;
  }
  try {
    writeSync(descriptor, `${JSON.stringify(input, null, 2)}\n`, undefined, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return path;
}

function canonicalDirectory(path: string): string {
  if (!isAbsolute(path)) fail('UNSAFE_EVIDENCE_ROOT');
  try {
    return realpathSync(path);
  } catch {
    fail('UNSAFE_EVIDENCE_ROOT');
  }
}

function isWithin(candidate: string, root: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function requireAlias(input: unknown): asserts input is string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(input)
    || privateCoordinate(input)) fail('UNSAFE_EVIDENCE');
}

function requireSafeScalar(input: unknown): asserts input is string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 256) fail('INVALID_EVIDENCE');
  rejectUnsafe(input);
}

function requireDigest(input: unknown): asserts input is string {
  if (typeof input !== 'string' || !/^sha256:[A-Za-z0-9_-]{3,128}$/u.test(input)) {
    fail('INVALID_EVIDENCE');
  }
}

function requireEnumArray<const Value extends string>(
  input: unknown,
  values: readonly Value[],
): asserts input is readonly Value[] {
  if (!Array.isArray(input) || input.some((value) => !values.includes(value))) fail('INVALID_EVIDENCE');
}

function requirePositive(input: unknown): asserts input is number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) fail('INVALID_EVIDENCE');
}

function requireNonNegative(input: unknown): asserts input is number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) fail('INVALID_EVIDENCE');
}

function requireRecord(input: unknown): asserts input is Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_EVIDENCE');
}

function exactKeys(input: object, allowed: readonly string[]): void {
  const keys = new Set(allowed);
  if (Object.keys(input).length !== allowed.length || Object.keys(input).some((key) => !keys.has(key))) {
    fail('INVALID_EVIDENCE');
  }
}

function rejectUnsafe(input: unknown): void {
  if (Array.isArray(input)) {
    input.forEach(rejectUnsafe);
    return;
  }
  if (input !== null && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) {
      if (/(?:message|body|url|header|cookie|stack|screenshot|transcript|credential|secret|raw)/iu.test(key)) {
        fail('UNSAFE_EVIDENCE');
      }
      rejectUnsafe(value);
    }
    return;
  }
  if (typeof input === 'string' && (/(?:https?:\/\/|xox[baprs]-|sk-[A-Za-z0-9]|Bearer\s+|-----BEGIN .*PRIVATE KEY-----)/iu.test(input)
    || privateCoordinate(input))) fail('UNSAFE_EVIDENCE');
}

function privateCoordinate(input: string): boolean {
  return /^(?:[TCUWDA][A-Z0-9]{8,}|ca_[A-Za-z0-9_-]{6,}|ac_[A-Za-z0-9_-]{6,})$/u.test(input);
}

function fail(code: EvidenceSafetyErrorCode): never {
  throw new EvidenceSafetyError(code);
}
