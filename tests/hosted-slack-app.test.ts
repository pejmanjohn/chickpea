import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { applySlackUserChange } from '../src/auth/slack-membership-events.ts';
import {
  InstallationContextError,
  scopeInstallationEnv,
} from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import {
  HOSTED_SLACK_INSTALLATION_ID,
  WORKSPACE_SLACK_INSTALLATION_ID,
} from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import {
  describeSlackCredentialSources,
  readSlackConnectionRevision,
  readStoredSlackTeamInfo,
  resolveSlackCredentials,
} from '../src/slack/credentials.ts';
import {
  backfillHostedWorkspaceInstallation,
  recordFirstHostedSlackDelivery,
  syncHostedWorkspaceInstallation,
} from '../src/slack/hosted-installation.ts';
import {
  hostedSlackEventRoute,
  hostedSlackInteractionRoute,
  hostedSlackLifecycleOutcome,
  slackInstallationCredentialId,
  withHostedSlackApp,
} from '../src/slack/hosted-slack-app.ts';
import {
  invalidateSlackInstallationCredentialCache,
  promoteSlackCredentialBundle,
  readActiveSlackCredentialMetadata,
  resolveSlackInstallationCredentials,
  stageSlackCredentialBundle,
  writeHostedSlackBotCredentials,
} from '../src/slack/installation-credentials.ts';
import { resolveSlackInstallationExecutionContext } from '../src/slack/installation-execution.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

/**
 * The pieces a host serving many installations composes Slack from: its app
 * attached to an installation's env, the installation's own bot slot, the
 * routing and lifecycle rules for a verified delivery, and the workspace
 * record every Slack path looks up.
 */

const APP = { appId: 'AHOSTED1', signingSecret: 'hosted-app-signing-secret' };
const TEAM = 'TTENANT1';
const HOSTED = { CHICKPEA_TENANCY: 'installation' };
const ENV = scopeInstallationEnv(HOSTED, { installationId: 'inst_tenant_a' });

function installation(t: TestContext) {
  const identity = new SqliteIdentityStore(':memory:');
  const config = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => {
    identity.close();
    config.close();
    settings.close();
    invalidateSlackInstallationCredentialCache();
  });
  const credentials = { state: identity, keyring: generateCredentialKeyring() };
  return { identity, config, settings, credentials, resolution: { ...credentials, env: ENV } };
}

test('a host\'s app rides only on an installation env of a deployment serving many', () => {
  assert.throws(() => withHostedSlackApp({}, APP), InstallationContextError);
  assert.throws(() => withHostedSlackApp(HOSTED, { appId: 'not-an-app', signingSecret: 'x' }), InstallationContextError);
  assert.throws(() => withHostedSlackApp(HOSTED, { appId: APP.appId, signingSecret: ' ' }), InstallationContextError);
  const attached = withHostedSlackApp(ENV, APP);
  assert.equal(withHostedSlackApp(attached, { ...APP }), attached);
  assert.throws(() => withHostedSlackApp(attached, { ...APP, signingSecret: 'another' }), InstallationContextError);
  assert.equal(Object.isFrozen(attached), true);
  assert.deepEqual(Object.keys(attached).sort(), Object.keys(ENV).sort(), 'the app is no env variable');
  assert.equal(Object.isFrozen(ENV), true, 'the input is unchanged');
});

test('the credential slot follows the deployment, and the other mode\'s slot is refused', async (t) => {
  assert.equal(slackInstallationCredentialId(undefined), WORKSPACE_SLACK_INSTALLATION_ID);
  assert.equal(slackInstallationCredentialId({}), WORKSPACE_SLACK_INSTALLATION_ID);
  assert.equal(slackInstallationCredentialId(ENV), HOSTED_SLACK_INSTALLATION_ID);

  const { identity, settings, credentials, resolution } = installation(t);
  // Only a standalone bundle in this store: under tenancy it is never read.
  const standalone = await stageSlackCredentialBundle(credentials, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID, identityClass: 'workspace_installation',
    purpose: 'connected_credentials', expectedActiveRevision: null, appId: APP.appId, teamId: TEAM,
    secrets: { signingSecret: 'standalone-secret', botToken: 'xoxb-standalone' },
  });
  await promoteSlackCredentialBundle(credentials, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID, candidateRevision: standalone.revision, expectedActiveRevision: null,
  });
  await assert.rejects(resolveSlackInstallationCredentials(WORKSPACE_SLACK_INSTALLATION_ID, ENV, resolution),
    InstallationContextError);
  await assert.rejects(readActiveSlackCredentialMetadata(WORKSPACE_SLACK_INSTALLATION_ID, ENV, resolution),
    InstallationContextError);
  await assert.rejects(resolveSlackInstallationCredentials(HOSTED_SLACK_INSTALLATION_ID, {}, { ...credentials, env: {} }),
    InstallationContextError);
  assert.equal((await resolveSlackCredentials(ENV, undefined, resolution)).botToken, undefined,
    'a hosted installation without its own bot has none');

  await writeHostedSlackBotCredentials(credentials, null, {
    botToken: 'xoxb-hosted', botUserId: 'UBOT', appId: APP.appId, teamId: TEAM,
    grantedScopes: ['chat:write'], validatedAt: 1_800_000_000_000,
  });
  // The shared readers behind turns, memory, routines, attachments and Admin.
  assert.deepEqual(await resolveSlackCredentials(ENV, undefined, resolution),
    { botToken: 'xoxb-hosted', signingSecret: undefined, botUserId: 'UBOT' });
  assert.deepEqual(await describeSlackCredentialSources(ENV, undefined, resolution),
    { botToken: 'stored', signingSecret: 'missing', botUserId: 'stored' });
  assert.equal((await readStoredSlackTeamInfo(ENV, settings, resolution)).teamId, TEAM);
  const active = await identity.getActiveSlackCredentialRevision(HOSTED_SLACK_INSTALLATION_ID);
  assert.equal(await readSlackConnectionRevision(settings, resolution), active?.revision);
  // Standalone readers still find their own bundle.
  assert.equal((await resolveSlackCredentials(undefined, undefined, credentials)).botToken, 'xoxb-standalone');
});

test('a durable turn of a hosted installation runs as the installation\'s own bot', async (t) => {
  const { config, credentials, resolution } = installation(t);
  await writeHostedSlackBotCredentials(credentials, null, {
    botToken: 'xoxb-hosted', botUserId: 'UBOT', appId: APP.appId, teamId: TEAM,
    grantedScopes: ['chat:write'], validatedAt: 1_800_000_000_000,
  });
  await syncHostedWorkspaceInstallation(ENV, { teamId: TEAM, appId: APP.appId, botUserId: 'UBOT' }, config);
  const previousFetch = globalThis.fetch;
  const tokens: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    tokens.push(request.headers.get('authorization') ?? '');
    return Response.json({ ok: true, team_id: TEAM, user_id: 'UBOT', app_id: APP.appId, bot_id: 'BBOT' });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const context = await resolveSlackInstallationExecutionContext(TEAM, ENV, {
    config, credentialDependencies: resolution,
  });
  assert.equal(context.botToken, 'xoxb-hosted');
  assert.deepEqual(tokens, ['Bearer xoxb-hosted']);
});

test('a hosted deactivation is checked against the installation\'s own bot revision', async (t) => {
  const { identity, credentials } = installation(t);
  const owner = await createSlackOwner(identity, { teamId: TEAM, userId: 'U1' });
  await writeHostedSlackBotCredentials(credentials, null, {
    botToken: 'xoxb-hosted', botUserId: 'UBOT', appId: APP.appId, teamId: TEAM,
    grantedScopes: ['users:read'], validatedAt: 1_800_000_000_000,
  });
  const active = await identity.getActiveSlackCredentialRevision(HOSTED_SLACK_INSTALLATION_ID);
  const change = {
    identity, credentialRevision: active!.revision, payloadTeamId: TEAM, apiAppId: APP.appId,
    eventId: 'EvHostedUserChange',
    event: {
      type: 'user_change' as const, event_ts: '1800000000.000100',
      user: { id: 'U1', team_id: TEAM, deleted: true, is_bot: false, is_app_user: false },
    },
  };
  assert.equal((await applySlackUserChange(change)).outcome, 'ignored', 'the standalone slot holds no bot here');
  assert.equal((await applySlackUserChange({ ...change, credentialIdentityId: HOSTED_SLACK_INSTALLATION_ID })).outcome,
    'suspended');
  assert.equal((await identity.getMembershipAccessOverlay(owner.membership.id))?.accessStatus, 'suspended');
});

test('the receiving workspace comes from Slack\'s authorization, never from team_id alone', () => {
  const base = {
    team_id: TEAM, api_app_id: APP.appId, type: 'event_callback', event_id: 'Ev1',
    event: { type: 'message' },
    authorizations: [{ team_id: TEAM, is_enterprise_install: false }],
  };
  assert.deepEqual(hostedSlackEventRoute(base), { route: 'installation', teamId: TEAM });
  assert.deepEqual(hostedSlackEventRoute({ ...base, context_team_id: TEAM }), { route: 'installation', teamId: TEAM });
  // Without an authorization, team_id stands only outside a channel shared between organizations.
  assert.deepEqual(hostedSlackEventRoute({ ...base, authorizations: undefined }), { route: 'installation', teamId: TEAM });
  const drops: Array<[unknown, string]> = [
    [{ ...base, authorizations: [{ team_id: null, enterprise_id: 'E1', is_enterprise_install: true }] }, 'enterprise'],
    [{ ...base, context_team_id: 'TOTHER' }, 'context_mismatch'],
    // An event that happened in another organization's workspace, seen through this installation.
    [{ ...base, team_id: 'TOTHER' }, 'foreign_team'],
    [{ ...base, authorizations: undefined, is_ext_shared_channel: true }, 'shared_without_authorization'],
    [{ ...base, authorizations: [], is_ext_shared_channel: true }, 'shared_without_authorization'],
    [{ ...base, authorizations: undefined, context_team_id: 'TOTHER' }, 'context_mismatch'],
    [{ ...base, authorizations: [{ is_enterprise_install: false }] }, 'malformed'],
    [{ ...base, authorizations: 'T1' }, 'malformed'],
    [{ ...base, team_id: undefined }, 'malformed'],
    [{ type: 'url_verification', challenge: 'x' }, 'malformed'],
    [null, 'malformed'],
  ];
  for (const [payload, reason] of drops) {
    assert.deepEqual(hostedSlackEventRoute(payload), { route: 'drop', reason }, JSON.stringify(payload));
  }

  assert.deepEqual(hostedSlackInteractionRoute({ type: 'block_actions', team: { id: TEAM } }),
    { route: 'installation', teamId: TEAM });
  assert.deepEqual(hostedSlackInteractionRoute({ type: 'block_actions', team: { id: TEAM }, is_enterprise_install: true }),
    { route: 'drop', reason: 'enterprise' });
  assert.deepEqual(hostedSlackInteractionRoute({ type: 'view_submission', team: { id: 'lowercase' } }),
    { route: 'drop', reason: 'malformed' });
  assert.deepEqual(hostedSlackInteractionRoute('payload'), { route: 'drop', reason: 'malformed' });
});

test('only an installation\'s own bot token ends it, and an event older than the installation is stale', () => {
  const installed = { installedAt: 1_800_000_000_500, botUserId: 'UBOT' };
  const at = (seconds: number, event: Record<string, unknown>) => ({ event_time: seconds, event });
  assert.equal(hostedSlackLifecycleOutcome(at(1_800_000_000, { type: 'app_uninstalled' }), installed), 'end',
    'the installation\'s own second still counts');
  assert.equal(hostedSlackLifecycleOutcome(at(1_799_999_999, { type: 'app_uninstalled' }), installed), 'stale');
  assert.equal(hostedSlackLifecycleOutcome(at(1_799_999_999, {
    type: 'tokens_revoked', tokens: { bot: ['UBOT'] },
  }), installed), 'stale');
  assert.equal(hostedSlackLifecycleOutcome(at(1_800_000_100, {
    type: 'tokens_revoked', tokens: { oauth: ['U1'], bot: [] },
  }), installed), 'user_tokens_only');
  assert.equal(hostedSlackLifecycleOutcome(at(1_800_000_100, {
    type: 'tokens_revoked', tokens: { oauth: [], bot: ['UOTHERBOT'] },
  }), installed), 'user_tokens_only');
  assert.equal(hostedSlackLifecycleOutcome(at(1_800_000_100, {
    type: 'tokens_revoked', tokens: { bot: ['UBOT'] },
  }), installed), 'end');
  assert.equal(hostedSlackLifecycleOutcome(at(1_800_000_100, {
    type: 'tokens_revoked', tokens: { bot: ['UANY'] },
  }), { installedAt: installed.installedAt }), 'end', 'without a known bot, any bot revocation ends it');
  assert.equal(hostedSlackLifecycleOutcome({ event: { type: 'app_uninstalled' } }, installed), 'end');
  assert.equal(hostedSlackLifecycleOutcome(at(1_800_000_100, { type: 'message' }), installed), undefined);
});

test('the workspace record a host writes is idempotent, materializes the Chickpea Agent and refuses what it does not own', async (t) => {
  const { config } = installation(t);
  const first = await syncHostedWorkspaceInstallation(ENV, { teamId: TEAM, appId: APP.appId, botUserId: 'UBOT' }, config);
  assert.equal(first.transportMode, 'direct');
  assert.equal(first.appId, APP.appId);
  assert.equal(first.botUserId, 'UBOT');
  assert.equal(first.runtimeContract, 'chickpea-v1');
  assert.deepEqual({ health: first.health, detail: first.healthDetail },
    { health: 'needs_attention', detail: 'events_verification_pending' }, 'it waits for events');
  assert.ok((await config.listAgents()).some(({ id }) => id === first.defaultAgentId));
  assert.ok(await config.getWorkspaceModelDefault(TEAM));

  const again = await syncHostedWorkspaceInstallation(ENV, { teamId: TEAM, appId: APP.appId, botUserId: 'UBOT' }, config);
  assert.equal(again.revision, first.revision, 'a repeat writes nothing');
  await config.updateWorkspaceInstallation(TEAM, { health: 'healthy', healthDetail: null });
  const rebot = await syncHostedWorkspaceInstallation(ENV, { teamId: TEAM, appId: APP.appId, botUserId: 'UBOT2' }, config);
  assert.equal(rebot.botUserId, 'UBOT2');
  assert.equal(rebot.health, 'healthy', 'a new bot user keeps the health its events proved');

  const refusals: Array<[Parameters<typeof syncHostedWorkspaceInstallation>[1], RegExp]> = [
    [{ teamId: 'TOTHER', appId: APP.appId, botUserId: 'UBOT' }, /already connected/],
    [{ teamId: TEAM, appId: 'AOTHERAPP', botUserId: 'UBOT' }, /another Slack workspace or app/],
    [{ teamId: 'lower', appId: APP.appId, botUserId: 'UBOT' }, /malformed/],
  ];
  for (const [input, refusal] of refusals) {
    await assert.rejects(syncHostedWorkspaceInstallation(ENV, input, config), refusal);
  }
  await assert.rejects(
    syncHostedWorkspaceInstallation({}, { teamId: TEAM, appId: APP.appId, botUserId: 'UBOT' }, config),
    InstallationContextError,
  );
  await config.updateWorkspaceInstallation(TEAM, { transportMode: 'gateway', gatewayBindingId: 'binding1' });
  await assert.rejects(
    syncHostedWorkspaceInstallation(ENV, { teamId: TEAM, appId: APP.appId, botUserId: 'UBOT2' }, config), /gateway/);
  await config.updateWorkspaceInstallation(TEAM, {
    transportMode: 'direct', gatewayBindingId: null, health: 'revoked', healthDetail: 'app_uninstalled',
  });
  await assert.rejects(
    syncHostedWorkspaceInstallation(ENV, { teamId: TEAM, appId: APP.appId, botUserId: 'UBOT2' }, config), /ended/);
});

test('a record left waiting by an interrupted first write is finished by the next one', async (t) => {
  const { config } = installation(t);
  await config.ensureWorkspaceInstallation({
    workspaceId: TEAM, transportMode: 'direct', teamId: TEAM, appId: APP.appId, botUserId: 'UBOT',
  });
  const finished = await syncHostedWorkspaceInstallation(ENV, { teamId: TEAM, appId: APP.appId, botUserId: 'UBOT' }, config);
  assert.equal(finished.healthDetail, 'events_verification_pending');
});

test('the first delivery marks a waiting record healthy once, and never revives an ended one', async (t) => {
  const { config } = installation(t);
  const waiting = await syncHostedWorkspaceInstallation(ENV, { teamId: TEAM, appId: APP.appId, botUserId: 'UBOT' }, config);
  await recordFirstHostedSlackDelivery(config, waiting);
  const healthy = await config.getWorkspaceInstallation(TEAM);
  assert.equal(healthy?.health, 'healthy');
  // A second delivery that read the waiting record loses the race quietly.
  await recordFirstHostedSlackDelivery(config, waiting);
  await recordFirstHostedSlackDelivery(config, healthy!);
  assert.equal((await config.getWorkspaceInstallation(TEAM))?.revision, healthy?.revision);
  const ended = await config.updateWorkspaceInstallation(TEAM, { health: 'revoked', healthDetail: 'app_uninstalled' });
  await recordFirstHostedSlackDelivery(config, ended);
  assert.equal((await config.getWorkspaceInstallation(TEAM))?.health, 'revoked');
});

test('an installation provisioned before hosts wrote its record is backfilled from its own bot', async (t) => {
  const { config, credentials, resolution } = installation(t);
  await assert.rejects(
    backfillHostedWorkspaceInstallation(ENV, { teamId: TEAM, appId: APP.appId }, { config, credentials: resolution }),
    /no bot credentials/,
  );
  await writeHostedSlackBotCredentials(credentials, null, {
    botToken: 'xoxb-hosted', botUserId: 'UBOT', appId: APP.appId, teamId: TEAM,
    grantedScopes: ['chat:write'], validatedAt: 1_800_000_000_000,
  });
  for (const expected of [{ teamId: TEAM, appId: 'AOTHERAPP' }, { teamId: 'TOTHER', appId: APP.appId }]) {
    await assert.rejects(
      backfillHostedWorkspaceInstallation(ENV, expected, { config, credentials: resolution }), /no bot credentials/);
  }
  const { installation: record, botUserId } = await backfillHostedWorkspaceInstallation(
    ENV, { teamId: TEAM, appId: APP.appId }, { config, credentials: resolution },
  );
  assert.equal(botUserId, 'UBOT');
  assert.equal(record.botUserId, 'UBOT');
  assert.equal(record.healthDetail, 'events_verification_pending');
  await assert.rejects(
    backfillHostedWorkspaceInstallation({}, { teamId: TEAM, appId: APP.appId }, { config, credentials: resolution }),
    InstallationContextError,
  );
});
