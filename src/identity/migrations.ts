import type { StateDb } from '../state/state-db.ts';

export const IDENTITY_SCHEMA_VERSION = 2;

interface IdentityMigration {
  version: number;
  statements: readonly string[];
}

/**
 * The schema that existed before identity migrations were introduced. Keeping
 * it as migration 1 lets a fresh database and an existing OSS database take
 * the same numbered path without guessing which target is running it.
 */
export const IDENTITY_SCHEMA_V1_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS identity_organizations (
    organization_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    auth_mode TEXT NOT NULL,
    canonical_admin_origin TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS identity_users (
    user_id TEXT PRIMARY KEY,
    primary_email TEXT NOT NULL,
    display_name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
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
  `CREATE TABLE IF NOT EXISTS identity_owner_claims (
    owner_claim_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL UNIQUE REFERENCES identity_organizations(organization_id),
    normalized_email TEXT NOT NULL,
    status TEXT NOT NULL,
    binding_id TEXT REFERENCES identity_external_bindings(binding_id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
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
  `CREATE INDEX IF NOT EXISTS identity_invitations_state_idx
   ON identity_invitations (organization_id, status, expires_at)`,
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
  `CREATE INDEX IF NOT EXISTS identity_personal_tokens_prefix_idx
   ON identity_personal_tokens (prefix, status)`,
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
  `CREATE INDEX IF NOT EXISTS identity_browser_sessions_prefix_idx
   ON identity_browser_sessions (prefix, expires_at)`,
  `CREATE TABLE IF NOT EXISTS identity_auth_provider_configs (
    auth_provider_config_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES identity_organizations(organization_id),
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    issuer TEXT,
    audience TEXT,
    admission_state TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (organization_id, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS identity_auth_rate_limits (
    bucket TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    failures INTEGER NOT NULL,
    PRIMARY KEY (bucket, key_hash)
  )`,
] as const;

const GENERALIZED_CREDENTIAL_STATEMENTS = [
  `CREATE TABLE identity_password_credentials (
    password_credential_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES identity_users(user_id),
    algorithm TEXT NOT NULL,
    parameter_version INTEGER NOT NULL CHECK (parameter_version > 0),
    iterations INTEGER NOT NULL CHECK (iterations > 0),
    salt TEXT NOT NULL,
    verifier TEXT NOT NULL,
    credential_version INTEGER NOT NULL CHECK (credential_version > 0),
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX identity_password_credentials_active_user_idx
   ON identity_password_credentials (user_id) WHERE status = 'active'`,
  `CREATE TABLE identity_password_reset_capabilities (
    password_reset_capability_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES identity_users(user_id),
    token_hash TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('admin_reset', 'owner_recovery')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'revoked', 'expired')),
    created_by_membership_id TEXT REFERENCES identity_memberships(membership_id),
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX identity_password_reset_capabilities_state_idx
   ON identity_password_reset_capabilities (user_id, status, expires_at)`,
  'DROP INDEX identity_browser_sessions_prefix_idx',
  'ALTER TABLE identity_browser_sessions RENAME TO identity_browser_sessions_legacy',
  `CREATE TABLE identity_browser_sessions (
    browser_session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES identity_users(user_id),
    membership_id TEXT NOT NULL REFERENCES identity_memberships(membership_id),
    authenticator_kind TEXT NOT NULL CHECK (authenticator_kind IN ('password', 'personal_token')),
    personal_token_id TEXT REFERENCES identity_personal_tokens(personal_token_id),
    credential_id TEXT REFERENCES identity_password_credentials(password_credential_id),
    credential_version INTEGER,
    session_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    idle_expires_at INTEGER NOT NULL,
    absolute_expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (idle_expires_at <= absolute_expires_at),
    CHECK (
      (authenticator_kind = 'personal_token' AND personal_token_id IS NOT NULL AND
       credential_id IS NULL AND credential_version IS NULL) OR
      (authenticator_kind = 'password' AND personal_token_id IS NULL AND
       credential_id IS NOT NULL AND credential_version > 0)
    )
  )`,
  `INSERT INTO identity_browser_sessions (
     browser_session_id, user_id, membership_id, authenticator_kind,
     personal_token_id, credential_id, credential_version, session_hash, prefix,
     idle_expires_at, absolute_expires_at, last_seen_at, revoked_at, created_at, updated_at
   )
   SELECT legacy.browser_session_id, legacy.user_id,
          (SELECT membership_id FROM identity_memberships membership
           WHERE membership.user_id = legacy.user_id ORDER BY membership.created_at LIMIT 1),
          'personal_token', legacy.personal_token_id, NULL, NULL,
          legacy.session_hash, legacy.prefix, legacy.expires_at, legacy.expires_at,
          legacy.last_seen_at, legacy.revoked_at, legacy.created_at, legacy.last_seen_at
   FROM identity_browser_sessions_legacy legacy`,
  'DROP TABLE identity_browser_sessions_legacy',
  `CREATE INDEX identity_browser_sessions_prefix_idx
   ON identity_browser_sessions (prefix, idle_expires_at, absolute_expires_at)`,
  `CREATE INDEX identity_browser_sessions_credential_idx
   ON identity_browser_sessions (credential_id, credential_version, revoked_at)`,
] as const;

const MIGRATIONS: readonly IdentityMigration[] = [
  { version: 1, statements: IDENTITY_SCHEMA_V1_STATEMENTS },
  { version: 2, statements: GENERALIZED_CREDENTIAL_STATEMENTS },
];

/** Apply each identity schema change exactly once on Node or DO SQLite. */
export function installIdentityMigrations(db: StateDb): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS identity_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`,
  );
  for (const migration of MIGRATIONS) {
    db.transaction(() => {
      if (db.get('SELECT 1 AS applied FROM identity_migrations WHERE version = ?', migration.version)) {
        return;
      }
      for (const statement of migration.statements) db.exec(statement);
      db.run(
        'INSERT INTO identity_migrations (version, applied_at) VALUES (?, ?)',
        migration.version,
        Date.now(),
      );
    });
  }
}
