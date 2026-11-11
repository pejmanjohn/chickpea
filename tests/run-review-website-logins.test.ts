import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import type { ConversationStreamChunk } from '@flue/runtime';
import * as v from 'valibot';

import { createWebsiteLogin, WEBSITE_LOGINS_SETTING } from '../src/browser/logins.ts';
import type { AXNode } from '../src/browser/page.ts';
import { browserHandoffMessage } from '../src/browser/requester.ts';
import { createBrowserTools } from '../src/browser/tools.ts';
import { BrowserTurnSession } from '../src/browser/turn-session.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore, type SettingsStore } from '../src/config/settings-store.ts';
import { startRunReview, type RunReviewEnding } from '../src/review/capture.ts';
import { COLLECTED_FIELD_CHARS } from '../src/review/collector.ts';
import { configureRunReview, type RunReviewPort } from '../src/review/port.ts';
import {
  buildRunReviewRecord,
  RUN_REVIEW_FIELD_BYTES,
  runReviewPseudonymizer,
  type RunReviewInput,
  type RunReviewRecordV1,
} from '../src/review/record.ts';
import { BROWSER_LINK_OMITTED, type RunReviewWebsiteLogins } from '../src/review/website-logins.ts';
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
  assert.equal(opened?.input, '{"url":"https://billing.example.com/u/[credential redacted]/callback?[omitted]"}');

  const hostWord = copy({ answer: 'See https://billing.example.com/callback?code=SYNTHCODE123' },
    { hosts: ['billing.example.com'], usernames: ['billing'] });
  assert.equal(hostWord.answer, 'See https://[credential redacted].example.com/callback?[omitted]',
    'a username that is part of the host replaces only that word, after the URL lost its query');
});

test('a URL on a login\'s site, or any URL in a browser step, keeps its scheme, host and path', () => {
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
  assert.equal(record.trigger.text, 'Use <http://billing.example.com/magic?[omitted]|billing.example.com/magic?[omitted]> ' +
    'or https://search.example/x, and see https://search.example/?q=kept#top');
  assert.equal(record.context[0]?.text, 'Reset: https://ledger.example.net/reset/[omitted]');
  const [opened, snapshot] = record.steps;
  assert.ok(opened?.kind === 'tool' && snapshot?.kind === 'tool');
  assert.equal(opened.input, '{"url":"docs.example.org/guide?[omitted]"}');
  assert.match(opened.output ?? '', /"url":"https:\/\/app\.billing\.example\.com\/home\?\[omitted\]"/);
  assert.equal(snapshot.output, '{"url":"https://search.example/?[omitted]"}', 'in a browser step every URL loses its query');
  assert.equal(record.answer, 'Signed in: https://billing.example.com/callback?[omitted] ' +
    'Help: https://billing.example.com/help/how-to-update-your-billing-address and /invoices/INV-2041. ' +
    'Public: https://search.example/?q=kept#top. Elsewhere: https://auth.example.com/magic?token=PERSONS-OWN-LINK',
  'a slug, a short ID, a public query and another site\'s link a person shares stay');
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
  assert.equal(opened.input, '{"url":"https://portal.example.org/users/o\'brien/callback?[omitted]"}');
  assert.match(opened.output ?? '', /"url":"https:\/\/billing\.example\.com\/callback\?\[omitted\]"/);
  assert.equal(JSON.parse(read.output ?? '{}').text, '{"link":"https://billing.example.com/magic?[omitted]","next":"x"}');
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

  // Anyone can write the label. What it wraps is removed elsewhere only as a whole web address,
  // so it cannot break up a link or a username before their own rules see them.
  const written = copy({
    trigger: {
      author: 'U012ABCDEF3',
      text: '<.|Open the browser> <then|Open the browser> <https://billing.example.com/c|Open the browser> then ' +
        'https://billing.example.com/callback?code=SYNTHCODE123 as Ops.Synthetic@example.com',
      files: [],
    },
  });
  assert.deepEqual(kept(written, ['SYNTHCODE123', 'ops.synthetic', 'synthetic@']), []);
  assert.equal(written.trigger.text, `${BROWSER_LINK_OMITTED} ${BROWSER_LINK_OMITTED} ${BROWSER_LINK_OMITTED} then ` +
    'https://billing.example.com/callback?[omitted] as [credential redacted]');
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

test('a username split across snapshot lines, or cut before a … or at the collector\'s cap, leaves no part of it', () => {
  const split = '- text "Account"\n  - text "Ops.Synthetic"\n  - link "@" [ref=e4]\n  - text "example.com"';
  const cutAtSnapshotCap = `- text "Signed in as Ops.Synthetic@ex\n… (snapshot cut at 12000 characters)`;
  const splitAfterState = '- button "Ops.Synthetic" [ref=e3] expanded\n  - text "@example.com"\n- heading "Ops.Synthetic" level=2\n- text "@example.com"';
  const longQuery = `https://billing.example.com/report?filter=${'x'.repeat(200)} `;
  const cutEnd = ' Signed in as Ops.Synth';
  const collected = longQuery.repeat(Math.ceil(COLLECTED_FIELD_CHARS / longQuery.length))
    .slice(0, COLLECTED_FIELD_CHARS - cutEnd.length) + cutEnd;
  assert.equal(collected.length, COLLECTED_FIELD_CHARS);
  const record = copy({
    context: [{ author: 'Billing Agent', role: 'agent', text: 'Signed in as Ops.Synth…', files: [] }],
    steps: [
      browserStep('browser_snapshot', {}, { snapshot: split }),
      browserStep('browser_snapshot', {}, { snapshot: cutAtSnapshotCap }),
      browserStep('browser_snapshot', {}, { snapshot: splitAfterState }),
      browserStep('browser_snapshot', {}, { snapshot: '- textbox "Email" [ref=e1] value="Ops.Synthetic@exam…"' }),
      { kind: 'tool', name: 'web_fetch', input: '{}', output: collected },
    ],
  });
  assert.deepEqual(kept(record, ['ops.synth']), []);
  const outputs = record.steps.map((step) => step.kind === 'tool' ? step.output ?? '' : '');
  assert.equal(JSON.parse(outputs[0]!).snapshot, '- text "Account"\n  - text "[credential redacted]"');
  assert.equal(JSON.parse(outputs[1]!).snapshot, '- text "Signed in as [credential redacted]\n… (snapshot cut at 12000 characters)');
  assert.equal(JSON.parse(outputs[2]!).snapshot, '- button "[credential redacted]"\n- heading "[credential redacted]"');
  assert.equal(record.context[0]?.text, 'Signed in as [credential redacted]…');
  assert.ok(new TextEncoder().encode(outputs[4]!).byteLength < RUN_REVIEW_FIELD_BYTES,
    'the cut field shrank below the record\'s cap, so its cut end reaches the copy');
  assert.match(outputs[4]!, /Signed in as \[credential redacted\]$/);
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
  const session = await startRunReview(HOSTED_ENV, { surface: 'channel', settings: () => settings });
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

test('a catalog that cannot be read or parsed keeps no copy', async (t) => {
  const records = fakePort(t);
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (line: string) => { warnings.push(line); });
  for (const settings of [catalogSettings('not json'), catalogSettings('{"logins":[]}'), catalogSettings(undefined, true)]) {
    const session = await startRunReview(HOSTED_ENV, { surface: 'dm', settings: () => settings });
    await session!.finish(ENDING);
  }
  assert.equal(records.length, 0);
  assert.deepEqual(warnings, Array(3).fill(JSON.stringify({ component: 'run_review', event: 'record_failed' })));

  const none = await startRunReview(HOSTED_ENV, { surface: 'dm', settings: () => catalogSettings(undefined) });
  await none!.finish(ENDING);
  assert.equal(records.length, 1, 'an installation with no logins is copied');
});

test('a copy built from settled history drops the same values', async (t) => {
  const records = fakePort(t);
  const session = await startRunReview(HOSTED_ENV, { surface: 'dm', settings: () => catalogSettings(OTHER_AGENTS_CATALOG) });
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

  const streamed = await startRunReview(HOSTED_ENV, { surface: 'dm', settings: () => store });
  streamed!.ingest(chunk({ type: 'message-started', messageId: 'm', submissionId: SUBMISSION }), SUBMISSION);
  calls.forEach((call, index) => {
    streamed!.ingest(chunk({ type: 'tool-input', messageId: 'm', toolCallId: `c${index}`, toolName: call.name, input: call.input }), SUBMISSION);
    streamed!.ingest(chunk({ type: 'tool-output', toolCallId: `c${index}`, output: call.output }), SUBMISSION);
  });
  streamed!.ingest(chunk({ type: 'message-delta', messageId: 'm', kind: 'text', delta: answer }), SUBMISSION);
  await streamed!.finish({ ...ENDING, context: DM_CONTEXT, answer });

  const settled = await startRunReview(HOSTED_ENV, { surface: 'dm', settings: () => store });
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
