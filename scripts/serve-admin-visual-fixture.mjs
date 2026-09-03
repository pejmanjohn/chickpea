#!/usr/bin/env node
/**
 * Serve deterministic visual-review states through the real authenticated
 * Admin routes. The fixture is deliberately process-local: it binds only to a
 * literal loopback address, uses generated local credentials, keeps every
 * store in one temporary SQLite file, and removes that directory on shutdown.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertNodeVersion, loadTsModule } from './lib/offline-harness.mjs';

const DEFAULT_HOST = '127.0.0.1';
const WORKSPACE_ID = 'TVISUAL';
const LOCAL_SLACK_TOKEN = 'xoxb-local-admin-visual-fixture';
const LOCAL_SLACK_SECRET = 'local-admin-visual-signing-secret';
const LOCAL_SLACK_BOT_ID = 'UVISUALBOT';
const ENV_KEYS = [
  'SLACK_API_URL',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_BOT_USER_ID',
];

export const CANONICAL_ADMIN_VISUAL_STATES = Object.freeze({
  settingsProviders: Object.freeze({ path: '/admin/settings/providers', actions: Object.freeze([]) }),
  agentInstructions: Object.freeze({ path: '/admin/agents/agent_research', actions: Object.freeze([]) }),
  agentBlankDescription: Object.freeze({ path: '/admin/agents/agent_customer', actions: Object.freeze([]) }),
  agentMemory: Object.freeze({ path: '/admin/agents/agent_research', actions: Object.freeze(['Memory']) }),
  agentSchedules: Object.freeze({ path: '/admin/agents/agent_release', actions: Object.freeze(['Schedules']) }),
  channelsIndex: Object.freeze({ path: '/admin/channels', actions: Object.freeze([]) }),
  channelDetail: Object.freeze({ path: '/admin/channels/TVISUAL/C_RELEASES', actions: Object.freeze([]) }),
  channelAdvanced: Object.freeze({
    path: '/admin/channels/TVISUAL/C_RELEASES',
    actions: Object.freeze(['Advanced']),
  }),
  team: Object.freeze({ path: '/admin/team', actions: Object.freeze([]) }),
});

export const CANONICAL_SLACK_AUTH_VISUAL_STATES = Object.freeze({
  signIn: Object.freeze({ path: '/__admin_visual_fixture/auth/sign-in' }),
  setupCreate: Object.freeze({ path: '/__admin_visual_fixture/auth/setup-create' }),
  setupConnected: Object.freeze({ path: '/__admin_visual_fixture/auth/setup-connected' }),
  setupApproval: Object.freeze({ path: '/__admin_visual_fixture/auth/setup-approval' }),
  setupOwner: Object.freeze({ path: '/__admin_visual_fixture/auth/setup-owner' }),
  accessDenied: Object.freeze({ path: '/__admin_visual_fixture/auth/access-denied' }),
  ownerComplete: Object.freeze({ path: '/__admin_visual_fixture/auth/owner-complete' }),
  recovery: Object.freeze({ path: '/__admin_visual_fixture/auth/recovery' }),
});

export const CANONICAL_CONNECTOR_VISUAL_STATES = Object.freeze({
  setup: Object.freeze({ path: '/__admin_visual_fixture/connectors/setup' }),
  waiting: Object.freeze({ path: '/__admin_visual_fixture/connectors/waiting' }),
  success: Object.freeze({ path: '/__admin_visual_fixture/connectors/success' }),
});

export const VISUAL_ENVIRONMENT_STATUS = Object.freeze({
  schemaVersion: 'chickpea-environment-status/v1',
  generatedAt: '2026-09-01T12:00:00.000Z',
  registryRevision: 12,
  selectedTarget: 'amber',
  targets: Object.freeze(['amber', 'cobalt', 'fern'].map((target, index) => Object.freeze({
    target,
    health: index === 0 ? 'ready' : index === 1 ? 'unreachable' : 'expired_claim',
    sourceSha: '1234567890abcdef1234567890abcdef12345678',
    dirty: index === 0,
    servingVersion: `version-${target}`,
    transport: 'events',
    workspaceAlias: `env-${target}-workspace`,
    workspaceLabel: `${target} workspace`,
    appAlias: `env-${target}-slack-app`,
    appLabel: `${target} app`,
    claim: index === 0 ? Object.freeze({
      holderId: 'holder-0123456789abcdef',
      leaseAgeMs: 180_000,
      expiresAt: '2026-09-01T20:00:00.000Z',
    }) : null,
    verifierLock: Object.freeze(index === 0
      ? { status: 'live', ownerRunId: 'visual-run-amber' }
      : { status: 'clear' }),
    schemaGeneration: 'd1:0002_mcp_oauth;do:v9',
    lastAttestedRevision: index === 0
      ? '1234567890abcdef1234567890abcdef12345678-dirty'
      : null,
    recoveryAction: index === 0
      ? 'No recovery needed.'
      : index === 1
        ? 'Check cobalt Worker and Slack transport reachability.'
        : 'Run npm run env -- reclaim fern.',
    credentialToken: 'xoxb-visual-do-not-expose',
  }))),
  sandbox: Object.freeze({
    archiveDate: '2027-01-15T00:00:00.000Z',
    daysUntilArchive: 136,
    warning: 'none',
    warningDays: Object.freeze([45, 30, 14]),
    unusedWorkspaceSlots: 2,
    integrationHeadroom: 37,
    browserProfilePath: '/private/visual-browser-profile',
  }),
});

const VISUAL_CHANNELS = Object.freeze([
  { id: 'C_RELEASES', name: 'release-room', is_private: false, is_member: true, is_archived: false },
  { id: 'C_SUPPORT', name: 'customer-support', is_private: false, is_member: false, is_archived: false },
  { id: 'C_CUSTOMER', name: 'customer-insights', is_private: true, is_member: true, is_archived: false },
  { id: 'C_UNASSIGNED', name: 'product-feedback', is_private: false, is_member: true, is_archived: false },
  { id: 'C_ARCHIVED', name: 'research-archive', is_private: true, is_member: true, is_archived: true },
  { id: 'C_DISCOVERED', name: 'design-critique', is_private: false, is_member: true, is_archived: false },
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

async function seedVisualTeam(identity, provisionSlackInteractionMember, owner) {
  const fixtures = [
    { slackUserId: 'UVISUALADMIN', displayName: 'Alex Admin', role: 'admin', status: 'active' },
    { slackUserId: 'UVISUALMEMBER', displayName: 'Maya Member', role: 'member', status: 'active' },
    { slackUserId: 'UVISUALOWNER2', displayName: 'Olive Owner', role: 'owner', status: 'active' },
    { slackUserId: 'UVISUALSUSPENDED', displayName: 'Sam Suspended', role: 'member', status: 'suspended' },
    { slackUserId: 'UVISUALREMOVED', displayName: 'Rae Removed', role: 'member', status: 'removed' },
  ];
  for (const fixture of fixtures) {
    const provisioned = await provisionSlackInteractionMember({
      identity,
      slackTeamId: WORKSPACE_ID,
      botUserId: LOCAL_SLACK_BOT_ID,
      user: {
        id: fixture.slackUserId,
        teamId: WORKSPACE_ID,
        displayName: fixture.displayName,
        deleted: false,
        bot: false,
        appUser: false,
        restricted: false,
        ultraRestricted: false,
        stranger: false,
      },
    });
    const membership = provisioned.resolution?.membership;
    if (!membership) throw new Error(`Could not seed visual member ${fixture.slackUserId}.`);
    if (fixture.role !== membership.role) {
      await identity.updateMembershipAuthority({
        membershipId: membership.id,
        role: fixture.role,
        actorMembershipId: owner.membership.id,
        authenticationSurface: 'better_auth',
        correlationId: `visual-role-${fixture.slackUserId}`,
        reasonCode: 'owner_changed_member_role',
      });
    }
    if (fixture.status !== 'active') {
      await identity.updateMembershipAuthority({
        membershipId: membership.id,
        status: fixture.status,
        actorMembershipId: owner.membership.id,
        authenticationSurface: 'better_auth',
        correlationId: `visual-status-${fixture.slackUserId}`,
        reasonCode: 'admin_deactivated_member',
      });
    }
  }
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
  const slackPresence = (id, handle, avatarHash) => ({
    requestedHandle: handle,
    normalizedHandle: handle,
    desiredState: 'active',
    health: 'healthy',
    avatar: {
      kind: 'generated',
      revision: 1,
      seed: id,
      url: `https://secure.gravatar.com/avatar/${avatarHash}?s=192&d=identicon`,
    },
  });
  return [
    {
      id: 'agent_customer',
      revision: 1,
      name: 'Customer Insights',
      description: '',
      instructions: 'Summarize customer feedback and distinguish recurring evidence from anecdotes.',
      enabled: false,
      slackPresence: slackPresence('agent_customer', 'customer-insights', 'b6a1f4b55c4c81e3da8a5f3c12f2ef7f'),
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    },
    {
      id: 'agent_release',
      revision: 1,
      name: 'Release Scribe',
      description: 'Keeps launches concise, decision-ready, and explicit about risk.',
      instructions: 'Turn release activity into concise, decision-ready updates with explicit risks.',
      enabled: true,
      slackPresence: slackPresence('agent_release', 'release-scribe', '205e460b479e2e5b48aec07710c08d50'),
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
      description: 'Investigates product questions with evidence and clearly marked uncertainty.',
      instructions: 'Investigate product questions, cite the available evidence, and call out uncertainty.',
      enabled: true,
      model: 'local-stub/visual-review',
      slackPresence: slackPresence('agent_research', 'research-partner', 'f9879d71855b5ff21e4963273a886bfc'),
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

async function seedConfig(store, runtimeContract) {
  const channels = [
    {
      workspaceId: WORKSPACE_ID,
      channelId: 'C_RELEASES',
      label: 'release-room',
      lifecycle: 'active',
      agentId: 'agent_release',
    },
    {
      workspaceId: WORKSPACE_ID,
      channelId: 'C_SUPPORT',
      label: 'customer-support',
      lifecycle: 'active',
      agentId: 'agent_research',
    },
    {
      workspaceId: WORKSPACE_ID,
      channelId: 'C_CUSTOMER',
      label: 'customer-insights',
      lifecycle: 'active',
      agentId: null,
    },
    {
      workspaceId: WORKSPACE_ID,
      channelId: 'C_UNASSIGNED',
      label: 'product-feedback',
      lifecycle: 'active',
      agentId: null,
    },
    {
      workspaceId: WORKSPACE_ID,
      channelId: 'C_ARCHIVED',
      label: 'research-archive',
      lifecycle: 'archived',
      agentId: 'agent_research',
    },
  ];
  for (const { agentId, ...channel } of channels) {
    await store.putChannel(channel);
    if (agentId) {
      await store.putAgentChannelGrant({
        workspaceId: channel.workspaceId,
        channelId: channel.channelId,
        agentId,
        status: 'active',
        createdByMembershipId: 'membership_visual_owner',
        channelLabel: channel.label,
      });
    }
  }
  const installation = await store.ensureWorkspaceInstallation({
    workspaceId: WORKSPACE_ID,
    transportMode: 'direct',
    ...(runtimeContract === 'chickpea-v1' ? { runtimeContract } : {}),
    defaultAgentId: 'agent_research',
    teamId: WORKSPACE_ID,
    appId: 'AVISUAL',
    botUserId: LOCAL_SLACK_BOT_ID,
  });
  await store.updateWorkspaceInstallation(WORKSPACE_ID, {
    health: 'healthy',
  }, installation.revision);
}

async function seedConnections(store, ownerMembershipId) {
  const account = (slug, providerId, label, toolkit, allowedCapabilities, options = {}) => ({
    id: `connection_${slug}`,
    workspaceId: WORKSPACE_ID,
    ownerKind: options.ownerKind ?? 'member',
    ...(options.ownerKind === 'team' ? {} : { ownerMembershipId }),
    createdByMembershipId: ownerMembershipId,
    providerId,
    label: `${label} · ${options.ownerKind === 'team' ? 'Team' : 'Personal'}`,
    identity: { accountName: options.accountName ?? 'member@acme.test' },
    policy: {
      kind: 'managed',
      adapterId: 'composio',
      toolkit,
      principalRef: options.ownerKind === 'team'
        ? `chickpea:organization:${WORKSPACE_ID}`
        : `chickpea:membership:${ownerMembershipId}`,
      accountRef: `ca_visual_${slug}`,
      allowedCapabilities,
    },
    secretRefId: `secret_visual_${slug}`,
    lifecycle: options.lifecycle ?? 'ready',
  });
  const accounts = [
    account('drive', 'google', 'Google Drive', 'googledrive', [
      'drive.files.search', 'drive.files.metadata', 'drive.files.read', 'drive.files.create',
    ]),
    account('gmail', 'google', 'Gmail', 'gmail', [
      'gmail.profile.read', 'gmail.messages.search', 'gmail.drafts.create', 'gmail.messages.send',
    ]),
    account('calendar', 'google', 'Google Calendar', 'googlecalendar', [
      'calendar.calendars.list', 'calendar.events.list', 'calendar.events.create',
      'calendar.events.update', 'calendar.events.delete',
    ]),
    account('team_gmail_needs_attention', 'google', 'Gmail', 'gmail', [
      'gmail.profile.read', 'gmail.messages.search', 'gmail.drafts.create', 'gmail.messages.send',
    ], {
      ownerKind: 'team', lifecycle: 'needs_attention', accountName: 'team@acme.test',
    }),
  ];
  for (const connection of accounts) await store.putConnectionAccount(connection);
  for (const [agentId, connection] of [
    ['agent_research', accounts[0]],
    ['agent_research', accounts[1]],
    ['agent_release', accounts[3]],
  ]) {
    await store.putAgentConnectionBinding({
      agentId,
      connectionAccountId: connection.id,
      providerId: connection.providerId,
      allowedCapabilities: connection.policy.allowedCapabilities,
      enabled: true,
    });
  }
}

async function seedSettings(settings) {
  await settings.setSetting('slack.teamName', 'Acme Design');
}

async function seedMemory(memory) {
  await memory.putAgentMemory({
    agentId: 'agent_research',
    expectedRevision: 0,
    body: [
      'Prefer short evidence summaries for product and engineering leads.',
      'Separate verified fact, inference, and unresolved questions.',
      'Check focused tests, rollout risk, owner, and rollback before launch.',
    ].join('\n'),
  });
}

async function seedSchedules(store, routines, ownerMembershipId, RoutineService) {
  const definitions = [
    {
      id: 'routine_visual_daily_release',
      name: 'Daily launch readiness digest with a long scannable name',
      scheduleInput: '0 9 * * 1-5',
      nextRunAt: Date.UTC(2026, 7, 26, 16),
      pause: false,
      referenceState: 'active',
    },
    {
      id: 'routine_visual_weekly_summary',
      name: 'Weekly customer summary',
      scheduleInput: '0 14 * * 5',
      nextRunAt: Date.UTC(2026, 7, 28, 21),
      pause: true,
      referenceState: 'active',
    },
    {
      id: 'routine_visual_dependency',
      name: 'Dependency follow-up',
      scheduleInput: '*/30 * * * *',
      nextRunAt: Date.UTC(2026, 7, 25, 20, 30),
      pause: false,
      referenceState: 'needs_attention',
    },
  ];
  for (const item of definitions) {
    const service = new RoutineService(routines, { routineId: () => item.id });
    let routine = await service.save({
      action: 'create',
      actorId: 'UVISUALOWNER',
      workspaceId: WORKSPACE_ID,
      channelId: 'C_RELEASES',
      definition: {
        name: item.name,
        description: 'Visual schedule fixture.',
        taskText: 'Post a concise visual-fixture update.',
        triggerKind: 'schedule',
        scheduleInput: item.scheduleInput,
        scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: item.scheduleInput }),
        timezone: 'America/Los_Angeles',
        outputPolicy: 'post',
        authorityMode: 'live_channel_v1',
      },
      nextRunAt: item.nextRunAt,
      projectedDailyStarts: 1,
      reservations: [{ windowStart: item.nextRunAt, count: 1 }],
      sourceVisibility: 'public',
    }, `visual-schedule:${item.id}`);
    if (item.pause) {
      routine = await service.control({
        routineId: routine.id,
        expectedVersion: routine.version,
        action: 'pause',
        actorId: 'UVISUALOWNER',
        actorClass: 'operator',
        reasonCode: 'admin_control',
        idempotencyKey: `visual-schedule-pause:${item.id}`,
      });
    }
    await store.putAgentScheduleReference({
      scheduleId: routine.id,
      agentId: 'agent_release',
      workspaceId: WORKSPACE_ID,
      channelId: 'C_RELEASES',
      createdByMembershipId: ownerMembershipId,
      runsAsMembershipId: ownerMembershipId,
      authorityReceiptId: `receipt_${item.id}`,
      requiredConnectionAccountIds: [],
      state: item.referenceState,
    });
  }
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
      app_id: 'AVISUAL',
      team: 'Acme Design',
      team_id: WORKSPACE_ID,
      user_id: LOCAL_SLACK_BOT_ID,
      bot_id: 'B_VISUAL',
    };
  }
  if (pathname.endsWith('/users.info')) {
    const visualProfiles = {
      UVISUALOWNER: ['Pejman Pour-Moezzi', 'pejman.pourmoezzi', 'pejman@example.com'],
      UVISUALADMIN: ['Alex Admin', 'alex.admin', 'alex@example.com'],
      UVISUALMEMBER: ['Maya Member', 'maya.member', 'maya@example.com'],
      UVISUALOWNER2: ['Olive Owner', 'olive.owner', 'olive@example.com'],
      UVISUALSUSPENDED: ['Sam Suspended', 'sam.suspended', 'sam@example.com'],
      UVISUALREMOVED: ['Rae Removed', 'rae.removed', 'rae@example.com'],
    };
    const profile = visualProfiles[body.user];
    if (profile) {
      return {
        ok: true,
        user: {
          id: body.user,
          team_id: WORKSPACE_ID,
          name: profile[1],
          profile: {
            display_name: profile[1],
            real_name: profile[0],
            email: profile[2],
            image_192: 'https://secure.gravatar.com/avatar/205e460b479e2e5b48aec07710c08d50?s=192&d=identicon',
          },
        },
      };
    }
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
    const channel = VISUAL_CHANNELS
      .find((candidate) => candidate.id === body.channel);
    return channel
      ? { ok: true, channel }
      : { ok: false, error: 'channel_not_found' };
  }
  return { ok: false, error: 'fixture_endpoint_not_found' };
}

async function nodeRequest(req, res, app, baseUrl, platformEnv) {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(new URL(req.url ?? '/', baseUrl), {
      method: req.method,
      headers: req.headers,
      ...(body ? { body } : {}),
    });
    const response = await app.fetch(request, platformEnv);
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
  const runtimeContract = options.runtimeContract ?? 'legacy';
  const onboardingStage = options.onboardingStage ?? null;
  const principalRole = options.principalRole ?? 'owner';
  assertLoopbackHost(host);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Admin visual fixture port must be an integer from 0 to 65535, received ${port}.`);
  }
  if (runtimeContract !== 'legacy' && runtimeContract !== 'chickpea-v1') {
    throw new Error(`Admin visual fixture runtime contract must be legacy or chickpea-v1, received ${runtimeContract}.`);
  }
  if (onboardingStage !== null && ![
    'choose_provider', 'choose_model', 'try',
  ].includes(onboardingStage)) {
    throw new Error(`Unknown onboarding visual stage ${onboardingStage}.`);
  }
  if (!['owner', 'admin', 'member'].includes(principalRole)) {
    throw new Error(`Unknown Admin visual principal role ${principalRole}.`);
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
    const {
      renderSlackAccessDeniedPage,
      renderSlackOwnerCompletePage,
      renderSlackRecoveryPage,
      renderSlackSetupPage,
      renderSlackSignInPage,
    } = await loadTsModule('src/admin/page.ts');
    const {
      renderManagedConnectionSetupPage,
      renderManagedConnectionSuccessPage,
      renderManagedConnectionWaitingPage,
    } = await loadTsModule('src/management/connector-landing-page.ts');
    const {
      buildSlackAppManifest,
      slackManifestPrefillUrl,
    } = await loadTsModule('src/slack/app-manifest.ts');
    const { SqliteConfigStore } = await loadTsModule('src/config/store.ts');
    const { SqliteSettingsStore } = await loadTsModule('src/config/settings-store.ts');
    const { PROVIDER_KEY_SETTING_KEYS } = await loadTsModule('src/config/provider-keys.ts');
    const { SqliteMemoryStateStore } = await loadTsModule('src/memory/store.ts');
    const { SqliteRoutineStore } = await loadTsModule('src/routines/store.ts');
    const { RoutineService } = await loadTsModule('src/routines/service.ts');
    const { SqliteUsageStore } = await loadTsModule('src/usage/store.ts');
    const { SqliteWorkStore } = await loadTsModule('src/work/store.ts');
    const { SqliteSlackStateStore } = await loadTsModule('src/slack/claim-store.ts');
    const { SqliteAgentSnapshotStore } = await loadTsModule('src/config/snapshot-store.ts');
    const { SqliteIdentityStore } = await loadTsModule('src/identity/store.ts');
    const { provisionSlackInteractionMember } = await loadTsModule('src/auth/slack-admission.ts');
    const {
      beginOnboardingJourney,
      selectOnboardingProvider,
      startOnboardingTry,
    } = await loadTsModule('src/config/onboarding-state.ts');
    const { generateCredentialKeyring } = await loadTsModule('src/slack/credential-keyring.ts');
    const { writeSlackInstallationCredentials } = await loadTsModule('src/slack/installation-credentials.ts');
    const { WORKSPACE_SLACK_INSTALLATION_ID } = await loadTsModule('src/config/types.ts');
    const {
      invalidateSlackChannelsCache,
    } = await loadTsModule('src/slack/channels.ts');
    const {
      invalidateStoredSlackCredentials,
    } = await loadTsModule('src/slack/credentials.ts');

    invalidateSlackChannelsCache();
    invalidateStoredSlackCredentials();

    const store = new SqliteConfigStore(stateDbPath, {
      agents: visualAgents(),
      grants: [],
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

    await seedConfig(store, runtimeContract);
    await seedSettings(settings);
    if (onboardingStage) {
      if (onboardingStage === 'choose_model' || onboardingStage === 'try') {
        await settings.setSetting(
          PROVIDER_KEY_SETTING_KEYS.anthropic,
          'sk-ant-local-admin-visual-fixture',
        );
      }
      let onboarding = await beginOnboardingJourney(settings, Date.now());
      if (onboardingStage === 'choose_model' || onboardingStage === 'try') {
        onboarding = await selectOnboardingProvider(settings, {
          expectedRevision: onboarding.revision,
          workspaceId: WORKSPACE_ID,
          providerId: 'anthropic',
        });
      }
      if (onboardingStage === 'try') {
        await startOnboardingTry(settings, {
          expectedRevision: onboarding.revision,
          agentId: 'agent_chickpea',
          modelId: 'anthropic/claude-sonnet-5',
          slackUserId: 'UVISUAL',
          tryStartedAt: Date.now(),
        });
      }
    }
    const slackCredentials = {
      state: identity,
      keyring: generateCredentialKeyring(),
    };
    await writeSlackInstallationCredentials(
      slackCredentials,
      WORKSPACE_SLACK_INSTALLATION_ID,
      null,
      {
        botToken: LOCAL_SLACK_TOKEN,
        signingSecret: LOCAL_SLACK_SECRET,
        botUserId: LOCAL_SLACK_BOT_ID,
        appId: 'AVISUAL',
        teamId: WORKSPACE_ID,
      },
    );
    await seedMemory(memory);
    const owner = await seedVisualSlackOwner(identity);
    await seedConnections(store, owner.membership.id);
    await seedSchedules(store, routines, owner.membership.id, RoutineService);
    await seedVisualTeam(identity, provisionSlackInteractionMember, owner);

    const adminToken = `visual-${randomBytes(18).toString('base64url')}`;
    const app = new Hono();
    const authManifest = buildSlackAppManifest({
      kind: 'workspace_app', origin: 'https://chickpea.example',
    });
    const authSetup = (state) => ({
      id: 'setup_visual', state, revision: 4, destination: '/admin/channels',
      createdAt: 1, updatedAt: 2, expiresAt: Date.now() + 86_400_000,
      appId: 'AVISUAL', manifestFingerprint: 'f'.repeat(64),
      credentialRevision: 'slackrev_visual',
    });
    const authPages = {
      'sign-in': renderSlackSignInPage('/admin/channels'),
      'setup-create': renderSlackSetupPage({
        setup: authSetup('awaiting_app_creation'), destination: '/admin/channels',
        manifest: authManifest, manifestPrefillUrl: slackManifestPrefillUrl(authManifest),
      }),
      'setup-connected': renderSlackSetupPage({
        setup: authSetup('awaiting_app_creation'), destination: '/admin/channels',
        manifest: authManifest, manifestPrefillUrl: slackManifestPrefillUrl(authManifest),
        gatewayState: 'connected',
      }),
      'setup-approval': renderSlackSetupPage({
        setup: authSetup('approval_pending'), destination: '/admin/channels',
        manifest: authManifest, manifestPrefillUrl: slackManifestPrefillUrl(authManifest),
      }),
      'setup-owner': renderSlackSetupPage({
        setup: authSetup('bot_installed'), destination: '/admin/channels',
        manifest: authManifest, manifestPrefillUrl: slackManifestPrefillUrl(authManifest),
      }),
      'access-denied': renderSlackAccessDeniedPage({
        purpose: 'login', destination: '/admin/channels', reason: 'user_mismatch',
        workspace: { teamId: WORKSPACE_ID, teamName: 'Acme' },
      }),
      'owner-complete': renderSlackOwnerCompletePage('/admin/channels'),
      recovery: renderSlackRecoveryPage({
        stage: 'credentials', expectedAppId: 'AVISUAL', expectedTeamId: WORKSPACE_ID,
      }),
    };
    const sprout = {
      id: 'agent_sprout',
      revision: 1,
      name: 'Sprout',
      description: '',
      instructions: 'Help the requester research customer relationships.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    };
    const connectorSetup = {
      setupOperationId: 'setup_visual_connector',
      action: 'managed_connection',
      target: {
        kind: 'managed_connection',
        targetId: 'agent:agent_sprout:managed:hubspot:member',
        targetLabel: 'HubSpot',
        provider: 'hubspot',
        agentId: sprout.id,
        agentName: sprout.name,
        ownerKind: 'member',
        accessLane: 'read',
        presetId: 'hubspot-managed',
      },
      actor: {
        membershipId: owner.membership.id,
        organizationId: owner.membership.organizationId,
        slackTeamId: WORKSPACE_ID,
        slackUserId: owner.user.slackUserId,
      },
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 15 * 60_000,
    };
    const sproutAvatarPath = resolve('assets/chickpea-avatars/agent-defaults/01-sage.png');
    const connectorPageInput = (status) => ({
      setup: { ...connectorSetup, status },
      agent: sprout,
      avatarUrl: '/__admin_visual_fixture/connectors/sprout.png',
    });
    let connectorVisualConnected = false;
    app.get('/__admin_visual_fixture/login', (c) => {
      if (c.req.query('token') !== adminToken) return c.text('Not found', 404);
      c.header('Set-Cookie', `chickpea_visual_token=${adminToken}; Path=/; HttpOnly; SameSite=Lax`);
      c.header('Cache-Control', 'no-store');
      return c.redirect(c.req.query('destination') || '/admin/team');
    });
    app.get('/__admin_visual_fixture/auth/:state', (c) => {
      const html = authPages[c.req.param('state')];
      if (!html) return c.notFound();
      c.header('Cache-Control', 'no-store');
      return c.html(html);
    });
    app.get('/__admin_visual_fixture/connectors/sprout.png', (c) => {
      c.header('Cache-Control', 'public, max-age=3600');
      c.header('Content-Type', 'image/png');
      return c.body(readFileSync(sproutAvatarPath));
    });
    app.get('/__admin_visual_fixture/connectors/:state', (c) => {
      const state = c.req.param('state');
      if (state === 'setup') {
        connectorVisualConnected = false;
        return c.html(renderManagedConnectionSetupPage(connectorPageInput('pending')));
      }
      if (state === 'waiting') {
        return c.html(connectorVisualConnected
          ? renderManagedConnectionSuccessPage(connectorPageInput('completed'))
          : renderManagedConnectionWaitingPage(connectorPageInput('pending')));
      }
      if (state === 'success') {
        return c.html(renderManagedConnectionSuccessPage(connectorPageInput('completed')));
      }
      return c.notFound();
    });
    app.post('/setup/setup_visual_connector/authorize', (c) => {
      if (c.req.header('x-requested-with') === 'chickpea-setup') {
        return c.json({ authorizationUrl: 'https://example.com/chickpea-connector-sign-in' });
      }
      return c.redirect('/__admin_visual_fixture/connectors/waiting');
    });
    app.post('/setup/setup_visual_connector/managed/poll', (c) => {
      connectorVisualConnected = true;
      return c.json({ ok: true, status: 'connected' });
    });
    app.post('/setup/setup_visual_connector/cancel', (c) => c.redirect('/__admin_visual_fixture/connectors/setup'));
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
      slackCredentials,
      usageAdminUi: true,
      authService: {
        async authenticateRequest(request) {
          const cookies = request.headers.get('cookie') || '';
          const cookieAuthenticated = cookies.split(';').some((part) => part.trim() === `chickpea_visual_token=${adminToken}`);
          if (request.headers.get('authorization') !== `Bearer ${adminToken}` && !cookieAuthenticated) {
            throw new Error('Authentication unavailable.');
          }
          return {
            userId: owner.user.id,
            membershipId: owner.membership.id,
            organizationId: owner.membership.organizationId,
            role: principalRole,
            authenticatorKind: 'visual_slack_session',
            credentialId: 'visual_session',
            correlationId: 'visual_request',
            machine: false,
          };
        },
      },
      knownProviders: new Set(onboardingStage ? ['local-stub', 'cloudflare'] : ['local-stub']),
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
      environmentStatus: async () => VISUAL_ENVIRONMENT_STATUS,
    }));

    const platformEnv = onboardingStage
      ? { AI: { models() { return []; } } }
      : undefined;
    let baseUrl = '';
    server = createServer((req, res) => void nodeRequest(req, res, app, baseUrl, platformEnv));
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

    // The API endpoint is process-local. Slack secrets stay exclusively in the
    // encrypted fixture revision and never become runtime environment inputs.
    process.env.SLACK_API_URL = `${baseUrl}/__admin_visual_fixture/slack`;

    return {
      address: bound.address,
      adminToken,
      baseUrl,
      runtimeContract,
      onboardingStage,
      authStates: CANONICAL_SLACK_AUTH_VISUAL_STATES,
      connectorStates: CANONICAL_CONNECTOR_VISUAL_STATES,
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
  const parsed = { host: DEFAULT_HOST, port: 0, runtimeContract: 'legacy', onboardingStage: null };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--host') parsed.host = args[++index];
    else if (value === '--port') parsed.port = Number(args[++index]);
    else if (value === '--runtime-contract') parsed.runtimeContract = args[++index];
    else if (value === '--onboarding-stage') parsed.onboardingStage = args[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  return parsed;
}

async function runCli() {
  const fixture = await startAdminVisualFixture(parseCliArgs(process.argv.slice(2)));
  // Install cleanup before advertising readiness to a parent process or user.
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

  console.log(`Admin visual fixture: ${fixture.baseUrl}`);
  console.log(`Runtime contract: ${fixture.runtimeContract}`);
  if (fixture.onboardingStage) console.log(`Onboarding stage: ${fixture.onboardingStage}`);
  console.log(`Local login token: ${fixture.adminToken}`);
  console.log('Canonical states (production URLs; perform the listed UI actions after load):');
  for (const [name, state] of Object.entries(fixture.canonicalStates)) {
    const actions = state.actions.length ? ` then ${state.actions.join(' → ')}` : '';
    console.log(`  ${name}: ${fixture.baseUrl}${state.path}${actions}`);
  }
  console.log('Connector landing states:');
  for (const [name, state] of Object.entries(fixture.connectorStates)) {
    console.log(`  ${name}: ${fixture.baseUrl}${state.path}`);
  }
  console.log(`Temporary state: ${fixture.stateDbPath}`);
  console.log('Press Ctrl+C to stop and remove the temporary state.');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  runCli().catch((error) => {
    console.error(`${basename(fileURLToPath(import.meta.url))}:`, error);
    process.exitCode = 1;
  });
}
