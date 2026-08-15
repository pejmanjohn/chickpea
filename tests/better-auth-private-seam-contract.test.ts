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
import { nativePasswordPrimitive } from '../src/auth/password.ts';

const ORIGIN = 'https://chickpea.example';
const SECRET = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => (index * 71 + 19) % 256))
  .toString('base64url');
const COMPATIBILITY_RECORD = new URL(
  './fixtures/slack/slack-oauth-compatibility.json',
  import.meta.url,
);
const GENERATED_SCHEMA = new URL(
  './fixtures/better-auth/1.6.26/0001_better_auth.sql',
  import.meta.url,
);

test('U0 production seam and pinned bootstrap schema stay generated from one source', async () => {
  assert.equal(BETTER_AUTH_PRIVATE_SESSION_PATH, '/chickpea-private/issue-session');
  assert.equal(slackAccountId('T123', 'U456'), 'slack:T123:U456');
  const generated = await generateBetterAuthBootstrapSql();
  assert.equal(generated, await readFile(GENERATED_SCHEMA, 'utf8'));
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
    configurationToken: { status: string; receipt: null };
    confidentialBotAndOidc: { status: string; receipt: null };
    pkcePublicClient: { status: string; receipt: null };
  };
  redaction: {
    containsSecrets: boolean;
    containsSlackIdentifiers: boolean;
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
      password: nativePasswordPrimitive(),
      loginSourceAllowed: async () => true,
      loginIdentityAllowed: async () => true,
      sourceKey: () => 'contract-probe',
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

test('the compatibility record does not claim unperformed real-Slack proofs', async () => {
  const record = JSON.parse(await readFile(COMPATIBILITY_RECORD, 'utf8')) as CompatibilityRecord;
  assert.deepEqual(record.slack.expectedGrantModel, {
    botAndOidcGrants: 'separate',
    oidcScopes: ['openid', 'profile'],
    oidcEmailScopeAllowed: false,
    defaultClientMode: 'confidential',
    installerUserMustEqualOidcSubject: true,
    workspaceMustEqualBotInstall: true,
    slackAuthGrantsProductRole: false,
  });
  assert.deepEqual(record.slack.configurationToken, {
    status: 'pending-external-proof',
    receipt: null,
  });
  assert.deepEqual(record.slack.confidentialBotAndOidc, {
    status: 'pending-external-proof',
    receipt: null,
  });
  assert.deepEqual(record.slack.pkcePublicClient, {
    status: 'pending-external-proof',
    receipt: null,
  });
  assert.deepEqual(record.redaction, {
    containsSecrets: false,
    containsSlackIdentifiers: false,
  });
});

function rowCount(backend: NodeBetterAuthBackend, table: string): number {
  const row = backend.database.prepare(`SELECT count(*) AS count FROM "${table}"`).get() as {
    count: number;
  };
  return Number(row.count);
}
