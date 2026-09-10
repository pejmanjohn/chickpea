import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { init, useModel, useTool } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';
import { createArtifactReceiptAccumulator, parseSlackArtifactReceipts, selectDeliverableArtifacts, useSlackArtifactReceipts, type SlackArtifactReceipt, type SlackArtifactReceipts } from '../src/slack/artifact-receipts.ts';

const destination = { workspaceId: 'T12345678', agentId: 'agent_smoke', channelId: 'C12345678', threadTs: '1789000000.000100' };
function receipt(index: number): SlackArtifactReceipt {
  return { schemaVersion: 1, fileId: `F1234567${index}`, filename: `${index}.csv`, byteLength: 3, stagedAt: 1, kind: 'file', destination };
}

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
    writeReceipts({ schemaVersion: 1, receipts: accumulator.add(receipt(data.index)) });
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
    const second = await agent.read(await agent.dispatch('Prepare another file.'));
    assert.deepEqual(parseSlackArtifactReceipts(second.data?.slackArtifactReceipts).map((file) => file.fileId), ['F12345672']);
  } finally { await flue.stop(); }
});
