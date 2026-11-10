/**
 * A test run's instance, as the installation's state store alone addresses
 * it on a deployment serving many installations: dispatch, abort, one
 * settlement read that never waits, the host erase, and the credit back.
 */
import { AgentInstanceNotFoundError, AgentRunError, init } from '@flue/runtime';
import { replyFromSnapshot } from '@flue/runtime/internal';

import { CHICKPEA_TEST_TURN_AGENT_NAME } from '../agents/names.ts';
import { parseRuntimePlanV2, type RuntimePlanV2 } from '../agents/runtime-plan.ts';
import { testRunReadServices, type TestRunToolCall } from '../agents/test-run-plan.ts';
import { TEST_TURN_ATTEMPT_ENDED_MESSAGE } from '../agents/test-turn-limits.ts';
import {
  InstallationContextError,
  requireInstallationScope,
  splitInstallationObjectName,
  type InstallationScope,
} from '../config/installation-scope.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import {
  AgentObjectBindingUnavailableError,
  agentObjectBindingName,
  agentObjectNamespace,
  agentObjectRoute,
  agentViewBase,
  observeAgentSettlementBounded,
  readAgentView,
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
  const bindingName = agentObjectBindingName(target.agentName);
  const binding = agentObjectNamespace(env, bindingName);
  if (!binding) throw new AgentObjectBindingUnavailableError(bindingName);
  const route = agentObjectRoute(binding, target.instanceId);
  const caughtUp = new Error('caught up');
  let settlement: ObservedSettlement;
  try {
    settlement = await observeAgentSettlementBounded(route, target, { sleep: () => Promise.reject(caughtUp) });
  } catch (error) {
    if (error === caughtUp) return undefined;
    throw error;
  }
  if (settlement.outcome !== 'completed') return settlement;
  const view = await readAgentView(route, target, `${agentViewBase(target.agentName, target.instanceId)}?view=history`);
  const history = await view.json() as AgentConversationSnapshot;
  return {
    ...settlement,
    completed: { reply: replyFromSnapshot(history, target.submissionId), history },
  };
}

/** A settled submission as the run's outcome: the reply with the services it read, or why it failed. */
export function testRunSettlement(
  settled: SettledAgentSubmission,
  submissionId: string,
  plan: RuntimePlanV2 | undefined,
): Exclude<TestRunInstanceSettlement, { kind: 'unsettled' }> {
  const reply = settled.completed?.reply;
  const text = reply ? withoutImages(withSlackDateFallbacks(reply.text)).trim() : '';
  if (settled.outcome === 'completed' && text) {
    const metadata = parseChickpeaResponseMetadata(reply?.metadata?.[CHICKPEA_RESPONSE_METADATA_KEY]);
    return {
      kind: 'answered',
      reply: text,
      read: plan ? testRunReadServices(plan, returnedToolCalls(settled.completed!.history, submissionId)) : [],
      ...(metadata ? { metadata } : {}),
    };
  }
  if (settled.outcome === 'aborted' || errorType(settled.error) === 'submission_timeout') {
    return { kind: 'failed', failure: 'deadline', creditBack: 'timeout' };
  }
  // The model kept calling tools past the run's limit: its own doing, so nothing is credited back.
  if ((settled.error as { meta?: { reason?: unknown } } | undefined)?.meta?.reason === TEST_TURN_ATTEMPT_ENDED_MESSAGE
    || errorMessages(settled.error).some((message) => message.includes(TEST_TURN_ATTEMPT_ENDED_MESSAGE))) {
    return { kind: 'failed', failure: 'failed', creditBack: null };
  }
  const failure = classifyFlueRunFailure(new AgentRunError({
    outcome: 'failed',
    submissionId,
    ...(settled.error === undefined ? {} : { cause: settled.error }),
  }));
  if (typeof failure === 'object') {
    return failure.kind === 'daily_limit'
      ? { kind: 'failed', failure: 'daily_limit', resumesAt: failure.resumesAt, creditBack: null }
      : { kind: 'failed', failure: 'out_of_usage', creditBack: null };
  }
  if (failure === 'credits-exhausted') return { kind: 'failed', failure: 'out_of_usage', creditBack: null };
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

/** The submission's tool calls that returned a result; failed calls read nothing. */
function returnedToolCalls(history: AgentConversationSnapshot, submissionId: string): TestRunToolCall[] {
  return history.messages
    .filter((message) => message.role === 'assistant' && message.submissionId === submissionId)
    .flatMap((message) => message.parts.flatMap((part) =>
      part.type === 'dynamic-tool' && part.state === 'output-available'
        ? [{ toolName: part.toolName, input: part.input }]
        : []));
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

/** An error's message and its causes', at most five deep. Flue prefixes a failed operation's message with the operation. */
function errorMessages(error: unknown): string[] {
  const messages: string[] = [];
  for (let current = error, depth = 0; typeof current === 'object' && current !== null && depth < 5; depth += 1) {
    const { message, cause } = current as { message?: unknown; cause?: unknown };
    if (typeof message === 'string') messages.push(message);
    current = cause;
  }
  return messages;
}

/**
 * The reply with nothing a client would fetch on its own: each Markdown or
 * HTML image becomes its alt text, or its address as plain text when it has
 * none, so a prompt injection cannot get a URL loaded without a click. Code
 * is rewritten too, since a client may not split code where this would. Any
 * `![` or `<img` left over, or formed by a rewrite, is escaped.
 */
export function withoutImages(markdown: string): string {
  const definitions = new Map<string, string>();
  for (const [, label, address] of markdown.matchAll(/^ {0,3}\[([^\]\n]+)\]:[ \t]*<?([^\s>]+)>?/gm)) {
    definitions.set(referenceLabel(label!), address!);
  }
  return markdownImagesAsText(markdown, definitions)
    .replace(/<img\b[^>]{0,2000}>/gi, (tag) => htmlAttribute(tag, 'alt') || htmlAttribute(tag, 'src'))
    .replaceAll('![', '!\\[')
    .replace(/<img/gi, '&lt;img');
}

/** One pass: an image's alt is kept as written, nested images in it included, for the final escape. */
function markdownImagesAsText(text: string, definitions: ReadonlyMap<string, string>): string {
  const closes = matchingBrackets(text);
  let shown = '';
  let at = 0;
  for (let start = text.indexOf('![', at); start >= 0; start = text.indexOf('![', at)) {
    shown += text.slice(at, start);
    at = start + 2;
    const altEnd = closes.get(start + 1);
    if (altEnd === undefined) {
      shown += '![';
      continue;
    }
    const alt = text.slice(start + 2, altEnd).trim();
    let address = definitions.get(referenceLabel(alt)) ?? '';
    at = altEnd + 1;
    const end = closes.get(at);
    if (end !== undefined && text[at] === '(') {
      const destination = text.slice(at + 1, end).trim();
      address = destination.startsWith('<') ? destination.slice(1).split('>')[0]! : destination.split(/\s/)[0]!;
      at = end + 1;
    } else if (end !== undefined) {
      address = definitions.get(referenceLabel(text.slice(at + 1, end) || alt)) ?? '';
      at = end + 1;
    }
    shown += alt || address;
  }
  return shown + text.slice(at);
}

/** Each `[` and `(` with the index of the bracket that closes it, nested pairs and escaped brackets skipped. */
function matchingBrackets(text: string): Map<number, number> {
  const closes = new Map<number, number>();
  const squares: number[] = [];
  const rounds: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') index += 1;
    else if (char === '[') squares.push(index);
    else if (char === '(') rounds.push(index);
    else if (char === ']' || char === ')') {
      const opener = (char === ']' ? squares : rounds).pop();
      if (opener !== undefined) closes.set(opener, index);
    }
  }
  return closes;
}

function referenceLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

function htmlAttribute(tag: string, name: string): string {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}
