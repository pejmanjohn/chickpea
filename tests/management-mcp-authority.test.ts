import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ParsedSkillSource } from '../src/config/skill-import.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { AGENT_AUTHORING_GUIDE_VERSION } from '../src/management/agent-authoring/index.ts';
import type { WorkspaceManagementServiceInput } from '../src/management/service.ts';
import {
  invokeWorkspaceManagementTool,
  type WorkspaceManagementToolArguments,
  type WorkspaceManagementToolName,
} from '../src/management/tool-adapter.ts';
import type {
  ImportSkillResult,
  ManagementActorContext,
  ManagementApplyResult,
  ManagementOperation,
} from '../src/management/types.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

type Fixture = Awaited<ReturnType<typeof createManagementAdapterFixture>>;
type Person = Fixture['owner'] | Fixture['admin'];

const knowledgeServer = {
  id: 'knowledge',
  displayName: 'Knowledge',
  url: 'https://mcp.example.test/mcp',
  transport: 'streamable-http' as const,
  authMode: 'none' as const,
  headerNames: [],
  enabled: true,
  lifecycleStatus: 'ready' as const,
  statusText: 'Ready',
  discoveredTools: [],
  allowedTools: [],
};

const billingApi = {
  id: 'billing',
  displayName: 'Billing',
  allowedHosts: ['billing.example.test'],
  pathPrefixes: ['/v1/'],
  headerName: 'Authorization',
  allowedMethods: ['GET'],
  enabled: true,
};

const docsRepository = {
  id: 'docs',
  installationId: 7,
  accountLogin: 'acme',
  fullName: 'acme/docs',
  enabled: true,
};

function mcpContext(person: Pick<Person, 'user' | 'membership'>): ManagementActorContext {
  return {
    userId: person.user.id,
    membershipId: person.membership.id,
    organizationId: person.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'authority-test' },
  };
}

async function call<TName extends WorkspaceManagementToolName>(
  f: Fixture,
  person: Pick<Person, 'user' | 'membership'>,
  name: TName,
  args: WorkspaceManagementToolArguments[TName],
): Promise<{ ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }> {
  return invokeWorkspaceManagementTool({
    service: f.service,
    resolveContext: async () => mcpContext(person),
  }, name, args);
}

interface ToolResults {
  apply_workspace_changes: ManagementApplyResult;
  confirm_workspace_change: ManagementApplyResult;
  undo_workspace_change: ManagementApplyResult;
  import_skill: ImportSkillResult;
}

/** The service result the adapter passes through, once the call succeeded. */
async function succeed<TName extends keyof ToolResults>(
  f: Fixture,
  person: Pick<Person, 'user' | 'membership'>,
  name: TName,
  args: WorkspaceManagementToolArguments[TName],
): Promise<ToolResults[TName]> {
  const response = await call(f, person, name, args);
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { result: ToolResults[TName] }).result;
}

async function apply(
  f: Fixture,
  person: Pick<Person, 'user' | 'membership'>,
  key: string,
  operations: ManagementOperation[],
): Promise<ManagementApplyResult> {
  return succeed(f, person, 'apply_workspace_changes', { idempotencyKey: key, operations });
}

async function confirm(
  f: Fixture,
  person: Pick<Person, 'user' | 'membership'>,
  proposalId: string,
): Promise<ManagementApplyResult> {
  return succeed(f, person, 'confirm_workspace_change', { proposalId });
}

function assertApplied(result: ManagementApplyResult, label: string): void {
  assert.equal(result.status, 'completed', `${label}: ${JSON.stringify(result.outcomes)}`);
  assert.deepEqual(result.outcomes.map(({ disposition }) => disposition), ['applied'], label);
  assert.equal(result.presentation, undefined, `${label} must not carry a confirmation preview`);
}

function pendingConfirmation(result: ManagementApplyResult, label: string): string {
  assert.equal(result.status, 'confirmation_required', `${label}: ${JSON.stringify(result.outcomes)}`);
  const proposalId = result.outcomes[0]?.proposalId;
  assert.match(proposalId ?? '', /^changeset_/, label);
  assert.ok((result.presentation?.markdown ?? '').trim().length > 0, `${label} needs a readable preview`);
  return proposalId!;
}

async function createAgent(
  f: Fixture,
  creator: Pick<Person, 'membership'>,
  id: string,
  extra: Partial<CustomAgentConfig> = {},
): Promise<CustomAgentConfig> {
  return f.config.createAgent({
    id,
    name: id.replace(/^agent_/, '').replace(/_/g, ' '),
    instructions: 'Help the team.',
    enabled: true,
    lifecycle: 'active',
    creatorMembershipId: creator.membership.id,
    editPolicy: 'creator_and_admins',
    configurationGeneration: 1,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
    ...extra,
  });
}

async function withFixture(
  suffix: string,
  run: (f: Fixture) => Promise<void>,
  overrides: Partial<WorkspaceManagementServiceInput> = {},
): Promise<void> {
  const f = await createManagementAdapterFixture(suffix, overrides);
  try {
    await run(f);
  } finally {
    f.close();
  }
}

test('MCP applies every allowed non-destructive change in one call', () => withFixture('mcp-direct', async (f) => {
  const workspaceId = f.owner.binding.slackTeamId;
  await f.config.putChannel({
    workspaceId,
    channelId: 'C_DIRECT',
    label: 'direct',
    lifecycle: 'active',
  });

  const created = await apply(f, f.owner, 'create-shared', [{
    itemId: 'create',
    kind: 'create_agent',
    agent: {
      id: 'agent_shared',
      name: 'Shared',
      instructions: 'Accept edits from the whole team.',
      editPolicy: 'all_workspace_members',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    },
  }]);
  assertApplied(created, 'create with workspace-wide edit authority');
  assert.equal((await f.config.getAgent('agent_shared')).editPolicy, 'all_workspace_members');

  let agent = await createAgent(f, f.owner, 'agent_direct');
  assertApplied(await apply(f, f.owner, 'edit-policy', [{
    itemId: 'edit-policy',
    kind: 'update_agent',
    agentId: agent.id,
    expectedRevision: agent.revision,
    patch: { editPolicy: 'all_workspace_members' },
  }]), 'editPolicy change');
  agent = await f.config.getAgent(agent.id);
  assert.equal(agent.editPolicy, 'all_workspace_members');

  assertApplied(await apply(f, f.owner, 'add-mcp', [{
    itemId: 'add-mcp',
    kind: 'update_agent',
    agentId: agent.id,
    expectedRevision: agent.revision,
    patch: { mcpServers: [knowledgeServer] },
  }]), 'mcpServers addition');
  agent = await f.config.getAgent(agent.id);
  assert.deepEqual(agent.mcpServers.map(({ id }) => id), ['knowledge']);

  assertApplied(await apply(f, f.owner, 'grant', [{
    itemId: 'grant',
    kind: 'grant_agent_channel',
    workspaceId,
    channelId: 'C_DIRECT',
    agentId: agent.id,
    expectedRevision: 0,
  }]), 'Channel grant');
  const [grant] = await f.config.listAgentChannelGrants(workspaceId, 'C_DIRECT');
  assert.equal(grant?.status, 'active');

  assertApplied(await apply(f, f.owner, 'revoke', [{
    itemId: 'revoke',
    kind: 'revoke_agent_channel',
    workspaceId,
    channelId: 'C_DIRECT',
    agentId: agent.id,
    expectedRevision: grant!.revision,
  }]), 'Channel revoke');
  assert.deepEqual(await f.config.listAgentChannelGrants(workspaceId, 'C_DIRECT'), []);

  agent = await f.config.getAgent(agent.id);
  assertApplied(await apply(f, f.owner, 'archive', [{
    itemId: 'archive',
    kind: 'archive_agent',
    agentId: agent.id,
    expectedRevision: agent.revision,
  }]), 'archive');
  agent = await f.config.getAgent(agent.id);
  assert.equal(agent.lifecycle, 'archived');

  assertApplied(await apply(f, f.owner, 'restore', [{
    itemId: 'restore',
    kind: 'restore_agent',
    agentId: agent.id,
    expectedRevision: agent.revision,
  }]), 'restore');
  agent = await f.config.getAgent(agent.id);
  assert.notEqual(agent.lifecycle, 'archived');

  const unreached = await createAgent(f, f.owner, 'agent_unreached');
  const disabled = await apply(f, f.owner, 'disable-unreached', [{
    itemId: 'disable',
    kind: 'update_agent',
    agentId: unreached.id,
    expectedRevision: unreached.revision,
    patch: { enabled: false },
  }]);
  assertApplied(disabled, 'disable without Channel reach');
  assert.equal(disabled.outcomes[0]?.undoAvailable, true, 'a disable without Channel reach keeps its undo');
  assert.equal((await f.config.getAgent(unreached.id)).enabled, false);
  assertApplied(await succeed(f, f.owner, 'undo_workspace_change', {
    operationId: disabled.operationId,
    idempotencyKey: 'undo-disable-unreached',
  }), 'undo of a disable');
  assert.equal((await f.config.getAgent(unreached.id)).enabled, true);

  const repositoryAgent = await createAgent(f, f.owner, 'agent_repository', {
    repositories: [docsRepository],
  });
  assertApplied(await apply(f, f.owner, 'remove-repository', [{
    itemId: 'remove-repository',
    kind: 'update_agent',
    agentId: repositoryAgent.id,
    expectedRevision: repositoryAgent.revision,
    patch: { repositories: [] },
  }]), 'repository grant removal');
  assert.deepEqual((await f.config.getAgent(repositoryAgent.id)).repositories, []);

  const member = (await f.identity.provisionSlackMember({
    slackTeamId: workspaceId,
    slackUserId: 'UDIRECTROLE1',
    displayName: 'Role Member',
  })).resolution!;
  assertApplied(await apply(f, f.owner, 'make-admin', [{
    itemId: 'make-admin',
    kind: 'update_member',
    membershipId: member.membership.id,
    role: 'admin',
  }]), 'member to Admin role change');
  assert.equal((await f.identity.getMembership(member.membership.id))?.role, 'admin');
  assert.deepEqual(
    (await f.identity.listAuditEvents())
      .filter(({ subjectId }) => subjectId === member.membership.id)
      .map(({ reasonCode }) => reasonCode),
    ['workspace_management_direct'],
  );
}));

test('MCP keeps revision protection on a direct archive', () => withFixture('mcp-direct-stale', async (f) => {
  const agent = await createAgent(f, f.owner, 'agent_stale');
  const stale = await apply(f, f.owner, 'archive-stale', [{
    itemId: 'archive',
    kind: 'archive_agent',
    agentId: agent.id,
    expectedRevision: agent.revision + 1,
  }]);
  assert.deepEqual(stale.outcomes.map(({ disposition, code }) => [disposition, code]), [
    ['failed', 'revision_conflict'],
  ]);
  assert.equal((await f.config.getAgent(agent.id)).lifecycle, 'active');
}));

test('MCP asks before each destructive change and applies it on confirmation', () => {
  let storedKey = true;
  return withFixture('mcp-destructive', async (f) => {
    const workspaceId = f.owner.binding.slackTeamId;
    const member = (await f.identity.provisionSlackMember({
      slackTeamId: workspaceId,
      slackUserId: 'UDESTRUCTIVE1',
      displayName: 'Destructive Member',
    })).resolution!;

    const doomed = await createAgent(f, f.owner, 'agent_doomed');
    const deleteProposal = pendingConfirmation(await apply(f, f.owner, 'delete-agent', [{
      itemId: 'delete',
      kind: 'delete_agent',
      agentId: doomed.id,
      expectedRevision: doomed.revision,
    }]), 'delete_agent');
    assert.equal((await f.config.getAgent(doomed.id)).id, doomed.id);
    assert.equal((await confirm(f, f.owner, deleteProposal)).status, 'completed');
    assert.equal((await f.config.listUserAgents()).some(({ id }) => id === doomed.id), false);

    const memberProposal = pendingConfirmation(await apply(f, f.owner, 'suspend-member', [{
      itemId: 'suspend',
      kind: 'update_member',
      membershipId: member.membership.id,
      status: 'suspended',
    }]), 'update_member');
    assert.equal((await f.identity.getMembership(member.membership.id))?.status, 'active');
    assert.equal((await confirm(f, f.owner, memberProposal)).status, 'completed');
    assert.equal((await f.identity.getMembership(member.membership.id))?.status, 'suspended');
    assert.deepEqual(
      (await f.identity.listAuditEvents())
        .filter(({ subjectId }) => subjectId === member.membership.id)
        .map(({ reasonCode }) => reasonCode),
      ['workspace_management_confirmation'],
    );

    const ownerProposal = pendingConfirmation(await apply(f, f.owner, 'make-owner', [{
      itemId: 'make-owner',
      kind: 'update_member',
      membershipId: f.admin.membership.id,
      role: 'owner',
    }]), 'promotion to Owner');
    assert.equal((await f.identity.getMembership(f.admin.membership.id))?.role, 'admin');
    assert.equal((await confirm(f, f.owner, ownerProposal)).status, 'completed');
    assert.equal((await f.identity.getMembership(f.admin.membership.id))?.role, 'owner');

    assertApplied(await apply(f, f.owner, 'reactivate-member', [{
      itemId: 'reactivate',
      kind: 'update_member',
      membershipId: member.membership.id,
      status: 'active',
    }]), 'reactivation');
    assert.equal((await f.identity.getMembership(member.membership.id))?.status, 'active');

    const keyProposal = pendingConfirmation(await apply(f, f.owner, 'remove-key', [{
      itemId: 'remove-key',
      kind: 'remove_provider_credential',
      providerId: 'openai',
    }]), 'remove_provider_credential');
    assert.equal(storedKey, true);
    assert.equal((await confirm(f, f.owner, keyProposal)).status, 'completed');
    assert.equal(storedKey, false);

    for (const [field, entry] of [
      ['mcpServers', knowledgeServer],
      ['apiConnections', billingApi],
    ] as const) {
      const connected = await createAgent(f, f.owner, `agent_remove_${field.toLowerCase()}`, {
        [field]: [entry],
      });
      const removal = pendingConfirmation(await apply(f, f.owner, `remove-${field}`, [{
        itemId: `remove-${field}`,
        kind: 'update_agent',
        agentId: connected.id,
        expectedRevision: connected.revision,
        patch: { [field]: [] },
      }]), `${field} removal`);
      assert.equal((await f.config.getAgent(connected.id))[field].length, 1);
      assert.equal((await confirm(f, f.owner, removal)).status, 'completed');
      assert.equal((await f.config.getAgent(connected.id))[field].length, 0);
    }

    const scheduled = await createAgent(f, f.owner, 'agent_scheduled');
    await f.config.putAgentChannelGrant({
      workspaceId,
      channelId: 'C_ROUTINE',
      agentId: scheduled.id,
      status: 'active',
      createdByMembershipId: f.owner.membership.id,
      channelLabel: 'routine',
    });
    assertApplied(await apply(f, f.owner, 'save-routine', [{
      itemId: 'routine',
      kind: 'save_routine',
      requiredConnectionAccountIds: [],
      agentId: scheduled.id,
      workspaceId,
      channelId: 'C_ROUTINE',
      name: 'Morning triage',
      description: 'Triage the overnight queue.',
      taskText: 'Summarize urgent requests.',
      schedule: { kind: 'cron', expression: '0 9 * * 1-5' },
      timezone: 'UTC',
      outputPolicy: 'post',
    }]), 'save_routine');
    const [routine] = await f.routines.listRoutines(workspaceId, 'C_ROUTINE');
    assert.ok(routine);
    const routineProposal = pendingConfirmation(await apply(f, f.owner, 'delete-routine', [{
      itemId: 'delete-routine',
      kind: 'delete_routine',
      workspaceId,
      channelId: 'C_ROUTINE',
      routineId: routine.id,
      expectedVersion: routine.version,
    }]), 'delete_routine');
    assert.equal((await f.routines.getRoutine(routine.id))?.deletedAt, null);
    assert.equal((await confirm(f, f.owner, routineProposal)).status, 'completed');
    assert.notEqual((await f.routines.getRoutine(routine.id))?.deletedAt, null);

    const reached = await f.config.getAgent(scheduled.id);
    const disableProposal = pendingConfirmation(await apply(f, f.owner, 'disable-reached', [{
      itemId: 'disable',
      kind: 'update_agent',
      agentId: reached.id,
      expectedRevision: reached.revision,
      patch: { enabled: false },
    }]), 'disable with Channel reach');
    assert.equal((await f.config.getAgent(reached.id)).enabled, true);
    assert.equal((await confirm(f, f.owner, disableProposal)).status, 'completed');
    assert.equal((await f.config.getAgent(reached.id)).enabled, false);
  }, {
    providerCredentialSource: async () => storedKey ? 'stored' : 'missing',
    removeProviderCredential: async () => {
      storedKey = false;
      return 'missing';
    },
  });
});

test('MCP grants a member exactly the Admin UI authority', () => withFixture('mcp-member', async (f) => {
  const member = (await f.identity.provisionSlackMember({
    slackTeamId: f.owner.binding.slackTeamId,
    slackUserId: 'UAUTHORITY1',
    displayName: 'Authority Member',
  })).resolution!;
  const theirs = await createAgent(f, member, 'agent_theirs');
  const shared = await createAgent(f, f.owner, 'agent_open', { editPolicy: 'all_workspace_members' });
  const locked = await createAgent(f, f.owner, 'agent_locked');

  assertApplied(await apply(f, member, 'member-archive-own', [{
    itemId: 'archive',
    kind: 'archive_agent',
    agentId: theirs.id,
    expectedRevision: theirs.revision,
  }]), 'member archives their own Agent');
  assertApplied(await apply(f, member, 'member-edit-shared', [{
    itemId: 'instructions',
    kind: 'update_agent',
    agentId: shared.id,
    expectedRevision: shared.revision,
    patch: { instructions: 'Edited by any member.' },
  }]), 'member edits a workspace-editable Agent');

  const denied = await apply(f, member, 'member-archive-locked', [{
    itemId: 'archive',
    kind: 'archive_agent',
    agentId: locked.id,
    expectedRevision: locked.revision,
  }]);
  assert.deepEqual(denied.outcomes.map(({ disposition, code }) => [disposition, code]), [
    ['failed', 'forbidden'],
  ]);
  assert.equal((await f.config.getAgent(locked.id)).lifecycle, 'active');

  const memberChange = await apply(f, member, 'member-promote', [{
    itemId: 'promote',
    kind: 'update_member',
    membershipId: member.membership.id,
    role: 'admin',
  }]);
  assert.deepEqual(memberChange.outcomes.map(({ disposition, code }) => [disposition, code]), [
    ['failed', 'operational_access_required'],
  ]);

  const adminMemberChange = await apply(f, f.admin, 'admin-suspend', [{
    itemId: 'suspend',
    kind: 'update_member',
    membershipId: member.membership.id,
    status: 'suspended',
  }]);
  assert.deepEqual(adminMemberChange.outcomes.map(({ disposition, code }) => [disposition, code]), [
    ['failed', 'owner_required'],
  ]);
  assert.equal((await f.identity.getMembership(member.membership.id))?.status, 'active');
}));

test('MCP undo applies directly unless the inverse removes a connection', () => withFixture('mcp-undo', async (f) => {
  let agent = await createAgent(f, f.owner, 'agent_undo');
  const edited = await apply(f, f.owner, 'edit-instructions', [{
    itemId: 'instructions',
    kind: 'update_agent',
    agentId: agent.id,
    expectedRevision: agent.revision,
    patch: { instructions: 'A newer role.' },
  }]);
  assertApplied(edited, 'instruction edit');
  assertApplied(await succeed(f, f.owner, 'undo_workspace_change', {
    operationId: edited.operationId,
    idempotencyKey: 'undo-instructions',
  }), 'undo of an instruction edit');
  agent = await f.config.getAgent(agent.id);
  assert.equal(agent.instructions, 'Help the team.');

  const added = await apply(f, f.owner, 'add-connection', [{
    itemId: 'add-mcp',
    kind: 'update_agent',
    agentId: agent.id,
    expectedRevision: agent.revision,
    patch: { mcpServers: [knowledgeServer] },
  }]);
  assertApplied(added, 'connection addition');
  const proposalId = pendingConfirmation(await succeed(f, f.owner, 'undo_workspace_change', {
    operationId: added.operationId,
    idempotencyKey: 'undo-connection',
  }), 'undo that removes a connection');
  assert.equal((await f.config.getAgent(agent.id)).mcpServers.length, 1);
  assert.equal((await confirm(f, f.owner, proposalId)).status, 'completed');
  assert.equal((await f.config.getAgent(agent.id)).mcpServers.length, 0);
}));

test('MCP import_skill installs from the authenticated call itself', () => {
  const resolved: ParsedSkillSource[] = [];
  return withFixture('mcp-import-skill', async (f) => {
    const agent = await createAgent(f, f.owner, 'agent_importer');
    const installed = await succeed(f, f.owner, 'import_skill', {
      agentId: agent.id,
      source: 'https://github.com/acme/skills/tree/main/changelog',
      idempotencyKey: 'import-changelog',
      guideVersion: AGENT_AUTHORING_GUIDE_VERSION,
    });
    assert.equal(installed.status, 'installed');
    assert.equal(resolved.length, 1);
    assert.deepEqual((await f.config.getAgent(agent.id)).skills.map(({ name }) => name), ['changelog']);

    const changed = {
      agentId: agent.id,
      source: 'https://github.com/acme/skills/tree/main/changelog',
      guideVersion: AGENT_AUTHORING_GUIDE_VERSION,
    };
    const clarification = await succeed(f, f.owner, 'import_skill', { ...changed, idempotencyKey: 'import-changed' });
    assert.ok(clarification.status === 'replacement_confirmation_required', clarification.status);
    assert.match(clarification.instruction, /replaceExisting true/);
    assert.doesNotMatch(clarification.instruction, /reply exactly/, 'an MCP call needs no Slack replacement phrase');

    const replaced = await succeed(f, f.owner, 'import_skill', {
      ...changed,
      replaceExisting: true,
      idempotencyKey: 'import-replace',
    });
    assert.equal(replaced.status, 'installed');
    assert.equal(
      (await f.config.getAgent(agent.id)).skills[0]?.instructions,
      'Summarize merged changes for people. Revision 3.',
    );
  }, {
    resolveSkillImport: async (source) => {
      resolved.push(source);
      return {
        owner: source.owner,
        repo: source.repo,
        ref: '2222222222222222222222222222222222222222',
        source: { visibility: 'public', access: 'anonymous' },
        skills: [{
          name: 'changelog',
          description: 'Write a changelog entry.',
          instructions: resolved.length === 1
            ? 'Summarize merged changes for people.'
            : `Summarize merged changes for people. Revision ${resolved.length}.`,
          hasScripts: false,
          path: 'changelog',
          sourceUrl: 'https://github.com/acme/skills/tree/2222222222222222222222222222222222222222/changelog',
        }],
        total: 1,
        capped: false,
        skipped: 0,
      };
    },
  });
});

test('MCP sends back a destructive change that cannot share a confirmation with its call', () => withFixture('mcp-own-call', async (f) => {
  const agent = await createAgent(f, f.owner, 'agent_own_call', { mcpServers: [knowledgeServer] });
  const result = await apply(f, f.owner, 'remove-then-edit', [
    {
      itemId: 'remove-mcp',
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: agent.revision,
      patch: { mcpServers: [] },
    },
    {
      itemId: 'edit',
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: agent.revision + 1,
      patch: { instructions: 'After the removal.' },
    },
  ]);
  assert.deepEqual(result.outcomes.map(({ disposition, code }) => [disposition, code]), [
    ['failed', 'confirmation_needs_own_call'],
    ['failed', 'revision_conflict'],
  ]);
  assert.match(result.outcomes[0]?.instruction ?? '', /other operations in this call were handled without it/);
  assert.match(result.outcomes[0]?.instruction ?? '', /Resend only this operation, in its own apply_workspace_changes call/);
  assert.equal((await f.config.getAgent(agent.id)).mcpServers.length, 1);
}));

test('MCP keeps only the newest destructive change confirmable', () => withFixture('mcp-supersede', async (f) => {
  const first = await createAgent(f, f.owner, 'agent_first');
  const second = await createAgent(f, f.owner, 'agent_second');
  const firstProposal = pendingConfirmation(await apply(f, f.owner, 'delete-first', [{
    itemId: 'delete', kind: 'delete_agent', agentId: first.id, expectedRevision: first.revision,
  }]), 'first delete');
  pendingConfirmation(await apply(f, f.owner, 'delete-second', [{
    itemId: 'delete', kind: 'delete_agent', agentId: second.id, expectedRevision: second.revision,
  }]), 'second delete');

  const stale = await call(f, f.owner, 'confirm_workspace_change', { proposalId: firstProposal });
  assert.equal(stale.ok ? undefined : stale.error.code, 'proposal_stale');
  assert.equal((await f.config.getAgent(first.id)).id, first.id);
}));

test('MCP retries a direct archive whose first attempt failed after the write', () => {
  let fixture: Fixture | undefined;
  let writes = 0;
  return withFixture('mcp-direct-retry', async (f) => {
    fixture = f;
    const agent = await createAgent(f, f.owner, 'agent_retry');
    const operations: ManagementOperation[] = [{
      itemId: 'archive',
      kind: 'archive_agent',
      agentId: agent.id,
      expectedRevision: agent.revision,
    }];
    const lost = await call(f, f.owner, 'apply_workspace_changes', { idempotencyKey: 'archive-retry', operations });
    assert.equal(lost.ok ? undefined : lost.error.code, 'management_error');
    assert.equal((await f.config.getAgent(agent.id)).lifecycle, 'archived');

    assertApplied(await apply(f, f.owner, 'archive-retry', operations), 'retried archive');
    assert.equal(writes, 1, 'the retry must not archive twice');
    assert.equal((await f.config.getAgent(agent.id)).lifecycle, 'archived');
  }, {
    archiveAgent: async ({ agentId, expectedRevision, expectedCredentialIncarnation }) => {
      assert.ok(fixture);
      writes += 1;
      const archived = await fixture.config.archiveAgent(agentId, {
        expectedRevision,
        ...(expectedCredentialIncarnation ? { expectedCredentialIncarnation } : {}),
      });
      if (writes === 1) throw new Error('The archive response was lost after the write.');
      return archived;
    },
  });
});
