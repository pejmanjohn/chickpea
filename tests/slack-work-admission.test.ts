import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import type { SlackConversationFacts, SlackUserFacts } from '../src/slack/credentials.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import {
  resolveSlackAdmissionTruth,
  slackAdmissionTruthReader,
} from '../src/slack/work-admission.ts';

const BOT_USER_ID = 'U_BOT';

const person: SlackUserFacts = {
  id: 'U_PERSON',
  teamId: 'T_ADMIT',
  deleted: false,
  bot: false,
  appUser: false,
  restricted: false,
  ultraRestricted: false,
  stranger: false,
};

const channel: SlackConversationFacts = {
  id: 'C_ADMIT',
  name: 'general',
  im: false,
  mpim: false,
  private: false,
  archived: false,
  frozen: false,
  shared: false,
  externallyShared: false,
  organizationShared: false,
  pendingShared: false,
  member: true,
  teamId: 'T_ADMIT',
};

function turn(overrides: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return {
    workspaceId: 'T_ADMIT',
    channelId: 'C_ADMIT',
    eventId: 'Ev_ADMIT',
    text: 'What changed?',
    userId: 'U_PERSON',
    messageTs: '1000.0001',
    threadTs: '1000.0001',
    source: 'app_mention',
    contextMode: 'thread',
    ...overrides,
  };
}

function reader(
  user: { ok: boolean; user?: SlackUserFacts } = { ok: true, user: person },
  conversation: { ok: boolean; facts?: SlackConversationFacts } = { ok: true, facts: channel },
) {
  const reads: string[] = [];
  return {
    reads,
    reader: {
      async user(userId: string) {
        reads.push(`user:${userId}`);
        return user;
      },
      async conversation(channelId: string) {
        reads.push(`conversation:${channelId}`);
        return conversation;
      },
    },
  };
}

test('a member in a channel Chickpea belongs to is eligible, with the channel\'s visibility', async () => {
  const { reader: truth, reads } = reader();
  assert.deepEqual(await resolveSlackAdmissionTruth(turn(), BOT_USER_ID, truth), {
    eligible: true,
    reason: 'eligible',
    sourceVisibility: 'public',
    actorTrustTier: 'member',
  });
  assert.deepEqual(reads.sort(), ['conversation:C_ADMIT', 'user:U_PERSON']);

  const privateChannel = reader(undefined, { ok: true, facts: { ...channel, private: true } }).reader;
  assert.deepEqual(await resolveSlackAdmissionTruth(turn(), BOT_USER_ID, privateChannel), {
    eligible: true,
    reason: 'eligible',
    sourceVisibility: 'private',
    actorTrustTier: 'member',
  });
});

test('a direct message is private and never reads the conversation', async () => {
  for (const overrides of [
    { source: 'dm_message' as const },
    { channelType: 'im' as const },
    { channelType: 'mpim' as const },
  ]) {
    const { reader: truth, reads } = reader(undefined, { ok: false });
    assert.deepEqual(
      await resolveSlackAdmissionTruth(turn({ channelId: 'D_ADMIT', ...overrides }), BOT_USER_ID, truth),
      { eligible: true, reason: 'eligible', sourceVisibility: 'private', actorTrustTier: 'member' },
      JSON.stringify(overrides),
    );
    assert.deepEqual(reads, ['user:U_PERSON']);
  }
});

test('an actor Slack cannot describe, or who is not an eligible person, is refused', async () => {
  for (const user of [{ ok: false }, { ok: true }, { ok: false, user: person }]) {
    assert.deepEqual(
      await resolveSlackAdmissionTruth(turn(), BOT_USER_ID, reader(user).reader),
      { eligible: false, reason: 'slack_truth_unavailable' },
      JSON.stringify(user),
    );
  }
  for (const user of [
    { ...person, bot: true },
    { ...person, appUser: true },
    { ...person, teamId: 'T_OTHER' },
    { ...person, teamId: undefined },
    { ...person, deleted: true },
    { ...person, stranger: true },
  ]) {
    let provisioned = false;
    assert.deepEqual(
      await resolveSlackAdmissionTruth(turn(), BOT_USER_ID, reader({ ok: true, user }).reader, async () => {
        provisioned = true;
        return true;
      }),
      { eligible: false, reason: 'ineligible_actor' },
      JSON.stringify(user),
    );
    assert.equal(provisioned, false);
  }
});

test('provisioning decides whether an eligible person is admitted', async () => {
  const seen: SlackUserFacts[] = [];
  const provision = (admitted: boolean) => async (user: SlackUserFacts) => {
    seen.push(user);
    return admitted;
  };
  assert.deepEqual(
    await resolveSlackAdmissionTruth(turn(), BOT_USER_ID, reader().reader, provision(false)),
    { eligible: false, reason: 'deactivated_actor' },
  );
  assert.equal(
    (await resolveSlackAdmissionTruth(turn(), BOT_USER_ID, reader().reader, provision(true))).eligible,
    true,
  );
  assert.deepEqual(seen, [person, person]);
});

test('a conversation Slack cannot describe, or that is not this workspace\'s, is refused', async () => {
  for (const conversation of [{ ok: false }, { ok: true }, { ok: false, facts: channel }]) {
    assert.deepEqual(
      await resolveSlackAdmissionTruth(turn(), BOT_USER_ID, reader(undefined, conversation).reader),
      { eligible: false, reason: 'slack_truth_unavailable' },
      JSON.stringify(conversation),
    );
  }
  for (const facts of [{ ...channel, id: 'C_OTHER' }, { ...channel, teamId: 'T_OTHER' }, { ...channel, teamId: undefined }]) {
    assert.deepEqual(
      await resolveSlackAdmissionTruth(turn(), BOT_USER_ID, reader(undefined, { ok: true, facts }).reader),
      { eligible: false, reason: 'workspace_mismatch' },
      JSON.stringify(facts),
    );
  }
});

test('an archived, frozen, shared, direct or unjoined conversation is unsupported', async () => {
  for (const change of [
    { archived: true },
    { frozen: true },
    { shared: true },
    { externallyShared: true },
    { organizationShared: true },
    { pendingShared: true },
    { im: true },
    { mpim: true },
    { member: false },
  ]) {
    assert.deepEqual(
      await resolveSlackAdmissionTruth(
        turn(),
        BOT_USER_ID,
        reader(undefined, { ok: true, facts: { ...channel, ...change } }).reader,
      ),
      { eligible: false, reason: 'unsupported_conversation' },
      JSON.stringify(change),
    );
  }
});

interface SlackCall {
  endpoint: string;
  method: string | undefined;
  authorization: string | undefined;
  body: string;
}

/** Answer Slack Web API calls with `answer`, recording each request. */
function stubSlack(t: TestContext, answer: () => unknown): SlackCall[] {
  const calls: SlackCall[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({
      endpoint: url.slice(url.lastIndexOf('/') + 1),
      method: init.method,
      authorization: new Headers(init.headers).get('authorization') ?? undefined,
      body: String(init.body),
    });
    return Response.json(answer());
  });
  return calls;
}

test('the user reader returns Slack\'s person, and nothing when Slack has none', async (t) => {
  const calls = stubSlack(t, () => ({
    ok: true,
    user: { id: 'U_PERSON', team_id: 'T_ADMIT', tz: 'Europe/Paris', profile: { display_name: 'Ada' } },
  }));
  assert.deepEqual(await slackAdmissionTruthReader('xoxb-admission').user('U_PERSON'), {
    ok: true,
    user: { ...person, displayName: 'Ada', timezone: 'Europe/Paris' },
  });
  assert.deepEqual(calls, [{
    endpoint: 'users.info',
    method: 'POST',
    authorization: 'Bearer xoxb-admission',
    body: 'user=U_PERSON',
  }]);

  for (const answer of [{ ok: false, error: 'user_not_found' }, { ok: false, user: { id: 'U_PERSON' } }]) {
    t.mock.restoreAll();
    stubSlack(t, () => answer);
    assert.deepEqual(
      await slackAdmissionTruthReader('xoxb-admission').user('U_PERSON'),
      { ok: false, ...(answer.user ? { user: { ...person, teamId: undefined, timezone: undefined } } : {}) },
      JSON.stringify(answer),
    );
  }
  t.mock.restoreAll();
  stubSlack(t, () => ({ ok: true }));
  assert.deepEqual(await slackAdmissionTruthReader('xoxb-admission').user('U_PERSON'), { ok: true });
});

test('the conversation reader returns Slack\'s channel, and nothing when Slack has none', async (t) => {
  const calls = stubSlack(t, () => ({
    ok: true,
    channel: { id: 'C_ADMIT', name: 'general', is_member: true, context_team_id: 'T_ADMIT' },
  }));
  assert.deepEqual(await slackAdmissionTruthReader('xoxb-admission').conversation('C_ADMIT'), {
    ok: true,
    facts: channel,
  });
  assert.deepEqual(calls, [{
    endpoint: 'conversations.info',
    method: 'POST',
    authorization: 'Bearer xoxb-admission',
    body: 'channel=C_ADMIT',
  }]);

  t.mock.restoreAll();
  stubSlack(t, () => ({ ok: false, error: 'channel_not_found' }));
  assert.deepEqual(await slackAdmissionTruthReader('xoxb-admission').conversation('C_ADMIT'), { ok: false });
  t.mock.restoreAll();
  stubSlack(t, () => ({ ok: true }));
  assert.deepEqual(await slackAdmissionTruthReader('xoxb-admission').conversation('C_ADMIT'), { ok: true });
});

test('both readers give up after three seconds by default, or the bound they are given', { timeout: 5_000 }, async (t) => {
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(() => {}));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const read of [
    (truth: ReturnType<typeof slackAdmissionTruthReader>) => truth.user('U_PERSON'),
    (truth: ReturnType<typeof slackAdmissionTruthReader>) => truth.conversation('C_ADMIT'),
  ]) {
    for (const [bound, truth] of [
      [3_000, slackAdmissionTruthReader('xoxb-admission')],
      [250, slackAdmissionTruthReader('xoxb-admission', 250)],
    ] as const) {
      let settled: unknown;
      const pending = read(truth).then((result) => { settled = result; });
      t.mock.timers.tick(bound - 1);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, undefined, `still waiting before ${bound} ms`);
      t.mock.timers.tick(1);
      await pending;
      assert.deepEqual(settled, { ok: false });
    }
  }
});
