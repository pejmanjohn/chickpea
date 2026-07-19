import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appendSlackReplyFooter,
  buildSlackAdminUrl,
  renderChannelOnboarding,
  renderSlackReplyFooterBlock,
  renderUnassignedChannelHint,
  markdownFallbackText,
  renderSlackMessage,
  slackMarkdownBlockTextLimit,
} from '../src/slack/message-format.ts';
import {
  slackLoadingMessages,
  slackStatusText,
  toolStatus,
} from '../src/slack/replies.ts';

test('standard Markdown final replies render as Slack markdown blocks', () => {
  const markdown = [
    '# Incident Summary',
    '',
    '**Bold lead** with _italic detail_ and ~~obsolete note~~.',
    '',
    '- First bullet',
    '- Second bullet with `inline code`',
    '',
    '1. First ordered item',
    '2. Second ordered item',
    '',
    '> Quoted Slack context',
    '',
    '[Runbook](https://example.com/runbook)',
    '',
    '```ts',
    'const ok = true;',
    '```',
    '',
    '| Metric | Value |',
    '|---|---:|',
    '| p95 | 120ms |',
  ].join('\n');

  const rendered = renderSlackMessage(markdown, 'markdown');

  assert.deepEqual(rendered.blocks, [{ type: 'markdown', text: markdown }]);
  assert.equal(rendered.mrkdwn, undefined);
  assert.match(rendered.text, /Incident Summary/);
  assert.match(rendered.text, /Bold lead/);
  assert.match(rendered.text, /Runbook \(https:\/\/example\.com\/runbook\)/);
  assert.doesNotMatch(rendered.text, /\*\*Bold lead\*\*/);
  assert.doesNotMatch(rendered.text, /```/);
});

test('plain progress replies disable Slack markup parsing and escape control characters', () => {
  const rendered = renderSlackMessage('Progress for <@U123> & <!channel>', 'plain_text');

  assert.equal(rendered.blocks, undefined);
  assert.equal(rendered.mrkdwn, false);
  assert.equal(rendered.text, 'Progress for &lt;@U123&gt; &amp; &lt;!channel&gt;');
});

test('markdown blocks are capped at Slack markdown block limits', () => {
  const rendered = renderSlackMessage('x'.repeat(slackMarkdownBlockTextLimit + 50), 'markdown');
  const block = rendered.blocks?.[0];

  assert.equal(block?.type, 'markdown');
  assert.equal(block?.text.length, slackMarkdownBlockTextLimit);
  assert.match(block?.text ?? '', /\[truncated]$/);
});

test('fallback text is plain enough for notifications and accessibility', () => {
  const fallback = markdownFallbackText('## Hello <team>\n\n**Ship** [docs](https://example.com)');

  assert.equal(fallback, 'Hello &lt;team&gt;\n\nShip docs (https://example.com)');
});

test('reply footers render profile, model, and optional configure link', () => {
  assert.equal(
    buildSlackAdminUrl('https://demo.example', { agentId: 'agent_default' }),
    'https://demo.example/admin?agent=agent_default',
  );

  const linked = renderSlackReplyFooterBlock({
    profileName: 'Default <Team>',
    modelLabel: 'local-stub/parity-stub-1',
    agentId: 'agent_default',
    publicUrl: 'https://demo.example/flue',
  });
  assert.deepEqual(linked, {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: 'Default &lt;Team&gt; | local-stub/parity-stub-1 | <https://demo.example/admin?agent=agent_default|Configure>',
      },
    ],
  });

  const unlinked = renderSlackReplyFooterBlock({
    profileName: 'Default',
    modelLabel: 'local-stub/parity-stub-1',
    agentId: 'agent_default',
  });
  assert.deepEqual(unlinked.elements, [
    {
      type: 'mrkdwn',
      text: 'Default | local-stub/parity-stub-1 | Configure',
    },
  ]);

  // An unresolvable model omits the segment entirely — no 'unresolved model'
  // diagnostic leaks into the user-facing footer.
  const noModel = renderSlackReplyFooterBlock({
    profileName: 'Default',
    agentId: 'agent_default',
    publicUrl: 'https://demo.example',
  });
  assert.equal(
    noModel.elements[0]?.text,
    'Default | <https://demo.example/admin?agent=agent_default|Configure>',
  );
});

test('buildSlackAdminUrl only links http(s) bases without userinfo', () => {
  assert.equal(buildSlackAdminUrl('https://demo.example', { agentId: 'a' }), 'https://demo.example/admin?agent=a');
  assert.equal(buildSlackAdminUrl('http://localhost:8789', { agentId: 'a' }), 'http://localhost:8789/admin?agent=a');
  // Non-http(s) scheme, embedded userinfo, or an unparseable base -> no link.
  assert.equal(buildSlackAdminUrl('ftp://internal-host', { agentId: 'a' }), undefined);
  assert.equal(buildSlackAdminUrl('https://evil.example@real-host', { agentId: 'a' }), undefined);
  assert.equal(buildSlackAdminUrl('not a url', { agentId: 'a' }), undefined);
  assert.equal(buildSlackAdminUrl(undefined), undefined);
});

test('a plain_text final with a footer keeps its content literal (not markdown-parsed)', () => {
  const plain = renderSlackMessage('The model provider *failed* to respond.', 'plain_text');
  assert.equal(plain.mrkdwn, false);
  assert.equal(plain.blocks, undefined);

  const withFooter = appendSlackReplyFooter(plain, {
    profileName: 'Default',
    modelLabel: 'local-stub/parity-stub-1',
    agentId: 'agent_default',
  });
  const [content, footer] = withFooter.blocks ?? [];
  // Content stays a literal plain_text section, NOT a markdown block that would
  // parse the '*failed*' as bold.
  assert.deepEqual(content, {
    type: 'section',
    text: { type: 'plain_text', text: 'The model provider *failed* to respond.', emoji: false },
  });
  assert.equal(footer?.type, 'context');
});

test('channel onboarding discloses mention-only, bounded context, no monitoring, and a Configure link', () => {
  const linked = renderChannelOnboarding({
    botUserId: 'U_BOT',
    channelId: 'C_ENG',
    publicUrl: 'https://demo.example',
  });
  assert.match(linked, /Mention <@U_BOT> to start a thread\./);
  assert.match(linked, /bounded recent context only when asked/);
  assert.match(linked, /no passive monitoring/i);
  assert.match(linked, /<https:\/\/demo\.example\/admin\?channel=C_ENG\|Configure> this channel's profile/);

  const unlinked = renderChannelOnboarding({ botUserId: 'U_BOT', channelId: 'C_ENG', publicUrl: undefined });
  assert.match(unlinked, /(^|\s)Configure this channel's profile/);
  assert.doesNotMatch(unlinked, /\|Configure>/);
});

test('unassigned-channel hint names the bot, explains the silence, and links Configure', () => {
  const linked = renderUnassignedChannelHint({
    botUserId: 'U_BOT',
    channelId: 'C_NEW',
    publicUrl: 'https://demo.example',
  });
  assert.match(linked, /No profile is assigned to this channel yet/);
  assert.match(linked, /<@U_BOT> cannot reply here\./);
  assert.match(linked, /<https:\/\/demo\.example\/admin\?channel=C_NEW\|Configure> this channel's profile/);

  const unlinked = renderUnassignedChannelHint({
    botUserId: 'U_BOT',
    channelId: 'C_NEW',
    publicUrl: undefined,
  });
  assert.match(unlinked, /(^|\s)Configure this channel's profile/);
  assert.doesNotMatch(unlinked, /\|Configure>/);
});

test('status updates use factual text and derive loading copy from the same fact', () => {
  const update = { text: 'is using 2 messages of channel_history context' };

  assert.equal(slackStatusText(update), update.text);
  assert.deepEqual(slackLoadingMessages(update), [
    'Using 2 messages of channel_history context',
  ]);
});

test('toolStatus names the MCP connection instead of the raw mcp__ identifier', () => {
  assert.deepEqual(toolStatus('mcp__context7__resolve-library-id'), {
    text: 'is calling context7: resolve-library-id',
  });
  // Builtin (non-MCP) tools keep the plain form.
  assert.deepEqual(toolStatus('lookup_thread_history'), {
    text: 'is running lookup_thread_history',
  });
  // A malformed mcp__ name (no second separator) falls back rather than
  // rendering an empty server or tool segment.
  assert.deepEqual(toolStatus('mcp__broken'), { text: 'is running mcp__broken' });
});

test('MCP tool status still respects Slack’s 50-character loading cap', () => {
  const update = toolStatus('mcp__some-long-server-name__a-very-long-tool-name-indeed');
  const [loading] = slackLoadingMessages(update);
  assert.ok(loading);
  assert.ok(loading.length <= 50, `expected <= 50 chars, got ${loading.length}`);
});

test('derived loading message is capped to Slack’s 50-character limit', () => {
  // A long status must not produce a 51+ char loading message: Slack rejects it,
  // tripping the presenter latch and killing every later status for the turn.
  const long = 'is running a-very-long-tool-name-that-exceeds-the-slack-loading-limit';
  const [loading] = slackLoadingMessages({ text: long });
  assert.ok(loading);
  assert.ok(loading.length <= 50, `expected <= 50 chars, got ${loading.length}`);
});
