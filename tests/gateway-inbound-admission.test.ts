import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  gatewayDeliveryOrderKey,
  GatewayInboundAdmission,
  GatewayKeyedAdmissionQueue,
  gatewaySelfGeneratedEvent,
  type GatewayAdmissionOutcome,
  type GatewayIntakeObservation,
} from '../src/slack/gateway/inbound-admission.ts';
import type { GatewayEventDelivery, GatewayInboundDelivery } from '../src/slack/gateway/protocol.ts';

const BOT = 'U_BOT';
const APP = 'A_SELF';
const SELF = { botUserId: BOT, appId: APP };

function deliver(event: Record<string, unknown>, deliveryId = `event:Ev${Math.random()}`): GatewayEventDelivery {
  return {
    protocolVersion: 1,
    kind: 'event.deliver',
    deliveryId,
    bindingId: 'binding_test',
    workspaceId: 'T1',
    envelope: {
      workspaceId: 'T1', eventId: deliveryId, eventTime: 1,
      event: event as unknown as GatewayEventDelivery['envelope']['event'],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

test('only this bot user\'s own messages, stream edits, and reactions are self-generated', () => {
  const dropped: Array<[Record<string, unknown>, string]> = [
    [{ type: 'message', channel: 'C1', user: BOT, bot_id: 'B1', ts: '1.1', text: 'answer' }, 'own_message'],
    [{ type: 'message', subtype: 'bot_message', channel: 'C1', user: BOT, bot_id: 'B1', ts: '1.1' }, 'own_message'],
    [{ type: 'message', subtype: 'thread_broadcast', channel: 'C1', user: BOT, ts: '1.2', thread_ts: '1.1' }, 'own_message'],
    [{ type: 'message', channel: 'D1', channel_type: 'im', user: BOT, ts: '1.1', text: 'dm reply' }, 'own_message'],
    [{ type: 'message', subtype: 'message_changed', channel: 'C1', ts: '2.0',
      message: { type: 'message', user: BOT, bot_id: 'B1', ts: '1.1', text: 'streamed' } }, 'own_message_changed'],
    [{ type: 'reaction_added', user: BOT, reaction: 'eyes', item: { type: 'message', channel: 'C1', ts: '1.1' } },
      'own_reaction'],
    // Persona-shaped posts and their stream edits may carry no `user`.
    [{ type: 'message', subtype: 'bot_message', channel: 'C1', bot_id: 'B1', app_id: APP, username: 'Agent',
      ts: '1.3', thread_ts: '1.1' }, 'own_message'],
    [{ type: 'message', subtype: 'bot_message', channel: 'C1', bot_id: 'B1', bot_profile: { app_id: APP },
      username: 'Agent', ts: '1.4' }, 'own_message'],
    [{ type: 'message', subtype: 'message_changed', channel: 'C1', ts: '2.1',
      message: { type: 'message', subtype: 'bot_message', bot_id: 'B1', app_id: APP, username: 'Agent', ts: '1.3' } },
      'own_message_changed'],
    [{ type: 'message', subtype: 'message_changed', channel: 'C1', ts: '2.2',
      message: { type: 'message', bot_id: 'B1', bot_profile: { app_id: APP }, ts: '1.4' } }, 'own_message_changed'],
  ];
  for (const [event, reason] of dropped) {
    assert.equal(gatewaySelfGeneratedEvent(deliver(event), SELF), reason, JSON.stringify(event));
  }
  const kept: Array<Record<string, unknown>> = [
    { type: 'app_mention', channel: 'C1', user: 'U_PERSON', ts: '1.1', text: `<@${BOT}> hi` },
    // An app_mention is never filtered, even one attributed to this bot.
    { type: 'app_mention', channel: 'C1', user: BOT, ts: '1.1', text: 'hi' },
    { type: 'message', channel: 'C1', user: 'U_PERSON', ts: '1.2', thread_ts: '1.1', text: 'reply' },
    { type: 'message', channel: 'D1', channel_type: 'im', user: 'U_PERSON', ts: '1.1', text: 'dm' },
    { type: 'message', channel: 'C1', user: 'U_OTHER_BOT', bot_id: 'B2', ts: '1.1', text: 'other app' },
    { type: 'message', subtype: 'message_changed', channel: 'C1', ts: '2.0',
      message: { type: 'message', user: 'U_PERSON', ts: '1.1', text: 'correction' } },
    // Slack does not say who deleted a message; a person may remove a reply.
    { type: 'message', subtype: 'message_deleted', channel: 'C1', ts: '2.0', deleted_ts: '1.1',
      previous_message: { type: 'message', user: BOT, ts: '1.1' } },
    // The bot joining a channel drives the welcome and private setup flows.
    { type: 'member_joined_channel', channel: 'C1', user: BOT, inviter: 'U_PERSON' },
    { type: 'reaction_added', user: 'U_PERSON', reaction: 'eyes', item: { type: 'message', channel: 'C1', ts: '1.1' } },
    { type: 'user_change', user: { id: BOT } },
    // A human `user` is never ours, whatever the app fields say.
    { type: 'message', channel: 'C1', user: 'U_PERSON', app_id: APP, ts: '1.5', text: 'shortcut post' },
    { type: 'message', subtype: 'message_changed', channel: 'C1', ts: '2.3',
      message: { type: 'message', user: 'U_PERSON', app_id: APP, ts: '1.5', text: 'edited' } },
    // Another app's persona post.
    { type: 'message', subtype: 'bot_message', channel: 'C1', bot_id: 'B9', app_id: 'A_OTHER', username: 'X', ts: '1.6' },
    { type: 'message', subtype: 'message_changed', channel: 'C1', ts: '2.4',
      message: { type: 'message', bot_id: 'B9', bot_profile: { app_id: 'A_OTHER' }, ts: '1.6' } },
    // Deletes stay unfiltered even for a persona post.
    { type: 'message', subtype: 'message_deleted', channel: 'C1', ts: '2.5', deleted_ts: '1.3',
      previous_message: { type: 'message', subtype: 'bot_message', app_id: APP, ts: '1.3' } },
  ];
  for (const event of kept) {
    assert.equal(gatewaySelfGeneratedEvent(deliver(event), SELF), undefined, JSON.stringify(event));
  }
  // Without the bound identity nothing can be classified as self-generated.
  for (const [event] of dropped) assert.equal(gatewaySelfGeneratedEvent(deliver(event), {}), undefined);
  assert.equal(gatewaySelfGeneratedEvent(deliver(dropped[0]![0]), { appId: APP }), undefined);
  assert.equal(gatewaySelfGeneratedEvent({
    protocolVersion: 1, kind: 'interaction.agent_selected', deliveryId: 'i1', bindingId: 'b', workspaceId: 'T1',
    userId: BOT, agentId: 'agent',
  }, SELF), undefined);
});

test('ordering keys group a thread, its edits, and a whole DM, and separate unrelated threads', () => {
  const key = (event: Record<string, unknown>) => gatewayDeliveryOrderKey(deliver(event));
  const root = key({ type: 'app_mention', channel: 'C1', user: 'U', ts: '100.1' });
  assert.equal(root, 'thread:C1:100.1');
  assert.equal(key({ type: 'message', channel: 'C1', user: 'U', ts: '100.5', thread_ts: '100.1' }), root);
  assert.equal(key({ type: 'message', subtype: 'message_changed', channel: 'C1', ts: '101.0',
    message: { ts: '100.5', thread_ts: '100.1' } }), root);
  assert.equal(key({ type: 'message', subtype: 'message_deleted', channel: 'C1', ts: '101.0', deleted_ts: '100.1',
    previous_message: { ts: '100.1' } }), root);
  assert.notEqual(key({ type: 'app_mention', channel: 'C1', user: 'U', ts: '200.1' }), root);
  assert.equal(key({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U', ts: '1.1' }), 'channel:D1');
  assert.equal(key({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U', ts: '2.1' }), 'channel:D1');
  assert.equal(key({ type: 'reaction_added', user: 'U', item: { type: 'message', channel: 'C1', ts: '100.1' } }), root);
  // A reaction on a thread reply names only the reply; its root is unknown
  // until normalization resolves it, so it orders with that reply's key.
  assert.equal(key({ type: 'reaction_added', user: 'U', item: { type: 'message', channel: 'C1', ts: '100.5' } }),
    'thread:C1:100.5');
  assert.equal(key({ type: 'member_joined_channel', channel: 'C1', user: 'U' }), 'channel:C1');
  assert.equal(key({ type: 'user_change', user: { id: 'U' } }), 'workspace');
  assert.equal(gatewayDeliveryOrderKey({
    protocolVersion: 1, kind: 'interaction.agent_selected', deliveryId: 'i1', bindingId: 'b', workspaceId: 'T1',
    userId: 'U1', agentId: 'agent',
  }), 'user:U1');
});

test('the keyed queue runs keys in parallel up to its bound and each key first-in-first-out', async () => {
  const queue = new GatewayKeyedAdmissionQueue(2);
  const started: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const run = (key: string, name: string) => {
    const gate = deferred<void>();
    gates.set(name, gate);
    return queue.run(key, async () => { started.push(name); await gate.promise; return name; });
  };
  const results = [run('a', 'a1'), run('a', 'a2'), run('b', 'b1'), run('c', 'c1')];
  await flush();
  assert.deepEqual(started, ['a1', 'b1']);
  assert.equal(queue.inFlight, 2);
  gates.get('b1')!.resolve();
  await flush();
  assert.deepEqual(started, ['a1', 'b1', 'c1'], 'a freed slot goes to the next waiting key');
  gates.get('a1')!.resolve();
  await flush();
  assert.deepEqual(started, ['a1', 'b1', 'c1', 'a2']);
  gates.get('a2')!.reject(new Error('failed'));
  gates.get('c1')!.resolve();
  const settled = await Promise.allSettled(results);
  assert.deepEqual(settled.map((result) => result.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
  // A failure does not wedge its key.
  assert.equal(await queue.run('a', async () => 'after'), 'after');
  assert.equal(queue.inFlight, 0);
  assert.throws(() => new GatewayKeyedAdmissionQueue(0), /positive integer/);
});

test('intake answers retries from memory, waits on an in-flight copy, and forgets failures', async () => {
  let clock = 1_000;
  const observations: GatewayIntakeObservation[] = [];
  const calls: string[] = [];
  const pending: Array<ReturnType<typeof deferred<GatewayAdmissionOutcome>>> = [];
  const intake = new GatewayInboundAdmission({
    rememberDeliveries: true,
    filterSelfGenerated: true,
    recentTtlMs: 60_000,
    now: () => clock,
    admit: (delivery) => {
      calls.push(delivery.deliveryId);
      const gate = deferred<GatewayAdmissionOutcome>();
      pending.push(gate);
      return gate.promise;
    },
    observe: (observation) => observations.push(observation),
  });
  const mention = deliver({ type: 'app_mention', channel: 'C1', user: 'U', ts: '1.1' }, 'event:Ev1');

  // A retry of an in-flight delivery waits for the first copy's receipt.
  const first = intake.deliver(mention, { botUserId: BOT });
  const retry = intake.deliver(mention, { botUserId: BOT });
  await flush();
  assert.deepEqual(calls, ['event:Ev1']);
  clock += 250;
  pending[0]!.resolve('accepted');
  assert.equal(await first, 'accepted');
  assert.equal(await retry, 'duplicate');
  // A later retry never reaches the store.
  assert.equal(await intake.deliver(mention, { botUserId: BOT }), 'duplicate');
  assert.deepEqual(calls, ['event:Ev1']);
  // Past the memory window the durable inbox decides again.
  clock += 60_000;
  const late = intake.deliver(mention, { botUserId: BOT });
  await flush();
  pending[1]!.resolve('duplicate');
  assert.equal(await late, 'duplicate');
  assert.equal(calls.length, 2);

  // A rejected or failed admission is not remembered: its retry is admitted.
  const other = deliver({ type: 'app_mention', channel: 'C2', user: 'U', ts: '2.1' }, 'event:Ev2');
  const rejected = intake.deliver(other);
  const waiting = intake.deliver(other);
  await flush();
  pending[2]!.resolve('rejected');
  assert.equal(await rejected, 'rejected');
  await flush();
  assert.equal(calls.length, 4, 'the waiting retry is admitted after the first copy is rejected');
  pending[3]!.reject(new Error('store unavailable'));
  await assert.rejects(waiting, /store unavailable/);
  const again = intake.deliver(other);
  await flush();
  pending[4]!.resolve('accepted');
  assert.equal(await again, 'accepted');

  // A reused delivery id with another identity is the store's conflict.
  const conflicting: GatewayInboundDelivery = { ...mention, bindingId: 'binding_other' };
  const conflict = intake.deliver(conflicting);
  await flush();
  pending[5]!.reject(new Error('conflict'));
  await assert.rejects(conflict, /conflict/);

  // Self-generated events are acknowledged without admission.
  assert.equal(await intake.deliver(deliver({ type: 'reaction_added', user: BOT, reaction: 'eyes',
    item: { type: 'message', channel: 'C1', ts: '1.1' } }), { botUserId: BOT }), 'accepted');
  assert.equal(calls.length, 6);
  assert.deepEqual(observations.map(({ outcome, source }) => [outcome, source]), [
    ['accepted', 'store'], ['duplicate', 'recent'], ['duplicate', 'recent'], ['duplicate', 'store'],
    ['rejected', 'store'], ['failed', 'store'], ['accepted', 'store'], ['failed', 'store'], ['filtered', 'filter'],
  ]);
  assert.equal(observations[0]!.admitMs, 250);
  assert.equal(observations.at(-1)!.filterReason, 'own_reaction');
});

test('intake memory is bounded and never forgets an in-flight admission', async () => {
  const gates: Array<ReturnType<typeof deferred<GatewayAdmissionOutcome>>> = [];
  let calls = 0;
  const intake = new GatewayInboundAdmission({
    rememberDeliveries: true,
    recentLimit: 3,
    concurrency: 8,
    admit: async () => {
      calls += 1;
      const gate = deferred<GatewayAdmissionOutcome>();
      gates.push(gate);
      return gate.promise;
    },
  });
  const make = (n: number) => deliver({ type: 'app_mention', channel: 'C1', user: 'U', ts: `${n}.1` }, `event:E${n}`);
  const held = intake.deliver(make(0));
  await flush();
  for (let n = 1; n <= 5; n += 1) {
    const admitted = intake.deliver(make(n));
    await flush();
    gates.at(-1)!.resolve('accepted');
    await admitted;
  }
  assert.equal(calls, 6);
  // The oldest settled entries were evicted; the in-flight one was kept.
  const retryHeld = intake.deliver(make(0));
  await flush();
  assert.equal(calls, 6);
  gates[0]!.resolve('accepted');
  assert.equal(await held, 'accepted');
  assert.equal(await retryHeld, 'duplicate');
  assert.equal(await intake.deliver(make(5)), 'duplicate');
  const evicted = intake.deliver(make(1));
  await flush();
  assert.equal(calls, 7);
  gates.at(-1)!.resolve('duplicate');
  assert.equal(await evicted, 'duplicate');
});
