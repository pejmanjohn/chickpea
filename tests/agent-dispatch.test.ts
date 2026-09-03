import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentFailureText,
  AgentPromptFailure,
  classifyAgentPromptFailure,
  promptSlackThreadAgent,
  type SlackFlueDispatchState,
} from '../src/slack/flue-dispatch.ts';
import type { AgentInstanceHandle } from '@flue/runtime';
import { AgentInstanceExistsError, AgentInstanceNotFoundError, AgentRunError } from '@flue/runtime';
import { opaqueId } from '../src/work/admission.ts';
import type {
  FlueDispatchEnvelopeV1,
  FlueDispatchReceiptV1,
  FlueSettlementCheckpointV1,
} from '../src/slack/turn-job-types.ts';
import {
  AGENT_FAILURE_TEXT,
  OPENAI_SUBSCRIPTION_POLICY_TEXT,
  OPENAI_SUBSCRIPTION_QUOTA_TEXT,
  OPENAI_SUBSCRIPTION_RECONNECT_TEXT,
  PROVIDER_FAILURE_TEXT,
  SANDBOX_FAILURE_TEXT,
  SANDBOX_SESSION_CAP_FAILURE_TEXT,
} from '../src/slack/web-client-presenter.ts';
import type { SlackProgressiveReadRelay } from '../src/slack/progressive-relay.ts';
import { SLACK_TABLE_PRESENTATION_DATA_NAME } from '../src/slack/table-presentation.ts';

function envelope(type: string, message: string): string {
  return JSON.stringify({ error: { type, message, details: 'private detail' } });
}

test('agent prompt failure classification distinguishes provider, sandbox, and unknown errors', () => {
  assert.equal(
    classifyAgentPromptFailure(
      500,
      envelope('sandbox_unavailable', 'The coding workspace is temporarily unavailable.'),
    ),
    'sandbox',
  );
  assert.equal(
    classifyAgentPromptFailure(
      500,
      envelope(
        'operation_failed',
        'Agent turn failed: Maximum number of running container instances exceeded.',
      ),
    ),
    'sandbox',
  );
  assert.equal(
    classifyAgentPromptFailure(
      500,
      envelope('sandbox_session_cap_reached', 'Monthly limit reached.'),
    ),
    'sandbox-session-cap',
  );
  assert.equal(
    classifyAgentPromptFailure(
      500,
      envelope('cloudflare_ai_binding_error', 'Cloudflare AI binding request failed.'),
    ),
    'provider',
  );
  assert.equal(
    classifyAgentPromptFailure(
      500,
      envelope('operation_failed', 'OpenAI subscription operation failed (auth_reconnect_required).'),
    ),
    'openai-subscription-reconnect',
  );
  assert.equal(
    classifyAgentPromptFailure(
      500,
      envelope('operation_failed', 'OpenAI subscription operation failed (subscription_quota_exhausted).'),
    ),
    'openai-subscription-quota',
  );
  assert.equal(
    classifyAgentPromptFailure(
      500,
      envelope('operation_failed', 'OpenAI subscription operation failed (originator_rejected).'),
    ),
    'openai-subscription-policy',
  );
  assert.equal(
    classifyAgentPromptFailure(500, envelope('operation_failed', 'Tool execution failed.')),
    'agent',
  );
  assert.equal(classifyAgentPromptFailure(500, 'not-json'), 'agent');
});

test('Slack failure copy uses only the public-safe failure category', () => {
  assert.equal(agentFailureText(new AgentPromptFailure('provider', 500)), PROVIDER_FAILURE_TEXT);
  assert.equal(
    agentFailureText(new AgentPromptFailure('openai-subscription-reconnect', 500)),
    OPENAI_SUBSCRIPTION_RECONNECT_TEXT,
  );
  assert.equal(
    agentFailureText(new AgentPromptFailure('openai-subscription-quota', 500)),
    OPENAI_SUBSCRIPTION_QUOTA_TEXT,
  );
  assert.equal(
    agentFailureText(new AgentPromptFailure('openai-subscription-policy', 500)),
    OPENAI_SUBSCRIPTION_POLICY_TEXT,
  );
  assert.equal(agentFailureText(new AgentPromptFailure('sandbox', 500)), SANDBOX_FAILURE_TEXT);
  assert.equal(
    agentFailureText(new AgentPromptFailure('sandbox-session-cap', 500)),
    SANDBOX_SESSION_CAP_FAILURE_TEXT,
  );
  assert.equal(agentFailureText(new AgentPromptFailure('agent', 500)), AGENT_FAILURE_TEXT);
  assert.equal(agentFailureText(new Error('raw secret')), AGENT_FAILURE_TEXT);
});

const ENVELOPE = {
  schemaVersion: 1,
  agentName: 'chickpea-slack-v2',
  instanceId: `agent_${'a'.repeat(40)}`,
  uid: null,
  message: { kind: 'user', body: 'hello' },
  initialData: { schemaVersion: 2 },
  idempotencyKey: 'turn_dispatch_test',
} as unknown as FlueDispatchEnvelopeV1;

const RECEIPT: FlueDispatchReceiptV1 = {
  submissionId: 'submission_dispatch_test',
  acceptedAt: '2026-08-01T12:00:00.000Z',
  uid: 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAV',
};

function state(
  overrides: Partial<SlackFlueDispatchState> = {},
): SlackFlueDispatchState {
  return {
    prepare: async () => ENVELOPE,
    reconcileExistingInstance: async (uid) => {
      const { initialData: _creationData, ...rest } = ENVELOPE;
      return { ...rest, uid };
    },
    recordReceipt: async (receipt) => receipt,
    recordSettlement: async (settlement) => settlement,
    markRecoveryRequired: async () => {},
    ...overrides,
  };
}

function handle(overrides: Partial<AgentInstanceHandle>): AgentInstanceHandle {
  return {
    id: ENVELOPE.instanceId,
    dispatch: async () => RECEIPT,
    read: async () => ({
      text: 'done',
      data: {},
      submissionId: RECEIPT.submissionId,
      uid: RECEIPT.uid,
      metadata: {
        chickpea: {
          schemaVersion: 1,
          requestedModel: 'local-stub/x',
          usage: { input: 2, output: 3, totalTokens: 5 },
          returnedModel: { provider: 'local-stub', id: 'x' },
        },
      },
    }),
    abort: async () => {},
    ...overrides,
  };
}

function promptInput(dispatchState: SlackFlueDispatchState, agent: AgentInstanceHandle) {
  return {
    message: 'hello',
    state: dispatchState,
    turnId: 'turn_dispatch_test',
    conversationKey: 'T1:C1:1.0',
    useCloudflareSandbox: false,
    requestedModel: 'local-stub/x',
    handle: agent,
    now: () => 1_800_000_000_000,
  };
}

test('dispatch diagnostics distinguish failed settlement from an empty completed reply without logging content', async (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  for (const stage of ['settlement_failed', 'invalid_result'] as const) {
    const dispatchState = state();
    await assert.rejects(() => promptSlackThreadAgent(promptInput(dispatchState, handle({
      async read() {
        if (stage === 'settlement_failed') throw new AgentRunError({
          outcome: 'failed', submissionId: RECEIPT.submissionId,
          cause: { type: 'internal_error', message: 'private prompt Bearer secret' },
        });
        return { text: '', data: { private: ['Bearer secret'] }, metadata: {},
          submissionId: RECEIPT.submissionId };
      },
    }))), (error: unknown) => error instanceof AgentPromptFailure && !error.retryable);
    assert.equal(dispatchState.flueSettlement?.outcome, 'failed');
  }
  assert.deepEqual(logs, ['settlement_failed', 'invalid_result'].map((stage) => [
    '[chickpea] agent dispatch failed:',
    { stage, submissionRef: opaqueId('fluesubmission', RECEIPT.submissionId) },
  ]));
  assert.doesNotMatch(JSON.stringify(logs), /private|Bearer|secret|submission_dispatch_test/);
});

test('an unavailable diagnostic logger cannot prevent failed-result settlement', async (t) => {
  t.mock.method(console, 'error', () => { throw new Error('logger unavailable'); });
  const dispatchState = state();
  await assert.rejects(() => promptSlackThreadAgent(promptInput(dispatchState, handle({
    async read() { return { text: '', data: {}, metadata: {}, submissionId: RECEIPT.submissionId }; },
  }))), (error: unknown) => error instanceof AgentPromptFailure && error.kind === 'agent');
  assert.equal(dispatchState.flueSettlement?.outcome, 'failed');
});

test('lost dispatch acknowledgment repeats the identical key and adopts the receipt', async () => {
  const sent: unknown[] = [];
  const dispatchState = state({ dispatchEnvelope: ENVELOPE });
  await assert.rejects(
    () => promptSlackThreadAgent(promptInput(dispatchState, handle({
      async dispatch(request) {
        sent.push(structuredClone(request));
        throw new Error('ack lost');
      },
    }))),
    (error: unknown) => error instanceof AgentPromptFailure && error.retryable,
  );
  let recorded: FlueDispatchReceiptV1 | undefined;
  const result = await promptSlackThreadAgent(promptInput(state({
    dispatchEnvelope: ENVELOPE,
    async recordReceipt(receipt) {
      recorded = receipt;
      return receipt;
    },
  }), handle({
    async dispatch(request) {
      sent.push(structuredClone(request));
      return { ...RECEIPT, deduplicated: true };
    },
  })));
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(recorded?.deduplicated, true);
  assert.equal(result.text, 'done');
});

test('a create-only collision adopts the returned uid before retrying admission', async () => {
  const existingUid = 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAZ';
  const requests: unknown[] = [];
  let reconciledUid: string | undefined;
  let calls = 0;
  const dispatchState = state({
    dispatchEnvelope: ENVELOPE,
    reconcileExistingInstance: async (uid) => {
      reconciledUid = uid;
      const { initialData: _creationData, ...rest } = ENVELOPE;
      return { ...rest, uid };
    },
  });
  const result = await promptSlackThreadAgent(promptInput(dispatchState, handle({
    async dispatch(request) {
      requests.push(structuredClone(request));
      calls += 1;
      if (calls === 1) {
        throw new AgentInstanceExistsError({ id: ENVELOPE.instanceId, uid: existingUid });
      }
      return { ...RECEIPT, uid: existingUid };
    },
  })));
  assert.equal(result.text, 'done');
  assert.equal(reconciledUid, existingUid);
  assert.equal(requests.length, 2);
  assert.equal('initialData' in (requests[1] as Record<string, unknown>), false);
  assert.equal(dispatchState.dispatchEnvelope?.uid, existingUid);
});

test('a transient read interruption retains the receipt and does not checkpoint failure', async () => {
  let settlements = 0;
  const dispatchState = state({
    dispatchEnvelope: ENVELOPE,
    dispatchReceipt: RECEIPT,
    recordSettlement: async (settlement) => {
      settlements += 1;
      return settlement;
    },
  });
  await assert.rejects(
    () => promptSlackThreadAgent(promptInput(dispatchState, handle({
      async read() { throw new TypeError('Network connection lost'); },
    }))),
    (error: unknown) => error instanceof AgentPromptFailure && error.retryable,
  );
  assert.equal(settlements, 0);
  assert.equal(dispatchState.flueSettlement, undefined);

  const recovered = await promptSlackThreadAgent(promptInput(dispatchState, handle({})));
  assert.equal(recovered.text, 'done');
  assert.equal(settlements, 1);
});

test('a missing expected instance enters recovery without fabricating a settlement', async () => {
  let reason: string | undefined;
  let settlements = 0;
  await assert.rejects(
    () => promptSlackThreadAgent(promptInput(state({
      dispatchEnvelope: ENVELOPE,
      dispatchReceipt: RECEIPT,
      recordSettlement: async (settlement) => {
        settlements += 1;
        return settlement;
      },
      markRecoveryRequired: async (value) => { reason = value; },
    }), handle({
      async read() { throw new AgentInstanceNotFoundError({ id: ENVELOPE.instanceId }); },
    }))),
    (error: unknown) => error instanceof AgentPromptFailure && error.recoveryRequired,
  );
  assert.equal(reason, 'flue_expected_instance_missing');
  assert.equal(settlements, 0);
});

test('saved receipt reattaches with read and saved settlement skips Flue entirely', async () => {
  let reads = 0;
  const result = await promptSlackThreadAgent(promptInput(state({
    dispatchEnvelope: ENVELOPE,
    dispatchReceipt: RECEIPT,
  }), handle({
    async dispatch() {
      throw new Error('dispatch must not run');
    },
    async read(target) {
      reads += 1;
      assert.equal(typeof target === 'string' ? target : target.submissionId, RECEIPT.submissionId);
      return {
        text: 'reattached', data: {}, submissionId: RECEIPT.submissionId,
        metadata: {
          chickpea: {
            schemaVersion: 1,
            requestedModel: 'local-stub/x',
            usage: { input: 1, output: 1, totalTokens: 2 },
          },
        },
      };
    },
  })));
  assert.equal(reads, 1);
  assert.equal(result.text, 'reattached');

  const settlement: FlueSettlementCheckpointV1 = {
    outcome: 'completed',
    settledAt: 1_800_000_000_000,
    result,
  };
  let beforeResult = 0;
  const replay = await promptSlackThreadAgent({ ...promptInput(state({
    dispatchEnvelope: ENVELOPE,
    dispatchReceipt: RECEIPT,
    flueSettlement: settlement,
  }), handle({
    async dispatch() { throw new Error('dispatch must not run'); },
    async read() { throw new Error('read must not run'); },
  })), beforeResult: async () => { beforeResult += 1; } });
  assert.deepEqual(replay, result);
  assert.equal(beforeResult, 1, 'saved settlement still runs the pre-reply notice seam');
});

test('native table intent is reduced into and replayed from the durable settlement', async () => {
  let persisted: FlueSettlementCheckpointV1 | undefined;
  const dispatchState = state({
    async recordSettlement(settlement) {
      persisted = structuredClone(settlement);
      return settlement;
    },
  });
  const result = await promptSlackThreadAgent(promptInput(dispatchState, handle({
    async read() {
      return {
        text: 'The allocation is ready for review.',
        data: {
          [SLACK_TABLE_PRESENTATION_DATA_NAME]: [{
            caption: 'Synthetic allocation',
            presentation: 'static',
            columns: [
              { header: 'Component' },
              { header: 'Amount', type: 'number' },
            ],
            rows: [
              ['Taxable', 9_350],
              ['Non-taxable', 650],
              ['Employer tax', 420],
              ['Benefits', 80],
              ['Gross addition', 10_500],
              ['Net addition', 9_920],
              ['Total', 10_000],
            ],
            rowHeaderIndex: 0,
          }],
        },
        submissionId: RECEIPT.submissionId,
        uid: RECEIPT.uid,
        metadata: {},
      };
    },
  })));

  assert.equal(result.tablePresentations?.[0]?.caption, 'Synthetic allocation');
  assert.deepEqual(persisted?.outcome === 'completed'
    ? persisted.result.tablePresentations
    : undefined, result.tablePresentations);
  if (!persisted) assert.fail('completed settlement was not persisted');

  const replay = await promptSlackThreadAgent(promptInput(state({
    flueSettlement: persisted,
  }), handle({
    async dispatch() { throw new Error('dispatch must not run'); },
    async read() { throw new Error('read must not run'); },
  })));
  assert.deepEqual(replay.tablePresentations, result.tablePresentations);
});

test('sandbox activation failure is sanitized and never replays dispatch in normal mode', async () => {
  let preparations = 0;
  let dispatches = 0;
  const dispatchState = state();
  await assert.rejects(
    () => promptSlackThreadAgent({
      ...promptInput(dispatchState, handle({
        async dispatch() {
          dispatches += 1;
          return RECEIPT;
        },
      })),
      useCloudflareSandbox: true,
      prepareSandbox: async () => {
        preparations += 1;
        throw new Error('private container control-plane detail');
      },
    }),
    (error: unknown) =>
      error instanceof AgentPromptFailure &&
      error.kind === 'sandbox' &&
      !error.retryable &&
      !error.recoveryRequired,
  );
  assert.equal(preparations, 1);
  assert.equal(dispatches, 0, 'activation failure must not admit or replay model work');
  assert.equal(dispatchState.dispatchEnvelope, undefined);
  assert.equal(dispatchState.dispatchReceipt, undefined);
});

test('receipt-scoped relay is prepared after durable receipt and drains after settlement', async () => {
  const operations: string[] = [];
  const relay: SlackProgressiveReadRelay = {
    onEvent(chunk) {
      operations.push(`event:${chunk.type}`);
    },
    async closeAndDrain() {
      operations.push('relay:closed');
      return {
        acceptedChunks: 1,
        acceptedBytes: 4,
        targetMessageCompleted: true,
        invalidated: false,
      };
    },
    async invalidateAndDrain(reason) {
      operations.push(`relay:invalid:${reason}`);
      return {
        acceptedChunks: 0,
        acceptedBytes: 0,
        targetMessageCompleted: false,
        invalidated: true,
        invalidationReason: reason,
      };
    },
  };
  const dispatchState = state({
    async recordReceipt(receipt) {
      operations.push('receipt:persisted');
      return receipt;
    },
    async recordSettlement(settlement) {
      operations.push('settlement:persisted');
      return settlement;
    },
  });
  const result = await promptSlackThreadAgent({
    ...promptInput(dispatchState, handle({
      async read(_receipt, options) {
        assert.equal(typeof options?.onEvent, 'function');
        options?.onEvent?.({
          type: 'message-delta',
          conversationId: 'conversation_dispatch',
          messageId: 'message_dispatch',
          kind: 'text',
          delta: 'done',
          position: { batch: 1, index: 0 },
        });
        return {
          text: 'done', data: {}, submissionId: RECEIPT.submissionId,
          metadata: {
            chickpea: {
              schemaVersion: 1,
              requestedModel: 'local-stub/x',
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          },
        };
      },
    })),
    prepareProgressiveRelay: async ({ instanceId, receipt }) => {
      operations.push(`relay:prepared:${instanceId}:${receipt.submissionId}`);
      return relay;
    },
    beforeResult: async () => { operations.push('before:result'); },
  });

  assert.equal(result.text, 'done');
  assert.deepEqual(operations, [
    'receipt:persisted',
    `relay:prepared:${ENVELOPE.instanceId}:${RECEIPT.submissionId}`,
    'event:message-delta',
    'settlement:persisted',
    'relay:closed',
    'before:result',
  ]);
});
