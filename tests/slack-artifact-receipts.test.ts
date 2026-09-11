import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { init, useModel, useTool } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';
import { createArtifactReceiptAccumulator, isCompletedSlackArtifactReceipt, isSlackFilePermalink, parseSlackArtifactReceipts, selectDeliverableArtifacts, useSlackArtifactReceipts, type CompletedSlackArtifactReceipt, type SlackArtifactReceipt, type SlackArtifactReceipts } from '../src/slack/artifact-receipts.ts';
import { stageArtifactWithReceipt } from '../src/slack/artifact-staging.ts';
import type { SlackFileStageInput, SlackFileTransport } from '../src/slack/file-transport.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';

const destination = { workspaceId: 'T12345678', agentId: 'agent_smoke', channelId: 'C12345678', threadTs: '1789000000.000100' };
function receipt(index: number): SlackArtifactReceipt {
  return { schemaVersion: 1, fileId: `F1234567${index}`, filename: `${index}.csv`, byteLength: 3, stagedAt: 1, kind: 'file', destination };
}
function completedReceipt(index: number): CompletedSlackArtifactReceipt {
  return { ...receipt(index), schemaVersion: 2, completedAt: 2,
    permalink: `https://example-workspace.slack.com/files/U12345678/F1234567${index}/${index}.csv` };
}

test('legacy and privately completed receipts survive persisted and Flue data parsing', () => {
  const files = [receipt(0), completedReceipt(1)];
  for (const source of [[{ schemaVersion: 1, receipts: files }], [files]]) {
    const parsed = parseSlackArtifactReceipts(JSON.parse(JSON.stringify(source)));
    assert.deepEqual(parsed, files);
    assert.equal(isCompletedSlackArtifactReceipt(parsed[0]!), false);
    assert.equal(isCompletedSlackArtifactReceipt(parsed[1]!), true);
    assert.deepEqual(selectDeliverableArtifacts(parsed, destination), files, 'selection must retain its legacy semantics');
  }
});

test('completed receipt permalinks require Slack ownership and the exact file id', () => {
  const valid = completedReceipt(1);
  for (const host of ['example-workspace.slack.com', 'other-workspace.slack.com',
    'example-workspace.enterprise.slack.com', 'example-workspace.slack-gov.com']) {
    assert.ok(isSlackFilePermalink(valid.permalink.replace('example-workspace.slack.com', host), valid.fileId));
  }
  assert.ok(isSlackFilePermalink(valid.permalink.padEnd(2_048, 'a'), valid.fileId));
  for (const permalink of [
    valid.permalink.replace('https:', 'http:'),
    valid.permalink.replace('example-workspace.slack.com', 'example.com'),
    valid.permalink.replace('example-workspace.slack.com', 'example-workspace.slack.com.attacker.invalid'),
    valid.permalink.replace('example-workspace.slack.com', 'example.slack-gov.com.attacker.invalid'),
    valid.permalink.replace('https://', 'https://token@'),
    valid.permalink.replace('https://', 'https://user:password@'),
    valid.permalink.replace('/files/', ':444/files/'),
    valid.permalink.replace(valid.fileId, 'F87654321'),
    valid.permalink.replace(valid.fileId, `${valid.fileId}X`),
    valid.permalink.replace(valid.fileId, `%46${valid.fileId.slice(1)}`),
    `${valid.permalink}?token=secret`, `${valid.permalink}#fragment`,
    `${valid.permalink}|label>`, `${valid.permalink}&extra`, `${valid.permalink}\n`,
    valid.permalink.padEnd(2_049, 'a'),
    valid.permalink.padEnd(1_900, 'é'),
  ]) {
    assert.equal(isSlackFilePermalink(permalink, valid.fileId), false);
    assert.throws(() => parseSlackArtifactReceipts([{ schemaVersion: 1, receipts: [{ ...valid, permalink }] }]));
  }
  assert.equal(parseSlackArtifactReceipts([{ schemaVersion: 1, receipts: [{ ...valid, filename: 'a'.repeat(256) }] }]).length, 1);
  for (const patch of [{ completedAt: undefined }, { completedAt: -1 }, { completedAt: 1.5 }, { filename: 'a'.repeat(257) }, { unknownField: true }]) {
    assert.throws(() => parseSlackArtifactReceipts([{ schemaVersion: 1, receipts: [{ ...valid, ...patch }] }]));
  }
});

test('receipt state survives serialization/recreated closures and rejects an eleventh file', () => {
  let state: SlackArtifactReceipts = { schemaVersion: 1, receipts: [] };
  const update = (fn: (previous: SlackArtifactReceipts) => SlackArtifactReceipts) => { state = fn(JSON.parse(JSON.stringify(state))); };
  const first = createArtifactReceiptAccumulator(update);
  first.add(receipt(0));
  const resumed = createArtifactReceiptAccumulator(update);
  resumed.add(receipt(1));
  assert.deepEqual(state.receipts.map((file) => file.fileId), ['F12345670', 'F12345671']);
  for (let index = 2; index < 10; index++) resumed.add(receipt(index));
  assert.throws(() => resumed.add(receipt(10)));
  assert.equal(state.receipts.length, 10);
});

test('receipt publication requires exact workspace, Agent, channel and thread', () => {
  assert.equal(selectDeliverableArtifacts([receipt(0)], destination).length, 1);
  for (const target of [
    { ...destination, workspaceId: undefined }, { ...destination, workspaceId: 'T87654321' },
    { ...destination, agentId: 'agent_other' }, { ...destination, channelId: 'C87654321' },
    { ...destination, threadTs: undefined },
  ]) assert.deepEqual(selectDeliverableArtifacts([receipt(0)], target), []);
});

function ReceiptProbe() {
  useModel('faux/receipt-proof');
  const { accumulator, writeReceipts } = useSlackArtifactReceipts();
  useTool({ name: 'stage_fixture', description: 'Stage a synthetic receipt', input: v.object({ index: v.number() }), output: v.string(), run: ({ data }) => {
    writeReceipts({ schemaVersion: 1, receipts: accumulator.add(data.index === 1 ? completedReceipt(1) : receipt(data.index)) });
    return { output: 'staged' };
  } });
  return 'Follow the scripted tool calls.';
}

test('actual Flue hook retains files across tool renders and resets on the next response', async () => {
  const faux = fauxProvider({ models: [{ id: 'receipt-proof', reasoning: false }], tokensPerSecond: 10000 });
  const flue = await start({ agents: [{ agent: ReceiptProbe, name: 'receipt-proof' }], providers: [faux.provider] });
  try {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('stage_fixture', { index: 0 })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('stage_fixture', { index: 1 })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Two files prepared.'),
      fauxAssistantMessage([fauxToolCall('stage_fixture', { index: 2 })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('One file prepared.'),
    ]);
    const agent = init(ReceiptProbe, { id: 'receipt-proof' });
    const first = await agent.read(await agent.dispatch('Prepare two files.'));
    assert.deepEqual(parseSlackArtifactReceipts(first.data?.slackArtifactReceipts).map((file) => file.fileId), ['F12345670', 'F12345671']);
    assert.ok(isCompletedSlackArtifactReceipt(parseSlackArtifactReceipts(first.data?.slackArtifactReceipts)[1]!));
    const second = await agent.read(await agent.dispatch('Prepare another file.'));
    assert.deepEqual(parseSlackArtifactReceipts(second.data?.slackArtifactReceipts).map((file) => file.fileId), ['F12345672']);
  } finally { await flue.stop(); }
});

function stagingState(transport: SlackFileTransport) {
  let state: SlackArtifactReceipts = { schemaVersion: 1, receipts: [receipt(0)] };
  const writes: SlackArtifactReceipts[] = [];
  let tick = 1;
  return {
    writes,
    state: () => state,
    run: () => stageArtifactWithReceipt({ transport,
      artifact: { filename: '  chart.png  ', title: '  Synthetic chart  ', bytes: new Uint8Array(3), kind: 'chart' },
      destination, now: () => tick++,
      accumulator: createArtifactReceiptAccumulator((update) => { state = update(state); }),
      writeReceipts: (value) => { writes.push(value); },
    }),
  };
}

const legacyTransport: SlackFileTransport = {
  async stage() { assert.fail('New artifact staging must not use legacy stage'); },
  async complete() { assert.fail('New artifact staging must not publish a native file message'); },
  async resolveShare() { assert.fail('Private staging must not read public shares'); },
};

test('artifact staging writes a v2 receipt only after valid private completion', async () => {
  let finish!: () => void;
  let calls = 0;
  let stagedInput: SlackFileStageInput | undefined;
  const ready = new Promise<void>((resolve) => { finish = resolve; });
  const completed = completedReceipt(1);
  const state = stagingState({ ...legacyTransport, async stagePrivate(input) {
    calls++;
    stagedInput = input;
    await ready;
    return { fileId: completed.fileId, permalink: completed.permalink, byteLength: 3 };
  } });
  const pending = state.run();
  assert.equal(state.writes.length, 0);
  assert.deepEqual(state.state().receipts, [receipt(0)]);
  finish();
  assert.deepEqual(await pending, { attached: true, byteLength: 3 });
  assert.equal(calls, 1);
  assert.equal(stagedInput?.filename, 'chart.png');
  assert.equal(stagedInput?.title, 'Synthetic chart');
  assert.equal(stagedInput?.altText, 'Synthetic chart');
  assert.equal(state.writes.length, 1);
  assert.deepEqual(state.writes[0]?.receipts[1], { ...completed, filename: 'chart.png', title: 'Synthetic chart', kind: 'chart' });
});

test('ambiguous, rejected or malformed private completion emits no receipt and never retries', async () => {
  for (const failure of [
    new Error('Completion response lost'),
    new SlackTransportError('files.uploadV2', 'internal_error', { effectOutcome: 'unknown' }),
    new SlackTransportError('files.uploadV2', 'invalid_arguments', { effectOutcome: 'failed' }),
    { fileId: 'F12345671', byteLength: 3 },
    { fileId: 'F12345671', byteLength: 3, permalink: 'https://example.com/files/U12345678/F12345671/1.csv' },
    { fileId: 'F12345671', byteLength: 4, permalink: completedReceipt(1).permalink },
  ]) {
    let calls = 0;
    const state = stagingState({ ...legacyTransport, async stagePrivate() {
      calls++;
      if (failure instanceof Error) throw failure;
      return failure as Awaited<ReturnType<NonNullable<SlackFileTransport['stagePrivate']>>>;
    } });
    assert.deepEqual(await state.run(), { attached: false, reason: 'unavailable' });
    assert.equal(calls, 1);
    assert.equal(state.writes.length, 0);
    assert.deepEqual(state.state().receipts, [receipt(0)]);
  }
  const legacy = stagingState(legacyTransport);
  assert.deepEqual(await legacy.run(), { attached: false, reason: 'unavailable' });
  assert.equal(legacy.writes.length, 0);
});

test('private staging failures expose only static operational categories', async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const canary = 'https://private.example/file?token=do-not-log';
  for (const failure of [new TypeError(canary),
    new SlackTransportError('files.uploadV2', 'invalid_private_completion_receipt'),
    { fileId: 'F12345671', byteLength: 4, permalink: completedReceipt(1).permalink }]) {
    const state = stagingState({ ...legacyTransport, async stagePrivate() {
      if (failure instanceof Error) throw failure;
      return failure;
    } });
    assert.deepEqual(await state.run(), { attached: false, reason: 'unavailable' });
  }
  assert.deepEqual(warnings, [
    ['[chickpea] artifact staging failed', { code: 'private_stage_failed' }],
    ['[chickpea] artifact staging failed', { code: 'private_receipt_invalid' }],
    ['[chickpea] artifact staging failed', { code: 'private_receipt_invalid' }],
  ]);
  assert.doesNotMatch(JSON.stringify(warnings), /private\.example|do-not-log|F12345671/);
});

test('an unknown receipt kind is ignored while structural damage still fails the list', () => {
  const chart: SlackArtifactReceipt = { ...receipt(0), kind: 'chart' };
  // A kind this version has never seen, as a newer host would write it.
  const future = { ...receipt(1), kind: 'future' };
  for (const source of [[{ schemaVersion: 1, receipts: [chart, future] }], [[chart, future]]]) {
    assert.deepEqual(parseSlackArtifactReceipts(JSON.parse(JSON.stringify(source))), [chart],
      'a newer receipt kind must not fail the whole list');
  }
  // Fields a newer kind carries are ignored with it, in either order.
  assert.deepEqual(parseSlackArtifactReceipts([{ schemaVersion: 1, receipts: [
    { ...future, revisedPrompt: 'a cat', appliedSize: '1024x1024' }, chart,
  ] }]), [chart]);
  assert.deepEqual(parseSlackArtifactReceipts([{ schemaVersion: 1, receipts: [future] }]), []);
  // Known kinds keep failing closed on malformed structure.
  for (const broken of [
    { ...receipt(1), fileId: 'not-a-file-id' }, { ...receipt(1), byteLength: 0 },
    { ...receipt(1), destination: undefined }, { ...receipt(1), kind: 7 },
    { ...receipt(1), unknownField: true }, 'F12345671', null, [],
  ]) {
    assert.throws(() => parseSlackArtifactReceipts([{ schemaVersion: 1, receipts: [chart, broken] }]),
      `malformed receipt ${JSON.stringify(broken)} must still fail`);
  }
  // The envelope itself, including the bounded list, is still validated.
  assert.throws(() => parseSlackArtifactReceipts([{ schemaVersion: 2, receipts: [chart] }]));
  assert.throws(() => parseSlackArtifactReceipts([{ schemaVersion: 1, receipts: [chart], extra: true }]));
  assert.throws(() => parseSlackArtifactReceipts([{ schemaVersion: 1, receipts:
    Array.from({ length: 11 }, (_, index) => ({ ...future, fileId: `F123456${index}0` })) }]));
});
