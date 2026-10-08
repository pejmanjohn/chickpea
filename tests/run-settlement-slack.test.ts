import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { compileRuntimePlanV2, deriveRuntimePlanInstanceId } from '../src/agents/runtime-plan.ts';
import {
  configureInstallationAdmission,
  resetInstallationAdmissionForTests,
} from '../src/config/installation-admission.ts';
import { installationOwnershipOf, scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  configurePlatformFunding,
  platformCredentialRefId,
  resetPlatformFundingForTests,
  type CreditBackOutcome,
  type CreditBackReason,
  type RunCost,
  type RunRef,
} from '../src/config/platform-funding.ts';
import { closeNodeStateStores, type PlatformEnv } from '../src/config/state-backend.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import {
  AgentPromptFailure,
  AgentRunAborted,
  agentFailureText,
  type AgentDispatchResult,
  type SlackFlueDispatchState,
} from '../src/slack/flue-dispatch.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import { runTurn, type RunTurnOptions } from '../src/slack/run-turn.ts';
import { SlackStatusRegistry } from '../src/slack/status-registry.ts';
import type { FlueSettlementCheckpointV1 } from '../src/slack/turn-job-types.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { DURABLE_RECOVERY_FAILURE_TEXT } from '../src/slack/web-client-presenter.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import type { UsageMicros } from '../src/usage/usage-display.ts';
import { SqliteWorkStore } from '../src/work/store.ts';
import { NO_RUN_FEES } from './helpers/platform-funding.ts';

/**
 * A hosted Slack turn that failed on Chickpea's side is credited back once
 * and says so; one that settled completed shows what it used in its footer.
 * Standalone, and a hosted deployment with no port, are unchanged.
 */

const TEAM = 'TSETTLE1';
const INSTALLATION = 'inst_settlement';
const HOSTED_ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: INSTALLATION });
const CREDITED_BACK = 'Usage for this reply was credited back to your plan.';

const ASSIGNMENT: ResolvedAssignment = {
  workspaceId: TEAM,
  channelId: 'DSETTLE1',
  agentId: 'agent_settlement',
  model: 'local-stub/settlement',
  modelAttribution: { source: 'pinned', providerId: 'local-stub' },
  agent: {
    id: 'agent_settlement', kind: 'user', revision: 1, name: 'Settlement Agent', instructions: 'Answer directly.',
    enabled: true, skills: [], mcpServers: [], apiConnections: [], repositories: [],
  },
};

/** An Agent whose runs Chickpea pays its provider for, from the workspace's plan. */
const PLATFORM_ASSIGNMENT: ResolvedAssignment = {
  ...ASSIGNMENT,
  modelCredential: {
    credentialRefId: platformCredentialRefId('local-stub'), version: 1, providerId: 'local-stub',
    sourceKind: 'platform', label: 'Chickpea', scopeLabel: null, unknownRotation: false,
  },
};

type FailureKind = Extract<FlueSettlementCheckpointV1, { outcome: 'failed' | 'aborted' }>['failureKind'];

const ANSWER: AgentDispatchResult = {
  text: 'Here is the plan.',
  requestedModel: null,
  returnedModel: null,
  reportedUsage: null,
  usageCompleteness: 'not_reported',
};

function dmTurn(messageTs: string): NormalizedSlackTurn {
  return {
    workspaceId: TEAM, channelId: ASSIGNMENT.channelId, channelType: 'im',
    eventId: `Ev_SETTLE_${messageTs}`, text: 'Summarize the plan.', userId: 'UMEMBER1',
    messageTs, threadTs: messageTs, source: 'dm_message', contextMode: 'dm_history',
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
}

async function turnState(t: TestContext): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-settlement-turn-'));
  const statePath = join(directory, 'state.sqlite');
  const keys = ['SLACK_STATE_DB_PATH', 'TAG_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = statePath;
  closeNodeStateStores();
  resetInstallationAdmissionForTests();
  configureInstallationAdmission(async () => 'admitted');
  t.after(() => {
    resetInstallationAdmissionForTests();
    resetPlatformFundingForTests();
    closeNodeStateStores();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    rmSync(directory, { recursive: true, force: true });
  });
  const config = new SqliteConfigStore(statePath, { agents: [] });
  await config.createAgent(ASSIGNMENT.agent);
  const installation = await config.ensureWorkspaceInstallation({
    workspaceId: TEAM, transportMode: 'direct', defaultAgentId: ASSIGNMENT.agentId,
    teamId: TEAM, botUserId: 'UCHICKPEA',
  });
  await config.updateWorkspaceInstallation(TEAM, { health: 'healthy' }, installation.revision);
  config.close();
}

/** A host port that records each credit-back and cost read and answers as told. */
function fundingPort(answers: {
  creditBack?: () => Promise<CreditBackOutcome>;
  runCost?: () => Promise<RunCost>;
} = {}) {
  const creditBacks: Array<{ run: RunRef; reason: CreditBackReason }> = [];
  const runCosts: RunRef[] = [];
  configurePlatformFunding({
    funding: async () => 'customer',
    admit: async () => 'admitted',
    charge: async () => undefined,
    ...NO_RUN_FEES,
    creditBack: async (run, reason) => {
      creditBacks.push({ run, reason });
      return (answers.creditBack ?? (async () => ({ kind: 'credited', usageMicros: 120_000 as UsageMicros })))();
    },
    runCost: async (run) => {
      runCosts.push(run);
      return (answers.runCost ?? (async () => ({ usageMicros: 305_000 as UsageMicros, shown: true })))();
    },
  });
  return { creditBacks, runCosts };
}

/**
 * How the Agent's run ends: its answer, or a failure whose settlement the
 * dispatch recorded before it threw. `thrown` is what the live classifier or
 * the replay raises for that kind.
 */
type Ending =
  | { kind: 'answer' }
  | { kind: 'failure'; recorded: FailureKind; thrown?: AgentPromptFailure; outcome?: 'failed' | 'aborted' }
  | { kind: 'throws'; error: unknown };

let turnCount = 0;

/** Runs one turn on a durable V3 presentation and returns every Slack write. */
async function settledTurn(
  t: TestContext,
  env: PlatformEnv | undefined,
  name: string,
  ending: Ending,
  options: {
    messageTs?: string;
    /** The run's receipt from an earlier attempt, as a replayed turn has. */
    receipt?: boolean;
    /** No durable presentation: the presenter renders the final itself. */
    legacy?: boolean;
    /** Chickpea pays the run's provider; otherwise the workspace's own key does. */
    platformFunded?: boolean;
    extra?: Partial<RunTurnOptions>;
  } = {},
) {
  turnCount += 1;
  const assignment = options.platformFunded ? PLATFORM_ASSIGNMENT : ASSIGNMENT;
  const turn = dmTurn(options.messageTs ?? `18100000${String(turnCount).padStart(2, '0')}.000100`);
  const work = new SqliteWorkStore(':memory:');
  const admitted = await work.admitShadowRun(prepareSlackShadowAdmission({
    turn, assignment, sourceVisibility: 'private', admittedAt: Date.now(),
  }));
  const runId = admitted.run.id;
  const db = openStateDb(':memory:');
  t.after(() => { db.close(); work.close(); });
  const store = new SlackRunPresentationStoreLogic(db);
  const sessionGeneration = Number(turn.messageTs.replace('.', ''));
  store.create({
    schemaVersion: 3, runId, turnJobId: `turn_${runId}`, bindingId: `binding_${runId}`,
    workBindingGeneration: 1, runFencingToken: 0,
    owner: { kind: 'selected_agent', persona: {
      name: 'Settlement Agent', avatarUrl: 'https://chickpea.example/assets/agents/settlement/avatar/1',
      avatarRevision: 1,
    } },
    sessionGeneration,
    currentActivity: {
      kind: 'preparing', action: 'Preparing', object: 'your request', generation: sessionGeneration, sequence: 1,
      operation: { operationId: `activity_${runId}_1`, certainty: 'pending' },
    },
    root: {
      workspaceId: turn.workspaceId, channelId: turn.channelId, threadTs: turn.threadTs, requesterUserId: turn.userId,
    },
  });
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const record = (method: string) => async (input: Record<string, unknown>) => {
    calls.push({ method, input });
    return { ok: true, ts: `${turn.messageTs.split('.')[0]}.000600`, channel: turn.channelId };
  };
  const client = {
    apiCall: async () => ({ ok: true }),
    assistant: { threads: { setStatus: async () => ({ ok: true }), setTitle: async () => ({ ok: true }) } },
    conversations: {
      replies: async () => ({ ok: true, messages: [] }),
      history: async () => ({ ok: true, messages: [] }),
    },
    chat: {
      startStream: record('chat.startStream'), appendStream: record('chat.appendStream'),
      stopStream: record('chat.stopStream'), postMessage: record('chat.postMessage'),
      update: record('chat.update'), delete: record('chat.delete'), postEphemeral: record('chat.postEphemeral'),
    },
  } as unknown as WebClient;
  const state = {
    getRunPresentation: (id: string) => store.get(id),
    getLatestThreadSessionGeneration: (root: Parameters<typeof store.getLatestThreadSessionGeneration>[0]) =>
      store.getLatestThreadSessionGeneration(root),
    transitionRunPresentation: (input: Parameters<typeof store.transition>[0]) => store.transition(input),
    reserveSlackAppend: (workspaceId: string) => store.reserveAppend(workspaceId),
    applySlackAppendCooldown: (workspaceId: string, retryAfterMs: number) =>
      store.applyAppendCooldown(workspaceId, retryAfterMs),
    matchFlueObservation: () => undefined,
  };
  const installation = installationOwnershipOf(env);
  const runtimePlan = compileRuntimePlanV2({
    ...(installation ? { installation } : {}),
    turn, assignment, instructions: 'Answer directly.', memoryEpoch: 1,
  });
  const receipt = () => ({ submissionId: `sub_${name}`, acceptedAt: new Date().toISOString(), uid: `uid_${name}` });
  // runTurn reads only the dispatch's checkpoints; the prompt fake writes them as the real dispatch does.
  const flueDispatch = (options.receipt ? { dispatchReceipt: receipt() } : {}) as SlackFlueDispatchState;
  let prompted = false;
  await runTurn(turn, assignment, env, {
    client, turnId: `turn_${runId}`, statusRegistry: new SlackStatusRegistry(),
    ...(options.legacy ? {} : { runId, presentationState: state }),
    workStore: work, usageRecordingEnabled: false,
    runtimePlanDecision: { runtimePlan, instanceId: deriveRuntimePlanInstanceId(runtimePlan) },
    flueDispatch,
    agentPrompt: async ({ state: dispatch }) => {
      prompted = true;
      dispatch.dispatchReceipt = receipt();
      if (ending.kind === 'answer') return ANSWER;
      if (ending.kind === 'throws') throw ending.error;
      dispatch.flueSettlement = {
        outcome: ending.outcome ?? 'failed', settledAt: Date.now(), failureKind: ending.recorded,
      };
      throw ending.thrown ?? new AgentPromptFailure(ending.recorded as ConstructorParameters<typeof AgentPromptFailure>[0]);
    },
    ...options.extra,
  });
  return Object.assign(calls, { prompted });
}

type Block = Record<string, unknown>;

/** The reply's text as a reader sees it: streamed, or in a content block. */
function visibleTexts(calls: Array<{ input: Record<string, unknown> }>): string[] {
  return calls.flatMap(({ input }) => [
    input.markdown_text,
    ...(Array.isArray(input.chunks) ? (input.chunks as Block[]).map((chunk) => chunk.text) : []),
    ...(Array.isArray(input.blocks) ? (input.blocks as Block[]) : [])
      .filter((block) => block.type === 'markdown' || block.type === 'section')
      .map((block) => typeof block.text === 'string' ? block.text : (block.text as Block | undefined)?.text),
  ]).filter((text): text is string => typeof text === 'string');
}

/** Each footer's segments, as Slack renders them. */
function footers(calls: Array<{ input: Record<string, unknown> }>): string[][] {
  return calls
    .flatMap(({ input }) => Array.isArray(input.blocks) ? input.blocks as Block[] : [])
    .flatMap((block) => block.type === 'context' ? block.elements as Block[] : [])
    .map((element) => String(element.text))
    .filter((text) => text.startsWith('Settlement Agent'))
    .map((text) => text.split(' | '));
}

function failureEnding(recorded: FailureKind, thrown?: AgentPromptFailure): Ending {
  return { kind: 'failure', recorded, ...(thrown ? { thrown } : {}) };
}

const OURS: Array<{ name: string; ending: Ending; error: unknown; reason: CreditBackReason }> = [
  { name: 'provider', ending: failureEnding('provider'), error: new AgentPromptFailure('provider'), reason: 'provider' },
  {
    name: 'invalid_output', ending: failureEnding('invalid-output'),
    error: new AgentPromptFailure('invalid-output'), reason: 'provider',
  },
  { name: 'agent', ending: failureEnding('agent'), error: new AgentPromptFailure('agent'), reason: 'chickpea' },
  // A checkpoint an attached container recorded; the replay raises it as an Agent failure.
  {
    name: 'sandbox', ending: failureEnding('sandbox', new AgentPromptFailure('agent')),
    error: new AgentPromptFailure('agent'), reason: 'sandbox',
  },
  // Anything else that ends a dispatched turn, with no settlement recorded.
  { name: 'unsettled', ending: { kind: 'throws', error: new Error('boom') }, error: new Error('boom'), reason: 'chickpea' },
];

for (const { name, ending, error, reason } of OURS) {
  test(`a platform-funded turn that failed on our side (${name}) is credited back once, as ${reason}, and says so`, async (t) => {
    await turnState(t);
    const port = fundingPort();
    for (const legacy of [false, true]) {
      port.creditBacks.length = 0;
      const calls = await settledTurn(t, HOSTED_ENV, `${name}_${legacy}`, ending, { legacy, platformFunded: true });
      assert.deepEqual(port.creditBacks, [{ run: { installationId: INSTALLATION, runId: `sub_${name}_${legacy}` }, reason }]);
      assert.ok(visibleTexts(calls).includes(`${agentFailureText(error)} ${CREDITED_BACK}`), JSON.stringify(calls));
      assert.deepEqual(port.runCosts, [], 'a failed run reads no cost');
      assert.ok(footers(calls).every((footer) => !footer.some((segment) => segment.startsWith('This reply used'))));
    }
  });
}

const NOT_OURS: Array<{ name: string; ending: Ending; error: AgentPromptFailure }> = [
  { name: 'credits_exhausted', ending: failureEnding('credits-exhausted'), error: new AgentPromptFailure('credits-exhausted') },
  {
    name: 'subscription_reconnect', ending: failureEnding('openai-subscription-reconnect'),
    error: new AgentPromptFailure('openai-subscription-reconnect'),
  },
  {
    name: 'subscription_quota', ending: failureEnding('openai-subscription-quota'),
    error: new AgentPromptFailure('openai-subscription-quota'),
  },
  {
    name: 'subscription_policy', ending: failureEnding('openai-subscription-policy'),
    error: new AgentPromptFailure('openai-subscription-policy'),
  },
  // A workspace limit, like running out of usage, recorded by an attached container.
  {
    name: 'sandbox_session_cap', ending: failureEnding('sandbox-session-cap', new AgentPromptFailure('agent')),
    error: new AgentPromptFailure('agent'),
  },
];

for (const { name, ending, error } of NOT_OURS) {
  test(`a hosted turn that failed for a reason not ours (${name}) credits nothing back and says nothing of it`, async (t) => {
    await turnState(t);
    const port = fundingPort();
    const calls = await settledTurn(t, HOSTED_ENV, name, ending, { platformFunded: true });
    assert.deepEqual(port.creditBacks, []);
    assert.ok(visibleTexts(calls).includes(agentFailureText(error)), 'the failure is still told, as before');
    assert.equal(JSON.stringify(calls).includes(CREDITED_BACK), false);
  });
}

test('on the workspace\'s own key a provider failure is the customer\'s: nothing is credited back', async (t) => {
  await turnState(t);
  const port = fundingPort();
  for (const kind of ['provider', 'invalid-output'] as const) {
    const calls = await settledTurn(t, HOSTED_ENV, `own_key_${kind}`, failureEnding(kind));
    assert.ok(visibleTexts(calls).includes(agentFailureText(new AgentPromptFailure(kind))), 'the failure is still told');
    assert.equal(JSON.stringify(calls).includes(CREDITED_BACK), false);
  }
  assert.deepEqual(port.creditBacks, []);

  const agent = await settledTurn(t, HOSTED_ENV, 'own_key_agent', failureEnding('agent'));
  assert.deepEqual(port.creditBacks, [{ run: { installationId: INSTALLATION, runId: 'sub_own_key_agent' }, reason: 'chickpea' }]);
  assert.ok(visibleTexts(agent).includes(`${agentFailureText(new AgentPromptFailure('agent'))} ${CREDITED_BACK}`));
});

const STOP_FACTS = { stopperUserId: 'USTOPPER', unread: 0, pullRequests: [], windingDown: false };

test('a requester\'s stop credits nothing back and shows no cost', async (t) => {
  await turnState(t);
  const port = fundingPort();
  const calls = await settledTurn(t, HOSTED_ENV, 'stopped', {
    kind: 'failure', recorded: 'agent', outcome: 'aborted', thrown: new AgentRunAborted(),
  }, { platformFunded: true, extra: { stopEnding: { finish: async () => STOP_FACTS } } });
  assert.ok(visibleTexts(calls).some((text) => text.startsWith('Stopped by <@USTOPPER>.')), JSON.stringify(calls));
  assert.deepEqual(port.creditBacks, []);
  assert.deepEqual(port.runCosts, []);
  assert.equal(JSON.stringify(calls).includes(CREDITED_BACK), false);
  assert.equal(JSON.stringify(calls).includes('This reply used'), false);
});

test('a suspended installation\'s failed turn credits nothing back and posts nothing', async (t) => {
  await turnState(t);
  configureInstallationAdmission(async () => 'refused');
  const port = fundingPort();
  const calls = await settledTurn(t, HOSTED_ENV, 'suspended', failureEnding('provider'), { platformFunded: true });
  assert.equal(calls.prompted, true, 'the run was dispatched before the refusal ended it');
  assert.deepEqual([...calls], []);
  assert.deepEqual(port.creditBacks, []);
});

test('a run the host already credited back says so; one with nothing to credit says nothing and still delivers', async (t) => {
  await turnState(t);
  const duplicate = fundingPort({ creditBack: async () => ({ kind: 'duplicate', usageMicros: 120_000 as UsageMicros }) });
  const repeated = await settledTurn(t, HOSTED_ENV, 'duplicate', failureEnding('provider'), { platformFunded: true });
  assert.equal(duplicate.creditBacks.length, 1);
  assert.ok(visibleTexts(repeated).includes(`${agentFailureText(new AgentPromptFailure('provider'))} ${CREDITED_BACK}`));

  const nothing = fundingPort({ creditBack: async () => ({ kind: 'nothing' }) });
  const empty = await settledTurn(t, HOSTED_ENV, 'nothing', failureEnding('provider'), { platformFunded: true });
  assert.equal(nothing.creditBacks.length, 1);
  assert.ok(visibleTexts(empty).includes(agentFailureText(new AgentPromptFailure('provider'))), 'the failure is delivered');
  assert.equal(JSON.stringify(empty).includes(CREDITED_BACK), false);
});

test('a host that answers too late holds the failure reply for no more than the budget, with no sentence', async (t) => {
  await turnState(t);
  t.mock.method(console, 'warn', () => undefined);
  const port = fundingPort({
    creditBack: () => new Promise((resolve) => {
      setTimeout(() => resolve({ kind: 'credited', usageMicros: 120_000 as UsageMicros }), 5_000).unref();
    }),
  });
  const startedAt = performance.now();
  const calls = await settledTurn(t, HOSTED_ENV, 'late', failureEnding('provider'), { platformFunded: true });
  const elapsedMs = performance.now() - startedAt;
  t.diagnostic(`failure reply with a host that never answers in time: ${Math.round(elapsedMs)} ms`);
  assert.equal(port.creditBacks.length, 1);
  assert.ok(visibleTexts(calls).includes(agentFailureText(new AgentPromptFailure('provider'))), 'the failure is delivered');
  assert.equal(JSON.stringify(calls).includes(CREDITED_BACK), false);
  assert.ok(elapsedMs >= 1_900 && elapsedMs < 4_000, `elapsed ${elapsedMs} ms`);
});

test('a completed hosted turn ends its footer with what it used, when the host shows it', async (t) => {
  await turnState(t);
  const shown = fundingPort();
  for (const legacy of [false, true]) {
    shown.runCosts.length = 0;
    const calls = await settledTurn(t, HOSTED_ENV, `cost_${legacy}`, { kind: 'answer' }, { legacy });
    assert.deepEqual(shown.runCosts, [{ installationId: INSTALLATION, runId: `sub_cost_${legacy}` }]);
    const [footer, ...others] = footers(calls);
    assert.deepEqual(others, [], JSON.stringify(calls));
    // 305,000 usage micros is 30.5 cents, rounded half up.
    assert.equal(footer?.at(-1), 'This reply used $0.31');
    assert.deepEqual(shown.creditBacks, []);
  }

  const hidden = fundingPort({ runCost: async () => ({ usageMicros: 305_000 as UsageMicros, shown: false }) });
  const below = await settledTurn(t, HOSTED_ENV, 'cost_hidden', { kind: 'answer' });
  assert.equal(hidden.runCosts.length, 1);
  assert.deepEqual(footers(below), [['Settlement Agent', 'local-stub/settlement', 'Configure']]);
});

test('a recovery notice replayed for a dispatched turn shows no cost and is not credited back by the turn', async (t) => {
  await turnState(t);
  const port = fundingPort();
  const calls = await settledTurn(t, HOSTED_ENV, 'replayed', { kind: 'answer' }, {
    receipt: true,
    extra: { replayText: DURABLE_RECOVERY_FAILURE_TEXT, replayTerminalResult: 'failure' },
  });
  assert.equal(calls.prompted, false);
  assert.ok(visibleTexts(calls).includes(DURABLE_RECOVERY_FAILURE_TEXT), JSON.stringify(calls));
  assert.deepEqual(port.runCosts, []);
  assert.deepEqual(port.creditBacks, []);
  assert.equal(JSON.stringify(calls).includes('This reply used'), false);
});

const STANDALONE_FOOTER = 'Settlement Agent | local-stub/settlement | Configure';
const STANDALONE_FAILURE =
  'I reached the Slack thread, but the model provider call failed before completion. I did not expose provider error details in Slack.';

test('standalone, a port that would credit back and show a cost changes nothing Slack receives', async (t) => {
  await turnState(t);
  for (const [name, ending] of [['answer', { kind: 'answer' }], ['failure', failureEnding('provider')]] as const) {
    for (const env of [undefined, {}]) {
      const port = fundingPort();
      const withPort = await settledTurn(t, env, `standalone_${name}`, ending, { messageTs: '1810009001.000100' });
      resetPlatformFundingForTests();
      const withoutPort = await settledTurn(t, env, `standalone_${name}`, ending, { messageTs: '1810009001.000100' });
      assert.deepEqual(withPort, withoutPort);
      assert.deepEqual(port.creditBacks, []);
      assert.deepEqual(port.runCosts, []);
      assert.deepEqual(footers(withPort).map((footer) => footer.join(' | ')), [STANDALONE_FOOTER]);
      if (name === 'failure') assert.ok(visibleTexts(withPort).includes(STANDALONE_FAILURE), JSON.stringify(withPort));
      else assert.ok(visibleTexts(withPort).includes(ANSWER.text));
    }
  }
});

test('a hosted deployment with no port asks nothing, says nothing of usage, and logs no warning', async (t) => {
  await turnState(t);
  const warn = t.mock.method(console, 'warn');
  const failed = await settledTurn(t, HOSTED_ENV, 'portless_failure', failureEnding('provider'));
  const answered = await settledTurn(t, HOSTED_ENV, 'portless_answer', { kind: 'answer' });
  assert.ok(visibleTexts(failed).includes(STANDALONE_FAILURE));
  assert.deepEqual(footers(answered), [[...STANDALONE_FOOTER.split(' | ')]]);
  assert.equal(JSON.stringify([failed, answered]).includes(CREDITED_BACK), false);
  const logged = warn.mock.calls.map(({ arguments: [line] }) => String(line));
  assert.equal(logged.some((line) => line.includes('platform_funding')), false, logged.join('\n'));
});
