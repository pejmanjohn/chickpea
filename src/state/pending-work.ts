import { init } from '@flue/runtime';

import { REFUSED_SKIP } from '../routines/execution.ts';
import { abortSlackThreadAgent, type SlackThreadAgentTarget } from '../slack/flue-dispatch.ts';
import type { TagStateStores } from './tag-state-stores.ts';

/**
 * Stopping the work an installation's state store would otherwise start or
 * deliver on its own: what a host runs after restoring an installation's
 * objects to an earlier moment (while it is suspended), so that resuming it
 * never answers a message twice or delivers a stale result.
 */

/** What the state store stopped. Each count is of records this call changed. */
export interface StatePendingWorkCancellation {
  readonly alarmCleared: true;
  /** Undelivered Slack turns parked for the operator, never run or delivered. */
  readonly turns: number;
  /** Queued, admitting or running routine occurrences skipped, with no notice. */
  readonly routineRuns: number;
  /** Routine recovery notices closed unsent. */
  readonly routineNotices: number;
  /** Management receipts closed unsent. */
  readonly managementReceipts: number;
  /** Flue instances of dispatched, unsettled turns and attempts asked to abort. */
  readonly agentsStopped: number;
  /** Those whose abort failed; the installation's admission check still refuses their model calls. */
  readonly agentsNotStopped: number;
}

/** A dispatched Flue submission to abort, by its agent. */
export type AgentStopTarget =
  | { readonly kind: 'slack_agent'; readonly target: SlackThreadAgentTarget }
  | { readonly kind: 'routine_agent'; readonly target: { instanceId: string; uid?: string } };

/**
 * Park every pending turn, skip every unfinished routine occurrence and
 * close every undelivered notice and receipt in one installation's state
 * store. Returns the counts and the Flue submissions to abort. Safe to repeat.
 */
export function cancelStatePendingWork(
  stores: Pick<TagStateStores, 'turnJobs' | 'routines' | 'management'>,
  at: number,
): Omit<StatePendingWorkCancellation, 'alarmCleared' | 'agentsStopped' | 'agentsNotStopped'> & {
  readonly agents: readonly AgentStopTarget[];
} {
  const turns = stores.turnJobs.cancelPendingWork();
  // Skipped exactly as a refused installation's occurrences are: the host
  // cancels only while it keeps the installation suspended, and a member's
  // run history reads the same as for any refusal.
  const routines = stores.routines.cancelPendingWork(at, REFUSED_SKIP);
  const managementReceipts = stores.management.cancelPendingReceipts(at);
  return {
    turns: turns.turns,
    routineRuns: routines.runs,
    routineNotices: routines.notices,
    managementReceipts,
    agents: [
      ...turns.dispatched.map((target) => ({ kind: 'slack_agent' as const, target })),
      ...routines.dispatched.map((target) => ({ kind: 'routine_agent' as const, target })),
    ],
  };
}

/**
 * Ask each dispatched Flue submission to abort, as a stop does. Flue's abort
 * covers the running submission and any queued behind it, so a later turn in
 * the thread never runs a restored one first. Best effort: one that fails is
 * counted, never thrown.
 */
export async function stopCancelledAgents(
  agents: readonly AgentStopTarget[],
  abort: (agent: AgentStopTarget) => Promise<void> = abortCancelledAgent,
): Promise<{ stopped: number; notStopped: number }> {
  let stopped = 0;
  for (const agent of agents) {
    try {
      await bounded(abort(agent), AGENT_ABORT_TIMEOUT_MS);
      stopped += 1;
    } catch {
      console.warn('[chickpea] a cancelled submission could not be stopped; its installation\'s admission refuses its model calls');
    }
  }
  return { stopped, notStopped: agents.length - stopped };
}

/** One abort is a single request to the agent's object; one that hangs is counted as not stopped. */
const AGENT_ABORT_TIMEOUT_MS = 10_000;

function bounded(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The abort was not answered in time.')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function abortCancelledAgent(agent: AgentStopTarget): Promise<void> {
  if (agent.kind === 'slack_agent') {
    await abortSlackThreadAgent(agent.target);
    return;
  }
  // Loaded only here, as routine execution does: it carries the whole turn runtime.
  const { ChickpeaRoutineExecution } = await import('../agents/routine-execution.ts');
  await init(ChickpeaRoutineExecution, {
    id: agent.target.instanceId,
    ...(agent.target.uid ? { uid: agent.target.uid } : {}),
  }).abort();
}
