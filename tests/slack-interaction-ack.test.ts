import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  answerSlackInteractionBy,
  createSlackInteractionAck,
  slackInteractionAckDeadline,
  slackInteractionAckOf,
  withSlackInteractionAck,
  type SlackInteractionAck,
} from '../src/slack/interaction-ack.ts';

const slackRequest = (timestamp?: string) => new Request('https://host.example/channels/slack/interactions', {
  method: 'POST',
  headers: timestamp === undefined ? {} : { 'x-slack-request-timestamp': timestamp },
});

test('the deadline is the earlier of 2.6 s after Slack\'s whole-second timestamp and 2.2 s after the handler starts', () => {
  // Staging, 2026-10-09: the request reached the host at 19:35:34.721 and its
  // handler started 1446 ms later in a fresh isolate. Slack's timestamp bounds
  // the answer to 36.600, 1.88 s after arrival; the handler alone would have
  // allowed 38.367.
  assert.equal(slackInteractionAckDeadline('1791574534', 1791574536167), 1791574536600);
  // A warm handler: its own clock is the earlier bound.
  assert.equal(slackInteractionAckDeadline('1791574534', 1791574534050), 1791574536250);
  // A Slack clock running ahead cannot push the answer past 2.2 s of ours.
  assert.equal(slackInteractionAckDeadline('1791574600', 1791574534000), 1791574536200);
  // A cold start past Slack's bound leaves a deadline already gone: answer at once.
  assert.ok(slackInteractionAckDeadline('1791574534', 1791574537000) < 1791574537000);
  for (const header of [null, '', 'soon', '1791574534.5', '-1', '1'.repeat(13)]) {
    assert.equal(slackInteractionAckDeadline(header, 1791574534000), 1791574536200, String(header));
  }
  const now = Date.now();
  assert.equal(createSlackInteractionAck(slackRequest(String(Math.floor(now / 1000))), now).deadline,
    Math.min(Math.floor(now / 1000) * 1000 + 2600, now + 2200));
});

test('one acknowledgement is claimed once, and rides only in the env it was attached to', () => {
  const ack = createSlackInteractionAck(slackRequest('1791574534'), 1791574534100);
  const env = { CHICKPEA_TENANCY: 'installation' };
  const served = withSlackInteractionAck(env, ack);
  assert.equal(slackInteractionAckOf(served), ack);
  assert.equal(slackInteractionAckOf(env), undefined);
  assert.equal(slackInteractionAckOf(undefined), undefined);
  assert.equal(served.CHICKPEA_TENANCY, 'installation');
  assert.ok(Object.isFrozen(served));
  assert.equal(ack.claim(), true);
  assert.equal(ack.claim(), false);
});

function ackIn(ms: number): SlackInteractionAck {
  let claimed = false;
  return { deadline: Date.now() + ms, claim: () => !claimed && (claimed = true) };
}

const after = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

/** What a runtime keeps alive past the response: only what reached waitUntil. */
function keptAlive() {
  const kept: Promise<unknown>[] = [];
  return { kept, waitUntil: (promise: Promise<unknown>) => { kept.push(promise); } };
}

test('an answer ready before the deadline is Slack\'s answer', async () => {
  const ack = ackIn(200);
  const { waitUntil } = keptAlive();
  assert.equal(await answerSlackInteractionBy(ack, after(5, 'core'), () => 'host', waitUntil), 'core');
  assert.equal(ack.claim(), true, 'nobody claimed an empty answer that made it in time');
});

test('past the deadline the host answers once, and the slower answer is kept alive to finish', async () => {
  const ack = ackIn(10);
  let finished = false;
  const answer = after(60, 'core').then((value) => { finished = true; return value; });
  const { kept, waitUntil } = keptAlive();
  assert.equal(await answerSlackInteractionBy(ack, answer, () => 'host', waitUntil), 'host');
  assert.equal(finished, false);
  assert.equal(ack.claim(), false, 'the host holds the claim, so Core cannot also answer');
  assert.deepEqual(kept, [answer], 'the answer is handed to waitUntil, not left to float');
  assert.equal(await kept[0], 'core');
});

test('errors claimed just before the deadline are waited for, never replaced by an empty answer', async () => {
  const ack = ackIn(20);
  const answer = after(10, undefined).then(() => {
    assert.equal(ack.claim(), true);
    return after(40, 'errors');
  });
  assert.equal(await answerSlackInteractionBy(ack, answer, () => 'host', keptAlive().waitUntil), 'errors');
});

test('a deadline already gone is answered once timers run, ahead of an answer still waiting on I/O', async () => {
  const ack = ackIn(-500);
  assert.equal(await answerSlackInteractionBy(ack, after(30, 'core'), () => 'host', keptAlive().waitUntil), 'host');
});
