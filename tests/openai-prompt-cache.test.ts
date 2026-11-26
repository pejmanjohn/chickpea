import assert from 'node:assert/strict';
import test from 'node:test';

import type { Api, Model } from '@earendil-works/pi-ai';

import {
  applyPromptCachePlan,
  explicitBreakpointsOffered,
  planPromptCache,
  promptCacheKey,
  shareOpenAIPromptCache,
  type PromptCacheKey,
} from '../src/agents/openai-prompt-cache.ts';
import { sharedSystemBlock, slackSystemBase } from '../src/agents/shared-prefix-layout.ts';
import { BUNDLED_MODEL_CATALOG } from '../src/model-catalog/bundled.ts';
import { resolveActiveCatalogRoute } from '../src/model-catalog/catalog.ts';
import { getBuiltinModel } from '../src/model-catalog/pi-builtin-models.ts';

const TERRA = builtin('gpt-5.6-terra');
const GPT_5_5 = builtin('gpt-5.5');
const SCOPE = { installationId: 'inst_alpha' };
const REQUEST = { requestId: 'req_openai_cache_test', model: TERRA, scope: SCOPE, purpose: 'reply' } as const;
const MISSED_TURN = '[chickpea] OpenAI Slack turn went out without the shared prompt prefix';
const LOOKUP_TOOL = { type: 'function', name: 'lookup', parameters: { type: 'object' }, strict: false };
const SLACK_TOOLS = [LOOKUP_TOOL, { type: 'function', name: 'present_details', parameters: { type: 'object' }, strict: false }];

/** Flue's sections after Chickpea's instructions, as composeSystemPrompt joins them. */
const FLUE_TAIL = [
  '', '## Available Agents', '', 'None. No subagents are currently declared.', '', 'Date: Mon, Nov 2, 2026',
].join('\n');

function builtin(id: string): Model<Api> {
  const model = getBuiltinModel('openai', id) as Model<Api> | undefined;
  assert.ok(model, `pi-ai lists openai/${id}`);
  return model;
}

function slackText(kind: 'system' | 'user', tenant: string): string {
  return `${sharedSystemBlock(kind)}\n\n${tenant}${FLUE_TAIL}`;
}

/**
 * A Responses request as pi-ai's buildParams shapes it for a model that takes
 * `additional_tools`: every tool goes in an item at the head of the input,
 * and there is no top-level tool list.
 */
function responsesPayload(
  developer: unknown,
  overrides: Record<string, unknown> = {},
  tools: readonly unknown[] = [LOOKUP_TOOL],
): Record<string, unknown> {
  return {
    model: 'gpt-5.6-terra',
    input: [
      { type: 'additional_tools', role: 'developer', tools },
      { role: 'developer', content: developer },
      { role: 'user', content: [{ type: 'input_text', text: 'What can you help me with?' }] },
    ],
    stream: true,
    prompt_cache_key: 'aff_01JTHREADALPHA',
    prompt_cache_retention: undefined,
    prompt_cache_options: undefined,
    store: false,
    reasoning: { effort: 'none' },
    ...overrides,
  };
}

/** The same request as pi-ai shapes it with the tools in a top-level list, or with no tools. */
function topLevelToolsPayload(developer: unknown, tools: readonly unknown[] | undefined): Record<string, unknown> {
  const { input: [, ...input], ...payload } = responsesPayload(developer) as { input: unknown[] };
  return { ...payload, input, ...(tools ? { tools } : {}) };
}

async function shared(payload: Record<string, unknown>, scope = SCOPE): Promise<Record<string, any>> {
  const decision = await shareOpenAIPromptCache(payload, { ...REQUEST, scope });
  assert.equal(decision.sharedPrefix, null, 'the charge names no shared prefix');
  return decision.payload as Record<string, any>;
}

test('parts join to the developer text for every cut', async () => {
  const tenants = [
    'You write one-page briefs for the sales team.\nYou are assigned to Slack workspace T0ALPHA0001, channel C0GENERAL01.',
    'Réponds en français. 日本語でも答えます。 Emoji: 🧑🏽‍💻 and a lone combining mark é.',
    'Quote this exactly:\n\n## Available Agents\n\nand keep going.',
  ];
  for (const kind of ['system', 'user'] as const) {
    for (const tenant of tenants) {
      const text = slackText(kind, tenant);
      const content = (await shared(responsesPayload(text))).input[1].content as Array<Record<string, unknown>>;
      assert.equal(content.map((part) => part.text).join(''), text, `${kind}: the parts join to the original bytes`);
      assert.equal(content.length, 2);
      assert.ok(content.every((part) => part.type === 'input_text' && (part.text as string).length > 0));
      assert.equal(content[0]!.text, `${sharedSystemBlock(kind)}\n\n`, 'the separator ends part 1');
    }
  }

  const constantOnly = `${sharedSystemBlock('system')}\n\n`;
  const content = (await shared(responsesPayload(constantOnly))).input[1].content as Array<Record<string, unknown>>;
  assert.deepEqual(content, [{ type: 'input_text', text: constantOnly, prompt_cache_breakpoint: { mode: 'explicit' } }],
    'an empty tail adds no empty part');
});

test('a recognized turn gets one breakpoint after the constant block and the installation key', async () => {
  const text = slackText('user', 'You write one-page briefs for the sales team.');
  const payload = responsesPayload(text);

  assert.deepEqual(planPromptCache(payload, TERRA), {
    action: 'share', cuts: [{ offset: sharedSystemBlock('user').length + 2 }],
  });
  const sent = await shared(payload);
  assert.equal(sent.prompt_cache_key, await promptCacheKey(SCOPE));
  assert.equal(sent.input[0], (payload.input as unknown[])[0], 'the tools item ahead of the breakpoint is sent as built');
  assert.deepEqual(sent.input[1], {
    role: 'developer',
    content: [
      { type: 'input_text', text: `${sharedSystemBlock('user')}\n\n`, prompt_cache_breakpoint: { mode: 'explicit' } },
      { type: 'input_text', text: text.slice(sharedSystemBlock('user').length + 2) },
    ],
  });
  assert.equal(sent.prompt_cache_options, undefined, 'the implicit write stays on');
});

// Defect caught: the planner reads only one of pi-ai's two layouts, so a
// model with a top-level tool list, or a request with no tools, loses the
// shared prefix.
test('a request with a top-level tool list or no tools gets the same cut in its first input item', async () => {
  const text = slackText('system', 'Tenant.');
  for (const [name, tools] of [['a top-level tool list', [LOOKUP_TOOL]], ['no tools', undefined]] as const) {
    const payload = topLevelToolsPayload(text, tools);
    assert.deepEqual(planPromptCache(payload, TERRA), { action: 'share', cuts: [{ offset: sharedSystemBlock('system').length + 2 }] }, name);
    const sent = await shared(payload);
    assert.deepEqual(sent.input[0].content[0], {
      type: 'input_text', text: `${sharedSystemBlock('system')}\n\n`, prompt_cache_breakpoint: { mode: 'explicit' },
    }, name);
    assert.deepEqual(sent.tools, tools, `${name}: the tools are sent as built`);
  }
});

test('keys: one installation\'s threads match, installations differ, at most 64 characters, no raw ID', async () => {
  const general = responsesPayload(slackText('system', 'Channel C0GENERAL01.'), { prompt_cache_key: 'aff_01JTHREADONE' });
  const sales = responsesPayload(slackText('system', 'Channel C0SALES0001.'), { prompt_cache_key: 'aff_01JTHREADTWO' });
  const alpha = [(await shared(general)).prompt_cache_key, (await shared(sales)).prompt_cache_key];
  const bravo = (await shared(general, { installationId: 'inst_bravo' })).prompt_cache_key;

  assert.equal(alpha[0], alpha[1], 'every thread of one installation sends one key');
  assert.notEqual(bravo, alpha[0], 'two installations never share a key');
  for (const [key, installationId] of [[alpha[0], 'inst_alpha'], [bravo, 'inst_bravo']] as const) {
    assert.match(key, /^ckp1:[0-9a-f]{32}$/);
    assert.ok(key.length <= 64, 'OpenAI takes at most 64 characters');
    assert.ok(!key.includes(installationId), 'the installation ID does not leave the process');
  }
});

test('reduced blocks, routine text and side-call text are untouched', async () => {
  const reduced = (kind: 'system' | 'user', managementMounted: boolean) =>
    `${slackSystemBase({ kind, managementMounted, memberToolsMounted: false })}\n\nTenant.${FLUE_TAIL}`;
  const cases = [
    ['a requester with no membership', reduced('user', true), 'reduced_slack_turn'],
    ['a file-delivery check', reduced('system', false), 'reduced_slack_turn'],
    ['a routine', `Post the weekly summary.${FLUE_TAIL}`, 'not_shared_slack_turn'],
    ['a side call', 'Classify the message.', 'not_shared_slack_turn'],
    ['a drifted block', `Changed. ${slackText('system', 'Tenant.')}`, 'not_shared_slack_turn'],
  ] as const;
  for (const [name, text, reason] of cases) {
    const payload = responsesPayload(text);
    assert.deepEqual(planPromptCache(payload, TERRA), { action: 'leave', reason }, name);
    assert.equal((await shareOpenAIPromptCache(payload, REQUEST)).payload, payload, `${name} goes out as the same object`);
  }
});

test('a model without the flag or a foreign base URL is untouched without reading the payload', async () => {
  const unread = new Proxy({}, {
    get: () => assert.fail('the payload was read'),
    has: () => assert.fail('the payload was read'),
    ownKeys: () => assert.fail('the payload was read'),
    getOwnPropertyDescriptor: () => assert.fail('the payload was read'),
  });
  for (const [name, model] of [
    ['gpt-5.5, which lacks the flag', GPT_5_5],
    ['a proxy endpoint', { ...TERRA, baseUrl: 'https://llm-proxy.example.com/v1' }],
    ['plain HTTP', { ...TERRA, baseUrl: 'http://api.openai.com/v1' }],
    ['another API on the endpoint', { ...TERRA, api: 'openai-completions' }],
  ] as const) {
    assert.deepEqual(planPromptCache(unread, model as Model<Api>), { action: 'leave', reason: 'breakpoints_unsupported' }, name);
  }
  const payload = responsesPayload(slackText('system', 'Tenant.'));
  assert.equal((await shareOpenAIPromptCache(payload, { ...REQUEST, model: GPT_5_5 })).payload, payload,
    'gpt-5.5 keeps pi-ai\'s request, per-thread key included');
});

test('caller breakpoints, explicit mode, missing key, non-string developer content are untouched', async () => {
  const text = slackText('system', 'Tenant.');
  const withCallerBreakpoint = responsesPayload(text);
  (withCallerBreakpoint.input as any[])[2].content[0].prompt_cache_breakpoint = { mode: 'explicit' };
  const withOutputBreakpoint = responsesPayload(text);
  (withOutputBreakpoint.input as any[]).push({
    type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'ok', prompt_cache_breakpoint: { mode: 'explicit' } }],
  });
  const cases = [
    ['a caller breakpoint on a message', withCallerBreakpoint, 'caller_breakpoints'],
    ['a caller breakpoint on a tool output', withOutputBreakpoint, 'caller_breakpoints'],
    ['explicit mode', responsesPayload(text, { prompt_cache_options: { mode: 'explicit' } }), 'caching_off'],
    ['no key', responsesPayload(text, { prompt_cache_key: undefined }), 'caching_off'],
    ['parts already', responsesPayload([{ type: 'input_text', text }]), 'no_developer_text'],
    ['a system-role message', { ...responsesPayload(text), input: [{ role: 'system', content: text }] }, 'no_developer_text'],
    ['a user message first', { ...responsesPayload(text), input: [{ role: 'user', content: text }] }, 'no_developer_text'],
    ['a user message after the tools item', {
      ...responsesPayload(text), input: [(responsesPayload(text).input as unknown[])[0], { role: 'user', content: text }],
    }, 'no_developer_text'],
    ['a developer message after two tools items', {
      ...responsesPayload(text), input: [...(responsesPayload(text).input as unknown[]).slice(0, 1), ...(responsesPayload(text).input as unknown[])],
    }, 'no_developer_text'],
    ['no input', { ...responsesPayload(text), input: undefined }, 'no_developer_text'],
  ] as const;
  for (const [name, payload, reason] of cases) {
    assert.deepEqual(planPromptCache(payload, TERRA), { action: 'leave', reason }, name);
    assert.equal((await shareOpenAIPromptCache(payload, REQUEST)).payload, payload, name);
  }
});

test('only prompt_cache_key and the developer message\'s content differ', async () => {
  const payload = responsesPayload(slackText('user', 'Tenant.'));
  const before = structuredClone(payload);
  const plan = planPromptCache(payload, TERRA);
  assert.equal(plan.action, 'share');
  const key = 'ckp1:00000000000000000000000000000000' as PromptCacheKey;
  const sent = applyPromptCachePlan(payload, plan.cuts, key) as Record<string, any>;

  assert.deepEqual(payload, before, 'the given payload is not mutated');
  const { prompt_cache_key: sentKey, input: [tools, developer, ...rest], ...others } = sent;
  const { prompt_cache_key: _key, input: [originalTools, original, ...originalRest], ...originalOthers } = payload as Record<string, any>;
  assert.equal(sentKey, key);
  assert.deepEqual(others, originalOthers);
  assert.deepEqual(Object.keys(sent), Object.keys(payload), 'no field is added or reordered');
  assert.deepEqual({ ...developer, content: original.content }, original, 'only the developer content changes');
  assert.equal(tools, originalTools, 'the tools item is passed by reference');
  assert.equal(rest.length, originalRest.length);
  rest.forEach((item: unknown, index: number) => assert.equal(item, originalRest[index], 'later input is passed by reference'));
});

test('a throwing planner returns the payload and logs no prompt text', async (t) => {
  const secret = 'Tenant secret instructions that must never be logged.';
  const input = new Proxy([], {
    get: () => {
      throw new TypeError(secret);
    },
  });
  const payload = responsesPayload(slackText('system', secret), { input });
  const warn = t.mock.method(console, 'warn', () => undefined);

  const decision = await shareOpenAIPromptCache(payload, REQUEST);

  assert.equal(decision.payload, payload);
  assert.equal(decision.sharedPrefix, null);
  assert.deepEqual(warn.mock.calls.map((call) => call.arguments), [[
    '[chickpea] OpenAI prompt cache plan failed; the request goes out as built',
    { model: 'gpt-5.6-terra', requestId: REQUEST.requestId, error: 'TypeError' },
  ]]);
  assert.ok(!JSON.stringify(warn.mock.calls.map((call) => call.arguments)).includes('secret'));
});

test('an unrecognized reply-purpose Slack turn warns with model, reason and request ID only', async (t) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  const slack = (developer: unknown) => responsesPayload(developer, {}, SLACK_TOOLS);
  const drifted = `Changed. ${slackText('system', 'Tenant secret.')}`;
  const reduced = `${slackSystemBase({ kind: 'user', managementMounted: true, memberToolsMounted: false })}\n\nTenant secret.`;

  await shareOpenAIPromptCache(slack(drifted), REQUEST);
  const slackTools = (slack(drifted).input as unknown[])[0];
  await shareOpenAIPromptCache({ ...slack(drifted), input: [slackTools, { role: 'system', content: drifted }] }, REQUEST);
  for (const [name, payload, request] of [
    ['a turn that shares', slack(slackText('system', 'Tenant secret.')), REQUEST],
    ['a reduced turn', slack(reduced), REQUEST],
    ['a model without breakpoints', slack(drifted), { ...REQUEST, model: GPT_5_5 }],
    ['a compaction', slack(drifted), { ...REQUEST, purpose: 'compaction' }],
    ['a request without Slack tools', responsesPayload(drifted), REQUEST],
  ] as const) {
    await shareOpenAIPromptCache(payload, request);
    assert.equal(warn.mock.callCount(), 2, `${name} does not warn`);
  }

  assert.deepEqual(warn.mock.calls.map((call) => call.arguments), [
    [MISSED_TURN, { model: 'gpt-5.6-terra', reason: 'not_shared_slack_turn', requestId: REQUEST.requestId }],
    [MISSED_TURN, { model: 'gpt-5.6-terra', reason: 'no_developer_text', requestId: REQUEST.requestId }],
  ]);
  assert.ok(!JSON.stringify(warn.mock.calls.map((call) => call.arguments)).includes('secret'));
});

test('every bundled API-key OpenAI model takes explicit breakpoints, and a compiled profile carries pi-ai\'s own flags', () => {
  const ids = BUNDLED_MODEL_CATALOG.filter((entry) => entry.lanes.openai_api_key).map((entry) => entry.id);
  assert.ok(ids.includes('openai/gpt-5.6-terra'), 'the bundled catalog offers API-key OpenAI models');
  const piFlags = builtin('gpt-6.1-sol').compat;
  for (const id of ids) {
    const route = resolveActiveCatalogRoute(id, 'openai_api_key');
    assert.ok(route, `${id} has an API-key route`);
    assert.ok(explicitBreakpointsOffered(route.model as Model<Api>), `${id} carries pi-ai's explicit prompt cache flag`);
    if (route.source === 'catalog') {
      assert.deepEqual(route.model.compat, piFlags, `${id} requests the way pi-ai's own GPT-6 models do`);
    }
  }
});
