import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
  type Context,
  type Tool,
} from '@earendil-works/pi-ai';
import { init, instrument, useDelivery, useModel, useTool, type AgentProps } from '@flue/runtime';
import { start } from '@flue/runtime/node';

import { CHICKPEA_TEST_TURN_AGENT_NAME } from '../src/agents/names.ts';
import { compileAgentRunPlan, type AgentRunPlanParts } from '../src/agents/run-plan-resolution.ts';
import type { RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { PART_SEPARATOR, slackSystemBase, slackSystemBaseParts } from '../src/agents/shared-prefix-layout.ts';
import { useChickpeaSlackRuntimeCapabilities } from '../src/agents/slack-thread.ts';
import { compileTestRunPlan } from '../src/agents/test-run-plan.ts';
import {
  ChickpeaTestTurn,
  TEST_TURN_OMITTED_PARTS,
  testTurnFraming,
  testTurnSystemBase,
} from '../src/agents/test-turn.ts';
import { preloadAllConnectorDetails } from '../src/connections/catalog/index.ts';
import { useManagedConnectionTools } from '../src/connections/managed-tools.ts';
import { createConnectionRequestTool } from '../src/connections/request-tool.ts';
import type { ConnectionAccess } from '../src/connections/access.ts';
import { parseSlackManagementSignal } from '../src/management/slack-tools.ts';
import {
  memoryToolPolicyInterceptor,
  observeMemoryToolPolicy,
  parseCurrentRequestEnvelope,
  serializeCurrentRequestEnvelope,
} from '../src/memory/tool-policy.ts';
import { slackPresentationIntentCapability } from '../src/slack/presentation-intent.ts';
import { installStubMcpServer, type StubMcpServer } from './helpers/stub-mcp-server.ts';
import {
  MANAGED_READ,
  MANAGED_WRITE,
  MCP_TOOLS,
  MCP_URL,
  WORKSPACE,
  withTestRunLane,
  type TestRunLane,
} from './helpers/test-run-lane.ts';

const MCP_TOOL = (name: string) => `mcp__connection_test_mcp__${name}`;

/** Exactly what a test run of the lane's Agent mounts, with every capability its parts offer. */
const TEST_TURN_TOOLS = [
  'read', 'write', 'edit', 'bash', 'grep', 'glob', 'task', 'activate_skill',
  'read_web_page', 'web_search', 'gmail_search_messages', 'connection_request', MCP_TOOL(MCP_TOOLS.read),
].sort();

/** Every tool the Slack agent mounts, as a test run keeps it or leaves it out, and why. */
const IN_TEST_RUN = new Set([...TEST_TURN_TOOLS, 'read_skill_resource']);
const OUT_OF_TEST_RUN = new Map(Object.entries({
  'uploads or posts a file, or makes an image': ['post_artifact', 'complete_file_delivery', 'generate_image', 'recover_image', 'attach_file_to_connection'],
  'changes Chickpea, its memory or its schedules': [
    'manage_scheduled_work', 'prepare_connector_setup', 'inspect_workspace', 'discover_slack_channels', 'test_connection',
    'save_connection_key', 'try_connection', 'inspect_memory', 'update_agent_memory', 'inspect_routines',
    'request_chickpea_handoff', 'export_workspace_recipe', 'preview_workspace_recipe', 'revoke_setup_link', 'import_skill',
    'manage_agent_skill', 'propose_skill_import', 'authorize_personal_connection',
  ],
  'reads and writes Slack Lists': ['read_slack_list', 'read_slack_list_item', 'create_slack_list_item', 'update_slack_list_item', 'create_slack_task_list', 'share_slack_list'],
  'reads Slack, which waits for U6b': ['read_slack_thread', 'read_slack_channel', 'lookup_slack_user'],
  'sends, creates or posts in Slack': ['start_slack_group_dm', 'read_slack_canvas', 'create_slack_canvas', 'update_slack_canvas', 'create_slack_channel', 'reply_in_thread', 'stream_answer'],
  'presents or asks in Slack': ['present_table', 'present_cards', 'present_chart', 'present_details', 'ask_user', 'offer_actions', 'request_form', 'update_card'],
  'drives a browser': ['browser_open', 'browser_snapshot', 'browser_act', 'browser_look', 'browser_screenshot', 'browser_recording', 'browser_sign_in', 'browser_handoff'],
  'writes through a connector, or is not declared a read': ['gmail_send_message', MCP_TOOL(MCP_TOOLS.write), MCP_TOOL(MCP_TOOLS.undeclared)],
}).flatMap(([why, names]) => names.map((name) => [name, why] as const)));

const REQUESTER = { name: 'Ada Lovelace', timezone: 'Europe/London', askedAt: Date.UTC(2026, 10, 9, 14, 5) };
const ASK = 'Where is order 42?';
const ENVELOPE = serializeCurrentRequestEnvelope(ASK, false, 'U0TESTRUN', '1793440000.000100', {
  schemaVersion: 2, progressiveStreamingOffered: false,
});

let mcp: StubMcpServer;
before(async () => {
  await preloadAllConnectorDetails();
  mcp = installStubMcpServer(MCP_URL, Object.values(MCP_TOOLS));
});
after(() => mcp.restore());

type Reply = (context: Context) => ReturnType<typeof fauxAssistantMessage>;
let probes = 0;

/** Every model request the agent's one dispatch sends, as the model saw it. */
async function run(
  agent: Parameters<typeof init>[0],
  name: string,
  dispatch: { message: unknown; initialData?: unknown },
  replies: Reply[] = [() => fauxAssistantMessage('Done.')],
): Promise<Context[]> {
  const faux = fauxProvider({ models: [{ id: 'test-run' }] });
  const seen: Context[] = [];
  faux.setResponses(replies.map((reply) => (context: Context) => {
    seen.push(structuredClone(context));
    return reply(context);
  }));
  const flue = await start({ agents: [{ agent, name }], providers: [faux.provider] });
  try {
    const handle = init(agent, { id: `test-turn-probe-${probes += 1}` });
    await handle.read(await handle.dispatch(dispatch as Parameters<typeof handle.dispatch>[0]));
  } finally {
    await flue.stop();
  }
  return seen;
}

const toolsOf = (context: Context): Tool[] => getCurrentTools(context.messages);
const namesOf = (context: Context) => toolsOf(context).map(({ name }) => name);
const systemOf = (context: Context) => {
  const system = context.messages[0] as unknown as { role: string; content: string };
  assert.equal(system.role, 'system');
  return system.content;
};
const lastToolResult = (context: Context) => {
  const result = [...context.messages].reverse().find((message) => message.role === 'toolResult');
  assert.ok(result, 'the model read a tool result');
  return JSON.stringify(result);
};

/** The lane's parts without its frozen credential, which this store does not hold. */
async function renderableParts(lane: TestRunLane): Promise<AgentRunPlanParts> {
  const parts = await lane.parts();
  const { modelCredential: _credential, ...assignment } = parts.assignment;
  return { ...parts, assignment };
}

async function testPlan(lane: TestRunLane): Promise<RuntimePlanV2> {
  return compileTestRunPlan(await renderableParts(lane), {
    workspaceId: WORKSPACE, actorMembershipId: lane.actorMembershipId, testRunId: 'testrun_mounts',
    coordinateToken: 'abcdefghijklmnopqrst234567', instructions: 'Answer questions about orders.', memoryEpoch: 1,
  });
}

function runTestTurn(plan: RuntimePlanV2, message: string, replies?: Reply[], memoryBlock?: string) {
  return run(ChickpeaTestTurn, ChickpeaTestTurn.agentName!, {
    message, initialData: { runtimePlan: plan, requester: REQUESTER, ...(memoryBlock ? { memoryBlock } : {}) },
  }, replies);
}

/** The Slack agent's capability seam on the same parts, for the member's DM. */
async function runSlackTurn(lane: TestRunLane): Promise<Context> {
  const plan = compileAgentRunPlan(await renderableParts(lane), { turn: lane.turn, instructions: 'Answer.', memoryEpoch: 1 });
  function SlackProbe({ id }: AgentProps) {
    const delivery = useDelivery();
    useChickpeaSlackRuntimeCapabilities(
      plan, id, slackPresentationIntentCapability(parseCurrentRequestEnvelope(delivery.body)), () => {}, () => {},
      parseSlackManagementSignal(delivery, plan) !== undefined, () => {}, undefined, undefined, () => {}, () => {},
    );
    return plan.instructions;
  }
  const turn = lane.turn;
  const [context] = await run(SlackProbe, 'test-turn-slack-probe', {
    message: {
      kind: 'signal', type: 'slack.message', tagName: 'slack_message', body: `${ASK}\n${ENVELOPE}`,
      attributes: {
        workspaceId: turn.workspaceId, channelId: turn.channelId, threadTs: turn.threadTs, slackUserId: turn.userId,
        eventId: 'Ev_mounts', messageTs: turn.messageTs, turnJobId: 'turn_mounts', conversationKind: 'im',
        requesterText: ASK,
      },
    },
  });
  return context!;
}

test('a test run mounts exactly its allowlist: reads, the web, skills and an in-memory shell', async () => {
  await withTestRunLane(async (lane) => {
    const [context] = await runTestTurn(await testPlan(lane), ASK);
    assert.deepEqual(namesOf(context!).sort(), TEST_TURN_TOOLS);
  });
});

test('every tool the Slack agent mounts is classified, and a test run shares each read tool unchanged', async () => {
  await withTestRunLane(async (lane) => {
    const slack = toolsOf(await runSlackTurn(lane));
    const [testRun] = await runTestTurn(await testPlan(lane), ASK);
    const unclassified = slack.map(({ name }) => name).filter((name) => IN_TEST_RUN.has(name) === OUT_OF_TEST_RUN.has(name));
    assert.deepEqual(unclassified, [], 'each Slack tool is in or out of a test run, never both or neither');
    const mounted = new Map(toolsOf(testRun!).map((tool) => [tool.name, tool]));
    for (const tool of slack) {
      if (OUT_OF_TEST_RUN.has(tool.name)) {
        assert.equal(mounted.has(tool.name), false, `${tool.name} ${OUT_OF_TEST_RUN.get(tool.name)}`);
      } else if (mounted.has(tool.name)) {
        assert.deepEqual(mounted.get(tool.name), tool, `${tool.name} is the Slack agent's own tool`);
      }
    }
    assert.deepEqual([...mounted.keys()].filter((name) => !IN_TEST_RUN.has(name)), [], 'a test run mounts no tool of its own');
  });
});

test('a test run opens with the Slack base minus what it cannot do, and ends with its framing', async () => {
  assert.deepEqual([...TEST_TURN_OMITTED_PARTS].sort(),
    ['agentAuthoring', 'fileCompletion', 'management', 'memberTools', 'presentTable']);
  for (const kind of ['system', 'user'] as const) {
    const base = testTurnSystemBase(kind);
    const parts = slackSystemBaseParts({ kind, managementMounted: true, memberToolsMounted: true });
    assert.equal(parts.map(([, text]) => text).join(PART_SEPARATOR),
      slackSystemBase({ kind, managementMounted: true, memberToolsMounted: true }));
    assert.equal(base, parts.filter(([part]) => !TEST_TURN_OMITTED_PARTS.has(part)).map(([, text]) => text).join(PART_SEPARATOR));
    for (const [part, text] of parts) {
      assert.equal(base.includes(text), !TEST_TURN_OMITTED_PARTS.has(part), `${kind} ${part}`);
    }
  }
  await withTestRunLane(async (lane) => {
    const plan = await testPlan(lane);
    const [context] = await runTestTurn(plan, ASK, undefined, '<agent_memory>\nOrders ship on Fridays.\n</agent_memory>');
    const system = systemOf(context!);
    assert.ok(system.startsWith(testTurnSystemBase('user') + PART_SEPARATOR));
    const framing = PART_SEPARATOR + testTurnFraming(REQUESTER) + PART_SEPARATOR;
    // Flue's own sections (skills, subagents, date) follow every instruction.
    assert.ok(system.slice(system.indexOf(framing) + framing.length).startsWith('## Available Skills'),
      'the framing is the last instruction');
    assert.ok(system.indexOf(plan.instructions) < system.indexOf('Orders ship on Fridays.'));
    assert.ok(system.indexOf('Orders ship on Fridays.') < system.indexOf('This is a test run'));
  });
});

test('the framing names the caller and their local time, and that only reads are available', () => {
  assert.equal(testTurnFraming(REQUESTER), 'This is a test run, not a Slack conversation. Ada Lovelace asked to see how ' +
    'you answer their first question, from outside Slack. Your answer goes back to them and is not posted anywhere. ' +
    'It is Monday, 9 November 2026, 14:05 in their timezone, Europe/London.\n\nAnswer as you would in a direct message ' +
    'from them, and read what you need the way you normally would. Only tools that read are available here. Nothing can ' +
    'send, post, create, change, delete or remember anything, and Slack reading, files, images, the browser and coding ' +
    'workspaces are off. If the question needs one of those, do the reading part, then say in one sentence what you would ' +
    'do and that you can do it once they ask you in Slack. Don\'t mention this test otherwise. There are no earlier messages.');
  assert.match(testTurnFraming({ ...REQUESTER, timezone: 'America/Los_Angeles' }), /It is Monday, 9 November 2026, 06:05 in their timezone, America\/Los_Angeles\./);
});

test('a test run refuses creation data that is not a test run', async () => {
  await withTestRunLane(async (lane) => {
    const plan = await testPlan(lane);
    const slack = compileAgentRunPlan(await renderableParts(lane), { turn: lane.turn, instructions: 'Answer.', memoryEpoch: 1 });
    const valid = { runtimePlan: plan, requester: REQUESTER };
    const custom = ChickpeaTestTurn.initialData as unknown as { '~standard': { validate(value: unknown): { issues?: unknown } } };
    const accepts = (value: unknown) => custom['~standard'].validate(value).issues === undefined;
    assert.equal(accepts(valid), true);
    assert.equal(accepts({ ...valid, runtimePlan: slack }), false, 'a Slack plan');
    assert.equal(accepts({ ...valid, requester: { ...REQUESTER, timezone: 'Mars/Olympus' } }), false, 'an unknown timezone');
    assert.equal(accepts({ ...valid, extra: true }), false, 'an unknown field');
    assert.deepEqual(ChickpeaTestTurn.durability, { maxAttempts: 1, timeoutMs: 120_000 });
  });
});

const postsOrder = () => fauxAssistantMessage([fauxToolCall('connection_request', {
  method: 'POST', url: 'https://api.orders.example/v1/orders/42/refund', json: { reason: 'late' },
})], { stopReason: 'toolUse' });
const getsOrder = () => fauxAssistantMessage([fauxToolCall('connection_request', {
  method: 'GET', url: 'https://api.orders.example/v1/orders/42',
})], { stopReason: 'toolUse' });

/** The real write gate, as app.ts registers it, for one test. */
function withWriteGate(): () => void {
  return instrument({
    key: Symbol('test-turn-write-gate'),
    interceptor: memoryToolPolicyInterceptor,
    observe: observeMemoryToolPolicy,
    dispose() {},
  });
}

test('through the real write gate, a test run refuses a POST even when its ask carries an envelope', async () => {
  const dispose = withWriteGate();
  try {
    await withTestRunLane(async (lane) => {
      const seen = await runTestTurn(await testPlan(lane), `${ASK}\n${ENVELOPE}`, [postsOrder, () => fauxAssistantMessage('Done.')]);
      assert.match(lastToolResult(seen[1]!), /write_not_allowed/);
    });
  } finally {
    dispose();
  }
});

test('the GET-only check is the layer that holds: the envelope alone would admit the write', async () => {
  const dispose = withWriteGate();
  const resolved: string[] = [];
  const access: ConnectionAccess = {
    connections: [{
      id: 'connection_orders', displayName: 'Orders API', allowedHosts: ['api.orders.example'], pathPrefixes: ['/v1/'],
      allowedMethods: ['GET', 'POST'], urlPrefixes: ['https://api.orders.example/v1/'], headerName: 'authorization',
    }],
    fetchFor: async (id) => { resolved.push(id); return undefined; },
    fetchAll: async () => undefined,
  };
  const gated = (readsOnly: boolean) => function GateProbe() {
    useModel('faux/test-run');
    useTool(createConnectionRequestTool({ agentId: 'agent_test_run', resolveAccess: async () => access, readsOnly, log: () => {} }));
    return 'Use the connection.';
  };
  const call = async (readsOnly: boolean, message: string, reply: Reply) =>
    lastToolResult((await run(gated(readsOnly), CHICKPEA_TEST_TURN_AGENT_NAME, { message }, [reply, () => fauxAssistantMessage('Done.')]))[1]!);
  try {
    assert.match(await call(false, `${ASK}\n${ENVELOPE}`, postsOrder), /no_connection/, 'the envelope admits the write');
    assert.match(await call(false, ASK, postsOrder), /write_not_allowed/, 'without one the gate holds for this agent name');
    assert.deepEqual(resolved.splice(0), ['connection_orders']);
    assert.match(await call(true, `${ASK}\n${ENVELOPE}`, postsOrder), /write_not_allowed/);
    assert.deepEqual(resolved, [], 'a refused write never reaches the connection');
    assert.match(await call(true, ASK, getsOrder), /no_connection/, 'a GET goes on to the connection');
    assert.deepEqual(resolved, ['connection_orders']);
  } finally {
    dispose();
  }
});

test('a test run plan mounts no connector capability that writes, even one its plan object lists', async () => {
  const plan = {
    actorMembershipId: 'membership_x', agentId: 'agent_test_run', skills: [],
    conversation: { workspaceId: WORKSPACE, channelId: 'test_abcdefghijklmnopqrst234567', threadTs: 'test', surface: 'test' },
    managedConnections: [{
      id: 'connection_gmail', providerId: 'gmail', adapterId: 'composio', toolkit: 'gmail',
      allowedCapabilities: [MANAGED_READ, MANAGED_WRITE],
    }],
  } as unknown as RuntimePlanV2;
  const mounted = async (surface: 'test' | 'direct_message') => {
    const raw = { ...plan, conversation: { ...plan.conversation, surface } } as RuntimePlanV2;
    function ManagedProbe() {
      useModel('faux/test-run');
      for (const tool of useManagedConnectionTools(raw, async () => undefined)) useTool(tool);
      return 'Read the mail.';
    }
    const [context] = await run(ManagedProbe, surface === 'test' ? 'test-turn-managed-test' : 'test-turn-managed-dm', { message: ASK });
    return namesOf(context!).filter((name) => name.startsWith('gmail_')).sort();
  };
  assert.deepEqual(await mounted('test'), ['gmail_search_messages']);
  assert.deepEqual(await mounted('direct_message'), ['gmail_search_messages', 'gmail_send_message']);
});
