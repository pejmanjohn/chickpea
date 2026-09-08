import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSlackChickpeaHandoff,
  createSlackManagementTurnGuard,
  invokeCloudflareSlackScheduleAction,
  invokeCloudflareSlackWorkspaceManagementTool,
  type SlackManagementSignal,
} from '../src/management/slack-tools.ts';

const SIGNAL: SlackManagementSignal = {
  agentId: 'agent_support',
  workspaceId: 'T_ACME',
  channelId: 'C_SUPPORT',
  threadTs: '100.001',
  slackUserId: 'U_REQUESTER',
  eventId: 'Ev_management_rpc',
  messageTs: '100.002',
  turnJobId: 'turn_management_rpc',
};

test('cross-Agent handoffs are read-only and bound to the trusted acting Agent', () => {
  assert.deepEqual(createSlackChickpeaHandoff(SIGNAL, 'cross_agent'), {
    ok: true,
    result: {
      kind: 'chickpea_handoff',
      chickpeaAgentId: 'agent_chickpea',
      actingAgentId: 'agent_support',
      reason: 'cross_agent',
      instruction: 'Mention @Chickpea in this thread and ask it to continue the same request. Chickpea will re-check your permissions before inspecting or changing anything.',
    },
  });
});

test('Cloudflare Slack management sends one complete requester-bound state RPC', async () => {
  const calls: unknown[] = [];
  const result = await invokeCloudflareSlackWorkspaceManagementTool({
    stub: {
      async workspaceManagementInvoke(request) {
        calls.push(request);
        return { ok: true, result: { agents: [] } };
      },
    },
    signal: SIGNAL,
    name: 'inspect_workspace',
    args: {},
  });

  assert.deepEqual(result, { ok: true, result: { agents: [] } });
  assert.deepEqual(calls, [{
    signal: SIGNAL,
    name: 'inspect_workspace',
    args: {},
  }]);
});

test('Cloudflare Slack management keeps failed-confirmation turn guards local', async () => {
  const calls: unknown[] = [];
  const persisted: unknown[] = [];
  const guard = createSlackManagementTurnGuard(
    SIGNAL.turnJobId,
    { turnJobId: SIGNAL.turnJobId },
    (state) => persisted.push(state),
  );
  const stub = {
    async workspaceManagementInvoke(request: unknown) {
      calls.push(request);
      return {
        ok: false as const,
        error: { code: 'proposal_stale', message: 'The proposal is stale.' },
      };
    },
  };

  const confirmation = await invokeCloudflareSlackWorkspaceManagementTool({
    stub,
    signal: SIGNAL,
    name: 'confirm_workspace_change',
    args: { proposalId: 'changeset_stale' },
    turnGuard: guard,
  });
  assert.equal(confirmation.ok, false);
  assert.deepEqual(persisted, [{
    turnJobId: SIGNAL.turnJobId,
    confirmationFailure: {
      code: 'proposal_stale',
      proposalId: 'changeset_stale',
    },
  }]);

  const blocked = await invokeCloudflareSlackWorkspaceManagementTool({
    stub,
    signal: SIGNAL,
    name: 'apply_workspace_changes',
    args: { idempotencyKey: 'blocked-write', operations: [] },
    turnGuard: guard,
  });
  assert.equal(blocked.ok, false);
  if (blocked.ok) assert.fail('expected a guarded write failure');
  assert.equal(blocked.error.code, 'fresh_approval_required');
  assert.equal(calls.length, 1);
});

test('Cloudflare Slack management sanitizes an unavailable state RPC', async () => {
  const result = await invokeCloudflareSlackWorkspaceManagementTool({
    stub: {
      async workspaceManagementInvoke() {
        throw new Error('secret remote failure');
      },
    },
    signal: SIGNAL,
    name: 'inspect_workspace',
    args: {},
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'management_error',
      message: 'The workspace management request failed.',
    },
  });
});

test('Cloudflare Slack management latches an unknown write outcome for the turn', async () => {
  const calls: unknown[] = [];
  const persisted: unknown[] = [];
  const guard = createSlackManagementTurnGuard(
    SIGNAL.turnJobId,
    { turnJobId: SIGNAL.turnJobId },
    (state) => persisted.push(state),
  );
  const stub = {
    async workspaceManagementInvoke(request: unknown) {
      calls.push(request);
      throw new Error('transport closed after submission');
    },
  };

  const ambiguous = await invokeCloudflareSlackWorkspaceManagementTool({
    stub,
    signal: SIGNAL,
    name: 'apply_workspace_changes',
    args: { idempotencyKey: 'apply-unknown', operations: [] },
    turnGuard: guard,
  });
  assert.deepEqual(ambiguous, {
    ok: false,
    error: {
      code: 'management_outcome_unknown',
      message: 'The workspace change outcome is unknown. Do not retry it or make a different workspace change in this turn. Inspect current state in a new message before deciding what to do next.',
    },
  });
  assert.deepEqual(persisted, [{
    turnJobId: SIGNAL.turnJobId,
    confirmationFailure: {
      code: 'management_outcome_unknown',
      proposalId: 'apply-unknown',
      outcome: 'unknown',
    },
  }]);

  const blocked = await invokeCloudflareSlackWorkspaceManagementTool({
    stub,
    signal: SIGNAL,
    name: 'undo_workspace_change',
    args: { operationId: 'operation-other', idempotencyKey: 'undo-other' },
    turnGuard: guard,
  });
  assert.equal(blocked.ok, false);
  if (blocked.ok) assert.fail('expected a guarded write failure');
  assert.equal(blocked.error.code, 'fresh_approval_required');
  assert.match(blocked.error.message, /unknown outcome/i);
  assert.equal(calls.length, 1);
});

test('Cloudflare Slack management also latches setup-link transport ambiguity', async () => {
  const calls: unknown[] = [];
  const guard = createSlackManagementTurnGuard(
    SIGNAL.turnJobId,
    { turnJobId: SIGNAL.turnJobId },
  );
  const stub = {
    async workspaceManagementInvoke(request: unknown) {
      calls.push(request);
      throw new Error('transport closed after setup submission');
    },
  };

  const ambiguous = await invokeCloudflareSlackWorkspaceManagementTool({
    stub,
    signal: SIGNAL,
    name: 'prepare_connector_setup',
    args: { agentId: 'agent_support', connector: 'sentry', ownerKind: 'team' },
    turnGuard: guard,
  });
  assert.equal(ambiguous.ok, false);
  if (ambiguous.ok) assert.fail('expected an unknown setup outcome');
  assert.equal(ambiguous.error.code, 'management_outcome_unknown');

  const blocked = await invokeCloudflareSlackWorkspaceManagementTool({
    stub,
    signal: SIGNAL,
    name: 'revoke_setup_link',
    args: { setupOperationId: 'setup-other', reissue: true },
    turnGuard: guard,
  });
  assert.equal(blocked.ok, false);
  if (blocked.ok) assert.fail('expected a guarded setup-link write');
  assert.equal(blocked.error.code, 'fresh_approval_required');
  assert.equal(calls.length, 1);
});

test('first-class schedule RPC retries the same host-bound action without an unknown outcome', async () => {
  const calls: unknown[] = [];
  const operation = {
    itemId: 'schedule',
    kind: 'save_routine' as const,
    agentId: SIGNAL.agentId,
    workspaceId: SIGNAL.workspaceId,
    channelId: SIGNAL.channelId,
    name: 'Follow up',
    description: 'Check again later.',
    taskText: 'Check again and report anything new.',
    schedule: { kind: 'in' as const, minutes: 5 },
    timezone: 'UTC',
    outputPolicy: 'post_on_change' as const,
  };
  const result = await invokeCloudflareSlackScheduleAction({
    stub: {
      async slackScheduleActionInvoke(request) {
        calls.push(request);
        if (calls.length === 1) throw new Error('response transport closed');
        return {
          outcome: 'applied',
          effect: 'saved',
          routineId: 'routine_follow_up',
          routineVersion: 1,
        };
      },
    },
    signal: SIGNAL,
    operation,
  });

  assert.equal(result.outcome, 'applied');
  assert.deepEqual(calls, [
    { signal: SIGNAL, operation },
    { signal: SIGNAL, operation },
  ]);
});
