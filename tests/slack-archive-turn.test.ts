import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
  type Context,
} from '@earendil-works/pi-ai';
import { type AgentProps, init, useDelivery, useModel } from '@flue/runtime';
import { start } from '@flue/runtime/node';

import type { RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { parseSlackManagementSignal } from '../src/management/slack-tools.ts';
import { serializeCurrentRequestEnvelope } from '../src/memory/tool-policy.ts';
import { archiveListing } from '../src/slack/archive-attachments.ts';
import { useReadArchiveFileTool } from '../src/slack/archive-file-tool.ts';
import { useSlackAttachmentContext } from '../src/slack/attachment-context.ts';
import { decorateAttachmentProvider } from '../src/slack/attachment-model-context.ts';
import type { GatewayAttachmentClient } from '../src/slack/gateway/client.ts';
import type { GatewayAttachmentRepresentation } from '../src/slack/gateway/protocol.ts';
import { makeTextPdf } from './helpers/pdf.ts';
import { buildZip } from './helpers/zip.ts';

const MODEL = 'faux/archive-turn';
const WORKSPACE = 'T_ARCHIVE';
const CHANNEL = 'C_ARCHIVE';
const THREAD_TS = '1788000000.000100';
const MESSAGE_TS = '1788000000.000200';
const REQUEST = 'Summarize plan.md and the report in this zip.';

const PLAN: RuntimePlanV2 = {
  schemaVersion: 2,
  continuityPolicy: 'synthetic-test',
  agentId: 'agent_archive',
  conversation: { workspaceId: WORKSPACE, channelId: CHANNEL, threadTs: THREAD_TS, surface: 'channel_thread', continuityKey: 'archive_turn' },
  model: MODEL,
  instructions: 'Answer the request.',
  memoryEpoch: 1,
  skills: [],
  mcpConnections: [],
  apiConnections: [],
  repositories: [],
  sandbox: { mode: 'bash' },
  artifactDestination: { kind: 'slack_conversation', channelId: CHANNEL },
  harnessRevision: 'test',
};

const KIT = buildZip([
  { path: 'kit/' },
  { path: 'kit/plan.md', content: '# Launch plan\nShip on Tuesday.\n' },
  { path: 'kit/report.pdf', content: makeTextPdf(['Units sold: 42']) },
  { path: '__MACOSX/kit/._plan.md', content: 'resource fork' },
]);

const reads: Array<{ fileId: string; accept: readonly GatewayAttachmentRepresentation[] | undefined }> = [];
const client: GatewayAttachmentClient = {
  async readAttachment(fileId, _maxBytes, _signal, accept) {
    reads.push({ fileId, accept });
    return { fileId, filename: 'kit.zip', representation: 'zip_original', contentType: 'application/zip', bytes: KIT };
  },
};

function ArchiveTurnProbe({ id }: AgentProps) {
  useModel(MODEL);
  const signal = parseSlackManagementSignal(useDelivery(), PLAN);
  useSlackAttachmentContext(PLAN, async () => undefined, async () => MODEL, () => client);
  useReadArchiveFileTool({
    instanceId: id,
    turnKey: signal?.turnJobId ?? '',
    currentMessageFileIds: signal?.attachmentFileIds,
    threadArchiveFileIds: signal?.threadArchiveFileIds,
    client: async () => client,
  });
  return 'Answer the request.';
}

function slackMessage(text: string, turnJobId: string, attributes: Record<string, string>) {
  return {
    kind: 'signal' as const,
    type: 'slack.message',
    tagName: 'slack_message',
    body: serializeCurrentRequestEnvelope(text, false, 'U_HUMAN', MESSAGE_TS, { schemaVersion: 2, progressiveStreamingOffered: false }),
    attributes: {
      workspaceId: WORKSPACE, channelId: CHANNEL, threadTs: THREAD_TS, slackUserId: 'U_HUMAN', eventId: `E_${turnJobId}`,
      messageTs: MESSAGE_TS, turnJobId, conversationKind: 'channel', requesterText: text, ...attributes,
    },
  };
}

function toolResults(context: Context | undefined): Record<string, unknown>[] {
  return (context?.messages ?? []).filter((message) => message.role === 'toolResult')
    .map((message) => JSON.parse(JSON.parse(message.content.map((part) => part.type === 'text' ? part.text : '').join('')) as string) as Record<string, unknown>);
}

test('one turn lists a zip, then reads a markdown file and a PDF from it with one download', async () => {
  reads.length = 0;
  const faux = fauxProvider({ models: [{ id: 'archive-turn' }] });
  const captures: Context[] = [];
  faux.setResponses([
    (context: Context) => {
      captures.push(context);
      return fauxAssistantMessage('Attachment 1 - kit.zip (file:1) lists kit/plan.md and kit/report.pdf.');
    },
    (context: Context) => {
      captures.push(context);
      return fauxAssistantMessage([
        fauxToolCall('read_archive_file', { file: 'file:1', path: 'kit/plan.md' }),
        fauxToolCall('read_archive_file', { file: 'file:1', path: 'kit/report.pdf' }),
      ], { stopReason: 'toolUse' });
    },
    (context: Context) => {
      captures.push(context);
      return fauxAssistantMessage('The plan ships Tuesday; the report counts 42 units.');
    },
  ]);
  const flue = await start({
    agents: [{ agent: ArchiveTurnProbe, name: 'archive-turn-probe' }],
    providers: [decorateAttachmentProvider(faux.provider)],
  });
  try {
    const handle = init(ArchiveTurnProbe, { id: 'archive-turn-probe' });
    await handle.read(await handle.dispatch({ message: {
      kind: 'signal',
      type: 'slack.message',
      tagName: 'slack_message',
      body: serializeCurrentRequestEnvelope(REQUEST, false, 'U_HUMAN', MESSAGE_TS, { schemaVersion: 2, progressiveStreamingOffered: false }),
      attributes: {
        workspaceId: WORKSPACE, channelId: CHANNEL, threadTs: THREAD_TS, slackUserId: 'U_HUMAN', eventId: 'E_ARCHIVE',
        messageTs: MESSAGE_TS, turnJobId: 'turn_archive', conversationKind: 'channel', requesterText: REQUEST,
        attachmentFileIds: 'F_KIT', attachmentIntakeStatus: 'ok', attachmentCount: '1',
      },
    } }));
  } finally {
    await flue.stop();
  }

  const [analysis, answer, afterReads] = captures;
  assert.match(JSON.stringify(analysis?.messages), /Zip archive file:1: its file list, not file contents\.\\n2 files:\\n- kit\/plan\.md \(text, 31 B\)\\n- kit\/report\.pdf \(pdf, /);
  assert.doesNotMatch(JSON.stringify(analysis?.messages), /__MACOSX/);
  assert.deepEqual(getCurrentTools(analysis!.messages).map((tool) => tool.name), [], 'the analysis call stays tool-free');
  assert.ok(getCurrentTools(answer!.messages).some((tool) => tool.name === 'read_archive_file'), 'the first answer call can read the archive');
  assert.match(JSON.stringify(answer?.messages), /handle=file:1 \| status=success \| code=listed/);

  const results = afterReads!.messages.filter((message) => message.role === 'toolResult')
    // The tool returns a JSON document, which the tool result carries as a JSON string.
    .map((message) => JSON.parse(JSON.parse(message.content.map((part) => part.type === 'text' ? part.text : '').join('')) as string) as Record<string, unknown>);
  assert.deepEqual(results.map(({ path, kind, text }) => ({ path, kind, text })), [
    { path: 'kit/plan.md', kind: 'text', text: '# Launch plan\nShip on Tuesday.\n' },
    { path: 'kit/report.pdf', kind: 'pdf', text: '--- Page 1 of 1 ---\nUnits sold: 42' },
  ]);
  assert.deepEqual(reads.map(({ accept }) => accept?.at(-1)), ['zip_original', 'zip_original']);
  assert.equal(reads.length, 2, 'one read for the analysis, one download shared by both tool calls');
});

test('a follow-up with no attachment lists and reads a zip an earlier message carried', async () => {
  reads.length = 0;
  const faux = fauxProvider({ models: [{ id: 'archive-turn' }] });
  const captures: Context[] = [];
  faux.setResponses([
    (context: Context) => {
      captures.push(context);
      return fauxAssistantMessage([fauxToolCall('read_archive_file', { file: 'file:1' })], { stopReason: 'toolUse' });
    },
    (context: Context) => {
      captures.push(context);
      return fauxAssistantMessage([fauxToolCall('read_archive_file', { file: 'file:1', path: 'kit/plan.md' })], { stopReason: 'toolUse' });
    },
    (context: Context) => {
      captures.push(context);
      return fauxAssistantMessage('The plan ships Tuesday.');
    },
    (context: Context) => {
      captures.push(context);
      return fauxAssistantMessage('There is no archive in this conversation.');
    },
  ]);
  const flue = await start({
    agents: [{ agent: ArchiveTurnProbe, name: 'archive-turn-probe' }],
    providers: [decorateAttachmentProvider(faux.provider)],
  });
  try {
    const handle = init(ArchiveTurnProbe, { id: 'archive-follow-up' });
    await handle.read(await handle.dispatch({
      message: slackMessage('Now open the plan in that zip.', 'turn_follow_up', { threadArchiveFileIds: 'F0KIT000001' }),
    }));
    await handle.read(await handle.dispatch({ message: slackMessage('What is new?', 'turn_plain', {}) }));
  } finally {
    await flue.stop();
  }

  const [listCall, readCall, answer, plain] = captures;
  assert.ok(getCurrentTools(listCall!.messages).some((tool) => tool.name === 'read_archive_file'), 'an earlier archive mounts the tool');
  assert.deepEqual(toolResults(readCall).at(-1), { ok: true, file: 'file:1', listing: archiveListing(KIT, 'file:1') });
  assert.match(archiveListing(KIT, 'file:1'), /^Zip archive file:1: its file list, not file contents\.\n2 files:\n- kit\/plan\.md \(text, 31 B\)\n- kit\/report\.pdf/);
  assert.deepEqual(toolResults(answer).at(-1), {
    ok: true, file: 'file:1', path: 'kit/plan.md', kind: 'text', text: '# Launch plan\nShip on Tuesday.\n',
  });
  assert.deepEqual(reads, [{ fileId: 'F0KIT000001', accept: ['zip_original'] }], 'one download serves the list and the read');
  assert.ok(!getCurrentTools(plain!.messages).some((tool) => tool.name === 'read_archive_file'), 'no archive and no files: no tool');
});
