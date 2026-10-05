import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

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
  restoreInstallationObject,
  type InstallationObject,
} from '../src/state/installation-objects.ts';
import { buildInstallationRestorePlan } from '../src/state/installation-restore.ts';
import {
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

function genericHost(env: Record<string, unknown> = scopeInstallationEnv(HOSTED, { installationId: A })) {
  const storage = new FakeObjectStorage();
  const ctx = storage.restoreContext;
  return { storage, ctx, host: objectHostFunctions({ env, storage, restoreContext: ctx }) };
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

test('preparation accepts T exactly 30 days ago and T equal to now', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const { host, storage } = genericHost();
  t.after(() => storage.database.close());
  for (const timestamp of [NOW - THIRTY_DAYS_MS, NOW]) {
    assert.equal((await host.chickpeaHostRestoreBookmarks({ installationId: A, timestamp })).timestamp, timestamp);
  }
});

test('restore checks the fence, awaits scheduling, then aborts, all within one input gate', async (t) => {
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
  t.mock.method(ctx, 'abort', () => {
    assert.equal(ctx.inGate, true);
    calls.push('abort');
    throw new FakeObjectAbort();
  });
  const result = host.chickpeaHostRestore(restoreRequest());
  const rejected = assert.rejects(result, FakeObjectAbort);
  await scheduling;
  assert.deepEqual(calls, ['fence', 'schedule']);
  release();
  await rejected;
  assert.deepEqual(calls, ['fence', 'schedule', 'scheduled', 'abort']);
  assert.equal(ctx.gates, 1);
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

test('PITR lookup and scheduling errors propagate without aborting or resetting', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const { host, storage, ctx } = genericHost();
  t.after(() => storage.database.close());
  const failure = new Error('Bookmark history unavailable');
  t.mock.method(storage, 'getBookmarkForTime', async () => { throw failure; });
  await assert.rejects(host.chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T }), (error) => error === failure);
  t.mock.method(storage, 'onNextSessionRestoreBookmark', async () => { throw failure; });
  await assert.rejects(host.chickpeaHostRestore(restoreRequest()), (error) => error === failure);
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
  assert.deepEqual(storage.bookmarkCalls, []);
});

test('generic, state-store and Sandbox host functions refuse standalone and unscoped deployments', async (t) => {
  for (const env of [{}, { CHICKPEA_TENANCY: 'standalone' }, HOSTED]) {
    const storage = new FakeObjectStorage();
    t.after(() => storage.database.close());
    const base = { env, storage, restoreContext: storage.restoreContext };
    const unexpected = () => { throw new Error('Refusal must precede state or container access'); };
    const hosts = [
      objectHostFunctions(base),
      stateStoreHostFunctions({ ...base, stores: unexpected, onErased: unexpected }),
      sandboxHostFunctions({
        ...base, running: unexpected, destroy: unexpected, stopRecorded: unexpected,
        releaseLease: unexpected, currentCheckpoint: unexpected,
      }),
    ];
    for (const host of hosts) {
      await assert.rejects(host.chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T }), InstallationContextError);
      await assert.rejects(host.chickpeaHostRestore(restoreRequest()), InstallationContextError);
    }
    assert.deepEqual(storage.bookmarkCalls, []);
    assert.equal(storage.restoreContext.aborts, 0);
  }
});

for (const kind of Object.keys(BINDINGS) as InstallationObject['kind'][]) {
  test(`${kind} host functions check their object's own installation and apply its fence`, async (t) => {
    t.mock.method(Date, 'now', () => NOW);
    const deployment = hostedDeployment([A, B]);
    t.after(() => {
      const storages = new Set([deployment.installation(A).storage, deployment.installation(B).storage,
        ...deployment.objects().map(({ storage }) => storage)]);
      for (const storage of storages) storage.database.close();
    });
    const object = buildInstallationRestorePlan(A, inventory(A)).find((item) => item.kind === kind)!;
    const target = deployment.object(BINDINGS[kind], object.name);
    const host = target.host as unknown as InstallationObjectRestoreRpc;
    await assert.rejects(host.chickpeaHostRestoreBookmarks({ installationId: B, timestamp: T }), InstallationContextError);
    await assert.rejects(host.chickpeaHostRestore(restoreRequest(B)), InstallationContextError);
    assert.deepEqual(target.storage.bookmarkCalls, []);
    const bookmarks = await readInstallationObjectRestoreBookmarks(deployment.installation(A).env, object, T);
    assert.deepEqual(bookmarks, { timestamp: T, currentBookmark: 'bookmark_current', targetBookmark: 'bookmark_target' });
    target.storage.currentBookmark = 'bookmark_moved';
    await assert.rejects(restoreInstallationObject(deployment.installation(A).env, object, {
      confirmInstallationId: A, expectedCurrentBookmark: bookmarks.currentBookmark, targetBookmark: bookmarks.targetBookmark,
    }), { code: 'restore_bookmark_moved' });
    assert.equal(target.storage.scheduledRestoreBookmark, undefined);
    assert.equal(target.storage.restoreContext.aborts, 0);
    target.storage.currentBookmark = bookmarks.currentBookmark;
    await assert.rejects(restoreInstallationObject(deployment.installation(A).env, object, {
      confirmInstallationId: A, expectedCurrentBookmark: bookmarks.currentBookmark, targetBookmark: bookmarks.targetBookmark,
    }), FakeObjectAbort);
    assert.equal(target.storage.scheduledRestoreBookmark, 'bookmark_target');
    assert.equal(target.storage.restoreContext.aborts, 1);
    assert.equal(deployment.installation(B).storage.scheduledRestoreBookmark, undefined);
  });
}

test('applying a prepared plan schedules only its installation, leaving every neighbouring object unchanged', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const deployment = hostedDeployment([A, B]);
  t.after(() => {
    for (const storage of new Set(deployment.objects().map((object) => object.storage))) storage.database.close();
  });
  const planA = buildInstallationRestorePlan(A, inventory(A));
  const planB = buildInstallationRestorePlan(B, inventory(B));
  const applied: string[] = [];
  const neighbourBefore: string[] = [];
  for (const object of [...planA, ...planB]) {
    const target = deployment.object(BINDINGS[object.kind], object.name);
    target.storage.currentBookmark = `current:${object.kind}:${object.name}`;
    target.storage.targetBookmark = `target:${object.kind}:${object.name}`;
    if (object.name.includes(`~${A}~`)) {
      const schedule = target.storage.onNextSessionRestoreBookmark.bind(target.storage);
      t.mock.method(target.storage, 'onNextSessionRestoreBookmark', async (bookmark: string) => {
        applied.push(object.name);
        return schedule(bookmark);
      });
    } else {
      target.storage.sql.exec('CREATE TABLE restore_neighbour (value TEXT)');
      target.storage.sql.exec('INSERT INTO restore_neighbour VALUES (?)', object.name);
      await target.storage.put('keep', { installationId: B });
      await target.storage.setAlarm(NOW + 100_000);
      neighbourBefore.push((await exportInstallationObject(deployment.installation(B).env, object, { mode: 'full' })).lines);
    }
  }
  const prepared = [];
  for (const object of planA) {
    prepared.push({ object, bookmarks: await readInstallationObjectRestoreBookmarks(deployment.installation(A).env, object, T) });
  }
  for (const { object, bookmarks } of prepared) {
    await assert.rejects(restoreInstallationObject(deployment.installation(A).env, object, {
      confirmInstallationId: A, expectedCurrentBookmark: bookmarks.currentBookmark, targetBookmark: bookmarks.targetBookmark,
    }), FakeObjectAbort);
    assert.equal(deployment.object(BINDINGS[object.kind], object.name).storage.scheduledRestoreBookmark,
      `target:${object.kind}:${object.name}`);
  }
  assert.deepEqual(applied, planA.map(({ name }) => name));
  for (const [index, object] of planB.entries()) {
    const target = deployment.object(BINDINGS[object.kind], object.name);
    assert.equal((await exportInstallationObject(deployment.installation(B).env, object, { mode: 'full' })).lines,
      neighbourBefore[index]);
    assert.deepEqual(target.storage.bookmarkCalls, []);
    assert.equal(target.storage.alarm, NOW + 100_000);
    assert.equal(target.storage.restoreContext.aborts, 0);
  }
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
  for (const object of buildInstallationRestorePlan(B, inventory(B))) {
    await assert.rejects(readInstallationObjectRestoreBookmarks(env, object, T), InstallationContextError);
    await assert.rejects(restoreInstallationObject(env, object, { ...restoreRequest(), confirmInstallationId: A }),
      InstallationContextError);
  }
  const store = installationStateStoreObject(env);
  await assert.rejects(restoreInstallationObject(env, store, { ...restoreRequest(), confirmInstallationId: B }),
    InstallationContextError);
  await assert.rejects(readInstallationObjectRestoreBookmarks(bindings, store, T), InstallationContextError);
  await assert.rejects(restoreInstallationObject(bindings, store, { ...restoreRequest(), confirmInstallationId: A }),
    InstallationContextError);
  assert.equal(addressed, 0);
});

test('the state store refuses a foreign persisted binding without touching PITR', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const deployment = hostedDeployment([A]);
  const installation = deployment.installation(A);
  t.after(() => installation.storage.database.close());
  installation.db.run('UPDATE installation_binding SET installation_id = ?', B);
  const store = installationStateStoreObject(installation.env);
  await assert.rejects(readInstallationObjectRestoreBookmarks(installation.env, store, T), InstallationContextError);
  await assert.rejects(restoreInstallationObject(installation.env, store, { ...restoreRequest(), confirmInstallationId: A }),
    InstallationContextError);
  assert.deepEqual(installation.storage.bookmarkCalls, []);
  assert.equal(installation.storage.restoreContext.callbackRejections, 0);
});

test('a running Sandbox refuses both calls without stopping its container or scheduling restore', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const deployment = hostedDeployment([A]);
  const installation = deployment.installation(A);
  const sandbox = inventory(A).find(({ kind }) => kind === 'sandbox')!;
  const object = deployment.object('SANDBOX', sandbox.name);
  t.after(() => { installation.storage.database.close(); object.storage.database.close(); });
  object.container!.running = true;
  await assert.rejects(readInstallationObjectRestoreBookmarks(installation.env, sandbox, T), { code: 'restore_object_busy' });
  await assert.rejects(restoreInstallationObject(installation.env, sandbox, { ...restoreRequest(), confirmInstallationId: A }),
    { code: 'restore_object_busy' });
  assert.deepEqual(object.storage.bookmarkCalls, []);
  assert.deepEqual(object.container, { running: true, destroyed: 0 });
  assert.deepEqual(object.lifecycle, []);
  assert.equal(object.storage.restoreContext.callbackRejections, 0);
});

test('the Flue class extension exposes both RPCs and derives ownership from its own name', async (t) => {
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
    if (allowed) {
      assert.equal((await agent.chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T })).targetBookmark,
        'bookmark_target');
      await assert.rejects(agent.chickpeaHostRestore(restoreRequest()), FakeObjectAbort);
      assert.equal(ctx.aborts, 1);
    } else {
      await assert.rejects(agent.chickpeaHostRestoreBookmarks({ installationId: A, timestamp: T }), InstallationContextError);
      await assert.rejects(agent.chickpeaHostRestore(restoreRequest()), InstallationContextError);
      assert.deepEqual(storage.bookmarkCalls, []);
    }
  }
  assert.throws(() => objectInstallationEnv({ id: { name: scopedObjectName({ installationId: A }, 'agent_x') } }, {}),
    InstallationContextError);
});

test('Cloudflare object classes forward both restore RPCs and provide the real lifecycle context', () => {
  const cloudflare = readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8');
  const sandbox = cloudflare.slice(cloudflare.indexOf('export class Sandbox'), cloudflare.indexOf('export class TagStateStore'));
  const state = cloudflare.slice(cloudflare.indexOf('export class TagStateStore'));
  const runner = readFileSync(new URL('../src/slack/thread-runner.ts', import.meta.url), 'utf8');
  for (const source of [sandbox, state, runner]) {
    for (const method of ['chickpeaHostRestoreBookmarks', 'chickpeaHostRestore']) {
      assert.match(source, new RegExp(`async ${method}\\(request: [^)]+\\) \\{\\s*return this\\.host\\(\\)\\.${method}\\(request\\);`));
    }
    assert.match(source, /restoreContext: this\.ctx/);
  }
});

test('the pure plan orders runners and agents first, Sandboxes next, state store last without mutating input', () => {
  const input = Object.freeze(inventory(A).map((object) => Object.freeze(object)));
  const before = JSON.stringify(input);
  const plan = buildInstallationRestorePlan(A, input);
  assert.deepEqual(plan.map(({ kind }) => kind), [
    'thread_runner', 'thread_runner', 'slack_agent', 'slack_agent', 'routine_agent', 'coding_worker', 'sandbox', 'state_store',
  ]);
  assert.equal(plan[0]!.name, scopedObjectName({ installationId: A }, 'thread_a'));
  assert.equal(plan[2]!.name, scopedObjectName({ installationId: A }, 'agent_a'));
  assert.equal(plan.at(-1)!.name, scopedObjectName({ installationId: A }, 'singleton'));
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(buildInstallationRestorePlan(A, [...input].reverse()), plan);
  assert.notEqual(plan[0], input.find(({ name }) => name === plan[0]!.name));
});

test('the plan includes the implicit state store once, including an empty inventory', () => {
  const state: InstallationObject = { kind: 'state_store', name: scopedObjectName({ installationId: A }, 'singleton') };
  assert.deepEqual(buildInstallationRestorePlan(A, []), [state]);
  const plan = buildInstallationRestorePlan(A, [state, ...inventory(A)]);
  assert.equal(plan.filter(({ kind }) => kind === 'state_store').length, 1);
  assert.deepEqual(plan.at(-1), state);
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
