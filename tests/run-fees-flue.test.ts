import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { init, instrument, useModel, useTool, type FlueExecutionInterceptor } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';

import { resolveRepositoryAccess, runtimePlanRepositoryShell } from '../src/agents/slack-thread.ts';
import { GITHUB_SETTING_KEYS } from '../src/config/github-app.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { RepositoryGrant } from '../src/config/types.ts';
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
  type RunRef,
} from '../src/config/platform-funding.ts';
import { buildSemanticActivityContext, registerActivityContext } from '../src/activity/status.ts';
import { genericSemanticDescriptor } from '../src/activity/semantic.ts';
import { runFeeInterceptor } from '../src/config/run-fee-interceptor.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import { ANTHROPIC_COMPAT_PROVIDER_ID } from '../src/model-catalog/provider-alias.ts';
import { AgentPromptFailure, agentFailureText, promptSlackThreadAgent } from '../src/slack/flue-dispatch.ts';
import { createSlackReadGate } from '../src/slack/read-budget.ts';
import { SlackReadingService } from '../src/slack/reading/service.ts';
import { createSlackReadingTools } from '../src/slack/reading/tools.ts';
import type { FlueDispatchEnvelopeV1 } from '../src/slack/turn-job-types.ts';
import { CREDITS_EXHAUSTED_TEXT } from '../src/slack/web-client-presenter.ts';
import type { RunKind } from '../src/usage/run-fees.ts';
import { withEnv } from './helpers/env.ts';
import { NO_RUN_FEES } from './helpers/platform-funding.ts';
import { answers, callsTools, SCRIPTED_MODEL, scriptedMessage, scriptedProvider } from './helpers/scripted-provider.ts';

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

/** Each run the port was asked to admit a task for. */
const admissions: RunRef[] = [];
/** Admission answers, fee posts and tool runs, in the order they happened. */
const timeline: string[] = [];
/** Long enough that parallel calls are all waiting on the answer when it arrives. */
const ADMISSION_DELAY_MS = 20;

function hostedPort(
  t: TestContext,
  options: {
    refuse?: FeePost['tier'];
    fail?: FeePost['tier'];
    stall?: FeePost['tier'];
    admission?: 'refused' | 'stall' | 'fail';
    port?: boolean;
  } = {},
) {
  resetModelAccessForTests();
  resetPlatformFundingForTests();
  configureInstallationAdmission(async () => 'admitted');
  configureModelAccessResolver({ resolve: async () => ({ apiKey: 'sk-run-fee-test-key' }) });
  const posts: Array<FeePost & { outcome: FeeOutcome['kind'] | 'failed' }> = [];
  const rows = new Set<string>();
  admissions.length = 0;
  timeline.length = 0;
  if (options.port !== false) {
    configurePlatformFunding({
      ...NO_RUN_FEES,
      funding: async () => 'customer',
      admit: async () => 'admitted',
      charge: async () => {},
      admitTask: async (run) => {
        admissions.push(run);
        if (options.admission === 'stall') return new Promise<never>(() => {});
        if (options.admission === 'fail') throw new Error('ledger unavailable');
        await new Promise((resolve) => setTimeout(resolve, ADMISSION_DELAY_MS));
        const answer = options.admission ?? 'admitted';
        timeline.push(`admit:${answer}`);
        return answer;
      },
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
        timeline.push(`${post.tier}:${outcome}`);
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

function interceptors(
  t: TestContext,
  lookup: (runId: string | undefined) => AttemptModelAccess,
  beforeRunFees?: FlueExecutionInterceptor,
) {
  const modelAccess = createModelAccessInterceptor({
    lookup: async (context) => lookup(context.submissionId),
    installationGrants: async () => [],
  });
  t.after(instrument({ key: Symbol('model-access'), interceptor: modelAccess, observe() {}, dispose() {} }));
  if (beforeRunFees) t.after(instrument({ key: Symbol('before-run-fees'), interceptor: beforeRunFees, observe() {}, dispose() {} }));
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
        timeline.push(`tool:${name}`);
        return { output: JSON.stringify({ status: 'ok' }) };
      },
    });
  }
  useTool({
    name: 'read_slack_list',
    description: 'The synthetic read_slack_list, which fails after it does its work.',
    input: v.object({}),
    output: v.string(),
    run: () => {
      ran.push('read_slack_list');
      throw new Error('Slack answered with an unreadable response.');
    },
  });
  return 'Use the scripted tools.';
}

const MENTION = { workspaceId: 'T0FEES', channelId: 'C0FEES', threadTs: '1000.000100', messageTs: '1000.000100' };
const slackHistoryCalls: unknown[] = [];
const readBudgetDecisions: boolean[] = [];
const grantChecks: string[] = [];
/** A channel the requester belongs to but this Agent was never added to. */
const UNGRANTED_CHANNEL = 'C0UNGRANTED';

/** The real Slack read tools on a shared app, paced at one read a minute. */
function ChannelMentionProbe() {
  useModel(`${ANTHROPIC_COMPAT_PROVIDER_ID}/${SCRIPTED_MODEL}`);
  const budget = createSlackReadGate({ state: undefined, workspaceId: MENTION.workspaceId, gated: true });
  const service = new SlackReadingService({
    client: { conversations: { history: async (args: unknown) => { slackHistoryCalls.push(args); return { ok: true, messages: [] }; } } } as never,
    gate: {
      ...budget,
      reserve: async (method) => {
        const decision = await budget.reserve(method);
        readBudgetDecisions.push(decision.ok);
        return decision;
      },
    },
    authority: {
      workspaceId: MENTION.workspaceId, managementAgent: false, requesterSlackUserId: 'U_REQUESTER', current: MENTION,
      assertActive: async () => {},
      conversation: async (id) => ({ id, teamId: MENTION.workspaceId, im: false, mpim: false, private: false, member: true, shared: false }),
      isMember: async () => true,
      hasActiveGrant: async (id) => { grantChecks.push(id); return id !== UNGRANTED_CHANNEL; },
    },
    self: { botUserId: 'U_BOT' },
  });
  for (const tool of createSlackReadingTools(async () => service)) useTool(tool);
  return 'Read the channel.';
}

const readsChannel = (channel: string) => (model: Parameters<typeof answers>[0]) => scriptedMessage(model, [
  { type: 'toolCall', id: 'call_read_channel', name: 'read_slack_channel', arguments: { channel } },
], 'toolUse');

async function slackTurn(id: string, probe: typeof FeeProbe = FeeProbe): Promise<{ text: string } | unknown> {
  const runtime = await start({
    agents: [{ agent: probe, name: 'fee-probe' }],
    providers: [registeredPiProvider(ANTHROPIC_COMPAT_PROVIDER_ID)!],
  });
  try {
    const agent = init(probe, { id });
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

/** A GitHub App this process can sign installation-token requests for. */
async function withGithubApp<T>(run: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-run-fees-github-'));
  const dbPath = join(dir, 'state.db');
  const settings = new SqliteSettingsStore(dbPath);
  try {
    await settings.setSetting(GITHUB_SETTING_KEYS.appId, 'run-fees-app');
    await settings.setSetting(GITHUB_SETTING_KEYS.privateKey, String(
      generateKeyPairSync('rsa', { modulusLength: 2_048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
    ));
    return await withEnv({ SLACK_STATE_DB_PATH: dbPath, GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined }, run);
  } finally {
    settings.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withFetch<T>(answer: typeof fetch, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = answer;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

const tiers = (posts: ReadonlyArray<{ tier: string; outcome: string }>) => posts.map(({ tier, outcome }) => `${tier}:${outcome}`);
const admissionAnswers = () => timeline.filter((entry) => entry.startsWith('admit:'));
const replyRun = (env: PlatformEnv | undefined, runKind: RunKind = 'interactive') =>
  (runId: string | undefined): AttemptModelAccess => ({ env, grant: ownKeyGrant(runId!), agentId: 'agent_fees', runKind });

test('an own-key turn with nothing spendable runs no tool, not even a parallel one, and ends out of usage before another request is sent', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t, { admission: 'refused', refuse: 'task' });
  interceptors(t, replyRun(hostedEnv()));
  const { sent } = scriptedProvider([callsTools('read_slack_channel', 'read_slack_channel'), answers]);
  ran.length = 0;

  const failure = await slackTurn('fees-refused');

  assert.ok(failure instanceof AgentPromptFailure, String(failure));
  assert.equal(failure.kind, 'credits-exhausted');
  assert.equal(failure.retryable, false);
  assert.equal(agentFailureText(failure), CREDITS_EXHAUSTED_TEXT);
  assert.equal(sent.length, 1, 'no provider request after the refusal');
  assert.deepEqual(ran, [], 'no tool ran');
  assert.equal(admissions.length, 1);
  assert.deepEqual(tiers(posts), ['chat:posted']);
});

test('parallel qualifying calls wait on one admission, then both run and post one task row', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  const entered: FlueExecutionInterceptor = async (operation, _context, next) => {
    if (operation.type === 'tool') timeline.push(`enter:${operation.toolCallId}`);
    return next();
  };
  interceptors(t, replyRun(hostedEnv()), entered);
  scriptedProvider([callsTools('read_slack_channel', 'read_slack_channel'), answers]);
  ran.length = 0;

  assert.deepEqual(await slackTurn('fees-admission-shared'), { text: 'done' });
  assert.deepEqual(timeline.filter((entry) => /^(enter|admit):/.test(entry)), [
    'enter:call_0_read_slack_channel', 'enter:call_1_read_slack_channel', 'admit:admitted',
  ], 'both calls were waiting when the one admission answered');
  assert.equal(admissions.length, 1);
  assert.deepEqual(ran, ['read_slack_channel', 'read_slack_channel']);
  assert.deepEqual(tiers(posts), ['chat:posted', 'task:posted']);
});

test('an admitted task runs its qualifying call, then posts the task row', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([callsTools('read_slack_channel'), answers]);

  assert.deepEqual(await slackTurn('fees-admitted'), { text: 'done' });
  assert.deepEqual(timeline, ['chat:posted', 'admit:admitted', 'tool:read_slack_channel', 'task:posted']);
  assert.deepEqual(admissions, [{ installationId: INSTALLATION, runId: posts[0]!.runId }], 'the port is asked about the run alone');
});

test('after an own-key post is refused, a parallel qualifying call that starts later never runs', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t, { refuse: 'task' });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  const secondStartsAfterRefusal: FlueExecutionInterceptor = async (operation, _context, next) => {
    if (operation.type === 'tool' && operation.toolCallId === 'call_1_read_slack_channel') {
      while (!posts.some(({ outcome }) => outcome === 'refused')) await tick();
      await tick();
    }
    return next();
  };
  interceptors(t, replyRun(hostedEnv()), secondStartsAfterRefusal);
  const { sent } = scriptedProvider([callsTools('read_slack_channel', 'read_slack_channel'), answers]);
  ran.length = 0;

  const failure = await slackTurn('fees-refused-parallel');

  assert.ok(failure instanceof AgentPromptFailure, String(failure));
  assert.equal(failure.kind, 'credits-exhausted');
  assert.equal(agentFailureText(failure), CREDITS_EXHAUSTED_TEXT);
  assert.equal(sent.length, 1, 'no provider request after the refusal');
  assert.deepEqual(ran, ['read_slack_channel'], 'only the call that started before the refusal ran');
  assert.deepEqual(tiers(posts), ['chat:posted', 'task:refused']);
});

test('a qualifying tool that throws after doing its work posts one task row', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([callsTools('read_slack_list'), answers]);
  ran.length = 0;

  assert.deepEqual(await slackTurn('fees-thrown-after-work'), { text: 'done' });
  assert.deepEqual(ran, ['read_slack_list']);
  assert.deepEqual(tiers(posts), ['chat:posted', 'task:posted']);
});

test('a channel read the Slack read budget refuses posts no task row, and Slack is never called', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([readsChannel(MENTION.channelId), answers]);
  slackHistoryCalls.length = 0;
  readBudgetDecisions.length = 0;
  const preRead = await createSlackReadGate({ state: undefined, workspaceId: MENTION.workspaceId, gated: true }).reserve('conversations.history');
  assert.equal(preRead.ok, true, 'the mention\'s history pre-read spent the minute\'s read');

  assert.deepEqual(await slackTurn('fees-read-refused', ChannelMentionProbe), { text: 'done' });
  assert.deepEqual(readBudgetDecisions, [false], 'the read budget refused the channel read');
  assert.deepEqual(slackHistoryCalls, []);
  assert.deepEqual(admissionAnswers(), ['admit:admitted'], 'the read was admitted, then charged nothing');
  assert.deepEqual(tiers(posts), ['chat:posted']);
});

test('a read of a channel this Agent was never added to posts no task row, and Slack is never called', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([readsChannel(UNGRANTED_CHANNEL), answers]);
  slackHistoryCalls.length = 0;
  readBudgetDecisions.length = 0;
  grantChecks.length = 0;

  assert.deepEqual(await slackTurn('fees-read-ungranted', ChannelMentionProbe), { text: 'done' });
  assert.deepEqual(grantChecks, [UNGRANTED_CHANNEL], 'the Agent\'s channel access refused the read');
  assert.deepEqual(readBudgetDecisions, []);
  assert.deepEqual(slackHistoryCalls, []);
  assert.deepEqual(admissionAnswers(), ['admit:admitted'], 'the read was admitted, then charged nothing');
  assert.deepEqual(tiers(posts), ['chat:posted']);
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
  assert.deepEqual(admissions, [], 'a call that does not qualify asks no admission');
});

test('parallel qualifying tools in one attempt post one task row once they complete', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv()));
  scriptedProvider([callsTools('read_slack_channel', 'read_slack_channel', 'read_slack_thread'), callsTools('read_slack_channel'), answers]);
  ran.length = 0;

  const result = await slackTurn('fees-parallel');

  assert.deepEqual(result, { text: 'done' });
  assert.deepEqual(ran.filter((name) => name === 'read_slack_channel').length, 3);
  assert.deepEqual(tiers(posts), ['chat:posted', 'task:posted']);
  assert.equal(new Set(posts.map(({ runId }) => runId)).size, 1);
  assert.equal(admissions.length, 1, 'one admission for the attempt, across its model turns');
});

test('a scheduled run posts its chat row and never a task row for a tool, even a qualifying one', { timeout: 20_000 }, async (t) => {
  const posts = hostedPort(t);
  interceptors(t, replyRun(hostedEnv(), 'scheduled'));
  scriptedProvider([callsTools('read_slack_channel'), answers]);
  ran.length = 0;

  assert.deepEqual(await slackTurn('fees-scheduled'), { text: 'done' });
  assert.deepEqual(ran, ['read_slack_channel']);
  assert.deepEqual(tiers(posts), ['chat:posted']);
  assert.deepEqual(admissions, []);
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

for (const [admission, how] of [['stall', 'never answers'], ['fail', 'fails']] as const) {
  test(`an admission the host ${how} admits the task: the tool runs and the task row posts`, { timeout: 20_000 }, async (t) => {
    const posts = hostedPort(t, { admission });
    const warn = t.mock.method(console, 'warn', () => undefined);
    interceptors(t, replyRun(hostedEnv()));
    scriptedProvider([callsTools('read_slack_channel'), answers]);
    ran.length = 0;

    assert.deepEqual(await slackTurn(`fees-admission-${admission}`), { text: 'done' });
    assert.equal(admissions.length, 1);
    assert.deepEqual(ran, ['read_slack_channel']);
    assert.deepEqual(tiers(posts), ['chat:posted', 'task:posted']);
    const logged = warn.mock.calls.map(({ arguments: [line] }) => String(line)).filter((line) => line.includes('task_admission_failed'));
    assert.equal(logged.length, 1);
    assert.ok(!logged[0]!.includes(INSTALLATION) && !logged[0]!.includes('sub_'), 'the log names no installation or run');
  });
}

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
      { type: 'tool', toolCallId: 'call_retry', toolName: 'read_slack_list' },
      { instanceId: 'fees-retry', submissionId: 'sub_retry' },
      async () => 'ran',
    ),
  );

  assert.equal(await attempt(), 'ran');
  assert.equal(await attempt(), 'ran');
  assert.deepEqual(tiers(posts), ['chat:posted', 'task:posted', 'chat:duplicate', 'task:duplicate']);
  assert.equal(admissions.length, 2, 'each attempt asks again');
});

test('a channel read whose result has an unexpected shape posts the task row and keeps its result', async (t) => {
  const posts = hostedPort(t);
  const malformed = [null, 'ran', { details: { output: 42 } }, { details: { output: 'not json' } }, { details: { output: 'null' } }];
  for (const [index, result] of malformed.entries()) {
    const modelAccess = createModelAccessInterceptor({
      lookup: async (context) => replyRun(hostedEnv())(context.submissionId),
      installationGrants: async () => [],
    });
    const context = { instanceId: `fees-malformed-${index}`, submissionId: `sub_malformed_${index}` };
    const returned = await modelAccess({ type: 'agent', operationId: 'op_malformed', operationKind: 'prompt' }, context, () =>
      runFeeInterceptor({ type: 'tool', toolCallId: 'call_read', toolName: 'read_slack_channel' }, context, async () => result));
    assert.equal(returned, result);
  }
  assert.deepEqual(posts.filter(({ tier }) => tier === 'task').map(({ runId }) => runId),
    malformed.map((_, index) => `sub_malformed_${index}`));
});

test('the shell posts the task row only when its plan\'s repository grant minted a credential this turn', async (t) => {
  const posts = hostedPort(t);
  t.mock.method(console, 'warn', () => undefined);
  await withGithubApp(async () => {
    for (const [mint, installationId] of [['failed', 70_001], ['minted', 70_002]] as const) {
      const grant: RepositoryGrant = {
        id: `repo_${mint}`, installationId, accountLogin: 'acme', fullName: 'acme/app', enabled: true,
      };
      const access = await withFetch(
        mint === 'failed'
          ? async () => new Response('failed', { status: 500 })
          : async () => Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
        () => resolveRepositoryAccess([grant]),
      );
      assert.equal(access.grants.length, mint === 'failed' ? 0 : 1);
      const modelAccess = createModelAccessInterceptor({
        lookup: async (context) => replyRun(hostedEnv())(context.submissionId),
        installationGrants: async () => [],
      });
      const context = { instanceId: `fees-shell-${mint}`, submissionId: `sub_shell_${mint}` };
      await modelAccess({ type: 'agent', operationId: 'op_shell', operationKind: 'prompt' }, context, () => {
        runtimePlanRepositoryShell(access);
        return runFeeInterceptor({ type: 'tool', toolCallId: 'call_bash', toolName: 'bash' }, context, async () => 'ran');
      });
    }
  });
  assert.deepEqual(posts.map(({ runId, tier }) => `${runId}:${tier}`),
    ['sub_shell_failed:chat', 'sub_shell_minted:chat', 'sub_shell_minted:task']);
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
    { type: 'tool', toolCallId: 'call_read', toolName: 'read_slack_list' }, context, async () => 'ran',
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
    assert.deepEqual(admissions, [], 'nothing asked for admission');
    assert.equal(warn.mock.callCount(), 0, 'nothing tried to post');
  });
}
