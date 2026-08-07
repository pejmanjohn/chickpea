import { randomUUID } from 'node:crypto';

import { AuditStoreLogic } from '../audit/store.ts';
import type { AuditEvent } from '../audit/types.ts';
import { openStateDb, type NodeStateDb } from '../state/node-state-db.ts';
import type { StateDb } from '../state/state-db.ts';
import { identityError } from './errors.ts';
import type {
  BindExternalIdentityInput,
  BrowserSessionRecord,
  ClaimOwnerInput,
  ConsumeInvitationInput,
  CreateBrowserSessionRecordInput,
  CreateInvitationInput,
  CreateOwnerClaimInput,
  CreatePersonalTokenRecordInput,
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
  PersonalTokenRecord,
  ResendInvitationInput,
  UpdateMembershipInput,
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
  personal_token_id: string;
  session_hash: string;
  prefix: string;
  expires_at: number;
  last_seen_at: number;
  revoked_at: number | null;
  created_at: number;
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
    if (!this.getUser(input.userId)) {
      throw identityError('identity_invalid', 'Token user was not found.');
    }
    validateTokenHash(input.tokenHash);
    const prefix = credentialPrefix(input.prefix);
    const label = nonEmpty(input.label, 'label');
    const at = this.now();
    const id = newId('personal_token');
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO identity_personal_tokens (
           personal_token_id, user_id, token_hash, prefix, label, status,
           last_used_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
        id,
        input.userId,
        input.tokenHash,
        prefix,
        label,
        at,
        at,
      );
      this.appendAudit('identity.personal_token_created', id, at, null);
    });
    return this.requiredPersonalToken(id);
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
    validateTokenHash(input.sessionHash);
    const prefix = credentialPrefix(input.prefix);
    const at = this.now();
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= at) {
      throw identityError('identity_invalid', 'Session expiry is invalid.');
    }
    const id = newId('browser_session');
    this.db.run(
      `INSERT INTO identity_browser_sessions (
         browser_session_id, user_id, personal_token_id, session_hash, prefix,
         expires_at, last_seen_at, revoked_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      id,
      input.userId,
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
    };
  }

  listAuditEvents(limit = 100): AuditEvent[] {
    return this.audit.list({ domain: 'identity', limit });
  }

  private initializeSchema(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS identity_organizations (
        organization_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        auth_mode TEXT NOT NULL,
        canonical_admin_origin TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS identity_users (
        user_id TEXT PRIMARY KEY,
        primary_email TEXT NOT NULL,
        display_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS identity_external_bindings (
        binding_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES identity_users(user_id),
        provider TEXT NOT NULL,
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        verified_email TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (provider, issuer, subject)
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS identity_memberships (
        membership_id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES identity_organizations(organization_id),
        user_id TEXT NOT NULL REFERENCES identity_users(user_id),
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (organization_id, user_id)
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS identity_owner_claims (
        owner_claim_id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL UNIQUE REFERENCES identity_organizations(organization_id),
        normalized_email TEXT NOT NULL,
        status TEXT NOT NULL,
        binding_id TEXT REFERENCES identity_external_bindings(binding_id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS identity_invitations (
        invitation_id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES identity_organizations(organization_id),
        normalized_email TEXT NOT NULL,
        role TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        inviter_membership_id TEXT NOT NULL REFERENCES identity_memberships(membership_id),
        accepted_membership_id TEXT REFERENCES identity_memberships(membership_id),
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS identity_invitations_state_idx
       ON identity_invitations (organization_id, status, expires_at)`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS identity_personal_tokens (
        personal_token_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES identity_users(user_id),
        token_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS identity_personal_tokens_prefix_idx
       ON identity_personal_tokens (prefix, status)`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS identity_browser_sessions (
        browser_session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES identity_users(user_id),
        personal_token_id TEXT NOT NULL REFERENCES identity_personal_tokens(personal_token_id),
        session_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL
      )`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS identity_browser_sessions_prefix_idx
       ON identity_browser_sessions (prefix, expires_at)`,
    );
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
  async findPersonalTokens(prefix: string) { return this.logic.findPersonalTokens(prefix); }
  async getPersonalToken(tokenId: string) { return this.logic.getPersonalToken(tokenId); }
  async revokePersonalToken(tokenId: string) { return this.logic.revokePersonalToken(tokenId); }
  async touchPersonalToken(tokenId: string) { return this.logic.touchPersonalToken(tokenId); }
  async createBrowserSession(input: CreateBrowserSessionRecordInput) { return this.logic.createBrowserSession(input); }
  async findBrowserSessions(prefix: string) { return this.logic.findBrowserSessions(prefix); }
  async revokeBrowserSession(sessionId: string) { return this.logic.revokeBrowserSession(sessionId); }
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
    personalTokenId: row.personal_token_id,
    sessionHash: row.session_hash,
    prefix: row.prefix,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
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
