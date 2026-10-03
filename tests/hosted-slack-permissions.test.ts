import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { OrganizationRole } from '../src/identity/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { SLACK_SETTING_KEYS, type SlackAuthTestResult } from '../src/slack/credentials.ts';
import {
  configureHostedSlackPermissionsUpdate,
  evaluateSlackPermissions,
  hostedSlackPermissionsUpdatePath,
  resetSlackPermissionsMemo,
  type SlackPermissionsEvidence,
} from '../src/slack/hosted-permissions.ts';
import { syncHostedWorkspaceInstallation } from '../src/slack/hosted-installation.ts';
import {
  invalidateSlackInstallationCredentialCache,
  writeHostedSlackBotCredentials,
} from '../src/slack/installation-credentials.ts';
import {
  missingRequestedSlackBotScopes,
  REQUESTED_SLACK_BOT_SCOPES,
  REQUIRED_SLACK_BOT_SCOPES,
  RETIRED_SLACK_BOT_SCOPES,
  SLACK_FEATURE_SCOPES,
  unexpectedSlackBotScopes,
} from '../src/slack/scopes.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

const TOKEN = 'hosted-slack-permissions-token';
const ORIGIN = 'https://hosted.example';
const ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_permissions' });
const WITHOUT_LISTS = REQUESTED_SLACK_BOT_SCOPES.filter((scope) => !SLACK_FEATURE_SCOPES.includes(scope));

function evidence(overrides: Partial<SlackPermissionsEvidence> = {}): SlackPermissionsEvidence {
  return {
    installationId: 'inst_a', revision: 'rev_1', grantedScopes: WITHOUT_LISTS, validatedAt: 1, ...overrides,
  };
}

/** A fake `auth.test` that counts calls and answers with the given header scopes. */
function liveSlack(answer: () => Partial<SlackAuthTestResult> | Error, now = () => 1_800_000_000_000) {
  const calls: string[] = [];
  const warnings: Array<Record<string, unknown>> = [];
  return {
    calls,
    warnings,
    dependencies: {
      now,
      botToken: async () => 'xoxb-live',
      authTest: async (token: string): Promise<SlackAuthTestResult> => {
        calls.push(token);
        const result = answer();
        if (result instanceof Error) throw result;
        return {
          ok: true, error: undefined, teamId: 'T1', teamName: undefined, botName: undefined, botUserId: 'UBOT',
          ...result,
        };
      },
      warn: (entry: Record<string, unknown>) => { warnings.push(entry); },
    },
  };
}

test('the scope gap names the requested scopes a grant lacks, and retired scopes are tolerated', () => {
  assert.deepEqual(missingRequestedSlackBotScopes(REQUESTED_SLACK_BOT_SCOPES), []);
  assert.deepEqual(missingRequestedSlackBotScopes(REQUIRED_SLACK_BOT_SCOPES), ['lists:read', 'lists:write']);
  const shuffled = [...REQUESTED_SLACK_BOT_SCOPES].reverse();
  assert.deepEqual(missingRequestedSlackBotScopes([...shuffled, ...shuffled]), [], 'order and duplicates do not matter');
  assert.deepEqual(missingRequestedSlackBotScopes(['chat:write'], ['chat:write', 'lists:read', 'lists:read']),
    ['lists:read']);

  // Lists stay a feature: a grant without them is accepted for reinstall and recovery.
  assert.deepEqual(SLACK_FEATURE_SCOPES, ['lists:read', 'lists:write']);
  assert.ok(SLACK_FEATURE_SCOPES.every((scope) => !REQUIRED_SLACK_BOT_SCOPES.includes(scope)));
  assert.deepEqual(RETIRED_SLACK_BOT_SCOPES, []);
  assert.deepEqual(unexpectedSlackBotScopes([...REQUESTED_SLACK_BOT_SCOPES, 'old:scope']), ['old:scope']);
  assert.deepEqual(unexpectedSlackBotScopes([...REQUESTED_SLACK_BOT_SCOPES, 'old:scope'], ['old:scope']), [],
    'a retired scope an older grant still holds is not unexpected');
  assert.deepEqual(unexpectedSlackBotScopes([...REQUESTED_SLACK_BOT_SCOPES, 'old:scope', 'admin:write'], ['old:scope']),
    ['admin:write'], 'an unknown scope is still unexpected');
});

test('a revision without validated scope evidence is unknown and asks Slack nothing', async (t) => {
  resetSlackPermissionsMemo();
  t.after(resetSlackPermissionsMemo);
  const slack = liveSlack(() => ({ grantedScopes: [...REQUESTED_SLACK_BOT_SCOPES] }));
  assert.equal(await evaluateSlackPermissions(undefined, slack.dependencies), 'unknown');
  assert.equal(await evaluateSlackPermissions(evidence({ validatedAt: null }), slack.dependencies), 'unknown');
  assert.equal(await evaluateSlackPermissions(evidence({ grantedScopes: [] }), slack.dependencies), 'unknown');
  assert.equal(await evaluateSlackPermissions(evidence({ grantedScopes: REQUESTED_SLACK_BOT_SCOPES }), slack.dependencies),
    'current');
  assert.deepEqual(slack.calls, [], 'no gap, no live check');
});

test('a gap Slack confirms needs an update, asked once per revision for ten minutes', async (t) => {
  resetSlackPermissionsMemo();
  t.after(resetSlackPermissionsMemo);
  let live: string[] = WITHOUT_LISTS;
  const slack = liveSlack(() => ({ grantedScopes: live }));
  for (let i = 0; i < 5; i++) {
    assert.equal(await evaluateSlackPermissions(evidence(), slack.dependencies), 'update_needed');
  }
  assert.equal(slack.calls.length, 1, 'one auth.test per installation and revision');

  // Slack changing underneath a settled gap does not move the bar within its ten minutes.
  live = [...REQUESTED_SLACK_BOT_SCOPES];
  assert.equal(await evaluateSlackPermissions(evidence(), slack.dependencies), 'update_needed');
  assert.equal(slack.calls.length, 1);

  // A new revision, another installation, or a changed requested set is a new question.
  live = WITHOUT_LISTS;
  assert.equal(await evaluateSlackPermissions(evidence({ revision: 'rev_2' }), slack.dependencies), 'update_needed');
  assert.equal(await evaluateSlackPermissions(evidence({ installationId: 'inst_b' }), slack.dependencies), 'update_needed');
  assert.equal(slack.calls.length, 3);
  assert.equal(await evaluateSlackPermissions(evidence(), slack.dependencies, [...REQUESTED_SLACK_BOT_SCOPES, 'future:scope']),
    'update_needed');
  assert.equal(slack.calls.length, 4);
  assert.equal(await evaluateSlackPermissions(evidence(), slack.dependencies, WITHOUT_LISTS), 'current',
    'a release that stops requesting the missing scope clears it without asking Slack');
  assert.equal(slack.calls.length, 4);
  assert.deepEqual(slack.warnings, []);
});

test('after ten minutes one live auth.test re-decides a gap, so a grant Cloud did not record clears the bar', async (t) => {
  resetSlackPermissionsMemo();
  t.after(resetSlackPermissionsMemo);
  let clock = 1_800_000_000_000;
  let live: string[] = WITHOUT_LISTS;
  const slack = liveSlack(() => ({ grantedScopes: live }), () => clock);
  assert.equal(await evaluateSlackPermissions(evidence(), slack.dependencies), 'update_needed');
  clock += 10 * 60_000 - 1;
  assert.equal(await evaluateSlackPermissions(evidence(), slack.dependencies), 'update_needed');
  assert.equal(slack.calls.length, 1, 'the gap stands for ten minutes');

  clock += 1;
  assert.equal(await evaluateSlackPermissions(evidence(), slack.dependencies), 'update_needed');
  assert.equal(slack.calls.length, 2, 'a gap Slack still confirms stands for another ten minutes');
  clock += 10 * 60_000 - 1;
  assert.equal(await evaluateSlackPermissions(evidence(), slack.dependencies), 'update_needed');
  assert.equal(slack.calls.length, 2);

  // An Owner approved in Slack as another account: Slack holds the scopes, the revision does not.
  live = [...REQUESTED_SLACK_BOT_SCOPES];
  clock += 1;
  assert.equal(await evaluateSlackPermissions(evidence(), slack.dependencies), 'current');
  assert.equal(slack.calls.length, 3, 'one live auth.test re-decides');
  assert.equal(slack.warnings.length, 1);

  // `current` stands for the revision.
  live = WITHOUT_LISTS;
  clock += 60 * 60_000;
  assert.equal(await evaluateSlackPermissions(evidence(), slack.dependencies), 'current');
  assert.equal(slack.calls.length, 3);
});

test('a gap Slack does not confirm is current and logged for operators, without scope names reaching the view', async (t) => {
  resetSlackPermissionsMemo();
  t.after(resetSlackPermissionsMemo);
  const slack = liveSlack(() => ({ grantedScopes: [...REQUESTED_SLACK_BOT_SCOPES] }));
  assert.equal(await evaluateSlackPermissions(evidence(), slack.dependencies), 'current');
  assert.equal(await evaluateSlackPermissions(evidence(), slack.dependencies), 'current');
  assert.equal(slack.calls.length, 1);
  assert.deepEqual(slack.warnings, [{
    event: 'chickpea.slack_permissions.stored_scopes_behind',
    installationId: 'inst_a',
    revision: 'rev_1',
    storedMissing: ['lists:read', 'lists:write'],
  }]);
});

test('when Slack cannot answer, the stored gap stands and is asked again next time', async (t) => {
  resetSlackPermissionsMemo();
  t.after(resetSlackPermissionsMemo);
  let answer: Partial<SlackAuthTestResult> | Error = new Error('slack unreachable');
  const slack = liveSlack(() => answer);
  assert.equal(await evaluateSlackPermissions(evidence(), slack.dependencies), 'update_needed');
  answer = {}; // no x-oauth-scopes header
  assert.equal(await evaluateSlackPermissions(evidence(), slack.dependencies), 'update_needed');
  answer = { ok: false, error: 'invalid_auth', grantedScopes: [...REQUESTED_SLACK_BOT_SCOPES] };
  assert.equal(await evaluateSlackPermissions(evidence(), slack.dependencies), 'update_needed');
  assert.equal(slack.calls.length, 3, 'nothing was memoized');
  assert.equal(await evaluateSlackPermissions(evidence(), { ...slack.dependencies, botToken: async () => undefined }),
    'update_needed');
  assert.equal(slack.calls.length, 3, 'no token, no call');
  answer = { grantedScopes: [...REQUESTED_SLACK_BOT_SCOPES] };
  assert.equal(await evaluateSlackPermissions(evidence(), slack.dependencies), 'current');
  assert.equal(slack.calls.length, 4);
});

test('the host update path must be same-origin', (t) => {
  t.after(() => configureHostedSlackPermissionsUpdate(undefined));
  assert.equal(hostedSlackPermissionsUpdatePath(), null);
  configureHostedSlackPermissionsUpdate({ path: '/start/reinstall' });
  assert.equal(hostedSlackPermissionsUpdatePath(), '/start/reinstall');
  for (const path of ['https://evil.example/x', '//evil.example/x', '/\\evil.example', 'start/reinstall', '/a"b', '/a b', '']) {
    assert.throws(() => configureHostedSlackPermissionsUpdate({ path }), /same-origin path/, path);
  }
  assert.equal(hostedSlackPermissionsUpdatePath(), '/start/reinstall', 'a refused path leaves the last good one');
  configureHostedSlackPermissionsUpdate(undefined);
  assert.equal(hostedSlackPermissionsUpdatePath(), null);
});

function principal(role: OrganizationRole): AuthPrincipal {
  return {
    userId: `user_${role}`, membershipId: `membership_${role}`, organizationId: 'org_oss', role,
    authenticatorKind: 'test_slack_session', credentialId: `session_${role}`, correlationId: `request_${role}`,
    machine: false,
  };
}

async function hostedInstallation(t: TestContext, grantedScopes: readonly string[]) {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const identity = new SqliteIdentityStore(':memory:');
  resetSlackPermissionsMemo();
  t.after(() => {
    config.close();
    settings.close();
    identity.close();
    invalidateSlackInstallationCredentialCache();
    resetSlackPermissionsMemo();
    configureHostedSlackPermissionsUpdate(undefined);
  });
  const credentials = { state: identity, keyring: generateCredentialKeyring() };
  const write = (expected: string | null, scopes: readonly string[]) => writeHostedSlackBotCredentials(credentials, expected, {
    botToken: 'xoxb-hosted-permissions', botUserId: 'UBOT', appId: 'AHOSTED1', teamId: 'TTEST',
    grantedScopes: [...scopes], validatedAt: Date.now(),
  });
  const revision = await write(null, grantedScopes);
  await syncHostedWorkspaceInstallation(ENV, { teamId: 'TTEST', appId: 'AHOSTED1', botUserId: 'UBOT' }, config);
  await settings.setSetting(SLACK_SETTING_KEYS.teamName, 'Tenant Workspace');
  let liveScopes: readonly string[] = grantedScopes;
  const authTests: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    assert.equal(new URL(request.url).pathname, '/api/auth.test');
    authTests.push(request.headers.get('authorization') ?? '');
    return Response.json(
      { ok: true, team_id: 'TTEST', team: 'Tenant Workspace', user_id: 'UBOT', app_id: 'AHOSTED1' },
      { headers: { 'x-oauth-scopes': liveScopes.join(',') } },
    );
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const view = async (role: OrganizationRole, env: Record<string, unknown> = ENV) => {
    const app = createAdminRoutes({
      store: config, settings, slackCredentials: credentials,
      ...testAdminAuthority(TOKEN, ORIGIN, identity, principal(role)),
    });
    const response = await app.request(`${ORIGIN}/admin/api/slack-connection`, { headers: testAdminHeaders(TOKEN) }, env);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return {
    config, view, authTests, revision, write,
    setLiveScopes(scopes: readonly string[]) { liveScopes = scopes; },
  };
}

test('hosted Slack status tells an Owner to update, an Admin to ask an Owner, and refuses a Member', async (t) => {
  const tenant = await hostedInstallation(t, WITHOUT_LISTS);
  configureHostedSlackPermissionsUpdate({ path: '/start/reinstall' });

  const owner = await tenant.view('owner');
  assert.equal(owner.status, 200);
  assert.deepEqual(owner.body.slackPermissions, { status: 'update_needed', canUpdate: true, updatePath: '/start/reinstall' });
  assert.doesNotMatch(JSON.stringify(owner.body), /lists:/, 'no scope name reaches Admin');

  const admin = await tenant.view('admin');
  assert.deepEqual(admin.body.slackPermissions, { status: 'update_needed', canUpdate: false, updatePath: '/start/reinstall' });
  assert.equal((await tenant.view('member')).status, 403);
  assert.equal(tenant.authTests.length, 1, 'the live check ran once for this revision');

  // Without the host's path there is nothing to offer and Admin shows no bar.
  configureHostedSlackPermissionsUpdate(undefined);
  assert.deepEqual((await tenant.view('owner')).body.slackPermissions,
    { status: 'update_needed', canUpdate: false, updatePath: null });

  // The update writes a new revision with the full grant; the bar clears without asking Slack.
  configureHostedSlackPermissionsUpdate({ path: '/start/reinstall' });
  await tenant.write(tenant.revision, REQUESTED_SLACK_BOT_SCOPES);
  tenant.setLiveScopes(REQUESTED_SLACK_BOT_SCOPES);
  assert.deepEqual((await tenant.view('owner')).body.slackPermissions,
    { status: 'current', canUpdate: true, updatePath: '/start/reinstall' });
  assert.equal(tenant.authTests.length, 1);
});

test('hosted Slack status is unknown for a revoked installation or one without scope evidence', async (t) => {
  const tenant = await hostedInstallation(t, WITHOUT_LISTS);
  configureHostedSlackPermissionsUpdate({ path: '/start/reinstall' });
  await tenant.config.updateWorkspaceInstallation('TTEST', { health: 'revoked', healthDetail: 'app_uninstalled' });
  assert.deepEqual((await tenant.view('owner')).body.slackPermissions,
    { status: 'unknown', canUpdate: true, updatePath: '/start/reinstall' });
  assert.equal(tenant.authTests.length, 0);

  const empty = await hostedInstallation(t, []);
  assert.deepEqual((await empty.view('admin')).body.slackPermissions,
    { status: 'unknown', canUpdate: false, updatePath: '/start/reinstall' });
  assert.equal(empty.authTests.length, 0);
});

test('standalone Slack status carries no permissions field', async (t) => {
  const tenant = await hostedInstallation(t, WITHOUT_LISTS);
  configureHostedSlackPermissionsUpdate({ path: '/start/reinstall' });
  const standalone = await tenant.view('owner', {});
  assert.equal(standalone.status, 200);
  assert.equal('slackPermissions' in standalone.body, false);
  assert.equal(standalone.body.hosted, undefined);
});
