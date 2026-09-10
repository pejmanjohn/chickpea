import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SLACK_ACTION_LINK_INSTRUCTION,
  appendSlackReplyFooter,
  buildSlackAdminUrl,
  canonicalSlackMarkdownText,
  renderChannelOnboarding,
  renderSlackReplyFooterBlock,
  renderUnassignedChannelHint,
  markdownFallbackText,
  renderSlackActionLink,
  renderSlackMarkdownActionLink,
  renderSlackMessage,
  renderSlackFileBlocks,
  renderSlackArtifactMessage,
  sanitizeSlackMarkdownLinks,
  slackActionLink,
  slackMarkdownBlockTextLimit,
  streamableSlackMarkdownPrefix,
} from '../src/slack/message-format.ts';
import {
  slackLoadingMessages,
  slackStatusText,
  toolStatus,
} from '../src/slack/replies.ts';
import { activityStatus } from '../src/activity/status.ts';
import { syntheticPem } from './helpers/credential-fixtures.ts';
import type { CompletedSlackArtifactReceipt } from '../src/slack/artifact-receipts.ts';

function completedFile(index: number, suffix = 'report.csv'): CompletedSlackArtifactReceipt {
  return {
    schemaVersion: 2, fileId: `F123456${index}`, filename: `report_${index}.csv`,
    permalink: `https://example.slack.com/files/U123456/F123456${index}/${suffix}`,
    kind: 'file', byteLength: 33, stagedAt: 1, completedAt: 2,
    destination: { workspaceId: 'T123456', agentId: 'analyst', channelId: 'C123456' },
  };
}

test('artifact links remain outside unfinished generated code and before one compact footer', () => {
  const files = [completedFile(0), completedFile(1)];
  const rendered = renderSlackArtifactMessage('**Report**\n```csv\nexam,bookings\nGRE,2400', 'markdown', {
    agentName: 'Analyst', agentId: 'analyst', publicUrl: 'https://example.test',
  }, files, 'TOEFL: 800');
  const sections = rendered.blocks?.filter((block) => block.type === 'section') ?? [];
  assert.ok(sections.some((block) => block.text.text.includes('Report')));
  assert.ok(sections.some((block) => block.text.text.includes('TOEFL: 800')));
  const linkSection = sections.find((block) => block.text.text.includes(files[0]!.permalink));
  assert.ok(linkSection);
  assert.doesNotMatch(linkSection.text.text, /```/);
  for (const file of files) {
    const link = `<${file.permalink}|${file.filename}>`;
    assert.ok(linkSection.text.text.includes(link));
    assert.ok(rendered.text.includes(link));
  }
  assert.equal(rendered.blocks?.filter((block) => block.type === 'context').length, 1);
  assert.equal(rendered.blocks?.at(-1)?.type, 'context');
  assert.ok(rendered.text.length <= 4_000);
});

test('artifact plain text stays literal while filenames remain usable labeled links', () => {
  const file = { ...completedFile(0), filename: 'report_<&|_2026.csv' };
  const rendered = renderSlackArtifactMessage('*literal* <@U123> & data', 'plain_text', {
    agentName: 'Analyst', agentId: 'analyst', includeConfigureLink: false, scheduled: true,
  }, [file]);
  const first = rendered.blocks?.[0];
  assert.equal(first?.type, 'section');
  if (first?.type === 'section') {
    assert.equal(first.text.type, 'plain_text');
    assert.equal(first.text.text, '*literal* &lt;@U123&gt; &amp; data');
  }
  assert.ok(rendered.text.includes('|report_&lt;&amp; _2026.csv>'));
  assert.equal((JSON.stringify(rendered.blocks).match(/Scheduled/g) ?? []).length, 1);
  assert.doesNotMatch(JSON.stringify(rendered), /Configure/);
});

test('ten long artifact links survive long body and table limits in both message representations', () => {
  const files = Array.from({ length: 10 }, (_, index) => ({
    ...completedFile(index, 'a'.repeat(1_950)), filename: '&'.repeat(256),
  }));
  const rendered = renderSlackArtifactMessage('<'.repeat(12_000), 'plain_text', {
    agentName: 'Analyst', agentId: 'analyst',
  }, files, '&'.repeat(12_000));
  assert.ok((rendered.blocks?.length ?? 0) <= 50);
  assert.ok(rendered.text.length < 40_000);
  assert.ok(rendered.text.length > 4_000, 'retain links beyond the recommended fallback size');
  for (const block of rendered.blocks ?? []) {
    if (block.type === 'section') assert.ok(block.text.text.length <= 3_000);
  }
  const visible = JSON.stringify(rendered.blocks);
  for (const file of files) {
    assert.ok(visible.includes(file.permalink));
    assert.ok(rendered.text.includes(file.permalink));
  }
  assert.equal(rendered.blocks?.filter((block) => block.type === 'context').length, 1);
});

test('artifact rendering redacts credentials in generated body, table and filename', () => {
  const canary = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
  const rendered = renderSlackArtifactMessage(`Credential: ${canary}`, 'markdown', {
    agentName: 'Analyst', agentId: 'analyst',
  }, [{ ...completedFile(0), filename: `${canary}.csv` }], `Table: ${canary}`);
  assert.doesNotMatch(JSON.stringify(rendered), new RegExp(canary));
  assert.match(JSON.stringify(rendered), /credential redacted/);
});

function fileBody(blocks: ReturnType<typeof renderSlackFileBlocks>): string {
  return blocks.filter((block) => block.type === 'section').map((block) => block.text.text).join('');
}

function renderFileBody(...args: Parameters<typeof renderSlackFileBlocks>): string {
  return fileBody(renderSlackFileBlocks(...args));
}

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

test('plain Slack replies redact credential-shaped content', () => {
  const canary = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
  const rendered = renderSlackMessage(`Credential: ${canary}`, 'plain_text');

  assert.doesNotMatch(rendered.text, new RegExp(canary));
  assert.match(rendered.text, /\[credential redacted\]/);
});

test('Markdown and plain Slack replies remove complete PEM armor', () => {
  const pem = syntheticPem('OPENSSH PRIVATE KEY', [
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ==',
    'c2VjcmV0LWJ5dGVzLXRoYXQtbXVzdC1ub3Qtc3Vydml2ZQ==',
  ]);
  for (const format of ['markdown', 'plain_text'] as const) {
    const rendered = JSON.stringify(renderSlackMessage(`Credential:\n${pem}\nDone.`, format));
    assert.match(rendered, /\[credential redacted\]/);
    assert.doesNotMatch(rendered, /b3BlbnNza|c2VjcmV0|END OPENSSH PRIVATE KEY/);
  }
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

test('classic file sections retain all 12,000 canonical characters and one context footer', () => {
  const text = `${'x'.repeat(11_992)}TAIL_END`;
  const blocks = renderSlackFileBlocks(text, 'markdown', {
    agentName: 'Analyst', agentId: 'agent_analyst', publicUrl: 'https://example.com',
  });
  assert.equal(fileBody(blocks), text);
  assert.equal(blocks.length, 5);
  for (const block of blocks.slice(0, -1)) {
    assert.equal(block.type, 'section');
    if (block.type !== 'section') continue;
    assert.equal(block.text.type, 'mrkdwn');
    assert.equal(block.text.text.length, 3_000);
  }
  assert.deepEqual(blocks.at(-1), { type: 'context', elements: [{
    type: 'mrkdwn', text: 'Analyst | <https://example.com/admin/agents/agent_analyst|Configure>',
  }] });
  assert.equal(markdownFallbackText(text).length, 4_000);
  assert.match(markdownFallbackText(text), /\[truncated\]$/);
});

test('file sections preserve safe action labels while escaping malformed content and redacting credentials', () => {
  const canary = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
  const comment = renderFileBody([
    '## Report <team>',
    '**GRE:** $2,400 & TOEFL: $800',
    '[View report](https://example.com/report?exam=gre&row=1)',
    '[Unsafe](javascript:alert)',
    '[Malformed](https://example.com/<broken',
    '<!channel>',
    `Credential: ${canary}`,
  ].join('\n'), 'markdown', {
    agentName: 'Analyst', agentId: 'agent_analyst', includeConfigureLink: false,
  });
  assert.match(comment, /Report &lt;team&gt;/);
  assert.match(comment, /GRE: \$2,400 &amp; TOEFL: \$800/);
  assert.match(comment, /<https:\/\/example.com\/report\?exam=gre&amp;row=1\|View report>/);
  assert.match(comment, /Unsafe\n\[Malformed\]\(https:\/\/example.com\/&lt;broken/);
  assert.match(comment, /&lt;!channel&gt;/);
  assert.match(comment, /\[credential redacted\]/);
  assert.doesNotMatch(comment, new RegExp(`${canary}|javascript:|<!channel>`));
});

test('plain file sections escape Slack control syntax and retain readable table data', () => {
  const comment = renderFileBody('Result for <@U123> & team', 'plain_text', {
    agentName: 'Analyst', agentId: 'agent_analyst', includeConfigureLink: false,
  }, 'Exam: GRE | Bookings: 2400\nExam: TOEFL | Bookings: 800');
  assert.equal(comment, 'Result for &lt;@U123&gt; &amp; team\n\nExam: GRE | Bookings: 2400\nExam: TOEFL | Bookings: 800');
});

test('file sections preserve exact inline and unformatted filenames and mathematical expressions', () => {
  const body = [
    'File: `qa_artifacts_1531.csv`',
    'Also attached: qa_artifacts_1531.csv and qa__artifacts__1531.png',
    'Compute `x_i * y_j + z_k ** 2` with $x_i + y_j$ and a*b*c.',
    'Example: `[literal_link](https://example.com/a_b)`',
  ].join('\n');
  const comment = renderFileBody(body, 'markdown', {
    agentName: 'Analyst', agentId: 'agent_analyst', includeConfigureLink: false,
  });
  assert.equal(comment, body);
});

test('file sections preserve fenced code and table-like literals while still escaping Slack controls', () => {
  const body = [
    'Use this snippet:',
    '```python',
    'filename = "qa_artifacts_1531.csv"',
    'total_value = x_i * y_j + z_k ** 2',
    'literal = "**keep** _this_ [link](https://example.com/a_b)"',
    '| column_a | column_b |',
    '| --- | --- |',
    '```',
    'Inline: `x_i < y_j && y_j > z_k`',
  ].join('\n');
  const comment = renderFileBody(body, 'markdown', {
    agentName: 'Analyst', agentId: 'agent_analyst', includeConfigureLink: false,
  });
  assert.equal(comment, body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'));
});

test('file sections keep links and short code intact when they cross a section boundary', () => {
  const prefix = 'x'.repeat(2_980);
  const link = '<https://example.com/report?exam=gre&amp;row=1|View report>';
  const blocks = renderSlackFileBlocks(`${prefix}[View report](https://example.com/report?exam=gre&row=1)\n\`qa_artifacts_1531.csv\``, 'markdown', {
    agentName: 'Analyst', agentId: 'agent_analyst', includeConfigureLink: false,
  });
  const sections = blocks.filter((block) => block.type === 'section');
  assert.equal(fileBody(blocks), `${prefix}${link}\n\`qa_artifacts_1531.csv\``);
  assert.equal(sections[0]!.text.text, prefix);
  assert.equal(sections[1]!.text.text, `${link}\n\`qa_artifacts_1531.csv\``);
  assert.ok(sections.every((block) => block.text.text.length <= 3_000));
});

for (const fence of ['`', '```']) {
  test(`file sections reopen long ${fence.length === 1 ? 'inline' : 'fenced'} code without losing literal content`, () => {
    const code = 'qa_artifacts_1531.csv x_i * y_j ** 2 '.repeat(180);
    const blocks = renderSlackFileBlocks(`${fence}${code}${fence}`, 'markdown', {
      agentName: 'Analyst', agentId: 'agent_analyst', includeConfigureLink: false,
    });
    const sections = blocks.filter((block) => block.type === 'section');
    assert.ok(sections.length > 1);
    assert.ok(sections.every((block) => block.text.text.length <= 3_000 &&
      block.text.text.startsWith(fence) && block.text.text.endsWith(fence)));
    assert.equal(sections.map((block) => block.text.text.slice(fence.length, -fence.length)).join(''), code);
    assert.equal(blocks.at(-1)!.type, 'context');
  });
}

test('file sections preserve escaped controls and Unicode at every boundary', () => {
  const body = `${'x'.repeat(2_998)}😀&<value>${'😀&'.repeat(1_000)}`;
  const blocks = renderSlackFileBlocks(body, 'markdown', {
    agentName: 'Analyst', agentId: 'agent_analyst', includeConfigureLink: false,
  });
  assert.equal(fileBody(blocks), body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'));
  for (const block of blocks) {
    if (block.type !== 'section') continue;
    assert.ok(block.text.text.length <= 3_000);
    assert.doesNotMatch(block.text.text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    assert.doesNotMatch(block.text.text, /&(?:a(?:m(?:p)?)?|l(?:t)?|g(?:t)?)?$/);
  }
});

test('a link larger than a section retains its complete URL and label as a literal', () => {
  const url = `https://example.com/${'a'.repeat(3_100)}?exam=gre&row=1`;
  const blocks = renderSlackFileBlocks(`[View report](${url})`, 'markdown', {
    agentName: 'Analyst', agentId: 'agent_analyst', includeConfigureLink: false,
  });
  const sections = blocks.filter((block) => block.type === 'section');
  assert.ok(sections.every((block) => block.text.text.length <= 3_000 &&
    block.text.text.startsWith('```') && block.text.text.endsWith('```')));
  assert.equal(sections.map((block) => block.text.text.slice(3, -3)).join(''), `&lt;${url.replaceAll('&', '&amp;')}|View report&gt;`);
});

test('dense code plus a bounded table repacks into at most 50 blocks without losing content', () => {
  const body = ('```\n' + '&'.repeat(300) + '\n```').repeat(38);
  const table = '&'.repeat(12_000);
  const blocks = renderSlackFileBlocks(body, 'markdown', {
    agentName: 'Analyst', agentId: 'agent_analyst', modelLabel: 'openai/test',
    includeConfigureLink: false, scheduled: true,
  }, table);
  assert.ok(blocks.length <= 50);
  const sections = blocks.filter((block) => block.type === 'section');
  assert.ok(sections.every((block) => block.text.type === 'plain_text' && block.text.text.length <= 3_000));
  assert.equal(fileBody(blocks), `${body.replaceAll('&', '&amp;')}\n\n${table.replaceAll('&', '&amp;')}`);
  assert.doesNotMatch(fileBody(blocks), /\[truncated\]/);
  assert.deepEqual(blocks.at(-1), { type: 'context', elements: [{
    type: 'mrkdwn', text: 'Analyst | openai/test | Scheduled',
  }] });
  assert.equal(blocks.filter((block) => block.type === 'context').length, 1);
});

test('aggregate fallback preserves a Unicode URL without percent-encoding expansion', () => {
  const body = `[View report](https://example.com/${'日'.repeat(11_000)})`;
  const table = '&'.repeat(12_000);
  const blocks = renderSlackFileBlocks(body, 'markdown', {
    agentName: 'Analyst', agentId: 'agent_analyst', includeConfigureLink: false,
  }, table);
  assert.ok(blocks.length <= 50);
  assert.ok(blocks.filter((block) => block.type === 'section').every((block) =>
    block.text.type === 'plain_text' && block.text.text.length <= 3_000));
  assert.equal(fileBody(blocks), `${body}\n\n${table.replaceAll('&', '&amp;')}`);
  assert.doesNotMatch(fileBody(blocks), /\[truncated\]/);
});

for (const format of ['plain_text', 'mrkdwn', 'markdown'] as const) {
  test(`file block limits remain bounded for oversized ${format} inputs with explicit truncation`, () => {
    const blocks = renderSlackFileBlocks('x'.repeat(150_000), format, {
      agentName: 'Analyst', agentId: 'agent_analyst', includeConfigureLink: false,
    }, '&'.repeat(150_000));
    assert.ok(blocks.length <= 50);
    assert.ok(blocks.filter((block) => block.type === 'section').every((block) => block.text.text.length <= 3_000));
    assert.equal(fileBody(blocks).match(/\[truncated\]/g)?.length, 2);
    assert.equal(blocks.at(-1)!.type, 'context');
  });
}

test('product-owned action links use safe descriptive Slack labels', () => {
  const reusable = slackActionLink(
    'https://demo.example/admin/agents/agent_default?tab=connections&owner=member',
    'View Agent',
  );
  assert.deepEqual(reusable, {
    url: 'https://demo.example/admin/agents/agent_default?tab=connections&owner=member',
    label: 'View Agent',
  });
  assert.equal(
    renderSlackActionLink(reusable),
    '<https://demo.example/admin/agents/agent_default?tab=connections&amp;owner=member|View Agent>',
  );
  assert.equal(
    renderSlackMarkdownActionLink(reusable),
    '[View Agent](https://demo.example/admin/agents/agent_default?tab=connections&owner=member)',
  );
  assert.equal(
    renderSlackActionLink('javascript:alert(1)', 'View Agent'),
    'View Agent',
  );
  assert.match(SLACK_ACTION_LINK_INSTRUCTION, /never display a raw URL/i);
  assert.match(SLACK_ACTION_LINK_INSTRUCTION, /actionLinks/);
  assert.match(SLACK_ACTION_LINK_INSTRUCTION, /supplied label/i);
  assert.doesNotMatch(SLACK_ACTION_LINK_INSTRUCTION, /Connect Google Ads|Authorize Google Ads/);
  assert.equal(
    canonicalSlackMarkdownText('[View Agent](https://demo.example/admin/agents/agent_default)'),
    '[View Agent](https://demo.example/admin/agents/agent_default)',
  );
});

test('reply footers render Agent, model, and optional configure link', () => {
  assert.equal(
    buildSlackAdminUrl('https://demo.example', { agentId: 'agent_default' }),
    'https://demo.example/admin/agents/agent_default',
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
        text: 'Default &lt;Team&gt; | local-stub/parity-stub-1 | <https://demo.example/admin/agents/agent_default|Configure>',
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
    'Default | <https://demo.example/admin/agents/agent_default|Configure>',
  );
});

test('scheduled reply footers add only the Scheduled segment', () => {
  const footer = { agentName: 'Analyst', agentId: 'analyst', modelLabel: 'openai/test', includeConfigureLink: false };
  assert.equal(renderSlackReplyFooterBlock(footer).elements[0]?.text, 'Analyst | openai/test');
  assert.equal(renderSlackReplyFooterBlock({ ...footer, scheduled: true }).elements[0]?.text,
    'Analyst | openai/test | Scheduled');
  assert.equal(renderSlackReplyFooterBlock({ ...footer, scheduled: true, memoryItems: ['Agent memory supplied'] }).elements[0]?.text,
    'Analyst | openai/test | Scheduled | Agent memory supplied');
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
  assert.equal(buildSlackAdminUrl('https://demo.example', { agentId: 'a' }), 'https://demo.example/admin/agents/a');
  assert.equal(buildSlackAdminUrl('http://localhost:8789', { agentId: 'a' }), 'http://localhost:8789/admin/agents/a');
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
