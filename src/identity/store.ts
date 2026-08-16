import { randomUUID } from 'node:crypto';

import { AuditStoreLogic } from '../audit/store.ts';
import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../config/types.ts';
import type { StateDb } from '../state/state-db.ts';
import { NodeStateDb, openStateDb } from '../state/node-state-db.ts';
import { identityError } from './errors.ts';
import { installIdentityMigrations } from './migrations.ts';
import type {
  AdvanceAuthOperationInput,
  ActivateInvitationInput,
  ActivateFirstOwnerInput,
  AdmitSlackOidcAttemptInput,
  AcquireSlackOidcAttemptInput,
  AcquireSlackRecoveryOAuthInput,
  AuthControl,
  AuthOperation,
  AuthOperationKind,
  AuthRateLimitState,
  BeginSlackAppCreationInput,
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
  CreateSlackOAuthAttemptInput,
  CreateSlackOidcAttemptInput,
  CreateSlackRecoverySessionInput,
  AcquireSlackOAuthAttemptInput,
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
  MembershipAuthorityMutationResult,
  MembershipAccessOverlay,
  Organization,
  OwnerClaim,
  PersonalTokenRecord,
  RecordIdentityAuthAuditInput,
  RecordSlackAppCreationSuccessInput,
  PromoteSlackCredentialRevisionInput,
  PromoteSlackRecoveryCandidateInput,
  RewrapSlackCredentialRevisionInput,
  ResendInvitationInput,
  RotatePersonalTokenResult,
  SetMembershipAccessOverlayInput,
  SlackCredentialControl,
  SlackCredentialRetentionResult,
  SlackCredentialRevision,
  SlackSetupTransaction,
  SlackSetupTransitionInput,
  ReserveSlackSetupTransactionInput,
  FailSlackAppCreationInput,
  MarkSlackSetupApprovalPendingInput,
  MarkSlackOAuthApprovalPendingInput,
  RecordSlackBotInstallationCandidateInput,
  RecordSlackEventsProofInput,
  RecordSlackRecoveryCandidateInput,
  PromoteSlackBotInstallationInput,
  FailSlackBotInstallationInput,
  SettleSlackOAuthAttemptInput,
  SettleSlackOidcAttemptInput,
  SlackOAuthAttempt,
  SlackOidcAttempt,
  SlackEventsProof,
  SlackRecoverySession,
  StageSlackRecoveryAppCredentialsInput,
  StartSlackRecoveryOAuthInput,
  StageSlackCredentialRevisionInput,
  SlackIdentityBinding,
  UpdateAuthControlInput,
  UpdateMembershipAuthorityInput,
  UpdateSlackRecoveryManifestInput,
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
      case 'create_slack_recovery_session': return { kind: 'slack_recovery_session', session: this.createSlackRecoverySession(request.input) };
      case 'get_slack_recovery_session': return { kind: 'slack_recovery_session', session: this.getSlackRecoverySession(request.recoveryId) ?? null };
      case 'stage_slack_recovery_app_credentials': return { kind: 'slack_recovery_session', session: this.stageSlackRecoveryAppCredentials(request.input) };
      case 'start_slack_recovery_oauth': return { kind: 'slack_recovery_session', session: this.startSlackRecoveryOAuth(request.input) };
      case 'update_slack_recovery_manifest': return { kind: 'slack_recovery_session', session: this.updateSlackRecoveryManifest(request.input) };
      case 'acquire_slack_recovery_oauth': return { kind: 'slack_recovery_session', session: this.acquireSlackRecoveryOAuth(request.input) };
      case 'record_slack_recovery_candidate': return { kind: 'slack_recovery_session', session: this.recordSlackRecoveryCandidate(request.input) };
      case 'promote_slack_recovery_candidate': return { kind: 'slack_recovery_session', session: this.promoteSlackRecoveryCandidate(request.input) };
      case 'reserve_slack_setup_transaction': return { kind: 'slack_setup_transaction', transaction: this.reserveSlackSetupTransaction(request.input) };
      case 'get_slack_setup_transaction': return { kind: 'slack_setup_transaction', transaction: this.getSlackSetupTransaction(request.setupId) ?? null };
      case 'find_slack_setup_transaction': return { kind: 'slack_setup_transaction', transaction: this.findSlackSetupTransaction(request.locatorHash) ?? null };
      case 'begin_slack_app_creation': return { kind: 'slack_setup_transaction', transaction: this.beginSlackAppCreation(request.input) };
      case 'fail_slack_app_creation': return { kind: 'slack_setup_transaction', transaction: this.failSlackAppCreation(request.input) };
      case 'record_slack_app_creation_success': return { kind: 'slack_setup_transaction', transaction: this.recordSlackAppCreationSuccess(request.input) };
      case 'restart_slack_app_creation': return { kind: 'slack_setup_transaction', transaction: this.restartSlackAppCreation(request.input) };
      case 'mark_slack_setup_approval_pending': return { kind: 'slack_setup_transaction', transaction: this.markSlackSetupApprovalPending(request.input) };
      case 'resume_slack_setup_after_approval': return { kind: 'slack_setup_transaction', transaction: this.resumeSlackSetupAfterApproval(request.input) };
      case 'create_slack_oauth_attempt': return { kind: 'slack_oauth_attempt', attempt: this.createSlackOAuthAttempt(request.input) };
      case 'get_slack_oauth_attempt': return { kind: 'slack_oauth_attempt', attempt: this.getSlackOAuthAttempt(request.attemptId) ?? null };
      case 'acquire_slack_oauth_attempt': return { kind: 'slack_oauth_attempt', attempt: this.acquireSlackOAuthAttempt(request.input) };
      case 'settle_slack_oauth_attempt': return { kind: 'slack_oauth_attempt', attempt: this.settleSlackOAuthAttempt(request.input) };
      case 'mark_slack_oauth_approval_pending': return { kind: 'slack_setup_transaction', transaction: this.markSlackOAuthApprovalPending(request.input) };
      case 'record_slack_bot_installation_candidate': return { kind: 'slack_setup_transaction', transaction: this.recordSlackBotInstallationCandidate(request.input) };
      case 'get_slack_events_proof': return { kind: 'slack_events_proof', proof: this.getSlackEventsProof(request.candidateRevision) ?? null };
      case 'record_slack_events_proof': return { kind: 'slack_events_proof', proof: this.recordSlackEventsProof(request.input) };
      case 'promote_slack_bot_installation': return { kind: 'slack_setup_transaction', transaction: this.promoteSlackBotInstallation(request.input) };
      case 'fail_slack_bot_installation': return { kind: 'slack_setup_transaction', transaction: this.failSlackBotInstallation(request.input) };
      case 'create_slack_oidc_attempt': return { kind: 'slack_oidc_attempt', attempt: this.createSlackOidcAttempt(request.input) };
      case 'get_slack_oidc_attempt': return { kind: 'slack_oidc_attempt', attempt: this.getSlackOidcAttempt(request.attemptId) ?? null };
      case 'acquire_slack_oidc_attempt': return { kind: 'slack_oidc_attempt', attempt: this.acquireSlackOidcAttempt(request.input) };
      case 'admit_slack_oidc_attempt': return { kind: 'auth_operation', operation: this.admitSlackOidcAttempt(request.input) };
      case 'settle_slack_oidc_attempt': return { kind: 'slack_oidc_attempt', attempt: this.settleSlackOidcAttempt(request.input) };
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
      case 'activate_first_owner': return { kind: 'identity_resolution', resolution: this.activateFirstOwner(request.input) };
      case 'activate_invitation': return { kind: 'identity_resolution', resolution: this.activateInvitation(request.input) };
      case 'resolve_slack_identity': return { kind: 'identity_resolution', resolution: this.resolveSlackIdentity(request.slackTeamId, request.slackUserId, request.organizationId) ?? null };
      case 'list_external_identities': return { kind: 'external_identities', externalIdentities: this.listExternalIdentities() };
      case 'list_memberships': return { kind: 'memberships', memberships: this.listMemberships() };
      case 'get_user': return { kind: 'user', user: this.getUser(request.userId) ?? null };
      case 'get_membership': return { kind: 'membership', membership: this.getMembership(request.membershipId) ?? null };
      case 'get_membership_for_user': {
        const membership = this.getMembershipForUser(request.userId, request.organizationId);
        return { kind: 'memberships', memberships: membership ? [membership] : [] };
      }
      case 'update_membership_authority': return {
        kind: 'membership_authority_mutation', result: this.updateMembershipAuthority(request.input),
      };
      case 'create_invitation': return { kind: 'invitation', invitation: this.createInvitation(request.input) };
      case 'find_invitation': {
        const invitation = this.findInvitation(request.locatorHash);
        return invitation
          ? { kind: 'invitation', invitation }
          : { kind: 'invitations', invitations: [] };
      }
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
    return this.db.transaction(() => this.stageSlackCredentialRevisionInTransaction(input));
  }

  private stageSlackCredentialRevisionInTransaction(
    input: StageSlackCredentialRevisionInput,
  ): SlackCredentialRevision {
    const installationId = input.installationId ?? DEFAULT_INSTALLATION_ID;
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
        nonEmpty(input.appId, 'Slack app ID'), input.teamId ?? null, input.botUserId ?? null,
        JSON.stringify(normalizeScopes(input.grantedScopes ?? [])), input.validatedAt ?? null,
        input.manifestFingerprint ?? null, control.rotationEpoch,
        input.envelope.version, input.envelope.algorithm, input.envelope.keyId,
        input.envelope.nonce, input.envelope.ciphertext, at, at,
      );
    } catch {
      throw identityError('credential_revision_conflict', 'Slack credential candidate changed concurrently.');
    }
    return this.requiredSlackCredentialRevision(input.identityId, input.revision);
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
    return this.db.transaction(() => this.promoteSlackCredentialRevisionInTransaction(input));
  }

  private promoteSlackCredentialRevisionInTransaction(
    input: PromoteSlackCredentialRevisionInput,
  ): SlackCredentialRevision {
    const installationId = input.installationId ?? DEFAULT_INSTALLATION_ID;
    const control = this.requiredSlackCredentialControl(installationId);
    requireCredentialEpoch(control, input.expectedRotationEpoch);
    const active = this.getActiveSlackCredentialRevision(input.identityId);
    if ((active?.revision ?? null) !== input.expectedActiveRevision) {
      throw identityError('credential_revision_conflict', 'Slack credential revision changed concurrently.');
    }
    const candidate = this.requiredSlackCredentialRevision(input.identityId, input.candidateRevision);
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
      `UPDATE identity_slack_credential_revisions SET status = 'active', updated_at = ?
       WHERE identity_id = ? AND revision = ? AND status = 'candidate'`,
      at, input.identityId, input.candidateRevision,
    ).changes;
    if (changed !== 1) {
      throw identityError('credential_revision_conflict', 'Slack credential promotion lost its compare-and-set.');
    }
    return this.requiredSlackCredentialRevision(input.identityId, input.candidateRevision);
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
      const expiredRecoverySessions = this.db.run(
        `UPDATE identity_slack_recovery_sessions SET status = 'expired',
          app_envelope_version = NULL, app_envelope_algorithm = NULL, app_key_id = NULL,
          app_nonce = NULL, app_ciphertext = NULL, oauth_state_hash = NULL,
          lease_expires_at = NULL, updated_at = ?
         WHERE status IN ('active', 'credentials_staged', 'oauth_pending', 'oauth_processing', 'waiting_events')
           AND expires_at <= ?`,
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
      const deletedBotOAuthAttempts = this.db.run(
        'DELETE FROM identity_slack_oauth_attempts WHERE expires_at <= ?',
        at,
      ).changes;
      const deletedSlackOidcAttempts = this.db.run(
        'DELETE FROM identity_slack_oidc_attempts WHERE expires_at <= ?',
        at,
      ).changes;
      const scrubbedCredentialCandidates = this.db.run(
        `UPDATE identity_slack_credential_revisions
         SET status = 'tombstoned', envelope_version = NULL, envelope_algorithm = NULL,
           key_id = NULL, nonce = NULL, ciphertext = NULL, tombstoned_at = ?, updated_at = ?
         WHERE status = 'candidate' AND created_at <= ?`,
        at, at, at - candidateMaxAgeMs,
      ).changes;
      const deletedOrphanedSlackEventsProofs = this.db.run(
        `DELETE FROM identity_slack_events_proofs
         WHERE NOT EXISTS (
           SELECT 1 FROM identity_slack_credential_revisions revisions
           WHERE revisions.identity_id = identity_slack_events_proofs.identity_id
             AND revisions.revision = identity_slack_events_proofs.candidate_revision
             AND revisions.status IN ('active', 'candidate')
         )`,
      ).changes;
      return {
        expiredAuthOperations,
        expiredRecoverySessions,
        expiredInvitations,
        expiredBrowserSessions,
        deletedSlackOAuthAttempts: deletedBotOAuthAttempts + deletedSlackOidcAttempts,
        deletedOrphanedSlackEventsProofs,
        scrubbedCredentialCandidates,
      };
    });
  }

  createSlackRecoverySession(input: CreateSlackRecoverySessionInput): SlackRecoverySession {
    const control = this.requiredSlackCredentialControl(DEFAULT_INSTALLATION_ID);
    const active = this.getActiveSlackCredentialRevision(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID);
    const now = this.now();
    if (control.deploymentId !== strictText(input.deploymentId, 'deployment ID', 256) ||
        !active || active.purpose !== 'connected_credentials' ||
        active.revision !== nonEmpty(input.baseRevision, 'Slack base revision') ||
        active.appId !== slackId(input.expectedAppId, 'Slack app ID') ||
        active.teamId !== slackId(input.expectedTeamId, 'Slack team ID') ||
        active.manifestFingerprint !== strictText(input.manifestFingerprint, 'manifest fingerprint', 256)) {
      throw identityError('auth_operation_conflict', 'Slack recovery authority does not match the active installation.');
    }
    const actions = [...new Set(input.allowedActions)].sort();
    if (JSON.stringify(actions) !== JSON.stringify(['credential_repair', 'url_repair'])) {
      throw identityError('identity_invalid', 'Slack recovery actions are invalid.');
    }
    if (!/^recovery_[A-Za-z0-9_-]{8,192}$/.test(input.id) ||
        !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) {
      throw identityError('identity_invalid', 'Slack recovery lifetime is invalid.');
    }
    const grantHash = credentialHash(input.grantHash);
    const sessionHash = credentialHash(input.sessionHash);
    const browserHash = credentialHash(input.browserHash);
    return this.db.transaction(() => {
      this.db.run(
        `UPDATE identity_slack_recovery_sessions SET status = 'expired',
          app_envelope_version = NULL, app_envelope_algorithm = NULL, app_key_id = NULL,
          app_nonce = NULL, app_ciphertext = NULL, oauth_state_hash = NULL,
          lease_expires_at = NULL, updated_at = ?
         WHERE status IN ('active', 'credentials_staged', 'oauth_pending', 'oauth_processing', 'waiting_events')
           AND expires_at <= ?`,
        now, now,
      );
      if (this.db.get('SELECT 1 AS present FROM identity_slack_recovery_sessions WHERE grant_hash = ?', grantHash)) {
        throw identityError('auth_operation_conflict', 'Slack recovery grant was already used.');
      }
      if (this.db.get(
        `SELECT 1 AS present FROM identity_slack_recovery_sessions
         WHERE status IN ('active', 'credentials_staged', 'oauth_pending', 'oauth_processing', 'waiting_events')`,
      )) {
        throw identityError('auth_operation_conflict', 'A Slack recovery session is already active.');
      }
      this.db.run(
        `INSERT INTO identity_slack_recovery_sessions (
          recovery_id, deployment_id, grant_hash, session_hash, browser_hash,
          allowed_actions_json, status, expected_app_id, expected_team_id, base_revision,
          manifest_fingerprint, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
        input.id, control.deploymentId, grantHash, sessionHash, browserHash,
        JSON.stringify(actions), active.appId, active.teamId, active.revision,
        active.manifestFingerprint, input.expiresAt, now, now,
      );
      return this.requiredSlackRecoverySession(input.id);
    });
  }

  getSlackRecoverySession(recoveryId: string): SlackRecoverySession | undefined {
    const row = this.db.get(
      'SELECT * FROM identity_slack_recovery_sessions WHERE recovery_id = ?',
      nonEmpty(recoveryId, 'Slack recovery ID'),
    );
    return row ? slackRecoverySessionFromRow(row) : undefined;
  }

  stageSlackRecoveryAppCredentials(
    input: StageSlackRecoveryAppCredentialsInput,
  ): SlackRecoverySession {
    validateRecoveryEnvelope(input.appCredentialEnvelope);
    return this.db.transaction(() => {
      const session = this.requiredLiveSlackRecoverySession(
        input.recoveryId, input.sessionHash, input.browserHash,
      );
      if (session.status !== 'active') {
        throw identityError('auth_operation_conflict', 'Slack recovery credentials were already staged.');
      }
      const changed = this.db.run(
        `UPDATE identity_slack_recovery_sessions SET status = 'credentials_staged',
          app_credential_revision = ?, app_credential_client_id = ?,
          app_envelope_version = ?, app_envelope_algorithm = ?, app_key_id = ?,
          app_nonce = ?, app_ciphertext = ?, updated_at = ?
         WHERE recovery_id = ? AND status = 'active'`,
        nonEmpty(input.appCredentialRevision, 'Slack recovery credential revision'),
        strictText(input.appCredentialClientId, 'Slack client ID', 256),
        input.appCredentialEnvelope.version, input.appCredentialEnvelope.algorithm,
        input.appCredentialEnvelope.keyId, input.appCredentialEnvelope.nonce,
        input.appCredentialEnvelope.ciphertext, this.now(), session.id,
      ).changes;
      if (changed !== 1) throw identityError('auth_operation_conflict', 'Slack recovery changed concurrently.');
      return this.requiredSlackRecoverySession(session.id);
    });
  }

  startSlackRecoveryOAuth(input: StartSlackRecoveryOAuthInput): SlackRecoverySession {
    return this.db.transaction(() => {
      const session = this.requiredLiveSlackRecoverySession(
        input.recoveryId, input.sessionHash, input.browserHash,
      );
      if (session.status !== 'credentials_staged') {
        throw identityError('auth_operation_conflict', 'Slack recovery is not ready for OAuth.');
      }
      const changed = this.db.run(
        `UPDATE identity_slack_recovery_sessions SET status = 'oauth_pending',
          oauth_state_hash = ?, oauth_redirect_uri = ?, updated_at = ?
         WHERE recovery_id = ? AND status = 'credentials_staged'`,
        credentialHash(input.stateHash), validHttpsCallback(input.redirectUri), this.now(), session.id,
      ).changes;
      if (changed !== 1) throw identityError('auth_operation_conflict', 'Slack recovery changed concurrently.');
      return this.requiredSlackRecoverySession(session.id);
    });
  }

  updateSlackRecoveryManifest(input: UpdateSlackRecoveryManifestInput): SlackRecoverySession {
    return this.db.transaction(() => {
      const session = this.requiredLiveSlackRecoverySession(
        input.recoveryId, input.sessionHash, input.browserHash,
      );
      if (session.status !== 'active') {
        throw identityError('auth_operation_conflict', 'Slack recovery URL repair must precede credential staging.');
      }
      const changed = this.db.run(
        `UPDATE identity_slack_recovery_sessions SET manifest_fingerprint = ?,
          result_code = 'urls_repaired', updated_at = ?
         WHERE recovery_id = ? AND status = 'active'`,
        strictText(input.manifestFingerprint, 'manifest fingerprint', 256), this.now(), session.id,
      ).changes;
      if (changed !== 1) throw identityError('auth_operation_conflict', 'Slack recovery changed concurrently.');
      return this.requiredSlackRecoverySession(session.id);
    });
  }

  acquireSlackRecoveryOAuth(input: AcquireSlackRecoveryOAuthInput): SlackRecoverySession {
    const stateHash = credentialHash(input.stateHash);
    const row = this.db.get(
      'SELECT * FROM identity_slack_recovery_sessions WHERE oauth_state_hash = ?', stateHash,
    );
    if (!row) throw identityError('auth_operation_missing', 'Slack recovery state was not found.');
    const current = slackRecoverySessionFromRow(row);
    this.requireSlackRecoveryBindings(current, input.sessionHash, input.browserHash);
    if (current.oauthRedirectUri !== validHttpsCallback(input.redirectUri)) {
      throw identityError('auth_operation_conflict', 'Slack recovery callback changed.');
    }
    const now = this.now();
    if (current.expiresAt <= now) {
      this.expireSlackRecoverySession(current.id, now);
      throw identityError('auth_operation_expired', 'Slack recovery expired.');
    }
    if (current.status === 'oauth_processing' && current.leaseExpiresAt && current.leaseExpiresAt > now) {
      throw identityError('auth_operation_conflict', 'Slack recovery processing lease is active.');
    }
    if (current.status !== 'oauth_pending' && current.status !== 'oauth_processing') {
      throw identityError('auth_operation_conflict', 'Slack recovery state is terminal.');
    }
    const leaseExpiresAt = Math.min(input.leaseExpiresAt, current.expiresAt);
    if (!Number.isSafeInteger(leaseExpiresAt) || leaseExpiresAt <= now) {
      throw identityError('auth_operation_expired', 'Slack recovery expired.');
    }
    const changed = this.db.run(
      `UPDATE identity_slack_recovery_sessions SET status = 'oauth_processing',
        lease_generation = lease_generation + 1, lease_expires_at = ?, updated_at = ?
       WHERE recovery_id = ? AND oauth_state_hash = ? AND status = ? AND lease_generation = ?`,
      leaseExpiresAt, now, current.id, stateHash, current.status, current.leaseGeneration,
    ).changes;
    if (changed !== 1) throw identityError('auth_operation_conflict', 'Slack recovery changed concurrently.');
    return this.requiredSlackRecoverySession(current.id);
  }

  recordSlackRecoveryCandidate(input: RecordSlackRecoveryCandidateInput): SlackRecoverySession {
    return this.db.transaction(() => {
      const session = this.requiredSlackRecoverySession(input.recoveryId);
      if (session.status !== 'oauth_processing' ||
          session.leaseGeneration !== input.expectedLeaseGeneration) {
        throw identityError('auth_operation_conflict', 'Slack recovery callback lease changed.');
      }
      const candidate = this.requiredSlackCredentialRevision(
        WORKSPACE_DEFAULT_SLACK_IDENTITY_ID, input.candidateRevision,
      );
      if (candidate.manifestFingerprint !== session.manifestFingerprint) {
        if (session.resultCode !== 'urls_repaired') {
          throw identityError('credential_revision_conflict', 'Slack recovery manifest changed without URL repair proof.');
        }
        this.db.run(
          `UPDATE identity_slack_credential_revisions SET manifest_fingerprint = ?, updated_at = ?
           WHERE identity_id = ? AND revision = ? AND status = 'candidate'`,
          session.manifestFingerprint, this.now(), candidate.identityId, candidate.revision,
        );
      }
      const auth = this.getAuthControl();
      const lostRootCandidate = auth?.healthGate === 'recovery_only' &&
        candidate.baseRevision === null &&
        !this.getActiveSlackCredentialRevision(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID);
      if (candidate.status !== 'candidate' || candidate.purpose !== 'connected_credentials' ||
          candidate.appId !== session.expectedAppId || candidate.teamId !== session.expectedTeamId ||
          (candidate.baseRevision !== session.baseRevision && !lostRootCandidate)) {
        throw identityError('credential_revision_conflict', 'Slack recovery candidate does not match its authority.');
      }
      const changed = this.db.run(
        `UPDATE identity_slack_recovery_sessions SET status = 'waiting_events',
          connected_candidate_revision = ?, oauth_state_hash = NULL, lease_expires_at = NULL,
          result_code = 'waiting_events', updated_at = ?
         WHERE recovery_id = ? AND status = 'oauth_processing' AND lease_generation = ?`,
        candidate.revision, this.now(), session.id, session.leaseGeneration,
      ).changes;
      if (changed !== 1) throw identityError('auth_operation_conflict', 'Slack recovery changed concurrently.');
      return this.requiredSlackRecoverySession(session.id);
    });
  }

  promoteSlackRecoveryCandidate(input: PromoteSlackRecoveryCandidateInput): SlackRecoverySession {
    return this.db.transaction(() => {
      const session = this.requiredLiveSlackRecoverySession(
        input.recoveryId, input.sessionHash, input.browserHash,
      );
      if (session.status !== 'waiting_events' ||
          session.connectedCandidateRevision !== input.candidateRevision) {
        throw identityError('auth_operation_conflict', 'Slack recovery is not waiting for this candidate.');
      }
      const candidate = this.requiredSlackCredentialRevision(
        WORKSPACE_DEFAULT_SLACK_IDENTITY_ID, input.candidateRevision,
      );
      if (candidate.baseRevision !== input.expectedActiveRevision ||
          candidate.appId !== session.expectedAppId || candidate.teamId !== session.expectedTeamId) {
        throw identityError('credential_revision_conflict', 'Slack recovery promotion changed its identity boundary.');
      }
      this.promoteSlackCredentialRevisionInTransaction({
        identityId: WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
        candidateRevision: input.candidateRevision,
        expectedActiveRevision: input.expectedActiveRevision,
        expectedRotationEpoch: input.expectedRotationEpoch,
      });
      const at = this.now();
      const changed = this.db.run(
        `UPDATE identity_slack_recovery_sessions SET status = 'consumed', consumed_at = ?,
          app_credential_revision = NULL, app_credential_client_id = NULL,
          app_envelope_version = NULL, app_envelope_algorithm = NULL, app_key_id = NULL,
          app_nonce = NULL, app_ciphertext = NULL, oauth_state_hash = NULL,
          lease_expires_at = NULL, result_code = 'repaired', updated_at = ?
         WHERE recovery_id = ? AND status = 'waiting_events'`,
        at, at, session.id,
      ).changes;
      if (changed !== 1) throw identityError('auth_operation_conflict', 'Slack recovery changed concurrently.');
      const auth = this.getAuthControl();
      if (auth?.healthGate === 'recovery_only') {
        this.db.run(
          `UPDATE identity_auth_controls SET health_gate = 'normal', revision = revision + 1, updated_at = ?
           WHERE installation_id = ? AND revision = ? AND health_gate = 'recovery_only'`,
          at, auth.installationId, auth.revision,
        );
      }
      return this.requiredSlackRecoverySession(session.id);
    });
  }

  reserveSlackSetupTransaction(
    input: ReserveSlackSetupTransactionInput,
  ): SlackSetupTransaction {
    return this.db.transaction(() => this.reserveSlackSetupTransactionInTransaction(input));
  }

  private reserveSlackSetupTransactionInTransaction(
    input: ReserveSlackSetupTransactionInput,
  ): SlackSetupTransaction {
    const locatorHash = credentialHash(input.locatorHash);
    const canonicalAdminOrigin = validOrigin(input.canonicalAdminOrigin);
    validateSetupTime(input.issuedAt, 'Slack setup issue time');
    validateSetupTime(input.expiresAt, 'Slack setup expiry');
    if (input.expiresAt <= input.issuedAt) {
      throw identityError('identity_invalid', 'Slack setup expiry is invalid.');
    }
    const destination = safeStoredAdminDestination(input.destination);
    const control = this.ensureAuthControl();
    if (control.canonicalAdminOrigin && control.canonicalAdminOrigin !== canonicalAdminOrigin) {
      throw identityError('auth_control_conflict', 'Slack setup is bound to another Admin origin.');
    }
    if (!control.canonicalAdminOrigin) {
      this.updateAuthControl({
        expectedRevision: control.revision,
        canonicalAdminOrigin,
      });
    }
    const existing = this.getSlackSetupTransaction('setup_default');
    if (!existing) {
      const at = this.now();
      this.db.run(
        `INSERT INTO identity_slack_setup_transactions (
          setup_id, locator_hash, state, revision, destination, manifest_fingerprint,
          app_id, credential_revision, last_error_code, expires_at, consumed_at,
          created_at, updated_at
        ) VALUES ('setup_default', ?, 'awaiting_app_creation', 1, ?, NULL, NULL, NULL, NULL, ?, NULL, ?, ?)`,
        locatorHash, destination, input.expiresAt, at, at,
      );
      return this.requiredSlackSetupTransaction('setup_default');
    }
    if (existing.state === 'consumed') {
      throw identityError('auth_operation_conflict', 'Slack setup authority is already consumed.');
    }
    if (existing.locatorHash === locatorHash) return existing;
    const nextState = existing.state === 'app_creation_pending'
      ? 'ambiguous_external_effect'
      : existing.state === 'expired'
      ? existing.appId ? 'app_created' : 'awaiting_app_creation'
      : existing.state === 'install_failed'
      ? 'app_created'
      : existing.state;
    const resetFailedInstall = existing.state === 'install_failed';
    const changed = this.db.run(
      `UPDATE identity_slack_setup_transactions
       SET locator_hash = ?, state = ?, revision = revision + 1,
         bot_credential_revision = CASE WHEN ? THEN NULL ELSE bot_credential_revision END,
         slack_team_id = CASE WHEN ? THEN NULL ELSE slack_team_id END,
         installer_slack_user_id = CASE WHEN ? THEN NULL ELSE installer_slack_user_id END,
         bot_user_id = CASE WHEN ? THEN NULL ELSE bot_user_id END,
         last_error_code = CASE WHEN ? THEN NULL ELSE last_error_code END,
         expires_at = ?, updated_at = ?
       WHERE setup_id = 'setup_default' AND revision = ?`,
      locatorHash, nextState,
      resetFailedInstall ? 1 : 0, resetFailedInstall ? 1 : 0,
      resetFailedInstall ? 1 : 0, resetFailedInstall ? 1 : 0,
      resetFailedInstall ? 1 : 0, input.expiresAt, this.now(), existing.revision,
    ).changes;
    if (changed !== 1) {
      throw identityError('auth_operation_conflict', 'Slack setup changed concurrently.');
    }
    return this.requiredSlackSetupTransaction('setup_default');
  }

  getSlackSetupTransaction(setupId: string): SlackSetupTransaction | undefined {
    const row = this.db.get(
      'SELECT * FROM identity_slack_setup_transactions WHERE setup_id = ?',
      nonEmpty(setupId, 'Slack setup ID'),
    );
    return row ? slackSetupTransactionFromRow(row) : undefined;
  }

  findSlackSetupTransaction(locatorHash: string): SlackSetupTransaction | undefined {
    const row = this.db.get(
      'SELECT * FROM identity_slack_setup_transactions WHERE locator_hash = ?',
      credentialHash(locatorHash),
    );
    return row ? slackSetupTransactionFromRow(row) : undefined;
  }

  beginSlackAppCreation(input: BeginSlackAppCreationInput): SlackSetupTransaction {
    return this.transitionSlackSetup(
      input,
      ['awaiting_app_creation'],
      'app_creation_pending',
      { manifestFingerprint: strictText(input.manifestFingerprint, 'manifest fingerprint', 256) },
    );
  }

  failSlackAppCreation(input: FailSlackAppCreationInput): SlackSetupTransaction {
    if (!['awaiting_app_creation', 'ambiguous_external_effect'].includes(input.state)) {
      throw identityError('identity_invalid', 'Slack app creation failure state is invalid.');
    }
    return this.transitionSlackSetup(
      input,
      ['app_creation_pending'],
      input.state,
      { lastErrorCode: strictText(input.errorCode, 'Slack setup error code', 128) },
    );
  }

  recordSlackAppCreationSuccess(
    input: RecordSlackAppCreationSuccessInput,
  ): SlackSetupTransaction {
    validateCredentialRevisionInput(input.credential);
    const appId = slackId(input.appId, 'Slack app ID');
    const fingerprint = strictText(input.manifestFingerprint, 'manifest fingerprint', 256);
    if (input.credential.appId !== appId || input.credential.purpose !== 'app_credentials' ||
        input.credential.identityClass !== 'workspace_default' ||
        input.credential.manifestFingerprint !== fingerprint) {
      throw identityError('identity_invalid', 'Slack app credentials do not match setup metadata.');
    }
    return this.db.transaction(() => {
      const setup = this.requiredSlackSetupTransition(
        input.setupId,
        input.expectedRevision,
        ['app_creation_pending', 'awaiting_app_creation', 'ambiguous_external_effect'],
      );
      const candidate = this.stageSlackCredentialRevisionInTransaction(input.credential);
      const promoted = this.promoteSlackCredentialRevisionInTransaction({
        identityId: candidate.identityId,
        candidateRevision: candidate.revision,
        expectedActiveRevision: input.credential.expectedActiveRevision,
        expectedRotationEpoch: input.credential.expectedRotationEpoch,
      });
      const changed = this.db.run(
        `UPDATE identity_slack_setup_transactions SET
          state = 'app_created', revision = revision + 1, manifest_fingerprint = ?,
          app_id = ?, credential_revision = ?, last_error_code = NULL, updated_at = ?
         WHERE setup_id = ? AND revision = ? AND state = ?`,
        fingerprint, appId, promoted.revision, this.now(), setup.id, setup.revision, setup.state,
      ).changes;
      if (changed !== 1) {
        throw identityError('auth_operation_conflict', 'Slack setup changed concurrently.');
      }
      return this.requiredSlackSetupTransaction(setup.id);
    });
  }

  restartSlackAppCreation(input: SlackSetupTransitionInput): SlackSetupTransaction {
    return this.transitionSlackSetup(
      input,
      ['ambiguous_external_effect'],
      'awaiting_app_creation',
      { lastErrorCode: null },
    );
  }

  markSlackSetupApprovalPending(
    input: MarkSlackSetupApprovalPendingInput,
  ): SlackSetupTransaction {
    const setup = this.requiredSlackSetupTransition(
      input.setupId,
      input.expectedRevision,
      ['app_created'],
    );
    if (setup.appId !== slackId(input.appId, 'Slack app ID')) {
      throw identityError('auth_operation_conflict', 'Slack setup app identity changed.');
    }
    return this.transitionSlackSetup(input, ['app_created'], 'approval_pending');
  }

  resumeSlackSetupAfterApproval(input: SlackSetupTransitionInput): SlackSetupTransaction {
    return this.transitionSlackSetup(
      input,
      ['approval_pending'],
      'app_created',
      { lastErrorCode: null },
    );
  }

  createSlackOAuthAttempt(input: CreateSlackOAuthAttemptInput): SlackOAuthAttempt {
    validateSlackOAuthAttemptInput(input);
    return this.db.transaction(() => {
      const setup = this.requiredSlackSetupTransition(
        input.setupId,
        input.setupRevision,
        ['app_created'],
      );
      const active = this.getActiveSlackCredentialRevision(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID);
      if (!active || active.revision !== input.credentialRevision ||
          active.revision !== input.baseRevision || active.purpose !== 'app_credentials' ||
          active.appId !== input.appId || setup.appId !== input.appId ||
          setup.credentialRevision !== input.credentialRevision) {
        throw identityError('credential_revision_conflict', 'Slack app credentials changed before OAuth start.');
      }
      const at = this.now();
      if (input.expiresAt <= at) {
        throw identityError('auth_operation_expired', 'Slack OAuth attempt expiry is invalid.');
      }
      this.db.run(
        `UPDATE identity_slack_oauth_attempts
         SET status = 'failed', result_code = 'superseded', lease_expires_at = NULL, updated_at = ?
         WHERE setup_id = ? AND status IN ('pending', 'processing')`,
        at, setup.id,
      );
      try {
        this.db.run(
          `INSERT INTO identity_slack_oauth_attempts (
            attempt_id, kind, purpose, setup_id, setup_revision, state_hash, browser_hash,
            app_id, client_id, credential_revision, base_revision, redirect_uri, destination,
            expected_team_id, expected_installer_slack_user_id, status, lease_generation,
            lease_expires_at, result_code, expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?, ?)`,
          nonEmpty(input.id, 'Slack OAuth attempt ID'), input.kind, input.purpose,
          setup.id, setup.revision, oauthHash(input.stateHash, 'Slack OAuth state hash'),
          oauthHash(input.browserHash, 'Slack OAuth browser hash'), input.appId,
          strictText(input.clientId, 'Slack client ID', 256), input.credentialRevision,
          input.baseRevision, validHttpsCallback(input.redirectUri), safeStoredAdminDestination(input.destination),
          input.expectedTeamId ?? null, input.expectedInstallerSlackUserId ?? null,
          input.expiresAt, at, at,
        );
      } catch {
        throw identityError('auth_operation_conflict', 'Slack OAuth attempt changed concurrently.');
      }
      return this.requiredSlackOAuthAttempt(input.id);
    });
  }

  getSlackOAuthAttempt(attemptId: string): SlackOAuthAttempt | undefined {
    const row = this.db.get(
      'SELECT * FROM identity_slack_oauth_attempts WHERE attempt_id = ?',
      nonEmpty(attemptId, 'Slack OAuth attempt ID'),
    );
    return row ? slackOAuthAttemptFromRow(row) : undefined;
  }

  acquireSlackOAuthAttempt(input: AcquireSlackOAuthAttemptInput): SlackOAuthAttempt {
    const stateHash = oauthHash(input.stateHash, 'Slack OAuth state hash');
    const browserHash = oauthHash(input.browserHash, 'Slack OAuth browser hash');
    if (input.kind !== 'slack_bot_install' || input.purpose !== 'setup_bot_install') {
      throw identityError('identity_invalid', 'Slack OAuth callback purpose is invalid.');
    }
    const redirectUri = validHttpsCallback(input.redirectUri);
    const acquired = this.db.transaction((): SlackOAuthAttempt | undefined => {
      const row = this.db.get(
        'SELECT * FROM identity_slack_oauth_attempts WHERE state_hash = ?',
        stateHash,
      );
      if (!row) throw identityError('auth_operation_missing', 'Slack OAuth state is invalid.');
      const attempt = slackOAuthAttemptFromRow(row);
      const at = this.now();
      if (attempt.browserHash !== browserHash) {
        throw identityError('auth_operation_conflict', 'Slack OAuth browser binding does not match.');
      }
      if (attempt.kind !== input.kind || attempt.purpose !== input.purpose ||
          attempt.redirectUri !== redirectUri) {
        throw identityError('auth_operation_conflict', 'Slack OAuth callback binding does not match.');
      }
      if (attempt.expiresAt <= at) {
        this.db.run(
          `UPDATE identity_slack_oauth_attempts SET status = 'expired', result_code = 'expired',
           lease_expires_at = NULL, updated_at = ? WHERE attempt_id = ?`,
          at, attempt.id,
        );
        return undefined;
      }
      const reclaim = attempt.status === 'processing' &&
        attempt.leaseExpiresAt !== null && attempt.leaseExpiresAt <= at;
      if (attempt.status !== 'pending' && !reclaim) {
        throw identityError(
          'auth_operation_conflict',
          attempt.status === 'processing'
            ? 'Slack OAuth processing lease is already held.'
            : 'Slack OAuth state is already consumed.',
        );
      }
      if (!Number.isSafeInteger(input.leaseExpiresAt) || input.leaseExpiresAt <= at) {
        throw identityError('identity_invalid', 'Slack OAuth processing lease is invalid.');
      }
      const leaseExpiresAt = Math.min(input.leaseExpiresAt, attempt.expiresAt);
      const changed = this.db.run(
        `UPDATE identity_slack_oauth_attempts SET status = 'processing',
          lease_generation = lease_generation + 1, lease_expires_at = ?, updated_at = ?
         WHERE attempt_id = ? AND status = ? AND lease_generation = ?`,
        leaseExpiresAt, at, attempt.id, attempt.status, attempt.leaseGeneration,
      ).changes;
      if (changed !== 1) {
        throw identityError('auth_operation_conflict', 'Slack OAuth processing lease changed concurrently.');
      }
      return this.requiredSlackOAuthAttempt(attempt.id);
    });
    if (!acquired) throw identityError('auth_operation_expired', 'Slack OAuth state expired.');
    return acquired;
  }

  settleSlackOAuthAttempt(input: SettleSlackOAuthAttemptInput): SlackOAuthAttempt {
    if (!['denied', 'failed'].includes(input.status)) {
      throw identityError('identity_invalid', 'Slack OAuth terminal state is invalid.');
    }
    const resultCode = strictText(input.resultCode, 'Slack OAuth result code', 128);
    const current = this.requiredSlackOAuthLease(input.attemptId, input.expectedLeaseGeneration);
    const changed = this.db.run(
      `UPDATE identity_slack_oauth_attempts SET status = ?, result_code = ?,
       lease_expires_at = NULL, updated_at = ?
       WHERE attempt_id = ? AND status = 'processing' AND lease_generation = ?`,
      input.status, resultCode, this.now(), current.id, current.leaseGeneration,
    ).changes;
    if (changed !== 1) throw identityError('auth_operation_conflict', 'Slack OAuth state changed concurrently.');
    return this.requiredSlackOAuthAttempt(current.id);
  }

  markSlackOAuthApprovalPending(
    input: MarkSlackOAuthApprovalPendingInput,
  ): SlackSetupTransaction {
    return this.db.transaction(() => {
      const attempt = this.requiredSlackOAuthLease(input.attemptId, input.expectedLeaseGeneration);
      const setup = this.requiredSlackSetupTransition(
        attempt.setupId,
        attempt.setupRevision,
        ['app_created'],
      );
      if (setup.appId !== attempt.appId || setup.credentialRevision !== attempt.credentialRevision) {
        throw identityError('auth_operation_conflict', 'Slack setup changed before approval.');
      }
      const at = this.now();
      const attemptChanged = this.db.run(
        `UPDATE identity_slack_oauth_attempts SET status = 'approval_pending',
          result_code = 'approval_pending', lease_expires_at = NULL, updated_at = ?
         WHERE attempt_id = ? AND status = 'processing' AND lease_generation = ?`,
        at, attempt.id, attempt.leaseGeneration,
      ).changes;
      if (attemptChanged !== 1) {
        throw identityError('auth_operation_conflict', 'Slack OAuth state changed concurrently.');
      }
      const changed = this.db.run(
        `UPDATE identity_slack_setup_transactions SET state = 'approval_pending',
          revision = revision + 1, last_error_code = 'approval_pending', updated_at = ?
         WHERE setup_id = ? AND revision = ? AND state = 'app_created'`,
        at, setup.id, setup.revision,
      ).changes;
      if (changed !== 1) throw identityError('auth_operation_conflict', 'Slack setup changed concurrently.');
      return this.requiredSlackSetupTransaction(setup.id);
    });
  }

  recordSlackBotInstallationCandidate(
    input: RecordSlackBotInstallationCandidateInput,
  ): SlackSetupTransaction {
    validateCredentialRevisionInput(input.credential);
    return this.db.transaction(() => {
      const attempt = this.requiredSlackOAuthLease(input.attemptId, input.expectedLeaseGeneration);
      const setup = this.requiredSlackSetupTransition(
        attempt.setupId,
        attempt.setupRevision,
        ['app_created'],
      );
      const teamId = slackId(input.teamId, 'Slack team ID');
      const installerId = slackId(input.installerSlackUserId, 'Slack installer user ID');
      const botUserId = slackId(input.botUserId, 'Slack bot user ID');
      if (attempt.expectedTeamId && attempt.expectedTeamId !== teamId) {
        throw identityError('auth_operation_conflict', 'Slack OAuth workspace does not match.');
      }
      if (attempt.expectedInstallerSlackUserId && attempt.expectedInstallerSlackUserId !== installerId) {
        throw identityError('auth_operation_conflict', 'Slack OAuth installer does not match the requester.');
      }
      if (setup.appId !== attempt.appId || setup.credentialRevision !== attempt.credentialRevision ||
          input.credential.identityId !== WORKSPACE_DEFAULT_SLACK_IDENTITY_ID ||
          input.credential.identityClass !== 'workspace_default' ||
          input.credential.purpose !== 'connected_credentials' ||
          input.credential.expectedActiveRevision !== attempt.baseRevision ||
          input.credential.appId !== attempt.appId || input.credential.teamId !== teamId ||
          input.credential.botUserId !== botUserId) {
        throw identityError('auth_operation_conflict', 'Slack bot grant does not match its OAuth attempt.');
      }
      const candidate = this.stageSlackCredentialRevisionInTransaction(input.credential);
      const at = this.now();
      const changed = this.db.run(
        `UPDATE identity_slack_setup_transactions SET state = 'bot_install_pending',
          revision = revision + 1, bot_credential_revision = ?, slack_team_id = ?,
          installer_slack_user_id = ?, bot_user_id = ?, last_error_code = NULL, updated_at = ?
         WHERE setup_id = ? AND revision = ? AND state = 'app_created'`,
        candidate.revision, teamId, installerId, botUserId, at, setup.id, setup.revision,
      ).changes;
      if (changed !== 1) throw identityError('auth_operation_conflict', 'Slack setup changed concurrently.');
      const attemptChanged = this.db.run(
        `UPDATE identity_slack_oauth_attempts SET status = 'validated', result_code = 'waiting_events',
          lease_expires_at = NULL, updated_at = ?
         WHERE attempt_id = ? AND status = 'processing' AND lease_generation = ?`,
        at, attempt.id, attempt.leaseGeneration,
      ).changes;
      if (attemptChanged !== 1) {
        throw identityError('auth_operation_conflict', 'Slack OAuth state changed concurrently.');
      }
      return this.requiredSlackSetupTransaction(setup.id);
    });
  }

  getSlackEventsProof(candidateRevision: string): SlackEventsProof | undefined {
    const row = this.db.get(
      'SELECT * FROM identity_slack_events_proofs WHERE candidate_revision = ?',
      nonEmpty(candidateRevision, 'Slack credential revision'),
    );
    return row ? slackEventsProofFromRow(row) : undefined;
  }

  recordSlackEventsProof(input: RecordSlackEventsProofInput): SlackEventsProof {
    return this.db.transaction(() => {
      const setup = this.requiredSlackSetupTransaction(input.setupId);
      const candidate = this.requiredSlackCredentialRevision(input.identityId, input.candidateRevision);
      const active = this.getActiveSlackCredentialRevision(input.identityId);
      if (setup.state !== 'bot_install_pending' ||
          setup.botCredentialRevision !== input.candidateRevision ||
          setup.appId !== input.appId || setup.slackTeamId !== input.teamId ||
          candidate.status !== 'candidate' || candidate.baseRevision !== input.baseRevision ||
          candidate.appId !== input.appId || candidate.teamId !== input.teamId ||
          active?.revision !== input.baseRevision) {
        throw identityError('credential_revision_conflict', 'Slack Events proof does not match the pending credential revision.');
      }
      if (!Number.isSafeInteger(input.verifiedAt) || input.verifiedAt < 0) {
        throw identityError('identity_invalid', 'Slack Events verification time is invalid.');
      }
      const existing = this.getSlackEventsProof(input.candidateRevision);
      if (existing) {
        if (existing.identityId === input.identityId && existing.appId === input.appId &&
            existing.teamId === input.teamId && existing.baseRevision === input.baseRevision) {
          return existing;
        }
        throw identityError('credential_revision_conflict', 'Slack Events proof conflicts with existing state.');
      }
      this.db.run(
        `INSERT INTO identity_slack_events_proofs (
          candidate_revision, identity_id, app_id, team_id, base_revision, verified_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        input.candidateRevision, input.identityId, input.appId, input.teamId,
        input.baseRevision, input.verifiedAt,
      );
      return this.getSlackEventsProof(input.candidateRevision)!;
    });
  }

  promoteSlackBotInstallation(input: PromoteSlackBotInstallationInput): SlackSetupTransaction {
    return this.db.transaction(() => {
      const setup = this.requiredSlackSetupTransaction(input.setupId);
      const proof = this.getSlackEventsProof(input.candidateRevision);
      if (setup.state !== 'bot_install_pending' ||
          setup.botCredentialRevision !== input.candidateRevision || !proof ||
          proof.identityId !== input.identityId || proof.appId !== input.appId ||
          proof.teamId !== input.teamId || proof.baseRevision !== input.baseRevision ||
          proof.verifiedAt !== input.verifiedAt) {
        throw identityError('credential_revision_conflict', 'Slack installation proof changed concurrently.');
      }
      this.promoteSlackCredentialRevisionInTransaction({
        identityId: input.identityId,
        candidateRevision: input.candidateRevision,
        expectedActiveRevision: input.baseRevision,
        expectedRotationEpoch: input.expectedRotationEpoch,
      });
      const at = this.now();
      const changed = this.db.run(
        `UPDATE identity_slack_setup_transactions SET state = 'bot_installed',
          revision = revision + 1, last_error_code = NULL, updated_at = ?
         WHERE setup_id = ? AND revision = ? AND state = 'bot_install_pending'
           AND bot_credential_revision = ?`,
        at, setup.id, setup.revision, input.candidateRevision,
      ).changes;
      if (changed !== 1) throw identityError('auth_operation_conflict', 'Slack setup changed concurrently.');
      this.db.run(
        `UPDATE identity_slack_oauth_attempts SET status = 'succeeded', result_code = 'bot_installed',
          updated_at = ? WHERE setup_id = ? AND status = 'validated'`,
        at, setup.id,
      );
      return this.requiredSlackSetupTransaction(setup.id);
    });
  }

  failSlackBotInstallation(input: FailSlackBotInstallationInput): SlackSetupTransaction {
    const resultCode = strictText(input.errorCode, 'Slack installation error code', 128);
    return this.db.transaction(() => {
      const setup = this.requiredSlackSetupTransaction(input.setupId);
      const control = this.requiredSlackCredentialControl(DEFAULT_INSTALLATION_ID);
      requireCredentialEpoch(control, input.expectedRotationEpoch);
      if (setup.state !== 'bot_install_pending' || setup.botCredentialRevision !== input.candidateRevision) {
        throw identityError('auth_operation_conflict', 'Slack installation is not waiting for verification.');
      }
      const candidate = this.requiredSlackCredentialRevision(
        WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
        input.candidateRevision,
      );
      if (candidate.status === 'candidate') {
        const at = this.now();
        const tombstoned = this.db.run(
          `UPDATE identity_slack_credential_revisions SET status = 'tombstoned',
            envelope_version = NULL, envelope_algorithm = NULL, key_id = NULL,
            nonce = NULL, ciphertext = NULL, tombstoned_at = ?, updated_at = ?
           WHERE identity_id = ? AND revision = ? AND status = 'candidate'`,
          at, at, candidate.identityId, candidate.revision,
        ).changes;
        if (tombstoned !== 1) {
          throw identityError('credential_revision_conflict', 'Slack credential changed concurrently.');
        }
      }
      const at = this.now();
      const setupChanged = this.db.run(
        `UPDATE identity_slack_setup_transactions SET state = 'install_failed',
          revision = revision + 1, last_error_code = ?, updated_at = ?
         WHERE setup_id = ? AND revision = ? AND state = 'bot_install_pending'
           AND bot_credential_revision = ?`,
        resultCode, at, setup.id, setup.revision, input.candidateRevision,
      ).changes;
      if (setupChanged !== 1) {
        throw identityError('auth_operation_conflict', 'Slack setup changed concurrently.');
      }
      this.db.run(
        `UPDATE identity_slack_oauth_attempts SET status = 'failed', result_code = ?, updated_at = ?
         WHERE setup_id = ? AND status = 'validated'`,
        resultCode, at, setup.id,
      );
      return this.requiredSlackSetupTransaction(setup.id);
    });
  }

  private transitionSlackSetup(
    input: SlackSetupTransitionInput,
    expectedStates: SlackSetupTransaction['state'][],
    nextState: SlackSetupTransaction['state'],
    changes: { manifestFingerprint?: string; lastErrorCode?: string | null } = {},
  ): SlackSetupTransaction {
    const current = this.requiredSlackSetupTransition(
      input.setupId,
      input.expectedRevision,
      expectedStates,
    );
    const changed = this.db.run(
      `UPDATE identity_slack_setup_transactions SET state = ?, revision = revision + 1,
        manifest_fingerprint = ?, last_error_code = ?, updated_at = ?
       WHERE setup_id = ? AND revision = ? AND state = ?`,
      nextState,
      changes.manifestFingerprint ?? current.manifestFingerprint,
      changes.lastErrorCode === undefined ? current.lastErrorCode : changes.lastErrorCode,
      this.now(), current.id, current.revision, current.state,
    ).changes;
    if (changed !== 1) {
      throw identityError('auth_operation_conflict', 'Slack setup changed concurrently.');
    }
    return this.requiredSlackSetupTransaction(current.id);
  }

  private requiredSlackSetupTransition(
    setupId: string,
    expectedRevision: number,
    expectedStates: SlackSetupTransaction['state'][],
  ): SlackSetupTransaction {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw identityError('identity_invalid', 'Slack setup revision is invalid.');
    }
    const current = this.requiredSlackSetupTransaction(setupId);
    if (current.expiresAt <= this.now() && current.state !== 'consumed') {
      this.db.run(
        `UPDATE identity_slack_setup_transactions
         SET state = 'expired', revision = revision + 1, updated_at = ?
         WHERE setup_id = ? AND revision = ?`,
        this.now(), current.id, current.revision,
      );
      throw identityError('auth_operation_expired', 'Slack setup expired.');
    }
    if (current.revision !== expectedRevision || !expectedStates.includes(current.state)) {
      throw identityError('auth_operation_conflict', 'Slack setup changed concurrently.');
    }
    return current;
  }

  private requiredSlackSetupTransaction(setupId: string): SlackSetupTransaction {
    const transaction = this.getSlackSetupTransaction(setupId);
    if (!transaction) throw identityError('auth_operation_missing', 'Slack setup was not found.');
    return transaction;
  }

  private requiredSlackOAuthAttempt(attemptId: string): SlackOAuthAttempt {
    const attempt = this.getSlackOAuthAttempt(attemptId);
    if (!attempt) throw identityError('auth_operation_missing', 'Slack OAuth attempt was not found.');
    return attempt;
  }

  private requiredSlackOAuthLease(attemptId: string, leaseGeneration: number): SlackOAuthAttempt {
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) {
      throw identityError('identity_invalid', 'Slack OAuth processing lease is invalid.');
    }
    const attempt = this.requiredSlackOAuthAttempt(attemptId);
    if (attempt.status !== 'processing' || attempt.leaseGeneration !== leaseGeneration ||
        attempt.leaseExpiresAt === null || attempt.leaseExpiresAt <= this.now()) {
      throw identityError('auth_operation_conflict', 'Slack OAuth processing lease is unavailable.');
    }
    return attempt;
  }

  private requiredSlackOidcAttempt(attemptId: string): SlackOidcAttempt {
    const attempt = this.getSlackOidcAttempt(attemptId);
    if (!attempt) throw identityError('auth_operation_missing', 'Slack OIDC attempt was not found.');
    return attempt;
  }

  private requiredSlackOidcLease(attemptId: string, leaseGeneration: number): SlackOidcAttempt {
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) {
      throw identityError('identity_invalid', 'Slack OIDC processing lease is invalid.');
    }
    const attempt = this.requiredSlackOidcAttempt(attemptId);
    if (attempt.status !== 'processing' || attempt.leaseGeneration !== leaseGeneration ||
        attempt.leaseExpiresAt === null || attempt.leaseExpiresAt <= this.now()) {
      throw identityError('auth_operation_conflict', 'Slack OIDC processing lease is unavailable.');
    }
    return attempt;
  }

  createSlackOidcAttempt(input: CreateSlackOidcAttemptInput): SlackOidcAttempt {
    if (!['first_owner', 'invitation', 'login'].includes(input.purpose)) {
      throw identityError('identity_invalid', 'Slack OIDC purpose is invalid.');
    }
    const at = this.now();
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= at) {
      throw identityError('identity_invalid', 'Slack OIDC expiry is invalid.');
    }
    const teamId = slackId(input.expectedTeamId, 'Slack team ID');
    const expectedUserId = input.expectedSlackUserId
      ? slackId(input.expectedSlackUserId, 'Slack user ID')
      : null;
    if (input.purpose !== 'login' && !expectedUserId) {
      throw identityError('identity_invalid', 'Slack OIDC admission requires an exact user.');
    }
    if (input.purpose === 'first_owner' &&
        (!input.setupId || !input.setupRevision || !input.operationId || input.invitationId)) {
      throw identityError('identity_invalid', 'First-Owner OIDC must bind setup and operation authority.');
    }
    if (input.purpose === 'invitation') {
      if (!input.invitationId || !input.invitationLocatorHash || !input.operationId ||
          input.setupId || input.setupRevision) {
        throw identityError('identity_invalid', 'Invitation OIDC must bind exact invitation authority.');
      }
      this.expirePendingInvitations(at);
      const invitation = this.requiredInvitation(input.invitationId);
      if (invitation.status !== 'pending' || invitation.expiresAt <= at ||
          invitation.locatorHash !== credentialHash(input.invitationLocatorHash) ||
          invitation.slackTeamId !== teamId || invitation.slackUserId !== expectedUserId ||
          input.expiresAt > invitation.expiresAt) {
        throw identityError('invitation_token_invalid', 'Invitation is unavailable.');
      }
    }
    if (input.purpose === 'login' &&
        (input.setupId || input.setupRevision || input.operationId || input.invitationId)) {
      throw identityError('identity_invalid', 'Normal Slack login cannot select an authority before proof.');
    }
    try {
      this.db.run(
        `INSERT INTO identity_slack_oidc_attempts (
          attempt_id, purpose, operation_id, invitation_id, setup_id, setup_revision,
          state_hash, nonce_hash, browser_hash, app_id, client_id, credential_revision,
          redirect_uri, destination, expected_team_id, expected_slack_user_id,
          admitted_team_id, admitted_slack_user_id, status, lease_generation,
          lease_expires_at, result_code, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL,
          'pending', 0, NULL, NULL, ?, ?, ?)`,
        nonEmpty(input.id, 'Slack OIDC attempt ID'), input.purpose, input.operationId ?? null,
        input.invitationId ?? null,
        input.setupId ?? null, input.setupRevision ?? null,
        oauthHash(input.stateHash, 'Slack OIDC state hash'),
        oauthHash(input.nonceHash, 'Slack OIDC nonce hash'),
        oauthHash(input.browserHash, 'Slack OIDC browser hash'),
        slackId(input.appId, 'Slack app ID'), strictText(input.clientId, 'Slack client ID', 256),
        nonEmpty(input.credentialRevision, 'Slack credential revision'),
        validHttpsCallback(input.redirectUri), safeStoredAdminDestination(input.destination),
        teamId, expectedUserId, input.expiresAt, at, at,
      );
    } catch {
      throw identityError('auth_operation_conflict', 'Slack OIDC attempt changed concurrently.');
    }
    return this.requiredSlackOidcAttempt(input.id);
  }

  getSlackOidcAttempt(attemptId: string): SlackOidcAttempt | undefined {
    const row = this.db.get(
      'SELECT * FROM identity_slack_oidc_attempts WHERE attempt_id = ?',
      nonEmpty(attemptId, 'Slack OIDC attempt ID'),
    );
    return row ? slackOidcAttemptFromRow(row) : undefined;
  }

  acquireSlackOidcAttempt(input: AcquireSlackOidcAttemptInput): SlackOidcAttempt {
    const stateHash = oauthHash(input.stateHash, 'Slack OIDC state hash');
    const browserHash = oauthHash(input.browserHash, 'Slack OIDC browser hash');
    const redirectUri = validHttpsCallback(input.redirectUri);
    const acquired = this.db.transaction((): SlackOidcAttempt | undefined => {
      const row = this.db.get('SELECT * FROM identity_slack_oidc_attempts WHERE state_hash = ?', stateHash);
      if (!row) throw identityError('auth_operation_missing', 'Slack OIDC state is invalid.');
      const attempt = slackOidcAttemptFromRow(row);
      const at = this.now();
      if (attempt.browserHash !== browserHash || attempt.purpose !== input.purpose ||
          attempt.redirectUri !== redirectUri) {
        throw identityError('auth_operation_conflict', 'Slack OIDC callback binding does not match.');
      }
      if (attempt.expiresAt <= at) {
        this.db.run(
          `UPDATE identity_slack_oidc_attempts SET status = 'expired', result_code = 'expired',
           lease_expires_at = NULL, updated_at = ? WHERE attempt_id = ?`,
          at, attempt.id,
        );
        return undefined;
      }
      // A response may be lost after durable admission or session issuance.
      // Only the exact original browser/state binding may resume that result.
      if (attempt.status === 'admitted' || attempt.status === 'succeeded') return attempt;
      const reclaim = attempt.status === 'processing' &&
        attempt.leaseExpiresAt !== null && attempt.leaseExpiresAt <= at;
      if (attempt.status !== 'pending' && !reclaim) {
        throw identityError('auth_operation_conflict',
          attempt.status === 'processing'
            ? 'Slack OIDC processing lease is already held.'
            : 'Slack OIDC state is already consumed.');
      }
      if (!Number.isSafeInteger(input.leaseExpiresAt) || input.leaseExpiresAt <= at) {
        throw identityError('identity_invalid', 'Slack OIDC processing lease is invalid.');
      }
      const leaseExpiresAt = Math.min(input.leaseExpiresAt, attempt.expiresAt);
      const changed = this.db.run(
        `UPDATE identity_slack_oidc_attempts SET status = 'processing',
          lease_generation = lease_generation + 1, lease_expires_at = ?, updated_at = ?
         WHERE attempt_id = ? AND status = ? AND lease_generation = ?`,
        leaseExpiresAt, at, attempt.id, attempt.status, attempt.leaseGeneration,
      ).changes;
      if (changed !== 1) throw identityError('auth_operation_conflict', 'Slack OIDC lease changed concurrently.');
      return this.requiredSlackOidcAttempt(attempt.id);
    });
    if (!acquired) throw identityError('auth_operation_expired', 'Slack OIDC state expired.');
    return acquired;
  }

  admitSlackOidcAttempt(input: AdmitSlackOidcAttemptInput): AuthOperation {
    return this.db.transaction(() => {
      const attempt = this.requiredSlackOidcLease(input.attemptId, input.expectedLeaseGeneration);
      const teamId = slackId(input.slackTeamId, 'Slack team ID');
      const userId = slackId(input.slackUserId, 'Slack user ID');
      if (credentialHash(input.capabilityHash) !== attempt.stateHash ||
          input.expiresAt !== attempt.expiresAt || attempt.expectedTeamId !== teamId ||
          (attempt.expectedSlackUserId && attempt.expectedSlackUserId !== userId)) {
        throw identityError('auth_operation_conflict', 'Slack OIDC actor does not match expected authority.');
      }
      let operation: AuthOperation;
      if (attempt.purpose === 'first_owner') {
        const setup = this.requiredSlackSetupTransition(
          attempt.setupId ?? '', attempt.setupRevision ?? 0, ['bot_installed'],
        );
        if (setup.slackTeamId !== teamId || setup.installerSlackUserId !== userId ||
            setup.appId !== attempt.appId || setup.botCredentialRevision !== attempt.credentialRevision) {
          throw identityError('owner_claim_conflict', 'Slack OIDC proof does not match the installed app.');
        }
        if (!attempt.operationId) throw identityError('auth_operation_missing', 'First-Owner operation is missing.');
        const existingClaim = this.getOwnerClaim();
        if (existingClaim?.status === 'reserved' && existingClaim.operationId !== attempt.operationId) {
          const prior = this.requiredAuthOperation(existingClaim.operationId);
          if (existingClaim.slackTeamId !== teamId || existingClaim.slackUserId !== userId ||
              prior.expiresAt > this.now() || !['reserved', 'reconciling', 'expired'].includes(prior.status)) {
            throw identityError('owner_claim_conflict', 'The singleton first-Owner claim is already reserved.');
          }
          this.db.run(
            `UPDATE identity_auth_operations SET status = 'expired', updated_at = ?
             WHERE operation_id = ? AND status IN ('reserved', 'reconciling')`,
            this.now(), prior.id,
          );
        }
        operation = this.reservePendingAuthOperation({
          id: attempt.operationId,
          kind: 'first_owner_claim',
          expectedSlackTeamId: teamId,
          expectedSlackUserId: userId,
          chickpeaRole: 'owner',
          capabilityHash: input.capabilityHash,
          expiresAt: input.expiresAt,
        }).operation;
        if (existingClaim?.status === 'reserved' && existingClaim.operationId !== operation.id) {
          const changed = this.db.run(
            `UPDATE identity_owner_claims SET operation_id = ?, updated_at = ?
             WHERE claim_key = 'first_owner' AND status = 'reserved' AND operation_id = ?`,
            operation.id, this.now(), existingClaim.operationId,
          ).changes;
          if (changed !== 1) throw identityError('owner_claim_conflict', 'First-Owner claim changed concurrently.');
        } else {
          this.createOwnerClaim({
            operationId: operation.id,
            slackTeamId: teamId,
            slackUserId: userId,
          });
        }
      } else if (attempt.purpose === 'invitation') {
        if (!attempt.invitationId || !attempt.operationId) {
          throw identityError('auth_operation_missing', 'Invitation admission authority is missing.');
        }
        this.expirePendingInvitations();
        const invitation = this.requiredInvitation(attempt.invitationId);
        if (invitation.status !== 'pending' || invitation.expiresAt <= this.now() ||
            invitation.slackTeamId !== teamId || invitation.slackUserId !== userId) {
          throw identityError('invitation_not_pending', 'Invitation is unavailable.');
        }
        operation = this.createAuthOperation({
          id: attempt.operationId,
          kind: 'invitation_admission',
          organizationId: invitation.organizationId,
          expectedSlackTeamId: teamId,
          expectedSlackUserId: userId,
          chickpeaRole: 'admin',
          capabilityHash: input.capabilityHash,
          expiresAt: input.expiresAt,
        });
      } else {
        const resolution = this.resolveSlackIdentity(teamId, userId);
        if (!resolution || resolution.membership.status !== 'active') {
          throw identityError('auth_operation_unavailable', 'Slack identity is not admitted.');
        }
        const row = this.db.get(
          `SELECT * FROM identity_auth_operations
           WHERE chickpea_membership_id = ? AND status = 'active'
           ORDER BY activated_at DESC LIMIT 1`,
          resolution.membership.id,
        );
        if (!row) throw identityError('auth_operation_unavailable', 'Slack authority is not active.');
        operation = authOperationFromRow(row);
      }
      const changed = this.db.run(
        `UPDATE identity_slack_oidc_attempts SET status = 'admitted', operation_id = ?,
          admitted_team_id = ?, admitted_slack_user_id = ?, result_code = 'admitted', updated_at = ?
         WHERE attempt_id = ? AND status = 'processing' AND lease_generation = ?`,
        operation.id, teamId, userId, this.now(), attempt.id, attempt.leaseGeneration,
      ).changes;
      if (changed !== 1) throw identityError('auth_operation_conflict', 'Slack OIDC admission changed concurrently.');
      return operation;
    });
  }

  settleSlackOidcAttempt(input: SettleSlackOidcAttemptInput): SlackOidcAttempt {
    const persisted = this.requiredSlackOidcAttempt(input.attemptId);
    const attempt = input.status === 'succeeded' || persisted.status === 'admitted'
      ? this.requiredSlackOidcAttempt(input.attemptId)
      : this.requiredSlackOidcLease(input.attemptId, input.expectedLeaseGeneration);
    const allowed = input.status === 'succeeded'
      ? attempt.status === 'admitted'
      : attempt.status === 'processing' ||
        (attempt.status === 'admitted' && input.status === 'failed');
    if (!allowed || attempt.leaseGeneration !== input.expectedLeaseGeneration) {
      throw identityError('auth_operation_conflict', 'Slack OIDC terminal state changed concurrently.');
    }
    const changed = this.db.run(
      `UPDATE identity_slack_oidc_attempts SET status = ?, result_code = ?,
        lease_expires_at = NULL, updated_at = ?
       WHERE attempt_id = ? AND status = ? AND lease_generation = ?`,
      input.status, strictText(input.resultCode, 'Slack OIDC result code', 128), this.now(),
      attempt.id, attempt.status, attempt.leaseGeneration,
    ).changes;
    if (changed !== 1) throw identityError('auth_operation_conflict', 'Slack OIDC state changed concurrently.');
    return this.requiredSlackOidcAttempt(attempt.id);
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
    return this.db.transaction(() => this.claimOwnerInTransaction(input));
  }

  activateFirstOwner(input: ActivateFirstOwnerInput): IdentityResolution {
    return this.db.transaction(() => {
      const attempt = this.requiredSlackOidcAttempt(input.oidcAttemptId);
      const setup = this.requiredSlackSetupTransition(
        input.setupId, input.expectedSetupRevision, ['bot_installed'],
      );
      if (attempt.status !== 'admitted' ||
          attempt.leaseGeneration !== input.expectedOidcLeaseGeneration ||
          attempt.operationId !== input.operationId ||
          attempt.setupId !== setup.id || attempt.setupRevision !== setup.revision ||
          attempt.admittedTeamId !== input.slackTeamId ||
          attempt.admittedSlackUserId !== input.slackUserId ||
          setup.slackTeamId !== input.slackTeamId ||
          setup.installerSlackUserId !== input.slackUserId) {
        throw identityError('owner_claim_conflict', 'First-Owner activation authority changed.');
      }
      const resolution = this.claimOwnerInTransaction(input);
      const at = input.at ?? this.now();
      const setupChanged = this.db.run(
        `UPDATE identity_slack_setup_transactions SET state = 'consumed', revision = revision + 1,
          consumed_at = ?, updated_at = ? WHERE setup_id = ? AND revision = ? AND state = 'bot_installed'`,
        at, at, setup.id, setup.revision,
      ).changes;
      const attemptChanged = this.db.run(
        `UPDATE identity_slack_oidc_attempts SET status = 'succeeded', result_code = 'owner_active',
          lease_expires_at = NULL, updated_at = ?
         WHERE attempt_id = ? AND status = 'admitted' AND lease_generation = ?`,
        at, attempt.id, attempt.leaseGeneration,
      ).changes;
      if (setupChanged !== 1 || attemptChanged !== 1) {
        throw identityError('auth_operation_conflict', 'First-Owner activation changed concurrently.');
      }
      return resolution;
    });
  }

  activateInvitation(input: ActivateInvitationInput): IdentityResolution {
    return this.db.transaction(() => {
      const at = input.at ?? this.now();
      this.expirePendingInvitations(at);
      const attempt = this.requiredSlackOidcAttempt(input.oidcAttemptId);
      const invitation = this.requiredInvitation(input.invitationId);
      const operation = this.requiredAuthOperation(input.operationId);
      if (attempt.purpose !== 'invitation' || attempt.invitationId !== invitation.id ||
          attempt.status !== 'admitted' || attempt.leaseGeneration !== input.expectedOidcLeaseGeneration ||
          attempt.operationId !== operation.id || attempt.admittedTeamId !== input.slackTeamId ||
          attempt.admittedSlackUserId !== input.slackUserId ||
          invitation.status !== 'pending' || invitation.expiresAt <= at ||
          invitation.slackTeamId !== input.slackTeamId || invitation.slackUserId !== input.slackUserId ||
          operation.kind !== 'invitation_admission' || !['reserved', 'reconciling'].includes(operation.status) ||
          operation.capabilityHash !== credentialHash(input.capabilityHash) ||
          operation.betterAuthUserId !== input.betterAuthUserId ||
          operation.betterAuthMembershipId !== input.betterAuthMembershipId ||
          operation.organizationId !== invitation.organizationId) {
        throw identityError('invitation_not_pending', 'Invitation activation authority changed.');
      }

      let resolution = this.resolveSlackIdentity(input.slackTeamId, input.slackUserId, invitation.organizationId);
      if (resolution) {
        if (resolution.membership.status !== 'removed' ||
            resolution.binding.betterAuthUserId !== input.betterAuthUserId ||
            resolution.binding.betterAuthMembershipId !== input.betterAuthMembershipId) {
          throw identityError('external_identity_conflict', 'Slack identity is already bound.');
        }
        this.db.run(
          `UPDATE identity_memberships SET role = 'admin', status = 'active', updated_at = ?
           WHERE membership_id = ? AND status = 'removed'`,
          at, resolution.membership.id,
        );
        this.db.run(
          `UPDATE identity_membership_access_overlays SET access_status = 'active',
           membership_version = membership_version + 1, updated_at = ? WHERE membership_id = ?`,
          at, resolution.membership.id,
        );
        resolution = this.requiredResolution(input.slackTeamId, input.slackUserId, invitation.organizationId);
      } else {
        resolution = this.insertCanonicalIdentity({
          operationId: operation.id,
          organizationId: invitation.organizationId,
          slackTeamId: input.slackTeamId,
          slackUserId: input.slackUserId,
          displayName: input.displayName ?? invitation.displayName,
          betterAuthUserId: input.betterAuthUserId,
          betterAuthMembershipId: input.betterAuthMembershipId,
          role: 'admin',
          at,
        });
      }
      const invitationChanged = this.db.run(
        `UPDATE identity_invitations SET status = 'accepted', accepted_membership_id = ?, updated_at = ?
         WHERE invitation_id = ? AND status = 'pending'`,
        resolution.membership.id, at, invitation.id,
      ).changes;
      const operationChanged = this.db.run(
        `UPDATE identity_auth_operations SET status = 'active', chickpea_membership_id = ?,
         activated_at = ?, updated_at = ? WHERE operation_id = ? AND status IN ('reserved', 'reconciling')`,
        resolution.membership.id, at, at, operation.id,
      ).changes;
      const attemptChanged = this.db.run(
        `UPDATE identity_slack_oidc_attempts SET status = 'succeeded', result_code = 'invitation_active',
         lease_expires_at = NULL, updated_at = ?
         WHERE attempt_id = ? AND status = 'admitted' AND lease_generation = ?`,
        at, attempt.id, attempt.leaseGeneration,
      ).changes;
      if (invitationChanged !== 1 || operationChanged !== 1 || attemptChanged !== 1) {
        throw identityError('auth_operation_conflict', 'Invitation activation changed concurrently.');
      }
      return resolution;
    });
  }

  private claimOwnerInTransaction(input: ClaimOwnerInput): IdentityResolution {
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

  updateMembershipAuthority(
    input: UpdateMembershipAuthorityInput,
  ): MembershipAuthorityMutationResult {
    return this.db.transaction(() => {
      const current = this.requiredMembership(input.membershipId);
      const replay = input.idempotencyKey
        ? this.audit.findByIdempotencyKey(nonEmpty(input.idempotencyKey, 'idempotency key'))
        : undefined;
      if (replay) {
        return {
          membership: current,
          changed: false,
          revokedPersonalTokenCount: 0,
          revokedBrowserSessionCount: 0,
        };
      }

      const actor = input.actorMembershipId
        ? this.requiredMembership(input.actorMembershipId)
        : undefined;
      const systemDeactivation = input.authenticationSurface === 'slack_event' && !actor;
      if (actor && (actor.organizationId !== current.organizationId ||
          actor.role !== 'owner' || actor.status !== 'active')) {
        throw identityError('inviter_not_authorized', 'Only an active Owner can change team authority.');
      }
      if (!actor && !systemDeactivation) {
        throw identityError('inviter_not_authorized', 'Membership authority requires an active Owner.');
      }

      const role = input.role ?? current.role;
      const status = input.status ?? current.status;
      let changed = role !== current.role || status !== current.status;
      let preserveSoleOwner = false;
      if (current.role === 'owner' && current.status === 'active' &&
          (role !== 'owner' || status !== 'active')) {
        const owners = Number(this.db.get(
          `SELECT count(*) AS count FROM identity_memberships
           WHERE organization_id = ? AND role = 'owner' AND status = 'active'`,
          current.organizationId,
        )?.count ?? 0);
        if (owners <= 1) {
          if (!systemDeactivation) {
            throw identityError('last_owner_required', 'At least one active Owner is required.');
          }
          preserveSoleOwner = true;
        }
      }

      const at = this.now();
      if (changed && !preserveSoleOwner) {
        this.db.run(
          'UPDATE identity_memberships SET role = ?, status = ?, updated_at = ? WHERE membership_id = ?',
          role, status, at, current.id,
        );
        if (status === 'removed') {
          this.db.run(
            `UPDATE identity_auth_operations SET status = 'tombstoned', tombstoned_at = ?, updated_at = ?
             WHERE chickpea_membership_id = ? AND status = 'active'`,
            at, at, current.id,
          );
        }
      }
      if (systemDeactivation && status === 'suspended') {
        const overlay = this.getMembershipAccessOverlay(current.id);
        if (overlay?.accessStatus !== 'suspended') {
          changed = true;
          this.db.run(
            `INSERT INTO identity_membership_access_overlays (
              membership_id, organization_id, access_status, membership_version, created_at, updated_at
            ) VALUES (?, ?, 'suspended', 1, ?, ?)
            ON CONFLICT (membership_id) DO UPDATE SET access_status = 'suspended',
              membership_version = identity_membership_access_overlays.membership_version + 1,
              updated_at = excluded.updated_at`,
            current.id, current.organizationId, at, at,
          );
        }
      } else if (status === 'active') {
        const overlay = this.getMembershipAccessOverlay(current.id);
        if (overlay?.accessStatus === 'suspended') {
          changed = true;
          this.db.run(
            `UPDATE identity_membership_access_overlays SET access_status = 'active',
             membership_version = membership_version + 1, updated_at = ? WHERE membership_id = ?`,
            at, current.id,
          );
        }
      }

      const revokedPersonalTokenCount = changed ? this.db.run(
        `UPDATE identity_personal_tokens SET status = 'revoked', updated_at = ?
         WHERE membership_id = ? AND status = 'active'`,
        at, current.id,
      ).changes : 0;
      const revokedBrowserSessionCount = changed ? this.db.run(
        `UPDATE identity_browser_sessions SET revoked_at = ?
         WHERE membership_id = ? AND revoked_at IS NULL`,
        at, current.id,
      ).changes : 0;
      const membership = this.requiredMembership(current.id);
      const append = input.idempotencyKey
        ? this.audit.appendIdempotent.bind(this.audit)
        : this.audit.append.bind(this.audit);
      append({
        eventId: newId('audit'), domain: 'identity', eventType: 'identity.membership',
        outcome: 'success', actorClass: input.authenticationSurface,
        actorId: actor?.id ?? null, workspaceId: input.slackTeamId ?? null,
        subjectId: current.id, subjectVersion: membership.updatedAt,
        createdAt: at, reasonCode: safeAudit(input.reasonCode),
        metadataJson: JSON.stringify({
          action: 'membership.update', correlationId: safeAudit(input.correlationId),
          authenticationSurface: input.authenticationSurface,
          role: membership.role, status: membership.status,
          slackUserId: input.slackUserId ? safeAudit(input.slackUserId) : null,
          credentialRevision: input.credentialRevision ? safeAudit(input.credentialRevision) : null,
          soleOwnerAccessSuspended: preserveSoleOwner,
        }),
        ...(input.idempotencyKey ? { idempotencyKey: safeAudit(input.idempotencyKey) } : {}),
      });
      return {
        membership,
        changed,
        revokedPersonalTokenCount,
        revokedBrowserSessionCount,
      };
    });
  }

  createInvitation(input: CreateInvitationInput): Invitation {
    const at = this.now();
    this.expirePendingInvitations(at);
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= at ||
        input.expiresAt > at + 7 * 24 * 60 * 60_000) {
      throw identityError('identity_invalid', 'Invitation expiry is invalid.');
    }
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

  findInvitation(locatorHash: string): Invitation | undefined {
    this.expirePendingInvitations();
    const row = this.db.get(
      `SELECT * FROM identity_invitations WHERE locator_hash = ? AND status = 'pending' LIMIT 1`,
      credentialHash(locatorHash),
    );
    return row ? invitationFromRow(row) : undefined;
  }

  resendInvitation(input: ResendInvitationInput): Invitation {
    this.expirePendingInvitations();
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
    this.expirePendingInvitations();
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
      const at = input.at ?? this.now();
      this.expirePendingInvitations(at);
      const invitation = this.requiredInvitation(input.invitationId);
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
    this.expirePendingInvitations();
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
      slackSetupTransactions: this.db.all(
        'SELECT * FROM identity_slack_setup_transactions ORDER BY created_at, setup_id',
      ).map(slackSetupTransactionFromRow)
        .map(({ locatorHash: _locatorHash, ...transaction }) => transaction),
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
  private requiredSlackRecoverySession(id: string): SlackRecoverySession {
    const value = this.getSlackRecoverySession(id);
    if (!value) throw identityError('auth_operation_missing', 'Slack recovery session was not found.');
    return value;
  }
  private requiredLiveSlackRecoverySession(
    id: string,
    sessionHash: string,
    browserHash: string,
  ): SlackRecoverySession {
    const session = this.requiredSlackRecoverySession(id);
    this.requireSlackRecoveryBindings(session, sessionHash, browserHash);
    const now = this.now();
    if (session.expiresAt <= now) {
      this.expireSlackRecoverySession(session.id, now);
      throw identityError('auth_operation_expired', 'Slack recovery session expired.');
    }
    if (['consumed', 'failed', 'expired'].includes(session.status)) {
      throw identityError('auth_operation_conflict', 'Slack recovery session is terminal.');
    }
    return session;
  }
  private requireSlackRecoveryBindings(
    session: SlackRecoverySession,
    sessionHash: string,
    browserHash: string,
  ): void {
    if (session.sessionHash !== credentialHash(sessionHash)) {
      throw identityError('auth_operation_conflict', 'Slack recovery session credential changed.');
    }
    if (session.browserHash !== credentialHash(browserHash)) {
      throw identityError('auth_operation_conflict', 'Slack recovery browser binding changed.');
    }
  }
  private expireSlackRecoverySession(id: string, at: number): void {
    this.db.run(
      `UPDATE identity_slack_recovery_sessions SET status = 'expired',
        app_envelope_version = NULL, app_envelope_algorithm = NULL, app_key_id = NULL,
        app_nonce = NULL, app_ciphertext = NULL, oauth_state_hash = NULL,
        lease_expires_at = NULL, updated_at = ? WHERE recovery_id = ?`,
      at, id,
    );
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
  private expirePendingInvitations(at = this.now()): void {
    this.db.run(
      `UPDATE identity_invitations SET status = 'expired', updated_at = ?
       WHERE status = 'pending' AND expires_at <= ?`,
      at, at,
    );
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
  async createSlackRecoverySession(input: CreateSlackRecoverySessionInput) { return this.logic.createSlackRecoverySession(input); }
  async getSlackRecoverySession(id: string) { return this.logic.getSlackRecoverySession(id); }
  async stageSlackRecoveryAppCredentials(input: StageSlackRecoveryAppCredentialsInput) { return this.logic.stageSlackRecoveryAppCredentials(input); }
  async startSlackRecoveryOAuth(input: StartSlackRecoveryOAuthInput) { return this.logic.startSlackRecoveryOAuth(input); }
  async updateSlackRecoveryManifest(input: UpdateSlackRecoveryManifestInput) { return this.logic.updateSlackRecoveryManifest(input); }
  async acquireSlackRecoveryOAuth(input: AcquireSlackRecoveryOAuthInput) { return this.logic.acquireSlackRecoveryOAuth(input); }
  async recordSlackRecoveryCandidate(input: RecordSlackRecoveryCandidateInput) { return this.logic.recordSlackRecoveryCandidate(input); }
  async promoteSlackRecoveryCandidate(input: PromoteSlackRecoveryCandidateInput) { return this.logic.promoteSlackRecoveryCandidate(input); }
  async reserveSlackSetupTransaction(input: ReserveSlackSetupTransactionInput) { return this.logic.reserveSlackSetupTransaction(input); }
  async getSlackSetupTransaction(setupId: string) { return this.logic.getSlackSetupTransaction(setupId); }
  async findSlackSetupTransaction(locatorHash: string) { return this.logic.findSlackSetupTransaction(locatorHash); }
  async beginSlackAppCreation(input: BeginSlackAppCreationInput) { return this.logic.beginSlackAppCreation(input); }
  async failSlackAppCreation(input: FailSlackAppCreationInput) { return this.logic.failSlackAppCreation(input); }
  async recordSlackAppCreationSuccess(input: RecordSlackAppCreationSuccessInput) { return this.logic.recordSlackAppCreationSuccess(input); }
  async restartSlackAppCreation(input: SlackSetupTransitionInput) { return this.logic.restartSlackAppCreation(input); }
  async markSlackSetupApprovalPending(input: MarkSlackSetupApprovalPendingInput) { return this.logic.markSlackSetupApprovalPending(input); }
  async resumeSlackSetupAfterApproval(input: SlackSetupTransitionInput) { return this.logic.resumeSlackSetupAfterApproval(input); }
  async createSlackOAuthAttempt(input: CreateSlackOAuthAttemptInput) { return this.logic.createSlackOAuthAttempt(input); }
  async getSlackOAuthAttempt(id: string) { return this.logic.getSlackOAuthAttempt(id); }
  async acquireSlackOAuthAttempt(input: AcquireSlackOAuthAttemptInput) { return this.logic.acquireSlackOAuthAttempt(input); }
  async settleSlackOAuthAttempt(input: SettleSlackOAuthAttemptInput) { return this.logic.settleSlackOAuthAttempt(input); }
  async markSlackOAuthApprovalPending(input: MarkSlackOAuthApprovalPendingInput) { return this.logic.markSlackOAuthApprovalPending(input); }
  async recordSlackBotInstallationCandidate(input: RecordSlackBotInstallationCandidateInput) { return this.logic.recordSlackBotInstallationCandidate(input); }
  async getSlackEventsProof(revision: string) { return this.logic.getSlackEventsProof(revision); }
  async recordSlackEventsProof(input: RecordSlackEventsProofInput) { return this.logic.recordSlackEventsProof(input); }
  async promoteSlackBotInstallation(input: PromoteSlackBotInstallationInput) { return this.logic.promoteSlackBotInstallation(input); }
  async failSlackBotInstallation(input: FailSlackBotInstallationInput) { return this.logic.failSlackBotInstallation(input); }
  async createSlackOidcAttempt(input: CreateSlackOidcAttemptInput) { return this.logic.createSlackOidcAttempt(input); }
  async getSlackOidcAttempt(id: string) { return this.logic.getSlackOidcAttempt(id); }
  async acquireSlackOidcAttempt(input: AcquireSlackOidcAttemptInput) { return this.logic.acquireSlackOidcAttempt(input); }
  async admitSlackOidcAttempt(input: AdmitSlackOidcAttemptInput) { return this.logic.admitSlackOidcAttempt(input); }
  async settleSlackOidcAttempt(input: SettleSlackOidcAttemptInput) { return this.logic.settleSlackOidcAttempt(input); }
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
  async activateFirstOwner(input: ActivateFirstOwnerInput) { return this.logic.activateFirstOwner(input); }
  async activateInvitation(input: ActivateInvitationInput) { return this.logic.activateInvitation(input); }
  async resolveSlackIdentity(teamId: string, userId: string, organizationId?: string) { return this.logic.resolveSlackIdentity(teamId, userId, organizationId); }
  async listExternalIdentities() { return this.logic.listExternalIdentities(); }
  async listMemberships() { return this.logic.listMemberships(); }
  async getUser(id: string) { return this.logic.getUser(id); }
  async getMembership(id: string) { return this.logic.getMembership(id); }
  async getMembershipForUser(userId: string, organizationId?: string) { return this.logic.getMembershipForUser(userId, organizationId); }
  async updateMembershipAuthority(input: UpdateMembershipAuthorityInput) {
    return this.logic.updateMembershipAuthority(input);
  }
  async createInvitation(input: CreateInvitationInput) { return this.logic.createInvitation(input); }
  async findInvitation(locatorHash: string) { return this.logic.findInvitation(locatorHash); }
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

function validateRecoveryEnvelope(envelope: StageSlackRecoveryAppCredentialsInput['appCredentialEnvelope']): void {
  if (envelope.version !== 1 || envelope.algorithm !== 'AES-GCM-256' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(envelope.keyId) ||
      !/^[A-Za-z0-9_-]{16}$/.test(envelope.nonce) ||
      !/^[A-Za-z0-9_-]{22,131072}$/.test(envelope.ciphertext)) {
    throw identityError('identity_invalid', 'Slack recovery credential envelope is invalid.');
  }
}

function validateSlackOAuthAttemptInput(input: CreateSlackOAuthAttemptInput): void {
  if (input.kind !== 'slack_bot_install' || input.purpose !== 'setup_bot_install') {
    throw identityError('identity_invalid', 'Slack OAuth attempt kind is invalid.');
  }
  if (!Number.isSafeInteger(input.setupRevision) || input.setupRevision < 1 ||
      !Number.isSafeInteger(input.expiresAt) || input.expiresAt < 1) {
    throw identityError('identity_invalid', 'Slack OAuth attempt timing is invalid.');
  }
  oauthHash(input.stateHash, 'Slack OAuth state hash');
  oauthHash(input.browserHash, 'Slack OAuth browser hash');
  slackId(input.appId, 'Slack app ID');
  if (input.expectedTeamId) slackId(input.expectedTeamId, 'Slack team ID');
  if (input.expectedInstallerSlackUserId) {
    slackId(input.expectedInstallerSlackUserId, 'Slack installer user ID');
  }
  validHttpsCallback(input.redirectUri);
  safeStoredAdminDestination(input.destination);
  nonEmpty(input.credentialRevision, 'Slack credential revision');
  nonEmpty(input.baseRevision, 'Slack base revision');
  if (input.credentialRevision !== input.baseRevision) {
    throw identityError('identity_invalid', 'Slack OAuth base revision is invalid.');
  }
}

function oauthHash(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw identityError('identity_invalid', `${field} is invalid.`);
  return value;
}

function validHttpsCallback(value: string): string {
  const candidate = strictText(value, 'Slack OAuth redirect URI', 2_048);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw identityError('identity_invalid', 'Slack OAuth redirect URI is invalid.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash ||
      parsed.toString() !== candidate) {
    throw identityError('identity_invalid', 'Slack OAuth redirect URI is invalid.');
  }
  return candidate;
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

function slackRecoverySessionFromRow(row: Record<string, unknown>): SlackRecoverySession {
  const hasEnvelope = row.app_ciphertext !== null && row.app_ciphertext !== undefined;
  const actions = JSON.parse(String(row.allowed_actions_json)) as SlackRecoverySession['allowedActions'];
  return {
    id: String(row.recovery_id),
    deploymentId: String(row.deployment_id),
    grantHash: String(row.grant_hash),
    sessionHash: String(row.session_hash),
    browserHash: String(row.browser_hash),
    allowedActions: actions,
    status: String(row.status) as SlackRecoverySession['status'],
    expectedAppId: String(row.expected_app_id),
    expectedTeamId: String(row.expected_team_id),
    baseRevision: String(row.base_revision),
    manifestFingerprint: String(row.manifest_fingerprint),
    appCredentialRevision: nullableString(row.app_credential_revision),
    appCredentialClientId: nullableString(row.app_credential_client_id),
    appCredentialEnvelope: hasEnvelope ? {
      version: Number(row.app_envelope_version) as 1,
      algorithm: String(row.app_envelope_algorithm) as 'AES-GCM-256',
      keyId: String(row.app_key_id),
      nonce: String(row.app_nonce),
      ciphertext: String(row.app_ciphertext),
    } : null,
    connectedCandidateRevision: nullableString(row.connected_candidate_revision),
    oauthStateHash: nullableString(row.oauth_state_hash),
    oauthRedirectUri: nullableString(row.oauth_redirect_uri),
    leaseGeneration: Number(row.lease_generation),
    leaseExpiresAt: nullableNumber(row.lease_expires_at),
    resultCode: nullableString(row.result_code),
    expiresAt: Number(row.expires_at),
    consumedAt: nullableNumber(row.consumed_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function slackSetupTransactionFromRow(row: Record<string, unknown>): SlackSetupTransaction {
  return {
    id: String(row.setup_id),
    locatorHash: String(row.locator_hash),
    state: String(row.state) as SlackSetupTransaction['state'],
    revision: Number(row.revision),
    destination: String(row.destination),
    manifestFingerprint: nullableString(row.manifest_fingerprint),
    appId: nullableString(row.app_id),
    credentialRevision: nullableString(row.credential_revision),
    botCredentialRevision: nullableString(row.bot_credential_revision),
    slackTeamId: nullableString(row.slack_team_id),
    installerSlackUserId: nullableString(row.installer_slack_user_id),
    botUserId: nullableString(row.bot_user_id),
    lastErrorCode: nullableString(row.last_error_code),
    expiresAt: Number(row.expires_at),
    consumedAt: nullableNumber(row.consumed_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function slackOAuthAttemptFromRow(row: Record<string, unknown>): SlackOAuthAttempt {
  return {
    id: String(row.attempt_id),
    kind: String(row.kind) as SlackOAuthAttempt['kind'],
    purpose: String(row.purpose) as SlackOAuthAttempt['purpose'],
    setupId: String(row.setup_id),
    setupRevision: Number(row.setup_revision),
    stateHash: String(row.state_hash),
    browserHash: String(row.browser_hash),
    appId: String(row.app_id),
    clientId: String(row.client_id),
    credentialRevision: String(row.credential_revision),
    baseRevision: String(row.base_revision),
    redirectUri: String(row.redirect_uri),
    destination: String(row.destination),
    expectedTeamId: nullableString(row.expected_team_id),
    expectedInstallerSlackUserId: nullableString(row.expected_installer_slack_user_id),
    status: String(row.status) as SlackOAuthAttempt['status'],
    leaseGeneration: Number(row.lease_generation),
    leaseExpiresAt: nullableNumber(row.lease_expires_at),
    resultCode: nullableString(row.result_code),
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function slackOidcAttemptFromRow(row: Record<string, unknown>): SlackOidcAttempt {
  return {
    id: String(row.attempt_id),
    purpose: String(row.purpose) as SlackOidcAttempt['purpose'],
    operationId: nullableString(row.operation_id),
    invitationId: nullableString(row.invitation_id),
    setupId: nullableString(row.setup_id),
    setupRevision: nullableNumber(row.setup_revision),
    stateHash: String(row.state_hash),
    nonceHash: String(row.nonce_hash),
    browserHash: String(row.browser_hash),
    appId: String(row.app_id),
    clientId: String(row.client_id),
    credentialRevision: String(row.credential_revision),
    redirectUri: String(row.redirect_uri),
    destination: String(row.destination),
    expectedTeamId: String(row.expected_team_id),
    expectedSlackUserId: nullableString(row.expected_slack_user_id),
    admittedTeamId: nullableString(row.admitted_team_id),
    admittedSlackUserId: nullableString(row.admitted_slack_user_id),
    status: String(row.status) as SlackOidcAttempt['status'],
    leaseGeneration: Number(row.lease_generation),
    leaseExpiresAt: nullableNumber(row.lease_expires_at),
    resultCode: nullableString(row.result_code),
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function slackEventsProofFromRow(row: Record<string, unknown>): SlackEventsProof {
  return {
    candidateRevision: String(row.candidate_revision),
    identityId: String(row.identity_id),
    appId: String(row.app_id),
    teamId: String(row.team_id),
    baseRevision: String(row.base_revision),
    verifiedAt: Number(row.verified_at),
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
function validateSetupTime(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw identityError('identity_invalid', `${field} is invalid.`);
  }
}
function safeStoredAdminDestination(value: string): string {
  const destination = value.trim();
  if (!/^\/admin(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/.test(destination)) return '/admin';
  try {
    const base = new URL('https://chickpea.invalid');
    const parsed = new URL(destination, base);
    if (parsed.origin === base.origin && parsed.pathname === destination && !parsed.search && !parsed.hash &&
        !parsed.username && !parsed.password && parsed.pathname !== '/admin/api' &&
        !parsed.pathname.startsWith('/admin/api/') &&
        (parsed.pathname === '/admin' || parsed.pathname.startsWith('/admin/'))) {
      return parsed.pathname;
    }
  } catch {
    // Fall through to the neutral Admin destination.
  }
  return '/admin';
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
