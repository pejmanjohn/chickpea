import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { getMigrations } from 'better-auth/db/migration';

import type { BetterAuthDatabaseBackend } from '../src/auth/better-auth-backend.ts';
import { createBetterAuthOptions } from '../src/auth/better-auth.ts';

export const PINNED_BETTER_AUTH_VERSION = '1.7.1';

export type BetterAuthBootstrapDialect = 'sqlite' | 'postgres';

export async function generateBetterAuthBootstrapSql(
  dialect: BetterAuthBootstrapDialect = 'sqlite',
): Promise<string> {
  if (dialect === 'postgres') {
    return bootstrapSql(' (PostgreSQL)', await compileFreshSchema(emptyPostgresSchema()),
      POSTGRES_CONTINUATIONS);
  }
  const database = new DatabaseSync(':memory:');
  try {
    return bootstrapSql('', await compileFreshSchema(database), []);
  } finally {
    database.close();
  }
}

function bootstrapSql(dialectLabel: string, generated: string, chickpeaTables: string[]): string {
  return [
    `-- Generated from better-auth@${PINNED_BETTER_AUTH_VERSION}${dialectLabel} by scripts/generate-better-auth-bootstrap.ts.`,
    '-- Fresh empty databases only. Do not edit this fixture by hand.',
    generated,
    '',
    `-- Chickpea natural-key invariants absent from Better Auth ${PINNED_BETTER_AUTH_VERSION} generation.`,
    'CREATE UNIQUE INDEX "account_providerId_accountId_uidx" ON "account" ("providerId", "accountId");',
    'CREATE UNIQUE INDEX "member_organizationId_userId_uidx" ON "member" ("organizationId", "userId");',
    '',
    ...chickpeaTables,
  ].join('\n');
}

// SQLite gains this table in migration 0002; PostgreSQL history starts with it.
const POSTGRES_CONTINUATIONS = [
  '-- Single-use MCP OAuth continuations. Epoch milliseconds need bigint here.',
  'CREATE TABLE "chickpea_mcp_oauth_continuation" (',
  '  "id_hash" text NOT NULL PRIMARY KEY,',
  '  "authorization_path" text NOT NULL,',
  '  "expires_at" bigint NOT NULL,',
  '  "created_at" bigint NOT NULL',
  ');',
  'CREATE INDEX "chickpea_mcp_oauth_continuation_expires_idx"',
  '  ON "chickpea_mcp_oauth_continuation" ("expires_at");',
  '',
];

async function compileFreshSchema(database: unknown): Promise<string> {
  const backend = { database } as unknown as BetterAuthDatabaseBackend;
  const options = createBetterAuthOptions({
    backend,
    baseURL: 'https://schema.chickpea.invalid',
    secret: 'schema-only-secret-is-never-used-at-runtime',
  });
  const migrations = await getMigrations(options);
  return (await migrations.compileMigrations()).trim();
}

/** Answers Better Auth's introspection as an empty `public` schema, with no server. */
function emptyPostgresSchema() {
  const client = {
    async query(sql: string) {
      if (/^\s*SHOW search_path/i.test(sql)) return { rows: [{ search_path: 'public' }] };
      if (/information_schema\.schemata/i.test(sql)) return { rows: [{ schema_name: 'public' }] };
      return { rows: [] };
    },
    release() {},
  };
  return { connect: async () => client, end: async () => {} };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const dialect = args.includes('--postgres') ? 'postgres' : 'sqlite';
  const sql = await generateBetterAuthBootstrapSql(dialect);
  const outputPath = args.find((arg) => !arg.startsWith('--'));
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, sql);
  } else {
    process.stdout.write(sql);
  }
}
