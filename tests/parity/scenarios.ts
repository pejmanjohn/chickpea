import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appHomeMessage,
  appMention,
  assistantThreadStarted,
  channelThreadMessage,
  dmMessage,
  topLevelChannelMessage,
} from '../helpers/slack-fixtures.ts';
import { RAW_PROVIDER_ERROR_MARKER, STUB_REPLY_MARKER, isMarkdownPost } from './fake-slack.ts';
import type { ParityException } from './exceptions.ts';
import type { Lane, LaneInstance, ScenarioLaneConfig } from './lane.ts';
import type { SlackEventFixture } from '../../src/slack/types.ts';

/** The exec channel / root thread the default fixtures target. */
const EXEC_CHANNEL = 'C_EXEC';
const ROOT_THREAD_TS = '1782770400.000100';

export interface Scenario {
  id: string;
  title: string;
  config: ScenarioLaneConfig;
  run(instance: LaneInstance): Promise<void>;
}

export const scenarios: Scenario[] = [
  {
    id: 'S01',
    title: 'url_verification echoes the challenge without touching the wire',
    config: {},
    async run(instance) {
      const response = await instance.postEvent({
        type: 'url_verification',
        challenge: 'parity-challenge',
      });

      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { challenge: 'parity-challenge' });
      await instance.quiesce();
      assert.equal(instance.backend.wireLog.length, 0);
    },
  },
  {
    id: 'S02',
    title: 'tampered signature is rejected with 401 and no wire calls',
    config: {},
    async run(instance) {
      const response = await instance.postEvent(appMention(), { tamper: true });

      assert.equal(response.status, 401);
      await instance.quiesce();
      assert.equal(instance.backend.wireLog.length, 0);
    },
  },
  {
    id: 'S03',
    title: 'mention full turn delivers one final, sets then clears status',
    config: {},
    async run(instance) {
      const response = await instance.postEvent(appMention());
      assert.equal(response.status, 200);
      await instance.quiesce();

      const finals = instance.backend.finals();
      assert.equal(finals.length, 1);
      const [final] = finals;
      assert.ok(final);
      assert.equal(final.channel, EXEC_CHANNEL);
      assert.equal(final.threadTs, ROOT_THREAD_TS);
      assert.ok(
        final.text.includes(STUB_REPLY_MARKER),
        'final text should carry the provider stub reply verbatim',
      );

      const statuses = instance.backend.statusCalls();
      assert.ok(
        statuses.some((entry) => String(entry.body.status).trim() !== ''),
        'expected at least one non-empty status',
      );
      const lastStatus = statuses.at(-1);
      assert.ok(lastStatus);
      assert.equal(String(lastStatus.body.status), '');
    },
  },
  {
    id: 'S04',
    title: 'duplicate delivery yields one final and at most one provider call',
    config: {},
    async run(instance) {
      const payload = appMention();
      const responses = [
        await instance.postEvent(payload),
        await instance.postEvent(payload),
        await instance.postEvent(payload),
      ];

      for (const response of responses) {
        assert.equal(response.status, 200);
      }
      await instance.quiesce();

      assert.equal(instance.backend.finals().length, 1);
      assert.ok(instance.backend.providerCalls().length <= 1);
    },
  },
  {
    id: 'S05',
    title: 'default 24h window drives conversations.history',
    config: {},
    async run(instance) {
      await instance.postEvent(appMention());
      await instance.quiesce();

      const historyCalls = instance.backend.callsOfMethod('conversations.history');
      assert.equal(historyCalls.length, 1);
      const [history] = historyCalls;
      assert.ok(history);
      assert.equal(history.body.channel, EXEC_CHANNEL);
      assert.ok(Number(history.body.limit) <= 50);
      assert.equal(history.body.latest, ROOT_THREAD_TS);
      assert.equal(
        Math.round(Number(history.body.latest) - Number(history.body.oldest)),
        86400,
      );
    },
  },
  {
    id: 'S06',
    title: '"last 2 days" widens the history window to 172800s',
    config: {},
    async run(instance) {
      await instance.postEvent(
        appMention({
          event_id: 'Ev_WINDOW_2D',
          event: { text: '<@U_BOT> what changed in the last 2 days?' },
        }),
      );
      await instance.quiesce();

      const [history] = instance.backend.callsOfMethod('conversations.history');
      assert.ok(history);
      assert.equal(
        Math.round(Number(history.body.latest) - Number(history.body.oldest)),
        172800,
      );
    },
  },
  {
    id: 'S07',
    title: 'thread continuation reads replies and feeds human context to the provider',
    config: {},
    async run(instance) {
      await instance.postEvent(appMention());
      await instance.quiesce();
      await instance.postEvent(channelThreadMessage());
      await instance.quiesce();

      const finals = instance.backend.finals();
      assert.equal(finals.length, 2);
      assert.ok(finals.every((final) => final.threadTs === ROOT_THREAD_TS));

      const replyCalls = instance.backend.callsOfMethod('conversations.replies');
      assert.ok(replyCalls.length >= 1);
      const [firstReply] = replyCalls;
      assert.ok(firstReply);
      assert.equal(firstReply.body.ts, ROOT_THREAD_TS);
      assert.ok(Number(firstReply.body.limit) <= 50);

      const providerCalls = instance.backend.providerCalls();
      const turnTwoProvider = providerCalls.at(-1);
      assert.ok(turnTwoProvider);
      const serialized = JSON.stringify(turnTwoProvider.body);
      assert.ok(serialized.includes('prior thread detail'));
      assert.ok(!serialized.includes('bot prior reply'));
    },
  },
  {
    id: 'S08',
    title: 'DM turn uses conversations.history and never conversations.replies',
    config: {},
    async run(instance) {
      await instance.postEvent(dmMessage());
      await instance.quiesce();

      const finals = instance.backend.finals();
      assert.equal(finals.length, 1);
      const [final] = finals;
      assert.ok(final);
      assert.equal(final.channel, 'D_DEMO_DM');
      assert.ok(
        instance.backend
          .callsOfMethod('conversations.history')
          .some((entry) => entry.body.channel === 'D_DEMO_DM'),
      );
      assert.equal(instance.backend.callsOfMethod('conversations.replies').length, 0);
    },
  },
  {
    id: 'S09',
    title: 'App Home messages reuse the DM path',
    config: {},
    async run(instance) {
      await instance.postEvent(appHomeMessage());
      await instance.quiesce();

      const finals = instance.backend.finals();
      assert.equal(finals.length, 1);
      const [final] = finals;
      assert.ok(final);
      assert.equal(final.channel, 'D_DEMO_APP_HOME');
      assert.equal(instance.backend.callsOfMethod('conversations.replies').length, 0);
    },
  },
  {
    id: 'S10',
    title: 'top-level channel message is ignored with no wire calls',
    config: {},
    async run(instance) {
      const response = await instance.postEvent(topLevelChannelMessage());
      assert.equal(response.status, 200);
      await instance.quiesce();
      assert.equal(instance.backend.wireLog.length, 0);
    },
  },
  {
    id: 'S11',
    title: 'filtered message events never reach the wire',
    config: {},
    async run(instance) {
      const missingUser = channelThreadMessage({ event_id: 'Ev_MSG_MISSING_USER' });
      delete missingUser.event.user;

      const cases: SlackEventFixture[] = [
        channelThreadMessage({
          event_id: 'Ev_MSG_BOT',
          event: { bot_id: 'B_DEMO', user: 'U_BOT' },
        }),
        channelThreadMessage({
          event_id: 'Ev_MSG_APP',
          event: { app_id: 'A_DEMO', user: 'U_APP_MESSAGE' },
        }),
        channelThreadMessage({ event_id: 'Ev_MSG_SELF', event: { user: 'U_BOT' } }),
        channelThreadMessage({
          event_id: 'Ev_MSG_SUBTYPE',
          event: { subtype: 'message_changed' },
        }),
        missingUser,
        channelThreadMessage({ event_id: 'Ev_MSG_EMPTY', event: { text: '   ' } }),
      ];

      for (const payload of cases) {
        const response = await instance.postEvent(payload);
        assert.equal(response.status, 200);
      }
      await instance.quiesce();
      assert.equal(instance.backend.wireLog.length, 0);
    },
  },
  {
    id: 'S12',
    title: 'assistant events are acknowledged without running',
    config: {},
    async run(instance) {
      const started = assistantThreadStarted();
      const startedResponse = await instance.postEvent(started);
      assert.ok(startedResponse.status >= 200 && startedResponse.status < 300);

      const changed = structuredClone(started);
      changed.event_id = 'Ev_ASSISTANT_002';
      changed.event.type = 'assistant_thread_context_changed';
      const changedResponse = await instance.postEvent(changed);
      assert.ok(changedResponse.status >= 200 && changedResponse.status < 300);

      await instance.quiesce();
      assert.equal(instance.backend.wireLog.length, 0);
    },
  },
  {
    id: 'S13',
    title: 'implicit thread reply with no prior session is dropped',
    config: {},
    async run(instance) {
      const response = await instance.postEvent(channelThreadMessage());
      assert.equal(response.status, 200);
      await instance.quiesce();
      assert.equal(instance.backend.wireLog.length, 0);
    },
  },
  {
    id: 'S14',
    title: 'fail-closed without a bot user id: mention runs, thread reply does not',
    config: { botUserId: null },
    async run(instance) {
      await instance.postEvent(appMention());
      await instance.quiesce();
      assert.equal(instance.backend.finals().length, 1);

      await instance.postEvent(channelThreadMessage());
      await instance.quiesce();
      assert.equal(instance.backend.finals().length, 1);
    },
  },
  {
    id: 'S15',
    title: 'provider failure still delivers one sanitized final and clears status',
    config: { provider: { mode: 'http_500' } },
    async run(instance) {
      await instance.postEvent(appMention());
      await instance.quiesce();

      const finals = instance.backend.finals();
      assert.equal(finals.length, 1);
      const [final] = finals;
      assert.ok(final);
      assert.ok(
        !final.text.includes(RAW_PROVIDER_ERROR_MARKER),
        'raw provider error must not leak to the wire',
      );

      const lastStatus = instance.backend.statusCalls().at(-1);
      assert.ok(lastStatus);
      assert.equal(String(lastStatus.body.status), '');
    },
  },
  {
    id: 'S16',
    title: 'status rejection falls back to a durable progress post before the final',
    config: { slack: { rejectSetStatus: true } },
    async run(instance) {
      await instance.postEvent(appMention());
      await instance.quiesce();

      const finals = instance.backend.finals();
      assert.equal(finals.length, 1);
      const [final] = finals;
      assert.ok(final);

      const progressPosts = instance.backend.progressPosts();
      assert.ok(progressPosts.length >= 1, 'expected a durable progress post');

      const firstProgressIndex = instance.backend.wireLog.findIndex(
        (entry) => entry.method === 'chat.postMessage' && !isMarkdownPost(entry.body),
      );
      assert.ok(firstProgressIndex >= 0);
      assert.ok(firstProgressIndex < final.index, 'progress must precede the final');

      const statuses = instance.backend.statusCalls();
      const nonEmptyStatuses = statuses.filter((entry) => String(entry.body.status) !== '');
      assert.ok(nonEmptyStatuses.length <= 2, 'no retry storm of status calls');
    },
  },
  {
    id: 'S17',
    title: 'startStream rejection delivers the final via chat.postMessage once',
    config: { slack: { rejectStartStream: true } },
    async run(instance) {
      await instance.postEvent(appMention());
      await instance.quiesce();

      const finals = instance.backend.finals();
      assert.equal(finals.length, 1);
      const [final] = finals;
      assert.ok(final);
      assert.ok(final.text.includes(STUB_REPLY_MARKER));

      assert.equal(instance.backend.callsOfMethod('chat.postMessage').length, 1);
      assert.equal(instance.backend.callsOfMethod('chat.stopStream').length, 0);
    },
  },
  {
    id: 'S18',
    title: 'a single stopStream failure does not duplicate the final',
    config: { slack: { failStopStreamOnce: true } },
    async run(instance) {
      await instance.postEvent(appMention());
      await instance.quiesce();

      assert.equal(instance.backend.finals().length, 1);
    },
  },
  {
    id: 'S19',
    title: 'unconfigured workspace/channel gets a wildcard assignment final',
    config: {},
    async run(instance) {
      await instance.postEvent(
        appMention({ team_id: 'T_OTHER', event: { channel: 'C_OTHER' } }),
      );
      await instance.quiesce();

      const finals = instance.backend.finals();
      assert.equal(finals.length, 1);
      const [final] = finals;
      assert.ok(final);
      assert.equal(final.channel, 'C_OTHER');
      assert.equal(final.threadTs, ROOT_THREAD_TS);
    },
  },
  {
    id: 'S20',
    title: 'explicit mention follow-up delivers two finals in the same thread',
    config: {},
    async run(instance) {
      await instance.postEvent(appMention());
      await instance.quiesce();
      await instance.postEvent(
        appMention({
          event_id: 'Ev_DEMO_FOLLOWUP',
          event: {
            text: '<@U_BOT> please use channel context for a follow-up',
            ts: '1782770500.000100',
            event_ts: '1782770500.000100',
            thread_ts: ROOT_THREAD_TS,
          },
        }),
      );
      await instance.quiesce();

      const finals = instance.backend.finals();
      assert.equal(finals.length, 2);
      assert.ok(finals.every((final) => final.threadTs === ROOT_THREAD_TS));
    },
  },
  {
    id: 'S21',
    title: 'threaded mention fan-out (mention + companion message) yields one reply',
    config: {},
    async run(instance) {
      // Slack delivers BOTH an app_mention and a message event for a single
      // in-thread mention: same channel + message ts, different event_ids. A
      // correct app replies exactly once. The Flue lane claims
      // msg:channel:messageTs (in addition to evt:event_id), so the companion
      // is deduped. Lane A dedupes on event_id only, so it double-replies —
      // that lane is frozen and registered as an expected-fail exception.
      const fanoutTs = ROOT_THREAD_TS;
      const mention = appMention({
        event_id: 'Ev_FANOUT_MENTION',
        event: { text: '<@U_BOT> fan-out check', ts: fanoutTs, event_ts: fanoutTs },
      });
      const companion = channelThreadMessage({
        event_id: 'Ev_FANOUT_MESSAGE',
        event: {
          text: '<@U_BOT> fan-out check',
          ts: fanoutTs,
          event_ts: fanoutTs,
          thread_ts: fanoutTs,
        },
      });

      const mentionResponse = await instance.postEvent(mention);
      assert.equal(mentionResponse.status, 200);
      await instance.quiesce();

      const companionResponse = await instance.postEvent(companion);
      assert.equal(companionResponse.status, 200);
      await instance.quiesce();

      assert.equal(instance.backend.finals().length, 1);
    },
  },
];

/**
 * Register the scenario suite as `node:test` tests for a lane.
 *
 * `exceptions` is additive (default `[]` preserves the original behavior). An
 * entry whose `scenarioId` + `lane` match is honored per its `behavior`:
 * `expected-fail` scenarios still RUN, an assertion failure passes the test
 * with a printed `EXCEPTION` note, and an unexpected PASS fails the test as a
 * stale exception.
 */
export function runScenarioSuite(lane: Lane, exceptions: ParityException[] = []): void {
  for (const scenario of scenarios) {
    const exception = exceptions.find(
      (entry) => entry.scenarioId === scenario.id && entry.lane === lane.name,
    );
    test(`${lane.name} · ${scenario.id} ${scenario.title}`, async () => {
      const instance = await lane.start(scenario.config);
      let scenarioError: unknown;
      try {
        await scenario.run(instance);
      } catch (error) {
        scenarioError = error;
      } finally {
        await instance.stop();
      }

      if (exception?.behavior === 'expected-fail') {
        if (scenarioError === undefined) {
          throw new Error(
            `Stale exception: ${scenario.id} on ${lane.name} is registered as ` +
              `expected-fail but PASSED. Remove the exceptions.ts entry. Rationale ` +
              `was: ${exception.rationale}`,
          );
        }
        const reason =
          scenarioError instanceof Error ? scenarioError.message : String(scenarioError);
        console.log(
          `EXCEPTION  ${lane.name} · ${scenario.id}: expected-fail as designed — ` +
            `${exception.rationale} (observed failure: ${reason.split('\n')[0]})`,
        );
        return;
      }

      if (scenarioError !== undefined) {
        throw scenarioError;
      }
    });
  }
}
