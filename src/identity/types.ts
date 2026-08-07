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

export interface PersonalTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  prefix: string;
  label: string;
  status: 'active' | 'revoked';
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface BrowserSessionRecord {
  id: string;
  userId: string;
  personalTokenId: string;
  sessionHash: string;
  prefix: string;
  expiresAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
  createdAt: number;
}

export interface AuthProviderConfig {
  id: string;
  organizationId: string;
  kind: string;
  state: 'pending' | 'active' | 'disabled';
  issuer: string | null;
  audience: string | null;
  admissionState: 'action_required' | 'admin_confirmed' | 'assertion_observed' | null;
  createdAt: number;
  updatedAt: number;
}

export interface AuthRateLimitState {
  bucket: string;
  keyHash: string;
  windowStart: number;
  failures: number;
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

export interface ConfigureAuthProviderInput {
  organizationId: string;
  kind: string;
  state: AuthProviderConfig['state'];
  issuer?: string | null;
  audience?: string | null;
  admissionState?: AuthProviderConfig['admissionState'];
}

export interface UpdateOrganizationAuthInput {
  organizationId: string;
  authMode: AuthMode;
  canonicalAdminOrigin?: string | null;
}

export interface ActivateAccessOwnerInput extends ClaimOwnerInput {
  audience: string;
  canonicalAdminOrigin: string;
}

export interface ReplaceAccessOwnerBindingInput extends BindExternalIdentityInput {}

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

export interface CreatePersonalTokenRecordInput {
  userId: string;
  tokenHash: string;
  prefix: string;
  label: string;
}

export interface CreateBrowserSessionRecordInput {
  userId: string;
  personalTokenId: string;
  sessionHash: string;
  prefix: string;
  expiresAt: number;
}

export interface IdentityExportSummary {
  organization: Organization | null;
  users: User[];
  externalIdentities: ExternalIdentityBinding[];
  memberships: Membership[];
  ownerClaim: Omit<OwnerClaim, 'normalizedEmail'> & { emailConfigured: boolean } | null;
  invitations: Array<Omit<Invitation, 'tokenHash' | 'normalizedEmail'> & { emailConfigured: boolean }>;
  personalTokens: Array<Omit<PersonalTokenRecord, 'tokenHash'>>;
  browserSessions: Array<Omit<BrowserSessionRecord, 'sessionHash'>>;
}

export interface IdentityStore {
  ensureOrganization(input: EnsureOrganizationInput): Promise<Organization>;
  getOrganization(): Promise<Organization | undefined>;
  createOwnerClaim(input: CreateOwnerClaimInput): Promise<OwnerClaim>;
  getOwnerClaim(): Promise<OwnerClaim | undefined>;
  claimOwner(input: ClaimOwnerInput): Promise<IdentityResolution>;
  activateAccessOwner(input: ActivateAccessOwnerInput): Promise<IdentityResolution>;
  replaceAccessOwnerBinding(input: ReplaceAccessOwnerBindingInput): Promise<IdentityResolution>;
  resolveExternalIdentity(
    provider: string,
    issuer: string,
    subject: string,
    organizationId?: string,
  ): Promise<IdentityResolution | undefined>;
  listExternalIdentities(): Promise<ExternalIdentityBinding[]>;
  listMemberships(): Promise<Membership[]>;
  getUser(userId: string): Promise<User | undefined>;
  getMembershipForUser(userId: string, organizationId?: string): Promise<Membership | undefined>;
  updateMembership(input: UpdateMembershipInput): Promise<Membership>;
  createInvitation(input: CreateInvitationInput): Promise<Invitation>;
  resendInvitation(input: ResendInvitationInput): Promise<Invitation>;
  revokeInvitation(invitationId: string): Promise<Invitation>;
  consumeInvitation(input: ConsumeInvitationInput): Promise<IdentityResolution>;
  listInvitations(): Promise<Invitation[]>;
  createPersonalToken(input: CreatePersonalTokenRecordInput): Promise<PersonalTokenRecord>;
  findPersonalTokens(prefix: string): Promise<PersonalTokenRecord[]>;
  getPersonalToken(tokenId: string): Promise<PersonalTokenRecord | undefined>;
  revokePersonalToken(tokenId: string): Promise<PersonalTokenRecord>;
  touchPersonalToken(tokenId: string): Promise<PersonalTokenRecord>;
  createBrowserSession(input: CreateBrowserSessionRecordInput): Promise<BrowserSessionRecord>;
  findBrowserSessions(prefix: string): Promise<BrowserSessionRecord[]>;
  revokeBrowserSession(sessionId: string): Promise<BrowserSessionRecord>;
  configureAuthProvider(input: ConfigureAuthProviderInput): Promise<AuthProviderConfig>;
  getAuthProviderConfig(kind: string): Promise<AuthProviderConfig | undefined>;
  updateAuthProviderAudience(
    kind: string,
    audience: string,
    actorMembershipId?: string,
  ): Promise<AuthProviderConfig>;
  updateOrganizationAuth(input: UpdateOrganizationAuthInput): Promise<Organization>;
  getAuthRateLimit(bucket: string, keyHash: string): Promise<AuthRateLimitState | undefined>;
  recordAuthRateFailure(
    bucket: string,
    keyHash: string,
    windowStart: number,
  ): Promise<AuthRateLimitState>;
  clearAuthRateLimit(bucket: string, keyHash: string): Promise<void>;
  exportSummary(): Promise<IdentityExportSummary>;
  listAuditEvents(limit?: number): Promise<AuditEvent[]>;
}

export type IdentityRpcRequest =
  | { kind: 'ensure_organization'; input: EnsureOrganizationInput }
  | { kind: 'get_organization' }
  | { kind: 'create_owner_claim'; input: CreateOwnerClaimInput }
  | { kind: 'get_owner_claim' }
  | { kind: 'claim_owner'; input: ClaimOwnerInput }
  | { kind: 'activate_access_owner'; input: ActivateAccessOwnerInput }
  | { kind: 'replace_access_owner_binding'; input: ReplaceAccessOwnerBindingInput }
  | {
      kind: 'resolve_external_identity';
      provider: string;
      issuer: string;
      subject: string;
      organizationId?: string;
    }
  | { kind: 'list_external_identities' }
  | { kind: 'list_memberships' }
  | { kind: 'get_user'; userId: string }
  | { kind: 'get_membership_for_user'; userId: string; organizationId?: string }
  | { kind: 'update_membership'; input: UpdateMembershipInput }
  | { kind: 'create_invitation'; input: CreateInvitationInput }
  | { kind: 'resend_invitation'; input: ResendInvitationInput }
  | { kind: 'revoke_invitation'; invitationId: string }
  | { kind: 'consume_invitation'; input: ConsumeInvitationInput }
  | { kind: 'list_invitations' }
  | { kind: 'create_personal_token'; input: CreatePersonalTokenRecordInput }
  | { kind: 'find_personal_tokens'; prefix: string }
  | { kind: 'get_personal_token'; tokenId: string }
  | { kind: 'revoke_personal_token'; tokenId: string }
  | { kind: 'touch_personal_token'; tokenId: string }
  | { kind: 'create_browser_session'; input: CreateBrowserSessionRecordInput }
  | { kind: 'find_browser_sessions'; prefix: string }
  | { kind: 'revoke_browser_session'; sessionId: string }
  | { kind: 'configure_auth_provider'; input: ConfigureAuthProviderInput }
  | { kind: 'get_auth_provider_config'; providerKind: string }
  | {
      kind: 'update_auth_provider_audience';
      providerKind: string;
      audience: string;
      actorMembershipId?: string;
    }
  | { kind: 'update_organization_auth'; input: UpdateOrganizationAuthInput }
  | { kind: 'get_auth_rate_limit'; bucket: string; keyHash: string }
  | { kind: 'record_auth_rate_failure'; bucket: string; keyHash: string; windowStart: number }
  | { kind: 'clear_auth_rate_limit'; bucket: string; keyHash: string }
  | { kind: 'export_summary' }
  | { kind: 'list_identity_audit_events'; limit?: number };

export type IdentityRpcResponse =
  | { kind: 'organization'; organization: Organization | null }
  | { kind: 'owner_claim'; ownerClaim: OwnerClaim | null }
  | { kind: 'identity_resolution'; resolution: IdentityResolution | null }
  | { kind: 'external_identities'; externalIdentities: ExternalIdentityBinding[] }
  | { kind: 'memberships'; memberships: Membership[] }
  | { kind: 'user'; user: User | null }
  | { kind: 'membership'; membership: Membership }
  | { kind: 'invitation'; invitation: Invitation }
  | { kind: 'invitations'; invitations: Invitation[] }
  | { kind: 'personal_token'; personalToken: PersonalTokenRecord }
  | { kind: 'personal_tokens'; personalTokens: PersonalTokenRecord[] }
  | { kind: 'browser_session'; browserSession: BrowserSessionRecord }
  | { kind: 'browser_sessions'; browserSessions: BrowserSessionRecord[] }
  | { kind: 'auth_provider_config'; config: AuthProviderConfig | null }
  | { kind: 'auth_rate_limit'; state: AuthRateLimitState | null }
  | { kind: 'ok' }
  | { kind: 'export_summary'; summary: IdentityExportSummary }
  | { kind: 'audit_events'; events: AuditEvent[] };
