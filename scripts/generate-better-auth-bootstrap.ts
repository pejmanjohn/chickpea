import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { getMigrations } from 'better-auth/db/migration';

import type { BetterAuthDatabaseBackend } from '../src/auth/better-auth-backend.ts';
import { createBetterAuthOptions } from '../src/auth/better-auth.ts';

export const PINNED_BETTER_AUTH_VERSION = '1.7.1';

export async function generateBetterAuthBootstrapSql(): Promise<string> {
  const database = new DatabaseSync(':memory:');
  try {
    const backend = { database } as unknown as BetterAuthDatabaseBackend;
    const options = createBetterAuthOptions({
      backend,
      baseURL: 'https://schema.chickpea.invalid',
      secret: 'schema-only-secret-is-never-used-at-runtime',
    });
    const migrations = await getMigrations(options);
    const generated = (await migrations.compileMigrations()).trim();
    return [
      `-- Generated from better-auth@${PINNED_BETTER_AUTH_VERSION} by scripts/generate-better-auth-bootstrap.ts.`,
      '-- Fresh empty databases only. Do not edit this fixture by hand.',
      generated,
      '',
      '-- Chickpea natural-key invariants absent from Better Auth 1.7.1 generation.',
      'CREATE UNIQUE INDEX "account_providerId_accountId_uidx" ON "account" ("providerId", "accountId");',
      'CREATE UNIQUE INDEX "member_organizationId_userId_uidx" ON "member" ("organizationId", "userId");',
      '',
    ].join('\n');
  } finally {
    database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sql = await generateBetterAuthBootstrapSql();
  const outputPath = process.argv[2];
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, sql);
  } else {
    process.stdout.write(sql);
  }
}
