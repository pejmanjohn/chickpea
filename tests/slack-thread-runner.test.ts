import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  createDemoEnvironment,
  handleSlackAppMention,
  type SlackEventFixture,
} from '../src/runtime/slack-thread-runner.ts';
import {
  createSlackPresentationEvent,
  LocalSlackReplySink,
  slackLoadingMessages,
  slackStatusText,
  type SlackFinalDelivery,
  type SlackPresentationContext,
  type SlackPresentationEvent,
  type SlackPresentationStage,
  type SlackReplyKind,
  type SlackReplyPost,
  type SlackReplySink,
} from '../src/slack/replies.ts';
import type { SlackAppMentionEvent } from '../src/slack/types.ts';
import { ToolDeniedError, runAllowedTool } from '../src/tools/safe-tools.ts';

type AppMentionFixture = SlackEventFixture & { event: SlackAppMentionEvent };
type AppMentionFixtureOverrides = Omit<Partial<SlackEventFixture>, 'event'> & {
  event?: Partial<SlackAppMentionEvent>;
};

function fixture(overrides: AppMentionFixtureOverrides = {}): AppMentionFixture {
  const base = JSON.parse(
    readFileSync(new URL('../fixtures/slack/app-mention.json', import.meta.url), 'utf8'),
  ) as AppMentionFixture;

  return {
    ...base,
    ...overrides,
    event: {
      ...base.event,
      ...overrides.event,
      type: 'app_mention',
    },
  };
}

test('app_mention resolves workspace and channel to a configured custom agent session', async () => {
  const replies = new LocalSlackReplySink();
  const env = createDemoEnvironment({ replies });

  const result = await handleSlackAppMention(fixture(), env, { providerId: 'claude' });

  assert.equal(result.status, 'handled');
  assert.equal(result.assignment.agentId, 'agent_exec_research');
  assert.equal(result.session.isNew, true);
  assert.equal(result.session.threadKey, 'T_DEMO:C_EXEC:1782770400.000100');
  assert.equal(result.session.snapshot.agent.name, 'Exec Research');
  assert.equal(result.session.turnCount, 1);
  assert.equal(env.replies.posts.length, 1);
  assert.equal(env.replies.posts[0]?.kind, 'final');
  assert.match(env.replies.posts[0]?.text ?? '', /Exec Research/);
  assert.equal(replies.presentationEvents[0]?.kind, 'status_set');
  assert.equal(replies.presentationEvents[0]?.text, 'is checking context');
  assert.equal(
    replies.presentationEvents.some(
      (event) =>
        event.kind === 'status_set' &&
        event.text === 'is gathering channel context' &&
        event.loadingMessages?.includes('Gathering channel context'),
    ),
    true,
  );
  assert.equal(replies.presentationEvents.at(-1)?.kind, 'status_cleared');
  assert.equal(result.telemetry.firstVisibleResponseKind, 'slack_status');
  assert.equal(result.telemetry.deliveryMode, 'stream');
  assert.equal(typeof result.telemetry.timeToFirstVisibleResponseMs, 'number');
});

test('duplicate Slack event ids are acknowledged without posting or calling a provider twice', async () => {
  const env = createDemoEnvironment();
  const incoming = fixture();

  const first = await handleSlackAppMention(incoming, env, { providerId: 'claude' });
  const second = await handleSlackAppMention(incoming, env, { providerId: 'claude' });

  assert.equal(first.status, 'handled');
  assert.equal(second.status, 'duplicate');
  assert.equal(env.replies.posts.length, 1);
  assert.equal(env.telemetry.modelCalls.length, 1);
});

test('completed duplicate Slack event ids return that event reply instead of the latest global reply', async () => {
  const env = createDemoEnvironment();
  const firstIncoming = fixture();
  const secondIncoming = fixture({ event_id: 'Ev_DEMO_002' });

  const first = await handleSlackAppMention(firstIncoming, env, { providerId: 'claude' });
  const second = await handleSlackAppMention(secondIncoming, env, { providerId: 'claude' });
  const duplicateFirst = await handleSlackAppMention(firstIncoming, env, { providerId: 'claude' });

  assert.equal(first.status, 'handled');
  assert.equal(second.status, 'handled');
  assert.equal(duplicateFirst.status, 'duplicate');
  assert.equal(duplicateFirst.finalReply.text, first.finalReply.text);
  assert.notEqual(duplicateFirst.finalReply.text, second.finalReply.text);
  assert.equal(env.replies.posts.length, 2);
  assert.equal(env.telemetry.modelCalls.length, 2);
});

test('in-flight duplicate Slack event ids do not create permanent duplicate text', async () => {
  const env = createDemoEnvironment();
  const incoming = fixture();

  const firstPromise = handleSlackAppMention(incoming, env, { providerId: 'claude' });
  const duplicate = await handleSlackAppMention(incoming, env, { providerId: 'claude' });
  const first = await firstPromise;

  assert.equal(first.status, 'handled');
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.finalReply.text, 'Duplicate event acknowledged.');
  assert.equal(env.replies.posts.length, 1);
  assert.equal(env.replies.posts[0]?.text, first.finalReply.text);
  assert.equal(env.telemetry.modelCalls.length, 1);
});

test('status rejection falls back to a durable progress post and skips repeated status calls', async () => {
  const replies = new RejectingStatusSink();
  const env = createDemoEnvironment({ replies });

  const result = await handleSlackAppMention(fixture(), env, { providerId: 'claude' });

  assert.equal(result.status, 'handled');
  assert.equal(result.telemetry.firstVisibleResponseKind, 'slack_progress');
  assert.deepEqual(
    replies.posts.map((post) => post.kind),
    ['progress', 'final'],
  );
  assert.deepEqual(replies.statusAttempts, ['checking_context']);
  assert.equal(replies.clearAttempts, 0);
  assert.deepEqual(result.telemetry.degradations, [
    'assistant.threads.setStatus:missing_scope',
  ]);
});

test('delivery failure after provider success releases dedupe for retry without provider-failed status', async () => {
  const replies = new FlakyFinalDeliverySink();
  const env = createDemoEnvironment({ replies });
  const incoming = fixture({ event_id: 'Ev_DELIVERY_FAIL' });

  await assert.rejects(
    () => handleSlackAppMention(incoming, env, { providerId: 'claude' }),
    /delivery_unavailable/,
  );
  assert.equal(
    replies.presentationEvents.some((event) => event.text === 'hit a provider error'),
    false,
  );

  const retry = await handleSlackAppMention(incoming, env, { providerId: 'claude' });

  assert.equal(retry.status, 'handled');
  assert.equal(retry.session.turnCount, 1);
  assert.match(retry.finalReply.text, /Exec Research handled turn 1/);
  assert.equal(replies.deliveryAttempts, 2);
});

test('safe tools run only when explicitly allowed by the agent policy', async () => {
  const env = createDemoEnvironment();
  const agent = env.agentStore.getAgent('agent_exec_research');

  const allowed = await runAllowedTool(agent, 'lookup_channel_brief', {
    channelId: 'C_EXEC',
  });

  assert.equal(allowed.toolName, 'lookup_channel_brief');
  assert.match(allowed.content, /exec leadership/);

  await assert.rejects(
    () => runAllowedTool(agent, 'lookup_customer_email', { customerId: 'cus_123' }),
    (error) =>
      error instanceof ToolDeniedError &&
      error.message === 'Tool lookup_customer_email is not allowed for agent agent_exec_research',
  );
});

test('the same Slack fixture can run through Claude and non-Claude provider lanes', async () => {
  const claudeEnv = createDemoEnvironment();
  const workersEnv = createDemoEnvironment();

  const claude = await handleSlackAppMention(fixture(), claudeEnv, { providerId: 'claude' });
  const workers = await handleSlackAppMention(
    fixture({ event_id: 'Ev_DEMO_002' }),
    workersEnv,
    { providerId: 'workers-ai' },
  );

  assert.equal(claude.status, 'handled');
  assert.equal(workers.status, 'handled');
  assert.equal(claude.provider.providerId, 'claude');
  assert.equal(claude.provider.model, 'anthropic/claude-sonnet-4-6');
  assert.equal(workers.provider.providerId, 'workers-ai');
  assert.equal(workers.provider.model, '@cf/zai-org/glm-5.2');
  assert.match(workers.finalReply.text, /non-Claude/);
});

test('thread replies continue the same session snapshot', async () => {
  const env = createDemoEnvironment();
  const original = fixture();
  const reply = fixture({
    event_id: 'Ev_DEMO_003',
    event: {
      ...original.event,
      text: '<@U_BOT> continue from the prior answer',
      ts: '1782770410.000200',
      event_ts: '1782770410.000200',
      thread_ts: original.event.ts,
    },
  });

  const first = await handleSlackAppMention(original, env, { providerId: 'claude' });
  const second = await handleSlackAppMention(reply, env, { providerId: 'claude' });

  assert.equal(first.status, 'handled');
  assert.equal(second.status, 'handled');
  assert.equal(second.session.isNew, false);
  assert.equal(second.session.id, first.session.id);
  assert.equal(second.session.snapshot.snapshotHash, first.session.snapshot.snapshotHash);
  assert.equal(second.session.turnCount, 2);
  assert.equal(env.replies.posts.length, 2);
});

test('provider failures emit a sanitized final reply and clear visible working state', async () => {
  const replies = new LocalSlackReplySink();
  const env = createDemoEnvironment({ replies });
  const provider = env.providers.get('claude');
  provider.generate = async () => {
    throw new Error('token_like_marker raw provider stack');
  };

  const result = await handleSlackAppMention(fixture(), env, { providerId: 'claude' });

  assert.equal(result.status, 'handled');
  assert.match(result.finalReply.text, /model provider call failed before completion/);
  assert.doesNotMatch(result.finalReply.text, /token_like_marker/);
  assert.equal(
    replies.presentationEvents.some(
      (event) =>
        event.kind === 'status_set' &&
        event.text === 'hit a provider error' &&
        event.loadingMessages?.includes('Provider call failed'),
    ),
    true,
  );
  assert.equal(replies.presentationEvents.at(-1)?.kind, 'status_cleared');
});

test('Paperplane Labs playtest channel uses exact assignment and channel brief', async () => {
  const env = createDemoEnvironment();

  const result = await handleSlackAppMention(
    fixture({
      team_id: 'T0AJZ12JALU',
      event_id: 'Ev_PAPERPLANE_001',
      event: {
        ...fixture().event,
        channel: 'C0AJVCUNL4A',
        text: '<@U_BOT> channel context smoke test from Codex',
      },
    }),
    env,
    { providerId: 'workers-ai' },
  );

  assert.equal(result.status, 'handled');
  assert.equal(result.assignment.workspaceId, 'T0AJZ12JALU');
  assert.equal(result.assignment.channelId, 'C0AJVCUNL4A');
  assert.equal(result.assignment.agentId, 'agent_exec_research');
  assert.match(result.finalReply.text, /Paperplane Labs #all-paperplane-labs/);
  assert.match(result.finalReply.text, /non-Claude Cloudflare Workers AI lane/);
});

test('unconfigured Slack channels fall back to the demo assignment for playtesting', async () => {
  const env = createDemoEnvironment();

  const result = await handleSlackAppMention(
    fixture({
      team_id: 'T_REAL_PLAYTEST',
      event_id: 'Ev_REAL_001',
      event: {
        ...fixture().event,
        channel: 'C_REAL_PLAYTEST',
      },
    }),
    env,
    { providerId: 'workers-ai' },
  );

  assert.equal(result.status, 'handled');
  assert.equal(result.assignment.agentId, 'agent_exec_research');
  assert.equal(result.session.threadKey, 'T_REAL_PLAYTEST:C_REAL_PLAYTEST:1782770400.000100');
});

class RejectingStatusSink implements SlackReplySink {
  readonly posts: SlackReplyPost[] = [];
  readonly statusAttempts: SlackPresentationStage[] = [];
  clearAttempts = 0;

  post(kind: SlackReplyKind, post: Omit<SlackReplyPost, 'kind'>): SlackReplyPost {
    const saved = { kind, ...post };
    this.posts.push(saved);
    return saved;
  }

  setStatus(context: SlackPresentationContext, stage: SlackPresentationStage): SlackPresentationEvent {
    this.statusAttempts.push(stage);
    return createSlackPresentationEvent(context, 'status_set', {
      ok: false,
      text: slackStatusText(stage),
      loadingMessages: slackLoadingMessages(stage),
      error: 'missing_scope',
    });
  }

  clearStatus(context: SlackPresentationContext): SlackPresentationEvent {
    this.clearAttempts += 1;
    return createSlackPresentationEvent(context, 'status_cleared', {
      ok: false,
      text: '',
      error: 'missing_scope',
    });
  }
}

class FlakyFinalDeliverySink extends LocalSlackReplySink {
  deliveryAttempts = 0;

  deliverFinal(context: SlackPresentationContext, text: string): SlackFinalDelivery {
    this.deliveryAttempts += 1;
    if (this.deliveryAttempts === 1) {
      throw new Error('delivery_unavailable');
    }
    return super.deliverFinal(context, text);
  }
}
