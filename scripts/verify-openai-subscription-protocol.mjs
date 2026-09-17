#!/usr/bin/env node
/**
 * Fresh adapter-level proof for Chickpea's ChatGPT subscription boundary.
 * This intentionally exercises device auth and the Chickpea/Pi provider
 * directly, independently of the persisted product routing selection.
 */

import { readFileSync } from 'node:fs';

import { Type, validateToolCall } from '@earendil-works/pi-ai';

import { assertNodeVersion } from './lib/node-version.mjs';
import { registeredPiProvider } from '../src/config/pi-provider-registry.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import {
  bindOpenAiSubscriptionProvider,
  OPENAI_SUBSCRIPTION_PROVIDER_ID,
} from '../src/openai-subscription/provider.ts';
import { commitOpenAiSubscriptionCredentials } from '../src/openai-subscription/credentials.ts';
import {
  OPENAI_SUBSCRIPTION_ENDPOINTS,
  OPENAI_SUBSCRIPTION_MODELS,
  exchangeOpenAiDeviceAuthorization,
  pollOpenAiDeviceAuthorization,
  startOpenAiDeviceAuthorization,
} from '../src/openai-subscription/protocol.ts';
import { clearOpenAiSubscriptionTransport } from '../src/openai-subscription/transport.ts';

export const DEFAULT_PROOF_MODEL = 'gpt-5.6-sol';
export const PROOF_TOOL_NAME = 'confirm_chickpea_subscription_transport';
export const PROOF_TOOL_ARGUMENT = 'CHICKPEA_SUBSCRIPTION_TOOL_ARGUMENT_OK';
export const PROOF_TOOL_RESULT = 'CHICKPEA_SUBSCRIPTION_TOOL_RESULT_OK';
export const PROOF_FINAL_MARKER = 'CHICKPEA_SUBSCRIPTION_TOOL_ROUNDTRIP_OK';

const SAFE_FAILURE_CODES = new Set([
  'auth_reconnect_required', 'authorization_expired', 'client_rejected', 'entitlement_denied',
  'invalid_response', 'invalid_tool_arguments', 'model_stream_failed', 'originator_rejected',
  'protocol_drift', 'provider_unavailable', 'request_timeout', 'subscription_quota_exhausted',
  'tool_call_missing', 'tool_continuation_failed', 'unexpected_egress', 'unsupported_model',
]);

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (!value?.startsWith('--')) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith('--')) {
    args.set(value, next);
    index += 1;
  } else {
    args.set(value, true);
  }
}

if (args.has('--help')) {
  console.log(
    'Usage: npm run verify:openai-subscription-protocol -- --live ' +
      '[--model gpt-5.6-sol] [--request-timeout-ms 120000]',
  );
  console.log('Starts fresh device authorization and runs an adapter-only Pi text/tool proof.');
  process.exit(0);
}

const live = args.has('--live');
const modelId = String(args.get('--model') ?? DEFAULT_PROOF_MODEL);
const rawRequestTimeout = args.get('--request-timeout-ms');
const requestTimeoutMs = Number(rawRequestTimeout ?? 120_000);

if (!live) {
  const packageJson = readPackageJson();
  const dependencyNames = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ];
  if (dependencyNames.some((name) => /codex|app-server/i.test(name))) fail('protocol_drift');
  if (!OPENAI_SUBSCRIPTION_ENDPOINTS.responses.startsWith('https://chatgpt.com/')) fail('protocol_drift');
  if (!OPENAI_SUBSCRIPTION_MODELS.includes(DEFAULT_PROOF_MODEL)) fail('unsupported_model');
  console.log('[openai-subscription] offline adapter contract verified');
  process.exit(0);
}

if (!OPENAI_SUBSCRIPTION_MODELS.includes(modelId)) fail('unsupported_model');
if (
  rawRequestTimeout === true ||
  !Number.isSafeInteger(requestTimeoutMs) ||
  requestTimeoutMs < 1 ||
  requestTimeoutMs > 180_000
) {
  fail('protocol_drift');
}

const packageJson = readPackageJson();
const versions = {
  node: process.version,
  piAi: packageJson.dependencies?.['@earendil-works/pi-ai'] ?? 'unknown',
  flueRuntime: packageJson.dependencies?.['@flue/runtime'] ?? 'unknown',
  model: modelId,
};
const nativeFetch = globalThis.fetch;
const destinations = [];
let unexpectedEgress = false;
const allowedHosts = new Set(['auth.openai.com', 'chatgpt.com']);
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  destinations.push(url.hostname);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) {
    unexpectedEgress = true;
    fail('unexpected_egress');
  }
  return nativeFetch(input, init);
};

const settings = new SqliteSettingsStore(':memory:');
try {
  assertNodeVersion();
  console.log(JSON.stringify({ stage: 'preflight', gate: 'adapter', authorization: 'fresh_device', ...versions }));

  const pending = await startOpenAiDeviceAuthorization();
  console.log(`[openai-subscription] Open ${pending.verificationUri}`);
  console.log(`[openai-subscription] Enter code: ${pending.userCode}`);
  console.log('[openai-subscription] Waiting for fresh authorization; credentials remain in memory only.');

  const approved = await waitForApproval(pending);
  const tokens = await exchangeOpenAiDeviceAuthorization(approved);
  await commitOpenAiSubscriptionCredentials(tokens, { settings });
  await bindOpenAiSubscriptionProvider({ settings, modelId });

  const provider = registeredPiProvider(OPENAI_SUBSCRIPTION_PROVIDER_ID);
  const model = provider?.getModels().find((candidate) => candidate.id === modelId);
  if (!provider || !model) fail('unsupported_model');

  const tool = {
    name: PROOF_TOOL_NAME,
    description: 'Confirm the Chickpea subscription adapter function-call path.',
    parameters: Type.Object(
      { proof: Type.Literal(PROOF_TOOL_ARGUMENT) },
      { additionalProperties: false },
    ),
  };
  const context = {
    systemPrompt:
      `Call ${PROOF_TOOL_NAME} exactly once with proof set to ${PROOF_TOOL_ARGUMENT}. ` +
      'After its successful result, return exactly the receipt string supplied by the tool and nothing else.',
    messages: [{ role: 'user', content: 'Run the subscription transport proof.', timestamp: Date.now() }],
    tools: [tool],
  };

  const first = await collect(provider.stream(model, context, {
    maxTokens: 128,
    signal: AbortSignal.timeout(requestTimeoutMs),
  }));
  const toolCalls = first.result.content.filter((part) => part.type === 'toolCall');
  failForModelError(first.result, 'tool_call_missing');
  if (toolCalls.length !== 1 || toolCalls[0].name !== tool.name) {
    fail('tool_call_missing');
  }
  let validated;
  try {
    validated = validateToolCall([tool], toolCalls[0]);
  } catch {
    fail('invalid_tool_arguments');
  }
  if (validated?.proof !== PROOF_TOOL_ARGUMENT || Object.keys(validated).length !== 1) {
    fail('invalid_tool_arguments');
  }

  context.messages.push(first.result);
  const finalReceipt = `${PROOF_FINAL_MARKER}:${crypto.randomUUID()}`;
  context.messages.push({
    role: 'toolResult',
    toolCallId: toolCalls[0].id,
    toolName: toolCalls[0].name,
    content: [{ type: 'text', text: `${PROOF_TOOL_RESULT}\nReceipt: ${finalReceipt}` }],
    isError: false,
    timestamp: Date.now(),
  });
  const second = await collect(provider.stream(model, context, {
    maxTokens: 128,
    signal: AbortSignal.timeout(requestTimeoutMs),
  }));
  const text = second.result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
  failForModelError(second.result, 'tool_continuation_failed');
  if (
    second.result.content.some((part) => part.type === 'toolCall') ||
    !second.events.some((event) => event.type === 'text_delta') ||
    !second.events.some((event) => event.type === 'done') ||
    text !== finalReceipt
  ) {
    fail('tool_continuation_failed');
  }
  if (!destinations.includes('chatgpt.com')) fail('model_stream_failed');
  if (destinations.includes('api.openai.com')) fail('unexpected_egress');

  console.log(JSON.stringify({
    ok: true,
    gate: 'adapter',
    authorization: 'fresh_device',
    streamingTextCompleted: true,
    toolArgumentsValidated: true,
    toolResultContinuation: true,
    destination: 'chatgpt.com',
    apiKeyFallbackObserved: false,
    ...versions,
  }));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    gate: 'adapter',
    model: modelId,
    failureCode: unexpectedEgress ? 'unexpected_egress' : safeCode(error),
  }));
  process.exitCode = 1;
} finally {
  clearOpenAiSubscriptionTransport();
  settings.close();
  globalThis.fetch = nativeFetch;
}

async function waitForApproval(pending) {
  while (Date.now() < pending.expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, pending.intervalMs + 1_000));
    const status = await pollOpenAiDeviceAuthorization(pending);
    if (status.state === 'approved') return status;
  }
  fail('authorization_expired');
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function safeCode(error) {
  return error && typeof error === 'object' && SAFE_FAILURE_CODES.has(error.code)
    ? error.code
    : 'protocol_drift';
}

function failForModelError(result, fallback) {
  if (result.stopReason === 'aborted') fail('request_timeout');
  if (result.stopReason !== 'error') return;
  const match = result.errorMessage?.match(/OpenAI subscription operation failed \(([a-z_]+)\)\./);
  fail(match && SAFE_FAILURE_CODES.has(match[1]) ? match[1] : fallback);
}

function readPackageJson() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
}
