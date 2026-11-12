import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createAssistantMessageEventStream, type AssistantMessage, type StreamOptions } from '@earendil-works/pi-ai';
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
import { ModelStepMarks } from '../src/observability/runtime-latency.ts';
import { EVERY_PROVIDER_FUNDED, NO_RUN_FEES } from './helpers/platform-funding.ts';

const MODEL = 'claude-opus-5-5';
const INSTALLATION = 'inst_model_step';

function observation(event: Record<string, unknown>): FlueObservation {
  return event as unknown as FlueObservation;
}

function grant(fundingSource: ModelAccessGrant['fundingSource']): ModelAccessGrant {
  return {
    installationId: INSTALLATION, providerId: 'anthropic', runId: `run_${fundingSource}`, fundingSource,
    credentialRefId: fundingSource === 'platform' ? 'platform:anthropic' : 'cred_anthropic', credentialVersion: 1,
  };
}

/** A shared shape's rendered request with a synthetic tenant block after the constant one, as a Slack turn sends it. */
function sharedPayload(): { id: SharedPrefixId; payload: Record<string, unknown> } {
  const [prewarm] = sharedPrefixRequests(MODEL);
  assert.ok(prewarm);
  return {
    id: prewarm.id,
    payload: {
      ...prewarm.body,
      max_tokens: 4_096,
      system: [{ type: 'text', text: `${sharedSystemBlock(prewarm.kind)}${PART_SEPARATOR}Synthetic tenant block.` }],
    },
  };
}

/** A finished step whose provider wrote 1,000 tokens for an hour and 500 for five minutes. */
function finalMessage(): AssistantMessage {
  return {
    role: 'assistant', content: [{ type: 'text', text: 'Synthetic answer.' }], api: 'anthropic-messages',
    provider: 'anthropic', model: MODEL, stopReason: 'stop', timestamp: 1,
    usage: {
      input: 12, output: 9, cacheRead: 0, cacheWrite: 1_500, cacheWrite1h: 1_000, totalTokens: 1_521,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function setUp(t: TestContext, charge: (sharedPrefix: SharedPrefixId | null) => Promise<void>) {
  resetModelAccessForTests();
  resetPlatformFundingForTests();
  resetInstallationAdmissionForTests();
  t.after(() => {
    resetModelAccessForTests();
    resetPlatformFundingForTests();
    resetInstallationAdmissionForTests();
  });
  registerBuiltinPiProvider('anthropic');
  configureModelAccessResolver({ resolve: async () => ({ apiKey: 'sk-model-step-settle-test' }) });
  configureInstallationAdmission(async () => 'admitted');
  configureModelRequestRecorder(async () => undefined);
  configurePlatformFunding({
    ...EVERY_PROVIDER_FUNDED,
    funding: async () => 'platform',
    admit: async () => 'admitted',
    charge: async (_record, sharedPrefix) => charge(sharedPrefix),
    ...NO_RUN_FEES,
  });
}

/**
 * One model step through the proxy as pi-ai sends it: the payload hook runs
 * inside the stream, then the provider's final message arrives. Returns the
 * step's model_step record.
 */
async function step(fundingSource: ModelAccessGrant['fundingSource'], payload: Record<string, unknown>, time: { now: number }) {
  const records: Record<string, unknown>[] = [];
  const steps = new ModelStepMarks(() => time.now, { info: (record) => records.push(record) });
  const env = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: INSTALLATION }) as PlatformEnv;
  const model = registeredPiProvider('anthropic')?.getModels().find((candidate) => candidate.id === MODEL);
  assert.ok(model);
  steps.observe(observation({ type: 'turn_request', turnId: 'step_1', purpose: 'agent', instanceId: 'agent_thread' }));
  await withModelAccess(grant(fundingSource), env, 'reply', () => steps.intercept({ type: 'model', turnId: 'step_1' }, async () => {
    const request = modelAccessRequest('anthropic', model, {} as StreamOptions);
    const stream = request.send((sent) => {
      const source = createAssistantMessageEventStream();
      void (async () => {
        await request.options.onPayload?.(structuredClone(payload), sent);
        const message = finalMessage();
        source.push({ type: 'done', reason: 'stop', message });
        source.end(message);
      })();
      return source;
    });
    assert.equal((await stream.result()).stopReason, 'stop');
  }));
  steps.observe(observation({
    type: 'turn', turnId: 'step_1', purpose: 'agent', durationMs: 3_000, isError: false,
    response: { finishReason: 'stop', usage: { input: 12, output: 9, cacheRead: 0, cacheWrite: 1_500, totalTokens: 1_521, cost: {} } },
  }));
  const record = records.at(-1);
  assert.equal(record?.event, 'model_step');
  return record!;
}

// Defects caught: the 1-hour split read from Flue's step usage (which drops
// it), a shared prefix other than the one the charge received, the charge's
// hold not timed or timed past the step's release, and a field the platform
// path never reaches.
test('a platform-funded Anthropic step logs its 1-hour and 5-minute cache writes, the shared prefix its charge carried, and the charge\'s hold', async (t) => {
  const time = { now: 0 };
  const charged: Array<SharedPrefixId | null> = [];
  setUp(t, async (sharedPrefix) => {
    charged.push(sharedPrefix);
    time.now += 250;
  });
  const { id, payload } = sharedPayload();
  const record = await step('platform', payload, time);
  assert.deepEqual(charged, [id], 'the charge carried the shared prefix');
  assert.equal(record.sharedPrefix, id);
  assert.equal(record.cacheWriteTokens, 1_500);
  assert.equal(record.cacheWrite1hTokens, 1_000);
  assert.equal(record.cacheWrite5mTokens, 500);
  assert.equal(record.chargeWaitMs, 250);
});

// Defects caught: `none` missing when the platform hook ran and the request
// carried no shared prefix (a miss to count), and a shared prefix or a held
// step logged for an own-key request, which no platform hook or charge touches.
test('a platform step without a shared prefix logs none; an own-key step logs no shared prefix and holds nothing for a charge', async (t) => {
  const time = { now: 0 };
  setUp(t, async () => {
    time.now += 250;
  });
  const unshared = { model: MODEL, max_tokens: 4_096, system: [{ type: 'text', text: 'Synthetic system prompt.' }], messages: [] };
  const platform = await step('platform', unshared, time);
  assert.equal(platform.sharedPrefix, 'none');
  assert.equal(platform.chargeWaitMs, 250);

  const ownKey = await step('customer', sharedPayload().payload, time);
  assert.equal('sharedPrefix' in ownKey, false, 'no platform hook ran');
  assert.equal(ownKey.chargeWaitMs, 0);
  assert.equal(ownKey.cacheWrite1hTokens, 1_000, 'an own-key step still reports the provider\'s split');
  assert.equal(ownKey.cacheWrite5mTokens, 500);
});
