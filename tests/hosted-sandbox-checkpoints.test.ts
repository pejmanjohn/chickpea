import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  InstallationContextError,
  installationScopeOf,
  scopeInstallationEnv,
} from '../src/config/installation-scope.ts';
import { utcMonthKey } from '../src/config/monthly-counter.ts';
import {
  CHECKPOINT_BUCKET_METHODS,
  checkpointObjectKeys,
  installationCheckpointBucket,
  installationCheckpointPrefix,
  sandboxCheckpointEnv,
} from '../src/sandbox/checkpoint-bucket.ts';
import { checkpointBucket, sweepInstallationCheckpoints } from '../src/sandbox/checkpoint-sweep.ts';
import {
  SANDBOX_CONTAINER_LEASES_KEY,
  SANDBOX_CONTAINER_SECONDS_PREFIX,
} from '../src/sandbox/container-lease.ts';
import { GITHUB_WRITES_KEY } from '../src/sandbox/github-write-rate.ts';
import { containerStopRecorded } from '../src/sandbox/sandbox-host.ts';
import { sandboxObjectEnv, sandboxObjectName } from '../src/sandbox/sandbox-object.ts';
import { checkpointWorkspace, discardWorkspaceCheckpoint } from '../src/sandbox/workspace-checkpoints.ts';
import { SandboxWorkspaceState, WORKSPACE_CHECKPOINT_TTL_SECONDS } from '../src/sandbox/workspace-lifecycle.ts';
import type { SandboxPolicyStorage } from '../src/sandbox/cloudflare-policy.ts';
import {
  cancelInstallationObjectPendingWork,
  censusInstallationSandbox,
  eraseInstallationCheckpoints,
  eraseInstallationObject,
  exportInstallationObject,
  installationStateStoreObject,
  listInstallationObjects,
  stopInstallationSandboxContainer,
  type InstallationObject,
} from '../src/state/installation-objects.ts';
import { CODING_WORKSPACE_EXPORT_NOTE, OBJECT_EXPORT_FORMAT } from '../src/state/object-host.ts';
import { opaqueId } from '../src/work/admission.ts';
import {
  CODING_WORKER_BINDING,
  CONTAINER_STATE_KEY,
  hostedDeployment,
  sandboxWorkspaceState,
  type HostedInstallation,
} from './helpers/installation-objects.ts';
import { MemoryR2Bucket, MemoryR2Object } from './helpers/memory-r2.ts';

/**
 * H12c: a deployment serving many installations keeps every installation's
 * coding workspace checkpoints under its own prefix of one shared bucket,
 * deletes each checkpoint a newer one replaces, sweeps and erases by prefix,
 * and answers the host for every coding workspace object: export, erase,
 * cancellation, a container stop and a census. Standalone keeps the bare
 * bucket and its whole-bucket sweep.
 */

/** Installation IDs as Cloud mints them: `inst_` and 32 hex, 37 characters. */
const INSTALLATION_A = `inst_${'0123456789abcdef'.repeat(2)}`;
const INSTALLATION_B = `inst_${'fedcba9876543210'.repeat(2)}`;
const PREFIX_A = `i1/${INSTALLATION_A}/`;
const PREFIX_B = `i1/${INSTALLATION_B}/`;
const HOSTED = { CHICKPEA_TENANCY: 'installation' } as const;
const hostedEnv = (installationId: string, bindings: Record<string, unknown> = {}) =>
  scopeInstallationEnv({ ...HOSTED, ...bindings } as Record<string, unknown>, { installationId });

const NOW = Date.UTC(2026, 9, 3, 12);
const HOUR = 3_600_000;
const THREAD_KEY = 'T0BUML4GZ18:C0C022KBYV6:1788000000.000100';
const BACKUP_1 = { id: '11111111-1111-4111-8111-111111111111', dir: '/workspace', localBucket: true };
const BACKUP_2 = { id: '22222222-2222-4222-8222-222222222222', dir: '/workspace', localBucket: true };
const keysOf = (backup: { id: string }) => [`backups/${backup.id}/data.sqsh`, `backups/${backup.id}/meta.json`];

type View = {
  put(key: string, value: string): Promise<{ key: string } | null>;
  get(key: string): Promise<(MemoryR2Object & { key: string }) | null>;
  head(key: string): Promise<{ key: string; size: number } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: Record<string, unknown>): Promise<{
    objects: Array<{ key: string; size: number }>;
    truncated: boolean;
    cursor?: string;
    delimitedPrefixes: string[];
  }>;
  createMultipartUpload(key: string): Promise<{
    key: string;
    uploadId: string;
    uploadPart(partNumber: number, value: string): Promise<{ partNumber: number; etag: string }>;
    complete(parts: Array<{ partNumber: number }>): Promise<{ key: string }>;
  }>;
  resumeMultipartUpload(key: string, uploadId: string): {
    key: string;
    complete(parts: Array<{ partNumber: number }>): Promise<{ key: string }>;
  };
};

const viewOf = (installationId: string, bucket: MemoryR2Bucket) =>
  installationCheckpointBucket<View>(hostedEnv(installationId, { BACKUP_BUCKET: bucket }))!;

test('the view prefixes every key it is given and strips the prefix from every key it returns', async () => {
  const bucket = new MemoryR2Bucket();
  bucket.seed(`${PREFIX_B}backups/b/data.sqsh`, 'neighbour');
  const view = viewOf(INSTALLATION_A, bucket);

  const put = await view.put('backups/x/meta.json', '{"ttl":1}');
  assert.equal(put?.key, 'backups/x/meta.json');
  assert.deepEqual(bucket.keys(), [`${PREFIX_A}backups/x/meta.json`, `${PREFIX_B}backups/b/data.sqsh`]);

  // Methods of a returned object run on R2's own object (its private state).
  const got = await view.get('backups/x/meta.json');
  assert.equal(got?.key, 'backups/x/meta.json');
  assert.deepEqual(await got?.json(), { ttl: 1 });
  assert.ok(got instanceof MemoryR2Object, 'the returned object keeps its prototype');
  assert.equal((await view.head('backups/x/meta.json'))?.key, 'backups/x/meta.json');
  assert.equal(await view.get('backups/b/data.sqsh'), null, 'a neighbour\'s key is out of reach');

  await view.put('backups/x/data.sqsh', 'archive');
  await view.put('backups/y/data.sqsh', 'other');
  const listed = await view.list();
  assert.deepEqual(listed.objects.map((object) => object.key),
    ['backups/x/data.sqsh', 'backups/x/meta.json', 'backups/y/data.sqsh']);
  assert.deepEqual(bucket.calls.at(-1)?.options, { prefix: PREFIX_A });
  const narrowed = await view.list({ prefix: 'backups/x/', startAfter: 'backups/x/data.sqsh', limit: 5 });
  assert.deepEqual(narrowed.objects.map((object) => object.key), ['backups/x/meta.json']);
  assert.deepEqual(bucket.calls.at(-1)?.options,
    { prefix: `${PREFIX_A}backups/x/`, startAfter: `${PREFIX_A}backups/x/data.sqsh`, limit: 5 });
  const delimited = await view.list({ prefix: 'backups/', delimiter: '/' });
  assert.deepEqual(delimited.delimitedPrefixes.sort(), ['backups/x/', 'backups/y/']);
  const paged = await view.list({ limit: 1 });
  assert.equal(paged.truncated, true);
  const next = await view.list({ limit: 5, cursor: paged.cursor });
  assert.deepEqual(next.objects.map((object) => object.key), ['backups/x/meta.json', 'backups/y/data.sqsh']);

  await view.delete('backups/y/data.sqsh');
  await view.delete(['backups/x/data.sqsh', 'backups/x/meta.json']);
  assert.deepEqual(bucket.keys(), [`${PREFIX_B}backups/b/data.sqsh`]);
  assert.deepEqual(bucket.calls.filter((call) => call.method === 'delete').map((call) => call.keys), [
    [`${PREFIX_A}backups/y/data.sqsh`],
    [`${PREFIX_A}backups/x/data.sqsh`, `${PREFIX_A}backups/x/meta.json`],
  ]);

  const upload = await view.createMultipartUpload('backups/m/data.sqsh');
  assert.equal(upload.key, 'backups/m/data.sqsh');
  await upload.uploadPart(1, 'ab');
  const resumed = view.resumeMultipartUpload('backups/m/data.sqsh', upload.uploadId);
  assert.equal(resumed.key, 'backups/m/data.sqsh');
  assert.equal((await resumed.complete([{ partNumber: 1 }])).key, 'backups/m/data.sqsh');
  assert.deepEqual(bucket.calls.filter((call) => /Multipart/.test(call.method)).map((call) => call.keys),
    [[`${PREFIX_A}backups/m/data.sqsh`], [`${PREFIX_A}backups/m/data.sqsh`]]);
  assert.ok(bucket.keys().includes(`${PREFIX_A}backups/m/data.sqsh`));

  await assert.rejects(view.put('', 'x'), /non-empty/);
});

test('the view offers exactly the SDK call set; any other member throws', () => {
  const view = viewOf(INSTALLATION_A, new MemoryR2Bucket()) as unknown as Record<string | symbol, unknown>;
  for (const method of CHECKPOINT_BUCKET_METHODS) {
    assert.equal(typeof view[method], 'function', method);
    assert.ok(method in view, method);
  }
  // The SDK's own guard (`isR2Bucket`) accepts it.
  assert.ok(['put', 'get', 'head', 'delete', 'list'].every((method) => method in view && typeof view[method] === 'function'));
  for (const member of ['copy', 'createPresignedUrl', 'getObject', 'deleteAll']) {
    assert.throws(() => view[member], /offers no/, member);
    assert.equal(member in view, false, member);
  }
  assert.throws(() => { view.put = () => undefined; }, /cannot be changed/);
  assert.equal(view[Symbol.toStringTag], undefined, 'inspection reads symbols');
});

test('the members generic code probes on any value read as absent, so the view can be awaited and serialized', async () => {
  const view = viewOf(INSTALLATION_A, new MemoryR2Bucket()) as unknown as Record<string | symbol, unknown>;
  for (const member of ['then', 'toJSON', 'constructor']) {
    assert.equal(view[member], undefined, member);
    assert.equal(member in view, false, member);
  }
  assert.equal(await Promise.resolve(view), view, 'not a thenable');
  assert.equal(await (async () => view)(), view);
  assert.equal(JSON.stringify(view), '{}', 'methods do not serialize');
});

/** A bucket that answers with whatever keys it is told to, as a misbehaving binding could. */
function answering(keys: { listed?: string[]; delimited?: string[]; headed?: unknown }) {
  const bucket = new MemoryR2Bucket();
  return Object.assign(Object.create(bucket) as MemoryR2Bucket, {
    list: async () => ({
      objects: (keys.listed ?? []).map((key) => new MemoryR2Object(key, 'x', new Date(NOW))),
      truncated: false,
      delimitedPrefixes: keys.delimited ?? [],
    }),
    head: async () => (keys.headed === undefined ? null : { key: keys.headed, size: 1 }),
  });
}

test('a key the bucket returns outside the installation\'s prefix is refused, never stripped', async () => {
  const neighbour = `${PREFIX_B}backups/b/data.sqsh`;
  for (const listed of [[neighbour], ['backups/bare/data.sqsh'], [`${PREFIX_A}backups/a/data.sqsh`, neighbour]]) {
    await assert.rejects(viewOf(INSTALLATION_A, answering({ listed })).list(), /outside the installation/, listed.join());
  }
  await assert.rejects(viewOf(INSTALLATION_A, answering({ delimited: [`${PREFIX_B}backups/`] })).list({ delimiter: '/' }),
    /outside the installation/);
  for (const headed of [neighbour, 'backups/bare/meta.json', 42, null]) {
    await assert.rejects(viewOf(INSTALLATION_A, answering({ headed })).head('backups/a/meta.json'),
      /outside the installation/, String(headed));
  }
  // The installation's own keys come back stripped.
  const own = await viewOf(INSTALLATION_A, answering({ listed: [`${PREFIX_A}backups/a/data.sqsh`] })).list();
  assert.deepEqual(own.objects.map((object) => object.key), ['backups/a/data.sqsh']);
});

test('standalone keeps the bare bucket; tenancy needs an installation and never wraps a view twice', () => {
  const bucket = new MemoryR2Bucket();
  assert.equal(installationCheckpointBucket({ BACKUP_BUCKET: bucket }), bucket);
  assert.equal(installationCheckpointBucket({}), undefined);
  assert.equal(installationCheckpointBucket(hostedEnv(INSTALLATION_A)), undefined);
  assert.throws(() => installationCheckpointBucket({ ...HOSTED, BACKUP_BUCKET: bucket }), InstallationContextError);
  const view = viewOf(INSTALLATION_A, bucket);
  assert.notEqual(view, bucket as unknown);
  assert.equal(installationCheckpointBucket(hostedEnv(INSTALLATION_A, { BACKUP_BUCKET: view })), view);
  assert.throws(() => installationCheckpointBucket(hostedEnv(INSTALLATION_B, { BACKUP_BUCKET: view })), InstallationContextError);
  assert.equal(installationCheckpointPrefix(INSTALLATION_A), PREFIX_A);
});

/** The Sandbox SDK release whose R2 calls the view was audited against. */
const AUDITED_SDK_VERSION = '0.12.10';
const SDK_DIST = new URL('../node_modules/@cloudflare/sandbox/dist/', import.meta.url);

test('the installed Sandbox SDK calls on its bucket exactly what the view offers', () => {
  const version = (JSON.parse(readFileSync(new URL('../package.json', SDK_DIST), 'utf8')) as { version: string }).version;
  assert.equal(version, AUDITED_SDK_VERSION,
    'a new Sandbox SDK: audit its R2 calls and BACKUP_BUCKET reads, update the view, then this pin');
  const sources = readdirSync(SDK_DIST).filter((file) => file.endsWith('.js'))
    .map((file) => readFileSync(new URL(file, SDK_DIST), 'utf8'));
  // Every method called on a value the SDK holds as an R2 bucket: the backup
  // bucket, the local-bucket backup and restore paths, the storage mounts and
  // the S3-compatible handler over a binding (`r2`). `bucket` also names a
  // bucket's name in mount validation, a string.
  const calls = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(
      /\b(?:bucket|backupBucket|r2|this\.bucket|this\.backupBucket|this\.requireBackupBucket\(\))\.(\w+)\(/g,
    )) calls.add(match[1]!);
  }
  for (const stringMethod of ['includes', 'split']) calls.delete(stringMethod);
  assert.deepEqual([...calls].sort(), [...CHECKPOINT_BUCKET_METHODS].sort());
  // It reads BACKUP_BUCKET only from the env its constructor is handed.
  const reads = sources.flatMap((source) => [...source.matchAll(/[\w$.]+(?:\?\.|\.)BACKUP_BUCKET\b(?!_)/g)].map((match) => match[0]));
  assert.deepEqual(reads.sort(), ['envObj?.BACKUP_BUCKET', 'this.env.BACKUP_BUCKET', 'this.env.BACKUP_BUCKET']);
  assert.equal(sources.some((source) => /\[\s*["'`]BACKUP_BUCKET["'`]\s*\]/.test(source)), false);
  // Superseded and erased checkpoints are deleted by the SDK's key layout.
  const sdk = sources.join('\n');
  assert.match(sdk, /const BACKUP_STORAGE_PREFIX = "backups";/);
  assert.match(sdk, /const BACKUP_ARCHIVE_OBJECT_NAME = "data\.sqsh";/);
  assert.match(sdk, /const BACKUP_METADATA_OBJECT_NAME = "meta\.json";/);
  assert.match(sdk, /backupId = crypto\.randomUUID\(\);/);
  assert.deepEqual(checkpointObjectKeys(BACKUP_1), keysOf(BACKUP_1));
  assert.equal(checkpointObjectKeys({ id: '../other' }), undefined);
});

test('a hosted Sandbox hands the SDK its installation\'s view; standalone and unscoped objects do not', async () => {
  const bucket = new MemoryR2Bucket();
  const name = sandboxObjectName(hostedEnv(INSTALLATION_A), THREAD_KEY);
  const kv = new Map<string, unknown>();
  const context = (id: string | undefined, entries = kv) => ({
    id: id === undefined ? {} : { name: id },
    storage: { kv: { get: (key: string) => entries.get(key), put: (key: string, value: unknown) => { entries.set(key, value); } } },
  });
  const env = sandboxObjectEnv(context(name), { ...HOSTED, BACKUP_BUCKET: bucket } as Record<string, unknown>);
  assert.equal(installationScopeOf(env)?.installationId, INSTALLATION_A);
  await (env.BACKUP_BUCKET as View).put('backups/x/meta.json', '{}');
  assert.deepEqual(bucket.keys(), [`${PREFIX_A}backups/x/meta.json`]);
  // A wake by ID recovers the installation and its view.
  const woken = sandboxObjectEnv(context(undefined), { ...HOSTED, BACKUP_BUCKET: bucket } as Record<string, unknown>);
  assert.equal(installationCheckpointBucket(woken), woken.BACKUP_BUCKET);
  // An object that serves no installation gets no bucket at all.
  const probe = sandboxObjectEnv(context('chickpea-container-probe', new Map()), { ...HOSTED, BACKUP_BUCKET: bucket } as Record<string, unknown>);
  assert.equal('BACKUP_BUCKET' in probe, false);
  assert.equal(checkpointBucket(probe), undefined);
  // Standalone: the very same env.
  const standalone = { BACKUP_BUCKET: bucket };
  assert.equal(sandboxObjectEnv(context(THREAD_KEY, new Map()), standalone), standalone);
  assert.equal(sandboxCheckpointEnv(standalone), standalone);
});

class MemoryStorage implements SandboxPolicyStorage {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, value); }
}

/** One end of turn through the SDK's local-bucket layout: both objects, then the handle. */
async function endTurn(env: Record<string, unknown>, state: SandboxWorkspaceState, backup: { id: string }) {
  return checkpointWorkspace({
    env, containerRunning: true, state, now: () => NOW,
    create: async () => {
      const bucket = env.BACKUP_BUCKET as View;
      for (const key of keysOf(backup)) await bucket.put(key, key);
      return backup;
    },
  });
}

for (const mode of ['standalone', 'installation'] as const) {
  test(`a new checkpoint deletes the one it replaced (${mode})`, async () => {
    const bucket = new MemoryR2Bucket();
    const env = mode === 'standalone'
      ? { BACKUP_BUCKET: bucket }
      : sandboxCheckpointEnv(hostedEnv(INSTALLATION_A, { BACKUP_BUCKET: bucket }));
    const prefix = mode === 'standalone' ? '' : PREFIX_A;
    const state = new SandboxWorkspaceState(new MemoryStorage());
    await state.beginTurn({ fingerprint: 'owner', turnId: 'turn-1', containerRunning: false, now: NOW });

    assert.equal(await endTurn(env, state, BACKUP_1), 'saved');
    assert.deepEqual(bucket.keys(), keysOf(BACKUP_1).map((key) => `${prefix}${key}`));
    assert.equal(await endTurn(env, state, BACKUP_2), 'saved');
    assert.deepEqual(bucket.keys(), keysOf(BACKUP_2).map((key) => `${prefix}${key}`), 'only the latest stays');
    assert.deepEqual(await state.checkpointForRestore('owner', NOW + HOUR), BACKUP_2, 'the latest still restores');
    assert.deepEqual(await state.currentCheckpoint(), BACKUP_2);

    // Recording the same handle again deletes nothing.
    assert.equal(await endTurn(env, state, BACKUP_2), 'saved');
    assert.deepEqual(bucket.keys(), keysOf(BACKUP_2).map((key) => `${prefix}${key}`));
  });
}

test('a superseded checkpoint that cannot be deleted leaves the new one saved', async () => {
  const bucket = new MemoryR2Bucket();
  const failing = Object.assign(Object.create(bucket) as MemoryR2Bucket, {
    put: (key: string, value: string) => bucket.put(key, value),
    delete: async () => { throw new Error('R2 unavailable'); },
  });
  const state = new SandboxWorkspaceState(new MemoryStorage());
  await state.beginTurn({ fingerprint: 'owner', turnId: 'turn-1', containerRunning: false, now: NOW });
  const env = { BACKUP_BUCKET: failing };
  assert.equal(await endTurn(env, state, BACKUP_1), 'saved');
  assert.equal(await endTurn(env, state, BACKUP_2), 'saved');
  assert.deepEqual(await state.currentCheckpoint(), BACKUP_2);
  assert.equal(bucket.keys().length, 4, 'the sweep deletes the leftover after the restore window');
});

test('work maintenance sweeps only its own installation\'s prefix; standalone sweeps the bucket', async () => {
  const expired = new Date(NOW - WORKSPACE_CHECKPOINT_TTL_SECONDS * 1_000 - HOUR);
  const fresh = new Date(NOW - HOUR);
  const bucket = new MemoryR2Bucket();
  for (const prefix of [PREFIX_A, PREFIX_B, '']) {
    bucket.seed(`${prefix}backups/old/data.sqsh`, 'old', expired);
    bucket.seed(`${prefix}backups/new/data.sqsh`, 'new', fresh);
  }
  assert.equal(await sweepInstallationCheckpoints(hostedEnv(INSTALLATION_A, { BACKUP_BUCKET: bucket }), NOW), 1);
  assert.deepEqual(bucket.keys(), [
    'backups/new/data.sqsh', 'backups/old/data.sqsh',
    `${PREFIX_A}backups/new/data.sqsh`,
    `${PREFIX_B}backups/new/data.sqsh`, `${PREFIX_B}backups/old/data.sqsh`,
  ]);
  assert.deepEqual(bucket.calls.filter((call) => call.method === 'list').map((call) => call.options?.prefix), [PREFIX_A],
    'the hosted sweep lists only its own prefix');
  await assert.rejects(sweepInstallationCheckpoints({ ...HOSTED, BACKUP_BUCKET: bucket }, NOW), InstallationContextError);
  assert.equal(await sweepInstallationCheckpoints(hostedEnv(INSTALLATION_A), NOW), 0, 'no bucket, nothing to sweep');

  const standalone = new MemoryR2Bucket();
  standalone.seed('backups/old/data.sqsh', 'old', expired);
  standalone.seed('backups/new/data.sqsh', 'new', fresh);
  assert.equal(await sweepInstallationCheckpoints({ BACKUP_BUCKET: standalone }, NOW), 1);
  assert.deepEqual(standalone.keys(), ['backups/new/data.sqsh']);
  assert.equal(standalone.calls.find((call) => call.method === 'list')?.options?.prefix, undefined);
});

test('a checkpoint erasure cursor resumes after its own place, whatever lies before it', async () => {
  const bucket = new MemoryR2Bucket();
  const key = (index: number) => `${PREFIX_A}backups/${String(index).padStart(5, '0')}/data.sqsh`;
  for (let index = 0; index < 2_500; index += 1) bucket.seed(key(index), 'a');
  const env = hostedEnv(INSTALLATION_A, { BACKUP_BUCKET: bucket });
  const first = await eraseInstallationCheckpoints(env, INSTALLATION_A);
  assert.equal(first.deleted, 1_000);
  // Objects written behind the cursor after its page (a checkpoint a late turn saved).
  for (const index of [3, 500, 999]) bucket.seed(key(index), 'late');

  const second = await eraseInstallationCheckpoints(env, INSTALLATION_A, first.nextCursor);
  assert.equal(second.deleted, 1_000);
  assert.deepEqual(bucket.keys().slice(0, 4), [key(3), key(500), key(999), key(2_000)],
    'the second page deleted 1000 to 1999, not what lay before its cursor');
  const third = await eraseInstallationCheckpoints(env, INSTALLATION_A, second.nextCursor);
  assert.deepEqual(third, { deleted: 500, nextCursor: null });
  assert.deepEqual(bucket.keys(), [key(3), key(500), key(999)]);
  // A pass from no cursor takes them.
  assert.deepEqual(await eraseInstallationCheckpoints(env, INSTALLATION_A), { deleted: 3, nextCursor: null });
  assert.deepEqual(bucket.keys(), []);
});

test('checkpoint erasure deletes the installation\'s prefix page by page, idempotently, and nothing else', async () => {
  const bucket = new MemoryR2Bucket();
  for (let index = 0; index < 2_345; index += 1) bucket.seed(`${PREFIX_A}backups/${String(index).padStart(5, '0')}/data.sqsh`, 'a');
  bucket.seed(`${PREFIX_A}orphan`, 'a');
  for (const key of ['backups/b/data.sqsh', 'backups/b/meta.json']) bucket.seed(`${PREFIX_B}${key}`, 'b');
  bucket.seed('backups/standalone/data.sqsh', 'bare');
  const before = Object.fromEntries(Object.entries(await bucket.snapshot()).filter(([key]) => !key.startsWith(PREFIX_A)));
  const env = hostedEnv(INSTALLATION_A, { BACKUP_BUCKET: bucket });

  await assert.rejects(eraseInstallationCheckpoints(env, INSTALLATION_B), InstallationContextError);
  await assert.rejects(eraseInstallationCheckpoints({ BACKUP_BUCKET: bucket }, INSTALLATION_A), InstallationContextError);
  await assert.rejects(eraseInstallationCheckpoints(env, INSTALLATION_A, 'not-a-cursor'), /malformed/);

  const pages: Array<{ deleted: number; nextCursor: string | null }> = [];
  let cursor: string | null = null;
  do {
    const page = await eraseInstallationCheckpoints(env, INSTALLATION_A, cursor);
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(pages.map((page) => page.deleted), [1_000, 1_000, 346]);
  assert.equal(bucket.keys().some((key) => key.startsWith(PREFIX_A)), false);
  assert.deepEqual(await bucket.snapshot(), before, 'the neighbour and standalone keys are byte-identical');
  assert.ok(bucket.calls.filter((call) => call.method === 'delete').every((call) => call.keys.every((key) => key.startsWith(PREFIX_A))));

  // Each page after the first lists from where the one before stopped.
  const listed = bucket.calls.filter((call) => call.method === 'list').map((call) => call.options);
  assert.deepEqual(listed.map((options) => options?.startAfter), [
    undefined, `${PREFIX_A}backups/00999/data.sqsh`, `${PREFIX_A}backups/01999/data.sqsh`,
  ]);
  assert.ok(listed.every((options) => options?.prefix === PREFIX_A && options?.limit === 1_000));

  // A replayed cursor and a confirming pass find nothing left.
  assert.deepEqual(await eraseInstallationCheckpoints(env, INSTALLATION_A, pages[0]!.nextCursor), { deleted: 0, nextCursor: null });
  assert.deepEqual(await eraseInstallationCheckpoints(env, INSTALLATION_A), { deleted: 0, nextCursor: null });
  assert.deepEqual(await eraseInstallationCheckpoints(hostedEnv(INSTALLATION_A), INSTALLATION_A), { deleted: 0, nextCursor: null });
});

/** One installation with a coding workspace: its Sandbox, a coding worker, a checkpoint and the host's records. */
async function codingWorkspace(
  deployment: ReturnType<typeof hostedDeployment>,
  installation: HostedInstallation,
  /** `leased`: the Sandbox's own lease is open, as for a running container or a stop its alarm has not settled. */
  options: { running?: boolean; leased?: boolean } = {},
) {
  const sandboxName = sandboxObjectName(installation.env, THREAD_KEY);
  const workerName = `i1~${installation.installationId}~${opaqueId('codingworker', `binding-${installation.installationId}`)}`;
  installation.stores.objectInventory.recordWorkspaceObject({ kind: 'sandbox', name: sandboxName });
  installation.stores.objectInventory.recordWorkspaceObject({ kind: 'coding_worker', name: workerName });
  const sandbox = deployment.object('SANDBOX', sandboxName);
  const state = sandboxWorkspaceState(sandbox.storage);
  await state.beginTurn({ fingerprint: 'owner', turnId: 'turn-1', containerRunning: false, now: NOW });
  sandbox.container!.running = true;
  assert.equal(await endTurn(sandbox.env, state, BACKUP_1), 'saved');
  sandbox.container!.running = options.running ?? false;
  if (options.running) sandbox.storage.kv.set(CONTAINER_STATE_KEY, { status: 'healthy', lastChange: NOW });
  sandbox.storage.sql.exec('CREATE TABLE container_schedules (id TEXT PRIMARY KEY, callback TEXT)');
  await sandbox.storage.put('chickpea.sandbox.coding-tasks.v1', { tasks: ['task'] });
  await sandbox.storage.setAlarm(NOW + HOUR);
  const worker = deployment.object(CODING_WORKER_BINDING, workerName);
  worker.storage.sql.exec('CREATE TABLE flue_transcript (id INTEGER PRIMARY KEY, body TEXT)');
  worker.storage.sql.exec('INSERT INTO flue_transcript (body) VALUES (?)', `Worker transcript of ${installation.installationId}`);
  await worker.storage.setAlarm(NOW + HOUR);
  installation.stores.settings.setSetting(SANDBOX_CONTAINER_LEASES_KEY, JSON.stringify({
    do_1: { startedAt: NOW - HOUR, leaseUntil: NOW + HOUR },
    do_2: { startedAt: NOW - 2 * HOUR, leaseUntil: NOW + HOUR },
    ...(options.leased ? { [sandboxName]: { startedAt: NOW - HOUR, leaseUntil: NOW + HOUR } } : {}),
  }));
  installation.stores.settings.setSetting(`${SANDBOX_CONTAINER_SECONDS_PREFIX}${utcMonthKey(new Date(NOW))}`, JSON.stringify({ seconds: 5_400 }));
  installation.stores.settings.setSetting(`${SANDBOX_CONTAINER_SECONDS_PREFIX}2026-09`, JSON.stringify({ seconds: 99 }));
  installation.stores.settings.setSetting(GITHUB_WRITES_KEY, JSON.stringify({ writes: [NOW], pullRequests: [] }));
  installation.stores.settings.setSetting(`sandbox.monthlySessions.${utcMonthKey(new Date(NOW))}`,
    JSON.stringify({ count: 3, reservationIds: ['t1', 't2', 't3'] }));
  installation.stores.settings.setSetting('slack.teamName', `Team ${installation.installationId}`);
  return {
    sandbox, worker,
    sandboxObject: { kind: 'sandbox', name: sandboxName } as InstallationObject,
    workerObject: { kind: 'coding_worker', name: workerName } as InstallationObject,
  };
}

async function exportText(env: HostedInstallation['env'], object: InstallationObject, mode: 'portable' | 'full') {
  let cursor: string | null | undefined;
  let text = '';
  do {
    const page = await exportInstallationObject(env, object, { mode, ...(cursor ? { cursor } : {}) });
    text += page.lines;
    cursor = page.nextCursor;
  } while (cursor);
  return text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('a Sandbox exports only a header and the note; a coding worker exports its transcript', async () => {
  const bucket = new MemoryR2Bucket();
  const deployment = hostedDeployment([INSTALLATION_A], { bucket });
  const a = deployment.installation(INSTALLATION_A);
  const { sandboxObject, workerObject } = await codingWorkspace(deployment, a);
  for (const mode of ['portable', 'full'] as const) {
    assert.deepEqual(await exportText(a.env, sandboxObject, mode),
      [{ t: 'object', format: OBJECT_EXPORT_FORMAT, mode, note: CODING_WORKSPACE_EXPORT_NOTE }]);
    const worker = await exportText(a.env, workerObject, mode);
    assert.ok(worker.some((record) => record.t === 'row' && (record.row as { body?: string }).body === `Worker transcript of ${INSTALLATION_A}`));
  }
  assert.equal(CODING_WORKSPACE_EXPORT_NOTE, 'Unpushed work in a coding workspace is not exported.');
  await assert.rejects(exportInstallationObject(a.env, sandboxObject, { mode: 'full', cursor: 'abc' }), /cursor/);
  await assert.rejects(
    exportInstallationObject(a.env, sandboxObject, { mode: 'everything' as 'full' }), /portable or full/);
});

test('no export carries the host\'s operational coding workspace records', async () => {
  const bucket = new MemoryR2Bucket();
  const deployment = hostedDeployment([INSTALLATION_A], { bucket });
  const a = deployment.installation(INSTALLATION_A);
  await codingWorkspace(deployment, a);
  for (const mode of ['portable', 'full'] as const) {
    const settings = (await exportText(a.env, installationStateStoreObject(a.env), mode))
      .filter((record) => record.t === 'row' && record.table === 'app_settings')
      .map((record) => (record.row as { key: string }).key);
    assert.ok(settings.includes('slack.teamName'), mode);
    assert.ok(settings.includes(`sandbox.monthlySessions.${utcMonthKey(new Date(NOW))}`), mode);
    assert.deepEqual(settings.filter((key) => key === SANDBOX_CONTAINER_LEASES_KEY || key === GITHUB_WRITES_KEY ||
      key.startsWith(SANDBOX_CONTAINER_SECONDS_PREFIX)), [], mode);
  }
});

test('stopping a Sandbox destroys a running container and keeps its records and checkpoint', async () => {
  const bucket = new MemoryR2Bucket();
  const deployment = hostedDeployment([INSTALLATION_A], { bucket });
  const a = deployment.installation(INSTALLATION_A);
  const { sandbox, sandboxObject, workerObject } = await codingWorkspace(deployment, a, { running: true });
  const tables = sandbox.storage.tables();
  const entries = [...sandbox.storage.kv.keys()].sort();

  assert.deepEqual(await stopInstallationSandboxContainer(a.env, sandboxObject), { stopped: true });
  assert.deepEqual(sandbox.container, { running: false, destroyed: 1 });
  assert.deepEqual(await stopInstallationSandboxContainer(a.env, sandboxObject), { stopped: false }, 'safe to repeat');
  assert.equal(sandbox.container!.destroyed, 1);
  assert.deepEqual(sandbox.storage.tables(), tables);
  assert.deepEqual([...sandbox.storage.kv.keys()].sort(), entries);
  assert.equal(sandbox.storage.alarm, NOW + HOUR, 'the container runtime keeps its alarm, which settles the stop');
  assert.deepEqual(await sandboxWorkspaceState(sandbox.storage).checkpointForRestore('owner', NOW + HOUR), BACKUP_1);
  assert.deepEqual(bucket.keys(), keysOf(BACKUP_1).map((key) => `${PREFIX_A}${key}`));
  await assert.rejects(stopInstallationSandboxContainer(a.env, workerObject), /Only a coding workspace Sandbox/);

  // Cancellation stops the container the same way.
  sandbox.container!.running = true;
  assert.deepEqual(await cancelInstallationObjectPendingWork(a.env, sandboxObject), { alarmCleared: false, containerStopped: true });
  assert.deepEqual(await cancelInstallationObjectPendingWork(a.env, sandboxObject), { alarmCleared: false, containerStopped: false });
  assert.equal(sandbox.container!.destroyed, 2);
  assert.equal(sandbox.storage.alarm, NOW + HOUR);
  // A coding worker's cancellation clears its alarm, like any Flue instance's.
  assert.deepEqual(await cancelInstallationObjectPendingWork(a.env, workerObject), { alarmCleared: true });
});

test('erasing an installation\'s coding workspace leaves nothing of it and its neighbour byte-identical', async () => {
  const bucket = new MemoryR2Bucket();
  const deployment = hostedDeployment([INSTALLATION_A, INSTALLATION_B], { bucket });
  const a = deployment.installation(INSTALLATION_A);
  const b = deployment.installation(INSTALLATION_B);
  const ofA = await codingWorkspace(deployment, a, { running: true, leased: true });
  const ofB = await codingWorkspace(deployment, b, { running: true, leased: true });
  bucket.seed(`${PREFIX_A}backups/orphan/data.sqsh`, 'left by a failed delete');
  const neighbour = async () => ({
    bucket: Object.fromEntries(Object.entries(await bucket.snapshot()).filter(([key]) => key.startsWith(PREFIX_B))),
    sandbox: JSON.stringify([ofB.sandbox.storage.tables(), [...ofB.sandbox.storage.kv], ofB.sandbox.storage.alarm, ofB.sandbox.container]),
    worker: JSON.stringify(await exportText(b.env, ofB.workerObject, 'full')),
    store: JSON.stringify(await exportText(b.env, installationStateStoreObject(b.env), 'full')),
  });
  const before = await neighbour();

  // The host's order: every inventoried object, the checkpoints, the state store last.
  const objects = (await listInstallationObjects(a.env)).objects.map(({ kind, name }) => ({ kind, name }));
  assert.deepEqual(objects.map(({ kind }) => kind), ['coding_worker', 'sandbox']);
  for (const object of objects) {
    assert.deepEqual(await eraseInstallationObject(a.env, object, { confirmInstallationId: INSTALLATION_A }), { erased: true });
  }
  assert.deepEqual(ofA.sandbox.container, { running: false, destroyed: 1 }, 'its running container went first');
  assert.deepEqual(ofA.sandbox.lifecycle, ['destroy', 'stop recorded', 'lease released'],
    'the erasure settled the stop its deleted alarm would have');
  const leases = JSON.parse(a.stores.settings.getSettings([SANDBOX_CONTAINER_LEASES_KEY])[0]!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(leases).sort(), ['do_1', 'do_2'], 'its own lease was released in the state store');
  assert.deepEqual(bucket.keys().filter((key) => key.startsWith(PREFIX_A)), [`${PREFIX_A}backups/orphan/data.sqsh`],
    'the Sandbox deleted its latest checkpoint; the prefix erasure takes the rest');
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const erased of [ofA.sandbox, ofA.worker]) {
    assert.deepEqual(erased.storage.tables(), []);
    assert.equal(erased.storage.kv.size, 0, 'no record of the stop landed after the erasure');
    assert.equal(erased.storage.alarm, null);
  }
  assert.deepEqual(await eraseInstallationCheckpoints(a.env, INSTALLATION_A), { deleted: 1, nextCursor: null });
  await eraseInstallationObject(a.env, installationStateStoreObject(a.env), { confirmInstallationId: INSTALLATION_A });
  assert.deepEqual(a.storage.tables(), [], 'the leases and meters went with the state store');
  assert.equal(bucket.keys().some((key) => key.startsWith(PREFIX_A)), false);
  assert.deepEqual(await neighbour(), before);
});

test('erasing a Sandbox whose container already stopped releases the lease its alarm had not, and waits for nothing', async () => {
  const deployment = hostedDeployment([INSTALLATION_A], { bucket: new MemoryR2Bucket() });
  const a = deployment.installation(INSTALLATION_A);
  const { sandbox, sandboxObject } = await codingWorkspace(deployment, a, { leased: true });
  assert.deepEqual(await eraseInstallationObject(a.env, sandboxObject, { confirmInstallationId: INSTALLATION_A }), { erased: true });
  assert.deepEqual(sandbox.lifecycle, ['lease released']);
  assert.equal(sandbox.container!.destroyed, 0);
  const leases = JSON.parse(a.stores.settings.getSettings([SANDBOX_CONTAINER_LEASES_KEY])[0]!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(leases).sort(), ['do_1', 'do_2']);
  assert.equal(sandbox.storage.kv.size, 0);
});

test('an erasure waits for the runtime\'s record of a stop only so long, then goes on and says so', async (t) => {
  let reads = 0;
  const recorded = await containerStopRecorded(async () => {
    reads += 1;
    return { status: reads < 3 ? 'healthy' : 'stopped_with_code' };
  }, { pollMs: 1 });
  assert.equal(recorded, true);
  assert.equal(reads, 3);
  assert.equal(await containerStopRecorded(async () => ({ status: 'stopped' })), true);

  const warned = t.mock.method(console, 'warn', () => {});
  const started = Date.now();
  assert.equal(await containerStopRecorded(async () => ({ status: 'running' }), { deadlineMs: 30, pollMs: 5 }), false);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(warned.mock.callCount(), 1);
  assert.equal(String(warned.mock.calls[0]!.arguments[0]), JSON.stringify({ component: 'sandbox_host', event: 'stop_record_deadline' }));
});

test('Sandbox host functions refuse standalone and another installation', async () => {
  const bucket = new MemoryR2Bucket();
  const deployment = hostedDeployment([INSTALLATION_A, INSTALLATION_B], { bucket });
  const a = deployment.installation(INSTALLATION_A);
  const b = deployment.installation(INSTALLATION_B);
  const ofB = await codingWorkspace(deployment, b, { running: true });
  await assert.rejects(stopInstallationSandboxContainer(a.env, ofB.sandboxObject), InstallationContextError);
  await assert.rejects(eraseInstallationObject(a.env, ofB.sandboxObject, { confirmInstallationId: INSTALLATION_A }),
    InstallationContextError);
  for (const method of ['chickpeaHostStopContainer', 'chickpeaHostErase', 'chickpeaHostCancelPendingWork', 'chickpeaHostExportPage']) {
    await assert.rejects(
      (ofB.sandbox.host[method] as (request: object) => Promise<unknown>)({ installationId: INSTALLATION_A, mode: 'full' }),
      InstallationContextError, method);
  }
  await assert.rejects(stopInstallationSandboxContainer({ SANDBOX: {} }, ofB.sandboxObject), InstallationContextError);
  assert.deepEqual(ofB.sandbox.container, { running: true, destroyed: 0 });
  assert.equal(bucket.keys().filter((key) => key.startsWith(PREFIX_B)).length, 2);
  assert.ok(ofB.sandbox.storage.tables().length > 0);
});

test('a census counts the coding workspace objects, leases, this month\'s time and sessions, and the prefix', async () => {
  const bucket = new MemoryR2Bucket();
  const deployment = hostedDeployment([INSTALLATION_A, INSTALLATION_B], { bucket });
  const a = deployment.installation(INSTALLATION_A);
  const b = deployment.installation(INSTALLATION_B);
  await codingWorkspace(deployment, a);
  await codingWorkspace(deployment, b);
  bucket.seed(`${PREFIX_A}backups/orphan/data.sqsh`, '12345');
  a.stores.objectInventory.recordWorkspaceObject({ kind: 'sandbox', name: sandboxObjectName(a.env, `${THREAD_KEY}:2`) });

  const keySizes = keysOf(BACKUP_1).reduce((total, key) => total + Buffer.byteLength(key), 0);
  assert.deepEqual(await censusInstallationSandbox(a.env, { now: NOW }), {
    objects: { sandbox: 2, coding_worker: 1 },
    runningContainers: 2,
    month: utcMonthKey(new Date(NOW)),
    containerSeconds: 5_400,
    sessions: 3,
    checkpoints: { objects: 3, bytes: keySizes + 5, complete: true },
  });
  // Next month nothing is metered yet; the leases still run.
  const nextMonth = Date.UTC(2026, 10, 2);
  const later = await censusInstallationSandbox(a.env, { now: nextMonth });
  assert.deepEqual([later.month, later.containerSeconds, later.sessions, later.runningContainers], ['2026-11', 0, 0, 2]);
  // Without the bucket binding there is no prefix to count.
  const unbound = hostedDeployment([INSTALLATION_A]);
  assert.equal((await censusInstallationSandbox(unbound.installation(INSTALLATION_A).env)).checkpoints, null);
  await assert.rejects(censusInstallationSandbox({ BACKUP_BUCKET: bucket }), InstallationContextError);
  await assert.rejects(censusInstallationSandbox(a.env, { now: Number.NaN }), /timestamp/);
});

test('a census lists at most 50 pages of the prefix and says when it stopped short', async () => {
  for (const [pages, complete] of [[50, true], [51, false]] as const) {
    let listed = 0;
    // A prefix of `pages` pages of one object each.
    const bucket = Object.assign(Object.create(new MemoryR2Bucket()) as MemoryR2Bucket, {
      list: async (options: { prefix: string; cursor?: string }) => {
        listed += 1;
        const page = options.cursor === undefined ? 0 : Number(options.cursor);
        const truncated = page + 1 < pages;
        return {
          objects: [new MemoryR2Object(`${options.prefix}backups/${page}/data.sqsh`, 'xy', new Date(NOW))],
          truncated,
          ...(truncated ? { cursor: String(page + 1) } : {}),
        };
      },
    });
    const deployment = hostedDeployment([INSTALLATION_A], { bucket });
    const census = await censusInstallationSandbox(deployment.installation(INSTALLATION_A).env, { now: NOW });
    assert.deepEqual(census.checkpoints, { objects: 50, bytes: 100, complete }, `${pages} pages`);
    assert.equal(listed, 50);
  }
});

for (const mode of ['standalone', 'installation'] as const) {
  test(`discarding a workspace forgets its checkpoint and deletes its objects (${mode})`, async () => {
    const bucket = new MemoryR2Bucket();
    const env = mode === 'standalone'
      ? { BACKUP_BUCKET: bucket }
      : sandboxCheckpointEnv(hostedEnv(INSTALLATION_A, { BACKUP_BUCKET: bucket }));
    const prefix = mode === 'standalone' ? '' : PREFIX_A;
    bucket.seed(`${prefix}backups/other/data.sqsh`, 'another thread');
    const state = new SandboxWorkspaceState(new MemoryStorage());
    await state.beginTurn({ fingerprint: 'owner', turnId: 'turn-1', containerRunning: false, now: NOW });
    assert.equal(await endTurn(env, state, BACKUP_1), 'saved');

    await discardWorkspaceCheckpoint({ env, state });
    assert.equal(await state.currentCheckpoint(), undefined);
    assert.equal(await state.hasCheckpoint('owner', NOW + HOUR), false);
    assert.deepEqual(bucket.keys(), [`${prefix}backups/other/data.sqsh`]);
    // Nothing to discard: nothing deleted.
    const deletes = bucket.calls.filter((call) => call.method === 'delete').length;
    await discardWorkspaceCheckpoint({ env, state });
    assert.equal(bucket.calls.filter((call) => call.method === 'delete').length, deletes);
  });
}

test('a discarded checkpoint whose objects cannot be deleted is still forgotten; without the bucket it is only forgotten', async (t) => {
  const bucket = new MemoryR2Bucket();
  const failing = Object.assign(Object.create(bucket) as MemoryR2Bucket, {
    put: (key: string, value: string) => bucket.put(key, value),
    delete: async () => { throw new Error('R2 unavailable'); },
  });
  const state = new SandboxWorkspaceState(new MemoryStorage());
  await state.beginTurn({ fingerprint: 'owner', turnId: 'turn-1', containerRunning: false, now: NOW });
  assert.equal(await endTurn({ BACKUP_BUCKET: failing }, state, BACKUP_1), 'saved');
  const warned = t.mock.method(console, 'warn', () => {});
  await discardWorkspaceCheckpoint({ env: { BACKUP_BUCKET: failing }, state });
  assert.equal(await state.currentCheckpoint(), undefined);
  assert.equal(warned.mock.callCount(), 1);
  assert.equal(bucket.keys().length, 2, 'the sweep deletes the leftover after the restore window');

  await state.recordCheckpoint(BACKUP_2, NOW);
  await discardWorkspaceCheckpoint({ env: {}, state });
  assert.equal(await state.currentCheckpoint(), undefined);
});

test('the Sandbox and the state store answer through these host functions, and maintenance sweeps by prefix', () => {
  const source = readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8');
  const sandbox = source.slice(source.indexOf('export class Sandbox extends CloudflareSandbox'), source.indexOf('Sandbox.outboundByHost ='));
  for (const method of ['chickpeaHostExportPage', 'chickpeaHostErase', 'chickpeaHostCancelPendingWork', 'chickpeaHostStopContainer']) {
    assert.match(sandbox, new RegExp(`async ${method}\\(request: Object\\w+\\) \\{\\s*return this\\.host\\(\\)\\.${method}\\(request\\);`), method);
  }
  assert.match(sandbox, /sandboxHostFunctions\(\{\s*env: this\.env,\s*storage: this\.ctx\.storage as unknown as HostObjectStorage,\s*running: \(\) => this\.containerRunning\(\),\s*destroy: \(\) => this\.destroy\(\),\s*stopRecorded: \(\) => containerStopRecorded\(\(\) => this\.getState\(\)\),\s*releaseLease: \(\) => this\.releaseContainerLease\(\),\s*currentCheckpoint: \(\) => this\.workspaceState\(\)\.currentCheckpoint\(\),/);
  // The erasure's release is the stop's own.
  assert.match(sandbox, /override async onStop\([^)]*\): Promise<void> \{\s*await super\.onStop\(params\);\s*await this\.releaseContainerLease\(\);\s*\}/);
  // A discard deletes its checkpoint's objects before it destroys the container.
  assert.match(sandbox, /async discardWorkspace\(\): Promise<void> \{\s*await discardWorkspaceCheckpoint\(\{ env: this\.env, state: this\.workspaceState\(\) \}\);\s*await this\.destroy\(\);\s*\}/);
  const store = source.slice(source.indexOf('export class TagStateStore'));
  assert.match(store, /async chickpeaHostSandboxCensus\(request: ObjectHostRequest & \{ now\?: number \}\) \{\s*return this\.host\(\)\.chickpeaHostSandboxCensus\(request\);/);
  assert.match(source, /if \(isCheckpointSweepMinute\(scheduledTime\)\) \{\s*try \{ await sweepInstallationCheckpoints\(platformEnv, scheduledTime\); \}/);
});
