import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createSlackAgentCreationTurnCoordinator,
  type SlackAgentCreationTurnState,
} from '../src/management/slack-tools.ts';
import type { ManagementOperation } from '../src/management/types.ts';
import {
  parseSlackAgentCreationTerminalIntents,
  SLACK_AGENT_CREATION_TERMINAL_DATA_NAME,
} from '../src/slack/agent-creation-terminal.ts';
import { resultFromAgentReply } from '../src/slack/flue-dispatch.ts';

const createOperation: Extract<ManagementOperation, { kind: 'create_agent' }> = {
  itemId: 'create',
  kind: 'create_agent',
  agent: {
    id: 'agent_deck',
    name: 'Deck',
    description: 'Creates polished presentations.',
    requestedHandle: 'deck',
    editPolicy: 'all_workspace_members',
    instructions: 'Create polished presentations.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  },
};

const appliedResult = {
  ok: true as const,
  result: {
    operationId: 'management_create_deck',
    idempotencyKey: 'ignored-model-key',
    status: 'completed' as const,
    outcomes: [{
      itemId: 'create',
      operationKind: 'create_agent' as const,
      disposition: 'applied' as const,
      changed: [{ kind: 'agent' as const, id: 'agent_deck', revision: 1 }],
    }],
    effectiveRevision: 'revision_create_deck',
    activation: 'next_turn' as const,
  },
};

test('Slack creation freezes one turn-derived operation and resumes it after interruption', () => {
  let persisted: SlackAgentCreationTurnState = { turnJobId: 'turn_create_deck' };
  const first = createSlackAgentCreationTurnCoordinator(
    'turn_create_deck',
    persisted,
    (state) => { persisted = structuredClone(state); },
  );
  const prepared = first.prepare({
    idempotencyKey: 'model-selected-key',
    operations: [createOperation],
    connectorMentions: ['Google Slides', 'Notion', 'Google Slides'],
  });
  assert.match(prepared.idempotencyKey, /^slackcreate_[a-f0-9]{40}$/);
  assert.notEqual(prepared.idempotencyKey, 'model-selected-key');
  assert.deepEqual(prepared.operations, [createOperation]);
  assert.deepEqual(prepared.connectorMentions, ['Google Slides', 'Notion']);

  const resumed = createSlackAgentCreationTurnCoordinator('turn_create_deck', persisted).prepare({
    idempotencyKey: 'another-model-key',
    operations: [createOperation],
    connectorMentions: ['Slack'],
  });
  assert.deepEqual(resumed, prepared);

  const changedCreate = structuredClone(createOperation);
  changedCreate.agent.name = 'A second Agent';
  assert.throws(
    () => createSlackAgentCreationTurnCoordinator('turn_create_deck', persisted).prepare({
      idempotencyKey: 'another-model-key',
      operations: [changedCreate],
      connectorMentions: ['Slack'],
    }),
    /Only one base Agent can be created in a Slack turn/,
  );

  const updateOperation: ManagementOperation = {
    itemId: 'reach',
    kind: 'grant_agent_channel',
    workspaceId: 'T_DEMO',
    channelId: 'C_SECOND',
    agentId: 'agent_deck',
    expectedRevision: 0,
  };
  assert.deepEqual(
    createSlackAgentCreationTurnCoordinator('turn_create_deck', persisted).prepare({
      idempotencyKey: 'follow-on-key',
      operations: [updateOperation],
    }),
    {
      idempotencyKey: 'follow-on-key',
      operations: [updateOperation],
      connectorMentions: [],
      creation: false,
    },
  );
});

test('a duplicate clarification can be corrected once within the same creation turn', () => {
  let persisted: SlackAgentCreationTurnState = { turnJobId: 'turn_distinct_deck' };
  const coordinator = createSlackAgentCreationTurnCoordinator(
    'turn_distinct_deck',
    persisted,
    (state) => { persisted = structuredClone(state); },
  );
  const first = coordinator.prepare({
    idempotencyKey: 'model-key',
    operations: [createOperation],
  });
  coordinator.record({
    ok: true,
    result: {
      status: 'clarification_required',
      clarification: {
        kind: 'duplicate_agent_identity',
        requested: { name: 'Deck', handle: 'deck' },
        matches: [{ id: 'agent_existing_deck', name: 'Deck', handle: 'deck' }],
        options: ['use_existing', 'create_distinct'],
      },
      presentation: { slack: 'Choose the existing Agent or create a distinct one.' },
    },
  });

  const distinct = structuredClone(createOperation);
  distinct.duplicateResolution = 'create_distinct';
  distinct.agent.requestedHandle = 'deck-distinct';
  const corrected = coordinator.prepare({
    idempotencyKey: 'another-model-key',
    operations: [distinct],
    connectorMentions: ['Google Slides'],
  });

  assert.equal(corrected.idempotencyKey, first.idempotencyKey);
  assert.deepEqual(corrected.operations, [distinct]);
  assert.deepEqual(corrected.connectorMentions, ['Google Slides']);
  assert.equal(persisted.frozenOutcome, undefined);
});

test('an applied create records one bounded terminal intent while other outcomes do not', () => {
  let persisted: SlackAgentCreationTurnState = { turnJobId: 'turn_create_deck' };
  const written: unknown[] = [];
  const coordinator = createSlackAgentCreationTurnCoordinator(
    'turn_create_deck',
    persisted,
    (state) => { persisted = structuredClone(state); },
    (intent) => { written.push(structuredClone(intent)); },
  );
  coordinator.prepare({
    idempotencyKey: 'model-key',
    operations: [createOperation],
    connectorMentions: ['Google Slides'],
  });
  const intent = coordinator.record(appliedResult);
  coordinator.record(appliedResult);
  assert.deepEqual(intent, {
    schemaVersion: 1,
    operationId: 'management_create_deck',
    creationItemId: 'create',
    agentId: 'agent_deck',
    connectorMentions: ['Google Slides'],
    followOnNotices: [],
  });
  assert.deepEqual(persisted.terminalIntent, intent);
  assert.deepEqual(written, [intent]);

  const withProposal = coordinator.recordFollowOn({
    ok: true,
    result: {
      proposalId: 'proposal_reach',
      status: 'pending',
      presentation: { slack: 'Add Deck to <#C_SECOND>? Reply `approve` to continue.' },
    },
  });
  assert.deepEqual(withProposal?.followOnNotices, [{
    kind: 'proposal',
    text: 'Add Deck to <#C_SECOND>? Reply `approve` to continue.',
  }]);
  assert.deepEqual(written, [intent, withProposal]);

  const longProposal = `Review this separate change: ${'detail '.repeat(100)}`;
  const withLongProposal = coordinator.recordFollowOn({
    ok: true,
    result: {
      proposalId: 'proposal_long',
      status: 'pending',
      presentation: { slack: longProposal },
    },
  });
  assert.equal(withLongProposal?.followOnNotices[1]?.text, longProposal.trim());

  const recoveredWrites: unknown[] = [];
  const recovered = createSlackAgentCreationTurnCoordinator(
    'turn_create_deck',
    persisted,
    () => undefined,
    (value) => recoveredWrites.push(value),
  );
  recovered.record(appliedResult);
  recovered.record(appliedResult);
  assert.deepEqual(recoveredWrites, [withLongProposal]);

  const duplicateWrites: unknown[] = [];
  const duplicate = createSlackAgentCreationTurnCoordinator(
    'turn_duplicate_deck',
    { turnJobId: 'turn_duplicate_deck' },
    () => undefined,
    (value) => duplicateWrites.push(value),
  );
  duplicate.prepare({ idempotencyKey: 'duplicate', operations: [createOperation] });
  assert.equal(duplicate.record({
    ok: true,
    result: {
      status: 'clarification_required',
      clarification: {
        kind: 'duplicate_agent_identity',
        requested: { name: 'Deck', handle: 'deck' },
        matches: [{ id: 'agent_existing', name: 'Deck', handle: 'deck' }],
        options: ['use_existing', 'create_distinct'],
      },
      presentation: { slack: 'Use the existing Agent or create a distinct one?' },
    },
  }), undefined);
  assert.deepEqual(duplicateWrites, []);
});

test('creation reply data survives reduction and malformed metadata cannot claim the final', () => {
  const terminal = {
    schemaVersion: 1 as const,
    operationId: 'management_create_deck',
    creationItemId: 'create',
    agentId: 'agent_deck',
    connectorMentions: ['Google Slides', 'Notion'],
    followOnNotices: [],
  };
  const result = resultFromAgentReply({
    text: 'Model prose that the Slack host will suppress.',
    data: { [SLACK_AGENT_CREATION_TERMINAL_DATA_NAME]: [terminal] },
    metadata: {},
    submissionId: 'submission_create_deck',
    uid: 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  }, null);
  assert.deepEqual(result.agentCreationTerminal, terminal);

  assert.deepEqual(parseSlackAgentCreationTerminalIntents([{ ...terminal, setupUrl: 'https://bad' }]), []);
  const withPending = {
    ...terminal,
    followOnNotices: [{ kind: 'pending' as const, text: 'A separate change is pending.' }],
  };
  assert.deepEqual(parseSlackAgentCreationTerminalIntents([terminal, withPending]), [withPending]);
  assert.deepEqual(parseSlackAgentCreationTerminalIntents([
    terminal,
    { ...withPending, operationId: 'management_create_other' },
  ]), []);
  assert.deepEqual(parseSlackAgentCreationTerminalIntents([
    withPending,
    { ...terminal, followOnNotices: [] },
  ]), []);
  assert.deepEqual(parseSlackAgentCreationTerminalIntents([{
    ...terminal,
    connectorMentions: Array.from({ length: 13 }, (_, index) => `Connector ${index}`),
  }]), []);
});
