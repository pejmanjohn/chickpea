import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  IDENTITY_SCHEMA_V1_STATEMENTS,
  installIdentityMigrations,
} from '../src/identity/migrations.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

const NOW = 1_786_000_000_000;

test('identity migrations install the fresh credential schema and are idempotent', () => {
  const db = openStateDb(':memory:');
  try {
    installIdentityMigrations(db);
    installIdentityMigrations(db);

    assert.deepEqual(
      db.all('SELECT version FROM identity_migrations ORDER BY version')
        .map((row) => Number(row.version)),
      [1, 2],
    );
    const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => String(row.name));
    assert.ok(tables.includes('identity_password_credentials'));
    assert.ok(tables.includes('identity_password_reset_capabilities'));
    const sessionColumns = db.all('PRAGMA table_info(identity_browser_sessions)')
      .map((row) => String(row.name));
    for (const column of [
      'membership_id', 'authenticator_kind', 'credential_id', 'credential_version',
      'idle_expires_at', 'absolute_expires_at', 'updated_at',
    ]) assert.ok(sessionColumns.includes(column), column);
    assert.equal(sessionColumns.includes('expires_at'), false);
  } finally {
    db.close();
  }
});

test('identity migration preserves a legacy PAT session without reclassifying it', () => {
  const db = openStateDb(':memory:');
  try {
    for (const statement of IDENTITY_SCHEMA_V1_STATEMENTS) db.exec(statement);
    seedLegacySession(db, true);

    installIdentityMigrations(db);

    const session = db.get(
      'SELECT * FROM identity_browser_sessions WHERE browser_session_id = ?',
      'browser_session_legacy',
    );
    assert.equal(session?.authenticator_kind, 'personal_token');
    assert.equal(session?.personal_token_id, 'personal_token_legacy');
    assert.equal(session?.membership_id, 'membership_owner');
    assert.equal(session?.credential_id, null);
    assert.equal(session?.credential_version, null);
    assert.equal(session?.idle_expires_at, NOW + 60_000);
    assert.equal(session?.absolute_expires_at, NOW + 60_000);
  } finally {
    db.close();
  }
});

test('identity migration rolls back a failed legacy session rebuild', () => {
  const db = openStateDb(':memory:');
  try {
    for (const statement of IDENTITY_SCHEMA_V1_STATEMENTS) db.exec(statement);
    seedLegacySession(db, false);

    assert.throws(() => installIdentityMigrations(db));

    const columns = db.all('PRAGMA table_info(identity_browser_sessions)')
      .map((row) => String(row.name));
    assert.ok(columns.includes('expires_at'));
    assert.equal(columns.includes('authenticator_kind'), false);
    assert.equal(
      db.get(
        'SELECT session_hash FROM identity_browser_sessions WHERE browser_session_id = ?',
        'browser_session_legacy',
      )?.session_hash,
      'legacy-session-hash',
    );
    assert.deepEqual(
      db.all('SELECT version FROM identity_migrations ORDER BY version')
        .map((row) => Number(row.version)),
      [1],
    );
  } finally {
    db.close();
  }
});

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
