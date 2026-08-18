import { randomUUID } from 'node:crypto';

import { AuditStoreLogic } from '../audit/store.ts';
import type { AuditEvent } from '../audit/types.ts';
import { promisify } from '../state/async-facade.ts';
import { openStateDb } from '../state/node-state-db.ts';
import type { StateDb } from '../state/state-db.ts';
import { identityError } from './errors.ts';
import { installIdentityMigrations } from './migrations.ts';
import type {
  BindExternalIdentityInput,
  BindActorExternalIdentityInput,
  ActorExternalIdentityBinding,
  ActorIdentityBindingHandoff,
  ActivateAccessOwnerInput,
  AdvanceAuthOperationInput,
  AuthControl,
  AuthOperation,
  AuthOperationKind,
  AuthProviderConfig,
  AuthRateLimitState,
  BootstrapTokenOwnerInput,
  BrowserSessionRecord,
  ClaimOwnerInput,
  ConsumeInvitationInput,
  ConsumeAuthOperationInput,
  CompletePasswordSetupInput,
  ConfigureAuthProviderInput,
  CreateBrowserSessionRecordInput,
  CreateInvitationInput,
  CreateAuthOperationInput,
  CreateOwnerClaimInput,
  CreatePersonalTokenRecordInput,
  EnsureOrganizationInput,
  EnsureAuthControlInput,
  ExternalIdentityBinding,
  IdentityExportSummary,
  IdentityResolution,
  IdentityRpcRequest,
  IdentityRpcResponse,
  IdentityStore,
  Invitation,
  Membership,
  MembershipAccessOverlay,
  Organization,
  OwnerClaim,
  PersonalTokenRecord,
  RecordIdentityAuthAuditInput,
  ResendInvitationInput,
  ReplaceAccessOwnerBindingInput,
  SetMembershipAccessOverlayInput,
  UpdateMembershipInput,
  UpdateAuthControlInput,
  UpdateOrganizationAuthInput,
  User,
} from './types.ts';

interface IdentityStoreOptions {
  now?: () => number;
}

interface OrganizationRow {
  organization_id: string;
  display_name: string;
  auth_mode: Organization['authMode'];
  canonical_admin_origin: string | null;
  created_at: number;
  updated_at: number;
}

interface UserRow {
  user_id: string;
  primary_email: string;
  display_name: string | null;
  created_at: number;
  updated_at: number;
}

interface BindingRow {
  binding_id: string;
  user_id: string;
  provider: string;
  issuer: string;
  subject: string;
  verified_email: string;
  created_at: number;
  updated_at: number;
}

interface ActorBindingRow {
  binding_id: string; provider: 'slack'; issuer: string; subject: string;
  user_id: string; organization_id: string; membership_id: string;
  revision: number; created_at: number; updated_at: number;
}

interface MembershipRow {
  membership_id: string;
  organization_id: string;
  user_id: string;
  role: Membership['role'];
  status: Membership['status'];
  created_at: number;
  updated_at: number;
}

interface OwnerClaimRow {
  owner_claim_id: string;
  organization_id: string;
  normalized_email: string;
  status: OwnerClaim['status'];
  binding_id: string | null;
  created_at: number;
  updated_at: number;
}

interface InvitationRow {
  invitation_id: string;
  organization_id: string;
  normalized_email: string;
  role: Invitation['role'];
  token_hash: string;
  status: Invitation['status'];
  inviter_membership_id: string;
  accepted_membership_id: string | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

interface PersonalTokenRow {
  personal_token_id: string;
  organization_id: string | null;
  user_id: string;
  membership_id: string | null;
  token_hash: string;
  prefix: string;
  label: string;
  status: PersonalTokenRecord['status'];
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

interface BrowserSessionRow {
  browser_session_id: string;
  organization_id: string | null;
  user_id: string;
  membership_id: string | null;
  personal_token_id: string;
  session_hash: string;
  prefix: string;
  expires_at: number;
  last_seen_at: number;
  revoked_at: number | null;
  created_at: number;
}

interface AuthProviderConfigRow {
  auth_provider_config_id: string;
  organization_id: string;
  kind: string;
  state: AuthProviderConfig['state'];
  issuer: string | null;
  audience: string | null;
  admission_state: AuthProviderConfig['admissionState'];
  created_at: number;
  updated_at: number;
}

interface AuthRateLimitRow {
  bucket: string;
  key_hash: string;
  window_start: number;
  failures: number;
}

interface AuthControlRow {
  installation_id: string;
  auth_mode: AuthControl['authMode'];
  canonical_admin_origin: string | null;
  better_auth_organization_id: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
}

interface AuthOperationRow {
  operation_id: string;
  kind: AuthOperation['kind'];
  organization_id: string | null;
  expected_normalized_email: string;
  capability_hash: string;
  status: AuthOperation['status'];
  step: number;
  better_auth_user_id: string | null;
  better_auth_organization_id: string | null;
  better_auth_membership_id: string | null;
  better_auth_invitation_id: string | null;
  target_credential_version: number | null;
  expires_at: number;
  consumed_at: number | null;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
}

const OSS_ORGANIZATION_ID = 'org_oss';
const DEFAULT_INSTALLATION_ID = 'installation_oss';

/**
 * Target-neutral identity lifecycle logic. Callers get transaction-oriented
 * operations instead of direct table access so the Node and Durable Object
 * paths enforce the same ownership and invitation invariants.
 */
export class IdentityStoreLogic {
  private readonly audit: AuditStoreLogic;
  private readonly now: () => number;

  constructor(
    private readonly db: StateDb,
    options: IdentityStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.audit = new AuditStoreLogic(db);
    this.initializeSchema();
  }

  execute(request: IdentityRpcRequest): IdentityRpcResponse {
    switch (request.kind) {
      case 'ensure_auth_control':
        return { kind: 'auth_control', control: this.ensureAuthControl(request.input) };
      case 'get_auth_control':
        return { kind: 'auth_control', control: this.getAuthControl(request.installationId) ?? null };
      case 'update_auth_control':
        return { kind: 'auth_control', control: this.updateAuthControl(request.input) };
      case 'create_auth_operation':
        return { kind: 'auth_operation', operation: this.createAuthOperation(request.input) };
      case 'reserve_pending_auth_operation': {
        const reservation = this.reservePendingAuthOperation(request.input);
        return { kind: 'auth_operation_reservation', ...reservation };
      }
      case 'get_auth_operation':
        return { kind: 'auth_operation', operation: this.getAuthOperation(request.operationId) ?? null };
      case 'find_auth_operation':
        return {
          kind: 'auth_operation',
          operation: this.findAuthOperation(request.operationKind, request.capabilityHash) ?? null,
        };
      case 'list_auth_operations':
        return {
          kind: 'auth_operations',
          operations: this.listAuthOperations(request.operationKind, request.organizationId),
        };
      case 'advance_auth_operation':
        return { kind: 'auth_operation', operation: this.advanceAuthOperation(request.input) };
      case 'consume_auth_operation':
        return { kind: 'auth_operation', operation: this.consumeAuthOperation(request.input) };
      case 'complete_password_setup':
        return { kind: 'auth_control', control: this.completePasswordSetup(request.input) };
      case 'revoke_auth_operation':
        return { kind: 'auth_operation', operation: this.revokeAuthOperation(request.operationId) };
      case 'get_membership_access_overlay':
        return {
          kind: 'membership_access_overlay',
          overlay: this.getMembershipAccessOverlay(request.membershipId) ?? null,
        };
      case 'set_membership_access_overlay':
        return {
          kind: 'membership_access_overlay',
          overlay: this.setMembershipAccessOverlay(request.input),
        };
      case 'ensure_organization':
        return { kind: 'organization', organization: this.ensureOrganization(request.input) };
      case 'get_organization':
        return { kind: 'organization', organization: this.getOrganization() ?? null };
      case 'create_owner_claim':
        return { kind: 'owner_claim', ownerClaim: this.createOwnerClaim(request.input) };
      case 'get_owner_claim':
        return { kind: 'owner_claim', ownerClaim: this.getOwnerClaim() ?? null };
      case 'claim_owner':
        return { kind: 'identity_resolution', resolution: this.claimOwner(request.input) };
      case 'bootstrap_token_owner':
        return { kind: 'identity_resolution', resolution: this.bootstrapTokenOwner(request.input) };
      case 'activate_access_owner':
        return { kind: 'identity_resolution', resolution: this.activateAccessOwner(request.input) };
      case 'replace_access_owner_binding':
        return {
          kind: 'identity_resolution',
          resolution: this.replaceAccessOwnerBinding(request.input),
        };
      case 'resolve_external_identity':
        return {
          kind: 'identity_resolution',
          resolution: this.resolveExternalIdentity(
            request.provider,
            request.issuer,
            request.subject,
            request.organizationId,
          ) ?? null,
        };
      case 'list_external_identities':
        return { kind: 'external_identities', externalIdentities: this.listExternalIdentities() };
      case 'resolve_actor_external_identity':
        return { kind: 'actor_external_identity', binding: this.resolveActorExternalIdentity(request.provider, request.issuer, request.subject) ?? null };
      case 'bind_actor_external_identity':
        return { kind: 'actor_external_identity', binding: this.bindActorExternalIdentity(request.input) };
      case 'create_actor_identity_binding_handoff':
        this.createActorIdentityBindingHandoff(request.input); return { kind: 'ok' };
      case 'get_actor_identity_binding_handoff':
        return { kind: 'actor_identity_binding_handoff', handoff: this.getActorIdentityBindingHandoff(request.tokenHash) ?? null };
      case 'consume_actor_identity_binding_handoff':
        return { kind: 'actor_identity_binding_handoff', handoff: this.consumeActorIdentityBindingHandoff(request.tokenHash, request.consumedAt) ?? null };
      case 'list_memberships':
        return { kind: 'memberships', memberships: this.listMemberships() };
      case 'get_user':
        return { kind: 'user', user: this.getUser(request.userId) ?? null };
      case 'find_user_by_email':
        return { kind: 'user', user: this.findUserByEmail(request.email) ?? null };
      case 'get_membership':
        return { kind: 'membership', membership: this.getMembership(request.membershipId) ?? null };
      case 'get_membership_for_user': {
        const membership = this.getMembershipForUser(request.userId, request.organizationId);
        return { kind: 'memberships', memberships: membership ? [membership] : [] };
      }
      case 'update_membership':
        return { kind: 'membership', membership: this.updateMembership(request.input) };
      case 'create_invitation':
        return { kind: 'invitation', invitation: this.createInvitation(request.input) };
      case 'resend_invitation':
        return { kind: 'invitation', invitation: this.resendInvitation(request.input) };
      case 'revoke_invitation':
        return { kind: 'invitation', invitation: this.revokeInvitation(request.invitationId) };
      case 'consume_invitation':
        return { kind: 'identity_resolution', resolution: this.consumeInvitation(request.input) };
      case 'list_invitations':
        return { kind: 'invitations', invitations: this.listInvitations() };
      case 'create_personal_token':
        return { kind: 'personal_token', personalToken: this.createPersonalToken(request.input) };
      case 'rotate_personal_token':
        return { kind: 'personal_token_rotation', result: this.rotatePersonalToken(request.input) };
      case 'find_personal_tokens':
        return { kind: 'personal_tokens', personalTokens: this.findPersonalTokens(request.prefix) };
      case 'get_personal_token': {
        const token = this.getPersonalToken(request.tokenId);
        return { kind: 'personal_tokens', personalTokens: token ? [token] : [] };
      }
      case 'revoke_personal_token':
        return { kind: 'personal_token', personalToken: this.revokePersonalToken(request.tokenId) };
      case 'touch_personal_token':
        return { kind: 'personal_token', personalToken: this.touchPersonalToken(request.tokenId) };
      case 'create_browser_session':
        return { kind: 'browser_session', browserSession: this.createBrowserSession(request.input) };
      case 'find_browser_sessions':
        return { kind: 'browser_sessions', browserSessions: this.findBrowserSessions(request.prefix) };
      case 'revoke_browser_session':
        return { kind: 'browser_session', browserSession: this.revokeBrowserSession(request.sessionId) };
      case 'configure_auth_provider':
        return { kind: 'auth_provider_config', config: this.configureAuthProvider(request.input) };
      case 'get_auth_provider_config':
        return { kind: 'auth_provider_config', config: this.getAuthProviderConfig(request.providerKind) ?? null };
      case 'update_auth_provider_audience':
        return {
          kind: 'auth_provider_config',
          config: this.updateAuthProviderAudience(
            request.providerKind,
            request.audience,
            request.actorMembershipId,
          ),
        };
      case 'update_organization_auth':
        return { kind: 'organization', organization: this.updateOrganizationAuth(request.input) };
      case 'get_auth_rate_limit':
        return {
          kind: 'auth_rate_limit',
          state: this.getAuthRateLimit(request.bucket, request.keyHash) ?? null,
        };
      case 'record_auth_rate_failure':
        return {
          kind: 'auth_rate_limit',
          state: this.recordAuthRateFailure(request.bucket, request.keyHash, request.windowStart),
        };
      case 'clear_auth_rate_limit':
        this.clearAuthRateLimit(request.bucket, request.keyHash);
        return { kind: 'ok' };
      case 'record_identity_auth_audit':
        this.recordAuthAudit(request.input);
        return { kind: 'ok' };
      case 'export_summary':
        return { kind: 'export_summary', summary: this.exportSummary() };
      case 'list_identity_audit_events':
        return { kind: 'audit_events', events: this.listAuditEvents(request.limit) };
    }
  }

  resolveActorExternalIdentity(provider: 'slack', issuer: string, subject: string): ActorExternalIdentityBinding | undefined {
    const row = this.db.get(
      `SELECT * FROM identity_actor_external_bindings WHERE provider = ? AND issuer = ? AND subject = ?`,
      provider, strictText(issuer, 'issuer', 256), strictText(subject, 'subject', 256),
    ) as ActorBindingRow | undefined;
    return row ? actorBindingFromRow(row) : undefined;
  }

  bindActorExternalIdentity(input: BindActorExternalIdentityInput): ActorExternalIdentityBinding {
    if (input.provider !== 'slack') throw identityError('identity_invalid', 'Actor identity provider is invalid.');
    const issuer = strictText(input.issuer, 'issuer', 256);
    const subject = strictText(input.subject, 'subject', 256);
    const userId = strictText(input.userId, 'userId', 256);
    const organizationId = strictText(input.organizationId, 'organizationId', 256);
    const membershipId = strictText(input.membershipId, 'membershipId', 256);
    const at = input.at ?? this.now();
    const current = this.resolveActorExternalIdentity('slack', issuer, subject);
    if (current && current.userId === userId && current.organizationId === organizationId && current.membershipId === membershipId) return current;
    if (current) {
      this.db.run(
        `UPDATE identity_actor_external_bindings SET user_id = ?, organization_id = ?, membership_id = ?, revision = revision + 1, updated_at = ? WHERE binding_id = ?`,
        userId, organizationId, membershipId, at, current.id,
      );
      return this.resolveActorExternalIdentity('slack', issuer, subject)!;
    }
    const id = `actor_binding_${randomUUID()}`;
    this.db.run(
      `INSERT INTO identity_actor_external_bindings (binding_id, provider, issuer, subject, user_id, organization_id, membership_id, revision, created_at, updated_at) VALUES (?, 'slack', ?, ?, ?, ?, ?, 1, ?, ?)`,
      id, issuer, subject, userId, organizationId, membershipId, at, at,
    );
    return this.resolveActorExternalIdentity('slack', issuer, subject)!;
  }

  createActorIdentityBindingHandoff(input: ActorIdentityBindingHandoff): void {
    if (!input.handoffId || !input.tokenHash || !input.issuer || !input.subject || !input.slackIdentityId ||
        !Number.isSafeInteger(input.slackIdentityRevision) || input.slackIdentityRevision < 0 ||
        !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= this.now() || input.consumedAt !== null) {
      throw identityError('identity_invalid', 'Slack actor binding handoff is invalid.');
    }
    this.db.run(
      `INSERT INTO identity_actor_binding_handoffs (handoff_id, token_hash, issuer, subject, slack_identity_id, slack_identity_revision, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      input.handoffId, input.tokenHash, input.issuer, input.subject, input.slackIdentityId,
      input.slackIdentityRevision, input.expiresAt,
    );
  }

  getActorIdentityBindingHandoff(tokenHash: string): ActorIdentityBindingHandoff | undefined {
    const row = this.db.get(
      `SELECT * FROM identity_actor_binding_handoffs WHERE token_hash = ? AND consumed_at IS NULL AND expires_at >= ?`,
      strictText(tokenHash, 'tokenHash', 512), this.now(),
    ) as Record<string, unknown> | undefined;
    return row ? actorHandoffFromRow(row) : undefined;
  }

  consumeActorIdentityBindingHandoff(tokenHash: string, consumedAt: number): ActorIdentityBindingHandoff | undefined {
    return this.db.transaction(() => {
      const current = this.getActorIdentityBindingHandoff(tokenHash);
      if (!current || current.expiresAt < consumedAt) return undefined;
      const changed = this.db.run(
        `UPDATE identity_actor_binding_handoffs SET consumed_at = ? WHERE handoff_id = ? AND consumed_at IS NULL`,
        consumedAt, current.handoffId,
      ).changes;
      return changed === 1 ? { ...current, consumedAt } : undefined;
    });
  }

  ensureAuthControl(input: EnsureAuthControlInput = {}): AuthControl {
    const installationId = input.installationId === undefined
      ? DEFAULT_INSTALLATION_ID
      : strictText(input.installationId, 'installationId', 256);
    const existing = this.getAuthControl(installationId);
    if (existing) return existing;
    const authMode = input.authMode ?? 'unconfigured';
    validateAuthMode(authMode);
    const at = this.now();
    this.db.run(
      `INSERT OR IGNORE INTO identity_auth_controls (
         installation_id, auth_mode, canonical_admin_origin,
         better_auth_organization_id, revision, created_at, updated_at
       ) VALUES (?, ?, NULL, NULL, 1, ?, ?)`,
      installationId, authMode, at, at,
    );
    return this.requiredAuthControl(installationId);
  }

  getAuthControl(installationId = DEFAULT_INSTALLATION_ID): AuthControl | undefined {
    const row = this.db.get(
      'SELECT * FROM identity_auth_controls WHERE installation_id = ?',
      strictText(installationId, 'installationId', 256),
    );
    return row ? rowToAuthControl(row as unknown as AuthControlRow) : undefined;
  }

  updateAuthControl(input: UpdateAuthControlInput): AuthControl {
    const installationId = input.installationId ?? DEFAULT_INSTALLATION_ID;
    const current = this.requiredAuthControl(installationId);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision <= 0) {
      throw identityError('identity_invalid', 'Control revision is invalid.');
    }
    const authMode = input.authMode ?? current.authMode;
    validateAuthMode(authMode);
    const origin = input.canonicalAdminOrigin === undefined
      ? current.canonicalAdminOrigin
      : input.canonicalAdminOrigin === null ? null : validOrigin(input.canonicalAdminOrigin);
    const betterAuthOrganizationId = input.betterAuthOrganizationId === undefined
      ? current.betterAuthOrganizationId
      : input.betterAuthOrganizationId === null
        ? null
        : strictText(input.betterAuthOrganizationId, 'betterAuthOrganizationId', 256);
    const at = this.now();
    const result = this.db.run(
      `UPDATE identity_auth_controls
       SET auth_mode = ?, canonical_admin_origin = ?, better_auth_organization_id = ?,
           revision = revision + 1, updated_at = ?
       WHERE installation_id = ? AND revision = ?`,
      authMode, origin, betterAuthOrganizationId, at, current.installationId,
      input.expectedRevision,
    );
    if (result.changes !== 1) {
      throw identityError('auth_control_conflict', 'Authentication control changed concurrently.');
    }
    return this.requiredAuthControl(current.installationId);
  }

  getMembershipAccessOverlay(membershipId: string): MembershipAccessOverlay | undefined {
    const row = this.db.get(
      `SELECT membership_id, organization_id, access_status, membership_version,
              created_at, updated_at
       FROM identity_membership_access_overlays WHERE membership_id = ?`,
      strictText(membershipId, 'membershipId', 256),
    ) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      membershipId: String(row.membership_id),
      organizationId: String(row.organization_id),
      accessStatus: row.access_status === 'suspended' ? 'suspended' : 'active',
      membershipVersion: Number(row.membership_version),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  setMembershipAccessOverlay(input: SetMembershipAccessOverlayInput): MembershipAccessOverlay {
    const membershipId = strictText(input.membershipId, 'membershipId', 256);
    const organizationId = strictText(input.organizationId, 'organizationId', 256);
    const actorMembershipId = input.actorMembershipId === undefined
      ? null
      : strictText(input.actorMembershipId, 'actorMembershipId', 256);
    const accessStatus = input.accessStatus;
    if (accessStatus !== 'active' && accessStatus !== 'suspended') {
      throw identityError('identity_invalid', 'Membership access status is invalid.');
    }
    const current = this.getMembershipAccessOverlay(membershipId);
    const ownerMembershipIds = input.ownerMembershipIds?.map((id) =>
      strictText(id, 'ownerMembershipId', 256));
    if (ownerMembershipIds && new Set(ownerMembershipIds).size !== ownerMembershipIds.length) {
      throw identityError('identity_invalid', 'Owner membership list contains duplicates.');
    }
    if (accessStatus === 'suspended' && ownerMembershipIds?.includes(membershipId)) {
      const hasOtherActiveOwner = ownerMembershipIds.some((ownerId) =>
        ownerId !== membershipId &&
        this.getMembershipAccessOverlay(ownerId)?.accessStatus !== 'suspended');
      if (!hasOtherActiveOwner) {
        throw identityError('last_owner_required', 'At least one active owner is required.', {
          membershipId,
        });
      }
    }
    const expectedVersion = input.expectedVersion;
    if (expectedVersion !== undefined &&
        (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
         (current?.membershipVersion ?? 0) !== expectedVersion)) {
      throw identityError('auth_operation_conflict', 'Membership access changed concurrently.');
    }
    if (current && current.organizationId !== organizationId) {
      throw identityError('identity_invalid', 'Membership access organization is immutable.');
    }
    const at = input.at ?? this.now();
    const nextVersion = (current?.membershipVersion ?? 0) + 1;
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO identity_membership_access_overlays (
           membership_id, organization_id, access_status, membership_version,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(membership_id) DO UPDATE SET
           access_status = excluded.access_status,
           membership_version = excluded.membership_version,
           updated_at = excluded.updated_at`,
        membershipId,
        organizationId,
        accessStatus,
        nextVersion,
        current?.createdAt ?? at,
        at,
      );
      this.appendAudit(
        'identity.membership_access_updated',
        membershipId,
        at,
        actorMembershipId,
        { accessStatus, membershipVersion: String(nextVersion) },
      );
    });
    return this.getMembershipAccessOverlay(membershipId)!;
  }

  createAuthOperation(input: CreateAuthOperationInput): AuthOperation {
    const id = input.id === undefined ? newId('auth_operation') : strictText(input.id, 'operationId', 256);
    const email = normalizeEmail(input.expectedEmail);
    const capabilityHash = credentialHash(input.capabilityHash);
    const organizationId = input.organizationId === undefined || input.organizationId === null
      ? null
      : strictText(input.organizationId, 'organizationId', 256);
    const targetCredentialVersion = input.targetCredentialVersion ?? null;
    if (targetCredentialVersion !== null &&
        (!Number.isSafeInteger(targetCredentialVersion) || targetCredentialVersion <= 0)) {
      throw identityError('identity_invalid', 'Target credential version is invalid.');
    }
    const at = this.now();
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= at) {
      throw identityError('identity_invalid', 'Operation expiry must be in the future.');
    }
    validateAuthOperationKind(input.kind);
    const existingRow = this.db.get(
      `SELECT * FROM identity_auth_operations
       WHERE operation_id = ? OR capability_hash = ? LIMIT 1`,
      id, capabilityHash,
    );
    const existing = existingRow
      ? rowToAuthOperation(existingRow as unknown as AuthOperationRow)
      : undefined;
    if (existing) {
      if (existing.id === id && existing.kind === input.kind &&
          existing.expectedNormalizedEmail === email && existing.capabilityHash === capabilityHash &&
          existing.organizationId === organizationId && existing.expiresAt === input.expiresAt &&
          existing.targetCredentialVersion === targetCredentialVersion) return existing;
      throw identityError('auth_operation_conflict', 'Authentication operation already exists.');
    }
    const inserted = this.db.run(
      `INSERT OR IGNORE INTO identity_auth_operations (
         operation_id, kind, organization_id, expected_normalized_email,
         capability_hash, status, step, better_auth_user_id,
         better_auth_organization_id, better_auth_membership_id,
         better_auth_invitation_id, target_credential_version, expires_at,
         consumed_at, revoked_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, ?, ?)`,
      id, input.kind, organizationId, email, capabilityHash,
      targetCredentialVersion, input.expiresAt, at, at,
    );
    if (inserted.changes !== 1) {
      const racedRow = this.db.get(
        `SELECT * FROM identity_auth_operations
         WHERE operation_id = ? OR capability_hash = ? LIMIT 1`,
        id, capabilityHash,
      );
      const raced = racedRow
        ? rowToAuthOperation(racedRow as unknown as AuthOperationRow)
        : undefined;
      if (raced && raced.id === id && raced.kind === input.kind &&
          raced.expectedNormalizedEmail === email && raced.capabilityHash === capabilityHash &&
          raced.organizationId === organizationId && raced.expiresAt === input.expiresAt &&
          raced.targetCredentialVersion === targetCredentialVersion) return raced;
      throw identityError('auth_operation_conflict', 'Authentication operation already exists.');
    }
    return this.requiredAuthOperation(id);
  }

  reservePendingAuthOperation(input: CreateAuthOperationInput): {
    operation: AuthOperation;
    created: boolean;
  } {
    const email = normalizeEmail(input.expectedEmail);
    credentialHash(input.capabilityHash);
    const organizationId = input.organizationId === undefined || input.organizationId === null
      ? null
      : strictText(input.organizationId, 'organizationId', 256);
    const targetCredentialVersion = input.targetCredentialVersion ?? null;
    if (targetCredentialVersion !== null &&
        (!Number.isSafeInteger(targetCredentialVersion) || targetCredentialVersion <= 0)) {
      throw identityError('identity_invalid', 'Target credential version is invalid.');
    }
    validateAuthOperationKind(input.kind);
    const at = this.now();
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= at) {
      throw identityError('identity_invalid', 'Operation expiry must be in the future.');
    }
    this.db.run(
      `UPDATE identity_auth_operations
       SET status = 'expired', updated_at = ?
       WHERE kind = ? AND organization_id IS ? AND expected_normalized_email = ?
         AND status = 'pending' AND expires_at <= ?`,
      at, input.kind, organizationId, email, at,
    );
    const existingRow = this.db.get(
      `SELECT * FROM identity_auth_operations
       WHERE kind = ? AND organization_id IS ? AND expected_normalized_email = ?
         AND status = 'pending'
       ORDER BY created_at, operation_id
       LIMIT 1`,
      input.kind, organizationId, email,
    );
    if (existingRow) {
      return {
        operation: rowToAuthOperation(existingRow as unknown as AuthOperationRow),
        created: false,
      };
    }
    return { operation: this.createAuthOperation(input), created: true };
  }

  getAuthOperation(operationId: string): AuthOperation | undefined {
    const row = this.db.get(
      'SELECT * FROM identity_auth_operations WHERE operation_id = ?',
      strictText(operationId, 'operationId', 256),
    );
    return row ? rowToAuthOperation(row as unknown as AuthOperationRow) : undefined;
  }

  findAuthOperation(kind: AuthOperationKind, capabilityHash: string): AuthOperation | undefined {
    validateAuthOperationKind(kind);
    const row = this.db.get(
      `SELECT * FROM identity_auth_operations
       WHERE kind = ? AND capability_hash = ?`,
      kind, credentialHash(capabilityHash),
    );
    return row ? rowToAuthOperation(row as unknown as AuthOperationRow) : undefined;
  }

  listAuthOperations(kind?: AuthOperationKind, organizationId?: string): AuthOperation[] {
    if (kind !== undefined) validateAuthOperationKind(kind);
    const normalizedOrganizationId = organizationId === undefined
      ? undefined
      : strictText(organizationId, 'organizationId', 256);
    return this.db
      .all(
        `SELECT * FROM identity_auth_operations
         WHERE (? IS NULL OR kind = ?)
           AND (? IS NULL OR organization_id = ?)
         ORDER BY created_at, operation_id`,
        kind ?? null,
        kind ?? null,
        normalizedOrganizationId ?? null,
        normalizedOrganizationId ?? null,
      )
      .map((row) => rowToAuthOperation(row as unknown as AuthOperationRow));
  }

  advanceAuthOperation(input: AdvanceAuthOperationInput): AuthOperation {
    const current = this.requiredPendingAuthOperation(
      input.operationId,
      input.capabilityHash,
      input.at ?? this.now(),
    );
    if (!Number.isSafeInteger(input.step) || input.step < current.step || input.step > current.step + 1) {
      throw identityError('auth_operation_step_invalid', 'Authentication operation step is invalid.');
    }
    const next = {
      user: mergeOpaqueId(current.betterAuthUserId, input.betterAuthUserId, 'betterAuthUserId'),
      organization: mergeOpaqueId(
        current.betterAuthOrganizationId,
        input.betterAuthOrganizationId,
        'betterAuthOrganizationId',
      ),
      membership: mergeOpaqueId(
        current.betterAuthMembershipId,
        input.betterAuthMembershipId,
        'betterAuthMembershipId',
      ),
      invitation: mergeOpaqueId(
        current.betterAuthInvitationId,
        input.betterAuthInvitationId,
        'betterAuthInvitationId',
      ),
    };
    const at = input.at ?? this.now();
    const advanced = this.db.run(
      `UPDATE identity_auth_operations
       SET step = ?, better_auth_user_id = ?, better_auth_organization_id = ?,
           better_auth_membership_id = ?, better_auth_invitation_id = ?, updated_at = ?
       WHERE operation_id = ? AND status = 'pending' AND step = ?`,
      input.step, next.user, next.organization, next.membership, next.invitation,
      at, current.id, current.step,
    );
    if (advanced.changes !== 1) {
      const latest = this.requiredAuthOperation(current.id);
      mergeOpaqueId(latest.betterAuthUserId, input.betterAuthUserId, 'betterAuthUserId');
      mergeOpaqueId(
        latest.betterAuthOrganizationId,
        input.betterAuthOrganizationId,
        'betterAuthOrganizationId',
      );
      mergeOpaqueId(
        latest.betterAuthMembershipId,
        input.betterAuthMembershipId,
        'betterAuthMembershipId',
      );
      mergeOpaqueId(
        latest.betterAuthInvitationId,
        input.betterAuthInvitationId,
        'betterAuthInvitationId',
      );
      if (latest.status !== 'pending' || latest.step !== input.step) {
        throw identityError('auth_operation_conflict', 'Authentication operation changed concurrently.');
      }
      return latest;
    }
    return this.requiredAuthOperation(current.id);
  }

  consumeAuthOperation(input: ConsumeAuthOperationInput): AuthOperation {
    const at = input.at ?? this.now();
    const current = this.requiredPendingAuthOperation(input.operationId, input.capabilityHash, at);
    if (!Number.isSafeInteger(input.expectedStep) || current.step !== input.expectedStep) {
      throw identityError('auth_operation_step_invalid', 'Authentication operation is incomplete.');
    }
    const result = this.db.run(
      `UPDATE identity_auth_operations
       SET status = 'consumed', consumed_at = ?, updated_at = ?
       WHERE operation_id = ? AND status = 'pending' AND step = ?`,
      at, at, current.id, current.step,
    );
    if (result.changes !== 1) {
      throw identityError('auth_operation_unavailable', 'Authentication operation is unavailable.');
    }
    return this.requiredAuthOperation(current.id);
  }

  completePasswordSetup(input: CompletePasswordSetupInput): AuthControl {
    const at = input.at ?? this.now();
    return this.db.transaction(() => {
      const operation = this.requiredPendingAuthOperation(
        input.operationId,
        input.capabilityHash,
        at,
      );
      const control = this.requiredAuthControl(DEFAULT_INSTALLATION_ID);
      const origin = validOrigin(input.canonicalAdminOrigin);
      const organizationId = strictText(
        input.betterAuthOrganizationId,
        'betterAuthOrganizationId',
        256,
      );
      const expectedControlAuthMode = input.expectedControlAuthMode;
      if (!['unconfigured', 'password_active'].includes(expectedControlAuthMode)) {
        throw identityError('identity_invalid', 'Expected authentication mode is invalid.');
      }
      const expectedBetterAuthOrganizationId = input.expectedBetterAuthOrganizationId === null
        ? null
        : strictText(
            input.expectedBetterAuthOrganizationId,
            'expectedBetterAuthOrganizationId',
            256,
          );
      if (operation.kind !== 'owner_setup' || operation.step !== input.expectedStep ||
          operation.betterAuthOrganizationId !== organizationId ||
          !operation.betterAuthUserId || !operation.betterAuthMembershipId ||
          control.authMode !== expectedControlAuthMode ||
          control.betterAuthOrganizationId !== expectedBetterAuthOrganizationId ||
          control.revision !== input.expectedControlRevision) {
        throw identityError('auth_operation_conflict', 'Owner setup changed concurrently.');
      }
      const activated = this.db.run(
        `UPDATE identity_auth_controls
         SET auth_mode = 'password_active', canonical_admin_origin = ?,
             better_auth_organization_id = ?, revision = revision + 1, updated_at = ?
         WHERE installation_id = ? AND auth_mode = ? AND revision = ?`,
        origin, organizationId, at, control.installationId, expectedControlAuthMode,
        control.revision,
      );
      const consumed = this.db.run(
        `UPDATE identity_auth_operations
         SET status = 'consumed', consumed_at = ?, updated_at = ?
         WHERE operation_id = ? AND status = 'pending' AND step = ?`,
        at, at, operation.id, operation.step,
      );
      if (activated.changes !== 1 || consumed.changes !== 1) {
        throw identityError('auth_operation_conflict', 'Owner setup changed concurrently.');
      }
      this.appendAudit(
        'identity.password_owner_setup_completed',
        control.installationId,
        at,
        operation.betterAuthMembershipId,
        { organizationId },
      );
      return this.requiredAuthControl(control.installationId);
    });
  }

  revokeAuthOperation(operationId: string): AuthOperation {
    const current = this.requiredAuthOperation(operationId);
    if (current.status !== 'pending') return current;
    const at = this.now();
    this.db.run(
      `UPDATE identity_auth_operations
       SET status = 'revoked', revoked_at = ?, updated_at = ?
       WHERE operation_id = ? AND status = 'pending'`,
      at, at, current.id,
    );
    return this.requiredAuthOperation(current.id);
  }

  ensureOrganization(input: EnsureOrganizationInput): Organization {
    const displayName = nonEmpty(input.displayName, 'displayName');
    const existing = this.getOrganization();
    if (existing) return existing;
    const at = this.now();
    try {
      this.db.transaction(() => {
        this.db.run(
          `INSERT INTO identity_organizations (
             organization_id, display_name, auth_mode, canonical_admin_origin,
             created_at, updated_at
           ) VALUES (?, ?, 'unconfigured', NULL, ?, ?)`,
          OSS_ORGANIZATION_ID,
          displayName,
          at,
          at,
        );
        this.appendAudit('identity.organization_initialized', OSS_ORGANIZATION_ID, at);
      });
    } catch (error) {
      const raced = this.getOrganization();
      if (raced) return raced;
      throw error;
    }
    return this.requiredOrganization();
  }

  getOrganization(): Organization | undefined {
    const row = this.db.get(
      'SELECT * FROM identity_organizations WHERE organization_id = ?',
      OSS_ORGANIZATION_ID,
    );
    return row ? rowToOrganization(row as unknown as OrganizationRow) : undefined;
  }

  createOwnerClaim(input: CreateOwnerClaimInput): OwnerClaim {
    this.requireOrganization(input.organizationId);
    const email = normalizeEmail(input.email);
    const existing = this.getOwnerClaim();
    if (existing) {
      if (existing.normalizedEmail === email) return existing;
      throw identityError(
        'owner_claim_conflict',
        'The pending owner is already configured for another email.',
        { ownerClaimId: existing.id },
      );
    }
    const at = this.now();
    const ownerClaimId = newId('owner_claim');
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO identity_owner_claims (
           owner_claim_id, organization_id, normalized_email, status,
           binding_id, created_at, updated_at
         ) VALUES (?, ?, ?, 'pending', NULL, ?, ?)`,
        ownerClaimId,
        input.organizationId,
        email,
        at,
        at,
      );
      this.appendAudit('identity.owner_claim_created', ownerClaimId, at);
    });
    return this.requiredOwnerClaim();
  }

  getOwnerClaim(): OwnerClaim | undefined {
    const row = this.db.get(
      `SELECT * FROM identity_owner_claims
       WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1`,
      OSS_ORGANIZATION_ID,
    );
    return row ? rowToOwnerClaim(row as unknown as OwnerClaimRow) : undefined;
  }

  claimOwner(input: ClaimOwnerInput): IdentityResolution {
    this.requireOrganization(input.organizationId);
    const email = normalizeEmail(input.verifiedEmail);
    validateExternalIdentity(input);
    const existing = this.resolveExternalIdentity(
      input.provider,
      input.issuer,
      input.subject,
      input.organizationId,
    );
    const claim = this.getOwnerClaim();
    if (!claim) throw identityError('owner_claim_missing', 'Owner setup has not been initialized.');
    if (claim.status === 'claimed') {
      if (existing?.binding.id === claim.bindingId && existing.membership.role === 'owner') {
        return existing;
      }
      throw identityError('owner_already_claimed', 'The owner claim has already been consumed.');
    }
    if (claim.normalizedEmail !== email) {
      throw identityError('owner_email_mismatch', 'The verified identity does not match the owner claim.');
    }
    if (existing) {
      throw identityError(
        'external_identity_conflict',
        'The external identity is already bound.',
        { bindingId: existing.binding.id },
      );
    }

    const at = input.at ?? this.now();
    const ids = { user: newId('user'), binding: newId('binding'), membership: newId('membership') };
    this.db.transaction(() => {
      this.insertIdentity(ids, input, email, 'owner', at);
      const updated = this.db.run(
        `UPDATE identity_owner_claims
         SET status = 'claimed', binding_id = ?, updated_at = ?
         WHERE owner_claim_id = ? AND status = 'pending'`,
        ids.binding,
        at,
        claim.id,
      );
      if (updated.changes !== 1) {
        throw identityError('owner_already_claimed', 'The owner claim has already been consumed.');
      }
      this.appendAudit('identity.owner_claimed', ids.membership, at, ids.membership);
    });
    return this.requiredResolution(input.provider, input.issuer, input.subject, input.organizationId);
  }

  bootstrapTokenOwner(input: BootstrapTokenOwnerInput): IdentityResolution {
    if (input.organizationId !== OSS_ORGANIZATION_ID) {
      throw identityError('identity_invalid', 'Token authentication organization is invalid.');
    }
    const displayName = nonEmpty(input.displayName, 'displayName');
    const email = normalizeEmail(input.verifiedEmail);
    validateExternalIdentity(input);
    const canonicalAdminOrigin = validOrigin(input.canonicalAdminOrigin);
    if (this.getOrganization()) {
      throw identityError('identity_invalid', 'Token authentication is already initialized.');
    }

    const at = input.at ?? this.now();
    const ownerClaimId = newId('owner_claim');
    const ids = { user: newId('user'), binding: newId('binding'), membership: newId('membership') };
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO identity_organizations (
           organization_id, display_name, auth_mode, canonical_admin_origin,
           created_at, updated_at
         ) VALUES (?, ?, 'unconfigured', NULL, ?, ?)`,
        OSS_ORGANIZATION_ID, displayName, at, at,
      );
      this.db.run(
        `INSERT INTO identity_owner_claims (
           owner_claim_id, organization_id, normalized_email, status,
           binding_id, created_at, updated_at
         ) VALUES (?, ?, ?, 'pending', NULL, ?, ?)`,
        ownerClaimId, OSS_ORGANIZATION_ID, email, at, at,
      );
      this.insertIdentity(ids, input, email, 'owner', at);
      if (this.db.run(
        `UPDATE identity_owner_claims
         SET status = 'claimed', binding_id = ?, updated_at = ?
         WHERE owner_claim_id = ? AND status = 'pending'`,
        ids.binding, at, ownerClaimId,
      ).changes !== 1) {
        throw identityError('owner_already_claimed', 'The owner claim has already been consumed.');
      }
      this.db.run(
        `UPDATE identity_organizations
         SET auth_mode = 'token_active', canonical_admin_origin = ?, updated_at = ?
         WHERE organization_id = ?`,
        canonicalAdminOrigin, at, OSS_ORGANIZATION_ID,
      );
      this.appendAudit('identity.organization_initialized', OSS_ORGANIZATION_ID, at);
      this.appendAudit('identity.owner_claim_created', ownerClaimId, at);
      this.appendAudit('identity.token_auth_activated', ids.membership, at, ids.membership);
    });
    return this.requiredResolution(input.provider, input.issuer, input.subject, OSS_ORGANIZATION_ID);
  }

  activateAccessOwner(input: ActivateAccessOwnerInput): IdentityResolution {
    this.requireOrganization(input.organizationId);
    const email = normalizeEmail(input.verifiedEmail);
    validateExternalIdentity(input);
    const issuer = strictText(input.issuer, 'issuer', 1_024);
    const audience = strictText(input.audience, 'audience', 1_024);
    const canonicalAdminOrigin = validOrigin(input.canonicalAdminOrigin);
    const existing = this.resolveExternalIdentity(
      input.provider, issuer, input.subject, input.organizationId,
    );
    const claim = this.getOwnerClaim();
    if (!claim) throw identityError('owner_claim_missing', 'Owner setup has not been initialized.');
    if (claim.status === 'claimed') {
      if (existing?.binding.id === claim.bindingId && existing.membership.role === 'owner') return existing;
      throw identityError('owner_already_claimed', 'The owner claim has already been consumed.');
    }
    if (claim.normalizedEmail !== email) {
      throw identityError('owner_email_mismatch', 'The verified identity does not match the owner claim.');
    }
    if (existing) {
      throw identityError('external_identity_conflict', 'The external identity is already bound.', {
        bindingId: existing.binding.id,
      });
    }
    const provider = this.getAuthProviderConfig(input.provider);
    if (!provider || provider.state !== 'pending' || provider.issuer !== issuer || provider.audience !== audience) {
      throw identityError('identity_invalid', 'Access provider configuration is not ready.');
    }

    const at = input.at ?? this.now();
    const ids = { user: newId('user'), binding: newId('binding'), membership: newId('membership') };
    this.db.transaction(() => {
      this.insertIdentity(ids, input, email, 'owner', at);
      if (this.db.run(
        `UPDATE identity_owner_claims SET status = 'claimed', binding_id = ?, updated_at = ?
         WHERE owner_claim_id = ? AND status = 'pending'`,
        ids.binding, at, claim.id,
      ).changes !== 1) {
        throw identityError('owner_already_claimed', 'The owner claim has already been consumed.');
      }
      this.db.run(
        `UPDATE identity_auth_provider_configs SET state = 'active', updated_at = ?
         WHERE auth_provider_config_id = ? AND state = 'pending'`,
        at, provider.id,
      );
      this.db.run(
        `UPDATE identity_organizations
         SET auth_mode = 'access_active', canonical_admin_origin = ?, updated_at = ?
         WHERE organization_id = ?`,
        canonicalAdminOrigin, at, input.organizationId,
      );
      this.appendAudit('identity.access_activated', ids.membership, at, ids.membership);
    });
    return this.requiredResolution(input.provider, issuer, input.subject, input.organizationId);
  }

  replaceAccessOwnerBinding(input: ReplaceAccessOwnerBindingInput): IdentityResolution {
    const organization = this.requireOrganization(input.organizationId);
    if (organization.authMode !== 'access_active') {
      throw identityError('identity_invalid', 'Access authentication is not active.');
    }
    validateExternalIdentity(input);
    const email = normalizeEmail(input.verifiedEmail);
    const provider = this.getAuthProviderConfig(input.provider);
    if (!provider || provider.state !== 'active' || provider.issuer !== input.issuer) {
      throw identityError('identity_invalid', 'Access provider configuration is not active.');
    }
    const claim = this.getOwnerClaim();
    if (!claim || claim.status !== 'claimed' || !claim.bindingId) {
      throw identityError('owner_claim_missing', 'The active owner binding was not found.');
    }
    const currentRow = this.db.get(
      'SELECT * FROM identity_external_bindings WHERE binding_id = ?',
      claim.bindingId,
    );
    const current = currentRow
      ? rowToBinding(currentRow as unknown as BindingRow)
      : undefined;
    if (!current || current.provider !== input.provider || current.issuer !== input.issuer ||
        normalizeEmail(current.verifiedEmail) !== email) {
      throw identityError('owner_email_mismatch', 'The verified identity does not match the owner.');
    }
    const membership = this.getMembershipForUser(current.userId, input.organizationId);
    if (!membership || membership.role !== 'owner' || membership.status !== 'active') {
      throw identityError('last_owner_required', 'An active owner binding is required.');
    }
    const existing = this.resolveExternalIdentity(
      input.provider, input.issuer, input.subject, input.organizationId,
    );
    if (existing) {
      if (existing.binding.id === current.id && existing.membership.id === membership.id) return existing;
      throw identityError('external_identity_conflict', 'The external identity is already bound.');
    }

    const at = input.at ?? this.now();
    const replacementId = newId('binding');
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO identity_external_bindings (
           binding_id, user_id, provider, issuer, subject, verified_email, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        replacementId,
        current.userId,
        input.provider,
        input.issuer,
        input.subject,
        email,
        at,
        at,
      );
      if (this.db.run(
        `UPDATE identity_owner_claims SET binding_id = ?, updated_at = ?
         WHERE owner_claim_id = ? AND binding_id = ? AND status = 'claimed'`,
        replacementId, at, claim.id, current.id,
      ).changes !== 1) {
        throw identityError('owner_already_claimed', 'The owner binding changed during recovery.');
      }
      this.db.run('DELETE FROM identity_external_bindings WHERE binding_id = ?', current.id);
      this.appendAudit('identity.access_owner_binding_replaced', membership.id, at, membership.id);
    });
    return this.requiredResolution(input.provider, input.issuer, input.subject, input.organizationId);
  }

  resolveExternalIdentity(
    provider: string,
    issuer: string,
    subject: string,
    organizationId = OSS_ORGANIZATION_ID,
  ): IdentityResolution | undefined {
    const row = this.db.get(
      `SELECT
         b.binding_id AS b_binding_id, b.user_id AS b_user_id,
         b.provider AS b_provider, b.issuer AS b_issuer, b.subject AS b_subject,
         b.verified_email AS b_verified_email, b.created_at AS b_created_at,
         b.updated_at AS b_updated_at,
         u.user_id AS u_user_id, u.primary_email AS u_primary_email,
         u.display_name AS u_display_name, u.created_at AS u_created_at,
         u.updated_at AS u_updated_at,
         m.membership_id AS m_membership_id, m.organization_id AS m_organization_id,
         m.user_id AS m_user_id, m.role AS m_role, m.status AS m_status,
         m.created_at AS m_created_at, m.updated_at AS m_updated_at
       FROM identity_external_bindings b
       JOIN identity_users u ON u.user_id = b.user_id
       JOIN identity_memberships m ON m.user_id = u.user_id AND m.organization_id = ?
       WHERE b.provider = ? AND b.issuer = ? AND b.subject = ?`,
      organizationId,
      provider,
      issuer,
      subject,
    );
    if (!row) return undefined;
    return joinedRowToResolution(row);
  }

  listExternalIdentities(): ExternalIdentityBinding[] {
    return this.db
      .all('SELECT * FROM identity_external_bindings ORDER BY created_at, binding_id')
      .map((row) => rowToBinding(row as unknown as BindingRow));
  }

  listMemberships(): Membership[] {
    return this.db
      .all('SELECT * FROM identity_memberships ORDER BY created_at, membership_id')
      .map((row) => rowToMembership(row as unknown as MembershipRow));
  }

  getUser(userId: string): User | undefined {
    const row = this.db.get('SELECT * FROM identity_users WHERE user_id = ?', userId);
    return row ? rowToUser(row as unknown as UserRow) : undefined;
  }

  findUserByEmail(email: string): User | undefined {
    const row = this.db.get(
      'SELECT * FROM identity_users WHERE primary_email = ?',
      normalizeEmail(email),
    );
    return row ? rowToUser(row as unknown as UserRow) : undefined;
  }

  getMembership(membershipId: string): Membership | undefined {
    const row = this.db.get(
      'SELECT * FROM identity_memberships WHERE membership_id = ?',
      strictText(membershipId, 'membershipId', 256),
    );
    return row ? rowToMembership(row as unknown as MembershipRow) : undefined;
  }

  getMembershipForUser(
    userId: string,
    organizationId = OSS_ORGANIZATION_ID,
  ): Membership | undefined {
    const row = this.db.get(
      `SELECT * FROM identity_memberships WHERE user_id = ? AND organization_id = ?`,
      userId,
      organizationId,
    );
    return row ? rowToMembership(row as unknown as MembershipRow) : undefined;
  }

  updateMembership(input: UpdateMembershipInput): Membership {
    const current = this.getMembership(input.membershipId);
    if (!current) {
      throw identityError('membership_missing', 'Membership was not found.', {
        membershipId: input.membershipId,
      });
    }
    const role = input.role ?? current.role;
    const status = input.status ?? current.status;
    if (current.role === 'owner' && current.status === 'active' &&
        (role !== 'owner' || status !== 'active')) {
      const count = Number(
        this.db.get(
          `SELECT COUNT(*) AS count FROM identity_memberships
           WHERE organization_id = ? AND role = 'owner' AND status = 'active'
             AND membership_id <> ?`,
          current.organizationId,
          current.id,
        )?.count ?? 0,
      );
      if (count === 0) {
        throw identityError('last_owner_required', 'At least one active owner is required.', {
          membershipId: current.id,
        });
      }
    }
    const at = this.now();
    this.db.transaction(() => {
      this.db.run(
        `UPDATE identity_memberships SET role = ?, status = ?, updated_at = ?
         WHERE membership_id = ?`,
        role,
        status,
        at,
        current.id,
      );
      this.appendAudit(
        'identity.membership_updated',
        current.id,
        at,
        input.actorMembershipId ?? null,
        { role, status },
      );
    });
    return this.requiredMembership(current.id);
  }

  createInvitation(input: CreateInvitationInput): Invitation {
    this.requireOrganization(input.organizationId);
    const inviter = this.getMembership(input.inviterMembershipId);
    if (!inviter || inviter.organizationId !== input.organizationId ||
        inviter.status !== 'active' || !['owner', 'admin'].includes(inviter.role) ||
        (input.role === 'owner' && inviter.role !== 'owner')) {
      throw identityError('inviter_not_authorized', 'The inviter cannot grant this role.');
    }
    const email = normalizeEmail(input.email);
    validateTokenHash(input.tokenHash);
    const at = this.now();
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= at) {
      throw identityError('identity_invalid', 'Invitation expiry must be in the future.');
    }
    const id = newId('invitation');
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO identity_invitations (
           invitation_id, organization_id, normalized_email, role, token_hash,
           status, inviter_membership_id, accepted_membership_id, expires_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?, ?)`,
        id,
        input.organizationId,
        email,
        input.role,
        input.tokenHash,
        input.inviterMembershipId,
        input.expiresAt,
        at,
        at,
      );
      this.appendAudit('identity.invitation_created', id, at, inviter.id, { role: input.role });
    });
    return this.requiredInvitation(id);
  }

  resendInvitation(input: ResendInvitationInput): Invitation {
    validateTokenHash(input.tokenHash);
    const invitation = this.requiredInvitation(input.invitationId);
    if (invitation.status !== 'pending') {
      throw identityError('invitation_not_pending', 'Invitation is no longer pending.', {
        invitationId: invitation.id,
      });
    }
    const at = this.now();
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= at) {
      throw identityError('identity_invalid', 'Invitation expiry must be in the future.');
    }
    this.db.transaction(() => {
      this.db.run(
        `UPDATE identity_invitations SET token_hash = ?, expires_at = ?, updated_at = ?
         WHERE invitation_id = ? AND status = 'pending'`,
        input.tokenHash,
        input.expiresAt,
        at,
        invitation.id,
      );
      this.appendAudit('identity.invitation_resent', invitation.id, at, null);
    });
    return this.requiredInvitation(invitation.id);
  }

  revokeInvitation(invitationId: string): Invitation {
    const invitation = this.requiredInvitation(invitationId);
    if (invitation.status !== 'pending') {
      throw identityError('invitation_not_pending', 'Invitation is no longer pending.', {
        invitationId,
      });
    }
    const at = this.now();
    this.db.transaction(() => {
      this.db.run(
        `UPDATE identity_invitations SET status = 'revoked', updated_at = ?
         WHERE invitation_id = ? AND status = 'pending'`,
        at,
        invitationId,
      );
      this.appendAudit('identity.invitation_revoked', invitationId, at, null);
    });
    return this.requiredInvitation(invitationId);
  }

  consumeInvitation(input: ConsumeInvitationInput): IdentityResolution {
    validateTokenHash(input.tokenHash);
    validateExternalIdentity(input);
    const email = normalizeEmail(input.verifiedEmail);
    const invitation = this.requiredInvitation(input.invitationId);
    const at = input.at ?? this.now();
    if (invitation.status !== 'pending') {
      throw identityError('invitation_not_pending', 'Invitation is no longer pending.', {
        invitationId: invitation.id,
      });
    }
    if (invitation.expiresAt <= at) {
      this.db.run(
        `UPDATE identity_invitations SET status = 'expired', updated_at = ?
         WHERE invitation_id = ? AND status = 'pending'`,
        at,
        invitation.id,
      );
      throw identityError('invitation_expired', 'Invitation has expired.', {
        invitationId: invitation.id,
      });
    }
    if (invitation.tokenHash !== input.tokenHash) {
      throw identityError('invitation_token_invalid', 'Invitation is unavailable.');
    }
    if (invitation.normalizedEmail !== email) {
      throw identityError('invitation_email_mismatch', 'Verified email does not match invitation.');
    }
    const existing = this.resolveExternalIdentity(
      input.provider,
      input.issuer,
      input.subject,
      invitation.organizationId,
    );
    if (existing) {
      throw identityError('external_identity_conflict', 'The external identity is already bound.', {
        bindingId: existing.binding.id,
      });
    }
    const ids = { user: newId('user'), binding: newId('binding'), membership: newId('membership') };
    this.db.transaction(() => {
      this.insertIdentity(ids, { ...input, organizationId: invitation.organizationId }, email,
        invitation.role, at);
      const accepted = this.db.run(
        `UPDATE identity_invitations
         SET status = 'accepted', accepted_membership_id = ?, updated_at = ?
         WHERE invitation_id = ? AND status = 'pending' AND token_hash = ?`,
        ids.membership,
        at,
        invitation.id,
        input.tokenHash,
      );
      if (accepted.changes !== 1) {
        throw identityError('invitation_not_pending', 'Invitation is no longer pending.', {
          invitationId: invitation.id,
        });
      }
      this.appendAudit('identity.invitation_accepted', invitation.id, at, ids.membership, {
        role: invitation.role,
      });
    });
    return this.requiredResolution(
      input.provider,
      input.issuer,
      input.subject,
      invitation.organizationId,
    );
  }

  listInvitations(): Invitation[] {
    return this.db
      .all('SELECT * FROM identity_invitations ORDER BY created_at, invitation_id')
      .map((row) => rowToInvitation(row as unknown as InvitationRow));
  }

  createPersonalToken(input: CreatePersonalTokenRecordInput): PersonalTokenRecord {
    const token = this.preparePersonalToken(input);
    this.db.transaction(() => {
      this.insertPersonalToken(input, token);
      this.appendAudit('identity.personal_token_created', token.id, token.at, null);
    });
    return this.requiredPersonalToken(token.id);
  }

  rotatePersonalToken(input: CreatePersonalTokenRecordInput): {
    personalToken: PersonalTokenRecord;
    revokedCount: number;
  } {
    const token = this.preparePersonalToken(input);
    let revokedCount = 0;
    this.db.transaction(() => {
      this.insertPersonalToken(input, token);
      this.db.run(
        `UPDATE identity_browser_sessions SET revoked_at = ?
         WHERE revoked_at IS NULL AND personal_token_id IN (
           SELECT personal_token_id FROM identity_personal_tokens
           WHERE user_id = ? AND personal_token_id <> ? AND status = 'active'
         )`,
        token.at, input.userId, token.id,
      );
      revokedCount = this.db.run(
        `UPDATE identity_personal_tokens SET status = 'revoked', updated_at = ?
         WHERE user_id = ? AND personal_token_id <> ? AND status = 'active'`,
        token.at, input.userId, token.id,
      ).changes;
      this.appendAudit('identity.personal_token_rotated', token.id, token.at, null, {
        revokedCount: String(revokedCount),
      });
    });
    return { personalToken: this.requiredPersonalToken(token.id), revokedCount };
  }

  findPersonalTokens(prefix: string): PersonalTokenRecord[] {
    return this.db
      .all(
        'SELECT * FROM identity_personal_tokens WHERE prefix = ? ORDER BY created_at, personal_token_id',
        credentialPrefix(prefix),
      )
      .map((row) => rowToPersonalToken(row as unknown as PersonalTokenRow));
  }

  getPersonalToken(tokenId: string): PersonalTokenRecord | undefined {
    const row = this.db.get(
      'SELECT * FROM identity_personal_tokens WHERE personal_token_id = ?',
      tokenId,
    );
    return row ? rowToPersonalToken(row as unknown as PersonalTokenRow) : undefined;
  }

  revokePersonalToken(tokenId: string): PersonalTokenRecord {
    const token = this.requiredPersonalToken(tokenId);
    if (token.status === 'revoked') return token;
    const at = this.now();
    this.db.transaction(() => {
      this.db.run(
        `UPDATE identity_personal_tokens SET status = 'revoked', updated_at = ?
         WHERE personal_token_id = ?`,
        at,
        tokenId,
      );
      this.db.run(
        `UPDATE identity_browser_sessions SET revoked_at = ?
         WHERE personal_token_id = ? AND revoked_at IS NULL`,
        at,
        tokenId,
      );
      this.appendAudit('identity.personal_token_revoked', tokenId, at, null);
    });
    return this.requiredPersonalToken(tokenId);
  }

  touchPersonalToken(tokenId: string): PersonalTokenRecord {
    this.requiredPersonalToken(tokenId);
    const at = this.now();
    this.db.run(
      `UPDATE identity_personal_tokens SET last_used_at = ?, updated_at = ?
       WHERE personal_token_id = ?`,
      at,
      at,
      tokenId,
    );
    return this.requiredPersonalToken(tokenId);
  }

  createBrowserSession(input: CreateBrowserSessionRecordInput): BrowserSessionRecord {
    const token = this.requiredPersonalToken(input.personalTokenId);
    if (token.userId !== input.userId || token.status !== 'active') {
      throw identityError('identity_invalid', 'Session source token is unavailable.');
    }
    const organizationId = input.organizationId ?? token.organizationId;
    const membershipId = input.membershipId ?? token.membershipId;
    if (organizationId !== token.organizationId || membershipId !== token.membershipId) {
      throw identityError('identity_invalid', 'Session membership does not match its source token.');
    }
    validateTokenHash(input.sessionHash);
    const prefix = credentialPrefix(input.prefix);
    const at = this.now();
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= at) {
      throw identityError('identity_invalid', 'Session expiry is invalid.');
    }
    const id = newId('browser_session');
    this.db.run(
      `INSERT INTO identity_browser_sessions (
         browser_session_id, organization_id, user_id, membership_id,
         personal_token_id, session_hash, prefix, expires_at, last_seen_at,
         revoked_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      id,
      organizationId,
      input.userId,
      membershipId,
      input.personalTokenId,
      input.sessionHash,
      prefix,
      input.expiresAt,
      at,
      at,
    );
    return this.requiredBrowserSession(id);
  }

  findBrowserSessions(prefix: string): BrowserSessionRecord[] {
    return this.db
      .all(
        'SELECT * FROM identity_browser_sessions WHERE prefix = ? ORDER BY created_at, browser_session_id',
        credentialPrefix(prefix),
      )
      .map((row) => rowToBrowserSession(row as unknown as BrowserSessionRow));
  }

  revokeBrowserSession(sessionId: string): BrowserSessionRecord {
    const session = this.requiredBrowserSession(sessionId);
    if (session.revokedAt !== null) return session;
    this.db.run(
      'UPDATE identity_browser_sessions SET revoked_at = ? WHERE browser_session_id = ?',
      this.now(),
      sessionId,
    );
    return this.requiredBrowserSession(sessionId);
  }

  configureAuthProvider(input: ConfigureAuthProviderInput): AuthProviderConfig {
    this.requireOrganization(input.organizationId);
    const kind = nonEmpty(input.kind, 'kind');
    const issuer = input.issuer === undefined || input.issuer === null
      ? null : strictText(input.issuer, 'issuer', 1_024);
    const audience = input.audience === undefined || input.audience === null
      ? null : strictText(input.audience, 'audience', 1_024);
    const existing = this.getAuthProviderConfig(kind);
    const at = this.now();
    if (existing) {
      this.db.run(
        `UPDATE identity_auth_provider_configs
         SET state = ?, issuer = ?, audience = ?, admission_state = ?, updated_at = ?
         WHERE auth_provider_config_id = ?`,
        input.state, issuer, audience, input.admissionState ?? existing.admissionState,
        at, existing.id,
      );
      const updated = this.requiredAuthProviderConfig(kind);
      this.appendAudit('identity.auth_provider_configured', updated.id, at, null, {
        state: updated.state,
      });
      return updated;
    }
    const id = newId('auth_provider');
    this.db.run(
      `INSERT INTO identity_auth_provider_configs (
         auth_provider_config_id, organization_id, kind, state, issuer, audience,
         admission_state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.organizationId, kind, input.state, issuer, audience,
      input.admissionState ?? null, at, at,
    );
    this.appendAudit('identity.auth_provider_configured', id, at, null, { state: input.state });
    return this.requiredAuthProviderConfig(kind);
  }

  getAuthProviderConfig(kind: string): AuthProviderConfig | undefined {
    const row = this.db.get(
      'SELECT * FROM identity_auth_provider_configs WHERE organization_id = ? AND kind = ?',
      OSS_ORGANIZATION_ID, kind,
    );
    return row ? rowToAuthProviderConfig(row as unknown as AuthProviderConfigRow) : undefined;
  }

  updateAuthProviderAudience(
    kind: string,
    audience: string,
    actorMembershipId?: string,
  ): AuthProviderConfig {
    const current = this.requiredAuthProviderConfig(kind);
    if (current.state !== 'active') {
      throw identityError('identity_invalid', 'Authentication provider is not active.');
    }
    const at = this.now();
    this.db.run(
      `UPDATE identity_auth_provider_configs SET audience = ?, updated_at = ?
       WHERE auth_provider_config_id = ?`,
      strictText(audience, 'audience', 1_024), at, current.id,
    );
    this.appendAudit('identity.auth_provider_audience_repaired', current.id, at, actorMembershipId ?? null);
    return this.requiredAuthProviderConfig(kind);
  }

  updateOrganizationAuth(input: UpdateOrganizationAuthInput): Organization {
    this.requireOrganization(input.organizationId);
    const origin = input.canonicalAdminOrigin === undefined
      ? this.requiredOrganization().canonicalAdminOrigin
      : input.canonicalAdminOrigin === null ? null : validOrigin(input.canonicalAdminOrigin);
    const at = this.now();
    this.db.run(
      `UPDATE identity_organizations SET auth_mode = ?, canonical_admin_origin = ?, updated_at = ?
       WHERE organization_id = ?`,
      input.authMode, origin, at, input.organizationId,
    );
    this.appendAudit('identity.organization_auth_updated', input.organizationId, at, null, {
      mode: input.authMode,
    });
    return this.requiredOrganization();
  }

  getAuthRateLimit(bucket: string, keyHash: string): AuthRateLimitState | undefined {
    const row = this.db.get(
      'SELECT * FROM identity_auth_rate_limits WHERE bucket = ? AND key_hash = ?',
      nonEmpty(bucket, 'bucket'), credentialHash(keyHash),
    );
    return row ? rowToAuthRateLimit(row as unknown as AuthRateLimitRow) : undefined;
  }

  recordAuthRateFailure(bucket: string, keyHash: string, windowStart: number): AuthRateLimitState {
    const safeBucket = nonEmpty(bucket, 'bucket');
    const safeHash = credentialHash(keyHash);
    if (!Number.isSafeInteger(windowStart) || windowStart < 0) {
      throw identityError('identity_invalid', 'Rate-limit window is invalid.');
    }
    this.db.run(
      `INSERT INTO identity_auth_rate_limits (bucket, key_hash, window_start, failures)
       VALUES (?, ?, ?, 1)
       ON CONFLICT (bucket, key_hash) DO UPDATE SET
         failures = CASE
           WHEN identity_auth_rate_limits.window_start = excluded.window_start
             THEN identity_auth_rate_limits.failures + 1
           ELSE 1
         END,
         window_start = excluded.window_start`,
      safeBucket, safeHash, windowStart,
    );
    return this.getAuthRateLimit(safeBucket, safeHash)!;
  }

  clearAuthRateLimit(bucket: string, keyHash: string): void {
    this.db.run(
      'DELETE FROM identity_auth_rate_limits WHERE bucket = ? AND key_hash = ?',
      nonEmpty(bucket, 'bucket'), credentialHash(keyHash),
    );
  }

  exportSummary(): IdentityExportSummary {
    const users = this.db.all('SELECT * FROM identity_users ORDER BY created_at, user_id')
      .map((row) => rowToUser(row as unknown as UserRow));
    const claim = this.getOwnerClaim();
    return {
      organization: this.getOrganization() ?? null,
      users,
      externalIdentities: this.listExternalIdentities(),
      memberships: this.listMemberships(),
      ownerClaim: claim ? {
        id: claim.id,
        organizationId: claim.organizationId,
        status: claim.status,
        bindingId: claim.bindingId,
        createdAt: claim.createdAt,
        updatedAt: claim.updatedAt,
        emailConfigured: true,
      } : null,
      invitations: this.listInvitations().map(({ tokenHash: _tokenHash, normalizedEmail: _email, ...row }) => ({
        ...row,
        emailConfigured: true,
      })),
      personalTokens: this.db.all(
        'SELECT * FROM identity_personal_tokens ORDER BY created_at, personal_token_id',
      ).map((row) => {
        const { tokenHash: _hash, ...safe } = rowToPersonalToken(row as unknown as PersonalTokenRow);
        return safe;
      }),
      browserSessions: this.db.all(
        'SELECT * FROM identity_browser_sessions ORDER BY created_at, browser_session_id',
      ).map((row) => {
        const { sessionHash: _hash, ...safe } = rowToBrowserSession(row as unknown as BrowserSessionRow);
        return safe;
      }),
      authControl: this.getAuthControl() ?? null,
      authOperations: this.db.all(
        'SELECT * FROM identity_auth_operations ORDER BY created_at, operation_id',
      ).map((row) => {
        const {
          capabilityHash: _hash,
          expectedNormalizedEmail: _email,
          ...safe
        } = rowToAuthOperation(row as unknown as AuthOperationRow);
        return { ...safe, emailConfigured: true };
      }),
    };
  }

  listAuditEvents(limit = 100): AuditEvent[] {
    return this.audit.list({ domain: 'identity', limit });
  }

  recordAuthAudit(input: RecordIdentityAuthAuditInput): void {
    const action = safeAuditToken(input.action, 'action');
    const correlationId = safeAuditToken(input.correlationId, 'correlationId');
    const authenticatorKind = safeAuditToken(input.authenticatorKind, 'authenticatorKind');
    const reasonCode = input.reasonCode === undefined || input.reasonCode === null
      ? null
      : safeAuditToken(input.reasonCode, 'reasonCode');
    this.audit.append({
      eventId: newId('audit'),
      domain: 'identity',
      eventType: `identity.${input.event}`,
      outcome: input.outcome,
      actorClass: input.membershipId ? 'membership' : 'system',
      actorId: input.membershipId ?? null,
      subjectId: input.userId ?? null,
      createdAt: input.at ?? this.now(),
      reasonCode,
      metadataJson: JSON.stringify({ action, correlationId, authenticatorKind }),
    });
  }

  private initializeSchema(): void {
    installIdentityMigrations(this.db);
  }

  private insertIdentity(
    ids: { user: string; binding: string; membership: string },
    input: BindExternalIdentityInput,
    email: string,
    role: Membership['role'],
    at: number,
  ): void {
    this.db.run(
      `INSERT INTO identity_users (
         user_id, primary_email, display_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
      ids.user,
      email,
      input.displayName?.trim() || null,
      at,
      at,
    );
    this.db.run(
      `INSERT INTO identity_external_bindings (
         binding_id, user_id, provider, issuer, subject, verified_email, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ids.binding,
      ids.user,
      input.provider,
      input.issuer,
      input.subject,
      email,
      at,
      at,
    );
    this.db.run(
      `INSERT INTO identity_memberships (
         membership_id, organization_id, user_id, role, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      ids.membership,
      input.organizationId,
      ids.user,
      role,
      at,
      at,
    );
  }

  private preparePersonalToken(input: CreatePersonalTokenRecordInput): {
    id: string;
    organizationId: string | null;
    membershipId: string | null;
    prefix: string;
    label: string;
    at: number;
  } {
    const explicitOrganization = input.organizationId ?? null;
    const explicitMembership = input.membershipId ?? null;
    if ((explicitOrganization === null) !== (explicitMembership === null)) {
      throw identityError('identity_invalid', 'Token organization and membership must be provided together.');
    }
    let organizationId = explicitOrganization;
    let membershipId = explicitMembership;
    if (organizationId === null || membershipId === null) {
      if (!this.getUser(input.userId)) {
        throw identityError('identity_invalid', 'Token user was not found.');
      }
      const membership = this.getMembershipForUser(input.userId);
      organizationId = membership?.organizationId ?? null;
      membershipId = membership?.id ?? null;
    } else {
      organizationId = strictText(organizationId, 'organizationId', 256);
      membershipId = strictText(membershipId, 'membershipId', 256);
    }
    validateTokenHash(input.tokenHash);
    return {
      id: newId('personal_token'),
      organizationId,
      membershipId,
      prefix: credentialPrefix(input.prefix),
      label: nonEmpty(input.label, 'label'),
      at: this.now(),
    };
  }

  private insertPersonalToken(
    input: CreatePersonalTokenRecordInput,
    token: {
      id: string;
      organizationId: string | null;
      membershipId: string | null;
      prefix: string;
      label: string;
      at: number;
    },
  ): void {
    this.db.run(
      `INSERT INTO identity_personal_tokens (
         personal_token_id, organization_id, user_id, membership_id, token_hash,
         prefix, label, status, last_used_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
      token.id, token.organizationId, input.userId, token.membershipId,
      input.tokenHash, token.prefix, token.label, token.at, token.at,
    );
  }

  private appendAudit(
    eventType: string,
    subjectId: string,
    at: number,
    actorId: string | null = null,
    metadata: Record<string, string> = {},
  ): void {
    this.audit.append({
      eventId: newId('audit'),
      domain: 'identity',
      eventType,
      outcome: 'success',
      actorClass: actorId ? 'membership' : 'system',
      actorId,
      subjectId,
      createdAt: at,
      metadataJson: JSON.stringify(metadata),
    });
  }

  private requireOrganization(id: string): Organization {
    const organization = this.getOrganization();
    if (!organization || organization.id !== id) {
      throw identityError('organization_missing', 'Organization was not found.', { organizationId: id });
    }
    return organization;
  }

  private requiredOrganization(): Organization {
    const organization = this.getOrganization();
    if (!organization) throw identityError('organization_missing', 'Organization was not found.');
    return organization;
  }

  private requiredOwnerClaim(): OwnerClaim {
    const claim = this.getOwnerClaim();
    if (!claim) throw identityError('owner_claim_missing', 'Owner claim was not found.');
    return claim;
  }

  private requiredMembership(id: string): Membership {
    const membership = this.getMembership(id);
    if (!membership) throw identityError('membership_missing', 'Membership was not found.', { membershipId: id });
    return membership;
  }

  private requiredInvitation(id: string): Invitation {
    const row = this.db.get('SELECT * FROM identity_invitations WHERE invitation_id = ?', id);
    if (!row) throw identityError('invitation_missing', 'Invitation was not found.', { invitationId: id });
    return rowToInvitation(row as unknown as InvitationRow);
  }

  private requiredPersonalToken(id: string): PersonalTokenRecord {
    const row = this.db.get(
      'SELECT * FROM identity_personal_tokens WHERE personal_token_id = ?',
      id,
    );
    if (!row) {
      throw identityError('personal_token_missing', 'Personal token was not found.', { tokenId: id });
    }
    return rowToPersonalToken(row as unknown as PersonalTokenRow);
  }

  private requiredBrowserSession(id: string): BrowserSessionRecord {
    const row = this.db.get(
      'SELECT * FROM identity_browser_sessions WHERE browser_session_id = ?',
      id,
    );
    if (!row) {
      throw identityError('browser_session_missing', 'Browser session was not found.', { sessionId: id });
    }
    return rowToBrowserSession(row as unknown as BrowserSessionRow);
  }

  private requiredAuthProviderConfig(kind: string): AuthProviderConfig {
    const config = this.getAuthProviderConfig(kind);
    if (!config) throw identityError('identity_invalid', 'Authentication provider was not found.');
    return config;
  }

  private requiredAuthControl(installationId: string): AuthControl {
    const control = this.getAuthControl(installationId);
    if (!control) {
      throw identityError('auth_control_missing', 'Authentication control was not found.');
    }
    return control;
  }

  private requiredAuthOperation(operationId: string): AuthOperation {
    const operation = this.getAuthOperation(operationId);
    if (!operation) {
      throw identityError('auth_operation_missing', 'Authentication operation was not found.');
    }
    return operation;
  }

  private requiredPendingAuthOperation(
    operationId: string,
    capabilityHash: string,
    at: number,
  ): AuthOperation {
    const operation = this.requiredAuthOperation(operationId);
    if (operation.status !== 'pending' ||
        operation.capabilityHash !== credentialHash(capabilityHash)) {
      throw identityError('auth_operation_unavailable', 'Authentication operation is unavailable.');
    }
    if (operation.expiresAt <= at) {
      this.db.run(
        `UPDATE identity_auth_operations
         SET status = 'expired', updated_at = ?
         WHERE operation_id = ? AND status = 'pending'`,
        at, operation.id,
      );
      throw identityError('auth_operation_expired', 'Authentication operation has expired.');
    }
    return operation;
  }

  private requiredResolution(
    provider: string,
    issuer: string,
    subject: string,
    organizationId: string,
  ): IdentityResolution {
    const resolution = this.resolveExternalIdentity(provider, issuer, subject, organizationId);
    if (!resolution) {
      throw identityError('identity_invalid', 'Identity was not readable after creation.');
    }
    return resolution;
  }
}

export interface SqliteIdentityStore extends IdentityStore {
  close(): void;
}

export class SqliteIdentityStore {
  constructor(path: string, options: IdentityStoreOptions = {}) {
    const db = openStateDb(path);
    // The Proxy facade drops the `implements` compile check, so this typed
    // binding is the conformance assertion that keeps it: a logic method that
    // stops matching IdentityStore fails typecheck here.
    const _conforms: IdentityStore = promisify(new IdentityStoreLogic(db, options), {
      close: () => db.close(),
    });
    return _conforms as unknown as SqliteIdentityStore;
  }
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 320 || !email.includes('@') || /[\u0000-\u0020\u007f]/.test(email)) {
    throw identityError('identity_invalid', 'Email address is invalid.');
  }
  return email;
}

function validateAuthMode(value: AuthControl['authMode']): void {
  if (![
    'unconfigured', 'password_active', 'access_pending', 'access_active',
    'token_active', 'legacy_shared', 'invalid',
  ].includes(value)) {
    throw identityError('identity_invalid', 'Authentication mode is invalid.');
  }
}

function validateAuthOperationKind(value: AuthOperationKind): void {
  if (![
    'owner_setup', 'invitation_enrollment', 'administrative_reset',
    'owner_recovery', 'legacy_migration',
  ].includes(value)) {
    throw identityError('identity_invalid', 'Authentication operation kind is invalid.');
  }
}

function mergeOpaqueId(
  current: string | null,
  candidate: string | null | undefined,
  field: string,
): string | null {
  if (candidate === undefined || candidate === null) return current;
  const normalized = strictText(candidate, field, 256);
  if (current !== null && current !== normalized) {
    throw identityError('auth_operation_conflict', `Authentication operation ${field} is immutable.`);
  }
  return normalized;
}

function safeAuditToken(value: string, field: string): string {
  const result = value.trim();
  if (!result || result.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(result)) {
    throw identityError('identity_invalid', `Auth audit ${field} is invalid.`);
  }
  return result;
}

function nonEmpty(value: string, field: string): string {
  const result = value.trim();
  if (!result || result.length > 256 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw identityError('identity_invalid', `${field} is invalid.`);
  }
  return result;
}

function validateExternalIdentity(input: Pick<BindExternalIdentityInput, 'provider' | 'issuer' | 'subject'>): void {
  nonEmpty(input.provider, 'provider');
  nonEmpty(input.issuer, 'issuer');
  nonEmpty(input.subject, 'subject');
}

function validateTokenHash(value: string): void {
  if (!value || value.length > 256 || /\s/.test(value)) {
    throw identityError('identity_invalid', 'Credential hash is invalid.');
  }
}

function credentialPrefix(value: string): string {
  const prefix = value.trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(prefix)) {
    throw identityError('identity_invalid', 'Credential prefix is invalid.');
  }
  return prefix;
}

function credentialHash(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw identityError('identity_invalid', 'Credential digest is invalid.');
  }
  return value;
}

function strictText(value: string, field: string, max: number): string {
  const result = value.trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) {
    throw identityError('identity_invalid', `${field} is invalid.`);
  }
  return result;
}

function validOrigin(value: string): string {
  try {
    const url = new URL(value);
    const loopbackHttp = url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !loopbackHttp) || url.username || url.password || url.pathname !== '/' ||
        url.search || url.hash) throw new Error('invalid');
    return url.origin;
  } catch {
    throw identityError('identity_invalid', 'Canonical Admin origin is invalid.');
  }
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function rowToOrganization(row: OrganizationRow): Organization {
  return {
    id: row.organization_id,
    displayName: row.display_name,
    authMode: row.auth_mode,
    canonicalAdminOrigin: row.canonical_admin_origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToUser(row: UserRow): User {
  return {
    id: row.user_id,
    primaryEmail: row.primary_email,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToBinding(row: BindingRow): ExternalIdentityBinding {
  return {
    id: row.binding_id,
    userId: row.user_id,
    provider: row.provider,
    issuer: row.issuer,
    subject: row.subject,
    verifiedEmail: row.verified_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function actorBindingFromRow(row: ActorBindingRow): ActorExternalIdentityBinding {
  return {
    id: row.binding_id,
    provider: 'slack',
    issuer: row.issuer,
    subject: row.subject,
    userId: row.user_id,
    organizationId: row.organization_id,
    membershipId: row.membership_id,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function actorHandoffFromRow(row: Record<string, unknown>): ActorIdentityBindingHandoff {
  return {
    handoffId: String(row.handoff_id), tokenHash: String(row.token_hash),
    issuer: String(row.issuer), subject: String(row.subject),
    slackIdentityId: String(row.slack_identity_id), slackIdentityRevision: Number(row.slack_identity_revision),
    expiresAt: Number(row.expires_at), consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
  };
}

function rowToMembership(row: MembershipRow): Membership {
  return {
    id: row.membership_id,
    organizationId: row.organization_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToOwnerClaim(row: OwnerClaimRow): OwnerClaim {
  return {
    id: row.owner_claim_id,
    organizationId: row.organization_id,
    normalizedEmail: row.normalized_email,
    status: row.status,
    bindingId: row.binding_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToInvitation(row: InvitationRow): Invitation {
  return {
    id: row.invitation_id,
    organizationId: row.organization_id,
    normalizedEmail: row.normalized_email,
    role: row.role,
    tokenHash: row.token_hash,
    status: row.status,
    inviterMembershipId: row.inviter_membership_id,
    acceptedMembershipId: row.accepted_membership_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToPersonalToken(row: PersonalTokenRow): PersonalTokenRecord {
  return {
    id: row.personal_token_id,
    organizationId: row.organization_id,
    userId: row.user_id,
    membershipId: row.membership_id,
    tokenHash: row.token_hash,
    prefix: row.prefix,
    label: row.label,
    status: row.status,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToBrowserSession(row: BrowserSessionRow): BrowserSessionRecord {
  return {
    id: row.browser_session_id,
    organizationId: row.organization_id,
    userId: row.user_id,
    membershipId: row.membership_id,
    personalTokenId: row.personal_token_id,
    sessionHash: row.session_hash,
    prefix: row.prefix,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

function rowToAuthControl(row: AuthControlRow): AuthControl {
  return {
    installationId: row.installation_id,
    authMode: row.auth_mode,
    canonicalAdminOrigin: row.canonical_admin_origin,
    betterAuthOrganizationId: row.better_auth_organization_id,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAuthOperation(row: AuthOperationRow): AuthOperation {
  return {
    id: row.operation_id,
    kind: row.kind,
    organizationId: row.organization_id,
    expectedNormalizedEmail: row.expected_normalized_email,
    capabilityHash: row.capability_hash,
    status: row.status,
    step: row.step,
    betterAuthUserId: row.better_auth_user_id,
    betterAuthOrganizationId: row.better_auth_organization_id,
    betterAuthMembershipId: row.better_auth_membership_id,
    betterAuthInvitationId: row.better_auth_invitation_id,
    targetCredentialVersion: row.target_credential_version,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAuthProviderConfig(row: AuthProviderConfigRow): AuthProviderConfig {
  return {
    id: row.auth_provider_config_id,
    organizationId: row.organization_id,
    kind: row.kind,
    state: row.state,
    issuer: row.issuer,
    audience: row.audience,
    admissionState: row.admission_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAuthRateLimit(row: AuthRateLimitRow): AuthRateLimitState {
  return {
    bucket: row.bucket,
    keyHash: row.key_hash,
    windowStart: row.window_start,
    failures: row.failures,
  };
}

function joinedRowToResolution(row: Record<string, unknown>): IdentityResolution {
  return {
    user: rowToUser({
      user_id: String(row.u_user_id), primary_email: String(row.u_primary_email),
      display_name: row.u_display_name === null ? null : String(row.u_display_name),
      created_at: Number(row.u_created_at), updated_at: Number(row.u_updated_at),
    }),
    binding: rowToBinding({
      binding_id: String(row.b_binding_id), user_id: String(row.b_user_id),
      provider: String(row.b_provider), issuer: String(row.b_issuer), subject: String(row.b_subject),
      verified_email: String(row.b_verified_email), created_at: Number(row.b_created_at),
      updated_at: Number(row.b_updated_at),
    }),
    membership: rowToMembership({
      membership_id: String(row.m_membership_id), organization_id: String(row.m_organization_id),
      user_id: String(row.m_user_id), role: row.m_role as Membership['role'],
      status: row.m_status as Membership['status'], created_at: Number(row.m_created_at),
      updated_at: Number(row.m_updated_at),
    }),
  };
}
