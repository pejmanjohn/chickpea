/** Canonical identifier grammar for persisted Agents and Agent-scoped routes. */
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;
export const CHICKPEA_AGENT_ID = 'agent_chickpea';
export const CHICKPEA_AGENT_NAME = 'Chickpea';
export type AgentIdentityField = 'id' | 'name' | 'handle';

export function isAgentId(value: string): boolean {
  return AGENT_ID_PATTERN.test(value);
}

/**
 * Collapse the separators and punctuation people commonly use to imitate a
 * protected product identity. NFKC also catches compatibility glyph variants.
 */
function canonicalAgentIdentity(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]/gu, '');
}

function isReservedAgentIdentity(
  field: AgentIdentityField,
  value: string,
): boolean {
  if (field === 'id' && value.toLocaleLowerCase('en-US') === CHICKPEA_AGENT_ID) return true;
  return canonicalAgentIdentity(value) === 'chickpea';
}

export function reservedAgentIdentityField(input: {
  id: string;
  name: string;
  handle?: string;
}): AgentIdentityField | undefined {
  for (const [field, value] of [
    ['id', input.id],
    ['name', input.name],
    ['handle', input.handle],
  ] satisfies Array<[AgentIdentityField, string | undefined]>) {
    if (value && isReservedAgentIdentity(field, value)) return field;
  }
  return undefined;
}
