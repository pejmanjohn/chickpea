import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createDemoEnvironment,
  handleSlackAppMention,
  handleSlackTurn,
} from '../src/runtime/slack-thread-runner.ts';
import type { ProviderRegistry } from '../src/providers/deterministic.ts';
import { renderSlackMessage } from '../src/slack/message-format.ts';
import {
  createSlackPresentationEvent,
  defaultSlackReplyFormat,
  LocalSlackReplySink,
  slackLoadingMessages,
  slackStatusText,
  type SlackFinalDelivery,
  type SlackPresentationContext,
  type SlackPresentationEvent,
  type SlackPresentationStage,
  type SlackReplyInput,
  type SlackReplyKind,
  type SlackReplyPost,
  type SlackReplySink,
} from '../src/slack/replies.ts';
import {
  computeChannelHistoryWindow,
  type SlackContextClient,
  type SlackTurnContext,
} from '../src/slack/thread-context.ts';
import { slackThreadKey } from '../src/slack/thread-key.ts';
import { normalizeSlackTurn } from '../src/slack/turn-normalization.ts';
import { ToolDeniedError, runAllowedTool } from '../src/tools/safe-tools.ts';
import {
  appHomeMessage,
  appMention as fixture,
  channelThreadMessage,
  dmMessage,
  topLevelChannelMessage,
} from './helpers/slack-fixtures.ts';

test('Slack turn normalization classifies mentions, thread replies, DMs, and ignored top-level messages', () => {
  const mention = normalizeSlackTurn(fixture());
  assert.ok(mention.status === 'runnable');
  assert.equal(mention.turn.source, 'app_mention');
  assert.equal(mention.turn.contextMode, 'channel_history');
  assert.equal(slackThreadKey(mention.turn), 'T_DEMO:C_EXEC:1782770400.000100');

  const options = { botUserId: 'U_BOT' };
  const threadReply = normalizeSlackTurn(channelThreadMessage(), options);
  assert.ok(threadReply.status === 'runnable');
  assert.equal(threadReply.turn.source, 'implicit_thread_reply');
  assert.equal(threadReply.turn.contextMode, 'thread');
  assert.equal(slackThreadKey(threadReply.turn), 'T_DEMO:C_EXEC:1782770400.000100');

  const dm = normalizeSlackTurn(dmMessage(), options);
  assert.ok(dm.status === 'runnable');
  assert.equal(dm.turn.source, 'dm_message');
  assert.equal(dm.turn.contextMode, 'dm_history');
  assert.equal(slackThreadKey(dm.turn), 'T_DEMO:D_DEMO_DM:dm');

  const appHome = normalizeSlackTurn(appHomeMessage(), options);
  assert.ok(appHome.status === 'runnable');
  assert.equal(appHome.turn.source, 'dm_message');
  assert.equal(appHome.turn.channelType, 'app_home');
  assert.equal(appHome.turn.contextMode, 'dm_history');
  assert.equal(slackThreadKey(appHome.turn), 'T_DEMO:D_DEMO_APP_HOME:dm');

  const topLevel = normalizeSlackTurn(topLevelChannelMessage(), options);
  assert.ok(topLevel.status === 'ignored');
  assert.equal(topLevel.reason, 'top_level_channel_message');

  const missingBotUserId = normalizeSlackTurn(channelThreadMessage());
  assert.ok(missingBotUserId.status === 'ignored');
  assert.equal(missingBotUserId.reason, 'missing_bot_user_id');

  const missingChannelType = channelThreadMessage({ event_id: 'Ev_MSG_NO_CHANNEL_TYPE' });
  delete missingChannelType.event.channel_type;
  const unsupportedChannelType = normalizeSlackTurn(missingChannelType, options);
  assert.ok(unsupportedChannelType.status === 'ignored');
  assert.equal(unsupportedChannelType.reason, 'unsupported_channel_type');
});

test('natural-language channel history windows do not match adjacent words', () => {
  assert.equal(
    computeChannelHistoryWindow('what happened last weekend?', '1782770400.000100').reason,
    'default_24h',
  );
  assert.equal(
    computeChannelHistoryWindow('plans for this weekend', '1782770400.000100').reason,
    'default_24h',
  );
  assert.equal(
    computeChannelHistoryWindow('todays numbers', '1782770400.000100').reason,
    'default_24h',
  );
  assert.equal(
    computeChannelHistoryWindow('what happened last week?', '1782770400.000100').reason,
    'last_week',
  );
});

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
  assert.equal(env.replies.posts[0]?.format, 'markdown');
  assert.equal(env.replies.posts[0]?.rendered.blocks?.[0]?.type, 'markdown');
  assert.match(env.replies.posts[0]?.rendered.blocks?.[0]?.text ?? '', /^\*\*Exec Research\*\*/);
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
  assert.equal(duplicate.finalReply.format, 'plain_text');
  assert.equal(duplicate.finalReply.rendered.mrkdwn, false);
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
  assert.equal(replies.posts[0]?.format, 'plain_text');
  assert.equal(replies.posts[1]?.format, 'markdown');
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
  assert.match(retry.finalReply.text, /\*\*Exec Research\*\* handled turn 1/);
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

test('plain channel thread replies run only when a process-local session already exists', async () => {
  const env = createDemoEnvironment({ botUserId: 'U_BOT' });

  const first = await handleSlackAppMention(fixture(), env, { providerId: 'claude' });
  const second = await handleSlackTurn(channelThreadMessage(), env, { providerId: 'workers-ai' });

  assert.equal(first.status, 'handled');
  assert.ok(second.status === 'handled');
  assert.equal(second.session.id, first.session.id);
  assert.equal(second.session.isNew, false);
  assert.equal(second.session.snapshot.providerId, 'claude');
  assert.equal(second.provider.providerId, 'claude');
  assert.equal(second.session.turnCount, 2);
  assert.equal(env.replies.posts.length, 2);

  const unknownEnv = createDemoEnvironment({ botUserId: 'U_BOT' });
  const ignored = await handleSlackTurn(channelThreadMessage(), unknownEnv, {
    providerId: 'claude',
  });

  assert.deepEqual(ignored, {
    status: 'ignored',
    reason: 'unknown_thread',
    eventId: 'Ev_MSG_THREAD_001',
  });
  assert.equal(unknownEnv.replies.posts.length, 0);
  assert.equal(unknownEnv.telemetry.modelCalls.length, 0);
});

test('direct messages create and continue sessions without mention syntax', async () => {
  const env = createDemoEnvironment({ botUserId: 'U_BOT' });
  const root = dmMessage();
  const reply = dmMessage({
    event_id: 'Ev_MSG_DM_002',
    event: {
      ts: '1782770430.000400',
      event_ts: '1782770430.000400',
      text: 'continue the DM conversation',
    },
  });

  const first = await handleSlackTurn(root, env, { providerId: 'workers-ai' });
  const second = await handleSlackTurn(reply, env, { providerId: 'workers-ai' });

  assert.ok(first.status === 'handled');
  assert.equal(first.assignment.agentId, 'agent_exec_research');
  assert.equal(first.session.threadKey, 'T_DEMO:D_DEMO_DM:dm');
  assert.equal(first.session.isNew, true);
  assert.ok(second.status === 'handled');
  assert.equal(second.session.id, first.session.id);
  assert.equal(second.session.turnCount, 2);
  assert.equal(env.replies.posts.length, 2);
});

test('dedupe applies to implicit thread replies and DMs', async () => {
  const env = createDemoEnvironment({ botUserId: 'U_BOT' });

  await handleSlackAppMention(fixture(), env, { providerId: 'claude' });
  const implicitFirst = await handleSlackTurn(channelThreadMessage(), env, { providerId: 'claude' });
  const implicitDuplicate = await handleSlackTurn(channelThreadMessage(), env, {
    providerId: 'claude',
  });

  assert.ok(implicitFirst.status === 'handled');
  assert.ok(implicitDuplicate.status === 'duplicate');
  assert.equal(env.replies.posts.length, 2);
  assert.equal(env.telemetry.modelCalls.length, 2);

  const dmEnv = createDemoEnvironment({ botUserId: 'U_BOT' });
  const dmFirst = await handleSlackTurn(dmMessage(), dmEnv, { providerId: 'workers-ai' });
  const dmDuplicate = await handleSlackTurn(dmMessage(), dmEnv, { providerId: 'workers-ai' });

  assert.ok(dmFirst.status === 'handled');
  assert.ok(dmDuplicate.status === 'duplicate');
  assert.equal(dmEnv.replies.posts.length, 1);
  assert.equal(dmEnv.telemetry.modelCalls.length, 1);
});

test('Slack context read failures degrade to current-message context without blocking final replies', async () => {
  const env = createDemoEnvironment({ slackContext: new ThrowingSlackContextClient() });

  const result = await handleSlackAppMention(fixture(), env, { providerId: 'claude' });

  assert.equal(result.status, 'handled');
  assert.match(result.finalReply.text, /Slack context \(default_24h\)/);
  assert.match(result.finalReply.text, /please use channel context/);
  assert.deepEqual(result.telemetry.degradations, [
    'slack_context.channel_history:missing_scope',
  ]);
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
  assert.equal(result.finalReply.format, 'plain_text');
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

test('provider-authored standard Markdown reaches the local Slack adapter as a markdown block', async () => {
  const markdown = [
    '# Formatting smoke',
    '',
    '**Bold** and _italic_ with `inline code`.',
    '',
    '- Bullet one',
    '- Bullet two',
    '',
    '> Blockquote',
    '',
    '[Slack docs](https://docs.slack.dev/)',
    '',
    '```json',
    '{"ok":true}',
    '```',
    '',
    '| Feature | Status |',
    '|---|---|',
    '| markdown block | covered |',
  ].join('\n');
  const providers = {
    get: () => ({
      providerId: 'workers-ai',
      model: 'formatting-test-model',
      generate: async () => ({
        providerId: 'workers-ai',
        model: 'formatting-test-model',
        text: markdown,
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 1,
      }),
    }),
  } as unknown as ProviderRegistry;
  const env = createDemoEnvironment({ providers });

  await handleSlackAppMention(fixture({ event_id: 'Ev_FORMATTING_001' }), env, {
    providerId: 'workers-ai',
  });

  const finalPost = env.replies.posts.at(-1);
  assert.equal(finalPost?.format, 'markdown');
  assert.deepEqual(finalPost?.rendered.blocks, [{ type: 'markdown', text: markdown }]);
  assert.match(finalPost?.rendered.text ?? '', /Formatting smoke/);
  assert.doesNotMatch(finalPost?.rendered.text ?? '', /\*\*Bold\*\*/);
});

test('configured demo channel uses exact assignment and channel brief', async () => {
  const env = createDemoEnvironment();

  const result = await handleSlackAppMention(
    fixture({
      event_id: 'Ev_DEMO_ASSIGNMENT_001',
      event: {
        ...fixture().event,
        text: '<@U_BOT> channel context smoke test from Codex',
      },
    }),
    env,
    { providerId: 'workers-ai' },
  );

  assert.equal(result.status, 'handled');
  assert.equal(result.assignment.workspaceId, 'T_DEMO');
  assert.equal(result.assignment.channelId, 'C_EXEC');
  assert.equal(result.assignment.agentId, 'agent_exec_research');
  assert.match(result.finalReply.text, /exec leadership channel/);
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

  post(kind: SlackReplyKind, post: SlackReplyInput): SlackReplyPost {
    const format = post.format ?? defaultSlackReplyFormat(kind);
    const saved: SlackReplyPost = {
      kind,
      ...post,
      format,
      rendered: renderSlackMessage(post.text, format),
    };
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

  deliverFinal(
    context: SlackPresentationContext,
    text: string,
    format?: SlackReplyInput['format'],
  ): SlackFinalDelivery {
    this.deliveryAttempts += 1;
    if (this.deliveryAttempts === 1) {
      throw new Error('delivery_unavailable');
    }
    return super.deliverFinal(context, text, format);
  }
}

class ThrowingSlackContextClient implements SlackContextClient {
  async hydrate(): Promise<SlackTurnContext> {
    throw new Error('missing_scope');
  }
}
