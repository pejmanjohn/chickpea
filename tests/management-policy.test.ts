import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import { AGENT_AUTHORING_GUIDE_VERSION } from '../src/management/agent-authoring/index.ts';
import { classifyManagementOperation } from '../src/management/policy.ts';
import { invokeSlackWorkspaceManagementTool } from '../src/management/slack-tools.ts';
import { invokeWorkspaceManagementTool } from '../src/management/tool-adapter.ts';
import type { LiveManagementActor, ManagementOperation } from '../src/management/types.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const actor: LiveManagementActor = {
  userId: 'user_policy',
  membershipId: 'membership_policy',
  organizationId: 'org_policy',
  role: 'admin',
  origin: { kind: 'mcp', clientId: 'policy-test' },
};

const skillUpdate: ManagementOperation = {
  itemId: 'skill',
  kind: 'update_agent',
  agentId: 'agent_policy',
  expectedRevision: 1,
  patch: {
    skills: [{
      name: 'unslop',
      description: 'Rewrite plainly.',
      instructions: 'Remove AI writing tells.',
      enabled: true,
    }],
  },
};

function posture(decision: ReturnType<typeof classifyManagementOperation>) {
  assert.equal(decision.allowed, true);
  if (!decision.allowed) throw new Error('Policy denied the test operation.');
  return decision.posture;
}

test('base Agent creation and only its trusted source-Channel grant are immediate', () => {
  for (const editPolicy of [undefined, 'creator_and_admins'] as const) {
    assert.deepEqual(classifyManagementOperation({
      actor,
      operation: {
        itemId: `create-${editPolicy ?? 'default'}`,
        kind: 'create_agent',
        agent: {
          id: `agent_deck_${editPolicy ?? 'default'}`,
          name: 'Deck',
          instructions: 'Create clear presentations.',
          ...(editPolicy ? { editPolicy } : {}),
          enabled: true,
          skills: [],
          mcpServers: [],
          apiConnections: [],
          repositories: [],
        },
      },
    }), {
      allowed: true,
      posture: 'immediate',
      reason: 'base_agent_creation',
    });
  }

  assert.deepEqual(classifyManagementOperation({
    actor,
    operation: {
      itemId: 'create-workspace-editable',
      kind: 'create_agent',
      agent: {
        id: 'agent_workspace_editable',
        name: 'Workspace Editable',
        instructions: 'Accept edits from every workspace member.',
        editPolicy: 'all_workspace_members',
        enabled: true,
        skills: [],
        mcpServers: [],
        apiConnections: [],
        repositories: [],
      },
    },
  }), {
    allowed: true,
    posture: 'confirmation',
    reason: 'workspace_wide_agent_edit_authority',
  });

  const grant: ManagementOperation = {
    itemId: 'grant',
    kind: 'grant_agent_channel',
    workspaceId: 'T_POLICY',
    channelId: 'C_POLICY',
    agentId: 'agent_deck',
    expectedRevision: 0,
  };
  assert.equal(posture(classifyManagementOperation({
    actor,
    operation: grant,
    agentEditable: true,
  })), 'confirmation');
  assert.deepEqual(classifyManagementOperation({
    actor,
    operation: grant,
    agentEditable: true,
    trustedSlackOriginGrant: true,
  }), {
    allowed: true,
    posture: 'immediate',
    reason: 'source_channel_for_created_agent',
  });
});

test('direct apply keeps ordinary creation immediate but reviews workspace-wide edit authority', async () => {
  const f = await createManagementAdapterFixture('create-edit-authority-policy');
  const context = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp' as const, clientId: 'create-edit-authority-policy' },
  };
  const agent = (id: string, name: string, editPolicy?: 'creator_and_admins' | 'all_workspace_members') => ({
    id,
    name,
    instructions: `Operate as ${name}.`,
    ...(editPolicy ? { editPolicy } : {}),
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  try {
    for (const [id, name, editPolicy] of [
      ['agent_default_authority', 'Default Authority', undefined],
      ['agent_creator_authority', 'Creator Authority', 'creator_and_admins'],
    ] as const) {
      const result = await f.service.applyWorkspaceChanges({
        context,
        idempotencyKey: `create-${id}`,
        operations: [{
          itemId: `create-${id}`,
          kind: 'create_agent',
          agent: agent(id, name, editPolicy),
        }],
      });
      assert.equal(result.status, 'completed');
      assert.equal(result.outcomes[0]?.disposition, 'applied');
      assert.equal((await f.config.getAgent(id)).editPolicy, 'creator_and_admins');
    }

    const workspaceWide = await f.service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'create-workspace-wide-authority',
      operations: [{
        itemId: 'create-workspace-wide-authority',
        kind: 'create_agent',
        agent: agent(
          'agent_workspace_wide_authority',
          'Workspace Wide Authority',
          'all_workspace_members',
        ),
      }],
    });
    assert.equal(workspaceWide.status, 'confirmation_required');
    assert.equal(workspaceWide.outcomes[0]?.disposition, 'confirmation_required');
    assert.match(workspaceWide.outcomes[0]?.proposalId ?? '', /^proposal_/);
    assert.equal(
      (await f.config.listUserAgents()).some(({ id }) => id === 'agent_workspace_wide_authority'),
      false,
    );
  } finally {
    f.close();
  }
});

test('explicit exact reversible skill changes apply immediately', () => {
  assert.deepEqual(classifyManagementOperation({
    actor,
    operation: skillUpdate,
    agentEditable: true,
    approvalBasis: 'explicit_requester_command',
    reversibleLocalChange: true,
  }), {
    allowed: true,
    posture: 'immediate',
    reason: 'explicit_reversible_change',
  });
});

test('inferred skill changes and consequential changes still require confirmation', () => {
  assert.deepEqual(classifyManagementOperation({
    actor,
    operation: skillUpdate,
    agentEditable: true,
    reversibleLocalChange: true,
  }), {
    allowed: true,
    posture: 'confirmation',
    reason: 'skill_change',
  });

  assert.equal(posture(classifyManagementOperation({
    actor,
    operation: skillUpdate,
    agentEditable: true,
    approvalBasis: 'explicit_requester_command',
    reversibleLocalChange: true,
    capabilityScopeExpanded: true,
  })), 'confirmation');

  assert.equal(posture(classifyManagementOperation({
    actor,
    operation: {
      ...skillUpdate,
      patch: { ...skillUpdate.patch, description: 'Also change the Agent.' },
    },
    agentEditable: true,
    approvalBasis: 'explicit_requester_command',
    reversibleLocalChange: true,
  })), 'confirmation');

  assert.equal(posture(classifyManagementOperation({
    actor,
    operation: {
      itemId: 'delete',
      kind: 'delete_agent',
      agentId: 'agent_policy',
      expectedRevision: 1,
    },
    agentEditable: true,
    approvalBasis: 'explicit_requester_command',
    reversibleLocalChange: true,
  })), 'confirmation');
});

test('the direct apply tool admits one exact skill toggle but proposes a content rewrite', async () => {
  const f = await createManagementAdapterFixture('explicit-skill-policy');
  const agent = await f.config.createAgent({
    id: 'agent_explicit_skill',
    name: 'Explicit Skill Agent',
    creatorMembershipId: f.admin.membership.id,
    editPolicy: 'creator_and_admins',
    lifecycle: 'active',
    configurationGeneration: 1,
    instructions: 'Test proportional approval.',
    enabled: true,
    skills: [{
      name: 'unslop',
      description: 'Rewrite plainly.',
      instructions: 'Remove AI writing tells.',
      enabled: true,
    }],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  const signal = {
    agentId: agent.id,
    workspaceId: f.admin.user.slackTeamId,
    channelId: 'D_EXPLICIT_SKILL',
    threadTs: '400.1',
    conversationKind: 'im' as const,
    slackUserId: f.admin.binding.slackUserId,
    eventId: 'Ev_EXPLICIT_SKILL',
    messageTs: '400.2',
    turnJobId: 'turn_EXPLICIT_SKILL',
    requesterText: 'Disable the unslop skill.',
  };
  try {
    const disabled = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'disable-unslop',
        operations: [{
          itemId: 'disable-skill',
          kind: 'update_agent',
          agentId: agent.id,
          expectedRevision: agent.revision,
          patch: { skills: [{ ...agent.skills[0]!, enabled: false }] },
        }],
      },
    });
    assert.equal(disabled.ok, true);
    assert.equal((disabled as { ok: true; result: { status: string } }).result.status, 'completed');
    const afterDisable = await f.config.getAgent(agent.id);
    assert.equal(afterDisable.skills[0]?.enabled, false);

    const rewritten = await invokeSlackWorkspaceManagementTool({
      signal: {
        ...signal,
        eventId: 'Ev_REWRITE_SKILL',
        turnJobId: 'turn_REWRITE_SKILL',
        requesterText: 'Rewrite the unslop skill with better instructions.',
      },
      identity: f.identity,
      service: f.service,
      name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'rewrite-unslop',
        operations: [{
          itemId: 'rewrite-skill',
          kind: 'update_agent',
          agentId: agent.id,
          expectedRevision: afterDisable.revision,
          patch: { skills: [{
            ...afterDisable.skills[0]!,
            instructions: 'Use generated replacement instructions.',
          }] },
        }],
      },
    });
    assert.equal(rewritten.ok, true);
    assert.equal((rewritten as { ok: true; result: { status: string } }).result.status,
      'confirmation_required');
    assert.equal((await f.config.getAgent(agent.id)).skills[0]?.instructions,
      'Remove AI writing tells.');

    const generatedAddition = await invokeSlackWorkspaceManagementTool({
      signal: {
        ...signal,
        eventId: 'Ev_ADD_GENERATED_SKILL',
        turnJobId: 'turn_ADD_GENERATED_SKILL',
        requesterText: 'Add a new helper skill.',
      },
      identity: f.identity,
      service: f.service,
      name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'add-generated-skill',
        operations: [{
          itemId: 'add-generated-skill',
          kind: 'update_agent',
          agentId: agent.id,
          expectedRevision: afterDisable.revision,
          patch: { skills: [
            ...afterDisable.skills,
            {
              name: 'helper',
              description: 'Generated helper.',
              instructions: 'Follow generated instructions.',
              enabled: true,
            },
          ] },
        }],
      },
    });
    assert.equal(generatedAddition.ok, true);
    assert.equal((generatedAddition as { ok: true; result: { status: string } }).result.status,
      'confirmation_required');

    const compound = await invokeSlackWorkspaceManagementTool({
      signal: {
        ...signal,
        eventId: 'Ev_COMPOUND_SKILL',
        turnJobId: 'turn_COMPOUND_SKILL',
        requesterText: 'Enable the unslop skill, then disable it.',
      },
      identity: f.identity,
      service: f.service,
      name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'compound-skill-toggle',
        operations: [{
          itemId: 'enable-skill',
          kind: 'update_agent',
          agentId: agent.id,
          expectedRevision: afterDisable.revision,
          patch: { skills: [{ ...afterDisable.skills[0]!, enabled: true }] },
        }, {
          itemId: 'disable-again',
          dependsOn: ['enable-skill'],
          kind: 'update_agent',
          agentId: agent.id,
          expectedRevision: afterDisable.revision + 1,
          patch: { skills: [{ ...afterDisable.skills[0]!, enabled: false }] },
        }],
      },
    });
    assert.equal(compound.ok, true);
    assert.equal((compound as { ok: true; result: { status: string } }).result.status,
      'confirmation_required');

    for (const [id, requesterText] of [
      ['negated', "Don't enable the unslop skill."],
      ['mixed-target', 'Disable the unslop skill and enable the helper skill.'],
    ] as const) {
      const ambiguousResult: {
        ok: true;
        result: unknown;
      } | {
        ok: false;
        error: { code: string; message: string };
      } = await invokeSlackWorkspaceManagementTool({
        signal: {
          ...signal,
          eventId: `Ev_${id}`,
          turnJobId: `turn_${id}`,
          requesterText,
        },
        identity: f.identity,
        service: f.service,
        name: 'apply_workspace_changes',
        args: {
          idempotencyKey: `${id}-enable-unslop`,
          operations: [{
            itemId: `${id}-enable-skill`,
            kind: 'update_agent',
            agentId: agent.id,
            expectedRevision: afterDisable.revision,
            patch: { skills: [{ ...afterDisable.skills[0]!, enabled: true }] },
          }],
        },
      });
      assert.equal(ambiguousResult.ok, true);
      assert.equal((ambiguousResult as { ok: true; result: { status: string } }).result.status,
        'confirmation_required');
    }

    const provenanceDrift = await invokeSlackWorkspaceManagementTool({
      signal: {
        ...signal,
        eventId: 'Ev_PROVENANCE_DRIFT',
        turnJobId: 'turn_PROVENANCE_DRIFT',
        requesterText: 'Enable the unslop skill.',
      },
      identity: f.identity,
      service: f.service,
      name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'enable-unslop-with-provenance-drift',
        operations: [{
          itemId: 'enable-skill-with-provenance-drift',
          kind: 'update_agent',
          agentId: agent.id,
          expectedRevision: afterDisable.revision,
          patch: { skills: [{
            ...afterDisable.skills[0]!,
            enabled: true,
            suggestedSkillId: 'suggested_unslop',
          }] },
        }],
      },
    });
    assert.equal(provenanceDrift.ok, true);
    assert.equal((provenanceDrift as { ok: true; result: { status: string } }).result.status,
      'confirmation_required');
  } finally {
    f.close();
  }
});

test('Slack removes one named existing skill immediately and refuses a proposal detour', async () => {
  const f = await createManagementAdapterFixture('explicit-skill-removal');
  const agent = await f.config.createAgent({
    id: 'agent_explicit_skill_removal',
    name: 'Sprout',
    creatorMembershipId: f.admin.membership.id,
    editPolicy: 'creator_and_admins',
    lifecycle: 'active',
    configurationGeneration: 1,
    instructions: 'Test immediate skill removal.',
    enabled: true,
    skills: [{
      name: 'unslop',
      description: 'Rewrite plainly.',
      instructions: 'Remove AI writing tells.',
      enabled: true,
    }, {
      name: 'keep-me',
      description: 'Keep this skill.',
      instructions: 'Remain installed.',
      enabled: true,
    }],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  const signal = {
    agentId: agent.id,
    workspaceId: f.admin.user.slackTeamId,
    channelId: 'D_EXPLICIT_SKILL_REMOVAL',
    threadTs: '500.1',
    conversationKind: 'im' as const,
    slackUserId: f.admin.binding.slackUserId,
    eventId: 'Ev_EXPLICIT_SKILL_REMOVAL',
    messageTs: '500.2',
    turnJobId: 'turn_EXPLICIT_SKILL_REMOVAL',
    requesterText: 'Remove the unslop skill',
  };
  try {
    const proposed = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'propose_workspace_changes',
      args: {
        idempotencyKey: 'do-not-propose-unslop-removal',
        guideVersion: AGENT_AUTHORING_GUIDE_VERSION,
        authoringReason: 'skill_edit',
        operations: [{
          itemId: 'remove-unslop',
          kind: 'update_agent',
          agentId: agent.id,
          expectedRevision: agent.revision,
          patch: { skills: [agent.skills[1]!] },
        }],
      },
    });
    assert.deepEqual(proposed, {
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'Use manage_agent_skill for this explicit reversible skill removal. No proposal was created.',
      },
    });

    for (const [requesterText, idempotencyKey] of [
      ['What happens if I remove unslop?', 'question-is-not-a-command'],
      ['Should I remove unslop?', 'should-i-is-not-a-command'],
      ['Should we remove the unslop skill?', 'should-we-is-not-a-command'],
      ['Can I remove unslop?', 'can-i-is-not-a-command'],
      ['Do you think I should remove unslop?', 'opinion-question-is-not-a-command'],
      ['Did you remove unslop?', 'past-tense-question-is-not-a-command'],
      ['When will you remove unslop?', 'timing-question-is-not-a-command'],
      ['Remove unslop?', 'imperative-question-is-not-a-command'],
      ['Someone said to remove unslop but I disagree', 'reported-command-is-not-a-command'],
      ['Remove unslop? Actually no', 'retracted-command-is-not-a-command'],
      ['Remove everything except unslop', 'exception-is-not-the-target'],
      ['Remove keep-me instead of unslop', 'alternative-is-not-the-target'],
      ['Remove unslop and then give it access to #general', 'compound-access-is-not-partial'],
      ['Remove unslop and also change its instructions to reply in French', 'compound-instructions-is-not-partial'],
      ['Remove unslop and add a summarizer skill', 'compound-skill-add-is-not-partial'],
      ['Add a summarizer skill. Remove unslop.', 'preceding-skill-add-is-not-partial'],
      ['Give it access to #general. Remove unslop.', 'preceding-access-is-not-partial'],
      ['Change its instructions to reply in French; remove unslop', 'preceding-instructions-is-not-partial'],
      ['Remove unslop, give it access to #general', 'comma-access-is-not-partial'],
      ['Remove unslop. Give it access to #general.', 'following-access-is-not-partial'],
      ['Remove unslop & add a summarizer skill', 'ampersand-skill-add-is-not-partial'],
      ['Remove unslop &amp; give it access to #general', 'slack-ampersand-access-is-not-partial'],
      ['Remove unslop + add a summarizer skill', 'plus-skill-add-is-not-partial'],
      ['Remove unslop — give it access to #general', 'dash-access-is-not-partial'],
      ['Remove unslop / give it access to #general', 'slash-access-is-not-partial'],
      ['Remove unslop give it access to #general', 'run-on-access-is-not-partial'],
    ] as const) {
      const refused = await invokeSlackWorkspaceManagementTool({
        signal: { ...signal, requesterText },
        identity: f.identity,
        service: f.service,
        name: 'manage_agent_skill',
        args: {
          action: 'remove',
          skillName: 'unslop',
          idempotencyKey,
        },
      });
      assert.equal(refused.ok, false, requesterText);
      assert.match(
        (refused as { ok: false; error: { message: string } }).error.message,
        /current requester message must explicitly remove the unslop skill/i,
      );
      assert.deepEqual(
        (await f.config.getAgent(agent.id)).skills.map(({ name }) => name),
        ['unslop', 'keep-me'],
      );
    }

    for (const skillName of ['unslop', 'keep-me'] as const) {
      const refusedCompound = await invokeSlackWorkspaceManagementTool({
        signal: { ...signal, requesterText: 'Remove unslop and keep-me' },
        identity: f.identity,
        service: f.service,
        name: 'manage_agent_skill',
        args: {
          action: 'remove',
          skillName,
          idempotencyKey: `shared-verb-compound-${skillName}`,
        },
      });
      assert.equal(refusedCompound.ok, false, skillName);
    }
    assert.deepEqual(
      (await f.config.getAgent(agent.id)).skills.map(({ name }) => name),
      ['unslop', 'keep-me'],
    );

    for (const [requesterText, idempotencyKey] of [
      ['Please remove the unslop skill', 'polite-please-removal'],
      ['Kindly remove the unslop skill.', 'polite-kindly-removal'],
      ['Just remove unslop', 'polite-just-removal'],
      ['Hi, please remove the unslop skill. Thanks!', 'greeting-and-thanks-removal'],
      ['Remove unslop please', 'bare-skill-please-removal'],
      ['Please remove unslop now', 'bare-skill-now-removal'],
      ['Remove unslop for me', 'bare-skill-for-me-removal'],
      ['Remove unslop from Sprout', 'bare-skill-target-removal'],
      ['Remove unslop\nThanks', 'newline-thanks-removal'],
    ] as const) {
      const accepted = await invokeSlackWorkspaceManagementTool({
        signal: { ...signal, requesterText },
        identity: f.identity,
        service: f.service,
        name: 'manage_agent_skill',
        args: {
          action: 'remove',
          skillName: 'unslop',
          idempotencyKey,
        },
      });
      assert.equal(accepted.ok, true, requesterText);
      assert.equal(
        (accepted as { ok: true; result: { status: string } }).result.status,
        'updated',
      );
      const withoutUnslop = await f.config.getAgent(agent.id);
      await f.config.updateAgent(agent.id, {
        skills: [agent.skills[0]!, ...withoutUnslop.skills],
      }, withoutUnslop.revision);
    }

    const removed = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'manage_agent_skill',
      args: {
        action: 'remove',
        skillName: 'unslop',
        idempotencyKey: 'remove-unslop-immediately',
      },
    });
    assert.equal(removed.ok, true);
    const result = (removed as {
      ok: true;
      result: {
        status: string;
        operationId: string;
        undoAvailable: boolean;
        presentation: { slack: string };
      };
    }).result;
    assert.equal(result.status, 'updated');
    assert.equal(result.undoAvailable, true);
    assert.match(result.presentation.slack, /Removed skill `unslop` from Sprout/i);
    assert.match(result.presentation.slack, /undo this change/i);
    assert.deepEqual((await f.config.getAgent(agent.id)).skills.map(({ name }) => name), ['keep-me']);

    const replayed = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'manage_agent_skill',
      args: {
        action: 'remove',
        skillName: 'unslop',
        idempotencyKey: 'remove-unslop-immediately',
      },
    });
    assert.deepEqual(replayed, removed);

    const undone = await f.service.undoWorkspaceChange({
      context: {
        userId: f.admin.user.id,
        membershipId: f.admin.membership.id,
        organizationId: f.admin.membership.organizationId,
        origin: { kind: 'mcp', clientId: 'trusted-skill-manager' },
      },
      operationId: result.operationId,
      idempotencyKey: 'trusted-connector-undoes-unslop-removal',
    });
    assert.equal(undone.status, 'completed');
    assert.deepEqual(
      (await f.config.getAgent(agent.id)).skills.map(({ name }) => name),
      ['unslop', 'keep-me'],
    );
    const replayedAfterUndo = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'manage_agent_skill',
      args: {
        action: 'remove',
        skillName: 'unslop',
        idempotencyKey: 'remove-unslop-immediately',
      },
    });
    assert.equal(replayedAfterUndo.ok, true);
    assert.equal(
      (replayedAfterUndo as { ok: true; result: { undoAvailable: boolean } })
        .result.undoAvailable,
      false,
    );
    assert.doesNotMatch(
      (replayedAfterUndo as { ok: true; result: { presentation: { slack: string } } })
        .result.presentation.slack,
      /undo this change/i,
    );

    const removedAgain = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'manage_agent_skill',
      args: {
        action: 'remove',
        skillName: 'unslop',
        idempotencyKey: 'remove-unslop-before-missing-check',
      },
    });
    assert.equal(removedAgain.ok, true);
    assert.equal(
      (removedAgain as { ok: true; result: { status: string } }).result.status,
      'updated',
    );

    const missing = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'manage_agent_skill',
      args: {
        action: 'remove',
        skillName: 'unslop',
        idempotencyKey: 'missing-unslop-is-durable',
      },
    });
    assert.equal(missing.ok, true);
    assert.equal((missing as { ok: true; result: { status: string } }).result.status, 'unchanged');

    const current = await f.config.getAgent(agent.id);
    await f.config.updateAgent(agent.id, {
      skills: [agent.skills[0]!, ...current.skills],
    }, current.revision);
    const missingReplay = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'manage_agent_skill',
      args: {
        action: 'remove',
        skillName: 'unslop',
        idempotencyKey: 'missing-unslop-is-durable',
      },
    });
    assert.deepEqual(missingReplay, missing);
    assert.deepEqual(
      (await f.config.getAgent(agent.id)).skills.map(({ name }) => name),
      ['unslop', 'keep-me'],
    );

    const trustedConnectorRemoval = await invokeWorkspaceManagementTool({
      service: f.service,
      resolveContext: async () => ({
        userId: f.admin.user.id,
        membershipId: f.admin.membership.id,
        organizationId: f.admin.membership.organizationId,
        origin: { kind: 'mcp', clientId: 'trusted-skill-manager' },
      }),
    }, 'manage_agent_skill', {
      agentId: agent.id,
      action: 'remove',
      skillName: 'unslop',
      idempotencyKey: 'trusted-connector-removes-unslop',
    });
    assert.equal(trustedConnectorRemoval.ok, true);
    assert.equal(
      (trustedConnectorRemoval as { ok: true; result: { status: string } }).result.status,
      'updated',
    );
    assert.deepEqual(
      (await f.config.getAgent(agent.id)).skills.map(({ name }) => name),
      ['keep-me'],
    );
  } finally {
    f.close();
  }
});

test('the narrow Slack tool enables, disables, and durably replays an unchanged skill', async () => {
  const f = await createManagementAdapterFixture('explicit-skill-toggle');
  const agent = await f.config.createAgent({
    id: 'agent_explicit_skill_toggle',
    name: 'Sprout',
    creatorMembershipId: f.admin.membership.id,
    editPolicy: 'creator_and_admins',
    lifecycle: 'active',
    configurationGeneration: 1,
    instructions: 'Test immediate skill toggles.',
    enabled: true,
    skills: [{
      name: 'unslop',
      description: 'Rewrite plainly.',
      instructions: 'Remove AI writing tells.',
      enabled: true,
    }, {
      name: 'remove-ai-tells',
      description: 'Test an action-like skill name.',
      instructions: 'Keep the action word inside the exact skill name.',
      enabled: true,
    }],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  const signal = {
    agentId: agent.id,
    workspaceId: f.admin.user.slackTeamId,
    channelId: 'D_EXPLICIT_SKILL_TOGGLE',
    threadTs: '510.1',
    conversationKind: 'im' as const,
    slackUserId: f.admin.binding.slackUserId,
    eventId: 'Ev_EXPLICIT_SKILL_TOGGLE',
    messageTs: '510.2',
    turnJobId: 'turn_EXPLICIT_SKILL_TOGGLE',
    requesterText: 'Disable the unslop skill',
  };
  try {
    const disabled = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'manage_agent_skill',
      args: {
        action: 'disable',
        skillName: 'unslop',
        idempotencyKey: 'disable-unslop-immediately',
      },
    });
    assert.equal(disabled.ok, true);
    assert.equal((disabled as { ok: true; result: { status: string } }).result.status, 'updated');
    assert.equal((await f.config.getAgent(agent.id)).skills[0]?.enabled, false);

    const alreadyDisabled = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'manage_agent_skill',
      args: {
        action: 'disable',
        skillName: 'unslop',
        idempotencyKey: 'disabled-unslop-is-durable',
      },
    });
    assert.equal(alreadyDisabled.ok, true);
    assert.equal(
      (alreadyDisabled as { ok: true; result: { status: string } }).result.status,
      'unchanged',
    );
    assert.deepEqual(await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'manage_agent_skill',
      args: {
        action: 'disable',
        skillName: 'unslop',
        idempotencyKey: 'disabled-unslop-is-durable',
      },
    }), alreadyDisabled);

    const enabled = await invokeSlackWorkspaceManagementTool({
      signal: {
        ...signal,
        eventId: 'Ev_ENABLE_UNSLOP',
        turnJobId: 'turn_ENABLE_UNSLOP',
        requesterText: 'Hello. Could you please enable the unslop skill? Thanks!',
      },
      identity: f.identity,
      service: f.service,
      name: 'manage_agent_skill',
      args: {
        action: 'enable',
        skillName: 'unslop',
        idempotencyKey: 'enable-unslop-immediately',
      },
    });
    assert.equal(enabled.ok, true);
    assert.equal((enabled as { ok: true; result: { status: string } }).result.status, 'updated');
    assert.equal((await f.config.getAgent(agent.id)).skills[0]?.enabled, true);

    const removedActionNamedSkill = await invokeSlackWorkspaceManagementTool({
      signal: {
        ...signal,
        eventId: 'Ev_REMOVE_ACTION_NAMED_SKILL',
        turnJobId: 'turn_REMOVE_ACTION_NAMED_SKILL',
        requesterText: 'Remove the remove-ai-tells skill',
      },
      identity: f.identity,
      service: f.service,
      name: 'manage_agent_skill',
      args: {
        action: 'remove',
        skillName: 'remove-ai-tells',
        idempotencyKey: 'remove-action-named-skill',
      },
    });
    assert.equal(removedActionNamedSkill.ok, true);
    assert.deepEqual(
      (await f.config.getAgent(agent.id)).skills.map(({ name }) => name),
      ['unslop'],
    );
  } finally {
    f.close();
  }
});

test('system Chickpea binds an immediate skill change to the named target Agent', async () => {
  const f = await createManagementAdapterFixture('explicit-skill-target');
  const createAgent = (id: string, name: string) => f.config.createAgent({
    id,
    name,
    creatorMembershipId: f.admin.membership.id,
    editPolicy: 'creator_and_admins' as const,
    lifecycle: 'active' as const,
    configurationGeneration: 1,
    instructions: `Test ${name} target binding.`,
    enabled: true,
    skills: [{
      name: 'unslop',
      description: 'Rewrite plainly.',
      instructions: 'Remove AI writing tells.',
      enabled: true,
    }],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  const [sprout, sproutTwo, basil] = await Promise.all([
    createAgent('agent_explicit_target_sprout', 'Sprout'),
    createAgent('agent_explicit_target_sprout_two', 'Sprout 2'),
    createAgent('agent_explicit_target_basil', 'Delete-bot'),
  ]);
  const signal = {
    agentId: CHICKPEA_AGENT_ID,
    workspaceId: f.admin.user.slackTeamId,
    channelId: 'D_EXPLICIT_SKILL_TARGET',
    threadTs: '520.1',
    conversationKind: 'im' as const,
    slackUserId: f.admin.binding.slackUserId,
    eventId: 'Ev_EXPLICIT_SKILL_TARGET',
    messageTs: '520.2',
    turnJobId: 'turn_EXPLICIT_SKILL_TARGET',
    requesterText: 'Remove the unslop skill from Sprout',
  };
  try {
    const overlappingWrongTarget = await invokeSlackWorkspaceManagementTool({
      signal: {
        ...signal,
        eventId: 'Ev_OVERLAPPING_TARGET',
        turnJobId: 'turn_OVERLAPPING_TARGET',
        requesterText: 'Remove the unslop skill from Sprout 2',
      },
      identity: f.identity,
      service: f.service,
      name: 'manage_agent_skill',
      args: {
        agentId: sprout.id,
        action: 'remove',
        skillName: 'unslop',
        idempotencyKey: 'do-not-prefix-match-sprout-two',
      },
    });
    assert.equal(overlappingWrongTarget.ok, false);
    assert.equal((await f.config.getAgent(sprout.id)).skills.length, 1);

    const overlappingNamedTarget = await invokeSlackWorkspaceManagementTool({
      signal: {
        ...signal,
        eventId: 'Ev_OVERLAPPING_TARGET',
        turnJobId: 'turn_OVERLAPPING_TARGET',
        requesterText: 'Remove the unslop skill from Sprout 2',
      },
      identity: f.identity,
      service: f.service,
      name: 'manage_agent_skill',
      args: {
        agentId: sproutTwo.id,
        action: 'remove',
        skillName: 'unslop',
        idempotencyKey: 'remove-from-exact-sprout-two',
      },
    });
    assert.equal(overlappingNamedTarget.ok, true);
    assert.deepEqual((await f.config.getAgent(sproutTwo.id)).skills, []);

    const wrongTarget = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'manage_agent_skill',
      args: {
        agentId: basil.id,
        action: 'remove',
        skillName: 'unslop',
        idempotencyKey: 'do-not-remove-from-basil',
      },
    });
    assert.equal(wrongTarget.ok, false);
    assert.equal((await f.config.getAgent(basil.id)).skills.length, 1);

    const namedTarget = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'manage_agent_skill',
      args: {
        agentId: sprout.id,
        action: 'remove',
        skillName: 'unslop',
        idempotencyKey: 'remove-from-named-sprout',
      },
    });
    assert.equal(namedTarget.ok, true);
    assert.deepEqual((await f.config.getAgent(sprout.id)).skills, []);
    assert.equal((await f.config.getAgent(basil.id)).skills.length, 1);

    const actionNamedTarget = await invokeSlackWorkspaceManagementTool({
      signal: {
        ...signal,
        eventId: 'Ev_ACTION_NAMED_TARGET',
        turnJobId: 'turn_ACTION_NAMED_TARGET',
        requesterText: 'Remove the unslop skill from Delete-bot',
      },
      identity: f.identity,
      service: f.service,
      name: 'manage_agent_skill',
      args: {
        agentId: basil.id,
        action: 'remove',
        skillName: 'unslop',
        idempotencyKey: 'remove-from-action-named-target',
      },
    });
    assert.equal(actionNamedTarget.ok, true);
    assert.deepEqual((await f.config.getAgent(basil.id)).skills, []);

    const [twinOne, twinTwo] = await Promise.all([
      createAgent('agent_explicit_target_twin_one', 'Twin'),
      createAgent('agent_explicit_target_twin_two', 'Twin'),
    ]);
    const duplicateNameTarget = await invokeSlackWorkspaceManagementTool({
      signal: {
        ...signal,
        eventId: 'Ev_DUPLICATE_NAMED_TARGET',
        turnJobId: 'turn_DUPLICATE_NAMED_TARGET',
        requesterText: 'Remove the unslop skill from Twin',
      },
      identity: f.identity,
      service: f.service,
      name: 'manage_agent_skill',
      args: {
        agentId: twinOne.id,
        action: 'remove',
        skillName: 'unslop',
        idempotencyKey: 'do-not-resolve-duplicate-agent-name',
      },
    });
    assert.equal(duplicateNameTarget.ok, false);
    assert.equal((await f.config.getAgent(twinOne.id)).skills.length, 1);
    assert.equal((await f.config.getAgent(twinTwo.id)).skills.length, 1);
  } finally {
    f.close();
  }
});

test('a failed named skill change replays the same actionable retry guidance', async () => {
  const f = await createManagementAdapterFixture('failed-skill-replay');
  const agent = await f.config.createAgent({
    id: 'agent_failed_skill_replay',
    name: 'Sprout',
    creatorMembershipId: f.admin.membership.id,
    editPolicy: 'creator_and_admins',
    lifecycle: 'active',
    configurationGeneration: 1,
    instructions: 'Test failed receipt replay.',
    enabled: true,
    skills: [{
      name: 'unslop',
      description: 'Rewrite plainly.',
      instructions: 'Remove AI writing tells.',
      enabled: true,
    }],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  const originalUpdateAgent = f.config.updateAgent.bind(f.config);
  let interleave = true;
  f.config.updateAgent = async (...args) => {
    if (interleave) {
      interleave = false;
      await originalUpdateAgent(agent.id, { description: 'Concurrent edit.' }, agent.revision);
    }
    return originalUpdateAgent(...args);
  };
  const signal = {
    agentId: agent.id,
    workspaceId: f.admin.user.slackTeamId,
    channelId: 'D_FAILED_SKILL_REPLAY',
    threadTs: '525.1',
    conversationKind: 'im' as const,
    slackUserId: f.admin.binding.slackUserId,
    eventId: 'Ev_FAILED_SKILL_REPLAY',
    messageTs: '525.2',
    turnJobId: 'turn_FAILED_SKILL_REPLAY',
    requesterText: 'Remove the unslop skill',
  };
  const args = {
    action: 'remove' as const,
    skillName: 'unslop',
    idempotencyKey: 'failed-skill-replay',
  };
  try {
    const first = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'manage_agent_skill',
      args,
    });
    const replay = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'manage_agent_skill',
      args,
    });
    for (const response of [first, replay]) {
      assert.equal(response.ok, false);
      assert.match(
        (response as { ok: false; error: { message: string } }).error.message,
        /did not complete.*retry with a new idempotency key/i,
      );
      assert.doesNotMatch(
        (response as { ok: false; error: { message: string } }).error.message,
        /receipt is invalid/i,
      );
    }
    assert.equal((await f.config.getAgent(agent.id)).skills.length, 1);
  } finally {
    f.close();
  }
});

test('a reserved unchanged skill request resumes without a write or fabricated undo', async () => {
  const f = await createManagementAdapterFixture('unchanged-skill-resume');
  const agent = await f.config.createAgent({
    id: 'agent_unchanged_skill_resume',
    name: 'Sprout',
    creatorMembershipId: f.admin.membership.id,
    editPolicy: 'creator_and_admins',
    lifecycle: 'active',
    configurationGeneration: 1,
    instructions: 'Test unchanged receipt recovery.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  const signal = {
    agentId: agent.id,
    workspaceId: f.admin.user.slackTeamId,
    channelId: 'D_UNCHANGED_SKILL_RESUME',
    threadTs: '530.1',
    conversationKind: 'im' as const,
    slackUserId: f.admin.binding.slackUserId,
    eventId: 'Ev_UNCHANGED_SKILL_RESUME',
    messageTs: '530.2',
    turnJobId: 'turn_UNCHANGED_SKILL_RESUME',
    requesterText: 'Remove the unslop skill',
  };
  const reserveRequest = f.management.reserveRequest.bind(f.management);
  const completeRequest = f.management.completeRequest.bind(f.management);
  let operationId: string | undefined;
  let failCompletion = true;
  f.management.reserveRequest = async (input) => {
    operationId = input.operationId;
    return reserveRequest(input);
  };
  f.management.completeRequest = async (...args) => {
    if (failCompletion) {
      failCompletion = false;
      throw new Error('synthetic crash before unchanged completion');
    }
    return completeRequest(...args);
  };
  try {
    const firstAttempt = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'manage_agent_skill',
      args: {
        action: 'remove',
        skillName: 'unslop',
        idempotencyKey: 'resume-missing-unslop',
      },
    });
    assert.equal(firstAttempt.ok, false);
    assert.equal((await f.config.getAgent(agent.id)).revision, agent.revision);

    const resumed = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'manage_agent_skill',
      args: {
        action: 'remove',
        skillName: 'unslop',
        idempotencyKey: 'resume-missing-unslop',
      },
    });
    assert.equal(resumed.ok, true);
    const result = (resumed as {
      ok: true;
      result: { status: string; undoAvailable: boolean; presentation: { slack: string } };
    }).result;
    assert.equal(result.status, 'unchanged');
    assert.equal(result.undoAvailable, false);
    assert.match(result.presentation.slack, /not installed/i);
    assert.equal((await f.config.getAgent(agent.id)).revision, agent.revision);
    assert.ok(operationId);
    assert.equal(await f.management.getUndo(operationId), undefined);
  } finally {
    f.close();
  }
});
