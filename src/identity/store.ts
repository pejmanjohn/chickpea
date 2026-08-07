import { randomUUID } from 'node:crypto';

import { AuditStoreLogic } from '../audit/store.ts';
import type { AuditEvent } from '../audit/types.ts';
import { openStateDb, type NodeStateDb } from '../state/node-state-db.ts';
import type { StateDb } from '../state/state-db.ts';
import { identityError } from './errors.ts';
import { installIdentityMigrations } from './migrations.ts';
import type {
  BindExternalIdentityInput,
  ActivateAccessOwnerInput,
  AuthProviderConfig,
  AuthRateLimitState,
  BootstrapTokenOwnerInput,
  BrowserSessionRecord,
  ClaimOwnerInput,
  ConsumePasswordResetCapabilityInput,
  ConsumeInvitationInput,
  ConfigureAuthProviderInput,
  CreateBrowserSessionRecordInput,
  CreateInvitationInput,
  CreateOwnerClaimInput,
  CreatePersonalTokenRecordInput,
  CreatePasswordResetCapabilityInput,
  EnrollPasswordInvitationInput,
  EnsureOrganizationInput,
  ExternalIdentityBinding,
  IdentityExportSummary,
  IdentityResolution,
  IdentityRpcRequest,
  IdentityRpcResponse,
  IdentityStore,
  Invitation,
  Membership,
  Organization,
  OwnerClaim,
  PasswordAccountResolution,
  PasswordBrowserSessionMaterial,
  PasswordCredentialMaterial,
  PasswordCredentialRecord,
  PasswordResetCapabilityRecord,
  PersonalTokenRecord,
  RecordIdentityAuthAuditInput,
  ResendInvitationInput,
  ReplaceAccessOwnerBindingInput,
  ReplacePasswordCredentialInput,
  SetupPasswordOwnerInput,
  UpdateMembershipInput,
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
  user_id: string;
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
  user_id: string;
  membership_id: string;
  authenticator_kind: BrowserSessionRecord['authenticatorKind'];
  personal_token_id: string | null;
  credential_id: string | null;
  credential_version: number | null;
  session_hash: string;
  prefix: string;
  idle_expires_at: number;
  absolute_expires_at: number;
  last_seen_at: number;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
}

interface PasswordCredentialRow {
  password_credential_id: string;
  user_id: string;
  algorithm: PasswordCredentialRecord['algorithm'];
  parameter_version: number;
  iterations: number;
  salt: string;
  verifier: string;
  credential_version: number;
  status: PasswordCredentialRecord['status'];
  created_at: number;
  updated_at: number;
}

interface PasswordResetCapabilityRow {
  password_reset_capability_id: string;
  user_id: string;
  token_hash: string;
  kind: PasswordResetCapabilityRecord['kind'];
  status: PasswordResetCapabilityRecord['status'];
  created_by_membership_id: string | null;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
  updated_at: number;
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

const OSS_ORGANIZATION_ID = 'org_oss';

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
      case 'list_memberships':
        return { kind: 'memberships', memberships: this.listMemberships() };
      case 'get_user':
        return { kind: 'user', user: this.getUser(request.userId) ?? null };
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
      case 'setup_password_owner':
        return { kind: 'password_account_resolution', resolution: this.setupPasswordOwner(request.input) };
      case 'enroll_password_invitation':
        return {
          kind: 'password_account_resolution',
          resolution: this.enrollPasswordInvitation(request.input),
        };
      case 'find_user_by_email':
        return { kind: 'user', user: this.findUserByEmail(request.email) ?? null };
      case 'get_active_password_credential':
        return {
          kind: 'password_credential',
          credential: this.getActivePasswordCredential(request.userId) ?? null,
        };
      case 'replace_password_credential':
        return {
          kind: 'password_account_resolution',
          resolution: this.replacePasswordCredential(request.input),
        };
      case 'create_password_reset_capability':
        return {
          kind: 'password_reset_capability',
          capability: this.createPasswordResetCapability(request.input),
        };
      case 'consume_password_reset_capability':
        return {
          kind: 'password_account_resolution',
          resolution: this.consumePasswordResetCapability(request.input),
        };
      case 'revoke_password_reset_capability':
        return {
          kind: 'password_reset_capability',
          capability: this.revokePasswordResetCapability(request.capabilityId),
        };
      case 'touch_browser_session':
        return {
          kind: 'browser_session',
          browserSession: this.touchBrowserSession(request.sessionId, request.idleExpiresAt),
        };
      case 'revoke_user_browser_sessions':
        return { kind: 'count', count: this.revokeUserBrowserSessions(request.userId) };
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
    const membership = this.getMembershipForUser(input.userId);
    if (!membership || membership.status !== 'active') {
      throw identityError('membership_missing', 'An active membership is required.');
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
         browser_session_id, user_id, membership_id, authenticator_kind,
         personal_token_id, credential_id, credential_version, session_hash, prefix,
         idle_expires_at, absolute_expires_at, last_seen_at, revoked_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'personal_token', ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      id,
      input.userId,
      membership.id,
      input.personalTokenId,
      input.sessionHash,
      prefix,
      input.expiresAt,
      input.expiresAt,
      at,
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
    const at = this.now();
    this.db.run(
      `UPDATE identity_browser_sessions SET revoked_at = ?, updated_at = ?
       WHERE browser_session_id = ?`,
      at,
      at,
      sessionId,
    );
    return this.requiredBrowserSession(sessionId);
  }

  setupPasswordOwner(input: SetupPasswordOwnerInput): PasswordAccountResolution {
    const email = normalizeEmail(input.email);
    const organizationDisplayName = strictText(
      input.organizationDisplayName,
      'organizationDisplayName',
      256,
    );
    const canonicalAdminOrigin = validOrigin(input.canonicalAdminOrigin);
    validatePasswordCredential(input.credential);
    validatePasswordSession(input.session, this.now());
    const ids = {
      user: newId('user'), membership: newId('membership'),
      credential: newId('password_credential'), session: newId('browser_session'),
    };
    const at = this.now();
    this.db.transaction(() => {
      const organization = this.getOrganization();
      const memberCount = Number(
        this.db.get('SELECT COUNT(*) AS count FROM identity_memberships')?.count ?? 0,
      );
      if ((organization && organization.authMode !== 'unconfigured') || memberCount !== 0) {
        throw identityError('password_setup_complete', 'Owner setup is no longer available.');
      }
      if (organization) {
        this.db.run(
          `UPDATE identity_organizations
           SET display_name = ?, auth_mode = 'password_active', canonical_admin_origin = ?, updated_at = ?
           WHERE organization_id = ? AND auth_mode = 'unconfigured'`,
          organizationDisplayName, canonicalAdminOrigin, at, organization.id,
        );
      } else {
        this.db.run(
          `INSERT INTO identity_organizations (
             organization_id, display_name, auth_mode, canonical_admin_origin, created_at, updated_at
           ) VALUES (?, ?, 'password_active', ?, ?, ?)`,
          OSS_ORGANIZATION_ID, organizationDisplayName, canonicalAdminOrigin, at, at,
        );
      }
      this.db.run(
        `INSERT INTO identity_users (
           user_id, primary_email, display_name, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?)`,
        ids.user, email, input.displayName?.trim() || null, at, at,
      );
      this.db.run(
        `INSERT INTO identity_memberships (
           membership_id, organization_id, user_id, role, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'owner', 'active', ?, ?)`,
        ids.membership, OSS_ORGANIZATION_ID, ids.user, at, at,
      );
      this.insertPasswordCredential(ids.credential, ids.user, 1, input.credential, at);
      this.insertPasswordSession(
        ids.session,
        ids.user,
        ids.membership,
        ids.credential,
        1,
        input.session,
        at,
      );
      this.appendAudit('identity.password_owner_setup', ids.user, at, ids.membership);
    });
    return this.requiredPasswordAccount(ids.user, ids.credential, ids.session);
  }

  enrollPasswordInvitation(input: EnrollPasswordInvitationInput): PasswordAccountResolution {
    validateTokenHash(input.tokenHash);
    validatePasswordCredential(input.credential);
    const at = input.at ?? this.now();
    validatePasswordSession(input.session, at);
    const invitation = this.requiredInvitation(input.invitationId);
    if (invitation.status !== 'pending') {
      throw identityError('invitation_not_pending', 'Invitation is no longer pending.');
    }
    if (invitation.expiresAt <= at) {
      this.db.run(
        `UPDATE identity_invitations SET status = 'expired', updated_at = ?
         WHERE invitation_id = ? AND status = 'pending'`,
        at, invitation.id,
      );
      throw identityError('invitation_expired', 'Invitation has expired.');
    }
    if (invitation.tokenHash !== input.tokenHash) {
      throw identityError('invitation_token_invalid', 'Invitation is unavailable.');
    }
    if (this.findUserByEmail(invitation.normalizedEmail)) {
      throw identityError('membership_conflict', 'An account already exists for this email.');
    }
    const ids = {
      user: newId('user'), membership: newId('membership'),
      credential: newId('password_credential'), session: newId('browser_session'),
    };
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO identity_users (
           user_id, primary_email, display_name, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?)`,
        ids.user, invitation.normalizedEmail, input.displayName?.trim() || null, at, at,
      );
      this.db.run(
        `INSERT INTO identity_memberships (
           membership_id, organization_id, user_id, role, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        ids.membership, invitation.organizationId, ids.user, invitation.role, at, at,
      );
      this.insertPasswordCredential(ids.credential, ids.user, 1, input.credential, at);
      this.insertPasswordSession(
        ids.session, ids.user, ids.membership, ids.credential, 1, input.session, at,
      );
      const accepted = this.db.run(
        `UPDATE identity_invitations
         SET status = 'accepted', accepted_membership_id = ?, updated_at = ?
         WHERE invitation_id = ? AND status = 'pending' AND token_hash = ?`,
        ids.membership, at, invitation.id, input.tokenHash,
      );
      if (accepted.changes !== 1) {
        throw identityError('invitation_not_pending', 'Invitation is no longer pending.');
      }
      this.appendAudit('identity.password_invitation_enrolled', invitation.id, at, ids.membership, {
        role: invitation.role,
      });
    });
    return this.requiredPasswordAccount(ids.user, ids.credential, ids.session);
  }

  findUserByEmail(email: string): User | undefined {
    const row = this.db.get(
      'SELECT * FROM identity_users WHERE primary_email = ? ORDER BY created_at LIMIT 1',
      normalizeEmail(email),
    );
    return row ? rowToUser(row as unknown as UserRow) : undefined;
  }

  getActivePasswordCredential(userId: string): PasswordCredentialRecord | undefined {
    const row = this.db.get(
      `SELECT * FROM identity_password_credentials
       WHERE user_id = ? AND status = 'active' ORDER BY credential_version DESC LIMIT 1`,
      nonEmpty(userId, 'userId'),
    );
    return row ? rowToPasswordCredential(row as unknown as PasswordCredentialRow) : undefined;
  }

  replacePasswordCredential(input: ReplacePasswordCredentialInput): PasswordAccountResolution {
    validatePasswordCredential(input.credential);
    const at = input.at ?? this.now();
    validatePasswordSession(input.session, at);
    const current = this.getActivePasswordCredential(input.userId);
    if (!current) {
      throw identityError('password_credential_missing', 'Password credential was not found.');
    }
    const membership = this.getMembershipForUser(input.userId);
    if (!membership || membership.status !== 'active') {
      throw identityError('membership_missing', 'An active membership is required.');
    }
    const credentialId = newId('password_credential');
    const sessionId = newId('browser_session');
    const version = current.credentialVersion + 1;
    this.db.transaction(() => {
      this.db.run(
        `UPDATE identity_password_credentials SET status = 'disabled', updated_at = ?
         WHERE password_credential_id = ? AND status = 'active'`,
        at, current.id,
      );
      this.insertPasswordCredential(credentialId, input.userId, version, input.credential, at);
      this.revokeUserBrowserSessionsInTransaction(input.userId, at);
      this.insertPasswordSession(
        sessionId, input.userId, membership.id, credentialId, version, input.session, at,
      );
      this.appendAudit('identity.password_credential_replaced', credentialId, at, membership.id, {
        credentialVersion: String(version),
      });
    });
    return this.requiredPasswordAccount(input.userId, credentialId, sessionId);
  }

  createPasswordResetCapability(
    input: CreatePasswordResetCapabilityInput,
  ): PasswordResetCapabilityRecord {
    const user = this.getUser(input.userId);
    if (!user) throw identityError('identity_invalid', 'Reset target was not found.');
    validateTokenHash(input.tokenHash);
    const at = this.now();
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= at) {
      throw identityError('identity_invalid', 'Reset expiry must be in the future.');
    }
    const actorId = input.createdByMembershipId ?? null;
    if (actorId) this.requireResetAuthority(actorId, input.userId);
    const id = newId('password_reset');
    this.db.transaction(() => {
      this.db.run(
        `UPDATE identity_password_reset_capabilities SET status = 'revoked', updated_at = ?
         WHERE user_id = ? AND kind = ? AND status = 'pending'`,
        at, input.userId, input.kind,
      );
      this.db.run(
        `INSERT INTO identity_password_reset_capabilities (
           password_reset_capability_id, user_id, token_hash, kind, status,
           created_by_membership_id, expires_at, consumed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL, ?, ?)`,
        id, input.userId, input.tokenHash, input.kind, actorId, input.expiresAt, at, at,
      );
      this.appendAudit('identity.password_reset_created', id, at, actorId, { kind: input.kind });
    });
    return this.requiredPasswordResetCapability(id);
  }

  consumePasswordResetCapability(
    input: ConsumePasswordResetCapabilityInput,
  ): PasswordAccountResolution {
    validateTokenHash(input.tokenHash);
    validatePasswordCredential(input.credential);
    const at = input.at ?? this.now();
    validatePasswordSession(input.session, at);
    const capability = this.requiredPasswordResetCapability(input.capabilityId);
    if (capability.status !== 'pending' || capability.tokenHash !== input.tokenHash) {
      throw identityError('password_reset_unavailable', 'Password reset is unavailable.');
    }
    if (capability.expiresAt <= at) {
      this.db.run(
        `UPDATE identity_password_reset_capabilities SET status = 'expired', updated_at = ?
         WHERE password_reset_capability_id = ? AND status = 'pending'`,
        at, capability.id,
      );
      throw identityError('password_reset_expired', 'Password reset has expired.');
    }
    const current = this.getActivePasswordCredential(capability.userId);
    if (!current) {
      throw identityError('password_credential_missing', 'Password credential was not found.');
    }
    const membership = this.getMembershipForUser(capability.userId);
    if (!membership || membership.status !== 'active') {
      throw identityError('membership_missing', 'An active membership is required.');
    }
    const credentialId = newId('password_credential');
    const sessionId = newId('browser_session');
    const version = current.credentialVersion + 1;
    this.db.transaction(() => {
      const consumed = this.db.run(
        `UPDATE identity_password_reset_capabilities
         SET status = 'consumed', consumed_at = ?, updated_at = ?
         WHERE password_reset_capability_id = ? AND status = 'pending' AND token_hash = ?`,
        at, at, capability.id, input.tokenHash,
      );
      if (consumed.changes !== 1) {
        throw identityError('password_reset_unavailable', 'Password reset is unavailable.');
      }
      this.db.run(
        `UPDATE identity_password_credentials SET status = 'disabled', updated_at = ?
         WHERE password_credential_id = ? AND status = 'active'`,
        at, current.id,
      );
      this.insertPasswordCredential(
        credentialId, capability.userId, version, input.credential, at,
      );
      this.revokeUserBrowserSessionsInTransaction(capability.userId, at);
      this.insertPasswordSession(
        sessionId, capability.userId, membership.id, credentialId, version, input.session, at,
      );
      this.appendAudit('identity.password_reset_consumed', capability.id, at, membership.id);
    });
    return this.requiredPasswordAccount(capability.userId, credentialId, sessionId);
  }

  revokePasswordResetCapability(capabilityId: string): PasswordResetCapabilityRecord {
    const capability = this.requiredPasswordResetCapability(capabilityId);
    if (capability.status !== 'pending') return capability;
    const at = this.now();
    this.db.run(
      `UPDATE identity_password_reset_capabilities SET status = 'revoked', updated_at = ?
       WHERE password_reset_capability_id = ? AND status = 'pending'`,
      at, capability.id,
    );
    return this.requiredPasswordResetCapability(capability.id);
  }

  touchBrowserSession(sessionId: string, idleExpiresAt: number): BrowserSessionRecord {
    const session = this.requiredBrowserSession(sessionId);
    const at = this.now();
    if (session.revokedAt !== null || !Number.isSafeInteger(idleExpiresAt) ||
        idleExpiresAt <= at || idleExpiresAt > session.absoluteExpiresAt) {
      throw identityError('identity_invalid', 'Session idle expiry is invalid.');
    }
    this.db.run(
      `UPDATE identity_browser_sessions SET idle_expires_at = ?, last_seen_at = ?, updated_at = ?
       WHERE browser_session_id = ? AND revoked_at IS NULL`,
      idleExpiresAt, at, at, session.id,
    );
    return this.requiredBrowserSession(session.id);
  }

  revokeUserBrowserSessions(userId: string): number {
    return this.revokeUserBrowserSessionsInTransaction(nonEmpty(userId, 'userId'), this.now());
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
      passwordCredentials: this.db.all(
        `SELECT * FROM identity_password_credentials
         ORDER BY created_at, password_credential_id`,
      ).map((row) => {
        const { salt: _salt, verifier: _verifier, ...safe } = rowToPasswordCredential(
          row as unknown as PasswordCredentialRow,
        );
        return safe;
      }),
      passwordResetCapabilities: this.db.all(
        `SELECT * FROM identity_password_reset_capabilities
         ORDER BY created_at, password_reset_capability_id`,
      ).map((row) => {
        const { tokenHash: _hash, ...safe } = rowToPasswordResetCapability(
          row as unknown as PasswordResetCapabilityRow,
        );
        return safe;
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
    prefix: string;
    label: string;
    at: number;
  } {
    if (!this.getUser(input.userId)) {
      throw identityError('identity_invalid', 'Token user was not found.');
    }
    validateTokenHash(input.tokenHash);
    return {
      id: newId('personal_token'),
      prefix: credentialPrefix(input.prefix),
      label: nonEmpty(input.label, 'label'),
      at: this.now(),
    };
  }

  private insertPersonalToken(
    input: CreatePersonalTokenRecordInput,
    token: { id: string; prefix: string; label: string; at: number },
  ): void {
    this.db.run(
      `INSERT INTO identity_personal_tokens (
         personal_token_id, user_id, token_hash, prefix, label, status,
         last_used_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
      token.id, input.userId, input.tokenHash, token.prefix, token.label, token.at, token.at,
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

  private getMembership(id: string): Membership | undefined {
    const row = this.db.get('SELECT * FROM identity_memberships WHERE membership_id = ?', id);
    return row ? rowToMembership(row as unknown as MembershipRow) : undefined;
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

  private requiredPasswordCredential(id: string): PasswordCredentialRecord {
    const row = this.db.get(
      'SELECT * FROM identity_password_credentials WHERE password_credential_id = ?',
      id,
    );
    if (!row) {
      throw identityError('password_credential_missing', 'Password credential was not found.');
    }
    return rowToPasswordCredential(row as unknown as PasswordCredentialRow);
  }

  private requiredPasswordResetCapability(id: string): PasswordResetCapabilityRecord {
    const row = this.db.get(
      `SELECT * FROM identity_password_reset_capabilities
       WHERE password_reset_capability_id = ?`,
      id,
    );
    if (!row) throw identityError('password_reset_missing', 'Password reset was not found.');
    return rowToPasswordResetCapability(row as unknown as PasswordResetCapabilityRow);
  }

  private insertPasswordCredential(
    id: string,
    userId: string,
    version: number,
    material: PasswordCredentialMaterial,
    at: number,
  ): void {
    this.db.run(
      `INSERT INTO identity_password_credentials (
         password_credential_id, user_id, algorithm, parameter_version, iterations,
         salt, verifier, credential_version, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      id, userId, material.algorithm, material.parameterVersion, material.iterations,
      material.salt, material.verifier, version, at, at,
    );
  }

  private insertPasswordSession(
    id: string,
    userId: string,
    membershipId: string,
    credentialId: string,
    credentialVersion: number,
    material: PasswordBrowserSessionMaterial,
    at: number,
  ): void {
    this.db.run(
      `INSERT INTO identity_browser_sessions (
         browser_session_id, user_id, membership_id, authenticator_kind,
         personal_token_id, credential_id, credential_version, session_hash, prefix,
         idle_expires_at, absolute_expires_at, last_seen_at, revoked_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'password', NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      id, userId, membershipId, credentialId, credentialVersion,
      material.sessionHash, credentialPrefix(material.prefix), material.idleExpiresAt,
      material.absoluteExpiresAt, at, at, at,
    );
  }

  private revokeUserBrowserSessionsInTransaction(userId: string, at: number): number {
    return this.db.run(
      `UPDATE identity_browser_sessions SET revoked_at = ?, updated_at = ?
       WHERE user_id = ? AND revoked_at IS NULL`,
      at, at, userId,
    ).changes;
  }

  private requireResetAuthority(actorMembershipId: string, targetUserId: string): void {
    const actor = this.requiredMembership(actorMembershipId);
    if (actor.status !== 'active' || !['owner', 'admin'].includes(actor.role)) {
      throw identityError('inviter_not_authorized', 'The actor cannot reset this account.');
    }
    const target = this.getMembershipForUser(targetUserId, actor.organizationId);
    if (!target || (target.role === 'owner' && actor.role !== 'owner')) {
      throw identityError('inviter_not_authorized', 'The actor cannot reset this account.');
    }
  }

  private requiredPasswordAccount(
    userId: string,
    credentialId: string,
    sessionId: string,
  ): PasswordAccountResolution {
    const user = this.getUser(userId);
    const membership = this.getMembershipForUser(userId);
    if (!user || !membership) {
      throw identityError('identity_invalid', 'Password account was not readable after creation.');
    }
    return {
      user,
      membership,
      credential: this.requiredPasswordCredential(credentialId),
      session: this.requiredBrowserSession(sessionId),
    };
  }

  private requiredAuthProviderConfig(kind: string): AuthProviderConfig {
    const config = this.getAuthProviderConfig(kind);
    if (!config) throw identityError('identity_invalid', 'Authentication provider was not found.');
    return config;
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

export class SqliteIdentityStore implements IdentityStore {
  private readonly db: NodeStateDb;
  private readonly logic: IdentityStoreLogic;

  constructor(path: string, options: IdentityStoreOptions = {}) {
    this.db = openStateDb(path);
    this.logic = new IdentityStoreLogic(this.db, options);
  }

  async ensureOrganization(input: EnsureOrganizationInput) { return this.logic.ensureOrganization(input); }
  async getOrganization() { return this.logic.getOrganization(); }
  async createOwnerClaim(input: CreateOwnerClaimInput) { return this.logic.createOwnerClaim(input); }
  async getOwnerClaim() { return this.logic.getOwnerClaim(); }
  async claimOwner(input: ClaimOwnerInput) { return this.logic.claimOwner(input); }
  async bootstrapTokenOwner(input: BootstrapTokenOwnerInput) {
    return this.logic.bootstrapTokenOwner(input);
  }
  async activateAccessOwner(input: ActivateAccessOwnerInput) { return this.logic.activateAccessOwner(input); }
  async replaceAccessOwnerBinding(input: ReplaceAccessOwnerBindingInput) {
    return this.logic.replaceAccessOwnerBinding(input);
  }
  async resolveExternalIdentity(provider: string, issuer: string, subject: string, organizationId?: string) {
    return this.logic.resolveExternalIdentity(provider, issuer, subject, organizationId);
  }
  async listExternalIdentities() { return this.logic.listExternalIdentities(); }
  async listMemberships() { return this.logic.listMemberships(); }
  async getUser(userId: string) { return this.logic.getUser(userId); }
  async getMembershipForUser(userId: string, organizationId?: string) {
    return this.logic.getMembershipForUser(userId, organizationId);
  }
  async updateMembership(input: UpdateMembershipInput) { return this.logic.updateMembership(input); }
  async createInvitation(input: CreateInvitationInput) { return this.logic.createInvitation(input); }
  async resendInvitation(input: ResendInvitationInput) { return this.logic.resendInvitation(input); }
  async revokeInvitation(invitationId: string) { return this.logic.revokeInvitation(invitationId); }
  async consumeInvitation(input: ConsumeInvitationInput) { return this.logic.consumeInvitation(input); }
  async listInvitations() { return this.logic.listInvitations(); }
  async createPersonalToken(input: CreatePersonalTokenRecordInput) { return this.logic.createPersonalToken(input); }
  async rotatePersonalToken(input: CreatePersonalTokenRecordInput) {
    return this.logic.rotatePersonalToken(input);
  }
  async findPersonalTokens(prefix: string) { return this.logic.findPersonalTokens(prefix); }
  async getPersonalToken(tokenId: string) { return this.logic.getPersonalToken(tokenId); }
  async revokePersonalToken(tokenId: string) { return this.logic.revokePersonalToken(tokenId); }
  async touchPersonalToken(tokenId: string) { return this.logic.touchPersonalToken(tokenId); }
  async createBrowserSession(input: CreateBrowserSessionRecordInput) { return this.logic.createBrowserSession(input); }
  async findBrowserSessions(prefix: string) { return this.logic.findBrowserSessions(prefix); }
  async revokeBrowserSession(sessionId: string) { return this.logic.revokeBrowserSession(sessionId); }
  async setupPasswordOwner(input: SetupPasswordOwnerInput) {
    return this.logic.setupPasswordOwner(input);
  }
  async enrollPasswordInvitation(input: EnrollPasswordInvitationInput) {
    return this.logic.enrollPasswordInvitation(input);
  }
  async findUserByEmail(email: string) { return this.logic.findUserByEmail(email); }
  async getActivePasswordCredential(userId: string) {
    return this.logic.getActivePasswordCredential(userId);
  }
  async replacePasswordCredential(input: ReplacePasswordCredentialInput) {
    return this.logic.replacePasswordCredential(input);
  }
  async createPasswordResetCapability(input: CreatePasswordResetCapabilityInput) {
    return this.logic.createPasswordResetCapability(input);
  }
  async consumePasswordResetCapability(input: ConsumePasswordResetCapabilityInput) {
    return this.logic.consumePasswordResetCapability(input);
  }
  async revokePasswordResetCapability(capabilityId: string) {
    return this.logic.revokePasswordResetCapability(capabilityId);
  }
  async touchBrowserSession(sessionId: string, idleExpiresAt: number) {
    return this.logic.touchBrowserSession(sessionId, idleExpiresAt);
  }
  async revokeUserBrowserSessions(userId: string) {
    return this.logic.revokeUserBrowserSessions(userId);
  }
  async configureAuthProvider(input: ConfigureAuthProviderInput) { return this.logic.configureAuthProvider(input); }
  async getAuthProviderConfig(kind: string) { return this.logic.getAuthProviderConfig(kind); }
  async updateAuthProviderAudience(kind: string, audience: string, actorMembershipId?: string) {
    return this.logic.updateAuthProviderAudience(kind, audience, actorMembershipId);
  }
  async updateOrganizationAuth(input: UpdateOrganizationAuthInput) {
    return this.logic.updateOrganizationAuth(input);
  }
  async getAuthRateLimit(bucket: string, keyHash: string) {
    return this.logic.getAuthRateLimit(bucket, keyHash);
  }
  async recordAuthRateFailure(bucket: string, keyHash: string, windowStart: number) {
    return this.logic.recordAuthRateFailure(bucket, keyHash, windowStart);
  }
  async clearAuthRateLimit(bucket: string, keyHash: string) {
    this.logic.clearAuthRateLimit(bucket, keyHash);
  }
  async recordAuthAudit(input: RecordIdentityAuthAuditInput) {
    this.logic.recordAuthAudit(input);
  }
  async exportSummary() { return this.logic.exportSummary(); }
  async listAuditEvents(limit?: number) { return this.logic.listAuditEvents(limit); }
  close(): void { this.db.close(); }
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 320 || !email.includes('@') || /[\u0000-\u0020\u007f]/.test(email)) {
    throw identityError('identity_invalid', 'Email address is invalid.');
  }
  return email;
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

function validatePasswordCredential(material: PasswordCredentialMaterial): void {
  if (material.algorithm !== 'pbkdf2-sha256' ||
      !Number.isSafeInteger(material.parameterVersion) || material.parameterVersion <= 0 ||
      !Number.isSafeInteger(material.iterations) || material.iterations <= 0) {
    throw identityError('identity_invalid', 'Password credential parameters are invalid.');
  }
  for (const value of [material.salt, material.verifier]) {
    if (!value || value.length > 1_024 || /\s/.test(value)) {
      throw identityError('identity_invalid', 'Password credential material is invalid.');
    }
  }
}

function validatePasswordSession(material: PasswordBrowserSessionMaterial, at: number): void {
  validateTokenHash(material.sessionHash);
  credentialPrefix(material.prefix);
  if (!Number.isSafeInteger(material.idleExpiresAt) ||
      !Number.isSafeInteger(material.absoluteExpiresAt) ||
      material.idleExpiresAt <= at ||
      material.absoluteExpiresAt < material.idleExpiresAt) {
    throw identityError('identity_invalid', 'Password session expiry is invalid.');
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
    userId: row.user_id,
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
    userId: row.user_id,
    membershipId: row.membership_id,
    authenticatorKind: row.authenticator_kind,
    personalTokenId: row.personal_token_id,
    credentialId: row.credential_id,
    credentialVersion: row.credential_version,
    sessionHash: row.session_hash,
    prefix: row.prefix,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToPasswordCredential(row: PasswordCredentialRow): PasswordCredentialRecord {
  return {
    id: row.password_credential_id,
    userId: row.user_id,
    algorithm: row.algorithm,
    parameterVersion: row.parameter_version,
    iterations: row.iterations,
    salt: row.salt,
    verifier: row.verifier,
    credentialVersion: row.credential_version,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToPasswordResetCapability(
  row: PasswordResetCapabilityRow,
): PasswordResetCapabilityRecord {
  return {
    id: row.password_reset_capability_id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    kind: row.kind,
    status: row.status,
    createdByMembershipId: row.created_by_membership_id,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
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
