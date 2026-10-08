import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import {
  createAssistantMessageEventStream,
  createProvider,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai';
import { init, instrument, useModel, useTool } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';

import {
  configureInstallationAdmission,
  resetInstallationAdmissionForTests,
} from '../src/config/installation-admission.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  configureModelAccessResolver,
  createModelAccessInterceptor,
  resetModelAccessForTests,
  type AttemptModelAccess,
  type ModelAccessGrant,
} from '../src/config/model-access.ts';
import { registerPiProvider, registeredPiProvider } from '../src/config/pi-provider-registry.ts';
import {
  configurePlatformFunding,
  resetPlatformFundingForTests,
  type FeeOutcome,
  type FeePost,
} from '../src/config/platform-funding.ts';
import { runFeeInterceptor } from '../src/config/run-fee-interceptor.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import { ANTHROPIC_COMPAT_PROVIDER_ID } from '../src/model-catalog/provider-alias.ts';
import { AgentPromptFailure, agentFailureText, promptSlackThreadAgent } from '../src/slack/flue-dispatch.ts';
import type { FlueDispatchEnvelopeV1 } from '../src/slack/turn-job-types.ts';
import { CREDITS_EXHAUSTED_TEXT } from '../src/slack/web-client-presenter.ts';
import { NO_RUN_FEES } from './helpers/platform-funding.ts';

const SONNET = 'claude-sonnet-5-5';
const INSTALLATION = 'inst_fees';

function hostedEnv(): PlatformEnv {
  return scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: INSTALLATION }) as PlatformEnv;
}

function ownKeyGrant(runId: string): ModelAccessGrant {
  return {
    installationId: INSTALLATION, providerId: 'anthropic', runId, fundingSource: 'customer',
    credentialRefId: 'cred_anthropic', credentialVersion: 1,
  };
}

type Reply = (model: Model<string>) => AssistantMessage;

function message(model: Model<string>, content: AssistantMessage['content'], stopReason: 'stop' | 'toolUse'): AssistantMessage {
  return {
    role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: 1,
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

const callsTools = (...names: string[]): Reply => (model) => message(
  model,
  names.map((name, index) => ({ type: 'toolCall', id: `call_${index}_${name}`, name, arguments: {} })),
  'toolUse',
);
const answers: Reply = (model) => message(model, [{ type: 'text', text: 'done' }], 'stop');

/** Streams a whole message as a provider does: each block's start and end, then done. */
function streamMessage(output: AssistantMessageEventStream, final: AssistantMessage): void {
  const partial: AssistantMessage = { ...final, content: [] };
  output.push({ type: 'start', partial: { ...partial } });
  final.content.forEach((block, contentIndex) => {
    partial.content = [...partial.content, block];
    if (block.type === 'text') {
      output.push({ type: 'text_start', contentIndex, partial: { ...partial } });
      output.push({ type: 'text_end', contentIndex, content: block.text, partial: { ...partial } });
    } else if (block.type === 'toolCall') {
      output.push({ type: 'toolcall_start', contentIndex, partial: { ...partial } });
      output.push({ type: 'toolcall_end', contentIndex, toolCall: block, partial: { ...partial } });
    }
  });
  output.push({ type: 'done', reason: final.stopReason as 'stop' | 'toolUse', message: final });
  output.end();
}

/** A provider through the production proxy that answers each request it is sent with the next reply. */
function scriptedProvider(replies: Reply[]) {
  const model = {
    id: SONNET, name: SONNET, api: 'anthropic-messages', provider: ANTHROPIC_COMPAT_PROVIDER_ID,
    baseUrl: 'https://provider.invalid', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_192,
  } as Model<'anthropic-messages'>;
  const sent: number[] = [];
  const stream = (sentModel: Model<string>): AssistantMessageEventStream => {
    sent.push(sent.length);
    const output = createAssistantMessageEventStream();
    const reply = replies.shift();
    assert.ok(reply, 'a scripted reply remains for every request sent');
    queueMicrotask(() => streamMessage(output, reply(sentModel)));
    return output;
  };
  registerPiProvider(createProvider({
    id: ANTHROPIC_COMPAT_PROVIDER_ID,
    auth: { apiKey: { name: 'probe', resolve: async () => ({ auth: {} }) } },
    models: [model],
    api: { stream, streamSimple: stream },
  }));
  return { sent };
}

/** A hosted host whose port answers each fee post by tier; it remembers every post. */
function hostedPort(t: TestContext, outcomes: Partial<Record<FeePost['tier'], FeeOutcome['kind']>> = {}) {
  resetModelAccessForTests();
  resetPlatformFundingForTests();
  configureInstallationAdmission(async () => 'admitted');
  configureModelAccessResolver({ resolve: async () => ({ apiKey: 'sk-run-fee-test-key' }) });
  const posts: FeePost[] = [];
  configurePlatformFunding({
    ...NO_RUN_FEES,
    funding: async () => 'customer',
    admit: async () => 'admitted',
    charge: async () => {},
    postFee: async (post) => {
      posts.push(post);
      return { kind: outcomes[post.tier] ?? 'posted' };
    },
  });
  t.after(() => {
    resetModelAccessForTests();
    resetPlatformFundingForTests();
    resetInstallationAdmissionForTests();
  });
  return posts;
}

function interceptors(t: TestContext, lookup: (runId: string | undefined) => AttemptModelAccess) {
  const modelAccess = createModelAccessInterceptor({
    lookup: async (context) => lookup(context.submissionId),
    installationGrants: async () => [],
  });
  t.after(instrument({ key: Symbol('model-access'), interceptor: modelAccess, observe() {}, dispose() {} }));
  t.after(instrument({ key: Symbol('run-fees'), interceptor: runFeeInterceptor, observe() {}, dispose() {} }));
}

const ran: string[] = [];

function FeeProbe() {
  useModel(`${ANTHROPIC_COMPAT_PROVIDER_ID}/${SONNET}`);
  for (const name of ['read_slack_channel', 'read_slack_thread']) {
    useTool({
      name,
      description: `The synthetic ${name}.`,
      input: v.object({}),
      output: v.string(),
      run: () => {
        ran.push(name);
        return { output: 'ok' };
      },
    });
  }
  return 'Use the scripted tools.';
}

async function slackTurn(id: string): Promise<unknown> {
  const runtime = await start({
    agents: [{ agent: FeeProbe, name: 'fee-probe' }],
    providers: [registeredPiProvider(ANTHROPIC_COMPAT_PROVIDER_ID)!],
  });
  try {
    const agent = init(FeeProbe, { id });
    const receipt = await agent.dispatch('Hello');
    return await promptSlackThreadAgent({
      handle: agent, message: 'unused saved dispatch', turnId: id,
      conversationKey: 'T_FIXTURE:C_FIXTURE:1',
      requestedModel: `anthropic/${SONNET}`,
      state: {
        dispatchEnvelope: { instanceId: id } as FlueDispatchEnvelopeV1,
        dispatchReceipt: receipt,
        prepare: () => { throw new Error('Must reuse saved dispatch'); },
        reconcileExistingInstance: () => { throw new Error('Must reuse saved instance'); },
        recordReceipt: (value) => value,
        recordSettlement: (value) => value,
        markRecoveryRequired: () => {},
      },
    }).then(() => undefined, (error: unknown) => error);
  } finally {
    await runtime.stop();
  }
}

test('an own-key task refused at zero ends the turn out of usage, before the tool runs or another request is sent', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t, { task: 'refused' });
  const env = hostedEnv();
  interceptors(t, (runId) => ({ env, grant: ownKeyGrant(runId!), agentId: 'agent_fees', runKind: 'interactive' }));
  const { sent } = scriptedProvider([callsTools('read_slack_channel'), answers]);
  ran.length = 0;

  const failure = await slackTurn('fees-refused');

  assert.ok(failure instanceof AgentPromptFailure, String(failure));
  assert.equal(failure.kind, 'credits-exhausted');
  assert.equal(failure.retryable, false);
  assert.equal(agentFailureText(failure), CREDITS_EXHAUSTED_TEXT);
  assert.equal(sent.length, 1, 'no provider request after the refusal');
  assert.deepEqual(ran, [], 'the refused tool never ran');
  assert.deepEqual(posts.map((post) => post.tier), ['chat', 'task']);
});
