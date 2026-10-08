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
  sharePromptPrefix,
  sharedPrefixMisses,
  sharedPrefixRequest,
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
const TENANT_IDS = [ALPHA.workspace, BRAVO.workspace, ALPHA.channel, ALPHA_OTHER_CHANNEL.channel, BRAVO.channel, USER_AGENT_ID];

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

/** Everything before breakpoint B: the universal tools and the constant system block. */
function sharedPrefix(request: RenderedRequest): string {
  return JSON.stringify({ tools: request.tools.slice(0, anchorIndex(request) + 1), system: request.system[0] });
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
  test(`${agentKind} Agent: two workspaces and two channels send one shared prefix`, async () => {
    const alpha = await render({ ...ALPHA, agentKind });
    const otherChannel = await render({ ...ALPHA_OTHER_CHANNEL, agentKind });
    const bravo = await render({ ...BRAVO, agentKind });
    assert.equal(sharedPrefix(otherChannel), sharedPrefix(alpha), 'two channels share tools and system[0]');
    assert.equal(sharedPrefix(bravo), sharedPrefix(alpha), 'two workspaces share tools and system[0]');
    assert.equal(alpha.system[0].text, sharedSystemBlock(agentKind));
    assert.notEqual(alpha.system[1].text, bravo.system[1].text, 'the tenant block names the workspace');
    const prefix = sharedPrefix(alpha);
    for (const id of TENANT_IDS) assert.ok(!prefix.includes(id), `${id} is not before breakpoint B`);
    assert.doesNotMatch(prefix, /Date: |You are assigned to Slack workspace|Your Agent ID is/);
    assert.deepEqual(blockedNetworkCalls(), []);
  });

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

test('markers sit at A, B, C and D with the design TTLs', async () => {
  const streaming = await render(ALPHA);
  const anchor = anchorIndex(streaming);
  assert.ok(anchor < streaming.tools.length - 1, 'stream_answer is a capability tool after A');
  assert.deepEqual(streaming.tools[anchor].cache_control, ONE_HOUR);
  assert.deepEqual(streaming.system.map((block: any) => block.cache_control), [FIVE_MINUTES, FIVE_MINUTES]);
  assert.deepEqual(markers(streaming), [
    `tools[${anchor}] ${SHARED_PREFIX_LAST_TOOL} 1h`, 'system[0] 5m', 'system[1] 5m', 'user 5m',
  ]);

  const universalOnly = await render({ ...ALPHA, progressiveStreamingOffered: false });
  assert.equal(anchorIndex(universalOnly), universalOnly.tools.length - 1, 'no capability tool follows A');
  assert.deepEqual(markers(universalOnly), [
    `tools[${universalOnly.tools.length - 1}] ${SHARED_PREFIX_LAST_TOOL} 1h`, 'system[0] 1h', 'system[1] 5m', 'user 5m',
  ]);
  assert.equal(universalOnly.service_tier, 'standard_only');
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

  const intentCheck = { model: 'claude-opus-5-5', system: [{ type: 'text', text: 'Classify.' }], messages: [] };
  assert.equal(sharePromptPrefix(intentCheck), intentCheck);
  assert.equal(sharedPrefixMisses(), before + 1, 'a request that is not a Slack turn is not a miss');
});

test('sharedPrefixRequest sends the bytes a rendered request sends, and its tools match a fresh render', async () => {
  const update = process.env.UPDATE_SHARED_PREFIX === '1';
  const snapshot: { tools: unknown[]; models: Record<string, unknown> } = { tools: [], models: {} };
  for (const model of SNAPSHOT_MODELS) {
    for (const agentKind of ['system', 'user'] as AgentKind[]) {
      const real = await render({ ...ALPHA, model, agentKind, progressiveStreamingOffered: false });
      const { model: _model, max_tokens: _max, stream: _stream, system: _system, tools, messages: _messages, ...settings } = real;
      assert.deepEqual(Object.keys(settings).sort(), ['output_config', 'service_tier', 'thinking']);
      snapshot.tools = withoutMarkers(tools) as unknown[];
      snapshot.models[model] = settings;
      if (update) continue;
      const prewarm = sharedPrefixRequest(model, agentKind);
      assert.equal(JSON.stringify(prewarm.tools), JSON.stringify(real.tools), `${model} ${agentKind}: tools`);
      assert.deepEqual(prewarm.system, [real.system[0]], `${model} ${agentKind}: shared system block`);
      for (const [key, value] of Object.entries(settings)) assert.deepEqual(prewarm[key], value, `${model}: ${key}`);
      assert.equal(prewarm.max_tokens, 0);
      assert.equal(prewarm.stream, undefined);
    }
  }
  const stored = JSON.stringify(snapshot, null, 1) + '\n';
  if (update) writeFileSync(SNAPSHOT, stored);
  assert.equal(readFileSync(SNAPSHOT, 'utf8'), stored,
    'src/agents/shared-prefix-tools.json is stale: run UPDATE_SHARED_PREFIX=1 node --import tsx --test tests/shared-prefix.test.ts');
  assert.throws(() => sharedPrefixRequest('claude-haiku-4-5', 'system'), /No shared prompt prefix is rendered/);
});
