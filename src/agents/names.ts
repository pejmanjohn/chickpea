/**
 * The deployed Flue agent identifiers, in one place, for RUNTIME POLICY.
 *
 * These strings are load-bearing beyond registration: runtime policy keys off
 * them (see `isManagedCurrentRequestAgent` in ../memory/tool-policy.ts, and the
 * activity bridge in ../app.ts). The Flue 2 cutover renamed the agents and the
 * policy predicate kept matching the pre-cutover names, which silently disabled
 * the only deterministic side-effect gate in production while its unit tests —
 * which passed the old names in explicitly — stayed green.
 *
 * The agent modules cannot import these: the Flue build reads
 * `<Agent>.agentName = '<literal>'` statically to derive Durable Object class
 * and binding names before any code runs, so those assignments must stay
 * literals. `tests/agent-names.test.ts` asserts the literals and these
 * constants agree, which is what turns a future rename into a loud test
 * failure instead of a silent security regression.
 */
export const CHICKPEA_SLACK_AGENT_NAME = 'chickpea-slack-v2';
export const CHICKPEA_ROUTINE_INTENT_AGENT_NAME = 'chickpea-routine-intent-v2';
export const CHICKPEA_ROUTINE_EXECUTION_AGENT_NAME = 'chickpea-routine-execution-v2';

/** Agents that run a Slack submission on a human's behalf and carry tool authority. */
export const MANAGED_SUBMISSION_AGENT_NAMES = [
  CHICKPEA_SLACK_AGENT_NAME,
  CHICKPEA_ROUTINE_INTENT_AGENT_NAME,
  CHICKPEA_ROUTINE_EXECUTION_AGENT_NAME,
] as const;

/**
 * Unattended agents. They have no human in the loop for the turn they execute,
 * so an external write needs explicit authority in the saved task text itself —
 * never merely the absence of selected memory.
 */
export const UNATTENDED_AGENT_NAMES = [
  CHICKPEA_ROUTINE_INTENT_AGENT_NAME,
  CHICKPEA_ROUTINE_EXECUTION_AGENT_NAME,
] as const;
