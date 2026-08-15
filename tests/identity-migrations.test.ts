import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  IDENTITY_SCHEMA_MARKER,
  installIdentityMigrations,
} from '../src/identity/migrations.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

test('fresh TAG_STATE installs one Slack-native identity schema in place', () => {
  const db = openStateDb(':memory:');
  try {
    installIdentityMigrations(db);
    installIdentityMigrations(db);
    assert.deepEqual(
      db.all('SELECT version FROM identity_migrations').map((row) => Number(row.version)),
      [1],
    );
    assert.equal(
      db.get("SELECT schema_marker FROM identity_schema_metadata WHERE schema_key = 'identity'")?.schema_marker,
      IDENTITY_SCHEMA_MARKER,
    );
    const sql = db.all(
      "SELECT sql FROM sqlite_master WHERE type IN ('table', 'index') AND name LIKE 'identity_%'",
    ).map((row) => String(row.sql ?? '')).join('\n').toLowerCase();
    assert.match(sql, /slack_team_id/);
    assert.match(sql, /slack_user_id/);
    assert.match(sql, /recovery_only/);
    assert.match(sql, /identity_slack_credential_controls/);
    assert.match(sql, /identity_slack_credential_revisions/);
    assert.match(sql, /identity_slack_setup_transactions/);
    assert.match(sql, /ambiguous_external_effect/);
    assert.match(sql, /ciphertext/);
    assert.match(sql, /rotation_epoch/);
    assert.doesNotMatch(sql, /bot_token|signing_secret|client_secret/);
    assert.doesNotMatch(sql, /email/);
    assert.doesNotMatch(sql, /password/);
    assert.doesNotMatch(sql, /actor_identity_binding_handoff/);
  } finally {
    db.close();
  }
});

test('an existing pre-Slack ledger fails closed instead of migrating', () => {
  const db = openStateDb(':memory:');
  try {
    db.exec('CREATE TABLE identity_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    db.run('INSERT INTO identity_migrations (version, applied_at) VALUES (1, 1)');
    assert.throws(
      () => installIdentityMigrations(db),
      /incompatible pre-Slack identity schema; use a fresh deployment/,
    );
  } finally {
    db.close();
  }
});
