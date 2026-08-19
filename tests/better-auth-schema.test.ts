import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  generateBetterAuthBootstrapSql,
  PINNED_BETTER_AUTH_VERSION,
} from '../scripts/generate-better-auth-bootstrap.ts';

const PRIOR_SCHEMA = new URL('./fixtures/better-auth/1.6.26/0001_better_auth.sql', import.meta.url);
const CURRENT_SCHEMA = new URL('./fixtures/better-auth/1.7.1/0001_better_auth.sql', import.meta.url);
const FORWARD_MIGRATION = new URL('../migrations/better-auth/0002_mcp_oauth.sql', import.meta.url);

test('Better Auth 1.7.1 fresh schema stays pinned to the configured plugins', async () => {
  assert.equal(PINNED_BETTER_AUTH_VERSION, '1.7.1');
  const generated = await generateBetterAuthBootstrapSql();
  assert.equal(generated, await readFile(CURRENT_SCHEMA, 'utf8'));
  for (const required of [
    '"issuer" text not null',
    'create table "jwks"',
    'create table "oauthClient"',
    'create table "oauthResource"',
    'create table "oauthRefreshToken"',
    'create table "oauthAccessToken"',
    'create table "oauthConsent"',
    'account_issuer_accountId_uidx',
  ]) {
    assert.match(generated, new RegExp(required, 'i'), required);
  }
});

test('the additive MCP OAuth migration upgrades the 1.6.26 schema without losing Slack identity', async () => {
  const [priorSql, currentSql, migrationSql] = await Promise.all([
    readFile(PRIOR_SCHEMA, 'utf8'),
    readFile(CURRENT_SCHEMA, 'utf8'),
    readFile(FORWARD_MIGRATION, 'utf8'),
  ]);
  const fresh = new DatabaseSync(':memory:');
  const upgraded = new DatabaseSync(':memory:');
  try {
    fresh.exec(currentSql);
    upgraded.exec(priorSql);
    upgraded.prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('user_1', 'Owner', 'owner@identity.invalid', 0, 1, 1);
    upgraded.prepare(
      `INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('account_1', 'slack:TACME:UOWNER', 'slack', 'user_1', 1, 1);
    upgraded.exec(migrationSql);

    const freshTables = tableNames(fresh);
    const upgradedBetterAuthTables = tableNames(upgraded).filter(
      (name) => name !== 'chickpea_mcp_oauth_continuation',
    );
    assert.deepEqual(upgradedBetterAuthTables, freshTables);
    for (const table of freshTables) {
      assert.deepEqual(tableShape(upgraded, table), tableShape(fresh, table), table);
    }
    assert.equal(
      upgraded.prepare('SELECT issuer FROM account WHERE id = ?').get('account_1')?.issuer,
      'local:slack',
    );
    assert.equal(
      tableNames(upgraded).includes('chickpea_mcp_oauth_continuation'),
      true,
    );
  } finally {
    fresh.close();
    upgraded.close();
  }
});

function tableNames(database: DatabaseSync): string[] {
  return database.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  ).all().map((row) => String(row.name));
}

function tableShape(database: DatabaseSync, table: string): Array<{
  name: string;
  type: string;
  notnull: number;
  pk: number;
}> {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(table)) throw new Error('Unsafe table name.');
  return database.prepare(`PRAGMA table_info("${table}")`).all().map((row) => ({
    name: String(row.name),
    type: String(row.type).toLowerCase(),
    notnull: Number(row.notnull),
    pk: Number(row.pk),
  })).sort((left, right) => left.name.localeCompare(right.name));
}
