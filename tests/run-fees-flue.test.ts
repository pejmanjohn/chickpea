import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

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
  withModelAccess,
  withModelRequestPurpose,
  type AttemptModelAccess,
  type ModelAccessGrant,
} from '../src/config/model-access.ts';
import { registeredPiProvider } from '../src/config/pi-provider-registry.ts';
import {
  configurePlatformFunding,
  resetPlatformFundingForTests,
  type FeeOutcome,
  type FeePost,
} from '../src/config/platform-funding.ts';
import { buildSemanticActivityContext, registerActivityContext } from '../src/activity/status.ts';
import { genericSemanticDescriptor } from '../src/activity/semantic.ts';
import { runFeeInterceptor } from '../src/config/run-fee-interceptor.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import { ANTHROPIC_COMPAT_PROVIDER_ID } from '../src/model-catalog/provider-alias.ts';
import { AgentPromptFailure, agentFailureText, promptSlackThreadAgent } from '../src/slack/flue-dispatch.ts';
import type { FlueDispatchEnvelopeV1 } from '../src/slack/turn-job-types.ts';
import { CREDITS_EXHAUSTED_TEXT } from '../src/slack/web-client-presenter.ts';
import type { FeeRun } from '../src/usage/run-fees.ts';
import { NO_RUN_FEES } from './helpers/platform-funding.ts';
import { answers, callsTools, SCRIPTED_MODEL, scriptedProvider } from './helpers/scripted-provider.ts';

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

function hostedPort(
  t: TestContext,
  options: { refuse?: FeePost['tier']; fail?: FeePost['tier']; stall?: FeePost['tier']; port?: boolean } = {},
) {
  resetModelAccessForTests();
  resetPlatformFundingForTests();
  configureInstallationAdmission(async () => 'admitted');
  configureModelAccessResolver({ resolve: async () => ({ apiKey: 'sk-run-fee-test-key' }) });
  const posts: Array<FeePost & { outcome: FeeOutcome['kind'] | 'failed' }> = [];
  const rows = new Set<string>();
  if (options.port !== false) {
    configurePlatformFunding({
      ...NO_RUN_FEES,
      funding: async () => 'customer',
      admit: async () => 'admitted',
      charge: async () => {},
      postFee: async (post) => {
        if (post.tier === options.stall) {
          posts.push({ ...post, outcome: 'failed' });
          return new Promise<never>(() => {});
        }
        if (post.tier === options.fail) {
          posts.push({ ...post, outcome: 'failed' });
          throw new Error('ledger unavailable');
        }
        const key = `${post.installationId}:${post.runId}:${post.tier}`;
        const outcome = post.tier === options.refuse ? 'refused' : rows.has(key) ? 'duplicate' : 'posted';
        if (outcome === 'posted') rows.add(key);
        posts.push({ ...post, outcome });
        return { kind: outcome };
      },
    });
  }
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
  useModel(`${ANTHROPIC_COMPAT_PROVIDER_ID}/${SCRIPTED_MODEL}`);
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

async function slackTurn(id: string): Promise<{ text: string } | unknown> {
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
      requestedModel: `anthropic/${SCRIPTED_MODEL}`,
      state: {
        dispatchEnvelope: { instanceId: id } as FlueDispatchEnvelopeV1,
        dispatchReceipt: receipt,
        prepare: () => { throw new Error('Must reuse saved dispatch'); },
        reconcileExistingInstance: () => { throw new Error('Must reuse saved instance'); },
        recordReceipt: (value) => value,
        recordSettlement: (value) => value,
        markRecoveryRequired: () => {},
      },
    }).then((result) => ({ text: result.text }), (error: unknown) => error);
  } finally {
    await runtime.stop();
  }
}

const tiers = (posts: ReadonlyArray<{ tier: string; outcome: string }>) => posts.map(({ tier, outcome }) => `${tier}:${outcome}`);
const replyRun = (env: PlatformEnv | undefined, feeRun: FeeRun = { kind: 'interactive', repositoryShell: false }) =>
  (runId: string | undefined): AttemptModelAccess => ({ env, grant: ownKeyGrant(runId!), agentId: 'agent_fees', feeRun });

test('an own-key task refused at zero ends the turn out of usage, before the tool runs or another request is sent', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t, { refuse: 'task' });
  interceptors(t, replyRun(hostedEnv()));
  const { sent } = scriptedProvider([callsTools('read_slack_channel'), answers]);
  ran.length = 0;

  const failure = await slackTurn('fees-refused');

  assert.ok(failure instanceof AgentPromptFailure, String(failure));
  assert.equal(failure.kind, 'credits-exhausted');
  assert.equal(failure.retryable, false);
  assert.equal(agentFailureText(failure), CREDITS_EXHAUSTED_TEXT);
  assert.equal(sent.length, 1, 'no provider request after the refusal');
  assert.deepEqual(ran, [], 'the refused tool never ran');
  assert.deepEqual(tiers(posts), ['chat:posted', 'task:refused']);
});

test('a hosted reply run posts one chat row, keyed by its submission and Agent, and no task row without a qualifying tool', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([callsTools('read_slack_thread'), answers]);
  ran.length = 0;

  const result = await slackTurn('fees-chat');

  assert.deepEqual(result, { text: 'done' });
  assert.deepEqual(ran, ['read_slack_thread']);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.tier, 'chat');
  assert.equal(posts[0]!.installationId, INSTALLATION);
  assert.equal(posts[0]!.agentId, 'agent_fees');
  assert.match(posts[0]!.runId, /^sub_/, 'the run ID is the Flue submission the request records carry');
});

test('parallel qualifying tools in one attempt post one task row, before either runs', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([callsTools('read_slack_channel', 'read_slack_channel', 'read_slack_thread'), callsTools('read_slack_channel'), answers]);
  ran.length = 0;

  const result = await slackTurn('fees-parallel');

  assert.deepEqual(result, { text: 'done' });
  assert.deepEqual(ran.filter((name) => name === 'read_slack_channel').length, 3);
  assert.deepEqual(tiers(posts), ['chat:posted', 'task:posted']);
  assert.equal(new Set(posts.map(({ runId }) => runId)).size, 1);
});

test('a scheduled run posts its chat row and never a task row for a tool, even a qualifying one', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv(), { kind: 'scheduled' }));
  scriptedProvider([callsTools('read_slack_channel'), answers]);
  ran.length = 0;

  assert.deepEqual(await slackTurn('fees-scheduled'), { text: 'done' });
  assert.deepEqual(ran, ['read_slack_channel']);
  assert.deepEqual(tiers(posts), ['chat:posted']);
});

test('an attempt with no reply run, such as a coding worker\'s, posts no fee row', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, (runId) => ({ env: hostedEnv(), grant: ownKeyGrant(runId!), agentId: 'agent_fees' }));
  scriptedProvider([callsTools('read_slack_channel'), answers]);
  ran.length = 0;

  assert.deepEqual(await slackTurn('fees-worker'), { text: 'done' });
  assert.deepEqual(ran, ['read_slack_channel']);
  assert.deepEqual(posts, []);
});

test('a task row the host cannot post lets the tool run, and the next qualifying tool asks again', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t, { fail: 'task' });
  const warn = t.mock.method(console, 'warn', () => undefined);
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([callsTools('read_slack_channel'), callsTools('read_slack_channel'), answers]);
  ran.length = 0;

  assert.deepEqual(await slackTurn('fees-unavailable'), { text: 'done' });
  assert.deepEqual(ran, ['read_slack_channel', 'read_slack_channel']);
  assert.deepEqual(tiers(posts), ['chat:posted', 'task:failed', 'task:failed']);
  const logged = warn.mock.calls.map(({ arguments: [line] }) => String(line)).filter((line) => line.includes('fee_post_failed'));
  assert.equal(logged.length, 2);
  assert.ok(logged.every((line) => !line.includes(INSTALLATION) && !line.includes('sub_')), 'the log names no installation or run');
});

test('a chat row the host never answers does not delay the first model request', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t, { stall: 'chat' });
  t.mock.method(console, 'warn', () => undefined);
  interceptors(t, replyRun(hostedEnv()));
  const { sentAt } = scriptedProvider([answers]);
  const startedAt = performance.now();

  assert.deepEqual(await slackTurn('fees-chat-stalled'), { text: 'done' });
  assert.deepEqual(tiers(posts), ['chat:failed']);
  assert.ok(sentAt[0]! - startedAt < 1_000, `the first request waited ${Math.round(sentAt[0]! - startedAt)} ms`);
});

test('a chat row the host cannot post never fails the attempt', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t, { fail: 'chat' });
  t.mock.method(console, 'warn', () => undefined);
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([answers]);

  assert.deepEqual(await slackTurn('fees-chat-unavailable'), { text: 'done' });
  assert.deepEqual(tiers(posts), ['chat:failed']);
});

test('a retried attempt of the same run posts only duplicates', async (t) => {
  const posts = hostedPort(t);
  const env = hostedEnv();
  const modelAccess = createModelAccessInterceptor({
    lookup: async (context) => replyRun(env)(context.submissionId),
    installationGrants: async () => [],
  });
  const attempt = () => modelAccess(
    { type: 'agent', operationId: 'op_retry', operationKind: 'prompt' },
    { instanceId: 'fees-retry', submissionId: 'sub_retry' },
    () => runFeeInterceptor(
      { type: 'tool', toolCallId: 'call_retry', toolName: 'read_slack_channel' },
      { instanceId: 'fees-retry', submissionId: 'sub_retry' },
      async () => 'ran',
    ),
  );

  assert.equal(await attempt(), 'ran');
  assert.equal(await attempt(), 'ran');
  assert.deepEqual(tiers(posts), ['chat:posted', 'task:posted', 'chat:duplicate', 'task:duplicate']);
});

test('the shell posts the task row only when the run\'s shell reaches a granted repository', async (t) => {
  const posts = hostedPort(t);
  for (const repositoryShell of [false, true]) {
    const modelAccess = createModelAccessInterceptor({
      lookup: async (context) => replyRun(hostedEnv(), { kind: 'interactive', repositoryShell })(context.submissionId),
      installationGrants: async () => [],
    });
    const context = { instanceId: `fees-shell-${repositoryShell}`, submissionId: `sub_shell_${repositoryShell}` };
    await modelAccess({ type: 'agent', operationId: 'op_shell', operationKind: 'prompt' }, context, () =>
      runFeeInterceptor({ type: 'tool', toolCallId: 'call_bash', toolName: 'bash' }, context, async () => 'ran'));
  }
  assert.deepEqual(posts.map(({ runId, tier }) => `${runId}:${tier}`),
    ['sub_shell_false:chat', 'sub_shell_true:chat', 'sub_shell_true:task']);
});

test('an unlisted tool qualifies by the family its render registered for it', async (t) => {
  const posts = hostedPort(t);
  registerActivityContext('fees-descriptor', buildSemanticActivityContext([
    { toolName: 'custom_lookup', descriptor: genericSemanticDescriptor('custom_connection') },
    { toolName: 'custom_note', descriptor: genericSemanticDescriptor('memory') },
  ]));
  const modelAccess = createModelAccessInterceptor({
    lookup: async (context) => replyRun(hostedEnv())(context.submissionId),
    installationGrants: async () => [],
  });
  const context = { instanceId: 'fees-descriptor', submissionId: 'sub_descriptor' };
  const call = (toolName: string) => runFeeInterceptor({ type: 'tool', toolCallId: `call_${toolName}`, toolName }, context, async () => toolName);

  await modelAccess({ type: 'agent', operationId: 'op_descriptor', operationKind: 'prompt' }, context, async () => {
    assert.equal(await call('custom_note'), 'custom_note');
    assert.deepEqual(tiers(posts), ['chat:posted']);
    assert.equal(await call('custom_lookup'), 'custom_lookup');
  });
  assert.deepEqual(tiers(posts), ['chat:posted', 'task:posted']);
});

test('a qualifying tool inside an absorbed purpose, such as reading an attachment, posts no task row', async (t) => {
  const posts = hostedPort(t);
  const modelAccess = createModelAccessInterceptor({
    lookup: async (context) => replyRun(hostedEnv())(context.submissionId),
    installationGrants: async () => [],
  });
  const context = { instanceId: 'fees-attachment', submissionId: 'sub_attachment' };
  const read = () => runFeeInterceptor(
    { type: 'tool', toolCallId: 'call_read', toolName: 'read_slack_channel' }, context, async () => 'ran',
  );

  await modelAccess({ type: 'agent', operationId: 'op_attachment', operationKind: 'prompt' }, context, async () => {
    assert.equal(await withModelRequestPurpose('attachment', read), 'ran');
    assert.deepEqual(tiers(posts), ['chat:posted']);
    assert.equal(await read(), 'ran');
  });
  assert.deepEqual(tiers(posts), ['chat:posted', 'task:posted']);
});

test('a stateless call, such as the intent check, posts no fee row', async (t) => {
  const posts = hostedPort(t);
  const { sent, model } = scriptedProvider([answers]);
  const call = () => registeredPiProvider(ANTHROPIC_COMPAT_PROVIDER_ID)!.streamSimple(model, {
    systemPrompt: 'probe', messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
  }, {}).result();

  const reply = await withModelAccess(ownKeyGrant('slack-interaction-intent'), hostedEnv(), 'intent', call);

  assert.equal(reply.stopReason, 'stop');
  assert.equal(sent.length, 1);
  assert.deepEqual(posts, []);
});

for (const [name, env, port] of [
  ['standalone, even with a host port configured,', undefined, true],
  ['a hosted deployment with no host port', hostedEnv(), false],
] as const) {
  test(`${name} posts nothing and runs as before`, { timeout: 20_000 }, async (t) => {
    const warn = t.mock.method(console, 'warn', () => undefined);
    const posts = hostedPort(t, { port });
    interceptors(t, replyRun(env));
    const { sent } = scriptedProvider([callsTools('read_slack_channel'), answers]);
    ran.length = 0;

    assert.deepEqual(await slackTurn(`fees-${port ? 'standalone' : 'no-port'}`), { text: 'done' });
    assert.deepEqual(ran, ['read_slack_channel']);
    assert.equal(sent.length, 2);
    assert.deepEqual(posts, []);
    assert.equal(warn.mock.callCount(), 0, 'nothing tried to post');
  });
}
