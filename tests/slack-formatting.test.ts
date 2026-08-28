import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appendSlackReplyFooter,
  buildSlackAdminUrl,
  canonicalSlackMarkdownText,
  renderChannelOnboarding,
  renderSlackReplyFooterBlock,
  renderUnassignedChannelHint,
  markdownFallbackText,
  renderSlackMessage,
  sanitizeSlackMarkdownLinks,
  slackMarkdownBlockTextLimit,
  streamableSlackMarkdownPrefix,
} from '../src/slack/message-format.ts';
import {
  slackLoadingMessages,
  slackStatusText,
  toolStatus,
} from '../src/slack/replies.ts';
import { activityStatus } from '../src/activity/status.ts';

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
  assert.match(rendered.text, /Metric — Value/);
  assert.match(rendered.text, /p95 — 120ms/);
  assert.doesNotMatch(rendered.text, /\| Metric \|/);
  assert.doesNotMatch(rendered.text, /\*\*Bold lead\*\*/);
  assert.doesNotMatch(rendered.text, /```/);
});

test('strong emphasis cannot leak a trailing asterisk into an auto-linked URL', () => {
  const url = 'https://github.com/octo-org/example-site/pull/4';
  const markdown = `Done: **\ud83d\udd17 ${url}**`;

  assert.equal(sanitizeSlackMarkdownLinks(markdown), `Done: \ud83d\udd17 ${url}`);
  assert.deepEqual(renderSlackMessage(markdown, 'markdown').blocks, [
    { type: 'markdown', text: `Done: \ud83d\udd17 ${url}` },
  ]);
  const [block] = renderSlackMessage(markdown, 'markdown').blocks ?? [];
  assert.equal(block?.type, 'markdown');
  assert.doesNotMatch(block?.type === 'markdown' ? block.text : '', /\/4\*/);

  assert.equal(sanitizeSlackMarkdownLinks(`**bold** and \`${markdown}\``), `**bold** and \`${markdown}\``);
});

test('every progressive cut point is a monotone prefix of the canonical terminal answer', () => {
  const corpus = [
    'A plain answer that arrives one character at a time.',
    'Done: **https://github.com/octo-org/example-site/pull/4** after review.',
    'Read [the runbook](https://example.com/runbook?q=1) before continuing.',
    '```ts\nconst answer = 42;\nconsole.log(answer);\n```\nComplete.',
    '**Bold text** followed by _ordinary emphasis_ and `inline code`.',
    'Credential: xoxb-123456789012345678901234\nDo not expose it.',
    'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456\nRotated.',
    'CHICKPEA_AUTH_SECRET=consumer-install-secret-value\nNever render this.',
    '<https://example.com/path|Slack link> then a safe suffix.',
    '| Metric | Value |\n| --- | ---: |\n| p95 | 120ms |\n| errors | 3 |',
  ];

  for (const terminalInput of corpus) {
    const terminal = canonicalSlackMarkdownText(terminalInput);
    let prior = '';
    for (let cut = 0; cut <= terminalInput.length; cut += 1) {
      const prefix = streamableSlackMarkdownPrefix(terminalInput.slice(0, cut));
      assert.ok(terminal.startsWith(prefix), `${JSON.stringify(prefix)} is not terminal prefix`);
      assert.ok(prefix.startsWith(prior), `${JSON.stringify(prefix)} rewrote ${JSON.stringify(prior)}`);
      prior = prefix;
    }
  }
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

test('reply footers render Agent, model, and optional configure link', () => {
  assert.equal(
    buildSlackAdminUrl('https://demo.example', { agentId: 'agent_default' }),
    'https://demo.example/admin?agent=agent_default',
  );

  const linked = renderSlackReplyFooterBlock({
    agentName: 'Default <Team>',
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
    agentName: 'Default',
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
    agentName: 'Default',
    agentId: 'agent_default',
    publicUrl: 'https://demo.example',
  });
  assert.equal(
    noModel.elements[0]?.text,
    'Default | <https://demo.example/admin?agent=agent_default|Configure>',
  );
});

test('reply footers disclose cross-channel memory as supplied advisory context', () => {
  const block = renderSlackReplyFooterBlock({
    agentName: 'Chickpea', agentId: 'agent',
    memoryItems: ['Memory supplied: release-checklist (#product, C123)'],
  });
  assert.match(block.elements[0]!.text, /Memory supplied: release-checklist/);
  assert.doesNotMatch(block.elements[0]!.text, /Memory used/);
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
    agentName: 'Default',
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

test('Channel onboarding explains explicit Agent routing, owned threads, and Configure', () => {
  const linked = renderChannelOnboarding({
    botUserId: 'UBOT',
    channelId: 'C_ENG',
    publicUrl: 'https://demo.example',
  });
  assert.match(linked, /Mention an Agent handle or <@UBOT> to start a thread/);
  assert.match(linked, /never joins unmentioned Channel conversations/);
  assert.match(linked, /Channel members can continue without repeating the mention/);
  assert.match(linked, /<https:\/\/demo\.example\/admin\?channel=C_ENG\|Configure> the Agents available in this Channel/);

  const unlinked = renderChannelOnboarding({ botUserId: 'UBOT', channelId: 'C_ENG', publicUrl: undefined });
  assert.match(unlinked, /(^|\s)Configure the Agents available in this Channel/);
  assert.doesNotMatch(unlinked, /\|Configure>/);
});

test('unassigned-Channel hint names the bot, explains the silence, and links Configure', () => {
  const linked = renderUnassignedChannelHint({
    botUserId: 'UBOT',
    channelId: 'C_NEW',
    publicUrl: 'https://demo.example',
  });
  assert.match(linked, /No Agent is available in this Channel yet/);
  assert.match(linked, /<@UBOT> cannot reply here\./);
  assert.match(linked, /<https:\/\/demo\.example\/admin\?channel=C_NEW\|Configure> the Agents available in this Channel/);

  const unlinked = renderUnassignedChannelHint({
    botUserId: 'UBOT',
    channelId: 'C_NEW',
    publicUrl: undefined,
  });
  assert.match(unlinked, /(^|\s)Configure the Agents available in this Channel/);
  assert.doesNotMatch(unlinked, /\|Configure>/);
});

test('status surfaces carry the same meaningful activity fact', () => {
  const update = activityStatus('checking', 'Checking', 'thread context');

  assert.equal(slackStatusText(update), 'Checking thread context…');
  assert.deepEqual(slackLoadingMessages(update), ['Checking thread context…']);
});

test('activity status never prefixes the Agent name or adds generic thinking copy', () => {
  const preparing = activityStatus('preparing', 'Preparing', 'your request');
  assert.deepEqual(slackLoadingMessages(preparing), ['Preparing your request…']);
  assert.equal(
    slackStatusText(preparing, 'Sprout'),
    'Preparing your request…',
  );
  assert.deepEqual(
    slackLoadingMessages(activityStatus('checking', 'Searching', 'the workspace'), 'Sprout'),
    ['Searching the workspace…'],
  );
});

test('toolStatus hides raw MCP identifiers when no registered activity context is available', () => {
  assert.deepEqual(
    toolStatus('mcp__context7__resolve-library-id'),
    activityStatus('checking', 'Checking', 'a connection'),
  );
  // A known builtin gets descriptive fixed copy rather than its identifier.
  assert.deepEqual(
    toolStatus('lookup_thread_history'),
    activityStatus('checking', 'Checking', 'thread history'),
  );
  // A malformed mcp__ name (no second separator) falls back rather than
  // rendering an empty server or tool segment.
  assert.deepEqual(
    toolStatus('mcp__broken'),
    activityStatus('checking', 'Checking', 'a connection'),
  );
});

test('bash tool status describes the workspace stage without exposing command text', () => {
  const examples = [
    ['git clone https://github.com/Acme/Alpha.git', 'Cloning the repository…'],
    ['pnpm install --frozen-lockfile', 'Installing dependencies…'],
    ['pnpm test', 'Running the test suite…'],
    ['cat > src/example.test.ts <<EOF', 'Editing the code…'],
    ['git commit -m "test: add smoke coverage"', 'Committing the changes…'],
    ['git push origin chickpea/smoke-test', 'Pushing the branch…'],
    [
      "curl -X POST https://api.github.com/repos/Acme/Alpha/pulls -d '{...}'",
      'Opening the pull request…',
    ],
    ['pnpm run dev', 'Starting the app…'],
    ['node capture-with-playwright.mjs screenshot.png', 'Capturing a screenshot…'],
    ['git status && find . -maxdepth 2 -type f', 'Inspecting the workspace…'],
  ] as const;

  for (const [command, expected] of examples) {
    assert.equal(toolStatus('bash', { command }).text, expected, command);
  }

  const secret = 'ghs_do-not-leak-this-token';
  const fallback = toolStatus('bash', { command: `custom-command --token ${secret}` });
  assert.deepEqual(fallback, activityStatus('running', 'Running', 'a workspace command'));
  assert.doesNotMatch(fallback.text, new RegExp(secret));
});

test('MCP tool status still respects Slack’s 50-character loading cap', () => {
  const update = toolStatus('mcp__some-long-server-name__a-very-long-tool-name-indeed');
  const loading = slackLoadingMessages(update).at(-1);
  assert.ok(loading);
  assert.ok(loading.length <= 50, `expected <= 50 chars, got ${loading.length}`);
});

test('derived loading message is capped to Slack’s 50-character limit', () => {
  // A long status must not produce a 51+ char loading message: Slack rejects it,
  // tripping the presenter latch and killing every later status for the turn.
  const long = 'is running a-very-long-tool-name-that-exceeds-the-slack-loading-limit';
  const loading = slackLoadingMessages({ text: long }).at(-1);
  assert.ok(loading);
  assert.ok(loading.length <= 50, `expected <= 50 chars, got ${loading.length}`);
  assert.equal(slackStatusText({ text: long }), loading);
});
