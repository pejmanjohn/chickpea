import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

import { ErrorCode, type WebClient } from '@slack/web-api';
import ts from 'typescript';

import { CfTurnJobsForRunner } from '../src/config/cf-state-proxies.ts';
import { objectInstallationEnv } from '../src/config/installation-scope.ts';
import { RunnerBootMarks } from '../src/observability/runtime-latency.ts';
import type { SlackPresentationStatePort } from '../src/slack/agent-view-presentation.ts';
import type { SlackInstallationExecutionContext, SlackRunSpeaker } from '../src/slack/installation-execution.ts';
import { drainSlackPresentationRepairs } from '../src/slack/presentation-repair.ts';
import {
  type SlackPresentationMutation,
  type SlackPresentationOwner,
  SlackRunPresentationStoreLogic,
  type SlackRunPresentationV3,
} from '../src/slack/run-presentations.ts';
import { SlackStatusRegistry } from '../src/slack/status-registry.ts';
import { ThreadRunnerJobStore } from '../src/slack/thread-runner-jobs.ts';
import { createRunnerSupersedeState, runnerLoopScheduler } from '../src/slack/thread-runner-loop.ts';
import { DoSqlStateDb } from '../src/state/do-state-db.ts';
import { ResidencyHold, residencyHoldMs } from '../src/state/residency-hold.ts';
import { FakeObjectRestoreContext, FakeObjectStorage } from './helpers/installation-objects.ts';

/**
 * On hosted Chickpea the thread runner executes almost every turn, and it
 * repairs its own turns' presentations: a long reply cut off partway, a
 * status message left behind. A run its Agent app's own bot spoke went out in
 * places Chickpea's bot is not, so only that bot can finish it. The runner
 * class is transpiled whole and its alarm run over a fake object's storage;
 * the alarm loop is replaced by one that runs the runner's repair.
 */

const TEAM = 'TTENANT1';
const MAIN_BOT = 'xoxb-main-bot';
const AGENT_BOT = 'xoxb-agent-bot';
const AGENT_BOT_USER = 'UAGENTBOT';
/** The Owner's DM with Support's own app, where Chickpea's bot is not. */
const APP_DM = 'D1';
const OWN_RUN: SlackRunSpeaker = { agentId: 'agent_support', speaker: { kind: 'own_bot', botUserId: AGENT_BOT_USER } };
const STATUS_TS = '1900000000.000200';
const PART_TWO = 'Part two of the refunds plan.';

interface SlackCall { method: string; token: string; channel: unknown; text?: unknown; username?: unknown }

/** A Slack client for one bot token. As in Slack, Chickpea's bot is refused in the app's own DM. */
function slackClient(token: string, calls: SlackCall[]): WebClient {
  const call = (method: string) => async (input: Record<string, unknown> = {}) => {
    calls.push({ method, token, channel: input.channel, ...(input.text ? { text: input.text } : {}), ...(input.username ? { username: input.username } : {}) });
    if (token === MAIN_BOT && input.channel === APP_DM) {
      throw Object.assign(new Error('An API error occurred: channel_not_found'), {
        code: ErrorCode.PlatformError,
        data: { ok: false, error: 'channel_not_found' },
      });
    }
    return method === 'chat.postMessage' ? { ok: true, ts: '1900000000.000900' } : { ok: true, messages: [] };
  };
  return {
    apiCall: (method: string, input: Record<string, unknown>) => call(method)(input),
    assistant: { threads: { setStatus: call('assistant.threads.setStatus') } },
    chat: { postMessage: call('chat.postMessage'), delete: call('chat.delete'), update: call('chat.update') },
    conversations: { replies: call('conversations.replies') },
  } as unknown as WebClient;
}

function advance(store: SlackRunPresentationStoreLogic, runId: string, mutation: SlackPresentationMutation): void {
  const current = store.get(runId) as SlackRunPresentationV3;
  const result = store.transition({
    runId,
    workBindingGeneration: current.workBindingGeneration,
    runFencingToken: current.runFencingToken,
    expectedProjectionVersion: current.projectionVersion,
    expectedStreamState: current.stream.state,
    mutation,
  });
  assert.equal(result.outcome, 'applied', mutation.kind);
}

/**
 * A run in `channelId` whose reply was cut off after its first part, with
 * its status still showing as a message: the state a runner's repair takes up.
 */
function cutOffReply(store: SlackRunPresentationStoreLogic, runId: string, channelId: string, owner: SlackPresentationOwner): void {
  store.create({
    schemaVersion: 3, runId, turnJobId: `turn_${runId}`, bindingId: `binding_${runId}`, workBindingGeneration: 1, runFencingToken: 0,
    owner, sessionGeneration: 1,
    currentActivity: {
      kind: 'checking', action: 'Checking', object: 'the refunds', generation: 1, sequence: 1,
      operation: { operationId: `activity_${runId}`, certainty: 'pending' },
    },
    root: { workspaceId: TEAM, channelId, threadTs: '1900000000.000100', requesterUserId: 'U1' },
  });
  advance(store, runId, { kind: 'select_activity_projection', surface: 'message' });
  advance(store, runId, { kind: 'record_activity_receipt', operationId: `activity_${runId}`, certainty: 'acknowledged', messageTs: STATUS_TS });
  advance(store, runId, { kind: 'record_terminal_delivery_intent', operationId: `terminal_${runId}`, result: 'answer' });
  advance(store, runId, {
    kind: 'record_continuation_plan', parts: [PART_TWO], closing: { footer: { agentName: 'Support', agentId: 'agent_support' } },
  });
  advance(store, runId, { kind: 'record_terminal_delivery_receipt', operationId: `terminal_${runId}`, certainty: 'acknowledged' });
}

function statePort(store: SlackRunPresentationStoreLogic): SlackPresentationStatePort {
  return {
    getRunPresentation: (runId) => store.get(runId),
    getLatestThreadSessionGeneration: (root) => store.getLatestThreadSessionGeneration(root),
    transitionRunPresentation: (input) => store.transition(input),
    reserveSlackAppend: (workspaceId) => store.reserveAppend(workspaceId),
    applySlackAppendCooldown: (workspaceId, retryAfterMs) => store.applyAppendCooldown(workspaceId, retryAfterMs),
    matchFlueObservation: () => undefined,
  };
}

const runnerSource = ts.createSourceFile(
  'thread-runner.ts',
  readFileSync(new URL('../src/slack/thread-runner.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const runnerClass = runnerSource.statements.find((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === 'SlackThreadRunner');
assert.ok(runnerClass);

/**
 * Runs the runner's repair once, over `storage`, against a state store
 * `stub`; returns every Slack call each bot made. The resolver answers a run
 * whose speaker is its app's own bot with that app's client, as
 * withAgentAppExecution does, and every other run with Chickpea's.
 */
async function runnerRepair(storage: FakeObjectStorage, stub: object): Promise<{ calls: SlackCall[]; asked: Array<SlackRunSpeaker | undefined> }> {
  const calls: SlackCall[] = [];
  const asked: Array<SlackRunSpeaker | undefined> = [];
  const context = (token: string, botUserId: string): SlackInstallationExecutionContext => ({
    workspaceId: TEAM, transportMode: 'direct', sharedAppReads: false, botUserId, client: slackClient(token, calls),
  });
  const Runner = vm.runInNewContext(
    ts.transpileModule(`${runnerClass!.getText(runnerSource).replace(/^export /, '')}\nSlackThreadRunner`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      Date, console, Map, Promise, Error,
      DurableObject: class {
        constructor(readonly ctx: unknown, readonly env: unknown) {}
      },
      RunnerBootMarks: class extends RunnerBootMarks {
        constructor() {
          super(Date.now, { info: () => undefined });
        }
      },
      objectInstallationEnv, ThreadRunnerJobStore, DoSqlStateDb, SlackStatusRegistry, SlackRunPresentationStoreLogic,
      createRunnerSupersedeState, runnerLoopScheduler, ResidencyHold, residencyHoldMs,
      // The state store, over the stub this test hands it.
      CfTurnJobsForRunner, tagStateStub: () => stub,
      cloudflareWorkerVersionId: () => undefined,
      deploymentTenancy: () => 'single',
      runnerPresentationState: ({ local }: { local: SlackRunPresentationStoreLogic }) => ({ state: statePort(local) }),
      cacheSlackInstallationExecutionContexts: (resolve: unknown) => resolve,
      withAgentAppExecution: () => async (_workspaceId: string, run?: SlackRunSpeaker) => {
        asked.push(run);
        return run?.speaker?.kind === 'own_bot' ? context(AGENT_BOT, AGENT_BOT_USER) : context(MAIN_BOT, 'UBOT');
      },
      getSettingsStore: () => ({}), getConfigStore: () => ({}), createPlatformProductTelemetry: () => ({}), sandboxTurnReaders: () => ({}),
      runnerTurnJobsPort: () => ({}), runnerSlackPort: () => ({}),
      RunnerStops: class {},
      runTurn: () => undefined, startEarlyJudgment: () => undefined,
      MAX_TURN_DRAIN_BATCH: 10,
      drainSlackPresentationRepairs,
      sanitizeError: (error: unknown) => String(error),
      // The alarm loop, reduced to the runner's repair.
      runThreadRunnerAlarm: async ({ repair }: { repair(): Promise<unknown> }) => {
        await repair();
        return { ran: 0 };
      },
    },
  ) as new (ctx: unknown, env: unknown) => { runAlarm(): Promise<unknown> };
  const runner = new Runner(new FakeObjectRestoreContext(storage, { name: `${TEAM}:${APP_DM}:1900000000.000100:owner-i1` }), {});
  await new Promise((resolve) => setImmediate(resolve));
  await runner.runAlarm();
  return { calls, asked };
}

function presentations(storage: FakeObjectStorage): SlackRunPresentationStoreLogic {
  return new SlackRunPresentationStoreLogic(new DoSqlStateDb(storage.asDurableObjectStorage()));
}

const OWN_BOT_OWNER: SlackPresentationOwner = { kind: 'agent_app', agentName: 'Support' };

test("the runner finishes a cut-off reply in an app Agent's own DM with the app's bot, and that bot removes its status message", async () => {
  const storage = new FakeObjectStorage();
  cutOffReply(presentations(storage), 'run_own', APP_DM, OWN_BOT_OWNER);
  const stub = { slackOwnBotRun: async (id: string) => ({ ok: true, value: id === 'turn_run_own' ? OWN_RUN : null }) };
  const { calls, asked } = await runnerRepair(storage, stub);
  assert.deepEqual(asked, [OWN_RUN], "the state store names the run its app's own bot spoke");
  assert.deepEqual(calls.filter((call) => call.token === MAIN_BOT), [], "Chickpea's bot, which is not in that DM, is never tried");
  assert.deepEqual(calls.filter((call) => call.method === 'chat.postMessage').map((call) => [call.token, call.channel, call.text, call.username]),
    [[AGENT_BOT, APP_DM, PART_TWO, undefined]], 'the rest of the reply, with no name override on the app\'s token');
  assert.deepEqual(calls.filter((call) => call.method === 'chat.delete').map((call) => [call.token, call.channel]),
    [[AGENT_BOT, APP_DM]], 'the status message');
  const repaired = presentations(storage).get('run_own') as SlackRunPresentationV3;
  assert.equal(repaired.continuations?.state, 'delivered');
  assert.equal(repaired.activityProjection.state, 'cleared');
  assert.equal(repaired.repairRequired, false);
});

test('a state store on older code names no run, so the runner repairs as before, with Chickpea\'s bot', async () => {
  const storage = new FakeObjectStorage();
  cutOffReply(presentations(storage), 'run_own', APP_DM, OWN_BOT_OWNER);
  const { calls, asked } = await runnerRepair(storage, {});
  assert.deepEqual(asked, [undefined]);
  assert.ok(calls.length > 0);
  assert.deepEqual(calls.filter((call) => call.token !== MAIN_BOT), []);
  assert.equal((presentations(storage).get('run_own') as SlackRunPresentationV3).repairRequired, true, 'still owed, as before');
});

test("a user-group Agent's cut-off reply is finished by Chickpea's bot under the Agent's name, as before", async () => {
  const storage = new FakeObjectStorage();
  const persona: SlackPresentationOwner = {
    kind: 'selected_agent',
    persona: { name: 'Finance', avatarUrl: 'https://chickpea.example/assets/agents/finance/avatar/1', avatarRevision: 1 },
  };
  cutOffReply(presentations(storage), 'run_finance', 'C1', persona);
  const stub = { slackOwnBotRun: async () => ({ ok: true, value: null }) };
  const { calls, asked } = await runnerRepair(storage, stub);
  assert.deepEqual(asked, [undefined]);
  assert.deepEqual(calls.filter((call) => call.method === 'chat.postMessage').map((call) => [call.token, call.channel, call.text, call.username]),
    [[MAIN_BOT, 'C1', PART_TWO, 'Finance']]);
  assert.equal((presentations(storage).get('run_finance') as SlackRunPresentationV3).repairRequired, false);
});
