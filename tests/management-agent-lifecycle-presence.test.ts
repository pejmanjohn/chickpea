import assert from 'node:assert/strict';
import { test } from 'node:test';

import { UnknownAgentError } from '../src/config/errors.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import {
  invokeWorkspaceManagementTool,
  type WorkspaceManagementToolArguments,
  type WorkspaceManagementToolName,
} from '../src/management/tool-adapter.ts';
import type {
  ManagementActorContext,
  ManagementApplyResult,
  ManagementOperation,
} from '../src/management/types.ts';
import { AgentPresenceReconciler } from '../src/slack/agent-presence/reconciler.ts';
import type { SlackTransport, SlackUserGroup } from '../src/slack/transport/types.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

type Fixture = Awaited<ReturnType<typeof createManagementAdapterFixture>>;
type ToolResponse = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

/** Slack's user-group directory: the part of Slack that publishing, renaming and archiving an Agent use. */
class UserGroupDirectory implements SlackTransport {
  readonly mode = 'direct';
  groups: SlackUserGroup[] = [];

  async lookupUserGroup(id: string) {
    const group = this.groups.find((candidate) => candidate.id === id);
    return group ? { ...group } : undefined;
  }
  async listUserGroups() { return this.groups.map((group) => ({ ...group })); }
  async createUserGroup(input: { name: string; handle: string; description?: string }) {
    const group: SlackUserGroup = { id: `S${this.groups.length + 1}`, ...input, disabled: false };
    this.groups.push(group);
    return { ...group };
  }
  async updateUserGroup(id: string, patch: { name?: string; handle?: string; description?: string }) {
    return { ...Object.assign(this.group(id), patch) };
  }
  async disableUserGroup(id: string) { return { ...Object.assign(this.group(id), { disabled: true }) }; }
  async enableUserGroup(id: string) { return { ...Object.assign(this.group(id), { disabled: false }) }; }
  async lookupMember(): Promise<never> { throw new Error('unused'); }
  async lookupChannel(): Promise<never> { throw new Error('unused'); }
  async listChannels(): Promise<never> { throw new Error('unused'); }
  async listMemberChannels(): Promise<never> { throw new Error('unused'); }
  async channelHasMember(): Promise<never> { throw new Error('unused'); }
  async openDirectConversation(): Promise<never> { throw new Error('unused'); }
  async joinPublicChannel(): Promise<never> { throw new Error('unused'); }
  async publishAppHome(): Promise<never> { throw new Error('unused'); }
  async postMessage(): Promise<never> { throw new Error('unused'); }

  private group(id: string): SlackUserGroup {
    const group = this.groups.find((candidate) => candidate.id === id);
    if (!group) throw new Error(`Unknown user group ${id}`);
    return group;
  }
}

/**
 * A workspace on a paid Slack plan, wired the way the live service wires
 * presence: creation publishes the handle, a name or description change syncs
 * the user group, and archive turns it off.
 */
async function withPublishingWorkspace(
  suffix: string,
  run: (f: Fixture, slack: UserGroupDirectory, presence: AgentPresenceReconciler) => Promise<void>,
): Promise<void> {
  const slack = new UserGroupDirectory();
  let presence: AgentPresenceReconciler | undefined;
  const reconciler = () => presence!;
  const f = await createManagementAdapterFixture(suffix, {
    publishAgentPresence: async ({ agentId }) => ({ agent: await reconciler().retry(agentId) }),
    reconcileAgentUpdate: async ({ agent, patch }) => {
      const presentationChanged = patch.name !== undefined ||
        patch.description !== undefined || patch.slackPresence !== undefined;
      return presentationChanged && agent.slackPresence?.desiredState === 'active'
        ? reconciler().retry(agent.id)
        : agent;
    },
    archiveAgent: async ({ agentId, expectedCredentialIncarnation }) => reconciler().archive(
      agentId,
      expectedCredentialIncarnation ? { expectedCredentialIncarnation } : {},
    ),
  });
  presence = new AgentPresenceReconciler({ config: f.config, transport: slack, announce: null });
  try {
    await run(f, slack, presence);
  } finally {
    f.close();
  }
}

function ownerContext(f: Fixture): ManagementActorContext {
  return {
    userId: f.owner.user.id,
    membershipId: f.owner.membership.id,
    organizationId: f.owner.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'lifecycle-test' },
  };
}

function call<TName extends WorkspaceManagementToolName>(
  f: Fixture,
  name: TName,
  args: WorkspaceManagementToolArguments[TName],
): Promise<ToolResponse> {
  return invokeWorkspaceManagementTool({ service: f.service, resolveContext: async () => ownerContext(f) }, name, args);
}

async function succeed<TName extends WorkspaceManagementToolName>(
  f: Fixture,
  name: TName,
  args: WorkspaceManagementToolArguments[TName],
): Promise<ManagementApplyResult> {
  const response = await call(f, name, args);
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { result: ManagementApplyResult }).result;
}

function apply(f: Fixture, idempotencyKey: string, operations: ManagementOperation[]) {
  return succeed(f, 'apply_workspace_changes', { idempotencyKey, operations });
}

function dispositions(result: ManagementApplyResult) {
  return result.outcomes.map(({ disposition, code }) => [disposition, code ?? null]);
}

async function createPublishedAgent(f: Fixture, slack: UserGroupDirectory): Promise<CustomAgentConfig> {
  const created = await apply(f, 'create-scout', [{
    itemId: 'create',
    kind: 'create_agent',
    agent: {
      id: 'agent_scout',
      name: 'Scout',
      description: 'Finds leads.',
      instructions: 'Find leads.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    },
  }]);
  assert.equal(created.status, 'completed', JSON.stringify(created));
  const agent = await f.config.getAgent('agent_scout');
  assert.equal(agent.slackPresence?.health, 'healthy');
  assert.equal(agent.slackPresence?.userGroupId, 'S1', 'creation published the handle at once');
  assert.deepEqual(slack.groups.map(({ handle, disabled }) => [handle, disabled]), [['scout', false]]);
  return agent;
}

async function changeDescription(f: Fixture, key: string, description: string) {
  const agent = await f.config.getAgent('agent_scout');
  const changed = await apply(f, key, [{
    itemId: 'describe',
    kind: 'update_agent',
    agentId: agent.id,
    expectedRevision: agent.revision,
    patch: { description },
  }]);
  assert.equal(changed.status, 'completed', JSON.stringify(changed));
  assert.equal(changed.outcomes[0]?.undoAvailable, true);
  return { changed, revisionBefore: agent.revision };
}

test('undo of a description change on a published Agent puts it back after presence sync moved the revision', () =>
  withPublishingWorkspace('undo-description-sync', async (f, slack) => {
    await createPublishedAgent(f, slack);
    const { changed, revisionBefore } = await changeDescription(f, 'describe', 'Finds and qualifies leads.');
    const edited = await f.config.getAgent('agent_scout');
    assert.ok(edited.revision > revisionBefore + 1, 'syncing the user group wrote revisions after the edit');
    assert.equal(slack.groups[0]?.description, 'Finds and qualifies leads.');

    const undone = await succeed(f, 'undo_workspace_change', {
      operationId: changed.operationId,
      idempotencyKey: 'undo-describe',
    });
    assert.equal(undone.status, 'completed', JSON.stringify(undone.outcomes));
    const restored = await f.config.getAgent('agent_scout');
    assert.equal(restored.description, 'Finds leads.');
    assert.equal(restored.slackPresence?.userGroupId, 'S1', 'the undo keeps the published handle');
    assert.equal(restored.slackPresence?.health, 'healthy');
    assert.equal(slack.groups[0]?.description, 'Finds leads.', 'Slack shows the restored description');
  }));

test('a later presence sync does not block undo, but someone else\'s edit does', () =>
  withPublishingWorkspace('undo-description-later', async (f, slack, presence) => {
    await createPublishedAgent(f, slack);
    const first = await changeDescription(f, 'describe-first', 'Finds and qualifies leads.');
    const afterEdit = (await f.config.getAgent('agent_scout')).revision;
    assert.ok((await presence.retry('agent_scout')).revision > afterEdit, 'a later sync wrote more revisions');
    const undone = await succeed(f, 'undo_workspace_change', {
      operationId: first.changed.operationId,
      idempotencyKey: 'undo-first',
    });
    assert.equal(undone.status, 'completed', JSON.stringify(undone.outcomes));
    assert.equal((await f.config.getAgent('agent_scout')).description, 'Finds leads.');

    const second = await changeDescription(f, 'describe-second', 'Qualifies leads only.');
    const current = await f.config.getAgent('agent_scout');
    await f.config.updateAgent(current.id, { instructions: 'Qualify leads.' }, current.revision);
    const refused = await call(f, 'undo_workspace_change', {
      operationId: second.changed.operationId,
      idempotencyKey: 'undo-second',
    });
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal((refused as { error: { code: string } }).error.code, 'proposal_stale');
    const kept = await f.config.getAgent('agent_scout');
    assert.equal(kept.description, 'Qualifies leads only.', 'the undo changed nothing');
    assert.equal(kept.instructions, 'Qualify leads.', 'the other person\'s edit stays');
  }));

test('an Agent published from MCP can be archived and then deleted, and its handle stays off in Slack', () =>
  withPublishingWorkspace('delete-published', async (f, slack) => {
    const published = await createPublishedAgent(f, slack);

    const early = await apply(f, 'delete-live', [{
      itemId: 'delete',
      kind: 'delete_agent',
      agentId: published.id,
      expectedRevision: published.revision,
    }]);
    assert.deepEqual(dispositions(early), [['failed', 'invalid_request']],
      'a live handle is refused before anything is deleted');
    assert.equal((await f.config.getAgent(published.id)).lifecycle, 'active');

    const archived = await apply(f, 'archive', [{
      itemId: 'archive',
      kind: 'archive_agent',
      agentId: published.id,
      expectedRevision: published.revision,
    }]);
    assert.equal(archived.status, 'completed', JSON.stringify(archived.outcomes));
    const before = await f.config.getAgent(published.id);
    assert.equal(before.lifecycle, 'archived');
    assert.equal(before.slackPresence?.userGroupId, 'S1', 'an archived Agent keeps its group for restore');
    assert.equal(slack.groups[0]?.disabled, true);

    const held = await apply(f, 'delete-archived', [{
      itemId: 'delete',
      kind: 'delete_agent',
      agentId: before.id,
      expectedRevision: before.revision,
    }]);
    assert.equal(held.status, 'confirmation_required', JSON.stringify(held.outcomes));
    const confirmed = await succeed(f, 'confirm_workspace_change', { proposalId: held.outcomes[0]!.proposalId! });
    assert.equal(confirmed.status, 'completed', JSON.stringify(confirmed.outcomes));
    await assert.rejects(f.config.getAgent(before.id), UnknownAgentError);
    assert.deepEqual(slack.groups.map(({ id, disabled }) => [id, disabled]), [['S1', true]],
      'the deleted Agent leaves no live handle in Slack');
    assert.equal(confirmed.links, undefined, 'no link points at the deleted Agent');
    assert.equal(confirmed.outcomes[0]?.links, undefined);
  }));

test('an Agent with its own Slack app is not deleted until archive retires the app', () =>
  withPublishingWorkspace('delete-agent-app', async (f) => {
    const created = await f.config.createAgent({
      id: 'agent_desk',
      name: 'Desk',
      instructions: 'Answer.',
      enabled: true,
      lifecycle: 'active',
      creatorMembershipId: f.owner.membership.id,
      editPolicy: 'creator_and_admins',
      configurationGeneration: 1,
      slackPresence: {
        requestedHandle: 'desk', normalizedHandle: 'desk', desiredState: 'active', health: 'healthy',
        avatar: { kind: 'generated', revision: 1, seed: 'desk' },
      },
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const app = await f.config.updateAgent(created.id, {
      slackPresence: {
        kind: 'agent_app', requestedHandle: 'desk', normalizedHandle: 'desk', desiredState: 'active', health: 'healthy',
        avatar: created.slackPresence!.avatar,
        app: {
          state: 'active', at: 1, app: { appId: 'A_DESK', clientId: '1.2' }, icon: 'agent_avatar',
          botUserId: 'U_DESK', installedAt: 1, installedBy: f.owner.binding.slackUserId,
        },
      },
    }, created.revision);

    const refused = await apply(f, 'delete-app', [{
      itemId: 'delete',
      kind: 'delete_agent',
      agentId: app.id,
      expectedRevision: app.revision,
    }]);
    assert.deepEqual(dispositions(refused), [['failed', 'invalid_request']]);
    assert.equal((await f.config.getAgent(app.id)).slackPresence?.kind, 'agent_app', 'the app Agent is kept');
  }));
