import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateManagementOperations } from '../src/management/contracts.ts';
import { classifyManagementOperation } from '../src/management/policy.ts';
import type { LiveManagementActor, ManagementOperation } from '../src/management/types.ts';

const owner: LiveManagementActor = {
  userId: 'user_owner',
  membershipId: 'member_owner',
  organizationId: 'org_test',
  role: 'owner',
  origin: { kind: 'mcp', clientId: 'client_test' },
};
const admin: LiveManagementActor = { ...owner, role: 'admin' };

test('management policy keeps creation clean and confirms risky changes', () => {
  const create: ManagementOperation = {
    itemId: 'create',
    kind: 'create_agent',
    agent: {
      id: 'agent_research',
      name: 'Research',
      instructions: 'Research the requested topic.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    },
  };
  const removePlacement: ManagementOperation = {
    itemId: 'remove',
    kind: 'place_agent',
    workspaceId: 'T1',
    channelId: 'C1',
    expectedRevision: 2,
    expectedAgentId: 'agent_research',
    agentId: null,
  };
  assert.deepEqual(classifyManagementOperation({ actor: admin, operation: create }), {
    allowed: true,
    posture: 'immediate',
    reason: 'safe_reversible_change',
  });
  assert.deepEqual(classifyManagementOperation({ actor: admin, operation: removePlacement }), {
    allowed: true,
    posture: 'confirmation',
    reason: 'remove_channel_placement',
  });
});

test('only an Owner may propose member authority changes', () => {
  const operation: ManagementOperation = {
    itemId: 'suspend',
    kind: 'update_member',
    membershipId: 'member_admin',
    status: 'suspended',
  };
  assert.deepEqual(classifyManagementOperation({ actor: admin, operation }), {
    allowed: false,
    reason: 'owner_required',
  });
  assert.deepEqual(classifyManagementOperation({ actor: owner, operation }), {
    allowed: true,
    posture: 'confirmation',
    reason: 'membership_authority_change',
  });
});

test('management contracts reject secrets, forward dependencies, and ambiguous placements', () => {
  assert.throws(() => validateManagementOperations([{
    itemId: 'secret',
    kind: 'create_agent',
    agent: {
      id: 'agent_bad',
      name: 'Bad',
      instructions: 'Use sk-proj-abcdefghijklmnopqrstuvwxyz123456.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    },
  }]), /credentials/i);
  assert.throws(() => validateManagementOperations([{
    itemId: 'later',
    dependsOn: ['missing'],
    kind: 'delete_agent',
    agentId: 'agent_missing',
    expectedRevision: 1,
  }]), /earlier item/i);
  assert.throws(() => validateManagementOperations([{
    itemId: 'placement',
    kind: 'place_agent',
    workspaceId: 'T1',
    channelId: 'C1',
    expectedRevision: 1,
    expectedAgentId: null,
  }]), /agentId or agentClientRef/i);
});
