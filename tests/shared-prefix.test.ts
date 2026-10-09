import {
  USER_AGENT_ID,
  blockedNetworkCalls,
  renderSlackRequest,
  type RenderedRequest,
  type SlackRequestVariant,
} from './helpers/render-slack-request.ts';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import {
  RUNTIME_PLAN_INSTRUCTIONS,
  SHARED_PREFIX_LAST_TOOL,
  WARMED_SHARED_PREFIX_SHAPES,
  sharePromptPrefix,
  sharedPrefixMisses,
  sharedPrefixRequests,
  sharedSystemBlock,
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

const SNAPSHOT = new URL('../src/agents/shared-prefix-tools.json', import.meta.url);
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
type WarmedShape = typeof WARMED_SHARED_PREFIX_SHAPES[number];
const SHAPE_VARIANTS: Record<WarmedShape, Pick<SlackRequestVariant, 'progressiveStreamingOffered' | 'imageModel'>> = {
  interactive: { progressiveStreamingOffered: false },
  interactive_streaming: { progressiveStreamingOffered: true },
  interactive_image: { progressiveStreamingOffered: false, imageModel: IMAGE_MODEL },
  interactive_streaming_image: { progressiveStreamingOffered: true, imageModel: IMAGE_MODEL },
};
const INTERACTIVE_TOOLS = ['ask_user', 'offer_actions', 'request_form'];
const IMAGE_TOOLS = ['generate_image', 'recover_image'];
const SEGMENT_TOOLS = { interactive: INTERACTIVE_TOOLS, streaming: ['stream_answer'], image: IMAGE_TOOLS };
const SHAPE_TOOLS: Record<WarmedShape, string[]> = {
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
      for (const variant of [ALPHA_OTHER_CHANNEL, BRAVO, ALPHA_DM]) {
        const other = await render({ ...variant, agentKind, ...SHAPE_VARIANTS[shape] });
        assert.equal(throughB(other), throughB(alpha), `${variant.workspace} ${variant.channel} sends the same bytes through B`);
        assert.notEqual(other.system[1].text, alpha.system[1].text, 'the tenant block names the workspace and channel');
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
  for (const [progressiveStreamingOffered, imageModel, after] of [
    [false, undefined, []],
    [true, undefined, ['stream_answer']],
    [false, IMAGE_MODEL, IMAGE_TOOLS],
    [true, IMAGE_MODEL, ['stream_answer', ...IMAGE_TOOLS]],
  ] as const) {
    const group = await render({ ...ALPHA_GROUP_DM, progressiveStreamingOffered, ...(imageModel ? { imageModel } : {}) });
    const anchor = anchorIndex(group);
    assert.deepEqual(group.tools.slice(anchor + 1).map((tool: any) => tool.name), after);
    assert.deepEqual(markers(group), [`tools[${anchor}] ${SHARED_PREFIX_LAST_TOOL} 1h`, 'system[0] 1h', 'system[1] 5m', 'user 5m']);
  }
});

test('a tool between A and B that no shared shape sends keeps A and caches B for five minutes', async () => {
  const finalAnswer = await render({ ...ALPHA, progressiveStreamingMode: 'final_answer' });
  const anchor = anchorIndex(finalAnswer);
  assert.equal(finalAnswer.tools.at(-1).name, 'stream_answer', 'the effect-capable stream_answer follows the interactive tools');
  assert.deepEqual(markers(finalAnswer), [`tools[${anchor}] ${SHARED_PREFIX_LAST_TOOL} 1h`, 'system[0] 5m', 'system[1] 5m', 'user 5m']);

  const withConnector = structuredClone(await render({ ...ALPHA, funding: 'customer' }));
  withConnector.tools.push({
    name: 'mcp__conn_crm__search_accounts', description: 'Search accounts in the CRM.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  });
  const before = sharedPrefixMisses();
  const shared = sharePromptPrefix(withConnector) as RenderedRequest;
  assert.equal(sharedPrefixMisses(), before, 'a tenant tool is not a miss');
  assert.equal(shared.system[0].text, sharedSystemBlock('system'), 'the constant block still opens the system prompt');
  assert.deepEqual(markers(shared), [`tools[${anchor}] ${SHARED_PREFIX_LAST_TOOL} 1h`, 'system[0] 5m', 'system[1] 5m', 'user 5m']);
});

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
  assert.equal(sharePromptPrefix(mismatched), mismatched);
  assert.equal(sharedPrefixMisses(), before + 1);

  const changedTool = structuredClone(customer);
  changedTool.tools[12].description = `${changedTool.tools[12].description} Workspace ${ALPHA.workspace}.`;
  assert.equal(sharePromptPrefix(changedTool), changedTool, 'universal tools other than the rendered ones');
  assert.equal(sharedPrefixMisses(), before + 2);
  assert.notEqual(sharePromptPrefix(structuredClone(customer)), customer, 'the unchanged request shares');

  const intentCheck = { model: 'claude-opus-5-5', system: [{ type: 'text', text: 'Classify.' }], messages: [] };
  assert.equal(sharePromptPrefix(intentCheck), intentCheck);
  assert.equal(sharedPrefixMisses(), before + 2, 'a request that is not a Slack turn is not a miss');
});

test('the last user block keeps a 5-minute marker after the 1-hour ones', async () => {
  const longRetention = structuredClone(await render({ ...ALPHA, funding: 'customer' }));
  longRetention.messages.at(-1).content.at(-1).cache_control = ONE_HOUR;
  const shared = sharePromptPrefix(longRetention) as RenderedRequest;
  assert.deepEqual(markers(shared).at(-1), 'user 5m');
  assert.deepEqual(shared.messages.at(-1).content.at(-1).cache_control, FIVE_MINUTES);
});

const MOUNTED_GUIDANCE = [
  { text: SLACK_LISTS_INSTRUCTION, tool: 'read_slack_list' },
  { text: SLACK_READING_INSTRUCTION, tool: 'read_slack_thread' },
  { text: SLACK_MANAGEMENT_GUIDANCE, tool: 'inspect_workspace' },
];

for (const [name, variant, unmounted] of [
  ['a requester with no membership', { ...ALPHA, member: false }, ['read_slack_list', 'read_slack_thread']],
  ['a file-delivery check', { ...ALPHA, delivery: 'file_delivery_check' }, ['read_slack_list', 'read_slack_thread', 'inspect_workspace']],
] as const) {
  test(`${name} gets guidance only for the tools it mounts, and goes out unchanged without counting a miss`, async () => {
    const before = sharedPrefixMisses();
    const request = await renderSlackRequest(variant);
    assert.equal(sharedPrefixMisses(), before, 'an expected non-shared turn is not a miss');
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

test('sharedPrefixRequests sends the bytes rendered turns send, and its tools match a fresh render', async () => {
  const update = process.env.UPDATE_SHARED_PREFIX === '1';
  const snapshot: { tools: unknown[]; segments: Record<string, unknown[]>; models: Record<string, unknown> } = {
    tools: [], segments: {}, models: {},
  };
  for (const model of SNAPSHOT_MODELS) {
    const prewarms = update ? [] : sharedPrefixRequests(model);
    if (!update) {
      assert.deepEqual(prewarms.map(({ kind, shape }) => `${kind} ${shape}`), [
        'system interactive', 'system interactive_streaming', 'system interactive_image', 'system interactive_streaming_image',
        'user interactive', 'user interactive_streaming', 'user interactive_image', 'user interactive_streaming_image',
      ]);
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
        const { request } = prewarms.find((prewarm) => prewarm.kind === agentKind && prewarm.shape === shape)!;
        assert.equal(JSON.stringify(request.tools), JSON.stringify(real.tools), `${model} ${agentKind} ${shape}: tools`);
        assert.deepEqual(request.system, [real.system[0]], `${model} ${agentKind} ${shape}: shared system block`);
        for (const [key, value] of Object.entries(settings)) assert.deepEqual(request[key], value, `${model}: ${key}`);
        assert.equal(request.max_tokens, 0);
        assert.equal(request.stream, undefined);
      }
    }
  }
  const stored = JSON.stringify(snapshot, null, 1) + '\n';
  if (update) writeFileSync(SNAPSHOT, stored);
  assert.equal(readFileSync(SNAPSHOT, 'utf8'), stored,
    'src/agents/shared-prefix-tools.json is stale: run UPDATE_SHARED_PREFIX=1 node --import tsx --test tests/shared-prefix.test.ts');
  assert.throws(() => sharedPrefixRequests('claude-haiku-4-5'), /No shared prompt prefix is rendered/);
});
