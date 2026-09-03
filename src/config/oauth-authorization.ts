import { AGENT_ID_PATTERN } from './agent-id.ts';

export type OAuthAuthorizationOwnerKind = 'legacy_agent' | 'member' | 'team';

/** Durable authority captured at OAuth start and revalidated by the public callback. */
export interface OAuthAuthorizationAuthority {
  organizationId: string;
  workspaceId: string;
  membershipId: string;
  agentId: string;
  ownerKind: OAuthAuthorizationOwnerKind;
}

export function parseOAuthAuthorizationAuthority(
  value: unknown,
): OAuthAuthorizationAuthority {
  if (
    !isRecord(value) ||
    !boundedIdentifier(value.organizationId) ||
    !boundedIdentifier(value.workspaceId) ||
    !boundedIdentifier(value.membershipId) ||
    typeof value.agentId !== 'string' ||
    !AGENT_ID_PATTERN.test(value.agentId) ||
    typeof value.ownerKind !== 'string' ||
    !['legacy_agent', 'member', 'team'].includes(value.ownerKind)
  ) {
    throw new Error('Stored OAuth authorization authority is invalid');
  }
  return {
    organizationId: value.organizationId,
    workspaceId: value.workspaceId,
    membershipId: value.membershipId,
    agentId: value.agentId,
    ownerKind: value.ownerKind as OAuthAuthorizationOwnerKind,
  };
}

function boundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 192 &&
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
