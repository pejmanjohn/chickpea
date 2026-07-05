import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appHomeMessage,
  appMention,
  assistantThreadStarted,
  channelThreadMessage,
  dmMessage,
  memberJoinedChannel,
  topLevelChannelMessage,
} from '../helpers/slack-fixtures.ts';
import {
  RAW_PROVIDER_ERROR_MARKER,
  STUB_REPLY_MARKER,
  TOOL_TRIGGER,
  isMarkdownPost,
} from './fake-slack.ts';
import type { ParityException } from './exceptions.ts';
import type { Lane, LaneInstance, ScenarioLaneConfig } from './lane.ts';
import { PROVIDER_FAILURE_TEXT } from '../../src/slack/web-client-presenter.ts';
import { slackFallbackTextLimit } from '../../src/slack/message-format.ts';
import type { SlackEventFixture } from '../../src/slack/types.ts';
import { seededAgents } from '../../src/config/seed.ts';

/** The exec channel / root thread the default fixtures target. */
const EXEC_CHANNEL = 'C_EXEC';
const ROOT_THREAD_TS = '1782770400.000100';

export interface Scenario {
  id: string;
  title: string;
  config: ScenarioLaneConfig;
  run(instance: LaneInstance): Promise<void>;
}

function demoChannelConfig(config: ScenarioLaneConfig = {}): ScenarioLaneConfig {
  return {
    ...config,
    configSeed: {
      agents: seededAgents,
      assignments: [
        {
          workspaceId: 'T_DEMO',
          channelId: 'C_ENG',
          agentId: 'agent_release_scribe',
          enabled: true,
          channelLabel: 'eng-releases',
        },
        {
          workspaceId: 'T_DEMO',
          channelId: EXEC_CHANNEL,
          agentId: 'agent_exec_brief',
          enabled: true,
          channelLabel: 'exec-briefing',
        },
        { workspaceId: '*', channelId: '*', agentId: 'agent_exec_brief', enabled: true },
      ],
    },
  };
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
    config: demoChannelConfig(),
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
      const nonEmptyStatusTexts = statuses
        .map((entry) => String(entry.body.status ?? '').trim())
        .filter(Boolean);
      const distinctStatusTexts = [...new Set(nonEmptyStatusTexts)];
      assert.ok(distinctStatusTexts.length >= 3, 'expected at least three distinct status texts');
      assert.match(distinctStatusTexts[0] ?? '', /reading the thread/);
      assert.ok(
        distinctStatusTexts.some((text) => /using \d+ messages? of .+ context/.test(text)),
        'expected one status to include the hydrated message count',
      );
      assert.ok(
        distinctStatusTexts.some((text) => text.includes('local-stub/parity-stub-1')),
        'expected one status to name the resolved model id',
      );
      const lastStatus = statuses.at(-1);
      assert.ok(lastStatus);
      assert.equal(String(lastStatus.body.status), '');
    },
  },
  {
    id: 'S04',
    title: 'duplicate delivery yields one final and at most one provider call',
    config: demoChannelConfig(),
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
    config: demoChannelConfig(),
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
    config: demoChannelConfig(),
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
    config: demoChannelConfig(),
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
      // Both filtered reply rows must be absent: the bot row exercises the
      // `bot_id` half of the thread-context filter (it now carries a `user`, so
      // only the `bot_id` guard can exclude it), the subtype row the `subtype`
      // half.
      assert.ok(!serialized.includes('bot prior reply'));
      assert.ok(!serialized.includes('subtype prior row'));
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
    config: demoChannelConfig({ botUserId: null }),
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
    config: demoChannelConfig({ provider: { mode: 'http_500' } }),
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
      assert.ok(
        instance.backend
          .statusCalls()
          .every((entry) => !String(entry.body.status).includes(RAW_PROVIDER_ERROR_MARKER)),
        'raw provider error must not leak to status text',
      );

      const lastStatus = instance.backend.statusCalls().at(-1);
      assert.ok(lastStatus);
      assert.equal(String(lastStatus.body.status), '');
    },
  },
  {
    id: 'S16',
    title: 'status rejection falls back to a durable progress post before the final',
    config: demoChannelConfig({ slack: { rejectSetStatus: true } }),
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
    config: demoChannelConfig({ slack: { rejectStartStream: true } }),
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
    config: demoChannelConfig({ slack: { failStopStreamOnce: true } }),
    async run(instance) {
      await instance.postEvent(appMention());
      await instance.quiesce();

      assert.equal(instance.backend.finals().length, 1);
    },
  },
  {
    id: 'S19',
    title: 'an unconfigured channel is fail-closed — the global wildcard is DM-only',
    // The default seed's '*,*' wildcard is the direct-conversation default, not
    // a channel catch-all. A mention in a channel with no explicit assignment
    // must produce nothing on the wire (channels never fall through to '*,*').
    config: {},
    async run(instance) {
      await instance.postEvent(
        appMention({ team_id: 'T_OTHER', event: { channel: 'C_OTHER' } }),
      );
      await instance.quiesce();

      assert.equal(
        instance.backend.finals().length,
        0,
        'an unassigned channel must stay silent (no wildcard fallback for channels)',
      );
    },
  },
  {
    id: 'S20',
    title: 'explicit mention follow-up delivers two finals in the same thread',
    config: demoChannelConfig(),
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
    config: demoChannelConfig(),
    async run(instance) {
      // Slack delivers BOTH an app_mention and a message event for a single
      // in-thread mention: same channel + message ts, different event_ids. A
      // correct app replies exactly once. This is a Lane B guarantee: Flue
      // claims msg:channel:messageTs (in addition to evt:event_id), so the
      // companion event is deduped and only one final is delivered. The old
      // event_id-only hand-rolled lane (deleted) dedupes on event_id alone, so
      // it would have double-replied here — that's the origin of the dual-key
      // claim design. No exception is registered for this scenario (the
      // exceptions registry is empty; see exceptions.ts).
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
  {
    id: 'S22',
    title: 'context read failure degrades to current-message context without blocking the final',
    config: demoChannelConfig({ slack: { failConversationReads: true } }),
    async run(instance) {
      // The mention's channel_history hydration calls conversations.history,
      // which the fake rejects with { ok:false } so the product WebClient throws
      // mid-hydration. The turn must degrade to current-message-only context and
      // still deliver its final (mirrors the deleted runner test "context read
      // failures degrade to current-message context without blocking finals").
      const response = await instance.postEvent(appMention());
      assert.equal(response.status, 200);
      await instance.quiesce();

      // The failing read was actually exercised (not bypassed).
      assert.ok(
        instance.backend.callsOfMethod('conversations.history').length >= 1,
        'expected the (failing) conversations.history read to be attempted',
      );

      // Degradation actually happened, not just implied: since the read
      // failed, none of the fake's default channel-history rows (e.g.
      // "recent channel context", see DEFAULT_HISTORY_MESSAGES in
      // fake-slack.ts) can have reached the provider prompt.
      const providerCalls = instance.backend.providerCalls();
      const lastProvider = providerCalls.at(-1);
      assert.ok(lastProvider);
      assert.ok(
        !JSON.stringify(lastProvider.body).includes('recent channel context'),
        'degraded context must not include the (unreachable) default channel-history row',
      );

      const finals = instance.backend.finals();
      assert.equal(finals.length, 1);
      const [final] = finals;
      assert.ok(final);
      assert.equal(final.channel, EXEC_CHANNEL);
      assert.equal(final.threadTs, ROOT_THREAD_TS);
      assert.ok(
        final.text.includes(STUB_REPLY_MARKER),
        'degraded-but-answered: the final still carries the provider stub reply',
      );
    },
  },
  {
    id: 'S23',
    title: 'final delivery failure releases the claim so a Slack retry re-drives exactly one final',
    config: demoChannelConfig({ slack: { failFinalDeliveryOnce: true } }),
    async run(instance) {
      const event = appMention();

      // First attempt: both final transports (startStream + markdown post) fail,
      // so deliverFinal throws, runTurn throws, and the claim is released. No
      // final reaches the wire.
      const first = await instance.postEvent(event);
      assert.equal(first.status, 200);
      await instance.quiesce();
      assert.equal(
        instance.backend.finals().length,
        0,
        'a fully-failed delivery must not count as a final on the wire',
      );

      // Slack retries the SAME signed event. Because the claim was released, the
      // retry re-drives the turn; delivery now succeeds. Dedupe still prevents a
      // second post, so exactly one final lands (mirrors the deleted runner test
      // "delivery failure after provider success releases dedupe for retry").
      const retry = await instance.postEvent(event);
      assert.equal(retry.status, 200);
      await instance.quiesce();

      const finals = instance.backend.finals();
      assert.equal(finals.length, 1);
      const [final] = finals;
      assert.ok(final);
      assert.equal(final.threadTs, ROOT_THREAD_TS);
      assert.ok(final.text.includes(STUB_REPLY_MARKER));
    },
  },
  {
    id: 'S24',
    title: 'agent-pinned local-stub model overrides the lane fallback model',
    config: {
      configSeed: {
        agents: [
          {
            id: 'agent_pinned_model',
            name: 'Pinned Model Agent',
            description: 'Pins a local-stub model for parity.',
            instructions: 'Use the pinned parity model.',
            enabled: true,
            model: 'local-stub/agent-pinned',
            defaultModels: {
              claude: 'anthropic/pinned-claude',
              'workers-ai': '@cf/pinned/model',
            },
            allowedTools: [],
          },
        ],
        assignments: [
          {
            workspaceId: 'T_DEMO',
            channelId: EXEC_CHANNEL,
            agentId: 'agent_pinned_model',
            enabled: true,
          },
        ],
      },
    },
    async run(instance) {
      const response = await instance.postEvent(
        appMention({
          event_id: 'Ev_PINNED_MODEL',
          event: { ts: '1782770900.000100' },
        }),
      );
      assert.equal(response.status, 200);
      await instance.quiesce();

      const provider = instance.backend.providerCalls().at(-1);
      assert.ok(provider);
      assert.equal(provider.body.model, 'agent-pinned');
      assert.notEqual(provider.body.model, 'parity-stub-1');
    },
  },
  {
    id: 'S25',
    title: 'channel prompt addendum appears only for assignments that set one',
    config: {
      configSeed: {
        agents: [
          {
            id: 'agent_addendum',
            name: 'Addendum Agent',
            description: 'Exercises channel prompt addenda.',
            instructions: 'Base addendum test instructions.',
            enabled: true,
            defaultModels: {
              claude: 'anthropic/addendum-claude',
              'workers-ai': '@cf/addendum/model',
            },
            allowedTools: [],
          },
        ],
        assignments: [
          {
            workspaceId: 'T_DEMO',
            channelId: EXEC_CHANNEL,
            agentId: 'agent_addendum',
            enabled: true,
            channelPromptAddendum: 'CHANNEL_ADDENDUM_MARKER: prefer launch-local context.',
          },
          {
            workspaceId: 'T_DEMO',
            channelId: 'C_NOADD',
            agentId: 'agent_addendum',
            enabled: true,
          },
        ],
      },
    },
    async run(instance) {
      await instance.postEvent(
        appMention({
          event_id: 'Ev_ADDENDUM_PRESENT',
          event: { ts: '1782771000.000100', event_ts: '1782771000.000100' },
        }),
      );
      await instance.quiesce();

      const withAddendum = instance.backend.providerCalls().at(-1);
      assert.ok(withAddendum);
      assert.match(JSON.stringify(withAddendum.body), /CHANNEL_ADDENDUM_MARKER/);

      await instance.postEvent(
        appMention({
          event_id: 'Ev_ADDENDUM_ABSENT',
          event: {
            channel: 'C_NOADD',
            ts: '1782771001.000100',
            event_ts: '1782771001.000100',
            text: '<@U_BOT> summarize without an addendum',
          },
        }),
      );
      await instance.quiesce();

      const withoutAddendum = instance.backend.providerCalls().at(-1);
      assert.ok(withoutAddendum);
      assert.doesNotMatch(JSON.stringify(withoutAddendum.body), /CHANNEL_ADDENDUM_MARKER/);
    },
  },
  {
    id: 'S26',
    title: 'tool-triggered turns surface lookup_channel_brief status without changing final delivery',
    config: demoChannelConfig(),
    async run(instance) {
      await instance.postEvent(
        appMention({
          event_id: 'Ev_TOOL_STATUS',
          event: {
            text: `<@U_BOT> ${TOOL_TRIGGER}`,
            ts: '1782771100.000100',
            event_ts: '1782771100.000100',
          },
        }),
      );
      await instance.quiesce();

      const finals = instance.backend.finals();
      assert.equal(finals.length, 1);
      const [final] = finals;
      assert.ok(final);
      assert.match(final.text, /Tool result:/);
      assert.match(final.text, /exec leadership channel tracks board prep/);

      const toolStatusIndex = instance.backend.wireLog.findIndex(
        (entry) =>
          entry.method === 'assistant.threads.setStatus' &&
          String(entry.body.status).includes('lookup_channel_brief'),
      );
      assert.ok(toolStatusIndex >= 0, 'expected a lookup_channel_brief status on the wire');
      assert.ok(toolStatusIndex < final.index, 'tool status must precede the final');
    },
  },
  {
    id: 'S27',
    title: 'tool-triggered turns still deliver one final when status updates reject',
    config: demoChannelConfig({ slack: { rejectSetStatus: true } }),
    async run(instance) {
      await instance.postEvent(
        appMention({
          event_id: 'Ev_TOOL_STATUS_REJECT',
          event: {
            text: `<@U_BOT> ${TOOL_TRIGGER}`,
            ts: '1782771101.000100',
            event_ts: '1782771101.000100',
          },
        }),
      );
      await instance.quiesce();
      assert.equal(instance.backend.finals().length, 1);
    },
  },
  {
    id: 'S28',
    title: 'unresolvable agent model degrades to one sanitized final, not silence',
    // Agent has no pinned model, and the lane fallback SLACK_FLUE_MODEL is
    // cleared, so the model cannot resolve. The cosmetic model status must not
    // abort the turn: the turn must still deliver exactly one sanitized final
    // (regression for resolveAgentModel throwing on the delivery path, which
    // previously left the user with silence + a Slack retry loop).
    config: {
      env: { SLACK_FLUE_MODEL: '' },
      configSeed: {
        agents: [
          {
            id: 'agent_unresolvable',
            name: 'Unresolvable Model Agent',
            description: 'Has no resolvable model in the parity environment.',
            instructions: 'Reply if you can.',
            enabled: true,
            defaultModels: {
              claude: 'anthropic/parity-claude',
              'workers-ai': '@cf/parity/model',
            },
            allowedTools: [],
          },
        ],
        assignments: [
          {
            workspaceId: 'T_DEMO',
            channelId: EXEC_CHANNEL,
            agentId: 'agent_unresolvable',
            enabled: true,
          },
        ],
      },
    },
    async run(instance) {
      await instance.postEvent(appMention());
      await instance.quiesce();

      const finals = instance.backend.finals();
      assert.equal(finals.length, 1, 'an unresolvable model must still deliver one final, not silence');
      const [final] = finals;
      assert.ok(final);
      assert.equal(final.text, PROVIDER_FAILURE_TEXT);
    },
  },
  {
    id: 'S29',
    title: 'explicit demo channel fixtures feed distinct profile instructions to the provider',
    config: demoChannelConfig(),
    async run(instance) {
      await instance.postEvent(
        appMention({
          event_id: 'Ev_DEMO_RELEASE_SCRIBE',
          event: {
            channel: 'C_ENG',
            text: '<@U_BOT> draft the release note for the latency fix',
            ts: '1782771200.000100',
            event_ts: '1782771200.000100',
          },
        }),
      );
      await waitForFinalCount(instance, 1);
      const releasePrompt = JSON.stringify(instance.backend.providerCalls().at(-1)?.body ?? {});
      assert.match(releasePrompt, /Release Scribe/);
      assert.match(releasePrompt, /summary table/i);
      assert.match(releasePrompt, /fenced code\/diff snippet/i);

      await instance.postEvent(
        appMention({
          event_id: 'Ev_DEMO_EXEC_BRIEF',
          event: {
            channel: EXEC_CHANNEL,
            text: '<@U_BOT> brief leadership on the launch plan',
            ts: '1782771201.000100',
            event_ts: '1782771201.000100',
          },
        }),
      );
      await waitForFinalCount(instance, 2);
      const execPrompt = JSON.stringify(instance.backend.providerCalls().at(-1)?.body ?? {});
      assert.match(execPrompt, /Exec Brief/);
      assert.match(execPrompt, /bold-led bullets/i);
      assert.match(execPrompt, /Next steps/);
      assert.doesNotMatch(execPrompt, /fenced code\/diff snippet/i);
    },
  },
  {
    id: 'S30',
    title: 'reply footer appears on streamed fallback and provider-failure finals',
    config: demoChannelConfig({
      env: { SLACK_FLUE_PUBLIC_URL: 'https://demo.example' },
    }),
    async run(instance) {
      await instance.postEvent(
        appMention({
          event_id: 'Ev_FOOTER_STREAM',
          event: {
            text: '<@U_BOT> answer with a streamed footer',
            ts: '1782771300.000100',
            event_ts: '1782771300.000100',
          },
        }),
      );
      await waitForFinalCount(instance, 1);
      const streamedStop = instance.backend.callsOfMethod('chat.stopStream').at(-1);
      assert.ok(streamedStop);
      assertFooterBlock(streamedStop.body.blocks, {
        profileName: 'Exec Brief',
        modelLabel: 'local-stub/parity-stub-1',
        configureUrl: 'https://demo.example/admin?agent=agent_exec_brief',
      });

      instance.backend.configure({ slack: { rejectStartStream: true } });
      await instance.postEvent(
        appMention({
          event_id: 'Ev_FOOTER_FALLBACK',
          event: {
            text: '<@U_BOT> answer through postMessage fallback',
            ts: '1782771301.000100',
            event_ts: '1782771301.000100',
          },
        }),
      );
      await waitForFinalCount(instance, 2);
      const fallbackPost = instance.backend.callsOfMethod('chat.postMessage').at(-1);
      assert.ok(fallbackPost);
      assertFooterBlock(fallbackPost.body.blocks, {
        profileName: 'Exec Brief',
        modelLabel: 'local-stub/parity-stub-1',
        configureUrl: 'https://demo.example/admin?agent=agent_exec_brief',
      });
      assert.ok(String(fallbackPost.body.text ?? '').length <= slackFallbackTextLimit);

      instance.backend.configure({
        provider: { mode: 'http_500' },
        slack: { rejectStartStream: false },
      });
      await instance.postEvent(
        appMention({
          event_id: 'Ev_FOOTER_PROVIDER_FAILURE',
          event: {
            text: '<@U_BOT> trigger provider failure with a footer',
            ts: '1782771302.000100',
            event_ts: '1782771302.000100',
          },
        }),
      );
      await waitForFinalCount(instance, 3, 65_000);
      const failureStop = instance.backend.callsOfMethod('chat.stopStream').at(-1);
      assert.ok(failureStop);
      assertFooterBlock(failureStop.body.blocks, {
        profileName: 'Exec Brief',
        modelLabel: 'local-stub/parity-stub-1',
        configureUrl: 'https://demo.example/admin?agent=agent_exec_brief',
      });
      assert.equal(instance.backend.finals().at(-1)?.text, PROVIDER_FAILURE_TEXT);
    },
  },
  {
    id: 'S31',
    title: 'bot channel join posts onboarding once and ignores non-bot joins',
    config: demoChannelConfig({
      env: { SLACK_FLUE_PUBLIC_URL: 'https://demo.example' },
    }),
    async run(instance) {
      const botJoin = memberJoinedChannel({
        event_id: 'Ev_BOT_JOINED_CHANNEL',
        event: {
          user: 'U_BOT',
          channel: 'C_ENG',
          event_ts: '1782771400.000100',
        },
      });

      const first = await instance.postEvent(botJoin);
      assert.equal(first.status, 200);
      await waitForPostMessageCount(instance, 1);

      const posts = instance.backend.callsOfMethod('chat.postMessage');
      assert.equal(posts.length, 1);
      const onboarding = posts[0];
      assert.ok(onboarding);
      assert.equal(onboarding.body.channel, 'C_ENG');
      assert.equal(onboarding.body.thread_ts, undefined);
      const text = String(onboarding.body.text ?? '');
      assert.match(text, /<@U_BOT>/);
      assert.match(text, /thread and bounded recent context only when asked/i);
      assert.match(text, /no passive monitoring/i);
      assert.match(text, /https:\/\/demo\.example\/admin\?channel=C_ENG/);

      const duplicate = await instance.postEvent(botJoin);
      assert.equal(duplicate.status, 200);
      await instance.quiesce();
      assert.equal(instance.backend.callsOfMethod('chat.postMessage').length, 1);

      instance.backend.reset();
      const nonBot = await instance.postEvent(
        memberJoinedChannel({
          event_id: 'Ev_HUMAN_JOINED_CHANNEL',
          event: {
            user: 'U_ALICE',
            channel: 'C_ENG',
            event_ts: '1782771401.000100',
          },
        }),
      );
      assert.equal(nonBot.status, 200);
      await instance.quiesce();
      assert.equal(instance.backend.wireLog.length, 0);
    },
  },
  {
    id: 'S32',
    title: 'onboarding is fail-closed: bot join in an unassigned channel stays silent',
    // No wildcard in this seed, so an unassigned channel has no resolvable
    // assignment. The bot-join onboarding must obey the same fail-closed gate as
    // every turn: greet only where the bot is actually configured.
    config: {
      env: { SLACK_FLUE_PUBLIC_URL: 'https://demo.example' },
      configSeed: {
        agents: [
          {
            id: 'agent_scoped',
            name: 'Scoped Profile',
            description: 'Assigned to exactly one channel.',
            instructions: 'Reply.',
            enabled: true,
            defaultModels: {
              claude: 'anthropic/parity-claude',
              'workers-ai': '@cf/parity/model',
            },
            allowedTools: [],
          },
        ],
        assignments: [
          {
            workspaceId: 'T_DEMO',
            channelId: 'C_ASSIGNED',
            agentId: 'agent_scoped',
            enabled: true,
          },
        ],
      },
    },
    async run(instance) {
      // Bot joins a channel with no assignment (and no wildcard) — no disclosure.
      await instance.postEvent(
        memberJoinedChannel({
          event_id: 'Ev_JOIN_UNASSIGNED',
          event: { user: 'U_BOT', channel: 'C_UNASSIGNED', event_ts: '1782771500.000100' },
        }),
      );
      await instance.quiesce();
      assert.equal(
        instance.backend.callsOfMethod('chat.postMessage').length,
        0,
        'no onboarding may be posted into an unassigned channel',
      );

      // Bot joins the one assigned channel — exactly one onboarding disclosure.
      await instance.postEvent(
        memberJoinedChannel({
          event_id: 'Ev_JOIN_ASSIGNED',
          event: { user: 'U_BOT', channel: 'C_ASSIGNED', event_ts: '1782771501.000100' },
        }),
      );
      await waitForPostMessageCount(instance, 1);
      assert.equal(instance.backend.callsOfMethod('chat.postMessage').length, 1);
    },
  },
  {
    id: 'S33',
    title: 'SLACK_FLUE_ALLOW_DMS=false silences DMs but leaves channels working',
    config: demoChannelConfig({
      env: { SLACK_FLUE_ALLOW_DMS: 'false' },
    }),
    async run(instance) {
      // Direct messages are turned off org-wide → no reply, nothing on the wire.
      await instance.postEvent(dmMessage());
      await instance.quiesce();
      assert.equal(
        instance.backend.finals().length,
        0,
        'a DM must stay silent when direct messages are disabled',
      );
      assert.equal(instance.backend.wireLog.length, 0);

      // An assigned channel still replies — the toggle is DM-only.
      await instance.postEvent(appMention());
      await instance.quiesce();
      assert.equal(
        instance.backend.finals().length,
        1,
        'channels are unaffected by the direct-message toggle',
      );
    },
  },
  {
    id: 'S34',
    title: 'started thread keeps its initial instructions after an admin edit',
    config: snapshotScenarioConfig('agent_snapshot_freeze'),
    async run(instance) {
      await instance.postEvent(
        appMention({
          event_id: 'Ev_S34_T1',
          event: {
            text: '<@U_BOT> start with the original snapshot instructions',
            ts: '1782771600.000100',
            event_ts: '1782771600.000100',
          },
        }),
      );
      await waitForProviderCallCount(instance, 1);
      assertProviderPrompt(instance, -1, {
        includes: 'SNAPSHOT_ALPHA_INSTRUCTIONS',
        excludes: 'SNAPSHOT_BETA_INSTRUCTIONS',
      });

      await patchAgent(instance, 'agent_snapshot_freeze', {
        instructions: 'SNAPSHOT_BETA_INSTRUCTIONS: edited profile instructions.',
      });

      await instance.postEvent(
        channelThreadMessage({
          event_id: 'Ev_S34_T2',
          event: {
            text: 'continue in the same thread after the admin edit',
            ts: '1782771601.000100',
            event_ts: '1782771601.000100',
            thread_ts: '1782771600.000100',
          },
        }),
      );
      await waitForProviderCallCount(instance, 2);
      assertProviderPrompt(instance, -1, {
        includes: 'SNAPSHOT_ALPHA_INSTRUCTIONS',
        excludes: 'SNAPSHOT_BETA_INSTRUCTIONS',
      });
    },
  },
  {
    id: 'S35',
    title: 'new thread picks up the edited instructions',
    config: snapshotScenarioConfig('agent_snapshot_new_thread'),
    async run(instance) {
      await instance.postEvent(
        appMention({
          event_id: 'Ev_S35_T1',
          event: {
            text: '<@U_BOT> start before the admin edit',
            ts: '1782771700.000100',
            event_ts: '1782771700.000100',
          },
        }),
      );
      await waitForProviderCallCount(instance, 1);

      await patchAgent(instance, 'agent_snapshot_new_thread', {
        instructions: 'SNAPSHOT_BETA_INSTRUCTIONS: edited profile instructions.',
      });

      await instance.postEvent(
        appMention({
          event_id: 'Ev_S35_T2_NEW_THREAD',
          event: {
            text: '<@U_BOT> start a separate thread after the admin edit',
            ts: '1782771701.000100',
            event_ts: '1782771701.000100',
          },
        }),
      );
      await waitForProviderCallCount(instance, 2);
      assertProviderPrompt(instance, -1, {
        includes: 'SNAPSHOT_BETA_INSTRUCTIONS',
        excludes: 'SNAPSHOT_ALPHA_INSTRUCTIONS',
      });
    },
  },
  {
    id: 'S36',
    title: 'started thread keeps running after its profile is disabled',
    config: snapshotScenarioConfig('agent_snapshot_disable'),
    async run(instance) {
      await instance.postEvent(
        appMention({
          event_id: 'Ev_S36_T1',
          event: {
            text: '<@U_BOT> start before the profile is disabled',
            ts: '1782771800.000100',
            event_ts: '1782771800.000100',
          },
        }),
      );
      await waitForProviderCallCount(instance, 1);

      await patchAgent(instance, 'agent_snapshot_disable', { enabled: false });

      await instance.postEvent(
        channelThreadMessage({
          event_id: 'Ev_S36_T2',
          event: {
            text: 'continue after the profile was disabled',
            ts: '1782771801.000100',
            event_ts: '1782771801.000100',
            thread_ts: '1782771800.000100',
          },
        }),
      );
      await waitForProviderCallCount(instance, 2);
      assertProviderPrompt(instance, -1, {
        includes: 'SNAPSHOT_ALPHA_INSTRUCTIONS',
        excludes: 'SNAPSHOT_BETA_INSTRUCTIONS',
      });
    },
  },
  {
    id: 'S37',
    title: 'a DM tracks current config — an edit reaches the same DM user (DMs are not frozen)',
    // A DM is one continuous session (constant ':dm' key), not a discrete thread,
    // so it must NOT freeze: an edit to the DM profile must reach existing DM
    // users on their next message. (Freezing would make the edit unreachable
    // forever, since a DM never starts a "new thread".)
    config: {
      configSeed: {
        agents: [
          {
            id: 'agent_dm_snapshot',
            name: 'DM Profile',
            description: 'Exercises DM config tracking.',
            instructions: 'SNAPSHOT_ALPHA_INSTRUCTIONS: original DM instructions.',
            enabled: true,
            model: 'local-stub/snapshot-profile',
            defaultModels: {
              claude: 'anthropic/snapshot-claude',
              'workers-ai': '@cf/snapshot/model',
            },
            allowedTools: [],
          },
        ],
        // The '*,*' direct-message default answers DMs.
        assignments: [{ workspaceId: '*', channelId: '*', agentId: 'agent_dm_snapshot', enabled: true }],
      },
    },
    async run(instance) {
      await instance.postEvent(
        dmMessage({
          event_id: 'Ev_S37_T1',
          event: { ts: '1782771700.000100', event_ts: '1782771700.000100' },
        }),
      );
      await waitForProviderCallCount(instance, 1);
      assertProviderPrompt(instance, -1, {
        includes: 'SNAPSHOT_ALPHA_INSTRUCTIONS',
        excludes: 'SNAPSHOT_BETA_INSTRUCTIONS',
      });

      await patchAgent(instance, 'agent_dm_snapshot', {
        instructions: 'SNAPSHOT_BETA_INSTRUCTIONS: edited DM instructions.',
      });

      await instance.postEvent(
        dmMessage({
          event_id: 'Ev_S37_T2',
          event: { ts: '1782771701.000100', event_ts: '1782771701.000100' },
        }),
      );
      await waitForProviderCallCount(instance, 2);
      assertProviderPrompt(instance, -1, {
        includes: 'SNAPSHOT_BETA_INSTRUCTIONS',
        excludes: 'SNAPSHOT_ALPHA_INSTRUCTIONS',
      });
    },
  },
];

function snapshotScenarioConfig(agentId: string): ScenarioLaneConfig {
  return {
    configSeed: {
      agents: [
        {
          id: agentId,
          name: 'Snapshot Profile',
          description: 'Exercises thread config snapshots.',
          instructions: 'SNAPSHOT_ALPHA_INSTRUCTIONS: original profile instructions.',
          enabled: true,
          model: 'local-stub/snapshot-profile',
          defaultModels: {
            claude: 'anthropic/snapshot-claude',
            'workers-ai': '@cf/snapshot/model',
          },
          allowedTools: [],
        },
      ],
      assignments: [
        {
          workspaceId: 'T_DEMO',
          channelId: EXEC_CHANNEL,
          agentId,
          enabled: true,
        },
      ],
    },
  };
}

async function patchAgent(
  instance: LaneInstance,
  agentId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const response = await instance.adminRequest(`/admin/api/agents/${agentId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

function assertProviderPrompt(
  instance: LaneInstance,
  index: number,
  expected: { includes: string; excludes: string },
): void {
  const call = instance.backend.providerCalls().at(index);
  assert.ok(call, `expected provider call at index ${index}`);
  const body = JSON.stringify(call.body);
  assert.match(body, new RegExp(escapeRegExp(expected.includes)));
  assert.doesNotMatch(body, new RegExp(escapeRegExp(expected.excludes)));
}

async function waitForProviderCallCount(
  instance: LaneInstance,
  expected: number,
  capMs = 20_000,
): Promise<void> {
  await waitForWireCondition(
    () => instance.backend.providerCalls().length >= expected,
    `expected at least ${expected} provider calls`,
    capMs,
  );
}

async function waitForFinalCount(
  instance: LaneInstance,
  expected: number,
  capMs = 20_000,
): Promise<void> {
  await waitForWireCondition(
    () => instance.backend.finals().length >= expected,
    `expected at least ${expected} finals`,
    capMs,
  );
}

async function waitForPostMessageCount(
  instance: LaneInstance,
  expected: number,
  capMs = 20_000,
): Promise<void> {
  await waitForWireCondition(
    () => instance.backend.callsOfMethod('chat.postMessage').length >= expected,
    `expected at least ${expected} chat.postMessage calls`,
    capMs,
  );
}

async function waitForWireCondition(
  predicate: () => boolean,
  description: string,
  capMs: number,
): Promise<void> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(description);
}

function assertFooterBlock(
  blocks: unknown,
  expected: { profileName: string; modelLabel: string; configureUrl: string },
): void {
  assert.ok(Array.isArray(blocks), 'expected Slack blocks on the final delivery');
  const footerText = blocks
    .flatMap((block) =>
      block && typeof block === 'object' && (block as { type?: unknown }).type === 'context'
        ? ((block as { elements?: unknown[] }).elements ?? [])
        : [],
    )
    .map((element) =>
      element && typeof element === 'object' ? String((element as { text?: unknown }).text ?? '') : '',
    )
    .join('\n');

  assert.match(footerText, new RegExp(escapeRegExp(expected.profileName)));
  assert.match(footerText, new RegExp(escapeRegExp(expected.modelLabel)));
  assert.match(footerText, new RegExp(`<${escapeRegExp(expected.configureUrl)}\\|Configure>`));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Register the scenario suite as `node:test` tests for a lane.
 *
 * `exceptions` is additive (default `[]` preserves the original behavior). An
 * entry whose `scenarioId` + `lane` match is honored per its `behavior`:
 * `expected-fail` scenarios still RUN, an assertion failure passes the test
 * with a printed `EXCEPTION` note, and an unexpected PASS fails the test as a
 * stale exception.
 */
export function runScenarioSuite(
  lane: Lane,
  exceptions: ParityException[] = [],
  options: { skip?: string | boolean | undefined } = {},
): void {
  for (const scenario of scenarios) {
    const exception = exceptions.find(
      (entry) => entry.scenarioId === scenario.id && entry.lane === lane.name,
    );
    test(`${lane.name} · ${scenario.id} ${scenario.title}`, { skip: options.skip }, async () => {
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
