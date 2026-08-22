/** Canonical identifier grammar for persisted Agents and Agent-scoped routes. */
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;

export function isAgentId(value: string): boolean {
  return AGENT_ID_PATTERN.test(value);
}
