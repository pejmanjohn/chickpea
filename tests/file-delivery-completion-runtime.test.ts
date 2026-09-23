import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import {
  bash, init, instrument, useDataWriter, useDelivery, useInstruction, useModel,
  useResponseStart, useSandbox, useTool,
  type AgentReply, type DeliveredMessage, type LlmMessage, type Sandbox,
} from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { Bash, InMemoryFs } from 'just-bash';
import * as v from 'valibot';

import { CHICKPEA_ROUTINE_EXECUTION_AGENT_NAME, CHICKPEA_SLACK_AGENT_NAME } from '../src/agents/names.ts';
import { compileRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { createRuntimePlanArtifactTools } from '../src/agents/slack-thread.ts';
import {
  closeNodeStateStores, getConfigStore, getSlackCredentialDependencies,
} from '../src/config/state-backend.ts';
import { WORKSPACE_SLACK_INSTALLATION_ID, type CustomAgentConfig } from '../src/config/types.ts';
import {
  assertArtifactDeliveryAllowed, bindCurrentRequestConversation,
  boundCurrentRequestConversation, memoryToolPolicyInterceptor, observeMemoryToolPolicy,
  parseModelVisibleCurrentRequestEnvelope, serializeCurrentRequestEnvelope,
} from '../src/memory/tool-policy.ts';
import { scheduleSignalMessageTs } from '../src/routines/schedule-signal.ts';
import { RoutineModelResultSchema } from '../src/routines/prompt.ts';
import { createWorkspaceArtifactTool, MAX_ARTIFACT_BYTES, type ArtifactDestinationBinding } from '../src/sandbox/artifact-tool.ts';
import {
  createArtifactReceiptAccumulator, parseSlackArtifactReceipts, SLACK_ARTIFACT_RECEIPTS_DATA_NAME,
  useSlackArtifactReceipts, type SlackArtifactReceipts,
} from '../src/slack/artifact-receipts.ts';
import { stageArtifactWithReceipt } from '../src/slack/artifact-staging.ts';
import {
  invalidateSlackInstallationCredentialCache, writeSlackInstallationCredentials,
} from '../src/slack/installation-credentials.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import {
  COMPLETE_FILE_DELIVERY_TOOL, FILE_COMPLETION_INSTRUCTION, FILE_DELIVERY_DATA_NAME,
  FILE_DELIVERY_SIGNAL_TYPE, FileDeliveryResultSchema, useFileDeliveryCompletion,
  createFileDeliveryCompletion, type FileDeliveryState,
} from '../src/slack/file-delivery-completion.ts';
import type { SlackFileStageInput, SlackFileTransport } from '../src/slack/file-transport.ts';
import { promptSlackThreadAgent, type SlackFlueDispatchState } from '../src/slack/flue-dispatch.ts';
import type { FlueDispatchEnvelopeV1 } from '../src/slack/turn-job-types.ts';
import { withEnv } from './helpers/env.ts';

const MODEL = 'faux/file-delivery';
const CONVERSATION = { workspaceId: 'TPROBE', channelId: 'CPROBE', threadTs: '1789230000.000100' };
const ACTOR = 'UPROBE';
const MESSAGE_TS = '1789230000.000200';
const REPORT = '# Install report\n\nThe installation checks passed.\n';
const AGENT: CustomAgentConfig = {
  id: 'file-delivery-probe', kind: 'user', revision: 1, name: 'File delivery probe',
  instructions: 'Create the requested final deliverables.', enabled: true, model: MODEL,
  skills: [], mcpServers: [], apiConnections: [], repositories: [],
};
const PLAN = compileRuntimePlanV2({
  turn: { ...CONVERSATION, eventId: 'EPROBE', text: 'Create an install report.',
    userId: ACTOR, messageTs: MESSAGE_TS, source: 'app_mention', contextMode: 'thread' },
  assignment: { ...CONVERSATION, agentId: AGENT.id, agent: AGENT, model: MODEL,
    modelAttribution: { source: 'workspace_default', providerId: 'faux', workspaceDefaultRevision: 1 } },
  instructions: AGENT.instructions, memoryEpoch: 1, sandboxMode: 'bash', effectiveConnections: [],
});

interface ProbeState {
  staged: SlackFileStageInput[];
  responseStarts: number;
  deliveries: DeliveredMessage[];
  repairSignalCounts: number[];
  repairAuthority: boolean[];
  toolOutcomes: { tool: string; isError: boolean }[];
  oversizeAttempts: number;
}
let probe: ProbeState;

/** Real hooks, sandbox tools, admission, and receipts; only Slack transport is synthetic. */
function useProbe() {
  useModel(MODEL);
  bindCurrentRequestConversation(CONVERSATION);
  probe.deliveries.push(useDelivery());
  useResponseStart(() => { probe.responseStarts++; });
  const { accumulator, writeReceipts } = useSlackArtifactReceipts();
  const completion = useFileDeliveryCompletion(PLAN, (ids) => {
    writeReceipts({ schemaVersion: 1, receipts: accumulator.remove(ids) });
  });
  const transport: SlackFileTransport = {
    maxBytes: MAX_ARTIFACT_BYTES,
    async stagePrivate(input) {
      assert.deepEqual(boundCurrentRequestConversation(), CONVERSATION);
      assertArtifactDeliveryAllowed();
      if (input.bytes.byteLength > 700 * 1024) {
        probe.oversizeAttempts++;
        throw new SlackTransportError('files.stage', 'gateway_request_too_large');
      }
      probe.staged.push({ ...input, bytes: (input.bytes as Uint8Array).slice() });
      const fileId = `FPROBE${String(probe.staged.length).padStart(5, '0')}`;
      return { fileId, byteLength: input.bytes.byteLength,
        permalink: `https://example.slack.com/files/${ACTOR}/${fileId}/${input.filename}` };
    },
    async stage() { throw new Error('Legacy staging must not run.'); },
    async complete() { throw new Error('Public delivery is outside this runtime test.'); },
    async resolveShare() { throw new Error('No live Slack resource exists.'); },
  };
  const binding: ArtifactDestinationBinding = {
    channel: CONVERSATION.channelId, threadTs: CONVERSATION.threadTs, sandboxKind: 'bash',
    stageArtifact: (artifact) => stageArtifactWithReceipt({
      artifact, transport, accumulator, writeReceipts,
      destination: { ...CONVERSATION, agentId: AGENT.id },
    }),
  };
  useSandbox(completion.wrapSandbox(bash(() => new Bash({ fs: new InMemoryFs() }))));
  useTool(createWorkspaceArtifactTool(binding, completion.deliver));
  useTool(completion.tool(binding));
  useInstruction(FILE_COMPLETION_INSTRUCTION);
}

function SlackProbe() { useProbe(); }

function RoutineProbe() {
  useProbe();
  const writeResult = useDataWriter('routineResult', { schema: RoutineModelResultSchema });
  useTool({
    name: 'submit_routine_result', description: 'Submit the final scheduled result.',
    input: RoutineModelResultSchema,
    run({ data }) { writeResult(data); return { output: 'recorded', terminate: true }; },
  });
}

function userText(message: LlmMessage): string | undefined {
  if (message.role !== 'user') return undefined;
  return typeof message.content === 'string' ? message.content : message.content
    .flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n');
}

function slackEnvelope(id: string): FlueDispatchEnvelopeV1 {
  return {
    schemaVersion: 2, agentName: CHICKPEA_SLACK_AGENT_NAME, instanceId: id,
    uid: null, idempotencyKey: `dispatch-${id}`,
    message: {
      kind: 'signal', type: 'slack.message', tagName: 'slack_message',
      body: `Create an install report.\n\n${serializeCurrentRequestEnvelope('', false, ACTOR, MESSAGE_TS)}`,
      attributes: { ...CONVERSATION, slackUserId: ACTOR, messageTs: MESSAGE_TS,
        eventId: 'EPROBE', turnJobId: `turn-${id}` },
    },
  };
}

function dispatchState(envelope: FlueDispatchEnvelopeV1): SlackFlueDispatchState {
  return {
    prepare: () => envelope,
    recordReceipt: (receipt) => receipt,
    recordSettlement: (settlement) => settlement,
    reconcileExistingInstance: () => { throw new Error('Unexpected incarnation conflict.'); },
    markRecoveryRequired: (reason) => { throw new Error(`Unexpected recovery: ${reason}`); },
  };
}

function completionResult(reply: AgentReply) {
  return v.parse(FileDeliveryResultSchema, reply.data?.[FILE_DELIVERY_DATA_NAME]?.at(-1));
}

const call = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
const writeReport = (path = '/home/user/report.md') => call('write', { path, content: REPORT });
const completeReport = (path = '/home/user/report.md') =>
  call(COMPLETE_FILE_DELIVERY_TOOL, { files: [{ path, filename: 'report.md' }] });

function artifactSandbox(bytes: Uint8Array): Sandbox {
  return {
    cwd: '/home/user',
    resolvePath(requested) {
      return requested.startsWith('/') ? requested : `/home/user/${requested}`;
    },
    async exec() { return { stdout: '', stderr: '', exitCode: 0 }; },
    async readFile() { return new TextDecoder().decode(bytes); },
    async readFileBuffer() { return bytes.slice(); },
    async writeFile() {},
    async stat() { return { isFile: true, isDirectory: false, size: bytes.byteLength }; },
    async readdir() { return []; },
    async exists() { return true; },
    async mkdir() {},
    async rm() {},
  };
}

test('artifact declarations expose only export tools during file-delivery repair', () => {
  let receipts: SlackArtifactReceipts = { schemaVersion: 1, receipts: [] };
  const accumulator = createArtifactReceiptAccumulator((update) => { receipts = update(receipts); });
  for (const repairing of [false, true]) {
    let state: FileDeliveryState = { pending: [], shellPending: false, generation: 0,
      outcomes: [], repairRequested: repairing, stagingAttempted: false };
    const completion = createFileDeliveryCompletion((update) => {
      state = typeof update === 'function' ? update(state) : update;
    }, () => {}, repairing);
    const tools = createRuntimePlanArtifactTools({ ...PLAN,
      imageCapability: { role: 'image', filled: true, acceptsImageInput: true },
    }, accumulator, () => {}, {
      fileCompletion: completion,
      reserveImageCall: () => { throw new Error('Declaring tools must not generate images.'); },
    });
    assert.deepEqual(tools.map((tool) => tool.name), repairing
      ? ['post_artifact', COMPLETE_FILE_DELIVERY_TOOL]
      : ['post_artifact', COMPLETE_FILE_DELIVERY_TOOL, 'generate_image', 'recover_image']);
  }
});

test('default runtime-plan artifact binding uses the durable Node Slack installation', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'chickpea-node-artifact-binding-'));
  const statePath = path.join(directory, 'state.sqlite');
  const keyringPath = path.join(directory, 'credential-keyring.json');
  const bytes = new TextEncoder().encode('MAC_LOCAL_FILE_TEST\n');
  const fileId = 'FNODEARTIFACT1';
  const permalink = `https://example.slack.com/files/UTEST/${fileId}/proof.txt`;
  const requests: string[] = [];
  let receipts: SlackArtifactReceipts = { schemaVersion: 1, receipts: [] };

  await withEnv({
    TAG_DB_PATH: statePath,
    SLACK_STATE_DB_PATH: statePath,
    CHICKPEA_CREDENTIAL_KEYRING_PATH: keyringPath,
    SLACK_API_URL: 'https://slack.invalid/api/',
  }, async () => {
    closeNodeStateStores();
    const config = getConfigStore();
    await config.ensureWorkspaceInstallation({
      workspaceId: CONVERSATION.workspaceId,
      transportMode: 'direct',
      teamId: CONVERSATION.workspaceId,
      appId: 'ANODEARTIFACT',
      botUserId: 'UBOTNODE',
    });
    await writeSlackInstallationCredentials(
      getSlackCredentialDependencies(),
      WORKSPACE_SLACK_INSTALLATION_ID,
      null,
      {
        botToken: 'xoxb-node-artifact-test',
        signingSecret: 'node-artifact-signing-secret',
        botUserId: 'UBOTNODE',
        appId: 'ANODEARTIFACT',
        teamId: CONVERSATION.workspaceId,
      },
    );
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/auth.test')) {
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer xoxb-node-artifact-test');
        return Response.json({
          ok: true, app_id: 'ANODEARTIFACT', team_id: CONVERSATION.workspaceId,
          user_id: 'UBOTNODE', user: 'Chickpea',
        });
      }
      if (url.endsWith('/files.getUploadURLExternal')) {
        return Response.json({ ok: true, file_id: fileId, upload_url: 'https://uploads.slack.test/node-artifact' });
      }
      if (url === 'https://uploads.slack.test/node-artifact') {
        assert.deepEqual(new Uint8Array(await new Response(init?.body).arrayBuffer()), bytes);
        return new Response('OK');
      }
      assert.ok(url.endsWith('/files.completeUploadExternal'), url);
      return Response.json({ ok: true, files: [{ id: fileId, permalink, size: bytes.byteLength }] });
    });

    const accumulator = createArtifactReceiptAccumulator((update) => {
      receipts = update(receipts);
    });
    const postArtifact = createRuntimePlanArtifactTools(
      PLAN,
      accumulator,
      (next) => { receipts = next; },
    ).find((tool) => tool.name === 'post_artifact');
    assert.ok(postArtifact);
    const runPostArtifact = postArtifact.run as unknown as (input: {
      toolCallId: string;
      log: { info(): void; warn(): void; error(): void };
      data: { path: string; filename: string };
      harness: { sandbox: Sandbox };
    }) => Promise<{ output: unknown }>;
    const result = await runPostArtifact({
      toolCallId: 'node-artifact-binding',
      log: { info() {}, warn() {}, error() {} },
      data: { path: '/home/user/proof.txt', filename: 'proof.txt' },
      harness: { sandbox: artifactSandbox(bytes) },
    });

    assert.deepEqual(result, {
      output: { attached: true, filename: 'proof.txt', byteLength: bytes.byteLength },
    });
    assert.deepEqual(requests, [
      'https://slack.invalid/api/auth.test',
      'https://slack.invalid/api/files.getUploadURLExternal',
      'https://uploads.slack.test/node-artifact',
      'https://slack.invalid/api/files.completeUploadExternal',
    ]);
    assert.deepEqual(receipts.receipts.map((receipt) => ({
      fileId: receipt.fileId,
      filename: receipt.filename,
      byteLength: receipt.byteLength,
      destination: receipt.destination,
    })), [{
      fileId,
      filename: 'proof.txt',
      byteLength: bytes.byteLength,
      destination: {
        workspaceId: CONVERSATION.workspaceId,
        agentId: AGENT.id,
        channelId: CONVERSATION.channelId,
        threadTs: CONVERSATION.threadTs,
      },
    }]);
  }).finally(() => {
    invalidateSlackInstallationCredentialCache();
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  });
});

test('native file-delivery completion preserves authority, response state, and bounded recovery', { timeout: 30_000 }, async (t) => {
  const faux = fauxProvider({ models: [{ id: 'file-delivery' }], tokensPerSecond: 100_000 });
  const stopInstrumentation = instrument({
    interceptor: memoryToolPolicyInterceptor,
    observe(event, context) {
      observeMemoryToolPolicy(event, context);
      if (probe && event.type === 'tool') {
        probe.toolOutcomes.push({ tool: event.toolName, isError: event.isError });
      }
      if (!probe || event.type !== 'turn_request' || event.purpose !== 'agent') return;
      const repairMessages = event.request.input.messages.flatMap((message) => {
        const text = userText(message);
        return text?.startsWith('<slack_file_delivery_check ') ? [text] : [];
      });
      probe.repairSignalCounts.push(repairMessages.length);
      for (const text of repairMessages) {
        probe.repairAuthority.push(Boolean(parseModelVisibleCurrentRequestEnvelope(text)));
      }
    },
    dispose() {},
  });
  const runtime = await start({
    agents: [{ agent: SlackProbe, name: CHICKPEA_SLACK_AGENT_NAME },
      { agent: RoutineProbe, name: CHICKPEA_ROUTINE_EXECUTION_AGENT_NAME }],
    providers: [faux.provider],
  });
  let sequence = 0;
  function begin(responses: Parameters<typeof faux.setResponses>[0]) {
    probe = { staged: [], responseStarts: 0, deliveries: [], repairSignalCounts: [], repairAuthority: [], toolOutcomes: [], oversizeAttempts: 0 };
    faux.setResponses(responses);
    return { id: `file-delivery-${++sequence}`, callsBefore: faux.state.callCount };
  }
  async function slackRun(id: string) {
    const handle = init(SlackProbe, { id });
    const state = dispatchState(slackEnvelope(id));
    const input = { handle, state, message: 'Create an install report.', turnId: `turn-${id}`,
      conversationKey: id, useCloudflareSandbox: false, requestedModel: MODEL };
    const result = await promptSlackThreadAgent(input);
    assert.ok(state.dispatchReceipt);
    const reply = await handle.read(state.dispatchReceipt);
    return { handle, state, input, result, reply };
  }
  function assertRepaired() {
    assert.equal(probe.responseStarts, 1);
    assert.equal(Math.max(...probe.repairSignalCounts), 1);
    assert.ok(probe.repairAuthority.length > 0);
    assert.ok(probe.repairAuthority.every(Boolean));
    assert.ok(probe.deliveries.some((delivery) => delivery.kind === 'signal' && delivery.type === FILE_DELIVERY_SIGNAL_TYPE));
  }
  try {
    for (const scenario of [
      { name: 'absolute path', path: '/home/user/report.md', draft: 'Created /home/user/report.md.' },
      { name: 'relative filename', path: 'report.md', draft: 'Created report.md.' },
      { name: 'no filename after shell creation', path: 'report.md', draft: 'The install report is ready.', shell: true },
    ]) {
      await t.test(`repairs an omitted Markdown export with ${scenario.name}`, async () => {
        const { id, callsBefore } = begin([
          scenario.shell ? call('bash', { command: "printf '# Install report\\n\\nThe installation checks passed.\\n' > report.md" }) : writeReport(scenario.path),
          fauxAssistantMessage(scenario.draft), completeReport(scenario.path),
          fauxAssistantMessage('Attached the install report.'),
        ]);
        const { reply, result, handle, state, input } = await slackRun(id);
        assertRepaired();
        assert.equal(faux.state.callCount - callsBefore, 4);
        assert.equal(probe.staged.length, 1);
        assert.equal(probe.staged[0]!.filename, 'report.md');
        assert.equal(new TextDecoder().decode(probe.staged[0]!.bytes as Uint8Array), REPORT);
        assert.equal(completionResult(reply).unresolved, false);
        assert.equal(result.text, 'Attached the install report.');
        assert.equal(result.artifacts?.length, 1);
        assert.deepEqual(result.artifacts?.[0]?.destination, { ...CONVERSATION, agentId: AGENT.id });
        const callsAfter = faux.state.callCount;
        assert.deepEqual(await handle.read(state.dispatchReceipt!), reply);
        delete state.flueSettlement;
        assert.deepEqual(await promptSlackThreadAgent(input), result);
        assert.equal(faux.state.callCount, callsAfter);
        assert.equal(probe.staged.length, 1);
      });
    }

    await t.test('an unreadable selected path gets one export repair beside a terminal oversized file', async () => {
      const { id, callsBefore } = begin([
        call('bash', { command: "printf 'AE6F-SMALL: ready\\n' > small.md; printf '%1000000s' '' | tr ' ' X > large.txt" }),
        call(COMPLETE_FILE_DELIVERY_TOOL, { files: [
          { path: 'large.txt', filename: 'large.txt' }, { path: 'mistaken.md', filename: 'small.md' },
        ] }),
        fauxAssistantMessage('The large file is too large and the small file could not attach.'),
        call('glob', { pattern: '*.md' }),
        call(COMPLETE_FILE_DELIVERY_TOOL, { files: [{ path: 'small.md', filename: 'small.md' }], excludedPaths: ['mistaken.md'] }),
        fauxAssistantMessage('Attached everything.'),
      ]);
      const { result, reply } = await slackRun(id);
      assertRepaired();
      assert.equal(faux.state.callCount - callsBefore, 6);
      assert.equal(probe.oversizeAttempts, 1);
      assert.deepEqual(probe.staged.map((file) => file.filename), ['small.md']);
      assert.equal(new TextDecoder().decode(probe.staged[0]!.bytes as Uint8Array), 'AE6F-SMALL: ready\n');
      assert.equal(completionResult(reply).unresolved, false);
      assert.equal(result.artifacts?.length, 1);
      assert.match(result.text, /large.txt because it exceeds the upload limit/);
      assert.doesNotMatch(result.text, /couldn't attach small|Attached everything|mistaken/);
    });

    await t.test('a missing source after the repair stays honest and cannot suppress a good attachment', async () => {
      const files = [{ path: 'report.md', filename: 'report.md' }, { path: 'missing.md', filename: 'missing.md' }];
      const { id, callsBefore } = begin([
        writeReport(), call(COMPLETE_FILE_DELIVERY_TOOL, { files }),
        fauxAssistantMessage('Everything attached.'),
        call(COMPLETE_FILE_DELIVERY_TOOL, { files: [] }),
        fauxAssistantMessage('Everything attached.'),
      ]);
      const { result, reply } = await slackRun(id);
      assertRepaired();
      assert.equal(faux.state.callCount - callsBefore, 5);
      assert.equal(completionResult(reply).unresolved, true);
      assert.equal(probe.staged.length, 1);
      assert.equal(result.artifacts?.length, 1);
      assert.match(result.text, /missing.md because the selected file could not be read/);
      assert.doesNotMatch(result.text, /Everything attached/);
    });

    await t.test('an ignored correction becomes an honest incomplete result after one repair', async () => {
      const { id, callsBefore } = begin([writeReport(), fauxAssistantMessage('Created /home/user/report.md.'),
        fauxAssistantMessage('Everything is done. Read /home/user/report.md.')]);
      const { result, reply } = await slackRun(id);
      assertRepaired();
      assert.equal(faux.state.callCount - callsBefore, 3);
      assert.equal(probe.staged.length, 0);
      assert.equal(completionResult(reply).unresolved, true);
      assert.match(result.text, /couldn't finish checking/);
      assert.doesNotMatch(result.text, /Everything is done|\/home\/user\/report\.md/);
      assert.equal(result.artifacts, undefined);
    });

    for (const mutation of [
      { tool: 'bash', args: { command: "printf 'replacement from a rerun' > report.md" } },
      { tool: 'write', args: { path: 'report.md', content: 'replacement from a rerun' } },
      { tool: 'edit', args: { path: 'report.md', oldText: 'installation checks passed', newText: 'rerun overwrote the result' } },
    ]) {
      await t.test(`repair denies ${mutation.tool} work while preserving the original file for export`, async () => {
        const { id, callsBefore } = begin([
          writeReport(), fauxAssistantMessage('Created /home/user/report.md.'),
          call(mutation.tool, mutation.args), completeReport(),
          fauxAssistantMessage('Attached the original completed report.'),
        ]);
        const { result, reply } = await slackRun(id);
        assertRepaired();
        assert.equal(faux.state.callCount - callsBefore, 5);
        assert.ok(probe.toolOutcomes.some((outcome) => outcome.tool === mutation.tool && outcome.isError));
        assert.equal(probe.staged.length, 1);
        assert.equal(new TextDecoder().decode(probe.staged[0]!.bytes as Uint8Array), REPORT);
        assert.equal(completionResult(reply).unresolved, false);
        assert.equal(result.artifacts?.length, 1);
        assert.equal(result.text, 'Attached the original completed report.');
      });
    }

    await t.test('a later ordinary request can write after the previous response needed repair', async () => {
      const { id } = begin([writeReport(), fauxAssistantMessage('The report is ready.'),
        completeReport(), fauxAssistantMessage('Attached the report.')]);
      const first = await slackRun(id);
      assertRepaired();
      const callsBefore = faux.state.callCount;
      const revised = '# New request\n\nA later request may create or revise files.\n';
      faux.setResponses([
        call('write', { path: 'report.md', content: revised }),
        call('post_artifact', { path: 'report.md', filename: 'report.md' }),
        fauxAssistantMessage('Attached the report from your new request.'),
      ]);
      const messageTs = '1789230000.000300';
      const envelope = slackEnvelope(id);
      assert.equal(envelope.schemaVersion, 2);
      if (envelope.schemaVersion !== 2) throw new Error('Signal envelope expected.');
      const followupState = dispatchState({ ...envelope, uid: first.state.dispatchReceipt!.uid,
        idempotencyKey: `followup-${id}`, message: { ...envelope.message,
          body: `Create a new report.\n\n${serializeCurrentRequestEnvelope('', false, ACTOR, messageTs)}`,
          attributes: { ...envelope.message.attributes, messageTs, turnJobId: `followup-${id}` },
        } });
      const result = await promptSlackThreadAgent({ ...first.input, state: followupState,
        message: 'Create a new report.', turnId: `followup-${id}` });
      assert.equal(faux.state.callCount - callsBefore, 3);
      assert.equal(probe.responseStarts, 2);
      assert.equal(probe.staged.length, 2);
      assert.equal(new TextDecoder().decode(probe.staged[1]!.bytes as Uint8Array), revised);
      assert.deepEqual(result.artifacts?.map((file) => file.fileId), ['FPROBE00002']);
      assert.equal(result.text, 'Attached the report from your new request.');
    });

    await t.test('a proactively posted file needs no correction model call', async () => {
      const { id, callsBefore } = begin([writeReport(),
        call('post_artifact', { path: 'report.md', filename: 'report.md' }),
        fauxAssistantMessage('Attached the install report.')]);
      const { result, reply } = await slackRun(id);
      assert.equal(faux.state.callCount - callsBefore, 3);
      assert.equal(Math.max(...probe.repairSignalCounts), 0);
      assert.equal(probe.responseStarts, 1);
      assert.equal(probe.staged.length, 1);
      assert.equal(completionResult(reply).unresolved, false);
      assert.equal(result.artifacts?.length, 1);
    });

    await t.test('a follow-up starts without earlier sandbox files and delivers its recreated small file beside a size rejection', async () => {
      const { id } = begin([
        call('write', { path: 'small.md', content: 'earlier contents' }),
        call('post_artifact', { path: 'small.md', filename: 'small.md' }),
        fauxAssistantMessage('Attached the earlier file.'),
      ]);
      const first = await slackRun(id);
      const messageTs = '1789230000.000400';
      const envelope = slackEnvelope(id);
      if (envelope.schemaVersion !== 2) throw new Error('Signal envelope expected.');
      const followup = dispatchState({ ...envelope, uid: first.state.dispatchReceipt!.uid,
        idempotencyKey: `partial-followup-${id}`, message: { ...envelope.message,
          body: `Recreate small.md and large.txt and return both.\n\n${serializeCurrentRequestEnvelope('', false, ACTOR, messageTs)}`,
          attributes: { ...envelope.message.attributes, messageTs, turnJobId: `partial-followup-${id}` },
        } });
      faux.setResponses([
        call('read', { path: 'small.md' }),
        call('bash', { command: "printf 'AE6F-SMALL: ready\\n' > small.md; printf '%1000000s' '' | tr ' ' X > large.txt" }),
        call('post_artifact', { path: 'large.txt', filename: 'large.txt' }),
        call(COMPLETE_FILE_DELIVERY_TOOL, { files: [{ path: 'large.txt', filename: 'large.txt' }, { path: 'small.md', filename: 'small.md' }] }),
        fauxAssistantMessage('Both files attached.'),
      ]);
      const result = await promptSlackThreadAgent({ ...first.input, state: followup,
        message: 'Recreate both files.', turnId: `partial-followup-${id}` });
      assert.ok(probe.toolOutcomes.some((outcome) => outcome.tool === 'read' && outcome.isError));
      assert.equal(probe.oversizeAttempts, 1);
      assert.equal(probe.staged.length, 2);
      assert.equal(new TextDecoder().decode(probe.staged[1]!.bytes as Uint8Array), 'AE6F-SMALL: ready\n');
      assert.deepEqual(result.artifacts?.map((file) => file.fileId), ['FPROBE00002']);
      assert.match(result.text, /large.txt because it exceeds the upload limit/);
      assert.doesNotMatch(result.text, /couldn't attach small|Both files attached/);
    });

    await t.test('correction keeps an earlier CSV receipt and stages only the missing Markdown file', async () => {
      const { id, callsBefore } = begin([
        call('write', { path: 'summary.csv', content: 'check,status\ninstall,passed\n' }),
        call('post_artifact', { path: 'summary.csv', filename: 'summary.csv' }),
        writeReport(), fauxAssistantMessage('Both reports are ready.'),
        call(COMPLETE_FILE_DELIVERY_TOOL, { files: [{ path: 'summary.csv', filename: 'summary.csv' },
          { path: 'report.md', filename: 'report.md' }] }),
        fauxAssistantMessage('Attached both reports.'),
      ]);
      const { result, reply } = await slackRun(id);
      assertRepaired();
      assert.equal(faux.state.callCount - callsBefore, 6);
      assert.deepEqual(probe.staged.map((file) => file.filename), ['summary.csv', 'report.md']);
      assert.deepEqual(parseSlackArtifactReceipts(reply.data?.[SLACK_ARTIFACT_RECEIPTS_DATA_NAME])
        .map((receipt) => receipt.fileId), ['FPROBE00001', 'FPROBE00002']);
      assert.equal(result.artifacts?.length, 2);
      assert.equal(result.text, 'Attached both reports.');
    });

    for (const addMarkdown of [true, false]) {
      await t.test(`completion preserves a prepared CSV when ${addMarkdown ? 'only a new Markdown file is listed' : 'an empty list confirms later scratch work'}`, async () => {
        const files = addMarkdown ? [{ path: 'report.md', filename: 'report.md' }] : [];
        const { id, callsBefore } = begin([
          call('write', { path: 'summary.csv', content: 'check,status\ninstall,passed\n' }),
          call('post_artifact', { path: 'summary.csv', filename: 'summary.csv' }),
          call('bash', { command: "printf 'temporary calculation' > scratch.txt" }),
          ...(addMarkdown ? [writeReport()] : []),
          fauxAssistantMessage('The requested work is complete.'),
          call(COMPLETE_FILE_DELIVERY_TOOL, { files }),
          fauxAssistantMessage(addMarkdown ? 'Attached the CSV and Markdown report.' : 'Attached the CSV summary.'),
        ]);
        const { result, reply } = await slackRun(id);
        assertRepaired();
        assert.equal(faux.state.callCount - callsBefore, addMarkdown ? 7 : 6);
        const expected = addMarkdown ? ['summary.csv', 'report.md'] : ['summary.csv'];
        assert.deepEqual(probe.staged.map((file) => file.filename), expected);
        assert.deepEqual(result.artifacts?.map((file) => file.filename), expected);
        assert.deepEqual(completionResult(reply).files.map((file) => file.filename).sort(), [...expected].sort());
        assert.equal(completionResult(reply).unresolved, false);
        assert.ok(!probe.staged.some((file) => file.filename === 'scratch.txt'));
      });
    }

    await t.test('a terminating routine result still permits same-response file correction', async () => {
      const { id, callsBefore } = begin([
        writeReport(), call('submit_routine_result', { outcome: 'succeeded', message: 'Created /home/user/report.md.' }),
        completeReport(), call('submit_routine_result', { outcome: 'succeeded', message: 'Attached the scheduled report.' }),
      ]);
      const scheduledFor = 1_789_230_000_000;
      const handle = init(RoutineProbe, { id });
      const receipt = await handle.dispatch({ message: {
        kind: 'signal', type: 'schedule',
        body: `Create an install report.\n\n${serializeCurrentRequestEnvelope('', false, ACTOR, scheduleSignalMessageTs(scheduledFor))}`,
        attributes: { workspaceId: CONVERSATION.workspaceId, routineId: 'routine-probe', occurrenceId: 'occurrence-probe',
          conversationId: 'conversation-probe', ownerAgentId: AGENT.id, actorSlackUserId: ACTOR, scheduledFor: String(scheduledFor) },
      } });
      const reply = await handle.read(receipt);
      assertRepaired();
      assert.equal(faux.state.callCount - callsBefore, 4);
      assert.deepEqual(reply.data?.routineResult, [{ outcome: 'succeeded', message: 'Attached the scheduled report.' }]);
      const structured = v.parse(RoutineModelResultSchema, reply.data?.routineResult?.at(-1));
      assert.equal(structured.message, 'Attached the scheduled report.');
      assert.doesNotMatch(structured.message, /\/home\/user|Created/);
      assert.equal(completionResult(reply).unresolved, false);
      assert.equal(parseSlackArtifactReceipts(reply.data?.[SLACK_ARTIFACT_RECEIPTS_DATA_NAME]).length, 1);
      assert.equal(probe.staged.length, 1);
    });
  } finally {
    await runtime.stop();
    await stopInstrumentation();
  }
});
