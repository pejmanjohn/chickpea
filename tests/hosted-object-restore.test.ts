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
  installationStateStoreObject,
  exportInstallationObject,
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
  type InstallationObjectRestoreRpc,
  type ObjectRestoreRequest,
} from '../src/state/object-host.ts';
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

function restoreRequest(installationId = A): ObjectRestoreRequest {
  return { installationId, expectedCurrentBookmark: 'bookmark_current', targetBookmark: 'bookmark_target' };
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

/** Each alarm write moves the object's bookmark, as each SQLite write does; returns the order of writes and reads. */
function bookmarkFollowsWrites(t: TestContext, storage: FakeObjectStorage): string[] {
  const events: string[] = [];
  let writes = 0;
  const setAlarm = storage.setAlarm.bind(storage);
  const deleteAlarm = storage.deleteAlarm.bind(storage);
  t.mock.method(storage, 'setAlarm', async (at: number) => { writes += 1; events.push('setAlarm'); await setAlarm(at); });
  t.mock.method(storage, 'deleteAlarm', async () => { writes += 1; events.push('deleteAlarm'); await deleteAlarm(); });
  t.mock.method(storage, 'getCurrentBookmark', async () => { events.push('fence'); return `w${writes}`; });
  return events;
}

test('preparation reads T and the current fence within the input gate without writing storage', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const { host, storage, ctx } = genericHost();
  t.after(() => storage.database.close());
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
    timestamp: T, currentBookmark: 'current_fence', targetBookmark: 'target_at_T',
  });
  assert.equal(target.mock.callCount(), 1);
  assert.equal(ctx.gates, 1);
  assert.equal(ctx.aborts, 0);
  assert.equal(storage.scheduledRestoreBookmark, undefined);
  assert.equal(storage.deleteAllCalls, 0);
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

test('scheduling checks the fence and awaits scheduling in one input gate, returns the receipt and does not restart', async (t) => {
  const { host, storage, ctx } = genericHost();
  t.after(() => storage.database.close());
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const scheduling = new Promise<void>((resolve) => { started = resolve; });
  const calls: string[] = [];
  t.mock.method(storage, 'getCurrentBookmark', async () => {
    assert.equal(ctx.inGate, true);
    calls.push('fence');
    return 'bookmark_current';
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
  const result = host.chickpeaHostRestore(restoreRequest());
  await scheduling;
  assert.deepEqual(calls, ['fence', 'schedule']);
  release();
  assert.deepEqual(await result, {
    expectedCurrentBookmark: 'bookmark_current', targetBookmark: 'bookmark_target', undoBookmark: 'undo_bookmark',
  });
  assert.deepEqual(calls, ['fence', 'schedule', 'scheduled']);
  assert.equal(ctx.gates, 1);
  assert.equal(ctx.aborts, 0);
});

test('a repeated schedule in the same session returns the same receipt without scheduling twice', async (t) => {
  const { host, storage, ctx } = genericHost();
  t.after(() => storage.database.close());
  const first = await host.chickpeaHostRestore(restoreRequest());
  // Scheduling may itself move the bookmark; the repeat must not be refused for it.
  storage.currentBookmark = 'bookmark_after_scheduling';
  assert.deepEqual(await host.chickpeaHostRestore(restoreRequest()), first);
  assert.equal(first.undoBookmark, 'bookmark_before_restore');
  assert.equal(storage.bookmarkCalls.filter(({ method }) => method === 'onNextSessionRestoreBookmark').length, 1);
  assert.equal(ctx.aborts, 0);
});

test('a session with a restore scheduled refuses another restore or a new preparation', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const { host, storage, ctx } = genericHost();
  t.after(() => storage.database.close());
  await host.chickpeaHostRestore(restoreRequest());
  const calls = storage.bookmarkCalls.length;
  await assert.rejects(host.chickpeaHostRestore({ ...restoreRequest(), targetBookmark: 'other_target' }), {
    name: 'ObjectRestoreError', code: 'restore_already_scheduled',
  });
  await assert.rejects(host.chickpeaHostRestore({ ...restoreRequest(), expectedCurrentBookmark: 'other_fence' }), {
    code: 'restore_already_scheduled',
  });
  await assert.rejects(host.chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T }), {
    code: 'restore_already_scheduled',
  });
  assert.equal(storage.bookmarkCalls.length, calls);
  assert.equal(storage.scheduledRestoreBookmark, 'bookmark_target');
  assert.equal(ctx.callbackRejections, 0);
});

test('restart aborts with the named reason only when its session has a restore scheduled; the next session confirms', async (t) => {
  const { storage, ctx, session } = genericHost();
  t.after(() => storage.database.close());
  // Nothing scheduled: a read, no restart.
  assert.deepEqual(await session().chickpeaHostRestoreRestart({ installationId: A }), {
    restorePending: false, currentBookmark: 'bookmark_current',
  });
  assert.equal(ctx.aborts, 0);
  const receipt = await session().chickpeaHostRestore(restoreRequest());
  const abort = t.mock.method(ctx, 'abort');
  await assert.rejects(session().chickpeaHostRestoreRestart({ installationId: A }), (error) =>
    error instanceof FakeObjectAbort && error.message === OBJECT_RESTORE_ABORT_REASON);
  assert.deepEqual(abort.mock.calls.map((call) => call.arguments), [['Installation point-in-time restore']]);
  assert.equal(ctx.callbackRejections, 0);
  assert.equal(storage.sessions, 2);
  assert.equal(storage.restoredBookmark, 'bookmark_target');
  // The next session has nothing scheduled: it answers, and its bookmark is no longer the prepared fence.
  const next = await session().chickpeaHostRestoreRestart({ installationId: A });
  assert.equal(next.restorePending, false);
  assert.notEqual(next.currentBookmark, receipt.expectedCurrentBookmark);
  assert.equal(storage.restoreContext.aborts, 0);
  assert.equal(storage.sessions, 2);
});

test('a session that keeps running after abort does not report that no restore is pending', async (t) => {
  const { storage, ctx, session } = genericHost();
  t.after(() => storage.database.close());
  await session().chickpeaHostRestore(restoreRequest());
  t.mock.method(ctx, 'abort', () => undefined);
  await assert.rejects(session().chickpeaHostRestoreRestart({ installationId: A }), {
    name: 'ObjectRestoreError', code: 'restore_restarting',
  });
  assert.equal(ctx.callbackRejections, 0);
});

test('a moved bookmark refuses scheduling and does not reset the object', async (t) => {
  const { host, storage, ctx } = genericHost();
  t.after(() => storage.database.close());
  storage.currentBookmark = 'bookmark_changed';
  await assert.rejects(host.chickpeaHostRestore(restoreRequest()), {
    name: 'ObjectRestoreError', code: 'restore_bookmark_moved',
  });
  assert.deepEqual(storage.bookmarkCalls, [{ method: 'getCurrentBookmark' }]);
  assert.equal(storage.scheduledRestoreBookmark, undefined);
  assert.equal(ctx.aborts, 0);
  assert.equal(ctx.callbackRejections, 0, 'a rejected gate callback would reset a real object');
  // Nothing was scheduled, so a restart does not abort.
  assert.equal((await host.chickpeaHostRestoreRestart({ installationId: A })).restorePending, false);
  assert.equal(ctx.aborts, 0);
});

test('invalid or missing bookmarks are refused without scheduling or aborting', async (t) => {
  const { host, storage, ctx } = genericHost();
  t.after(() => storage.database.close());
  for (const invalid of ['', ' ', undefined, 42]) {
    for (const field of ['expectedCurrentBookmark', 'targetBookmark']) {
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
  await assert.rejects(host.chickpeaHostRestore(restoreRequest()), (error) => error === failure);
  assert.equal((await host.chickpeaHostRestoreRestart({ installationId: A })).restorePending, false);
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
  await assert.rejects(host.chickpeaHostRestoreRestart({ installationId: A }), { code: 'restore_unavailable' });
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
      await assert.rejects(host.chickpeaHostRestoreRestart({ installationId: A }), InstallationContextError);
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
    await assert.rejects(host.chickpeaHostRestoreRestart({ installationId: B }), InstallationContextError);
    assert.deepEqual(target.storage.bookmarkCalls, []);
    const bookmarks = await readInstallationObjectRestoreBookmarks(env, object, T);
    assert.deepEqual(bookmarks, { timestamp: T, currentBookmark: 'bookmark_current', targetBookmark: 'bookmark_target' });
    const apply = { confirmInstallationId: A, expectedCurrentBookmark: bookmarks.currentBookmark, targetBookmark: bookmarks.targetBookmark };
    target.storage.currentBookmark = 'bookmark_moved';
    await assert.rejects(scheduleInstallationObjectRestore(env, object, apply), { code: 'restore_bookmark_moved' });
    assert.equal(target.storage.scheduledRestoreBookmark, undefined);
    target.storage.currentBookmark = bookmarks.currentBookmark;
    const receipt = await scheduleInstallationObjectRestore(env, object, apply);
    assert.equal(receipt.undoBookmark, 'bookmark_before_restore');
    assert.equal(target.storage.scheduledRestoreBookmark, 'bookmark_target');
    assert.equal(target.storage.sessions, 1, 'scheduling does not restart');
    const session = await restartInstallationObject(env, object, { confirmInstallationId: A });
    assert.deepEqual(session, { restorePending: false, currentBookmark: 'restored:bookmark_target' });
    assert.equal(target.storage.restoredBookmark, 'bookmark_target');
    assert.equal(target.storage.sessions, 2);
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
      confirmInstallationId: A, expectedCurrentBookmark: bookmarks.currentBookmark, targetBookmark: bookmarks.targetBookmark,
    });
  }
  for (const { object } of preparation.prepared) await restartInstallationObject(env, object, { confirmInstallationId: A });
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
      confirmInstallationId: A, expectedCurrentBookmark: bookmarks.currentBookmark, targetBookmark: bookmarks.targetBookmark,
    }));
  }
  assert.equal(receipts.length, plan.length);
  for (const { object } of preparation.prepared) await restartInstallationObject(env, object, { confirmInstallationId: A });
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

test('a cold Sandbox deletes its container runtime alarm before its fence is read, so scheduling in that session matches', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const storage = new FakeObjectStorage();
  t.after(() => storage.database.close());
  const events = bookmarkFollowsWrites(t, storage);
  const host = sandboxHost(storage, { running: false, status: 'stopped' });
  // The Containers SDK's constructor arms its alarm whenever the Sandbox wakes.
  await storage.setAlarm(NOW + 1_000);
  const bookmarks = await host.chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T });
  assert.deepEqual(events, ['setAlarm', 'deleteAlarm', 'fence']);
  assert.equal(storage.alarm, null, 'no alarm remains to delete itself after the fence read');
  assert.equal(bookmarks.currentBookmark, 'w2');
  const receipt = await host.chickpeaHostRestore({
    installationId: A, expectedCurrentBookmark: bookmarks.currentBookmark, targetBookmark: bookmarks.targetBookmark,
  });
  assert.equal(receipt.targetBookmark, 'bookmark_target');
  assert.deepEqual(events, ['setAlarm', 'deleteAlarm', 'fence', 'fence']);
  assert.equal(storage.restoreContext.callbackRejections, 0);
});

test('a Sandbox evicted between preparing and scheduling refuses, then schedules when prepared again at once', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const storage = new FakeObjectStorage();
  t.after(() => storage.database.close());
  bookmarkFollowsWrites(t, storage);
  const host = sandboxHost(storage, { running: false, status: 'stopped' });
  await storage.setAlarm(NOW + 1_000);
  const first = await host.chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T });
  // Evicted and woken again: the SDK constructor arms its alarm once more.
  await storage.setAlarm(NOW + 2_000);
  await assert.rejects(host.chickpeaHostRestore({
    installationId: A, expectedCurrentBookmark: first.currentBookmark, targetBookmark: first.targetBookmark,
  }), { code: 'restore_bookmark_moved' });
  assert.equal(storage.scheduledRestoreBookmark, undefined);
  const again = await host.chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T });
  await host.chickpeaHostRestore({
    installationId: A, expectedCurrentBookmark: again.currentBookmark, targetBookmark: again.targetBookmark,
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
  await storage.setAlarm(NOW + 1_000);
  const host = sandboxHost(storage, { running: false, status: 'running' });
  assert.deepEqual(await host.chickpeaHostRestoreRestart({ installationId: A }), {
    restorePending: false, currentBookmark: 'bookmark_current',
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

test('wrappers refuse standalone, foreign objects and incorrect confirmation before resolving stubs', async () => {
  let addressed = 0;
  const namespace = {
    getByName: () => { addressed += 1; throw new Error('Must not address a stub'); },
    idFromName: () => { addressed += 1; throw new Error('Must not address a stub'); },
    get: () => { addressed += 1; throw new Error('Must not address a stub'); },
  };
  const bindings = Object.fromEntries(Object.values(BINDINGS).map((name) => [name, namespace]));
  const env = scopeInstallationEnv({ ...HOSTED, ...bindings }, { installationId: A });
  const apply = { expectedCurrentBookmark: 'bookmark_current', targetBookmark: 'bookmark_target' };
  for (const object of buildInstallationRestorePlan(B, inventory(B))) {
    await assert.rejects(readInstallationObjectRestoreBookmarks(env, object, T), InstallationContextError);
    await assert.rejects(scheduleInstallationObjectRestore(env, object, { ...apply, confirmInstallationId: A }),
      InstallationContextError);
    await assert.rejects(restartInstallationObject(env, object, { confirmInstallationId: A }), InstallationContextError);
  }
  const store = installationStateStoreObject(env);
  await assert.rejects(scheduleInstallationObjectRestore(env, store, { ...apply, confirmInstallationId: B }),
    InstallationContextError);
  await assert.rejects(restartInstallationObject(env, store, { confirmInstallationId: B }), InstallationContextError);
  await assert.rejects(readInstallationObjectRestoreBookmarks(bindings, store, T), InstallationContextError);
  await assert.rejects(scheduleInstallationObjectRestore(bindings, store, { ...apply, confirmInstallationId: A }),
    InstallationContextError);
  await assert.rejects(restartInstallationObject(bindings, store, { confirmInstallationId: A }), InstallationContextError);
  assert.equal(addressed, 0);
});

test('a restart retries over a fresh stub and gives up after three failed calls', async () => {
  const stubs: object[] = [];
  let calls = 0;
  const env = scopeInstallationEnv({
    ...HOSTED,
    SLACK_THREAD_RUNNER: {
      getByName: () => {
        const stub = { chickpeaHostRestoreRestart: async () => { calls += 1; throw new Error('Durable Object reset'); } };
        stubs.push(stub);
        return stub;
      },
    },
  }, { installationId: A });
  const runner = inventory(A).find(({ kind }) => kind === 'thread_runner')!;
  await assert.rejects(restartInstallationObject(env, runner, { confirmInstallationId: A }), /Durable Object reset/);
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
  await assert.rejects(restartInstallationObject(installation.env, store, { confirmInstallationId: A }),
    InstallationContextError);
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
    await assert.rejects(agent.chickpeaHostRestoreRestart({ installationId: B }), InstallationContextError);
    if (allowed) {
      assert.equal((await agent.chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T })).targetBookmark,
        'bookmark_target');
      assert.equal((await agent.chickpeaHostRestore(restoreRequest())).undoBookmark, 'bookmark_before_restore');
      assert.equal(ctx.aborts, 0);
      await assert.rejects(agent.chickpeaHostRestoreRestart({ installationId: A }), FakeObjectAbort);
      assert.equal(ctx.aborts, 1);
      assert.equal(storage.restoredBookmark, 'bookmark_target');
    } else {
      await assert.rejects(agent.chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T }), InstallationContextError);
      await assert.rejects(agent.chickpeaHostRestore(restoreRequest()), InstallationContextError);
      await assert.rejects(agent.chickpeaHostRestoreRestart({ installationId: A }), InstallationContextError);
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
