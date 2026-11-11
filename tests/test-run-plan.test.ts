import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileAgentRunPlan, type AgentRunPlanParts } from '../src/agents/run-plan-resolution.ts';
import {
  CONVERSATION_PLAN_SCHEMA_VERSION,
  deriveRuntimePlanInstanceId,
  parseRuntimePlanV2,
  RUNTIME_PLAN_SCHEMA_VERSION,
  runtimePlanUsesPersonalAccess,
  type RuntimePlanV2,
} from '../src/agents/runtime-plan.ts';
import { compileTestRunPlan, type TestRunConversation } from '../src/agents/test-run-plan.ts';
import {
  registerFrozenOpenRouterRuntimeModelRoute,
  type FrozenOpenRouterLiveModelRoute,
} from '../src/config/openrouter-runtime-model.ts';
import { resetBuiltinProviderModelOverlaysForTests } from '../src/config/pi-provider.ts';
import { splitInstallationObjectName } from '../src/config/installation-scope.ts';
import { opaqueId } from '../src/work/admission.ts';
import {
  API_ACCOUNT,
  EVERY_PLAN_KEY,
  INSTALLATION,
  MANAGED_ACCOUNT,
  MANAGED_READ,
  MANAGED_WRITE,
  MCP_ACCOUNT,
  MCP_TOOLS,
  WORKSPACE,
  withTestRunLane,
  type TestRunLane,
} from './helpers/test-run-lane.ts';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz'.slice(0, 20) + '234567';
const OVERLAY_MODEL = 'openrouter/acme/fresh-live-model';
const OVERLAY_ROUTE: FrozenOpenRouterLiveModelRoute = {
  source: 'openrouter_live_catalog', displayName: 'Acme Fresh Live Model', contextWindow: 196_608, maxTokens: 32_768,
  reasoning: false, input: ['text', 'image'], cost: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 },
};

function testConversation(lane: TestRunLane): TestRunConversation {
  return {
    workspaceId: WORKSPACE, actorMembershipId: lane.actorMembershipId, testRunId: 'testrun_1', coordinateToken: TOKEN,
    installation: INSTALLATION, instructions: 'Answer questions about orders.\nYou are Orders.', memoryEpoch: 7,
  };
}

/** The parts, on a model with a frozen live-catalog route, so every optional key has a value. */
async function routedParts(lane: TestRunLane): Promise<AgentRunPlanParts> {
  const parts = await lane.parts();
  return {
    ...parts,
    assignment: { ...parts.assignment, model: OVERLAY_MODEL },
    runtimeModel: OVERLAY_MODEL,
    runtimeModelRoute: OVERLAY_ROUTE,
  };
}

/** A DM turn's plan from the same parts, with a request that selects and leaves a choice, and a front desk. */
function slackPlan(lane: TestRunLane, parts: AgentRunPlanParts): RuntimePlanV2 {
  return compileAgentRunPlan(parts, {
    turn: lane.turn, installation: INSTALLATION, instructions: 'Answer.', memoryEpoch: 7,
    frontDesk: { agents: [{ id: 'agent_test_run', name: 'Orders' }] },
    request: {
      selected: [...parts.connections],
      selections: [{ group: 'orders', providerId: 'orders-api', accountId: API_ACCOUNT }],
      ambiguous: [{ providerId: 'sentry', choices: [{ label: 'Team Sentry', scope: 'team' }] }],
    },
  });
}

async function withRoutes<T>(run: () => Promise<T>): Promise<T> {
  registerFrozenOpenRouterRuntimeModelRoute(OVERLAY_MODEL, OVERLAY_MODEL, OVERLAY_ROUTE);
  try {
    return await run();
  } finally {
    resetBuiltinProviderModelOverlaysForTests();
  }
}

test('the fixture turns on every key a plan can carry, so each narrowing has something to remove', async () => {
  await withRoutes(() => withTestRunLane(async (lane) => {
    const slack = slackPlan(lane, await routedParts(lane));
    assert.deepEqual(Object.keys(slack).sort(), Object.keys(EVERY_PLAN_KEY).sort());
    assert.equal(slack.schemaVersion, CONVERSATION_PLAN_SCHEMA_VERSION, 'a Slack turn still freezes V4');
    assert.equal(slack.conversation.guest, true);
    assert.ok(slack.repositories.length > 0 && slack.connectionAuthorizations!.length > 0 &&
      slack.connectionChoices!.length > 0 && slack.imageCapability!.filled);
    assert.deepEqual(slack.mcpConnections[0]!.allowedTools, Object.values(MCP_TOOLS).sort());
    assert.deepEqual(slack.managedConnections![0]!.allowedCapabilities, [MANAGED_READ, MANAGED_WRITE].sort());
  }));
});

test('a test run compiles the same Agent as V5 on its own coordinate, narrowed to reads', async () => {
  await withRoutes(() => withTestRunLane(async (lane) => {
    const parts = await routedParts(lane);
    const plan = compileTestRunPlan(parts, testConversation(lane));
    const slack = slackPlan(lane, parts);

    assert.equal(plan.schemaVersion, RUNTIME_PLAN_SCHEMA_VERSION);
    assert.deepEqual(plan.conversation, {
      workspaceId: WORKSPACE, channelId: `test_${TOKEN}`, threadTs: 'test', surface: 'test',
      continuityKey: opaqueId('agent', 'test:testrun_1'),
    });
    assert.deepEqual(plan.artifactDestination, { kind: 'slack_conversation', channelId: `test_${TOKEN}` });
    assert.equal(plan.actorMembershipId, lane.actorMembershipId);
    assert.deepEqual(plan.installation, INSTALLATION);
    assert.equal(splitInstallationObjectName(deriveRuntimePlanInstanceId(plan)).scope?.installationId, INSTALLATION.installationId);

    // What no message decides is the Slack turn's, exactly.
    for (const key of ['agentId', 'model', 'runtimeModel', 'runtimeModelRoute', 'effort', 'modelAttribution',
      'modelCredential', 'skills', 'webSearch', 'teamReconnects', 'apiConnections', 'continuityPolicy'] as const) {
      assert.deepEqual(plan[key], slack[key], key);
    }
    assert.deepEqual(plan.configurationRevision, { agent: 1, channel: 4 });
    assert.equal(plan.ownerIncarnation, 2);
    assert.equal(plan.instructions, testConversation(lane).instructions);
    assert.equal(plan.memoryEpoch, 7);

    // Narrowed: the declared-read MCP tool, the read capability, and nothing that writes, posts or reaches Slack.
    assert.deepEqual(plan.mcpConnections.map(({ id, allowedTools, readOnlyTools, writeTools }) =>
      ({ id, allowedTools, readOnlyTools, writeTools })), [{
      id: MCP_ACCOUNT, allowedTools: [MCP_TOOLS.read], readOnlyTools: [MCP_TOOLS.read], writeTools: [],
    }]);
    assert.deepEqual(plan.managedConnections?.map(({ id, allowedCapabilities }) => ({ id, allowedCapabilities })),
      [{ id: MANAGED_ACCOUNT, allowedCapabilities: [MANAGED_READ] }]);
    assert.deepEqual(plan.apiConnections[0]?.allowedMethods, ['GET', 'POST'], 'GET-only is enforced at the tool');
    assert.deepEqual(plan.connectionAccountIds, [API_ACCOUNT, MANAGED_ACCOUNT, MCP_ACCOUNT].sort());
    for (const absent of ['frontDesk', 'handoffContext', 'codingWorkspace', 'browserCapability', 'websiteLogins',
      'imageCapability', 'connectionSelections'] as const) {
      assert.equal(plan[absent], undefined, absent);
    }
    assert.deepEqual([plan.repositories, plan.connectionAuthorizations, plan.connectionChoices], [[], [], []]);
    assert.equal(runtimePlanUsesPersonalAccess(plan), false);
    assert.deepEqual(parseRuntimePlanV2(JSON.parse(JSON.stringify(plan))), plan, 'the plan round-trips');
  }));
});

test('an MCP tool counts as a read only when declared one, and a Meta Ads tool only when reviewed as one', async () => {
  await withTestRunLane(async (lane) => {
    const parts = await lane.parts();
    const withPolicy = (policy: object) => ({
      ...parts,
      connections: parts.connections.map((connection) => connection.policy.kind === 'mcp'
        ? { ...connection, policy: { ...connection.policy, ...policy } } as typeof connection
        : connection),
    });
    const toolsOf = (plan: RuntimePlanV2) => plan.mcpConnections.flatMap(({ allowedTools }) => allowedTools);

    // A server's own read-only hint is not a declaration.
    const hinted = withPolicy({ discoveredTools: Object.values(MCP_TOOLS).map((name) => ({ name, readOnlyHint: true })) });
    assert.deepEqual(toolsOf(compileTestRunPlan(hinted, testConversation(lane))), [MCP_TOOLS.read]);

    // Nothing declared a read: the connection drops out, account and all.
    const writesOnly = compileTestRunPlan(withPolicy({ toolPolicies: { [MCP_TOOLS.read]: { effect: 'write' } } }), testConversation(lane));
    assert.deepEqual(writesOnly.mcpConnections, []);
    assert.equal(writesOnly.connectionAccountIds?.includes(MCP_ACCOUNT), false);

    // Meta Ads: a reviewed write declared a read stays out.
    const meta = compileTestRunPlan(withPolicy({
      url: 'https://mcp.facebook.com/ads', presetId: 'meta-ads',
      allowedTools: ['ads_get_ad_accounts', 'ads_update_entity'],
      toolPolicies: { ads_get_ad_accounts: { effect: 'read' }, ads_update_entity: { effect: 'read' } },
    }), testConversation(lane));
    assert.deepEqual(toolsOf(meta), ['ads_get_ad_accounts']);
  });
});

test('a catalog MCP tool is a read only when marked one: never one its server added later, nor one its server says writes', async () => {
  await withTestRunLane(async (lane) => {
    const parts = await lane.parts();
    const catalog = (policy: object) => compileTestRunPlan({
      ...parts,
      connections: parts.connections.map((connection) => connection.policy.kind === 'mcp'
        ? { ...connection, policy: { ...connection.policy, presetId: 'linear', ...policy } } as typeof connection
        : connection),
    }, testConversation(lane));
    const toolsOf = (plan: RuntimePlanV2) => plan.mcpConnections.flatMap(({ allowedTools }) => allowedTools);
    const names = Object.values(MCP_TOOLS);

    assert.deepEqual(toolsOf(catalog({})), [MCP_TOOLS.read], 'a catalog service\'s mark counts as a custom one\'s');
    const added = 'list_customers';
    assert.deepEqual(toolsOf(catalog({
      allowedTools: [...names, added],
      discoveredTools: [...names.map((name) => ({ name })), { name: added, readOnlyHint: true }],
    })), [MCP_TOOLS.read], 'a tool the server added later, read-only by its own word, has no mark');
    const flipped = catalog({ discoveredTools: names.map((name) => ({ name, ...(name === MCP_TOOLS.read ? { readOnlyHint: false } : {}) })) });
    assert.deepEqual(flipped.mcpConnections, [], 'its one read mark is outranked by the server, so the connection drops out');
    assert.equal(flipped.connectionAccountIds?.includes(MCP_ACCOUNT), false);
  });
});

test('a connector with no read capability drops out of a test run', async () => {
  await withTestRunLane(async (lane) => {
    const parts = await lane.parts();
    const plan = compileTestRunPlan({
      ...parts,
      connections: parts.connections.map((connection) => connection.policy.kind === 'managed'
        ? { ...connection, policy: { ...connection.policy, allowedCapabilities: [MANAGED_WRITE] } }
        : connection),
    }, testConversation(lane));
    assert.equal(plan.managedConnections, undefined);
    assert.equal(plan.connectionAccountIds?.includes(MANAGED_ACCOUNT), false);
  });
});

test('V5 parsing refuses a test run plan that could write, post or reach Slack', async () => {
  await withTestRunLane(async (lane) => {
    const plan = compileTestRunPlan(await lane.parts(), testConversation(lane));
    const refused: Array<[string, (plan: Record<string, unknown>) => void, RegExp]> = [
      ['a Slack channel', (p) => { p.conversation = { ...plan.conversation, channelId: 'D0TESTRUN' }; p.artifactDestination = { kind: 'slack_conversation', channelId: 'D0TESTRUN' }; }, /a Slack conversation/],
      ['a guest thread', (p) => { p.conversation = { ...plan.conversation, guest: true }; }, /a Slack conversation/],
      ['a file thread', (p) => { p.artifactDestination = { ...plan.artifactDestination, threadTs: '1793440000.000100' }; }, /a file destination thread/],
      ['an unknown caller', (p) => { delete p.actorMembershipId; }, /an unknown caller/],
      ['a front desk', (p) => { p.frontDesk = { agents: [{ id: 'agent_x', name: 'X' }] }; }, /a front desk/],
      ['handoff context', (p) => { p.handoffContext = [{ messageTs: '1793430000.000100', role: 'human', text: 'Hi.' }]; }, /handoff context/],
      ['a coding workspace', (p) => { p.codingWorkspace = { available: true }; }, /a coding workspace/],
      ['a browser', (p) => { p.browserCapability = { provider: 'browserbase' }; }, /a browser/],
      ['website logins', (p) => {
        p.browserCapability = { provider: 'browserbase' };
        p.websiteLogins = [{ id: `wl_${'a'.repeat(32)}`, host: 'a.example', label: 'A', level: 'act', method: 'handoff' }];
      }, /a browser/],
      ['an image model', (p) => { p.imageCapability = { role: 'image', filled: true, acceptsImageInput: false }; }, /an image model/],
      ['a repository', (p) => { p.repositories = [{ id: 'repo_x', fullName: 'acme/x' }]; }, /repositories/],
      ['a connection selection', (p) => { p.connectionSelections = [{ group: 'g', providerId: 'p', accountId: 'a' }]; }, /connection selections/],
      ['a connection authorization', (p) => {
        p.connectionAuthorizations = [{ providerId: 'sentry', templateAccountId: 't', accounts: [] }];
      }, /connection authorizations/],
      ['a connection choice', (p) => { p.connectionChoices = [{ providerId: 'sentry', choices: [] }]; }, /connection choices/],
      ['an MCP write tool', (p) => {
        p.mcpConnections = plan.mcpConnections.map((connection) => ({
          ...connection, allowedTools: [MCP_TOOLS.read, MCP_TOOLS.write], writeTools: [MCP_TOOLS.write],
        }));
      }, /an MCP tool not listed as a read/],
      ['an unlisted MCP tool', (p) => {
        p.mcpConnections = plan.mcpConnections.map((connection) => ({
          ...connection, allowedTools: [MCP_TOOLS.read, MCP_TOOLS.undeclared],
        }));
      }, /an MCP tool not listed as a read/],
      ['a writing capability', (p) => {
        p.managedConnections = plan.managedConnections!.map((connection) => ({
          ...connection, allowedCapabilities: [MANAGED_READ, MANAGED_WRITE],
        }));
      }, /a connector capability that writes/],
      ['an unknown capability', (p) => {
        p.managedConnections = plan.managedConnections!.map((connection) => ({
          ...connection, allowedCapabilities: ['gmail.messages.unknown'],
        }));
      }, /a connector capability that writes/],
      ['a Slack thread', (p) => { p.conversation = { ...plan.conversation, threadTs: '1793440000.000100' }; }, /conversation.threadTs is invalid/],
      ['a direct message surface', (p) => { p.conversation = { ...plan.conversation, surface: 'direct_message' }; }, /V5 is a test run/],
    ];
    for (const [name, change, expected] of refused) {
      const candidate = structuredClone(plan) as unknown as Record<string, unknown>;
      change(candidate);
      assert.throws(() => parseRuntimePlanV2(candidate), expected, name);
    }
  });
});

test('only V5 is a test run: a V4 plan cannot claim the test surface or thread', async () => {
  await withTestRunLane(async (lane) => {
    const slack = compileAgentRunPlan(await lane.parts(), { turn: lane.turn, instructions: 'Answer.', memoryEpoch: 1 });
    assert.equal(parseRuntimePlanV2(slack).schemaVersion, CONVERSATION_PLAN_SCHEMA_VERSION);
    assert.throws(() => parseRuntimePlanV2({ ...slack, conversation: { ...slack.conversation, surface: 'test' } }),
      /V5 is a test run, and only V5 is/);
    assert.throws(() => parseRuntimePlanV2({ ...slack, conversation: { ...slack.conversation, threadTs: 'test' } }),
      /conversation.threadTs is invalid/);
    assert.throws(() => parseRuntimePlanV2({ ...slack, schemaVersion: RUNTIME_PLAN_SCHEMA_VERSION }), /V5 is a test run/);
  });
});
