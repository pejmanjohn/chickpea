import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';

import { installationAgentObject } from '../src/agents/cloudflare-extension.ts';
import { CHICKPEA_ROUTINE_EXECUTION_AGENT_NAME } from '../src/agents/names.ts';
import {
  InstallationContextError,
  objectInstallationEnv,
  scopedObjectName,
  scopeInstallationEnv,
} from '../src/config/installation-scope.ts';
import { sandboxHostFunctions } from '../src/sandbox/sandbox-host.ts';
import { sandboxObjectName } from '../src/sandbox/sandbox-object.ts';
import { agentObjectBindingName, CHICKPEA_SLACK_AGENT_BINDING } from '../src/slack/bounded-agent-observation.ts';
import {
  backfillInstallationObjects,
  installationStateStoreObject,
  exportInstallationObject,
  listInstallationObjects,
  readInstallationObjectRestoreBookmarks,
  restartInstallationObject,
  scheduleInstallationObjectRestore,
  type InstallationObject,
} from '../src/state/installation-objects.ts';
import {
  buildInstallationRestorePlan,
  prepareInstallationRestore,
  type InstallationCensusObject,
} from '../src/state/installation-restore.ts';
import {
  OBJECT_RESTORE_ABORT_REASON,
  ObjectRestoreError,
  objectHostFunctions,
  objectStorageDigest,
  type InstallationObjectRestoreRpc,
  type ObjectRestoreRequest,
  type ObjectRestoreRestartRequest,
} from '../src/state/object-host.ts';
import { BACKFILLED_FIRST_SEEN_AT } from '../src/state/object-inventory.ts';
import { stateStoreHostFunctions } from '../src/state/state-store-host.ts';
import {
  CODING_WORKER_BINDING,
  FakeObjectAbort,
  FakeObjectRestoreContext,
  FakeObjectStorage,
  hostedDeployment,
} from './helpers/installation-objects.ts';

const NOW = 1_800_000_000_000;
const T = NOW - 60_000;
/** Cloudflare's point-in-time recovery window, spelled out so a changed window fails here. */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
const A = 'inst_restore_a';
const B = 'inst_restore_b';
const HOSTED = { CHICKPEA_TENANCY: 'installation' };
const BINDINGS: Record<InstallationObject['kind'], string> = {
  state_store: 'TAG_STATE',
  thread_runner: 'SLACK_THREAD_RUNNER',
  slack_agent: CHICKPEA_SLACK_AGENT_BINDING,
  routine_agent: agentObjectBindingName(CHICKPEA_ROUTINE_EXECUTION_AGENT_NAME),
  coding_worker: CODING_WORKER_BINDING,
  sandbox: 'SANDBOX',
};

function inventory(installationId: string): InstallationObject[] {
  const scope = { installationId };
  const env = scopeInstallationEnv(HOSTED, scope);
  return [
    { kind: 'sandbox', name: sandboxObjectName(env, 'T_RESTORE:C_RESTORE:1.0') },
    { kind: 'routine_agent', name: scopedObjectName(scope, 'routineagent_test') },
    { kind: 'slack_agent', name: scopedObjectName(scope, 'agent_z') },
    { kind: 'coding_worker', name: scopedObjectName(scope, 'codingworker_test') },
    { kind: 'thread_runner', name: scopedObjectName(scope, 'thread_z') },
    { kind: 'slack_agent', name: scopedObjectName(scope, 'agent_a') },
    { kind: 'thread_runner', name: scopedObjectName(scope, 'thread_a') },
  ];
}

function restoreRequest(installationId = A, expectedContentDigest = 'digest_prepared'): ObjectRestoreRequest {
  return { installationId, expectedCurrentBookmark: 'bookmark_current', expectedContentDigest, targetBookmark: 'bookmark_target' };
}

/** The request scheduling presents for an object prepared now: the digest of its storage as it stands. */
async function preparedRequest(storage: FakeObjectStorage, installationId = A): Promise<ObjectRestoreRequest> {
  return restoreRequest(installationId, await objectStorageDigest(storage));
}

/**
 * Storage of every kind a restore replaces: rows in a rowid table and in one
 * without rowid, a setting an export leaves out, key-value entries and an alarm.
 */
async function seed(storage: FakeObjectStorage): Promise<void> {
  storage.sql.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT, data BLOB)');
  storage.sql.exec("INSERT INTO notes (body, data) VALUES ('first', x'00ff'), ('second', NULL)");
  storage.sql.exec('CREATE TABLE pairs (k1 TEXT, k2 INTEGER, value TEXT, PRIMARY KEY (k1, k2)) WITHOUT ROWID');
  storage.sql.exec("INSERT INTO pairs VALUES ('b', 1, 'one'), ('a', 2, 'two')");
  storage.sql.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
  storage.sql.exec("INSERT INTO app_settings VALUES ('sandbox.containerLeases', '{}')");
  await storage.put('kv_a', { value: 1 });
  await storage.put('kv_b', new Map([['x', 1]]));
  await storage.setAlarm(NOW + 60_000);
}

/** A restart presenting the fence `restoreRequest` schedules against. */
function restartRequest(installationId = A): ObjectRestoreRestartRequest {
  return { installationId, expectedCurrentBookmark: 'bookmark_current' };
}

/** A generic object's host functions over its current session, built per call as the classes build them. */
function genericHost(env: Record<string, unknown> = scopeInstallationEnv(HOSTED, { installationId: A })) {
  const storage = new FakeObjectStorage();
  const ctx = storage.restoreContext;
  const session = () => objectHostFunctions({ env, storage, restoreContext: storage.restoreContext });
  return { storage, ctx, host: session(), session };
}

function closeAll(deployment: ReturnType<typeof hostedDeployment>, installationIds: readonly string[]): void {
  const storages = new Set([...installationIds.map((id) => deployment.installation(id).storage),
    ...deployment.objects().map(({ storage }) => storage)]);
  for (const storage of storages) storage.database.close();
}

const unexpected = (): never => { throw new Error('Refusal must precede state or container access'); };

/** A Sandbox's host functions over a fake storage, with its container's running state and recorded status. */
function sandboxHost(storage: FakeObjectStorage, container: { running: boolean; status: string }) {
  return sandboxHostFunctions({
    env: scopeInstallationEnv(HOSTED, { installationId: A }),
    storage,
    restoreContext: storage.restoreContext,
    running: () => container.running,
    destroy: unexpected,
    stopRecorded: unexpected,
    releaseLease: unexpected,
    currentCheckpoint: unexpected,
    containerState: async () => ({ status: container.status }),
  });
}

/**
 * Each alarm write moves the object's bookmark, as each SQLite write does;
 * returns the order of writes, fence reads and digests (each lists the
 * key-value entries once).
 */
function bookmarkFollowsWrites(t: TestContext, storage: FakeObjectStorage): string[] {
  const events: string[] = [];
  let writes = 0;
  const setAlarm = storage.setAlarm.bind(storage);
  const deleteAlarm = storage.deleteAlarm.bind(storage);
  const list = storage.list.bind(storage);
  t.mock.method(storage, 'setAlarm', async (at: number) => { writes += 1; events.push('setAlarm'); await setAlarm(at); });
  t.mock.method(storage, 'deleteAlarm', async () => { writes += 1; events.push('deleteAlarm'); await deleteAlarm(); });
  t.mock.method(storage, 'getCurrentBookmark', async () => { events.push('fence'); return `w${writes}`; });
  t.mock.method(storage, 'list', async (options?: { startAfter?: string; limit?: number }) => {
    events.push('digest');
    return list(options);
  });
  return events;
}

test('preparation reads T, the current fence and the storage digest within the input gate without writing storage', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const { host, storage, ctx } = genericHost();
  t.after(() => storage.database.close());
  await seed(storage);
  const digest = await objectStorageDigest(storage);
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  const getAlarm = storage.getAlarm.bind(storage);
  const alarmRead = t.mock.method(storage, 'getAlarm', async () => {
    assert.equal(ctx.inGate, true, 'the digest reads the alarm last, within the gate');
    return getAlarm();
  });
  const target = t.mock.method(storage, 'getBookmarkForTime', async (timestamp: number | Date) => {
    assert.equal(ctx.inGate, true);
    assert.equal(timestamp, T);
    return 'target_at_T';
  });
  t.mock.method(storage, 'getCurrentBookmark', async () => {
    assert.equal(ctx.inGate, true);
    return 'current_fence';
  });
  assert.deepEqual(await host.chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T }), {
    timestamp: T, currentBookmark: 'current_fence', targetBookmark: 'target_at_T', contentDigest: digest,
  });
  assert.equal(target.mock.callCount(), 1);
  assert.equal(ctx.gates, 1);
  assert.equal(ctx.aborts, 0);
  assert.equal(storage.scheduledRestoreBookmark, undefined);
  assert.equal(storage.deleteAllCalls, 0);
  assert.equal(storage.alarm, NOW + 60_000);
  assert.equal(alarmRead.mock.callCount(), 1);
  alarmRead.mock.restore();
  assert.equal(await objectStorageDigest(storage), digest, 'preparation wrote nothing');
});

test('the storage digest covers everything stored, in key order, and nothing else', async (t) => {
  const left = new FakeObjectStorage();
  const right = new FakeObjectStorage();
  t.after(() => { left.database.close(); right.database.close(); });
  await seed(left);
  // The same storage, written in another order and through other sessions.
  await right.setAlarm(NOW + 60_000);
  await right.put('kv_b', new Map([['x', 1]]));
  await right.put('kv_a', { value: 1 });
  right.restart();
  right.sql.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
  right.sql.exec("INSERT INTO app_settings VALUES ('sandbox.containerLeases', '{}')");
  right.sql.exec('CREATE TABLE pairs (k1 TEXT, k2 INTEGER, value TEXT, PRIMARY KEY (k1, k2)) WITHOUT ROWID');
  right.sql.exec("INSERT INTO pairs VALUES ('a', 2, 'two'), ('b', 1, 'one')");
  right.sql.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT, data BLOB)');
  right.sql.exec("INSERT INTO notes (id, body, data) VALUES (2, 'second', NULL), (1, 'first', x'00ff')");
  assert.notEqual(left.currentBookmark, right.currentBookmark);
  assert.equal(await objectStorageDigest(right), await objectStorageDigest(left));
  // A different value in any one place is different storage.
  right.sql.exec("UPDATE notes SET data = x'00fe' WHERE id = 1");
  assert.notEqual(await objectStorageDigest(right), await objectStorageDigest(left));
});

for (const [label, timestamp] of [
  ['older than 30 days', NOW - THIRTY_DAYS_MS - 1],
  ['equal to now', NOW],
  ['in the future', NOW + 1],
  ['NaN', Number.NaN],
  ['infinite', Number.POSITIVE_INFINITY],
  ['fractional', T + 0.5],
  ['a string', String(T)],
  ['missing', undefined],
] as const) {
  test(`preparation refuses a timestamp ${label} before accessing PITR storage`, async (t) => {
    t.mock.method(Date, 'now', () => NOW);
    const { host, storage, ctx } = genericHost();
    t.after(() => storage.database.close());
    await assert.rejects(host.chickpeaHostRestoreBookmarks({ installationId: A, timestamp: timestamp as number }), {
      name: 'ObjectRestoreError', code: 'restore_time_invalid',
    });
    assert.deepEqual(storage.bookmarkCalls, []);
    assert.equal(ctx.gates, 0);
    assert.equal(ctx.aborts, 0);
  });
}

test('preparation accepts T exactly 30 days ago and T one millisecond before now', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const { host, storage } = genericHost();
  t.after(() => storage.database.close());
  for (const timestamp of [NOW - THIRTY_DAYS_MS, NOW - 1]) {
    assert.equal((await host.chickpeaHostRestoreBookmarks({ installationId: A, timestamp })).timestamp, timestamp);
  }
});

test('scheduling checks the storage against preparation and awaits scheduling in one input gate, returns the receipt and does not restart', async (t) => {
  const { host, storage, ctx } = genericHost();
  t.after(() => storage.database.close());
  await seed(storage);
  const request = await preparedRequest(storage);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const scheduling = new Promise<void>((resolve) => { started = resolve; });
  const calls: string[] = [];
  const getAlarm = storage.getAlarm.bind(storage);
  t.mock.method(storage, 'getAlarm', async () => {
    assert.equal(ctx.inGate, true);
    calls.push('digest');
    return getAlarm();
  });
  t.mock.method(storage, 'onNextSessionRestoreBookmark', async (bookmark: string) => {
    assert.equal(ctx.inGate, true);
    assert.equal(bookmark, 'bookmark_target');
    calls.push('schedule');
    started();
    await pending;
    calls.push('scheduled');
    return 'undo_bookmark';
  });
  const result = host.chickpeaHostRestore(request);
  await scheduling;
  assert.deepEqual(calls, ['digest', 'schedule']);
  release();
  assert.deepEqual(await result, {
    expectedCurrentBookmark: 'bookmark_current',
    expectedContentDigest: request.expectedContentDigest,
    targetBookmark: 'bookmark_target',
    undoBookmark: 'undo_bookmark',
  });
  assert.deepEqual(calls, ['digest', 'schedule', 'scheduled']);
  assert.equal(ctx.gates, 1);
  assert.equal(ctx.aborts, 0);
});

test('a repeated schedule in the same session returns the same receipt without scheduling twice', async (t) => {
  const { host, storage, ctx } = genericHost();
  t.after(() => storage.database.close());
  const request = await preparedRequest(storage);
  const first = await host.chickpeaHostRestore(request);
  // Scheduling may itself write; the repeat must not be refused for it.
  storage.currentBookmark = 'bookmark_after_scheduling';
  await storage.put('written_after_scheduling', true);
  assert.deepEqual(await host.chickpeaHostRestore(request), first);
  assert.equal(first.undoBookmark, 'bookmark_before_restore');
  assert.equal(storage.bookmarkCalls.filter(({ method }) => method === 'onNextSessionRestoreBookmark').length, 1);
  assert.equal(ctx.aborts, 0);
});

test('a session with a restore scheduled refuses another restore or a new preparation', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const { host, storage, ctx } = genericHost();
  t.after(() => storage.database.close());
  const request = await preparedRequest(storage);
  await host.chickpeaHostRestore(request);
  const calls = storage.bookmarkCalls.length;
  await assert.rejects(host.chickpeaHostRestore({ ...request, targetBookmark: 'other_target' }), {
    name: 'ObjectRestoreError', code: 'restore_already_scheduled',
  });
  await assert.rejects(host.chickpeaHostRestore({ ...request, expectedCurrentBookmark: 'other_fence' }), {
    code: 'restore_already_scheduled',
  });
  await assert.rejects(host.chickpeaHostRestore({ ...request, expectedContentDigest: 'other_digest' }), {
    code: 'restore_already_scheduled',
  });
  await assert.rejects(host.chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T }), {
    code: 'restore_already_scheduled',
  });
  assert.equal(storage.bookmarkCalls.length, calls);
  assert.equal(storage.scheduledRestoreBookmark, 'bookmark_target');
  assert.equal(ctx.callbackRejections, 0);
});

test('restart aborts with the named reason only when its session has the restore scheduled; the next session proves it applied', async (t) => {
  const { storage, ctx, session } = genericHost();
  t.after(() => storage.database.close());
  // Nothing scheduled: the object still holds the fence, so it neither restarts nor claims a restore.
  await assert.rejects(session().chickpeaHostRestoreRestart(restartRequest()), {
    name: 'ObjectRestoreError', code: 'restore_not_scheduled',
  });
  assert.equal(ctx.aborts, 0);
  assert.equal(ctx.callbackRejections, 0);
  const receipt = await session().chickpeaHostRestore(await preparedRequest(storage));
  const abort = t.mock.method(ctx, 'abort');
  await assert.rejects(session().chickpeaHostRestoreRestart(restartRequest()), (error) =>
    error instanceof FakeObjectAbort && error.message === OBJECT_RESTORE_ABORT_REASON);
  assert.deepEqual(abort.mock.calls.map((call) => call.arguments), [['Installation point-in-time restore']]);
  assert.equal(ctx.callbackRejections, 0);
  assert.equal(storage.sessions, 2);
  assert.equal(storage.restoredBookmark, 'bookmark_target');
  // The next session has nothing scheduled and its bookmark left the fence: the restore applied.
  assert.deepEqual(await session().chickpeaHostRestoreRestart({
    installationId: A, expectedCurrentBookmark: receipt.expectedCurrentBookmark,
  }), { applied: true, currentBookmark: 'restored:bookmark_target' });
  assert.equal(storage.restoreContext.aborts, 0);
  assert.equal(storage.sessions, 2);
});

test('restart refuses a missing fence before PITR, and one other than the scheduled restore\'s without aborting', async (t) => {
  const { storage, ctx, session } = genericHost();
  t.after(() => storage.database.close());
  for (const invalid of ['', ' ', undefined, 42]) {
    await assert.rejects(session().chickpeaHostRestoreRestart({ installationId: A, expectedCurrentBookmark: invalid as string }), {
      name: 'ObjectRestoreError', code: 'restore_bookmark_invalid',
    });
  }
  assert.deepEqual(storage.bookmarkCalls, []);
  assert.equal(ctx.gates, 0);
  await session().chickpeaHostRestore(await preparedRequest(storage));
  await assert.rejects(session().chickpeaHostRestoreRestart({ installationId: A, expectedCurrentBookmark: 'other_fence' }), {
    name: 'ObjectRestoreError', code: 'restore_already_scheduled',
  });
  assert.equal(ctx.aborts, 0);
  assert.equal(ctx.callbackRejections, 0);
  assert.equal(storage.scheduledRestoreBookmark, 'bookmark_target');
  assert.equal(storage.sessions, 1);
});

test('an object evicted between scheduling and restart answers the first restart call: the restore applied', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const deployment = hostedDeployment([A]);
  t.after(() => closeAll(deployment, [A]));
  const env = deployment.installation(A).env;
  const object = inventory(A).find(({ kind }) => kind === 'thread_runner')!;
  const target = deployment.object(BINDINGS.thread_runner, object.name);
  const bookmarks = await readInstallationObjectRestoreBookmarks(env, object, T);
  const receipt = await scheduleInstallationObjectRestore(env, object, {
    confirmInstallationId: A,
    expectedCurrentBookmark: bookmarks.currentBookmark,
    expectedContentDigest: bookmarks.contentDigest,
    targetBookmark: bookmarks.targetBookmark,
  });
  const scheduledIn = target.storage.restoreContext;
  // Evicted and woken again, with no abort: the new session applies the restore.
  target.storage.restart();
  const reads = target.storage.bookmarkCalls.length;
  assert.deepEqual(await restartInstallationObject(env, object, {
    confirmInstallationId: A, expectedCurrentBookmark: receipt.expectedCurrentBookmark,
  }), { applied: true, currentBookmark: 'restored:bookmark_target' });
  assert.equal(target.storage.restoredBookmark, 'bookmark_target');
  assert.equal(target.storage.scheduledRestoreBookmark, undefined);
  assert.equal(target.storage.sessions, 2);
  assert.equal(scheduledIn.aborts + target.storage.restoreContext.aborts, 0, 'nothing was left to restart');
  assert.deepEqual(target.storage.bookmarkCalls.slice(reads), [{ method: 'getCurrentBookmark' }], 'one call answered');
});

test('a session that keeps running after abort does not report that no restore is pending', async (t) => {
  const { storage, ctx, session } = genericHost();
  t.after(() => storage.database.close());
  await session().chickpeaHostRestore(await preparedRequest(storage));
  t.mock.method(ctx, 'abort', () => undefined);
  await assert.rejects(session().chickpeaHostRestoreRestart(restartRequest()), {
    name: 'ObjectRestoreError', code: 'restore_restarting',
  });
  assert.equal(ctx.callbackRejections, 0);
});

test('an object evicted and woken again since preparation, with nothing written, schedules: only its bookmark moved', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const { storage, session } = genericHost();
  t.after(() => storage.database.close());
  await seed(storage);
  const prepared = await session().chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T });
  // As on staging: idle objects evicted and woken again by a read, each session with a new bookmark.
  storage.restart();
  const reread = await session().chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T });
  assert.notEqual(reread.currentBookmark, prepared.currentBookmark);
  assert.equal(reread.targetBookmark, prepared.targetBookmark);
  assert.equal(reread.contentDigest, prepared.contentDigest);
  storage.restart();
  const request = {
    installationId: A,
    expectedCurrentBookmark: prepared.currentBookmark,
    expectedContentDigest: prepared.contentDigest,
    targetBookmark: prepared.targetBookmark,
  };
  const receipt = await session().chickpeaHostRestore(request);
  assert.deepEqual(receipt, {
    expectedCurrentBookmark: prepared.currentBookmark,
    expectedContentDigest: prepared.contentDigest,
    targetBookmark: prepared.targetBookmark,
    undoBookmark: 'bookmark_before_restore',
  });
  assert.equal(storage.scheduledRestoreBookmark, 'bookmark_target');
  await assert.rejects(session().chickpeaHostRestoreRestart({ installationId: A, expectedCurrentBookmark: prepared.currentBookmark }),
    FakeObjectAbort);
  assert.deepEqual(await session().chickpeaHostRestoreRestart({ installationId: A, expectedCurrentBookmark: prepared.currentBookmark }),
    { applied: true, currentBookmark: 'restored:bookmark_target' });
});

test('a schedule whose answer was lost is asked again: never inferred from a moved bookmark', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const { storage, session } = genericHost();
  t.after(() => storage.database.close());
  await seed(storage);
  const prepared = await session().chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T });
  const request = {
    installationId: A,
    expectedCurrentBookmark: prepared.currentBookmark,
    expectedContentDigest: prepared.contentDigest,
    targetBookmark: prepared.targetBookmark,
  };
  const lost = await session().chickpeaHostRestore(request);
  // The session holding it answers again with the same receipt.
  assert.deepEqual(await session().chickpeaHostRestore(request), lost);
  // Evicted: the restore applied. Storage restored to what it held at preparation schedules again, to the same target.
  storage.restart();
  assert.equal(storage.restoredBookmark, 'bookmark_target');
  const again = await session().chickpeaHostRestore(request);
  assert.equal(again.targetBookmark, 'bookmark_target');
  assert.equal(storage.bookmarkCalls.filter(({ method }) => method === 'onNextSessionRestoreBookmark').length, 2);
  // Evicted again, now holding what it held at T: it refuses, as for a write. Nothing claims the restore applied.
  storage.restart();
  storage.sql.exec('DELETE FROM notes WHERE id = 2');
  await assert.rejects(session().chickpeaHostRestore(request), { code: 'restore_content_moved' });
  assert.equal(storage.scheduledRestoreBookmark, undefined);
});

const WRITES: ReadonlyArray<readonly [string, (storage: FakeObjectStorage) => unknown]> = [
  ['a row inserted', (storage) => storage.sql.exec("INSERT INTO notes (body) VALUES ('later')")],
  ['a row changed', (storage) => storage.sql.exec("UPDATE notes SET body = 'changed' WHERE id = 1")],
  ['a row deleted', (storage) => storage.sql.exec('DELETE FROM notes WHERE id = 2')],
  ['a row of a table without rowid changed', (storage) => storage.sql.exec("UPDATE pairs SET value = 'changed' WHERE k1 = 'a'")],
  ['a setting an export leaves out changed',
    (storage) => storage.sql.exec("UPDATE app_settings SET value = '{\"lease\":1}' WHERE key = 'sandbox.containerLeases'")],
  ['a table created', (storage) => storage.sql.exec('CREATE TABLE later (id INTEGER PRIMARY KEY)')],
  ['an index created', (storage) => storage.sql.exec('CREATE INDEX notes_body ON notes (body)')],
  ['a key-value entry put', (storage) => storage.put('later', { at: 1 })],
  ['a key-value entry changed', (storage) => storage.put('kv_a', { value: 2 })],
  ['a key-value entry deleted', (storage) => storage.kv.delete('kv_b')],
  ['the alarm moved', (storage) => storage.setAlarm(NOW + 120_000)],
  ['the alarm deleted', (storage) => storage.deleteAlarm()],
];

for (const [write, apply] of WRITES) {
  for (const evicted of [false, true]) {
    test(`${write} since preparation${evicted ? ', then an eviction,' : ''} refuses scheduling without resetting the object`, async (t) => {
      t.mock.method(Date, 'now', () => NOW);
      const { storage, session } = genericHost();
      t.after(() => storage.database.close());
      await seed(storage);
      const prepared = await session().chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T });
      const request = {
        installationId: A,
        expectedCurrentBookmark: prepared.currentBookmark,
        expectedContentDigest: prepared.contentDigest,
        targetBookmark: prepared.targetBookmark,
      };
      await apply(storage);
      if (evicted) storage.restart();
      const ctx = storage.restoreContext;
      await assert.rejects(session().chickpeaHostRestore(request), {
        name: 'ObjectRestoreError', code: 'restore_content_moved',
      });
      assert.equal(storage.scheduledRestoreBookmark, undefined);
      assert.equal(ctx.aborts, 0);
      assert.equal(ctx.callbackRejections, 0, 'a rejected gate callback would reset a real object');
      // Reviewed and prepared again, it schedules against what it now stores.
      const again = await session().chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T });
      assert.notEqual(again.contentDigest, prepared.contentDigest);
      await session().chickpeaHostRestore({ ...request, expectedContentDigest: again.contentDigest });
      assert.equal(storage.scheduledRestoreBookmark, 'bookmark_target');
    });
  }
}

for (const [where, write] of [
  ['a row past the first batch', (storage: FakeObjectStorage) => storage.sql.exec("UPDATE notes SET body = 'changed' WHERE id = 450")],
  ['a key-value entry past the first batch', (storage: FakeObjectStorage) => storage.put('many_0300', 'changed')],
] as const) {
  test(`the digest reads past its first batch: ${where} changed refuses scheduling`, async (t) => {
    t.mock.method(Date, 'now', () => NOW);
    const { storage, session } = genericHost();
    t.after(() => storage.database.close());
    await seed(storage);
    for (let id = 3; id <= 500; id += 1) storage.sql.exec('INSERT INTO notes (id, body) VALUES (?, ?)', id, `note ${id}`);
    for (let index = 0; index < 400; index += 1) await storage.put(`many_${String(index).padStart(4, '0')}`, index);
    const prepared = await session().chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T });
    await write(storage);
    await assert.rejects(session().chickpeaHostRestore({
      installationId: A,
      expectedCurrentBookmark: prepared.currentBookmark,
      expectedContentDigest: prepared.contentDigest,
      targetBookmark: prepared.targetBookmark,
    }), { code: 'restore_content_moved' });
  });
}

test('a write that stores the same values again does not refuse scheduling', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const { storage, session } = genericHost();
  t.after(() => storage.database.close());
  await seed(storage);
  const prepared = await session().chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T });
  storage.sql.exec('UPDATE notes SET body = body');
  await storage.put('kv_a', { value: 1 });
  await storage.setAlarm(NOW + 60_000);
  storage.currentBookmark = 'bookmark_after_rewrite';
  await session().chickpeaHostRestore({
    installationId: A,
    expectedCurrentBookmark: prepared.currentBookmark,
    expectedContentDigest: prepared.contentDigest,
    targetBookmark: prepared.targetBookmark,
  });
  assert.equal(storage.scheduledRestoreBookmark, 'bookmark_target');
});

test('invalid or missing bookmarks or content digest are refused without scheduling or aborting', async (t) => {
  const { host, storage, ctx } = genericHost();
  t.after(() => storage.database.close());
  for (const invalid of ['', ' ', undefined, 42]) {
    for (const field of ['expectedCurrentBookmark', 'expectedContentDigest', 'targetBookmark']) {
      await assert.rejects(host.chickpeaHostRestore({ ...restoreRequest(), [field]: invalid }), {
        name: 'ObjectRestoreError', code: 'restore_bookmark_invalid',
      });
    }
  }
  assert.deepEqual(storage.bookmarkCalls, []);
  assert.equal(ctx.aborts, 0);
});

test('PITR lookup and scheduling errors propagate without recording a restore, aborting or resetting', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const { host, storage, ctx } = genericHost();
  t.after(() => storage.database.close());
  const failure = new Error('Bookmark history unavailable');
  t.mock.method(storage, 'getBookmarkForTime', async () => { throw failure; });
  await assert.rejects(host.chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T }), (error) => error === failure);
  t.mock.method(storage, 'onNextSessionRestoreBookmark', async () => { throw failure; });
  await assert.rejects(host.chickpeaHostRestore(await preparedRequest(storage)), (error) => error === failure);
  await assert.rejects(host.chickpeaHostRestoreRestart(restartRequest()), { code: 'restore_not_scheduled' });
  assert.equal(ctx.aborts, 0);
  assert.equal(ctx.callbackRejections, 0);
  assert.equal(storage.scheduledRestoreBookmark, undefined);
});

test('host functions without a SQLite restore context fail closed', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const { storage } = genericHost();
  t.after(() => storage.database.close());
  const host = objectHostFunctions({ env: scopeInstallationEnv(HOSTED, { installationId: A }), storage });
  await assert.rejects(host.chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T }), {
    name: 'ObjectRestoreError', code: 'restore_unavailable',
  });
  await assert.rejects(host.chickpeaHostRestore(restoreRequest()), ObjectRestoreError);
  await assert.rejects(host.chickpeaHostRestoreRestart(restartRequest()), { code: 'restore_unavailable' });
  assert.deepEqual(storage.bookmarkCalls, []);
});

test('generic, state-store and Sandbox host functions refuse standalone and unscoped deployments', async (t) => {
  for (const env of [{}, { CHICKPEA_TENANCY: 'standalone' }, HOSTED]) {
    const storage = new FakeObjectStorage();
    t.after(() => storage.database.close());
    const base = { env, storage, restoreContext: storage.restoreContext };
    const hosts = [
      objectHostFunctions(base),
      stateStoreHostFunctions({ ...base, stores: unexpected, onErased: unexpected }),
      sandboxHostFunctions({
        ...base, running: unexpected, destroy: unexpected, stopRecorded: unexpected,
        releaseLease: unexpected, currentCheckpoint: unexpected, containerState: unexpected,
      }),
    ];
    for (const host of hosts) {
      await assert.rejects(host.chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T }), InstallationContextError);
      await assert.rejects(host.chickpeaHostRestore(restoreRequest()), InstallationContextError);
      await assert.rejects(host.chickpeaHostRestoreRestart(restartRequest()), InstallationContextError);
    }
    assert.deepEqual(storage.bookmarkCalls, []);
    assert.equal(storage.restoreContext.aborts, 0);
  }
});

for (const kind of Object.keys(BINDINGS) as InstallationObject['kind'][]) {
  test(`${kind} host functions check their object's own installation, apply its fence and restart into the restore`, async (t) => {
    t.mock.method(Date, 'now', () => NOW);
    const deployment = hostedDeployment([A, B]);
    t.after(() => closeAll(deployment, [A, B]));
    const env = deployment.installation(A).env;
    const object = buildInstallationRestorePlan(A, inventory(A)).find((item) => item.kind === kind)!;
    const target = deployment.object(BINDINGS[kind], object.name);
    const host = target.host as unknown as InstallationObjectRestoreRpc;
    await assert.rejects(host.chickpeaHostRestoreBookmarks({ installationId: B, timestamp: T }), InstallationContextError);
    await assert.rejects(host.chickpeaHostRestore(restoreRequest(B)), InstallationContextError);
    await assert.rejects(host.chickpeaHostRestoreRestart(restartRequest(B)), InstallationContextError);
    assert.deepEqual(target.storage.bookmarkCalls, []);
    const bookmarks = await readInstallationObjectRestoreBookmarks(env, object, T);
    assert.deepEqual(bookmarks, {
      timestamp: T, currentBookmark: 'bookmark_current', targetBookmark: 'bookmark_target',
      contentDigest: await objectStorageDigest(target.storage),
    });
    const apply = {
      confirmInstallationId: A,
      expectedCurrentBookmark: bookmarks.currentBookmark,
      expectedContentDigest: bookmarks.contentDigest,
      targetBookmark: bookmarks.targetBookmark,
    };
    // Evicted and woken again since preparation: a new bookmark over the same storage.
    target.storage.restart();
    await target.storage.put('written_since_preparation', true);
    await assert.rejects(scheduleInstallationObjectRestore(env, object, apply), { code: 'restore_content_moved' });
    assert.equal(target.storage.scheduledRestoreBookmark, undefined);
    target.storage.kv.delete('written_since_preparation');
    const receipt = await scheduleInstallationObjectRestore(env, object, apply);
    assert.equal(receipt.undoBookmark, 'bookmark_before_restore');
    assert.equal(target.storage.scheduledRestoreBookmark, 'bookmark_target');
    assert.equal(target.storage.sessions, 2, 'scheduling does not restart');
    await assert.rejects(restartInstallationObject(env, object, { confirmInstallationId: A, expectedCurrentBookmark: 'bookmark_moved' }),
      { code: 'restore_already_scheduled' });
    assert.equal(target.storage.sessions, 2, 'a restart presenting another fence does not restart');
    const applied = await restartInstallationObject(env, object, {
      confirmInstallationId: A, expectedCurrentBookmark: receipt.expectedCurrentBookmark,
    });
    assert.deepEqual(applied, { applied: true, currentBookmark: 'restored:bookmark_target' });
    assert.equal(target.storage.restoredBookmark, 'bookmark_target');
    assert.equal(target.storage.sessions, 3);
    assert.equal(deployment.installation(B).storage.scheduledRestoreBookmark, undefined);
    assert.equal(deployment.installation(B).storage.sessions, 1);
  });
}

test('applying a prepared plan schedules and restarts only its installation, leaving every neighbouring object unchanged', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const deployment = hostedDeployment([A, B]);
  t.after(() => closeAll(deployment, [A, B]));
  const planA = buildInstallationRestorePlan(A, inventory(A));
  const planB = buildInstallationRestorePlan(B, inventory(B));
  const neighbourBefore: string[] = [];
  for (const object of [...planA, ...planB]) {
    const target = deployment.object(BINDINGS[object.kind], object.name);
    target.storage.currentBookmark = `current:${object.kind}:${object.name}`;
    target.storage.targetBookmark = `target:${object.kind}:${object.name}`;
    if (!object.name.includes(`~${A}~`)) {
      target.storage.sql.exec('CREATE TABLE restore_neighbour (value TEXT)');
      target.storage.sql.exec('INSERT INTO restore_neighbour VALUES (?)', object.name);
      await target.storage.put('keep', { installationId: B });
      await target.storage.setAlarm(NOW + 100_000);
      neighbourBefore.push((await exportInstallationObject(deployment.installation(B).env, object, { mode: 'full' })).lines);
    }
  }
  const env = deployment.installation(A).env;
  const preparation = await prepareInstallationRestore(env, inventory(A), T);
  assert.deepEqual(preparation.prepared.map(({ object }) => object), planA);
  assert.deepEqual([preparation.skipped, preparation.failed], [[], []]);
  for (const { object, bookmarks } of preparation.prepared) {
    await scheduleInstallationObjectRestore(env, object, {
      confirmInstallationId: A,
      expectedCurrentBookmark: bookmarks.currentBookmark,
      expectedContentDigest: bookmarks.contentDigest,
      targetBookmark: bookmarks.targetBookmark,
    });
  }
  for (const { object, bookmarks } of preparation.prepared) {
    await restartInstallationObject(env, object, { confirmInstallationId: A, expectedCurrentBookmark: bookmarks.currentBookmark });
  }
  for (const object of planA) {
    assert.equal(deployment.object(BINDINGS[object.kind], object.name).storage.restoredBookmark,
      `target:${object.kind}:${object.name}`);
  }
  for (const [index, object] of planB.entries()) {
    const target = deployment.object(BINDINGS[object.kind], object.name);
    assert.equal((await exportInstallationObject(deployment.installation(B).env, object, { mode: 'full' })).lines,
      neighbourBefore[index]);
    assert.deepEqual(target.storage.bookmarkCalls, []);
    assert.equal(target.storage.alarm, NOW + 100_000);
    assert.equal(target.storage.sessions, 1);
  }
});

test('restored objects that write to each other on waking do not move a fence still awaiting its restore', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const deployment = hostedDeployment([A]);
  t.after(() => closeAll(deployment, [A]));
  const env = deployment.installation(A).env;
  const plan = buildInstallationRestorePlan(A, inventory(A));
  const storageOf = (kind: InstallationObject['kind']) =>
    deployment.object(BINDINGS[kind], plan.find((object) => object.kind === kind)!.name).storage;
  for (const object of plan) deployment.object(BINDINGS[object.kind], object.name).storage.targetBookmark = `T:${object.kind}`;
  const store = storageOf('state_store');
  const runner = storageOf('thread_runner');
  const sandbox = storageOf('sandbox');
  const write = (storage: FakeObjectStorage, what: string) => { storage.currentBookmark += `+${what}`; };
  const landed: string[] = [];
  const into = (storage: FakeObjectStorage) => (storage.restoredBookmark ? 'restored' : 'awaiting restore');
  // A Sandbox restored inside a turn records its container's stop and releases its lease in the state store.
  sandbox.onRestart = () => { landed.push(`sandbox lease release -> ${into(store)} state store`); write(store, 'lease'); };
  // A runner's resumed job calls the state store; the state store hands turns to runners.
  runner.onRestart = () => { landed.push(`runner begin -> ${into(store)} state store`); write(store, 'begin'); };
  store.onRestart = () => { landed.push(`state store hand-off -> ${into(runner)} runner`); write(runner, 'handoff'); };
  const preparation = await prepareInstallationRestore(env, inventory(A), T);
  const receipts = [];
  for (const { object, bookmarks } of preparation.prepared) {
    receipts.push(await scheduleInstallationObjectRestore(env, object, {
      confirmInstallationId: A,
      expectedCurrentBookmark: bookmarks.currentBookmark,
      expectedContentDigest: bookmarks.contentDigest,
      targetBookmark: bookmarks.targetBookmark,
    }));
  }
  assert.equal(receipts.length, plan.length);
  for (const [index, { object }] of preparation.prepared.entries()) {
    await restartInstallationObject(env, object, {
      confirmInstallationId: A, expectedCurrentBookmark: receipts[index]!.expectedCurrentBookmark,
    });
  }
  for (const object of plan) {
    assert.equal(deployment.object(BINDINGS[object.kind], object.name).storage.restoredBookmark, `T:${object.kind}`);
  }
  assert.deepEqual(landed, [
    // Restarted first, the store's hand-off reaches a runner whose restore discards it.
    'state store hand-off -> awaiting restore runner',
    'sandbox lease release -> restored state store',
    'runner begin -> restored state store',
  ]);
});

test('a cold Sandbox deletes its container runtime alarm before its fence and digest are read, so scheduling matches', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const storage = new FakeObjectStorage();
  t.after(() => storage.database.close());
  const events = bookmarkFollowsWrites(t, storage);
  const host = sandboxHost(storage, { running: false, status: 'stopped' });
  // The Containers SDK's constructor arms its alarm whenever the Sandbox wakes.
  await storage.setAlarm(NOW + 1_000);
  const bookmarks = await host.chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T });
  assert.deepEqual(events, ['setAlarm', 'deleteAlarm', 'fence', 'digest']);
  assert.equal(storage.alarm, null, 'no alarm remains to delete itself after the fence read');
  assert.equal(bookmarks.currentBookmark, 'w2');
  const receipt = await host.chickpeaHostRestore({
    installationId: A,
    expectedCurrentBookmark: bookmarks.currentBookmark,
    expectedContentDigest: bookmarks.contentDigest,
    targetBookmark: bookmarks.targetBookmark,
  });
  assert.equal(receipt.targetBookmark, 'bookmark_target');
  assert.deepEqual(events, ['setAlarm', 'deleteAlarm', 'fence', 'digest', 'digest']);
  assert.equal(storage.restoreContext.callbackRejections, 0);
});

test('a Sandbox evicted between preparing and scheduling schedules: the alarm its wake arms is deleted before the digest', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const storage = new FakeObjectStorage();
  t.after(() => storage.database.close());
  bookmarkFollowsWrites(t, storage);
  const host = () => sandboxHost(storage, { running: false, status: 'stopped' });
  await storage.setAlarm(NOW + 1_000);
  const first = await host().chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T });
  // Evicted and woken again: the SDK constructor arms its alarm once more.
  storage.restart();
  await storage.setAlarm(NOW + 2_000);
  await host().chickpeaHostRestore({
    installationId: A,
    expectedCurrentBookmark: first.currentBookmark,
    expectedContentDigest: first.contentDigest,
    targetBookmark: first.targetBookmark,
  });
  assert.equal(storage.scheduledRestoreBookmark, 'bookmark_target');
  assert.equal(storage.alarm, null);
});

test('a Sandbox whose wake wrote more than its alarm refuses, then schedules when prepared again at once', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const storage = new FakeObjectStorage();
  t.after(() => storage.database.close());
  const host = () => sandboxHost(storage, { running: false, status: 'stopped' });
  const first = await host().chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T });
  storage.restart();
  await storage.setAlarm(NOW + 2_000);
  await storage.put('container_state_written_on_wake', { status: 'stopped' });
  const request = {
    installationId: A,
    expectedCurrentBookmark: first.currentBookmark,
    expectedContentDigest: first.contentDigest,
    targetBookmark: first.targetBookmark,
  };
  await assert.rejects(host().chickpeaHostRestore(request), { code: 'restore_content_moved' });
  assert.equal(storage.scheduledRestoreBookmark, undefined);
  const again = await host().chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T });
  await host().chickpeaHostRestore({
    ...request, expectedCurrentBookmark: again.currentBookmark, expectedContentDigest: again.contentDigest,
  });
  assert.equal(storage.scheduledRestoreBookmark, 'bookmark_target');
});

for (const status of ['running', 'healthy', 'stopping', 'stopped_with_code']) {
  test(`a Sandbox whose container status reads ${status} refuses without touching its alarm or PITR`, async (t) => {
    t.mock.method(Date, 'now', () => NOW);
    const storage = new FakeObjectStorage();
    t.after(() => storage.database.close());
    const host = sandboxHost(storage, { running: false, status });
    await storage.setAlarm(NOW + 1_000);
    await assert.rejects(host.chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T }), { code: 'restore_object_busy' });
    await assert.rejects(host.chickpeaHostRestore(restoreRequest()), { code: 'restore_object_busy' });
    assert.equal(storage.alarm, NOW + 1_000, 'the alarm still has a stop to record');
    assert.deepEqual(storage.bookmarkCalls, []);
    assert.equal(storage.restoreContext.callbackRejections, 0);
  });
}

test('a Sandbox with a container schedule pending refuses without touching its alarm', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const storage = new FakeObjectStorage();
  t.after(() => storage.database.close());
  storage.sql.exec(`CREATE TABLE container_schedules (id TEXT PRIMARY KEY, callback TEXT NOT NULL, time INTEGER NOT NULL)`);
  storage.sql.exec(`INSERT INTO container_schedules (id, callback, time) VALUES ('s1', 'tick', 1)`);
  await storage.setAlarm(NOW + 1_000);
  const host = sandboxHost(storage, { running: false, status: 'stopped' });
  await assert.rejects(host.chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T }), { code: 'restore_object_busy' });
  assert.equal(storage.alarm, NOW + 1_000);
  storage.sql.exec('DELETE FROM container_schedules');
  await host.chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T });
  assert.equal(storage.alarm, null);
});

test('a restart never settles a Sandbox: one restored inside a turn keeps the alarm that records its stop', async (t) => {
  const storage = new FakeObjectStorage();
  t.after(() => storage.database.close());
  await sandboxHost(storage, { running: false, status: 'stopped' }).chickpeaHostRestore(await preparedRequest(storage));
  storage.restart();
  // Its restored status reads running, and its SDK alarm is armed to record the stop.
  await storage.setAlarm(NOW + 1_000);
  const host = sandboxHost(storage, { running: false, status: 'running' });
  assert.deepEqual(await host.chickpeaHostRestoreRestart(restartRequest()), {
    applied: true, currentBookmark: 'restored:bookmark_target',
  });
  assert.equal(storage.alarm, NOW + 1_000);
});

test('preparing a census skips objects recorded after T, reports failures per object and never skips the state store', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const deployment = hostedDeployment([A]);
  t.after(() => closeAll(deployment, [A]));
  const env = deployment.installation(A).env;
  const [sandbox, routine, agentZ, worker, threadZ, agentA, threadA] = inventory(A);
  const store = installationStateStoreObject(env);
  const census: InstallationCensusObject[] = [
    { ...sandbox!, firstSeenAt: T - 1_000 },
    { ...routine!, firstSeenAt: T },
    { ...agentZ!, firstSeenAt: T + 1 },
    { ...worker! },
    { ...threadZ!, firstSeenAt: T - 1 },
    { ...agentA!, firstSeenAt: T - 5 },
    { ...threadA!, firstSeenAt: T + 60_000 },
    { ...store, firstSeenAt: T + 1 },
  ];
  const failure = new Error('Bookmark history unavailable');
  t.mock.method(deployment.object(BINDINGS.slack_agent, agentA!.name).storage, 'getBookmarkForTime', async () => { throw failure; });
  const result = await prepareInstallationRestore(env, census, T);
  assert.equal(result.timestamp, T);
  assert.deepEqual(result.skipped, [
    { object: { kind: 'thread_runner', name: threadA!.name }, reason: 'younger_than_target', firstSeenAt: T + 60_000 },
    { object: { kind: 'slack_agent', name: agentZ!.name }, reason: 'younger_than_target', firstSeenAt: T + 1 },
  ]);
  assert.deepEqual(result.failed, [{ object: { kind: 'slack_agent', name: agentA!.name }, error: failure }]);
  assert.deepEqual(result.prepared.map(({ object }) => object.kind),
    ['state_store', 'sandbox', 'thread_runner', 'routine_agent', 'coding_worker']);
  assert.ok(result.prepared.every(({ bookmarks }) => bookmarks.timestamp === T && bookmarks.targetBookmark === 'bookmark_target'));
  for (const younger of [threadA!, agentZ!]) {
    assert.deepEqual(deployment.object(BINDINGS[younger.kind], younger.name).storage.bookmarkCalls, []);
  }
  await assert.rejects(prepareInstallationRestore({ CHICKPEA_TENANCY: 'standalone' }, census, T), InstallationContextError);
});

test('names the backfill recovers predate the inventory, so prepare restores them however late the backfill ran', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const deployment = hostedDeployment([A]);
  t.after(() => closeAll(deployment, [A]));
  const installation = deployment.installation(A);
  const scope = { installationId: A };
  const thread = 'T_RESTORE:C_RESTORE:1700000000.000100';
  // Rows a release before the inventory wrote: a thread's route, now on its
  // second owner, and a Slack agent's binding. Nothing recorded their names.
  installation.db.exec('PRAGMA foreign_keys = OFF');
  installation.db.run(
    `INSERT INTO config_agent_thread_routes (workspace_id, channel_id, thread_ts, agent_id, agent_generation,
       owner_incarnation, revision, updated_at) VALUES ('T_RESTORE', 'C_RESTORE', '1700000000.000100', 'agent_legacy', 1, 2, 1, ?)`,
    NOW,
  );
  installation.db.run(
    "INSERT INTO slack_agent_bindings (continuity_key, instance_id, uid, updated_at) VALUES ('legacy', ?, 'uid_legacy', ?)",
    scopedObjectName(scope, 'agent_legacy'), T - 1_000,
  );
  installation.db.exec('PRAGMA foreign_keys = ON');
  // The second owner's runner took its first turn after T, which recorded it.
  installation.stores.objectInventory.recordThreadRunner(`${thread}:owner-i2`);
  // The backfill runs after T, as a host may run it at any time.
  assert.deepEqual((await backfillInstallationObjects(installation.env)).recovered,
    { coding_worker: 0, routine_agent: 0, sandbox: 0, slack_agent: 1, thread_runner: 2 });
  const legacyAgent = { kind: 'slack_agent' as const, name: scopedObjectName(scope, 'agent_legacy') };
  const legacyRunner = { kind: 'thread_runner' as const, name: scopedObjectName(scope, `${thread}:owner-i1`) };
  const liveRunner = { kind: 'thread_runner' as const, name: scopedObjectName(scope, `${thread}:owner-i2`) };
  const census = (await listInstallationObjects(installation.env)).objects;
  assert.equal(BACKFILLED_FIRST_SEEN_AT, 0);
  assert.deepEqual(census, [
    { ...legacyAgent, firstSeenAt: BACKFILLED_FIRST_SEEN_AT },
    { ...legacyRunner, firstSeenAt: BACKFILLED_FIRST_SEEN_AT },
    // Already recorded: the backfill keeps its time.
    { ...liveRunner, firstSeenAt: NOW },
  ]);
  const preparation = await prepareInstallationRestore(installation.env, census, T);
  assert.deepEqual(preparation.prepared.map(({ object }) => object),
    [installationStateStoreObject(installation.env), legacyRunner, legacyAgent]);
  assert.deepEqual(preparation.skipped, [{ object: liveRunner, reason: 'younger_than_target', firstSeenAt: NOW }]);
  assert.deepEqual(preparation.failed, []);
});

test('wrappers refuse standalone, foreign objects and incorrect confirmation before resolving stubs', async () => {
  let addressed = 0;
  const namespace = {
    getByName: () => { addressed += 1; throw new Error('Must not address a stub'); },
    idFromName: () => { addressed += 1; throw new Error('Must not address a stub'); },
    get: () => { addressed += 1; throw new Error('Must not address a stub'); },
  };
  const bindings = Object.fromEntries(Object.values(BINDINGS).map((name) => [name, namespace]));
  const env = scopeInstallationEnv({ ...HOSTED, ...bindings }, { installationId: A });
  const apply = { expectedCurrentBookmark: 'bookmark_current', expectedContentDigest: 'digest', targetBookmark: 'bookmark_target' };
  const restartFence = { expectedCurrentBookmark: 'bookmark_current' };
  for (const object of buildInstallationRestorePlan(B, inventory(B))) {
    await assert.rejects(readInstallationObjectRestoreBookmarks(env, object, T), InstallationContextError);
    await assert.rejects(scheduleInstallationObjectRestore(env, object, { ...apply, confirmInstallationId: A }),
      InstallationContextError);
    await assert.rejects(restartInstallationObject(env, object, { ...restartFence, confirmInstallationId: A }),
      InstallationContextError);
  }
  const store = installationStateStoreObject(env);
  await assert.rejects(scheduleInstallationObjectRestore(env, store, { ...apply, confirmInstallationId: B }),
    InstallationContextError);
  await assert.rejects(restartInstallationObject(env, store, { ...restartFence, confirmInstallationId: B }),
    InstallationContextError);
  await assert.rejects(readInstallationObjectRestoreBookmarks(bindings, store, T), InstallationContextError);
  await assert.rejects(scheduleInstallationObjectRestore(bindings, store, { ...apply, confirmInstallationId: A }),
    InstallationContextError);
  await assert.rejects(restartInstallationObject(bindings, store, { ...restartFence, confirmInstallationId: A }),
    InstallationContextError);
  assert.equal(addressed, 0);
});

test('a restart retries over a fresh stub and gives up after three failed calls', async () => {
  const stubs: object[] = [];
  let calls = 0;
  const env = scopeInstallationEnv({
    ...HOSTED,
    SLACK_THREAD_RUNNER: {
      getByName: () => {
        const stub = {
          chickpeaHostRestoreRestart: async (request: ObjectRestoreRestartRequest) => {
            calls += 1;
            assert.deepEqual(request, { installationId: A, expectedCurrentBookmark: 'fence' });
            throw new Error('Durable Object reset');
          },
        };
        stubs.push(stub);
        return stub;
      },
    },
  }, { installationId: A });
  const runner = inventory(A).find(({ kind }) => kind === 'thread_runner')!;
  await assert.rejects(restartInstallationObject(env, runner, { confirmInstallationId: A, expectedCurrentBookmark: 'fence' }),
    /Durable Object reset/);
  assert.equal(calls, 3);
  assert.equal(new Set(stubs).size, 3);
});

test('the state store refuses a foreign persisted binding without touching PITR', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const deployment = hostedDeployment([A]);
  const installation = deployment.installation(A);
  t.after(() => installation.storage.database.close());
  installation.db.run('UPDATE installation_binding SET installation_id = ?', B);
  const store = installationStateStoreObject(installation.env);
  const apply = { ...restoreRequest(), confirmInstallationId: A };
  await assert.rejects(readInstallationObjectRestoreBookmarks(installation.env, store, T), InstallationContextError);
  await assert.rejects(scheduleInstallationObjectRestore(installation.env, store, apply), InstallationContextError);
  await assert.rejects(restartInstallationObject(installation.env, store, {
    confirmInstallationId: A, expectedCurrentBookmark: 'bookmark_current',
  }), InstallationContextError);
  assert.deepEqual(installation.storage.bookmarkCalls, []);
  assert.equal(installation.storage.restoreContext.callbackRejections, 0);
});

test('a running Sandbox refuses preparation and scheduling without stopping its container or scheduling restore', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const deployment = hostedDeployment([A]);
  const installation = deployment.installation(A);
  const sandbox = inventory(A).find(({ kind }) => kind === 'sandbox')!;
  const object = deployment.object('SANDBOX', sandbox.name);
  t.after(() => { installation.storage.database.close(); object.storage.database.close(); });
  object.container!.running = true;
  await assert.rejects(readInstallationObjectRestoreBookmarks(installation.env, sandbox, T), { code: 'restore_object_busy' });
  await assert.rejects(scheduleInstallationObjectRestore(installation.env, sandbox, { ...restoreRequest(), confirmInstallationId: A }),
    { code: 'restore_object_busy' });
  assert.deepEqual(object.storage.bookmarkCalls, []);
  assert.deepEqual(object.container, { running: true, destroyed: 0 });
  assert.deepEqual(object.lifecycle, []);
  assert.equal(object.storage.restoreContext.callbackRejections, 0);
});

test('the Flue class extension exposes the restore RPCs and derives ownership from its own name', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  class FakeAgentBase {
    constructor(readonly ctx: FakeObjectRestoreContext, readonly env: Record<string, unknown>) {}
  }
  const Agent = installationAgentObject(FakeAgentBase as never) as new (
    ctx: FakeObjectRestoreContext, env: Record<string, unknown>,
  ) => InstallationObjectRestoreRpc;
  for (const [name, env, allowed] of [
    [scopedObjectName({ installationId: A }, 'agent_x'), HOSTED, true],
    ['agent_x', HOSTED, false],
    ['agent_x', {}, false],
  ] as const) {
    const storage = new FakeObjectStorage();
    t.after(() => storage.database.close());
    const ctx = new FakeObjectRestoreContext(storage, { name });
    const agent = new Agent(ctx, env);
    await assert.rejects(agent.chickpeaHostRestoreBookmarks({ installationId: B, timestamp: T }), InstallationContextError);
    await assert.rejects(agent.chickpeaHostRestore(restoreRequest(B)), InstallationContextError);
    await assert.rejects(agent.chickpeaHostRestoreRestart(restartRequest(B)), InstallationContextError);
    if (allowed) {
      assert.equal((await agent.chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T })).targetBookmark,
        'bookmark_target');
      assert.equal((await agent.chickpeaHostRestore(await preparedRequest(storage))).undoBookmark, 'bookmark_before_restore');
      assert.equal(ctx.aborts, 0);
      await assert.rejects(agent.chickpeaHostRestoreRestart(restartRequest()), FakeObjectAbort);
      assert.equal(ctx.aborts, 1);
      assert.equal(storage.restoredBookmark, 'bookmark_target');
    } else {
      await assert.rejects(agent.chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T }), InstallationContextError);
      await assert.rejects(agent.chickpeaHostRestore(restoreRequest()), InstallationContextError);
      await assert.rejects(agent.chickpeaHostRestoreRestart(restartRequest()), InstallationContextError);
      assert.deepEqual(storage.bookmarkCalls, []);
    }
  }
  assert.throws(() => objectInstallationEnv({ id: { name: scopedObjectName({ installationId: A }, 'agent_x') } }, {}),
    InstallationContextError);
});

test('Cloudflare object classes forward the restore RPCs and provide the real lifecycle context', () => {
  const cloudflare = readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8');
  const sandbox = cloudflare.slice(cloudflare.indexOf('export class Sandbox'), cloudflare.indexOf('export class TagStateStore'));
  const state = cloudflare.slice(cloudflare.indexOf('export class TagStateStore'));
  const runner = readFileSync(new URL('../src/slack/thread-runner.ts', import.meta.url), 'utf8');
  for (const source of [sandbox, state, runner]) {
    for (const method of ['chickpeaHostRestoreBookmarks', 'chickpeaHostRestore', 'chickpeaHostRestoreRestart']) {
      assert.match(source, new RegExp(`async ${method}\\(request: [^)]+\\) \\{\\s*return this\\.host\\(\\)\\.${method}\\(request\\);`));
    }
    assert.match(source, /restoreContext: this\.ctx/);
  }
  // The Containers SDK's own status, read through its public getState.
  assert.match(sandbox, /containerState: \(\) => this\.getState\(\),/);
});

test('the pure plan orders the state store first, then Sandboxes, runners and agents, without mutating input', () => {
  const input = Object.freeze(inventory(A).map((object) => Object.freeze(object)));
  const before = JSON.stringify(input);
  const plan = buildInstallationRestorePlan(A, input);
  assert.deepEqual(plan.map(({ kind }) => kind), [
    'state_store', 'sandbox', 'thread_runner', 'thread_runner', 'slack_agent', 'slack_agent', 'routine_agent', 'coding_worker',
  ]);
  assert.equal(plan[0]!.name, scopedObjectName({ installationId: A }, 'singleton'));
  assert.equal(plan[2]!.name, scopedObjectName({ installationId: A }, 'thread_a'));
  assert.equal(plan[4]!.name, scopedObjectName({ installationId: A }, 'agent_a'));
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(buildInstallationRestorePlan(A, [...input].reverse()), plan);
  assert.notEqual(plan[1], input.find(({ name }) => name === plan[1]!.name));
});

test('the plan includes the implicit state store once, first, including an empty inventory', () => {
  const state: InstallationObject = { kind: 'state_store', name: scopedObjectName({ installationId: A }, 'singleton') };
  assert.deepEqual(buildInstallationRestorePlan(A, []), [state]);
  const plan = buildInstallationRestorePlan(A, [...inventory(A), state]);
  assert.equal(plan.filter(({ kind }) => kind === 'state_store').length, 1);
  assert.deepEqual(plan[0], state);
});

test('the plan refuses foreign or malformed names, wrong state stores, duplicates and unknown kinds', () => {
  for (const object of inventory(B)) assert.throws(() => buildInstallationRestorePlan(A, [object]), InstallationContextError);
  for (const name of ['agent_x', 'i1~inst_restore_a~', 'i1~bad id~agent_x']) {
    assert.throws(() => buildInstallationRestorePlan(A, [{ kind: 'slack_agent', name }]), InstallationContextError);
  }
  assert.throws(() => buildInstallationRestorePlan(A, [{ kind: 'state_store', name: scopedObjectName({ installationId: A }, 'other') }]),
    InstallationContextError);
  assert.throws(() => buildInstallationRestorePlan(A, [inventory(A)[0]!, inventory(A)[0]!]), /duplicate/);
  assert.throws(() => buildInstallationRestorePlan(A, [{ kind: 'unknown', name: scopedObjectName({ installationId: A }, 'x') } as never]),
    /Unknown installation object kind/);
  assert.throws(() => buildInstallationRestorePlan('bad id', []), InstallationContextError);
});
