import {
  USER_AGENT_ID,
  blockedNetworkCalls,
  chargedRequestId,
  chargedSharedPrefix,
  renderSlackRequest,
  renderToolPayloads,
  type RenderedRequest,
  type SlackRequestVariant,
} from './helpers/render-slack-request.ts';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import {
  RUNTIME_PLAN_INSTRUCTIONS,
  SHARED_PREFIX_LAST_TOOL,
  SHARED_PREFIX_SHAPES,
  WARMED_SHARED_PREFIX_SHAPES,
  sharePromptPrefix,
  sharedPrefixMisses,
  sharedPrefixRequests,
  sharedSystemBlock,
  type WarmedSharedPrefixShape,
} from '../src/agents/shared-prefix.ts';
import { SLACK_INTERACTION_DEFAULTS, SLACK_RUNTIME_GUARDRAIL } from '../src/config/effective-config.ts';
import type { AgentKind } from '../src/config/types.ts';
import { EXTERNAL_ACTION_AUTHORITY_PREAMBLE } from '../src/connections/runtime.ts';
import { AGENT_AUTHORING_ROUTER_INSTRUCTION } from '../src/management/agent-authoring/index.ts';
import { SLACK_MANAGEMENT_GUIDANCE } from '../src/management/slack-tools.ts';
import { FILE_COMPLETION_INSTRUCTION } from '../src/slack/file-delivery-completion.ts';
import { SLACK_LISTS_INSTRUCTION } from '../src/slack/lists/tools.ts';
import { SLACK_ACTION_LINK_INSTRUCTION } from '../src/slack/message-format.ts';
import { SLACK_READING_INSTRUCTION } from '../src/slack/reading/tools.ts';
import { SLACK_PRESENT_TABLE_INSTRUCTION } from '../src/slack/table-presentation.ts';
import { createRuntimePlanCodingTools } from '../src/agents/coding-worker-task.ts';
import { compileRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { EMPTY_WORKSPACE_ROSTER, createWorkspaceRoster } from '../src/sandbox/workspace-limits.ts';
import { WORKSPACE_TOOL_NAMES } from '../src/sandbox/workspace-tools.ts';

const SNAPSHOT = new URL('../src/agents/shared-prefix-tools.json', import.meta.url);
const REQUEST_ID = 'req_shared_prefix_test';
const SNAPSHOT_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5'] as const;
const ONE_HOUR = { type: 'ephemeral', ttl: '1h' };
const FIVE_MINUTES = { type: 'ephemeral', ttl: '5m' };

const ALPHA: SlackRequestVariant = {
  workspace: 'T0ALPHA0001', channel: 'C0GENERAL01', thread: '1787000000.000100', user: 'U0ALICE0001',
  text: 'What can you help me with?',
};
const ALPHA_OTHER_CHANNEL = { ...ALPHA, channel: 'C0SALES0001', thread: '1787000900.000100' };
const BRAVO = { ...ALPHA, workspace: 'T0BRAVO0001', channel: 'C0GENERAL02', user: 'U0CAROL0001' };
const ALPHA_DM: SlackRequestVariant = { ...ALPHA, conversationKind: 'im', channel: 'D0ALICE0001', thread: '1787001800.000100' };
const ALPHA_GROUP_DM: SlackRequestVariant = { ...ALPHA, conversationKind: 'mpim', channel: 'G0GROUP0001' };
const TENANT_IDS = [
  ALPHA.workspace, BRAVO.workspace, ALPHA.channel, ALPHA_OTHER_CHANNEL.channel, BRAVO.channel, ALPHA_DM.channel, USER_AGENT_ID,
];

const IMAGE_MODEL = 'openai/gpt-image-2.5-flare';
const SHAPE_VARIANTS: Record<WarmedSharedPrefixShape, Pick<SlackRequestVariant, 'progressiveStreamingOffered' | 'imageModel'>> = {
  interactive: { progressiveStreamingOffered: false },
  interactive_streaming: { progressiveStreamingOffered: true },
  interactive_image: { progressiveStreamingOffered: false, imageModel: IMAGE_MODEL },
  interactive_streaming_image: { progressiveStreamingOffered: true, imageModel: IMAGE_MODEL },
};
const INTERACTIVE_TOOLS = ['ask_user', 'offer_actions', 'request_form'];
const IMAGE_TOOLS = ['generate_image', 'recover_image'];
const SEGMENT_TOOLS = { interactive: INTERACTIVE_TOOLS, streaming: ['stream_answer'], image: IMAGE_TOOLS };
const SHAPE_TOOLS: Record<WarmedSharedPrefixShape, string[]> = {
  interactive: INTERACTIVE_TOOLS,
  interactive_streaming: [...INTERACTIVE_TOOLS, 'stream_answer'],
  interactive_image: [...INTERACTIVE_TOOLS, ...IMAGE_TOOLS],
  interactive_streaming_image: [...INTERACTIVE_TOOLS, 'stream_answer', ...IMAGE_TOOLS],
};

const UNCONDITIONAL_INSTRUCTIONS = [
  SLACK_INTERACTION_DEFAULTS,
  SLACK_RUNTIME_GUARDRAIL,
  EXTERNAL_ACTION_AUTHORITY_PREAMBLE,
  ...Object.values(RUNTIME_PLAN_INSTRUCTIONS),
  SLACK_ACTION_LINK_INSTRUCTION,
  FILE_COMPLETION_INSTRUCTION,
  AGENT_AUTHORING_ROUTER_INSTRUCTION,
  SLACK_MANAGEMENT_GUIDANCE,
  SLACK_LISTS_INSTRUCTION,
  SLACK_READING_INSTRUCTION,
  SLACK_PRESENT_TABLE_INSTRUCTION,
];

function anchorIndex(request: RenderedRequest): number {
  const index = request.tools.findIndex((tool: any) => tool.name === SHARED_PREFIX_LAST_TOOL);
  assert.ok(index > 0, `${SHARED_PREFIX_LAST_TOOL} is mounted`);
  return index;
}

function throughB(request: RenderedRequest): string {
  return JSON.stringify({ tools: request.tools, system: request.system[0] });
}

function markers(request: RenderedRequest): string[] {
  return [
    ...request.tools.flatMap((tool: any, index: number) => tool.cache_control ? [`tools[${index}] ${tool.name} ${tool.cache_control.ttl ?? '5m'}`] : []),
    ...request.system.flatMap((block: any, index: number) => block.cache_control ? [`system[${index}] ${block.cache_control.ttl ?? '5m'}`] : []),
    ...request.messages.flatMap((message: any) => Array.isArray(message.content)
      ? message.content.flatMap((block: any) => block.cache_control ? [`${message.role} ${block.cache_control.ttl ?? '5m'}`] : [])
      : []),
  ];
}

function withoutMarkers(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, field) => key === 'cache_control' ? undefined : field));
}

const renders = new Map<string, Promise<RenderedRequest>>();
function render(variant: SlackRequestVariant): Promise<RenderedRequest> {
  const key = JSON.stringify(variant);
  let request = renders.get(key);
  if (!request) {
    request = renderSlackRequest(variant);
    renders.set(key, request);
  }
  return request;
}

for (const agentKind of ['system', 'user'] as const) {
  test(`${agentKind} Agent: unconditional instructions sit in the shared block, never after it`, async () => {
    const [constant, tenant] = (await render({ ...ALPHA, agentKind })).system.map((block: any) => block.text);
    for (const instruction of UNCONDITIONAL_INSTRUCTIONS) {
      assert.ok(constant.includes(instruction), `shared block carries: ${instruction.slice(0, 60)}`);
      assert.ok(!tenant.includes(instruction), `tenant block repeats: ${instruction.slice(0, 60)}`);
    }
    assert.ok(tenant.startsWith(agentKind === 'user' ? 'You write one-page briefs' : 'You are Chickpea, the built-in'),
      'the tenant block opens with the Agent\'s own instructions');
  });
}

for (const agentKind of ['system', 'user'] as const) {
  for (const shape of WARMED_SHARED_PREFIX_SHAPES) {
    test(`${agentKind} Agent, ${shape}: channels, workspaces and DMs send the same bytes through B, cached for an hour`, async () => {
      const alpha = await render({ ...ALPHA, agentKind, ...SHAPE_VARIANTS[shape] });
      const anchor = anchorIndex(alpha);
      assert.deepEqual(alpha.tools.slice(anchor + 1).map((tool: any) => tool.name), SHAPE_TOOLS[shape]);
      assert.deepEqual(markers(alpha), [`tools[${anchor}] ${SHARED_PREFIX_LAST_TOOL} 1h`, 'system[0] 1h', 'system[1] 5m', 'user 5m']);
      assert.equal(alpha.system[0].text, sharedSystemBlock(agentKind));
      assert.equal(chargedSharedPrefix(alpha), `${agentKind}/${shape}`, 'the charge names the prefix the request carried');
      for (const variant of [ALPHA_OTHER_CHANNEL, BRAVO, ALPHA_DM]) {
        const other = await render({ ...variant, agentKind, ...SHAPE_VARIANTS[shape] });
        assert.equal(throughB(other), throughB(alpha), `${variant.workspace} ${variant.channel} sends the same bytes through B`);
        assert.notEqual(other.system[1].text, alpha.system[1].text, 'the tenant block names the workspace and channel');
        assert.equal(chargedSharedPrefix(other), chargedSharedPrefix(alpha));
      }
      const prefix = throughB(alpha);
      for (const id of TENANT_IDS) assert.ok(!prefix.includes(id), `${id} is not before breakpoint B`);
      assert.doesNotMatch(prefix, /Date: |You are assigned to Slack workspace|Your Agent ID is/);
      assert.equal(alpha.service_tier, 'standard_only');
      assert.deepEqual(blockedNetworkCalls(), []);
    });
  }
}

test('workspaces on either API-key image model send the same bytes through B', async () => {
  const flare = await render({ ...ALPHA, imageModel: IMAGE_MODEL });
  const sunburst = await render({ ...BRAVO, imageModel: 'openai/gpt-image-2.5-sunburst' });
  assert.equal(throughB(sunburst), throughB(flare));
});

test('a group DM, which mounts no interactive tools, also caches B for an hour', async () => {
  for (const [progressiveStreamingOffered, imageModel, after, prefix] of [
    [false, undefined, [], 'system/bare'],
    [true, undefined, ['stream_answer'], 'system/streaming'],
    [false, IMAGE_MODEL, IMAGE_TOOLS, 'system/image'],
    [true, IMAGE_MODEL, ['stream_answer', ...IMAGE_TOOLS], 'system/streaming_image'],
  ] as const) {
    const group = await render({ ...ALPHA_GROUP_DM, progressiveStreamingOffered, ...(imageModel ? { imageModel } : {}) });
    const anchor = anchorIndex(group);
    assert.deepEqual(group.tools.slice(anchor + 1).map((tool: any) => tool.name), after);
    assert.deepEqual(markers(group), [`tools[${anchor}] ${SHARED_PREFIX_LAST_TOOL} 1h`, 'system[0] 1h', 'system[1] 5m', 'user 5m']);
    assert.equal(chargedSharedPrefix(group), prefix);
  }
});

test('a tool between A and B that no shared shape sends keeps A and caches B for five minutes', async () => {
  const finalAnswer = await render({ ...ALPHA, progressiveStreamingMode: 'final_answer' });
  const anchor = anchorIndex(finalAnswer);
  assert.equal(finalAnswer.tools.at(-1).name, 'stream_answer', 'the effect-capable stream_answer follows the interactive tools');
  assert.deepEqual(markers(finalAnswer), [`tools[${anchor}] ${SHARED_PREFIX_LAST_TOOL} 1h`, 'system[0] 5m', 'system[1] 5m', 'user 5m']);
  assert.equal(chargedSharedPrefix(finalAnswer), null, 'the charge names no shared prefix');

  const withConnector = structuredClone(await render({ ...ALPHA, funding: 'customer' }));
  withConnector.tools.push({
    name: 'mcp__conn_crm__search_accounts', description: 'Search accounts in the CRM.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  });
  const before = sharedPrefixMisses();
  const decision = sharePromptPrefix(withConnector, REQUEST_ID);
  const shared = decision.payload as RenderedRequest;
  assert.equal(decision.sharedPrefix, null, 'the request carries no shared prefix');
  assert.equal(sharedPrefixMisses(), before, 'a tenant tool is not a miss');
  assert.equal(shared.system[0].text, sharedSystemBlock('system'), 'the constant block still opens the system prompt');
  assert.deepEqual(markers(shared), [`tools[${anchor}] ${SHARED_PREFIX_LAST_TOOL} 1h`, 'system[0] 5m', 'system[1] 5m', 'user 5m']);
});

const ZENDESK_POLICY = {
  kind: 'api', authMode: 'credential', allowedHosts: ['acme.zendesk.com'], pathPrefixes: ['/api/v2'],
  allowedMethods: ['GET', 'POST', 'PUT'], headerName: 'Authorization', headerValuePrefix: 'Basic ', presetId: 'zendesk',
};
function connected(account: Record<string, unknown>) {
  return {
    accounts: [{
      id: 'conn_1', workspaceId: ALPHA.workspace, revision: 1, createdByMembershipId: 'member', label: 'Service',
      secretRefId: 'secret_1', lifecycle: 'ready', createdAt: 0, updatedAt: 0, ownerKind: 'team', ...account,
    }],
    bindings: [{
      agentId: USER_AGENT_ID, connectionAccountId: 'conn_1', providerId: account.providerId,
      allowedCapabilities: [], enabled: true, createdAt: 0, updatedAt: 0,
    }],
  };
}
const CONNECTED_AGENTS: Record<string, Partial<SlackRequestVariant>> = {
  'a team API connection': { connections: connected({ providerId: 'zendesk', policy: ZENDESK_POLICY }) },
  'a personal API connection': {
    connections: connected({ providerId: 'zendesk', policy: ZENDESK_POLICY, ownerKind: 'member', ownerMembershipId: 'member' }),
  },
  'an MCP connection': {
    connections: connected({
      providerId: 'crm',
      policy: {
        kind: 'mcp', url: 'https://mcp.crm.example/mcp', transport: 'streamable-http', authMode: 'none', headerNames: [],
        discoveredTools: [{ name: 'search_accounts', description: 'Search accounts.', inputSchema: { type: 'object' } }],
        allowedTools: ['search_accounts'],
      },
    }),
  },
  // Node never mounts a coding workspace; tests/sandbox-workspace-tools.test.ts pins post_artifact with one.
  'a GitHub repository and no coding workspace': {
    agentOverrides: { repositories: [{ id: 'repo_1', installationId: 1, accountLogin: 'acme', fullName: 'acme/support', enabled: true }] },
  },
};

for (const [name, setup] of Object.entries(CONNECTED_AGENTS)) {
  test(`a user Agent with ${name} sends the same universal tools and keeps breakpoint A`, async () => {
    const plain = await render({ ...ALPHA_DM, agentKind: 'user' });
    const before = sharedPrefixMisses();
    const request = await render({ ...ALPHA_DM, agentKind: 'user', thread: '1787002700.000100', ...setup });
    assert.equal(sharedPrefixMisses(), before, 'the request is not a shared-prefix miss');
    const anchor = anchorIndex(request);
    assert.equal(anchor, anchorIndex(plain));
    assert.equal(JSON.stringify(withoutMarkers(request.tools.slice(0, anchor + 1))), JSON.stringify(withoutMarkers(plain.tools.slice(0, anchor + 1))));
    assert.equal(request.tools[anchor].cache_control?.ttl, '1h');
    assert.equal(request.system[0].text, sharedSystemBlock('user'));
  });
}

test('a new image in the thread leaves the tools and system prompt unchanged, so the cached history holds', async () => {
  const thread = { ...ALPHA, agentKind: 'user' as const, imageModel: IMAGE_MODEL, thread: '1787003600.000100' };
  const image = {
    conversationKey: `${ALPHA.workspace}:${ALPHA.channel}:${thread.thread}`, fileId: 'F0IMAGE0001', filename: 'logo.png',
    mimeType: 'image/png', origin: 'agent' as const, messageTs: '1787003600.000200',
  };
  const before = await render(thread);
  const after = await render({ ...thread, threadImages: [image] });
  assert.equal(JSON.stringify(withoutMarkers(after.tools)), JSON.stringify(withoutMarkers(before.tools)));
  assert.deepEqual(after.system.map((block: any) => block.text), before.system.map((block: any) => block.text));
});

interface CodingTenant {
  workspace: string;
  channel: string;
  agentId: string;
  agentName: string;
  repository: string;
  coordinatorId: string;
  conversationKey: string;
  openWorkspace?: string;
}

/** A coordinator plan with a repository and a coding workspace, which only the Cloudflare target compiles. */
function codingPlan(tenant: CodingTenant) {
  const agent = {
    id: tenant.agentId, kind: 'user', revision: 1, name: tenant.agentName, instructions: 'Code.', enabled: true,
    model: 'anthropic/claude-opus-5-5', skills: [], mcpServers: [], apiConnections: [],
    repositories: [{ id: 'repo_1', installationId: 7, accountLogin: tenant.repository.split('/')[0], fullName: tenant.repository, enabled: true }],
  };
  return compileRuntimePlanV2({
    turn: {
      workspaceId: tenant.workspace, channelId: tenant.channel, eventId: 'E_CODING', text: 'Fix the build.', userId: 'U0ALICE0001',
      actorMembershipId: 'member', messageTs: '1787004500.000200', threadTs: '1787004500.000100', source: 'app_mention', contextMode: 'thread',
    },
    assignment: {
      workspaceId: tenant.workspace, channelId: tenant.channel, agentId: agent.id, agent, runtimeContract: 'chickpea-v1', model: agent.model,
      modelAttribution: { source: 'pinned', providerId: 'anthropic' },
    },
    instructions: 'Code.', memoryEpoch: 1, codingWorkspace: true,
  } as never);
}

/** The coding-workspace tools one tenant's coordinator mounts, as its request carries them. */
async function renderCodingTools(tenant: CodingTenant): Promise<unknown[]> {
  const roster = createWorkspaceRoster(tenant.openWorkspace
    ? { schemaVersion: 1, workspaces: { [tenant.openWorkspace]: { generation: 2, open: true, lastUsedAt: 1_787_004_000_000 } } }
    : EMPTY_WORKSPACE_ROSTER, () => {});
  const definitions = createRuntimePlanCodingTools({
    plan: codingPlan(tenant), coordinatorId: tenant.coordinatorId, sandboxConversationKey: tenant.conversationKey,
    resolve: () => undefined, roster, taskRunning: () => false,
    onWorkerStarted() {}, onWorkerUsage() {}, onMilestone() {},
  });
  const names = new Set(definitions.map(({ name }) => name));
  const tools = (await renderToolPayloads(definitions)).filter((tool: any) => names.has(tool.name));
  assert.equal(tools.length, definitions.length, 'every coding tool renders');
  return withoutMarkers(tools) as unknown[];
}

const CODING_ALPHA: CodingTenant = {
  workspace: ALPHA.workspace, channel: ALPHA.channel, agentId: 'support', agentName: 'Support', repository: 'acme/support-portal',
  coordinatorId: 'coordinator_alpha', conversationKey: `${ALPHA.workspace}:${ALPHA.channel}:1787004500.000100`,
};
const CODING_BRAVO: CodingTenant = {
  workspace: BRAVO.workspace, channel: BRAVO.channel, agentId: USER_AGENT_ID, agentName: 'Brief Writer', repository: 'globex/billing-ledger',
  coordinatorId: 'coordinator_bravo', conversationKey: `${BRAVO.workspace}:${BRAVO.channel}:1787009000.000100`, openWorkspace: 'ledger-fix',
};

test('shapes compose the capability segments in mount order, and only interactive shapes without coding are warmed', () => {
  assert.equal(Object.keys(SHARED_PREFIX_SHAPES).length, 16);
  for (const [shape, segments] of Object.entries(SHARED_PREFIX_SHAPES)) {
    assert.equal(shape, segments.join('_') || 'bare');
  }
  assert.deepEqual([...WARMED_SHARED_PREFIX_SHAPES], ['interactive', 'interactive_streaming', 'interactive_image', 'interactive_streaming_image']);
});

test('the coding-workspace tools render the same in every workspace and name none of its tenants', async () => {
  const alpha = await renderCodingTools(CODING_ALPHA);
  const bravo = await renderCodingTools(CODING_BRAVO);
  assert.deepEqual(alpha.map((tool: any) => tool.name), [...WORKSPACE_TOOL_NAMES]);
  assert.equal(JSON.stringify(bravo), JSON.stringify(alpha));
  const rendered = JSON.stringify(alpha);
  for (const tenant of [CODING_ALPHA, CODING_BRAVO]) {
    for (const id of [tenant.workspace, tenant.channel, tenant.agentId, tenant.agentName, tenant.coordinatorId, tenant.conversationKey,
      ...tenant.repository.split('/'), 'repo_1', ...(tenant.openWorkspace ? [`"${tenant.openWorkspace}"`] : [])]) {
      assert.ok(!rendered.includes(id), `${id} is not in a coding-workspace tool`);
    }
  }
});

const REPOSITORY = { repositories: [{ id: 'repo_1', installationId: 7, accountLogin: 'acme', fullName: 'acme/support-portal', enabled: true }] };

for (const [name, variant, expected] of [
  ['a user Agent', { ...ALPHA, agentKind: 'user' }, 'user/interactive_streaming_coding'],
  ['a user Agent with an image model', { ...ALPHA, agentKind: 'user', imageModel: IMAGE_MODEL }, 'user/interactive_streaming_coding_image'],
  ['Chickpea', ALPHA, 'system/interactive_streaming_coding'],
] as const) {
  test(`${name} with a repository's coding workspace carries a shared prefix and caches B for an hour`, async () => {
    const before = sharedPrefixMisses();
    const request = await render({ ...variant, thread: '1787005400.000100', codingWorkspace: true, agentOverrides: REPOSITORY });
    assert.equal(sharedPrefixMisses(), before);
    const names = request.tools.map((tool: any) => tool.name);
    assert.ok(WORKSPACE_TOOL_NAMES.every((tool) => names.includes(tool)), 'the coordinator mounts its coding tools');
    assert.equal(chargedSharedPrefix(request), expected);
    assert.deepEqual(request.system[0].cache_control, ONE_HOUR, 'breakpoint B is cached for an hour');
  });
}

test('a customer-funded request goes out exactly as pi-ai builds it', async () => {
  const platform = await render(ALPHA);
  const customer = await render({ ...ALPHA, funding: 'customer' });
  assert.equal(customer.service_tier, undefined);
  assert.equal(customer.system.length, 1);
  assert.equal(customer.system[0].text, `${platform.system[0].text}\n\n${platform.system[1].text}`);
  assert.deepEqual(withoutMarkers(customer.tools), withoutMarkers(platform.tools));
  assert.deepEqual(markers(customer), [`tools[${customer.tools.length - 1}] stream_answer 5m`, 'system[0] 5m', 'user 5m']);
  assert.deepEqual(customer.tools.at(-1).cache_control, { type: 'ephemeral' });
});

test('a request whose system block does not match goes out unchanged and counts a miss', async () => {
  const customer = await render({ ...ALPHA, funding: 'customer' });
  const mismatched = structuredClone(customer);
  mismatched.system[0].text = `Changed. ${mismatched.system[0].text}`;
  const before = sharedPrefixMisses();
  assert.deepEqual(sharePromptPrefix(mismatched, REQUEST_ID), { payload: mismatched, sharedPrefix: null });
  assert.equal(sharedPrefixMisses(), before + 1);

  const changedTool = structuredClone(customer);
  changedTool.tools[12].description = `${changedTool.tools[12].description} Workspace ${ALPHA.workspace}.`;
  const warnings: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    assert.deepEqual(sharePromptPrefix(changedTool, REQUEST_ID), { payload: changedTool, sharedPrefix: null },
      'universal tools other than the rendered ones');
  } finally {
    console.warn = warn;
  }
  assert.equal(sharedPrefixMisses(), before + 2);
  assert.deepEqual(warnings.map(([, fields]) => fields), [
    { model: 'claude-opus-5-5', reason: 'universal_tools_differ', tool: changedTool.tools[12].name, requestId: REQUEST_ID },
  ], 'the warning names the first universal tool that differs and the request, and nothing from its text');
  assert.equal(sharePromptPrefix(structuredClone(customer), REQUEST_ID).sharedPrefix, 'system/interactive_streaming', 'the unchanged request shares');

  const intentCheck = { model: 'claude-opus-5-5', system: [{ type: 'text', text: 'Classify.' }], messages: [] };
  const { result: decision, logged } = await reducedTurnLogs(async () => sharePromptPrefix(intentCheck, REQUEST_ID));
  assert.deepEqual(decision, { payload: intentCheck, sharedPrefix: null });
  assert.equal(sharedPrefixMisses(), before + 2, 'a request that is not a Slack turn is not a miss');
  assert.deepEqual(logged, [], 'nor a reduced Slack turn');
});

test('the last user block keeps a 5-minute marker after the 1-hour ones', async () => {
  const longRetention = structuredClone(await render({ ...ALPHA, funding: 'customer' }));
  longRetention.messages.at(-1).content.at(-1).cache_control = ONE_HOUR;
  const shared = sharePromptPrefix(longRetention, REQUEST_ID).payload as RenderedRequest;
  assert.deepEqual(markers(shared).at(-1), 'user 5m');
  assert.deepEqual(shared.messages.at(-1).content.at(-1).cache_control, FIVE_MINUTES);
});

const MOUNTED_GUIDANCE = [
  { text: SLACK_LISTS_INSTRUCTION, tool: 'read_slack_list' },
  { text: SLACK_READING_INSTRUCTION, tool: 'read_slack_thread' },
  { text: SLACK_MANAGEMENT_GUIDANCE, tool: 'inspect_workspace' },
];

/** The reduced-turn lines `sharePromptPrefix` logs while `run` runs. */
async function reducedTurnLogs<T>(run: () => Promise<T>): Promise<{ result: T; logged: unknown[] }> {
  const logged: unknown[] = [];
  const info = console.info;
  console.info = (message: unknown, fields: unknown) => {
    if (String(message).includes('reduced tool list')) logged.push(fields);
  };
  try {
    return { result: await run(), logged };
  } finally {
    console.info = info;
  }
}

for (const [name, variant, unmounted, reason] of [
  ['a requester with no membership', { ...ALPHA, member: false }, ['read_slack_list', 'read_slack_thread'], 'requester_not_member'],
  ['a file-delivery check', { ...ALPHA, delivery: 'file_delivery_check' }, ['read_slack_list', 'read_slack_thread', 'inspect_workspace'], 'management_unmounted'],
] as const) {
  test(`${name} gets guidance only for the tools it mounts, and goes out unchanged without counting a miss`, async () => {
    const before = sharedPrefixMisses();
    const { result: request, logged } = await reducedTurnLogs(() => renderSlackRequest(variant));
    assert.equal(sharedPrefixMisses(), before, 'an expected non-shared turn is not a miss');
    assert.deepEqual(logged, [{ model: 'claude-opus-5-5', reason, requestId: chargedRequestId(request) }],
      'its cold write is attributable: the log names the request its charge carries');
    const toolNames = new Set(request.tools.map((tool: any) => tool.name));
    for (const tool of unmounted) assert.ok(!toolNames.has(tool), `${tool} is not mounted`);
    assert.equal(request.system.length, 1, 'the system block does not match a shared block, so it goes out as built');
    const text = request.system[0].text;
    for (const guidance of MOUNTED_GUIDANCE) {
      assert.equal(text.split(guidance.text).length - 1, toolNames.has(guidance.tool) ? 1 : 0,
        `${guidance.tool} guidance appears once exactly when the tool mounts`);
    }
  });
}

test('sharedPrefixRequests sends the bytes rendered turns send under the ID their charges report, and its tools match a fresh render', async () => {
  const update = process.env.UPDATE_SHARED_PREFIX === '1';
  const snapshot: { tools: unknown[]; segments: Record<string, unknown[]>; models: Record<string, unknown> } = {
    tools: [], segments: {}, models: {},
  };
  for (const model of SNAPSHOT_MODELS) {
    const prewarms = update ? [] : sharedPrefixRequests(model);
    if (!update) {
      assert.deepEqual(prewarms.map(({ id }) => id), [
        'system/interactive', 'system/interactive_streaming', 'system/interactive_image', 'system/interactive_streaming_image',
        'user/interactive', 'user/interactive_streaming', 'user/interactive_image', 'user/interactive_streaming_image',
      ]);
      for (const { id, kind, shape } of prewarms) assert.equal(id, `${kind}/${shape}`);
    }
    for (const agentKind of ['system', 'user'] as AgentKind[]) {
      for (const shape of WARMED_SHARED_PREFIX_SHAPES) {
        const real = await render({ ...ALPHA, model, agentKind, ...SHAPE_VARIANTS[shape] });
        const { model: _model, max_tokens: _max, stream: _stream, system: _system, tools, messages: _messages, ...settings } = real;
        assert.deepEqual(Object.keys(settings).sort(), ['output_config', 'service_tier', 'thinking']);
        const anchor = anchorIndex(real);
        snapshot.tools = withoutMarkers(tools.slice(0, anchor + 1)) as unknown[];
        const afterAnchor = withoutMarkers(tools.slice(anchor + 1)) as any[];
        for (const [segment, names] of Object.entries(SEGMENT_TOOLS)) {
          const segmentTools = afterAnchor.filter((tool) => names.includes(tool.name));
          if (segmentTools.length > 0) snapshot.segments[segment] = segmentTools;
        }
        snapshot.models[model] = settings;
        if (update) continue;
        const prewarm = prewarms.find(({ id }) => id === chargedSharedPrefix(real));
        assert.ok(prewarm, `${model} ${agentKind} ${shape}: the real request's charge names a pre-warmed prefix`);
        assert.deepEqual([prewarm.kind, prewarm.shape], [agentKind, shape]);
        const { request } = prewarm;
        assert.equal(JSON.stringify(request.tools), JSON.stringify(real.tools), `${model} ${agentKind} ${shape}: tools`);
        assert.deepEqual(request.system, [real.system[0]], `${model} ${agentKind} ${shape}: shared system block`);
        for (const [key, value] of Object.entries(settings)) assert.deepEqual(request[key], value, `${model}: ${key}`);
        assert.equal(request.max_tokens, 0);
        assert.equal(request.stream, undefined);
      }
    }
  }
  // A Node render never mounts a coding workspace; the segment comes from the tools a coordinator mounts.
  snapshot.segments.coding = await renderCodingTools(CODING_ALPHA);
  const stored = JSON.stringify(snapshot, null, 1) + '\n';
  if (update) writeFileSync(SNAPSHOT, stored);
  assert.equal(readFileSync(SNAPSHOT, 'utf8'), stored,
    'src/agents/shared-prefix-tools.json is stale: run UPDATE_SHARED_PREFIX=1 node --import tsx --test tests/shared-prefix.test.ts');
  assert.throws(() => sharedPrefixRequests('claude-haiku-4-5'), /No shared prompt prefix is rendered/);
});
