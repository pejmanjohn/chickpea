import assert from 'node:assert/strict';
import test from 'node:test';
import { apiOAuthSettingKeys, connectionAccountOAuthRef } from '../src/config/api-oauth.ts';
import { googleWorkspaceApiPolicy } from '../src/config/api-oauth-policy.ts';
import { mcpOAuthSettingKeys } from '../src/config/mcp-oauth.ts';
import { OAUTH_KEEPALIVE_AGE_MS } from '../src/config/oauth-shared.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { ConnectionAccount } from '../src/config/types.ts';
import {
  isOAuthKeepAliveDue,
  isOAuthKeepAliveMinute,
  runOAuthKeepAliveSweep,
} from '../src/connections/oauth-keepalive.ts';

const SERVER_URL = 'https://mcp.example.test/mcp';
const MCP_TOKEN_ENDPOINT = 'https://auth.example.test/token';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const NOW = Date.UTC(2026, 8, 30, 6, 10);
const HOUR = 60 * 60_000;
const WORKSPACE = 'T_KEEP';

function mcpBundle(obtainedAt: number, options: { refreshToken?: boolean; expiresIn?: number } = {}): string {
  return JSON.stringify({
    serverUrl: SERVER_URL,
    authorizationServerUrl: 'https://auth.example.test',
    metadata: {
      issuer: 'https://auth.example.test',
      authorization_endpoint: 'https://auth.example.test/authorize',
      token_endpoint: MCP_TOKEN_ENDPOINT,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
    },
    resource: SERVER_URL,
    clientInformation: { client_id: 'registered-client' },
    tokens: {
      access_token: 'access-old', token_type: 'Bearer', expires_in: options.expiresIn ?? 3_600,
      ...(options.refreshToken === false ? {} : { refresh_token: 'refresh-old' }),
    },
    obtainedAt,
  });
}

function googleBundle(obtainedAt: number): string {
  return JSON.stringify({
    provider: 'google', accessToken: 'google-old', refreshToken: 'google-refresh',
    tokenType: 'Bearer', expiresIn: 3_600, obtainedAt,
  });
}

function mcpAccount(id: string, lifecycle: ConnectionAccount['lifecycle'] = 'ready') {
  return {
    id, workspaceId: WORKSPACE, ownerKind: 'team' as const, createdByMembershipId: 'member_owner',
    providerId: 'errors', label: id, lifecycle, secretRefId: `secret_${id}`,
    policy: {
      kind: 'mcp' as const, url: SERVER_URL, transport: 'streamable-http' as const, authMode: 'oauth' as const,
      headerNames: [], discoveredTools: [{ name: 'list_errors' }], allowedTools: ['list_errors'],
    },
  };
}

async function fixture() {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  await config.createAgent({
    id: 'agent_keep', name: 'Keep', instructions: 'Watch errors', enabled: true,
    creatorMembershipId: 'member_owner', editPolicy: 'creator_and_admins',
    skills: [], apiConnections: [], repositories: [],
    mcpServers: [{
      id: 'legacy', displayName: 'Legacy', url: SERVER_URL, transport: 'streamable-http',
      authMode: 'oauth', headerNames: [], enabled: true, lifecycleStatus: 'ready',
      statusText: 'Connected', discoveredTools: [], allowedTools: [],
    }],
  });
  await config.ensureWorkspaceInstallation({ workspaceId: WORKSPACE, transportMode: 'direct', defaultAgentId: 'agent_keep' });
  const stale = NOW - OAUTH_KEEPALIVE_AGE_MS - 60_000;
  const tokenKeys: Record<string, string> = {};
  const accounts: Record<string, ConnectionAccount> = {};
  for (const [id, lifecycle, bundle] of [
    // Still valid for a day, but unrenewed for over eight hours.
    ['connection_idle', 'ready', mcpBundle(stale, { expiresIn: 86_400 })],
    ['connection_recent', 'ready', mcpBundle(NOW - HOUR)],
    ['connection_parked', 'needs_attention', mcpBundle(stale)],
    ['connection_access_only', 'ready', mcpBundle(stale, { refreshToken: false })],
  ] as const) {
    accounts[id] = await config.putConnectionAccount(mcpAccount(id, lifecycle), 0);
    tokenKeys[id] = mcpOAuthSettingKeys(connectionAccountOAuthRef(id))[2];
    await settings.setSetting(tokenKeys[id]!, bundle);
  }
  const oauthScopes = ['https://www.googleapis.com/auth/gmail.readonly'];
  accounts.connection_mail = await config.putConnectionAccount({
    id: 'connection_mail', workspaceId: WORKSPACE, ownerKind: 'team', createdByMembershipId: 'member_owner',
    providerId: 'google', label: 'Mail', lifecycle: 'ready', secretRefId: 'secret_mail',
    policy: { kind: 'api', authMode: 'oauth', oauthProvider: 'google', oauthScopes, ...googleWorkspaceApiPolicy(oauthScopes) },
  }, 0);
  const mailKeys = apiOAuthSettingKeys(connectionAccountOAuthRef('connection_mail'));
  await settings.setSetting(mailKeys[0], JSON.stringify({ provider: 'google', clientId: 'client', clientSecret: 'secret' }));
  await settings.setSetting(mailKeys[2], googleBundle(stale));
  tokenKeys.connection_mail = mailKeys[2];
  tokenKeys.legacy = mcpOAuthSettingKeys({ agentId: 'agent_keep', connectionId: 'legacy' })[2];
  // The oldest credential, though enumerated last.
  await settings.setSetting(tokenKeys.legacy!, mcpBundle(stale - HOUR / 2));

  const requests: string[] = [];
  let googleResponse = (): Response =>
    Response.json({ access_token: 'google-new', token_type: 'Bearer', expires_in: 3_600 });
  let mcpResponse = (): Response => Response.json({
    access_token: 'access-new', token_type: 'Bearer', expires_in: 3_600, refresh_token: 'refresh-new',
  });
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new Request(input, init).url;
    requests.push(url);
    if (url === MCP_TOKEN_ENDPOINT) return mcpResponse();
    if (url === GOOGLE_TOKEN_ENDPOINT) return googleResponse();
    throw new Error(`unexpected request ${url}`);
  };
  const events: Array<Record<string, unknown>> = [];
  const obtainedAt = async (id: string) =>
    (JSON.parse((await settings.getSetting(tokenKeys[id]!))!) as { obtainedAt: number }).obtainedAt;
  return {
    config, settings, accounts, tokenKeys, requests, events, obtainedAt, stale,
    rejectMcpRefresh(response: () => Response) { mcpResponse = response; },
    rejectGoogleRefresh(response: () => Response) { googleResponse = response; },
    sweep: (maxRenewals?: number) => runOAuthKeepAliveSweep({
      config, settings, fetchFn, now: () => NOW,
      emit: (event) => events.push(event as unknown as Record<string, unknown>),
      ...(maxRenewals === undefined ? {} : { maxRenewals }),
    }),
    close() { config.close(); settings.close(); },
  };
}

test('keep-alive is due after eight hours, then retried each sweep for an hour and hourly after', () => {
  const issued = 0;
  const due = OAUTH_KEEPALIVE_AGE_MS;
  assert.equal(isOAuthKeepAliveDue(issued, due - 1), false);
  assert.equal(isOAuthKeepAliveDue(issued, due), true);
  assert.equal(isOAuthKeepAliveDue(issued, due + 50 * 60_000), true);
  assert.equal(isOAuthKeepAliveDue(issued, due + HOUR + 5 * 60_000), true);
  assert.equal(isOAuthKeepAliveDue(issued, due + HOUR + 20 * 60_000), false);
  assert.equal(isOAuthKeepAliveDue(issued, due + 3 * HOUR + 9 * 60_000), true);
  assert.equal(isOAuthKeepAliveMinute(Date.UTC(2026, 8, 30, 6, 20)), true);
  assert.equal(isOAuthKeepAliveMinute(Date.UTC(2026, 8, 30, 6, 21)), false);
});

test('the sweep renews only idle refreshable credentials of ready connections', async () => {
  const f = await fixture();
  try {
    const summary = await f.sweep();
    assert.deepEqual({ ...summary, durationMs: 0 }, {
      event: 'chickpea.oauth.keepalive', credentials: 5, due: 3,
      renewed: 3, unavailable: 0, rejected: 0, skipped: 0, failed: 0, deferred: 0, durationMs: 0,
    });
    for (const id of ['connection_idle', 'connection_mail', 'legacy']) {
      assert.equal(await f.obtainedAt(id), NOW, id);
    }
    for (const id of ['connection_recent', 'connection_parked', 'connection_access_only']) {
      assert.notEqual(await f.obtainedAt(id), NOW, id);
    }
    const renewals = f.events.filter((event) => event.event === 'chickpea.oauth.refresh');
    assert.equal(renewals.length, 3);
    assert.ok(renewals.every((event) => event.trigger === 'keepalive' && event.outcome === 'refreshed'));
    assert.equal(JSON.stringify(f.events).includes('refresh-new'), false);
  } finally { f.close(); }
});

test('a rejected keep-alive renewal demotes the connection account', async () => {
  const f = await fixture();
  try {
    f.rejectMcpRefresh(() => Response.json({ error: 'invalid_grant' }, { status: 400 }));
    const summary = await f.sweep();
    assert.equal(summary.rejected, 2);
    assert.equal(summary.renewed, 1);
    const idle = (await f.config.listConnectionAccounts(WORKSPACE)).find(({ id }) => id === 'connection_idle');
    assert.equal(idle?.lifecycle, 'needs_attention');
    assert.equal(await f.settings.getSetting(f.tokenKeys.connection_idle!), undefined);
    const [legacy] = (await f.config.getAgent('agent_keep')).mcpServers;
    assert.equal(legacy?.statusText, 'Reconnect required');
  } finally { f.close(); }
});

test('a transient keep-alive failure keeps the credential due for the next sweep', async () => {
  const f = await fixture();
  try {
    f.rejectMcpRefresh(() => Response.json({ error: 'temporarily_unavailable' }, { status: 503 }));
    const summary = await f.sweep();
    assert.equal(summary.unavailable, 2);
    assert.equal(await f.obtainedAt('connection_idle'), f.stale);
    const idle = (await f.config.listConnectionAccounts(WORKSPACE)).find(({ id }) => id === 'connection_idle');
    assert.equal(idle?.lifecycle, 'ready');
  } finally { f.close(); }
});

test('the sweep bounds its work and leaves a concurrently leased credential to its holder', async () => {
  const f = await fixture();
  try {
    // A turn holds the refresh lease while the access token is still valid.
    const idleRef = connectionAccountOAuthRef('connection_idle');
    await f.settings.setSetting(f.tokenKeys.connection_idle!, mcpBundle(f.stale, { expiresIn: 86_400 }));
    await f.settings.setSetting(mcpOAuthSettingKeys(idleRef)[4], JSON.stringify({ owner: 'turn', expiresAt: NOW + 60_000 }));
    const summary = await f.sweep(2);
    assert.equal(summary.due, 3);
    assert.equal(summary.deferred, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.renewed, 1);
    assert.equal(await f.obtainedAt('connection_idle'), f.stale);
    // Oldest first: the legacy credential was renewed; the Google one waits.
    assert.equal(await f.obtainedAt('legacy'), NOW);
    assert.notEqual(await f.obtainedAt('connection_mail'), NOW);
  } finally { f.close(); }
});

test('a rejected Google renewal demotes its connection account', async () => {
  const f = await fixture();
  try {
    f.rejectGoogleRefresh(() => Response.json({ error: 'invalid_grant' }, { status: 400 }));
    const summary = await f.sweep();
    assert.equal(summary.rejected, 1);
    const mail = (await f.config.listConnectionAccounts(WORKSPACE)).find(({ id }) => id === 'connection_mail');
    assert.equal(mail?.lifecycle, 'needs_attention');
    assert.equal(await f.settings.getSetting(f.tokenKeys.connection_mail!), undefined);
  } finally { f.close(); }
});

test('an unexpected renewal error is counted as failed, not skipped', async (t) => {
  const f = await fixture();
  const warn = t.mock.method(console, 'warn', () => {});
  try {
    // Parseable enough to be due, but not a valid stored credential.
    await f.settings.setSetting(f.tokenKeys.connection_idle!, JSON.stringify({
      tokens: { refresh_token: 'refresh-old', expires_in: 3_600 }, obtainedAt: f.stale,
    }));
    const summary = await f.sweep();
    assert.equal(summary.failed, 1);
    assert.equal(summary.renewed, 2);
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /could not renew a credential \(oauth_storage_invalid\)/);
  } finally { f.close(); }
});
