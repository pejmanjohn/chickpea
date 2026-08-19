import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { SqliteConfigStore } from '../src/config/store.ts';
import type { ConfigStore } from '../src/config/store.ts';
import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { createManagementSetupRoutes } from '../src/management/setup-routes.ts';
import { WorkspaceManagementService } from '../src/management/service.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { recordPendingSlackChallenge } from '../src/slack/identity-handshake.ts';
import { cancelSlackIdentityConnection } from '../src/slack/identity-bootstrap.ts';
import { REQUIRED_SLACK_BOT_SCOPES } from '../src/slack/scopes.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const CAPABILITY = 'c'.repeat(43);

async function fixture(suffix: string) {
  let sequence = 0;
  const identity = new SqliteIdentityStore(':memory:');
  const owner = await createSlackOwner(identity, { suffix });
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  await config.createAgent({
    id: 'agent_support',
    name: 'Support',
    instructions: 'Help customers.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  const workspaceDefault = await config.getSlackIdentity(
    WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
  );
  await config.updateSlackIdentity(
    workspaceDefault.id,
    workspaceDefault.connectionRevision,
    {
      lifecycle: 'connected',
      teamId: owner.user.slackTeamId,
      appId: 'A_DEFAULT',
      botUserId: 'U_DEFAULT_BOT',
      health: 'healthy',
    },
  );
  const service = new WorkspaceManagementService({
    identity,
    config,
    management,
    setupBaseUrl: 'https://chickpea.test',
    randomCapability: () => CAPABILITY,
    randomId: () => `${suffix}_${++sequence}`,
    cancelSlackIdentitySetup: (identityId, expectedRevision) =>
      cancelSlackIdentityConnection({
        config,
        settings,
        identityId,
        expectedRevision,
      }),
  });
  const context = {
    userId: owner.user.id,
    membershipId: owner.membership.id,
    organizationId: owner.membership.organizationId,
    origin: { kind: 'mcp' as const, clientId: 'codex' },
  };
  return {
    identity,
    owner,
    config,
    management,
    settings,
    service,
    context,
    close() {
      identity.close();
      config.close();
      management.close();
      settings.close();
    },
  };
}

test('management creates a Slack identity, changes its DM binding, and confirms retirement', async () => {
  const f = await fixture('slack-lifecycle');
  try {
    const created = await f.service.applyWorkspaceChanges({
      context: f.context,
      idempotencyKey: 'create-support-identity',
      operations: [{
        itemId: 'identity',
        kind: 'create_slack_identity',
        identityId: 'slack_identity_support',
        initialDmAgentId: 'agent_support',
        appName: 'Chickpea Support',
        displayName: 'Support',
      }],
    });
    assert.equal(created.outcomes[0]?.disposition, 'applied');
    assert.equal(created.outcomes[0]?.changed?.[0]?.kind, 'slack_identity');

    let slackIdentity = await f.config.getSlackIdentity('slack_identity_support');
    assert.equal(slackIdentity.dmAgentId, 'agent_support');
    assert.equal(slackIdentity.lifecycle, 'setup_incomplete');

    const canceled = await f.service.applyWorkspaceChanges({
      context: f.context,
      idempotencyKey: 'cancel-support-setup',
      operations: [{
        itemId: 'cancel',
        kind: 'cancel_slack_identity_setup',
        identityId: slackIdentity.id,
        expectedRevision: slackIdentity.connectionRevision,
      }],
    });
    assert.equal(canceled.outcomes[0]?.disposition, 'confirmation_required');
    await f.service.confirmWorkspaceChange({
      context: f.context,
      proposalId: canceled.outcomes[0]!.proposalId!,
    });
    slackIdentity = await f.config.getSlackIdentity(slackIdentity.id);
    assert.equal(slackIdentity.lifecycle, 'setup_incomplete');
    assert.equal(slackIdentity.credentialProvenance, 'none');

    const dmsOff = await f.service.applyWorkspaceChanges({
      context: f.context,
      idempotencyKey: 'support-dms-off',
      operations: [{
        itemId: 'dms',
        kind: 'set_slack_identity_dms',
        identityId: slackIdentity.id,
        expectedRevision: slackIdentity.connectionRevision,
        dmState: 'off',
      }],
    });
    assert.equal(dmsOff.outcomes[0]?.undoAvailable, true);
    slackIdentity = await f.config.getSlackIdentity(slackIdentity.id);
    assert.equal(slackIdentity.dmState, 'off');
    assert.equal(slackIdentity.dmAgentId, undefined);

    slackIdentity = await f.config.updateSlackIdentity(
      slackIdentity.id,
      slackIdentity.connectionRevision,
      { lifecycle: 'connected', health: 'healthy' },
    );
    const proposed = await f.service.applyWorkspaceChanges({
      context: f.context,
      idempotencyKey: 'retire-support-identity',
      operations: [{
        itemId: 'retire',
        kind: 'retire_slack_identity',
        identityId: slackIdentity.id,
        expectedRevision: slackIdentity.connectionRevision,
      }],
    });
    assert.equal(proposed.outcomes[0]?.disposition, 'confirmation_required');
    assert.equal((await f.config.getSlackIdentity(slackIdentity.id)).lifecycle, 'connected');

    await f.service.confirmWorkspaceChange({
      context: f.context,
      proposalId: proposed.outcomes[0]!.proposalId!,
    });
    assert.equal((await f.config.getSlackIdentity(slackIdentity.id)).lifecycle, 'retired');
    assert.deepEqual(
      (await f.config.listSlackIdentityAuditEvents({ subjectId: slackIdentity.id }))
        .map(({ eventType }) => eventType).sort(),
      [
        'slack_identity.setup_canceled',
        'slack_identity.setup_started',
        'slack_identity.dm_binding_changed',
        'slack_identity.retired',
      ].sort(),
    );
  } finally {
    f.close();
  }
});

test('interrupted Slack identity creation reconciles the persisted ingress record', async () => {
  const f = await fixture('slack-interrupted');
  try {
    let interrupt = true;
    const interruptedConfig = new Proxy(f.config as ConfigStore, {
      get(target, property, receiver) {
        if (property === 'createSlackIdentity') {
          return async (...args: Parameters<ConfigStore['createSlackIdentity']>) => {
            const created = await target.createSlackIdentity(...args);
            if (interrupt) {
              interrupt = false;
              throw new Error('simulated Slack identity interruption');
            }
            return created;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const service = new WorkspaceManagementService({
      identity: f.identity,
      config: interruptedConfig,
      management: f.management,
      setupBaseUrl: 'https://chickpea.test',
      randomCapability: () => CAPABILITY,
      randomId: () => 'slack_interrupted',
    });
    const input = {
      context: f.context,
      idempotencyKey: 'interrupted-slack-identity',
      operations: [{
        itemId: 'identity',
        kind: 'create_slack_identity' as const,
        identityId: 'slack_identity_interrupted',
        initialDmAgentId: 'agent_support',
        appName: 'Chickpea Interrupted',
        displayName: 'Interrupted',
      }],
    };
    await assert.rejects(
      () => service.applyWorkspaceChanges(input),
      /simulated Slack identity interruption/,
    );
    const ingressKey = (await f.config.getSlackIdentity(
      'slack_identity_interrupted',
    )).ingressKey;
    const replay = await service.applyWorkspaceChanges(input);
    assert.equal(replay.status, 'completed');
    assert.equal(
      (await f.config.getSlackIdentity('slack_identity_interrupted')).ingressKey,
      ingressKey,
    );
  } finally {
    f.close();
  }
});

test('a delegated Slack identity link completes signed setup without exposing secrets to MCP', async () => {
  const f = await fixture('slack-setup');
  const signingSecret = 'support-signing-secret';
  try {
    const requested = await f.service.applyWorkspaceChanges({
      context: f.context,
      idempotencyKey: 'create-and-connect-support',
      operations: [{
        itemId: 'identity',
        kind: 'create_slack_identity',
        identityId: 'slack_identity_support',
        initialDmAgentId: 'agent_support',
        appName: 'Chickpea Support',
        displayName: 'Support',
      }, {
        itemId: 'setup',
        dependsOn: ['identity'],
        kind: 'request_setup',
        target: { kind: 'slack_identity', identityId: 'slack_identity_support' },
      }],
    });
    const outcome = requested.outcomes[1]!;
    assert.equal(outcome.disposition, 'setup_required');
    const setupUrl = new URL(outcome.setupUrl!);
    const setupId = outcome.setupOperationId!;

    const draft = await f.config.getSlackIdentity('slack_identity_support');
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const rawBody = JSON.stringify({
      type: 'url_verification',
      challenge: 'challenge-support',
      api_app_id: 'A0SUPPORT',
      team_id: f.owner.user.slackTeamId,
    });
    const signature = `v0=${createHmac('sha256', signingSecret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest('hex')}`;
    assert.equal((await recordPendingSlackChallenge(f.settings, draft, {
      rawBody,
      signature,
      timestamp,
    })).accepted, true);

    const delivered: string[] = [];
    const app = createManagementSetupRoutes({
      management: f.management,
      config: f.config,
      settings: f.settings,
      identity: f.identity,
      deliverReceipt: async (record) => {
        delivered.push(JSON.stringify(record.receipt));
        return { deliveryRef: 'slack:dm:receipt' };
      },
      slackIdentityBootstrap: {
        authTest: async () => ({
          ok: true,
          error: undefined,
          appId: 'A0SUPPORT',
          teamId: f.owner.user.slackTeamId,
          teamName: 'Acme',
          botName: 'support',
          botUserId: 'USUPPORT',
          botId: 'BSUPPORT',
          grantedScopes: [...REQUIRED_SLACK_BOT_SCOPES],
        }),
        botIdentityInfo: async () => ({
          ok: true,
          error: undefined,
          displayName: 'Support',
          avatarUrl: 'https://avatars.slack-edge.com/support.png',
          appId: 'A0SUPPORT',
        }),
      },
    });

    const exchange = await app.request(`https://chickpea.test/setup/${setupId}/exchange`, {
      method: 'POST',
      headers: { origin: 'https://chickpea.test', 'content-type': 'application/json' },
      body: JSON.stringify({ capability: setupUrl.hash.slice('#setup='.length) }),
    });
    assert.equal(exchange.status, 200);
    const cookie = exchange.headers.get('set-cookie')!.split(';')[0]!;

    const summary = await app.request(`https://chickpea.test/setup/${setupId}`, {
      headers: { cookie },
    });
    const html = await summary.text();
    assert.match(html, /prefilled Slack app setup/);
    assert.match(html, /Slack bot token/);
    assert.doesNotMatch(html, new RegExp(signingSecret));

    const completed = await app.request(`https://chickpea.test/setup/${setupId}/complete`, {
      method: 'POST',
      headers: {
        cookie,
        origin: 'https://chickpea.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        botToken: 'xoxb-support',
        signingSecret,
      }).toString(),
    });
    assert.equal(completed.status, 303);
    const connected = await f.config.getSlackIdentity(draft.id);
    assert.equal(connected.lifecycle, 'connected');
    assert.equal(connected.botUserId, 'USUPPORT');

    const publicStatus = await f.service.getOperation(f.context, setupId);
    const serialized = JSON.stringify(publicStatus);
    assert.doesNotMatch(serialized, /xoxb-support|support-signing-secret/);
    assert.equal(delivered.length, 1);
    assert.match(delivered[0]!, /"connector":"Slack"/);
    assert.match(delivered[0]!, /"accountLabel":"Support"/);
    assert.deepEqual(
      (await f.config.listSlackIdentityAuditEvents({ subjectId: draft.id }))
        .map(({ eventType }) => eventType).sort(),
      [
        'slack_identity.setup_started',
        'slack_identity.credentials_connected',
        'slack_identity.setup_verified',
      ].sort(),
    );
  } finally {
    f.close();
  }
});
