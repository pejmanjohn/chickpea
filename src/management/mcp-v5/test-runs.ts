/**
 * try_agent_once and get_test_run (U6a §6): one read-only run of a new Agent
 * on the first question saved when it was created, as the caller, posting
 * nowhere. Every check is here; the state store admits, dispatches, settles
 * and erases. Loaded only when a card calls one of them.
 */
import { randomBytes } from 'node:crypto';

import type { z } from 'zod';

import { resolveAgentRunPlan } from '../../agents/run-plan-resolution.ts';
import { compileTestRunPlan, untestableConnections } from '../../agents/test-run-plan.ts';
import type { TestTurnInitialData } from '../../agents/test-turn.ts';
import { slackTenantInstructions } from '../../agents/shared-prefix-layout.ts';
import { installationOwnershipOf } from '../../config/installation-scope.ts';
import { resolveModelCredentialAttribution } from '../../config/model-credential-refs.ts';
import { agentMemoryPromptBlock } from '../../memory/runtime.ts';
import { escapeSlackControlCharacters } from '../../slack/message-format.ts';
import { TestRunUsageRecorder } from '../../usage/test-run-usage.ts';
import type { TestRunStore, TestRunView } from '../test-run-types.ts';
import { ManagementError } from '../types.ts';
import { readAgentRun, resolveAgentModel, type AgentRunReading } from './agent-run.ts';
import { admissionChecks, agentAdminFix, modelChecks } from './check.ts';
import { fail, fiveZeroCode, McpToolFailure, type McpErrorFix } from './conventions.ts';
import type { FiveZeroDeps } from './reads.ts';
import type * as schemas from './schemas.ts';

type Output = z.infer<typeof schemas.testRunOutput>;

/** What every result says of the run, whatever its status. */
export const TEST_RUN_NOTE = 'A test run: it runs once, read-only. It makes only read requests and sends nothing to Slack.';

/** A tool call waits this long for the run to settle, then returns `running`. */
export const TEST_RUN_WAIT_MS = 20_000;
const TEST_RUN_POLL_MS = 1_000;

export interface TestRunTiming {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_TIME: TestRunTiming = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function tryAgentOnce(
  deps: FiveZeroDeps,
  input: z.infer<typeof schemas.tryAgentOnceInput>,
  timing: TestRunTiming = REAL_TIME,
): Promise<Output> {
  const store = await testRunStore(deps);
  const reading = await readTestedAgent(deps, input.agentId);
  const { agent, actor } = reading;
  const caller = { organizationId: actor.organizationId, actorMembershipId: actor.membershipId };
  const ask = await reading.stores.config.getAgentFirstAsk?.(agent.id) ?? null;
  // A retry gets the run it started, whatever has changed since.
  const replayed = await store.replay({ ...caller, idempotencyKey: input.idempotencyKey });
  if (replayed) {
    if (replayed.agentId !== agent.id) keyReused();
    return result(await settle(store, { ...caller, runToken: replayed.runToken }, replayed, timing), ask ?? '', agent.name, timing);
  }
  if (!ask) {
    fail('not_found', `${agent.name} has no saved first question to test.`, {
      nextStep: 'Tell the person to ask it in Slack instead.',
    });
  }
  const admission = admissionChecks(deps, reading).find(({ status }) => status === 'failing');
  if (admission) {
    fail('not_allowed', `You can't message ${agent.name} in Slack yet, so it can't be tested as you.`,
      admission.fix ? { fix: admission.fix } : {});
  }
  const [model] = await modelChecks(deps, reading);
  if (model?.status === 'failing') {
    fail('model_unavailable', `${agent.name} can't run right now. ${model.detail}`, model.fix ? { fix: model.fix } : {});
  }
  const run = await resolveTestRun(deps, reading, ask, input.idempotencyKey);
  const started = await store.start(run.request);
  switch (started.kind) {
    case 'in_progress':
      return fail('in_progress', 'Another test run is going in this workspace. Try again in a minute.');
    case 'daily_limit':
      return fail('usage_limit', dailyLimitText(started.resumesAt, timing.now()));
    case 'key_reused':
      return keyReused();
    case 'expired':
      return expired();
    default:
      return result(
        await settle(store, { ...caller, runToken: started.run.runToken }, started.run, timing),
        ask,
        agent.name,
        timing,
      );
  }
}

export async function getTestRun(
  deps: FiveZeroDeps,
  input: z.infer<typeof schemas.getTestRunInput>,
  timing: TestRunTiming = REAL_TIME,
): Promise<Output> {
  const store = await testRunStore(deps);
  const context = await deps.context();
  const query = { organizationId: context.organizationId, actorMembershipId: context.membershipId, runToken: input.runToken };
  const first = await store.observe(query) ?? expired();
  // Its Agent, as the caller can still manage it, by a light read: a card polls this. One they cannot reads as gone.
  const { agent, stores } = await deps.service.agentReader(context, first.agentId).catch((error: unknown) => {
    if (error instanceof ManagementError && ['not_found', 'not_allowed'].includes(fiveZeroCode(error.code))) expired();
    throw error;
  });
  const ask = await stores.config.getAgentFirstAsk?.(agent.id) ?? '';
  return result(await settle(store, query, first, timing), ask, agent.name, timing);
}

/** Node and a standalone Cloudflare deployment serve none: the run's instance is erased with the host erase. */
async function testRunStore(deps: FiveZeroDeps): Promise<TestRunStore> {
  return await deps.service.testRunStore(await deps.context()) ??
    fail('temporarily_unavailable', 'Test runs aren\'t available on this workspace yet.', {
      nextStep: 'Tell the person to ask the Agent in Slack instead.',
    });
}

/** The Agent, read as check_agent reads it, for the caller in a direct message. */
async function readTestedAgent(deps: FiveZeroDeps, agentId: string): Promise<AgentRunReading> {
  try {
    return await readAgentRun(deps, { agentId });
  } catch (error) {
    if (!(error instanceof McpToolFailure && error.error.code === 'not_found')) throw error;
    // One they may use but not change is named; any other reads as missing.
    const snapshot = await deps.service.inspectWorkspace(await deps.context());
    const usable = snapshot.usableAgents?.find(({ id }) => id === agentId);
    if (usable) fail('not_allowed', `Only someone who can change ${usable.name} can test it.`);
    throw error;
  }
}

/**
 * The run as the caller's direct message would run it, as ingress resolves
 * it: the model policy, then the credential with its use registered, then
 * the real route. Refuses a connection the caller has yet to set up, and one
 * the narrowed plan cannot read through.
 */
async function resolveTestRun(deps: FiveZeroDeps, reading: AgentRunReading, ask: string, idempotencyKey: string) {
  const { stores, agent, workspaceId, actor } = reading;
  const { assignment } = await resolveAgentModel(reading);
  if (!assignment || !stores.settings) {
    fail('model_unavailable', `${agent.name} can't run right now. This deployment cannot resolve its model.`);
  }
  const credential = await resolveModelCredentialAttribution(assignment.model, stores.env, stores.settings);
  const admitted = credential ? { ...assignment, modelCredential: credential } : assignment;
  const parts = await resolveAgentRunPlan({
    assignment: admitted,
    model: assignment.model,
    workspaceId,
    connections: { actorMembershipId: actor.membershipId, config: stores.config },
    env: stores.env,
    settings: stores.settings,
    roles: stores.config,
    // A test run never opens a coding workspace, so none is decided.
    decideCodingWorkspace: async () => ({ capability: 'unavailable', unavailableFallback: false }),
  });
  // Every personal connection is offered; one is pending only while the caller has no ready account for it.
  const pending = parts.connectionAuthorizations?.find(({ accounts }) => !accounts.some(({ lifecycle }) => lifecycle === 'ready'));
  if (pending) {
    const template = (await stores.config.listConnectionAccounts(workspaceId))
      .find(({ id }) => id === pending.templateAccountId);
    const service = template?.label ?? pending.providerId;
    // As check_agent gives it: reconnect_service's link for a connection the Agent lists, else Admin.
    const fix: McpErrorFix | undefined = reading.snapshotAgent.connections?.some(({ id }) => id === pending.templateAccountId)
      ? { label: `Finish setting up ${service}`, tool: 'reconnect_service', arguments: { agentId: agent.id, connectionId: pending.templateAccountId } }
      : agentAdminFix(deps, reading, 'Finish its setup in Admin');
    fail('needs_setup', `Finish setting up ${service} first, then try again.`, fix ? { fix } : {});
  }
  const [untestable] = untestableConnections(parts.connections);
  if (untestable) {
    const fix = agentAdminFix(deps, reading, 'Open the Agent in Admin');
    fail('not_testable',
      `None of ${untestable.account.label}'s tools are marked as reads, so a test run can't use it. Ask ${agent.name} in Slack instead.`,
      fix ? { fix } : {});
  }
  const memory = await stores.memory?.getAgentMemory(agent.id);
  const memoryBlock = memory ? agentMemoryPromptBlock(memory.body) : undefined;
  const testRunId = `testrun_${token(20)}`;
  const coordinateToken = token(20).slice(0, 26);
  const installation = installationOwnershipOf(stores.env);
  const plan = compileTestRunPlan(parts, {
    workspaceId,
    actorMembershipId: actor.membershipId,
    testRunId,
    coordinateToken,
    ...(installation ? { installation } : {}),
    instructions: slackTenantInstructions(admitted),
    memoryEpoch: Math.max(1, (memory?.revision ?? 0) + 1),
  });
  const askedAt = Date.now();
  const timezone = reading.person.slackUserId
    ? await stores.slackMemberTimezone?.(reading.person.slackUserId)
    : undefined;
  const initialData: TestTurnInitialData = {
    runtimePlan: plan,
    ...(memoryBlock ? { memoryBlock } : {}),
    requester: { name: reading.person.name ?? 'The person', timezone: validTimezone(timezone), askedAt },
  };
  return {
    request: {
      run: {
        testRunId,
        runToken: `tr_${token(20)}`,
        coordinateToken,
        organizationId: actor.organizationId,
        actorMembershipId: actor.membershipId,
        agentId: agent.id,
        idempotencyKey,
        usage: TestRunUsageRecorder.admission({
          testRunId,
          startedAt: askedAt,
          workspaceId,
          agentId: agent.id,
          agentLabel: agent.name,
          requesterMembershipId: actor.membershipId,
          requestedModel: assignment.model,
          ...(admitted.modelAttribution ? { modelAttribution: admitted.modelAttribution } : {}),
          credentialRefId: credential?.credentialRefId ?? null,
          credentialVersion: credential?.version ?? null,
          ...(stores.env ? { platformEnv: stores.env } : {}),
        }),
      },
      // The ask as a person's message, never a host signal: no envelope in it is read.
      message: testRunMessage(ask),
      initialData: initialData as TestTurnInitialData & Record<string, unknown>,
    },
  };
}

/** The first ask as a Slack person's text reaches the model: plain, with Slack's control characters escaped. */
export function testRunMessage(ask: string): string {
  return escapeSlackControlCharacters(ask);
}

/** Polls the state store, which runs the settle step on each read, for up to 20 seconds. */
async function settle(
  store: TestRunStore,
  query: { organizationId: string; actorMembershipId: string; runToken: string },
  first: TestRunView,
  timing: TestRunTiming,
): Promise<TestRunView> {
  const until = timing.now() + TEST_RUN_WAIT_MS;
  let view = first;
  while ((view.status === 'admitted' || view.status === 'running') && timing.now() + TEST_RUN_POLL_MS <= until) {
    await timing.sleep(TEST_RUN_POLL_MS);
    view = await store.observe(query) ?? expired();
  }
  return view;
}

function result(view: TestRunView, ask: string, agentName: string, timing: TestRunTiming): Output {
  const status = view.status === 'answered' ? 'answered' : view.status === 'failed' ? 'failed' : 'running';
  return {
    status,
    runToken: view.runToken,
    ask,
    ...(view.result?.reply ? { reply: view.result.reply } : {}),
    ...(view.result?.read && status === 'answered' ? { read: view.result.read } : {}),
    ...(status === 'failed' ? { problem: problemText(view, agentName, timing.now()) } : {}),
    note: TEST_RUN_NOTE,
  };
}

function problemText(view: TestRunView, agentName: string, now: number): string {
  switch (view.failure) {
    case 'deadline':
      return `The test run took too long and was stopped. Ask ${agentName} in Slack instead.`;
    case 'out_of_usage':
      return 'This workspace is out of usage, so the test run couldn\'t finish.';
    case 'daily_limit':
      return dailyLimitText(view.result?.resumesAt ?? now, now);
    default:
      return `The test run didn't finish. Ask ${agentName} in Slack instead.`;
  }
}

/** Rounded up to whole hours until the limit resumes. */
export function dailyLimitText(resumesAt: number, now: number): string {
  const hours = Math.max(1, Math.ceil((resumesAt - now) / 3_600_000));
  return `Test runs for this workspace have reached today's limit. They start again in about ${hours} ${hours === 1 ? 'hour' : 'hours'}.`;
}

function validTimezone(timezone: string | undefined): string {
  if (!timezone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
    return timezone;
  } catch {
    return 'UTC';
  }
}

/** RFC 4648 base32, lowercase, from `bytes` random bytes. */
function token(bytes: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of randomBytes(bytes)) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return output;
}

function expired(): never {
  return fail('not_found', 'This test run has expired.', { nextStep: 'Tell the person to ask the Agent in Slack instead.' });
}

function keyReused(): never {
  return fail('key_reused', 'That idempotencyKey was already used for another test run.', {
    nextStep: 'Send a new idempotencyKey.',
  });
}
