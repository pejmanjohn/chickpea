import { randomUUID } from 'node:crypto';

import { AuditStoreLogic } from '../audit/store.ts';
import type { StateDb } from '../state/state-db.ts';
import { NodeStateDb, openStateDb } from '../state/node-state-db.ts';
import { identityError } from './errors.ts';
import { installIdentityMigrations } from './migrations.ts';
import type {
  AdvanceAuthOperationInput,
  AuthControl,
  AuthOperation,
  AuthOperationKind,
  AuthRateLimitState,
  BeginSlackCredentialRotationInput,
  BrowserSessionRecord,
  ClaimOwnerInput,
  ConsumeAuthOperationInput,
  ConsumeInvitationInput,
  CreateAuthOperationInput,
  CreateBrowserSessionRecordInput,
  CreateInvitationInput,
  CreateOwnerClaimInput,
  CreatePersonalTokenRecordInput,
  EnsureAuthControlInput,
  EnsureSlackCredentialControlInput,
  EnsureOrganizationInput,
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
  PromoteSlackCredentialRevisionInput,
  RewrapSlackCredentialRevisionInput,
  ResendInvitationInput,
  RotatePersonalTokenResult,
  SetMembershipAccessOverlayInput,
  SlackCredentialControl,
  SlackCredentialRetentionResult,
  SlackCredentialRevision,
  StageSlackCredentialRevisionInput,
  SlackIdentityBinding,
  UpdateAuthControlInput,
  UpdateMembershipInput,
  UpdateOrganizationAuthInput,
  TombstoneSlackCredentialRevisionInput,
  User,
} from './types.ts';

interface IdentityStoreOptions { now?: () => number }

const DEFAULT_INSTALLATION_ID = 'installation_oss';
const DEFAULT_ORGANIZATION_ID = 'org_oss';

export class IdentityStoreLogic {
  private readonly audit: AuditStoreLogic;
  private readonly now: () => number;

  constructor(private readonly db: StateDb, options: IdentityStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    installIdentityMigrations(db);
    this.audit = new AuditStoreLogic(db);
  }

  execute(request: IdentityRpcRequest): IdentityRpcResponse {
    switch (request.kind) {
      case 'ensure_auth_control': return { kind: 'auth_control', control: this.ensureAuthControl(request.input) };
      case 'get_auth_control': return { kind: 'auth_control', control: this.getAuthControl(request.installationId) ?? null };
      case 'update_auth_control': return { kind: 'auth_control', control: this.updateAuthControl(request.input) };
      case 'ensure_slack_credential_control': return { kind: 'slack_credential_control', control: this.ensureSlackCredentialControl(request.input) };
      case 'get_slack_credential_control': return { kind: 'slack_credential_control', control: this.getSlackCredentialControl(request.installationId) ?? null };
      case 'begin_slack_credential_rotation': return { kind: 'slack_credential_control', control: this.beginSlackCredentialRotation(request.input) };
      case 'stage_slack_credential_revision': return { kind: 'slack_credential_revision', revision: this.stageSlackCredentialRevision(request.input) };
      case 'get_active_slack_credential_revision': return { kind: 'slack_credential_revision', revision: this.getActiveSlackCredentialRevision(request.identityId) ?? null };
      case 'get_slack_credential_revision': return { kind: 'slack_credential_revision', revision: this.getSlackCredentialRevision(request.identityId, request.revision) ?? null };
      case 'has_slack_credential_history': return { kind: 'slack_credential_presence', present: this.hasSlackCredentialHistory(request.identityId) };
      case 'list_live_slack_credential_revisions': return { kind: 'slack_credential_revisions', revisions: this.listLiveSlackCredentialRevisions() };
      case 'promote_slack_credential_revision': return { kind: 'slack_credential_revision', revision: this.promoteSlackCredentialRevision(request.input) };
      case 'tombstone_slack_credential_revision': return { kind: 'slack_credential_revision', revision: this.tombstoneSlackCredentialRevision(request.input) };
      case 'rewrap_slack_credential_revision': return { kind: 'slack_credential_revision', revision: this.rewrapSlackCredentialRevision(request.input) };
      case 'count_live_slack_credential_revisions_by_key': return { kind: 'slack_credential_count', count: this.countLiveSlackCredentialRevisionsByKey(request.keyId, request.expectedRotationEpoch) };
      case 'sweep_slack_identity_retention': return { kind: 'slack_credential_retention', result: this.sweepSlackIdentityRetention(request.at, request.candidateMaxAgeMs) };
      case 'create_auth_operation': return { kind: 'auth_operation', operation: this.createAuthOperation(request.input) };
      case 'reserve_pending_auth_operation': {
        const result = this.reservePendingAuthOperation(request.input);
        return { kind: 'auth_operation_reservation', ...result };
      }
      case 'get_auth_operation': return { kind: 'auth_operation', operation: this.getAuthOperation(request.operationId) ?? null };
      case 'find_auth_operation': return { kind: 'auth_operation', operation: this.findAuthOperation(request.operationKind, request.capabilityHash) ?? null };
      case 'list_auth_operations': return { kind: 'auth_operations', operations: this.listAuthOperations(request.operationKind, request.organizationId) };
      case 'advance_auth_operation': return { kind: 'auth_operation', operation: this.advanceAuthOperation(request.input) };
      case 'consume_auth_operation': return { kind: 'auth_operation', operation: this.consumeAuthOperation(request.input) };
      case 'revoke_auth_operation': return { kind: 'auth_operation', operation: this.revokeAuthOperation(request.operationId) };
      case 'get_membership_access_overlay': return { kind: 'membership_access_overlay', overlay: this.getMembershipAccessOverlay(request.membershipId) ?? null };
      case 'set_membership_access_overlay': return { kind: 'membership_access_overlay', overlay: this.setMembershipAccessOverlay(request.input) };
      case 'ensure_organization': return { kind: 'organization', organization: this.ensureOrganization(request.input) };
      case 'get_organization': return { kind: 'organization', organization: this.getOrganization() ?? null };
      case 'create_owner_claim': return { kind: 'owner_claim', ownerClaim: this.createOwnerClaim(request.input) };
      case 'get_owner_claim': return { kind: 'owner_claim', ownerClaim: this.getOwnerClaim() ?? null };
      case 'claim_owner': return { kind: 'identity_resolution', resolution: this.claimOwner(request.input) };
      case 'resolve_slack_identity': return { kind: 'identity_resolution', resolution: this.resolveSlackIdentity(request.slackTeamId, request.slackUserId, request.organizationId) ?? null };
      case 'list_external_identities': return { kind: 'external_identities', externalIdentities: this.listExternalIdentities() };
      case 'list_memberships': return { kind: 'memberships', memberships: this.listMemberships() };
      case 'get_user': return { kind: 'user', user: this.getUser(request.userId) ?? null };
      case 'get_membership': return { kind: 'membership', membership: this.getMembership(request.membershipId) ?? null };
      case 'get_membership_for_user': {
        const membership = this.getMembershipForUser(request.userId, request.organizationId);
        return { kind: 'memberships', memberships: membership ? [membership] : [] };
      }
      case 'update_membership': return { kind: 'membership', membership: this.updateMembership(request.input) };
      case 'create_invitation': return { kind: 'invitation', invitation: this.createInvitation(request.input) };
      case 'resend_invitation': return { kind: 'invitation', invitation: this.resendInvitation(request.input) };
      case 'revoke_invitation': return { kind: 'invitation', invitation: this.revokeInvitation(request.invitationId) };
      case 'consume_invitation': return { kind: 'identity_resolution', resolution: this.consumeInvitation(request.input) };
      case 'list_invitations': return { kind: 'invitations', invitations: this.listInvitations() };
      case 'create_personal_token': return { kind: 'personal_token', personalToken: this.createPersonalToken(request.input) };
      case 'rotate_personal_token': return { kind: 'personal_token_rotation', result: this.rotatePersonalToken(request.input) };
      case 'find_personal_tokens': return { kind: 'personal_tokens', personalTokens: this.findPersonalTokens(request.prefix) };
      case 'get_personal_token': {
        const token = this.getPersonalToken(request.tokenId);
        return { kind: 'personal_tokens', personalTokens: token ? [token] : [] };
      }
      case 'revoke_personal_token': return { kind: 'personal_token', personalToken: this.revokePersonalToken(request.tokenId) };
      case 'touch_personal_token': return { kind: 'personal_token', personalToken: this.touchPersonalToken(request.tokenId) };
      case 'create_browser_session': return { kind: 'browser_session', browserSession: this.createBrowserSession(request.input) };
      case 'find_browser_sessions': return { kind: 'browser_sessions', browserSessions: this.findBrowserSessions(request.prefix) };
      case 'revoke_browser_session': return { kind: 'browser_session', browserSession: this.revokeBrowserSession(request.sessionId) };
      case 'update_organization_auth': return { kind: 'organization', organization: this.updateOrganizationAuth(request.input) };
      case 'get_auth_rate_limit': return { kind: 'auth_rate_limit', state: this.getAuthRateLimit(request.bucket, request.keyHash) ?? null };
      case 'record_auth_rate_failure': return { kind: 'auth_rate_limit', state: this.recordAuthRateFailure(request.bucket, request.keyHash, request.windowStart) };
      case 'clear_auth_rate_limit': this.clearAuthRateLimit(request.bucket, request.keyHash); return { kind: 'ok' };
      case 'record_identity_auth_audit': this.recordAuthAudit(request.input); return { kind: 'ok' };
      case 'export_summary': return { kind: 'identity_export', summary: this.exportSummary() };
      case 'list_identity_audit_events': return { kind: 'audit_events', events: this.listAuditEvents(request.limit) };
    }
  }

  ensureAuthControl(input: EnsureAuthControlInput = {}): AuthControl {
    const installationId = input.installationId ?? DEFAULT_INSTALLATION_ID;
    const existing = this.getAuthControl(installationId);
    if (existing) return existing;
    const at = this.now();
    this.db.run(
      `INSERT INTO identity_auth_controls (
        installation_id, auth_mode, health_gate, canonical_admin_origin,
        better_auth_organization_id, revision, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, NULL, 1, ?, ?)`,
      installationId, input.authMode ?? 'unconfigured', input.healthGate ?? 'normal', at, at,
    );
    return this.requiredAuthControl(installationId);
  }

  getAuthControl(installationId = DEFAULT_INSTALLATION_ID): AuthControl | undefined {
    const row = this.db.get('SELECT * FROM identity_auth_controls WHERE installation_id = ?', installationId);
    return row ? authControlFromRow(row) : undefined;
  }

  updateAuthControl(input: UpdateAuthControlInput): AuthControl {
    const installationId = input.installationId ?? DEFAULT_INSTALLATION_ID;
    const current = this.requiredAuthControl(installationId);
    const origin = input.canonicalAdminOrigin === undefined
      ? current.canonicalAdminOrigin
      : input.canonicalAdminOrigin === null ? null : validOrigin(input.canonicalAdminOrigin);
    const changed = this.db.run(
      `UPDATE identity_auth_controls SET auth_mode = ?, health_gate = ?, canonical_admin_origin = ?,
       better_auth_organization_id = ?, revision = revision + 1, updated_at = ?
       WHERE installation_id = ? AND revision = ?`,
      input.authMode ?? current.authMode,
      input.healthGate ?? current.healthGate,
      origin,
      input.betterAuthOrganizationId === undefined
        ? current.betterAuthOrganizationId
        : input.betterAuthOrganizationId,
      this.now(), installationId, input.expectedRevision,
    ).changes;
    if (changed !== 1) throw identityError('auth_control_conflict', 'Authentication control changed concurrently.');
    return this.requiredAuthControl(installationId);
  }

  ensureSlackCredentialControl(
    input: EnsureSlackCredentialControlInput,
  ): SlackCredentialControl {
    const installationId = input.installationId ?? DEFAULT_INSTALLATION_ID;
    const existing = this.getSlackCredentialControl(installationId);
    if (existing) return existing;
    const at = this.now();
    try {
      this.db.run(
        `INSERT INTO identity_slack_credential_controls (
          installation_id, deployment_id, current_key_id, rotation_epoch, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?)`,
        installationId, newId('deployment'), nonEmpty(input.currentKeyId, 'credential key ID'), at, at,
      );
    } catch {
      const winner = this.getSlackCredentialControl(installationId);
      if (winner) return winner;
      throw identityError('credential_revision_conflict', 'Slack credential control could not be initialized.');
    }
    return this.requiredSlackCredentialControl(installationId);
  }

  getSlackCredentialControl(
    installationId = DEFAULT_INSTALLATION_ID,
  ): SlackCredentialControl | undefined {
    const row = this.db.get(
      'SELECT * FROM identity_slack_credential_controls WHERE installation_id = ?',
      installationId,
    );
    return row ? slackCredentialControlFromRow(row) : undefined;
  }

  beginSlackCredentialRotation(
    input: BeginSlackCredentialRotationInput,
  ): SlackCredentialControl {
    const installationId = input.installationId ?? DEFAULT_INSTALLATION_ID;
    if (!Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch < 1) {
      throw identityError('identity_invalid', 'Slack credential rotation epoch is invalid.');
    }
    const expectedKeyId = nonEmpty(input.expectedCurrentKeyId, 'credential key ID');
    const nextKeyId = nonEmpty(input.nextKeyId, 'credential key ID');
    if (expectedKeyId === nextKeyId) {
      throw identityError('identity_invalid', 'Slack credential rotation requires a new key.');
    }
    const changed = this.db.run(
      `UPDATE identity_slack_credential_controls
       SET current_key_id = ?, rotation_epoch = rotation_epoch + 1, updated_at = ?
       WHERE installation_id = ? AND rotation_epoch = ? AND current_key_id = ?`,
      nextKeyId, this.now(), installationId, input.expectedEpoch, expectedKeyId,
    ).changes;
    if (changed !== 1) {
      throw identityError('credential_rotation_conflict', 'Slack credential encryption epoch changed.');
    }
    return this.requiredSlackCredentialControl(installationId);
  }

  stageSlackCredentialRevision(
    input: StageSlackCredentialRevisionInput,
  ): SlackCredentialRevision {
    validateCredentialRevisionInput(input);
    const installationId = input.installationId ?? DEFAULT_INSTALLATION_ID;
    return this.db.transaction(() => {
      const control = this.requiredSlackCredentialControl(installationId);
      requireCredentialEpoch(control, input.expectedRotationEpoch);
      if (input.envelope.keyId !== control.currentKeyId) {
        throw identityError('credential_rotation_conflict', 'Slack credential encryption epoch changed.');
      }
      const active = this.getActiveSlackCredentialRevision(input.identityId);
      if ((active?.revision ?? null) !== input.expectedActiveRevision) {
        throw identityError('credential_revision_conflict', 'Slack credential revision changed concurrently.');
      }
      const latestRow = this.db.get(
        `SELECT * FROM identity_slack_credential_revisions
         WHERE identity_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        input.identityId,
      );
      const latest = latestRow ? slackCredentialRevisionFromRow(latestRow) : undefined;
      // Realm identity remains immutable even after a recovery tombstone has
      // scrubbed the prior ciphertext. Tombstoning is revocation, never a way
      // to repoint an identity at a different app or workspace.
      if (latest) requireCredentialTransition(latest, input);
      const existing = this.getSlackCredentialRevision(input.identityId, input.revision);
      if (existing) {
        if (credentialRevisionMatches(existing, input)) return existing;
        throw identityError('credential_revision_conflict', 'Slack credential revision conflicts with existing state.');
      }
      const at = this.now();
      try {
        this.db.run(
          `INSERT INTO identity_slack_credential_revisions (
            identity_id, identity_class, purpose, revision, base_revision, status,
            app_id, team_id, bot_user_id,
            granted_scopes_json, validated_at, manifest_fingerprint, rotation_epoch,
            envelope_version, envelope_algorithm, key_id, nonce, ciphertext,
            created_at, updated_at, tombstoned_at
          ) VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          nonEmpty(input.identityId, 'Slack identity ID'), input.identityClass, input.purpose,
          nonEmpty(input.revision, 'credential revision'), input.expectedActiveRevision,
          nonEmpty(input.appId, 'Slack app ID'),
          input.teamId ?? null, input.botUserId ?? null,
          JSON.stringify(normalizeScopes(input.grantedScopes ?? [])), input.validatedAt ?? null,
          input.manifestFingerprint ?? null, control.rotationEpoch,
          input.envelope.version, input.envelope.algorithm, input.envelope.keyId,
          input.envelope.nonce, input.envelope.ciphertext, at, at,
        );
      } catch {
        throw identityError('credential_revision_conflict', 'Slack credential candidate changed concurrently.');
      }
      return this.requiredSlackCredentialRevision(input.identityId, input.revision);
    });
  }

  getActiveSlackCredentialRevision(identityId: string): SlackCredentialRevision | undefined {
    const row = this.db.get(
      `SELECT * FROM identity_slack_credential_revisions
       WHERE identity_id = ? AND status = 'active'`,
      nonEmpty(identityId, 'Slack identity ID'),
    );
    return row ? slackCredentialRevisionFromRow(row) : undefined;
  }

  getSlackCredentialRevision(
    identityId: string,
    revision: string,
  ): SlackCredentialRevision | undefined {
    const row = this.db.get(
      `SELECT * FROM identity_slack_credential_revisions
       WHERE identity_id = ? AND revision = ?`,
      nonEmpty(identityId, 'Slack identity ID'), nonEmpty(revision, 'credential revision'),
    );
    return row ? slackCredentialRevisionFromRow(row) : undefined;
  }

  hasSlackCredentialHistory(identityId: string): boolean {
    return Boolean(this.db.get(
      'SELECT 1 AS present FROM identity_slack_credential_revisions WHERE identity_id = ? LIMIT 1',
      nonEmpty(identityId, 'Slack identity ID'),
    ));
  }

  listLiveSlackCredentialRevisions(): SlackCredentialRevision[] {
    return this.db.all(
      `SELECT * FROM identity_slack_credential_revisions
       WHERE status IN ('active', 'candidate') ORDER BY identity_id, created_at, revision`,
    ).map(slackCredentialRevisionFromRow);
  }

  promoteSlackCredentialRevision(
    input: PromoteSlackCredentialRevisionInput,
  ): SlackCredentialRevision {
    const installationId = input.installationId ?? DEFAULT_INSTALLATION_ID;
    return this.db.transaction(() => {
      const control = this.requiredSlackCredentialControl(installationId);
      requireCredentialEpoch(control, input.expectedRotationEpoch);
      const active = this.getActiveSlackCredentialRevision(input.identityId);
      if ((active?.revision ?? null) !== input.expectedActiveRevision) {
        throw identityError('credential_revision_conflict', 'Slack credential revision changed concurrently.');
      }
      const candidate = this.requiredSlackCredentialRevision(
        input.identityId,
        input.candidateRevision,
      );
      if (candidate.status !== 'candidate' || !candidate.envelope ||
          candidate.baseRevision !== input.expectedActiveRevision ||
          candidate.rotationEpoch !== control.rotationEpoch ||
          candidate.envelope.keyId !== control.currentKeyId) {
        throw identityError('credential_revision_conflict', 'Slack credential candidate is not promotable.');
      }
      const at = this.now();
      if (active) {
        this.db.run(
          `UPDATE identity_slack_credential_revisions
           SET status = 'tombstoned', envelope_version = NULL, envelope_algorithm = NULL,
             key_id = NULL, nonce = NULL, ciphertext = NULL, tombstoned_at = ?, updated_at = ?
           WHERE identity_id = ? AND revision = ? AND status = 'active'`,
          at, at, active.identityId, active.revision,
        );
      }
      const changed = this.db.run(
        `UPDATE identity_slack_credential_revisions
         SET status = 'active', updated_at = ?
         WHERE identity_id = ? AND revision = ? AND status = 'candidate'`,
        at, input.identityId, input.candidateRevision,
      ).changes;
      if (changed !== 1) {
        throw identityError('credential_revision_conflict', 'Slack credential promotion lost its compare-and-set.');
      }
      return this.requiredSlackCredentialRevision(input.identityId, input.candidateRevision);
    });
  }

  tombstoneSlackCredentialRevision(
    input: TombstoneSlackCredentialRevisionInput,
  ): SlackCredentialRevision {
    const installationId = input.installationId ?? DEFAULT_INSTALLATION_ID;
    return this.db.transaction(() => {
      const control = this.requiredSlackCredentialControl(installationId);
      requireCredentialEpoch(control, input.expectedRotationEpoch);
      const current = this.requiredSlackCredentialRevision(input.identityId, input.revision);
      if (current.status === 'tombstoned') {
        const active = this.getActiveSlackCredentialRevision(input.identityId);
        if (active && active.revision !== input.revision) {
          throw identityError(
            'credential_revision_conflict',
            'Slack credential revision changed concurrently.',
          );
        }
        return current;
      }
      const at = this.now();
      this.db.run(
        `UPDATE identity_slack_credential_revisions
         SET status = 'tombstoned', envelope_version = NULL, envelope_algorithm = NULL,
           key_id = NULL, nonce = NULL, ciphertext = NULL, tombstoned_at = ?, updated_at = ?
         WHERE identity_id = ? AND revision = ? AND status IN ('active', 'candidate')`,
        at, at, input.identityId, input.revision,
      );
      return this.requiredSlackCredentialRevision(input.identityId, input.revision);
    });
  }

  rewrapSlackCredentialRevision(
    input: RewrapSlackCredentialRevisionInput,
  ): SlackCredentialRevision {
    const installationId = input.installationId ?? DEFAULT_INSTALLATION_ID;
    return this.db.transaction(() => {
      const control = this.requiredSlackCredentialControl(installationId);
      requireCredentialEpoch(control, input.expectedRotationEpoch);
      if (input.envelope.keyId !== control.currentKeyId) {
        throw identityError('credential_rotation_conflict', 'Slack credential encryption epoch changed.');
      }
      const current = this.requiredSlackCredentialRevision(input.identityId, input.revision);
      if (!current.envelope || current.status === 'tombstoned' ||
          current.envelope.keyId !== input.expectedKeyId) {
        throw identityError('credential_revision_conflict', 'Slack credential rewrap lost its compare-and-set.');
      }
      const changed = this.db.run(
        `UPDATE identity_slack_credential_revisions SET
          envelope_version = ?, envelope_algorithm = ?, key_id = ?, nonce = ?, ciphertext = ?,
          rotation_epoch = ?, updated_at = ?
         WHERE identity_id = ? AND revision = ? AND status IN ('active', 'candidate')
           AND key_id = ? AND rotation_epoch = ?`,
        input.envelope.version, input.envelope.algorithm, input.envelope.keyId,
        input.envelope.nonce, input.envelope.ciphertext, control.rotationEpoch, this.now(),
        input.identityId, input.revision, input.expectedKeyId, current.rotationEpoch,
      ).changes;
      if (changed !== 1) {
        throw identityError('credential_revision_conflict', 'Slack credential rewrap lost its compare-and-set.');
      }
      return this.requiredSlackCredentialRevision(input.identityId, input.revision);
    });
  }

  countLiveSlackCredentialRevisionsByKey(
    keyId: string,
    expectedRotationEpoch: number,
  ): number {
    const control = this.requiredSlackCredentialControl(DEFAULT_INSTALLATION_ID);
    requireCredentialEpoch(control, expectedRotationEpoch);
    return Number(this.db.get(
      `SELECT COUNT(*) AS count FROM identity_slack_credential_revisions
       WHERE status IN ('active', 'candidate') AND key_id = ?`,
      nonEmpty(keyId, 'credential key ID'),
    )?.count ?? 0);
  }

  sweepSlackIdentityRetention(
    at: number,
    candidateMaxAgeMs: number,
  ): SlackCredentialRetentionResult {
    if (!Number.isSafeInteger(at) || at < 0 ||
        !Number.isSafeInteger(candidateMaxAgeMs) || candidateMaxAgeMs < 1) {
      throw identityError('identity_invalid', 'Slack identity retention boundary is invalid.');
    }
    return this.db.transaction(() => {
      const expiredAuthOperations = this.db.run(
        `UPDATE identity_auth_operations SET status = 'expired', updated_at = ?
         WHERE status IN ('reserved', 'reconciling') AND expires_at <= ?`,
        at, at,
      ).changes;
      const expiredInvitations = this.db.run(
        `UPDATE identity_invitations SET status = 'expired', updated_at = ?
         WHERE status = 'pending' AND expires_at <= ?`,
        at, at,
      ).changes;
      const expiredBrowserSessions = this.db.run(
        'DELETE FROM identity_browser_sessions WHERE expires_at <= ?',
        at,
      ).changes;
      const scrubbedCredentialCandidates = this.db.run(
        `UPDATE identity_slack_credential_revisions
         SET status = 'tombstoned', envelope_version = NULL, envelope_algorithm = NULL,
           key_id = NULL, nonce = NULL, ciphertext = NULL, tombstoned_at = ?, updated_at = ?
         WHERE status = 'candidate' AND created_at <= ?`,
        at, at, at - candidateMaxAgeMs,
      ).changes;
      return {
        expiredAuthOperations,
        expiredInvitations,
        expiredBrowserSessions,
        scrubbedCredentialCandidates,
      };
    });
  }

  createAuthOperation(input: CreateAuthOperationInput): AuthOperation {
    validateOperationInput(input);
    const id = input.id ?? newId('authop');
    const at = this.now();
    try {
      this.db.run(
        `INSERT INTO identity_auth_operations (
          operation_id, kind, organization_id, expected_slack_team_id, expected_slack_user_id,
          chickpea_role, capability_hash, status, step, better_auth_user_id,
          better_auth_organization_id, better_auth_membership_id, chickpea_membership_id,
          expires_at, activated_at, tombstoned_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', 0, NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, ?)`,
        id, input.kind, input.organizationId ?? null,
        slackId(input.expectedSlackTeamId, 'Slack team ID'),
        slackId(input.expectedSlackUserId, 'Slack user ID'),
        input.chickpeaRole ?? null, credentialHash(input.capabilityHash), input.expiresAt, at, at,
      );
    } catch (error) {
      const replay = this.getAuthOperation(id);
      if (replay && operationMatchesInput(replay, input)) return replay;
      throw identityError('auth_operation_conflict', 'Authentication operation conflicts with existing authority.');
    }
    return this.requiredAuthOperation(id);
  }

  reservePendingAuthOperation(input: CreateAuthOperationInput): { operation: AuthOperation; created: boolean } {
    validateOperationInput(input);
    const existing = input.kind === 'first_owner_claim'
      ? this.db.get(
        `SELECT * FROM identity_auth_operations WHERE kind = 'first_owner_claim'
         AND status IN ('reserved', 'reconciling', 'active') LIMIT 1`,
      )
      : this.db.get(
        `SELECT * FROM identity_auth_operations WHERE kind = ? AND organization_id IS ?
         AND expected_slack_team_id = ? AND expected_slack_user_id = ?
         AND status IN ('reserved', 'reconciling', 'active') LIMIT 1`,
        input.kind, input.organizationId ?? null, input.expectedSlackTeamId, input.expectedSlackUserId,
      );
    if (existing) {
      const operation = authOperationFromRow(existing);
      if (!operationMatchesInput(operation, input)) {
        throw identityError('auth_operation_conflict', 'Authentication operation is already reserved.');
      }
      return { operation, created: false };
    }
    return { operation: this.createAuthOperation(input), created: true };
  }

  getAuthOperation(operationId: string): AuthOperation | undefined {
    const row = this.db.get('SELECT * FROM identity_auth_operations WHERE operation_id = ?', operationId);
    return row ? authOperationFromRow(row) : undefined;
  }

  findAuthOperation(kind: AuthOperationKind, capabilityHash: string): AuthOperation | undefined {
    const row = this.db.get(
      'SELECT * FROM identity_auth_operations WHERE kind = ? AND capability_hash = ?',
      kind, credentialHash(capabilityHash),
    );
    return row ? authOperationFromRow(row) : undefined;
  }

  listAuthOperations(kind?: AuthOperationKind, organizationId?: string): AuthOperation[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (kind) { clauses.push('kind = ?'); params.push(kind); }
    if (organizationId) { clauses.push('organization_id = ?'); params.push(organizationId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.all(
      `SELECT * FROM identity_auth_operations ${where} ORDER BY created_at, operation_id`,
      ...params,
    ).map(authOperationFromRow);
  }

  advanceAuthOperation(input: AdvanceAuthOperationInput): AuthOperation {
    const at = input.at ?? this.now();
    const current = this.requiredLiveOperation(input.operationId, input.capabilityHash, at);
    if (!Number.isSafeInteger(input.step) || input.step <= current.step) {
      throw identityError('auth_operation_step_invalid', 'Authentication operation step must advance.');
    }
    const values = {
      user: mergeOpaque(current.betterAuthUserId, input.betterAuthUserId, 'Better Auth user ID'),
      organization: mergeOpaque(current.betterAuthOrganizationId, input.betterAuthOrganizationId, 'Better Auth organization ID'),
      member: mergeOpaque(current.betterAuthMembershipId, input.betterAuthMembershipId, 'Better Auth membership ID'),
      chickpeaMember: mergeOpaque(current.chickpeaMembershipId, input.chickpeaMembershipId, 'Chickpea membership ID'),
    };
    this.db.run(
      `UPDATE identity_auth_operations SET status = 'reconciling', step = ?, better_auth_user_id = ?,
       better_auth_organization_id = ?, better_auth_membership_id = ?, chickpea_membership_id = ?, updated_at = ?
       WHERE operation_id = ? AND status IN ('reserved', 'reconciling')`,
      input.step, values.user, values.organization, values.member, values.chickpeaMember, at, current.id,
    );
    return this.requiredAuthOperation(current.id);
  }

  consumeAuthOperation(input: ConsumeAuthOperationInput): AuthOperation {
    const at = input.at ?? this.now();
    const current = this.requiredLiveOperation(input.operationId, input.capabilityHash, at);
    if (current.step !== input.expectedStep || !current.betterAuthUserId ||
        !current.betterAuthOrganizationId || !current.betterAuthMembershipId ||
        !current.chickpeaMembershipId) {
      throw identityError('auth_operation_step_invalid', 'Authentication operation is not ready to activate.');
    }
    this.db.run(
      `UPDATE identity_auth_operations SET status = 'active', activated_at = ?, updated_at = ?
       WHERE operation_id = ? AND status IN ('reserved', 'reconciling')`,
      at, at, current.id,
    );
    return this.requiredAuthOperation(current.id);
  }

  revokeAuthOperation(operationId: string): AuthOperation {
    const current = this.requiredAuthOperation(operationId);
    if (current.status === 'active') {
      throw identityError('auth_operation_unavailable', 'Active authority cannot be tombstoned.');
    }
    const at = this.now();
    this.db.run(
      `UPDATE identity_auth_operations SET status = 'tombstoned', tombstoned_at = ?, updated_at = ?
       WHERE operation_id = ? AND status IN ('reserved', 'reconciling')`,
      at, at, operationId,
    );
    return this.requiredAuthOperation(operationId);
  }

  ensureOrganization(input: EnsureOrganizationInput): Organization {
    const existing = this.getOrganization();
    if (existing) {
      if (input.slackTeamId && existing.slackTeamId && input.slackTeamId !== existing.slackTeamId) {
        throw identityError('organization_missing', 'The installation is bound to another Slack workspace.');
      }
      return existing;
    }
    const at = this.now();
    this.db.run(
      `INSERT INTO identity_organizations (
        organization_id, display_name, slack_team_id, auth_mode, canonical_admin_origin, created_at, updated_at
      ) VALUES (?, ?, ?, 'unconfigured', NULL, ?, ?)`,
      DEFAULT_ORGANIZATION_ID, strictText(input.displayName, 'display name', 120),
      input.slackTeamId ? slackId(input.slackTeamId, 'Slack team ID') : null, at, at,
    );
    return this.requiredOrganization();
  }

  getOrganization(): Organization | undefined {
    const row = this.db.get('SELECT * FROM identity_organizations ORDER BY created_at LIMIT 1');
    return row ? organizationFromRow(row) : undefined;
  }

  createOwnerClaim(input: CreateOwnerClaimInput): OwnerClaim {
    const existing = this.getOwnerClaim();
    if (existing) {
      if (existing.operationId === input.operationId && existing.slackTeamId === input.slackTeamId &&
          existing.slackUserId === input.slackUserId) return existing;
      throw identityError('owner_claim_conflict', 'The singleton first-Owner claim is already reserved.');
    }
    const operation = this.requiredAuthOperation(input.operationId);
    if (operation.kind !== 'first_owner_claim' || operation.expectedSlackTeamId !== input.slackTeamId ||
        operation.expectedSlackUserId !== input.slackUserId || operation.status !== 'reserved') {
      throw identityError('owner_claim_conflict', 'The first-Owner operation does not match this Slack identity.');
    }
    const at = input.at ?? this.now();
    this.db.run(
      `INSERT INTO identity_owner_claims (
        claim_key, owner_claim_id, operation_id, organization_id, slack_team_id, slack_user_id,
        status, membership_id, created_at, updated_at
      ) VALUES ('first_owner', ?, ?, ?, ?, ?, 'reserved', NULL, ?, ?)`,
      newId('ownerclaim'), input.operationId, input.organizationId ?? null,
      slackId(input.slackTeamId, 'Slack team ID'), slackId(input.slackUserId, 'Slack user ID'), at, at,
    );
    return this.requiredOwnerClaim();
  }

  getOwnerClaim(): OwnerClaim | undefined {
    const row = this.db.get("SELECT * FROM identity_owner_claims WHERE claim_key = 'first_owner'");
    return row ? ownerClaimFromRow(row) : undefined;
  }

  claimOwner(input: ClaimOwnerInput): IdentityResolution {
    return this.db.transaction(() => {
      const claim = this.requiredOwnerClaim();
      if (claim.status === 'active') {
        const existing = this.resolveSlackIdentity(input.slackTeamId, input.slackUserId, input.organizationId);
        if (existing?.membership.id === claim.membershipId) return existing;
        throw identityError('owner_already_claimed', 'The first Owner has already been claimed.');
      }
      if (claim.status !== 'reserved' || claim.operationId !== input.operationId ||
          claim.slackTeamId !== input.slackTeamId || claim.slackUserId !== input.slackUserId) {
        throw identityError('owner_claim_conflict', 'The verified Slack identity does not own this claim.');
      }
      const operation = this.requiredAuthOperation(input.operationId);
      if (!['reserved', 'reconciling'].includes(operation.status) ||
          operation.expectedSlackTeamId !== input.slackTeamId ||
          operation.expectedSlackUserId !== input.slackUserId ||
          operation.chickpeaRole !== 'owner' ||
          operation.betterAuthUserId !== input.betterAuthUserId ||
          operation.betterAuthMembershipId !== input.betterAuthMembershipId ||
          !operation.betterAuthOrganizationId) {
        throw identityError('owner_claim_conflict', 'The first-Owner operation is unavailable.');
      }
      const organization = this.ensureOrganization({
        displayName: 'Chickpea', slackTeamId: input.slackTeamId,
      });
      if (organization.id !== input.organizationId) {
        throw identityError('organization_missing', 'The first-Owner organization is invalid.');
      }
      const resolution = this.insertCanonicalIdentity({ ...input, role: 'owner' });
      const at = input.at ?? this.now();
      this.db.run(
        `UPDATE identity_owner_claims SET organization_id = ?, status = 'active', membership_id = ?, updated_at = ?
         WHERE claim_key = 'first_owner' AND status = 'reserved'`,
        organization.id, resolution.membership.id, at,
      );
      this.db.run(
        `UPDATE identity_organizations SET slack_team_id = ?, auth_mode = 'slack_active', updated_at = ?
         WHERE organization_id = ? AND (slack_team_id IS NULL OR slack_team_id = ?)`,
        input.slackTeamId, at, organization.id, input.slackTeamId,
      );
      this.db.run(
        `UPDATE identity_auth_operations SET status = 'active', chickpea_role = 'owner',
         better_auth_user_id = ?, better_auth_membership_id = ?, chickpea_membership_id = ?,
         activated_at = ?, updated_at = ? WHERE operation_id = ?`,
        input.betterAuthUserId, input.betterAuthMembershipId, resolution.membership.id,
        at, at, operation.id,
      );
      const control = this.ensureAuthControl();
      if (control.authMode !== 'slack_active') {
        this.updateAuthControl({
          expectedRevision: control.revision,
          authMode: 'slack_active',
          betterAuthOrganizationId: operation.betterAuthOrganizationId,
        });
      }
      return this.requiredResolution(input.slackTeamId, input.slackUserId, organization.id);
    });
  }

  resolveSlackIdentity(
    slackTeamIdValue: string,
    slackUserIdValue: string,
    organizationId?: string,
  ): IdentityResolution | undefined {
    const row = this.db.get(
      `SELECT
        b.*, u.display_name AS u_display_name, u.created_at AS u_created_at, u.updated_at AS u_updated_at,
        m.role AS m_role, m.status AS m_status, m.created_at AS m_created_at, m.updated_at AS m_updated_at
       FROM identity_slack_bindings b
       JOIN identity_users u ON u.user_id = b.user_id
       JOIN identity_memberships m ON m.membership_id = b.membership_id
       WHERE b.slack_team_id = ? AND b.slack_user_id = ? ${organizationId ? 'AND b.organization_id = ?' : ''}
       LIMIT 1`,
      slackTeamIdValue, slackUserIdValue, ...(organizationId ? [organizationId] : []),
    );
    return row ? resolutionFromRow(row) : undefined;
  }

  listExternalIdentities(): SlackIdentityBinding[] {
    return this.db.all('SELECT * FROM identity_slack_bindings ORDER BY created_at, binding_id')
      .map(slackBindingFromRow);
  }

  resolveActorExternalIdentity(
    provider: 'slack',
    slackTeamIdValue: string,
    slackUserIdValue: string,
  ): SlackIdentityBinding | undefined {
    if (provider !== 'slack') return undefined;
    return this.resolveSlackIdentity(slackTeamIdValue, slackUserIdValue)?.binding;
  }

  listMemberships(): Membership[] {
    return this.db.all('SELECT * FROM identity_memberships ORDER BY created_at, membership_id')
      .map(membershipFromRow);
  }

  getUser(userId: string): User | undefined {
    const row = this.db.get('SELECT * FROM identity_users WHERE user_id = ?', userId);
    return row ? userFromRow(row) : undefined;
  }

  getMembership(membershipId: string): Membership | undefined {
    const row = this.db.get('SELECT * FROM identity_memberships WHERE membership_id = ?', membershipId);
    return row ? membershipFromRow(row) : undefined;
  }

  getMembershipForUser(userId: string, organizationId?: string): Membership | undefined {
    const row = this.db.get(
      `SELECT * FROM identity_memberships WHERE user_id = ? ${organizationId ? 'AND organization_id = ?' : ''}
       ORDER BY created_at LIMIT 1`,
      userId, ...(organizationId ? [organizationId] : []),
    );
    return row ? membershipFromRow(row) : undefined;
  }

  updateMembership(input: UpdateMembershipInput): Membership {
    return this.db.transaction(() => {
      const current = this.requiredMembership(input.membershipId);
      const role = input.role ?? current.role;
      const status = input.status ?? current.status;
      if (current.role === 'owner' && current.status === 'active' &&
          (role !== 'owner' || status !== 'active')) {
        const owners = Number(this.db.get(
          `SELECT count(*) AS count FROM identity_memberships
           WHERE organization_id = ? AND role = 'owner' AND status = 'active'`,
          current.organizationId,
        )?.count ?? 0);
        if (owners <= 1) throw identityError('last_owner_required', 'At least one active Owner is required.');
      }
      this.db.run(
        'UPDATE identity_memberships SET role = ?, status = ?, updated_at = ? WHERE membership_id = ?',
        role, status, this.now(), current.id,
      );
      return this.requiredMembership(current.id);
    });
  }

  createInvitation(input: CreateInvitationInput): Invitation {
    const inviter = this.requiredMembership(input.inviterMembershipId);
    if (inviter.organizationId !== input.organizationId || inviter.role !== 'owner' || inviter.status !== 'active') {
      throw identityError('inviter_not_authorized', 'Only an active Owner can invite an Admin.');
    }
    const organization = this.requiredOrganization();
    if (organization.id !== input.organizationId || organization.slackTeamId !== input.slackTeamId) {
      throw identityError('identity_invalid', 'Invitation Slack workspace does not match the installation.');
    }
    const existingRow = this.db.get(
      `SELECT * FROM identity_invitations WHERE organization_id = ? AND slack_team_id = ?
       AND slack_user_id = ? AND status = 'pending' LIMIT 1`,
      input.organizationId, input.slackTeamId, input.slackUserId,
    );
    if (existingRow) return invitationFromRow(existingRow);
    const at = this.now();
    const id = newId('invite');
    this.db.run(
      `INSERT INTO identity_invitations (
        invitation_id, organization_id, slack_team_id, slack_user_id, display_name, role,
        locator_hash, status, inviter_membership_id, accepted_membership_id,
        expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?, ?)`,
      id, input.organizationId, slackId(input.slackTeamId, 'Slack team ID'),
      slackId(input.slackUserId, 'Slack user ID'), cleanDisplayName(input.displayName),
      input.role, credentialHash(input.locatorHash), input.inviterMembershipId,
      input.expiresAt, at, at,
    );
    return this.requiredInvitation(id);
  }

  resendInvitation(input: ResendInvitationInput): Invitation {
    const current = this.requiredInvitation(input.invitationId);
    if (current.status !== 'pending') throw identityError('invitation_not_pending', 'Invitation is unavailable.');
    this.db.run(
      `UPDATE identity_invitations SET locator_hash = ?, expires_at = ?, updated_at = ?
       WHERE invitation_id = ? AND status = 'pending'`,
      credentialHash(input.locatorHash), input.expiresAt, this.now(), current.id,
    );
    return this.requiredInvitation(current.id);
  }

  revokeInvitation(invitationId: string): Invitation {
    const current = this.requiredInvitation(invitationId);
    if (current.status !== 'pending') throw identityError('invitation_not_pending', 'Invitation is unavailable.');
    this.db.run(
      "UPDATE identity_invitations SET status = 'revoked', updated_at = ? WHERE invitation_id = ?",
      this.now(), current.id,
    );
    return this.requiredInvitation(current.id);
  }

  consumeInvitation(input: ConsumeInvitationInput): IdentityResolution {
    return this.db.transaction(() => {
      const invitation = this.requiredInvitation(input.invitationId);
      const at = input.at ?? this.now();
      if (invitation.status !== 'pending') throw identityError('invitation_not_pending', 'Invitation is unavailable.');
      if (invitation.expiresAt <= at) {
        this.db.run("UPDATE identity_invitations SET status = 'expired', updated_at = ? WHERE invitation_id = ?", at, invitation.id);
        throw identityError('invitation_expired', 'Invitation has expired.');
      }
      if (invitation.locatorHash !== credentialHash(input.locatorHash)) {
        throw identityError('invitation_token_invalid', 'Invitation is unavailable.');
      }
      if (invitation.slackTeamId !== input.slackTeamId || invitation.slackUserId !== input.slackUserId) {
        throw identityError('invitation_identity_mismatch', 'Slack identity does not match invitation.');
      }
      const resolution = this.insertCanonicalIdentity({
        operationId: `invitation:${invitation.id}`,
        organizationId: invitation.organizationId,
        slackTeamId: input.slackTeamId,
        slackUserId: input.slackUserId,
        displayName: input.displayName ?? invitation.displayName,
        betterAuthUserId: input.betterAuthUserId,
        betterAuthMembershipId: input.betterAuthMembershipId,
        role: invitation.role,
        at,
      });
      this.db.run(
        `UPDATE identity_invitations SET status = 'accepted', accepted_membership_id = ?, updated_at = ?
         WHERE invitation_id = ? AND status = 'pending'`,
        resolution.membership.id, at, invitation.id,
      );
      return resolution;
    });
  }

  listInvitations(): Invitation[] {
    return this.db.all('SELECT * FROM identity_invitations ORDER BY created_at, invitation_id')
      .map(invitationFromRow);
  }

  getMembershipAccessOverlay(membershipId: string): MembershipAccessOverlay | undefined {
    const row = this.db.get(
      'SELECT * FROM identity_membership_access_overlays WHERE membership_id = ?', membershipId,
    );
    return row ? overlayFromRow(row) : undefined;
  }

  setMembershipAccessOverlay(input: SetMembershipAccessOverlayInput): MembershipAccessOverlay {
    const current = this.getMembershipAccessOverlay(input.membershipId);
    if (input.expectedVersion !== undefined && (current?.membershipVersion ?? 0) !== input.expectedVersion) {
      throw identityError('membership_conflict', 'Membership access changed concurrently.');
    }
    const at = input.at ?? this.now();
    this.db.run(
      `INSERT INTO identity_membership_access_overlays (
        membership_id, organization_id, access_status, membership_version, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT (membership_id) DO UPDATE SET access_status = excluded.access_status,
        membership_version = identity_membership_access_overlays.membership_version + 1,
        updated_at = excluded.updated_at`,
      input.membershipId, input.organizationId, input.accessStatus, at, at,
    );
    return this.getMembershipAccessOverlay(input.membershipId)!;
  }

  createPersonalToken(input: CreatePersonalTokenRecordInput): PersonalTokenRecord {
    const id = newId('pat');
    const at = this.now();
    this.db.run(
      `INSERT INTO identity_personal_tokens (
        personal_token_id, organization_id, user_id, membership_id, token_hash, prefix,
        label, status, last_used_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
      id, input.organizationId ?? null, input.userId, input.membershipId ?? null,
      credentialHash(input.tokenHash), credentialPrefix(input.prefix),
      strictText(input.label, 'token label', 120), at, at,
    );
    return this.requiredPersonalToken(id);
  }

  rotatePersonalToken(input: CreatePersonalTokenRecordInput): RotatePersonalTokenResult {
    return this.db.transaction(() => {
      const at = this.now();
      const revoked = this.db.run(
        `UPDATE identity_personal_tokens SET status = 'revoked', updated_at = ?
         WHERE user_id = ? AND status = 'active'`,
        at, input.userId,
      ).changes;
      return { personalToken: this.createPersonalToken(input), revokedCount: revoked };
    });
  }

  findPersonalTokens(prefix: string): PersonalTokenRecord[] {
    return this.db.all(
      "SELECT * FROM identity_personal_tokens WHERE prefix = ? AND status = 'active' ORDER BY created_at",
      credentialPrefix(prefix),
    ).map(personalTokenFromRow);
  }

  getPersonalToken(tokenId: string): PersonalTokenRecord | undefined {
    const row = this.db.get('SELECT * FROM identity_personal_tokens WHERE personal_token_id = ?', tokenId);
    return row ? personalTokenFromRow(row) : undefined;
  }

  revokePersonalToken(tokenId: string): PersonalTokenRecord {
    const current = this.requiredPersonalToken(tokenId);
    this.db.run(
      "UPDATE identity_personal_tokens SET status = 'revoked', updated_at = ? WHERE personal_token_id = ?",
      this.now(), current.id,
    );
    return this.requiredPersonalToken(tokenId);
  }

  touchPersonalToken(tokenId: string): PersonalTokenRecord {
    const current = this.requiredPersonalToken(tokenId);
    this.db.run(
      'UPDATE identity_personal_tokens SET last_used_at = ?, updated_at = ? WHERE personal_token_id = ?',
      this.now(), this.now(), current.id,
    );
    return this.requiredPersonalToken(tokenId);
  }

  createBrowserSession(input: CreateBrowserSessionRecordInput): BrowserSessionRecord {
    const id = newId('session');
    const at = this.now();
    this.db.run(
      `INSERT INTO identity_browser_sessions (
        browser_session_id, organization_id, user_id, membership_id, personal_token_id,
        session_hash, prefix, expires_at, last_seen_at, revoked_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      id, input.organizationId ?? null, input.userId, input.membershipId ?? null,
      input.personalTokenId, credentialHash(input.sessionHash), credentialPrefix(input.prefix),
      input.expiresAt, at, at,
    );
    return this.requiredBrowserSession(id);
  }

  findBrowserSessions(prefix: string): BrowserSessionRecord[] {
    return this.db.all(
      `SELECT * FROM identity_browser_sessions WHERE prefix = ? AND revoked_at IS NULL
       AND expires_at > ? ORDER BY created_at`,
      credentialPrefix(prefix), this.now(),
    ).map(browserSessionFromRow);
  }

  revokeBrowserSession(sessionId: string): BrowserSessionRecord {
    const current = this.requiredBrowserSession(sessionId);
    this.db.run(
      'UPDATE identity_browser_sessions SET revoked_at = ? WHERE browser_session_id = ? AND revoked_at IS NULL',
      this.now(), current.id,
    );
    return this.requiredBrowserSession(sessionId);
  }

  updateOrganizationAuth(input: UpdateOrganizationAuthInput): Organization {
    const current = this.requiredOrganization();
    if (current.id !== input.organizationId) throw identityError('organization_missing', 'Organization was not found.');
    const origin = input.canonicalAdminOrigin === undefined
      ? current.canonicalAdminOrigin
      : input.canonicalAdminOrigin === null ? null : validOrigin(input.canonicalAdminOrigin);
    this.db.run(
      'UPDATE identity_organizations SET auth_mode = ?, canonical_admin_origin = ?, updated_at = ? WHERE organization_id = ?',
      input.authMode, origin, this.now(), current.id,
    );
    return this.requiredOrganization();
  }

  getAuthRateLimit(bucket: string, keyHash: string): AuthRateLimitState | undefined {
    const row = this.db.get(
      'SELECT * FROM identity_auth_rate_limits WHERE bucket = ? AND key_hash = ?',
      nonEmpty(bucket, 'bucket'), credentialHash(keyHash),
    );
    return row ? rateLimitFromRow(row) : undefined;
  }

  recordAuthRateFailure(bucket: string, keyHash: string, windowStart: number): AuthRateLimitState {
    this.db.run(
      `INSERT INTO identity_auth_rate_limits (bucket, key_hash, window_start, failures) VALUES (?, ?, ?, 1)
       ON CONFLICT (bucket, key_hash) DO UPDATE SET
         failures = CASE WHEN identity_auth_rate_limits.window_start = excluded.window_start
           THEN identity_auth_rate_limits.failures + 1 ELSE 1 END,
         window_start = excluded.window_start`,
      nonEmpty(bucket, 'bucket'), credentialHash(keyHash), windowStart,
    );
    return this.getAuthRateLimit(bucket, keyHash)!;
  }

  clearAuthRateLimit(bucket: string, keyHash: string): void {
    this.db.run(
      'DELETE FROM identity_auth_rate_limits WHERE bucket = ? AND key_hash = ?',
      nonEmpty(bucket, 'bucket'), credentialHash(keyHash),
    );
  }

  recordAuthAudit(input: RecordIdentityAuthAuditInput): void {
    this.audit.append({
      eventId: newId('audit'), domain: 'identity', eventType: `identity.${input.event}`,
      outcome: input.outcome, actorClass: input.authenticatorKind,
      actorId: input.membershipId ?? null, subjectId: input.userId ?? null,
      createdAt: input.at ?? this.now(), reasonCode: input.reasonCode ?? null,
      metadataJson: JSON.stringify({
        action: safeAudit(input.action), correlationId: safeAudit(input.correlationId),
        authenticatorKind: safeAudit(input.authenticatorKind),
      }),
    });
  }

  listAuditEvents(limit = 100) { return this.audit.list({ domain: 'identity', limit }); }

  exportSummary(): IdentityExportSummary {
    return {
      organization: this.getOrganization() ?? null,
      users: this.db.all('SELECT * FROM identity_users ORDER BY created_at, user_id').map(userFromRow),
      slackBindings: this.listExternalIdentities(),
      memberships: this.listMemberships(),
      ownerClaim: this.getOwnerClaim() ?? null,
      invitations: this.listInvitations().map(({ locatorHash: _locatorHash, ...invitation }) => invitation),
      personalTokens: this.db.all('SELECT * FROM identity_personal_tokens ORDER BY created_at')
        .map(personalTokenFromRow).map(({ tokenHash: _tokenHash, ...token }) => token),
      browserSessions: this.db.all('SELECT * FROM identity_browser_sessions ORDER BY created_at')
        .map(browserSessionFromRow).map(({ sessionHash: _sessionHash, ...session }) => session),
      authControl: this.getAuthControl() ?? null,
      authOperations: this.listAuthOperations().map(({ capabilityHash: _capabilityHash, ...operation }) => operation),
    };
  }

  private insertCanonicalIdentity(input: ClaimOwnerInput & { role: Membership['role'] }): IdentityResolution {
    const existing = this.resolveSlackIdentity(input.slackTeamId, input.slackUserId);
    if (existing) {
      if (existing.membership.organizationId !== input.organizationId ||
          existing.binding.betterAuthUserId !== input.betterAuthUserId ||
          existing.binding.betterAuthMembershipId !== input.betterAuthMembershipId) {
        throw identityError('external_identity_conflict', 'Slack identity is already bound.');
      }
      return existing;
    }
    const at = input.at ?? this.now();
    const userId = newId('user');
    const membershipId = newId('membership');
    const bindingId = newId('slackbinding');
    this.db.run(
      `INSERT INTO identity_users (
        user_id, slack_team_id, slack_user_id, display_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      userId, slackId(input.slackTeamId, 'Slack team ID'),
      slackId(input.slackUserId, 'Slack user ID'), cleanDisplayName(input.displayName), at, at,
    );
    this.db.run(
      `INSERT INTO identity_memberships (
        membership_id, organization_id, user_id, role, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      membershipId, input.organizationId, userId, input.role, at, at,
    );
    this.db.run(
      `INSERT INTO identity_slack_bindings (
        binding_id, slack_team_id, slack_user_id, user_id, organization_id, membership_id,
        better_auth_user_id, better_auth_membership_id, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      bindingId, input.slackTeamId, input.slackUserId, userId, input.organizationId,
      membershipId, nonEmpty(input.betterAuthUserId, 'Better Auth user ID'),
      nonEmpty(input.betterAuthMembershipId, 'Better Auth membership ID'), at, at,
    );
    return this.requiredResolution(input.slackTeamId, input.slackUserId, input.organizationId);
  }

  private requiredLiveOperation(operationId: string, capabilityHash: string, at: number): AuthOperation {
    const operation = this.requiredAuthOperation(operationId);
    if (!['reserved', 'reconciling'].includes(operation.status) ||
        operation.capabilityHash !== credentialHash(capabilityHash)) {
      throw identityError('auth_operation_unavailable', 'Authentication operation is unavailable.');
    }
    if (operation.expiresAt <= at) {
      this.db.run(
        "UPDATE identity_auth_operations SET status = 'expired', updated_at = ? WHERE operation_id = ?",
        at, operation.id,
      );
      throw identityError('auth_operation_expired', 'Authentication operation has expired.');
    }
    return operation;
  }

  private requiredAuthControl(id: string): AuthControl {
    const value = this.getAuthControl(id);
    if (!value) throw identityError('auth_control_missing', 'Authentication control was not found.');
    return value;
  }
  private requiredSlackCredentialControl(id: string): SlackCredentialControl {
    const value = this.getSlackCredentialControl(id);
    if (!value) {
      throw identityError('credential_control_missing', 'Slack credential control was not found.');
    }
    return value;
  }
  private requiredSlackCredentialRevision(
    identityId: string,
    revision: string,
  ): SlackCredentialRevision {
    const value = this.getSlackCredentialRevision(identityId, revision);
    if (!value) {
      throw identityError('credential_revision_missing', 'Slack credential revision was not found.');
    }
    return value;
  }
  private requiredAuthOperation(id: string): AuthOperation {
    const value = this.getAuthOperation(id);
    if (!value) throw identityError('auth_operation_missing', 'Authentication operation was not found.');
    return value;
  }
  private requiredOrganization(): Organization {
    const value = this.getOrganization();
    if (!value) throw identityError('organization_missing', 'Organization was not found.');
    return value;
  }
  private requiredOwnerClaim(): OwnerClaim {
    const value = this.getOwnerClaim();
    if (!value) throw identityError('owner_claim_missing', 'First-Owner claim was not found.');
    return value;
  }
  private requiredMembership(id: string): Membership {
    const value = this.getMembership(id);
    if (!value) throw identityError('membership_missing', 'Membership was not found.');
    return value;
  }
  private requiredInvitation(id: string): Invitation {
    const row = this.db.get('SELECT * FROM identity_invitations WHERE invitation_id = ?', id);
    if (!row) throw identityError('invitation_missing', 'Invitation was not found.');
    return invitationFromRow(row);
  }
  private requiredPersonalToken(id: string): PersonalTokenRecord {
    const value = this.getPersonalToken(id);
    if (!value) throw identityError('personal_token_missing', 'Personal token was not found.');
    return value;
  }
  private requiredBrowserSession(id: string): BrowserSessionRecord {
    const row = this.db.get('SELECT * FROM identity_browser_sessions WHERE browser_session_id = ?', id);
    if (!row) throw identityError('browser_session_missing', 'Browser session was not found.');
    return browserSessionFromRow(row);
  }
  private requiredResolution(teamId: string, userId: string, organizationId: string): IdentityResolution {
    const value = this.resolveSlackIdentity(teamId, userId, organizationId);
    if (!value) throw identityError('identity_invalid', 'Slack identity was not readable.');
    return value;
  }
}

export class SqliteIdentityStore implements IdentityStore {
  private readonly db: NodeStateDb;
  private readonly logic: IdentityStoreLogic;
  constructor(path: string, options: IdentityStoreOptions = {}) {
    this.db = openStateDb(path);
    this.logic = new IdentityStoreLogic(this.db, options);
  }
  async ensureAuthControl(input: EnsureAuthControlInput = {}) { return this.logic.ensureAuthControl(input); }
  async getAuthControl(id?: string) { return this.logic.getAuthControl(id); }
  async updateAuthControl(input: UpdateAuthControlInput) { return this.logic.updateAuthControl(input); }
  async ensureSlackCredentialControl(input: EnsureSlackCredentialControlInput) { return this.logic.ensureSlackCredentialControl(input); }
  async getSlackCredentialControl(id?: string) { return this.logic.getSlackCredentialControl(id); }
  async beginSlackCredentialRotation(input: BeginSlackCredentialRotationInput) { return this.logic.beginSlackCredentialRotation(input); }
  async stageSlackCredentialRevision(input: StageSlackCredentialRevisionInput) { return this.logic.stageSlackCredentialRevision(input); }
  async getActiveSlackCredentialRevision(identityId: string) { return this.logic.getActiveSlackCredentialRevision(identityId); }
  async getSlackCredentialRevision(identityId: string, revision: string) { return this.logic.getSlackCredentialRevision(identityId, revision); }
  async hasSlackCredentialHistory(identityId: string) { return this.logic.hasSlackCredentialHistory(identityId); }
  async listLiveSlackCredentialRevisions() { return this.logic.listLiveSlackCredentialRevisions(); }
  async promoteSlackCredentialRevision(input: PromoteSlackCredentialRevisionInput) { return this.logic.promoteSlackCredentialRevision(input); }
  async tombstoneSlackCredentialRevision(input: TombstoneSlackCredentialRevisionInput) { return this.logic.tombstoneSlackCredentialRevision(input); }
  async rewrapSlackCredentialRevision(input: RewrapSlackCredentialRevisionInput) { return this.logic.rewrapSlackCredentialRevision(input); }
  async countLiveSlackCredentialRevisionsByKey(keyId: string, epoch: number) { return this.logic.countLiveSlackCredentialRevisionsByKey(keyId, epoch); }
  async sweepSlackIdentityRetention(at: number, candidateMaxAgeMs: number) { return this.logic.sweepSlackIdentityRetention(at, candidateMaxAgeMs); }
  async createAuthOperation(input: CreateAuthOperationInput) { return this.logic.createAuthOperation(input); }
  async reservePendingAuthOperation(input: CreateAuthOperationInput) { return this.logic.reservePendingAuthOperation(input); }
  async getAuthOperation(id: string) { return this.logic.getAuthOperation(id); }
  async findAuthOperation(kind: AuthOperationKind, hash: string) { return this.logic.findAuthOperation(kind, hash); }
  async listAuthOperations(kind?: AuthOperationKind, organizationId?: string) { return this.logic.listAuthOperations(kind, organizationId); }
  async advanceAuthOperation(input: AdvanceAuthOperationInput) { return this.logic.advanceAuthOperation(input); }
  async consumeAuthOperation(input: ConsumeAuthOperationInput) { return this.logic.consumeAuthOperation(input); }
  async revokeAuthOperation(id: string) { return this.logic.revokeAuthOperation(id); }
  async getMembershipAccessOverlay(id: string) { return this.logic.getMembershipAccessOverlay(id); }
  async setMembershipAccessOverlay(input: SetMembershipAccessOverlayInput) { return this.logic.setMembershipAccessOverlay(input); }
  async ensureOrganization(input: EnsureOrganizationInput) { return this.logic.ensureOrganization(input); }
  async getOrganization() { return this.logic.getOrganization(); }
  async createOwnerClaim(input: CreateOwnerClaimInput) { return this.logic.createOwnerClaim(input); }
  async getOwnerClaim() { return this.logic.getOwnerClaim(); }
  async claimOwner(input: ClaimOwnerInput) { return this.logic.claimOwner(input); }
  async resolveSlackIdentity(teamId: string, userId: string, organizationId?: string) { return this.logic.resolveSlackIdentity(teamId, userId, organizationId); }
  async listExternalIdentities() { return this.logic.listExternalIdentities(); }
  async resolveActorExternalIdentity(provider: 'slack', teamId: string, userId: string) { return this.logic.resolveActorExternalIdentity(provider, teamId, userId); }
  async listMemberships() { return this.logic.listMemberships(); }
  async getUser(id: string) { return this.logic.getUser(id); }
  async getMembership(id: string) { return this.logic.getMembership(id); }
  async getMembershipForUser(userId: string, organizationId?: string) { return this.logic.getMembershipForUser(userId, organizationId); }
  async updateMembership(input: UpdateMembershipInput) { return this.logic.updateMembership(input); }
  async createInvitation(input: CreateInvitationInput) { return this.logic.createInvitation(input); }
  async resendInvitation(input: ResendInvitationInput) { return this.logic.resendInvitation(input); }
  async revokeInvitation(id: string) { return this.logic.revokeInvitation(id); }
  async consumeInvitation(input: ConsumeInvitationInput) { return this.logic.consumeInvitation(input); }
  async listInvitations() { return this.logic.listInvitations(); }
  async createPersonalToken(input: CreatePersonalTokenRecordInput) { return this.logic.createPersonalToken(input); }
  async rotatePersonalToken(input: CreatePersonalTokenRecordInput) { return this.logic.rotatePersonalToken(input); }
  async findPersonalTokens(prefix: string) { return this.logic.findPersonalTokens(prefix); }
  async getPersonalToken(id: string) { return this.logic.getPersonalToken(id); }
  async revokePersonalToken(id: string) { return this.logic.revokePersonalToken(id); }
  async touchPersonalToken(id: string) { return this.logic.touchPersonalToken(id); }
  async createBrowserSession(input: CreateBrowserSessionRecordInput) { return this.logic.createBrowserSession(input); }
  async findBrowserSessions(prefix: string) { return this.logic.findBrowserSessions(prefix); }
  async revokeBrowserSession(id: string) { return this.logic.revokeBrowserSession(id); }
  async updateOrganizationAuth(input: UpdateOrganizationAuthInput) { return this.logic.updateOrganizationAuth(input); }
  async getAuthRateLimit(bucket: string, hash: string) { return this.logic.getAuthRateLimit(bucket, hash); }
  async recordAuthRateFailure(bucket: string, hash: string, window: number) { return this.logic.recordAuthRateFailure(bucket, hash, window); }
  async clearAuthRateLimit(bucket: string, hash: string) { this.logic.clearAuthRateLimit(bucket, hash); }
  async recordAuthAudit(input: RecordIdentityAuthAuditInput) { this.logic.recordAuthAudit(input); }
  async exportSummary() { return this.logic.exportSummary(); }
  async listAuditEvents(limit?: number) { return this.logic.listAuditEvents(limit); }
  close() { this.db.close(); }
}

function validateOperationInput(input: CreateAuthOperationInput): void {
  if (!['first_owner_claim', 'invitation_admission', 'login'].includes(input.kind)) {
    throw identityError('identity_invalid', 'Authentication operation kind is invalid.');
  }
  slackId(input.expectedSlackTeamId, 'Slack team ID');
  slackId(input.expectedSlackUserId, 'Slack user ID');
  credentialHash(input.capabilityHash);
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0) {
    throw identityError('identity_invalid', 'Authentication operation expiry is invalid.');
  }
}

function validateCredentialRevisionInput(input: StageSlackCredentialRevisionInput): void {
  const allowedPurpose = input.identityClass === 'workspace_default'
    ? input.purpose === 'app_credentials' || input.purpose === 'connected_credentials'
    : input.purpose === 'bot_credentials';
  if (!allowedPurpose) {
    throw identityError('identity_invalid', 'Slack credential purpose does not match its identity class.');
  }
  if (!Number.isSafeInteger(input.expectedRotationEpoch) || input.expectedRotationEpoch < 1) {
    throw identityError('identity_invalid', 'Slack credential rotation epoch is invalid.');
  }
  if (input.purpose === 'connected_credentials' && !input.teamId) {
    throw identityError('identity_invalid', 'Connected Slack credentials require a workspace.');
  }
  if (input.purpose === 'app_credentials' && input.teamId !== undefined && input.teamId !== null) {
    throw identityError('identity_invalid', 'Pre-install Slack app credentials cannot bind a workspace.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.envelope.keyId) ||
      !/^[A-Za-z0-9_-]{16}$/.test(input.envelope.nonce) ||
      !/^[A-Za-z0-9_-]{22,131072}$/.test(input.envelope.ciphertext)) {
    throw identityError('identity_invalid', 'Slack credential envelope is invalid.');
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(input.identityId)) {
    throw identityError('identity_invalid', 'Slack identity ID is invalid.');
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.revision)) {
    throw identityError('identity_invalid', 'Credential revision is invalid.');
  }
  slackId(input.appId, 'Slack app ID');
  if (input.teamId) slackId(input.teamId, 'Slack team ID');
  if (input.botUserId) slackId(input.botUserId, 'Slack bot user ID');
  if (input.manifestFingerprint !== undefined && input.manifestFingerprint !== null) {
    strictText(input.manifestFingerprint, 'manifest fingerprint', 256);
  }
  if (input.validatedAt !== undefined && input.validatedAt !== null &&
      (!Number.isSafeInteger(input.validatedAt) || input.validatedAt < 0)) {
    throw identityError('identity_invalid', 'Slack credential validation time is invalid.');
  }
  if (input.envelope.version !== 1 || input.envelope.algorithm !== 'AES-GCM-256') {
    throw identityError('identity_invalid', 'Slack credential envelope is invalid.');
  }
  normalizeScopes(input.grantedScopes ?? []);
}

function requireCredentialTransition(
  active: SlackCredentialRevision,
  input: StageSlackCredentialRevisionInput,
): void {
  if (active.identityClass !== input.identityClass) {
    throw identityError('credential_revision_conflict', 'Slack credential identity class is immutable.');
  }
  if (active.appId !== input.appId) {
    throw identityError('credential_revision_conflict', 'Slack credential app identity is immutable.');
  }
  const nextTeamId = input.teamId ?? null;
  if (active.teamId && active.teamId !== nextTeamId) {
    throw identityError('credential_revision_conflict', 'Slack credential workspace identity is immutable.');
  }
  if (active.purpose === 'connected_credentials' && input.purpose === 'app_credentials') {
    throw identityError('credential_revision_conflict', 'Connected Slack credentials cannot be downgraded.');
  }
  if (active.manifestFingerprint !== (input.manifestFingerprint ?? null)) {
    throw identityError('credential_revision_conflict', 'Slack credential manifest is immutable.');
  }
}

function normalizeScopes(values: readonly string[]): string[] {
  if (values.length > 128) throw identityError('identity_invalid', 'Slack granted scopes are invalid.');
  const normalized = [...new Set(values.map((value) => value.trim()))].sort();
  if (normalized.some((value) => !/^[a-z][a-z0-9_.:-]{0,127}$/.test(value))) {
    throw identityError('identity_invalid', 'Slack granted scopes are invalid.');
  }
  return normalized;
}

function requireCredentialEpoch(control: SlackCredentialControl, expectedEpoch: number): void {
  if (control.rotationEpoch !== expectedEpoch) {
    throw identityError('credential_rotation_conflict', 'Slack credential encryption epoch changed.');
  }
}

function credentialRevisionMatches(
  revision: SlackCredentialRevision,
  input: StageSlackCredentialRevisionInput,
): boolean {
  return revision.status === 'candidate' && revision.identityClass === input.identityClass &&
    revision.purpose === input.purpose && revision.baseRevision === input.expectedActiveRevision &&
    revision.appId === input.appId &&
    revision.teamId === (input.teamId ?? null) && revision.botUserId === (input.botUserId ?? null) &&
    revision.manifestFingerprint === (input.manifestFingerprint ?? null) &&
    revision.validatedAt === (input.validatedAt ?? null) &&
    JSON.stringify(revision.grantedScopes) === JSON.stringify(normalizeScopes(input.grantedScopes ?? [])) &&
    revision.rotationEpoch === input.expectedRotationEpoch &&
    JSON.stringify(revision.envelope) === JSON.stringify(input.envelope);
}

function slackCredentialControlFromRow(row: Record<string, unknown>): SlackCredentialControl {
  return {
    installationId: String(row.installation_id),
    deploymentId: String(row.deployment_id),
    currentKeyId: String(row.current_key_id),
    rotationEpoch: Number(row.rotation_epoch),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function slackCredentialRevisionFromRow(row: Record<string, unknown>): SlackCredentialRevision {
  const hasEnvelope = row.ciphertext !== null && row.ciphertext !== undefined;
  return {
    identityId: String(row.identity_id),
    identityClass: String(row.identity_class) as SlackCredentialRevision['identityClass'],
    purpose: String(row.purpose) as SlackCredentialRevision['purpose'],
    revision: String(row.revision),
    baseRevision: row.base_revision === null ? null : String(row.base_revision),
    status: String(row.status) as SlackCredentialRevision['status'],
    appId: String(row.app_id),
    teamId: row.team_id === null || row.team_id === undefined ? null : String(row.team_id),
    botUserId: row.bot_user_id === null || row.bot_user_id === undefined ? null : String(row.bot_user_id),
    grantedScopes: JSON.parse(String(row.granted_scopes_json)) as string[],
    validatedAt: row.validated_at === null || row.validated_at === undefined
      ? null : Number(row.validated_at),
    manifestFingerprint: row.manifest_fingerprint === null || row.manifest_fingerprint === undefined
      ? null : String(row.manifest_fingerprint),
    rotationEpoch: Number(row.rotation_epoch),
    envelope: hasEnvelope ? {
      version: Number(row.envelope_version) as 1,
      algorithm: String(row.envelope_algorithm) as 'AES-GCM-256',
      keyId: String(row.key_id),
      nonce: String(row.nonce),
      ciphertext: String(row.ciphertext),
    } : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    tombstonedAt: row.tombstoned_at === null || row.tombstoned_at === undefined
      ? null : Number(row.tombstoned_at),
  };
}

function operationMatchesInput(operation: AuthOperation, input: CreateAuthOperationInput): boolean {
  return operation.kind === input.kind && operation.organizationId === (input.organizationId ?? null) &&
    operation.expectedSlackTeamId === input.expectedSlackTeamId &&
    operation.expectedSlackUserId === input.expectedSlackUserId &&
    operation.chickpeaRole === (input.chickpeaRole ?? null) &&
    operation.capabilityHash === credentialHash(input.capabilityHash) &&
    operation.expiresAt === input.expiresAt;
}

function mergeOpaque(current: string | null, candidate: string | null | undefined, field: string): string | null {
  if (candidate === undefined || candidate === null) return current;
  const normalized = nonEmpty(candidate, field);
  if (current && current !== normalized) throw identityError('auth_operation_conflict', `${field} is immutable.`);
  return normalized;
}

function slackId(value: string, field: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9]{2,64}$/.test(normalized)) throw identityError('identity_invalid', `${field} is invalid.`);
  return normalized;
}

function cleanDisplayName(value: string | null | undefined): string | null {
  if (value === undefined || value === null || !value.trim()) return null;
  return strictText(value, 'display name', 120);
}

function validOrigin(value: string): string {
  try {
    const url = new URL(value);
    const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !loopback) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) throw new Error('invalid');
    return url.origin;
  } catch {
    throw identityError('identity_invalid', 'Canonical Admin origin is invalid.');
  }
}

function credentialHash(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw identityError('identity_invalid', 'Credential digest is invalid.');
  return value;
}
function credentialPrefix(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(normalized)) throw identityError('identity_invalid', 'Credential prefix is invalid.');
  return normalized;
}
function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw identityError('identity_invalid', `${field} is invalid.`);
  }
  return normalized;
}
function strictText(value: string, field: string, max: number): string {
  const normalized = nonEmpty(value, field);
  if (normalized.length > max) throw identityError('identity_invalid', `${field} is invalid.`);
  return normalized;
}
function safeAudit(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(normalized)) {
    throw identityError('identity_invalid', 'Audit field is invalid.');
  }
  return normalized;
}
function newId(prefix: string): string { return `${prefix}_${randomUUID().replaceAll('-', '')}`; }

function authControlFromRow(row: Record<string, unknown>): AuthControl {
  return { installationId: String(row.installation_id), authMode: row.auth_mode as AuthControl['authMode'],
    healthGate: row.health_gate as AuthControl['healthGate'],
    canonicalAdminOrigin: nullableString(row.canonical_admin_origin),
    betterAuthOrganizationId: nullableString(row.better_auth_organization_id), revision: Number(row.revision),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
function authOperationFromRow(row: Record<string, unknown>): AuthOperation {
  return { id: String(row.operation_id), kind: row.kind as AuthOperation['kind'],
    organizationId: nullableString(row.organization_id), expectedSlackTeamId: String(row.expected_slack_team_id),
    expectedSlackUserId: String(row.expected_slack_user_id), chickpeaRole: row.chickpea_role as AuthOperation['chickpeaRole'],
    capabilityHash: String(row.capability_hash), status: row.status as AuthOperation['status'], step: Number(row.step),
    betterAuthUserId: nullableString(row.better_auth_user_id), betterAuthOrganizationId: nullableString(row.better_auth_organization_id),
    betterAuthMembershipId: nullableString(row.better_auth_membership_id), chickpeaMembershipId: nullableString(row.chickpea_membership_id),
    expiresAt: Number(row.expires_at), activatedAt: nullableNumber(row.activated_at), tombstonedAt: nullableNumber(row.tombstoned_at),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
function organizationFromRow(row: Record<string, unknown>): Organization {
  return { id: String(row.organization_id), displayName: String(row.display_name),
    slackTeamId: nullableString(row.slack_team_id), authMode: row.auth_mode as Organization['authMode'],
    canonicalAdminOrigin: nullableString(row.canonical_admin_origin), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
function userFromRow(row: Record<string, unknown>): User {
  return { id: String(row.user_id), slackTeamId: String(row.slack_team_id), slackUserId: String(row.slack_user_id),
    displayName: nullableString(row.display_name), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
function membershipFromRow(row: Record<string, unknown>): Membership {
  return { id: String(row.membership_id), organizationId: String(row.organization_id), userId: String(row.user_id),
    role: row.role as Membership['role'], status: row.status as Membership['status'],
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
function slackBindingFromRow(row: Record<string, unknown>): SlackIdentityBinding {
  return { id: String(row.binding_id), provider: 'slack', slackTeamId: String(row.slack_team_id),
    slackUserId: String(row.slack_user_id), userId: String(row.user_id), organizationId: String(row.organization_id),
    membershipId: String(row.membership_id), betterAuthUserId: String(row.better_auth_user_id),
    betterAuthMembershipId: String(row.better_auth_membership_id), revision: Number(row.revision),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
function ownerClaimFromRow(row: Record<string, unknown>): OwnerClaim {
  return { id: String(row.owner_claim_id), operationId: String(row.operation_id), organizationId: nullableString(row.organization_id),
    slackTeamId: String(row.slack_team_id), slackUserId: String(row.slack_user_id), status: row.status as OwnerClaim['status'],
    membershipId: nullableString(row.membership_id), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
function invitationFromRow(row: Record<string, unknown>): Invitation {
  return { id: String(row.invitation_id), organizationId: String(row.organization_id), slackTeamId: String(row.slack_team_id),
    slackUserId: String(row.slack_user_id), displayName: nullableString(row.display_name), role: row.role as Invitation['role'],
    locatorHash: String(row.locator_hash), status: row.status as Invitation['status'], inviterMembershipId: String(row.inviter_membership_id),
    acceptedMembershipId: nullableString(row.accepted_membership_id), expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
function overlayFromRow(row: Record<string, unknown>): MembershipAccessOverlay {
  return { membershipId: String(row.membership_id), organizationId: String(row.organization_id),
    accessStatus: row.access_status as MembershipAccessOverlay['accessStatus'], membershipVersion: Number(row.membership_version),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
function personalTokenFromRow(row: Record<string, unknown>): PersonalTokenRecord {
  return { id: String(row.personal_token_id), organizationId: nullableString(row.organization_id), userId: String(row.user_id),
    membershipId: nullableString(row.membership_id), tokenHash: String(row.token_hash), prefix: String(row.prefix),
    label: String(row.label), status: row.status as PersonalTokenRecord['status'], lastUsedAt: nullableNumber(row.last_used_at),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
function browserSessionFromRow(row: Record<string, unknown>): BrowserSessionRecord {
  return { id: String(row.browser_session_id), organizationId: nullableString(row.organization_id), userId: String(row.user_id),
    membershipId: nullableString(row.membership_id), personalTokenId: String(row.personal_token_id), sessionHash: String(row.session_hash),
    prefix: String(row.prefix), expiresAt: Number(row.expires_at), lastSeenAt: Number(row.last_seen_at),
    revokedAt: nullableNumber(row.revoked_at), createdAt: Number(row.created_at) };
}
function rateLimitFromRow(row: Record<string, unknown>): AuthRateLimitState {
  return { bucket: String(row.bucket), keyHash: String(row.key_hash), windowStart: Number(row.window_start), failures: Number(row.failures) };
}
function resolutionFromRow(row: Record<string, unknown>): IdentityResolution {
  const binding = slackBindingFromRow(row);
  return { binding,
    user: { id: binding.userId, slackTeamId: binding.slackTeamId, slackUserId: binding.slackUserId,
      displayName: nullableString(row.u_display_name), createdAt: Number(row.u_created_at), updatedAt: Number(row.u_updated_at) },
    membership: { id: binding.membershipId, organizationId: binding.organizationId, userId: binding.userId,
      role: row.m_role as Membership['role'], status: row.m_status as Membership['status'],
      createdAt: Number(row.m_created_at), updatedAt: Number(row.m_updated_at) } };
}
function nullableString(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }
function nullableNumber(value: unknown): number | null { return value === null || value === undefined ? null : Number(value); }
