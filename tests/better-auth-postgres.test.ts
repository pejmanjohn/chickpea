import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';

import { getMigrations } from 'better-auth/db/migration';
import pg from 'pg';

import { createBetterAuth, createBetterAuthOptions } from '../src/auth/better-auth.ts';
import {
  openPostgresBetterAuthBackend,
  PostgresBetterAuthBackend,
  type PostgresBetterAuthPool,
} from '../src/auth/better-auth-postgres.ts';
import { applyPostgresBetterAuthMigrations } from '../src/auth/better-auth-postgres-migrations.ts';
import { betterAuthBackendContract } from './helpers/better-auth-backend-contract.ts';
import { startPostgresTestCluster, type PostgresTestClusterStart } from './helpers/postgres-cluster.ts';

const MIGRATIONS = path.resolve('migrations/better-auth-postgres');
const ORIGIN = 'https://chickpea.example';

// Skipped only when CHICKPEA_TEST_POSTGRES_BIN is set empty; a missing server fails.
let started: Promise<PostgresTestClusterStart> | undefined;
const cluster = () => started ??= startPostgresTestCluster();
after(async () => (await started?.catch(() => undefined))?.cluster?.stop());

/** Cleanup that runs last-in, first-out when the test ends. */
function deferrals(t: TestContext) {
  const steps: Array<() => unknown> = [];
  t.after(async () => {
    for (const step of steps.reverse()) await step();
  });
  return (step: () => unknown) => void steps.push(step);
}

/** A fresh database, dropped when the test ends. */
async function database(t: TestContext, defer: ReturnType<typeof deferrals>) {
  const result = await cluster();
  if (!result.cluster) {
    t.skip(result.skip);
    return undefined;
  }
  const created = await result.cluster.createDatabase();
  defer(() => created.drop());
  return { ...result.cluster.connection, database: created.name };
}

async function migrate(config: pg.PoolConfig): Promise<void> {
  const migrator = new pg.Pool({ ...config, max: 1 });
  try {
    await applyPostgresBetterAuthMigrations(migrator);
  } finally {
    await migrator.end();
  }
}

const contract = betterAuthBackendContract({
  label: 'PostgreSQL',
  skip: async () => (await cluster()).skip,
  async open() {
    const { cluster: running } = await cluster();
    assert.ok(running);
    const created = await running.createDatabase();
    const config = { ...running.connection, database: created.name };
    await migrate(config);
    // The production request-scoped pool, so concurrency stays within its default limit.
    const backend = openPostgresBetterAuthBackend(config);
    return {
      backend,
      async count(table) {
        const result = await backend.pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM "${table}"`,
        );
        return result.rows[0]?.count ?? 0;
      },
      async close() {
        await backend.close();
        await created.drop();
      },
    };
  },
});
for (const { name, run } of contract) test(name, { timeout: 60_000 }, run);

test('PostgreSQL migrations apply once and leave nothing for Better Auth to add', async (t) => {
  const defer = deferrals(t);
  const config = await database(t, defer);
  if (!config) return;
  const pool = new pg.Pool(config);
  defer(() => pool.end());
  assert.deepEqual(await applyPostgresBetterAuthMigrations(pool), ['0001_better_auth.sql']);
  assert.deepEqual(await applyPostgresBetterAuthMigrations(pool), []);
  const ledger = await pool.query('SELECT name, digest FROM chickpea_better_auth_migrations');
  assert.deepEqual(ledger.rows, [{
    name: '0001_better_auth.sql',
    digest: createHash('sha256')
      .update(readFileSync(path.join(MIGRATIONS, '0001_better_auth.sql'))).digest('hex'),
  }]);

  // Better Auth's own planner, over Chickpea's production options, finds the
  // migrated schema complete: the committed history matches 1.7.1's schema.
  const backend = new PostgresBetterAuthBackend(pool);
  const plan = await getMigrations(createBetterAuthOptions({
    backend, baseURL: ORIGIN, secret: randomBytes(32).toString('base64url'),
  }));
  assert.deepEqual(
    [plan.toBeCreated, plan.toBeAdded, plan.toBeAddedIndexes, plan.unsafeChanges],
    [[], [], [], []],
  );

  const columns = await pool.query(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
     WHERE (table_name, column_name) IN (('chickpea_mcp_oauth_continuation', 'expires_at'),
       ('chickpea_mcp_oauth_continuation', 'created_at'), ('session', 'absoluteExpiresAt'),
       ('user', 'id')) ORDER BY table_name, column_name`,
  );
  assert.deepEqual(columns.rows.map((row) => `${row.table_name}.${row.column_name} ${row.data_type}`), [
    'chickpea_mcp_oauth_continuation.created_at bigint',
    'chickpea_mcp_oauth_continuation.expires_at bigint',
    'session.absoluteExpiresAt timestamp with time zone',
    'user.id uuid',
  ]);
  const unique = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexname = ANY($1)
     ORDER BY indexname`,
    [[
      'account_issuer_accountId_uidx', 'account_providerId_accountId_uidx',
      'member_organizationId_userId_uidx', 'oauthClientResource_clientId_resourceId_uidx',
    ]],
  );
  assert.equal(unique.rowCount, 4);
});

test('PostgreSQL migrations refuse a changed history or an unledgered schema', async (t) => {
  const defer = deferrals(t);
  const config = await database(t, defer);
  if (!config) return;
  const pool = new pg.Pool(config);
  defer(() => pool.end());
  await applyPostgresBetterAuthMigrations(pool);
  const edited = mkdtempSync(path.join(tmpdir(), 'chickpea-pg-migrations-'));
  defer(() => rmSync(edited, { recursive: true, force: true }));
  cpSync(MIGRATIONS, edited, { recursive: true });
  writeFileSync(path.join(edited, '0001_better_auth.sql'),
    `${readFileSync(path.join(MIGRATIONS, '0001_better_auth.sql'), 'utf8')}\n-- edited\n`);
  await assert.rejects(applyPostgresBetterAuthMigrations(pool, edited), /incompatible Better Auth migration history/);

  const other = await database(t, defer);
  assert.ok(other);
  const unledgered = new pg.Pool(other);
  defer(() => unledgered.end());
  await unledgered.query('CREATE TABLE "user" (id text PRIMARY KEY)');
  await assert.rejects(applyPostgresBetterAuthMigrations(unledgered), /incompatible Better Auth migration history/);
  const ledger = await unledgered.query("SELECT to_regclass('chickpea_better_auth_migrations') AS ledger");
  assert.equal(ledger.rows[0]?.ledger, null, 'a refused run leaves no ledger behind');
});

test('concurrent PostgreSQL migration runs apply the schema once', async (t) => {
  const defer = deferrals(t);
  const config = await database(t, defer);
  if (!config) return;
  const pools = [new pg.Pool(config), new pg.Pool(config)];
  defer(() => Promise.all(pools.map((pool) => pool.end())));
  const results = await Promise.all(pools.map((pool) => applyPostgresBetterAuthMigrations(pool)));
  assert.deepEqual(results.map((names) => names.length).sort(), [0, 1]);
  assert.equal((await pools[0]!.query('SELECT count(*)::int AS n FROM chickpea_better_auth_migrations')).rows[0]?.n, 1);
});

test('the PostgreSQL backend sets no session state and returns every connection', async (t) => {
  const config = await database(t, deferrals(t));
  if (!config) return;
  await migrate(config);

  const statements: string[] = [];
  const pool = new pg.Pool({ ...config, max: 4 });
  const backend = new PostgresBetterAuthBackend(recording(pool, statements));
  const auth = createBetterAuth({
    backend, baseURL: ORIGIN, secret: randomBytes(32).toString('base64url'),
  });
  await auth.$context;
  const identity = await auth.chickpea.reconcileSlackIdentity({
    slackTeamId: 'TAAAA', slackUserId: 'U0001', displayName: 'Owner',
    organization: { name: 'chickpea-org_a', slug: 'chickpea-org_a' },
  });
  await backend.listMemberships(identity.organizationId);
  await backend.revokeOAuthGrantsForUser(identity.userId);
  await backend.deleteSessionsForUser(identity.userId);

  assert.ok(statements.length > 5);
  const sessionState = statements.filter((sql) =>
    /^\s*(SET|RESET|DISCARD|LISTEN|PREPARE|DEALLOCATE)\b/i.test(sql) || /\bset_config\s*\(/i.test(sql));
  assert.deepEqual(sessionState, []);
  assert.equal(pool.waitingCount, 0);
  assert.equal(pool.idleCount, pool.totalCount, 'every checked-out connection was released');

  await backend.close();
  await assert.rejects(backend.getUser(identity.userId));
  assert.equal(await activeConnections(config, { settle: true }), 0, 'closing the backend closes its connections');
});

test('a request-scoped PostgreSQL backend closes every connection it opened', async (t) => {
  const config = await database(t, deferrals(t));
  if (!config) return;
  await migrate(config);
  for (let request = 0; request < 3; request += 1) {
    const backend = openPostgresBetterAuthBackend(config);
    await Promise.all([
      backend.hasIdentityAuthority(),
      backend.countMcpOAuthClients(),
      backend.absoluteExpiryForToken('missing'),
    ]);
    assert.ok(await activeConnections(config) >= 1);
    await backend.close();
    assert.equal(await activeConnections(config, { settle: true }), 0);
  }
});

/** Records every statement sent through the pool or a client checked out of it. */
function recording(pool: pg.Pool, statements: string[]): PostgresBetterAuthPool {
  const text = (query: unknown) => typeof query === 'string' ? query : String((query as { text?: unknown })?.text);
  const query = (target: { query: (...args: never[]) => unknown }) =>
    (...args: unknown[]) => {
      statements.push(text(args[0]));
      return (target.query as (...rest: unknown[]) => unknown).apply(target, args);
    };
  return {
    query: query(pool),
    async connect() {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === 'query') return query(target);
          const value: unknown = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    end: () => pool.end(),
  } as PostgresBetterAuthPool;
}

async function activeConnections(
  config: pg.ClientConfig & { database: string },
  { settle = false } = {},
): Promise<number> {
  const client = new pg.Client({ ...config, database: 'postgres' });
  await client.connect();
  try {
    // A closed client's server process can take a moment to exit; allow a slow host 15 s.
    const deadline = Date.now() + 15_000;
    for (;;) {
      const result = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
        [config.database],
      );
      const count = result.rows[0]?.n ?? 0;
      if (!settle || count === 0 || Date.now() >= deadline) return count;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await client.end();
  }
}
