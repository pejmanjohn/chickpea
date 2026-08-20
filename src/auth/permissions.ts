import type { OrganizationRole } from '../identity/types.ts';
import type { AuthPrincipal } from './types.ts';

export type Permission =
  | 'account.view'
  | 'admin.configure'
  | 'team.view'
  | 'team.invite'
  | 'team.manage_members'
  | 'team.manage_owners'
  | 'auth.manage'
  | 'auth.recover'
  | 'agent.create'
  | 'connection.create_team'
  | 'connection.create_personal'
  | 'schedule.create';

const MEMBER = new Set<Permission>([
  'account.view',
  'agent.create',
  'connection.create_team',
  'connection.create_personal',
  'schedule.create',
]);
const ADMIN = new Set<Permission>([
  ...MEMBER,
  'admin.configure',
  'team.view',
]);
const OWNER = new Set<Permission>([
  ...ADMIN,
  'team.invite',
  'team.manage_members',
  'team.manage_owners',
  'auth.manage',
  'auth.recover',
]);

export class AuthorizationError extends Error {
  readonly name = 'AuthorizationError';
  constructor(readonly code: 'forbidden' | 'principal_required' = 'forbidden') {
    super(code === 'forbidden' ? 'Permission forbidden.' : 'Authenticated principal required.');
  }
}

export interface AgentAuthorityDescriptor {
  creatorMembershipId?: string;
  editPolicy?: 'creator_and_admins' | 'all_workspace_members';
}

export function permissionForRole(role: OrganizationRole): ReadonlySet<Permission> {
  if (role === 'owner') return OWNER;
  if (role === 'admin') return ADMIN;
  return MEMBER;
}

export function requirePermission(principal: AuthPrincipal | undefined, permission: Permission): void {
  if (!principal) throw new AuthorizationError('principal_required');
  if (!permissionForRole(principal.role).has(permission)) throw new AuthorizationError();
}

export function canEditAgent(
  principal: AuthPrincipal | undefined,
  agent: AgentAuthorityDescriptor,
): boolean {
  if (!principal) return false;
  if (principal.role === 'owner' || principal.role === 'admin') return true;
  return agent.creatorMembershipId === principal.membershipId ||
    agent.editPolicy === 'all_workspace_members';
}

export function requireAgentEdit(
  principal: AuthPrincipal | undefined,
  agent: AgentAuthorityDescriptor,
): void {
  if (!principal) throw new AuthorizationError('principal_required');
  if (!canEditAgent(principal, agent)) throw new AuthorizationError();
}

/** Slack Channel membership is an independent ceiling; Admin authority cannot bypass it. */
export function requireAgentChannelPublication(
  principal: AuthPrincipal | undefined,
  agent: AgentAuthorityDescriptor,
  actorIsChannelMember: boolean,
): void {
  requireAgentEdit(principal, agent);
  if (!actorIsChannelMember) throw new AuthorizationError();
}
