import type { StateDb } from '../state/state-db.ts';

export const IDENTITY_SCHEMA_VERSION = 4;

interface IdentityMigration {
  version: number;
  apply(db: StateDb): void;
}

/**
 * The shipped U8 schema. Existing Access/token/shared installations continue
 * to use these tables until their mode-specific U14 migration. Fresh password
 * installations never make this directory canonical.
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

const CHICKPEA_CONTROL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS identity_auth_controls (
    installation_id TEXT PRIMARY KEY,
    auth_mode TEXT NOT NULL,
    canonical_admin_origin TEXT,
    better_auth_organization_id TEXT,
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS identity_auth_operations (
    operation_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    organization_id TEXT,
    expected_normalized_email TEXT NOT NULL,
    capability_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'revoked', 'expired')),
    step INTEGER NOT NULL CHECK (step >= 0),
    better_auth_user_id TEXT,
    better_auth_organization_id TEXT,
    better_auth_membership_id TEXT,
    better_auth_invitation_id TEXT,
    target_credential_version INTEGER,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS identity_auth_operations_state_idx
   ON identity_auth_operations (kind, status, expires_at)`,
  `CREATE TABLE IF NOT EXISTS identity_membership_access_overlays (
    membership_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    access_status TEXT NOT NULL CHECK (access_status IN ('active', 'suspended')),
    membership_version INTEGER NOT NULL CHECK (membership_version > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS identity_membership_access_overlays_org_idx
   ON identity_membership_access_overlays (organization_id, access_status)`,
] as const;

const MIGRATIONS: readonly IdentityMigration[] = [
  { version: 1, apply: (db) => runStatements(db, IDENTITY_SCHEMA_V1_STATEMENTS) },
  {
    version: 2,
    apply: (db) => {
      runStatements(db, CHICKPEA_CONTROL_STATEMENTS);
      rebuildChickpeaCredentialTables(db);
    },
  },
  {
    // bba9f97 briefly used version 2 for a custom PBKDF2/session schema. That
    // code never shipped, but this compatibility step makes an existing dev
    // database converge without re-running or trusting that schema.
    version: 3,
    apply: (db) => {
      runStatements(db, CHICKPEA_CONTROL_STATEMENTS);
      rebuildChickpeaCredentialTables(db);
      db.exec('DROP TABLE IF EXISTS identity_password_reset_capabilities');
      db.exec('DROP TABLE IF EXISTS identity_password_credentials');
    },
  },
  {
    version: 4,
    apply: (db) => runStatements(db, [
      `CREATE TABLE IF NOT EXISTS identity_actor_external_bindings (
        binding_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider = 'slack'),
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        user_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        membership_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (provider, issuer, subject)
      )`,
      `CREATE TABLE IF NOT EXISTS identity_actor_binding_handoffs (
        handoff_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        slack_identity_id TEXT NOT NULL,
        slack_identity_revision INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      )`,
    ]),
  },
];

/** Apply each Chickpea state change exactly once on Node or DO SQLite. */
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
      migration.apply(db);
      db.run(
        'INSERT INTO identity_migrations (version, applied_at) VALUES (?, ?)',
        migration.version,
        Date.now(),
      );
    });
  }
}

function runStatements(db: StateDb, statements: readonly string[]): void {
  for (const statement of statements) db.exec(statement);
}

function rebuildChickpeaCredentialTables(db: StateDb): void {
  rebuildLegacyBrowserSessions(db);
  rebuildPersonalTokens(db);
}

function rebuildPersonalTokens(db: StateDb): void {
  const columns = tableColumns(db, 'identity_personal_tokens');
  if (columns.has('organization_id') && columns.has('membership_id')) return;

  db.exec('DROP INDEX IF EXISTS identity_personal_tokens_prefix_idx');
  db.exec('ALTER TABLE identity_personal_tokens RENAME TO identity_personal_tokens_pre_control');
  db.exec(
    `CREATE TABLE identity_personal_tokens (
      personal_token_id TEXT PRIMARY KEY,
      organization_id TEXT,
      user_id TEXT NOT NULL,
      membership_id TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL,
      last_used_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );
  db.exec(
    `INSERT INTO identity_personal_tokens (
       personal_token_id, organization_id, user_id, membership_id, token_hash,
       prefix, label, status, last_used_at, created_at, updated_at
     )
     SELECT token.personal_token_id,
            (SELECT membership.organization_id FROM identity_memberships membership
             WHERE membership.user_id = token.user_id ORDER BY membership.created_at LIMIT 1),
            token.user_id,
            (SELECT membership.membership_id FROM identity_memberships membership
             WHERE membership.user_id = token.user_id ORDER BY membership.created_at LIMIT 1),
            token.token_hash, token.prefix, token.label, token.status,
            token.last_used_at, token.created_at, token.updated_at
     FROM identity_personal_tokens_pre_control token`,
  );
  db.exec('DROP TABLE identity_personal_tokens_pre_control');
  db.exec(
    `CREATE INDEX identity_personal_tokens_prefix_idx
     ON identity_personal_tokens (prefix, status)`,
  );
}

function rebuildLegacyBrowserSessions(db: StateDb): void {
  const columns = tableColumns(db, 'identity_browser_sessions');
  if (columns.has('organization_id') && columns.has('membership_id') && columns.has('expires_at')) {
    return;
  }

  const generalized = columns.has('authenticator_kind');
  db.exec('DROP INDEX IF EXISTS identity_browser_sessions_prefix_idx');
  db.exec('DROP INDEX IF EXISTS identity_browser_sessions_credential_idx');
  db.exec('ALTER TABLE identity_browser_sessions RENAME TO identity_browser_sessions_pre_control');
  db.exec(
    `CREATE TABLE identity_browser_sessions (
      browser_session_id TEXT PRIMARY KEY,
      organization_id TEXT,
      user_id TEXT NOT NULL,
      membership_id TEXT,
      personal_token_id TEXT NOT NULL,
      session_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL
    )`,
  );
  if (generalized) {
    db.exec(
      `INSERT INTO identity_browser_sessions (
         browser_session_id, organization_id, user_id, membership_id,
         personal_token_id, session_hash, prefix, expires_at, last_seen_at,
         revoked_at, created_at
       )
       SELECT session.browser_session_id,
              (SELECT membership.organization_id FROM identity_memberships membership
               WHERE membership.membership_id = session.membership_id),
              session.user_id, session.membership_id, session.personal_token_id,
              session.session_hash, session.prefix,
              MIN(session.idle_expires_at, session.absolute_expires_at),
              session.last_seen_at, session.revoked_at, session.created_at
       FROM identity_browser_sessions_pre_control session
       WHERE session.authenticator_kind = 'personal_token'
         AND session.personal_token_id IS NOT NULL`,
    );
  } else {
    db.exec(
      `INSERT INTO identity_browser_sessions (
         browser_session_id, organization_id, user_id, membership_id,
         personal_token_id, session_hash, prefix, expires_at, last_seen_at,
         revoked_at, created_at
       )
       SELECT session.browser_session_id,
              (SELECT membership.organization_id FROM identity_memberships membership
               WHERE membership.user_id = session.user_id ORDER BY membership.created_at LIMIT 1),
              session.user_id,
              (SELECT membership.membership_id FROM identity_memberships membership
               WHERE membership.user_id = session.user_id ORDER BY membership.created_at LIMIT 1),
              session.personal_token_id, session.session_hash, session.prefix,
              session.expires_at, session.last_seen_at, session.revoked_at, session.created_at
       FROM identity_browser_sessions_pre_control session`,
    );
  }
  db.exec('DROP TABLE identity_browser_sessions_pre_control');
  db.exec(
    `CREATE INDEX identity_browser_sessions_prefix_idx
     ON identity_browser_sessions (prefix, expires_at)`,
  );
}

function tableColumns(db: StateDb, table: string): Set<string> {
  return new Set(db.all(`PRAGMA table_info(${table})`).map((row) => String(row.name)));
}
