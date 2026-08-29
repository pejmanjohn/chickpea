import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyManagementOperation } from '../src/management/policy.ts';
import { invokeSlackWorkspaceManagementTool } from '../src/management/slack-tools.ts';
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
