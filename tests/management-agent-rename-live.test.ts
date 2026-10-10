import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { inspect } from 'node:util';

import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import { AGENT_AUTHORING_GUIDE_VERSION } from '../src/management/agent-authoring/index.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { createLiveWorkspaceManagementService } from '../src/management/live-service.ts';
import {
  invokeSlackWorkspaceManagementTool,
  type SlackManagementSignal,
} from '../src/management/slack-tools.ts';
import type { ManagementAgentPatch, ManagementApplyResult } from '../src/management/types.ts';
import { syncHostedWorkspaceInstallation } from '../src/slack/hosted-installation.ts';
import {
  invalidateSlackInstallationCredentialCache,
  writeHostedSlackBotCredentials,
} from '../src/slack/installation-credentials.ts';
import { REQUESTED_SLACK_BOT_SCOPES } from '../src/slack/scopes.ts';
import { useDeploymentKeyring } from './helpers/deployment-keyring.ts';
import { withEnv } from './helpers/env.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const HOSTED = { CHICKPEA_TENANCY: 'installation' } as Record<string, unknown>;
// Slack publishes no user-group name limit; this fake picks one to exercise `name_too_long`.
const FAKE_GROUP_NAME_LIMIT = 40;

function fakeSlackWorkspace(t: TestContext) {
  const groups = [
    { id: 'S0SUPPORT', name: 'Customer Support', handle: 'support', description: '', date_update: 1, date_delete: 0 },
    { id: 'S0DESK', name: 'Desk', handle: 'desk', description: 'Desk Agent', date_update: 1, date_delete: 0 },
  ];
  const slack = {
    groups,
    /** Runs once inside the next usergroups.update, as an edit landing during the Slack call. */
    duringUpdate: undefined as (() => Promise<void>) | undefined,
  };
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const method = new URL(request.url).pathname.split('/').at(-1);
    if (method === 'usergroups.list') return Response.json({ ok: true, usergroups: groups });
    if (method !== 'usergroups.update') throw new Error(`Unexpected Slack call: ${method}`);
    const during = slack.duringUpdate;
    slack.duringUpdate = undefined;
    await during?.();
    const form = new URLSearchParams(await request.text());
    const group = groups.find(({ id }) => id === form.get('usergroup'));
    if (!group) return Response.json({ ok: false, error: 'no_such_subteam' });
    const name = form.get('name') ?? group.name;
    const handle = form.get('handle') ?? group.handle;
    if (name.length > FAKE_GROUP_NAME_LIMIT) return Response.json({ ok: false, error: 'name_too_long' });
    if (groups.some((other) => other.id !== group.id && other.handle === handle)) {
      return Response.json({ ok: false, error: 'handle_already_exists' });
    }
    Object.assign(group, { name, handle, description: form.get('description') ?? group.description, date_update: 2 });
    return Response.json({ ok: true, usergroup: group });
  });
  return slack;
}

async function renameFixture(t: TestContext) {
  const slack = fakeSlackWorkspace(t);
  const env = scopeInstallationEnv(HOSTED, { installationId: 'inst_lt5_rename' });
  const keyring = useDeploymentKeyring(t);
  const f = await createManagementAdapterFixture('lt5-rename-live');
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => {
    f.close();
    settings.close();
    invalidateSlackInstallationCredentialCache();
  });
  const teamId = f.owner.user.slackTeamId;
  const credentials = { state: f.identity, keyring };
  await writeHostedSlackBotCredentials(credentials, null, {
    botToken: 'xoxb-lt5-bot', userGroupToken: 'xoxp-lt5-owner', botUserId: 'UBOT', appId: 'AHOSTED1', teamId,
    grantedScopes: [...REQUESTED_SLACK_BOT_SCOPES], validatedAt: Date.now(),
  });
  await syncHostedWorkspaceInstallation(env, { teamId, appId: 'AHOSTED1', botUserId: 'UBOT' }, f.config);
  const service = createLiveWorkspaceManagementService(env, {
    identity: f.identity, settings, slackCredentials: credentials,
    overrides: {
      config: f.config, management: f.management, memory: f.memory, routines: f.routines,
      setupBaseUrl: 'http://localhost', now: () => 1_800_000_000_000,
    },
  });
  const created = await f.config.createAgent({
    id: 'agent_desk', name: 'Desk', description: 'Desk Agent',
    creatorMembershipId: f.admin.membership.id, editPolicy: 'creator_and_admins',
    lifecycle: 'active', configurationGeneration: 1, instructions: 'Answer the front desk.', enabled: true,
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  });
  await f.config.updateAgent(created.id, {
    slackPresence: {
      ...created.slackPresence!,
      kind: 'user_group', requestedHandle: 'desk', normalizedHandle: 'desk',
      desiredState: 'active', health: 'healthy', userGroupId: 'S0DESK',
    },
  }, created.revision);
  let sequence = 0;
  const signalFor = (requesterText: string): SlackManagementSignal => {
    sequence += 1;
    return {
      agentId: CHICKPEA_AGENT_ID,
      workspaceId: teamId,
      channelId: 'D0REQUESTER',
      threadTs: '1800000000.000100',
      conversationKind: 'im',
      slackUserId: f.admin.binding.slackUserId,
      eventId: `Ev0RENAME${sequence}`,
      messageTs: `1800000000.00010${sequence}`,
      turnJobId: `turn_lt5_rename_${sequence}`,
      requesterText,
    };
  };
  const tool = <TName extends 'apply_workspace_changes' | 'propose_workspace_changes' | 'confirm_workspace_change'>(
    requesterText: string,
    name: TName,
    args: Parameters<typeof invokeSlackWorkspaceManagementTool<TName>>[0]['args'],
  ) => invokeSlackWorkspaceManagementTool({ signal: signalFor(requesterText), identity: f.identity, service, name, args });
  const renameArgs = async (patch: ManagementAgentPatch) => ({
    idempotencyKey: `rename-${sequence}`,
    operations: [{
      itemId: 'rename', kind: 'update_agent' as const, agentId: 'agent_desk',
      expectedRevision: (await f.config.getAgent('agent_desk')).revision, patch,
    }],
  });
  const update = async (requesterText: string, patch: ManagementAgentPatch) => {
    const applied = await tool(requesterText, 'apply_workspace_changes', await renameArgs(patch));
    if (!applied.ok) assert.fail(inspect(applied, { depth: 8 }));
    const [outcome] = (applied.result as ManagementApplyResult).outcomes;
    assert.ok(outcome);
    return outcome;
  };
  const desk = async () => {
    const agent = await f.config.getAgent('agent_desk');
    return {
      name: agent.name,
      instructions: agent.instructions,
      enabled: agent.enabled,
      lifecycle: agent.lifecycle,
      handle: agent.slackPresence?.normalizedHandle,
      requestedHandle: agent.slackPresence?.requestedHandle,
      health: agent.slackPresence?.health,
    };
  };
  return { f, slack, tool, renameArgs, update, desk };
}

const DESK = {
  name: 'Desk', instructions: 'Answer the front desk.', enabled: true,
  lifecycle: 'active', handle: 'desk', requestedHandle: 'desk', health: 'healthy',
};

test('renaming an Agent onto a taken Slack handle fails to the model and keeps the handle it had', async (t) => {
  await withEnv({ CHICKPEA_TENANCY: undefined, SLACK_STATE_DB_PATH: ':memory:' }, async () => {
    const { slack, update, desk } = await renameFixture(t);

    const outcome = await update('change Desk to @support', { requestedHandle: 'support' });
    assert.deepEqual(
      { disposition: outcome.disposition, code: outcome.code, warning: outcome.warning },
      { disposition: 'failed', code: 'handle_collision', warning: undefined },
    );
    assert.equal(
      outcome.instruction,
      '@support is already taken in this Slack workspace, so nothing changed and the Agent keeps @desk. Free handles: @support-team, @support-2, @support-3. Offer these, or ask for another handle.',
    );
    assert.deepEqual(await desk(), DESK);
    assert.equal(slack.groups.find(({ id }) => id === 'S0DESK')?.handle, 'desk');

    const renamed = await update('change Desk to @frontdesk', { requestedHandle: 'frontdesk' });
    assert.equal(renamed.disposition, 'applied');
    assert.deepEqual(await desk(), { ...DESK, handle: 'frontdesk', requestedHandle: 'frontdesk' });
    assert.equal(slack.groups.find(({ id }) => id === 'S0DESK')?.handle, 'frontdesk');
  });
});

test('a name Slack finds too long for its user group fails to the model with the reason and keeps the name', async (t) => {
  await withEnv({ CHICKPEA_TENANCY: undefined, SLACK_STATE_DB_PATH: ':memory:' }, async () => {
    const { slack, update, desk } = await renameFixture(t);
    const longName = 'Front Desk for every visitor question and booking';
    assert.ok(longName.length > FAKE_GROUP_NAME_LIMIT);

    const outcome = await update(`rename Desk to ${longName}`, { name: longName });
    assert.deepEqual(
      { disposition: outcome.disposition, code: outcome.code, warning: outcome.warning },
      { disposition: 'failed', code: 'slack_operation_failed', warning: undefined },
    );
    assert.equal(
      outcome.instruction,
      'Slack refused this name because it is too long for a Slack user group, so nothing changed and the Agent keeps its name. Ask for a shorter name.',
    );
    assert.deepEqual(await desk(), DESK);
    assert.equal(slack.groups.find(({ id }) => id === 'S0DESK')?.name, 'Desk');
  });
});

test('an approved rename onto a taken handle fails to the model and changes neither name nor handle', async (t) => {
  await withEnv({ CHICKPEA_TENANCY: undefined, SLACK_STATE_DB_PATH: ':memory:' }, async () => {
    const { slack, tool, renameArgs, update, desk } = await renameFixture(t);
    const rename = { name: 'Support', requestedHandle: 'support' };
    const kept = /^@support is already taken in this Slack workspace, so nothing changed and the Agent keeps @desk\./;
    const deskGroup = { id: 'S0DESK', name: 'Desk', handle: 'desk', description: 'Desk Agent', date_update: 1, date_delete: 0 };

    const pending = await update('rename Desk to Support with @support', rename);
    assert.equal(pending.disposition, 'confirmation_required');
    const confirmed = await tool('approve', 'confirm_workspace_change', { proposalId: pending.proposalId! });
    assert.equal(confirmed.ok, false);
    const { error } = confirmed as { ok: false; error: { code: string; message: string } };
    assert.equal(error.code, 'handle_collision');
    assert.match(error.message, kept);
    assert.deepEqual(await desk(), DESK);
    assert.deepEqual(slack.groups.find(({ id }) => id === 'S0DESK'), deskGroup);

    const proposed = await tool('rename Desk to Support with @support', 'propose_workspace_changes', {
      ...await renameArgs(rename), guideVersion: AGENT_AUTHORING_GUIDE_VERSION, authoringReason: 'agent_edit',
    });
    if (!proposed.ok) assert.fail(inspect(proposed, { depth: 8 }));
    const approved = await tool('approve', 'confirm_workspace_change', {
      proposalId: (proposed.result as { proposalId: string }).proposalId,
    });
    if (!approved.ok) assert.fail(inspect(approved, { depth: 8 }));
    const [outcome] = (approved.result as ManagementApplyResult).outcomes;
    assert.deepEqual(
      { disposition: outcome?.disposition, code: outcome?.code, warning: outcome?.warning },
      { disposition: 'failed', code: 'handle_collision', warning: undefined },
    );
    assert.match(outcome?.instruction ?? '', kept);
    assert.deepEqual(await desk(), DESK);
    assert.deepEqual(slack.groups.find(({ id }) => id === 'S0DESK'), deskGroup);
  });
});

test('an edit that lands during a refused rename\'s Slack call survives the put-back', async (t) => {
  await withEnv({ CHICKPEA_TENANCY: undefined, SLACK_STATE_DB_PATH: ':memory:' }, async () => {
    const { f, slack, update, desk } = await renameFixture(t);
    slack.duringUpdate = async () => {
      const current = await f.config.getAgent('agent_desk');
      await f.config.updateAgent('agent_desk', {
        instructions: 'Answer the front desk and the phones.', enabled: false,
      }, current.revision);
    };

    const outcome = await update('change Desk to @support', { requestedHandle: 'support' });
    assert.deepEqual({ disposition: outcome.disposition, code: outcome.code }, { disposition: 'failed', code: 'handle_collision' });
    assert.deepEqual(await desk(), { ...DESK, instructions: 'Answer the front desk and the phones.', enabled: false });
  });
});

test('a rename that lands during a refused rename\'s Slack call is not undone', async (t) => {
  await withEnv({ CHICKPEA_TENANCY: undefined, SLACK_STATE_DB_PATH: ':memory:' }, async () => {
    const { f, slack, update, desk } = await renameFixture(t);
    slack.duringUpdate = async () => {
      const current = await f.config.getAgent('agent_desk');
      await f.config.updateAgent('agent_desk', {
        name: 'Front Desk',
        slackPresence: { ...current.slackPresence!, requestedHandle: 'frontdesk', normalizedHandle: 'frontdesk' },
      }, current.revision);
    };

    const outcome = await update('change Desk to @support', { requestedHandle: 'support' });
    assert.deepEqual({ disposition: outcome.disposition, code: outcome.code }, { disposition: 'failed', code: 'handle_collision' });
    const after = await desk();
    assert.deepEqual(
      { name: after.name, handle: after.handle, requestedHandle: after.requestedHandle },
      { name: 'Front Desk', handle: 'frontdesk', requestedHandle: 'frontdesk' },
    );
    assert.match(outcome.instruction ?? '', /^@support is already taken in this Slack workspace, so nothing changed and the Agent keeps @frontdesk\./);
  });
});

test('a name that lands during a refused name change is kept', async (t) => {
  await withEnv({ CHICKPEA_TENANCY: undefined, SLACK_STATE_DB_PATH: ':memory:' }, async () => {
    const { f, slack, update, desk } = await renameFixture(t);
    slack.duringUpdate = async () => {
      const current = await f.config.getAgent('agent_desk');
      await f.config.updateAgent('agent_desk', { name: 'Front Desk' }, current.revision);
    };

    const outcome = await update('rename Desk to a very long name', { name: 'Front Desk for every visitor question and booking' });
    assert.equal(outcome.disposition, 'failed');
    assert.deepEqual(await desk(), { ...DESK, name: 'Front Desk' });
  });
});

test('a rename that lands between the put-back\'s read and write is not undone either', async (t) => {
  await withEnv({ CHICKPEA_TENANCY: undefined, SLACK_STATE_DB_PATH: ':memory:' }, async () => {
    const { f, slack, update, desk } = await renameFixture(t);
    const updateAgent = f.config.updateAgent.bind(f.config);
    let raceArmed = false;
    slack.duringUpdate = async () => { raceArmed = true; };
    f.config.updateAgent = async (agentId, patch, expectedRevision) => {
      if (raceArmed && patch.lifecycle === 'active') {
        raceArmed = false;
        const current = await f.config.getAgent(agentId);
        await updateAgent(agentId, {
          slackPresence: { ...current.slackPresence!, requestedHandle: 'frontdesk', normalizedHandle: 'frontdesk' },
        }, current.revision);
      }
      return updateAgent(agentId, patch, expectedRevision);
    };

    const outcome = await update('change Desk to @support', { requestedHandle: 'support' });
    assert.equal(raceArmed, false, 'the put-back was attempted');
    assert.equal(outcome.code, 'handle_collision');
    const after = await desk();
    assert.deepEqual({ handle: after.handle, requestedHandle: after.requestedHandle }, { handle: 'frontdesk', requestedHandle: 'frontdesk' });
  });
});
