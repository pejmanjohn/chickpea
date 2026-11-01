import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileRuntimePlanV2, deriveRuntimePlanInstanceId } from '../src/agents/runtime-plan.ts';
import {
  createSlackTurnInput,
  serializeSlackTurnInput,
  slackTurnSubmissionId,
  useAgentObjectStorageForTests,
  writeStagedTurnInput,
} from '../src/agents/turn-input.ts';
import type { CustomAgentConfig, ResolvedAssignment } from '../src/config/types.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import {
  createWorkModelInvocationInterceptor,
  currentFlueObservationContext,
} from '../src/work/model-invocation.ts';
import { sqlStorage } from './helpers/agent-object-sql.ts';
import { withCloudflareUserAgent } from './helpers/cloudflare-target.ts';

const correlation = {
  runId: 'run_invocation_boundary',
  runExecutionId: 'execution_invocation_boundary',
  mode: 'enforce' as const,
};

const target = {
  turnJobId: 'turn_invocation_boundary',
  instanceId: `agent_${'a'.repeat(40)}`,
  submissionId: 'submission_invocation_boundary',
  generation: 'turn_invocation_boundary',
  workCorrelation: correlation,
};

const context = {
  instanceId: target.instanceId,
  submissionId: target.submissionId,
  agentName: 'chickpea-slack-v2',
};

test('the first Flue model operation marks invocation before provider execution exactly once', async () => {
  const events: string[] = [];
  const interceptor = createWorkModelInvocationInterceptor({
    resolveTarget: async () => target,
    markInvocation: async () => {
      events.push('marked');
    },
  });
  await interceptor(
    { type: 'agent', operationId: 'operation', operationKind: 'prompt' },
    context,
    async () => {
      await interceptor({ type: 'model', turnId: 'turn-1' }, {}, async () => {
        events.push('provider-1');
      });
      await interceptor({ type: 'model', turnId: 'turn-1' }, {}, async () => {
        events.push('provider-2');
      });
    },
  );
  assert.deepEqual(events, ['marked', 'provider-1', 'provider-2']);
});

test('agent initialization failures remain not submitted', async () => {
  let marks = 0;
  const interceptor = createWorkModelInvocationInterceptor({
    resolveTarget: async () => target,
    markInvocation: async () => { marks += 1; },
  });
  await assert.rejects(
    () => interceptor(
      { type: 'agent', operationId: 'operation', operationKind: 'prompt' },
      context,
      async () => { throw new Error('policy rejected'); },
    ),
    /policy rejected/,
  );
  assert.equal(marks, 0);
});

test('ledger authority fails closed when its invocation marker cannot persist', async () => {
  let providerCalls = 0;
  const interceptor = createWorkModelInvocationInterceptor({
    resolveTarget: async () => target,
    markInvocation: async () => {
      throw new Error('marker unavailable');
    },
  });
  await assert.rejects(
    () => interceptor(
      { type: 'agent', operationId: 'operation', operationKind: 'prompt' },
      context,
      () => interceptor({ type: 'model', turnId: 'turn-1' }, {}, async () => {
        providerCalls += 1;
      }),
    ),
    /marker unavailable/,
  );
  assert.equal(providerCalls, 0);
});

test('non-Slack Flue agents bypass Slack TurnJob correlation', async () => {
  let targetResolutions = 0;
  let agentCalls = 0;
  const interceptor = createWorkModelInvocationInterceptor({
    resolveTarget: async () => {
      targetResolutions += 1;
      throw new Error('Slack matcher must not receive an auxiliary agent id');
    },
  });

  for (const agentName of [
    'chickpea-routine-intent-v2',
    'chickpea-routine-execution-v2',
  ]) {
    await interceptor(
      { type: 'agent', operationId: `operation-${agentName}`, operationKind: 'prompt' },
      {
        instanceId: `routine-${agentName}`,
        submissionId: `submission-${agentName}`,
        agentName,
      },
      async () => { agentCalls += 1; },
    );
  }

  assert.equal(targetResolutions, 0);
  assert.equal(agentCalls, 2);
});

test('an observe-mode invocation whose marker fails is not marked again by later model operations', async () => {
  let marks = 0;
  let providerCalls = 0;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const interceptor = createWorkModelInvocationInterceptor({
      resolveTarget: async () => ({ ...target, workCorrelation: { ...correlation, mode: 'observe' as const } }),
      markInvocation: async () => {
        marks += 1;
        throw new Error('Canonical RunExecution correlation is unavailable.');
      },
    });
    await interceptor(
      { type: 'agent', operationId: 'operation', operationKind: 'prompt' },
      context,
      async () => {
        for (let turn = 0; turn < 50; turn += 1) {
          await interceptor({ type: 'model', turnId: `turn-${turn}` }, {}, async () => {
            providerCalls += 1;
          });
        }
      },
    );
  } finally {
    console.warn = warn;
  }
  assert.equal(providerCalls, 50, 'the legacy execution continues');
  assert.equal(marks, 1, 'one store attempt for the invocation, not one per model operation');
});

test('a Slack agent whose staged input carries the observation correlates from its own storage; one without it asks the state store', async () => {
  const agent: CustomAgentConfig = {
    id: 'agent_invocation', kind: 'user', revision: 1, name: 'Invocation', instructions: 'Correlate.',
    enabled: true, model: 'openai/gpt-5.4-mini', skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
  const turn: NormalizedSlackTurn = {
    workspaceId: 'T_WORK', channelId: 'C_WORK', eventId: 'E_WORK', text: 'Correlate me.', userId: 'U_ALICE',
    messageTs: '1788000000.000200', threadTs: '1788000000.000100', source: 'app_mention', contextMode: 'thread',
  };
  const assignment: ResolvedAssignment = {
    workspaceId: 'T_WORK', channelId: 'C_WORK', agentId: agent.id, agent, runtimeContract: 'chickpea-v1',
    ownerIncarnation: 1, model: 'openai/gpt-5.4-mini', modelAttribution: { source: 'pinned', providerId: 'openai' },
  };
  const plan = compileRuntimePlanV2({ turn, assignment, instructions: agent.instructions, memoryEpoch: 1 });
  const instanceId = deriveRuntimePlanInstanceId(plan);
  const observation = { generation: 'msg:C_WORK:1788000000.000200', workCorrelation: correlation, harnessRevision: plan.harnessRevision };
  const stagedSubmission = await slackTurnSubmissionId(instanceId, 'turn_staged');
  const bareSubmission = await slackTurnSubmissionId(instanceId, 'turn_bare');
  const sql = sqlStorage();
  writeStagedTurnInput(sql, serializeSlackTurnInput(createSlackTurnInput({
    turnJobId: 'turn_staged', instanceId, runtimePlan: plan, submissionId: stagedSubmission, observation,
  })), 1);
  writeStagedTurnInput(sql, serializeSlackTurnInput(createSlackTurnInput({
    turnJobId: 'turn_bare', instanceId, runtimePlan: plan, submissionId: bareSubmission,
  })), 2);

  const storeReads: string[] = [];
  const interceptor = createWorkModelInvocationInterceptor({
    resolveTarget: async (_instanceId, submissionId) => {
      storeReads.push(submissionId);
      return { ...observation, turnJobId: 'turn_bare', instanceId, submissionId };
    },
    markInvocation: async () => {},
  });
  const correlated: unknown[] = [];
  useAgentObjectStorageForTests(() => ({ storage: { sql } }));
  try {
    await withCloudflareUserAgent(async () => {
      for (const submissionId of [stagedSubmission, bareSubmission]) {
        await interceptor(
          { type: 'agent', operationId: submissionId, operationKind: 'prompt' },
          { instanceId, submissionId, agentName: 'chickpea-slack-v2' },
          async () => { correlated.push(currentFlueObservationContext()?.target); },
        );
      }
    });
  } finally {
    useAgentObjectStorageForTests(undefined);
  }
  assert.deepEqual(correlated, [
    { ...observation, turnJobId: 'turn_staged', instanceId, submissionId: stagedSubmission },
    { ...observation, turnJobId: 'turn_bare', instanceId, submissionId: bareSubmission },
  ]);
  assert.deepEqual(storeReads, [bareSubmission], 'only the turn staged without an observation reaches the state store');
});

test('an observe-mode invocation marks while the provider request is in flight, and the mark still lands', async () => {
  const events: string[] = [];
  const interceptor = createWorkModelInvocationInterceptor({
    resolveTarget: async () => ({ ...target, workCorrelation: { ...correlation, mode: 'observe' as const } }),
    markInvocation: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push('marked');
    },
  });
  await interceptor(
    { type: 'agent', operationId: 'operation', operationKind: 'prompt' },
    context,
    () => interceptor({ type: 'model', turnId: 'turn-1' }, {}, async () => {
      events.push('provider-1');
    }),
  );
  assert.deepEqual(events, ['provider-1'], 'the observer does not wait for its mark before the provider request');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(events, ['provider-1', 'marked'], 'the mark still lands');
});
