import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { compileRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import {
  createLedgerSlackRunHandler,
  type LedgerSlackTurnExecutor,
} from '../src/slack/ledger-turn-driver.ts';
import { AgentPromptFailure } from '../src/slack/flue-dispatch.ts';
import { SlackIdentityUnavailableError } from '../src/slack/identity-execution.ts';
import { TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import {
  SlackRunPresentationStoreLogic,
  type SlackPresentationMutation,
  type SlackRunPresentationV1,
} from '../src/slack/run-presentations.ts';
import type { SlackPresentationStatePort } from '../src/slack/agent-view-presentation.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { opaqueId } from '../src/work/admission.ts';
import { ShadowWorkLifecycle } from '../src/work/lifecycle.ts';
import { prepareSubmitRun, type SubmitRunInput } from '../src/work/submit-run.ts';
import { WorkStoreLogic } from '../src/work/store.ts';
import type { WorkStore } from '../src/work/types.ts';

const NOW = 1_940_000_000_000;

test('delivery-only recovery replays the exact persisted Slack payload without executing again', async () => {
  let clock = NOW;
  const db = openStateDb(':memory:');
  try {
    const work = new WorkStoreLogic(db, { now: () => clock });
    const turns = new TurnJobStoreLogic(db, () => clock);
    const admission = work.admitShadowRun(prepareSubmitRun(submission('delivery-retry')));
    const first = work.claimNextInteractiveRun({
      ownerId: 'first_worker', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: clock,
    });
    assert.equal(first?.phase, 'execute');
    const payload = {
      channel: 'C_canary',
      thread_ts: '100.001',
      text: 'Persisted answer',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Persisted answer' } }],
    };
    const lifecycle = lifecycleFor(work, admission.run.id, first!.fencingToken, () => ++clock);
    await lifecycle.prepareExecution('Prepared input');
    await lifecycle.markInvoked();
    await lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
    const attemptId = await lifecycle.beforeDelivery({
      method: 'slack_chat_post_message',
      approvedOutput: 'Persisted answer',
      renderedPayload: JSON.stringify({ method: 'slack_chat_post_message', payload }),
    });
    await lifecycle.afterDelivery({
      attemptId,
      outcome: 'failed',
      safeFailureCode: 'slack_rate_limited',
    });
    work.releaseRunLease({
      runId: admission.run.id,
      ownerId: first!.leaseOwner,
      fencingToken: first!.fencingToken,
      outcome: 'requeue',
      reasonCode: 'confirmed_delivery_failure',
      releasedAt: ++clock,
    });
    turns.enqueue(turnJob(admission.run.id));
    turns.recordAttempt('turn_delivery-retry', 1);
    const second = work.claimNextInteractiveRun({
      ownerId: 'second_worker', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: ++clock,
    });
    assert.equal(second?.phase, 'delivery');

    const sent: unknown[] = [];
    let executions = 0;
    const handler = createLedgerSlackRunHandler({
      work: work as unknown as WorkStore,
      turns,
      client: {
        chat: {
          postMessage: async (actual: unknown) => {
            sent.push(actual);
            return { ok: true, channel: 'C_canary', ts: '100.002' };
          },
        },
      } as unknown as WebClient,
      executeTurn: (async () => {
        executions += 1;
      }) as LedgerSlackTurnExecutor,
      now: () => ++clock,
    });
    assert.deepEqual(await handler(second!), { kind: 'completed' });
    assert.equal(executions, 0);
    assert.deepEqual(sent, [payload]);
    assert.equal(work.getRun(admission.run.id)?.status, 'settled');
    assert.equal(work.getRun(admission.run.id)?.deliveryStatus, 'delivered');
    assert.equal(turns.getPendingByRunId(admission.run.id), undefined);
  } finally {
    db.close();
  }
});

test('an ambiguous persisted Slack retry enters recovery and cannot be claimed again', async () => {
  let clock = NOW;
  const db = openStateDb(':memory:');
  try {
    const work = new WorkStoreLogic(db, { now: () => clock });
    const turns = new TurnJobStoreLogic(db, () => clock);
    const admission = work.admitShadowRun(prepareSubmitRun(submission('delivery-unknown')));
    const first = work.claimNextInteractiveRun({
      ownerId: 'first_worker', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: clock,
    })!;
    const lifecycle = lifecycleFor(work, admission.run.id, first.fencingToken, () => ++clock);
    await lifecycle.prepareExecution('Prepared input');
    await lifecycle.markInvoked();
    await lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
    const payload = { channel: 'C_canary', thread_ts: '100.001', text: 'Persisted answer' };
    const attemptId = await lifecycle.beforeDelivery({
      method: 'slack_chat_post_message',
      approvedOutput: 'Persisted answer',
      renderedPayload: JSON.stringify({ method: 'slack_chat_post_message', payload }),
    });
    await lifecycle.afterDelivery({ attemptId, outcome: 'failed', safeFailureCode: 'confirmed' });
    work.releaseRunLease({
      runId: admission.run.id, ownerId: first.leaseOwner, fencingToken: first.fencingToken,
      outcome: 'requeue', reasonCode: 'confirmed_delivery_failure', releasedAt: ++clock,
    });
    turns.enqueue(turnJob(admission.run.id, 'delivery-unknown'));
    turns.recordAttempt('turn_delivery-unknown', 1);
    const second = work.claimNextInteractiveRun({
      ownerId: 'second_worker', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: ++clock,
    })!;
    const handler = createLedgerSlackRunHandler({
      work: work as unknown as WorkStore,
      turns,
      client: {
        chat: { postMessage: async () => { throw new Error('socket closed after send'); } },
      } as unknown as WebClient,
      now: () => ++clock,
    });
    assert.deepEqual(await handler(second), { kind: 'completed' });
    assert.equal(work.getRun(admission.run.id)?.status, 'recovery_required');
    assert.equal(work.getRun(admission.run.id)?.deliveryStatus, 'unknown');
    assert.equal(turns.getPendingByRunId(admission.run.id), undefined);
    assert.equal(work.claimNextInteractiveRun({
      ownerId: 'third_worker', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: ++clock,
    }), undefined);
  } finally {
    db.close();
  }
});

test('delivery recovery never repeats a stream start without a proven Slack coordinate', async () => {
  let clock = NOW;
  const db = openStateDb(':memory:');
  try {
    const work = new WorkStoreLogic(db, { now: () => clock });
    const turns = new TurnJobStoreLogic(db, () => clock);
    const presentations = new SlackRunPresentationStoreLogic(db, () => clock);
    const admission = work.admitShadowRun(prepareSubmitRun(submission('stream-start-unknown')));
    const first = work.claimNextInteractiveRun({
      ownerId: 'first_worker', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: clock,
    })!;
    const lifecycle = lifecycleFor(work, admission.run.id, first.fencingToken, () => ++clock);
    await lifecycle.prepareExecution('Prepared input');
    await lifecycle.markInvoked();
    await lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
    const attemptId = await lifecycle.beforeDelivery({
      method: 'slack_chat_stream',
      approvedOutput: 'Persisted answer',
      renderedPayload: JSON.stringify({
        method: 'slack_chat_stream',
        start: { channel: 'C_canary', thread_ts: '100.001', markdown_text: 'Persisted answer' },
        stop: {},
      }),
    });
    assert.ok(attemptId);
    let presentation = presentations.create({
      runId: admission.run.id,
      turnJobId: 'turn_stream-start-unknown',
      bindingId: admission.binding.id,
      workBindingGeneration: admission.binding.generation,
      runFencingToken: first.fencingToken,
      root: {
        workspaceId: 'T_canary', channelId: 'C_canary', threadTs: '100.001',
        requesterUserId: 'U_member',
      },
    });
    presentation = transitionPresentation(
      presentations,
      presentation,
      { kind: 'stream_start_intent' },
    );
    work.releaseRunLease({
      runId: admission.run.id, ownerId: first.leaseOwner, fencingToken: first.fencingToken,
      outcome: 'requeue', reasonCode: 'delivery_pending', releasedAt: ++clock,
    });
    turns.enqueue(turnJob(admission.run.id, 'stream-start-unknown'));
    const second = work.claimNextInteractiveRun({
      ownerId: 'second_worker', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: ++clock,
    })!;
    let slackCalls = 0;
    const handler = createLedgerSlackRunHandler({
      work: work as unknown as WorkStore,
      turns,
      client: { chat: { startStream: async () => { slackCalls += 1; } } } as unknown as WebClient,
      presentationState: presentationPort(presentations, turns),
      now: () => ++clock,
    });

    assert.deepEqual(await handler(second), {
      kind: 'recovery_required',
      reasonCode: 'slack_presentation_effect_unresolved',
    });
    assert.equal(slackCalls, 0);
    assert.equal(presentation.stream.state, 'starting');
  } finally {
    db.close();
  }
});

test('delivery recovery finalizes one exact known stream and its presentation', async () => {
  let clock = NOW;
  const db = openStateDb(':memory:');
  try {
    const work = new WorkStoreLogic(db, { now: () => clock });
    const turns = new TurnJobStoreLogic(db, () => clock);
    const presentations = new SlackRunPresentationStoreLogic(db, () => clock);
    const admission = work.admitShadowRun(prepareSubmitRun(submission('known-stream-recovery')));
    const first = work.claimNextInteractiveRun({
      ownerId: 'first_worker', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: clock,
    })!;
    const lifecycle = lifecycleFor(work, admission.run.id, first.fencingToken, () => ++clock);
    await lifecycle.prepareExecution('Prepared input');
    await lifecycle.markInvoked();
    await lifecycle.settleExecution({ outcome: 'succeeded', rawStatus: 'flue_succeeded' });
    const attemptId = await lifecycle.beforeDelivery({
      method: 'slack_chat_stream_resume',
      approvedOutput: 'Persisted answer',
      renderedPayload: JSON.stringify({
        method: 'slack_chat_stream_resume',
        channel: 'C_canary', ts: '100.002', stop: { chunks: [] },
        terminalTaskStatus: 'complete',
      }),
    });
    await lifecycle.afterDelivery({
      attemptId,
      outcome: 'failed',
      safeFailureCode: 'slack_stream_finalize_failed',
    });
    let presentation = presentations.create({
      runId: admission.run.id,
      turnJobId: 'turn_known-stream-recovery',
      bindingId: admission.binding.id,
      workBindingGeneration: admission.binding.generation,
      runFencingToken: first.fencingToken,
      root: {
        workspaceId: 'T_canary', channelId: 'C_canary', threadTs: '100.001',
        requesterUserId: 'U_member',
      },
    });
    for (const mutation of [
      { kind: 'freeze_progressive_eligibility', eligibility: {
        allowed: false, reason: 'other' as const,
      } } as const,
      { kind: 'stream_start_intent' } as const,
      { kind: 'stream_started', messageTs: '100.002', flue: {
        instanceId: 'instance_recovery', submissionId: 'submission_recovery',
      } } as const,
      { kind: 'close_stream', outcome: 'terminal_only' as const } as const,
      { kind: 'mark_finalizing' } as const,
    ]) {
      presentation = transitionPresentation(presentations, presentation, mutation);
    }
    work.releaseRunLease({
      runId: admission.run.id, ownerId: first.leaseOwner, fencingToken: first.fencingToken,
      outcome: 'requeue', reasonCode: 'confirmed_delivery_failure', releasedAt: ++clock,
    });
    turns.enqueue(turnJob(admission.run.id, 'known-stream-recovery'));
    const second = work.claimNextInteractiveRun({
      ownerId: 'second_worker', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: ++clock,
    })!;
    const calls: unknown[] = [];
    const handler = createLedgerSlackRunHandler({
      work: work as unknown as WorkStore,
      turns,
      client: {
        chat: { stopStream: async (input: unknown) => { calls.push(input); } },
      } as unknown as WebClient,
      presentationState: presentationPort(presentations, turns),
      now: () => ++clock,
    });

    assert.deepEqual(await handler(second), { kind: 'completed' });
    assert.deepEqual(calls, [{ channel: 'C_canary', ts: '100.002', chunks: [] }]);
    assert.equal(work.getRun(admission.run.id)?.deliveryStatus, 'delivered');
    assert.equal(presentations.get(admission.run.id)?.stream.state, 'finalized');
  } finally {
    db.close();
  }
});

test('a pre-submit executor failure is safely requeued instead of quarantined', async () => {
  let clock = NOW;
  const db = openStateDb(':memory:');
  try {
    const work = new WorkStoreLogic(db, { now: () => clock });
    const turns = new TurnJobStoreLogic(db, () => clock);
    const admission = work.admitShadowRun(prepareSubmitRun(submission('pre-submit')));
    turns.enqueue(turnJob(admission.run.id, 'pre-submit'));
    const claim = work.claimNextInteractiveRun({
      ownerId: 'worker', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: clock,
    })!;
    const handler = createLedgerSlackRunHandler({
      work: work as unknown as WorkStore,
      turns,
      client: {} as WebClient,
      executeTurn: (async () => { throw new Error('hydration unavailable'); }) as LedgerSlackTurnExecutor,
      now: () => ++clock,
    });
    assert.deepEqual(await handler(claim), {
      kind: 'requeue',
      reasonCode: 'ledger_turn_failed_before_submit',
    });
  } finally {
    db.close();
  }
});

test('a transient ledger identity preflight requeues without quarantining its TurnJob', async () => {
  let clock = NOW;
  const db = openStateDb(':memory:');
  try {
    const work = new WorkStoreLogic(db, { now: () => clock });
    const turns = new TurnJobStoreLogic(db, () => clock);
    const admission = work.admitShadowRun(prepareSubmitRun(submission('identity-preflight')));
    turns.enqueue(turnJob(admission.run.id, 'identity-preflight'));
    const claim = work.claimNextInteractiveRun({
      ownerId: 'worker', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: clock,
    })!;
    let executions = 0;
    const handler = createLedgerSlackRunHandler({
      work: work as unknown as WorkStore,
      turns,
      resolveIdentity: async () => {
        throw new SlackIdentityUnavailableError('slack_identity_default', 'ratelimited');
      },
      verifyIdentityAccess: async () => undefined,
      executeTurn: (async () => { executions += 1; }) as LedgerSlackTurnExecutor,
      now: () => ++clock,
    });

    assert.deepEqual(await handler(claim), {
      kind: 'requeue',
      reasonCode: 'slack_identity_temporarily_unavailable',
    });
    assert.equal(executions, 0);
    assert.ok(turns.getPendingByRunId(admission.run.id));
  } finally {
    db.close();
  }
});

test('a Flue reconciliation conflict quarantines the ledger Run and retains its TurnJob', async () => {
  let clock = NOW;
  const db = openStateDb(':memory:');
  try {
    const work = new WorkStoreLogic(db, { now: () => clock });
    const turns = new TurnJobStoreLogic(db, () => clock);
    const admission = work.admitShadowRun(prepareSubmitRun(submission('flue-conflict')));
    turns.enqueue(turnJob(admission.run.id, 'flue-conflict'));
    const claim = work.claimNextInteractiveRun({
      ownerId: 'worker', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: clock,
    })!;
    const handler = createLedgerSlackRunHandler({
      work: work as unknown as WorkStore,
      turns,
      client: {} as WebClient,
      executeTurn: (async () => {
        turns.markRecoveryRequired('turn_flue-conflict', 'flue_dispatch_payload_conflict');
        throw new AgentPromptFailure('agent', 409, true);
      }) as LedgerSlackTurnExecutor,
      now: () => ++clock,
    });

    assert.deepEqual(await handler(claim), {
      kind: 'recovery_required',
      reasonCode: 'flue_dispatch_reconciliation_required',
    });
    assert.equal(turns.runtimeDrainCounts().pendingLedgerTurnJobs, 1);
    assert.equal(turns.getPendingByRunId(admission.run.id), undefined);
  } finally {
    db.close();
  }
});

test('failure classification uses the newest immutable RunExecution', async () => {
  let clock = NOW;
  const db = openStateDb(':memory:');
  try {
    const work = new WorkStoreLogic(db, { now: () => clock });
    const turns = new TurnJobStoreLogic(db, () => clock);
    const admission = work.admitShadowRun(prepareSubmitRun(submission('known-safe-retry')));
    turns.enqueue(turnJob(admission.run.id, 'known-safe-retry'));
    const first = work.claimNextInteractiveRun({
      ownerId: 'first_worker', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: clock,
    })!;
    const firstLifecycle = lifecycleFor(work, admission.run.id, first.fencingToken, () => ++clock);
    await firstLifecycle.prepareExecution('Prepared input');
    await firstLifecycle.settleExecution({
      outcome: 'not_submitted', rawStatus: 'credential_unavailable',
      safeFailureCode: 'credential_unavailable',
    });
    const instanceIds: string[] = [];
    const handler = createLedgerSlackRunHandler({
      work: work as unknown as WorkStore,
      turns,
      client: {} as WebClient,
      executeTurn: (async (_turn, _assignment, _env, options) => {
        const decision = options?.runtimePlanDecision ?? await options?.onRuntimePlan?.(
          compileRuntimePlanV2({
            turn: turn(),
            assignment: assignment(),
            instructions: 'Frozen recovery instructions.',
            memoryEpoch: 1,
            sandboxMode: 'bash',
          }),
        );
        instanceIds.push(decision?.instanceId ?? 'missing');
        if (options?.runFencingToken === 2) {
          const secondLifecycle = lifecycleFor(
            work,
            admission.run.id,
            options.runFencingToken,
            () => ++clock,
          );
          await secondLifecycle.prepareExecution('Prepared input');
          await secondLifecycle.markInvoked();
        }
        throw new Error('known safe refusal');
      }) as LedgerSlackTurnExecutor,
      now: () => ++clock,
    });
    assert.deepEqual(await handler(first), {
      kind: 'requeue', reasonCode: 'ledger_turn_failed_before_submit',
    });
    work.releaseRunLease({
      runId: admission.run.id, ownerId: first.leaseOwner, fencingToken: first.fencingToken,
      outcome: 'requeue', reasonCode: 'ledger_turn_failed_before_submit', releasedAt: ++clock,
    });
    const second = work.claimNextInteractiveRun({
      ownerId: 'second_worker', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: ++clock,
    })!;
    assert.deepEqual(await handler(second), {
      kind: 'recovery_required', reasonCode: 'ledger_turn_outcome_ambiguous',
    });
    const executions = work.listRunExecutions(admission.run.id, 10);
    assert.equal(second.fencingToken, first.fencingToken + 1);
    assert.equal(executions.length, 2);
    assert.deepEqual(executions.map((execution) => execution.fencingToken), [1, 2]);
    assert.equal(executions[0]?.outcome, 'not_submitted');
    assert.equal(executions[1]?.outcome, 'pending');
    assert.equal(instanceIds.length, 2);
    assert.equal(instanceIds[0], instanceIds[1], 'retry keeps the frozen Flue target');
    assert.match(instanceIds[0] ?? '', /^agent_[a-f0-9]{40}$/);
    assert.doesNotMatch(instanceIds.join(' '), /T_canary|C_canary|100\.001/);
  } finally {
    db.close();
  }
});

test('known-safe pre-submit failures stop at the bounded turn-attempt ceiling', async () => {
  let clock = NOW;
  const db = openStateDb(':memory:');
  try {
    const work = new WorkStoreLogic(db, { now: () => clock });
    const turns = new TurnJobStoreLogic(db, () => clock);
    const admission = work.admitShadowRun(prepareSubmitRun(submission('safe-retry-ceiling')));
    turns.enqueue(turnJob(admission.run.id, 'safe-retry-ceiling'));
    const handler = createLedgerSlackRunHandler({
      work: work as unknown as WorkStore,
      turns,
      client: {} as WebClient,
      executeTurn: (async (_turn, _assignment, _env, options) => {
        const fencingToken = options?.runFencingToken ?? 0;
        const lifecycle = lifecycleFor(work, admission.run.id, fencingToken, () => ++clock);
        await lifecycle.prepareExecution('Prepared input');
        await lifecycle.settleExecution({
          outcome: 'not_submitted',
          rawStatus: 'credential_unavailable',
          safeFailureCode: 'credential_unavailable',
        });
        throw new Error('known safe refusal');
      }) as LedgerSlackTurnExecutor,
      now: () => ++clock,
    });
    const first = work.claimNextInteractiveRun({
      ownerId: 'first_worker', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: clock,
    })!;
    assert.deepEqual(await handler(first), {
      kind: 'requeue', reasonCode: 'ledger_turn_failed_before_submit',
    });
    work.releaseRunLease({
      runId: admission.run.id, ownerId: first.leaseOwner, fencingToken: first.fencingToken,
      outcome: 'requeue', reasonCode: 'ledger_turn_failed_before_submit', releasedAt: ++clock,
    });
    const second = work.claimNextInteractiveRun({
      ownerId: 'second_worker', authorityEpoch: 1, leaseDurationMs: 30_000, claimedAt: ++clock,
    })!;
    assert.deepEqual(await handler(second), {
      kind: 'recovery_required', reasonCode: 'ledger_turn_attempts_exhausted',
    });
    assert.equal(await turns.getPendingByRunId(admission.run.id), undefined);
  } finally {
    db.close();
  }
});

function lifecycleFor(
  work: WorkStoreLogic,
  runId: string,
  fencingToken: number,
  now: () => number,
): ShadowWorkLifecycle {
  return new ShadowWorkLifecycle({
    store: work as unknown as WorkStore,
    runId: runId as never,
    attemptNumber: fencingToken,
    fencingToken,
    agentName: 'agent_canary',
    canonicalModel: 'local-stub/canary',
    sensitivity: 'public',
    routeEvidence: {},
    now,
    mode: 'enforce',
  });
}

function transitionPresentation(
  store: SlackRunPresentationStoreLogic,
  current: SlackRunPresentationV1,
  mutation: SlackPresentationMutation,
): SlackRunPresentationV1 {
  const result = store.transition({
    runId: current.runId,
    workBindingGeneration: current.workBindingGeneration,
    runFencingToken: current.runFencingToken,
    expectedProjectionVersion: current.projectionVersion,
    expectedStreamState: current.stream.state,
    mutation,
  });
  assert.equal(result.outcome, 'applied');
  if (result.outcome !== 'applied') throw new Error('presentation transition failed');
  return result.presentation;
}

function presentationPort(
  store: SlackRunPresentationStoreLogic,
  turns: TurnJobStoreLogic,
): SlackPresentationStatePort {
  return {
    getRunPresentation: (runId) => store.get(runId),
    transitionRunPresentation: (input) => store.transition(input),
    reserveSlackAppend: (workspaceId) => store.reserveAppend(workspaceId),
    applySlackAppendCooldown: (workspaceId, retryAfterMs) =>
      store.applyAppendCooldown(workspaceId, retryAfterMs),
    matchFlueObservation: (instanceId, submissionId) =>
      turns.matchFlueObservation(instanceId, submissionId),
  };
}

function turnJob(runId: string, suffix = 'delivery-retry') {
  return {
    id: `turn_${suffix}`,
    evtKey: `evt_${suffix}`,
    msgKey: `msg_${suffix}`,
    turn: turn(),
    assignment: assignment(),
    runId,
    executionAuthority: 'ledger' as const,
  };
}

function turn(): NormalizedSlackTurn {
  return {
    workspaceId: 'T_canary', channelId: 'C_canary', eventId: 'Ev_canary',
    text: 'Do the work', userId: 'U_member', messageTs: '100.001', threadTs: '100.001',
    source: 'app_mention', contextMode: 'thread', channelType: 'channel',
  };
}

function assignment(): ResolvedAssignment {
  return {
    workspaceId: 'T_canary', channelId: 'C_canary', agentId: 'agent_canary',
    model: 'local-stub/canary',
    agent: {
      id: 'agent_canary', name: 'Canary', instructions: 'Help.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    },
  };
}

function submission(suffix: string): SubmitRunInput {
  const scope = `recovery:${suffix}`;
  return {
    work: { id: opaqueId('work', scope), kind: 'conversation', createdAt: NOW },
    binding: {
      id: opaqueId('binding', scope), adapterKind: 'slack',
      externalAccountId: opaqueId('account', 'recovery'),
      externalConversationId: opaqueId('conversation', scope), generation: 1,
      sourceVisibility: 'public', configMode: 'frozen_on_open',
      orderingKey: opaqueId('ordering', scope), createdAt: NOW,
    },
    trigger: {
      runId: opaqueId('run', scope), runKind: 'interactive', kind: 'slack_fixture',
      ref: opaqueId('trigger', scope), dedupeKey: opaqueId('dedupe', scope),
      body: 'Do the work', createdAt: NOW,
    },
    actor: { ref: opaqueId('actor', 'recovery'), trustTier: 'member' },
    sourceContextWatermark: opaqueId('watermark', scope),
    safeConfig: {
      schemaVersion: 1, profileId: 'agent_canary', configuredModel: 'local-stub/canary',
      snapshotDigest: 'a'.repeat(64), capabilityDigest: 'b'.repeat(64),
      skillNames: [], connectionIds: [], repositoryIds: [], memoryMode: 'public',
      ceilings: {
        maxModelAttempts: 20, maxToolCalls: 1_000, maxActionAttempts: 0,
        timeoutMs: 900_000,
      },
    },
    execution: { authority: 'ledger', coordinatorKind: 'interactive', authorityEpoch: 1 },
    audit: {
      eventId: opaqueId('audit', scope), idempotencyKey: opaqueId('auditkey', scope),
    },
  };
}
