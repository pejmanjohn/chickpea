import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import pg from 'pg';

export interface PostgresTestCluster {
  /** Unix-socket connection settings; the server has no TCP listener. */
  connection: { host: string; port: number; user: string };
  createDatabase(): Promise<{ name: string; drop(): Promise<void> }>;
  stop(): Promise<void>;
}

export type PostgresTestClusterStart =
  | { cluster: PostgresTestCluster; skip?: undefined }
  | { cluster?: undefined; skip: string };

const USER = 'chickpea';
const PORT = 5432;

/**
 * Starts a private, disposable PostgreSQL server for one test file. The
 * tests are skipped only when CHICKPEA_TEST_POSTGRES_BIN is set to an empty
 * value; otherwise a missing or broken PostgreSQL fails them, so the gate
 * never passes on a backend it did not run.
 */
export async function startPostgresTestCluster(): Promise<PostgresTestClusterStart> {
  const configured = process.env.CHICKPEA_TEST_POSTGRES_BIN;
  if (configured === '') {
    return { skip: 'CHICKPEA_TEST_POSTGRES_BIN is empty, so the PostgreSQL backend tests are skipped.' };
  }
  const bin = postgresBinDirectory(configured);
  if (!bin) {
    throw new Error(configured
      ? `CHICKPEA_TEST_POSTGRES_BIN (${configured}) does not contain initdb and postgres.`
      : 'The PostgreSQL backend tests need PostgreSQL 13 or later (initdb and postgres), ' +
        'for example `brew install postgresql@17` or `apt install postgresql`. Set ' +
        'CHICKPEA_TEST_POSTGRES_BIN to their directory if they are not found, or to an ' +
        'empty value to skip these tests.');
  }
  // A Unix socket path is limited to about 100 bytes, so keep the directory short.
  const root = mkdtempSync(path.join(existsSync('/tmp') ? '/tmp' : tmpdir(), 'chickpea-pg-'));
  const data = path.join(root, 'data');
  let log = '';
  try {
    execFileSync(path.join(bin, 'initdb'), [
      '-D', data, '-U', USER, '--auth=trust', '-E', 'UTF8', '--no-locale', '--no-sync',
    ], { stdio: 'pipe' });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`initdb could not create a test cluster: ${failureText(error)}`);
  }
  const server = spawn(path.join(bin, 'postgres'), [
    '-D', data, '-k', root, '-p', String(PORT), '-c', 'listen_addresses=',
    '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  server.stderr.on('data', (chunk: Buffer) => { log = (log + chunk.toString()).slice(-4_000); });
  const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
  const kill = () => server.kill('SIGKILL');
  process.once('exit', kill);
  const stop = async () => {
    process.removeListener('exit', kill);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGINT');
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  };
  const connection = { host: root, port: PORT, user: USER };
  for (let attempt = 0; ; attempt += 1) {
    const client = new pg.Client({ ...connection, database: 'postgres' });
    try {
      await client.connect();
      await client.end();
      break;
    } catch {
      await client.end().catch(() => {});
      if (attempt >= 100 || server.exitCode !== null) {
        await stop();
        throw new Error(`The PostgreSQL test server did not start:\n${log.trim()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const admin = async <T>(work: (client: pg.Client) => Promise<T>) => {
    const client = new pg.Client({ ...connection, database: 'postgres' });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  };
  return {
    cluster: {
      connection,
      async createDatabase() {
        const name = `chickpea_${randomBytes(6).toString('hex')}`;
        await admin((client) => client.query(`CREATE DATABASE ${name}`));
        return {
          name,
          drop: () => admin(async (client) => {
            await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
          }),
        };
      },
      stop,
    },
  };
}

function postgresBinDirectory(configured: string | undefined): string | undefined {
  const usable = (directory: string | undefined): directory is string => Boolean(directory) &&
    existsSync(path.join(directory!, 'initdb')) && existsSync(path.join(directory!, 'postgres'));
  if (configured !== undefined) return usable(configured) ? configured : undefined;
  const pgConfig = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' });
  const versioned = (parent: string, pattern: RegExp, suffix: string[]) => {
    try {
      return readdirSync(parent).filter((name) => pattern.test(name)).sort().reverse()
        .map((name) => path.join(parent, name, ...suffix));
    } catch {
      return [];
    }
  };
  return [
    pgConfig.status === 0 ? pgConfig.stdout.trim() : undefined,
    ...(process.env.PATH ?? '').split(path.delimiter),
    ...versioned('/opt/homebrew/opt', /^postgresql(@\d+)?$/, ['bin']),
    ...versioned('/usr/local/opt', /^postgresql(@\d+)?$/, ['bin']),
    ...versioned('/usr/lib/postgresql', /^\d+$/, ['bin']),
  ].find(usable);
}

function failureText(error: unknown): string {
  const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
  return stderr || (error instanceof Error ? error.message : String(error));
}
