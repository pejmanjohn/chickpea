import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  markdownFallbackText,
  renderSlackMessage,
  slackMarkdownBlockTextLimit,
} from '../src/slack/message-format.ts';
import { LocalSlackReplySink } from '../src/slack/replies.ts';

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

test('reply sinks default final replies to markdown and progress replies to plain text', () => {
  const sink = new LocalSlackReplySink();

  sink.post('progress', {
    channelId: 'C',
    threadTs: '1.0',
    text: '<@U123> working',
    postedAt: 1,
  });
  sink.post('final', {
    channelId: 'C',
    threadTs: '1.0',
    text: '**Done**',
    postedAt: 2,
  });

  assert.equal(sink.posts[0]?.format, 'plain_text');
  assert.equal(sink.posts[0]?.rendered.mrkdwn, false);
  assert.equal(sink.posts[1]?.format, 'markdown');
  assert.deepEqual(sink.posts[1]?.rendered.blocks, [{ type: 'markdown', text: '**Done**' }]);
});
