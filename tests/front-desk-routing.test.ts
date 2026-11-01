import assert from 'node:assert/strict';
import { test } from 'node:test';

import { processGatewaySlackEnvelope, processGatewayUiAction, processSlackFrontDeskHandoff } from '../src/channels/slack.ts';
import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import { closeNodeStateStores, resolveStores } from '../src/config/state-backend.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import type { WebClient } from '@slack/web-api';
import { compileRuntimePlanV2, deriveRuntimePlanInstanceId } from '../src/agents/runtime-plan.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import { freezeRuntimePlanForTurn, runTurn } from '../src/slack/run-turn.ts';
import { uiActionId, uiBlockId, uiSurfaceId, uiValue, type UiSurfaceRecord } from '../src/slack/ui/surface.ts';
import { escapeMrkdwn } from '../src/slack/ui/text.ts';
import { resolveAgentRoute } from '../src/slack/agent-routing.ts';
import {
  FRONT_DESK_CHOICE_SETTLED_LINE,
  FRONT_DESK_MAX_NAME_CHARS,
  clampText,
  compileFrontDeskPlan,
  frontDeskFailureLine,
  type SlackFrontDeskHandoffRequest,
} from '../src/slack/front-desk.ts';
import { recordDeliveredSlackAgentMessage } from '../src/slack/public-context.ts';
import { slackAgentThreadKey } from '../src/slack/thread-key.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const OWNER = {
  id: 'U1', team_id: 'T1', name: 'Owner', deleted: false, is_bot: false, is_app_user: false,
  is_restricted: false, is_ultra_restricted: false, is_stranger: false,
};

function presence(handle: string) {
  return {
    requestedHandle: handle, normalizedHandle: handle, desiredState: 'active' as const,
    health: 'healthy' as const, userGroupId: `S${handle.toUpperCase().replace(/-/g, '')}`,
    avatar: { kind: 'generated' as const, revision: 1, seed: handle, url: `https://example.test/${handle}.svg` },
  };
}

function agentInput(id: string, name: string, handle: string, creatorMembershipId: string, description?: string) {
  return {
    id, name, instructions: `Help with ${name}.`, enabled: true, lifecycle: 'active' as const,
    creatorMembershipId, editPolicy: 'creator_and_admins' as const, ...(description ? { description } : {}),
    model: `local-stub/${handle}`, skills: [], mcpServers: [], apiConnections: [], repositories: [],
    slackPresence: presence(handle),
  };
}

export interface FrontDeskLane {
  stores: ReturnType<typeof resolveStores>;
  gateway: GatewayDeploymentClient;
  jobs: TurnJob[];
  posts: Array<Record<string, unknown>>;
  enqueueTurn(job: TurnJob): Promise<{ ok: true; value: null }>;
  ownerMembershipId: string;
}

/**
 * A chickpea-v1 gateway installation whose owner U1 created Support Desk and
 * Research, beside an HR Agent another member created (creator-only, so never
 * U1's to use). Admitted jobs are collected in order; posts are recorded.
 */
export async function withFrontDeskLane(scenario: (lane: FrontDeskLane) => Promise<void>): Promise<void> {
  const envKeys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previousEnv = envKeys.map((key) => process.env[key]);
  for (const key of envKeys) process.env[key] = ':memory:';
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  closeNodeStateStores();
  const stores = resolveStores();
  try {
    const owner = await createSlackOwner(stores.identity, { teamId: 'T1', userId: 'U1' });
    await stores.config.ensureWorkspaceInstallation({
      workspaceId: 'T1', transportMode: 'gateway', appId: 'A1', botUserId: 'UBOT',
      gatewayBindingId: 'binding1', runtimeContract: 'chickpea-v1',
    });
    // A model that needs no provider key, so Chickpea's turns are admitted canonically.
    const current = await stores.config.getWorkspaceModelDefault('T1');
    await stores.config.putWorkspaceModelDefault({
      workspaceId: 'T1', modelId: 'local-stub/chickpea', provenance: 'admin_selected',
      lastChangedByMembershipId: owner.membership.id,
    }, current?.revision ?? 0);
    const agents: CustomAgentConfig[] = [];
    for (const [id, name, handle, creator, description] of [
      ['agent_support', 'Support Desk', 'support-desk', owner.membership.id, 'Answers order questions on the portal.'],
      ['agent_research', 'Research', 'research', owner.membership.id, 'Researches markets.'],
      ['agent_hr', 'HR', 'hr', 'membership_someone_else', 'Handles payroll.'],
    ] as const) {
      agents.push(await stores.config.createAgent(agentInput(id, name, handle, creator, description)));
    }
    const posts: Array<Record<string, unknown>> = [];
    const binding = { workspaceId: 'T1', appId: 'A1', botUserId: 'UBOT', bindingId: 'binding1' };
    const liveChannel = {
      id: 'C1', name: 'team', is_channel: true, is_private: false, is_member: true, is_archived: false,
    };
    const gateway = {
      workspaceId: 'T1',
      async loadBinding() { return binding; },
      async call(operation: string, args: Record<string, unknown>) {
        if (operation === 'users.info') return { user: OWNER };
        if (operation === 'conversations.info') return { channel: liveChannel };
        if (operation === 'conversations.members') return { members: ['U1', 'UBOT'] };
        if (operation === 'users.conversations') return { channels: [liveChannel] };
        if (operation === 'chat.postMessage') {
          posts.push(args);
          return { ok: true, ts: `9900.00000${posts.length}`, channel: args.channel };
        }
        if (operation === 'chat.postEphemeral') {
          posts.push({ ...args, ephemeral: true });
          return { ok: true };
        }
        if (operation === 'chat.update') {
          posts.push({ ...args, update: true });
          return { ok: true };
        }
        throw new Error(`Unexpected gateway operation: ${operation}`);
      },
    } as unknown as GatewayDeploymentClient;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true, value: { userAgent: 'Cloudflare-Workers' },
    });
    const jobs: TurnJob[] = [];
    const enqueueTurn = async (job: TurnJob) => {
      if (!jobs.some(({ id }) => id === job.id)) jobs.push(job);
      return { ok: true as const, value: null };
    };
    await scenario({ stores, gateway, jobs, posts, enqueueTurn, ownerMembershipId: owner.membership.id });
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

const ROOT = '1793440000.000100';
const LINE_TS = '1793440000.000200';

export function directMessage(eventId: string, ts: string, text: string, patch: Record<string, unknown> = {}) {
  return {
    workspaceId: 'T1', eventId, eventTime: Math.floor(Number(ts)),
    event: { type: 'message' as const, channel: 'D1', user: 'U1', ts, text, ...patch },
  };
}

test('an untagged root DM reaches Chickpea with the Agents this person may use, and only them', async () => {
  await withFrontDeskLane(async ({ stores, gateway, jobs, enqueueTurn }) => {
    await processGatewaySlackEnvelope(directMessage('Ev1', '1793440000.000100', 'Check order 4821 on the portal.'),
      undefined, gateway, { stores, enqueueTurn });
    assert.equal(jobs.length, 1);
    const [chickpea] = jobs;
    assert.equal(chickpea!.assignment.agentId, CHICKPEA_AGENT_ID);
    assert.ok(chickpea!.runId, 'admitted with a Run');
    assert.deepEqual(chickpea!.assignment.frontDesk?.agents.map(({ id, name, handle, purpose }) => ({ id, name, handle, purpose })), [
      { id: 'agent_research', name: 'Research', handle: 'research', purpose: 'Researches markets.' },
      { id: 'agent_support', name: 'Support Desk', handle: 'support-desk', purpose: 'Answers order questions on the portal.' },
    ], 'a creator-only Agent another member made is never listed');
    assert.equal(chickpea!.assignment.frontDesk?.omitted, 0);
    assert.equal(chickpea!.assignment.frontDesk?.incomplete, false);
  });
});

test('a root DM delivered again after its admission failed still reaches Chickpea with its list', async () => {
  await withFrontDeskLane(async ({ stores, gateway, jobs, enqueueTurn }) => {
    let failed = false;
    const flaky = async (job: TurnJob) => {
      if (!failed) {
        failed = true;
        return { ok: false as const, error: { code: 'unavailable', message: 'state store unavailable' } };
      }
      return enqueueTurn(job);
    };
    const envelope = directMessage('Ev1', ROOT, 'Check order 4821 on the portal.');
    await assert.rejects(processGatewaySlackEnvelope(envelope, undefined, gateway, { stores, enqueueTurn: flaky as never }));
    await processGatewaySlackEnvelope(envelope, undefined, gateway, { stores, enqueueTurn: flaky as never });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.assignment.agentId, CHICKPEA_AGENT_ID);
    assert.equal(jobs[0]!.assignment.frontDesk?.agents.length, 2);
  });
});

test('an Agent name too long, or empty once cleaned, still freezes the turn\'s plan', async () => {
  await withFrontDeskLane(async ({ stores, gateway, jobs, enqueueTurn, ownerMembershipId }) => {
    const longName = `Quarterly ${'very '.repeat(42)}long report Agent`;
    assert.ok(longName.length > 200 && longName.length <= 240);
    await stores.config.createAgent(agentInput('agent_long', longName, 'quarterly', ownerMembershipId));
    await stores.config.createAgent(agentInput('agent_brackets', '<>', 'brackets', ownerMembershipId));
    await processGatewaySlackEnvelope(directMessage('Ev1', ROOT, 'Check order 4821 on the portal.'),
      undefined, gateway, { stores, enqueueTurn });
    const chickpea = jobs[0]!;
    const { decision } = await freezeRuntimePlanForTurn({
      turn: chickpea.turn,
      assignment: chickpea.assignment,
      platformEnv: undefined,
      settingsStore: stores.settings,
      configStore: stores.config,
      memoryEpoch: Promise.resolve(1),
    });
    const names = new Map(decision.runtimePlan.frontDesk?.agents.map(({ id, name }) => [id, name]));
    assert.equal(names.get('agent_brackets'), 'brackets', 'a name that cleans to nothing falls back to the handle');
    assert.equal(names.get('agent_long'), clampText(longName, FRONT_DESK_MAX_NAME_CHARS));
  });
});

test('a mention of an Agent or of Chickpea, and a DM thread reply, get no front desk', async () => {
  await withFrontDeskLane(async ({ stores, gateway, jobs, enqueueTurn }) => {
    const deliver = (envelope: Parameters<typeof processGatewaySlackEnvelope>[0]) =>
      processGatewaySlackEnvelope(envelope, undefined, gateway, { stores, enqueueTurn });
    await deliver(directMessage('Ev1', '1793440000.000100', '<!subteam^SRESEARCH|@research> size the market'));
    await deliver(directMessage('Ev2', '1793440100.000100', '<@UBOT> what can you do?'));
    await deliver(directMessage('Ev3', '1793440200.000100', 'Check order 4821.'));
    await deliver(directMessage('Ev4', '1793440200.000200', 'And order 4822.', { thread_ts: '1793440200.000100' }));
    assert.deepEqual(jobs.map(({ assignment }) => [assignment.agentId, Boolean(assignment.frontDesk)]), [
      ['agent_research', false],
      [CHICKPEA_AGENT_ID, false],
      [CHICKPEA_AGENT_ID, true],
      [CHICKPEA_AGENT_ID, false],
    ]);
  });
});

/** Chickpea's root DM turn, delivered with its hand-off line, then the takeover the line announced. */
async function handOff(lane: FrontDeskLane, agentId: string, agentName: string, text = 'Check order 4821 on the portal.') {
  const { stores, gateway, jobs, enqueueTurn } = lane;
  await processGatewaySlackEnvelope(directMessage('Ev1', ROOT, text, {
    files: [{ id: 'F0RECEIPT1', name: 'receipt.pdf', mimetype: 'application/pdf', size: 1200 }],
  }), undefined, gateway, { stores, enqueueTurn });
  const chickpea = jobs.find(({ assignment }) => assignment.agentId === CHICKPEA_AGENT_ID)!;
  await recordDeliveredSlackAgentMessage(stores.config, chickpea.turn, chickpea.assignment, {
    messageTs: LINE_TS, text: `${agentName} is taking this. It has the portal login.`,
  });
  const dispatch = () => processSlackFrontDeskHandoff({
    turn: chickpea.turn, fromAgentId: CHICKPEA_AGENT_ID, agentId, agentName,
  }, undefined, { stores, gatewayClient: gateway, enqueueTurn });
  await dispatch();
  return { chickpea, dispatch };
}

test('a hand-off admits the person\'s own message for the chosen Agent, which takes the thread over', async () => {
  await withFrontDeskLane(async (lane) => {
    const { stores, gateway, jobs, posts, enqueueTurn } = lane;
    const { chickpea, dispatch } = await handOff(lane, 'agent_support', 'Support Desk');
    assert.equal(jobs.length, 2);
    const support = jobs[1]!;
    assert.equal(support.id, `msg:D1:${ROOT}:handoff`, 'its own claim, turn job, and usage operation');
    assert.equal(support.assignment.agentId, 'agent_support');
    assert.equal(support.turn.text, chickpea.turn.text, 'the person\'s own words, never model text');
    assert.equal(support.turn.userId, 'U1');
    assert.equal(support.turn.messageTs, ROOT);
    assert.equal(support.turn.threadTs, ROOT);
    assert.deepEqual(support.turn.attachments, chickpea.turn.attachments);
    assert.ok(support.turn.attachments?.length, 'the person\'s files come along');
    assert.deepEqual(support.turn.frontDesk, { fromAgentId: CHICKPEA_AGENT_ID, via: 'handoff' });
    for (const field of ['agentAsk', 'coAddressed', 'uiResponse', 'managementApprovalProposalId', 'sessionThreadTs'] as const) {
      assert.equal(support.turn[field], undefined, `${field} is never copied`);
    }
    assert.equal(support.assignment.frontDesk, undefined, 'the takeover has no front desk of its own');
    assert.notEqual(support.runId, chickpea.runId, 'a Run of its own');
    assert.notEqual(slackAgentThreadKey(support.turn, support.assignment), slackAgentThreadKey(chickpea.turn, chickpea.assignment));
    const route = await stores.config.getAgentThreadRoute('T1', 'D1', ROOT);
    assert.equal(route?.agentId, 'agent_support');
    assert.equal(route?.ownerIncarnation, 2);
    assert.equal(route?.handoff?.transferMessageTs, ROOT);
    assert.equal(route?.handoff?.previousAgentId, CHICKPEA_AGENT_ID);
    assert.ok(support.assignment.handoffContext?.some(({ text }) => text.startsWith('Support Desk is taking this.')),
      'the new owner reads Chickpea\'s line as thread context');

    // A second hand-off of the same message admits nothing and says nothing.
    await dispatch();
    await processSlackFrontDeskHandoff({
      turn: chickpea.turn, fromAgentId: CHICKPEA_AGENT_ID, agentId: 'agent_research', agentName: 'Research',
    }, undefined, { stores, gatewayClient: gateway, enqueueTurn });
    assert.equal(jobs.length, 2);
    assert.deepEqual(posts, []);

    // An untagged follow-up stays with the new owner.
    await processGatewaySlackEnvelope(directMessage('Ev2', '1793440000.000300', 'Also order 4822.', { thread_ts: ROOT }),
      undefined, gateway, { stores, enqueueTurn });
    assert.equal(jobs.at(-1)?.assignment.agentId, 'agent_support');
    assert.equal(jobs.at(-1)?.assignment.ownerIncarnation, 2);
  });
});

test('a hand-off to an Agent the person can no longer use is refused, and Chickpea says so once', async () => {
  await withFrontDeskLane(async (lane) => {
    const { stores, jobs, posts } = lane;
    await processGatewaySlackEnvelope(directMessage('Ev1', ROOT, 'Check order 4821 on the portal.'),
      undefined, lane.gateway, { stores, enqueueTurn: lane.enqueueTurn });
    const chickpea = jobs[0]!;
    assert.ok(chickpea.assignment.frontDesk?.agents.some(({ id }) => id === 'agent_support'));
    // Access changes between the list and the hand-off.
    const support = await stores.config.getAgent('agent_support');
    await stores.config.updateAgent('agent_support', { creatorMembershipId: 'membership_someone_else' }, support.revision);
    const dispatch = () => processSlackFrontDeskHandoff({
      turn: chickpea.turn, fromAgentId: CHICKPEA_AGENT_ID, agentId: 'agent_support', agentName: 'Support Desk',
    }, undefined, { stores, gatewayClient: lane.gateway, enqueueTurn: lane.enqueueTurn });
    await dispatch();
    await dispatch();
    assert.equal(jobs.length, 1, 'nothing is admitted');
    assert.deepEqual(posts, [{ channel: 'D1', thread_ts: ROOT, text: frontDeskFailureLine('Support Desk') }]);
    assert.equal((await stores.config.getAgentThreadRoute('T1', 'D1', ROOT))?.agentId, CHICKPEA_AGENT_ID,
      'the thread stays Chickpea\'s');
  });
});

test('the failure line shows an Agent name as written, never as Slack markup', async () => {
  await withFrontDeskLane(async (lane) => {
    const { stores, jobs, posts } = lane;
    await processGatewaySlackEnvelope(directMessage('Ev1', ROOT, 'Check order 4821 on the portal.'),
      undefined, lane.gateway, { stores, enqueueTurn: lane.enqueueTurn });
    const support = await stores.config.getAgent('agent_support');
    await stores.config.updateAgent('agent_support', { enabled: false }, support.revision);
    await processSlackFrontDeskHandoff({
      turn: jobs[0]!.turn, fromAgentId: CHICKPEA_AGENT_ID, agentId: 'agent_support', agentName: 'R&D @channel',
    }, undefined, { stores, gatewayClient: lane.gateway, enqueueTurn: lane.enqueueTurn });
    const text = String(posts[0]?.text);
    assert.equal(text, frontDeskFailureLine(escapeMrkdwn('R&D @channel')));
    assert.ok(text.includes('R&amp;D'), 'an ampersand is escaped');
    assert.ok(!text.includes('@channel'), 'a broadcast word cannot notify anyone');
  });
});

test('a hand-off to an Agent whose model cannot resolve is admitted as a mention of it would be', async () => {
  await withFrontDeskLane(async (lane) => {
    const { stores, jobs, posts } = lane;
    await processGatewaySlackEnvelope(directMessage('Ev1', ROOT, 'Check order 4821 on the portal.'),
      undefined, lane.gateway, { stores, enqueueTurn: lane.enqueueTurn });
    const chickpea = jobs[0]!;
    const support = await stores.config.getAgent('agent_support');
    await stores.config.updateAgent('agent_support', { model: 'openai/gpt-not-in-any-catalog' }, support.revision);
    const dispatch = () => processSlackFrontDeskHandoff({
      turn: chickpea.turn, fromAgentId: CHICKPEA_AGENT_ID, agentId: 'agent_support', agentName: 'Support Desk',
    }, undefined, { stores, gatewayClient: lane.gateway, enqueueTurn: lane.enqueueTurn });
    await dispatch();
    assert.equal(jobs.length, 2, 'admitted, to deliver the sanitized provider failure');
    const takeover = jobs[1]!;
    assert.equal(takeover.id, `msg:D1:${ROOT}:handoff`);
    assert.equal(takeover.assignment.agentId, 'agent_support');
    assert.equal(takeover.runId, undefined, 'on the legacy lane, as a mention with no ready model is');
    assert.deepEqual(posts, [], 'no failure line for a takeover that went through');
    assert.equal((await stores.config.getAgentThreadRoute('T1', 'D1', ROOT))?.agentId, 'agent_support');
    // The same hand-off again finds the legacy claim taken: a duplicate, not a refusal.
    await dispatch();
    assert.equal(jobs.length, 2);
    assert.deepEqual(posts, []);
  });
});

test('a hand-off that keeps failing after it moved the thread gives the thread back to Chickpea', async (t) => {
  await withFrontDeskLane(async (lane) => {
    const { stores, jobs, posts } = lane;
    await processGatewaySlackEnvelope(directMessage('Ev1', ROOT, 'Check order 4821 on the portal.'),
      undefined, lane.gateway, { stores, enqueueTurn: lane.enqueueTurn });
    const chickpea = jobs[0]!;
    const unavailable = async () => ({ ok: false as const, error: { code: 'unavailable', message: 'state store unavailable' } });
    const dispatch = (enqueueTurn: FrontDeskLane['enqueueTurn']) => processSlackFrontDeskHandoff({
      turn: chickpea.turn, fromAgentId: CHICKPEA_AGENT_ID, agentId: 'agent_support', agentName: 'Support Desk',
    }, undefined, { stores, gatewayClient: lane.gateway, enqueueTurn });
    // Its retries back off on timers; run them out without waiting.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = dispatch(unavailable as never);
    let settled = false;
    void pending.finally(() => { settled = true; });
    while (!settled) {
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(5_000);
    }
    await pending;
    t.mock.timers.reset();
    assert.equal(jobs.length, 1, 'nothing is admitted');
    assert.deepEqual(posts.map(({ text }) => text), [frontDeskFailureLine('Support Desk')]);
    const route = await stores.config.getAgentThreadRoute('T1', 'D1', ROOT);
    assert.equal(route?.agentId, CHICKPEA_AGENT_ID, 'the failure line is true: the thread is still Chickpea\'s');

    // A later hand-off is a fresh takeover, not a retry of the one that failed.
    await dispatch(lane.enqueueTurn);
    assert.equal(jobs.at(-1)?.assignment.agentId, 'agent_support');
    assert.equal((await stores.config.getAgentThreadRoute('T1', 'D1', ROOT))?.agentId, 'agent_support');
  });
});

test('the takeover seed hands over only Chickpea\'s own root DM thread', async () => {
  await withFrontDeskLane(async (lane) => {
    const { stores, gateway, jobs, enqueueTurn } = lane;
    const allow = async () => ({ status: 'allowed' as const, audience: 'creator_only' as const });
    const actor = { channelMember: false, fullMember: true };
    const route = (turn: NormalizedSlackTurn, agentId = 'agent_support') => resolveAgentRoute({
      turn, surface: 'direct', actor, config: stores.config, frontDeskAgentId: agentId, authorizeUserAgent: allow,
    });
    // A thread another Agent owns is not Chickpea's to hand over.
    await processGatewaySlackEnvelope(directMessage('Ev1', '1793440100.000100', '<!subteam^SRESEARCH|@research> size it'),
      undefined, gateway, { stores, enqueueTurn });
    const research = jobs[0]!;
    assert.equal((await route(research.turn)).kind, 'denied');
    // Chickpea's thread, but at a reply or in a group DM: denied.
    await processGatewaySlackEnvelope(directMessage('Ev2', ROOT, 'Check order 4821.'), undefined, gateway, { stores, enqueueTurn });
    const chickpea = jobs[1]!;
    assert.equal((await route({ ...chickpea.turn, messageTs: '1793440000.000900' })).kind, 'denied');
    assert.equal((await route({ ...chickpea.turn, channelType: 'mpim' })).kind, 'denied');
    // Chickpea's root: routed, as a takeover; then a retry of the same takeover routes again.
    const first = await route(chickpea.turn);
    assert.equal(first.kind === 'routed' && first.source, 'front_desk');
    assert.equal(first.kind === 'routed' && first.handoff, true);
    const retried = await route(chickpea.turn);
    assert.equal(retried.kind === 'routed' && retried.assignment.agentId, 'agent_support');
    assert.equal(retried.kind === 'routed' && retried.route.ownerIncarnation, 2, 'the retry does not hand over twice');
    // Once Support Desk owns it, no other Agent may take it from the front desk.
    assert.equal((await route(chickpea.turn, 'agent_research')).kind, 'denied');
  });
});

/** A Slack client that records what a run posts. */
function recordingClient(posts: Array<Record<string, unknown>>): WebClient {
  return {
    conversations: { replies: async () => ({ ok: true, messages: [] }), history: async () => ({ ok: true, messages: [] }) },
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        posts.push(args);
        return { ok: true, ts: `1793440000.00090${posts.length}` };
      },
      update: async () => ({ ok: true }),
    },
  } as unknown as WebClient;
}

/** A model that needs no provider key, so the run reaches delivery. */
function stubModel<T extends TurnJob['assignment']>(assignment: T): T {
  return { ...assignment, model: 'local-stub/agent', modelAttribution: { source: 'pinned' as const, providerId: 'local-stub' } };
}

/** Chickpea's root DM turn run to delivery, with the model's run replaced by a hand-off to `agentIds`. */
async function runHandOff(lane: FrontDeskLane, agentIds: string[], note: string, options: { usage?: true } = {}) {
  const { stores, gateway, jobs, enqueueTurn } = lane;
  await processGatewaySlackEnvelope(directMessage('Ev1', ROOT, 'Check order 4821 on the portal.'),
    undefined, gateway, { stores, enqueueTurn });
  const chickpea = jobs[0]!;
  const assignment = stubModel(chickpea.assignment);
  const frontDesk = compileFrontDeskPlan(chickpea.turn, assignment)!;
  const runtimePlan = compileRuntimePlanV2({ turn: chickpea.turn, assignment, instructions: 'Help.', memoryEpoch: 1, frontDesk });
  const posts: Array<Record<string, unknown>> = [];
  const client = recordingClient(posts);
  const handoffs: SlackFrontDeskHandoffRequest[] = [];
  let delivered: string | undefined;
  await runTurn(chickpea.turn, assignment, undefined, {
    client, turnId: chickpea.id,
    ...(options.usage ? { usageRecordingEnabled: true, usageStore: stores.usage } : { usageRecordingEnabled: false }),
    runtimePlanDecision: { runtimePlan, instanceId: deriveRuntimePlanInstanceId(runtimePlan) },
    appStores: stores,
    agentPrompt: async (input) => {
      const { resultFromAgentReply } = await import('../src/slack/flue-dispatch.ts');
      return resultFromAgentReply({
        text: 'A draft the person never sees.', metadata: {},
        data: { slackFrontDeskHandoff: [{ agentIds, note }] }, submissionId: 'sub_front_desk', uid: 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      }, null, input.runtimePlan?.frontDesk);
    },
    onFrontDeskHandoff: (request) => { handoffs.push(request); },
    onDelivered: (outcome) => { delivered = outcome; },
  });
  return { chickpea, posts, handoffs, delivered };
}

/** The card a hand-off to several Agents left, and a pick on it. */
async function cardOf(lane: FrontDeskLane, turnJobId: string) {
  const id = uiSurfaceId(turnJobId, 'host-agent-choice');
  const read = async (): Promise<UiSurfaceRecord> => {
    const response = await lane.stores.slackState.executeUiSurface!({ kind: 'get_surface', id });
    assert.ok(response.kind === 'surface' && response.surface);
    return response.surface;
  };
  const card = await read();
  const click = (index: number, userId = 'U1') => processGatewayUiAction({
    protocolVersion: 1, kind: 'interaction.ui_action', deliveryId: `ui:${id}:${index}:${userId}`,
    bindingId: 'binding1', workspaceId: 'T1', userId, containerType: 'message',
    channelId: 'D1', messageTs: card.messageTs!, threadTs: ROOT, isEphemeral: false, viewId: null,
    actionId: uiActionId('host', 'agent_choice', index), blockId: uiBlockId('host', id, 1),
    actionType: 'button', value: uiValue(id, index), selected: [], state: {},
    actionTs: '1793440001.000100', triggerId: 'trigger1',
  }, undefined, lane.gateway, { stores: lane.stores, enqueueTurn: lane.enqueueTurn });
  return { read, click };
}

const cardText = (posts: Array<Record<string, unknown>>) => posts.filter(({ update }) => update).map(({ text }) => text);

test('the takeover is metered as its own Agent\'s turn, for the same requester as Chickpea\'s decision', async () => {
  await withFrontDeskLane(async (lane) => {
    const { stores } = lane;
    const { chickpea, handoffs } = await runHandOff(lane, ['agent_support'], 'It has the portal login.', { usage: true });
    await processSlackFrontDeskHandoff(handoffs[0]!, undefined, { stores, gatewayClient: lane.gateway, enqueueTurn: lane.enqueueTurn });
    const takeover = lane.jobs[1]!;
    const assignment = stubModel(takeover.assignment);
    const runtimePlan = compileRuntimePlanV2({ turn: takeover.turn, assignment, instructions: 'Help.', memoryEpoch: 1 });
    await runTurn(takeover.turn, assignment, undefined, {
      client: recordingClient([]), turnId: takeover.id, usageRecordingEnabled: true, usageStore: stores.usage,
      runtimePlanDecision: { runtimePlan, instanceId: deriveRuntimePlanInstanceId(runtimePlan) },
      appStores: stores,
      agentPrompt: async () => {
        const { resultFromAgentReply } = await import('../src/slack/flue-dispatch.ts');
        return resultFromAgentReply({
          text: 'Order 4821 shipped yesterday.', metadata: {}, data: {}, submissionId: 'sub_takeover', uid: 'inst_01ARZ3NDEKTSV4RRFFQ69G5FAW',
        }, null);
      },
    });
    const decision = (await stores.usage.getOperation(chickpea.id))?.operation;
    const taken = (await stores.usage.getOperation(takeover.id))?.operation;
    assert.equal(decision?.agentId, CHICKPEA_AGENT_ID, 'Chickpea\'s short decision is metered as Chickpea\'s');
    assert.equal(taken?.agentId, 'agent_support', 'the takeover is metered as the target Agent\'s');
    assert.equal(taken?.requesterMembershipId, lane.ownerMembershipId);
    assert.equal(taken?.requesterMembershipId, decision?.requesterMembershipId, 'the same requester on both');
  });
});

test('Chickpea\'s hand-off to one Agent posts the host\'s line, then asks the executor to admit the takeover', async () => {
  await withFrontDeskLane(async (lane) => {
    const { chickpea, posts, handoffs, delivered } = await runHandOff(lane, ['agent_support'], 'It has the portal login.');
    assert.equal(delivered, 'succeeded');
    assert.deepEqual(posts.map(({ text }) => text), ['Support Desk is taking this. It has the portal login.']);
    assert.ok(!JSON.stringify(posts).includes('A draft the person never sees.'));
    assert.deepEqual(handoffs, [{
      turn: chickpea.turn, fromAgentId: CHICKPEA_AGENT_ID, agentId: 'agent_support', agentName: 'Support Desk',
    }]);
  });
});

test('a hand-off to several Agents posts the line and a card with one button per Agent, and admits nothing yet', async () => {
  await withFrontDeskLane(async (lane) => {
    const { chickpea, posts, handoffs } = await runHandOff(lane, ['agent_support', 'agent_research', CHICKPEA_AGENT_ID], 'Both can look.');
    assert.deepEqual(handoffs, []);
    assert.equal(posts[0]?.text, 'Which Agent should take this? Both can look.');
    const card = posts[1] as { text: string; blocks: Array<{ elements?: Array<{ text: { text: string } }> }> };
    assert.equal(card.text, 'Which Agent should take this?');
    assert.deepEqual(card.blocks.flatMap((block) => block.elements ?? []).map((button) => button.text.text),
      ['Support Desk', 'Research', 'Chickpea']);
    const surface = await lane.stores.slackState.executeUiSurface!({
      kind: 'get_surface', id: uiSurfaceId(chickpea.id, 'host-agent-choice'),
    });
    const record = surface.kind === 'surface' ? surface.surface : null;
    assert.equal(record?.namespace, 'host');
    assert.equal(record?.requesterUserId, 'U1');
    assert.ok(record && record.expiresAt - record.createdAt <= 24 * 60 * 60_000, 'the card lives a day');
    assert.deepEqual(record?.spec.kind === 'agent_choice' && record.spec.origin?.text, 'Check order 4821 on the portal.');
  });
});

test('a pick on the card admits the person\'s message for that Agent; anyone else\'s click and a second pick do nothing', async () => {
  await withFrontDeskLane(async (lane) => {
    const { chickpea } = await runHandOff(lane, ['agent_support', 'agent_research'], 'Both can look.');
    const { read, click } = await cardOf(lane, chickpea.id);
    assert.equal((await read()).status, 'open');

    await click(0, 'U2');
    assert.equal(lane.jobs.length, 1, 'a click from someone else admits nothing');
    assert.deepEqual(lane.posts, [], 'and says nothing');
    assert.equal((await read()).resolution, undefined);

    await click(0);
    assert.equal(lane.jobs.length, 2);
    const support = lane.jobs[1]!;
    assert.equal(support.id, `msg:D1:${ROOT}:handoff`);
    assert.equal(support.assignment.agentId, 'agent_support');
    assert.equal(support.turn.text, 'Check order 4821 on the portal.', 'the person\'s typed message, never the button label');
    assert.equal(support.turn.uiResponse, undefined);
    assert.deepEqual(support.turn.frontDesk, { fromAgentId: CHICKPEA_AGENT_ID, via: 'click' });
    assert.equal((await lane.stores.config.getAgentThreadRoute('T1', 'D1', ROOT))?.agentId, 'agent_support');
    assert.equal((await read()).status, 'resolved');
    assert.deepEqual(cardText(lane.posts), ['Support Desk is taking this.']);

    // A second pick, of another Agent, finds the message handed over.
    await click(1);
    assert.equal(lane.jobs.length, 2);
    assert.equal((await read()).resolution?.choice, 0);
    assert.ok(!lane.posts.some(({ ephemeral }) => ephemeral), 'no notice for a repeat click');
  });
});

const lastCard = (posts: Array<Record<string, unknown>>) =>
  posts.filter(({ update }) => update).at(-1) as { text: string; blocks: Array<{ type: string }> } | undefined;

test('two picks at once, of the same Agent or of two, admit one takeover and the card names who took it', async () => {
  for (const picks of [[0, 0], [0, 1]] as const) {
    await withFrontDeskLane(async (lane) => {
      const { chickpea } = await runHandOff(lane, ['agent_support', 'agent_research'], 'Both can look.');
      const { read, click } = await cardOf(lane, chickpea.id);
      await Promise.all(picks.map((index) => click(index)));
      assert.equal(lane.jobs.length, 2, `one takeover for picks ${picks.join(',')}`);
      const owner = (await lane.stores.config.getAgentThreadRoute('T1', 'D1', ROOT))?.agentId;
      assert.equal(owner, lane.jobs[1]!.assignment.agentId);
      const card = await read();
      assert.equal(card.spec.kind === 'agent_choice' && card.spec.options[card.resolution!.takenBy!]?.agentId, owner);
      assert.equal(lastCard(lane.posts)?.text, owner === 'agent_support' ? 'Support Desk is taking this.' : 'Research is taking this.');
      assert.ok(!lane.posts.some(({ ephemeral }) => ephemeral), 'the second pick says nothing');
    });
  }
});

test('a pick after another takeover of the message names the Agent that has it', async () => {
  await withFrontDeskLane(async (lane) => {
    const { chickpea } = await runHandOff(lane, ['agent_support', 'agent_research'], 'Both can look.');
    await processSlackFrontDeskHandoff({
      turn: chickpea.turn, fromAgentId: CHICKPEA_AGENT_ID, agentId: 'agent_research', agentName: 'Research',
    }, undefined, { stores: lane.stores, gatewayClient: lane.gateway, enqueueTurn: lane.enqueueTurn });
    const { read, click } = await cardOf(lane, chickpea.id);
    await click(0);
    assert.equal(lane.jobs.length, 2, 'Support Desk is not admitted');
    assert.equal((await read()).resolution?.takenBy, 1);
    assert.equal(lastCard(lane.posts)?.text, 'Research is taking this.');
  });
});

test('a click on a card whose pick never settled leaves no live buttons', async () => {
  await withFrontDeskLane(async (lane) => {
    const { chickpea } = await runHandOff(lane, ['agent_support', 'agent_research'], 'Both can look.');
    const { read, click } = await cardOf(lane, chickpea.id);
    // The host claimed the card and admitted the takeover, then stopped before settling it.
    const card = await read();
    await lane.stores.slackState.executeUiSurface!({
      kind: 'claim_surface', id: card.id, namespace: 'host', resolution: { byUserId: 'U1', at: Date.now(), choice: 0 },
    });
    await processSlackFrontDeskHandoff({
      turn: chickpea.turn, fromAgentId: CHICKPEA_AGENT_ID, agentId: 'agent_support', agentName: 'Support Desk',
    }, undefined, { stores: lane.stores, gatewayClient: lane.gateway, enqueueTurn: lane.enqueueTurn });
    await click(1);
    assert.equal(lane.jobs.length, 2, 'the click admits nothing');
    const redrawn = lastCard(lane.posts);
    assert.equal(redrawn?.text, FRONT_DESK_CHOICE_SETTLED_LINE);
    assert.ok(!redrawn?.blocks.some(({ type }) => type === 'actions'), 'no buttons left');
  });
});

test('picking Chickpea on the card gives Chickpea its own turn on the message, with no front desk', async () => {
  await withFrontDeskLane(async (lane) => {
    const { chickpea } = await runHandOff(lane, ['agent_support', CHICKPEA_AGENT_ID], 'I can answer too.');
    const { click } = await cardOf(lane, chickpea.id);
    await click(1);
    const picked = lane.jobs[1]!;
    assert.equal(picked.id, `msg:D1:${ROOT}:handoff`);
    assert.equal(picked.assignment.agentId, CHICKPEA_AGENT_ID);
    assert.deepEqual(picked.turn.frontDesk, { fromAgentId: CHICKPEA_AGENT_ID, via: 'click' });
    assert.equal(compileFrontDeskPlan(picked.turn, picked.assignment), undefined, 'it cannot hand off again');
    assert.notEqual(picked.runId, chickpea.runId);
    assert.deepEqual(cardText(lane.posts), ['Chickpea is answering this.']);
  });
});

test('a pick the person can no longer make turns the card into the failure line; an expired card says to mention the Agent', async () => {
  await withFrontDeskLane(async (lane) => {
    const { chickpea } = await runHandOff(lane, ['agent_support', 'agent_research'], 'Both can look.');
    const support = await lane.stores.config.getAgent('agent_support');
    await lane.stores.config.updateAgent('agent_support', { enabled: false }, support.revision);
    const { read, click } = await cardOf(lane, chickpea.id);
    await click(0);
    assert.equal(lane.jobs.length, 1);
    assert.equal((await read()).resolution?.refused, true);
    assert.deepEqual(cardText(lane.posts), [frontDeskFailureLine('Support Desk')]);
    assert.equal(originOf(await read()), undefined, 'a refused pick forgets the message');
  });
  await withFrontDeskLane(async (lane) => {
    const { chickpea } = await runHandOff(lane, ['agent_support', 'agent_research'], 'Both can look.');
    const { read, click } = await cardOf(lane, chickpea.id);
    const card = await read();
    // The person comes back the next day.
    const now = Date.now;
    Date.now = () => card.expiresAt + 1;
    try {
      await click(0);
    } finally {
      Date.now = now;
    }
    assert.equal(lane.jobs.length, 1);
    assert.equal((await read()).status, 'expired');
    assert.deepEqual(cardText(lane.posts), ['This choice expired. Mention the Agent you want.']);
    assert.equal(originOf(await read()), undefined, 'an expired card forgets the message');
  });
});

const originOf = (card: UiSurfaceRecord) => card.spec.kind === 'agent_choice' ? card.spec.origin : null;

/** A change Slack reports to the person's root message: an edit to `text`, or a delete. */
function rootMessageChange(eventId: string, change: { edit: string } | 'delete') {
  const original = { type: 'message' as const, user: 'U1', ts: ROOT, text: 'Check order 4821 on the portal.' };
  return {
    workspaceId: 'T1', eventId, eventTime: 1793440002,
    event: change === 'delete'
      ? { type: 'message' as const, subtype: 'message_deleted', channel: 'D1', channel_type: 'im', ts: '1793440002.000100',
          deleted_ts: ROOT, previous_message: original }
      : { type: 'message' as const, subtype: 'message_changed', channel: 'D1', channel_type: 'im', ts: '1793440002.000100',
          message: { ...original, text: change.edit, edited: { user: 'U1', ts: '1793440002.000100' } },
          previous_message: original },
  };
}

test('an edit or a delete of the message closes its card, and a later pick sends nothing', async () => {
  for (const change of [{ edit: 'Check order 4822 instead.' }, 'delete'] as const) {
    await withFrontDeskLane(async (lane) => {
      const { chickpea } = await runHandOff(lane, ['agent_support', 'agent_research'], 'Both can look.');
      const { read, click } = await cardOf(lane, chickpea.id);
      await processGatewaySlackEnvelope(rootMessageChange('Ev9', change) as never, undefined, lane.gateway,
        { stores: lane.stores, enqueueTurn: lane.enqueueTurn });
      const label = change === 'delete' ? 'delete' : 'edit';
      assert.equal((await read()).status, 'expired', `${label} closes the card`);
      assert.equal(originOf(await read()), undefined, `${label} drops the copy`);
      const before = lane.jobs.length;
      await click(0);
      assert.equal(lane.jobs.length, before, `the pick admits nothing after an ${label}`);
      assert.ok(!lane.jobs.some(({ id }) => id.endsWith(':handoff')));
      assert.deepEqual(cardText(lane.posts), ['This choice expired. Mention the Agent you want.']);
    });
  }
});

test('a pick forgets the message once it claims the card', async () => {
  await withFrontDeskLane(async (lane) => {
    const { chickpea } = await runHandOff(lane, ['agent_support', 'agent_research'], 'Both can look.');
    const { read, click } = await cardOf(lane, chickpea.id);
    assert.equal(originOf(await read())?.text, 'Check order 4821 on the portal.');
    await click(0);
    assert.equal(lane.jobs[1]?.turn.text, 'Check order 4821 on the portal.');
    assert.equal(originOf(await read()), undefined);
  });
});
