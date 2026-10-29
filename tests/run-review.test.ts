import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import type { ConversationStreamChunk } from '@flue/runtime';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import type { SettingsPatch, SettingsStore } from '../src/config/settings-store.ts';
import {
  RUN_REVIEW_PSEUDONYM_SETTING,
  slackRunReviewConversation,
  startRunReview,
  type RunReviewEnding,
} from '../src/review/capture.ts';
import { RunReviewCollector } from '../src/review/collector.ts';
import {
  configureRunReview,
  runReview,
  runReviewConfigured,
  type RunReviewPort,
} from '../src/review/port.ts';
import {
  buildRunReviewRecord,
  OTHER_CONVERSATION_OMITTED,
  RUN_REVIEW_FIELD_BYTES,
  RUN_REVIEW_READS_OMITTED_UNLESS_CURRENT,
  RUN_REVIEW_RECORD_BYTES,
  runReviewPseudonymizer,
  type RunReviewInput,
  type RunReviewRecordV1,
} from '../src/review/record.ts';
import { encodeBase64Url } from '../src/security/base64url.ts';
import { SLACK_LIST_TOOL_NAMES } from '../src/slack/lists/tools.ts';
import { SLACK_READ_TOOL_NAMES } from '../src/slack/reading/tools.ts';
import { RUNNER_PREFETCHED_SETTINGS, runnerPrefetchedSettings } from '../src/slack/thread-runner-rpc.ts';

const INSTALLATION = 'inst_review';
const HOSTED_ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: INSTALLATION });
const PRIVACY_URL = 'https://chickpea.example/privacy#help-improve-chickpea';
// Assembled at runtime so push protection never mistakes it for a real Slack token.
const SYNTHETIC_SLACK_TOKEN = ['xox', 'b'].join('') + '-' + ['1234567890', 'abcdefghijklmnop'].join('-');
const KEY = new Uint8Array(32).fill(7);
const SUBMISSION = 'sub_review';

function fakePort(t: TestContext, overrides: Partial<RunReviewPort> = {}) {
  const records: Array<{ installationId: string; record: RunReviewRecordV1 }> = [];
  const capturingCalls: string[] = [];
  configureRunReview({
    enabled: async () => true,
    setEnabled: async (_id, change) => change.enabled,
    capturing: async (installationId) => {
      capturingCalls.push(installationId);
      return true;
    },
    record: async (installationId, record) => {
      records.push({ installationId, record });
    },
    privacyUrl: PRIVACY_URL,
    ...overrides,
  });
  t.after(() => configureRunReview(undefined));
  return { records, capturingCalls };
}

function memorySettings(): SettingsStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getSetting: async (key) => values.get(key),
    getSettings: async (keys) => keys.map((key) => values.get(key)),
    setSetting: async (key, value) => { values.set(key, value); },
    deleteSetting: async (key) => { values.delete(key); },
    applySettingsPatch: async (patch: SettingsPatch) => {
      if (patch.expected && (values.get(patch.expected.key) ?? null) !== patch.expected.value) return false;
      for (const write of patch.set ?? []) values.set(write.key, write.value);
      return true;
    },
    mergeSettingStringSet: async () => [],
  };
}

let index = 0;
function chunk(body: Record<string, unknown>): ConversationStreamChunk {
  index += 1;
  return { conversationId: 'conversation', position: { batch: 1, index }, ...body } as ConversationStreamChunk;
}

function input(overrides: Partial<RunReviewInput> = {}): RunReviewInput {
  return {
    runId: 'run_review',
    recordedAt: '2026-10-25T12:00:00.000Z',
    surface: 'channel',
    agentId: 'agent_review',
    trigger: { author: 'U012ABCDEF3', text: 'Summarize the thread.', files: [] },
    context: [],
    steps: [],
    outcome: 'succeeded',
    timings: { settledAt: '2026-10-25T12:00:01.000Z' },
    truncated: false,
    source: 'stream',
    ...overrides,
  };
}

const ENDING: RunReviewEnding = {
  runId: 'run_review',
  agentId: 'agent_review',
  trigger: { author: 'U012ABCDEF3', text: 'Summarize the thread.', files: [] },
  context: [],
  answer: 'Here is the summary.',
  outcome: 'succeeded',
};

test('no port is the default, and a port needs an https privacy URL', (t) => {
  assert.equal(runReview(), undefined);
  assert.equal(runReviewConfigured(), false);
  const port: RunReviewPort = {
    enabled: async () => false,
    setEnabled: async () => false,
    capturing: async () => false,
    record: async () => {},
    privacyUrl: 'http://chickpea.example/privacy',
  };
  assert.throws(() => configureRunReview(port), /https/);
  assert.throws(() => configureRunReview({ ...port, privacyUrl: '/privacy' }), /https/);
  assert.equal(runReview(), undefined, 'a refused port is not installed');
  t.after(() => configureRunReview(undefined));
  configureRunReview({ ...port, privacyUrl: PRIVACY_URL });
  assert.equal(runReviewConfigured(), true);
  configureRunReview(undefined);
  assert.equal(runReview(), undefined);
});

test('a thread runner prefetches the review key only where the host captures runs', (t) => {
  assert.deepEqual(runnerPrefetchedSettings(), RUNNER_PREFETCHED_SETTINGS);
  fakePort(t);
  assert.deepEqual(runnerPrefetchedSettings(), [...RUNNER_PREFETCHED_SETTINGS, RUN_REVIEW_PSEUDONYM_SETTING]);
});

test('a session starts only with a port, an installation, a capturing host and an unshared channel', async (t) => {
  const settings = () => memorySettings();
  assert.equal(await startRunReview(HOSTED_ENV, { surface: 'channel', grantsWebsiteLogins: false, settings }), undefined, 'no port');

  const { capturingCalls } = fakePort(t);
  assert.equal(await startRunReview({}, { surface: 'channel', grantsWebsiteLogins: false, settings }), undefined, 'standalone has no installation');
  assert.equal(await startRunReview(HOSTED_ENV, { surface: 'channel', grantsWebsiteLogins: false, sharedChannel: true, settings }), undefined);
  assert.deepEqual(capturingCalls, [], 'neither asks the host');
  assert.ok(await startRunReview(HOSTED_ENV, { surface: 'channel', grantsWebsiteLogins: false, settings }));
  assert.deepEqual(capturingCalls, [INSTALLATION]);

  configureRunReview({ ...runReview()!, capturing: async () => false });
  assert.equal(await startRunReview(HOSTED_ENV, { surface: 'dm', grantsWebsiteLogins: false, settings }), undefined, 'the host is not capturing');
  t.mock.method(console, 'warn', () => undefined);
  configureRunReview({ ...runReview()!, capturing: async () => { throw new Error('registry down'); } });
  assert.equal(await startRunReview(HOSTED_ENV, { surface: 'dm', grantsWebsiteLogins: false, settings }), undefined, 'a failing answer fails closed');
  configureRunReview({ ...runReview()!, capturing: () => { throw new Error('registry down'); } });
  assert.equal(await startRunReview(HOSTED_ENV, { surface: 'dm', grantsWebsiteLogins: false, settings }), undefined, 'so does a synchronous throw');
});

test('a run whose plan grants a website login is never captured, and says why without content', async (t) => {
  const { capturingCalls } = fakePort(t);
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (line: string) => { warnings.push(line); });
  assert.equal(await startRunReview(HOSTED_ENV, { surface: 'dm', grantsWebsiteLogins: true, settings: () => memorySettings() }),
    undefined);
  assert.deepEqual(capturingCalls, [INSTALLATION]);
  assert.deepEqual(warnings, [JSON.stringify({ component: 'run_review', event: 'website_logins_granted' })]);
});

test('a slow capturing answer fails closed after about a second', async (t) => {
  fakePort(t, { capturing: () => new Promise<boolean>(() => {}) });
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (line: string) => { warnings.push(line); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = startRunReview(HOSTED_ENV, { surface: 'channel', grantsWebsiteLogins: false, settings: () => memorySettings() });
  await Promise.resolve();
  t.mock.timers.tick(1_000);
  assert.equal(await started, undefined);
  assert.deepEqual(warnings, [JSON.stringify({ component: 'run_review', event: 'capturing_unavailable' })]);
});

test('the collector keeps one submission and joins each tool call to its result', () => {
  const collector = new RunReviewCollector(SUBMISSION);
  for (const event of [
    // An earlier turn in the same thread replays first.
    chunk({ type: 'message-started', messageId: 'earlier', submissionId: 'sub_earlier' }),
    chunk({ type: 'message-delta', messageId: 'earlier', kind: 'text', delta: 'Old answer.' }),
    chunk({ type: 'message-started', messageId: 'step1', submissionId: SUBMISSION }),
    chunk({ type: 'message-delta', messageId: 'step1', kind: 'reasoning', delta: 'Read the ' }),
    chunk({ type: 'message-delta', messageId: 'step1', kind: 'reasoning', delta: 'thread first.' }),
    chunk({ type: 'tool-input', messageId: 'step1', toolCallId: 'call1', toolName: 'read_slack_thread', input: { limit: 5 } }),
    chunk({ type: 'tool-input', messageId: 'earlier', toolCallId: 'call0', toolName: 'other_turn', input: {} }),
    chunk({ type: 'data-part', messageId: 'step1', name: 'workspace-milestone', data: { secret: 'plumbing' } }),
    chunk({ type: 'tool-output', toolCallId: 'call1', output: { messages: 2 }, durationMs: 40 }),
    chunk({ type: 'tool-output', toolCallId: 'call0', output: 'not ours' }),
    chunk({ type: 'message-started', messageId: 'step2', submissionId: SUBMISSION }),
    chunk({ type: 'tool-input', messageId: 'step2', toolCallId: 'call2', toolName: 'web_fetch', input: 'https://x.example' }),
    chunk({ type: 'tool-output-error', toolCallId: 'call2', errorText: 'timed out', durationMs: 5000 }),
    chunk({ type: 'message-delta', messageId: 'step2', kind: 'text', delta: 'Here is ' }),
    chunk({ type: 'message-delta', messageId: 'step2', kind: 'text', delta: 'the summary.' }),
  ]) collector.ingest(event);
  assert.deepEqual(collector.steps(), [
    { kind: 'reasoning', text: 'Read the thread first.' },
    { kind: 'tool', name: 'read_slack_thread', input: '{"limit":5}', output: '{"messages":2}', durationMs: 40 },
    { kind: 'tool', name: 'web_fetch', input: 'https://x.example', error: 'timed out', durationMs: 5000 },
    { kind: 'text', text: 'Here is the summary.' },
  ]);
  assert.equal(collector.truncated, false);
});

test('a redelivered chunk counts once, and a reset replaces what the stream showed', () => {
  const collector = new RunReviewCollector(SUBMISSION);
  const started = chunk({ type: 'message-started', messageId: 'step1', submissionId: SUBMISSION });
  const delta = chunk({ type: 'message-delta', messageId: 'step1', kind: 'text', delta: 'Draft.' });
  for (const event of [started, delta, delta]) collector.ingest(event);
  assert.deepEqual(collector.steps(), [{ kind: 'text', text: 'Draft.' }]);
  collector.ingest(chunk({
    type: 'conversation-reset',
    snapshot: {
      v: 1, conversationId: 'conversation', offset: '9', settlements: [],
      messages: [
        { id: 'user', role: 'user', purpose: 'user', display: 'visible', submissionId: SUBMISSION, parts: [{ type: 'text', text: 'the prompt', state: 'done' }] },
        {
          id: 'step1', role: 'assistant', purpose: 'assistant', display: 'visible', submissionId: SUBMISSION,
          parts: [
            { type: 'file', mediaType: 'image/png', url: 'https://files.example/private.png', filename: 'chart.png' },
            { type: 'data-receipt', data: { id: 'x' } },
            { type: 'dynamic-tool', toolName: 'search', toolCallId: 'call9', state: 'output-available', input: { q: 'a' }, output: ['b'] },
            { type: 'text', text: 'Final.', state: 'done' },
          ],
        },
      ],
    },
  }));
  assert.deepEqual(collector.steps(), [
    { kind: 'tool', name: 'search', input: '{"q":"a"}', output: '["b"]' },
    { kind: 'text', text: 'Final.' },
  ]);
});

test('the collector cuts long fields and drops its oldest steps past its budget', () => {
  const collector = new RunReviewCollector(SUBMISSION);
  collector.ingest(chunk({ type: 'message-started', messageId: 'step', submissionId: SUBMISSION }));
  collector.ingest(chunk({ type: 'tool-input', messageId: 'step', toolCallId: 'first', toolName: 'first', input: {} }));
  for (let call = 0; call < 40; call += 1) {
    collector.ingest(chunk({ type: 'tool-input', messageId: 'step', toolCallId: `call${call}`, toolName: 'read', input: {} }));
    collector.ingest(chunk({ type: 'tool-output', toolCallId: `call${call}`, output: 'x'.repeat(100_000) }));
  }
  const steps = collector.steps();
  assert.equal(collector.truncated, true);
  assert.ok(steps.every((step) => step.kind !== 'tool' || (step.output?.length ?? 0) <= 32 * 1024));
  assert.notEqual(steps[0]?.kind === 'tool' && steps[0].name, 'first', 'the oldest step went first');
  assert.ok(steps.length < 41);
});

test('history holds the settled submission when the stream was never observed', () => {
  const collector = RunReviewCollector.fromHistory({
    v: 1, conversationId: 'conversation', offset: '3', settlements: [],
    messages: [
      { id: 'other', role: 'assistant', purpose: 'assistant', display: 'visible', submissionId: 'sub_other', parts: [{ type: 'text', text: 'no', state: 'done' }] },
      {
        id: 'mine', role: 'assistant', purpose: 'assistant', display: 'visible', submissionId: SUBMISSION,
        parts: [
          { type: 'reasoning', text: 'Think.', state: 'done' },
          { type: 'dynamic-tool', toolName: 'fail', toolCallId: 'c1', state: 'output-error', input: {}, errorText: 'nope', durationMs: 2 },
          { type: 'text', text: 'Done.', state: 'done' },
        ],
      },
    ],
  }, SUBMISSION);
  assert.deepEqual(collector.steps(), [
    { kind: 'reasoning', text: 'Think.' },
    { kind: 'tool', name: 'fail', input: '{}', error: 'nope', durationMs: 2 },
    { kind: 'text', text: 'Done.' },
  ]);
});

test('every Slack user ID in every string becomes the same per-installation pseudonym', () => {
  const pseudonymOf = runReviewPseudonymizer(KEY);
  const record = buildRunReviewRecord(input({
    trigger: { author: 'U012ABCDEF3', text: 'Ask <@U012ABCDEF3|ana> and <@W0987ZYXWV1> to UNDERSTAND', files: [] },
    context: [
      { author: 'U0ZZZZZZZZ9', role: 'human', text: 'ping U012ABCDEF3', files: [{ name: 'notes.txt', size: 12 }] },
      { author: 'Helper Agent', role: 'agent', text: 'Agent row', files: [] },
    ],
    steps: [{
      kind: 'tool', name: 'read_slack_thread', input: '{}',
      output: '{"conversation":{"id":"C012ABCDEF3","kind":"channel","current":true},' +
        '"messages":[{"author":{"kind":"person","id":"U012ABCDEF3","name":"Ana"}}]}',
    }],
  }), pseudonymOf);
  const ana = pseudonymOf('U012ABCDEF3');
  assert.match(ana, /^u_[0-9a-f]{20}$/);
  assert.equal(record.trigger.author, ana);
  assert.equal(record.trigger.text, `Ask <@${ana}|ana> and <@${pseudonymOf('W0987ZYXWV1')}> to UNDERSTAND`);
  assert.equal(record.context[0]?.author, pseudonymOf('U0ZZZZZZZZ9'));
  assert.equal(record.context[0]?.text, `ping ${ana}`);
  assert.deepEqual(record.context[0]?.files, [{ name: 'notes.txt', size: 12 }]);
  assert.equal(record.context[1]?.author, 'Helper Agent');
  const tool = record.steps[0];
  assert.equal(tool?.kind === 'tool' && tool.output,
    '{"conversation":{"id":"C012ABCDEF3","kind":"channel","current":true},' +
    `"messages":[{"author":{"kind":"person","id":"${ana}","name":"Ana"}}]}`);
  assert.equal(JSON.stringify(record).includes('U012ABCDEF3'), false);
  assert.notEqual(runReviewPseudonymizer(new Uint8Array(32).fill(8))('U012ABCDEF3'), ana, 'another installation differs');
});

test('a Slack read of another conversation, which may be a Slack Connect one, keeps its call but not its result', () => {
  const read = (name: string, output: string) => ({ kind: 'tool' as const, name, input: '{"channel":"C0OTHER123"}', output });
  const current = JSON.stringify({ status: 'ok', conversation: { id: 'C0HERE1234', kind: 'channel', current: true }, messages: [] });
  const other = JSON.stringify({ status: 'ok', conversation: { id: 'C0OTHER123', kind: 'channel', current: false }, messages: [{ text: 'partner notes' }] });
  const refused = JSON.stringify({ status: 'not_read', code: 'needs_agent_access', message: 'Ask an admin.' });
  const record = buildRunReviewRecord(input({
    steps: [
      read('read_slack_thread', current),
      read('read_slack_channel', other),
      read('read_slack_thread', other),
      read('read_slack_channel', refused),
      read('read_slack_thread', `${other.slice(0, 40)}`),
      read('lookup_slack_user', '{"id":"U0ZZZZZZZZ9","name":"Bo"}'),
    ],
  }), runReviewPseudonymizer(KEY));
  assert.deepEqual(record.steps.map((step) => step.kind === 'tool' && [step.name, step.input, step.output]), [
    ['read_slack_thread', '{"channel":"C0OTHER123"}', current],
    ['read_slack_channel', '{"channel":"C0OTHER123"}', OTHER_CONVERSATION_OMITTED],
    ['read_slack_thread', '{"channel":"C0OTHER123"}', OTHER_CONVERSATION_OMITTED],
    ['read_slack_channel', '{"channel":"C0OTHER123"}', refused],
    ['read_slack_thread', '{"channel":"C0OTHER123"}', OTHER_CONVERSATION_OMITTED],
    ['lookup_slack_user', '{"channel":"C0OTHER123"}', `{"id":"${runReviewPseudonymizer(KEY)('U0ZZZZZZZZ9')}","name":"Bo"}`],
  ]);
  assert.equal(JSON.stringify(record).includes('partner notes'), false);
  for (const name of RUN_REVIEW_READS_OMITTED_UNLESS_CURRENT) {
    assert.ok((SLACK_READ_TOOL_NAMES as readonly string[]).includes(name), `${name} is a Slack reading tool`);
  }
});

test('every Slack List tool, which says nothing of where its List is shared, keeps its call but not its output or error', () => {
  const list = JSON.stringify({ status: 'ok', list: { id: 'F0LIST1234', name: 'Partner launch' }, items: [{ task: 'partner notes' }] });
  // A write's readback mismatch carries the item it read back.
  const mismatch = JSON.stringify({ status: 'not_written', code: 'readback_mismatch', item: { task: 'partner notes' } });
  const call = (name: string, result: { output?: string; error?: string }) => ({
    kind: 'tool' as const, name, input: '{"listUrl":"https://x.slack.com/lists/T1/F0LIST1234"}', ...result,
  });
  const record = buildRunReviewRecord(input({
    steps: [
      call('read_slack_list', { output: list }),
      call('read_slack_list_item', { output: '{"status":"not_read"}' }),
      call('create_slack_list_item', { output: mismatch }),
      call('update_slack_list_item', { error: 'Slack readback differed: partner notes' }),
      ...SLACK_LIST_TOOL_NAMES.map((name) => call(name, { output: list, error: 'partner notes' })),
    ],
  }), runReviewPseudonymizer(KEY));
  for (const step of record.steps) {
    assert.ok(step.kind === 'tool' && (SLACK_LIST_TOOL_NAMES as readonly string[]).includes(step.name));
    assert.equal(step.input, '{"listUrl":"https://x.slack.com/lists/T1/F0LIST1234"}');
    if (step.output !== undefined) assert.equal(step.output, OTHER_CONVERSATION_OMITTED, step.name);
    if (step.error !== undefined) assert.equal(step.error, OTHER_CONVERSATION_OMITTED, step.name);
  }
  assert.deepEqual(record.steps.slice(0, 4).map((step) => step.kind === 'tool' && [step.name, 'output' in step, 'error' in step]), [
    ['read_slack_list', true, false],
    ['read_slack_list_item', true, false],
    ['create_slack_list_item', true, false],
    ['update_slack_list_item', false, true],
  ]);
  assert.equal(JSON.stringify(record).includes('partner notes'), false);
});

test('credentials are redacted before the cap, and the builder adds no Slack coordinates', () => {
  const record = buildRunReviewRecord(input({
    steps: [{ kind: 'tool', name: 'connection_request', input: `token ${SYNTHETIC_SLACK_TOKEN}`, output: 'ANTHROPIC_API_KEY=sk-not-a-real-key-123' }],
    answer: `Use ${SYNTHETIC_SLACK_TOKEN} please`,
    error: { class: 'Error', message: `failed with ${SYNTHETIC_SLACK_TOKEN}` },
  }), runReviewPseudonymizer(KEY));
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes(SYNTHETIC_SLACK_TOKEN), false);
  assert.equal(serialized.includes('sk-not-a-real-key'), false);
  assert.equal(record.answer, 'Use [credential redacted] please');
  assert.deepEqual(Object.keys(record).sort(), [
    'agentId', 'answer', 'context', 'error', 'format', 'outcome', 'recordedAt', 'runId', 'source', 'steps',
    'surface', 'timings', 'trigger', 'truncated',
  ]);
  assert.equal(record.format, 'chickpea.run-review.v1');
});

test('a key the run saved with save_connection_key leaves every field of the copy', () => {
  const key = ['sb', 'live', 'synthetic"Key\\value42'].join('_');
  const record = buildRunReviewRecord(input({
    trigger: { author: 'U12345678', text: `here is our key ${key} for https://api.statusboard.example/v2`, files: [] },
    context: [{ author: 'U12345678', role: 'human', text: `earlier: ${key}`, files: [] }],
    steps: [
      { kind: 'tool', name: 'save_connection_key', input: JSON.stringify({ connectionId: 'statusboard', key }), output: '{"check":{"kind":"ok"}}' },
      { kind: 'text', text: `Saved ${key}.` },
      { kind: 'tool', name: 'save_connection_key', input: '{"connectionId":"statusboard","key":"sb_live_cut' },
    ],
    answer: `Connected with ${key}`,
  }), runReviewPseudonymizer(KEY));
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes('synthetic'), false, serialized);
  assert.equal(record.trigger.text, 'here is our key [credential redacted] for https://api.statusboard.example/v2');
  assert.deepEqual(record.steps[0], {
    kind: 'tool',
    name: 'save_connection_key',
    input: '{"connectionId":"statusboard","key":"[credential redacted]"}',
    output: '{"check":{"kind":"ok"}}',
  });
  assert.equal(record.steps[2]?.kind === 'tool' && record.steps[2].input, '[input omitted]', 'a cut call is dropped whole');
  assert.equal(record.answer, 'Connected with [credential redacted]');
});

test('a field is cut to 16 KiB and the record to 256 KiB, oldest steps first', () => {
  const pseudonymOf = runReviewPseudonymizer(KEY);
  const single = buildRunReviewRecord(input({
    steps: [{ kind: 'tool', name: 'read', input: '{}', output: 'é'.repeat(20_000) }],
  }), pseudonymOf);
  const output = single.steps[0]?.kind === 'tool' ? single.steps[0].output ?? '' : '';
  assert.ok(new TextEncoder().encode(output).byteLength <= RUN_REVIEW_FIELD_BYTES);
  assert.ok(output.length > 8_000);
  assert.equal(single.truncated, true);

  const steps = Array.from({ length: 40 }, (_, step) => ({ kind: 'text' as const, text: `${step}:`.padEnd(15_000, 'z') }));
  const fitted = buildRunReviewRecord(input({ steps }), pseudonymOf);
  assert.ok(new TextEncoder().encode(JSON.stringify(fitted)).byteLength <= RUN_REVIEW_RECORD_BYTES);
  assert.equal(fitted.truncated, true);
  const first = fitted.steps[0];
  assert.ok(first?.kind === 'text' && !first.text.startsWith('0:'), 'the oldest step is the one dropped');
  const last = fitted.steps.at(-1);
  assert.ok(last?.kind === 'text' && last.text.startsWith('39:'), 'the newest step stays');

  assert.equal(buildRunReviewRecord(input(), pseudonymOf).truncated, false);
});

test('past 256 KiB with every step dropped, the oldest context rows go next', () => {
  const context = Array.from({ length: 40 }, (_, row) => ({
    author: 'Helper Agent', role: 'agent' as const, text: `${row}:`.padEnd(15_000, 'z'), files: [],
  }));
  const fitted = buildRunReviewRecord(input({
    steps: [{ kind: 'text', text: 'one step' }, { kind: 'text', text: 'another step' }],
    context,
  }), runReviewPseudonymizer(KEY));
  assert.ok(new TextEncoder().encode(JSON.stringify(fitted)).byteLength <= RUN_REVIEW_RECORD_BYTES);
  assert.equal(fitted.truncated, true);
  assert.deepEqual(fitted.steps, []);
  assert.ok(fitted.context.length > 0 && fitted.context.length < 40);
  assert.ok(!fitted.context[0]?.text.startsWith('0:'), 'the oldest row is the one dropped');
  assert.ok(fitted.context.at(-1)?.text.startsWith('39:'), 'the newest row stays');
});

test('a finished session scrubs and records once, with one key per installation', async (t) => {
  const { records } = fakePort(t);
  const settings = memorySettings();
  const session = await startRunReview(HOSTED_ENV, { surface: 'dm', grantsWebsiteLogins: false, settings: () => settings });
  assert.ok(session);
  session.ingest(chunk({ type: 'message-started', messageId: 'm', submissionId: SUBMISSION }), SUBMISSION);
  session.ingest(chunk({ type: 'message-delta', messageId: 'm', kind: 'text', delta: 'Hi U012ABCDEF3' }), SUBMISSION);
  await session.finish({ ...ENDING, receivedAt: Date.UTC(2026, 9, 25, 12), admittedAt: Date.UTC(2026, 9, 25, 12, 0, 1) });
  await session.finish(ENDING);
  assert.equal(records.length, 1);
  const [{ installationId, record }] = records as [typeof records[number]];
  assert.equal(installationId, INSTALLATION);
  assert.equal(record.surface, 'dm');
  assert.equal(record.source, 'stream');
  assert.equal(record.timings.receivedAt, '2026-10-25T12:00:00.000Z');
  assert.equal(record.timings.admittedAt, '2026-10-25T12:00:01.000Z');
  const stored = JSON.parse(settings.values.get(RUN_REVIEW_PSEUDONYM_SETTING)!) as { version: number; key: string };
  assert.equal(stored.version, 1);
  assert.match(stored.key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(record.trigger.author.startsWith('u_'), true);
  assert.deepEqual(record.steps, [{ kind: 'text', text: `Hi ${record.trigger.author}` }]);

  const again = await startRunReview(HOSTED_ENV, { surface: 'channel', grantsWebsiteLogins: false, settings: () => settings });
  await again!.finish(ENDING);
  assert.equal(records[1]?.record.trigger.author, record.trigger.author, 'the stored key is reused');
});

test('a key another isolate wrote after the runner prefetched is read back from the store', async (t) => {
  const { records } = fakePort(t);
  const store = memorySettings();
  store.values.set(RUN_REVIEW_PSEUDONYM_SETTING, JSON.stringify({ version: 1, key: encodeBase64Url(KEY) }));
  // The runner's snapshot predates the other write; writes reach the store.
  const prefetched: SettingsStore = { ...store, getSetting: async () => undefined, getSettings: async (keys) => keys.map(() => undefined) };
  const session = await startRunReview(HOSTED_ENV, { surface: 'dm', grantsWebsiteLogins: false, settings: () => store, prefetched });
  await session!.finish(ENDING);
  assert.equal(records[0]?.record.trigger.author, runReviewPseudonymizer(KEY)('U012ABCDEF3'));
});

test('a session with no observed stream reads the settled history once', async (t) => {
  const { records } = fakePort(t);
  const session = await startRunReview(HOSTED_ENV, { surface: 'channel', grantsWebsiteLogins: false, settings: () => memorySettings() });
  let reads = 0;
  await session!.finish({
    ...ENDING,
    history: {
      submissionId: SUBMISSION,
      read: async () => {
        reads += 1;
        return {
          v: 1, conversationId: 'conversation', offset: '2', settlements: [],
          messages: [{ id: 'm', role: 'assistant', purpose: 'assistant', display: 'visible', submissionId: SUBMISSION, parts: [{ type: 'text', text: 'From history.', state: 'done' }] }],
        };
      },
    },
  });
  assert.equal(reads, 1);
  assert.equal(records[0]?.record.source, 'history');
  assert.deepEqual(records[0]?.record.steps, [{ kind: 'text', text: 'From history.' }]);
});

test('a failing or hanging store never throws and logs nothing of the run', async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (line: string) => { warnings.push(line); });
  fakePort(t, { record: async () => { throw new Error(`store refused ${SYNTHETIC_SLACK_TOKEN}`); } });
  const failing = await startRunReview(HOSTED_ENV, { surface: 'channel', grantsWebsiteLogins: false, settings: () => memorySettings() });
  await failing!.finish(ENDING);
  assert.deepEqual(warnings, [JSON.stringify({ component: 'run_review', event: 'record_failed' })]);

  warnings.length = 0;
  let recorded = false;
  configureRunReview({ ...runReview()!, record: () => new Promise<void>(() => { recorded = true; }) });
  const hanging = await startRunReview(HOSTED_ENV, { surface: 'channel', grantsWebsiteLogins: false, settings: () => memorySettings() });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const finished = hanging!.finish(ENDING);
  for (let turn = 0; turn < 20 && !recorded; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5_000);
  await finished;
  assert.deepEqual(warnings, [JSON.stringify({ component: 'run_review', event: 'record_timed_out' })]);
});

test('a Slack turn copies its trigger row and context rows, naming people by Slack user ID', () => {
  const conversation = slackRunReviewConversation({ userId: 'U012ABCDEF3', text: 'raw text' }, {
    mode: 'thread', truncated: false, degradations: [],
    messages: [
      { userId: 'U0ZZZZZZZZ9', text: 'earlier', ts: '1.1', isTrigger: false, role: 'human', authorName: 'Bo' },
      { userId: 'B012', text: 'deploy done', ts: '1.2', isTrigger: false, role: 'app', authorName: 'CI' },
      { userId: 'U012ABCDEF3', text: 'trigger text', ts: '1.3', isTrigger: true, role: 'human', files: [{ name: 'a.png', type: 'image/png', sizeBytes: 9 }] },
    ],
  });
  assert.deepEqual(conversation, {
    trigger: { author: 'U012ABCDEF3', text: 'trigger text', files: [{ name: 'a.png', size: 9 }] },
    context: [
      { author: 'U0ZZZZZZZZ9', role: 'human', text: 'earlier', files: [] },
      { author: 'CI', role: 'app', text: 'deploy done', files: [] },
    ],
  });
  assert.deepEqual(slackRunReviewConversation({ userId: 'U012ABCDEF3', text: 'raw text' }, undefined), {
    trigger: { author: 'U012ABCDEF3', text: 'raw text', files: [] },
    context: [],
  });
});
