import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { betterAuth } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { getOrgAdapter } from 'better-auth/plugins';

import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { createBetterAuthPublicHandler } from '../src/auth/better-auth-routes.ts';
import {
  BETTER_AUTH_PRIVATE_SESSION_PATH,
  slackAccountId,
} from '../src/auth/better-auth.ts';
import { generateBetterAuthBootstrapSql } from '../scripts/generate-better-auth-bootstrap.ts';

const ORIGIN = 'https://chickpea.example';
const SECRET = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => (index * 71 + 19) % 256))
  .toString('base64url');
const COMPATIBILITY_RECORD = new URL(
  './fixtures/slack/slack-oauth-compatibility.json',
  import.meta.url,
);
const ACCEPTED_SLACK_MANIFEST = new URL(
  './fixtures/slack/slack-oauth-accepted-manifest.json',
  import.meta.url,
);
const GENERATED_SCHEMA = new URL(
  './fixtures/better-auth/1.6.26/0001_better_auth.sql',
  import.meta.url,
);
const COMMITTED_SCHEMA = new URL(
  '../migrations/better-auth/0001_better_auth.sql',
  import.meta.url,
);

test('U0 production seam and pinned bootstrap schema stay generated from one source', async () => {
  assert.equal(BETTER_AUTH_PRIVATE_SESSION_PATH, '/chickpea-private/issue-session');
  assert.equal(slackAccountId('T123', 'U456'), 'slack:T123:U456');
  const generated = await generateBetterAuthBootstrapSql();
  assert.equal(generated, await readFile(GENERATED_SCHEMA, 'utf8'));
  assert.equal(generated, await readFile(COMMITTED_SCHEMA, 'utf8'));
  assert.match(generated, /account_providerId_accountId_uidx/);
  assert.match(generated, /member_organizationId_userId_uidx/);
});

interface CompatibilityRecord {
  schemaVersion: number;
  betterAuth: {
    package: string;
    version: string;
    localContract: {
      reconciliation: string;
      sessionIssuance: string;
      publicBoundary: string;
    };
    sourcePins: Array<{ path: string; sha256: string }>;
    localSourcePins: Array<{ path: string; sha256: string }>;
  };
  slack: {
    expectedGrantModel: {
      botAndOidcGrants: string;
      oidcScopes: string[];
      oidcEmailScopeAllowed: boolean;
      defaultClientMode: string;
      installerUserMustEqualOidcSubject: boolean;
      workspaceMustEqualBotInstall: boolean;
      slackAuthGrantsProductRole: boolean;
    };
    configurationToken: {
      status: string;
      receipt: {
        observedAt: string;
        lifetimeHours: number;
        createdProgrammatically: boolean;
        accessTokenPersisted: boolean;
        refreshTokenPersisted: boolean;
        acceptedManifestFixture: string;
        appHash: string;
        creatorSlackRole: { isAdmin: boolean; isOwner: boolean };
        ordinaryMemberRoleRequirementProven: boolean;
      };
    };
    confidentialBotAndOidc: {
      status: string;
      receipt: {
        bot: Record<string, unknown>;
        oidc: Record<string, unknown>;
        sameApp: boolean;
        sameWorkspace: boolean;
        exactInstaller: boolean;
      };
    };
    pkcePublicClient: {
      status: string;
      receipt: {
        settingOneWay: boolean;
        canonicalClientMode: string;
        bot: Record<string, unknown>;
        oidc: Record<string, unknown>;
      };
    };
    capabilities: {
      status: string;
      receipt: Record<string, unknown>;
      externalLimitations: string[];
    };
  };
  redaction: {
    containsSecrets: boolean;
    containsSlackIdentifiers: boolean;
    identifierEncoding: string;
  };
}

test('Better Auth 1.6.26 source and public exports stay pinned to the reviewed private seam', async () => {
  const record = JSON.parse(await readFile(COMPATIBILITY_RECORD, 'utf8')) as CompatibilityRecord;
  const repositoryPackage = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  const lock = JSON.parse(
    await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'),
  ) as { packages?: Record<string, { version?: string }> };

  assert.equal(record.schemaVersion, 1);
  assert.equal(record.betterAuth.package, 'better-auth');
  assert.equal(record.betterAuth.version, '1.6.26');
  assert.deepEqual(record.betterAuth.localContract, {
    reconciliation: 'verified-local',
    sessionIssuance: 'verified-local',
    publicBoundary: 'verified-local',
  });
  assert.equal(repositoryPackage.dependencies?.['better-auth'], '1.6.26');
  assert.equal(repositoryPackage.dependencies?.['@better-auth/core'], undefined,
    'the private seam must not import an undeclared Better Auth transitive package');
  assert.equal(lock.packages?.['node_modules/better-auth']?.version, '1.6.26');
  assert.equal(typeof betterAuth, 'function');
  assert.equal(typeof createAuthEndpoint, 'function');
  assert.equal(typeof setSessionCookie, 'function');
  assert.equal(typeof getOrgAdapter, 'function');

  const packageRoot = new URL('../', import.meta.resolve('better-auth'));
  for (const pin of record.betterAuth.sourcePins) {
    const source = await readFile(new URL(pin.path, packageRoot));
    assert.equal(
      createHash('sha256').update(source).digest('hex'),
      pin.sha256,
      `${pin.path} changed in the installed Better Auth package`,
    );
  }
  for (const pin of record.betterAuth.localSourcePins) {
    const source = await readFile(new URL(`../${pin.path}`, import.meta.url));
    assert.equal(
      createHash('sha256').update(source).digest('hex'),
      pin.sha256,
      `${pin.path} changed without refreshing the U0 compatibility record`,
    );
  }
});

test('the public allowlist rejects a direct generic OAuth callback probe', async () => {
  const backend = new NodeBetterAuthBackend(':memory:');
  try {
    const publicHandler = createBetterAuthPublicHandler({
      backend,
      baseURL: ORIGIN,
      secret: SECRET,
    });

    const response = await publicHandler(new Request(
      `${ORIGIN}/api/auth/callback/slack-oidc?code=redacted&state=redacted`,
    ));
    assert.equal(response.status, 404);
    assert.equal(response.headers.has('set-cookie'), false);
    assert.equal(rowCount(backend, 'session'), 0);
    assert.equal(rowCount(backend, 'user'), 0);
  } finally {
    backend.close();
  }
});

test('the U11 compatibility record truthfully pins real-Slack proof and external limits', async () => {
  const record = JSON.parse(await readFile(COMPATIBILITY_RECORD, 'utf8')) as CompatibilityRecord;
  const accepted = JSON.parse(await readFile(ACCEPTED_SLACK_MANIFEST, 'utf8')) as {
    schemaVersion: number;
    evidence: string;
    manifest: {
      features: { agent_view?: unknown };
      oauth_config: {
        redirect_urls: string[];
        scopes: { bot: string[]; user: string[] };
        pkce_enabled?: boolean;
      };
      settings: { event_subscriptions: { request_url: string; bot_events: string[] } };
    };
    slackNormalization: {
      autoAddedBotScopes: string[];
      disposablePkceExportValue: boolean;
      pkceExcludedFromCanonicalManifest: boolean;
    };
  };
  assert.deepEqual(record.slack.expectedGrantModel, {
    botAndOidcGrants: 'separate',
    oidcScopes: ['openid', 'profile'],
    oidcEmailScopeAllowed: false,
    defaultClientMode: 'confidential',
    installerUserMustEqualOidcSubject: true,
    workspaceMustEqualBotInstall: true,
    slackAuthGrantsProductRole: false,
  });
  assert.equal(record.slack.configurationToken.status, 'verified-real-slack');
  assert.equal(record.slack.configurationToken.receipt.createdProgrammatically, true);
  assert.equal(record.slack.configurationToken.receipt.lifetimeHours, 12);
  assert.equal(record.slack.configurationToken.receipt.accessTokenPersisted, false);
  assert.equal(record.slack.configurationToken.receipt.refreshTokenPersisted, false);
  assert.equal(record.slack.configurationToken.receipt.ordinaryMemberRoleRequirementProven, false);
  assert.equal(
    record.slack.configurationToken.receipt.acceptedManifestFixture,
    'tests/fixtures/slack/slack-oauth-accepted-manifest.json',
  );

  assert.equal(record.slack.confidentialBotAndOidc.status, 'verified-real-slack');
  assert.equal(record.slack.confidentialBotAndOidc.receipt.sameApp, true);
  assert.equal(record.slack.confidentialBotAndOidc.receipt.sameWorkspace, true);
  assert.equal(record.slack.confidentialBotAndOidc.receipt.exactInstaller, true);
  assert.deepEqual(record.slack.confidentialBotAndOidc.receipt.bot, {
    endpoint: 'oauth.v2.access',
    tokenAuthMethod: 'client_secret_post',
    tokenType: 'bot',
    grantedScopes: accepted.manifest.oauth_config.scopes.bot,
    appHash: 'sha256:301d549546166f4d',
    teamHash: 'sha256:368bfd413933c2c4',
    installerHash: 'sha256:716d77d653583290',
    botUserHash: 'sha256:79b6b15d885714cc',
    authTestAgreement: true,
    directoryListOk: true,
    channelListOk: true,
  });
  assert.deepEqual(record.slack.confidentialBotAndOidc.receipt.oidc, {
    endpoint: 'openid.connect.token',
    tokenAuthMethod: 'client_secret_post',
    issuer: 'https://slack.com',
    claimNames: [
      'at_hash',
      'aud',
      'auth_time',
      'exp',
      'family_name',
      'given_name',
      'https://slack.com/team_domain',
      'https://slack.com/team_id',
      'https://slack.com/team_image_230',
      'https://slack.com/team_image_default',
      'https://slack.com/team_name',
      'https://slack.com/user_id',
      'iat',
      'iss',
      'locale',
      'name',
      'nonce',
      'picture',
      'sub',
    ],
    audienceHash: 'sha256:b803dc33172f4e40',
    azpPresent: false,
    nonceAgreement: true,
    emailClaimPresent: false,
    subjectHash: 'sha256:716d77d653583290',
    teamHash: 'sha256:368bfd413933c2c4',
    userHash: 'sha256:716d77d653583290',
    userInfoAgreement: true,
  });

  assert.equal(record.slack.pkcePublicClient.status, 'tested-incompatibility');
  assert.equal(record.slack.pkcePublicClient.receipt.settingOneWay, true);
  assert.equal(record.slack.pkcePublicClient.receipt.canonicalClientMode, 'confidential');
  assert.deepEqual(record.slack.pkcePublicClient.receipt.bot, {
    tokenAuthMethod: 'none+S256',
    success: true,
    distinctVerifier: true,
  });
  assert.deepEqual(record.slack.pkcePublicClient.receipt.oidc, {
    tokenAuthMethod: 'none+S256',
    success: false,
    distinctVerifier: true,
    attempts: 2,
    slackError: 'internal_error',
  });

  assert.equal(record.slack.capabilities.status, 'partial-real-slack-proof');
  assert.deepEqual(record.slack.capabilities.receipt, {
    usersListOk: true,
    usersInfoOk: true,
    selectableHumanCount: 2,
    selectableNonInstallerHash: 'sha256:034cca8ea29a63f5',
    channelListOk: true,
    signedUrlVerification: true,
    signedUserChangeDeactivation: false,
    approvalRequiredResume: false,
    visibleSlackOidcConsent: true,
  });
  assert.deepEqual(record.slack.capabilities.externalLimitations, [
    'no proven disposable second Acme user was available for a deactivation event',
    'no separate approval-required requester and approver session was available',
  ]);

  assert.equal(accepted.schemaVersion, 1);
  assert.equal(accepted.evidence, 'redacted-real-slack-export');
  assert.ok(accepted.manifest.features.agent_view);
  assert.deepEqual(accepted.manifest.oauth_config.scopes.user, ['openid', 'profile']);
  assert.deepEqual(accepted.manifest.oauth_config.scopes.bot, [
    'app_mentions:read',
    'assistant:write',
    'channels:history',
    'channels:join',
    'channels:read',
    'chat:write',
    'files:write',
    'groups:history',
    'groups:read',
    'im:history',
    'mpim:read',
    'reactions:read',
    'reactions:write',
    'users:read',
  ]);
  assert.deepEqual(accepted.manifest.oauth_config.redirect_urls, [
    'https://u11.example/callback/bot',
    'https://u11.example/callback/oidc',
  ]);
  assert.equal(accepted.manifest.settings.event_subscriptions.request_url, 'https://u11.example/events');
  assert.ok(accepted.manifest.settings.event_subscriptions.bot_events.includes('user_change'));
  assert.equal(accepted.manifest.oauth_config.pkce_enabled, undefined);
  assert.deepEqual(accepted.slackNormalization, {
    autoAddedBotScopes: ['mpim:read'],
    disposablePkceExportValue: true,
    pkceExcludedFromCanonicalManifest: true,
  });
  assert.deepEqual(record.redaction, {
    containsSecrets: false,
    containsSlackIdentifiers: false,
    identifierEncoding: 'sha256-truncated-16-hex',
  });
  for (const serialized of [JSON.stringify(record), JSON.stringify(accepted)]) {
    assert.doesNotMatch(serialized, /xox[a-z.-]*[A-Za-z0-9-]+/i);
    assert.doesNotMatch(serialized, /\b[ATUBCW][A-Z0-9]{8,}\b/);
    assert.doesNotMatch(serialized, /\b\d{8,}\.\d{8,}\b/);
  }
});

function rowCount(backend: NodeBetterAuthBackend, table: string): number {
  const row = backend.database.prepare(`SELECT count(*) AS count FROM "${table}"`).get() as {
    count: number;
  };
  return Number(row.count);
}
