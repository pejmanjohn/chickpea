import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentFailureText,
  AgentObservationYield,
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
import { CODING_WORKSPACE_USE_DATA_NAME } from '../src/sandbox/workspace-use.ts';
import { WORKSPACE_MILESTONE_DATA_NAME, type WorkspaceMilestoneRecord } from '../src/slack/coding-worker-run.ts';
import { createBoundedAgentReplyReader } from '../src/slack/bounded-agent-observation.ts';

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


test('the host turn hands its thread images to the durable dispatch preparation', async () => {
  const prepared: unknown[][] = [];
  const records = [{
    conversationKey: 'T1:C1:1.0',
    fileId: 'F00000000AA',
    filename: 'logo.png',
    mimeType: 'image/png',
    origin: 'person' as const,
    messageTs: '1.0',
  }];
  const dispatchState = state({
    prepare: async (_message, _observation, threadImages, admittedListIds) => {
      prepared.push([threadImages, admittedListIds]);
      return ENVELOPE;
    },
  });
  await promptSlackThreadAgent({
    ...promptInput(dispatchState, handle({})),
    threadImages: records,
    admittedListIds: ['FEXISTING'],
  });
  // Omitting the images is the no-image turn, not a different contract.
  await promptSlackThreadAgent({ ...promptInput(state({
    prepare: async (_message, _observation, threadImages, admittedListIds) => {
      prepared.push([threadImages, admittedListIds]);
      return ENVELOPE;
    },
  }), handle({})) });
  assert.deepEqual(prepared, [[records, ['FEXISTING']], [undefined, undefined]]);
});

test('the turn envelope is built before the first dispatch only, and a failed build still dispatches', async () => {
  const frozen = { schemaVersion: 1 } as unknown as NonNullable<
    Parameters<SlackFlueDispatchState['prepare']>[4]
  >;
  const prepared: unknown[] = [];
  let builds = 0;
  const prepare: SlackFlueDispatchState['prepare'] = async (...args) => {
    prepared.push(args[4]);
    return ENVELOPE;
  };
  await promptSlackThreadAgent({
    ...promptInput(state({ prepare }), handle({})),
    buildTurnEnvelope: async () => {
      builds += 1;
      return frozen;
    },
  });
  // A retry that already holds its dispatch envelope never rebuilds.
  await promptSlackThreadAgent({
    ...promptInput(state({ prepare, dispatchEnvelope: ENVELOPE }), handle({})),
    buildTurnEnvelope: async () => {
      builds += 1;
      return frozen;
    },
  });
  await promptSlackThreadAgent({
    ...promptInput(state({ prepare }), handle({})),
    buildTurnEnvelope: async () => {
      throw new Error('settings unavailable');
    },
  });
  assert.equal(builds, 1);
  assert.deepEqual(prepared, [frozen, undefined]);
});

test('dispatch persists only the completed assistant step after an interrupted prefix', async () => {
  const dispatchState = state();
  const agent = handle({ read: async (_receipt, options) => {
    let index = 0;
    for (const text of ['Found the original at 123.', 'Found the original. Complete answer.']) {
      // Flue deliberately maps both steps onto the same response message ID.
      options?.onEvent?.({ type: 'message-started', conversationId: 'conversation',
        messageId: 'response', submissionId: RECEIPT.submissionId, position: { batch: 1, index: index++ } });
      options?.onEvent?.({ type: 'message-delta', conversationId: 'conversation',
        messageId: 'response', kind: 'text', delta: text, position: { batch: 1, index: index++ } });
      options?.onEvent?.({ type: 'message-completed', conversationId: 'conversation',
        messageId: 'response', position: { batch: 1, index: index++ } });
    }
    return { text: 'Found the original at 123.\n\nFound the original. Complete answer.',
      submissionId: RECEIPT.submissionId, data: {} };
  } });
  const result = await promptSlackThreadAgent(promptInput(dispatchState, agent));
  assert.equal(result.text, 'Found the original. Complete answer.');
  assert.equal(dispatchState.flueSettlement?.outcome === 'completed' &&
    dispatchState.flueSettlement.result.text, result.text);
});

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
    { stage, submissionRef: opaqueId('fluesubmission', RECEIPT.submissionId),
      ...(stage === 'invalid_result' ? { hasText: false } : {
        causes: [{ kind: 'unknown' }, { kind: 'internal_error' }],
      }) },
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

test('an attached-container turn prepares its workspace turn once, never on reattachment', async () => {
  let preparations = 0;
  let dispatches = 0;
  const dispatchState = state();
  const prepareSandbox = async () => { preparations += 1; };
  const agent = handle({
    async dispatch() {
      dispatches += 1;
      return RECEIPT;
    },
  });
  const first = await promptSlackThreadAgent({
    ...promptInput(dispatchState, agent), useCloudflareSandbox: true, prepareSandbox,
  });
  assert.equal(first.text, 'done');
  assert.deepEqual({ preparations, dispatches }, { preparations: 1, dispatches: 1 });

  // The receipt survived an interrupted read; the reattaching attempt must not
  // prepare the turn again, which would revoke the running submission's egress.
  const reattaching = state({ dispatchEnvelope: ENVELOPE, dispatchReceipt: RECEIPT });
  const reattached = await promptSlackThreadAgent({
    ...promptInput(reattaching, agent), useCloudflareSandbox: true, prepareSandbox,
  });
  assert.equal(reattached.text, 'done');
  assert.deepEqual({ preparations, dispatches }, { preparations: 1, dispatches: 1 });
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
    async suspendAndDrain() {
      operations.push('relay:suspended');
      return {
        acceptedChunks: 0,
        acceptedBytes: 0,
        targetMessageCompleted: false,
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

test('extreme punctuation output settles as terminal failure and never repeats a possibly completed write', async (t) => {
  t.mock.method(console, 'error', () => {});
  let reads = 0;
  let dispatches = 0;
  const dispatchState = state();
  const agent = handle({
    async dispatch() { dispatches++; return RECEIPT; },
    async read() { reads++; return { text: '!'.repeat(4096), data: {}, metadata: {}, submissionId: RECEIPT.submissionId }; },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(() => promptSlackThreadAgent(promptInput(dispatchState, agent)),
      (error: unknown) => error instanceof AgentPromptFailure && error.kind === 'invalid-output' &&
        !error.retryable && /not retried/.test(agentFailureText(error)) &&
        /Check the connected service/.test(agentFailureText(error)));
  }
  assert.equal(dispatches, 1);
  assert.equal(reads, 1);
  assert.equal(dispatchState.flueSettlement?.outcome, 'failed');
});
test('short punctuation, structured results and ordinary long answers remain valid', async () => {
  for (const text of ['!!!', '!'.repeat(1023), '{"ok":true}', '---\n# Answer\n---', 'Confirmed. '.repeat(1000), '!?'.repeat(1024)]) {
    const result = await promptSlackThreadAgent(promptInput(state(), handle({
      async read() { return { text, data: {}, metadata: {}, submissionId: RECEIPT.submissionId }; },
    })));
    assert.equal(result.text, text);
  }
});

test('terminal step selection falls back when a complete boundary cannot be proven', async () => {
  for (const scenario of ['snapshot', 'incomplete', 'foreign', 'different', 'oversized'] as const) {
    const dispatchState = state();
    const agent = handle({ read: async (_receipt, options) => {
      options?.onEvent?.({ type: 'message-started', conversationId: 'conversation',
        messageId: 'response', submissionId: scenario === 'foreign' ? 'another-submission' : RECEIPT.submissionId,
        position: { batch: 1, index: 0 } });
      options?.onEvent?.({ type: 'message-delta', conversationId: 'conversation', messageId: 'response',
        kind: 'text', delta: scenario === 'oversized' ? 'x'.repeat(129 * 1024) : 'Final.', position: { batch: 1, index: 1 } });
      if (scenario !== 'incomplete') options?.onEvent?.({ type: 'message-completed',
        conversationId: 'conversation', messageId: 'response', position: { batch: 1, index: 2 } });
      if (scenario === 'snapshot') options?.onEvent?.({ type: 'conversation-reset',
        conversationId: 'conversation', snapshot: { v: 1, conversationId: 'conversation', messages: [], offset: '1', settlements: [] }, position: { batch: 2, index: 0 } });
      return { text: scenario === 'different' ? 'Different final.' : 'Prefix.\n\nFinal.',
        submissionId: RECEIPT.submissionId, data: {} };
    } });
    const result = await promptSlackThreadAgent(promptInput(dispatchState, agent));
    assert.equal(result.text, scenario === 'different' ? 'Different final.' : 'Prefix.\n\nFinal.', scenario);
  }
});

test('real Flue durable read separates working narration from the final Slack answer', { timeout: 15_000 }, async () => {
  const { init, useModel, useTool } = await import('@flue/runtime');
  const { start } = await import('@flue/runtime/node');
  const { createCloudflareBindingProvider } = await import('../src/cloudflare-provider.ts');
  let calls = 0;
  let reads = 0;
  function TerminalProbe() {
    useModel('cloudflare/@cf/zai-org/glm-5.3-flash');
    useTool({ name: 'read_fixture', description: 'Read the fixture.', run: () => { reads++; return 'CEDAR'; } });
    return 'Write a self-contained final answer after reading the fixture.';
  }
  const provider = createCloudflareBindingProvider({ run: async () => {
    calls++;
    const deltas = calls === 1 ? [{ content: 'Checking the fixture.' },
      { tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'read_fixture', arguments: '{}' } }] }]
      : [{ content: 'The fixture is CEDAR.' }];
    return new Response(deltas.map(delta => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`).join('') +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  const runtime = await start({ agents: [{ agent: TerminalProbe, name: 'terminal-step-probe' }], providers: [provider] });
  try {
    const agent = init(TerminalProbe, { id: 'terminal-step-probe' });
    const receipt = await agent.dispatch('Read the fixture.');
    const dispatchState = state({ dispatchEnvelope: ENVELOPE, dispatchReceipt: receipt });
    const result = await promptSlackThreadAgent(promptInput(dispatchState, agent));
    assert.equal(result.text, 'The fixture is CEDAR.');
    assert.equal((await agent.read(receipt)).text, 'Checking the fixture.\n\nThe fixture is CEDAR.',
      'the real runtime folds both steps but the adapter retains the terminal step');
    assert.equal(reads, 1);
    assert.equal(calls, 2);
  } finally { await runtime.stop(); }
});

// --- Bounded reply observation (Cloudflare) -------------------------------

function withCloudflareTarget<T>(run: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Cloudflare-Workers' },
    configurable: true,
  });
  return run().finally(() => {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete (globalThis as { navigator?: unknown }).navigator;
  });
}

test('an interrupted bounded observation retains the receipt and reconnects without re-dispatch', async () => {
  let dispatches = 0;
  let settlements = 0;
  const dispatchState = state({
    recordSettlement: async (settlement) => { settlements += 1; return settlement; },
  });
  const agent = handle({
    dispatch: async () => { dispatches += 1; return RECEIPT; },
    read: async (_receipt, options) => {
      assert.equal(options, undefined, 'after settlement Flue reads once, with nothing to long-poll for');
      return { text: 'settled reply', data: {}, submissionId: RECEIPT.submissionId };
    },
  });
  const observed: string[] = [];
  await assert.rejects(
    () => promptSlackThreadAgent({
      ...promptInput(dispatchState, agent),
      observeReply: async () => { throw new TypeError('Network connection lost'); },
    }),
    (error: unknown) => error instanceof AgentPromptFailure && error.retryable,
  );
  assert.equal(dispatches, 1);
  assert.equal(settlements, 0);
  assert.deepEqual(dispatchState.dispatchReceipt, RECEIPT, 'the durable receipt survives the interruption');

  const recovered = await promptSlackThreadAgent({
    ...promptInput(dispatchState, agent),
    observeReply: async ({ handle: reader, receipt, instanceId, onEvent }) => {
      assert.equal(receipt.submissionId, RECEIPT.submissionId);
      assert.equal(instanceId, ENVELOPE.instanceId);
      onEvent({ type: 'message-started', conversationId: 'c', messageId: 'response',
        submissionId: RECEIPT.submissionId, position: { batch: 1, index: 0 } });
      observed.push('observed');
      return reader.read(receipt as never);
    },
  });
  assert.equal(recovered.text, 'settled reply');
  assert.deepEqual(observed, ['observed']);
  assert.equal(dispatches, 1, 'the retry observes the same submission; it never re-dispatches');
  assert.equal(settlements, 1);
});

test('a failed settlement read through the bounded reader keeps AgentRunError semantics', async () => {
  const dispatchState = state();
  await assert.rejects(() => promptSlackThreadAgent({
    ...promptInput(dispatchState, handle({
      async read() {
        throw new AgentRunError({ outcome: 'failed', submissionId: RECEIPT.submissionId,
          cause: { type: 'internal_error', message: 'private' } });
      },
    })),
    observeReply: async ({ handle: reader, receipt }) => reader.read(receipt as never),
  }), (error: unknown) => error instanceof AgentPromptFailure && !error.retryable);
  assert.equal(dispatchState.flueSettlement?.outcome, 'failed');
});

test('on Cloudflare the adapter observes through the agent namespace binding without a long-poll', async () => {
  await withCloudflareTarget(async () => {
    // Missing binding: fail before admitting a turn nobody could observe.
    let dispatches = 0;
    await assert.rejects(
      () => promptSlackThreadAgent({
        ...promptInput(state(), handle({ dispatch: async () => { dispatches += 1; return RECEIPT; } })),
        env: {},
      }),
      { name: 'AgentObjectBindingUnavailableError' },
    );
    assert.equal(dispatches, 0);

    const requests: URL[] = [];
    const pages = [
      [{ type: 'stream-checkpoint', incarnation: 1 }],
      [{ type: 'stream-checkpoint', incarnation: 1 },
        { type: 'submission-settled', submissionId: RECEIPT.submissionId, outcome: 'completed' }],
    ];
    const namespace = {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async (request: Request) => {
          const url = new URL(request.url);
          requests.push(url);
          assert.equal(id, ENVELOPE.instanceId);
          return Response.json(pages.shift(), { headers: {
            'Stream-Next-Offset': '0_1', ...(pages.length ? { 'Stream-Up-To-Date': 'true' } : {}),
          } });
        },
      }),
    };
    let reads = 0;
    const dispatchState = state();
    const started = Date.now();
    const result = await promptSlackThreadAgent({
      ...promptInput(dispatchState, handle({
        read: async (_receipt, options) => {
          reads += 1;
          assert.equal(options, undefined);
          return { text: 'done', data: {}, submissionId: RECEIPT.submissionId };
        },
      })),
      env: { FLUE_CHICKPEA_SLACK_V2_AGENT: namespace },
    });
    assert.equal(result.text, 'done');
    assert.equal(reads, 1);
    assert.equal(requests.length, 2);
    assert.ok(Date.now() - started >= 700, 'the idle page waited the real poll interval');
    for (const url of requests) {
      assert.equal(url.pathname, `/agents/chickpea-slack-v2/${ENVELOPE.instanceId}`);
      assert.equal(url.searchParams.get('view'), 'updates');
      assert.equal(url.searchParams.has('live'), false);
    }
    assert.equal(dispatchState.flueSettlement?.outcome, 'completed');
  });
});

test('a completed reply reports whether the Agent opened a coding workspace, without persisting it', async () => {
  const opened = state();
  const result = await promptSlackThreadAgent(promptInput(opened, handle({
    read: async () => ({
      text: 'done',
      data: { [CODING_WORKSPACE_USE_DATA_NAME]: [{ opened: true }] },
      submissionId: RECEIPT.submissionId,
      uid: RECEIPT.uid,
      metadata: {},
    }),
  })));
  assert.equal(result.codingWorkspaceOpened, true);
  assert.equal(
    opened.flueSettlement?.outcome === 'completed' && 'codingWorkspaceOpened' in opened.flueSettlement.result,
    false,
  );

  const plain = await promptSlackThreadAgent(promptInput(state(), handle({})));
  assert.equal(plain.codingWorkspaceOpened, false);
});

test('only a turn with an attached container fails as a sandbox failure', async () => {
  const sandboxFailure = () => handle({
    async read() {
      throw new AgentRunError({ outcome: 'failed', submissionId: RECEIPT.submissionId,
        cause: { type: 'sandbox_unavailable', message: 'The coding workspace is temporarily unavailable.' } });
    },
  });
  // A legacy attached container keeps the sandbox category.
  await assert.rejects(
    () => promptSlackThreadAgent({ ...promptInput(state(), sandboxFailure()), useCloudflareSandbox: true,
      prepareSandbox: async () => {} }),
    (error: unknown) => error instanceof AgentPromptFailure && error.kind === 'sandbox',
  );
  // The Agent in the virtual sandbox never fails its turn on a workspace.
  await assert.rejects(
    () => promptSlackThreadAgent(promptInput(state(), sandboxFailure())),
    (error: unknown) => error instanceof AgentPromptFailure && error.kind === 'agent',
  );
});

function milestone(
  name: WorkspaceMilestoneRecord['milestone'],
  milestoneState: WorkspaceMilestoneRecord['state'],
  toolCallId = 'call_a',
): WorkspaceMilestoneRecord {
  return { schemaVersion: 1, toolCallId, milestone: name, state: milestoneState };
}

test('workspace milestones of this submission reach the checklist in order, once, before settlement', async () => {
  const applied: string[] = [];
  const targets = new Set<string>();
  let appliedAtSettlement: string[] | undefined;
  const dispatchState = state({
    recordSettlement: async (settlement) => {
      appliedAtSettlement = [...applied];
      return settlement;
    },
  });
  const part = (messageId: string, data: unknown) => ({
    type: 'data-part', conversationId: 'c', messageId, name: WORKSPACE_MILESTONE_DATA_NAME, data,
  });
  const agent = handle({ read: async (_receipt, options) => {
    const emit = (chunk: unknown) => options?.onEvent?.(chunk as never);
    // A re-attached read replays an earlier submission first.
    emit({ type: 'message-started', conversationId: 'c', messageId: 'earlier', submissionId: 'submission_earlier' });
    emit(part('earlier', milestone('workspace', 'started', 'call_old')));
    emit({ type: 'message-started', conversationId: 'c', messageId: 'response', submissionId: RECEIPT.submissionId });
    emit(part('response', milestone('workspace', 'started')));
    emit(part('response', { schemaVersion: 1, toolCallId: 'call_a', milestone: 'workspace', state: 'done' }));
    emit(part('response', milestone('workspace', 'completed')));
    emit(part('response', milestone('workspace', 'started', 'call_b')));
    emit(part('response', milestone('changes', 'started')));
    return {
      text: 'done',
      submissionId: RECEIPT.submissionId,
      data: {
        // The settled reply carries every record, including one the live
        // stream missed.
        [WORKSPACE_MILESTONE_DATA_NAME]: [
          milestone('workspace', 'started'),
          milestone('workspace', 'completed'),
          milestone('changes', 'started'),
          milestone('changes', 'changed'),
        ],
      },
    };
  } });
  const result = await promptSlackThreadAgent({
    ...promptInput(dispatchState, agent),
    onWorkspaceMilestone: async (record, target) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      targets.add(`${target.instanceId}/${target.submissionId}`);
      applied.push(`${record.toolCallId}:${record.milestone}:${record.state}`);
    },
  });
  assert.equal(result.text, 'done');
  assert.deepEqual(applied, [
    'call_a:workspace:started',
    'call_a:workspace:completed',
    'call_a:changes:started',
    'call_a:changes:changed',
  ]);
  assert.deepEqual(appliedAtSettlement, applied, 'the checklist is applied before the answer settles');
  assert.deepEqual([...targets], [`${ENVELOPE.instanceId}/${RECEIPT.submissionId}`]);
});

test('the bounded reader sees an idle hint only while a milestone start is the last chunk', async () => {
  const hints: boolean[] = [];
  const part = (data: unknown) => ({
    type: 'data-part', conversationId: 'c', messageId: 'response', name: WORKSPACE_MILESTONE_DATA_NAME, data,
  });
  await promptSlackThreadAgent({
    ...promptInput(state(), handle({})),
    onWorkspaceMilestone: async () => {},
    observeReply: async ({ handle: reader, receipt, onEvent, isIdleCandidate }) => {
      assert.ok(isIdleCandidate, 'the dispatch passes the milestone relay hint');
      onEvent({ type: 'message-started', conversationId: 'c', messageId: 'response', submissionId: RECEIPT.submissionId } as never);
      hints.push(isIdleCandidate());
      onEvent(part(milestone('changes', 'started')) as never);
      hints.push(isIdleCandidate());
      onEvent(part(milestone('changes', 'changed')) as never);
      hints.push(isIdleCandidate());
      return reader.read(receipt as never);
    },
  });
  assert.deepEqual(hints, [false, true, false]);
});

test('a turn that already delegated a coding task seeds the reattached reader as idle', async () => {
  const seeds: unknown[] = [];
  for (const codingTaskStarted of [true, false]) {
    await promptSlackThreadAgent({
      ...promptInput(state(), handle({})),
      codingTaskStarted,
      observeReply: async ({ handle: reader, receipt, initialIdleCandidate }) => {
        seeds.push(initialIdleCandidate);
        return reader.read(receipt as never);
      },
    });
  }
  assert.deepEqual(seeds, [true, undefined]);
});

test('a failing checklist update never fails or delays the answer', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const seen: string[] = [];
  const agent = handle({ read: async (_receipt, options) => {
    options?.onEvent?.({ type: 'message-started', conversationId: 'c', messageId: 'response',
      submissionId: RECEIPT.submissionId } as never);
    options?.onEvent?.({ type: 'data-part', conversationId: 'c', messageId: 'response',
      name: WORKSPACE_MILESTONE_DATA_NAME, data: milestone('workspace', 'started') } as never);
    return { text: 'done', submissionId: RECEIPT.submissionId,
      data: { [WORKSPACE_MILESTONE_DATA_NAME]: [milestone('workspace', 'completed')] } };
  } });
  const dispatchState = state();
  const result = await promptSlackThreadAgent({
    ...promptInput(dispatchState, agent),
    onWorkspaceMilestone: async (record) => {
      seen.push(record.state);
      throw new Error('Slack Agent View presentation writer is stale.');
    },
  });
  assert.equal(result.text, 'done');
  assert.equal(dispatchState.flueSettlement?.outcome, 'completed');
  assert.deepEqual(seen, ['started', 'completed'], 'a failed record does not stop later ones');
});

test('a turn whose reply never settles yields on abort, keeps its receipt, and reattaches once', async () => {
  let dispatches = 0;
  let settlements = 0;
  const relayOperations: string[] = [];
  const relay: SlackProgressiveReadRelay = {
    onEvent() {},
    async closeAndDrain() {
      relayOperations.push('closed');
      return { acceptedChunks: 0, acceptedBytes: 0, targetMessageCompleted: true, invalidated: false };
    },
    async invalidateAndDrain(reason) {
      relayOperations.push(`invalid:${reason}`);
      return { acceptedChunks: 0, acceptedBytes: 0, targetMessageCompleted: false, invalidated: true };
    },
    async suspendAndDrain() {
      relayOperations.push('suspended');
      return { acceptedChunks: 0, acceptedBytes: 0, targetMessageCompleted: false, invalidated: false };
    },
  };
  const dispatchState = state({
    recordSettlement: async (settlement) => { settlements += 1; return settlement; },
  });
  const agent = handle({
    dispatch: async () => { dispatches += 1; return RECEIPT; },
    read: async () => ({ text: 'final answer', data: {}, submissionId: RECEIPT.submissionId }),
  });
  // The real bounded reader against an agent whose stream never settles.
  let polls = 0;
  const controller = new AbortController();
  const neverSettles = createBoundedAgentReplyReader({
    agentName: 'chickpea-slack-v2',
    resolveRoute: () => async () => {
      polls += 1;
      if (polls === 3) controller.abort(new Error('alarm budget'));
      return Response.json([{ type: 'stream-checkpoint', incarnation: 1 }], {
        headers: { 'Stream-Next-Offset': '1', 'Stream-Up-To-Date': 'true' },
      });
    },
    pollIntervalMs: 1,
  });
  let observing = 0;
  await assert.rejects(
    () => promptSlackThreadAgent({
      ...promptInput(dispatchState, agent),
      observeReply: neverSettles,
      observationSignal: controller.signal,
      onObservationStarted: () => { observing += 1; },
      prepareProgressiveRelay: async () => relay,
    }),
    (error: unknown) => error instanceof AgentObservationYield && error.retryable &&
      !error.recoveryRequired,
  );
  assert.equal(observing, 1);
  assert.equal(dispatches, 1);
  assert.equal(settlements, 0, 'a yield settles nothing');
  assert.deepEqual(dispatchState.dispatchReceipt, RECEIPT, 'the durable receipt survives the yield');
  assert.equal(dispatchState.flueSettlement, undefined);
  assert.deepEqual(relayOperations, ['suspended'], 'the stream stays open for reattachment');

  const settled = createBoundedAgentReplyReader({
    agentName: 'chickpea-slack-v2',
    resolveRoute: () => async () => Response.json([
      { type: 'stream-checkpoint', incarnation: 1 },
      { type: 'submission-settled', submissionId: RECEIPT.submissionId, outcome: 'completed',
        position: { batch: 1, index: 0 } },
    ]),
  });
  const result = await promptSlackThreadAgent({
    ...promptInput(dispatchState, agent),
    observeReply: settled,
    observationSignal: new AbortController().signal,
    prepareProgressiveRelay: async () => relay,
  });
  assert.equal(result.text, 'final answer');
  assert.equal(dispatches, 1, 'reattachment never re-dispatches');
  assert.equal(settlements, 1);
  assert.deepEqual(relayOperations, ['suspended', 'closed']);
});

test('a settled failure observed as the budget ends keeps its failure semantics', async () => {
  const controller = new AbortController();
  const dispatchState = state();
  await assert.rejects(() => promptSlackThreadAgent({
    ...promptInput(dispatchState, handle({
      async read() {
        controller.abort();
        throw new AgentRunError({ outcome: 'failed', submissionId: RECEIPT.submissionId,
          cause: { type: 'internal_error', message: 'private' } });
      },
    })),
    observeReply: async ({ handle: reader, receipt }) => reader.read(receipt as never),
    observationSignal: controller.signal,
  }), (error: unknown) => error instanceof AgentPromptFailure &&
    !(error instanceof AgentObservationYield) && !error.retryable);
  assert.equal(dispatchState.flueSettlement?.outcome, 'failed');
});

test('a missing agent instance found after the budget abort still requires recovery', async () => {
  const controller = new AbortController();
  const reasons: string[] = [];
  const dispatchState = state({ markRecoveryRequired: async (reason) => { reasons.push(reason); } });
  await assert.rejects(() => promptSlackThreadAgent({
    ...promptInput(dispatchState, handle({})),
    observeReply: async () => {
      controller.abort(new Error('alarm budget'));
      throw new AgentInstanceNotFoundError({ id: ENVELOPE.instanceId });
    },
    observationSignal: controller.signal,
  }), (error: unknown) => error instanceof AgentPromptFailure &&
    !(error instanceof AgentObservationYield) && error.recoveryRequired);
  assert.deepEqual(reasons, ['flue_expected_instance_missing']);
});
