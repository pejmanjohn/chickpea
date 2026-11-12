import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ConversationStreamChunk } from '@flue/runtime';
import * as v from 'valibot';

import { createWebsiteLogin, normalizeWebsiteLoginHost, WEBSITE_LOGINS_SETTING } from '../src/browser/logins.ts';
import type { AXNode } from '../src/browser/page.ts';
import { browserHandoffMessage } from '../src/browser/requester.ts';
import { createBrowserTools } from '../src/browser/tools.ts';
import { BrowserTurnSession } from '../src/browser/turn-session.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore, type SettingsStore } from '../src/config/settings-store.ts';
import { runReviewError, startRunReview, type RunReviewEnding } from '../src/review/capture.ts';
import { configureRunReview, type RunReviewPort } from '../src/review/port.ts';
import {
  buildRunReviewRecord,
  RUN_REVIEW_FIELD_BYTES,
  runReviewPseudonymizer,
  type RunReviewInput,
  type RunReviewRecordV1,
} from '../src/review/record.ts';
import {
  BROWSER_LINK_OMITTED,
  RunReviewScrubLimit,
  websiteLoginScrub,
  type RunReviewWebsiteLogins,
} from '../src/review/website-logins.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { toContextMessage } from '../src/slack/thread-context.ts';
import { FakeCdpSocket, fakeBrowserProvider } from './helpers/fake-cdp-socket.ts';

const KEY = new Uint8Array(32).fill(7);
const INSTALLATION = 'inst_review';
const HOSTED_ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: INSTALLATION });
const SUBMISSION = 'sub_review';
const USERNAME = 'Ops.Synthetic@example.com';
const LOGINS: RunReviewWebsiteLogins = {
  hosts: ['billing.example.com', 'ledger.example.net'],
  usernames: [USERNAME, 'ledger.synthetic@example.com'],
};
const LIVE_VIEW_URL = 'https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=connect.browserbase.com/debug/SYNTHSESS/devtools/page/SYNTHPAGE&debug=true';

function copy(overrides: Partial<RunReviewInput>, websiteLogins: RunReviewWebsiteLogins = LOGINS): RunReviewRecordV1 {
  return buildRunReviewRecord({
    runId: 'run_review',
    recordedAt: '2026-11-10T12:00:00.000Z',
    surface: 'dm',
    agentId: 'agent_review',
    trigger: { author: 'U012ABCDEF3', text: 'Check the invoice.', files: [] },
    context: [],
    steps: [],
    outcome: 'succeeded',
    timings: { settledAt: '2026-11-10T12:00:01.000Z' },
    truncated: false,
    source: 'stream',
    websiteLogins,
    browserStepsWithheld: false,
    ...overrides,
  }, runReviewPseudonymizer(KEY));
}

/** Which of `values` any field of the record still holds, in any case. */
function kept(record: RunReviewRecordV1, values: readonly string[]): string[] {
  const text = JSON.stringify(record).toLowerCase();
  return values.filter((value) => text.includes(value.toLowerCase()));
}

const browserStep = (name: string, input: unknown, output: unknown) =>
  ({ kind: 'tool' as const, name, input: JSON.stringify(input), output: JSON.stringify(output) });

/** `base` with a username and a password, as the URL standard's setters write them. */
function address(base: string, username: string, password = ''): string {
  const url = new URL(base);
  url.username = username;
  url.password = password;
  return url.href;
}

test('link rules see each URL whole, before a username or a key replacement can end it early', () => {
  const key = ['sb', 'live', 'synthKey0123456789'].join('_');
  const record = copy({
    trigger: {
      author: 'U012ABCDEF3',
      text: 'I landed on https://billing.example.com/callback?login_hint=Ops.Synthetic@example.com&code=SYNTHCODE123&state=SYNTHSTATE456',
      files: [],
    },
    steps: [
      { kind: 'tool', name: 'save_connection_key', input: JSON.stringify({ connectionId: 'billing', key }), output: '{}' },
      browserStep(
        'browser_open',
        { url: 'https://billing.example.com/u/Ops.Synthetic@example.com/callback?code=SYNTHCODE123' },
        { url: 'https://billing.example.com/callback?login_hint=Ops.Synthetic@example.com&code=SYNTHCODE123', title: 'Billing' },
      ),
    ],
    answer: `Done: https://billing.example.com/api?key=${key}&state=SYNTHSTATE456`,
  });
  assert.deepEqual(kept(record, ['SYNTHCODE123', 'SYNTHSTATE456', 'synthKey0123456789', 'ops.synthetic']), []);
  assert.equal(record.trigger.text, 'I landed on https://billing.example.com/callback?[omitted]');
  assert.equal(record.answer, 'Done: https://billing.example.com/api?[omitted]');
  const opened = record.steps[1]?.kind === 'tool' ? record.steps[1] : undefined;
  assert.equal(opened?.input, '{"url":"https://billing.example.com/u/[omitted]/callback?[omitted]"}');

  const hostWord = copy({ answer: 'See https://billing.example.com/callback?code=SYNTHCODE123' },
    { hosts: ['billing.example.com'], usernames: ['billing'] });
  assert.equal(hostWord.answer, 'See https://[credential redacted].example.com/callback?[omitted]',
    'a username that is part of the host replaces only that word, after the URL lost its query');
});

test('a URL on a login\'s site, or any URL in a browser step, keeps its scheme, host and path words, and loses its query', () => {
  const record = copy({
    trigger: {
      author: 'U012ABCDEF3',
      text: 'Use <http://billing.example.com/magic?token=SYNTHMAGIC0123|billing.example.com/magic?token=SYNTHMAGIC0123> ' +
        'or https://ops:SYNTHPASS@search.example/x, and see https://search.example/?q=kept#top',
      files: [],
    },
    context: [{ author: 'U012ABCDEF3', role: 'human', text: 'Reset: https://ledger.example.net/reset/SYNTHRESETTOKEN0123456789', files: [] }],
    steps: [
      browserStep('browser_open', { url: 'docs.example.org/guide?session=SYNTHGUIDE42' }, {
        url: 'https://app.billing.example.com/home;jsessionid=SYNTHSESSION0123456789?tab=1',
        snapshot: '- link "Search" [ref=e1]',
      }),
      browserStep('browser_snapshot', {}, { url: 'https://search.example/?q=kept#top' }),
    ],
    answer: 'Signed in: https://billing.example.com/callback#access_token=SYNTHTOKEN789 ' +
      'Help: https://billing.example.com/help/how-to-update-your-billing-address and /invoices/INV-2041. ' +
      'Public: https://search.example/?q=kept#top. Elsewhere: https://auth.example.com/magic?token=PERSONS-OWN-LINK',
  });
  assert.deepEqual(kept(record, [
    'SYNTHMAGIC0123', 'SYNTHPASS', 'SYNTHRESETTOKEN', 'SYNTHGUIDE42', 'SYNTHSESSION', 'SYNTHTOKEN789',
  ]), []);
  assert.equal(record.trigger.text, 'Use <http://billing.example.com/magic?[omitted]> ' +
    'or https://search.example/x, and see https://search.example/?q=kept#top');
  assert.equal(record.context[0]?.text, 'Reset: https://ledger.example.net/reset/[omitted]');
  const [opened, snapshot] = record.steps;
  assert.ok(opened?.kind === 'tool' && snapshot?.kind === 'tool');
  assert.equal(opened.input, '{"url":"docs.example.org/guide?[omitted]"}');
  assert.match(opened.output ?? '', /"url":"https:\/\/app\.billing\.example\.com\/home\?\[omitted\]"/);
  assert.equal(snapshot.output, '{"url":"https://search.example/?[omitted]"}', 'in a browser step every URL loses its query');
  assert.equal(record.answer, 'Signed in: https://billing.example.com/callback?[omitted] ' +
    'Help: https://billing.example.com/help/[omitted] and /invoices/INV-2041. ' +
    'Public: https://search.example/?q=kept#top. Elsewhere: https://auth.example.com/magic?token=PERSONS-OWN-LINK',
  'a login site\'s slug goes, and a path outside a link, a public query and another site\'s link a person shares stay');
});

test('a URL on a login\'s site, or any URL in a browser step, keeps a path segment only where it is a word of up to 20 letters', () => {
  // A site may take any short path segment as its sign-in bearer, so length is no proof a segment is safe.
  const record = copy({
    trigger: {
      author: 'U012ABCDEF3',
      text: 'Use https://billing.example.com/magic/k7Qx2 or <https://billing.example.com/m/48213|Sign in> or ' +
        'billing.example.com/invoices/2041/a1b2c3, then https://billing.example.com/account/settings. ' +
        'Public: https://search.example/s/k7Qx2/48213/how-to-pay',
      files: [],
    },
    steps: [browserStep('browser_open', { url: 'https://docs.example.org/guide/k7Qx2/12345' }, {
      url: 'https://docs.example.org/Guide/v2/2041?tab=1',
      title: 'Docs',
    })],
    answer: 'Then https://ledger.example.net/r/1234/12345/abcdefghijklmnopqrst/abcdefghijklmnopqrstu/how-to-pay ' +
      '(see https://billing.example.com/help).',
  });
  assert.deepEqual(kept(record, ['k7Qx2', '12345', '48213', '2041', '1234', 'a1b2c3', 'abcdefghijklmnopqrstu', 'v2']), [
    'k7Qx2', '48213',
  ], 'only the public link keeps its segments');
  assert.equal(record.trigger.text, 'Use https://billing.example.com/magic/[omitted] or <https://billing.example.com/m/[omitted]|Sign in> or ' +
    'billing.example.com/invoices/[omitted]/[omitted], then https://billing.example.com/account/settings. ' +
    'Public: https://search.example/s/k7Qx2/48213/how-to-pay');
  const [opened] = record.steps;
  assert.ok(opened?.kind === 'tool');
  assert.equal(opened.input, '{"url":"https://docs.example.org/guide/[omitted]/[omitted]"}');
  assert.equal(opened.output, '{"url":"https://docs.example.org/Guide/[omitted]/[omitted]?[omitted]","title":"Docs"}');
  assert.equal(record.answer, 'Then https://ledger.example.net/r/[omitted]/[omitted]/abcdefghijklmnopqrst/[omitted]/[omitted] ' +
    '(see https://billing.example.com/help).');
});

test('a login site\'s or a browser step\'s path keeps no segment with a mark inside it, and `|` divides one only before a Slack link\'s label', () => {
  // `shorttoken!` and `short|token` are whole segments a site may take as its bearer. Only the end of the whole link is a sentence's.
  const links = 'https://billing.example.com/magic/shorttoken!/done https://billing.example.com/magic/short|token ' +
    'https://billing.example.com/magic/7391';
  const scrubbed = 'https://billing.example.com/magic/[omitted]/done https://billing.example.com/magic/[omitted] ' +
    'https://billing.example.com/magic/[omitted]';
  const record = copy({
    trigger: {
      author: 'U012ABCDEF3',
      text: `Use ${links}. Or <https://billing.example.com/m/48213|Sign in>, <https://billing.example.com|billing>, ` +
        '<billing.example.com/magic/short|token> or <https://billing.example.com/cb?code=SYNTHCODE123|Done>!',
      files: [],
    },
    context: [{ author: 'U012ABCDEF3', role: 'human', text: links, files: [] }],
    steps: [browserStep('browser_snapshot', {}, {
      url: 'https://billing.example.com/magic/shorttoken!',
      snapshot: `- text "${links} <https://docs.example.org/magic/short|token> https://docs.example.org/a/b!/c."`,
    })],
    answer: `See ${links}, then https://billing.example.com/help/billing! or (https://billing.example.com/magic/7391).`,
  });
  assert.equal(record.trigger.text, `Use ${scrubbed}. Or <https://billing.example.com/m/[omitted]|Sign in>, ` +
    '<https://billing.example.com|billing>, <billing.example.com/magic/short|token> or <https://billing.example.com/cb?[omitted]>!',
  'in Slack\'s markup a label follows the first `|` before the query, and the URL before it keeps only words');
  assert.equal(record.context[0]?.text, scrubbed);
  const [shown] = record.steps;
  assert.ok(shown?.kind === 'tool');
  assert.deepEqual(JSON.parse(shown.output ?? '{}'), {
    url: 'https://billing.example.com/magic/shorttoken!',
    snapshot: `- text "${scrubbed} <https://docs.example.org/magic/[omitted]> https://docs.example.org/a/[omitted]/c."`,
  }, 'a browser step reads no Slack label, and the marks that end a link stay after its last word');
  assert.equal(record.answer, `See ${scrubbed}, then https://billing.example.com/help/billing! or (https://billing.example.com/magic/[omitted]).`);
});

test('a delimiter percent decoding wrote is the address\'s data, so a path segment that holds one goes whole, in every field', () => {
  // A site builds one segment from a bearer with encodeURIComponent, and a server that matches `/magic/:token/done`
  // decodes it whole: `SynthAlpha/SynthBravo` is one bearer, not two words.
  const link = (inside: string, host = 'billing.example.com') => `https://${host}/magic/SynthAlpha${inside}SynthBravo/done`;
  const inside = ['%2F', '%3F', '%23', '%3B', '%26', '%3D', '%252F', '&percnt;2F', `${'\\'}u00252F`];
  const links = inside.map((escape) => link(escape)).join(' ');
  const scrubbed = inside.map(() => 'https://billing.example.com/magic/[omitted]/done').join(' ');
  const whole = encodeURIComponent(link('%2F'));
  const record = copy({
    trigger: { author: 'U012ABCDEF3', text: `Use ${links}.`, files: [] },
    context: [{ author: 'U012ABCDEF3', role: 'human', text: `<${link('%2F')}|Sign in> or billing.example.com/magic/SynthAlpha%2FSynthBravo`, files: [] }],
    steps: [
      browserStep('browser_open', { url: link('%2F') }, { url: link('%2F', 'accounts.other.example'), title: 'Signed in' }),
      { kind: 'tool', name: 'read_mail', input: '{}', output: JSON.stringify(JSON.stringify({ text: links })) },
    ],
    answer: `See ${whole} or https://other.example/redirect?next=${encodeURIComponent(whole)} today`,
  });
  assert.deepEqual(kept(record, ['SynthAlpha', 'SynthBravo']), []);
  assert.equal(record.trigger.text, `Use ${scrubbed}.`);
  assert.equal(record.context[0]?.text, '<https://billing.example.com/magic/[omitted]/done|Sign in> or billing.example.com/magic/[omitted]');
  const [opened, mail] = record.steps;
  assert.ok(opened?.kind === 'tool' && mail?.kind === 'tool');
  assert.equal(opened.input, '{"url":"https://billing.example.com/magic/[omitted]/done"}');
  assert.equal(opened.output, '{"url":"https://accounts.other.example/magic/[omitted]/done","title":"Signed in"}');
  assert.equal(JSON.parse(JSON.parse(mail.output ?? '""')).text, scrubbed);
  assert.equal(record.answer, 'See https:%2F%2Fbilling.example.com[omitted] or ' +
    'https://other.example/redirect?next=https:%2F%2Fbilling.example.com[omitted] today',
  'past the host of an address percent-encoded whole, all of it is one segment');
});

test('a URL on an IDN login site loses its token whatever form the URL and the saved site are written in, with a scheme or without', () => {
  const site = normalizeWebsiteLoginHost('bücher.example');
  assert.equal(site, 'xn--bcher-kva.example', 'the catalog saves the ASCII form');
  // A plan may hold a site as it was typed, before the catalog read it.
  const logins: RunReviewWebsiteLogins = { hosts: [site, 'café.example'], usernames: [] };
  const [wideB, wideDot, ideographicDot, alef] = [0xff42, 0xff0e, 0x3002, 0x5d0].map((point) => String.fromCodePoint(point));
  const wideWww = String.fromCodePoint(0xff57).repeat(3);
  const record = copy({
    trigger: {
      author: 'U012ABCDEF3',
      text: 'Open https://bücher.example/cb?code=SYNTHIDN01 or bücher.example/cb?code=SYNTHIDN02 or ' +
        'https://BÜCHER.example./cb?code=SYNTHIDN03 or shop.bücher.example/r/cb?code=SYNTHIDN04 or ' +
        `${wideB}ücher${wideDot}example/cb?code=SYNTHIDN05 or bücher${ideographicDot}example/cb?code=SYNTHIDN06 or ` +
        'https://b%C3%BCcher.example/cb?code=SYNTHIDN07 or b%C3%BCcher.example/cb?code=SYNTHIDN08 or ' +
        'https://XN--BCHER-KVA.example/cb?code=SYNTHIDN09 or xn--caf-dma.example/cb?code=SYNTHIDN10. ' +
        // Letters a URL refuses to put together in one name: a Latin then a Hebrew one.
        `Elsewhere https://ab${alef}.example/cb?code=SYNTHIDN16. Public: https://straße.example/s?q=kept and пример.рф/s?q=kept`,
      files: [],
    },
    steps: [browserStep('browser_open', { url: 'bücher.example/cb?code=SYNTHIDN11' }, {
      url: 'https://bücher.example/cb?code=SYNTHIDN12',
      snapshot: '- link "Next": пример.рф/s?q=SYNTHIDN13 example.xn--p1ai/s?q=SYNTHIDN14',
    })],
    answer: 'Signed in at <https://café.example/home?session=SYNTHIDN15|café.example>. ' +
      `Watch at ${wideWww}.browserbase.com/sessions/SYNTHIDN17`,
  }, logins);
  assert.deepEqual(kept(record, ['SYNTHIDN']), []);
  assert.equal(record.trigger.text,
    'Open https://bücher.example/cb?[omitted] or bücher.example/cb?[omitted] or ' +
    'https://BÜCHER.example./cb?[omitted] or shop.bücher.example/r/cb?[omitted] or ' +
    '[omitted]/cb?[omitted] or [omitted]/cb?[omitted] or ' +
    'https://bücher.example/cb?[omitted] or bücher.example/cb?[omitted] or ' +
    'https://XN--BCHER-KVA.example/cb?[omitted] or xn--caf-dma.example/cb?[omitted]. ' +
    'Elsewhere https://[omitted]/cb?[omitted]. Public: https://straße.example/s?q=kept and пример.рф/s?q=kept',
  'a percent-encoded host comes back decoded; one written in a form a link does not show as itself (a fullwidth or ' +
  'ideographic full stop), or that no URL can hold, goes');
  const [opened] = record.steps;
  assert.ok(opened?.kind === 'tool');
  assert.equal(opened.input, '{"url":"bücher.example/cb?[omitted]"}');
  assert.deepEqual(JSON.parse(opened.output ?? '{}'), {
    url: 'https://bücher.example/cb?[omitted]',
    snapshot: '- link "Next": пример.рф/s?[omitted] example.xn--p1ai/s?[omitted]',
  });
  assert.equal(record.answer, `Signed in at <https://café.example/home?[omitted]>. Watch at ${BROWSER_LINK_OMITTED}`);
});

test('an address percent-encoded whole is still one address, and a rewritten link writes each delimiter decoding wrote as its escape again', () => {
  const record = copy({
    answer: [
      // The decoded `/` after the host ends it, so the `@` of an email address in the path starts no host.
      encodeURIComponent('https://billing.example.com/u/ops@example.com/cb?code=SYNTHWHOLE1'),
      encodeURIComponent('billing.example.com/cb?code=SYNTHWHOLE2'),
      encodeURIComponent('http://127.0.0.1:9222/devtools/inspector.html?ws=127.0.0.1:9222/devtools/page/SYNTHWHOLE3'),
      // Another site's query keeps its meaning when a link inside it is rewritten.
      'https://other.example/r?note=a%26b%3Dc%3Bd%2Fe%3Ff%23g&next=https://billing.example.com/cb?code=SYNTHWHOLE4',
    ].join(' '),
  });
  assert.deepEqual(kept(record, ['SYNTHWHOLE']), []);
  assert.equal(record.answer, `https:%2F%2Fbilling.example.com[omitted] billing.example.com[omitted] ${BROWSER_LINK_OMITTED} ` +
    'https://other.example/r?note=a%26b%3Dc%3Bd%2Fe%3Ff%23g&next=https://billing.example.com/cb?[omitted]');
});

test('a saved site reads without one leading `www.`, and any host under it is that site, so the address bar\'s form of its link loses its token', () => {
  // A browser's address bar hides `www.`, and a person or an Agent may copy the address as it shows it.
  const bucher = normalizeWebsiteLoginHost('www.bücher.example');
  assert.equal(bucher, 'www.xn--bcher-kva.example');
  // `www.example` has only one label past `www.`, so it stays whole: `other.example` is no host under it.
  const logins: RunReviewWebsiteLogins = { hosts: ['www.billing.example.com', bucher, 'www.example'], usernames: [] };
  const text = 'Open billing.example.com/callback?code=SYNTHWWW1 or https://billing.example.com/cb#t=SYNTHWWW2 or ' +
    'https://www.billing.example.com/magic/SYNTHWWW3 or accounts.billing.example.com/cb?code=SYNTHWWW4 or ' +
    '<https://login.billing.example.com/cb?code=SYNTHWWW5|Done> or bücher.example/cb?code=SYNTHWWW6 or ' +
    'https://m.billing.example.com/cb?code=SYNTHWWW7. Public: https://other.example/s?q=kept and https://billing.example.org/s?q=kept';
  const scrubbed = 'Open billing.example.com/callback?[omitted] or https://billing.example.com/cb?[omitted] or ' +
    'https://www.billing.example.com/magic/[omitted] or accounts.billing.example.com/cb?[omitted] or ' +
    '<https://login.billing.example.com/cb?[omitted]> or bücher.example/cb?[omitted] or ' +
    'https://m.billing.example.com/cb?[omitted]. Public: https://other.example/s?q=kept and https://billing.example.org/s?q=kept';
  const record = copy({
    trigger: { author: 'U012ABCDEF3', text, files: [] },
    context: [{ author: 'Billing Agent', role: 'agent', text, files: [] }],
    answer: JSON.stringify({ text }),
  }, logins);
  assert.deepEqual(kept(record, ['SYNTHWWW']), []);
  assert.equal(record.trigger.text, scrubbed);
  assert.equal(record.context[0]?.text, scrubbed);
  assert.equal(JSON.parse(record.answer ?? '{}').text, scrubbed);
});

test('a link on an IDN login site in JSON that keeps to ASCII loses its token, and comes back as JSON reads it while one kept stays as written', () => {
  // Python's json.dumps writes every character past ASCII as an escape, so a connector's result may hold a host that way.
  const asciiJson = (value: unknown) => JSON.stringify(value)
    .replace(/[^\0-~]/g, (unit) => `${'\\'}u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const alef = String.fromCodePoint(0x5d0);
  const mail = asciiJson({
    text: 'Reset at https://bücher.example/reset?token=SYNTHIDN21, bücher.example/cb?code=SYNTHIDN22 or ' +
      `https://über.bücher.example/x?code=SYNTHIDN23 or https://${alef}a.example/cb?code=SYNTHIDN25. ` +
      'Menu: https://café.example/menu?item=kept',
  });
  const page = asciiJson({ snapshot: '- text "über.example/s?q=SYNTHIDN24"' });
  assert.equal(/[^\0-~]/.test(mail + page), false, 'the test text holds escapes only');
  const record = copy({
    steps: [
      { kind: 'tool', name: 'read_mail', input: '{}', output: mail },
      { kind: 'tool', name: 'browser_snapshot', input: '{}', output: page },
    ],
  }, { hosts: [normalizeWebsiteLoginHost('bücher.example')], usernames: [] });
  assert.deepEqual(kept(record, ['SYNTHIDN']), []);
  const [read, shown] = record.steps;
  assert.ok(read?.kind === 'tool' && shown?.kind === 'tool');
  // A link the rules rewrite comes back as they read it, without the escapes JSON need not write. A link they keep
  // stays as written.
  assert.equal(read.output, JSON.stringify({
    text: 'Reset at https://bücher.example/reset?[omitted], bücher.example/cb?[omitted] or ' +
      'https://über.bücher.example/x?[omitted] or https://[omitted]/cb?[omitted]. Menu: https://café.example/menu?item=kept',
  }).replace('é', '\\u00e9'), 'each link keeps its host, but for one no URL can hold');
  assert.equal(shown.output, JSON.stringify({ snapshot: '- text "über.example/s?[omitted]"' }));
});

test('a login site\'s link with JSON escapes of its ASCII characters, escaped once or twice, loses its token in every field', () => {
  // A serializer may escape any character, and one that escapes a field again doubles each backslash.
  const escape = (char: string, backslashes: number) => `${'\\'.repeat(backslashes)}u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
  const links = (backslashes: number) => {
    const e = (char: string) => escape(char, backslashes);
    return `https://${e('b')}illing.example.com/cb?code=SYNTHESC1 https://billing${e('.')}example.com/cb?code=SYNTHESC2 ` +
      `${e('b')}illing.example.com/cb?code=SYNTHESC3 ` +
      `https:${e('/')}${e('/')}billing.example.com${e('/')}cb${e('?')}code=SYNTHESC4 ${e('/')}${e('/')}ledger${e('.')}example.net/r?t=SYNTHESC5`;
  };
  const scrubbed = (backslashes: number) => 'https://billing.example.com/cb?[omitted] https://billing.example.com/cb?[omitted] ' +
    'billing.example.com/cb?[omitted] https://billing.example.com/cb?[omitted] ' +
    `${escape('/', backslashes)}${escape('/', backslashes)}ledger.example.net/r?[omitted]`;
  assert.equal(JSON.parse(`"${links(1)}"`), 'https://billing.example.com/cb?code=SYNTHESC1 https://billing.example.com/cb?code=SYNTHESC2 ' +
    'billing.example.com/cb?code=SYNTHESC3 https://billing.example.com/cb?code=SYNTHESC4 //ledger.example.net/r?t=SYNTHESC5',
  'JSON reads each escaped link as the login site\'s');
  const record = copy({
    context: [{ author: 'U012ABCDEF3', role: 'human', text: links(2), files: [] }],
    steps: [
      { kind: 'tool', name: 'browser_snapshot', input: '{}', output: `{"url":"${links(1)}"}` },
      { kind: 'tool', name: 'read_mail', input: '{}', output: JSON.stringify({ text: `{"url":"${links(1)}"}` }) },
    ],
    answer: links(1),
  });
  assert.deepEqual(kept(record, ['SYNTHESC']), []);
  assert.equal(record.answer, scrubbed(1));
  assert.equal(record.context[0]?.text, scrubbed(2));
  const [shown, read] = record.steps;
  assert.ok(shown?.kind === 'tool' && read?.kind === 'tool');
  assert.equal(shown.output, `{"url":"${scrubbed(1)}"}`);
  assert.equal(JSON.parse(read.output ?? '{}').text, `{"url":"${scrubbed(1)}"}`);
});

test('a link reads as NFKC without default-ignorable characters, so a decomposed, fullwidth or soft-hyphenated login site loses its token', () => {
  const [diaeresis, softHyphen, zeroWidthSpace, selector, wordJoiner] = [0x308, 0xad, 0x200b, 0xfe0f, 0x2060]
    .map((point) => String.fromCodePoint(point));
  const wide = (text: string) => text.replace(/[!-~]/g, (char) => String.fromCodePoint(char.charCodeAt(0) + 0xfee0));
  const logins: RunReviewWebsiteLogins = {
    hosts: ['bücher.example', 'billing.example.com', 'billing.bücher'].map(normalizeWebsiteLoginHost),
    usernames: [],
  };
  assert.deepEqual(logins.hosts, ['xn--bcher-kva.example', 'billing.example.com', 'billing.xn--bcher-kva']);
  const links = `bu${diaeresis}cher.example/cb?code=SYNTHNFKC1 https://bu${diaeresis}cher.example/cb?code=SYNTHNFKC2 ` +
    `bill${softHyphen}ing.example.com/cb?code=SYNTHNFKC3 https://bill${zeroWidthSpace}ing.example.com/cb?code=SYNTHNFKC4 ` +
    `billing${selector}.example.com/cb?code=SYNTHNFKC5 bill${wordJoiner}ing.example.com/cb?code=SYNTHNFKC6 ` +
    `${wide('billing')}.example.com/cb${wide('?')}code=SYNTHNFKC7 billing.bu${diaeresis}cher/cb?code=SYNTHNFKC8 ` +
    // A soft hyphen as a JSON escape, and a mark no label may start with, which no URL can hold.
    `bill${'\\'}u00ading.example.com/cb?code=SYNTHNFKC9 ${diaeresis}billing.example.com/cb?code=SYNTHNFKC10`;
  const scrubbed = 'bücher.example/cb?[omitted] https://bücher.example/cb?[omitted] ' +
    'billing.example.com/cb?[omitted] https://billing.example.com/cb?[omitted] ' +
    'billing.example.com/cb?[omitted] billing.example.com/cb?[omitted] ' +
    'billing.example.com/[omitted] billing.bücher/cb?[omitted] ' +
    'billing.example.com/cb?[omitted] [omitted]/cb?[omitted]';
  // Text around a link stays as written, whatever NFKC would make of it. A fullwidth `?` or `)` is no query mark or
  // sentence mark: a browser reads it as part of the path.
  const around = `${wide('See')} ❤${selector} (${wide('billing')}.example.com/cb?code=SYNTHNFKC12${wide(')')} ${wide('now')}${softHyphen}.`;
  const record = copy({
    context: [{ author: 'U012ABCDEF3', role: 'human', text: links, files: [] }],
    steps: [{ kind: 'tool', name: 'browser_snapshot', input: '{}', output: `${links} shop.exa${diaeresis}mple/x?q=SYNTHNFKC11` }],
    answer: `${links} ${around}`,
  }, logins);
  assert.deepEqual(kept(record, ['SYNTHNFKC']), []);
  assert.equal(record.answer, `${scrubbed} ${wide('See')} ❤${selector} (billing.example.com/cb?[omitted] ${wide('now')}${softHyphen}.`,
    'a link comes back as the rules read it, and only its own characters go');
  assert.equal(record.context[0]?.text, scrubbed);
  const [shown] = record.steps;
  assert.ok(shown?.kind === 'tool');
  assert.equal(shown.output, `${scrubbed} shop.exämple/x?[omitted]`, 'in a browser step a decomposed top-level label reads as a name');

  // NFKC can lengthen text, as a ligature becomes two letters, and the link after it is still replaced where it was written.
  const ligatures = String.fromCodePoint(0xfb01).repeat(64);
  const escapedThenLonger = `{"note":"${'\\'}u0041 ${ligatures} billing.example.com/cb?code=SYNTHNFKC13 ${ligatures}"}`;
  const lengthened = copy({ steps: [{ kind: 'tool', name: 'read_mail', input: '{}', output: escapedThenLonger }] }, logins);
  assert.equal(lengthened.steps[0]?.kind === 'tool' && lengthened.steps[0].output,
    `{"note":"${'\\'}u0041 ${ligatures} billing.example.com/cb?[omitted] ${ligatures}"}`);
});

test('NFKC never ends, splits or hides a link the written text does not', () => {
  // A character NFKC turns into whitespace or ASCII punctuation is read as written, as a browser reads it in a link.
  const [diaeresis, acute, wideQuote, wideLess, wideGreater, wideBackslash, wideSolidus, wideBar, wideLowLine, wideAt] =
    [0xa8, 0xb4, 0xff02, 0xff1c, 0xff1e, 0xff3c, 0xff0f, 0xff5c, 0xff3f, 0xff20].map((point) => String.fromCodePoint(point));
  const marks = [diaeresis, acute, wideQuote, wideLess, wideGreater, wideBackslash];
  const links = `${marks.map((mark, index) => `https://billing.example.com/cb${mark}x?code=SYNTHSTRUCT${index}`).join(' ')} ` +
    `https://billing.example.com/magic/short${wideSolidus}token ${wideLowLine}billing.example.com/cb?code=SYNTHSTRUCT6 ` +
    `${wideAt}billing.example.com/cb?code=SYNTHSTRUCT7`;
  const scrubbed = `${marks.map(() => 'https://billing.example.com/[omitted]?[omitted]').join(' ')} ` +
    `https://billing.example.com/magic/[omitted] ${wideLowLine}billing.example.com/cb?[omitted] ${wideAt}billing.example.com/cb?[omitted]`;
  // Nor does NFKC take one away: `<` and a combining long solidus would be `≮`, and Slack's markup would be gone.
  const handoff = `<${String.fromCodePoint(0x338)}https://live.provider.example/s/SYNTHLIVE|Open the browser>`;
  const record = copy({
    trigger: { author: 'U012ABCDEF3', text: `${links} <https://billing.example.com/cb${wideBar}x?code=SYNTHSTRUCT8>`, files: [] },
    context: [{ author: 'Billing Agent', role: 'agent', text: handoff, files: [] }],
    steps: [{ kind: 'tool', name: 'browser_snapshot', input: '{}', output: links }],
    answer: links,
  });
  assert.deepEqual(kept(record, ['SYNTHSTRUCT', 'short' + wideSolidus + 'token', 'SYNTHLIVE']), []);
  assert.equal(record.context[0]?.text, BROWSER_LINK_OMITTED);
  assert.equal(record.answer, scrubbed);
  assert.equal(record.trigger.text, `${scrubbed} <https://billing.example.com/[omitted]?[omitted]>`,
    'a fullwidth bar is no Slack label\'s');
  const [shown] = record.steps;
  assert.ok(shown?.kind === 'tool');
  assert.equal(shown.output, scrubbed);
});

test('an IP host compares with a login\'s site as a URL reads it, and a scheme-less IP link counts in a browser step', () => {
  const logins: RunReviewWebsiteLogins = { hosts: ['127.1', '[::1]'].map(normalizeWebsiteLoginHost), usernames: [] };
  assert.deepEqual(logins.hosts, ['127.0.0.1', '[::1]'], 'the catalog saves each IP host in the form a URL gives it');
  const links = 'https://127.1/cb?code=SYNTHIP1 https://0x7f000001/cb?code=SYNTHIP2 https://2130706433/cb?code=SYNTHIP3 ' +
    'https://0177.0.0.1/cb?code=SYNTHIP4 127.0.0.1/cb?code=SYNTHIP5 [::1]:443/cb?code=SYNTHIP6 ' +
    'https://[0:0:0:0:0:0:0:1]/cb?code=SYNTHIP7 127.1/cb?code=SYNTHIP8';
  const scrubbed = 'https://127.1/cb?[omitted] https://0x7f000001/cb?[omitted] https://2130706433/cb?[omitted] ' +
    'https://0177.0.0.1/cb?[omitted] 127.0.0.1/cb?[omitted] [::1]:443/cb?[omitted] ' +
    'https://[0:0:0:0:0:0:0:1]/cb?[omitted] 127.1/cb?[omitted]';
  // Another address: its link without a scheme keeps its query in prose, as another site's link does.
  const elsewhere = '10.0.0.5/cb?q=kept [fd00::5]/cb?q=kept';
  const record = copy({
    context: [{ author: 'U012ABCDEF3', role: 'human', text: `${links} ${elsewhere}`, files: [] }],
    steps: [{
      kind: 'tool', name: 'browser_snapshot', input: '{}',
      output: `${links} 10.0.0.5/cb?code=SYNTHIP9 [fd00::5]:8443/cb?code=SYNTHIP10 10.5/cb?q=kept`,
    }],
    answer: `${links} ${elsewhere}`,
  }, logins);
  assert.deepEqual(kept(record, ['SYNTHIP']), []);
  assert.equal(record.answer, `${scrubbed} ${elsewhere}`);
  assert.equal(record.context[0]?.text, `${scrubbed} ${elsewhere}`);
  const [shown] = record.steps;
  assert.ok(shown?.kind === 'tool');
  assert.equal(shown.output, `${scrubbed} 10.0.0.5/cb?[omitted] [fd00::5]:8443/cb?[omitted] 10.5/cb?q=kept`,
    'in a browser step an IPv4 address in four decimal parts or a bracketed IPv6 one is a link\'s host, and another spelling is one only on a login\'s site');
});

test('a page\'s address keeps its \' and |, and a JSON-escaped & or =, inside the URL a copy cuts', () => {
  // A connector's text result that another program serialized: Go and Gson write `&` and `=` as JSON escapes.
  const escaped = (char: string) => `${'\\'}u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
  const mail = `{"link":"https://billing.example.com/magic?email=a${escaped('&')}token${escaped('=')}SYNTHMAGIC0123","next":"x"}`;
  assert.equal(mail.includes('&') || mail.includes('token='), false, 'the test text holds the escapes');
  const record = copy({
    steps: [
      browserStep('browser_open', { url: 'https://portal.example.org/users/o\'brien/callback?code=SYNTHCODE123' }, {
        url: 'https://billing.example.com/callback?scope=read|write&code=SYNTHCODE123',
        snapshot: '- link "Search" [ref=e1]',
      }),
      { kind: 'tool', name: 'read_mail', input: '{}', output: JSON.stringify({ text: mail }) },
    ],
  });
  assert.deepEqual(kept(record, ['SYNTHCODE123', 'SYNTHMAGIC0123']), []);
  const [opened, read] = record.steps;
  assert.ok(opened?.kind === 'tool' && read?.kind === 'tool');
  assert.equal(opened.input, '{"url":"https://portal.example.org/users/[omitted]/callback?[omitted]"}');
  assert.match(opened.output ?? '', /"url":"https:\/\/billing\.example\.com\/callback\?\[omitted\]"/);
  assert.equal(JSON.parse(read.output ?? '{}').text, '{"link":"https://billing.example.com/magic?[omitted]","next":"x"}');
});

test('in prose and Slack text a URL keeps its \' and |, a link inside another goes by its own rule, and a Browserbase link needs no scheme', () => {
  const record = copy({
    trigger: {
      author: 'U012ABCDEF3',
      text: 'Try https://billing.example.com/users/o\'brien/callback?code=SYNTHCODE123 and ' +
        '<https://billing.example.com/cb?scope=read|write&code=SYNTHCODE456|callback>',
      files: [],
    },
    context: [{
      author: 'U012ABCDEF3', role: 'human', files: [],
      text: '<https://go.example.org/r|https://billing.example.com/cb?code=SYNTHCODE789> or ' +
        'https://go.example.org/r?next=https://ledger.example.net/cb?code=SYNTHCODE012',
    }],
    answer: 'Watch at www.browserbase.com/devtools-fullscreen/inspector.html?wss=connect.browserbase.com/debug/SYNTHSESS ' +
      'or browserbase.com/sessions/SYNTHSESS2 now',
  });
  assert.deepEqual(kept(record, ['SYNTHCODE', 'SYNTHSESS', 'browserbase']), []);
  assert.equal(record.trigger.text,
    'Try https://billing.example.com/users/[omitted]/callback?[omitted] and <https://billing.example.com/cb?[omitted]>');
  assert.equal(record.context[0]?.text, '<https://go.example.org/r|https://billing.example.com/cb?[omitted]> or ' +
    'https://go.example.org/r?next=https://ledger.example.net/cb?[omitted]');
  assert.equal(record.answer, `Watch at ${BROWSER_LINK_OMITTED} or ${BROWSER_LINK_OMITTED} now`);
});

test('a link right after another link\'s host, behind //, or behind a host no site has, keeps no token', () => {
  const record = copy({
    trigger: {
      author: 'U012ABCDEF3',
      text: '<https://go.example.org|https://billing.example.com/cb?code=SYNTHCODE123> ' +
        '<https://go.example.org|billing.example.com/cb?code=SYNTHCODE456> ' +
        'https://go.example.org\'billing.example.com/cb?code=SYNTHCODE789 ' +
        'https://ops\'x:SYNTHPASS@billing.example.com/cb?code=SYNTHCODE678 ' +
        'https://ops|x:SYNTHPASS@billing.example.com/cb?code=SYNTHCODE901 https://u;x:SYNTHPASS@billing.example.com/cb?code=SYNTHCODE902 ' +
        'https://go.example.org/r?next=//billing.example.com/cb?code=SYNTHCODE012 and //ledger.example.net/r?t=SYNTHCODE345 ' +
        '<https://go.example.org|Report?id=5>',
      files: [],
    },
  });
  assert.deepEqual(kept(record, ['SYNTHCODE', 'SYNTHPASS']), []);
  assert.equal(record.trigger.text,
    '<https://go.example.org|https://billing.example.com/cb?[omitted]> ' +
    '<https://go.example.org|billing.example.com/cb?[omitted]> ' +
    'https://[omitted]/cb?[omitted] ' +
    'https://billing.example.com/cb?[omitted] ' +
    'https://billing.example.com/cb?[omitted] https://billing.example.com/cb?[omitted] ' +
    'https://go.example.org/r?next=//billing.example.com/cb?[omitted] and //ledger.example.net/r?[omitted] ' +
    '<https://go.example.org|Report?id=5>');
});

test('a URL\'s userinfo goes whole whatever delimiters its encoding writes, and hides neither its host nor its token, in every field', () => {
  // The URL standard's setters write a `/`, `?`, `#`, `@` or `:` in a username or password as its percent escape.
  // Decoded, it is the userinfo's data: the host follows the userinfo's last `@`, before the first `/`, `?` or `#` as written.
  const signIn = (username: string, password?: string) =>
    address('https://billing.example.com/cb?code=SynthUserinfoCode1', username, password);
  const slashed = signIn('SynthOps/SynthTeam', 'SynthPass/?#@:4417');
  assert.equal(slashed, 'https://SynthOps%2FSynthTeam:SynthPass%2F%3F%23%40%3A4417@billing.example.com/cb?code=SynthUserinfoCode1');
  const queried = signIn('SynthOps?SynthTeam');
  const hashed = signIn('SynthOps#SynthTeam', 'SynthPass4417');
  const other = address('https://other.example/s?q=kept', 'SynthOps?SynthTeam', 'SynthPass#4417');
  // A userinfo that spells a login site makes another site's link no login site's.
  const spelled = address('https://other.example/s?q=kept', 'billing.example.com/x');
  // An address percent-encoded whole may hold the `@` of an email address in its path, past the end of its authority,
  // and a link without a scheme may be one: either is read from the first host it can have that is a login site, the
  // hosted browser's, or none a URL reads.
  const emailPath = encodeURIComponent('https://billing.example.com/u/ops@corp.example/reset/SynthPathToken');
  const twice = encodeURIComponent(encodeURIComponent(
    address('https://billing.example.com/u/ops@corp.example/SynthPathToken', 'SynthOps/SynthTeam')));
  const session = encodeURIComponent('https://www.browserbase.com/sessions/ops@corp.example/SynthSession');
  // A written `//` before what was percent-encoded once more: the host a URL would read ends at a `/` decoding wrote,
  // which no URL reads as written, so the address reads as decoding would leave it, and only an `@` as written ends a
  // userinfo a URL reads as written.
  const encodedAfterScheme = [
    'https://billing.example.com%2Fu%2Fops%40corp.example%2Freset%2FSynthPath1Token',
    'https://billing.example.com%2Fu%2Fops@corp.example%2Freset%2FSynthPath2Token',
    'https://billing.example.com%2Fu%2Fops%40corp.example/reset/SynthPath3Token',
  ].join(' ');
  const unreadable = `ab${String.fromCodePoint(0x5d0)}.example%2FSynthOps@other.example/cb?code=SynthUserinfoCode2`;
  const whole = encodeURIComponent(slashed);
  const record = copy({
    trigger: { author: 'U012ABCDEF3', text: `Use ${slashed} or ${queried}.`, files: [] },
    // An email address written as a username, its `@` as written: the userinfo ends at the last `@`.
    context: [{ author: 'U012ABCDEF3', role: 'human', text: `Signed in at ${hashed} and ${other} as ` +
      'https://SynthOps@corp.example:SynthPass@other.example/s?q=kept', files: [] }],
    steps: [
      browserStep('browser_open', { url: slashed }, { url: hashed }),
      { kind: 'tool', name: 'read_mail', input: '{}', output: JSON.stringify({ text: `${slashed} ${whole}` }) },
    ],
    answer: `See ${whole}, ${new URLSearchParams({ next: slashed })}, https://other.example/redirect?next=${whole}, ` +
      `${emailPath}, ${twice}, ${session}, ${unreadable}, ${spelled} or ${other} today, then ${encodedAfterScheme}`,
  });
  assert.deepEqual(kept(record, ['SynthOps', 'SynthTeam', 'SynthPass', 'SynthUserinfoCode', 'SynthPath', 'SynthSession']), []);
  const signedIn = 'https://billing.example.com/cb?[omitted]';
  const signedInWhole = 'https:%2F%2Fbilling.example.com[omitted]';
  assert.equal(record.trigger.text, `Use ${signedIn} or ${signedIn}.`);
  assert.equal(record.context[0]?.text, `Signed in at ${signedIn} and https://other.example/s?q=kept as https://other.example/s?q=kept`);
  const [opened, mail] = record.steps;
  assert.ok(opened?.kind === 'tool' && mail?.kind === 'tool');
  assert.equal(opened.input, `{"url":"${signedIn}"}`);
  assert.equal(opened.output, `{"url":"${signedIn}"}`);
  assert.equal(JSON.parse(mail.output ?? '{}').text, `${signedIn} ${signedInWhole}`);
  assert.equal(record.answer, `See ${signedInWhole}, next=${signedInWhole}, https://other.example/redirect?next=${signedInWhole}, ` +
    `${signedInWhole}, ${signedInWhole}, ${BROWSER_LINK_OMITTED} [omitted][omitted]/cb?[omitted], ` +
    'https://other.example/s?q=kept or https://other.example/s?q=kept today, then ' +
    'https://billing.example.com[omitted] https://billing.example.com[omitted] https://billing.example.com[omitted]/reset/[omitted]');
});

test('a link behind `//` loses its userinfo on any site, and an email address\'s domain starts no link', () => {
  // A protocol-relative address, or one of a scheme no rule names, holds an authority behind `//` as any URL does:
  // its host follows the userinfo's last `@`, and the link starts where the userinfo does, whatever site it is on.
  const withUserinfo = address('https://billing.example.com/cb?code=SynthUserinfoCode3', 'SynthOps/SynthTeam', 'SynthPass4417');
  const protocolRelative = withUserinfo.slice('https:'.length);
  const record = copy({
    trigger: { author: 'U012ABCDEF3', text: `Use //SynthOps:SynthPass@billing.example.com/cb?code=SynthUserinfoCode4 or ${protocolRelative}.`, files: [] },
    steps: [
      browserStep('browser_open', { url: protocolRelative }, { url: '//SynthOps:SynthPass@accounts.other.example/inbox?q=SynthUserinfoCode5' }),
      { kind: 'tool', name: 'read_mail', input: '{}', output: JSON.stringify({ text: `Next: ${new URLSearchParams({ next: protocolRelative })}` }) },
    ],
    answer: 'See https://other.example/r?next=//SynthOps:SynthPass@billing.example.com/cb?code=SynthUserinfoCode6 and ' +
      'postgres://SynthOps:SynthPass@billing.example.com:5432/app?sslkey=SynthUserinfoCode7, ' +
      '//SynthOps:SynthPass@other.example/s?q=kept and redis://SynthOps:SynthPass@cache.other.example:6379/0. ' +
      // An email address's `@`, as written or percent-encoded, and one in a path, starts no authority.
      'Write to ops@billing.example.com/help, ops%40billing.example.com%2Fhelp or //go.example.org/u/ops@billing.example.com/help.',
  });
  assert.deepEqual(kept(record, ['SynthOps', 'SynthTeam', 'SynthPass', 'SynthUserinfoCode']), []);
  assert.equal(record.trigger.text, 'Use //billing.example.com/cb?[omitted] or //billing.example.com/cb?[omitted].');
  const [opened, mail] = record.steps;
  assert.ok(opened?.kind === 'tool' && mail?.kind === 'tool');
  assert.equal(opened.input, '{"url":"//billing.example.com/cb?[omitted]"}');
  assert.equal(opened.output, '{"url":"//accounts.other.example/inbox?[omitted]"}');
  assert.equal(JSON.parse(mail.output ?? '{}').text, 'Next: next=%2F%2Fbilling.example.com[omitted]');
  assert.equal(record.answer, 'See https://other.example/r?next=//billing.example.com/cb?[omitted] and ' +
    'postgres://billing.example.com:5432/app?[omitted], //other.example/s?q=kept and redis://cache.other.example:6379/0. ' +
    'Write to ops@billing.example.com/help, ops%40billing.example.com%2Fhelp or //go.example.org/u/ops@billing.example.com/help.');
});

test('a login site\'s link without a scheme keeps no token after a JSON line break or tab, escaped once or twice, or behind JSON-escaped slashes', () => {
  const backslash = '\\';
  const mail = JSON.stringify({ text: 'Reset:\nbilling.example.com/reset?token=SYNTHGAP1\tledger.example.net/cb?code=SYNTHGAP2' });
  const linked = `{"link":"${backslash}/${backslash}/billing.example.com${backslash}/cb?code=SYNTHGAP3"}`;
  // A field escaped again writes `\n` with two backslashes, so a run of them before `n` reads as a line break,
  // though a path may hold a backslash and an `n` as written.
  const twice = JSON.stringify({ path: `C:${backslash}nbilling.example.com/cb?code=SYNTHGAP4` });
  const record = copy({ steps: [{ kind: 'tool', name: 'read_mail', input: '{}', output: `${mail} ${linked} ${twice}` }] });
  const [read] = record.steps;
  assert.ok(read?.kind === 'tool');
  assert.equal(read.output, '{"text":"Reset:\\nbilling.example.com/reset?[omitted]\\tledger.example.net/cb?[omitted]"} ' +
    `{"link":"${backslash}/${backslash}/billing.example.com/cb?[omitted]"} {"path":"C:${backslash}${backslash}nbilling.example.com/cb?[omitted]"}`);
});

test('a login site\'s link without a scheme keeps no token after another host\'s text, and other text stays as written', () => {
  const record = copy({
    trigger: {
      author: 'U012ABCDEF3',
      text: 'See go.example.org/r?next=billing.example.com/cb?code=SYNTHCODE123 and app.ledger.example.net:8443/x;sid=SYNTHSID ' +
        'but not docs.example.org\\/a?b=c or and/or.',
      files: [],
    },
  });
  assert.equal(record.trigger.text, 'See go.example.org/r?next=billing.example.com/cb?[omitted] and app.ledger.example.net:8443/x?[omitted] ' +
    'but not docs.example.org\\/a?b=c or and/or.');
});

test('a link keeps no token behind JSON-escaped slashes or a host that ends in a dot', () => {
  const record = copy({
    context: [{
      author: 'U012ABCDEF3', role: 'human', files: [],
      text: 'Is https://www.browserbase.com./sessions/SYNTHSESS3 the one? I used billing.example.com./magic?token=SYNTHMAGIC0123',
    }],
    steps: [
      // A raw JSON response a page shows, as PHP writes it and as the snapshot then escapes it.
      browserStep('browser_snapshot', {}, {
        snapshot: '- text "{\\"next\\":\\"https:\\\\/\\\\/billing.example.com\\\\/callback?code=SYNTHCODE123\\"}"',
      }),
      {
        kind: 'tool', name: 'read_mail', input: '{}',
        output: '{"link":"https:\\/\\/www.browserbase.com\\/devtools-fullscreen\\/inspector.html?wss=connect.browserbase.com\\/debug\\/SYNTHSESS"}',
      },
    ],
    answer: 'Done: https://billing.example.com./callback?code=SYNTHCODE123 and billing.example.com\\/reset\\/SYNTHRESETTOKEN0123456789',
  });
  assert.deepEqual(kept(record, ['SYNTHCODE123', 'SYNTHSESS', 'SYNTHMAGIC0123', 'SYNTHRESETTOKEN', 'browserbase']), []);
  assert.equal(record.context[0]?.text, `Is ${BROWSER_LINK_OMITTED} the one? I used billing.example.com./magic?[omitted]`);
  assert.equal(record.answer, 'Done: https://billing.example.com./callback?[omitted] and billing.example.com/reset/[omitted]');
  const [shown, read] = record.steps;
  assert.ok(shown?.kind === 'tool' && read?.kind === 'tool');
  assert.equal(JSON.parse(shown.output ?? '{}').snapshot, '- text "{\\"next\\":\\"https://billing.example.com/callback?[omitted]\\"}"');
  assert.equal(read.output, `{"link":"${BROWSER_LINK_OMITTED}"}`);
});

test('a username leaves a JSON unicode escape or an HTML entity of any of its marks', () => {
  const unicode = (char: string) => '\\' + 'u' + char.charCodeAt(0).toString(16).padStart(4, '0');
  const name = 'r&d.o\'brien@example.com';
  const json = name.replace(/[&'@]/g, (char) => unicode(char));
  const decimal = name.replace(/[&'@]/g, (char) => `&#${char.charCodeAt(0)};`);
  const hex = name.replace(/[&'@]/g, (char) => `&#x${char.charCodeAt(0).toString(16)};`);
  assert.equal([json, decimal, hex].some((text) => text.includes('@') || text.includes('\'')), false, 'the test text holds the escapes');
  const record = copy({
    steps: [{ kind: 'tool', name: 'read_page', input: '{}', output: JSON.stringify({ body: json }) }],
    answer: `${json} or ${decimal} or ${hex.toUpperCase()}`,
  }, { hosts: [], usernames: [name] });
  assert.deepEqual(kept(record, ['brien', 'example.com']), []);
  assert.equal(record.answer, '[credential redacted] or [credential redacted] or [credential redacted]');
  assert.equal(record.steps[0]?.kind === 'tool' && record.steps[0].output, '{"body":"[credential redacted]"}');
});

test('a username leaves the JSON escapes of a character past U+FFFF, one per half, in either case, mixed with the character as written or escaped again', () => {
  // U+10400 folds to U+10428, so each half of its pair alone folds to neither.
  const name = `${String.fromCodePoint(0x10400)}synthetic`;
  const [high, low] = [name.charCodeAt(0), name.charCodeAt(1)];
  const small = String.fromCodePoint(0x10428);
  const escape = (unit: number, backslashes = 1) => `${'\\'.repeat(backslashes)}u${unit.toString(16).padStart(4, '0')}`;
  const everyUnit = Array.from({ length: name.length }, (_, index) => escape(name.charCodeAt(index)).toUpperCase().replace('\\U', '\\u')).join('');
  const forms = [
    `${escape(high)}${escape(low)}synthetic`,
    `${escape(high)}${String.fromCharCode(low)}synthetic`,
    `${String.fromCharCode(high)}${escape(low)}synthetic`,
    `${escape(high, 2)}${escape(low, 2)}synthetic`,
    everyUnit,
    `${escape(small.charCodeAt(0))}${escape(small.charCodeAt(1))}SYNTHETIC`,
  ];
  assert.ok(forms.every((form) => !form.includes(name)) && JSON.parse(`"${forms[0]}"`) === name && everyUnit.includes('\\uD801'),
    'the test text holds the escapes, and JSON reads the first as the username');
  assert.equal(JSON.parse(`"${forms[5]}"`), name.toLowerCase().replace('synthetic', 'SYNTHETIC'), 'and the last as its other case');
  // A lone half is a character of its own: it stays, and the username beside it still goes.
  const lone = `${escape(high)}x ${escape(high)}${forms[0]}`;
  const record = copy({
    context: [{ author: 'U012ABCDEF3', role: 'human', text: `Signed in as ${forms[0]} today`, files: [] }],
    steps: [{ kind: 'tool', name: 'read_page', input: '{}', output: `{"user":"${forms[3]}","next":"x"}` }],
    answer: `${forms.join(' or ')}; ${lone}.`,
  }, { hosts: [], usernames: [name] });
  assert.deepEqual(kept(record, ['synthetic']), []);
  assert.equal(record.context[0]?.text, 'Signed in as [credential redacted] today');
  assert.equal(record.steps[0]?.kind === 'tool' && record.steps[0].output, '{"user":"[credential redacted]","next":"x"}');
  assert.equal(record.answer, `${forms.map(() => '[credential redacted]').join(' or ')}; ${escape(high)}x ${escape(high)}[credential redacted].`);
});

test('a username percent-encoded in every character, or in mixed forms, leaves the copy and the text around it stays as written', () => {
  const percent = (text: string) => [...new TextEncoder().encode(text)].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');
  const accented = 'josé.synthetic@example.com';
  const mixed = `${percent('Ops.')}Synthetic${'\\'}u0040${percent('example')}.com`;
  const record = copy({
    steps: [{ kind: 'tool', name: 'read_mail', input: '{}', output: `{"link":"https://forms.example/next?u=${percent(USERNAME)}&x=1"}` }],
    answer: `Sent ${percent(USERNAME).toUpperCase()}, ${mixed}, ${percent(accented)} and ${percent('Ops Synthetic')}; %ZZ, %C3 and 100%25 stay.`,
  }, { hosts: [], usernames: [USERNAME, accented, 'Ops Synthetic'] });
  assert.equal(record.steps[0]?.kind === 'tool' && record.steps[0].output, '{"link":"https://forms.example/next?u=[credential redacted]&x=1"}');
  assert.equal(record.answer,
    'Sent [credential redacted], [credential redacted], [credential redacted] and [credential redacted]; %ZZ, %C3 and 100%25 stay.');
});

test('an email address\'s local part leaves the copy where it stands alone, under the same length and word rules', () => {
  const record = copy({
    steps: [browserStep('browser_snapshot', {}, {
      snapshot: '- heading "Welcome back, Ops.Synthetic" level=1\n- option "bob" [ref=e2]\n- text "bob approved it"',
    })],
    answer: 'Welcome back, OPS.SYNTHETIC. Ops.Synthetics and xOps.Synthetic stay, and bob approved it.',
  }, { hosts: [], usernames: [USERNAME, 'bob@example.com'] });
  const output = record.steps[0]?.kind === 'tool' ? record.steps[0].output ?? '' : '';
  assert.equal(JSON.parse(output).snapshot,
    '- heading "Welcome back, [credential redacted]" level=1\n- option "[credential redacted]" [ref=e2]\n- text "bob approved it"');
  assert.equal(record.answer, 'Welcome back, [credential redacted]. Ops.Synthetics and xOps.Synthetic stay, and bob approved it.');
});

test('a hand-off link goes from a field that JSON-escapes its markup, as Go writes `<`, `>` and `&`', () => {
  const liveView = 'https://live.provider.example/s/SYNTHLIVE?view=full&t=SYNTHLIVETOKEN';
  const goJson = (value: unknown) => JSON.stringify(value)
    .replace(/[<>&]/g, (char) => `${'\\'}u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const output = goJson({ messages: [{ text: browserHandoffMessage('portal.example.com', liveView) }, { text: `Links:\n- ${liveView}` }] });
  assert.equal(/[<>&]/.test(output), false, 'the test text holds the escapes');
  const record = copy({ steps: [{ kind: 'tool', name: 'read_slack', input: '{}', output }] });
  assert.deepEqual(kept(record, ['SYNTHLIVE', 'live.provider']), []);
  const [read] = record.steps;
  assert.ok(read?.kind === 'tool');
  assert.match(read.output ?? '', /\[browser link omitted\] and sign in;[^"]*"\},\{"text":"Links:\\n- \[browser link omitted\]"\}\]\}$/);
});

test('a login site\'s or the hosted browser\'s link percent-encoded whole, once or twice, as a form or in a redirect, loses its token in every field', () => {
  const signIn = 'https://billing.example.com/cb?code=SYNTHPCT1';
  const session = 'https://www.browserbase.com/sessions/SYNTHPCT2';
  const encoded = [
    encodeURIComponent(signIn),
    new URLSearchParams({ next: signIn }).toString(),
    encodeURIComponent(encodeURIComponent(signIn)),
    new URLSearchParams({ state: new URLSearchParams({ next: signIn }).toString() }).toString(),
    `https://other.example/redirect?next=${encodeURIComponent(signIn)}`,
    encodeURIComponent(session),
    `https://other.example/redirect?next=${encodeURIComponent(encodeURIComponent(session))}`,
  ].join(' ');
  assert.equal(/SYNTHPCT\d\b/.test(decodeURIComponent(encoded)) && !encoded.includes('://billing'), true, 'the test text holds the escapes');
  const record = copy({
    context: [{ author: 'U012ABCDEF3', role: 'human', text: encoded, files: [] }],
    steps: [
      browserStep('browser_snapshot', {}, { url: encoded }),
      { kind: 'tool', name: 'read_mail', input: '{}', output: JSON.stringify({ text: encoded }) },
    ],
    answer: `See ${encoded} today`,
  });
  assert.deepEqual(kept(record, ['SYNTHPCT', 'browserbase']), []);
  // Past the host of an address percent-encoded whole, what decoding wrote is one segment, which goes.
  const signedIn = 'https:%2F%2Fbilling.example.com[omitted]';
  assert.equal(record.answer, `See ${signedIn} next=${signedIn} ${signedIn} state=next%3D${signedIn} ` +
    `https://other.example/redirect?next=${signedIn} ${BROWSER_LINK_OMITTED} ` +
    `https://other.example/redirect?next=${BROWSER_LINK_OMITTED} today`);
});

test('a percent-encoded space, quote, angle bracket or backslash inside an address ends no link, so the token after it goes', () => {
  // A browser reads `%20` in an address as data. Decoded as a space, it would end the link and leave the token after it.
  // PHP's htmlentities with ENT_HTML5 writes `%` as `&percnt;`, and a JSON serializer may escape it.
  const inside = ['%20', '%22', '%3C', '%3E', '%5C', '%2520', '%5C%22', '%C2%A0', '%26lt%3B', '&percnt;20', '&percnt;22', `${'\\'}u002520`];
  const links = inside.map((escape, index) => `https://billing.example.com/cb?x=a${escape}b&code=SYNTHSTAND${index}`).join(' ');
  const others = 'https://other.example/s?q=a%20b%22c%3Cd and https://other.example/r?note=a%20b&next=' +
    encodeURIComponent('https://billing.example.com/cb?code=SYNTHSTAND9');
  const record = copy({
    steps: [{ kind: 'tool', name: 'browser_snapshot', input: '{}', output: links }],
    answer: `${links} ${others}`,
  });
  assert.deepEqual(kept(record, ['SYNTHSTAND']), []);
  const scrubbed = inside.map(() => 'https://billing.example.com/cb?[omitted]').join(' ');
  assert.equal(record.answer, `${scrubbed} https://other.example/s?q=a%20b%22c%3Cd and ` +
    'https://other.example/r?note=a%20b&next=https:%2F%2Fbilling.example.com[omitted]',
  'a link the rules keep stays as written, and one they rewrite writes each such character as its escape again');
  assert.equal(record.steps[0]?.kind === 'tool' && record.steps[0].output, scrubbed);
});

test('a hand-off link goes percent-encoded whole, and a hand-off URL holding an encoded space goes wherever the text repeats it', () => {
  const liveView = 'https://live.provider.example/s/SYNTHHAND1?note=a%20b&t=SYNTHHAND2';
  const message = browserHandoffMessage('portal.example.com', liveView);
  const record = copy({
    context: [{ author: 'Billing Agent', role: 'agent', text: `${message}\nLinks in this Slack message:\n- ${liveView}`, files: [] }],
    steps: [{ kind: 'tool', name: 'browser_snapshot', input: '{}', output: encodeURIComponent(message) }],
    // A field percent-encoded whole that holds the message and its link listed again, as a context row writes it.
    answer: new URLSearchParams({ text: `${message}\nLinks in this Slack message:\n- ${liveView}` }).toString(),
  });
  assert.deepEqual(kept(record, ['SYNTHHAND', 'live.provider']), []);
  assert.match(record.context[0]?.text ?? '', /\[browser link omitted\] and sign in;.*\nLinks in this Slack message:\n- \[browser link omitted\]$/s);
});

test('a login site\'s link, a hand-off link and a username written in HTML character references leave every field', () => {
  // Python's encode('ascii', 'xmlcharrefreplace') and html.escape, and PHP's htmlentities, as the security delta re-review wrote them.
  const logins = { hosts: [normalizeWebsiteLoginHost('bücher.example')], usernames: ['müller.synthetic@example.com'] };
  const handoff = '&lt;https://handoff.example/live?token=SYNTHHTML2|Open the browser&gt;';
  const text = `b&#252;cher.example/cb?code=SYNTHHTML1 ${handoff} as m&uuml;ller.synthetic@example.com`;
  const record = copy({
    context: [{ author: 'Billing Agent', role: 'agent', text, files: [] }],
    steps: [{ kind: 'tool', name: 'browser_snapshot', input: '{}', output: text }],
    answer: text,
  }, logins);
  assert.deepEqual(kept(record, ['SYNTHHTML', 'handoff.example', 'ller.synthetic']), []);
  assert.equal(record.answer, `bücher.example/cb?[omitted] ${BROWSER_LINK_OMITTED} as [credential redacted]`);
});

test('every hosted browser link goes whole, whatever its host', () => {
  const record = copy({
    trigger: { author: 'U012ABCDEF3', text: 'Is https://www.browserbase.com/sessions/SYNTHSESS3 still open?', files: [] },
    context: [
      { author: 'Billing Agent', role: 'agent', text: browserHandoffMessage('billing.example.com', LIVE_VIEW_URL), files: [] },
      { author: 'Billing Agent', role: 'agent', text: browserHandoffMessage('portal.example.com', 'https://live.provider.example/s/SYNTHLIVE'), files: [] },
    ],
    steps: [{ kind: 'tool', name: 'browser_open', input: '{}', error: 'connect failed: wss://connect.usw2.browserbase.com/?signingKey=SYNTHJWT' }],
    answer: 'Debugger: http://127.0.0.1:9222/devtools/inspector.html?ws=127.0.0.1:9222/devtools/page/SYNTHPAGE2 ' +
      'and ws://127.0.0.1:9222/devtools/browser/SYNTHBROWSER',
  });
  assert.deepEqual(kept(record, ['browserbase', 'SYNTHSESS', 'SYNTHPAGE', 'SYNTHLIVE', 'SYNTHJWT', 'SYNTHBROWSER', 'devtools']), []);
  assert.match(record.context[0]?.text ?? '', /^billing\.example\.com needs you to sign in before I can continue\. \[browser link omitted\] and sign in;/);
  assert.equal(record.answer, `Debugger: ${BROWSER_LINK_OMITTED} and ${BROWSER_LINK_OMITTED}`);
});

test('a hand-off link a later turn reads back from Slack goes from both places its context row holds it', () => {
  const liveView = 'https://live.provider.example/s/SYNTHLIVE?view=full&t=SYNTHLIVETOKEN';
  // Slack returns the message with a rich_text block, and a context row lists that block's links under the text.
  const row = toContextMessage({
    ts: '1792915200.000100', user: 'U0BOT12345', text: browserHandoffMessage('portal.example.com', liveView),
    blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'link', url: liveView, text: 'Open the browser' }] }] }],
  }, { botUserId: 'U0BOT12345' });
  assert.match(row?.text ?? '', /Links in this Slack message:\n- https:\/\/live\.provider\.example\/s\/SYNTHLIVE/);
  const record = copy({ context: [{ author: 'Billing Agent', role: 'agent', text: row!.text, files: [] }] });
  assert.deepEqual(kept(record, ['SYNTHLIVE', 'live.provider']), []);
  assert.match(record.context[0]?.text ?? '', /Links in this Slack message:\n- \[browser link omitted\]$/);

  // Anyone can write the label. What it wraps is removed elsewhere only as a whole web address, and only with the
  // whole link that holds it, so it cannot break up a link or a username before their own rules see them.
  const written = copy({
    trigger: {
      author: 'U012ABCDEF3',
      text: '<.|Open the browser> <then|Open the browser> <https://billing.example.com/c|Open the browser> then ' +
        'https://billing.example.com/callback?code=SYNTHCODE123 or https://billing.example.com/account?code=SYNTHCODE124 ' +
        'as Ops.Synthetic@example.com',
      files: [],
    },
  });
  assert.deepEqual(kept(written, ['SYNTHCODE12', 'ops.synthetic', 'synthetic@']), []);
  assert.equal(written.trigger.text, `${BROWSER_LINK_OMITTED} ${BROWSER_LINK_OMITTED} ${BROWSER_LINK_OMITTED} then ` +
    `${BROWSER_LINK_OMITTED} or https://billing.example.com/account?[omitted] as [credential redacted]`);
});

test('a link that holds a hand-off URL goes whole, however many encodings hold it and whatever comes around it', () => {
  // A context row carried as one path segment of a login site's link, as encodeURIComponent writes it, then encoded
  // again: the URL it lists again ends where the segment does, before `/done`, written or itself encoded. A form
  // writes a space as `+`, which a link holds.
  const liveView = 'https://live.provider.example/s/SYNTHLIVE7?view=full&t=SYNTHLIVE8';
  const row = toContextMessage({
    ts: '1792915200.000100', user: 'U0BOT12345', text: browserHandoffMessage('portal.example.com', liveView),
    blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'link', url: liveView, text: 'Open the browser' }] }] }],
  }, { botUserId: 'U0BOT12345' })!.text;
  const segment = `https://billing.example.com/magic/${encodeURIComponent(row)}/done`;
  const form = new URLSearchParams({ text: `${browserHandoffMessage('portal.example.com', liveView)} Open: ${liveView}` }).toString();
  // A browser step keeps a path's words, so a URL whose path is words goes only with the whole link that holds it.
  const wordsView = 'https://live.provider.example/view/SynthLetters';
  const joined = `${browserHandoffMessage('portal.example.com', wordsView)} and https://other.example/x+${wordsView}`;
  for (const text of [segment, encodeURIComponent(segment), `${row} and ${liveView}/more?x=1`, joined, form, form.replace(/%2F/g, '/')]) {
    const record = copy({
      answer: text,
      context: [{ author: 'Billing Agent', role: 'agent', text, files: [] }],
      steps: [{ kind: 'tool', name: 'browser_snapshot', input: '{}', output: text }],
    });
    assert.deepEqual(kept(record, ['SYNTHLIVE', 'SynthLetters', 'live.provider']), [], text);
  }
});

test('a saved username leaves every field, in any case and in every escaped or encoded form', () => {
  const snapshot = [
    '- textbox "Email" [ref=e1] value="Ops.Synthetic@example.com"',
    '- textbox "Domain user" [ref=e2] value="CORP\\\\jsmith"',
    '- text "Signed in as\nops.synthetic@example.com"',
  ].join('\n');
  const record = copy({
    trigger: { author: 'U012ABCDEF3', text: 'My login is OPS.SYNTHETIC@EXAMPLE.COM, or CORP\\jsmith on the old site.', files: [] },
    context: [{ author: 'U012ABCDEF3', role: 'human', text: 'The team login is r&amp;d.synthetic@example.com', files: [] }],
    steps: [
      browserStep('browser_act', { ref: 'e1', action: 'type', text: 'Ops.Synthetic@example.com' }, {
        url: 'https://billing.example.com/users/ops%2esynthetic%40EXAMPLE%2Ecom/invoices',
        snapshot,
      }),
    ],
    answer: 'I used https://forms.example/submit?email=Ops.Synthetic%40example.com&ok=1 for ops.synthetic@example.com.',
  }, { hosts: ['billing.example.com'], usernames: [USERNAME, 'CORP\\jsmith', 'r&d.synthetic@example.com'] });
  assert.deepEqual(kept(record, ['ops.synthetic', 'ops%2esynthetic', 'jsmith', 'r&d.synthetic', 'r&amp;d.synthetic']), []);
  assert.equal(record.trigger.text, 'My login is [credential redacted], or [credential redacted] on the old site.');
  assert.equal(record.context[0]?.text, 'The team login is [credential redacted]');
  assert.equal(record.answer, 'I used https://forms.example/submit?email=[credential redacted]&ok=1 for [credential redacted].');
  const act = record.steps[0]?.kind === 'tool' ? record.steps[0] : undefined;
  assert.equal(act?.input, '{"ref":"e1","action":"type","text":"[credential redacted]"}');
  assert.equal(JSON.parse(act?.output ?? '{}').snapshot, [
    '- textbox "Email" [ref=e1] value="[credential redacted]"',
    '- textbox "Domain user" [ref=e2] value="[credential redacted]"',
    '- text "Signed in as\n[credential redacted]"',
  ].join('\n'));
});

test('a username split across snapshot lines, or cut before a …, leaves no part of it', () => {
  const split = '- text "Account"\n  - text "Ops.Synthetic"\n  - link "@" [ref=e4]\n  - text "example.com"';
  const cutAtSnapshotCap = `- text "Signed in as Ops.Synthetic@ex\n… (snapshot cut at 12000 characters)`;
  const splitAfterState = '- button "Ops.Synthetic" [ref=e3] expanded\n  - text "@example.com"\n- heading "Ops.Synthetic" level=2\n- text "@example.com"';
  const record = copy({
    context: [{ author: 'Billing Agent', role: 'agent', text: 'Signed in as Ops.Synth…', files: [] }],
    steps: [
      browserStep('browser_snapshot', {}, { snapshot: split }),
      browserStep('browser_snapshot', {}, { snapshot: cutAtSnapshotCap }),
      browserStep('browser_snapshot', {}, { snapshot: splitAfterState }),
      browserStep('browser_snapshot', {}, { snapshot: '- textbox "Email" [ref=e1] value="Ops.Synthetic@exam…"' }),
    ],
  });
  assert.deepEqual(kept(record, ['ops.synth']), []);
  const outputs = record.steps.map((step) => step.kind === 'tool' ? step.output ?? '' : '');
  assert.equal(JSON.parse(outputs[0]!).snapshot, '- text "Account"\n  - text "[credential redacted]"');
  assert.equal(JSON.parse(outputs[1]!).snapshot, '- text "Signed in as [credential redacted]\n… (snapshot cut at 12000 characters)');
  assert.equal(JSON.parse(outputs[2]!).snapshot, '- button "[credential redacted]"\n- heading "[credential redacted]"');
  assert.equal(record.context[0]?.text, 'Signed in as [credential redacted]…');
});

test('a field over its cap is cut before the scrub, back to where no link, key or username without a space goes on', () => {
  // Text that ends `at` UTF-8 bytes past the field cap, so the cap cuts `tail` there.
  const straddling = (tail: string, at: number) => {
    const head = 'Report line with words. '.repeat(RUN_REVIEW_FIELD_BYTES / 16);
    return head.slice(0, RUN_REVIEW_FIELD_BYTES - at) + tail;
  };
  const token = `SYNTHMAGIC${'7'.repeat(30)}`;
  const key = ['ghp', `SYNTHKEY${'4'.repeat(32)}`].join('_');
  const spaced = 'SYNTHSAVED part two 0123456789';
  const longRun = `${'x'.repeat(5000)},${['ghp', `SYNTHLONG${'5'.repeat(32)}`].join('_')}`;
  const steps = [
    { kind: 'tool' as const, name: 'save_connection_key', input: JSON.stringify({ connectionId: 'ledger', key: spaced }), output: '{}' },
    { kind: 'tool' as const, name: 'web_fetch', input: '{}', output: straddling(` https://billing.example.com/magic/${token} next`, 40) },
    { kind: 'tool' as const, name: 'web_fetch', input: '{}', output: straddling(` key ${key} next`, 20) },
    { kind: 'tool' as const, name: 'web_fetch', input: '{}', output: straddling(' Signed in as Billing Ops Team today', 28) },
    { kind: 'tool' as const, name: 'web_fetch', input: '{}', output: straddling(` saved ${spaced} next`, 22) },
    { kind: 'tool' as const, name: 'web_fetch', input: '{}', output: straddling(` ${longRun} next`, 5020) },
  ];
  const record = copy({ steps }, { hosts: ['billing.example.com'], usernames: ['Billing Ops Team'] });
  assert.deepEqual(kept(record, ['SYNTHMAGIC', 'SYNTHKEY', 'billing ops', 'SYNTHSAVED', 'SYNTHLONG']), []);
  const outputs = record.steps.map((step) => step.kind === 'tool' ? step.output ?? '' : '');
  assert.ok(outputs[1]!.endsWith('Report line with words. '), 'the link the cap cut goes whole');
  assert.ok(outputs[2]!.endsWith(' key'), 'so does the key');
  assert.match(outputs[3]!, / Signed in as \[credential [a-z]*$/, 'a username\'s start before the cut goes, and the cap cuts its marker');
  assert.ok(outputs[4]!.includes(' saved [credential'), 'a saved key a cut back would split is scrubbed whole, then capped');
  assert.ok(outputs[5]!.includes('x,[credential'), 'so is a run with nowhere to cut back to');
  assert.equal(record.truncated, true);
});

test('a copy chooses its steps by their size before the scrub, so the scrub reads about the record cap, not all the collector held', () => {
  const query = `?filter=${'q'.repeat(8 * 1024)}`;
  const steps = Array.from({ length: 40 }, (_, index) =>
    browserStep('browser_open', { n: index }, { url: `https://billing.example.com/report/${index}${query}` }));
  const record = copy({ steps });
  assert.ok(new TextEncoder().encode(JSON.stringify(steps)).byteLength > 300 * 1024);
  const first = record.steps[0]?.kind === 'tool' ? JSON.parse(record.steps[0].input).n as number : undefined;
  assert.ok(first !== undefined && first > 0 && record.steps.length === 40 - first,
    'the oldest steps went, though each would shrink to a few bytes once its query went');
  assert.equal(record.truncated, true);
});

test('a long username\'s start, cut past its 64th character, leaves no part of it', () => {
  const long = `ops.${'synthetic.'.repeat(9)}team@example.com`;
  const spaced = `ops.${'synthetic.'.repeat(7)}night "shift" team@example.com`;
  assert.ok(long.length > 100 && spaced.indexOf(' ') > 64);
  const record = copy({
    steps: [browserStep('browser_snapshot', {}, { snapshot: `- text "Signed in as ${spaced.slice(0, 84)}…"` })],
    answer: `Signed in as ${long.slice(0, 90)}… and ${long.slice(0, 40)}…`,
  }, { hosts: [], usernames: [long, spaced] });
  assert.deepEqual(kept(record, ['synthetic', 'shift']), []);
  assert.equal(record.answer, 'Signed in as [credential redacted]… and [credential redacted]…');
  const output = record.steps[0]?.kind === 'tool' ? record.steps[0].output ?? '' : '';
  assert.equal(JSON.parse(output).snapshot, '- text "Signed in as [credential redacted]…"', 'a space or an escaped quote past the 64th does not stop it');
});

test('usernames match whole words, and one under four characters only as a whole value in a browser step', () => {
  const admin = copy({ answer: 'Ask an Admin, not the sysadmin, to administer billing.' }, { hosts: [], usernames: ['admin'] });
  assert.equal(admin.answer, 'Ask an [credential redacted], not the sysadmin, to administer billing.');

  const short = copy({
    steps: [browserStep('browser_snapshot', {}, { snapshot: '- textbox "User" [ref=e1] value="bob"\n- text "bob approved it"' })],
    answer: 'bob approved it.',
  }, { hosts: [], usernames: ['bob'] });
  const output = short.steps[0]?.kind === 'tool' ? short.steps[0].output ?? '' : '';
  assert.equal(JSON.parse(output).snapshot, '- textbox "User" [ref=e1] value="[credential redacted]"\n- text "bob approved it"');
  assert.equal(short.answer, 'bob approved it.');
});

test('a username that is a word of the record\'s run ID, Agent ID or model leaves them whole, and nothing else', () => {
  const record = copy({
    runId: 'run_billing',
    agentId: 'agent_billing',
    model: 'billing-model-1',
    steps: [{ kind: 'tool', name: 'billing_lookup', input: '{"for":"billing"}', output: 'billing is current', error: 'billing timed out' }],
    error: { class: 'billing_error', message: 'billing failed' },
    answer: 'The billing run finished.',
  }, { hosts: [], usernames: ['billing'] });
  assert.equal(record.runId, 'run_billing');
  assert.equal(record.agentId, 'agent_billing', 'Cloud files the copy under this Agent');
  assert.equal(record.model, 'billing-model-1');
  assert.deepEqual(record.error, { class: '[credential redacted]_error', message: '[credential redacted] failed' });
  assert.deepEqual(record.steps[0], {
    kind: 'tool', name: '[credential redacted]_lookup', input: '{"for":"[credential redacted]"}',
    output: '[credential redacted] is current', error: '[credential redacted] timed out',
  });
  assert.equal(record.answer, 'The [credential redacted] run finished.');

  const shaped = copy({ runId: `run:${USERNAME}`, agentId: `agent ${USERNAME}`, model: `${USERNAME}/model` });
  assert.deepEqual(kept(shaped, ['ops.synthetic']), [], 'an ID that is not shaped like one gets the username rule');
});

test('a tool name or an error class that holds a saved username loses it, streamed or read from history', async (t) => {
  // A model can call a tool by any name, and an error can carry any name: neither is Chickpea's own token.
  const builder = copy({
    steps: [{ kind: 'tool', name: 'Ops.Synthetic', input: '{}', error: 'No such tool.' }],
    error: { class: 'Ops.Synthetic', message: 'failed' },
  });
  assert.equal(builder.steps[0]?.kind === 'tool' && builder.steps[0].name, '[credential redacted]');
  assert.equal(builder.error?.class, '[credential redacted]');

  const records = fakePort(t);
  const settings = catalogSettings(JSON.stringify([{ host: 'billing.example.com', username: USERNAME }]));
  const failure = Object.assign(new Error('The run failed.'), { name: 'Ops.Synthetic' });
  const streamed = await startRunReview(HOSTED_ENV, { surface: 'dm', grantsWebsiteLogins: false, settings: () => settings });
  streamed!.ingest(chunk({ type: 'message-started', messageId: 'm', submissionId: SUBMISSION }), SUBMISSION);
  streamed!.ingest(chunk({ type: 'tool-input', messageId: 'm', toolCallId: 'c1', toolName: 'Ops.Synthetic', input: {} }), SUBMISSION);
  streamed!.ingest(chunk({ type: 'tool-output-error', toolCallId: 'c1', errorText: 'No such tool.' }), SUBMISSION);
  await streamed!.finish({ ...ENDING, outcome: 'failed', error: runReviewError(failure) });

  const settled = await startRunReview(HOSTED_ENV, { surface: 'dm', grantsWebsiteLogins: false, settings: () => settings });
  await settled!.finish({
    ...ENDING,
    outcome: 'failed',
    error: runReviewError(failure),
    history: {
      submissionId: SUBMISSION,
      read: async () => ({
        v: 1, conversationId: 'conversation', offset: '1', settlements: [],
        messages: [{
          id: 'm', role: 'assistant', purpose: 'assistant', display: 'visible', submissionId: SUBMISSION,
          parts: [{ type: 'dynamic-tool', toolName: 'Ops.Synthetic', toolCallId: 'c1', state: 'output-error', input: {}, errorText: 'No such tool.' }],
        }],
      }),
    },
  });
  assert.deepEqual(records.map((record) => record.source), ['stream', 'history']);
  for (const record of records) {
    assert.deepEqual(kept(record, ['ops.synthetic']), [], record.source);
    assert.equal(record.steps[0]?.kind === 'tool' && record.steps[0].name, '[credential redacted]');
    assert.equal(record.error?.class, '[credential redacted]');
  }
});

test('a username leaves prose written without spaces between words', () => {
  const record = copy({
    trigger: { author: 'U012ABCDEF3', text: 'ユーザー名Ops.Synthetic@example.comでログインしてください', files: [] },
    context: [{ author: 'U012ABCDEF3', role: 'human', text: '已使用ops.synthetic@example.com登录', files: [] }],
    answer: 'ops.synthetic@example.com으로 로그인했습니다. เข้าสู่ระบบด้วยops.synthetic@example.comแล้ว',
  });
  assert.deepEqual(kept(record, ['ops.synthetic']), []);
  assert.equal(record.trigger.text, 'ユーザー名[credential redacted]でログインしてください');
  assert.equal(record.context[0]?.text, '已使用[credential redacted]登录');
  assert.equal(record.answer, '[credential redacted]으로 로그인했습니다. เข้าสู่ระบบด้วย[credential redacted]แล้ว');

  const admin = copy({ answer: '管理者adminです。sysadminです。' }, { hosts: [], usernames: ['admin'] });
  assert.equal(admin.answer, '管理者[credential redacted]です。sysadminです。', 'a Latin word still keeps a username inside it');
});

test('a username\'s start before three dots leaves the copy, as before a …', () => {
  const record = copy({
    answer: 'Signed in as Ops.Synth... then as OPS.SYNTHETIC@EXAM ... and the Ops team... xOps.Synth… stays',
  });
  assert.equal(record.answer,
    'Signed in as [credential redacted]... then as [credential redacted] ... and the Ops team... xOps.Synth… stays');
});

test('a username with spaces leaves a form, and one that holds an escape of its own leaves text that escapes it again', () => {
  const record = copy({
    trigger: { author: 'U012ABCDEF3', text: 'Posted name=Ops+Synthetic&x=1 as promo%20team@example.com', files: [] },
    answer: 'Sent https://forms.example/s?u=promo%2520team%40example.com&ok=1 and r&amp;amp;d.synthetic@example.com',
  }, { hosts: [], usernames: ['Ops Synthetic', 'promo%20team@example.com', 'r&amp;d.synthetic@example.com'] });
  assert.equal(record.trigger.text, 'Posted name=[credential redacted]&x=1 as [credential redacted]');
  assert.equal(record.answer, 'Sent https://forms.example/s?u=[credential redacted]&ok=1 and [credential redacted]');
});

test('a username leaves text that writes it with another case of the same letters', () => {
  // A capital Σ is σ in lower case, but a word ends in ς; ſ is an s, ϑ a θ, and the Kelvin sign a k.
  const record = copy({
    answer: 'ΖΗΣΗΣ.SYNTHETIC@EXAMPLE.COM, Opſ.Synthetic@example.com, ϑεα.synthetic@example.com and Kassia.synthetic@example.com',
  }, { hosts: [], usernames: ['Ζησης.synthetic@example.com', USERNAME, 'θεα.synthetic@example.com', 'kassia.synthetic@example.com'] });
  assert.equal(record.answer,
    '[credential redacted], [credential redacted], [credential redacted] and [credential redacted]');
});

test('a username leaves text whose letters grow longer in lower case, and the text around it stays as written', () => {
  // `İ` is one code unit, and two in lower case.
  const title = 'İ'.repeat(40);
  const record = copy({ answer: `${title} ${title} İSMAIL.SYNTHETIC@EXAMPLE.COM.` }, { hosts: [], usernames: ['İsmail.Synthetic@example.com'] });
  assert.equal(record.answer, `${title} ${title} [credential redacted].`);
});

test('a long username\'s start split by snapshot node breaks past its 64th character leaves no part of it', () => {
  const long = `${'a'.repeat(64)}${'.b'.repeat(12)}@example.com`;
  // Each break is one a snapshot writes between nodes: a ref, node states, a line break and the next node.
  const node = '" [ref=e123] level=2 checked=mixed selected expanded disabled\n- text "';
  const start = `${'a'.repeat(64)}${'.b'.repeat(10)}`;
  const snapshot = `- text "${start.slice(0, 64)}${[...start.slice(64)].join(node)}…"`;
  assert.ok(snapshot.length > 1_400);
  const record = copy({
    steps: [
      browserStep('browser_snapshot', {}, { snapshot }),
      { kind: 'tool', name: 'browser_snapshot', input: '{}', output: snapshot },
    ],
  }, { hosts: [], usernames: [long] });
  assert.deepEqual(kept(record, ['aaaaaaaa']), []);
  const [serialized, literal] = record.steps.map((step) => step.kind === 'tool' ? step.output ?? '' : '');
  assert.equal(JSON.parse(serialized!).snapshot, '- text "[credential redacted]…"');
  assert.equal(literal, '- text "[credential redacted]…"');
});

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Runs `body` in its own Node process with 64 MB of heap, half a Worker's
 * memory, and a deadline, so a scrub that backtracks or compiles without
 * bound fails here rather than holding the test file. `body` has the scrub's
 * module as `logins` and prints one JSON line.
 */
function inChild(body: string): unknown {
  const result = spawnSync(process.execPath, [
    '--max-old-space-size=64', '--import', 'tsx', '--input-type=module', '-e',
    `const logins = await import('./src/review/website-logins.ts');\n${body}`,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 45_000 });
  assert.equal(result.status, 0,
    `the scrub's process ${result.signal ? `was stopped (${result.signal})` : 'failed'}: ${result.stderr.slice(0, 1500)}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
}

test('a username of repeated spaces or backslashes takes no longer against a near miss than against itself', () => {
  // Each near miss holds every character of the username but fails its last word boundary.
  const result = inChild(`
    const scrub = logins.websiteLoginScrub({ hosts: [], usernames: ['aaaa' + ' '.repeat(8) + 'z', 'bbbb' + '\\\\'.repeat(8) + 'y'] });
    const read = (text) => scrub.usernames(text, { browserStep: false, cut: false });
    console.log(JSON.stringify({
      nearMisses: ['aaaa' + ' '.repeat(100) + 'zX', 'bbbb' + '\\\\'.repeat(100) + 'yX'].map((text) => read(text) === text),
      matches: read('aaaa' + ' '.repeat(100) + 'z. bbbb' + '\\\\'.repeat(100) + 'y.'),
    }));
  `);
  assert.deepEqual(result, { nearMisses: [true, true], matches: '[credential redacted]. [credential redacted].' });
});

test('a field with no space reads each host once, and a login site\'s link at its end still loses its token', () => {
  // Every `=x/` could start a link without a scheme on another site. A field with no space near its cap is scrubbed whole.
  const result = inChild(`
    const run = 'x/='.repeat(400000);
    const read = logins.websiteLoginScrub({ hosts: ['billing.example.com'], usernames: [] }).links(run + 'billing.example.com/cb?code=SYNTHCODE123', false);
    console.log(JSON.stringify({ same: read.startsWith(run), end: read.slice(run.length) }));
  `);
  assert.deepEqual(result, { same: true, end: 'billing.example.com/cb?[omitted]' });
});

test('a host of thousands of labels, dots, escapes or backslashes takes no longer to read than a short one', () => {
  // A host is compared from where a saved site could start, so no suffix of it is read longer than a site.
  // A host starts at an escape or a run of backslashes, never inside one, so each run has one start.
  const result = inChild(`
    const read = (text, browserStep = false) =>
      logins.websiteLoginScrub({ hosts: ['billing.example.com'], usernames: [] }).links(text, browserStep);
    const backslash = String.fromCharCode(92);
    const dotted = ('https://a' + '.'.repeat(16384) + 'b/x ').repeat(256);
    const labels = ('a.'.repeat(8192) + 'b/x ').repeat(256);
    const runs = ['%41'.repeat(400000), (backslash + 'u00fc').repeat(200000), backslash.repeat(1200000)];
    const login = 'x.billing.example.com/cb?code=SYNTHCODE123';
    console.log(JSON.stringify({
      dotted: [false, true].map((browserStep) => read(dotted, browserStep) === dotted),
      labels: read(labels + login) === labels + 'x.billing.example.com/cb?[omitted]',
      under: read('a.'.repeat(8192) + login).endsWith('x.billing.example.com/cb?[omitted]'),
      runs: runs.flatMap((run) => [false, true].map((browserStep) => read(run, browserStep) === run)),
    }));
  `);
  assert.deepEqual(result, { dotted: [true, true], labels: true, under: true, runs: Array(6).fill(true) });
});

test('a field of nested escapes takes at most four decoding passes, each read once, and reads as the fourth leaves it', () => {
  // Each shape decodes one layer a pass: `%2525…` to `%25…`, `&amp;amp;` to `&amp;`, and escapes of one kind inside another's.
  const result = inChild(`
    const scrub = () => logins.websiteLoginScrub({ hosts: ['billing.example.com'], usernames: ['Ops.Synthetic@example.com'] });
    const backslash = String.fromCharCode(92);
    const shapes = ['%25'.repeat(400000), '%252525'.repeat(170000), '&amp;amp;amp;'.repeat(90000), '%26amp%3B'.repeat(130000),
      '&#37;25'.repeat(170000), (backslash + 'u0025' + '25').repeat(120000), ('%5C' + 'u0026amp;').repeat(100000)];
    const nested = (layers) => {
      let text = 'https://billing.example.com/cb?code=SYNTHNEST';
      for (let layer = 0; layer < layers; layer += 1) text = encodeURIComponent(text);
      return text;
    };
    console.log(JSON.stringify({
      links: shapes.map((shape) => scrub().links(shape, false) === shape),
      usernames: shapes.map((shape) => scrub().usernames(shape, { browserStep: false, cut: false }) === shape),
      layers: [1, 2, 3, 4, 5].map((layers) => scrub().links(nested(layers), false).includes('SYNTHNEST')),
    }));
  `);
  assert.deepEqual(result, {
    links: Array(7).fill(true),
    usernames: Array(7).fill(true),
    layers: [false, false, false, false, true],
  }, 'an address encoded four times loses its token; one encoded five times is deliberate, and its fifth layer stays');
});

test('each decoding pass counts against the copy\'s budget', () => {
  // `%2525` takes two passes to read as `%`, and a third finds nothing left to decode.
  const field = '%2525'.repeat(40_000);
  const scrub = websiteLoginScrub({ hosts: ['billing.example.com'], usernames: [] });
  for (let read = 0; read < 30; read += 1) assert.equal(scrub.links(field, false), field);
  assert.throws(() => {
    for (let read = 0; read < 10; read += 1) scrub.links(field, false);
  }, (error) => error instanceof RunReviewScrubLimit && error.event === 'scrub_over_budget');
});

test('each hand-off URL looked for counts each link it reads against the copy\'s budget', () => {
  const links = (count: number) => Array.from({ length: count }, (_, index) =>
    `<https://live.provider.example/s/SYNTHMANY${index}|Open the browser> https://live.provider.example/s/SYNTHMANY${index}`).join(' ');
  const scrub = () => websiteLoginScrub({ hosts: [], usernames: [] });
  assert.equal(scrub().links(links(10), false).includes('SYNTHMANY'), false, 'a field of 10 hand-off links stays within it');
  assert.throws(() => scrub().links(links(4000), false), (error) =>
    error instanceof RunReviewScrubLimit && error.event === 'scrub_over_budget');
});

test('a character reference or percent escape of no character stays as written, and the copy is kept', () => {
  const none = '&#0; &#xD800; &#1114112; &#x110000; &#99999999999; %C0%AF %E0%80%AF %ED%A0%80 %F4%90%80%80 %F5%80%80%80';
  const record = copy({
    steps: [{
      kind: 'tool', name: 'browser_snapshot', input: '{}',
      output: `${none} https://billing.example.com/cb?code=SYNTHNONE1 https://other.example/a%E0%80%AFb?x=1`,
    }],
    answer: `${none} as Ops.Synthetic@example.com`,
  });
  assert.equal(record.answer, `${none} as [credential redacted]`);
  // A browser decodes no overlong form, so `%E0%80%AF` is no `/` and its segment is no word.
  assert.equal(record.steps[0]?.kind === 'tool' && record.steps[0].output,
    `${none} https://billing.example.com/cb?[omitted] https://other.example/[omitted]?[omitted]`);
});

test('each host read in another script counts its parse against the copy\'s budget', () => {
  const scrub = () => websiteLoginScrub({ hosts: ['billing.example.com'], usernames: [] });
  const hosts = (count: number) => '日本/x '.repeat(count);
  assert.equal(scrub().links(hosts(10_000), false), hosts(10_000), 'a field of 10,000 such hosts stays within it');
  assert.throws(() => scrub().links(hosts(300_000), false), (error) =>
    error instanceof RunReviewScrubLimit && error.event === 'scrub_over_budget');
});

test('a page that names the start of every saved and planned username stays within half a Worker\'s memory', () => {
  // The plan's 100 and a replacement catalog's 100, each as long as the catalog allows, then 500 at the scrub's cap.
  const result = inChild(`
    const names = (count) => Array.from({ length: count }, (_, i) => ('u' + i + '.' + 'a.'.repeat(155) + 'z' + i + '@x.example').slice(0, 320));
    const starts = (usernames) => usernames.map((name) => name.slice(0, 64) + '…').join('\\n');
    const scrubbed = (usernames) => logins.websiteLoginScrub({ hosts: [], usernames }).usernames(starts(usernames), { browserStep: true, cut: true });
    const union = scrubbed(names(200));
    const atCap = scrubbed(names(500));
    console.log(JSON.stringify({
      pageChars: starts(names(200)).length,
      redacted: union.split('[credential redacted]…').length - 1,
      kept: names(200).filter((name) => union.includes(name.slice(0, 12))).length,
      redactedAtCap: atCap.split('[credential redacted]…').length - 1,
    }));
  `);
  assert.deepEqual(result, { pageChars: 13_199, redacted: 200, kept: 0, redactedAtCap: 500 });
});

function fakePort(t: TestContext): RunReviewRecordV1[] {
  const records: RunReviewRecordV1[] = [];
  const port: RunReviewPort = {
    enabled: async () => true,
    setEnabled: async (_id, change) => change.enabled,
    capturing: async () => true,
    record: async (_installationId, record) => { records.push(record); },
    privacyUrl: 'https://chickpea.example/privacy#help-improve-chickpea',
  };
  configureRunReview(port);
  t.after(() => configureRunReview(undefined));
  return records;
}

function catalogSettings(catalog: string | undefined, failCatalog = false): SettingsStore {
  const values = new Map<string, string>();
  if (catalog !== undefined) values.set(WEBSITE_LOGINS_SETTING, catalog);
  return {
    getSetting: async (key) => {
      if (failCatalog && key === WEBSITE_LOGINS_SETTING) throw new Error('state store unavailable');
      return values.get(key);
    },
    getSettings: async (keys) => keys.map((key) => values.get(key)),
    setSetting: async (key, value) => { values.set(key, value); },
    deleteSetting: async (key) => { values.delete(key); },
    applySettingsPatch: async (patch) => {
      if (patch.expected && (values.get(patch.expected.key) ?? null) !== patch.expected.value) return false;
      for (const write of patch.set ?? []) values.set(write.key, write.value);
      return true;
    },
    mergeSettingStringSet: async () => [],
  };
}

let position = 0;
function chunk(body: Record<string, unknown>): ConversationStreamChunk {
  position += 1;
  return { conversationId: 'conversation', position: { batch: 1, index: position }, ...body } as ConversationStreamChunk;
}

const ENDING: RunReviewEnding = {
  runId: 'run_review',
  agentId: 'agent_review',
  trigger: { author: 'U012ABCDEF3', text: 'Check the ledger.', files: [] },
  context: [],
  outcome: 'succeeded',
};

// Another Agent's login, which this run's plan never froze, and an entry the catalog reader would skip.
const OTHER_AGENTS_CATALOG = JSON.stringify([
  { id: `wl_${'a'.repeat(32)}`, host: 'ledger.example.net', label: 'Ledger', ownerKind: 'team', createdByMembershipId: 'mem_owner', method: 'credentials', username: 'ledger.synthetic@example.com', createdAt: 1 },
  { host: 'legacy.example.org', username: 'legacy.synthetic@example.org' },
]);

test('a copy drops the username of every login the installation saved, read when the copy is built', async (t) => {
  const records = fakePort(t);
  const settings = catalogSettings(OTHER_AGENTS_CATALOG);
  const session = await startRunReview(HOSTED_ENV, { surface: 'channel', grantsWebsiteLogins: false, settings: () => settings });
  session!.ingest(chunk({ type: 'message-started', messageId: 'm', submissionId: SUBMISSION }), SUBMISSION);
  session!.ingest(chunk({ type: 'tool-input', messageId: 'm', toolCallId: 'c1', toolName: 'inspect_workspace', input: {} }), SUBMISSION);
  session!.ingest(chunk({
    type: 'tool-output', toolCallId: 'c1',
    output: { agents: [{ websiteLogins: [{ host: 'ledger.example.net', username: 'ledger.synthetic@example.com' }] }] },
  }), SUBMISSION);
  await session!.finish({
    ...ENDING,
    context: [{ author: 'Ledger Agent', role: 'agent', text: 'Signed in to https://ledger.example.net/home?sid=SYNTHSID as legacy.synthetic@example.org', files: [] }],
  });
  assert.equal(records.length, 1);
  assert.deepEqual(kept(records[0]!, ['ledger.synthetic', 'legacy.synthetic', 'SYNTHSID']), []);
  assert.equal(records[0]!.context[0]?.text, 'Signed in to https://ledger.example.net/home?[omitted] as [credential redacted]');
});

test('a copy drops the logins the run\'s plan froze, though the catalog no longer holds them', async (t) => {
  const records = fakePort(t);
  const session = await startRunReview(HOSTED_ENV, {
    surface: 'dm',
    grantsWebsiteLogins: false,
    planWebsiteLogins: [{ host: 'portal.example.org', username: USERNAME }, { host: 'ledger.example.net' }],
    settings: () => catalogSettings('[]'),
  });
  await session!.finish({
    ...ENDING,
    answer: `Signed in to https://portal.example.org/home?sid=SYNTHSID as ${USERNAME}, then https://ledger.example.net/r?t=SYNTHT`,
  });
  assert.equal(records.length, 1);
  assert.equal(records[0]!.answer,
    'Signed in to https://portal.example.org/home?[omitted] as [credential redacted], then https://ledger.example.net/r?[omitted]');
});

test('a catalog that cannot be read or parsed keeps no copy', async (t) => {
  const records = fakePort(t);
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (line: string) => { warnings.push(line); });
  for (const settings of [catalogSettings('not json'), catalogSettings('{"logins":[]}'), catalogSettings(undefined, true)]) {
    const session = await startRunReview(HOSTED_ENV, { surface: 'dm', grantsWebsiteLogins: false, settings: () => settings });
    await session!.finish(ENDING);
  }
  assert.equal(records.length, 0);
  assert.deepEqual(warnings, Array(3).fill(JSON.stringify({ component: 'run_review', event: 'record_failed' })));

  const none = await startRunReview(HOSTED_ENV, { surface: 'dm', grantsWebsiteLogins: false, settings: () => catalogSettings(undefined) });
  await none!.finish(ENDING);
  assert.equal(records.length, 1, 'an installation with no logins is copied');
});

test('a copy past the scrub\'s caps or its budget is not kept, and its one log line names only the reason', async (t) => {
  const records = fakePort(t);
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (line: string) => { warnings.push(line); });
  const catalog = (usernames: readonly string[]) =>
    JSON.stringify(usernames.map((username, index) => ({ host: `site${index}.example.com`, username })));
  const long = (index: number, length: number) => `${`ops.${index}.${'synthetic.'.repeat(40)}`.slice(0, length - 12)}@example.com`;
  const cases: Array<[readonly string[], RunReviewEnding]> = [
    [Array.from({ length: 501 }, (_, index) => `ops.synthetic.${index}@example.com`), ENDING],
    [[long(0, 321)], ENDING],
    // Usernames that end one another, against runs of their one letter: every position ends hundreds of them.
    [Array.from({ length: 317 }, (_, index) => 'a'.repeat(index + 4)), {
      ...ENDING,
      context: Array.from({ length: 8 }, () => ({ author: 'Ledger Agent', role: 'agent' as const, text: 'a'.repeat(16_000), files: [] })),
    }],
  ];
  for (const [usernames, ending] of cases) {
    const session = await startRunReview(HOSTED_ENV, { surface: 'dm', grantsWebsiteLogins: false, settings: () => catalogSettings(catalog(usernames)) });
    await session!.finish(ending);
  }
  assert.equal(records.length, 0);
  assert.deepEqual(warnings, ['scrub_over_logins', 'scrub_over_logins', 'scrub_over_budget']
    .map((event) => JSON.stringify({ component: 'run_review', event })));

  const atCaps = Array.from({ length: 500 }, (_, index) => long(index, 320));
  const session = await startRunReview(HOSTED_ENV, { surface: 'dm', grantsWebsiteLogins: false, settings: () => catalogSettings(catalog(atCaps)) });
  await session!.finish({ ...ENDING, answer: `Signed in as ${atCaps[499]}` });
  assert.equal(records[0]?.answer, 'Signed in as [credential redacted]', 'a copy at the caps is kept');
});

test('a copy built from settled history drops the same values', async (t) => {
  const records = fakePort(t);
  const session = await startRunReview(HOSTED_ENV, { surface: 'dm', grantsWebsiteLogins: false, settings: () => catalogSettings(OTHER_AGENTS_CATALOG) });
  await session!.finish({
    ...ENDING,
    history: {
      submissionId: SUBMISSION,
      read: async () => ({
        v: 1, conversationId: 'conversation', offset: '1', settlements: [],
        messages: [{
          id: 'm', role: 'assistant', purpose: 'assistant', display: 'visible', submissionId: SUBMISSION,
          parts: [
            {
              type: 'dynamic-tool', toolName: 'browser_snapshot', toolCallId: 'c1', state: 'output-available', input: {},
              output: { url: 'https://ledger.example.net/callback?code=SYNTHCODE123', snapshot: '- text "LEDGER.SYNTHETIC@EXAMPLE.COM"' },
            },
            { type: 'text', text: 'Signed in as ledger.synthetic@example.com at https://ledger.example.net/x#access_token=SYNTHTOKEN789', state: 'done' },
          ],
        }],
      }),
    },
  });
  assert.equal(records[0]?.source, 'history');
  assert.deepEqual(kept(records[0]!, ['ledger.synthetic', 'SYNTHCODE123', 'SYNTHTOKEN789']), []);
});

// ---------------------------------------------------------------------------
// One synthetic signed-in run, through the real browser tools
// ---------------------------------------------------------------------------

const PASSWORD = 'Synthetic-Pass-0451';
const TOTP_SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const SIGNED_IN_URL = 'https://billing.example.com/callback?login_hint=ops.synthetic%40example.com&code=SYNTHCODE123#access_token=SYNTHTOKEN789';

const ax = (nodeId: string, role: string, extra: Partial<AXNode> & { label?: string; text?: string } = {}): AXNode => {
  const { label, text, ...rest } = extra;
  return {
    nodeId, role: { type: 'role', value: role },
    ...(label ? { name: { type: 'computedString', value: label } } : {}),
    ...(text === undefined ? {} : { value: { type: 'string', value: text } }),
    ...rest,
  };
};

/** A sign-in page that keeps what was typed in its fields, then shows the account split across elements. */
class SignInPage extends FakeCdpSocket {
  url = 'https://billing.example.com/login';
  typed: string[] = [];
  #focused = 0;
  #signedIn = false;

  constructor() {
    super();
    for (const [method, responder] of FakeCdpSocket.withPage().responders) this.responders.set(method, responder);
    this.responders.set('Page.navigate', (message) => {
      this.url = String(message.params.url);
      queueMicrotask(() => this.emitEvent('Page.loadEventFired', {}, 'page-1'));
      return { result: { frameId: 'f1', loaderId: 'l1' } };
    });
    this.responders.set('Runtime.evaluate', (message) => ({
      result: String(message.params.expression).includes('location.href')
        ? { result: { type: 'object', value: { url: this.url, title: this.#signedIn ? 'Billing' : 'Sign in' } } }
        : { result: { type: 'string', value: 'complete' } },
    }));
    this.responders.set('DOM.focus', (message) => {
      this.#focused = Number(message.params.backendNodeId);
      return { result: {} };
    });
    this.responders.set('Input.insertText', (message) => {
      this.typed[this.#focused - 11] = String(message.params.text);
      return { result: {} };
    });
    this.responders.set('Input.dispatchMouseEvent', (message) => {
      if (message.params.type === 'mousePressed') {
        this.#signedIn = true;
        this.url = SIGNED_IN_URL;
      }
      return { result: {} };
    });
    this.responders.set('DOM.getBoxModel', () => ({ result: { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } } }));
    this.responders.set('Accessibility.getFullAXTree', () => ({ result: { nodes: this.#tree() } }));
  }

  #tree(): AXNode[] {
    const [username = '', password = '', code = ''] = this.typed;
    const form = [
      ax('2', 'textbox', { parentId: '1', label: 'Email', backendDOMNodeId: 11, text: username }),
      ax('3', 'textbox', { parentId: '1', label: 'Password', backendDOMNodeId: 12, text: password }),
      ax('4', 'textbox', { parentId: '1', label: 'Authentication code', backendDOMNodeId: 13, text: code }),
      ax('5', 'button', { parentId: '1', label: 'Sign in', backendDOMNodeId: 14 }),
    ];
    if (!this.#signedIn) return [ax('1', 'RootWebArea', { childIds: ['2', '3', '4', '5'] }), ...form];
    return [
      ax('1', 'RootWebArea', { childIds: ['6', '7', '8', '9', '10'] }),
      ax('6', 'StaticText', { parentId: '1', label: 'Signed in as' }),
      ax('7', 'StaticText', { parentId: '1', label: 'Ops.Synthetic' }),
      ax('8', 'StaticText', { parentId: '1', label: '@' }),
      ax('9', 'StaticText', { parentId: '1', label: 'example.com' }),
      ax('10', 'StaticText', { parentId: '1', label: `Welcome back, ${username.toLowerCase()}. Invoice INV-2041 is due.` }),
    ];
  }
}

async function signedInRun() {
  const store = new SqliteSettingsStore(':memory:');
  const deps = { store, keyring: generateCredentialKeyring('run_review_website_logins') };
  const login = await createWebsiteLogin(deps, {
    host: 'billing.example.com', label: 'Billing', ownerKind: 'team', createdByMembershipId: 'mem_owner',
    method: 'credentials', username: USERNAME, password: PASSWORD, totpSeed: TOTP_SEED,
  });
  const page = new SignInPage();
  const { provider } = fakeBrowserProvider({ createContext: async () => ({ id: 'ctx-1' }) });
  const session = new BrowserTurnSession({ provider, connect: async () => page, sleep: async () => undefined });
  const granted = [{ id: login.id, host: login.host, label: login.label, level: 'check' as const, method: login.method, username: USERNAME }];
  const tools = createBrowserTools({
    session,
    stageArtifact: async (input) => ({ attached: true, byteLength: input.bytes.byteLength }),
    transportMaxBytes: async () => undefined,
    sleep: async () => undefined,
    now: () => new Date(Date.UTC(2026, 10, 10, 12)),
    logins: { granted, readLive: async () => granted, dependencies: async () => deps },
  });
  const calls: Array<{ name: string; input: Record<string, unknown>; output: unknown }> = [];
  const run = async (name: string, input: Record<string, unknown> = {}) => {
    const tool = tools.find((each) => each.name === name)!;
    const result = await (tool.run as (context: unknown) => Promise<{ output: unknown }>)({
      data: v.parse(tool.input as v.GenericSchema, input), toolCallId: `call_${calls.length}`, log: { info() {}, warn() {}, error() {} },
    });
    calls.push({ name, input, output: JSON.parse(JSON.stringify(result.output)) });
  };
  await run('browser_open', { url: 'https://billing.example.com/login?next=%2Finvoices' });
  await run('browser_sign_in', { loginId: login.id, usernameRef: 'e1', passwordRef: 'e2', codeRef: 'e3', submitRef: 'e4' });
  await run('browser_snapshot');
  await session.close();
  const answer = 'Signed in as ops.synthetic@example.com; the callback was ' +
    'https://billing.example.com/callback?code=SYNTHCODE123. Invoice INV-2041 is due.';
  const code = page.typed[2]!;
  assert.match(code, /^\d{6}$/);
  assert.equal(page.typed[1], PASSWORD, 'the page received the password');
  const rawTrace = JSON.stringify(calls);
  assert.match(rawTrace, /Ops\.Synthetic/, 'the Agent sees the username, so the copy must remove it');
  assert.match(rawTrace, /SYNTHCODE123/, 'and the page URL with its query');
  return { store, calls, answer, code };
}

// The hand-off message a 1:1 DM keeps, which the next turn's context reads back.
const DM_CONTEXT: RunReviewEnding['context'] = [
  { author: 'Billing Agent', role: 'agent', text: browserHandoffMessage('billing.example.com', LIVE_VIEW_URL), files: [] },
  { author: 'U012ABCDEF3', role: 'human', text: 'Done, I signed in as Ops.Synthetic@example.com', files: [] },
];

test('one synthetic signed-in run, streamed or read from history, keeps its page content and none of the login', async (t) => {
  const records = fakePort(t);
  const { store, calls, answer, code } = await signedInRun();
  const secrets = [
    'ops.synthetic', PASSWORD, code, 'SYNTHCODE123', 'SYNTHTOKEN789', 'browserbase', 'SYNTHSESS', TOTP_SEED,
  ];

  const streamed = await startRunReview(HOSTED_ENV, { surface: 'dm', grantsWebsiteLogins: false, settings: () => store });
  streamed!.ingest(chunk({ type: 'message-started', messageId: 'm', submissionId: SUBMISSION }), SUBMISSION);
  calls.forEach((call, index) => {
    streamed!.ingest(chunk({ type: 'tool-input', messageId: 'm', toolCallId: `c${index}`, toolName: call.name, input: call.input }), SUBMISSION);
    streamed!.ingest(chunk({ type: 'tool-output', toolCallId: `c${index}`, output: call.output }), SUBMISSION);
  });
  streamed!.ingest(chunk({ type: 'message-delta', messageId: 'm', kind: 'text', delta: answer }), SUBMISSION);
  await streamed!.finish({ ...ENDING, context: DM_CONTEXT, answer });

  const settled = await startRunReview(HOSTED_ENV, { surface: 'dm', grantsWebsiteLogins: false, settings: () => store });
  await settled!.finish({
    ...ENDING,
    context: DM_CONTEXT,
    answer,
    history: {
      submissionId: SUBMISSION,
      read: async () => ({
        v: 1, conversationId: 'conversation', offset: '1', settlements: [],
        messages: [{
          id: 'm', role: 'assistant', purpose: 'assistant', display: 'visible', submissionId: SUBMISSION,
          parts: [
            ...calls.map((call, index) => ({
              type: 'dynamic-tool' as const, toolName: call.name, toolCallId: `c${index}`, state: 'output-available' as const,
              input: call.input, output: call.output,
            })),
            { type: 'text' as const, text: answer, state: 'done' as const },
          ],
        }],
      }),
    },
  });

  assert.deepEqual(records.map((record) => record.source), ['stream', 'history']);
  for (const record of records) {
    assert.deepEqual(kept(record, secrets), [], record.source);
    assert.equal(record.steps.filter((step) => step.kind === 'tool').length, 3, 'every browser step is kept');
    assert.match(JSON.stringify(record), /Invoice INV-2041 is due/, 'signed-in page content is kept');
    assert.match(JSON.stringify(record), /https:\/\/billing\.example\.com\/callback\?\[omitted\]/);
  }
});
