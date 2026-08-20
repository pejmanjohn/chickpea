import type { StateDb } from '../state/state-db.ts';

export const IDENTITY_SCHEMA_VERSION = 1;
export const IDENTITY_SCHEMA_MARKER = 'slack-native-v1';

/** Fresh Slack-native TAG_STATE schema. Earlier ledgers are incompatible by design. */
export const IDENTITY_SCHEMA_V1_STATEMENTS = [
  `CREATE TABLE identity_schema_metadata (
    schema_key TEXT PRIMARY KEY CHECK (schema_key = 'identity'), schema_marker TEXT NOT NULL
  )`,
  `CREATE TABLE identity_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`,
  `CREATE TABLE identity_auth_controls (
    installation_id TEXT PRIMARY KEY,
    auth_mode TEXT NOT NULL CHECK (auth_mode IN ('unconfigured', 'slack_active')),
    health_gate TEXT NOT NULL CHECK (health_gate IN ('normal', 'recovery_only')),
    canonical_admin_origin TEXT, better_auth_organization_id TEXT,
    revision INTEGER NOT NULL CHECK (revision > 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE identity_slack_credential_controls (
    installation_id TEXT PRIMARY KEY,
    deployment_id TEXT NOT NULL UNIQUE,
    current_key_id TEXT NOT NULL,
    rotation_epoch INTEGER NOT NULL CHECK (rotation_epoch > 0),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE identity_slack_credential_revisions (
    identity_id TEXT NOT NULL,
    identity_class TEXT NOT NULL CHECK (identity_class IN ('workspace_default', 'dedicated_bot')),
    purpose TEXT NOT NULL CHECK (purpose IN ('app_credentials', 'connected_credentials', 'bot_credentials')),
    revision TEXT NOT NULL, base_revision TEXT,
    status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'tombstoned')),
    app_id TEXT NOT NULL, team_id TEXT, bot_user_id TEXT,
    granted_scopes_json TEXT NOT NULL,
    validated_at INTEGER, manifest_fingerprint TEXT,
    rotation_epoch INTEGER NOT NULL CHECK (rotation_epoch > 0),
    envelope_version INTEGER, envelope_algorithm TEXT, key_id TEXT, nonce TEXT, ciphertext TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, tombstoned_at INTEGER,
    PRIMARY KEY (identity_id, revision)
  )`,
  `CREATE UNIQUE INDEX identity_slack_credential_active_uidx
    ON identity_slack_credential_revisions (identity_id) WHERE status = 'active'`,
  `CREATE UNIQUE INDEX identity_slack_credential_candidate_uidx
    ON identity_slack_credential_revisions (identity_id) WHERE status = 'candidate'`,
  `CREATE INDEX identity_slack_credential_key_idx
    ON identity_slack_credential_revisions (key_id, status, rotation_epoch)`,
  `CREATE TABLE identity_slack_recovery_sessions (
    recovery_id TEXT PRIMARY KEY, deployment_id TEXT NOT NULL,
    grant_hash TEXT NOT NULL UNIQUE, session_hash TEXT NOT NULL UNIQUE, browser_hash TEXT NOT NULL,
    allowed_actions_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'active', 'credentials_staged', 'oauth_pending', 'oauth_processing',
      'waiting_events', 'consumed', 'failed', 'expired'
    )),
    expected_app_id TEXT NOT NULL, expected_team_id TEXT NOT NULL, base_revision TEXT NOT NULL,
    manifest_fingerprint TEXT NOT NULL,
    app_credential_revision TEXT, app_credential_client_id TEXT,
    app_envelope_version INTEGER, app_envelope_algorithm TEXT, app_key_id TEXT,
    app_nonce TEXT, app_ciphertext TEXT,
    connected_candidate_revision TEXT, oauth_state_hash TEXT UNIQUE, oauth_redirect_uri TEXT,
    lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
    lease_expires_at INTEGER, result_code TEXT, expires_at INTEGER NOT NULL,
    consumed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX identity_slack_recovery_active_uidx
    ON identity_slack_recovery_sessions ((1))
    WHERE status IN ('active', 'credentials_staged', 'oauth_pending', 'oauth_processing', 'waiting_events')`,
  `CREATE TABLE identity_slack_setup_transactions (
    setup_id TEXT PRIMARY KEY CHECK (setup_id = 'setup_default'),
    locator_hash TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN (
      'awaiting_app_creation', 'app_creation_pending', 'ambiguous_external_effect',
      'app_created', 'approval_pending', 'bot_install_pending', 'bot_installed',
      'install_failed', 'expired', 'consumed'
    )),
    revision INTEGER NOT NULL CHECK (revision > 0),
    destination TEXT NOT NULL,
    manifest_fingerprint TEXT, app_id TEXT, credential_revision TEXT,
    bot_credential_revision TEXT, slack_team_id TEXT,
    installer_slack_user_id TEXT, bot_user_id TEXT,
    last_error_code TEXT, expires_at INTEGER NOT NULL, consumed_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX identity_slack_setup_state_idx
    ON identity_slack_setup_transactions (state, expires_at)`,
  `CREATE TABLE identity_slack_oauth_attempts (
    attempt_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind = 'slack_bot_install'),
    purpose TEXT NOT NULL CHECK (purpose = 'setup_bot_install'),
    setup_id TEXT NOT NULL, setup_revision INTEGER NOT NULL CHECK (setup_revision > 0),
    state_hash TEXT NOT NULL UNIQUE, browser_hash TEXT NOT NULL,
    app_id TEXT NOT NULL, client_id TEXT NOT NULL,
    credential_revision TEXT NOT NULL, base_revision TEXT NOT NULL,
    redirect_uri TEXT NOT NULL, destination TEXT NOT NULL,
    expected_team_id TEXT, expected_installer_slack_user_id TEXT,
    status TEXT NOT NULL CHECK (status IN (
      'pending', 'processing', 'validated', 'approval_pending', 'denied',
      'failed', 'succeeded', 'expired'
    )),
    lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
    lease_expires_at INTEGER, result_code TEXT, expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX identity_slack_oauth_setup_idx
    ON identity_slack_oauth_attempts (setup_id, status, expires_at)`,
  `CREATE TABLE identity_slack_oidc_attempts (
    attempt_id TEXT PRIMARY KEY,
    purpose TEXT NOT NULL CHECK (purpose IN ('first_owner', 'invitation', 'login')),
    operation_id TEXT, invitation_id TEXT, setup_id TEXT, setup_revision INTEGER,
    state_hash TEXT NOT NULL UNIQUE, nonce_hash TEXT NOT NULL, browser_hash TEXT NOT NULL,
    app_id TEXT NOT NULL, client_id TEXT NOT NULL, credential_revision TEXT NOT NULL,
    redirect_uri TEXT NOT NULL, destination TEXT NOT NULL,
    expected_team_id TEXT NOT NULL, expected_slack_user_id TEXT,
    admitted_team_id TEXT, admitted_slack_user_id TEXT,
    status TEXT NOT NULL CHECK (status IN (
      'pending', 'processing', 'admitted', 'succeeded', 'denied', 'failed', 'expired'
    )),
    lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
    lease_expires_at INTEGER, result_code TEXT, expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX identity_slack_oidc_state_idx
    ON identity_slack_oidc_attempts (purpose, status, expires_at)`,
  `CREATE TABLE identity_slack_events_proofs (
    candidate_revision TEXT PRIMARY KEY, identity_id TEXT NOT NULL,
    app_id TEXT NOT NULL, team_id TEXT NOT NULL, base_revision TEXT NOT NULL,
    verified_at INTEGER NOT NULL
  )`,
  `CREATE TABLE identity_organizations (
    organization_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, slack_team_id TEXT UNIQUE,
    auth_mode TEXT NOT NULL CHECK (auth_mode IN ('unconfigured', 'slack_active')),
    canonical_admin_origin TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE identity_users (
    user_id TEXT PRIMARY KEY, slack_team_id TEXT NOT NULL, slack_user_id TEXT NOT NULL,
    display_name TEXT, contact_email TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE (slack_team_id, slack_user_id)
  )`,
  `CREATE TABLE identity_memberships (
    membership_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES identity_organizations(organization_id),
    user_id TEXT NOT NULL REFERENCES identity_users(user_id),
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'removed')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (organization_id, user_id)
  )`,
  `CREATE TABLE identity_slack_bindings (
    binding_id TEXT PRIMARY KEY, slack_team_id TEXT NOT NULL, slack_user_id TEXT NOT NULL,
    user_id TEXT NOT NULL UNIQUE REFERENCES identity_users(user_id),
    organization_id TEXT NOT NULL REFERENCES identity_organizations(organization_id),
    membership_id TEXT NOT NULL UNIQUE REFERENCES identity_memberships(membership_id),
    better_auth_user_id TEXT UNIQUE, better_auth_membership_id TEXT UNIQUE,
    revision INTEGER NOT NULL CHECK (revision > 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE (slack_team_id, slack_user_id)
  )`,
  `CREATE TABLE identity_owner_claims (
    claim_key TEXT PRIMARY KEY CHECK (claim_key = 'first_owner'), owner_claim_id TEXT NOT NULL UNIQUE,
    operation_id TEXT NOT NULL UNIQUE,
    organization_id TEXT REFERENCES identity_organizations(organization_id), slack_team_id TEXT NOT NULL,
    slack_user_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('reserved', 'active', 'tombstoned')),
    membership_id TEXT REFERENCES identity_memberships(membership_id),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE identity_invitations (
    invitation_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES identity_organizations(organization_id),
    slack_team_id TEXT NOT NULL, slack_user_id TEXT NOT NULL, display_name TEXT,
    role TEXT NOT NULL CHECK (role = 'admin'), locator_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
    inviter_membership_id TEXT NOT NULL REFERENCES identity_memberships(membership_id),
    accepted_membership_id TEXT REFERENCES identity_memberships(membership_id),
    expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX identity_invitations_state_idx
   ON identity_invitations (organization_id, status, expires_at)`,
  `CREATE UNIQUE INDEX identity_invitations_pending_tuple_uidx
   ON identity_invitations (organization_id, slack_team_id, slack_user_id) WHERE status = 'pending'`,
  `CREATE TABLE identity_auth_operations (
    operation_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('first_owner_claim', 'invitation_admission', 'login')),
    organization_id TEXT REFERENCES identity_organizations(organization_id),
    expected_slack_team_id TEXT NOT NULL, expected_slack_user_id TEXT NOT NULL,
    chickpea_role TEXT CHECK (chickpea_role IN ('owner', 'admin', 'member')),
    capability_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('reserved', 'reconciling', 'active', 'tombstoned', 'expired')),
    step INTEGER NOT NULL CHECK (step >= 0), better_auth_user_id TEXT,
    better_auth_organization_id TEXT, better_auth_membership_id TEXT, chickpea_membership_id TEXT,
    expires_at INTEGER NOT NULL, activated_at INTEGER, tombstoned_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX identity_auth_operations_state_idx
   ON identity_auth_operations (kind, status, expires_at)`,
  `CREATE UNIQUE INDEX identity_auth_operations_first_owner_uidx
   ON identity_auth_operations (kind)
   WHERE kind = 'first_owner_claim' AND status IN ('reserved', 'reconciling', 'active')`,
  `CREATE UNIQUE INDEX identity_auth_operations_tuple_uidx
   ON identity_auth_operations (kind, organization_id, expected_slack_team_id, expected_slack_user_id)
   WHERE status IN ('reserved', 'reconciling', 'active')`,
  `CREATE TABLE identity_membership_access_overlays (
    membership_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
    access_status TEXT NOT NULL CHECK (access_status IN ('active', 'suspended')),
    membership_version INTEGER NOT NULL CHECK (membership_version > 0),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE identity_personal_tokens (
    personal_token_id TEXT PRIMARY KEY,
    organization_id TEXT REFERENCES identity_organizations(organization_id),
    user_id TEXT NOT NULL REFERENCES identity_users(user_id),
    membership_id TEXT REFERENCES identity_memberships(membership_id),
    token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, label TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')), last_used_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX identity_personal_tokens_prefix_idx ON identity_personal_tokens (prefix, status)`,
  `CREATE TABLE identity_browser_sessions (
    browser_session_id TEXT PRIMARY KEY,
    organization_id TEXT REFERENCES identity_organizations(organization_id),
    user_id TEXT NOT NULL REFERENCES identity_users(user_id),
    membership_id TEXT REFERENCES identity_memberships(membership_id),
    personal_token_id TEXT NOT NULL REFERENCES identity_personal_tokens(personal_token_id),
    session_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
    expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX identity_browser_sessions_prefix_idx ON identity_browser_sessions (prefix, expires_at)`,
  `CREATE TABLE identity_auth_rate_limits (
    bucket TEXT NOT NULL, key_hash TEXT NOT NULL, window_start INTEGER NOT NULL, failures INTEGER NOT NULL,
    PRIMARY KEY (bucket, key_hash)
  )`,
] as const;

export function installIdentityMigrations(db: StateDb): void {
  const ledgerExists = Boolean(db.get(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'identity_migrations'",
  ));
  if (ledgerExists) {
    const markerTableExists = Boolean(db.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'identity_schema_metadata'",
    ));
    const marker = markerTableExists
      ? db.get("SELECT schema_marker FROM identity_schema_metadata WHERE schema_key = 'identity'")?.schema_marker
      : undefined;
    const versions = db.all('SELECT version FROM identity_migrations ORDER BY version')
      .map((row) => Number(row.version));
    if (marker !== IDENTITY_SCHEMA_MARKER || versions.length !== 1 || versions[0] !== 1) {
      throw new Error('TAG_STATE contains an incompatible pre-Slack identity schema; use a fresh deployment.');
    }
    return;
  }
  db.transaction(() => {
    for (const statement of IDENTITY_SCHEMA_V1_STATEMENTS) db.exec(statement);
    db.run(
      'INSERT INTO identity_schema_metadata (schema_key, schema_marker) VALUES (?, ?)',
      'identity', IDENTITY_SCHEMA_MARKER,
    );
    db.run('INSERT INTO identity_migrations (version, applied_at) VALUES (?, ?)', 1, Date.now());
  });
}
