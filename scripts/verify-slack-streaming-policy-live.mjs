#!/usr/bin/env node
/**
 * Content-free policy evaluation for model-selected Slack answer delivery.
 * Fixture validation is offline. Provider trials require --live, never call
 * Slack, never print model output, and permit egress only to the selected host.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { resolveModel } from '@flue/runtime/internal';
import { getApiProvider } from '@earendil-works/pi-ai/compat';

import { resolveRuntimeModel } from '../src/config/runtime-model.ts';
import { resolveOpenAiAuthMethod, saveOpenAiAuthMethod } from '../src/config/openai-auth.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { activateModelCatalog } from '../src/model-catalog/catalog.ts';
import { parseModelCatalogBytes } from '../src/model-catalog/schema.ts';
import {
  SLACK_STREAM_ANSWER_ACKNOWLEDGEMENT,
  SLACK_STREAM_ANSWER_INSTRUCTION,
  SLACK_STREAM_ANSWER_TOOL_DESCRIPTION,
  SLACK_STREAM_ANSWER_TOOL_NAME,
} from '../src/slack/presentation-intent.ts';
import {
  evaluateSlackStreamingPolicy,
  parseSlackStreamingPolicyFixtureSet,
} from '../src/slack/streaming-policy-evaluation.ts';

const args = parseArgs(process.argv.slice(2));
if (args.has('--help')) {
  console.log('Offline fixture check: npm run verify:slack-streaming-policy');
  console.log(
    'Live evaluation: npm run verify:slack-streaming-policy:live -- --live ' +
      '--lane <subscription|openai-api-key|anthropic-api-key> --model <id> ' +
      '[--trials <1-10>] [--state-db <path>] [--catalog-file <path>]',
  );
  console.log('Live mode consumes quota, never calls Slack, and never prints model output.');
  process.exit(0);
}

const fixtureFile = new URL('../fixtures/slack-streaming-policy.json', import.meta.url);
const fixtureSet = parseSlackStreamingPolicyFixtureSet(
  JSON.parse(await readFile(fixtureFile, 'utf8')),
);
if (args.has('--validate-fixtures')) {
  console.log(JSON.stringify({
    ok: true,
    fixtureCount: fixtureSet.fixtures.length,
    expectations: countBy(fixtureSet.fixtures, (fixture) => fixture.expectation),
    categories: countBy(fixtureSet.fixtures, (fixture) => fixture.category),
  }));
  process.exit(0);
}

assert.equal(args.has('--live'), true, 'refusing model traffic without the explicit --live flag');
const lane = String(args.get('--lane') ?? '');
assert.ok(
  lane === 'subscription' || lane === 'openai-api-key' || lane === 'anthropic-api-key',
  '--lane must be subscription, openai-api-key, or anthropic-api-key',
);
const modelId = String(args.get('--model') ?? '');
assert.match(modelId, /^[a-z0-9][a-z0-9._-]{0,127}$/, '--model must be a safe model id');
const trialsPerFixture = Number(args.get('--trials') ?? 1);
assert.ok(
  Number.isSafeInteger(trialsPerFixture) && trialsPerFixture >= 1 && trialsPerFixture <= 10,
  '--trials must be an integer from 1 to 10',
);

const provider = lane === 'anthropic-api-key' ? 'anthropic' : 'openai';
const canonicalModel = `${provider}/${modelId}`;
const expectedHost = lane === 'subscription' ? 'chatgpt.com' : `api.${provider}.com`;
const catalogFile = args.get('--catalog-file');
const hostedCatalog = typeof catalogFile === 'string'
  ? await readHostedCatalog(catalogFile)
  : undefined;
const statePath = lane === 'subscription' ? String(args.get('--state-db') ?? '') : ':memory:';
if (lane === 'subscription') {
  assert.ok(statePath, '--state-db is required for a subscription evaluation');
} else {
  const keyName = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  assert.ok(process.env[keyName], `${keyName} is required`);
  if (provider === 'openai') {
    assert.equal(process.env.OPENAI_BASE_URL ?? '', '', 'OPENAI_BASE_URL must be unset');
  } else {
    assert.equal(process.env.ANTHROPIC_BASE_URL ?? '', '', 'ANTHROPIC_BASE_URL must be unset');
  }
}

const nativeFetch = globalThis.fetch;
const destinations = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  destinations.push(url.hostname);
  if (url.hostname !== expectedHost &&
      !(lane === 'subscription' && url.hostname === 'auth.openai.com')) {
    throw new Error(`Slack streaming policy evaluation blocked unexpected host ${url.hostname}.`);
  }
  return nativeFetch(input, init);
};

const settings = new SqliteSettingsStore(statePath);
const priorOpenAiMethod = provider === 'openai'
  ? await resolveOpenAiAuthMethod(settings)
  : undefined;
try {
  if (provider === 'openai') {
    await saveOpenAiAuthMethod(settings, lane === 'subscription' ? 'subscription' : 'api_key');
  }
  const route = await resolveRuntimeModel('slack_streaming_policy_evaluation', canonicalModel, {
    settings,
    ...(hostedCatalog
      ? {
          loadCatalog: async () => {
            const activation = activateModelCatalog(hostedCatalog);
            return {
              status: activation.status === 'restart_required' ? 'restart_required' : 'activated',
              revision: activation.snapshot.revision,
            };
          },
        }
      : {}),
  });
  const model = resolveModel(route.model);
  const api = getApiProvider(model.api);
  assert.ok(api, `API handler ${model.api} must be registered`);
  const options = {
    apiKey: lane === 'subscription'
      ? 'chickpea-boundary-managed'
      : process.env[provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'],
    maxTokens: 2_000,
  };
  const trials = [];
  let ordinal = 0;
  for (let repetition = 0; repetition < trialsPerFixture; repetition += 1) {
    for (const fixture of fixtureSet.fixtures) {
      const needsControl = fixture.expectation === 'clear_positive';
      let offered;
      let controlFirstVisibleMs;
      // Alternate pair order to reduce a simple warm-cache/order bias.
      if (needsControl && ordinal % 2 === 0) {
        controlFirstVisibleMs = await runControl(api, model, options, fixture.prompt);
        offered = await runOffered(api, model, options, fixture.prompt);
      } else {
        offered = await runOffered(api, model, options, fixture.prompt);
        if (needsControl) {
          controlFirstVisibleMs = await runControl(api, model, options, fixture.prompt);
        }
      }
      trials.push({
        fixtureId: fixture.id,
        expectation: fixture.expectation,
        category: fixture.category,
        ...offered,
        ...(controlFirstVisibleMs === undefined ? {} : { controlFirstVisibleMs }),
      });
      ordinal += 1;
    }
  }
  const report = evaluateSlackStreamingPolicy(trials);
  assert.ok(destinations.includes(expectedHost), `model traffic must reach ${expectedHost}`);
  assert.equal(
    destinations.every((host) =>
      host === expectedHost || (lane === 'subscription' && host === 'auth.openai.com')
    ),
    true,
  );
  console.log(JSON.stringify({
    ok: report.pass,
    lane,
    canonicalModel,
    runtimeModel: route.model,
    trialsPerFixture,
    report,
  }));
  if (!report.pass) process.exitCode = 1;
} finally {
  globalThis.fetch = nativeFetch;
  if (priorOpenAiMethod) await saveOpenAiAuthMethod(settings, priorOpenAiMethod);
  settings.close();
}

async function runOffered(api, model, options, prompt) {
  const startedAt = performance.now();
  const userMessage = { role: 'user', content: prompt, timestamp: Date.now() };
  const first = await consumeTurn(api, model, {
    systemPrompt: `You are Chickpea, a helpful Slack agent. ${SLACK_STREAM_ANSWER_INSTRUCTION}`,
    messages: [userMessage],
    tools: [{
      name: SLACK_STREAM_ANSWER_TOOL_NAME,
      description: SLACK_STREAM_ANSWER_TOOL_DESCRIPTION,
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    }],
  }, options);
  const declarations = first.message.content.filter((part) =>
    part.type === 'toolCall' && part.name === SLACK_STREAM_ANSWER_TOOL_NAME
  );
  const declared = declarations.length > 0;
  const declarationShapeValid = declarations.length === 1 &&
    Object.keys(declarations[0].arguments ?? {}).length === 0 &&
    first.message.content.filter((part) => part.type === 'toolCall').length === 1;
  if (!declared) {
    return {
      declared: false,
      declarationBeforeText: true,
      declarationShapeValid: true,
      contaminationDetected: containsDeliveryContamination(first.text),
      offeredFirstVisibleMs: first.completedAt - startedAt,
    };
  }
  const declaration = declarations[0];
  const continuation = await consumeTurn(api, model, {
    systemPrompt: `You are Chickpea, a helpful Slack agent. ${SLACK_STREAM_ANSWER_INSTRUCTION}`,
    messages: [
      userMessage,
      first.message,
      {
        role: 'toolResult',
        toolCallId: declaration.id,
        toolName: SLACK_STREAM_ANSWER_TOOL_NAME,
        content: [{ type: 'text', text: SLACK_STREAM_ANSWER_ACKNOWLEDGEMENT }],
        isError: false,
        timestamp: Date.now(),
      },
    ],
  }, options);
  return {
    declared: true,
    declarationBeforeText: first.text.length === 0,
    declarationShapeValid,
    contaminationDetected: containsDeliveryContamination(continuation.text),
    offeredFirstVisibleMs: (continuation.firstTextAt ?? continuation.completedAt) - startedAt,
    declarationMs: (first.declarationAt ?? first.completedAt) - startedAt,
  };
}

async function runControl(api, model, options, prompt) {
  const startedAt = performance.now();
  const turn = await consumeTurn(api, model, {
    systemPrompt: 'You are Chickpea, a helpful Slack agent. Answer the user directly.',
    messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
  }, options);
  // Terminal delivery is visible only after the full model turn completes.
  return turn.completedAt - startedAt;
}

async function consumeTurn(api, model, context, options) {
  const stream = api.stream(model, context, options);
  let firstTextAt;
  let declarationAt;
  let message;
  for await (const event of stream) {
    if (event.type === 'text_delta' && event.delta && firstTextAt === undefined) {
      firstTextAt = performance.now();
    }
    if (event.type === 'toolcall_end' &&
        event.toolCall.name === SLACK_STREAM_ANSWER_TOOL_NAME &&
        declarationAt === undefined) {
      declarationAt = performance.now();
    }
    if (event.type === 'done') message = event.message;
    if (event.type === 'error') {
      throw new Error(event.error.errorMessage ?? 'Model evaluation turn failed.');
    }
  }
  assert.ok(message, 'Model evaluation turn ended without a result');
  return {
    message,
    text: message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join(''),
    firstTextAt,
    declarationAt,
    completedAt: performance.now(),
  };
}

function containsDeliveryContamination(text) {
  return /stream_answer|delivery preference noted|(?:I am|I'm|Slack is) streaming (?:this|the) answer/i
    .test(text);
}

function countBy(values, keyFor) {
  const result = {};
  for (const value of values) {
    const key = keyFor(value);
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function parseArgs(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value?.startsWith('--')) continue;
    const next = values[index + 1];
    if (next && !next.startsWith('--')) {
      result.set(value, next);
      index += 1;
    } else {
      result.set(value, true);
    }
  }
  return result;
}

async function readHostedCatalog(file) {
  const bytes = new Uint8Array(await readFile(file));
  return {
    document: parseModelCatalogBytes(bytes),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
