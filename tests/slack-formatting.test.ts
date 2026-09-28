import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SLACK_ACTION_LINK_INSTRUCTION,
  appendSlackReplyFooter,
  buildSlackAdminUrl,
  canonicalSlackMarkdownText,
  renderChannelOnboarding,
  renderSlackReplyFooterBlock,
  replyFooterModelLabel,
  renderUnassignedChannelHint,
  markdownFallbackText,
  markdownToSlackMrkdwn,
  neutralizeSlackBroadcastMentions,
  renderSlackActionLink,
  renderSlackMarkdownActionLink,
  renderSlackMessage,
  renderSlackFileBlocks,
  renderSlackArtifactMessage,
  sanitizeSlackMarkdownLinks,
  slackActionLink,
  slackMarkdownBlockTextLimit,
  splitSlackMarkdownReply,
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
  // Pairs close left to right, so a bold closer never opens a URL span.
  assert.equal(
    sanitizeSlackMarkdownLinks('- **Step:** go to https://x.test/a then **Save**.'),
    '- **Step:** go to https://x.test/a then **Save**.',
  );
  assert.equal(sanitizeSlackMarkdownLinks('**a** [link](http://b) **c**'), '**a** [link](http://b) **c**');
});

test('a line led by bold text keeps streaming after the bold closes', () => {
  for (const line of ['**Summary:** the deploy finished', '- **Step 1:** run it and **always** check']) {
    assert.equal(streamableSlackMarkdownPrefix(line), line);
  }
  // A star run holds only the `**` that can still open a URL span.
  assert.equal(streamableSlackMarkdownPrefix('*********'), '*******');
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
    'CHICKPEA_AUTH_SECRET=\nabcdefghij',
    'sk-proj-abcdefghijklmnopqrstuvwxyz123456OK.CHICKPEA_AUTH_SECRET=\nghp_abcdefghijklmnopqrstuvwxyz-',
    '-xoxb-AWS_ACCESS_KEY_ID=\nxAKIAhello',
    'CHICKPEA_AUTH_SECRET\n=\nabcdefghij then prose.',
    'sk-proj-a-bcd-AWS_ACCESS_KEY_ID:\nabc done.',
    'OPENAI_API_KEY=\nxoxb-xoxb- then prose.',
    'CHICKPEA_AUTH_SECRET=\nabcdefg[hij more',
    'CHICKPEA_AUTH_SECRET=\nabcdefg**hij more',
    'OPENAI_API_KEY=\n|abcdefghij more',
    'OPENAI_API_KEY=\nabcd@here [link',
    'OPENAI_API_KEY=\nabcd@channel then more',
    `${'OPENAI_API_KEY=\n'.repeat(12)}OK.`,
    '<https://example.com/path|Slack link> then a safe suffix.',
    '| Metric | Value |\n| --- | ---: |\n| p95 | 120ms |\n| errors | 3 |',
    'Heads up <!here> and <!subteam^S0123|@oncall>, plus @channel and `<!everyone>`.',
    'Ask @here-now or @everyone123; mail a@here.com.\n```\n<!channel> @here\n```\nDone @here.',
    '`@here <x` then <!here>, then `<!channel|x>` and <![CDATA[ a ]]>.',
    'Key sk-proj-abcdefghijklmnopqrstuvwxyz123456@here stays redacted, @everyone.',
    'word\nxoxb-xoxb-123456789012345678901234\nDone.',
    'word\nsk-xoxb-xoxb-123456789012345678901234 then more.',
    'word\nxoxb-sk-ant-xoxb-123456789012345678901234 then more.',
    'word\nxoxp-sk-proj-abcdefghijklmnopqrstuvwxyz123456 then more.',
    '```ts\nxoxb-xoxb-123456789012345678901234\n```\nComplete.',
    '@channelword\n******',
    '**a**http://x** then more',
    '****http://x*** then more',
    '2**10 stays literal.\n**https://example.test/x** done',
    'See **http://a.test** and **http://b.test** both.',
    '**a `x` http://b** c http://d**',
    'x `**http://a** y` z',
    '```\n**http://a** x\n```\n**http://b** y',
    '````\n**http://a**\n````',
    '**https://a.test/x [draft]** is live',
    '- **Step:** go to https://x.test/a then **Save**.',
    '**Summary:** see https://x.test/a** then more',
    '**a `b** c` https://d**',
    '**https://x** `y` **https://z** `w',
    '*********',
    'Ping __@here__, _@channel_ and @here_now; see youtube.com/@everyone_team @here__ done.',
    'see **https://x sk-proj-abcdefghijklmnopqrstuvwxyz123456** ok',
    '**https://x OPENAI_API_KEY=**\nabc more',
    'see **https://x/<a** ok',
    '**>@<https://x\\n**a\\n',
    // Dropping a `**URL**` span's stars joins the words on either side of them.
    '**https://x @here**b and more.',
    '**https://x xo**xb-123456789012345678901234 done',
    'xo**xb-123456789012345678901234 https://x** done',
    '@he**re https://x** now',
    '**http://y/OPENAI_API_KEY= **\nhttps://xhttps://x',
    // Overlapping credential markers hold from the first.
    'xoxox-xox',
    'xoxox|OPENAI_API_KEY\n',
    // A hold pulled back to a dropped span's opener reads the joined words too.
    'a**` https://x xoxo**\nabcdefghij more',
    'xo**xb-123456789012345678901234 https://x @**\nok',
    'a xo**xb-123456789012345678901234 https://x OPENAI_API_KEY=**\nabcdefghijkl done',
    '`c` AK**IAABCDEFGHIJKLMNOP https://x <**\n\nxoxb-123456789012345678901234 ok',
    // `'\u0130'.toLowerCase()` is two characters; marker positions must not drift.
    `${'\u0130'.repeat(33)} token xoxb-123456789012345678901234 done`,
    `${'\u0130'.repeat(33)} xoxox-xox`,
    // A credential the answer redacts across a span opener: a name before
    // it and its separator after, or a PEM header split in two.
    'OPENAI_API_KEY\n**= abcdefghij https://x <**',
    'OPENAI_API_KEY **= abcdefghij https://x OPENAI_API_KEY**',
    'AWS_ACCESS_KEY_ID\n**: abcdefgh https://x** y',
    'ADMIN_TOKEN\t**=\tabcdefghij https://x** ok',
    '-----BEGIN RSA PRIVATE **KEY----- https://x <**\nabc',
    '-----BEGIN RSA **PRIVATE KEY----- https://x `**\n',
    // A mention the opener splits, and a letter outside the BMP after one.
    'x @c**hannel https://a.test/docs**',
    'x <!he**re> https://a.test/docs**',
    `Heads up @here**${'\u{1D400}'} https://x @h** done`,
    // Runs of `<` and `@h` the answer settles, and spans it settles the other way.
    'Intro.\n\na < b < c < d then done.\nNext.',
    '`<` `<` `<` `<` `<` `<` done',
    '```\n<a\n<a\n<a\n<a\n<a\n```\nDone.',
    `${'**https://x @h**'.repeat(6)} done`,
    `${'**https://x @here_**'.repeat(3)}x done`,
    `${'**https://x @here**'.repeat(3)}x done`,
    '**https://x @h**ere now',
    '@h**https://x**ere now',
    '**https://x <**!here> now',
    '**https://x <**!her <!here> now',
    'x <!here|xoxb-123456789012345678901234> ok\nnext',
    'xoxb-123456789012345678901234@here**https://x xoxb-1**23456789012345678901234 more',
    'OPENAI_API_KEY=abcdefghij<**https://x xoxb-**!here> more',
    // A cut that would close a span after a backtick it leaves open, and a
    // credential marker the cut's own reading would join across its stars.
    'Try `**https://a.test/<**xox` < b',
    'Run `**https://a.test/xo**xox <` then xox',
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

test('a run of decided broadcast-word prefixes streams instead of being peeled away', () => {
  // Each `@h` is followed by a space: nothing is left to decide, so the
  // stream shows it all rather than holding one more word per pass.
  const spans = '**https://x @h** '.repeat(700);
  assert.equal(streamableSlackMarkdownPrefix(spans), canonicalSlackMarkdownText(spans));
  const words = `${'@h '.repeat(4000)}@`;
  assert.equal(streamableSlackMarkdownPrefix(words), '@h '.repeat(4000).trimEnd());
  // Back-to-back spans: only the last, whose `s` may still grow, waits.
  const docs = '**https://a.test/docs**';
  assert.equal(streamableSlackMarkdownPrefix(docs.repeat(480)), 'https://a.test/docs'.repeat(479));
});

test('a `<` or `@` word the answer has settled streams as v0.1.29 streamed it', () => {
  // v0.1.30 judged each cut alone and held each of these runs back to its
  // start. A `<` followed by a space, a backtick or a letter can never
  // become `<!here>`; only the one on the line still being written waits.
  const settled: Array<[string, string]> = [
    ['Intro.\n\na < b < c < d < e', 'Intro.\n\na < b < c < d'],
    [`Intro.\n\n${'`<` '.repeat(8)}x`, `Intro.\n\n${'`<` '.repeat(7)}\``],
    [`Intro.\n\n\`\`\`\n${'<a\n'.repeat(6)}<a`, `Intro.\n\n\`\`\`\n${'<a\n'.repeat(5)}<a`],
    // The answer reads `@hhttps`, not a broadcast word. The last `@h`, whose
    // word runs into the text still being written, waits.
    [`Intro.\n\n${'**https://x @h**'.repeat(8)}x`, `Intro.\n\n${'https://x @h'.repeat(7)}`],
  ];
  for (const [input, expected] of settled) {
    assert.equal(streamableSlackMarkdownPrefix(input), expected, JSON.stringify(input));
  }
  // Settled the other way: every span boundary would show `@⁠here_` or
  // `@⁠here`, which the answer reads as `@here_https` and `@herehttps`, and
  // a cut at `@h` whose answer reads `@here https://x`.
  assert.equal(streamableSlackMarkdownPrefix(`Intro.\n\n${'**https://x @here_**'.repeat(2)}x`), 'Intro.');
  assert.equal(streamableSlackMarkdownPrefix(`Intro.\n\n${'**https://x @here**'.repeat(2)}x`), 'Intro.');
  assert.equal(streamableSlackMarkdownPrefix('Intro. @h**ere https://x <**b'), 'Intro.');
});

test('a cut that would close a span inside code it leaves open stops before the closing stars', () => {
  // The answer keeps the stars as code once its backtick closes. Pulling the
  // cut back to the span's opener instead dropped text already streamed.
  const text = 'Try `**https://a.test/<**xox` < b';
  assert.equal(streamableSlackMarkdownPrefix(text.slice(0, 30)), 'Try `**https://a.test/');
  assert.equal(streamableSlackMarkdownPrefix(text.slice(0, 31)), 'Try `**https://a.test/');
});

test('the hold gives up after four pull-backs instead of showing less', () => {
  // Each span would end the cut in `@here_`, which the answer reads as
  // `@here_https`: it pulls the cut back to its `@`, then to its opener.
  const spans = (count: number) => `Intro.\nx ${'**https://x @here_**'.repeat(count)}`;
  assert.equal(streamableSlackMarkdownPrefix(spans(2)), 'Intro.\nx');
  assert.equal(streamableSlackMarkdownPrefix(spans(3)), '');
  // Once the run's word ends nothing is left to decide.
  assert.equal(streamableSlackMarkdownPrefix(`${spans(3)} done`), canonicalSlackMarkdownText(`${spans(3)} done`));
});

test('a run the hold pulls back one unit at a time streams within a CPU bound', () => {
  // Each shape pulls the cut back one span, `<` or code span per pass. In
  // v0.1.30 every pass rescanned the whole cut, so streaming 12,000
  // characters of these in 40-character chunks took 4 to 47 s of CPU each;
  // the bounded hold takes under 150 ms, a tenth of the bound asserted here.
  const shapes = ['**https://x @h**', '**https://x @here_**', 'a < b ', '`<` '];
  for (const unit of shapes) {
    const run = unit.repeat(Math.ceil(12_000 / unit.length)).slice(0, 12_000);
    const answer = `Intro.\n\n${run}\n\nDone.`;
    const terminal = canonicalSlackMarkdownText(answer);
    let shown = '';
    const start = process.cpuUsage();
    for (let end = 40; end < answer.length + 40; end += 40) {
      const prefix = streamableSlackMarkdownPrefix(answer.slice(0, end));
      assert.ok(terminal.startsWith(prefix), `${unit}: ${JSON.stringify(prefix.slice(-40))} is not terminal prefix`);
      // `''` is nothing new to stream; anything else extends what was shown.
      if (prefix) {
        assert.ok(prefix.startsWith(shown), `${unit}: ${JSON.stringify(prefix.slice(-40))} rewrote the stream`);
        shown = prefix;
      }
      const { user, system } = process.cpuUsage(start);
      assert.ok(user + system < 1_500_000, `${unit}: ${Math.round((user + system) / 1_000)} ms of CPU by ${end}`);
    }
    // After the run's line ends, the stream catches up with the whole answer.
    assert.equal(shown, terminal, unit);
  }
});

test('a cut after stripped stars reads the answer at the matching place', () => {
  // The answer drops four stars before `@h`; its next character is the space.
  const text = '**https://a/1** @h then';
  assert.equal(streamableSlackMarkdownPrefix(text.slice(0, 18)), 'https://a/1');
  assert.equal(streamableSlackMarkdownPrefix(text.slice(0, 19)), 'https://a/1 @h');
});

const WJ = '⁠';
// A live special mention, or a broadcast word Slack could auto-parse.
const LIVE_BROADCAST = /<!(?:here|channel|everyone|group|subteam\^)|(?<![\p{L}\p{N}])@(?:here|channel|everyone)(?![\p{L}\p{N}])/iu;

test('model text never renders a Slack broadcast or user-group mention', () => {
  const answer = [
    'Heads up <!here> and <!channel|@channel>, also <!everyone> and <!group>.',
    'Paging <!subteam^S0123ABC|@oncall>, <!subteam^S0456DEF|design> and <!subteam^S0789GHI>.',
    'Plain @here, @Channel and @EVERYONE too.',
    'Keep <@U012AB3CD>, <#C0123|general>, <!date^1392734382^{date_short}|Feb 18>, a@here.com, @heresy and <!DOCTYPE html>.',
  ].join('\n');
  const canonical = canonicalSlackMarkdownText(answer);

  assert.equal(canonical, [
    `Heads up @${WJ}here and @${WJ}channel, also @${WJ}everyone and @${WJ}channel.`,
    `Paging @${WJ}oncall, @${WJ}design and @${WJ}user-group.`,
    `Plain @${WJ}here, @${WJ}Channel and @${WJ}EVERYONE too.`,
    'Keep <@U012AB3CD>, <#C0123|general>, <!date^1392734382^{date_short}|Feb 18>, a@here.com, @heresy and <!DOCTYPE html>.',
  ].join('\n'));
  assert.equal(neutralizeSlackBroadcastMentions(canonical), canonical);
  assert.equal(canonicalSlackMarkdownText(canonical), canonical);

  const rendered = renderSlackMessage(answer, 'markdown');
  const [block] = rendered.blocks ?? [];
  assert.equal(block?.type, 'markdown');
  const blockText = block?.type === 'markdown' ? block.text : '';
  assert.equal(blockText, canonical);
  assert.match(blockText, /<@U012AB3CD>/);
  for (const text of [blockText, rendered.text]) assert.doesNotMatch(text, LIVE_BROADCAST);
  assert.doesNotMatch(renderSlackMessage(answer, 'mrkdwn').text, LIVE_BROADCAST);
});

test('file replies keep broadcast words and user-group handles inert in mrkdwn', () => {
  const answer = 'Deploy done <!here>, cc @oncall and <@U123>. Mail ops@example.com. `@here`';
  const footer = { agentName: 'Analyst', agentId: 'analyst' };
  const body = renderFileBody(answer, 'markdown', footer);

  // File-reply prose already escaped Slack control syntax, `<@U123>` included.
  assert.equal(
    body,
    `Deploy done @${WJ}here, cc @${WJ}oncall and &lt;@${WJ}U123&gt;. Mail ops@example.com. \`@${WJ}here\``,
  );
  const rendered = renderSlackArtifactMessage(answer, 'markdown', footer, [completedFile(0)]);
  for (const text of [JSON.stringify(rendered.blocks), rendered.text]) {
    assert.doesNotMatch(text, LIVE_BROADCAST);
    assert.match(text, /ops@example\.com/);
  }
  // mrkdwn sections auto-parse handles; top-level text needs link_names.
  assert.doesNotMatch(JSON.stringify(rendered.blocks), /(?<![\p{L}\p{N}])@oncall/u);

  // Table cells join the same mrkdwn section as prose.
  const withTable = renderFileBody(answer, 'markdown', footer, 'Owner: @here | Note: <!channel> for @oncall');
  assert.match(withTable, new RegExp(`Owner: @${WJ}here \\| Note: &lt;!channel&gt; for @${WJ}oncall`));
  assert.doesNotMatch(withTable, LIVE_BROADCAST);
});

test('mrkdwn emphasis, image alt text and link labels cannot revive a mention', () => {
  const footer = { agentName: 'Analyst', agentId: 'analyst' };
  const emphasis = 'Ping __@here__, _@channel_ and __@oncall__ now.';
  const labels = [
    '![@here](https://x.test/a.png) ![@oncall](u) [@everyone](nope)',
    '[@_here_](nope) [@`everyone`](all) [@here](https://x.test/p)',
  ].join('\n');
  const inert = [
    `Ping *@${WJ}here*, _@${WJ}channel_ and *@${WJ}oncall* now.`,
    [
      `@${WJ}here @${WJ}oncall @${WJ}everyone`,
      `@${WJ}here @${WJ}everyone <https://x.test/p|@${WJ}here>`,
    ].join('\n'),
  ];
  // File replies canonicalize first; present_details markdown does not.
  assert.deepEqual([emphasis, labels].map((text) => renderFileBody(text, 'markdown', footer)), inert);
  assert.deepEqual([emphasis, labels].map(markdownToSlackMrkdwn), inert);

  // Markup must not fuse an `@` with the word after it.
  const fused = [
    '@![here](https://x.test/a.png) now', '@[here](nope) now', '@[oncall](nope) now',
    '![@](u)here now', '[@](nope)channel now', '@**here** now',
  ];
  const plainMention = /(?<![\p{L}\p{N}]_*)@[\p{L}\p{N}*]/u;
  for (const text of fused) {
    for (const rendered of [renderFileBody(text, 'markdown', footer), markdownToSlackMrkdwn(text)]) {
      assert.doesNotMatch(rendered, plainMention, `${text} -> ${rendered}`);
    }
  }

  // Handles, URL paths and emails that merely contain a broadcast word stay exact.
  const words = 'See https://www.youtube.com/@channel_news, @here_now and ops_@example.com.';
  assert.equal(canonicalSlackMarkdownText(words), words);
  assert.match(
    renderFileBody('[profile](https://medium.com/@here_now)', 'markdown', footer),
    /^<https:\/\/medium\.com\/@here_now\|profile>$/,
  );

  // A model-chosen filename is a mrkdwn link label.
  const named = renderSlackArtifactMessage('Attached.', 'markdown', footer, [
    { ...completedFile(0), filename: '@here.csv' },
  ]);
  assert.match(JSON.stringify(named.blocks), new RegExp(`\\|@${WJ}here\\.csv>`));
});

test('code keeps a special mention readable but inert', () => {
  const answer = [
    'Send `<!here> deploy done` from the bot.',
    '```js',
    "post({ text: '<!channel> @here <!subteam^S1|@ops>' });",
    '```',
    'Then `@here` in prose code stays as written.',
  ].join('\n');

  assert.equal(canonicalSlackMarkdownText(answer), [
    `Send \`<${WJ}!here> deploy done\` from the bot.`,
    '```js',
    `post({ text: '<${WJ}!channel> @here <${WJ}!subteam^S1|@ops>' });`,
    '```',
    'Then `@here` in prose code stays as written.',
  ].join('\n'));
});

test('a streamed prefix withholds a mention until it neutralizes like the whole answer', () => {
  const cases: Array<[string, string]> = [
    ['Heads up <!he', 'Heads up'],
    ['Heads up <!here', 'Heads up'],
    ['Heads up <!here>', `Heads up @${WJ}here`],
    ['Heads up <!subteam^S1|@on', 'Heads up'],
    ['Heads up @', 'Heads up'],
    ['Heads up @Her', 'Heads up'],
    // `@here` can still become `@heresy`, which is not a mention.
    ['Heads up @here', 'Heads up'],
    // A space ends the word as surely as a comma does.
    ['Heads up @here ', `Heads up @${WJ}here`],
    ['Heads up @here,', `Heads up @${WJ}here,`],
    // Any character that cannot continue the word ends it.
    ['Heads up @here<x', `Heads up @${WJ}here`],
    ['Heads up @here[x', `Heads up @${WJ}here`],
    ['Heads up @here\nx', `Heads up @${WJ}here`],
    ['Heads up @here_ x', `Heads up @${WJ}here_`],
    ['Heads up @heresy', 'Heads up @heresy'],
    ['Heads up @ops.', 'Heads up @ops.'],
    // An inline code span may still close, which changes how it neutralizes.
    ['Try `x <!here>', 'Try `x'],
    ['Try `x <!here>` now', `Try \`x <${WJ}!here>\` now`],
    ['Try `x @here', 'Try `x'],
    ['Try `x @here` now', 'Try `x @here` now'],
    // A cut elsewhere cannot split a closed code span carrying a mention.
    ['`@here <x` then', '`'],
    ['Done.\n`<!he', 'Done.\n`'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(streamableSlackMarkdownPrefix(input), expected, JSON.stringify(input));
  }
});

test('a repeated credential marker is held from its first occurrence', () => {
  const input = 'word\nxoxb-xoxb-123456789012345678901234';
  assert.equal(canonicalSlackMarkdownText(input), 'word\n[credential redacted]');
  assert.equal(streamableSlackMarkdownPrefix(input), 'word');
  assert.equal(streamableSlackMarkdownPrefix('word\nxoxb-xoxb-'), 'word');
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

test('markdown finals continue in another message instead of ending in [truncated]', () => {
  const answer = 'x'.repeat(slackMarkdownBlockTextLimit + 50);
  const canonical = canonicalSlackMarkdownText(answer);
  assert.equal(canonical, answer);

  const parts = splitSlackMarkdownReply(canonical);
  assert.equal(parts.length, 2);
  assert.equal(parts.join(''), answer);
  for (const part of parts) {
    const block = renderSlackMessage(part, 'markdown').blocks?.[0];
    assert.equal(block?.type, 'markdown');
    assert.equal(block?.text, part);
    assert.doesNotMatch(block?.text ?? '', /\[truncated]/);
  }
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
  assert.match(comment, /\*GRE:\* \$2,400 &amp; TOEFL: \$800/);
  assert.match(comment, /<https:\/\/example.com\/report\?exam=gre&amp;row=1\|View report>/);
  assert.match(comment, /Unsafe\n\[Malformed\]\(https:\/\/example.com\/&lt;broken/);
  assert.match(comment, /@\u2060channel/);
  assert.match(comment, /\[credential redacted\]/);
  assert.doesNotMatch(comment, new RegExp(`${canary}|javascript:|<!channel>`));
});

test('file replies translate standard Markdown styles across code and links into mrkdwn', () => {
  const markdown = [
    '~~The June `TEST50` sale was the most recent **code explicitly labeled** 50%,',
    'but it was not [the best comparable period](https://example.com/comparison).~~',
    '[Edit: August is the better comparison.]',
  ].join(' ');
  assert.deepEqual(renderSlackMessage(markdown, 'markdown').blocks, [
    { type: 'markdown', text: markdown },
  ]);

  const rendered = renderSlackArtifactMessage(markdown, 'markdown', {
    agentName: 'Analyst', agentId: 'agent_analyst', includeConfigureLink: false,
  }, [completedFile(0)]);
  const first = rendered.blocks?.[0];
  assert.equal(first?.type, 'section');
  if (first?.type !== 'section') return;
  assert.equal(first.text.type, 'mrkdwn');
  assert.equal(first.text.text, [
    '~The June `TEST50` sale was the most recent *code explicitly labeled* 50%,',
    'but it was not <https://example.com/comparison|the best comparable period>.~',
    '[Edit: August is the better comparison.]',
  ].join(' '));
});

test('file reply style conversion leaves code and literal operators unchanged', () => {
  const body = [
    'Native mrkdwn: *bold* _italic_ ~old~.',
    'Operators: 1 ~~ 2, a ~ b, z_k ** 2, and ~/reports.',
    'Inline: `~~old~~ **bold** [docs](https://example.com)`.',
    'Unfinished: ~~draft and **label.',
    'Malformed: ~~~not a strike~~~ and \\~~literal~~.',
    'Escaped closer: ~~keep \\~~ literal.',
    'Even escape: \\\\~~removed~~.',
    'Standard: __bold__ and ~~removed~~.',
  ].join('\n');
  const comment = renderFileBody(body, 'markdown', {
    agentName: 'Analyst', agentId: 'agent_analyst', includeConfigureLink: false,
  });
  assert.equal(comment, [
    'Native mrkdwn: *bold* _italic_ ~old~.',
    'Operators: 1 ~~ 2, a ~ b, z_k ** 2, and ~/reports.',
    'Inline: `~~old~~ **bold** [docs](https://example.com)`.',
    'Unfinished: ~~draft and **label.',
    'Malformed: ~~~not a strike~~~ and \\~~literal~~.',
    'Escaped closer: ~~keep \\~~ literal.',
    'Even escape: \\\\~removed~.',
    'Standard: *bold* and ~removed~.',
  ].join('\n'));
});

test('file reply conversion remains bounded for a full-size malformed delimiter chain', () => {
  const body = '**a '.repeat(3_000).trim();
  const blocks = renderSlackFileBlocks(body, 'markdown', {
    agentName: 'Analyst', agentId: 'agent_analyst', includeConfigureLink: false,
  });
  assert.equal(fileBody(blocks), body);
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
    'literal = "~~keep~~ **this** [link](https://example.com/a_b)"',
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

test('the footer names the coding model only when a coding worker ran on a different model', () => {
  const agentModel = 'openai/gpt-5.6-sol';
  const codingModel = 'anthropic/claude-opus-5-5';
  // No worker ran: the footer is exactly what it was before the coding role.
  assert.equal(replyFooterModelLabel({ agentModel, codingModel, codingWorkerRan: false }), agentModel);
  assert.equal(replyFooterModelLabel({ agentModel, codingWorkerRan: false }), agentModel);
  // Same model on both sides: nothing to attribute.
  assert.equal(
    replyFooterModelLabel({ agentModel, codingModel: agentModel, codingWorkerRan: true }),
    agentModel,
  );
  assert.equal(replyFooterModelLabel({ agentModel: undefined, codingModel, codingWorkerRan: true }), undefined);
  const label = replyFooterModelLabel({ agentModel, codingModel, codingWorkerRan: true });
  assert.equal(label, `${agentModel} · coding: ${codingModel}`);
  assert.equal(
    renderSlackReplyFooterBlock({
      agentName: 'Analyst',
      agentId: 'agent_analyst',
      modelLabel: label,
      includeConfigureLink: false,
    }).elements[0]?.text,
    `Analyst | ${agentModel} · coding: ${codingModel}`,
  );
});
