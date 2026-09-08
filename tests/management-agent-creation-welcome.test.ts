import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONNECTION_CATALOG_PRESETS,
  matchingConnectorCatalogPresets,
  type ConnectorCatalogPreset,
} from '../src/config/presets.ts';
import { selectAgentCreationConnectors } from '../src/management/agent-creation-welcome.ts';
import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import { managementActorOriginKey } from '../src/management/contracts.ts';
import type { ManagementActorContext } from '../src/management/types.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

test('catalog aliases resolve to one canonical connector', () => {
  assert.equal(matchingConnectorCatalogPresets('Drive')[0]?.id, 'google-drive');
  assert.equal(matchingConnectorCatalogPresets('Slides')[0]?.id, 'google-slides');
  assert.equal(matchingConnectorCatalogPresets('Google Mail')[0]?.id, 'gmail');

  const identities = CONNECTION_CATALOG_PRESETS.flatMap((preset) =>
    [preset.id, preset.name, ...(preset.aliases ?? [])].map((name) => ({
      name: name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
      id: preset.id,
    }))
  );
  for (const identity of identities) {
    assert.deepEqual(
      [...new Set(identities.filter(({ name }) => name === identity.name).map(({ id }) => id))],
      [identity.id],
      `catalog lookup ${identity.name} must identify one connector`,
    );
  }
});

test('explicit connector actions follow request order, deduplicate aliases, and cap at three', async () => {
  const plan = await selectAgentCreationConnectors({
    requestText: 'Create an Agent using Notion, Drive, Google Drive, Asana, and Linear.',
    explicitMentions: ['Linear', 'Google Drive', 'Notion', 'Asana', 'Drive'],
    agentCorpus: 'A general research assistant.',
  });
  assert.deepEqual(plan.candidates.map(({ presetId, source }) => [presetId, source]), [
    ['notion-managed', 'explicit'],
    ['google-drive', 'explicit'],
    ['asana', 'explicit'],
  ]);
  assert.deepEqual(plan.notices, [{
    kind: 'overflow',
    label: 'Linear',
    text: 'Linear can be connected later from View Agent.',
  }]);
});

test('invalid and unavailable connectors do not consume an action slot', async () => {
  const plan = await selectAgentCreationConnectors({
    requestText: 'Create an Agent for Notion, Imaginary CRM, Google Slides, and Asana.',
    explicitMentions: ['Notion', 'Imaginary CRM', 'Google Slides', 'Asana'],
    agentCorpus: 'Research only.',
    isEligible: ({ id }) => id !== 'notion-managed',
  });
  assert.deepEqual(plan.candidates.map(({ presetId }) => presetId), ['google-slides', 'asana']);
  assert.deepEqual(plan.notices.map(({ kind, label }) => [kind, label]), [
    ['unavailable', 'Notion'],
    ['unsupported', 'Imaginary CRM'],
  ]);
});

test('explicit connector aliases anchor to the canonical request text without pre-escaping labels', async () => {
  const alias = await selectAgentCreationConnectors({
    requestText: 'Create a deck Agent using Google Slides.',
    explicitMentions: ['Slides'],
    agentCorpus: '',
  });
  assert.deepEqual(alias.candidates.map(({ presetId }) => presetId), ['google-slides']);

  const unsupported = await selectAgentCreationConnectors({
    requestText: 'Create an Agent using <CRM & Ops>.',
    explicitMentions: ['<CRM & Ops>'],
    agentCorpus: '',
  });
  assert.equal(unsupported.notices[0]?.label, '<CRM & Ops>');
  assert.equal(unsupported.notices[0]?.text, '<CRM & Ops> isn’t available to connect yet.');
});

test('only request-anchored affirmative connector mentions can become explicit actions', async () => {
  const plan = await selectAgentCreationConnectors({
    requestText: 'Create a research Agent without Notion. I previously used Slack. "Google Drive" is just an example. Use Linear.',
    explicitMentions: ['Notion', 'Slack', 'Google Drive', 'Linear', 'Invented by model'],
    agentCorpus: 'Research assistant.',
  });
  assert.deepEqual(plan.candidates, [{
    presetId: 'linear',
    label: 'Linear',
    source: 'explicit',
  }]);
  assert.deepEqual(plan.notices, []);
});

test('one unique corpus match may follow explicit actions but ambiguous inference adds nothing', async () => {
  const unique = await selectAgentCreationConnectors({
    requestText: 'Create a Deck Agent with Notion.',
    explicitMentions: ['Notion'],
    agentCorpus: 'Deck creates polished presentations in Google Slides.',
  });
  assert.deepEqual(unique.candidates.map(({ presetId, source }) => [presetId, source]), [
    ['notion-managed', 'explicit'],
    ['google-slides', 'inferred'],
  ]);

  const ambiguous = await selectAgentCreationConnectors({
    requestText: 'Create a reporting Agent.',
    explicitMentions: [],
    agentCorpus: 'Build reports in Google Sheets and Google Slides.',
  });
  assert.deepEqual(ambiguous.candidates, []);

  const negated = await selectAgentCreationConnectors({
    requestText: 'Create a support Agent.',
    explicitMentions: [],
    agentCorpus: 'Answer from the FAQ. Never touch the calendar.',
  });
  assert.deepEqual(negated.candidates, []);
});

test('ambiguous aliases produce a notice and no action', async () => {
  const catalog = [
    { id: 'alpha', name: 'Alpha', aliases: ['Shared'], description: '', category: 'docs', accent: '#000', managedToolkit: 'alpha', providerId: 'alpha' },
    { id: 'beta', name: 'Beta', aliases: ['Shared'], description: '', category: 'docs', accent: '#000', managedToolkit: 'beta', providerId: 'beta' },
  ] satisfies ConnectorCatalogPreset[];
  const plan = await selectAgentCreationConnectors({
    requestText: 'Create an Agent connected to Shared.',
    explicitMentions: ['Shared'],
    agentCorpus: '',
    catalog,
  });
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.notices, [{
    kind: 'ambiguous',
    label: 'Shared',
    text: 'Shared matches more than one connector; choose it later from View Agent.',
  }]);
});

test('a Slack creation freezes one welcome with connector handoffs and its published avatar', async () => {
  const published: unknown[] = [];
  const avatarUrl =
    'https://gateway.chickpea.test/avatars/binding/agent_deck_welcome/rev_1.png';
  const f = await createManagementAdapterFixture('agent-creation-welcome-claim', {
    publishGeneratedAgentAvatar: async (input) => {
      published.push(input);
      return { url: avatarUrl, revision: 1 };
    },
  });
  try {
    const context: ManagementActorContext = {
      userId: f.admin.user.id,
      membershipId: f.admin.membership.id,
      organizationId: f.admin.membership.organizationId,
      actingAgentId: CHICKPEA_AGENT_ID,
      origin: {
        kind: 'slack',
        workspaceId: f.admin.binding.slackTeamId,
        channelId: 'D_AGENT_CREATION_WELCOME',
        threadTs: '900.1',
        messageTs: '900.1',
        requestText: 'Create a deck Agent using Google Slides, Notion, and Supabase.',
        conversationKind: 'im',
        agentId: CHICKPEA_AGENT_ID,
      },
    };
    const applied = await f.service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'create-deck-with-connectors',
      operations: [{
        itemId: 'create',
        kind: 'create_agent',
        agent: {
          id: 'agent_deck_welcome',
          name: 'Deck',
          description: 'Creates polished presentations.',
          requestedHandle: 'deck-welcome',
          editPolicy: 'creator_and_admins',
          instructions: 'Create presentations in Google Slides.',
          enabled: true,
          skills: [],
          mcpServers: [],
          apiConnections: [],
          repositories: [],
        },
      }],
    });
    if (!('operationId' in applied)) assert.fail('expected applied creation');
    const created = await f.config.getAgent('agent_deck_welcome');
    await f.config.updateAgent(created.id, {
      slackPresence: {
        ...created.slackPresence!,
        desiredState: 'active',
        health: 'healthy',
        userGroupId: 'SDECKWELCOME',
      },
    }, created.revision);

    const first = await f.service.finalizeSlackAgentCreationWelcome({
      context,
      operationId: applied.operationId,
      creationItemId: 'create',
      agentId: 'agent_deck_welcome',
      connectorMentions: ['Notion', 'Supabase', 'Google Slides'],
      followOnNotices: [],
      presentationRunId: 'run_deck_welcome',
      turnJobId: 'turn_deck_welcome',
    });
    const replay = await f.service.finalizeSlackAgentCreationWelcome({
      context,
      operationId: applied.operationId,
      creationItemId: 'create',
      agentId: 'agent_deck_welcome',
      connectorMentions: ['A different connector'],
      followOnNotices: [{ kind: 'failure', text: 'This must not replace the claim.' }],
      presentationRunId: 'run_other',
      turnJobId: 'turn_deck_welcome',
    });

    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.deepEqual(replay.outbox, first.outbox);
    await assert.rejects(
      () => f.service.finalizeSlackAgentCreationWelcome({
        context: {
          ...context,
          userId: f.owner.user.id,
          membershipId: f.owner.membership.id,
        },
        operationId: applied.operationId,
        creationItemId: 'create',
        agentId: 'agent_deck_welcome',
        connectorMentions: [],
        followOnNotices: [],
        turnJobId: 'turn_deck_welcome',
      }),
      /creation operation was not found/,
    );
    await assert.rejects(
      () => f.service.finalizeSlackAgentCreationWelcome({
        context,
        operationId: applied.operationId,
        creationItemId: 'create',
        agentId: 'agent_deck_welcome',
        connectorMentions: [],
        followOnNotices: [],
        turnJobId: 'turn_other',
      }),
      /welcome belongs to another Slack turn/,
    );
    assert.equal(first.outbox.outboxId, `agent_welcome_${applied.operationId}`);
    if (!('kind' in first.outbox.receipt) ||
        first.outbox.receipt.kind !== 'agent_created_welcome') {
      assert.fail('expected Agent welcome receipt');
    }
    const receipt = first.outbox.receipt;
    assert.equal(receipt.agentHandle, 'deck-welcome');
    assert.equal(receipt.persona.avatarUrl, avatarUrl);
    assert.deepEqual(published, [{
      workspaceId: f.admin.binding.slackTeamId,
      agentId: created.id,
      revision: created.slackPresence?.avatar.revision,
      seed: created.slackPresence?.avatar.seed,
    }]);
    assert.equal(
      (await f.config.getAgent(created.id)).slackPresence?.avatar.url,
      avatarUrl,
    );
    assert.deepEqual(receipt.publication, { status: 'complete', incomplete: [] });
    assert.deepEqual(receipt.connectorActions?.map(({ label }) => label), [
      'Google Slides',
      'Notion',
    ]);
    assert.deepEqual(receipt.connectorNotices, [{
      kind: 'unavailable',
      label: 'Supabase',
      text: 'Supabase isn’t available to connect right now.',
    }]);
    assert.match(receipt.connectorActions?.[0]?.setupUrl ?? '', /\/setup\/setup_welcome_/);
    assert.match(receipt.connectorActions?.[1]?.setupUrl ?? '', /\/setup\/setup_welcome_/);
    assert.notEqual(
      receipt.connectorActions?.[0]?.setupOperationId,
      receipt.connectorActions?.[1]?.setupOperationId,
    );
    assert.match(receipt.viewAgentUrl ?? '', /\/admin\/agents\/agent_deck_welcome$/);
    for (const action of receipt.connectorActions ?? []) {
      assert.ok(action.setupOperationId);
      const setup = await f.management.getSetup(action.setupOperationId!);
      assert.equal(setup?.action, 'managed_connection');
      assert.equal(setup?.target.agentId, 'agent_deck_welcome');
    }
    assert.deepEqual(
      await f.management.getOutboxForOperation(applied.operationId),
      first.outbox,
    );
  } finally {
    f.close();
  }
});

test('a rejecting managed-connector availability check still queues the welcome', async () => {
  const f = await createManagementAdapterFixture('welcome-availability-rejection', {
    managedConnectorAvailable: async () => {
      throw new Error('connector catalog unavailable');
    },
  });
  try {
    const context: ManagementActorContext = {
      userId: f.admin.user.id,
      membershipId: f.admin.membership.id,
      organizationId: f.admin.membership.organizationId,
      actingAgentId: CHICKPEA_AGENT_ID,
      origin: {
        kind: 'slack',
        workspaceId: f.admin.binding.slackTeamId,
        channelId: 'D_CONNECTOR_AVAILABILITY',
        threadTs: '900.2',
        messageTs: '900.2',
        requestText: 'Create a research Agent using Notion.',
        conversationKind: 'im',
        agentId: CHICKPEA_AGENT_ID,
      },
    };
    const applied = await f.service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'create-agent-with-unavailable-notion',
      operations: [{
        itemId: 'create',
        kind: 'create_agent',
        agent: {
          id: 'agent_connector_availability',
          name: 'Research',
          requestedHandle: 'research-availability',
          editPolicy: 'creator_and_admins',
          instructions: 'Research in Notion.',
          enabled: true,
          skills: [],
          mcpServers: [],
          apiConnections: [],
          repositories: [],
        },
      }],
    });
    if (!('operationId' in applied)) assert.fail('expected applied creation');

    const finalized = await f.service.finalizeSlackAgentCreationWelcome({
      context,
      operationId: applied.operationId,
      creationItemId: 'create',
      agentId: 'agent_connector_availability',
      connectorMentions: ['Notion'],
      followOnNotices: [],
      turnJobId: 'turn_connector_availability',
    });

    assert.equal(finalized.created, true);
    assert.deepEqual(await f.management.getOutboxForOperation(applied.operationId), finalized.outbox);
    if (!('kind' in finalized.outbox.receipt) ||
        finalized.outbox.receipt.kind !== 'agent_created_welcome') {
      assert.fail('expected Agent welcome receipt');
    }
    assert.deepEqual(finalized.outbox.receipt.connectorActions, []);
    assert.deepEqual(finalized.outbox.receipt.connectorNotices, [{
      kind: 'unavailable',
      label: 'Notion',
      text: 'Notion isn’t available to connect right now.',
    }]);
  } finally {
    f.close();
  }
});

test('welcome finalization truthfully reports presence and source-Channel publication failures', async () => {
  const scenarios = [
    {
      suffix: 'welcome-presence-partial',
      conversationKind: 'im' as const,
      healthyPresence: false,
      avatarFailure: false,
      incomplete: ['slack_presence'],
    },
    {
      suffix: 'welcome-source-partial',
      conversationKind: 'channel' as const,
      healthyPresence: true,
      avatarFailure: false,
      incomplete: ['source_channel'],
    },
    {
      suffix: 'welcome-avatar-publication-failure',
      conversationKind: 'im' as const,
      healthyPresence: true,
      avatarFailure: true,
      incomplete: [],
    },
  ] as const;

  for (const scenario of scenarios) {
    const f = await createManagementAdapterFixture(
      scenario.suffix,
      scenario.avatarFailure
        ? { publishGeneratedAgentAvatar: async () => { throw new Error('gateway unavailable'); } }
        : {},
    );
    try {
      const agentId = `agent_${scenario.suffix.replaceAll('-', '_')}`;
      const agent = await f.config.createAgent({
        id: agentId,
        name: 'Partial Agent',
        creatorMembershipId: f.admin.membership.id,
        editPolicy: 'all_workspace_members',
        lifecycle: 'active',
        configurationGeneration: 1,
        instructions: 'Help with partial-publication testing.',
        enabled: true,
        slackPresence: {
          requestedHandle: 'partial-agent',
          normalizedHandle: 'partial-agent',
          desiredState: 'active',
          health: scenario.healthyPresence ? 'healthy' : 'pending',
          avatar: { kind: 'generated', revision: 1, seed: agentId },
          ...(scenario.healthyPresence ? { userGroupId: 'SPARTIAL' } : {}),
        },
        skills: [],
        mcpServers: [],
        apiConnections: [],
        repositories: [],
      });
      await f.config.materializeChickpeaAgent();
      const installation = await f.config.ensureWorkspaceInstallation({
        workspaceId: f.admin.binding.slackTeamId,
        transportMode: 'direct',
        defaultAgentId: agent.id,
        teamId: f.admin.binding.slackTeamId,
        botUserId: 'U_CHICKPEA',
      });
      await f.config.updateWorkspaceInstallation(
        f.admin.binding.slackTeamId,
        { runtimeContract: 'chickpea-v1', health: 'healthy' },
        installation.revision,
      );
      const context: ManagementActorContext = {
        userId: f.admin.user.id,
        membershipId: f.admin.membership.id,
        organizationId: f.admin.membership.organizationId,
        actingAgentId: CHICKPEA_AGENT_ID,
        origin: {
          kind: 'slack',
          workspaceId: f.admin.binding.slackTeamId,
          channelId: scenario.conversationKind === 'im' ? 'D_PARTIAL' : 'C_PARTIAL',
          threadTs: '901.1',
          messageTs: '901.1',
          requestText: 'Create a partial Agent.',
          conversationKind: scenario.conversationKind,
          agentId: CHICKPEA_AGENT_ID,
        },
      };
      const operationId = `management_${scenario.suffix}`;
      const createOperation = {
        itemId: 'create',
        kind: 'create_agent' as const,
        agent: {
          id: agent.id,
          name: agent.name,
          instructions: agent.instructions,
          enabled: true,
          skills: [],
          mcpServers: [],
          apiConnections: [],
          repositories: [],
        },
      };
      await f.management.reserveRequest({
        operationId,
        organizationId: context.organizationId,
        actorUserId: context.userId,
        actorMembershipId: context.membershipId,
        originKey: managementActorOriginKey(context),
        idempotencyKey: scenario.suffix,
        digest: scenario.suffix.padEnd(64, '0'),
        operations: [createOperation],
        at: 1_800_000_000_000,
      });
      await f.management.markRequestApplying(operationId, 1_800_000_000_001);
      await f.management.completeRequest(operationId, {
        operationId,
        idempotencyKey: scenario.suffix,
        status: 'completed',
        outcomes: [{
          itemId: 'create',
          operationKind: 'create_agent',
          disposition: 'applied',
          changed: [{ kind: 'agent', id: agent.id, revision: agent.revision }],
        }],
        effectiveRevision: scenario.suffix.padEnd(32, '0'),
        activation: 'next_turn',
      }, 1_800_000_000_002);

      const finalized = await f.service.finalizeSlackAgentCreationWelcome({
        context,
        operationId,
        creationItemId: 'create',
        agentId: agent.id,
        connectorMentions: [],
        followOnNotices: [],
        turnJobId: `turn_${scenario.suffix}`,
      });
      if (!('kind' in finalized.outbox.receipt) ||
          finalized.outbox.receipt.kind !== 'agent_created_welcome') {
        assert.fail('expected Agent welcome receipt');
      }
      assert.deepEqual(finalized.outbox.receipt.publication, {
        status: scenario.incomplete.length === 0 ? 'complete' : 'partial',
        incomplete: scenario.incomplete,
      });
      if (scenario.avatarFailure) {
        assert.match(
          finalized.outbox.receipt.persona.avatarUrl ?? '',
          new RegExp(`/assets/agents/${agent.id}/avatar/1$`),
        );
      }
    } finally {
      f.close();
    }
  }
});
