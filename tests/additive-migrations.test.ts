import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Release tooling JavaScript helper.
import { additiveMigrationFindings, isMigrationSource } from '../scripts/lib/additive-migrations.mjs';

const D1 = 'migrations/better-auth/0001_base.sql';
const NEXT = 'migrations/better-auth/0002_next.sql';
const WORK = 'src/work/migrations.ts';
const CONFIG = 'src/config/store.ts';

const BASE: Record<string, string> = {
  [D1]: `CREATE TABLE "user" ("id" text NOT NULL PRIMARY KEY, "name" text NOT NULL, "email" text);
CREATE INDEX "user_email_idx" ON "user" ("email");`,
  [WORK]: `const STATEMENTS = [
  \`CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('queued', 'done')),
    attempts INTEGER NOT NULL DEFAULT 0,
    note TEXT
  )\`,
  'CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (status)',
  'INSERT INTO app_migrations (domain, version, applied_at) VALUES (?, ?, ?)',
];`,
  [CONFIG]: `db.exec(\`CREATE TABLE config_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT
)\`);
db.run('UPDATE config_agents SET name = ? WHERE id = ?', name, id);`,
};

/** Findings with the shared remedy cut off, for the source `edit` makes from BASE. */
function findings(edit: Record<string, string | undefined>): string[] {
  const head = new Map(Object.entries({ ...BASE, ...edit }).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return additiveMigrationFindings(new Map(Object.entries(BASE)), head)
    .map((finding: string) => finding.replace(/ Migrations only add: .*$/, ''));
}

const work = (from: string, to: string) => ({ [WORK]: BASE[WORK]!.replace(from, to) });
const config = (from: string, to: string) => ({ [CONFIG]: BASE[CONFIG]!.replace(from, to) });

test('the check covers the Durable Object migration sources and the D1 chain', () => {
  for (const path of ['src/identity/migrations.ts', WORK, CONFIG, D1]) assert.equal(isMigrationSource(path), true, path);
  for (const path of ['src/config/snapshot-store.ts', 'migrations/other/0001.sql', 'migrations/better-auth/README.md']) {
    assert.equal(isMigrationSource(path), false, path);
  }
});

test('unchanged sources, and code edits around them, are additive', () => {
  assert.deepEqual(findings({}), []);
  assert.deepEqual(findings({ [CONFIG]: `// Store setup.\n${BASE[CONFIG]}\nconst label = 'Create the Agent first';` }), []);
});

test('allowed: a new table, a new index, and a nullable or constant-default column', () => {
  assert.deepEqual(findings({ [NEXT]: `CREATE TABLE "session" ("id" text NOT NULL PRIMARY KEY, "userId" text NOT NULL);
CREATE UNIQUE INDEX "session_user_idx" ON "session" ("userId");
ALTER TABLE "user" ADD COLUMN "image" text;
ALTER TABLE "user" ADD COLUMN "issuer" text NOT NULL DEFAULT 'local:slack';
ALTER TABLE "user" ADD COLUMN "banned" integer NOT NULL DEFAULT 0;` }), []);
  assert.deepEqual(findings(work("'INSERT", `'CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, owner TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS runs_note_idx ON runs (note)',
  'ALTER TABLE runs ADD COLUMN finished_at INTEGER',
  'INSERT`)), []);
});

test('allowed: a column added to an existing table where it is created, nullable or with a constant default', () => {
  assert.deepEqual(findings(config('model TEXT\n', "model TEXT,\n  kind TEXT NOT NULL DEFAULT 'user',\n  archived_at INTEGER\n")), []);
});

test('allowed: a default changed or NOT NULL dropped on an existing column', () => {
  assert.deepEqual(findings(work('attempts INTEGER NOT NULL DEFAULT 0', 'attempts INTEGER DEFAULT 1')), []);
});

test('allowed: a contraction marked "-- contract:" with its reason', () => {
  assert.deepEqual(findings({ [NEXT]: `-- contract: no code has read email since v0.1.30
DROP INDEX "user_email_idx";
-- contract: no code has read email since v0.1.30
ALTER TABLE "user" DROP COLUMN "email";` }), []);
  assert.deepEqual(findings({
    [CONFIG]: `${BASE[CONFIG]!.replace(',\n  model TEXT', '')}\ndb.exec('ALTER TABLE config_agents DROP COLUMN model -- contract: unused since v0.1.40');`,
  }), []);
  assert.deepEqual(findings({
    ...config(',\n  model TEXT', ''),
    [NEXT]: '-- contract: unused since v0.1.40\nALTER TABLE config_agents DROP COLUMN model;',
  }), ['src/config/store.ts:1: drops column config_agents.model.'],
  'a contraction in one database does not cover the other');
});

test('refused: drops', () => {
  assert.deepEqual(findings({ [NEXT]: 'DROP TABLE "user";' }), [`${NEXT}:1: drop table "user" drops.`]);
  assert.deepEqual(findings({ [NEXT]: 'ALTER TABLE "user" DROP COLUMN "email";' }), [`${NEXT}:1: alter table "user" drop column "email" drops.`]);
  assert.deepEqual(findings(config(',\n  model TEXT', '')), ['src/config/store.ts:1: drops column config_agents.model.']);
  assert.deepEqual(findings({ [CONFIG]: undefined }), ['src/config/store.ts:1: drops table config_agents.']);
  assert.deepEqual(findings(work("  'CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (status)',\n", '')),
    ['src/work/migrations.ts:8: drops index runs_status_idx.']);
});

test('refused: renames', () => {
  assert.deepEqual(findings({ [NEXT]: 'ALTER TABLE "user" RENAME TO "member";\nALTER TABLE "user" RENAME COLUMN "name" TO "label";' }), [
    `${NEXT}:1: alter table "user" rename to "member" renames.`,
    `${NEXT}:2: alter table "user" rename column "name" to "label" renames.`,
  ]);
});

test('refused: a type change', () => {
  assert.deepEqual(findings(work('note TEXT', 'note BLOB')), ['src/work/migrations.ts:2: changes the type of column runs.note from text to blob.']);
});

test('refused: a changed CHECK or table constraint on existing data', () => {
  assert.deepEqual(findings(work("('queued', 'done')", "('queued', 'running', 'done')")),
    ['src/work/migrations.ts:2: changes the constraints of column runs.status.']);
  assert.deepEqual(findings(work('note TEXT\n', 'note TEXT,\n    UNIQUE (status, note)\n')),
    ['src/work/migrations.ts:2: changes the table constraints of runs.']);
  assert.deepEqual(findings(work('ON runs (status)', 'ON runs (status, note)')), ['src/work/migrations.ts:8: changes index runs_status_idx.']);
});

test('refused: a data rewrite', () => {
  assert.deepEqual(findings({ [NEXT]: `UPDATE "user" SET "name" = lower("name");
DELETE FROM "user" WHERE "email" IS NULL;
INSERT INTO "user" ("id", "name") SELECT "id", "name" FROM "user";
INSERT OR REPLACE INTO "user" ("id", "name") VALUES ('a', 'b');` }), [
    `${NEXT}:1: update "user" set "name" = lower("name") rewrites data.`,
    `${NEXT}:2: delete from "user" where "email" is null rewrites data.`,
    `${NEXT}:3: insert into "user"("id","name")select "id","name" from "user" rewrites data.`,
    `${NEXT}:4: insert or replace into "user"("id","name")values('a','b') rewrites data.`,
  ]);
});

test('the config store\'s own queries are not migrations', () => {
  assert.deepEqual(findings({ [CONFIG]: `${BASE[CONFIG]}\ndb.run('DELETE FROM config_agents WHERE id = ?', id);` }), []);
});

test('refused: NOT NULL added to an existing column, or a new NOT NULL column without a constant default', () => {
  assert.deepEqual(findings(work('note TEXT', 'note TEXT NOT NULL')), ['src/work/migrations.ts:2: adds NOT NULL to existing column runs.note.']);
  assert.deepEqual(findings(config('model TEXT\n', 'model TEXT,\n  credential_incarnation TEXT NOT NULL\n')),
    ['src/config/store.ts:1: adds NOT NULL column config_agents.credential_incarnation without a constant default.']);
  assert.deepEqual(findings({ [NEXT]: `ALTER TABLE "user" ADD COLUMN "joined" integer NOT NULL;
ALTER TABLE "user" ADD COLUMN "seen" integer NOT NULL DEFAULT (unixepoch());` }), [
    `${NEXT}:1: alter table "user" add column "joined" integer not null adds NOT NULL column joined without a constant default.`,
    `${NEXT}:2: alter table "user" add column "seen" integer not null default(unixepoch()) adds NOT NULL column seen without a constant default.`,
  ]);
});

test('refused: an edited or removed applied D1 migration, and a statement the check does not recognize', () => {
  assert.deepEqual(findings({ [D1]: `${BASE[D1]}\nCREATE INDEX "user_name_idx" ON "user" ("name");` }),
    [`${D1}: edits an applied D1 migration. Add a new migration file instead.`]);
  assert.deepEqual(findings({ [D1]: undefined }).slice(0, 1), [`${D1}: removes an applied D1 migration. Add a new migration file instead.`]);
  assert.deepEqual(findings({ [NEXT]: 'CREATE TRIGGER "user_touch" AFTER UPDATE ON "user" BEGIN SELECT 1; END;' }).length, 1);
});

test('every refusal names the remedy: expand, then contract in a later release', () => {
  const [finding] = additiveMigrationFindings(new Map(Object.entries(BASE)), new Map(Object.entries({ ...BASE, [NEXT]: 'DROP TABLE "user";' })));
  assert.match(finding, /Migrations only add: expand now, and contract in a later release once no code uses the old shape/);
});
