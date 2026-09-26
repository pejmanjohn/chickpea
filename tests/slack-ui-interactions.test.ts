import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBrowserAction, getBrowserAction } from '../src/browser/actions.ts';
import { processGatewaySlackEnvelope, processGatewayUiAction } from '../src/channels/slack.ts';
import { closeNodeStateStores, resolveStores, type AppStores } from '../src/config/state-backend.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import type { GatewayUiActionDelivery } from '../src/slack/gateway/protocol.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { checkSlackBlocks } from '../src/slack/ui/block-kit-limits.ts';
import {
  uiActionId,
  uiBlockId,
  uiSurfaceId,
  uiValue,
  type UiSurfaceRecord,
} from '../src/slack/ui/surface.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const THREAD_TS = '3000.000100';
const CARD_TS = '3000.000300';

function member(id: string, patch: Record<string, unknown> = {}) {
  return {
    id, team_id: 'T1', name: id, deleted: false, is_bot: false, is_app_user: false,
    is_restricted: false, is_ultra_restricted: false, is_stranger: false, ...patch,
  };
}

interface Fixture {
  stores: AppStores;
  jobs: TurnJob[];
  calls: Array<{ operation: string; input: Record<string, unknown> }>;
  ownerMembershipId: string;
  surface(patch?: Partial<UiSurfaceRecord>): Promise<UiSurfaceRecord>;
  click(surfaceId: string, patch?: Partial<GatewayUiActionDelivery>): Promise<'accepted' | 'rejected'>;
  read(id: string): Promise<UiSurfaceRecord | undefined>;
  ephemerals(): string[];
  updates(): Array<Record<string, unknown>>;
  heldAction(scope?: { channelId: string; threadTs: string; agentId: string }): Promise<string>;
  message(envelope: Parameters<typeof processGatewaySlackEnvelope>[0]): Promise<void>;
}

async function withFixture(body: (f: Fixture) => Promise<void>): Promise<void> {
  const envKeys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previousEnv = envKeys.map((key) => process.env[key]);
  for (const key of envKeys) process.env[key] = ':memory:';
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  closeNodeStateStores();
  const stores = resolveStores();
  try {
    const owner = await createSlackOwner(stores.identity, { teamId: 'T1', userId: 'U1' });
    await stores.config.createAgent({
      id: 'agent_support', name: 'support', instructions: '', enabled: true, lifecycle: 'active',
      model: 'local-stub/ui-click',
      creatorMembershipId: owner.membership.id, editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
      slackPresence: {
        requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active',
        health: 'healthy', userGroupId: 'SSUPPORT',
        avatar: { kind: 'generated', revision: 1, seed: 'support' },
      },
    });
    await stores.config.ensureWorkspaceInstallation({
      workspaceId: 'T1', transportMode: 'gateway', appId: 'A1', botUserId: 'UBOT',
      gatewayBindingId: 'binding1',
    });
    await stores.config.putChannel({ workspaceId: 'T1', channelId: 'C1', label: 'ops', lifecycle: 'active' }, 0);
    await stores.config.putAgentChannelGrant({
      workspaceId: 'T1', channelId: 'C1', agentId: 'agent_support', status: 'active',
      createdByMembershipId: owner.membership.id, channelLabel: 'ops', channelIsPrivate: false,
    }, 0);
    const channel = { id: 'C1', name: 'ops', is_channel: true, is_private: false, is_member: true, is_archived: false };
    const calls: Fixture['calls'] = [];
    const gateway = {
      workspaceId: 'T1',
      async loadBinding() { return { workspaceId: 'T1', appId: 'A1', botUserId: 'UBOT', bindingId: 'binding1' }; },
      async call(operation: string, input: Record<string, unknown>) {
        calls.push({ operation, input });
        if (operation === 'users.info') {
          const id = String(input.user);
          return { user: member(id, id === 'UGUEST' ? { is_restricted: true } : {}) };
        }
        if (operation === 'conversations.info') return { channel };
        if (operation === 'conversations.members') return { members: ['U1', 'U2', 'UGUEST', 'UBOT'] };
        if (operation === 'users.conversations') return { channels: [channel] };
        if (operation.startsWith('chat.')) return { ok: true, ts: '3000.000900', channel: 'C1' };
        throw new Error(`Unexpected gateway operation: ${operation}`);
      },
    } as unknown as GatewayDeploymentClient;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Cloudflare-Workers' } });
    const jobs: TurnJob[] = [];
    const execution = {
      stores,
      enqueueTurn: async (job: TurnJob) => { jobs.push(job); return { ok: true as const, value: null }; },
    };
    // The mention that opens the Agent's thread.
    assert.equal(await processGatewaySlackEnvelope({
      workspaceId: 'T1', eventId: 'Ev3000', eventTime: 3000,
      event: {
        type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', ts: THREAD_TS,
        text: '<!subteam^SSUPPORT|@support> Update my billing plan.',
      },
    }, undefined, gateway, execution), 'accepted');
    assert.equal(jobs.length, 1);
    const turnJobId = jobs[0]!.id;
    let actions = 0;

    const execute = stores.slackState.executeUiSurface!;
    const fixture: Fixture = {
      stores,
      jobs,
      calls,
      ownerMembershipId: owner.membership.id,
      async message(envelope) {
        assert.equal(await processGatewaySlackEnvelope(envelope, undefined, gateway, execution), 'accepted');
      },
      async heldAction(scope = { channelId: 'C1', threadTs: THREAD_TS, agentId: 'agent_support' }) {
        const held = await createBrowserAction(stores.settings, {
          workspaceId: 'T1', ...scope,
          actorSlackUserId: 'U1', actorMembershipId: owner.membership.id,
          loginId: `wl_${'a'.repeat(32)}`, host: 'billing.example.com', url: 'https://billing.example.com/plan',
          title: 'Plan', ref: 'e3', role: 'button', name: 'Confirm change', occurrence: 0, action: 'click',
          description: 'click "Confirm change"',
        });
        return held.id;
      },
      async surface(patch = {}) {
        const now = Date.now();
        const browserActionId = patch.spec?.kind === 'approval' && patch.spec.approval === 'browser_step'
          ? patch.spec.browserActionId
          : await fixture.heldAction();
        const record: UiSurfaceRecord = {
          id: uiSurfaceId(turnJobId, `host-approval:${actions += 1}`),
          namespace: 'host',
          workspaceId: 'T1', channelId: 'C1', threadTs: THREAD_TS, conversationThreadTs: THREAD_TS,
          conversationKind: 'channel', agentId: 'agent_support', turnJobId, requesterUserId: 'U1',
          spec: { kind: 'approval', approval: 'browser_step', browserActionId, description: 'click "Confirm change"', host: 'billing.example.com' },
          status: 'open', messageTs: CARD_TS,
          createdAt: now, updatedAt: now, expiresAt: now + 60_000,
          ...patch,
        };
        const stored = await execute({ kind: 'put_surface', record });
        assert.equal(stored.kind, 'surface');
        return (stored as { surface: UiSurfaceRecord }).surface;
      },
      async click(surfaceId, patch = {}) {
        return processGatewayUiAction({
          protocolVersion: 1, kind: 'interaction.ui_action', deliveryId: `ui:${surfaceId}:${patch.actionTs ?? ''}`,
          bindingId: 'binding1', workspaceId: 'T1', userId: 'U1', containerType: 'message',
          channelId: 'C1', messageTs: CARD_TS, threadTs: THREAD_TS, isEphemeral: false, viewId: null,
          actionId: uiActionId('host', 'approval', 0), blockId: uiBlockId('host', surfaceId, 1),
          actionType: 'button', value: uiValue(surfaceId, 0), selected: [], state: {},
          actionTs: '3001.123456', triggerId: 'trigger1',
          ...patch,
        }, undefined, gateway, execution);
      },
      async read(id) {
        const response = await execute({ kind: 'get_surface', id });
        return response.kind === 'surface' ? response.surface ?? undefined : undefined;
      },
      ephemerals: () => calls.filter(({ operation }) => operation === 'chat.postEphemeral')
        .map(({ input }) => String(input.text)),
      updates: () => calls.filter(({ operation }) => operation === 'chat.update').map(({ input }) => input),
    };
    await body(fixture);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    closeNodeStateStores();
    envKeys.forEach((key, index) => {
      if (previousEnv[index] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[index];
    });
  }
}

function hasActions(update: Record<string, unknown>): boolean {
  return (update.blocks as Array<{ type: string }>).some((block) => block.type === 'actions');
}

test('Approve step click passes admission, stamps the held step, and redraws from stored state', async () => withFixture(async (f) => {
  const surface = await f.surface();
  const actionId = (surface.spec as { browserActionId: string }).browserActionId;
  assert.equal(await f.click(surface.id), 'accepted');

  assert.equal(f.jobs.length, 2);
  const turn = f.jobs[1]!.turn;
  assert.equal(turn.userId, 'U1');
  assert.equal(turn.approvedBrowserActionId, actionId);
  assert.deepEqual(turn.uiResponse, { surfaceId: surface.id, namespace: 'host', kind: 'approval', choice: 0 });
  assert.equal(turn.threadTs, THREAD_TS);
  assert.equal(turn.messageTs, '3001.123456');
  assert.match(turn.text, /^Approved the browser step with the Approve step button/);
  assert.equal(turn.managementApprovalProposalId, undefined);

  const stored = await f.read(surface.id);
  assert.equal(stored?.status, 'resolved');
  assert.equal(stored?.resolution?.byUserId, 'U1');
  assert.equal(stored?.resolution?.choice, 0);
  assert.equal((await getBrowserAction(f.stores.settings, actionId))?.status, 'approved');

  const update = f.updates().at(-1)!;
  assert.equal(update.ts, CARD_TS);
  assert.equal(hasActions(update), false);
  assert.match(JSON.stringify(update.blocks), /Approved by <@U1>/);
  assert.deepEqual(f.ephemerals(), []);
}));

test('Stop click spends the held step without stamping an approval', async () => withFixture(async (f) => {
  const surface = await f.surface();
  const actionId = (surface.spec as { browserActionId: string }).browserActionId;
  assert.equal(await f.click(surface.id, {
    actionId: uiActionId('host', 'approval', 1), value: uiValue(surface.id, 1),
  }), 'accepted');
  const turn = f.jobs[1]!.turn;
  assert.equal(turn.approvedBrowserActionId, undefined);
  assert.equal(turn.uiResponse?.choice, 1);
  assert.match(turn.text, /Stopped the browser step/);
  assert.equal((await getBrowserAction(f.stores.settings, actionId))?.status, 'consumed');
  assert.match(JSON.stringify(f.updates().at(-1)!.blocks), /Stopped by <@U1>/);
}));

test('a typed "stop" in the thread spends the step and retires its card as a typed answer', async () => withFixture(async (f) => {
  const surface = await f.surface();
  const actionId = (surface.spec as { browserActionId: string }).browserActionId;
  await f.message({
    workspaceId: 'T1', eventId: 'EvStop', eventTime: 3002,
    event: { type: 'message' as const, channel: 'C1', channel_type: 'channel', user: 'U1', ts: '3002.000100', thread_ts: THREAD_TS, text: 'stop' },
  });
  assert.equal(f.jobs.length, 2);
  assert.equal(f.jobs[1]!.turn.approvedBrowserActionId, undefined);
  assert.equal((await getBrowserAction(f.stores.settings, actionId))?.status, 'consumed');
  const stored = await f.read(surface.id);
  assert.equal(stored?.status, 'resolved');
  assert.equal(stored?.resolution?.choice, 1);
  assert.equal(stored?.resolution?.typed, true);
  const update = f.updates().at(-1)!;
  assert.equal(update.ts, CARD_TS);
  assert.equal(hasActions(update), false);
  assert.match(JSON.stringify(update.blocks), /Stopped by <@U1> \(typed reply\)/);
  // A late click on the settled card starts nothing.
  await f.click(surface.id);
  assert.equal(f.jobs.length, 2);
  assert.match(f.ephemerals().at(-1)!, /Already answered by <@U1>/);
}));

test('a double click or a replayed delivery starts one turn and tells the second clicker it was answered', async () => withFixture(async (f) => {
  const surface = await f.surface();
  await f.click(surface.id);
  await f.click(surface.id, { actionTs: '3001.223456' });
  await f.click(surface.id);
  assert.equal(f.jobs.length, 2);
  assert.equal(f.ephemerals().length, 2);
  assert.ok(f.ephemerals().every((text) => /Already answered by <@U1>/.test(text)));
}));

test('someone other than the requester is refused privately and the button stays live', async () => withFixture(async (f) => {
  const surface = await f.surface();
  const actionId = (surface.spec as { browserActionId: string }).browserActionId;
  await f.click(surface.id, { userId: 'U2' });
  await f.click(surface.id, { userId: 'UGUEST', actionTs: '3001.323456' });
  assert.equal(f.jobs.length, 1);
  assert.equal((await f.read(surface.id))?.status, 'open');
  assert.equal((await getBrowserAction(f.stores.settings, actionId))?.status, 'pending');
  const [other, guest] = f.ephemerals();
  assert.match(other!, /Only <@U1> can answer this/);
  assert.match(guest!, /isn't available right now|Only <@U1>/);
  // The requester can still approve afterwards.
  await f.click(surface.id, { actionTs: '3001.423456' });
  assert.equal(f.jobs.length, 2);
}));

test('a ui-namespace click can never resolve a host approval, whatever it is labelled', async () => withFixture(async (f) => {
  const surface = await f.surface();
  await f.click(surface.id, {
    actionId: uiActionId('ui', 'question', 0),
    blockId: uiBlockId('ui', surface.id, 1),
  });
  // A ui record that claims to be an approval cannot stamp one either.
  const forged = await f.surface({ namespace: 'ui' });
  await f.click(forged.id, {
    actionId: uiActionId('ui', 'approval', 0),
    blockId: uiBlockId('ui', forged.id, 1),
    value: uiValue(forged.id, 0),
    actionTs: '3001.523456',
  });
  assert.equal(f.jobs.length, 1);
  assert.equal((await f.read(surface.id))?.status, 'open');
  assert.equal((await f.read(forged.id))?.status, 'open');
  assert.ok(f.jobs.every((job) => !job.turn.approvedBrowserActionId));
}));

test('closed, expired, superseded, ephemeral, and mismatched clicks are refused without a turn', async () => withFixture(async (f) => {
  const expired = await f.surface({ expiresAt: Date.now() - 1 });
  await f.click(expired.id);
  assert.equal((await f.read(expired.id))?.status, 'expired');
  assert.match(f.ephemerals().at(-1)!, /has closed/);

  const superseded = await f.surface({ status: 'superseded' });
  await f.click(superseded.id, { actionTs: '3001.623456' });
  assert.match(f.ephemerals().at(-1)!, /has closed/);

  const open = await f.surface();
  await f.click(open.id, { isEphemeral: true, actionTs: '3001.723456' });
  await f.click(open.id, { messageTs: '3000.000999', actionTs: '3001.823456' });
  await f.click(open.id, { channelId: 'C2', actionTs: '3001.923456' });
  // A value moved from another card never parses.
  await f.click(open.id, { value: uiValue(expired.id, 0), actionTs: '3002.023456' });
  assert.equal(f.jobs.length, 1);
  assert.equal((await f.read(open.id))?.status, 'open');
  // A card whose held step is no longer current closes on click.
  const spent = await f.surface();
  const actionId = (spent.spec as { browserActionId: string }).browserActionId;
  await f.stores.settings.setSetting(`browseraction_${actionId}`, JSON.stringify({
    ...(await getBrowserAction(f.stores.settings, actionId)), status: 'consumed',
  }));
  await f.click(spent.id, { actionTs: '3002.123456' });
  assert.equal(f.jobs.length, 1);
  assert.equal((await f.read(spent.id))?.status, 'expired');
  assert.match(f.ephemerals().at(-1)!, /no longer current/);
}));

test('link buttons and unknown surfaces are acknowledged without side effects beyond a notice', async () => withFixture(async (f) => {
  const surface = await f.surface();
  assert.equal(await f.click(surface.id, { actionId: 'chickpea.ui.v1.link.0', blockId: uiBlockId('ui', surface.id, 2), value: null }), 'accepted');
  assert.equal(f.calls.filter(({ operation }) => operation.startsWith('chat.')).length, 0);
  assert.equal(await f.click('f'.repeat(32), { blockId: uiBlockId('host', 'f'.repeat(32), 1), value: uiValue('f'.repeat(32), 0) }), 'accepted');
  assert.match(f.ephemerals().at(-1)!, /has closed/);
  assert.equal(f.jobs.length, 1);
}));

test('every redraw of an adversarial card is identical and passes the Block Kit checker', async () => withFixture(async (f) => {
  const surface = await f.surface({
    spec: {
      kind: 'approval', approval: 'browser_step', browserActionId: await f.heldAction(),
      description: 'click "<!channel> & <b>Approve</b>" '.repeat(20), host: 'billing.example.com',
    },
  });
  await f.click(surface.id);
  await f.click(surface.id, { actionTs: '3002.223456' });
  const [first, second] = f.updates();
  assert.deepEqual(first, second);
  const check = checkSlackBlocks(first!.blocks as unknown[], { text: String(first!.text) });
  assert.deepEqual(check.issues, []);
  assert.doesNotMatch(JSON.stringify(first!.blocks), /<!channel>/);
}));

test('a click in a DM thread is admitted like a DM reply from the clicker', async () => withFixture(async (f) => {
  const jobsBefore = f.jobs.length;
  // Clicks take canonical admission only, which needs a configured model.
  await f.stores.config.putWorkspaceModelDefault({
    workspaceId: 'T1', modelId: 'local-stub/ui-click', provenance: 'admin_selected',
  });
  // The DM opens a thread with whichever Agent the workspace routes DMs to.
  const envelope = {
    workspaceId: 'T1', eventId: 'EvDm', eventTime: 4000,
    event: { type: 'message' as const, channel: 'D1', channel_type: 'im', user: 'U1', ts: '4000.000100', text: 'Please update my plan.' },
  };
  await f.message(envelope);
  assert.equal(f.jobs.length, jobsBefore + 1);
  const dmJob = f.jobs.at(-1)!;
  const surface = await f.surface({
    channelId: 'D1', threadTs: '4000.000100', conversationThreadTs: '4000.000100', conversationKind: 'im',
    agentId: dmJob.assignment.agent.id, turnJobId: dmJob.id, messageTs: '4000.000300',
    spec: {
      kind: 'approval', approval: 'browser_step',
      browserActionId: await f.heldAction({ channelId: 'D1', threadTs: '4000.000100', agentId: dmJob.assignment.agent.id }),
      description: 'click "Save"', host: 'example.com',
    },
  });
  await f.click(surface.id, { channelId: 'D1', messageTs: '4000.000300', threadTs: '4000.000100', actionTs: '4001.000001' });
  assert.deepEqual(f.ephemerals(), []);
  assert.equal(f.jobs.length, jobsBefore + 2);
  const turn = f.jobs.at(-1)!.turn;
  assert.equal(turn.source, 'dm_message');
  assert.equal(turn.channelId, 'D1');
  assert.equal(turn.threadTs, '4000.000100');
  assert.ok(turn.approvedBrowserActionId);
  assert.equal((await f.read(surface.id))?.status, 'resolved');
}));

test('Cancel on a workspace-change card retires the proposal, so a later typed approve cannot apply it', async () => withFixture(async (f) => {
  const owner = await f.stores.identity.resolveSlackIdentity('T1', 'U1');
  assert.ok(owner);
  const scope = `slack:T1:C1:${THREAD_TS}:agent:agent_support`;
  const stamp = Date.now();
  await f.stores.management.putChangeSetProposal({
    proposalId: 'proposal_cancel', organizationId: owner.membership.organizationId,
    actorUserId: owner.user.id, actorMembershipId: owner.membership.id,
    originKey: scope, approvalScopeKey: scope, idempotencyKey: 'proposal_cancel',
    guideVersion: 'test', authoringReason: 'agent_edit', digest: 'd'.repeat(64),
    operations: [{ itemId: 'update', kind: 'update_agent', agentId: 'agent_support', expectedRevision: 1,
      patch: { description: 'Frozen description' } }],
    preview: { summary: 'Preview', changes: [], missingSetup: [] },
    targetRevisions: { 'agent:agent_support': 1 }, at: stamp,
  });
  const surface = await f.surface({
    spec: { kind: 'approval', approval: 'workspace_change', proposalId: 'proposal_cancel' },
  });
  await f.click(surface.id, { actionId: uiActionId('host', 'approval', 1), value: uiValue(surface.id, 1) });
  assert.equal(f.jobs.length, 2);
  assert.equal(f.jobs.at(-1)!.turn.managementApprovalProposalId, undefined);
  assert.match(JSON.stringify(f.updates().at(-1)!.blocks), /Cancelled by <@U1>/);
  assert.equal((await f.stores.management.getChangeSetProposal('proposal_cancel'))?.status, 'stale');
}));
