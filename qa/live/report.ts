import {
  CLEANUP_RESULTS,
  PRIMARY_RESULTS,
  type Suite,
} from './schema.ts';
import type { CaseOutcome, RunReport } from './state.ts';

export interface AggregateRunReportInput {
  suite: Suite;
  manifestDigest: string;
  targetFingerprint: string;
  repositoryRevision: string;
  servingVersion: string;
  declaredVariantIds: readonly string[];
  cases: readonly CaseOutcome[];
}

export function aggregateRunReport(input: AggregateRunReportInput): RunReport {
  const declaredVariantIds = unique(input.declaredVariantIds);
  const casesByVariant = new Map(input.cases.map((outcome) => [outcome.variantId, outcome]));
  const executedVariantIds = declaredVariantIds.filter((variantId) => casesByVariant.has(variantId));
  const missingVariantIds = declaredVariantIds.filter((variantId) => !casesByVariant.has(variantId));
  const cases = executedVariantIds.map((variantId) => casesByVariant.get(variantId) as CaseOutcome);
  const blockedVariantIds = declaredVariantIds.filter((variantId) => {
    const result = casesByVariant.get(variantId)?.primary.result;
    return result === undefined || result === 'blocked';
  });
  const primaryCounts = count(PRIMARY_RESULTS, cases.map((outcome) => outcome.primary.result));
  const cleanupCounts = count(CLEANUP_RESULTS, cases.map((outcome) => outcome.cleanup));
  return {
    schemaVersion: 'chickpea-live-report/v1',
    suite: input.suite,
    manifestDigest: input.manifestDigest,
    targetFingerprint: input.targetFingerprint,
    repositoryRevision: input.repositoryRevision,
    servingVersion: input.servingVersion,
    aggregate: aggregateResult(cases, missingVariantIds),
    inventory: {
      manifestDeclared: { count: declaredVariantIds.length, variantIds: declaredVariantIds },
      executed: { count: executedVariantIds.length, variantIds: executedVariantIds },
      blocked: { count: blockedVariantIds.length, variantIds: blockedVariantIds },
    },
    primaryCounts,
    cleanupCounts,
    cases,
  };
}

function aggregateResult(
  cases: readonly CaseOutcome[],
  missingVariantIds: readonly string[],
): RunReport['aggregate'] {
  if (missingVariantIds.length > 0) return 'incomplete';
  const primary = cases.map((outcome) => outcome.primary.result);
  if (primary.includes('infrastructure_error')) return 'infrastructure_error';
  if (primary.includes('ambiguous')) return 'ambiguous';
  if (primary.includes('blocked')) return 'blocked';
  if (primary.includes('fail')) return 'fail';
  if (cases.some((outcome) => outcome.cleanup === 'failed')) return 'cleanup_failed';
  return 'pass';
}

function count<const Values extends readonly string[]>(
  values: Values,
  observed: readonly string[],
): Record<Values[number], number> {
  return Object.fromEntries(values.map((value) => [
    value,
    observed.filter((candidate) => candidate === value).length,
  ])) as Record<Values[number], number>;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
