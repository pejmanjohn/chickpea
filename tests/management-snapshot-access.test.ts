import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import type { WorkspaceManagementServiceInput } from '../src/management/service.ts';
import type { WorkspaceManagementToolResult } from '../src/management/tool-adapter.ts';
import type {
  ManagementActorContext,
  ManagementApplyResult,
  ManagementOperation,
  ManagementWorkspaceSnapshot,
} from '../src/management/types.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { SLACK_SETTING_KEYS } from '../src/slack/credentials.ts';
import { slackInstallationCredentialId } from '../src/slack/hosted-slack-app.ts';
import {
  promoteSlackCredentialBundle,
  stageSlackCredentialBundle,
} from '../src/slack/installation-credentials.ts';
import type { SlackChannel } from '../src/slack/transport/types.ts';
import {
  createManagementAdapterFixture,
  ownerSlackDmContext,
  type ManagementAdapterFixture,
} from './helpers/management-adapter-fixture.ts';
import { confirmThroughService, serviceResult } from './helpers/management-service-result.ts';

type Person = Pick<ManagementAdapterFixture['owner'], 'user' | 'membership'>;

function mcp(person: Person, clientId = 'client_current'): ManagementActorContext {
  return {
    userId: person.user.id,
    membershipId: person.membership.id,
    organizationId: person.membership.organizationId,
    origin: { kind: 'mcp', clientId },
  };
}

/** The service calls the 5.0 tools make, each in the `{ ok, result | error }` shape. */
const undo = (f: ManagementAdapterFixture, context: ManagementActorContext, args: { operationId: string; idempotencyKey: string }) =>
  serviceResult(() => f.service.undoWorkspaceChange({ context, ...args }));
const listClients = (f: ManagementAdapterFixture, context: ManagementActorContext) =>
  serviceResult(() => f.service.listMcpClients(context));
const revokeClient = (f: ManagementAdapterFixture, context: ManagementActorContext, clientId: string) =>
  serviceResult(() => f.service.revokeMcpClient(context, clientId));

async function succeed<T>(response: Promise<WorkspaceManagementToolResult>): Promise<T> {
  const settled = await response;
  assert.equal(settled.ok, true, JSON.stringify(settled));
  return (settled as { result: T }).result;
}

const apply = (f: ManagementAdapterFixture, context: ManagementActorContext, key: string, operations: ManagementOperation[]) =>
  succeed<ManagementApplyResult>(serviceResult(() => f.service.applyWorkspaceChanges({ context, idempotencyKey: key, operations })));

const inspect = (f: ManagementAdapterFixture, context: ManagementActorContext): Promise<ManagementWorkspaceSnapshot> =>
  f.service.inspectWorkspace(context);

async function withFixture(
  suffix: string,
  run: (f: ManagementAdapterFixture) => Promise<void>,
  overrides: Partial<WorkspaceManagementServiceInput> = {},
): Promise<void> {
  const f = await createManagementAdapterFixture(suffix, overrides);
  try {
    await run(f);
  } finally {
    f.close();
  }
}

async function createAgent(
  f: ManagementAdapterFixture,
  id: string,
  extra: Partial<CustomAgentConfig> = {},
): Promise<CustomAgentConfig> {
  return f.config.createAgent({
    id,
    name: id.replace(/^agent_/, ''),
    instructions: 'Help the team.',
    enabled: true,
    lifecycle: 'active',
    creatorMembershipId: f.owner.membership.id,
    editPolicy: 'creator_and_admins',
    configurationGeneration: 1,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
    ...extra,
  });
}

async function grant(f: ManagementAdapterFixture, agentId: string, channelId: string): Promise<void> {
  await f.config.putAgentChannelGrant({
    workspaceId: f.owner.binding.slackTeamId,
    channelId,
    agentId,
    status: 'active',
    createdByMembershipId: f.owner.membership.id,
  });
}

function slackFacts(
  channels: Record<string, Omit<SlackChannel, 'id'>>,
): NonNullable<WorkspaceManagementServiceInput['slackFacts']> {
  return async () => ({
    async lookupChannel(channelId) {
      const channel = channels[channelId];
      if (!channel) throw new Error(`channel_not_found:${channelId}`);
      return { id: channelId, ...channel };
    },
    async listMemberChannels() {
      return new Set<string>();
    },
  });
}

test('a request whose every item failed is failed; one with an applied item stays partial', () =>
  withFixture('status-failed', async (f) => {
    const agent = await createAgent(f, 'agent_status');
    const stale = (itemId: string): ManagementOperation => ({
      itemId,
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: agent.revision + 5,
      patch: { instructions: `Stale ${itemId}.` },
    });
    const onlyFailed = await apply(f, mcp(f.owner), 'only-failed', [stale('stale')]);
    assert.deepEqual(onlyFailed.outcomes.map(({ disposition }) => disposition), ['failed']);
    assert.equal(onlyFailed.status, 'failed');

    const allFailed = await apply(f, mcp(f.owner), 'all-failed', [stale('first'), stale('second')]);
    assert.equal(allFailed.status, 'failed', JSON.stringify(allFailed.outcomes));

    const mixed = await apply(f, mcp(f.owner), 'mixed', [{
      itemId: 'edit',
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: agent.revision,
      patch: { instructions: 'A newer role.' },
    }, stale('stale')]);
    assert.deepEqual(mixed.outcomes.map(({ disposition }) => disposition), ['applied', 'failed']);
    assert.equal(mixed.status, 'partial');
  }));

test('a confirmed disable carries the same undo as an immediate edit, by its confirm or its apply ID', () =>
  withFixture('confirmed-undo', async (f) => {
    for (const [agentId, undoBy] of [['agent_by_confirm', 'confirm'], ['agent_by_apply', 'apply']] as const) {
      const agent = await createAgent(f, agentId);
      await grant(f, agent.id, `C_${undoBy.toUpperCase()}`);
      const requested = await apply(f, mcp(f.owner), `disable-${agentId}`, [{
        itemId: 'disable',
        kind: 'update_agent',
        agentId: agent.id,
        expectedRevision: agent.revision,
        patch: { enabled: false },
      }]);
      assert.equal(requested.status, 'confirmation_required', JSON.stringify(requested.outcomes));
      const proposalId = requested.outcomes[0]!.proposalId!;
      const confirmed = await succeed<ManagementApplyResult>(confirmThroughService(f.service, mcp(f.owner), proposalId));
      assert.equal(confirmed.status, 'completed');
      assert.equal(confirmed.outcomes[0]?.undoAvailable, true, 'the confirmed disable offers its undo');
      assert.equal((await f.config.getAgent(agent.id)).enabled, false);

      const undone = await succeed<ManagementApplyResult>(undo(f, mcp(f.owner), {
        operationId: undoBy === 'confirm' ? confirmed.operationId : requested.operationId,
        idempotencyKey: `undo-${agentId}`,
      }));
      assert.equal(undone.status, 'completed', JSON.stringify(undone.outcomes));
      const restored = await f.config.getAgent(agent.id);
      assert.equal(restored.enabled, true, `undo by the ${undoBy} ID turns the Agent back on`);
      assert.equal((await f.config.listAgentChannelGrants(f.owner.binding.slackTeamId))
        .find((row) => row.agentId === agent.id)?.status, 'active', 'its Channel grant was kept throughout');

      const again = await undo(f, mcp(f.owner), {
        operationId: confirmed.operationId,
        idempotencyKey: `undo-again-${agentId}`,
      });
      assert.ok(!again.ok && again.error.code === 'undo_unavailable', 'the undo is used once');
    }
  }));

test('a confirmed connection removal carries its undo too', () =>
  withFixture('confirmed-removal-undo', async (f) => {
    const workspaceId = f.owner.binding.slackTeamId;
    await f.config.ensureWorkspaceInstallation({
      workspaceId, teamId: workspaceId, transportMode: 'gateway', appId: 'A_P4', botUserId: 'U_BOT',
      gatewayBindingId: 'binding_p4',
    });
    let agent = await createAgent(f, 'agent_knowledge');
    const server = {
      id: 'knowledge', displayName: 'Knowledge', url: 'https://mcp.example.test/mcp',
      transport: 'streamable-http' as const, authMode: 'none' as const, headerNames: [], enabled: true, allowedTools: [],
    };
    assert.equal((await apply(f, mcp(f.owner), 'add', [{
      itemId: 'add', kind: 'update_agent', agentId: agent.id, expectedRevision: agent.revision,
      patch: { mcpServers: [server] },
    }])).status, 'completed');
    agent = await f.config.getAgent(agent.id);
    const removal = await apply(f, mcp(f.owner), 'remove', [{
      itemId: 'remove', kind: 'update_agent', agentId: agent.id, expectedRevision: agent.revision,
      patch: { mcpServers: [] },
    }]);
    assert.equal(removal.status, 'confirmation_required');
    const confirmed = await succeed<ManagementApplyResult>(confirmThroughService(f.service, mcp(f.owner), removal.outcomes[0]!.proposalId!));
    assert.equal(confirmed.outcomes[0]?.undoAvailable, true);
    const undone = await succeed<ManagementApplyResult>(undo(f, mcp(f.owner), {
      operationId: confirmed.operationId,
      idempotencyKey: 'undo-remove',
    }));
    assert.equal(undone.status, 'completed', JSON.stringify(undone.outcomes));
    const snapshot = await inspect(f, mcp(f.owner));
    assert.deepEqual(snapshot.agents.find(({ id }) => id === agent.id)?.mcpServers.map(({ id }) => id), ['knowledge']);
  }));

test('a call that changed more than the confirmed item offers no undo, as an immediate call does not', () =>
  withFixture('confirmed-multi-undo', async (f) => {
    const agent = await createAgent(f, 'agent_multi');
    await grant(f, agent.id, 'C_MULTI');
    const requested = await apply(f, mcp(f.owner), 'edit-and-disable', [{
      itemId: 'edit',
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: agent.revision,
      patch: { instructions: 'Answer in French.' },
    }, {
      itemId: 'disable',
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: agent.revision + 1,
      patch: { enabled: false },
    }]);
    assert.deepEqual(requested.outcomes.map(({ disposition }) => disposition), ['applied', 'confirmation_required']);
    assert.equal(requested.outcomes[0]?.undoAvailable, undefined, 'the edit alone is not undone either');

    const confirmed = await succeed<ManagementApplyResult>(confirmThroughService(f.service, mcp(f.owner), requested.outcomes[1]!.proposalId!));
    assert.equal(confirmed.status, 'completed');
    assert.equal(confirmed.outcomes[0]?.undoAvailable, undefined, 'an undo of the disable alone would leave the edit');
    for (const operationId of [confirmed.operationId, requested.operationId]) {
      const refused = await undo(f, mcp(f.owner), { operationId, idempotencyKey: `undo-${operationId}` });
      assert.ok(!refused.ok && refused.error.code === 'undo_unavailable', JSON.stringify(refused));
    }
    const after = await f.config.getAgent(agent.id);
    assert.equal(after.enabled, false);
    assert.equal(after.instructions, 'Answer in French.');
  }));

test('forgetting an Agent\'s memory over MCP can be undone', () =>
  withFixture('memory-undo', async (f) => {
    const agent = await createAgent(f, 'agent_memory');
    const saved = await f.memory.putAgentMemory({ agentId: agent.id, expectedRevision: 0, body: 'Refunds go to account 99.' });
    const forgotten = await apply(f, mcp(f.owner), 'forget', [{
      itemId: 'forget',
      kind: 'update_agent_memory',
      agentId: agent.id,
      expectedRevision: saved.revision,
      body: '',
    }]);
    assert.deepEqual(forgotten.outcomes.map(({ disposition }) => disposition), ['applied']);
    assert.equal(forgotten.outcomes[0]?.undoAvailable, true);
    assert.equal((await f.memory.getAgentMemory(agent.id)).body, '');

    const undone = await succeed<ManagementApplyResult>(undo(f, mcp(f.owner), {
      operationId: forgotten.operationId,
      idempotencyKey: 'undo-forget',
    }));
    assert.equal(undone.status, 'completed', JSON.stringify(undone.outcomes));
    assert.equal((await f.memory.getAgentMemory(agent.id)).body, 'Refunds go to account 99.');

    const again = await undo(f, mcp(f.owner), {
      operationId: forgotten.operationId,
      idempotencyKey: 'undo-forget-again',
    });
    assert.ok(!again.ok && again.error.code === 'undo_unavailable', 'the undo is used once');

    const other = await undo(f, mcp(f.admin), {
      operationId: forgotten.operationId,
      idempotencyKey: 'undo-forget-admin',
    });
    assert.ok(!other.ok && other.error.code === 'undo_unavailable', 'another person cannot use it');
  }));

test('a memory body the store refuses over MCP says why, not that the memory changed', () =>
  withFixture('memory-refused', async (f) => {
    const agent = await createAgent(f, 'agent_memory');
    const refused = await apply(f, mcp(f.owner), 'bell', [{
      itemId: 'bell',
      kind: 'update_agent_memory',
      agentId: agent.id,
      expectedRevision: 0,
      body: 'Ring \u0007 twice.',
    }]);
    assert.deepEqual(refused.outcomes.map(({ disposition }) => disposition), ['failed'], JSON.stringify(refused.outcomes));
    assert.match(JSON.stringify(refused.outcomes), /control characters/);
    assert.doesNotMatch(JSON.stringify(refused.outcomes), /revision_conflict|memory changed/);
    assert.equal((await f.memory.getAgentMemory(agent.id)).revision, 0);
  }));

test('inspection names the Slack team, the caller, and the team list only for people Admin shows the Team page', () =>
  withFixture('snapshot-caller', async (f) => {
    const member = (await f.identity.provisionSlackMember({
      slackTeamId: f.owner.binding.slackTeamId,
      slackUserId: 'U_SNAPSHOT_MEMBER',
      displayName: 'Mina Member',
    })).resolution!;

    const owner = await inspect(f, mcp(f.owner));
    assert.equal(owner.slackTeamId, f.owner.binding.slackTeamId, 'the Slack team ID inspect_routines takes');
    assert.deepEqual(owner.caller, {
      membershipId: f.owner.membership.id,
      role: 'owner',
      displayName: f.owner.user.displayName,
    });
    assert.ok(owner.team, 'an Owner sees the team');

    const admin = await inspect(f, mcp(f.admin));
    assert.deepEqual(admin.caller, { membershipId: f.admin.membership.id, role: 'admin', displayName: 'Admin' });
    assert.deepEqual(new Map(admin.team?.members.map(({ id, role, status }) => [id, `${role}:${status}`])), new Map([
      [f.owner.membership.id, 'owner:active'],
      [f.admin.membership.id, 'admin:active'],
      [member.membership.id, 'member:active'],
    ]), 'an Admin sees the Team page, so inspection lists the team');
    for (const row of admin.team!.members) {
      assert.ok(!Object.keys(row).some((key) => /mail/i.test(key)), 'the team list carries no email');
    }

    const asMember = await inspect(f, mcp(member));
    assert.deepEqual(asMember.caller, { membershipId: member.membership.id, role: 'member', displayName: 'Mina Member' });
    assert.equal(asMember.slackTeamId, f.owner.binding.slackTeamId);
    assert.equal(asMember.team, undefined, 'Admin hides the Team page from Members');
  }));

async function connectSlack(f: ManagementAdapterFixture, teamId: string): Promise<void> {
  const credentials = { state: f.identity, keyring: generateCredentialKeyring() };
  const identityId = slackInstallationCredentialId(undefined);
  const staged = await stageSlackCredentialBundle(credentials, {
    identityId,
    identityClass: 'workspace_installation',
    purpose: 'connected_credentials',
    expectedActiveRevision: null,
    appId: 'A_SNAPSHOT',
    teamId,
    secrets: { signingSecret: 'snapshot-secret', botToken: 'xoxb-snapshot' },
  });
  await promoteSlackCredentialBundle(credentials, {
    identityId,
    candidateRevision: staged.revision,
    expectedActiveRevision: null,
  });
}

async function withSlackSettings(
  suffix: string,
  run: (f: ManagementAdapterFixture, settings: SqliteSettingsStore) => Promise<void>,
): Promise<void> {
  const settings = new SqliteSettingsStore(':memory:', () => 1_800_000_000_000);
  try {
    await withFixture(suffix, (f) => run(f, settings), { settings });
  } finally {
    settings.close();
  }
}

test('inspection names the Slack workspace by its stored name, for every caller', () =>
  withSlackSettings('snapshot-team-name', async (f, settings) => {
    await connectSlack(f, f.owner.binding.slackTeamId);
    await settings.setSetting(SLACK_SETTING_KEYS.teamName, 'Acme Robotics');
    const member = (await f.identity.provisionSlackMember({
      slackTeamId: f.owner.binding.slackTeamId,
      slackUserId: 'U_TEAM_NAME_MEMBER',
      displayName: 'Mina Member',
    })).resolution!;

    const owner = await inspect(f, mcp(f.owner));
    assert.equal(owner.slackTeamId, f.owner.binding.slackTeamId);
    assert.equal(owner.slackTeamName, 'Acme Robotics');

    const asMember = await inspect(f, mcp(member));
    assert.equal(asMember.slackTeamName, 'Acme Robotics');
    assert.equal(asMember.team, undefined, 'the name does not bring the team list with it');
  }));

test('inspection omits the workspace name an install has not stored yet', () =>
  withSlackSettings('snapshot-team-unnamed', async (f) => {
    await connectSlack(f, f.owner.binding.slackTeamId);

    const snapshot = await inspect(f, mcp(f.owner));
    assert.equal(snapshot.slackTeamId, f.owner.binding.slackTeamId);
    assert.equal('slackTeamName' in snapshot, false);
  }));

test('inspection omits a stored workspace name that belongs to another Slack team', () =>
  withSlackSettings('snapshot-team-other', async (f, settings) => {
    await connectSlack(f, 'T_SOMEONE_ELSE');
    await settings.setSetting(SLACK_SETTING_KEYS.teamName, 'Someone Else Inc');

    const snapshot = await inspect(f, mcp(f.owner));
    assert.equal(snapshot.slackTeamId, f.owner.binding.slackTeamId);
    assert.equal('slackTeamName' in snapshot, false, 'another team\'s name never names this workspace');
  }));

test('inspection names a gateway-connected workspace, which keeps no Slack credential, as Admin does', () =>
  withSlackSettings('snapshot-team-gateway', async (f, settings) => {
    await settings.setSetting(SLACK_SETTING_KEYS.teamName, 'Acme Robotics');

    const snapshot = await inspect(f, mcp(f.owner));
    assert.equal(snapshot.slackTeamId, f.owner.binding.slackTeamId);
    assert.equal(snapshot.slackTeamName, 'Acme Robotics');
  }));

test('inspection shows which Agents answer in group DMs and which have their own Slack app', () =>
  withFixture('snapshot-reach', async (f) => {
    const everyone = await createAgent(f, 'agent_everyone');
    await grant(f, everyone.id, 'C_PUBLIC');
    const roomOnly = await createAgent(f, 'agent_room_only');
    await grant(f, roomOnly.id, 'G_PRIVATE');
    await createAgent(f, 'agent_creator_only');
    const off = await createAgent(f, 'agent_off');
    await grant(f, off.id, 'C_PUBLIC');
    await f.config.updateAgent(off.id, { enabled: false }, off.revision);
    const unverified = await createAgent(f, 'agent_unverified');
    await grant(f, unverified.id, 'C_UNKNOWN');
    const created = await createAgent(f, 'agent_desk');
    await f.config.updateAgent(created.id, {
      slackPresence: {
        kind: 'agent_app', requestedHandle: 'desk', normalizedHandle: 'desk', desiredState: 'active', health: 'healthy',
        avatar: { kind: 'generated', revision: 1 },
        app: {
          state: 'active', at: 1, app: { appId: 'A_DESK', clientId: '1.2' }, icon: 'agent_avatar',
          botUserId: 'U_DESK', installedAt: 1, installedBy: f.owner.binding.slackUserId,
        },
      },
    }, created.revision);

    const snapshot = await inspect(f, mcp(f.owner));
    const byId = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
    assert.deepEqual(Object.fromEntries([...byId].map(([id, agent]) => [id, agent.groupDms])), {
      agent_everyone: 'eligible',
      agent_room_only: 'not_eligible',
      agent_creator_only: 'not_eligible',
      agent_off: 'not_eligible',
      agent_unverified: 'unknown',
      agent_desk: 'not_eligible',
    });
    assert.deepEqual(byId.get('agent_desk')?.ownSlackApp, { handle: 'desk' });
    assert.equal(byId.get('agent_everyone')?.ownSlackApp, undefined);
  }, {
    slackFacts: slackFacts({
      C_PUBLIC: { name: 'general', private: false, member: true, archived: false },
      G_PRIVATE: { name: 'room', private: true, member: true, archived: false },
    }),
  }));

/** Better Auth rows for the people the fixture signed in, as consent and token exchange leave them. */
function seedMcpClients(f: ManagementAdapterFixture, backend: NodeBetterAuthBackend): void {
  const db = backend.database;
  const user = (id: string, email: string) => db.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
  ).run(id, email, email, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
  const client = (clientId: string, name: string) => db.prepare(
    'INSERT INTO oauthClient (id, clientId, name, redirectUris, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(`row_${clientId}`, clientId, name, '["http://127.0.0.1:1/cb"]', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
  const consent = (clientId: string, userId: string, at: string) => db.prepare(
    'INSERT INTO oauthConsent (id, clientId, userId, scopes, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(`consent_${clientId}_${userId}`, clientId, userId, '["chickpea:workspace"]', at, at);
  const refresh = (clientId: string, userId: string, at: string) => db.prepare(
    'INSERT INTO oauthRefreshToken (id, token, clientId, userId, expiresAt, createdAt, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(`refresh_${clientId}_${userId}_${at}`, `token_${clientId}_${userId}_${at}`, clientId, userId,
    '2026-11-30T00:00:00.000Z', at, '["chickpea:workspace","offline_access"]');
  const ownerId = f.owner.binding.betterAuthUserId!;
  const adminId = f.admin.binding.betterAuthUserId!;
  user(ownerId, 'owner@example.test');
  user(adminId, 'admin@example.test');
  client('client_current', 'Chickpea CLI');
  client('client_code', 'Claude Code');
  client('client_admin', 'Codex');
  consent('client_current', ownerId, '2026-10-20T09:00:00.000Z');
  refresh('client_current', ownerId, '2026-10-20T09:00:00.000Z');
  refresh('client_current', ownerId, '2026-10-25T17:30:00.000Z');
  consent('client_code', ownerId, '2026-10-02T08:00:00.000Z');
  refresh('client_code', ownerId, '2026-10-03T08:00:00.000Z');
  consent('client_admin', adminId, '2026-10-21T10:00:00.000Z');
  refresh('client_admin', adminId, '2026-10-21T10:00:00.000Z');
}

interface McpClientList {
  clients: Array<{ clientId: string; name: string | null; connectedAt: string; lastUsedAt: string | null; current: boolean }>;
}

test('a person lists and revokes only their own connected MCP clients, over MCP only', async () => {
  const backend = new NodeBetterAuthBackend(':memory:');
  try {
    await withFixture('mcp-clients', async (f) => {
      seedMcpClients(f, backend);
      const listed = await succeed<McpClientList>(listClients(f, mcp(f.owner)));
      assert.deepEqual(listed.clients, [{
        clientId: 'client_current',
        name: 'Chickpea CLI',
        connectedAt: '2026-10-20T09:00:00.000Z',
        lastUsedAt: '2026-10-25T17:30:00.000Z',
        current: true,
      }, {
        clientId: 'client_code',
        name: 'Claude Code',
        connectedAt: '2026-10-02T08:00:00.000Z',
        lastUsedAt: '2026-10-03T08:00:00.000Z',
        current: false,
      }]);
      assert.doesNotMatch(JSON.stringify(listed), /token_|refresh_/, 'no token value leaves Better Auth');

      const theirs = await revokeClient(f, mcp(f.owner), 'client_admin');
      const missing = await revokeClient(f, mcp(f.owner), 'client_missing');
      assert.ok(!theirs.ok && !missing.ok);
      assert.deepEqual(theirs.error, missing.error, 'another person\'s client reads as one that does not exist');
      assert.equal(theirs.error.code, 'mcp_client_not_found');
      const adminClients = await succeed<McpClientList>(listClients(f, mcp(f.admin, 'client_admin')));
      assert.deepEqual(adminClients.clients.map(({ clientId, current }) => [clientId, current]), [['client_admin', true]],
        'the other person\'s client is untouched');

      const other = await succeed<{ clientId: string; current: boolean; message: string }>(
        revokeClient(f, mcp(f.owner), 'client_code'));
      assert.equal(other.current, false);
      assert.match(other.message, /Claude Code/);
      assert.doesNotMatch(other.message, /sign in again/);
      assert.deepEqual((await succeed<McpClientList>(listClients(f, mcp(f.owner)))).clients
        .map(({ clientId }) => clientId), ['client_current']);
      const remaining = backend.database.prepare(
        'SELECT count(*) AS n FROM oauthRefreshToken WHERE clientId = ?',
      ).get('client_code') as { n: number };
      assert.equal(Number(remaining.n), 0, 'its refresh tokens are gone');

      const current = await succeed<{ current: boolean; message: string }>(
        revokeClient(f, mcp(f.owner), 'client_current'));
      assert.equal(current.current, true);
      assert.match(current.message, /sign in to Chickpea again/);
      assert.deepEqual((await succeed<McpClientList>(listClients(f, mcp(f.owner)))).clients, []);

      const fromSlack = await listClients(f, ownerSlackDmContext(f));
      assert.ok(!fromSlack.ok, 'Slack has no MCP clients to manage');
      assert.deepEqual(fromSlack.error, {
        code: 'forbidden',
        message: 'Connected MCP clients are listed and revoked over the Chickpea MCP or in Admin.',
      });
    }, { mcpOAuthClients: async () => backend });
  } finally {
    backend.close();
  }
});

test('revoking a client deletes its grants again, so a refresh that raced the first delete leaves no token', async () => {
  const backend = new NodeBetterAuthBackend(':memory:');
  try {
    let deletes = 0;
    await withFixture('mcp-revoke-race', async (f) => {
      seedMcpClients(f, backend);
      await succeed(revokeClient(f, mcp(f.owner), 'client_code'));
      assert.equal(deletes, 2);
      const remaining = backend.database.prepare(
        'SELECT count(*) AS n FROM oauthRefreshToken WHERE clientId = ?',
      ).get('client_code') as { n: number };
      assert.equal(Number(remaining.n), 0, 'the token the racing refresh stored is gone too');
    }, {
      mcpOAuthClients: async () => ({
        listOAuthClientsForUser: (userId) => backend.listOAuthClientsForUser(userId),
        async revokeOAuthClientForUser(userId, clientId) {
          const revoked = await backend.revokeOAuthClientForUser(userId, clientId);
          deletes += 1;
          if (deletes === 1) {
            // A refresh that validated the old token before the delete stores its replacement after it.
            backend.database.prepare(
              'INSERT INTO oauthRefreshToken (id, token, clientId, userId, expiresAt, createdAt, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ).run('refresh_rotated', 'token_rotated', clientId, userId,
              '2026-11-30T00:00:00.000Z', '2026-10-26T00:00:00.000Z', '["chickpea:workspace","offline_access"]');
          }
          return revoked;
        },
      }),
    });
  } finally {
    backend.close();
  }
});
