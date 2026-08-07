import type { AuditEvent } from '../audit/types.ts';

export type OrganizationRole = 'owner' | 'admin' | 'member';
export type MembershipStatus = 'active' | 'suspended' | 'removed';
export type AuthMode =
  | 'unconfigured'
  | 'access_pending'
  | 'access_active'
  | 'token_active'
  | 'legacy_shared'
  | 'invalid';

export interface Organization {
  id: string;
  displayName: string;
  authMode: AuthMode;
  canonicalAdminOrigin: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface User {
  id: string;
  primaryEmail: string;
  displayName: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ExternalIdentityBinding {
  id: string;
  userId: string;
  provider: string;
  issuer: string;
  subject: string;
  verifiedEmail: string;
  createdAt: number;
  updatedAt: number;
}

export interface Membership {
  id: string;
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  status: MembershipStatus;
  createdAt: number;
  updatedAt: number;
}

export interface OwnerClaim {
  id: string;
  organizationId: string;
  normalizedEmail: string;
  status: 'pending' | 'claimed' | 'replaced';
  bindingId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Invitation {
  id: string;
  organizationId: string;
  normalizedEmail: string;
  role: OrganizationRole;
  tokenHash: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  inviterMembershipId: string;
  acceptedMembershipId: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface IdentityResolution {
  user: User;
  binding: ExternalIdentityBinding;
  membership: Membership;
}

export interface EnsureOrganizationInput {
  displayName: string;
}

export interface CreateOwnerClaimInput {
  organizationId: string;
  email: string;
}

export interface BindExternalIdentityInput {
  organizationId: string;
  provider: string;
  issuer: string;
  subject: string;
  verifiedEmail: string;
  displayName?: string | null;
  at?: number;
}

export type ClaimOwnerInput = BindExternalIdentityInput;

export interface UpdateMembershipInput {
  membershipId: string;
  role?: OrganizationRole;
  status?: MembershipStatus;
  actorMembershipId?: string;
}

export interface CreateInvitationInput {
  organizationId: string;
  email: string;
  role: OrganizationRole;
  tokenHash: string;
  inviterMembershipId: string;
  expiresAt: number;
}

export interface ResendInvitationInput {
  invitationId: string;
  tokenHash: string;
  expiresAt: number;
}

export interface ConsumeInvitationInput {
  invitationId: string;
  tokenHash: string;
  provider: string;
  issuer: string;
  subject: string;
  verifiedEmail: string;
  displayName?: string | null;
  at?: number;
}

export interface IdentityExportSummary {
  organization: Organization | null;
  users: User[];
  externalIdentities: ExternalIdentityBinding[];
  memberships: Membership[];
  ownerClaim: Omit<OwnerClaim, 'normalizedEmail'> & { emailConfigured: boolean } | null;
  invitations: Array<Omit<Invitation, 'tokenHash' | 'normalizedEmail'> & { emailConfigured: boolean }>;
}

export interface IdentityStore {
  ensureOrganization(input: EnsureOrganizationInput): Promise<Organization>;
  getOrganization(): Promise<Organization | undefined>;
  createOwnerClaim(input: CreateOwnerClaimInput): Promise<OwnerClaim>;
  getOwnerClaim(): Promise<OwnerClaim | undefined>;
  claimOwner(input: ClaimOwnerInput): Promise<IdentityResolution>;
  resolveExternalIdentity(
    provider: string,
    issuer: string,
    subject: string,
    organizationId?: string,
  ): Promise<IdentityResolution | undefined>;
  listExternalIdentities(): Promise<ExternalIdentityBinding[]>;
  listMemberships(): Promise<Membership[]>;
  updateMembership(input: UpdateMembershipInput): Promise<Membership>;
  createInvitation(input: CreateInvitationInput): Promise<Invitation>;
  resendInvitation(input: ResendInvitationInput): Promise<Invitation>;
  revokeInvitation(invitationId: string): Promise<Invitation>;
  consumeInvitation(input: ConsumeInvitationInput): Promise<IdentityResolution>;
  listInvitations(): Promise<Invitation[]>;
  exportSummary(): Promise<IdentityExportSummary>;
  listAuditEvents(limit?: number): Promise<AuditEvent[]>;
}

export type IdentityRpcRequest =
  | { kind: 'ensure_organization'; input: EnsureOrganizationInput }
  | { kind: 'get_organization' }
  | { kind: 'create_owner_claim'; input: CreateOwnerClaimInput }
  | { kind: 'get_owner_claim' }
  | { kind: 'claim_owner'; input: ClaimOwnerInput }
  | {
      kind: 'resolve_external_identity';
      provider: string;
      issuer: string;
      subject: string;
      organizationId?: string;
    }
  | { kind: 'list_external_identities' }
  | { kind: 'list_memberships' }
  | { kind: 'update_membership'; input: UpdateMembershipInput }
  | { kind: 'create_invitation'; input: CreateInvitationInput }
  | { kind: 'resend_invitation'; input: ResendInvitationInput }
  | { kind: 'revoke_invitation'; invitationId: string }
  | { kind: 'consume_invitation'; input: ConsumeInvitationInput }
  | { kind: 'list_invitations' }
  | { kind: 'export_summary' }
  | { kind: 'list_identity_audit_events'; limit?: number };

export type IdentityRpcResponse =
  | { kind: 'organization'; organization: Organization | null }
  | { kind: 'owner_claim'; ownerClaim: OwnerClaim | null }
  | { kind: 'identity_resolution'; resolution: IdentityResolution | null }
  | { kind: 'external_identities'; externalIdentities: ExternalIdentityBinding[] }
  | { kind: 'memberships'; memberships: Membership[] }
  | { kind: 'membership'; membership: Membership }
  | { kind: 'invitation'; invitation: Invitation }
  | { kind: 'invitations'; invitations: Invitation[] }
  | { kind: 'export_summary'; summary: IdentityExportSummary }
  | { kind: 'audit_events'; events: AuditEvent[] };
