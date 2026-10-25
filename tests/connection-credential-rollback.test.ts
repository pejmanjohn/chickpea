import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
import {
  boundApiCredentialRef,
  boundMcpCredentialRef,
  validConnectionCredentialRef,
} from '../src/config/connection-credential-binding.ts';
import { saveConnectorCredential } from '../src/config/connector-secrets.ts';
import { mcpOAuthSettingKeys } from '../src/config/mcp-oauth.ts';
import { resolveMcpSecrets, saveMcpSecrets } from '../src/config/mcp-secrets.ts';
import { OAUTH_KEEPALIVE_AGE_MS } from '../src/config/oauth-shared.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { AgentSnapshotStore } from '../src/config/snapshot-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { ApiConnectionConfig, McpConnectionConfig } from '../src/config/types.ts';
import { runOAuthKeepAliveSweep } from '../src/connections/oauth-keepalive.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import type { SlackTransport } from '../src/slack/transport/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

// v0.1.33's Admin saves every connection of an Agent without the credential
// reference v0.1.34 added. These tests update forward from that state.

const TOKEN = 'rollback-admin-token';
const NOW = Date.UTC(2026, 9, 24, 6, 10);
const STALE = NOW - OAUTH_KEEPALIVE_AGE_MS - 60_000;
const SERVER_URL = 'https://mcp.example.test/mcp';
const TOKEN_ENDPOINT = 'https://auth.example.test/token';

function oauthServer(id: string): McpConnectionConfig {
  return {
    id, displayName: id, url: SERVER_URL, transport: 'streamable-http', authMode: 'oauth',
    headerNames: [], enabled: true, lifecycleStatus: 'ready', statusText: 'Connected',
    discoveredTools: [], allowedTools: [],
  };
}

function bearerServer(id: string): McpConnectionConfig {
  return { ...oauthServer(id), url: `https://${id}.example.test/mcp`, authMode: 'bearer' };
}

function credentialApi(id: string): ApiConnectionConfig {
  return {
    id, displayName: id, allowedHosts: [`${id}.example.test`], pathPrefixes: ['/v1'],
    headerName: 'Authorization', allowedMethods: ['GET'], enabled: true, authMode: 'credential',
  };
}

function tokenBundle(obtainedAt: number): string {
  return JSON.stringify({
    serverUrl: SERVER_URL,
    authorizationServerUrl: 'https://auth.example.test',
    metadata: {
      issuer: 'https://auth.example.test',
      authorization_endpoint: 'https://auth.example.test/authorize',
      token_endpoint: TOKEN_ENDPOINT,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
    },
    resource: SERVER_URL,
    clientInformation: { client_id: 'registered-client' },
    tokens: { access_token: 'access-old', token_type: 'Bearer', expires_in: 86_400, refresh_token: 'refresh-old' },
    obtainedAt,
  });
}

function identity(): IdentityStore {
  return {
    getMembership: async (id: string) => id === 'membership_test_owner'
      ? { id, organizationId: 'org_oss', userId: 'user_test_owner', role: 'owner', status: 'active', createdAt: 1, updatedAt: 1 }
      : undefined,
    getUser: async (id: string) => id === 'user_test_owner'
      ? { id, slackTeamId: 'T_TEST', slackUserId: 'U_OWNER', displayName: 'Owner', contactEmail: 'o@example.com', createdAt: 1, updatedAt: 1 }
      : undefined,
    getMembershipAccessOverlay: async () => undefined,
    recordAuthAudit: async () => undefined,
  } as unknown as IdentityStore;
}

/** One state file shared by configuration and settings, reopened like a restart. */
function installation() {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-credential-rollback-'));
  const path = join(dir, 'state.sqlite');
  const open = () => ({
    config: new SqliteConfigStore(path, { agents: [] }),
    settings: new SqliteSettingsStore(path),
  });
  let stores = open();
  return {
    get config() { return stores.config; },
    get settings() { return stores.settings; },
    restart() {
      stores.config.close();
      stores.settings.close();
      stores = open();
    },
    /** v0.1.33's Admin PATCH: every connection rewritten without its reference. */
    saveOnV0133(agentId: string) {
      const db = openStateDb(path);
      try {
        const row = db.get(
          'SELECT mcp_servers_json, api_connections_json FROM config_agents WHERE id = ?',
          agentId,
        )!;
        const strip = (raw: unknown) => JSON.stringify(
          (JSON.parse(String(raw)) as Array<Record<string, unknown>>)
            .map(({ credentialRef: _credentialRef, ...connection }) => connection),
        );
        db.run(
          `UPDATE config_agents SET mcp_servers_json = ?, api_connections_json = ?,
             revision = revision + 1 WHERE id = ?`,
          strip(row.mcp_servers_json),
          strip(row.api_connections_json),
          agentId,
        );
      } finally {
        db.close();
      }
    },
    admin() {
      const app = new Hono();
      app.route('/', createAdminRoutes({
        store: stores.config,
        settings: stores.settings,
        management: new SqliteManagementStore(':memory:'),
        snapshots: { listLiveRootsByAgent: async () => [] } as unknown as AgentSnapshotStore,
        slackTransport: {
          mode: 'direct',
          getWorkspaceInfo: async () => ({ teamId: 'T_TEST' }),
        } as unknown as SlackTransport,
        knownProviders: new Set(['local-stub']),
        ...testAdminAuthority(TOKEN, undefined, identity()),
      }));
      return app;
    },
    keepAlive() {
      const requests: string[] = [];
      const sweep = runOAuthKeepAliveSweep({
        config: stores.config,
        settings: stores.settings,
        now: () => NOW,
        emit: () => {},
        fetchFn: async (input, init) => {
          const url = new Request(input, init).url;
          requests.push(url);
          if (url !== TOKEN_ENDPOINT) throw new Error(`unexpected request ${url}`);
          return Response.json({
            access_token: 'access-new', token_type: 'Bearer', expires_in: 3_600, refresh_token: 'refresh-new',
          });
        },
      });
      return { sweep, requests };
    },
    close() {
      stores.config.close();
      stores.settings.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * `agent_saved` will be saved on v0.1.33; `agent_untouched` keeps its
 * references and holds an idle OAuth sign-in for the keep-alive to renew.
 */
async function seed(state: ReturnType<typeof installation>) {
  const agent = (id: string, mcpServers: McpConnectionConfig[], apiConnections: ApiConnectionConfig[]) =>
    state.config.createAgent({
      id, name: id, instructions: 'Help.', enabled: true, creatorMembershipId: 'membership_test_owner',
      editPolicy: 'creator_and_admins', skills: [], mcpServers, apiConnections, repositories: [],
      model: 'local-stub/admin-agent',
    });
  const saved = await agent('agent_saved', [bearerServer('docs'), oauthServer('notion')], [credentialApi('billing')]);
  const untouched = await agent('agent_untouched', [oauthServer('errors')], []);
  const [docs, notion] = saved.mcpServers;
  await saveMcpSecrets(boundMcpCredentialRef(saved.id, docs!), { bearerToken: 'docs-secret' }, undefined, state.settings);
  await state.settings.setSetting(mcpOAuthSettingKeys(boundMcpCredentialRef(saved.id, notion!))[2], tokenBundle(STALE));
  await saveConnectorCredential(
    boundApiCredentialRef(saved.id, saved.apiConnections[0]!), 'billing-secret', undefined, state.settings,
  );
  const errorsTokenKey = mcpOAuthSettingKeys(boundMcpCredentialRef(untouched.id, untouched.mcpServers[0]!))[2];
  await state.settings.setSetting(errorsTokenKey, tokenBundle(STALE));
  return { errorsTokenKey };
}

async function getJson(app: Hono, path: string) {
  const response = await app.request(`http://localhost${path}`, { headers: testAdminHeaders(TOKEN) });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

test('after a v0.1.33 Admin save, the next start gives each connection a reference again', async () => {
  const state = installation();
  try {
    const { errorsTokenKey } = await seed(state);
    state.restart();
    state.saveOnV0133('agent_saved');
    state.restart();

    const stored = await state.config.getAgent('agent_saved');
    for (const connection of [...stored.mcpServers, ...stored.apiConnections]) {
      assert.ok(validConnectionCredentialRef(connection.credentialRef), connection.id);
    }

    const app = state.admin();
    const list = await getJson(app, '/admin/api/agents');
    assert.equal(list.status, 200);
    const listed = list.body.agents.find(({ id }: { id: string }) => id === 'agent_saved');
    assert.deepEqual(
      [...listed.mcpServers, ...listed.apiConnections].map(({ id, credentialBinding }) =>
        [id, typeof credentialBinding]),
      [['docs', 'string'], ['notion', 'string'], ['billing', 'string']],
    );
    const page = await getJson(app, '/admin/api/agents/agent_saved');
    assert.equal(page.status, 200);
    assert.equal(page.body.agent.apiConnections[0].credentialSource, 'missing');
    assert.equal(page.body.agent.apiConnections[0].credentialBinding, listed.apiConnections[0].credentialBinding);
    const docs = stored.mcpServers.find(({ id }) => id === 'docs')!;
    assert.deepEqual(
      await resolveMcpSecrets(boundMcpCredentialRef('agent_saved', docs), [], undefined, state.settings),
      { headers: {} },
    );

    const keepAlive = state.keepAlive();
    const summary = await keepAlive.sweep;
    assert.deepEqual({ credentials: summary.credentials, renewed: summary.renewed, failed: summary.failed },
      { credentials: 2, renewed: 1, failed: 0 });
    assert.deepEqual(keepAlive.requests, [TOKEN_ENDPOINT]);
    assert.equal(JSON.parse((await state.settings.getSetting(errorsTokenKey))!).obtainedAt, NOW);
  } finally {
    state.close();
  }
});

test('a connection without a reference does not take down the Agent list or the keep-alive', async () => {
  const state = installation();
  try {
    const { errorsTokenKey } = await seed(state);
    // Written while this process runs, so no start has refilled it.
    state.saveOnV0133('agent_saved');

    const app = state.admin();
    const list = await getJson(app, '/admin/api/agents');
    assert.equal(list.status, 200);
    const listed = list.body.agents.find(({ id }: { id: string }) => id === 'agent_saved');
    assert.deepEqual(
      [...listed.mcpServers, ...listed.apiConnections].map(({ id, credentialBinding }) => [id, credentialBinding]),
      [['docs', undefined], ['notion', undefined], ['billing', undefined]],
    );
    const page = await getJson(app, '/admin/api/agents/agent_saved');
    assert.equal(page.status, 200);
    assert.equal(page.body.agent.apiConnections[0].credentialSource, 'missing');

    const summary = await state.keepAlive().sweep;
    assert.deepEqual({ credentials: summary.credentials, renewed: summary.renewed, failed: summary.failed },
      { credentials: 1, renewed: 1, failed: 0 });
    assert.equal(JSON.parse((await state.settings.getSetting(errorsTokenKey))!).obtainedAt, NOW);
  } finally {
    state.close();
  }
});
