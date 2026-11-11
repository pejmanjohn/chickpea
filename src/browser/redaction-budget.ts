/**
 * How much matching work redacting typed secrets may spend on one tool
 * result. It loads with the browser tools; the matcher itself loads with the
 * first browser session (`redaction.ts`).
 */
import { BROWSER_TOO_LARGE_TO_CHECK_MESSAGE } from './messages.ts';

/**
 * Matching work one surface may spend, such as a page read, a screenshot
 * check or an error: characters of text times characters of the pattern
 * they are matched against. The slowest text measured cost 0.3 ns a unit, so
 * a surface stays under about 150 ms. Ordinary text costs about 100 units a
 * character with a 20-character password and a code typed.
 */
const WORK_BUDGET = 500_000_000;

/** Text that would take more matching work than its surface allows. It is withheld, never shown unchecked. */
export class RedactionBudgetError extends Error {
  constructor() {
    super(BROWSER_TOO_LARGE_TO_CHECK_MESSAGE);
    this.name = 'RedactionBudgetError';
  }
}

/** The matching work left to one surface. Pass the same budget to every piece of text it shows. */
export class RedactionBudget {
  #left: number;

  constructor(units = WORK_BUDGET) {
    this.#left = units;
  }

  spend(units: number): void {
    this.#left -= units;
    if (this.#left < 0) throw new RedactionBudgetError();
  }
}
