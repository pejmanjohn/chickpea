import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  IDENTITY_SCHEMA_V1_STATEMENTS,
  installIdentityMigrations,
} from '../src/identity/migrations.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

const NOW = 1_786_000_000_000;

test('fresh identity state installs only legacy compatibility and Chickpea control schema', () => {
  const db = openStateDb(':memory:');
  try {
    installIdentityMigrations(db);
    installIdentityMigrations(db);

    assert.deepEqual(
      db.all('SELECT version FROM identity_migrations ORDER BY version')
        .map((row) => Number(row.version)),
      [1, 2, 3],
    );
    const tables = new Set(
      db.all("SELECT name FROM sqlite_master WHERE type = 'table'")
        .map((row) => String(row.name)),
    );
    for (const table of [
      'identity_auth_controls',
      'identity_auth_operations',
      'identity_membership_access_overlays',
    ]) assert.equal(tables.has(table), true, table);
    assert.equal(tables.has('identity_password_credentials'), false);
    assert.equal(tables.has('identity_password_reset_capabilities'), false);

    assert.deepEqual(foreignKeyTargets(db, 'identity_personal_tokens'), []);
    assert.deepEqual(foreignKeyTargets(db, 'identity_browser_sessions'), []);
    const sessionColumns = tableColumns(db, 'identity_browser_sessions');
    for (const column of [
      'organization_id', 'membership_id', 'personal_token_id', 'expires_at',
    ]) assert.equal(sessionColumns.has(column), true, column);
    assert.equal(sessionColumns.has('credential_id'), false);
  } finally {
    db.close();
  }
});

test('legacy PAT session upgrades without introducing password authority', () => {
  const db = openStateDb(':memory:');
  try {
    for (const statement of IDENTITY_SCHEMA_V1_STATEMENTS) db.exec(statement);
    seedLegacySession(db, true);

    installIdentityMigrations(db);

    const token = db.get(
      'SELECT * FROM identity_personal_tokens WHERE personal_token_id = ?',
      'personal_token_legacy',
    );
    assert.equal(token?.organization_id, 'org_oss');
    assert.equal(token?.membership_id, 'membership_owner');
    const session = db.get(
      'SELECT * FROM identity_browser_sessions WHERE browser_session_id = ?',
      'browser_session_legacy',
    );
    assert.equal(session?.organization_id, 'org_oss');
    assert.equal(session?.membership_id, 'membership_owner');
    assert.equal(session?.expires_at, NOW + 60_000);
    assert.equal(tableExists(db, 'identity_password_credentials'), false);
  } finally {
    db.close();
  }
});

test('bba9f97 unreleased password v2 converges through compatibility migration', () => {
  const db = openStateDb(':memory:');
  try {
    for (const statement of IDENTITY_SCHEMA_V1_STATEMENTS) db.exec(statement);
    seedLegacySession(db, true);
    installUnreleasedPasswordV2(db);

    installIdentityMigrations(db);

    assert.deepEqual(
      db.all('SELECT version FROM identity_migrations ORDER BY version')
        .map((row) => Number(row.version)),
      [1, 2, 3],
    );
    assert.equal(tableExists(db, 'identity_password_credentials'), false);
    assert.equal(tableExists(db, 'identity_password_reset_capabilities'), false);
    const sessions = db.all('SELECT * FROM identity_browser_sessions ORDER BY browser_session_id');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.browser_session_id, 'browser_session_legacy');
    assert.equal(sessions[0]?.membership_id, 'membership_owner');
    assert.equal(tableColumns(db, 'identity_browser_sessions').has('authenticator_kind'), false);
  } finally {
    db.close();
  }
});

function installUnreleasedPasswordV2(db: ReturnType<typeof openStateDb>): void {
  db.exec(
    `CREATE TABLE identity_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`,
  );
  db.run('INSERT INTO identity_migrations (version, applied_at) VALUES (1, ?)', NOW);
  db.run('INSERT INTO identity_migrations (version, applied_at) VALUES (2, ?)', NOW);
  db.exec(
    `CREATE TABLE identity_password_credentials (
      password_credential_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES identity_users(user_id),
      algorithm TEXT NOT NULL,
      parameter_version INTEGER NOT NULL,
      iterations INTEGER NOT NULL,
      salt TEXT NOT NULL,
      verifier TEXT NOT NULL,
      credential_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );
  db.exec(
    `CREATE TABLE identity_password_reset_capabilities (
      password_reset_capability_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES identity_users(user_id),
      token_hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      created_by_membership_id TEXT,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );
  db.exec('DROP INDEX identity_browser_sessions_prefix_idx');
  db.exec('ALTER TABLE identity_browser_sessions RENAME TO identity_browser_sessions_v1');
  db.exec(
    `CREATE TABLE identity_browser_sessions (
      browser_session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES identity_users(user_id),
      membership_id TEXT NOT NULL REFERENCES identity_memberships(membership_id),
      authenticator_kind TEXT NOT NULL,
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
      updated_at INTEGER NOT NULL
    )`,
  );
  db.exec(
    `INSERT INTO identity_browser_sessions (
       browser_session_id, user_id, membership_id, authenticator_kind,
       personal_token_id, credential_id, credential_version, session_hash,
       prefix, idle_expires_at, absolute_expires_at, last_seen_at, revoked_at,
       created_at, updated_at
     )
     SELECT browser_session_id, user_id, 'membership_owner', 'personal_token',
            personal_token_id, NULL, NULL, session_hash, prefix, expires_at,
            expires_at, last_seen_at, revoked_at, created_at, last_seen_at
     FROM identity_browser_sessions_v1`,
  );
  db.exec('DROP TABLE identity_browser_sessions_v1');
  db.exec(
    `CREATE INDEX identity_browser_sessions_prefix_idx
     ON identity_browser_sessions (prefix, idle_expires_at, absolute_expires_at)`,
  );
}

function seedLegacySession(
  db: ReturnType<typeof openStateDb>,
  includeMembership: boolean,
): void {
  db.run(
    `INSERT INTO identity_organizations (
       organization_id, display_name, auth_mode, canonical_admin_origin, created_at, updated_at
     ) VALUES (?, ?, ?, NULL, ?, ?)`,
    'org_oss', 'Chickpea', 'token_active', NOW, NOW,
  );
  db.run(
    `INSERT INTO identity_users (
       user_id, primary_email, display_name, created_at, updated_at
     ) VALUES (?, ?, NULL, ?, ?)`,
    'user_owner', 'owner@example.com', NOW, NOW,
  );
  if (includeMembership) {
    db.run(
      `INSERT INTO identity_memberships (
         membership_id, organization_id, user_id, role, status, created_at, updated_at
       ) VALUES (?, ?, ?, 'owner', 'active', ?, ?)`,
      'membership_owner', 'org_oss', 'user_owner', NOW, NOW,
    );
  }
  db.run(
    `INSERT INTO identity_personal_tokens (
       personal_token_id, user_id, token_hash, prefix, label, status,
       last_used_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
    'personal_token_legacy', 'user_owner', 'legacy-token-hash', 'legacy12', 'Legacy', NOW, NOW,
  );
  db.run(
    `INSERT INTO identity_browser_sessions (
       browser_session_id, user_id, personal_token_id, session_hash, prefix,
       expires_at, last_seen_at, revoked_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    'browser_session_legacy', 'user_owner', 'personal_token_legacy',
    'legacy-session-hash', 'session12', NOW + 60_000, NOW, NOW,
  );
}

function tableExists(db: ReturnType<typeof openStateDb>, table: string): boolean {
  return Boolean(db.get("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?", table));
}

function tableColumns(db: ReturnType<typeof openStateDb>, table: string): Set<string> {
  return new Set(db.all(`PRAGMA table_info(${table})`).map((row) => String(row.name)));
}

function foreignKeyTargets(db: ReturnType<typeof openStateDb>, table: string): string[] {
  return db.all(`PRAGMA foreign_key_list(${table})`).map((row) => String(row.table)).sort();
}
