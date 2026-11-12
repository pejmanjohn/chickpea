/**
 * A test run's instance, as the installation's state store alone addresses
 * it on a deployment serving many installations: dispatch, abort, one
 * settlement read that never waits, the host erase, and the credit back.
 */
import { AgentInstanceNotFoundError, AgentRunError, init } from '@flue/runtime';
import { replyFromSnapshot } from '@flue/runtime/internal';

import { CHICKPEA_TEST_TURN_AGENT_NAME } from '../agents/names.ts';
import { parseRuntimePlanV2, type RuntimePlanV2 } from '../agents/runtime-plan.ts';
import { practiceReply, practiceSteps, type PracticeToolCall } from '../agents/practice-steps.ts';
import { installationRefusesWork } from '../config/installation-admission.ts';
import { CREDITS_EXHAUSTED_CODE } from '../config/platform-funding.ts';
import {
  InstallationContextError,
  requireInstallationScope,
  splitInstallationObjectName,
  type InstallationScope,
} from '../config/installation-scope.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import {
  agentObjectBindingName,
  readAgentSubmissionBounded,
  type AgentConversationSnapshot,
  type BoundedObservationTarget,
  type ObservedSettlement,
} from '../slack/bounded-agent-observation.ts';
import { classifyFlueRunFailure } from '../slack/agent-failure.ts';
import { withSlackDateFallbacks } from '../slack/message-format.ts';
import { CHICKPEA_RESPONSE_METADATA_KEY, parseChickpeaResponseMetadata } from '../usage/response-metadata.ts';
import { creditBackFailedRun, creditBackReason, hostedRun, planFunding } from '../usage/run-settlement.ts';
import type { ObjectEraseResult, ObjectHostRequest } from './object-host.ts';
import type { TestRunInstancePort, TestRunInstanceSettlement } from './test-run-lifecycle.ts';

/**
 * `agent`: the agent registered as `chickpea-test-turn-v1`, loaded at the
 * first dispatch because it carries the turn runtime. A workerd fixture
 * passes a probe registered under that name.
 */
export function cloudflareTestRunInstancePort(
  env: PlatformEnv,
  agent: () => Promise<Parameters<typeof init>[0]> = async () => (await import('../agents/test-turn.ts')).ChickpeaTestTurn,
): TestRunInstancePort {
  const scope = requireInstallationScope(env);
  if (!scope) throw new Error('Test runs run only on a deployment serving many installations.');
  const handle = async (instanceId: string) => {
    assertOwnInstance(scope, instanceId);
    return init(await agent(), { id: instanceId });
  };
  return {
    async dispatch(instanceId, dispatch) {
      const receipt = await (await handle(instanceId)).dispatch(dispatch);
      return { submissionId: receipt.submissionId };
    },
    async abort(instanceId) {
      try {
        await (await handle(instanceId)).abort();
      } catch (error) {
        if (!(error instanceof AgentInstanceNotFoundError)) throw error;
      }
    },
    async settlement(instanceId, submissionId, plan) {
      assertOwnInstance(scope, instanceId);
      let settled: SettledAgentSubmission | undefined;
      try {
        settled = await readSettledAgentSubmissionBounded(env, {
          agentName: CHICKPEA_TEST_TURN_AGENT_NAME,
          instanceId,
          submissionId,
        });
      } catch (error) {
        if (error instanceof AgentInstanceNotFoundError) return { kind: 'not_found' };
        throw error;
      }
      if (!settled) return { kind: 'unsettled' };
      return testRunSettlement(settled, submissionId, readPlan(plan));
    },
    erase: (instanceId) => eraseTestTurnInstance(env, scope, instanceId),
    async creditBack(submissionId, reason) {
      // As a direct message's failure: while the installation is suspended or ended, nothing is credited back.
      if (await installationRefusesWork(env)) return;
      await creditBackFailedRun(hostedRun(env, submissionId), reason);
    },
  };
}

/** A settled submission, as one pass over its instance's stream reads it. */
export interface SettledAgentSubmission extends ObservedSettlement {
  /** A completed submission's reply and the conversation it closes. */
  completed?: { reply: ReturnType<typeof replyFromSnapshot>; history: AgentConversationSnapshot };
}

/**
 * One pass over a submission's instance that never waits: undefined while it
 * runs, else its settlement and, when it completed, its reply and history.
 * An instance with no stream throws `AgentInstanceNotFoundError`.
 */
export async function readSettledAgentSubmissionBounded(
  env: Record<string, unknown> | undefined,
  target: Pick<BoundedObservationTarget, 'agentName' | 'instanceId' | 'submissionId'>,
): Promise<SettledAgentSubmission | undefined> {
  const settled = await readAgentSubmissionBounded(env, target, { history: true });
  if (!settled?.history) return settled;
  const { history, ...settlement } = settled;
  return { ...settlement, completed: { reply: replyFromSnapshot(history, target.submissionId), history } };
}

/** A settled submission as the run's outcome: the reply with its steps, or why it failed. */
export function testRunSettlement(
  settled: SettledAgentSubmission,
  submissionId: string,
  plan: RuntimePlanV2 | undefined,
): Exclude<TestRunInstanceSettlement, { kind: 'unsettled' }> {
  const reply = settled.completed?.reply;
  const text = reply ? withSlackDateFallbacks(reply.text).trim() : '';
  if (settled.outcome === 'completed' && text) {
    const metadata = parseChickpeaResponseMetadata(reply?.metadata?.[CHICKPEA_RESPONSE_METADATA_KEY]);
    return {
      kind: 'answered',
      ...practiceReply(text),
      ...plan ? practiceSteps(plan, submissionToolCalls(settled.completed!.history, submissionId)) : { read: [], skills: [], steps: [] },
      ...(metadata ? { metadata } : {}),
    };
  }
  if (settled.outcome === 'aborted' || errorType(settled.error) === 'submission_timeout') {
    return { kind: 'failed', failure: 'deadline', creditBack: 'timeout' };
  }
  const failure = classifyFlueRunFailure(new AgentRunError({
    outcome: 'failed',
    submissionId,
    ...(settled.error === undefined ? {} : { cause: settled.error }),
  }));
  if (typeof failure === 'object') {
    return { kind: 'failed', failure: failure.kind === 'daily_limit' ? 'daily_limit' : 'out_of_usage', funding: failure, creditBack: null };
  }
  if (failure === 'credits-exhausted') {
    return { kind: 'failed', failure: 'out_of_usage', funding: { kind: CREDITS_EXHAUSTED_CODE }, creditBack: null };
  }
  return { kind: 'failed', failure: 'failed', creditBack: creditBackReason(failure, { funding: planFunding(plan) }) };
}

/**
 * Erases one test run's instance with the host erase, after checking that
 * its name carries this installation's scope, as `objectStub` does.
 */
export async function eraseTestTurnInstance(
  env: Record<string, unknown>,
  scope: InstallationScope,
  instanceId: string,
): Promise<void> {
  assertOwnInstance(scope, instanceId);
  const bindingName = agentObjectBindingName(CHICKPEA_TEST_TURN_AGENT_NAME);
  const namespace = env[bindingName] as { idFromName(name: string): unknown; get(id: unknown): unknown } | undefined;
  if (typeof namespace?.idFromName !== 'function' || typeof namespace.get !== 'function') {
    throw new Error(`Durable Object binding ${bindingName} is unavailable.`);
  }
  const stub = namespace.get(namespace.idFromName(instanceId)) as {
    chickpeaHostErase(request: ObjectHostRequest): Promise<ObjectEraseResult>;
  };
  await stub.chickpeaHostErase({ installationId: scope.installationId });
}

function assertOwnInstance(scope: InstallationScope, instanceId: string): void {
  if (splitInstallationObjectName(instanceId).scope?.installationId !== scope.installationId) {
    throw new InstallationContextError('installation_context_mismatch', 'The object belongs to another installation.');
  }
}

/** The submission's tool calls that settled, in order: each with its output, or the error the Agent saw. */
function submissionToolCalls(history: AgentConversationSnapshot, submissionId: string): PracticeToolCall[] {
  return history.messages
    .filter((message) => message.role === 'assistant' && message.submissionId === submissionId)
    .flatMap((message) => message.parts.flatMap((part): PracticeToolCall[] => {
      if (part.type !== 'dynamic-tool') return [];
      if (part.state === 'output-available') return [{ toolName: part.toolName, input: part.input, output: part.output }];
      if (part.state === 'output-error') return [{ toolName: part.toolName, input: part.input, error: part.errorText }];
      return [];
    }));
}

function readPlan(plan: unknown): RuntimePlanV2 | undefined {
  try {
    return plan === undefined ? undefined : parseRuntimePlanV2(plan);
  } catch {
    return undefined;
  }
}

function errorType(error: unknown): string | undefined {
  const type = typeof error === 'object' && error !== null ? (error as { type?: unknown }).type : undefined;
  return typeof type === 'string' ? type : undefined;
}
