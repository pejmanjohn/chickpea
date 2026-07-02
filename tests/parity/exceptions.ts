/**
 * Reviewed parity exceptions.
 *
 * The parity goal is the ENTIRE scenario suite green on BOTH lanes with
 * `scenarios.ts` assertions unmodified. An exception records an intentional,
 * reviewed difference where one lane legitimately cannot satisfy a scenario the
 * other lane does — never a way to paper over an un-triaged failure.
 *
 * Semantics (implemented in `runScenarioSuite`):
 *   - `behavior: 'expected-fail'` — the scenario RUNS on the excepted lane and
 *     is expected to FAIL its assertions. The test passes and prints an
 *     `EXCEPTION` note. If the scenario instead PASSES, the exception is stale
 *     and the run FAILS (so a fixed/removed divergence forces us to delete the
 *     entry). An excepted scenario is never silently skipped.
 *
 * Start state for this stage: ZERO exceptions. The whole point is the full
 * scenario suite green on the Flue lane (Lane B) unmodified. The hand-rolled
 * lane (Lane A) — and its one Lane-A-only S21 fan-out expected-fail entry — was
 * deleted when the harness was removed; S21 now runs and PASSES on Lane B.
 */
export interface ParityException {
  /** Scenario id from `scenarios.ts` (e.g. 'S21'). */
  scenarioId: string;
  /** Lane name the exception applies to (`lane.name`, e.g. 'lane-a'). */
  lane: string;
  /** Currently only 'expected-fail': the scenario runs and is expected to fail. */
  behavior: 'expected-fail';
  /** Why this divergence is accepted rather than fixed. */
  rationale: string;
  /** Set once a human has approved the divergence in review. */
  approvedInReview: boolean;
}

export const parityExceptions: ParityException[] = [];
