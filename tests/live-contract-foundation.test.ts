import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_LIFECYCLE_CONTRACT,
  evaluateAgentArchive,
  evaluateAgentLifecycle,
} from '../qa/live/cases/agent-lifecycle.live.ts';
import {
  CONNECTOR_SETUP_CONTRACT,
  evaluateConnectorSetup,
} from '../qa/live/cases/connector-setup.live.ts';
import {
  CHANNEL_SCHEDULE_CONTRACT,
  evaluateChannelSchedule,
  evaluateRoutineCleanup,
} from '../qa/live/cases/channel-schedule.live.ts';
import { LIVE_MANIFEST } from '../qa/live/manifest.ts';

test('foundation case modules cover exactly the manifest foundation variants', () => {
  const authored = [
    AGENT_LIFECYCLE_CONTRACT,
    CONNECTOR_SETUP_CONTRACT,
    CHANNEL_SCHEDULE_CONTRACT,
  ].flatMap(({ variants }) => variants.map(({ id }) => id)).sort();
  assert.deepEqual(authored, LIVE_MANIFEST.requiredVariants.deep);
});

test('case adapters reject normalized assertion tokens as upstream input', () => {
  for (const evaluate of [evaluateAgentLifecycle, evaluateConnectorSetup, evaluateChannelSchedule]) {
    assert.throws(
      () => evaluate('invalid-variant' as never, { observedTokens: ['agent.exists'] }),
      /INVALID_UPSTREAM_SHAPE|UNKNOWN_VARIANT/,
    );
  }
});

test('LC-01 normalizes real Agent, welcome outbox, Slack history, and presentation shapes', () => {
  const created = evaluateAgentLifecycle('LC01-V1-create-welcome', agentCreateFixture());
  assert.equal(created.pass, true);
  assert.deepEqual(created.observedTokens, [
    'agent.exists', 'slack.message_matches', 'forbidden.no_duplicate',
  ]);

  const updated = evaluateAgentLifecycle('LC01-V2-update-approve', agentUpdateFixture());
  assert.equal(updated.pass, true);
  assert.deepEqual(updated.observedTokens, [
    'agent.instructions_equal', 'forbidden.no_early_mutation',
  ]);
});

test('LC-01 catches welcome publication, presence, duplication, and lingering activity regressions', () => {
  const cases: Array<[string, (fixture: any) => void]> = [
    ['welcome_missing', (fixture) => { fixture.slack.messages = []; }],
    ['welcome_duplicate', (fixture) => { fixture.slack.messages.push(structuredClone(fixture.slack.messages[0])); }],
    ['welcome_wrong_channel', (fixture) => { fixture.admin.outboxes[0].destination.channelId = 'C_OTHER'; }],
    ['welcome_false_claim', (fixture) => {
      fixture.admin.outboxes[0].receipt.publication = { status: 'partial', incomplete: ['source_channel'] };
    }],
    ['presence_missing', (fixture) => { fixture.admin.agents[0].slackPresence.health = 'needs_attention'; }],
    ['activity_lingering', (fixture) => { fixture.admin.presentation.activityProjection.state = 'visible'; }],
  ];
  for (const [failure, mutate] of cases) {
    const fixture = agentCreateFixture();
    mutate(fixture);
    assert.equal(evaluateAgentLifecycle('LC01-V1-create-welcome', fixture).failures.includes(failure as never), true, failure);
  }
});

test('LC-01 catches reaction-only or misbound approval and full-value persistence regressions', () => {
  const cases: Array<[string, (fixture: any) => void]> = [
    ['proposal_binding_mismatch', (fixture) => { fixture.admin.proposal.actorUserId = 'U_OTHER'; }],
    ['reaction_only_approval', (fixture) => {
      fixture.slack.messages = [];
      fixture.slack.reactions = [{ user: 'U_OWNER', name: 'white_check_mark' }];
    }],
    ['frozen_value_mismatch', (fixture) => { fixture.admin.proposal.operations[0].patch.instructions = 'truncated'; }],
    ['durable_value_truncated', (fixture) => { fixture.admin.agent.instructions = 'truncated'; }],
    ['revision_not_advanced', (fixture) => { fixture.admin.agent.revision = 4; }],
    ['early_mutation', (fixture) => { fixture.admin.preApprovalRevision = 5; }],
    ['activity_lingering', (fixture) => { fixture.admin.presentation.activityProjection.state = 'visible'; }],
  ];
  for (const [failure, mutate] of cases) {
    const fixture = agentUpdateFixture();
    mutate(fixture);
    const result = evaluateAgentLifecycle('LC01-V2-update-approve', fixture);
    assert.equal(result.failures.includes(failure as never), true, failure);
  }
});

test('LC-01 cleanup proves the exact archived Agent and attributed tombstone', () => {
  const fixture = {
    expectedAgentId: 'agent_qa_alpha',
    runMarker: 'qa-alpha01',
    admin: { agent: { id: 'agent_qa_alpha', lifecycle: 'archived', routes: [] } },
    residue: { kind: 'agent_tombstone', agentId: 'agent_qa_alpha', runMarker: 'qa-alpha01' },
  };
  assert.equal(evaluateAgentArchive(fixture).pass, true);
  fixture.admin.agent.routes.push({ channelId: 'C_QA', active: true } as never);
  assert.deepEqual(evaluateAgentArchive(fixture).failures, ['active_route_remains']);
});

test('LC-04 normalizes actual setup, account, Agent binding, and Sheets result shapes', () => {
  const personal = evaluateConnectorSetup('LC04-V1-personal-read', connectorFixture('member'));
  assert.equal(personal.pass, true);
  assert.deepEqual(personal.observedTokens, ['connection.owner_personal', 'forbidden.no_cross_agent_reuse']);

  const team = evaluateConnectorSetup('LC04-V2-team-read', connectorFixture('team'));
  assert.equal(team.pass, true);
  assert.deepEqual(team.observedTokens, ['connection.owner_team', 'forbidden.no_cross_agent_reuse']);

  const race = evaluateConnectorSetup('LC04-V3-editor-race', connectorFixture('member', true));
  assert.equal(race.pass, true);
  assert.deepEqual(race.observedTokens, [
    'connection.editor_attributed', 'forbidden.no_cross_agent_reuse', 'forbidden.no_duplicate',
  ]);
});

test('LC-04 catches hidden ownership, attribution, binding, provider, tool, replay, and activity failures', () => {
  const cases: Array<[string, (fixture: any) => void, boolean?]> = [
    ['ownership_not_selected', (fixture) => { fixture.setupForm.ownerKind = ''; }],
    ['editor_not_authorized', (fixture) => { fixture.admin.setups[0].completedByUserId = 'U_OTHER'; }],
    ['completion_attribution_mismatch', (fixture) => { fixture.admin.accounts[0].createdByMembershipId = 'membership_other'; }],
    ['agent_binding_missing', (fixture) => { fixture.admin.bindings = []; }],
    ['provider_account_mismatch', (fixture) => { fixture.admin.accounts[0].policy.accountRef = 'ca_other'; }],
    ['provider_grant_missing', (fixture) => { fixture.provider.connected_accounts = []; }],
    ['tool_read_failed', (fixture) => { fixture.provider.tool_result.successful = false; }],
    ['marker_row_missing', (fixture) => { fixture.provider.tool_result.data.values.splice(1); }],
    ['activity_lingering', (fixture) => { fixture.admin.presentation.activityProjection.state = 'visible'; }],
    ['setup_replayed', (fixture) => { fixture.provider.callbacks[1].result = 'completed'; }, true],
    ['duplicate_completion', (fixture) => {
      fixture.admin.setups.push(structuredClone(fixture.admin.setups[0]));
    }, true],
    ['stale_callback_won', (fixture) => { fixture.provider.callbacks[0].completedByUserId = 'U_FIRST'; }, true],
  ];
  for (const [failure, mutate, race] of cases) {
    const fixture = connectorFixture('member', race === true);
    mutate(fixture);
    const variant = race ? 'LC04-V3-editor-race' : 'LC04-V1-personal-read';
    assert.equal(evaluateConnectorSetup(variant, fixture).failures.includes(failure as never), true, failure);
  }
});

test('LC-08 normalizes RoutineDefinition, RoutineRun, audit, and Slack history shapes', () => {
  const due = evaluateChannelSchedule('LC08-V1-create-due', routineDueFixture());
  assert.equal(due.pass, true);
  assert.deepEqual(due.observedTokens, [
    'routine.exists', 'routine.due_delivery', 'forbidden.no_duplicate',
  ]);
  assert.equal(evaluateChannelSchedule('LC08-V2-pause-resume', routinePauseFixture()).pass, true);
  assert.equal(evaluateChannelSchedule('LC08-V3-run-now', routineRunNowFixture()).pass, true);
});

test('LC-08 catches saved-only, duplicate, wrong-thread, occurrence, and temporal-control regressions', () => {
  const dueCases: Array<[string, (fixture: any) => void]> = [
    ['ack_missing', (fixture) => { fixture.slack.messages.splice(0, 1); }],
    ['ack_duplicate', (fixture) => { fixture.slack.messages.push(structuredClone(fixture.slack.messages[0])); }],
    ['due_delivery_missing', (fixture) => { fixture.slack.messages.splice(1, 1); }],
    ['due_delivery_duplicate', (fixture) => { fixture.slack.messages.push(structuredClone(fixture.slack.messages[1])); }],
    ['wrong_origin_thread', (fixture) => { fixture.slack.messages[1].thread_ts = '1700000000.999999'; }],
    ['occurrence_missing', (fixture) => { fixture.admin.runs = []; }],
    ['activity_lingering', (fixture) => { fixture.admin.presentation.activityProjection.state = 'visible'; }],
  ];
  for (const [failure, mutate] of dueCases) {
    const fixture = routineDueFixture();
    mutate(fixture);
    assert.equal(evaluateChannelSchedule('LC08-V1-create-due', fixture).failures.includes(failure as never), true, failure);
  }

  const pause = routinePauseFixture();
  pause.admin.runs = pause.admin.runs.filter((run: any) => run.status !== 'cancelled');
  assert.equal(evaluateChannelSchedule('LC08-V2-pause-resume', pause).failures.includes('pause_not_effective'), true);
  const drift = routinePauseFixture();
  drift.admin.routine.scheduleJson = '{"kind":"cron","expression":"changed"}';
  assert.equal(evaluateChannelSchedule('LC08-V2-pause-resume', drift).failures.includes('schedule_drift'), true);
  const noResume = routinePauseFixture();
  noResume.admin.runs = noResume.admin.runs.filter((run: any) => run.status !== 'succeeded');
  assert.equal(evaluateChannelSchedule('LC08-V2-pause-resume', noResume).failures.includes('resume_not_effective'), true);

  const duplicate = routineRunNowFixture();
  duplicate.admin.runs.push(structuredClone(duplicate.admin.runs[0]!));
  assert.equal(evaluateChannelSchedule('LC08-V3-run-now', duplicate).failures.includes('run_now_duplicate'), true);
});

test('LC-08 cleanup verifies deletion by immutable Routine ID', () => {
  assert.equal(evaluateRoutineCleanup({
    expectedRoutineId: 'routine_qa_alpha',
    deletion: { routine_id: 'routine_qa_alpha' },
    readback: { routine: null, status: 'absent' },
  }).pass, true);
});

function agentCreateFixture() {
  return {
    request: {
      runMarker: 'qa-alpha01', expectedAgentName: 'Calendar qa-alpha01',
      sourceChannelId: 'C_QA', sourceThreadTs: '1700000000.000100',
    },
    admin: {
      agents: [{
        id: 'agent_qa_alpha', revision: 1, name: 'Calendar qa-alpha01', lifecycle: 'active',
        slackPresence: { requestedHandle: 'calendar-qa-alpha01', normalizedHandle: 'calendar-qa-alpha01', desiredState: 'active', health: 'healthy' },
      }],
      channelGrants: [{ agentId: 'agent_qa_alpha', channelId: 'C_QA', status: 'active', revision: 1 }],
      outboxes: [{
        outboxId: 'agent_welcome_operation_alpha', operationId: 'operation_alpha', status: 'delivered',
        destination: { kind: 'thread', workspaceId: 'T_QA', channelId: 'C_QA', threadTs: '1700000000.000100' },
        receipt: {
          kind: 'agent_created_welcome', creationOperationId: 'operation_alpha', agentId: 'agent_qa_alpha',
          agentName: 'Calendar qa-alpha01', requesterMembershipId: 'membership_owner', surface: 'channel',
          persona: { name: 'Calendar qa-alpha01' }, publication: { status: 'complete', incomplete: [] },
        },
        deliveryRef: 'slack:C_QA:1700000000.000200',
      }],
      presentation: { activityProjection: { surface: 'assistant_status', state: 'cleared' } },
    },
    slack: { messages: [{
      type: 'message', ts: '1700000000.000200', channel: 'C_QA', thread_ts: '1700000000.000100',
      text: 'Calendar qa-alpha01 is ready.',
    }] },
  };
}

function agentUpdateFixture() {
  const fullInstructions = `Schedule only after checking conflicts. ${'Keep the full approved policy. '.repeat(100)}`;
  return {
    request: {
      runMarker: 'qa-alpha02', agentId: 'agent_qa_alpha', requesterUserId: 'U_OWNER',
      threadTs: '1700000000.000300', approvalScopeKey: 'slack:T_QA:C_QA:1700000000.000300:agent:agent_chickpea',
      fullInstructions,
    },
    admin: {
      beforeRevision: 4, preApprovalRevision: 4,
      proposal: {
        proposalId: 'proposal_alpha', actorUserId: 'U_OWNER',
        approvalScopeKey: 'slack:T_QA:C_QA:1700000000.000300:agent:agent_chickpea', status: 'completed',
        operations: [{ kind: 'update_agent', agentId: 'agent_qa_alpha', expectedRevision: 4, patch: { instructions: fullInstructions } }],
        preview: { summary: 'Update Calendar qa-alpha02', changes: [], missingSetup: [] },
        result: { outcomes: [{ changed: [{ kind: 'agent', id: 'agent_qa_alpha', revision: 5 }] }] },
      },
      agent: { id: 'agent_qa_alpha', revision: 5, instructions: fullInstructions },
      presentation: { activityProjection: { surface: 'assistant_status', state: 'cleared' } },
    },
    slack: {
      messages: [{ type: 'message', ts: '1700000000.000400', thread_ts: '1700000000.000300', user: 'U_OWNER', text: 'approve' }],
      reactions: [],
    },
  };
}

function connectorFixture(ownerKind: 'member' | 'team', race = false) {
  const completedByUserId = race ? 'U_SECOND' : ownerKind === 'team' ? 'U_ADMIN' : 'U_MEMBER';
  const completedByMembershipId = race ? 'membership_second' : ownerKind === 'team' ? 'membership_admin' : 'membership_member';
  return {
    request: {
      runMarker: 'qa-sheets01', setupOperationId: 'setup_sheets_alpha', agentId: 'agent_qa_alpha',
      providerAccountId: 'ca_sheets_alpha',
      authorizedEditorIds: ['U_MEMBER', 'U_ADMIN', 'U_FIRST', 'U_SECOND'],
      authorizedMembershipIds: ['membership_member', 'membership_admin', 'membership_first', 'membership_second'],
    },
    setupForm: { ownerKind, access: 'read' },
    admin: {
      setups: [{
        setupOperationId: 'setup_sheets_alpha', status: 'completed',
        target: { kind: 'managed_connection', provider: 'googlesheets', agentId: 'agent_qa_alpha', ownerKind, accessLane: 'read' },
        completedByUserId, completedByMembershipId, connectionAccountId: 'connection_sheets_alpha',
      }],
      accounts: [{
        id: 'connection_sheets_alpha', ownerKind,
        ...(ownerKind === 'member' ? { ownerMembershipId: completedByMembershipId } : {}),
        createdByMembershipId: completedByMembershipId, lifecycle: 'active',
        policy: { kind: 'managed', adapterId: 'composio', toolkit: 'googlesheets', accountRef: 'ca_sheets_alpha', allowedCapabilities: ['sheets.values.get'] },
      }],
      bindings: [{ agentId: 'agent_qa_alpha', connectionAccountId: 'connection_sheets_alpha', providerId: 'google', enabled: true }],
      presentation: { activityProjection: { surface: 'assistant_status', state: 'cleared' } },
    },
    provider: {
      connected_accounts: [{ id: 'ca_sheets_alpha', status: 'ACTIVE' }],
      tool_result: {
        successful: true, error: null,
        data: { spreadsheet_id: 'sheet_synthetic', range: 'QA!A1:B2', values: [['case_marker', 'status'], ['qa-sheets01', 'ready']], major_dimension: 'ROWS' },
      },
      callbacks: race ? [
        { sequence: 1, completedByUserId: 'U_SECOND', result: 'completed', afterCompletion: false },
        { sequence: 2, completedByUserId: 'U_FIRST', result: 'already_completed', afterCompletion: true },
      ] : [],
    },
  };
}

function routineDueFixture() {
  return {
    request: {
      runMarker: 'qa-routine01', originChannelId: 'C_QA', originThreadTs: '1700000001.000100',
      expectedRoutineName: 'Daily qa-routine01',
      expectedAcknowledgementText: 'Scheduled Daily qa-routine01.',
      expectedResultText: 'Routine completed: Daily qa-routine01',
    },
    admin: {
      routines: [{ id: 'routine_qa_alpha', name: 'Daily qa-routine01', state: 'active', version: 1, destination: { kind: 'channel', channelId: 'C_QA' } }],
      runs: [{
        id: 'rrun_qa_alpha', routineId: 'routine_qa_alpha', routineVersion: 1, triggerSource: 'schedule',
        status: 'succeeded', deliveryStatus: 'delivered', deliveryChannelId: 'C_QA', deliveryMessageTs: '1700000002.000100',
      }],
      presentation: { activityProjection: { surface: 'assistant_status', state: 'cleared' } },
    },
    slack: { messages: [
      { type: 'message', ts: '1700000001.000200', channel: 'C_QA', thread_ts: '1700000001.000100', text: 'Scheduled Daily qa-routine01.' },
      { type: 'message', ts: '1700000002.000100', channel: 'C_QA', thread_ts: '1700000001.000100', text: 'Routine completed: Daily qa-routine01' },
    ] },
  };
}

function routinePauseFixture() {
  return {
    request: { runMarker: 'qa-routine02' },
    admin: {
      baselineVersion: 3,
      baselineScheduleJson: '{"kind":"cron","expression":"0 9 * * 1-5"}',
      routine: { id: 'routine_qa_alpha', state: 'active', version: 5, scheduleJson: '{"kind":"cron","expression":"0 9 * * 1-5"}' },
      events: [
        { eventType: 'routine.pause', subjectId: 'routine_qa_alpha', subjectVersion: 4, createdAt: 1000, metadataJson: '{"state":"paused"}' },
        { eventType: 'routine.resume', subjectId: 'routine_qa_alpha', subjectVersion: 5, createdAt: 2000, metadataJson: '{"state":"active"}' },
      ],
      runs: [
        { id: 'rrun_paused', routineId: 'routine_qa_alpha', triggerSource: 'schedule', queuedAt: 1500, status: 'cancelled', deliveryStatus: 'none' },
        { id: 'rrun_resumed', routineId: 'routine_qa_alpha', triggerSource: 'schedule', queuedAt: 2500, status: 'succeeded', deliveryStatus: 'delivered' },
      ],
      presentation: { activityProjection: { surface: 'assistant_status', state: 'cleared' } },
    },
  };
}

function routineRunNowFixture() {
  return {
    request: {
      runMarker: 'qa-routine03', originChannelId: 'C_QA', originThreadTs: '1700000003.000100',
      expectedResultText: 'Routine completed: Run now qa-routine03',
    },
    admin: {
      baselineNextRunAt: 1800000000000,
      routine: { id: 'routine_qa_alpha', nextRunAt: 1800000000000 },
      runs: [{
        id: 'rrun_now_alpha', routineId: 'routine_qa_alpha', triggerSource: 'run_now',
        status: 'succeeded', deliveryStatus: 'delivered', deliveryMessageTs: '1700000003.000200',
      }],
      presentation: { activityProjection: { surface: 'assistant_status', state: 'cleared' } },
    },
    slack: { messages: [{
      type: 'message', ts: '1700000003.000200', channel: 'C_QA', thread_ts: '1700000003.000100',
      text: 'Routine completed: Run now qa-routine03',
    }] },
  };
}
