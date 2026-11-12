import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import type { SlackDirectDelivery } from '../src/slack/claim-store.ts';
import { RESIDENCY_HOLD_VARIABLE } from '../src/state/residency-hold.ts';
import type { DirectStore } from './helpers/direct-store-probe.ts';
import {
  DM,
  missingMethod,
  settled,
  WORKER_MENTION,
  withDirectWorker,
  type DirectWorker,
  type StoreAdmission,
} from './helpers/direct-worker.ts';
import { HOLD_MS } from './helpers/residency-hold.ts';

/**
 * CHICKPEA_SLACK_ADMISSION=store: the Worker sends a direct installation's
 * verified message to its state store in one call, and the store admits it
 * on its own stores (TagStateStore.admitSlackDelivery, behind the Worker's
 * CfSlackStateStore.admitDelivery). A store on older code rejects the call,
 * and the Worker admits that delivery itself, once.
 */

const STORE_PATH = { CHICKPEA_SLACK_ADMISSION: 'store' };
const REPLY = { ...DM, ts: '6000.000200', thread_ts: DM.ts, text: 'and since Monday?' };
const GUEST = (method: string) => method === 'users.info'
  ? Response.json({ ok: true, user: {
      id: 'U1', team_id: 'T1', name: 'U1', deleted: false, is_bot: false, is_app_user: false,
      is_restricted: true, is_ultra_restricted: false, is_stranger: false,
    } })
  : undefined;

interface Logged {
  summaries: Array<Record<string, unknown>>;
  admissions: Array<Record<string, unknown>>;
  fallbacks: Array<Record<string, unknown>>;
}

/** The content-free runtime records the Worker and the store log. */
function logged(t: TestContext): Logged {
  const records: Logged = { summaries: [], admissions: [], fallbacks: [] };
  t.mock.method(console, 'info', (record: unknown) => {
    const event = (record as { event?: unknown } | undefined)?.event;
    if (event === 'state_rpc_summary') records.summaries.push(record as Record<string, unknown>);
    if (event === 'slack_store_admission') records.admissions.push(record as Record<string, unknown>);
    if (event === 'state_rpc_fallback') records.fallbacks.push(record as Record<string, unknown>);
  });
  return records;
}

/** Slack's request, answered as the Worker answers it, with everything it started finished. */
async function deliver(worker: DirectWorker, body: Record<string, unknown>): Promise<void> {
  const kept: Array<Promise<unknown>> = [];
  const response = await worker.deliver(body, { waitUntil: (promise) => { kept.push(promise); }, passThroughOnException() {}, props: {} });
  assert.equal(response.status, 200);
  while (kept.length) await Promise.all(kept.splice(0));
}

const turns = (worker: DirectWorker) => worker.db.all('SELECT id FROM turn_jobs ORDER BY id').map((row) => row.id);
const recorded = (worker: DirectWorker) => worker.db.all(
  "SELECT message_ts, text FROM config_slack_public_context WHERE role = 'human' ORDER BY message_ts",
);
/** A value made by the transpiled store, as plain data. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const rpcs = (worker: DirectWorker) => worker.log.filter((entry) => entry.startsWith('rpc:'));
const slack = (worker: DirectWorker) => worker.log.filter((entry) => entry.startsWith('slack:'));

// Defects caught: the Worker still running its chain (or noting the
// delivery) with the variable on; the store not handing the turn to its
// runner with its first status, not holding itself for the residency
// window, or not arming the alarm at the commit; work not held by the
// store's waitUntil; and admission calling the store over RPC from inside it.
test('with the variable on, one call admits the message in the store, which hands it over and holds itself', async (t) => {
  const records = logged(t);
  await withDirectWorker(t, async (worker) => {
    const before = Date.now();
    await deliver(worker, worker.event(DM));
    assert.deepEqual(worker.failures, []);
    assert.deepEqual(turns(worker), ['msg:D1:6000.000100']);
    assert.deepEqual(recorded(worker), [{ message_ts: DM.ts, text: DM.text }], 'the accepted message is in the thread record');
    assert.deepEqual(rpcs(worker).filter((entry) => !['rpc:identityExecute', 'rpc:configGetWorkspaceInstallation'].includes(entry)),
      ['rpc:admitSlackDelivery'], 'past the signature check, one call and no note');
    assert.equal(worker.notes.length, 0);

    const { store } = worker;
    assert.equal(store.held.length, 1, "the store holds its admission with its waitUntil");
    assert.equal(store.handed.length, 1, 'the turn went to its runner');
    assert.equal(store.handed[0]!.job.id, 'msg:D1:6000.000100');
    assert.equal(store.wakes.length, 1, 'the runner was woken at receipt');
    assert.ok(store.alarms.some((at) => at >= before + 20_000), 'the alarm was armed at the commit');
    assert.ok(store.heldUntil().some((at) => at >= before + HOLD_MS && at <= Date.now() + HOLD_MS),
      "a person's turn holds the store for the deployment's window");

    assert.deepEqual(records.admissions.map(({ outcome, turns: admitted, rpcCalls }) => ({ outcome, admitted, rpcCalls })),
      [{ outcome: 'processed', admitted: 1, rpcCalls: 0 }], 'the store logs its admission, with no call to itself');
    assert.deepEqual(records.summaries.map(({ path, calls }) => ({ path, calls })), [{ path: 'store', calls: 1 }]);
  }, { env: { ...STORE_PATH, [RESIDENCY_HOLD_VARIABLE]: String(HOLD_MS) } });
});

// Defect caught: the variable read as on when unset or misspelled.
test('without the variable, or with another value, the Worker admits as before', async (t) => {
  for (const env of [{}, { CHICKPEA_SLACK_ADMISSION: 'worker' }, { CHICKPEA_SLACK_ADMISSION: 'stor' }]) {
    const records = logged(t);
    await withDirectWorker(t, async (worker) => {
      await deliver(worker, worker.event(DM));
      assert.deepEqual(turns(worker), ['msg:D1:6000.000100'], JSON.stringify(env));
      assert.ok(!rpcs(worker).includes('rpc:admitSlackDelivery'), `${JSON.stringify(env)}: no store admission`);
      assert.equal(worker.notes.length, 1, `${JSON.stringify(env)}: the note, as before`);
      assert.deepEqual(records.summaries.map(({ path }) => path), ['worker']);
    }, { env });
  }
});

// Defects caught: a new Worker dropping deliveries a store on older code
// cannot take (the deploy's first minutes, and with the residency hold every
// conversation still in memory), a fallback that admits twice or not at
// all, a fallback that is not logged with its reason, and a store on new code
// still served by the fallback.
test('a store on older code rejects the call; each delivery is admitted by the Worker once, until the store runs new code', async (t) => {
  const records = logged(t);
  let storeCode: 'previous' | 'current' = 'previous';
  const admission: StoreAdmission = (delivery, store) =>
    storeCode === 'previous' ? missingMethod('admitSlackDelivery') : store.admitSlackDelivery(delivery);
  await withDirectWorker(t, async (worker) => {
    // A held conversation's messages inside the window a deploy leaves its store on the old code.
    const held = [DM, REPLY, { ...REPLY, ts: '6000.000300', text: 'and Tuesday?' }];
    for (const event of held) await deliver(worker, worker.event(event));
    assert.deepEqual(worker.failures, []);
    assert.deepEqual(turns(worker), ['msg:D1:6000.000100', 'msg:D1:6000.000200', 'msg:D1:6000.000300'], 'each message became one turn');
    assert.equal(worker.notes.length, 3, "each fell back to today's chain, note included");
    assert.equal(worker.store.handed.length, 0, 'the old store admitted nothing itself');
    assert.deepEqual(records.fallbacks.map(({ method, reason }) => ({ method, reason })),
      Array(3).fill({ method: 'admitSlackDelivery', reason: 'method_missing' }));
    assert.deepEqual(records.summaries.map(({ path, reason }) => ({ path, reason })),
      Array(3).fill({ path: 'fallback', reason: 'method_missing' }));

    // The store restarts on the new code.
    storeCode = 'current';
    await deliver(worker, worker.event({ ...DM, ts: '6100.000100', text: 'a new thread' }));
    assert.equal(turns(worker).length, 4);
    assert.equal(records.fallbacks.length, 3, 'no fallback once the store has the method');
    assert.equal(records.summaries.at(-1)?.path, 'store');
    assert.equal(worker.store.handed.at(-1)?.job.id, 'msg:D1:6100.000100', 'the store admitted it and handed it over');
  }, { env: STORE_PATH, admission });
});

// Defects caught: a store's answer, even a failure, followed by the Worker's
// own admission (a second run nobody needed); the lost delivery logged as
// the store's admission.
test("a store that answers with a failure is not second-guessed by the Worker's chain", async (t) => {
  const records = logged(t);
  await withDirectWorker(t, async (worker) => {
    await deliver(worker, worker.event(DM));
    assert.deepEqual(rpcs(worker).filter((entry) => entry === 'rpc:admitSlackDelivery' || entry === 'rpc:noteSlackDelivery'),
      ['rpc:admitSlackDelivery']);
    assert.deepEqual(turns(worker), []);
    assert.equal(worker.failures.length, 1, 'the failure is logged');
    assert.deepEqual(records.fallbacks, []);
    assert.deepEqual(records.summaries.map(({ path, reason }) => ({ path, reason })),
      [{ path: 'fallback', reason: 'store_failed' }]);
  }, {
    env: STORE_PATH,
    admission: async () => ({ ok: false, error: { code: 'internal', message: 'a dependency failed' } }),
  });
});

/** The store admits the delivery as far as `upTo` lets it, then its call rejects, as a store replaced mid-call does. */
function replacedMidCall(upTo: (store: DirectStore, delivery: SlackDirectDelivery) => Promise<unknown>): StoreAdmission {
  return async (delivery, store) => {
    await upTo(store, delivery);
    throw new Error('Durable Object reset because its code was updated.');
  };
}

// Defects caught (the double run, design §3.4): a fallback after a store that
// committed admitting a second turn, recording the message twice, handing the
// turn over twice, or repeating a refusal in Slack; and after a store that
// stopped before its commit, the delivery being lost or admitted twice.
test("a store replaced mid-call is followed by the Worker's chain, which finds what the store did and admits nothing twice", async (t) => {
  const records = logged(t);
  await t.test('after the commit', async (t) => {
    await withDirectWorker(t, async (worker) => {
      await deliver(worker, worker.event(DM));
      assert.deepEqual(worker.failures, []);
      assert.deepEqual(turns(worker), ['msg:D1:6000.000100'], 'one turn');
      assert.deepEqual(recorded(worker), [{ message_ts: DM.ts, text: DM.text }], 'one record of the message');
      assert.equal(worker.store.handed.length, 1, 'handed over once, by the store');
      assert.ok(rpcs(worker).includes('rpc:noteSlackDelivery'), "the Worker's chain ran, and found the claims taken");
    }, { env: STORE_PATH, admission: replacedMidCall((store, delivery) => store.admitSlackDelivery(delivery)) });
  });

  await t.test("after a refusal said in Slack", async (t) => {
    await withDirectWorker(t, async (worker) => {
      await deliver(worker, worker.event(DM));
      assert.deepEqual(turns(worker), [], "a guest's message is refused");
      assert.deepEqual(slack(worker).filter((entry) => entry === 'slack:chat.postMessage'), ['slack:chat.postMessage'],
        'the refusal is said once');
    }, { env: STORE_PATH, slack: GUEST, admission: replacedMidCall((store, delivery) => store.admitSlackDelivery(delivery)) });
  });

  await t.test('before the commit', async (t) => {
    let lookups = 0;
    await withDirectWorker(t, async (worker) => {
      await deliver(worker, worker.event(DM));
      assert.deepEqual(turns(worker), ['msg:D1:6000.000100'], 'the Worker admitted what the store could not');
      assert.deepEqual(recorded(worker), [{ message_ts: DM.ts, text: DM.text }]);
      assert.equal(worker.store.handed.length, 0);
    }, {
      env: STORE_PATH,
      // The store's instance goes while it waits on Slack's sender lookup, after its first writes.
      slack: async (method) => {
        if (method === 'users.info' && ++lookups === 1) await new Promise<never>(() => undefined);
        return undefined;
      },
      admission: replacedMidCall(async (store, delivery) => {
        void store.admitSlackDelivery(delivery);
        await settled(() => lookups === 1);
      }),
    });
  });

  // Defect caught: the alarm armed only after the hand-off (the keep-warm
  // tick), so a turn whose store stops between its commit and its hand-off
  // waits for an unrelated wake: the Worker's chain finds the claims taken and
  // hands nothing over.
  await t.test('between the commit and the hand-off', async (t) => {
    let releaseStatus!: () => void;
    const statusShown = new Promise<void>((resolve) => { releaseStatus = resolve; });
    let probe: DirectStore | undefined;
    // The alarms armed when the first status write began.
    let armedAtStatus: number[] | undefined;
    let admitting: Promise<unknown> | undefined;
    await withDirectWorker(t, async (worker) => {
      probe = worker.store;
      const before = Date.now();
      await deliver(worker, worker.event(DM));
      assert.deepEqual(turns(worker), ['msg:D1:6000.000100'], 'one turn, committed by the store');
      assert.equal(worker.store.handed.length, 0, 'the store stopped before its hand-off');
      assert.ok(armedAtStatus?.some((at) => at >= before + 15_000 && at <= Date.now() + 20_000),
        'the alarm was armed at the commit, a keep-warm tick away, before the status write began');
      releaseStatus();
      await admitting;
    }, {
      env: STORE_PATH,
      slack: async (method) => {
        if (method === 'assistant.threads.setStatus' && !armedAtStatus) {
          armedAtStatus = [...probe!.alarms];
          await statusShown;
        }
        return undefined;
      },
      admission: replacedMidCall(async (store, delivery) => {
        admitting = store.admitSlackDelivery(delivery);
        await settled(() => armedAtStatus !== undefined);
      }),
    });
  });
  assert.deepEqual([...new Set(records.fallbacks.map(({ reason }) => reason))], ['disconnected']);
});

// Defect caught: Chickpea's introduction to a person, queued by their first
// message, waiting for the next keep-warm tick. The Worker's claim arms the
// alarm for it (managementExecute); the store's own claim is a local call.
test("a person's first message arms the alarm for Chickpea's introduction at once", async (t) => {
  await withDirectWorker(t, async (worker) => {
    await deliver(worker, worker.event(DM));
    const due = worker.stores.management.nextOutboxDueAt();
    assert.ok(due !== undefined && due <= Date.now(), 'the first message queued the introduction');
    assert.ok(worker.store.alarms.some((at) => at <= Date.now()), 'the alarm is armed for it now, not at the keep-warm tick');
  }, { env: STORE_PATH });
});

// Defects caught: a later message of a thread admitted before an earlier
// one that waits on Slack, and another conversation held behind it.
test("one thread's messages are admitted in the order they reached the store; another thread does not wait", async (t) => {
  let releaseFirstLookup!: () => void;
  const firstLookup = new Promise<void>((resolve) => { releaseFirstLookup = resolve; });
  let lookups = 0;
  await withDirectWorker(t, async (worker) => {
    const committed: string[] = [];
    const admitCanonical = worker.stores.slack.admitCanonical.bind(worker.stores.slack);
    worker.stores.slack.admitCanonical = (input, ...rest) => {
      if (input.turnJob) committed.push(input.turnJob.id);
      return admitCanonical(input, ...rest);
    };
    const first = deliver(worker, worker.event(DM));
    await settled(() => lookups === 1);
    const second = deliver(worker, worker.event(REPLY));
    const other = deliver(worker, worker.event({ ...DM, ts: '7000.000100', text: 'another thread' }));
    await other;
    assert.deepEqual(committed, ['msg:D1:7000.000100'], 'the other thread was admitted while the first waited on Slack');
    releaseFirstLookup();
    await Promise.all([first, second]);
    assert.deepEqual(committed, ['msg:D1:7000.000100', 'msg:D1:6000.000100', 'msg:D1:6000.000200'],
      "the reply waited for its thread's first message");
  }, {
    env: { ...STORE_PATH, SLACK_THREAD_RUNNER: undefined },
    slack: async (method) => {
      if (method !== 'users.info') return undefined;
      lookups += 1;
      if (lookups === 1) await firstLookup;
      return undefined;
    },
  });
});

// Defect caught: a thread's order held through the first message's status
// write and hand-off, so its reply waits on them.
test("a reply is admitted while its thread's first message is still showing its status", async (t) => {
  let releaseStatus!: () => void;
  const statusShown = new Promise<void>((resolve) => { releaseStatus = resolve; });
  let statusWrites = 0;
  await withDirectWorker(t, async (worker) => {
    const committed: string[] = [];
    const admitCanonical = worker.stores.slack.admitCanonical.bind(worker.stores.slack);
    worker.stores.slack.admitCanonical = (input, ...rest) => {
      if (input.turnJob) committed.push(input.turnJob.id);
      return admitCanonical(input, ...rest);
    };
    const first = deliver(worker, worker.event(DM));
    await settled(() => statusWrites === 1);
    await deliver(worker, worker.event(REPLY));
    assert.deepEqual(committed, ['msg:D1:6000.000100', 'msg:D1:6000.000200'], 'the reply committed during the status write');
    assert.equal(worker.store.handed.length, 0, 'the first hand-off still waits for its status');
    releaseStatus();
    await first;
    assert.deepEqual(worker.store.handed.map(({ job }) => job.id), ['msg:D1:6000.000100']);
  }, {
    env: STORE_PATH,
    slack: async (method) => {
      if (method === 'assistant.threads.setStatus' && ++statusWrites === 1) await statusShown;
      return undefined;
    },
  });
});

// Defects caught: a recovery-only installation, or a delivery for another
// app, admitted by the store, or reaching Slack before it is refused.
test('the store refuses a recovery-only installation and a delivery for another app before any Slack call', async (t) => {
  const records = logged(t);
  await withDirectWorker(t, async (worker) => {
    const answer = async (fields: Partial<SlackDirectDelivery>) => plain(await worker.store.admitSlackDelivery({
      workspaceId: 'T1', eventId: 'EvRefused', eventTime: 1, event: DM as unknown as SlackDirectDelivery['event'],
      appId: 'A1', receivedAt: Date.now(), ...fields,
    }));
    assert.deepEqual(await answer({ appId: 'A2' }), { ok: true, value: { outcome: 'refused', reason: 'installation' } });
    assert.deepEqual(await answer({ workspaceId: 'T9' }), { ok: true, value: { outcome: 'refused', reason: 'installation' } });
    const control = worker.stores.identity.getAuthControl()!;
    worker.stores.identity.updateAuthControl({ expectedRevision: control.revision, healthGate: 'recovery_only' });
    assert.deepEqual(await answer({}), { ok: true, value: { outcome: 'refused', reason: 'recovery_only' } });
    assert.deepEqual(slack(worker), []);
    assert.deepEqual(turns(worker), []);
    assert.deepEqual(records.admissions.map(({ outcome, reason }) => ({ outcome, reason })), [
      { outcome: 'refused', reason: 'installation' },
      { outcome: 'refused', reason: 'installation' },
      { outcome: 'refused', reason: 'recovery_only' },
    ]);
  });
});

// Defect caught: a mention delivered twice (app_mention and message) admitted
// twice by the store, or its duplicate handed over again.
test('the same mention delivered as app_mention and as message is one turn, handed over once', async (t) => {
  await withDirectWorker(t, async (worker) => {
    await deliver(worker, worker.event(WORKER_MENTION));
    await deliver(worker, worker.event({ ...WORKER_MENTION, type: 'message', channel_type: 'channel' }));
    assert.deepEqual(turns(worker), ['msg:C1:5000.000100']);
    assert.equal(worker.store.handed.length, 1);
  }, { env: STORE_PATH });
});

/** The turns the store commits, in order, from now on. */
function commits(worker: DirectWorker): string[] {
  const committed: string[] = [];
  const admitCanonical = worker.stores.slack.admitCanonical.bind(worker.stores.slack);
  worker.stores.slack.admitCanonical = (input, ...rest) => {
    if (input.turnJob) committed.push(input.turnJob.id);
    return admitCanonical(input, ...rest);
  };
  return committed;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const LATER_REPLY = { ...REPLY, ts: '6000.000300', text: 'and Tuesday?' };

// Defects caught (security delta review, finding 1): a delivery that waited
// in its thread's order admitted on the recovery gate, installation and
// credentials it read before the wait, so recovery, or a revoked
// installation, does not stop it.
test("a delivery that waited in its thread's order admits on the gate and installation as they are after the wait", async (t) => {
  const changes: Array<[string, (worker: DirectWorker) => void]> = [
    ['recovery_only', (worker) => {
      const control = worker.stores.identity.getAuthControl()!;
      worker.stores.identity.updateAuthControl({ expectedRevision: control.revision, healthGate: 'recovery_only' });
    }],
    ['installation', (worker) => {
      const installation = worker.stores.config.getWorkspaceInstallation('T1')!;
      worker.stores.config.updateWorkspaceInstallation('T1', { health: 'revoked' }, installation.revision);
    }],
  ];
  for (const [reason, change] of changes) {
    await t.test(reason, async (t) => {
      const records = logged(t);
      let releaseFirstLookup!: () => void;
      const firstLookup = new Promise<void>((resolve) => { releaseFirstLookup = resolve; });
      let lookups = 0;
      let arrived = 0;
      await withDirectWorker(t, async (worker) => {
        const first = deliver(worker, worker.event(DM));
        await settled(() => lookups === 1);
        const second = deliver(worker, worker.event(REPLY));
        await settled(() => arrived === 2);
        // The reply is in its thread's order, behind the first message's Slack read.
        await pause(50);
        change(worker);
        releaseFirstLookup();
        await Promise.all([first, second]);
        assert.equal(lookups, 1, 'the reply made no Slack call');
        assert.deepEqual(turns(worker), ['msg:D1:6000.000100'], 'the reply was not admitted');
        assert.deepEqual(records.admissions.filter(({ outcome }) => outcome === 'refused').map(({ reason }) => reason), [reason]);
      }, {
        env: { ...STORE_PATH, SLACK_THREAD_RUNNER: undefined },
        admission: (delivery, store) => {
          arrived += 1;
          return store.admitSlackDelivery(delivery);
        },
        slack: async (method) => {
          if (method === 'users.info' && ++lookups === 1) await firstLookup;
          return undefined;
        },
      });
    });
  }
});

// Defect caught (Fable review, finding 4): a delivery taking its place in its
// thread's order only after its credential read, so a reply whose read is
// quicker overtakes its thread's first message and is dropped as a reply to
// an unknown thread.
test("a delivery takes its place in its thread's order when it reaches the store, before its credential read", async (t) => {
  let releaseFirstRead!: () => void;
  const firstRead = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
  let reads = 0;
  let arrived = 0;
  // Set as the store takes the first message, past the Worker's signature check.
  let delayNext = false;
  await withDirectWorker(t, async (worker) => {
    const committed = commits(worker);
    const identity = worker.stores.identity;
    const read = identity.getActiveSlackCredentialRevision.bind(identity);
    // The first message's credential read is slow; the Worker's own reads, and the reply's, are not.
    identity.getActiveSlackCredentialRevision = ((identityId: string) => {
      if (!delayNext) return read(identityId);
      delayNext = false;
      reads += 1;
      return firstRead.then(() => read(identityId));
    }) as typeof identity.getActiveSlackCredentialRevision;
    const first = deliver(worker, worker.event(DM));
    await settled(() => reads === 1);
    const second = deliver(worker, worker.event(REPLY));
    await settled(() => arrived === 2);
    await pause(50);
    releaseFirstRead();
    await Promise.all([first, second]);
    assert.deepEqual(committed, ['msg:D1:6000.000100', 'msg:D1:6000.000200'], 'the reply was admitted after its first message');
  }, {
    env: { ...STORE_PATH, SLACK_THREAD_RUNNER: undefined },
    admission: (delivery, store) => {
      arrived += 1;
      if (arrived === 1) delayNext = true;
      return store.admitSlackDelivery(delivery);
    },
  });
});

// Defects caught (security delta review, finding 2): a Slack rate limit
// holding a thread's order while Slack's client waits out Retry-After, so the
// thread's later messages wait behind it; and the rate limit not logged.
test("a Slack rate limit fails its call at once and does not hold its thread's later messages", async (t) => {
  const records = logged(t);
  let lookups = 0;
  await withDirectWorker(t, async (worker) => {
    await deliver(worker, worker.event(DM));
    const committed = commits(worker);
    const limited = deliver(worker, worker.event(REPLY));
    await settled(() => lookups === 2);
    const later = deliver(worker, worker.event(LATER_REPLY));
    await settled(() => committed.includes('msg:D1:6000.000300'));
    await Promise.all([limited, later]);
    assert.deepEqual(committed, ['msg:D1:6000.000300'], 'the rate-limited reply was not admitted; the next one was');
    assert.equal(worker.failures.filter((line) => line.includes('Slack event intake failed')).length, 1,
      "the rate-limited message fails as on the Worker's path");
    assert.deepEqual(records.admissions.slice(1).map(({ outcome, rateLimited }) => ({ outcome, rateLimited })), [
      { outcome: 'failed', rateLimited: 1 },
      { outcome: 'processed', rateLimited: 0 },
    ]);
  }, {
    env: { ...STORE_PATH, SLACK_THREAD_RUNNER: undefined },
    slack: (method) => method === 'users.info' && ++lookups === 2
      ? new Response('', { status: 429, headers: { 'retry-after': '3' } })
      : undefined,
  });
});

// Defect caught (Fable review, finding 6): a fallback that fails before its
// admission starts logged as the store's path.
test("a fallback that fails before it admits is logged as the fallback's", async (t) => {
  const records = logged(t);
  await withDirectWorker(t, async (worker) => {
    worker.stores.config.getWorkspaceInstallation = () => { throw new Error('the store cannot answer'); };
    await deliver(worker, worker.event(DM));
    assert.equal(worker.failures.length, 1);
    assert.deepEqual(records.summaries.map(({ path, reason }) => ({ path, reason })), [{ path: 'fallback', reason: 'method_missing' }]);
  }, { env: STORE_PATH, admission: 'missing' });
});
