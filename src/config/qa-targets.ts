/** Logical QA identities. Physical resource coordinates live in private registration. */
export const QA_TARGETS = Object.freeze(['amber', 'cobalt', 'violet'] as const);
export type QaTarget = typeof QA_TARGETS[number];
export const ORIGINAL_QA_TARGETS = Object.freeze(['amber', 'cobalt'] as const);

export function isQaTarget(value: unknown): value is QaTarget {
  return typeof value === 'string' && (QA_TARGETS as readonly string[]).includes(value);
}

/** Existing two-lane histories remain readable until Violet is registered. */
export function validQaFleet(targets: readonly string[]): boolean {
  return targets.length >= ORIGINAL_QA_TARGETS.length
    && new Set(targets).size === targets.length
    && ORIGINAL_QA_TARGETS.every((target) => targets.includes(target))
    && targets.every(isQaTarget);
}
