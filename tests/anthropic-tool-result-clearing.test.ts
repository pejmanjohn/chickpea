import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import {
  createAssistantMessageEventStream,
  normalizeContext,
  type AssistantMessage,
  type Context,
  type StreamOptions,
  type Tool,
} from '@earendil-works/pi-ai';
import type { FlueObservation } from '@flue/runtime';

import { PART_SEPARATOR, sharedSystemBlock } from '../src/agents/shared-prefix-layout.ts';
import { sharedPrefixRequests, type SharedPrefixId } from '../src/agents/shared-prefix.ts';
import {
  configureInstallationAdmission,
  resetInstallationAdmissionForTests,
} from '../src/config/installation-admission.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  configureModelAccessResolver,
  configureModelRequestRecorder,
  modelAccessRequest,
  resetModelAccessForTests,
  withModelAccess,
  type ModelAccessGrant,
} from '../src/config/model-access.ts';
import { registerBuiltinPiProvider } from '../src/config/pi-provider.ts';
import { registeredPiProvider } from '../src/config/pi-provider-registry.ts';
import { configurePlatformFunding, resetPlatformFundingForTests } from '../src/config/platform-funding.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import {
  CONTEXT_MANAGEMENT_BETA,
  DEFAULT_TOOL_RESULT_CLEARING,
  TOOL_RESULT_CLEARING_SETTING_VARIABLES,
  TOOL_RESULT_CLEARING_VARIABLE,
  clearedToolResults,
  toolResultClearing,
  withToolResultClearing,
} from '../src/config/tool-result-clearing.ts';
import type { ModelRequestPurpose } from '../src/usage/model-requests.ts';
import { ModelStepMarks } from '../src/observability/runtime-latency.ts';
import { EVERY_PROVIDER_FUNDED, NO_RUN_FEES } from './helpers/platform-funding.ts';

type Provider = 'anthropic' | 'openai';

const MODEL: Readonly<Record<Provider, string>> = { anthropic: 'claude-opus-5-5', openai: 'gpt-5.6-luna' };
const ON: PlatformEnv = { [TOOL_RESULT_CLEARING_VARIABLE]: 'on' };
const OFF: PlatformEnv = {};

function tool(name: string): Tool {
  return { name, description: `Synthetic ${name} tool.`, parameters: { type: 'object', properties: {}, required: [] } as unknown as Tool['parameters'] };
}

/** One synthetic tool loop: a lookup call and its result, with the skill tool mounted. */
function context(provider: Provider): Context {
  return {
    systemPrompt: 'Synthetic system prompt.',
    tools: [tool('lookup'), tool('activate_skill')],
    messages: [
      { role: 'user', content: 'Look up record 1.', timestamp: 1 },
      {
        role: 'assistant', api: provider === 'anthropic' ? 'anthropic-messages' : 'openai-responses', provider, model: MODEL[provider],
        content: [{ type: 'toolCall', id: 'toolu_1', name: 'lookup', arguments: { id: 1 } }],
        stopReason: 'toolUse', timestamp: 2,
        usage: {
          input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      {
        role: 'toolResult', toolCallId: 'toolu_1', toolName: 'lookup', isError: false, timestamp: 3,
        content: [{ type: 'text', text: 'Synthetic record 1: alpha beta gamma.' }],
      },
    ],
  };
}

function sse(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** A short Anthropic answer whose final `message_delta` carries `context_management`, or none. */
function anthropicAnswer(contextManagement?: Record<string, unknown>): string {
  return [
    sse({
      type: 'message_start',
      message: {
        id: 'msg_clearing', type: 'message', role: 'assistant', model: MODEL.anthropic, content: [],
        usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }),
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } }),
    sse({ type: 'content_block_stop', index: 0 }),
    sse({
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 },
      ...(contextManagement ? { context_management: contextManagement } : {}),
    }),
    sse({ type: 'message_stop' }),
  ].join('');
}

interface Sent {
  readonly url: string;
  readonly betas: string[];
  readonly body: Record<string, unknown>;
}

function observation(event: Record<string, unknown>): FlueObservation {
  return event as unknown as FlueObservation;
}

function grant(providerId: Provider, fundingSource: ModelAccessGrant['fundingSource'] = 'customer'): ModelAccessGrant {
  return {
    installationId: 'inst_clearing', providerId, runId: `run_${fundingSource}`, fundingSource,
    credentialRefId: fundingSource === 'platform' ? `platform:${providerId}` : `cred_${providerId}`, credentialVersion: 1,
  };
}

function proxied(t: TestContext) {
  resetModelAccessForTests();
  registerBuiltinPiProvider('anthropic');
  registerBuiltinPiProvider('openai');
  configureModelAccessResolver({ resolve: async () => ({ apiKey: 'sk-tool-result-clearing-test' }) });
  // As at runtime, where the recorder is always configured: each request settles and reports to its step.
  configureModelRequestRecorder(async () => undefined);
  t.after(resetModelAccessForTests);
}

function modelOf(provider: Provider) {
  const model = registeredPiProvider(provider)?.getModels().find((candidate) => candidate.id === MODEL[provider]);
  assert.ok(model, `${provider} lists ${MODEL[provider]}`);
  return model;
}

/**
 * One model step sent by pi-ai's own provider through Chickpea's proxy, with
 * its HTTP request captured as the SDK sent it, and the step's model_step record.
 */
async function sendStep(
  provider: Provider,
  env: PlatformEnv,
  { purpose = 'reply', answer = anthropicAnswer() }: { purpose?: ModelRequestPurpose; answer?: string } = {},
): Promise<{ sent: Sent; record: Record<string, unknown>; observed: string[] }> {
  const records: Record<string, unknown>[] = [];
  const observed: string[] = [];
  const steps = new ModelStepMarks(() => 0, { info: (record) => records.push(record) });
  let sent: Sent | undefined;
  const network: typeof fetch = async (input, init) => {
    const beta = new Headers(init?.headers).get('anthropic-beta');
    sent = {
      url: String(input),
      betas: beta ? beta.split(',').map((name) => name.trim()) : [],
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    return provider === 'anthropic'
      ? new Response(answer, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
      : new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'synthetic' } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
  };
  steps.observe(observation({ type: 'turn_request', turnId: 'step_1', purpose: 'agent', instanceId: 'agent_thread' }));
  await withModelAccess(grant(provider), env, purpose, () => steps.intercept({ type: 'model', turnId: 'step_1' }, async () => {
    const stream = registeredPiProvider(provider)!.streamSimple(
      modelOf(provider), normalizeContext(context(provider)), {
        fetch: network,
        maxRetries: 0,
        onProviderStreamEvent: (event) => {
          observed.push(String((event as { type?: unknown }).type));
        },
      },
    );
    await stream.result();
  }));
  steps.observe(observation({
    type: 'turn', turnId: 'step_1', purpose: 'agent', durationMs: 1_000, isError: false, response: { finishReason: 'stop' },
  }));
  assert.ok(sent, `pi-ai sent the ${provider} request`);
  const record = records.at(-1);
  assert.equal(record?.event, 'model_step');
  return { sent, record: record!, observed };
}

const EXPECTED_EDIT = {
  type: 'clear_tool_uses_20250919',
  trigger: { type: 'input_tokens', value: 250_000 },
  keep: { type: 'tool_uses', value: 8 },
  clear_at_least: { type: 'input_tokens', value: 60_000 },
  exclude_tools: ['activate_skill'],
};

// Defects caught: the edit sent with the variable off; a beta header that
// replaces pi-ai's own betas (interleaved thinking, fallbacks, thinking
// binding) instead of joining them; a hook that drops or rewrites anything
// else pi-ai built, `thinking.block_binding` included; settings other than
// the design's; an excluded tool the request does not define; the streamed
// `message_delta`'s applied edits not reaching model_step; and the caller's
// own stream observer replaced by the one that reads them.
test('an own-key Anthropic step carries the clearing edit and its beta only with the variable on, keeps pi-ai\'s betas and request, and logs what the provider cleared', async (t) => {
  proxied(t);
  const off = await sendStep('anthropic', OFF);
  assert.match(off.sent.url, /\/v1\/messages/);
  assert.equal('context_management' in off.sent.body, false);
  assert.equal(off.sent.betas.includes(CONTEXT_MANAGEMENT_BETA), false);
  assert.ok(off.sent.betas.length > 0, 'pi-ai sends betas of its own on this model');
  assert.equal('clearedToolUses' in off.record, false);
  assert.equal('clearedInputTokens' in off.record, false);

  const applied = { applied_edits: [{ type: 'clear_tool_uses_20250919', cleared_tool_uses: 43, cleared_input_tokens: 517_000 }] };
  const on = await sendStep('anthropic', ON, { answer: anthropicAnswer(applied) });
  assert.deepEqual(on.sent.betas, [...off.sent.betas, CONTEXT_MANAGEMENT_BETA], 'pi-ai\'s betas, in order, then the clearing beta');
  const { context_management: contextManagement, ...rest } = on.sent.body;
  assert.deepEqual(contextManagement, { edits: [EXPECTED_EDIT] });
  assert.deepEqual(rest, off.sent.body, 'nothing else in the request changed');
  assert.deepEqual(
    (on.sent.body.thinking as { block_binding?: unknown } | undefined)?.block_binding,
    { prefix_mismatch_behavior: 'drop_block' },
    'pi-ai still asks the provider to drop a mismatched thinking block',
  );
  assert.equal(on.record.clearedToolUses, 43);
  assert.equal(on.record.clearedInputTokens, 517_000);
  assert.deepEqual(on.observed, off.observed, 'the caller\'s own stream observer still sees every event');
  assert.ok(on.observed.includes('message_delta'));
  assert.equal('sharedPrefix' in on.record, false, 'an own-key request still looks for no shared prefix');

  const none = await sendStep('anthropic', ON, { answer: anthropicAnswer({ applied_edits: [] }) });
  assert.equal(none.record.clearedToolUses, 0, 'sent, and nothing cleared yet');
  assert.equal(none.record.clearedInputTokens, 0);
});

// Defects caught: the edit on another provider's request, on a compaction
// (one summary request with no tool history), and settings read from a
// companion variable ignored.
test('clearing reaches only an Agent step on the Anthropic API, and takes its companion settings', async (t) => {
  proxied(t);
  const openai = await sendStep('openai', ON);
  assert.equal('context_management' in openai.sent.body, false);
  assert.equal(JSON.stringify(openai.sent.body).includes('clear_tool_uses'), false);
  assert.equal(openai.sent.betas.includes(CONTEXT_MANAGEMENT_BETA), false);

  const compaction = await sendStep('anthropic', ON, { purpose: 'compaction' });
  assert.equal('context_management' in compaction.sent.body, false);
  assert.equal(compaction.sent.betas.includes(CONTEXT_MANAGEMENT_BETA), false);

  const lowered = await sendStep('anthropic', {
    ...ON,
    [TOOL_RESULT_CLEARING_SETTING_VARIABLES.triggerTokens]: '40000',
    [TOOL_RESULT_CLEARING_SETTING_VARIABLES.keepToolUses]: '2',
    [TOOL_RESULT_CLEARING_SETTING_VARIABLES.clearAtLeastTokens]: '10000',
  });
  assert.deepEqual(lowered.sent.body.context_management, {
    edits: [{
      ...EXPECTED_EDIT,
      trigger: { type: 'input_tokens', value: 40_000 },
      keep: { type: 'tool_uses', value: 2 },
      clear_at_least: { type: 'input_tokens', value: 10_000 },
    }],
  });
});

/** A shared shape's rendered request with a synthetic tenant block after the constant one, as a Slack turn sends it. */
function sharedPayload(): { id: SharedPrefixId; payload: Record<string, unknown> } {
  const [prewarm] = sharedPrefixRequests(MODEL.anthropic);
  assert.ok(prewarm);
  return {
    id: prewarm.id,
    payload: {
      ...prewarm.body,
      betas: [...prewarm.betas],
      max_tokens: 4_096,
      system: [{ type: 'text', text: `${sharedSystemBlock(prewarm.kind)}${PART_SEPARATOR}Synthetic tenant block.` }],
    },
  };
}

// Defects caught: the credits hook without the edit, the pin or the shared
// prefix's breakpoints lost, and the charge given another prefix than the
// request carried.
test('a credits-funded Anthropic step keeps its pin and shared prefix and carries the clearing edit', async (t) => {
  proxied(t);
  resetPlatformFundingForTests();
  resetInstallationAdmissionForTests();
  t.after(() => {
    resetPlatformFundingForTests();
    resetInstallationAdmissionForTests();
  });
  configureInstallationAdmission(async () => 'admitted');
  configureModelRequestRecorder(async () => undefined);
  const charged: Array<SharedPrefixId | null> = [];
  configurePlatformFunding({
    ...EVERY_PROVIDER_FUNDED,
    funding: async () => 'platform',
    admit: async () => 'admitted',
    charge: async (_record, sharedPrefix) => {
      charged.push(sharedPrefix);
    },
    ...NO_RUN_FEES,
  });
  const { id, payload } = sharedPayload();
  const sendPayload = async (env: PlatformEnv) => {
    const scoped = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation', ...env }, { installationId: 'inst_clearing' }) as PlatformEnv;
    let built: unknown;
    await withModelAccess(grant('anthropic', 'platform'), scoped, 'reply', async () => {
      const request = modelAccessRequest('anthropic', modelOf('anthropic'), {} as StreamOptions);
      const stream = request.send((sent) => {
        const source = createAssistantMessageEventStream();
        void (async () => {
          built = await request.options.onPayload?.(structuredClone(payload), sent);
          const message = emptyAnswer();
          source.push({ type: 'done', reason: 'stop', message });
          source.end(message);
        })();
        return source;
      });
      assert.equal((await stream.result()).stopReason, 'stop');
    });
    assert.ok(built && typeof built === 'object');
    return built as Record<string, unknown>;
  };
  const off = await sendPayload(OFF);
  const on = await sendPayload(ON);
  assert.deepEqual(charged, [id, id], 'both charges carried the shared prefix');
  assert.equal(on.service_tier, 'standard_only', 'the credits pin still ran');
  const { context_management: contextManagement, betas, ...rest } = on;
  const { betas: offBetas, ...offRest } = off;
  assert.deepEqual(rest, offRest, 'the shared prefix\'s breakpoints and every other field are as without clearing');
  assert.deepEqual(betas, [...(offBetas as string[]), CONTEXT_MANAGEMENT_BETA]);
  const [edit] = (contextManagement as { edits: Array<Record<string, unknown>> }).edits;
  assert.deepEqual(edit?.exclude_tools, ['activate_skill', 'read_skill_resource', 'inspect_memory', 'update_agent_memory']);
});

/** A finished step with no content: what the credits hook did is in the payload. */
function emptyAnswer(): AssistantMessage {
  return {
    role: 'assistant', content: [], api: 'anthropic-messages', provider: 'anthropic', model: MODEL.anthropic,
    stopReason: 'stop', timestamp: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

// Defects caught: a tool added later by value (pi-ai's `tool_addition`) left
// clearable; an excluded name the request never defines; a beta repeated;
// and an edit forced onto a payload that already manages its context or
// whose betas the hook cannot read.
test('the edit excludes the instruction tools a request defines, in its tool list or a later tool addition, and leaves other payloads as built', () => {
  const settings = DEFAULT_TOOL_RESULT_CLEARING;
  const added = withToolResultClearing({
    betas: [CONTEXT_MANAGEMENT_BETA, 'interleaved-thinking-2025-05-14'],
    tools: [{ name: 'lookup' }, { name: 'inspect_memory' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Synthetic.' }] },
      { role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_definition', definition: { name: 'read_skill_resource' } } }] },
    ],
  }, settings);
  assert.deepEqual(added.betas, [CONTEXT_MANAGEMENT_BETA, 'interleaved-thinking-2025-05-14']);
  const [edit] = (added.context_management as { edits: Array<Record<string, unknown>> }).edits;
  assert.deepEqual(edit?.exclude_tools, ['read_skill_resource', 'inspect_memory']);

  const plain = withToolResultClearing({ tools: [{ name: 'lookup' }], messages: [] }, settings);
  assert.deepEqual(plain.betas, [CONTEXT_MANAGEMENT_BETA]);
  const [plainEdit] = (plain.context_management as { edits: Array<Record<string, unknown>> }).edits;
  assert.equal('exclude_tools' in plainEdit!, false, 'no instruction tool is mounted');

  for (const payload of [
    { context_management: { edits: [] }, tools: [] },
    { betas: 'interleaved-thinking-2025-05-14', tools: [] },
    { betas: [1], tools: [] },
  ]) {
    assert.equal(withToolResultClearing(payload, settings), payload);
  }
});

// Defects caught: clearing on for a value other than `on`; a setting taken
// from a value that is not a whole number in range (so a typo could clear
// every result); and a valid companion setting ignored.
test('clearing is on only for `on`, and each setting takes its variable when it is a whole number in range', () => {
  assert.equal(toolResultClearing(undefined), undefined);
  for (const value of ['', 'off', 'true', '1', 'onn']) {
    assert.equal(toolResultClearing({ [TOOL_RESULT_CLEARING_VARIABLE]: value }), undefined, value);
  }
  assert.deepEqual(toolResultClearing({ [TOOL_RESULT_CLEARING_VARIABLE]: ' ON ' }), DEFAULT_TOOL_RESULT_CLEARING);
  const vars = TOOL_RESULT_CLEARING_SETTING_VARIABLES;
  for (const [name, value] of [
    [vars.triggerTokens, '0'], [vars.triggerTokens, '1000001'], [vars.triggerTokens, '25k'], [vars.triggerTokens, '-5'],
    [vars.keepToolUses, '0'], [vars.keepToolUses, '101'], [vars.keepToolUses, '2.5'],
    [vars.clearAtLeastTokens, '0'], [vars.clearAtLeastTokens, '1e5'],
  ] as const) {
    assert.deepEqual(toolResultClearing({ ...ON, [name]: value }), DEFAULT_TOOL_RESULT_CLEARING, `${name}=${value}`);
  }
  assert.deepEqual(
    toolResultClearing({ ...ON, [vars.triggerTokens]: '1000000', [vars.keepToolUses]: '1', [vars.clearAtLeastTokens]: '1' }),
    { triggerTokens: 1_000_000, keepToolUses: 1, clearAtLeastTokens: 1 },
  );
});

// Defects caught: a reading from an event that carries no clearing, another
// edit's counts added in (thinking clearing), a malformed count summed, and
// `message_start`'s report missed.
test('the provider\'s clearing is read from message_delta or message_start, counting only tool-use clearing', () => {
  assert.equal(clearedToolResults({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }), undefined);
  assert.equal(clearedToolResults({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }), undefined);
  assert.equal(clearedToolResults('message_delta'), undefined);
  assert.deepEqual(clearedToolResults({
    type: 'message_delta',
    context_management: {
      applied_edits: [
        { type: 'clear_tool_uses_20250919', cleared_tool_uses: 3, cleared_input_tokens: 15_075 },
        { type: 'clear_thinking_20251015', cleared_thinking_turns: 2, cleared_input_tokens: 9_000 },
        { type: 'clear_tool_uses_20250919', cleared_tool_uses: -1, cleared_input_tokens: 'many' },
      ],
    },
  }), { toolUses: 3, inputTokens: 15_075 });
  assert.deepEqual(clearedToolResults({
    type: 'message_start',
    message: { context_management: { applied_edits: [{ type: 'clear_tool_uses_20250919', cleared_tool_uses: 1, cleared_input_tokens: 5_019 }] } },
  }), { toolUses: 1, inputTokens: 5_019 });
});
