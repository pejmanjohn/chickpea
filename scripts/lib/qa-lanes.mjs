/**
 * The claimed QA lanes, as one dependency-free list for scripts.
 *
 * The deploy wrapper reads it on every path, including ordinary production
 * deploys, so this module must stay free of imports. src/config/qa-targets.ts
 * holds the same list for TypeScript; tests/qa-lanes.test.ts keeps them equal.
 */
export const QA_LANES = Object.freeze(['amber', 'cobalt', 'violet']);

export function isQaLane(value) {
  return typeof value === 'string' && QA_LANES.includes(value);
}
