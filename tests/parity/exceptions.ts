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
 * Start state for this stage: ZERO Lane-B exceptions — the whole point is the
 * full suite green on Flue unmodified. The only entry is the Lane-A-only S21
 * fan-out bug that Flue fixes by design.
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

export const parityExceptions: ParityException[] = [
  {
    scenarioId: 'S21',
    lane: 'lane-a',
    behavior: 'expected-fail',
    rationale:
      'Old-lane bug, fixed by design in the Flue lane; the old lane is frozen. ' +
      'S21 sends a threaded app_mention plus its companion message event (same ' +
      'channel + message ts, different event_ids) — the real Slack fan-out for a ' +
      'single mention. Lane A dedupes on event_id only, so it double-replies. The ' +
      'Flue lane also claims msg:channel:ts, collapsing the fan-out to exactly one ' +
      'reply. We do not backport the fix into the frozen hand-rolled lane.',
    approvedInReview: true,
  },
];
