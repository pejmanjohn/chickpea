import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processGatewaySlackEnvelope } from '../src/channels/slack.ts';
import { closeNodeStateStores, resolveStores } from '../src/config/state-backend.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const OWNER = {
  id: 'U1', team_id: 'T1', name: 'Owner', deleted: false, is_bot: false, is_app_user: false,
  is_restricted: false, is_ultra_restricted: false, is_stranger: false,
};

async function withGatewayAdmission(
  usersInfo: () => Promise<Record<string, unknown>>,
  body: (admit: (ts: string) => Promise<'accepted' | 'rejected'>, jobs: TurnJob[]) => Promise<void>,
): Promise<void> {
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
    const binding = { workspaceId: 'T1', appId: 'A1', botUserId: 'UBOT', bindingId: 'binding1' };
    const gateway = {
      workspaceId: 'T1',
      async loadBinding() { return binding; },
      async call(operation: string) {
        if (operation === 'users.info') return usersInfo();
        if (operation === 'conversations.info') return { channel: { id: 'D1', is_im: true, user: 'U1' } };
        if (operation === 'users.conversations') return { channels: [] };
        if (operation === 'chat.postMessage') return { ts: '1000.0001', channel: 'D1' };
        throw new Error(`Unexpected gateway operation: ${operation}`);
      },
    } as unknown as GatewayDeploymentClient;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true, value: { userAgent: 'Cloudflare-Workers' },
    });
    const jobs: TurnJob[] = [];
    // The same Slack event every time: a durable inbox retry replays it.
    const admit = (ts: string) => processGatewaySlackEnvelope({
      workspaceId: 'T1', eventId: `Ev${ts}`, eventTime: Number(ts),
      event: {
        type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', ts,
        text: '<!subteam^SSUPPORT|@support> Hello there.',
      },
    }, undefined, gateway, {
      stores,
      enqueueTurn: async (job) => { jobs.push(job); return { ok: true, value: null }; },
    });
    await body(admit, jobs);
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

test('a rate-limited routing lookup defers admission so the inbox retry admits the mention', async () => {
  let limited = true;
  await withGatewayAdmission(async () => {
    if (limited) {
      throw new SlackTransportError('users.info', 'gateway_rate_limited', {
        retryable: true, effectOutcome: 'failed',
      });
    }
    return { user: OWNER };
  }, async (admit, jobs) => {
    await assert.rejects(
      admit('1000'),
      (error: unknown) => error instanceof SlackTransportError && error.code === 'gateway_rate_limited',
    );
    assert.equal(jobs.length, 0, 'no turn is admitted while the lookup is rate limited');
    limited = false;
    // Nothing was claimed by the deferred attempt, so the retry is not a duplicate.
    assert.equal(await admit('1000'), 'accepted');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.assignment.agentId, 'agent_support');
  });
});

test('a non-retryable routing failure stays fail-closed and completes the delivery', async () => {
  await withGatewayAdmission(async () => {
    throw new SlackTransportError('users.info', 'user_not_found', {
      retryable: false, effectOutcome: 'failed',
    });
  }, async (admit, jobs) => {
    assert.equal(await admit('2000'), 'accepted');
    assert.equal(jobs.length, 0);
  });
});
