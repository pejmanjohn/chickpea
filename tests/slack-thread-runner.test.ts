import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  createDemoEnvironment,
  handleSlackAppMention,
  type SlackEventFixture,
} from '../src/runtime/slack-thread-runner.ts';
import type { ProviderRegistry } from '../src/providers/deterministic.ts';
import { ToolDeniedError, runAllowedTool } from '../src/tools/safe-tools.ts';

function fixture(overrides: Partial<SlackEventFixture> = {}): SlackEventFixture {
  const base = JSON.parse(
    readFileSync(new URL('../fixtures/slack/app-mention.json', import.meta.url), 'utf8'),
  ) as SlackEventFixture;

  return {
    ...base,
    ...overrides,
    event: {
      ...base.event,
      ...overrides.event,
    },
  };
}

test('app_mention resolves workspace and channel to a configured custom agent session', async () => {
  const env = createDemoEnvironment();

  const result = await handleSlackAppMention(fixture(), env, { providerId: 'claude' });

  assert.equal(result.status, 'handled');
  assert.equal(result.assignment.agentId, 'agent_exec_research');
  assert.equal(result.session.isNew, true);
  assert.equal(result.session.threadKey, 'T_DEMO:C_EXEC:1782770400.000100');
  assert.equal(result.session.snapshot.agent.name, 'Exec Research');
  assert.equal(result.session.turnCount, 1);
  assert.equal(env.replies.posts.length, 2);
  assert.equal(env.replies.posts[0]?.kind, 'progress');
  assert.equal(env.replies.posts[0]?.threadTs, '1782770400.000100');
  assert.equal(env.replies.posts[0]?.format, 'plain_text');
  assert.equal(env.replies.posts[0]?.rendered.mrkdwn, false);
  assert.match(env.replies.posts[1]?.text ?? '', /Exec Research/);
  assert.equal(env.replies.posts[1]?.format, 'markdown');
  assert.equal(env.replies.posts[1]?.rendered.blocks?.[0]?.type, 'markdown');
  assert.match(env.replies.posts[1]?.rendered.blocks?.[0]?.text ?? '', /^\*\*Exec Research\*\*/);
  assert.equal(result.telemetry.firstVisibleResponseKind, 'slack_progress');
  assert.equal(typeof result.telemetry.timeToFirstVisibleResponseMs, 'number');
});

test('duplicate Slack event ids are acknowledged without posting or calling a provider twice', async () => {
  const env = createDemoEnvironment();
  const incoming = fixture();

  const first = await handleSlackAppMention(incoming, env, { providerId: 'claude' });
  const second = await handleSlackAppMention(incoming, env, { providerId: 'claude' });

  assert.equal(first.status, 'handled');
  assert.equal(second.status, 'duplicate');
  assert.equal(env.replies.posts.length, 2);
  assert.equal(env.telemetry.modelCalls.length, 1);
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
  assert.equal(env.replies.posts.length, 4);
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
