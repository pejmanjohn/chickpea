#!/usr/bin/env node
/**
 * Serve deterministic visual-review states through the real authenticated
 * Admin routes. The fixture is deliberately process-local: it binds only to a
 * literal loopback address, uses generated local credentials, keeps every
 * store in one temporary SQLite file, and removes that directory on shutdown.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertNodeVersion, loadTsModule } from './lib/offline-harness.mjs';

const DEFAULT_HOST = '127.0.0.1';
const WORKSPACE_ID = 'TVISUAL';
const LOCAL_SLACK_TOKEN = 'xoxb-local-admin-visual-fixture';
const LOCAL_SLACK_SECRET = 'local-admin-visual-signing-secret';
const LOCAL_SLACK_BOT_ID = 'U_VISUAL_BOT';
const ENV_KEYS = [
  'SLACK_API_URL',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_BOT_USER_ID',
];

export const CANONICAL_ADMIN_VISUAL_STATES = Object.freeze({
  agentInstructions: Object.freeze({ path: '/admin/agents/agent_research', actions: Object.freeze([]) }),
  agentMemory: Object.freeze({ path: '/admin/agents/agent_research', actions: Object.freeze(['Memory']) }),
  channelsIndex: Object.freeze({ path: '/admin/channels', actions: Object.freeze([]) }),
  channelDetail: Object.freeze({ path: '/admin/channels/TVISUAL/C_RELEASES', actions: Object.freeze([]) }),
  channelAdvanced: Object.freeze({
    path: '/admin/channels/TVISUAL/C_RELEASES',
    actions: Object.freeze(['Advanced']),
  }),
});

const VISUAL_CHANNELS = Object.freeze([
  { id: 'C_RELEASES', name: 'release-room', is_private: false, is_member: true },
  { id: 'C_SUPPORT', name: 'customer-support', is_private: false, is_member: false },
  { id: 'C_CUSTOMER', name: 'customer-insights', is_private: true, is_member: true },
  { id: 'C_UNASSIGNED', name: 'product-feedback', is_private: false, is_member: true },
  { id: 'C_ARCHIVED', name: 'research-archive', is_private: true, is_member: true },
  { id: 'C_DISCOVERED', name: 'design-critique', is_private: false, is_member: true },
]);

let activeFixture = false;

async function seedVisualSlackOwner(identity) {
  const operation = await identity.createAuthOperation({
    id: 'first_owner_visual',
    kind: 'first_owner_claim',
    expectedSlackTeamId: WORKSPACE_ID,
    expectedSlackUserId: 'UVISUALOWNER',
    chickpeaRole: 'owner',
    capabilityHash: 'a'.repeat(64),
    expiresAt: Date.now() + 60_000,
  });
  await identity.createOwnerClaim({
    operationId: operation.id,
    slackTeamId: WORKSPACE_ID,
    slackUserId: 'UVISUALOWNER',
  });
  await identity.advanceAuthOperation({
    operationId: operation.id,
    capabilityHash: 'a'.repeat(64),
    step: 1,
    betterAuthUserId: 'ba_user_visual',
    betterAuthOrganizationId: '11111111-1111-4111-8111-111111111111',
    betterAuthMembershipId: 'ba_member_visual',
  });
  return identity.claimOwner({
    operationId: operation.id,
    organizationId: 'org_oss',
    slackTeamId: WORKSPACE_ID,
    slackUserId: 'UVISUALOWNER',
    displayName: 'Visual Owner',
    betterAuthUserId: 'ba_user_visual',
    betterAuthMembershipId: 'ba_member_visual',
  });
}

function assertLoopbackHost(host) {
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error(`Admin visual fixture host must be a literal loopback address, received ${host}.`);
  }
}

function loopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function urlHost(address) {
  return address.includes(':') ? `[${address}]` : address;
}

function visualAgents() {
  return [
    {
      id: 'agent_customer',
      revision: 1,
      name: 'Customer Insights',
      instructions: 'Summarize customer feedback and distinguish recurring evidence from anecdotes.',
      enabled: false,
      model: 'local-stub/visual-review',
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    },
    {
      id: 'agent_release',
      revision: 1,
      name: 'Release Scribe',
      instructions: 'Turn release activity into concise, decision-ready updates with explicit risks.',
      enabled: true,
      model: 'local-stub/visual-review',
      skills: [{
        name: 'release-readiness',
        description: 'Review release readiness and launch risk.',
        instructions: 'Name blockers, owners, and the safest next step.',
        enabled: true,
      }],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    },
    {
      id: 'agent_research',
      revision: 1,
      name: 'Research Partner',
      instructions: 'Investigate product questions, cite the available evidence, and call out uncertainty.',
      enabled: true,
      model: 'local-stub/visual-review',
      skills: [{
        name: 'research-brief',
        description: 'Build a sourced research brief.',
        instructions: 'Separate fact, inference, and open questions.',
        enabled: true,
      }],
      mcpServers: [{
        id: 'linear',
        displayName: 'Linear',
        url: 'https://mcp.linear.app/mcp',
        transport: 'streamable-http',
        authMode: 'none',
        headerNames: [],
        enabled: true,
        lifecycleStatus: 'ready',
        statusText: 'Connected · 2 tools',
        discoveredTools: [{ name: 'search' }, { name: 'create' }],
        allowedTools: ['search', 'create'],
        presetId: 'linear',
      }],
      apiConnections: [],
      repositories: [{
        id: 'repo_research',
        installationId: 42,
        accountLogin: 'acme',
        fullName: 'acme/research',
        enabled: true,
      }],
    },
  ];
}

async function seedConfig(store) {
  const channels = [
    {
      workspaceId: WORKSPACE_ID,
      channelId: 'C_RELEASES',
      label: 'release-room',
      additionalInstructions: 'Lead with launch blockers and reversible next steps.',
      participationMode: 'ambient',
      lifecycle: 'active',
      agentId: 'agent_release',
    },
    {
      workspaceId: WORKSPACE_ID,
      channelId: 'C_SUPPORT',
      label: 'customer-support',
      additionalInstructions: 'Escalate urgent support patterns.',
      participationMode: 'mention_only',
      lifecycle: 'active',
      agentId: 'agent_research',
    },
    {
      workspaceId: WORKSPACE_ID,
      channelId: 'C_CUSTOMER',
      label: 'customer-insights',
      participationMode: 'ambient',
      lifecycle: 'active',
      agentId: 'agent_customer',
    },
    {
      workspaceId: WORKSPACE_ID,
      channelId: 'C_UNASSIGNED',
      label: 'product-feedback',
      participationMode: 'ambient',
      lifecycle: 'active',
      agentId: null,
    },
    {
      workspaceId: WORKSPACE_ID,
      channelId: 'C_ARCHIVED',
      label: 'research-archive',
      participationMode: 'mention_only',
      lifecycle: 'archived',
      agentId: 'agent_research',
    },
  ];
  for (const { agentId, ...channel } of channels) {
    await store.putChannel(channel);
    if (agentId) {
      await store.putAssignment({
        workspaceId: channel.workspaceId,
        channelId: channel.channelId,
        agentId,
      });
    }
  }
  await store.putAssignment({ workspaceId: '*', channelId: '*', agentId: 'agent_research' });

  const defaultIdentity = await store.getSlackIdentity('slack_identity_default');
  await store.updateSlackIdentity(defaultIdentity.id, defaultIdentity.connectionRevision, {
    lifecycle: 'connected',
    teamId: WORKSPACE_ID,
    appId: 'A_VISUAL',
    botUserId: LOCAL_SLACK_BOT_ID,
    credentialProvenance: 'workspace_default',
    observedDisplayName: 'Chickpea',
    observedAt: Date.now(),
    health: 'healthy',
  });
}

async function seedSettings(settings, slackTokenFingerprint) {
  const values = {
    'slack.connectionRevision': 'visual-fixture-1',
    'slack.botToken': LOCAL_SLACK_TOKEN,
    'slack.signingSecret': LOCAL_SLACK_SECRET,
    'slack.botUserId': LOCAL_SLACK_BOT_ID,
    'slack.teamId': WORKSPACE_ID,
    'slack.teamName': 'Acme Design',
    'slack.teamTokenFingerprint': slackTokenFingerprint(LOCAL_SLACK_TOKEN),
  };
  for (const [key, value] of Object.entries(values)) await settings.setSetting(key, value);
}

async function seedMemory(memory) {
  const agentOwner = await memory.ensureOwner({
    workspaceId: WORKSPACE_ID,
    ownerKind: 'agent',
    ownerId: 'agent_research',
  });
  const channelOwner = await memory.ensureOwner({
    workspaceId: WORKSPACE_ID,
    ownerKind: 'channel',
    ownerId: 'C_RELEASES',
  });
  const entries = [
    {
      entryId: 'mem_visual_audience',
      storeId: agentOwner.storeId,
      slug: 'audience-notes',
      description: 'Who reads research updates.',
      type: 'preference',
      body: 'Prefer short evidence summaries for product and engineering leads.',
      writeOrigin: { kind: 'admin' },
    },
    {
      entryId: 'mem_visual_principles',
      storeId: agentOwner.storeId,
      slug: 'research-principles',
      description: 'Durable research guidance.',
      type: 'fact',
      body: 'Separate verified fact, inference, and unresolved questions.',
      writeOrigin: { kind: 'admin' },
    },
    {
      entryId: 'mem_visual_release',
      storeId: channelOwner.storeId,
      slug: 'release-checklist',
      description: 'Exact-Channel launch checklist.',
      type: 'project',
      body: 'Check focused tests, rollout risk, owner, and rollback before launch.',
      writeOrigin: { kind: 'slack_channel', channelId: 'C_RELEASES' },
    },
  ];
  for (const entry of entries) {
    await memory.createOwnerEntry({
      ...entry,
      workspaceId: WORKSPACE_ID,
      actorId: 'U_VISUAL_OWNER',
      actorClass: 'owner',
      idempotencyKey: `admin-visual-${entry.entryId}`,
    });
  }
  await memory.observeChannelScope({
    workspaceId: WORKSPACE_ID,
    channelId: 'C_RELEASES',
    privacy: 'public',
    displayName: 'release-room',
    observedAt: Date.now(),
  });
}

function fakeSlackResponse(pathname, body) {
  if (pathname.endsWith('/conversations.list')) {
    return {
      ok: true,
      channels: VISUAL_CHANNELS,
      response_metadata: { next_cursor: '' },
    };
  }
  if (pathname.endsWith('/auth.test')) {
    return {
      ok: true,
      app_id: 'A_VISUAL',
      team: 'Acme Design',
      team_id: WORKSPACE_ID,
      user_id: LOCAL_SLACK_BOT_ID,
      bot_id: 'B_VISUAL',
    };
  }
  if (pathname.endsWith('/users.info')) {
    if (body.user !== LOCAL_SLACK_BOT_ID) {
      return { ok: false, error: 'user_not_found' };
    }
    return {
      ok: true,
      user: {
        id: LOCAL_SLACK_BOT_ID,
        team_id: WORKSPACE_ID,
        is_bot: true,
        profile: { display_name: 'Chickpea', real_name: 'Chickpea' },
      },
    };
  }
  if (pathname.endsWith('/conversations.info')) {
    const channel = VISUAL_CHANNELS.find((candidate) => candidate.id === body.channel);
    return channel
      ? { ok: true, channel }
      : { ok: false, error: 'channel_not_found' };
  }
  return { ok: false, error: 'fixture_endpoint_not_found' };
}

async function nodeRequest(req, res, app, baseUrl) {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(new URL(req.url ?? '/', baseUrl), {
      method: req.method,
      headers: req.headers,
      ...(body ? { body } : {}),
    });
    const response = await app.fetch(request);
    res.statusCode = response.status;
    for (const [name, value] of response.headers) res.setHeader(name, value);
    const bytes = Buffer.from(await response.arrayBuffer());
    res.end(bytes);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(error instanceof Error ? error.message : String(error));
  }
}

function listen(server, port, host) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
}

function closeServer(server) {
  return new Promise((resolveClose, reject) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

/** Start one disposable, loopback-only real Admin fixture. */
export async function startAdminVisualFixture(options = {}) {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? 0;
  assertLoopbackHost(host);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Admin visual fixture port must be an integer from 0 to 65535, received ${port}.`);
  }
  if (activeFixture) throw new Error('Only one Admin visual fixture can run in a process at a time.');
  activeFixture = true;

  const stateDirectory = mkdtempSync(join(tmpdir(), 'chickpea-admin-visual-'));
  const stateDbPath = join(stateDirectory, 'state.db');
  const previousEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const stores = [];
  let server;
  let closed = false;

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    // Start refusing new requests immediately, but do not yield before
    // releasing process-local resources. npm and the child Node process both
    // receive an interactive signal, so a first-await cleanup can be cut off
    // before its temporary database is removed.
    const serverClosing = server ? closeServer(server) : Promise.resolve();
    try {
      for (const store of stores.reverse()) {
        try { store.close?.(); } catch { /* finish closing the remaining handles */ }
      }
    } finally {
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(stateDirectory, { recursive: true, force: true });
      activeFixture = false;
    }
    await serverClosing;
  };

  try {
    assertNodeVersion();
    const { Hono } = await import('hono');
    const { createAdminRoutes } = await loadTsModule('src/admin/routes.ts');
    const { SqliteConfigStore } = await loadTsModule('src/config/store.ts');
    const { SqliteSettingsStore } = await loadTsModule('src/config/settings-store.ts');
    const { SqliteMemoryStateStore } = await loadTsModule('src/memory/store.ts');
    const { SqliteRoutineStore } = await loadTsModule('src/routines/store.ts');
    const { SqliteUsageStore } = await loadTsModule('src/usage/store.ts');
    const { SqliteWorkStore } = await loadTsModule('src/work/store.ts');
    const { SqliteSlackStateStore } = await loadTsModule('src/slack/claim-store.ts');
    const { SqliteAgentSnapshotStore } = await loadTsModule('src/config/snapshot-store.ts');
    const { SqliteIdentityStore } = await loadTsModule('src/identity/store.ts');
    const {
      invalidateSlackChannelsCache,
    } = await loadTsModule('src/slack/channels.ts');
    const {
      invalidateStoredSlackCredentials,
      slackTokenFingerprint,
    } = await loadTsModule('src/slack/credentials.ts');

    invalidateSlackChannelsCache();
    invalidateStoredSlackCredentials();

    const store = new SqliteConfigStore(stateDbPath, {
      agents: visualAgents(),
      assignments: [],
    });
    const settings = new SqliteSettingsStore(stateDbPath);
    const memory = new SqliteMemoryStateStore(stateDbPath);
    const routines = new SqliteRoutineStore(stateDbPath);
    const usage = new SqliteUsageStore(stateDbPath);
    const work = new SqliteWorkStore(stateDbPath);
    const slackState = new SqliteSlackStateStore(stateDbPath);
    const snapshots = new SqliteAgentSnapshotStore(stateDbPath);
    const identity = new SqliteIdentityStore(stateDbPath);
    stores.push(store, settings, memory, routines, usage, work, slackState, snapshots, identity);

    await seedConfig(store);
    await seedSettings(settings, slackTokenFingerprint);
    await seedMemory(memory);
    const owner = await seedVisualSlackOwner(identity);

    const adminToken = `visual-${randomBytes(18).toString('base64url')}`;
    const app = new Hono();
    app.post('/__admin_visual_fixture/slack/:method', async (c) => {
      if (c.req.header('authorization') !== `Bearer ${LOCAL_SLACK_TOKEN}`) {
        return c.json({ ok: false, error: 'invalid_auth' });
      }
      const body = await c.req.parseBody();
      const result = fakeSlackResponse(c.req.path, body);
      return c.json(result, result.error === 'fixture_endpoint_not_found' ? 404 : 200);
    });
    app.route('/', createAdminRoutes({
      store,
      settings,
      memory,
      routines,
      usage,
      work,
      slackState,
      snapshots,
      identity,
      usageAdminUi: true,
      authService: {
        async authenticateRequest(request) {
          if (request.headers.get('authorization') !== `Bearer ${adminToken}`) {
            throw new Error('Authentication unavailable.');
          }
          return {
            userId: owner.user.id,
            membershipId: owner.membership.id,
            organizationId: owner.membership.organizationId,
            role: 'owner',
            authenticatorKind: 'visual_slack_session',
            credentialId: 'visual_session',
            correlationId: 'visual_request',
            machine: false,
          };
        },
      },
      knownProviders: new Set(['local-stub']),
      runtimeDrain: async () => ({
        drained: true,
        categories: {
          admittedTurns: 0,
          claimedTurns: 0,
          pendingDeliveries: 0,
          executingRuns: 0,
          admittingOrRunningRoutineOccurrences: 0,
        },
      }),
    }));

    let baseUrl = '';
    server = createServer((req, res) => void nodeRequest(req, res, app, baseUrl));
    await listen(server, port, host);
    const bound = server.address();
    if (!bound || typeof bound === 'string' || !loopbackAddress(bound.address)) {
      throw new Error(`Admin visual fixture did not bind to loopback: ${String(bound)}.`);
    }
    baseUrl = `http://${urlHost(bound.address)}:${bound.port}`;
    const control = await identity.getAuthControl();
    await identity.updateAuthControl({
      expectedRevision: control.revision,
      canonicalAdminOrigin: baseUrl,
    });
    await identity.updateOrganizationAuth({
      organizationId: owner.membership.organizationId,
      authMode: 'slack_active',
      canonicalAdminOrigin: baseUrl,
    });

    // These values are visibly fake and useful only while this loopback server
    // exists. Setting the complete triple prevents ambient real Slack
    // credentials from winning the production resolver's env-first policy.
    process.env.SLACK_BOT_TOKEN = LOCAL_SLACK_TOKEN;
    process.env.SLACK_SIGNING_SECRET = LOCAL_SLACK_SECRET;
    process.env.SLACK_BOT_USER_ID = LOCAL_SLACK_BOT_ID;
    process.env.SLACK_API_URL = `${baseUrl}/__admin_visual_fixture/slack`;

    return {
      address: bound.address,
      adminToken,
      baseUrl,
      canonicalStates: CANONICAL_ADMIN_VISUAL_STATES,
      stateDbPath,
      stateDirectory,
      close: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function parseCliArgs(args) {
  const parsed = { host: DEFAULT_HOST, port: 0 };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--host') parsed.host = args[++index];
    else if (value === '--port') parsed.port = Number(args[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return parsed;
}

async function runCli() {
  const fixture = await startAdminVisualFixture(parseCliArgs(process.argv.slice(2)));
  console.log(`Admin visual fixture: ${fixture.baseUrl}`);
  console.log(`Local login token: ${fixture.adminToken}`);
  console.log('Canonical states (production URLs; perform the listed UI actions after load):');
  for (const [name, state] of Object.entries(fixture.canonicalStates)) {
    const actions = state.actions.length ? ` then ${state.actions.join(' → ')}` : '';
    console.log(`  ${name}: ${fixture.baseUrl}${state.path}${actions}`);
  }
  console.log(`Temporary state: ${fixture.stateDbPath}`);
  console.log('Press Ctrl+C to stop and remove the temporary state.');

  let stopping = false;
  const cleanupOnExit = () => void fixture.close();
  process.once('exit', cleanupOnExit);
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal}: stopping Admin visual fixture…`);
    await fixture.close();
    process.off('exit', cleanupOnExit);
    process.exitCode = 0;
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
  // npm can relay terminal shutdown as SIGHUP after its wrapper exits.
  process.once('SIGHUP', () => void stop('SIGHUP'));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  runCli().catch((error) => {
    console.error(`${basename(fileURLToPath(import.meta.url))}:`, error);
    process.exitCode = 1;
  });
}
