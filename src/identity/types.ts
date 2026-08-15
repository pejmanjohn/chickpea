import type { AuditEvent } from '../audit/types.ts';
import type {
  SlackCredentialIdentityClass,
  SlackCredentialPurpose,
  SlackSecretEnvelope,
} from '../slack/secret-envelope.ts';

export type OrganizationRole = 'owner' | 'admin';
export type MembershipStatus = 'active' | 'suspended' | 'removed';
export type AuthMode = 'unconfigured' | 'slack_active';
export type AuthHealthGate = 'normal' | 'recovery_only';

export interface Organization {
  id: string;
  displayName: string;
  slackTeamId: string | null;
  authMode: AuthMode;
  canonicalAdminOrigin: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface User {
  id: string;
  slackTeamId: string;
  slackUserId: string;
  displayName: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Immutable canonical Slack-to-Chickpea membership binding. */
export interface SlackIdentityBinding {
  id: string;
  provider: 'slack';
  slackTeamId: string;
  slackUserId: string;
  userId: string;
  organizationId: string;
  membershipId: string;
  betterAuthUserId: string;
  betterAuthMembershipId: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type ExternalIdentityBinding = SlackIdentityBinding;
export type ActorExternalIdentityBinding = SlackIdentityBinding;

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
  operationId: string;
  organizationId: string | null;
  slackTeamId: string;
  slackUserId: string;
  status: 'reserved' | 'active' | 'tombstoned';
  membershipId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Invitation {
  id: string;
  organizationId: string;
  slackTeamId: string;
  slackUserId: string;
  displayName: string | null;
  role: 'admin';
  locatorHash: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  inviterMembershipId: string;
  acceptedMembershipId: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface PersonalTokenRecord {
  id: string;
  organizationId: string | null;
  userId: string;
  membershipId: string | null;
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
  organizationId: string | null;
  userId: string;
  membershipId: string | null;
  personalTokenId: string;
  sessionHash: string;
  prefix: string;
  expiresAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
  createdAt: number;
}

export interface AuthRateLimitState {
  bucket: string;
  keyHash: string;
  windowStart: number;
  failures: number;
}

export type AuthOperationKind = 'first_owner_claim' | 'invitation_admission' | 'login';
export type AuthOperationStatus = 'reserved' | 'reconciling' | 'active' | 'tombstoned' | 'expired';

export interface AuthControl {
  installationId: string;
  authMode: AuthMode;
  healthGate: AuthHealthGate;
  canonicalAdminOrigin: string | null;
  betterAuthOrganizationId: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface SlackCredentialControl {
  installationId: string;
  deploymentId: string;
  currentKeyId: string;
  rotationEpoch: number;
  createdAt: number;
  updatedAt: number;
}

export type SlackCredentialRevisionStatus = 'candidate' | 'active' | 'tombstoned';

/** Internal encrypted-state record. It is deliberately absent from exports/admin projections. */
export interface SlackCredentialRevision {
  identityId: string;
  identityClass: SlackCredentialIdentityClass;
  purpose: SlackCredentialPurpose;
  revision: string;
  /** Active revision this candidate was staged against; immutable callback fence. */
  baseRevision: string | null;
  status: SlackCredentialRevisionStatus;
  appId: string;
  teamId: string | null;
  botUserId: string | null;
  grantedScopes: string[];
  validatedAt: number | null;
  manifestFingerprint: string | null;
  rotationEpoch: number;
  envelope: SlackSecretEnvelope | null;
  createdAt: number;
  updatedAt: number;
  tombstonedAt: number | null;
}

export interface EnsureSlackCredentialControlInput {
  installationId?: string;
  currentKeyId: string;
}

export interface BeginSlackCredentialRotationInput {
  installationId?: string;
  expectedEpoch: number;
  expectedCurrentKeyId: string;
  nextKeyId: string;
}

export interface StageSlackCredentialRevisionInput {
  installationId?: string;
  expectedRotationEpoch: number;
  expectedActiveRevision: string | null;
  revision: string;
  identityId: string;
  identityClass: SlackCredentialIdentityClass;
  purpose: SlackCredentialPurpose;
  appId: string;
  teamId?: string | null;
  botUserId?: string | null;
  grantedScopes?: string[];
  validatedAt?: number | null;
  manifestFingerprint?: string | null;
  envelope: SlackSecretEnvelope;
}

export interface PromoteSlackCredentialRevisionInput {
  installationId?: string;
  identityId: string;
  candidateRevision: string;
  expectedActiveRevision: string | null;
  expectedRotationEpoch: number;
}

export interface TombstoneSlackCredentialRevisionInput {
  installationId?: string;
  identityId: string;
  revision: string;
  expectedRotationEpoch: number;
}

export interface RewrapSlackCredentialRevisionInput {
  installationId?: string;
  identityId: string;
  revision: string;
  expectedKeyId: string;
  expectedRotationEpoch: number;
  envelope: SlackSecretEnvelope;
}

export interface SlackCredentialRetentionResult {
  expiredAuthOperations: number;
  expiredInvitations: number;
  expiredBrowserSessions: number;
  scrubbedCredentialCandidates: number;
}

export interface AuthOperation {
  id: string;
  kind: AuthOperationKind;
  organizationId: string | null;
  expectedSlackTeamId: string;
  expectedSlackUserId: string;
  chickpeaRole: OrganizationRole | null;
  capabilityHash: string;
  status: AuthOperationStatus;
  step: number;
  betterAuthUserId: string | null;
  betterAuthOrganizationId: string | null;
  betterAuthMembershipId: string | null;
  chickpeaMembershipId: string | null;
  expiresAt: number;
  activatedAt: number | null;
  tombstonedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface MembershipAccessOverlay {
  membershipId: string;
  organizationId: string;
  accessStatus: 'active' | 'suspended';
  membershipVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface SetMembershipAccessOverlayInput {
  membershipId: string;
  organizationId: string;
  accessStatus: MembershipAccessOverlay['accessStatus'];
  expectedVersion?: number;
  ownerMembershipIds?: string[];
  actorMembershipId?: string;
  at?: number;
}

export interface RecordIdentityAuthAuditInput {
  event: 'authentication' | 'authorization';
  outcome: 'success' | 'denied';
  action: string;
  correlationId: string;
  authenticatorKind: string;
  userId?: string | null;
  membershipId?: string | null;
  reasonCode?: string | null;
  at?: number;
}

export interface IdentityResolution {
  user: User;
  binding: SlackIdentityBinding;
  membership: Membership;
}

export interface EnsureOrganizationInput {
  displayName: string;
  slackTeamId?: string | null;
}

export interface CreateOwnerClaimInput {
  operationId: string;
  slackTeamId: string;
  slackUserId: string;
  organizationId?: string | null;
  at?: number;
}

export interface ClaimOwnerInput {
  operationId: string;
  organizationId: string;
  slackTeamId: string;
  slackUserId: string;
  displayName?: string | null;
  betterAuthUserId: string;
  betterAuthMembershipId: string;
  at?: number;
}

export type BootstrapTokenOwnerInput = ClaimOwnerInput;
export type ActivateAccessOwnerInput = ClaimOwnerInput;
export type ReplaceAccessOwnerBindingInput = never;

export interface UpdateMembershipInput {
  membershipId: string;
  role?: OrganizationRole;
  status?: MembershipStatus;
  actorMembershipId?: string;
}

export interface CreateInvitationInput {
  organizationId: string;
  slackTeamId: string;
  slackUserId: string;
  displayName?: string | null;
  role: 'admin';
  locatorHash: string;
  inviterMembershipId: string;
  expiresAt: number;
}

export interface ResendInvitationInput {
  invitationId: string;
  locatorHash: string;
  expiresAt: number;
}

export interface ConsumeInvitationInput {
  invitationId: string;
  locatorHash: string;
  slackTeamId: string;
  slackUserId: string;
  displayName?: string | null;
  betterAuthUserId: string;
  betterAuthMembershipId: string;
  at?: number;
}

export interface CreatePersonalTokenRecordInput {
  organizationId?: string | null;
  userId: string;
  membershipId?: string | null;
  tokenHash: string;
  prefix: string;
  label: string;
}

export interface RotatePersonalTokenResult {
  personalToken: PersonalTokenRecord;
  revokedCount: number;
}

export interface CreateBrowserSessionRecordInput {
  organizationId?: string | null;
  userId: string;
  membershipId?: string | null;
  personalTokenId: string;
  sessionHash: string;
  prefix: string;
  expiresAt: number;
}

export interface EnsureAuthControlInput {
  installationId?: string;
  authMode?: AuthMode;
  healthGate?: AuthHealthGate;
}

export interface UpdateAuthControlInput {
  installationId?: string;
  expectedRevision: number;
  authMode?: AuthMode;
  healthGate?: AuthHealthGate;
  canonicalAdminOrigin?: string | null;
  betterAuthOrganizationId?: string | null;
}

export interface CreateAuthOperationInput {
  id?: string;
  kind: AuthOperationKind;
  organizationId?: string | null;
  expectedSlackTeamId: string;
  expectedSlackUserId: string;
  chickpeaRole?: OrganizationRole | null;
  capabilityHash: string;
  expiresAt: number;
}

export interface AdvanceAuthOperationInput {
  operationId: string;
  capabilityHash: string;
  step: number;
  status?: 'reconciling';
  betterAuthUserId?: string | null;
  betterAuthOrganizationId?: string | null;
  betterAuthMembershipId?: string | null;
  chickpeaMembershipId?: string | null;
  at?: number;
}

export interface ConsumeAuthOperationInput {
  operationId: string;
  capabilityHash: string;
  expectedStep: number;
  at?: number;
}

export interface UpdateOrganizationAuthInput {
  organizationId: string;
  authMode: AuthMode;
  canonicalAdminOrigin?: string | null;
}

export interface IdentityExportSummary {
  organization: Organization | null;
  users: User[];
  slackBindings: SlackIdentityBinding[];
  memberships: Membership[];
  ownerClaim: OwnerClaim | null;
  invitations: Array<Omit<Invitation, 'locatorHash'>>;
  personalTokens: Array<Omit<PersonalTokenRecord, 'tokenHash'>>;
  browserSessions: Array<Omit<BrowserSessionRecord, 'sessionHash'>>;
  authControl: AuthControl | null;
  authOperations: Array<Omit<AuthOperation, 'capabilityHash'>>;
}

export interface HumanIdentityDirectory {
  getOrganization(): Promise<Organization | undefined>;
  listMemberships(): Promise<Membership[]>;
  getUser(userId: string): Promise<User | undefined>;
  getMembership(membershipId: string): Promise<Membership | undefined>;
  getMembershipForUser(userId: string, organizationId?: string): Promise<Membership | undefined>;
}

export interface IdentityStore extends HumanIdentityDirectory {
  ensureAuthControl(input?: EnsureAuthControlInput): Promise<AuthControl>;
  getAuthControl(installationId?: string): Promise<AuthControl | undefined>;
  updateAuthControl(input: UpdateAuthControlInput): Promise<AuthControl>;
  ensureSlackCredentialControl(input: EnsureSlackCredentialControlInput): Promise<SlackCredentialControl>;
  getSlackCredentialControl(installationId?: string): Promise<SlackCredentialControl | undefined>;
  beginSlackCredentialRotation(input: BeginSlackCredentialRotationInput): Promise<SlackCredentialControl>;
  stageSlackCredentialRevision(input: StageSlackCredentialRevisionInput): Promise<SlackCredentialRevision>;
  getActiveSlackCredentialRevision(identityId: string): Promise<SlackCredentialRevision | undefined>;
  getSlackCredentialRevision(identityId: string, revision: string): Promise<SlackCredentialRevision | undefined>;
  hasSlackCredentialHistory(identityId: string): Promise<boolean>;
  listLiveSlackCredentialRevisions(): Promise<SlackCredentialRevision[]>;
  promoteSlackCredentialRevision(input: PromoteSlackCredentialRevisionInput): Promise<SlackCredentialRevision>;
  tombstoneSlackCredentialRevision(input: TombstoneSlackCredentialRevisionInput): Promise<SlackCredentialRevision>;
  rewrapSlackCredentialRevision(input: RewrapSlackCredentialRevisionInput): Promise<SlackCredentialRevision>;
  countLiveSlackCredentialRevisionsByKey(keyId: string, expectedRotationEpoch: number): Promise<number>;
  sweepSlackIdentityRetention(at: number, candidateMaxAgeMs: number): Promise<SlackCredentialRetentionResult>;
  createAuthOperation(input: CreateAuthOperationInput): Promise<AuthOperation>;
  reservePendingAuthOperation(input: CreateAuthOperationInput): Promise<{ operation: AuthOperation; created: boolean }>;
  getAuthOperation(operationId: string): Promise<AuthOperation | undefined>;
  findAuthOperation(kind: AuthOperationKind, capabilityHash: string): Promise<AuthOperation | undefined>;
  listAuthOperations(kind?: AuthOperationKind, organizationId?: string): Promise<AuthOperation[]>;
  advanceAuthOperation(input: AdvanceAuthOperationInput): Promise<AuthOperation>;
  consumeAuthOperation(input: ConsumeAuthOperationInput): Promise<AuthOperation>;
  revokeAuthOperation(operationId: string): Promise<AuthOperation>;
  getMembershipAccessOverlay(membershipId: string): Promise<MembershipAccessOverlay | undefined>;
  setMembershipAccessOverlay(input: SetMembershipAccessOverlayInput): Promise<MembershipAccessOverlay>;
  ensureOrganization(input: EnsureOrganizationInput): Promise<Organization>;
  getOrganization(): Promise<Organization | undefined>;
  createOwnerClaim(input: CreateOwnerClaimInput): Promise<OwnerClaim>;
  getOwnerClaim(): Promise<OwnerClaim | undefined>;
  claimOwner(input: ClaimOwnerInput): Promise<IdentityResolution>;
  resolveSlackIdentity(slackTeamId: string, slackUserId: string, organizationId?: string): Promise<IdentityResolution | undefined>;
  listExternalIdentities(): Promise<SlackIdentityBinding[]>;
  resolveActorExternalIdentity(provider: 'slack', slackTeamId: string, slackUserId: string): Promise<SlackIdentityBinding | undefined>;
  listMemberships(): Promise<Membership[]>;
  getUser(userId: string): Promise<User | undefined>;
  getMembership(membershipId: string): Promise<Membership | undefined>;
  getMembershipForUser(userId: string, organizationId?: string): Promise<Membership | undefined>;
  updateMembership(input: UpdateMembershipInput): Promise<Membership>;
  createInvitation(input: CreateInvitationInput): Promise<Invitation>;
  resendInvitation(input: ResendInvitationInput): Promise<Invitation>;
  revokeInvitation(invitationId: string): Promise<Invitation>;
  consumeInvitation(input: ConsumeInvitationInput): Promise<IdentityResolution>;
  listInvitations(): Promise<Invitation[]>;
  createPersonalToken(input: CreatePersonalTokenRecordInput): Promise<PersonalTokenRecord>;
  rotatePersonalToken(input: CreatePersonalTokenRecordInput): Promise<RotatePersonalTokenResult>;
  findPersonalTokens(prefix: string): Promise<PersonalTokenRecord[]>;
  getPersonalToken(tokenId: string): Promise<PersonalTokenRecord | undefined>;
  revokePersonalToken(tokenId: string): Promise<PersonalTokenRecord>;
  touchPersonalToken(tokenId: string): Promise<PersonalTokenRecord>;
  createBrowserSession(input: CreateBrowserSessionRecordInput): Promise<BrowserSessionRecord>;
  findBrowserSessions(prefix: string): Promise<BrowserSessionRecord[]>;
  revokeBrowserSession(sessionId: string): Promise<BrowserSessionRecord>;
  updateOrganizationAuth(input: UpdateOrganizationAuthInput): Promise<Organization>;
  getAuthRateLimit(bucket: string, keyHash: string): Promise<AuthRateLimitState | undefined>;
  recordAuthRateFailure(bucket: string, keyHash: string, windowStart: number): Promise<AuthRateLimitState>;
  clearAuthRateLimit(bucket: string, keyHash: string): Promise<void>;
  recordAuthAudit(input: RecordIdentityAuthAuditInput): Promise<void>;
  exportSummary(): Promise<IdentityExportSummary>;
  listAuditEvents(limit?: number): Promise<AuditEvent[]>;
}

export type IdentityRpcRequest =
  | { kind: 'ensure_auth_control'; input: EnsureAuthControlInput }
  | { kind: 'get_auth_control'; installationId?: string }
  | { kind: 'update_auth_control'; input: UpdateAuthControlInput }
  | { kind: 'ensure_slack_credential_control'; input: EnsureSlackCredentialControlInput }
  | { kind: 'get_slack_credential_control'; installationId?: string }
  | { kind: 'begin_slack_credential_rotation'; input: BeginSlackCredentialRotationInput }
  | { kind: 'stage_slack_credential_revision'; input: StageSlackCredentialRevisionInput }
  | { kind: 'get_active_slack_credential_revision'; identityId: string }
  | { kind: 'get_slack_credential_revision'; identityId: string; revision: string }
  | { kind: 'has_slack_credential_history'; identityId: string }
  | { kind: 'list_live_slack_credential_revisions' }
  | { kind: 'promote_slack_credential_revision'; input: PromoteSlackCredentialRevisionInput }
  | { kind: 'tombstone_slack_credential_revision'; input: TombstoneSlackCredentialRevisionInput }
  | { kind: 'rewrap_slack_credential_revision'; input: RewrapSlackCredentialRevisionInput }
  | { kind: 'count_live_slack_credential_revisions_by_key'; keyId: string; expectedRotationEpoch: number }
  | { kind: 'sweep_slack_identity_retention'; at: number; candidateMaxAgeMs: number }
  | { kind: 'create_auth_operation'; input: CreateAuthOperationInput }
  | { kind: 'reserve_pending_auth_operation'; input: CreateAuthOperationInput }
  | { kind: 'get_auth_operation'; operationId: string }
  | { kind: 'find_auth_operation'; operationKind: AuthOperationKind; capabilityHash: string }
  | { kind: 'list_auth_operations'; operationKind?: AuthOperationKind; organizationId?: string }
  | { kind: 'advance_auth_operation'; input: AdvanceAuthOperationInput }
  | { kind: 'consume_auth_operation'; input: ConsumeAuthOperationInput }
  | { kind: 'revoke_auth_operation'; operationId: string }
  | { kind: 'get_membership_access_overlay'; membershipId: string }
  | { kind: 'set_membership_access_overlay'; input: SetMembershipAccessOverlayInput }
  | { kind: 'ensure_organization'; input: EnsureOrganizationInput }
  | { kind: 'get_organization' }
  | { kind: 'create_owner_claim'; input: CreateOwnerClaimInput }
  | { kind: 'get_owner_claim' }
  | { kind: 'claim_owner'; input: ClaimOwnerInput }
  | { kind: 'resolve_slack_identity'; slackTeamId: string; slackUserId: string; organizationId?: string }
  | { kind: 'list_external_identities' }
  | { kind: 'list_memberships' }
  | { kind: 'get_user'; userId: string }
  | { kind: 'get_membership'; membershipId: string }
  | { kind: 'get_membership_for_user'; userId: string; organizationId?: string }
  | { kind: 'update_membership'; input: UpdateMembershipInput }
  | { kind: 'create_invitation'; input: CreateInvitationInput }
  | { kind: 'resend_invitation'; input: ResendInvitationInput }
  | { kind: 'revoke_invitation'; invitationId: string }
  | { kind: 'consume_invitation'; input: ConsumeInvitationInput }
  | { kind: 'list_invitations' }
  | { kind: 'create_personal_token'; input: CreatePersonalTokenRecordInput }
  | { kind: 'rotate_personal_token'; input: CreatePersonalTokenRecordInput }
  | { kind: 'find_personal_tokens'; prefix: string }
  | { kind: 'get_personal_token'; tokenId: string }
  | { kind: 'revoke_personal_token'; tokenId: string }
  | { kind: 'touch_personal_token'; tokenId: string }
  | { kind: 'create_browser_session'; input: CreateBrowserSessionRecordInput }
  | { kind: 'find_browser_sessions'; prefix: string }
  | { kind: 'revoke_browser_session'; sessionId: string }
  | { kind: 'update_organization_auth'; input: UpdateOrganizationAuthInput }
  | { kind: 'get_auth_rate_limit'; bucket: string; keyHash: string }
  | { kind: 'record_auth_rate_failure'; bucket: string; keyHash: string; windowStart: number }
  | { kind: 'clear_auth_rate_limit'; bucket: string; keyHash: string }
  | { kind: 'record_identity_auth_audit'; input: RecordIdentityAuthAuditInput }
  | { kind: 'export_summary' }
  | { kind: 'list_identity_audit_events'; limit?: number };

export type IdentityRpcResponse =
  | { kind: 'auth_control'; control: AuthControl | null }
  | { kind: 'slack_credential_control'; control: SlackCredentialControl | null }
  | { kind: 'slack_credential_revision'; revision: SlackCredentialRevision | null }
  | { kind: 'slack_credential_revisions'; revisions: SlackCredentialRevision[] }
  | { kind: 'slack_credential_count'; count: number }
  | { kind: 'slack_credential_presence'; present: boolean }
  | { kind: 'slack_credential_retention'; result: SlackCredentialRetentionResult }
  | { kind: 'auth_operation'; operation: AuthOperation | null }
  | { kind: 'auth_operation_reservation'; operation: AuthOperation; created: boolean }
  | { kind: 'auth_operations'; operations: AuthOperation[] }
  | { kind: 'membership_access_overlay'; overlay: MembershipAccessOverlay | null }
  | { kind: 'organization'; organization: Organization | null }
  | { kind: 'owner_claim'; ownerClaim: OwnerClaim | null }
  | { kind: 'identity_resolution'; resolution: IdentityResolution | null }
  | { kind: 'external_identities'; externalIdentities: SlackIdentityBinding[] }
  | { kind: 'memberships'; memberships: Membership[] }
  | { kind: 'user'; user: User | null }
  | { kind: 'membership'; membership: Membership | null }
  | { kind: 'invitation'; invitation: Invitation }
  | { kind: 'invitations'; invitations: Invitation[] }
  | { kind: 'personal_token'; personalToken: PersonalTokenRecord }
  | { kind: 'personal_token_rotation'; result: RotatePersonalTokenResult }
  | { kind: 'personal_tokens'; personalTokens: PersonalTokenRecord[] }
  | { kind: 'browser_session'; browserSession: BrowserSessionRecord }
  | { kind: 'browser_sessions'; browserSessions: BrowserSessionRecord[] }
  | { kind: 'auth_rate_limit'; state: AuthRateLimitState | null }
  | { kind: 'identity_export'; summary: IdentityExportSummary }
  | { kind: 'audit_events'; events: AuditEvent[] }
  | { kind: 'ok' };
