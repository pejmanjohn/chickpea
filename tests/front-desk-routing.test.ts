import assert from 'node:assert/strict';
import { test } from 'node:test';

import { processGatewaySlackEnvelope } from '../src/channels/slack.ts';
import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import { closeNodeStateStores, resolveStores } from '../src/config/state-backend.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
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
    assert.deepEqual(chickpea!.assignment.frontDesk?.agents.map(({ id, name, handle, purpose }) => ({ id, name, handle, purpose })), [
      { id: 'agent_research', name: 'Research', handle: 'research', purpose: 'Researches markets.' },
      { id: 'agent_support', name: 'Support Desk', handle: 'support-desk', purpose: 'Answers order questions on the portal.' },
    ], 'a creator-only Agent another member made is never listed');
    assert.equal(chickpea!.assignment.frontDesk?.omitted, 0);
    assert.equal(chickpea!.assignment.frontDesk?.incomplete, false);
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
