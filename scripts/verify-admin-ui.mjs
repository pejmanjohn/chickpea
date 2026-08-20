#!/usr/bin/env node
/**
 * Prove the /admin configuration loop without Slack network access:
 *   1. mount the real Hono admin routes against an in-memory SQLite store,
 *   2. establish an exact Slack-bound Owner and authenticate as that principal,
 *   3. create two Agents and publish both to one Channel through the additive grant API,
 *   4. prove the Channel inventory exposes both grants without one replacing the other,
 *   5. seed Agent memory and prove Channel memory is forbidden while Agent-owned
 *      conflict, history, and irreversible-delete contracts remain available.
 */
import {
  assertNodeVersion,
  loadTsModule,
} from './lib/offline-harness.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADMIN_ORIGIN = 'https://admin-ui.example';
const WORKSPACE_ID = 'TADMINUI1';
const CHANNEL_ID = 'C_ADMIN_UI';
const CHANNEL_LABEL = 'eng-releases';
const AGENT_ID = 'agent_admin_ui';
const MODEL_SPECIFIER = 'local-stub/admin-ui-model';
const MEMORY_ENTRY_ID = 'mem_admin_ui_release';
const ROUTINE_ID = 'routine_admin_ui_release';

const results = [];

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

async function adminJson(app, path, options = {}) {
  const response = await app.request(path.startsWith('http') ? path : `${ADMIN_ORIGIN}${path}`, {
    ...options,
    headers: {
      origin: ADMIN_ORIGIN,
      'sec-fetch-site': 'same-origin',
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function adminBody(app, method, path, body) {
  return adminJson(app, path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let store;
let settings;
let memory;
let routines;
let usage;
let work;
let identity;
try {
  console.log(`node ${assertNodeVersion()}`);
  const { Hono } = await import('hono');
  const { createAdminRoutes } = await loadTsModule('src/admin/routes.ts');
  const { SqliteConfigStore } = await loadTsModule('src/config/store.ts');
  const { SqliteSettingsStore } = await loadTsModule('src/config/settings-store.ts');
  const { SqliteMemoryStateStore } = await loadTsModule('src/memory/store.ts');
  const { SqliteRoutineStore } = await loadTsModule('src/routines/store.ts');
  const { RoutineService } = await loadTsModule('src/routines/service.ts');
  const { SqliteUsageStore } = await loadTsModule('src/usage/store.ts');
  const { SqliteWorkStore } = await loadTsModule('src/work/store.ts');
  const { SqliteIdentityStore } = await loadTsModule('src/identity/store.ts');
  const statePath = join(mkdtempSync(join(tmpdir(), 'chickpea-admin-ui-')), 'state.db');
  store = new SqliteConfigStore(statePath, { agents: [], assignments: [] });
  settings = new SqliteSettingsStore(statePath);
  memory = new SqliteMemoryStateStore(statePath);
  routines = new SqliteRoutineStore(statePath);
  usage = new SqliteUsageStore(statePath);
  work = new SqliteWorkStore(statePath);
  identity = new SqliteIdentityStore(statePath);
  const ownerOperation = await identity.createAuthOperation({
    id: 'first_owner_admin_ui', kind: 'first_owner_claim',
    expectedSlackTeamId: 'TADMINUI1', expectedSlackUserId: 'UADMINUI1',
    chickpeaRole: 'owner', capabilityHash: 'a'.repeat(64),
    expiresAt: Date.now() + 60_000,
  });
  await identity.createOwnerClaim({
    operationId: ownerOperation.id,
    slackTeamId: 'TADMINUI1', slackUserId: 'UADMINUI1',
  });
  await identity.advanceAuthOperation({
    operationId: ownerOperation.id, capabilityHash: 'a'.repeat(64), step: 1,
    betterAuthUserId: 'ba_user_admin_ui',
    betterAuthOrganizationId: '11111111-1111-4111-8111-111111111111',
    betterAuthMembershipId: 'ba_member_admin_ui',
  });
  const owner = await identity.claimOwner({
    operationId: ownerOperation.id, organizationId: 'org_oss',
    slackTeamId: 'TADMINUI1', slackUserId: 'UADMINUI1', displayName: 'Admin UI Owner',
    betterAuthUserId: 'ba_user_admin_ui', betterAuthMembershipId: 'ba_member_admin_ui',
  });
  await identity.updateOrganizationAuth({
    organizationId: owner.membership.organizationId,
    authMode: 'slack_active', canonicalAdminOrigin: ADMIN_ORIGIN,
  });
  const authControl = await identity.getAuthControl();
  await identity.updateAuthControl({
    expectedRevision: authControl.revision,
    canonicalAdminOrigin: ADMIN_ORIGIN,
  });
  const usageNow = Date.now();
  await work.admitShadowRun({
    work: {
      id: 'work_admin_ui_release', kind: 'conversation', maximumSensitivity: 'public',
      createdAt: usageNow - 10_000,
    },
    binding: {
      id: 'binding_admin_ui_release', workId: 'work_admin_ui_release', adapterKind: 'slack',
      externalAccountId: 'account_admin_ui_release',
      externalConversationId: 'conversation_admin_ui_release', generation: 1,
      sourceVisibility: 'public', configMode: 'frozen_on_open',
      orderingKey: 'ordering_admin_ui_release', createdAt: usageNow - 10_000,
    },
    run: {
      id: 'run_admin_ui_release', workId: 'work_admin_ui_release',
      bindingId: 'binding_admin_ui_release', kind: 'interactive',
      triggerKind: 'admin_ui_verifier', triggerRef: 'trigger_admin_ui_release',
      dedupeKey: 'dedupe_admin_ui_release', actorTrustTier: 'system',
      effectiveCapabilityDigest: 'b'.repeat(64), executionAuthority: 'legacy',
      coordinatorKind: 'interactive', authorityEpoch: 1, createdAt: usageNow - 10_000,
    },
    safeConfig: {
      schemaVersion: 1, profileId: AGENT_ID, configuredModel: MODEL_SPECIFIER,
      snapshotDigest: 'a'.repeat(64), capabilityDigest: 'b'.repeat(64),
      skillNames: [], connectionIds: [], repositoryIds: [], memoryMode: 'public',
      ceilings: { maxModelAttempts: 3, maxToolCalls: 20, maxActionAttempts: 0, timeoutMs: 120_000 },
    },
    triggerContent: { sensitivity: 'public', body: 'Admin UI Run trigger' },
    auditEventId: 'audit_admin_ui_release',
    auditIdempotencyKey: 'auditkey_admin_ui_release',
  });
  await usage.admitOperation({
    operationId: 'usage_admin_ui_release',
    runId: 'run_admin_ui_release',
    operationKind: 'interactive_turn',
    sourceId: 'slack:C_ADMIN_UI:usage',
    startedAt: usageNow - 10_000,
    installationId: 'admin-ui-installation',
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    agentLabel: 'Admin UI Agent',
    channelId: CHANNEL_ID,
    channelLabel: CHANNEL_LABEL,
    conversationKind: 'named_channel',
    requestedProvider: 'openai',
    requestedModel: 'gpt-4.1-mini',
    credentialRefId: 'cred_openai_admin_ui',
    credentialVersion: 1,
  });
  await usage.recordTerminal({
    operationId: 'usage_admin_ui_release',
    executionId: 'usage_exec_admin_ui_release',
    status: 'completed',
    finishedAt: usageNow - 5_000,
    observedAt: usageNow - 5_000,
    providerRoute: 'openai',
    requestedProvider: 'openai',
    requestedModel: 'gpt-4.1-mini',
    returnedProvider: 'openai',
    returnedModel: 'gpt-4.1-mini',
    credentialRefId: 'cred_openai_admin_ui',
    credentialVersion: 1,
    usageCompleteness: 'complete',
    inputTokens: 1_000,
    outputTokens: 250,
    totalTokens: 1_250,
    usageUnknownReason: null,
    estimateCompleteness: 'complete',
    estimateAmountMicros: 800,
    estimateCurrency: 'USD',
    priceVersionId: 'openai_2026-07-28',
    priceUnknownReason: null,
  });
  const agentMemory = await memory.ensureOwner({
    workspaceId: WORKSPACE_ID,
    ownerKind: 'agent',
    ownerId: AGENT_ID,
  });
  await memory.createOwnerEntry({
    entryId: MEMORY_ENTRY_ID,
    storeId: agentMemory.storeId,
    workspaceId: WORKSPACE_ID,
    slug: 'release-principles',
    description: 'Reusable release principles.',
    type: 'preference',
    body: 'Prefer small, reversible releases.',
    actorId: 'U_ADMIN_UI_MEMBER',
    actorClass: 'member',
    writeOrigin: { kind: 'admin' },
    idempotencyKey: 'admin-ui-agent-memory-create',
  });
  await memory.observeChannelScope({
    workspaceId: WORKSPACE_ID,
    channelId: CHANNEL_ID,
    privacy: 'public',
    displayName: CHANNEL_LABEL,
    observedAt: Date.now(),
  });
  const routineService = new RoutineService(routines, {
    now: Date.now,
    routineId: () => ROUTINE_ID,
  });
  const routine = await routineService.save({
    action: 'create',
    actorId: 'U_ADMIN_UI_MEMBER',
    workspaceId: WORKSPACE_ID,
    channelId: CHANNEL_ID,
    definition: {
      name: 'Release readiness check',
      description: 'Checks launch blockers every weekday.',
      taskText: 'Review launch blockers and make safe progress.',
      triggerKind: 'schedule',
      scheduleInput: '0 9 * * 1-5',
      scheduleJson: '{"version":1,"kind":"cron","expression":"0 9 * * 1-5"}',
      timezone: 'America/Los_Angeles',
      outputPolicy: 'post',
      authorityMode: 'live_channel_v1',
    },
    nextRunAt: Date.now() + 3_600_000,
    projectedDailyStarts: 5,
    reservations: [{ windowStart: Date.now() + 3_600_000, count: 1 }],
    sourceVisibility: 'public',
  }, 'admin-ui-routine-create');
  await routines.createOccurrence({
    runId: 'rrun_admin_ui_release',
    idempotencyKey: 'admin-ui-routine-run',
    routineId: routine.id,
    routineVersion: routine.version,
    scheduledFor: Date.now(),
    triggerSource: 'run_now',
    requestedBy: 'U_ADMIN_UI_MEMBER',
    queuedAt: Date.now(),
    deadlineAt: Date.now() + 900_000,
  });
  const app = new Hono();
  const userGroups = [];
  const slackChannel = {
    id: CHANNEL_ID, name: CHANNEL_LABEL, private: false, member: true, archived: false,
  };
  const slackTransport = {
    mode: 'direct',
    async lookupMember(userId) {
      return { id: userId, teamId: WORKSPACE_ID, deleted: false, bot: false, appUser: false, restricted: false, ultraRestricted: false, stranger: false };
    },
    async lookupChannel() { return slackChannel; },
    async listChannels() { return { channels: [slackChannel], truncated: false }; },
    async channelHasMember() { return true; },
    async openDirectConversation(userId) { return { ...slackChannel, id: `D_${userId}`, private: true }; },
    async joinPublicChannel() { return slackChannel; },
    async listUserGroups() { return [...userGroups]; },
    async createUserGroup(input) {
      const group = { id: `S${userGroups.length + 1}`, ...input, disabled: false, updatedAt: Math.floor(Date.now() / 1000) };
      userGroups.push(group);
      return group;
    },
    async updateUserGroup(id, patch) {
      const group = userGroups.find((candidate) => candidate.id === id);
      Object.assign(group, patch);
      return group;
    },
    async disableUserGroup(id) { return this.updateUserGroup(id, { disabled: true }); },
    async enableUserGroup(id) { return this.updateUserGroup(id, { disabled: false }); },
    async publishAppHome() { return {}; },
    async postMessage() { return { channelId: CHANNEL_ID, ts: '1.0' }; },
  };
  app.route(
    '/',
    createAdminRoutes({
      store,
      settings,
      memory,
      routines,
      usage,
      work,
      identity,
      usageAdminUi: true,
      authService: {
        async authenticateRequest() {
          return {
            userId: owner.user.id,
            membershipId: owner.membership.id,
            organizationId: owner.membership.organizationId,
            role: 'owner',
            authenticatorKind: 'better_auth',
            credentialId: 'better_auth_session_admin_ui',
            correlationId: 'request_admin_ui_verifier',
            machine: false,
          };
        },
      },
      knownProviders: new Set(['local-stub']),
      slackTransport,
    }),
  );

  const retiredLogin = await app.request(`${ADMIN_ORIGIN}/admin/login`, { method: 'POST' });
  const pageResponse = await app.request(`${ADMIN_ORIGIN}/admin`);
  const pageHtml = await pageResponse.text();
  record(
    'Slack-bound Owner opens Admin while the retired token login stays absent',
    retiredLogin.status === 404 &&
      pageResponse.status === 200 &&
      pageResponse.headers.get('cache-control') === 'no-store' &&
      pageHtml.includes('Agents available here') &&
      !pageHtml.includes('Resolved configuration') &&
      pageHtml.includes('data-action="copy-channel-prompt"'),
    `retiredLogin=${retiredLogin.status} page=${pageResponse.status}`,
  );

  record(
    'admin page keeps Agent-owned Scheduled Work audit without Channel-memory navigation',
    pageHtml.includes('Audit logs') &&
      !pageHtml.includes('SESSIONS_ADMIN_UI') &&
      !pageHtml.includes('data-action="open-sessions"') &&
      pageHtml.includes('data-action="audit-tab-scheduled">Scheduled work') &&
      !pageHtml.includes('data-action="audit-tab-memory"') &&
      pageHtml.includes('aria-disabled="true" title="Coming later">Network events'),
  );

  record(
    'workspace-default Slack setup has no browser credential paste-back surface',
    pageHtml.includes('Bot tokens are never pasted into Admin') &&
      !pageHtml.includes('data-action="slack-connect-form"') &&
      !pageHtml.includes('data-action="slack-update-open"') &&
      !pageHtml.includes('id="onboarding-signing-secret"') &&
      !pageHtml.includes('id="onboarding-bot-token"'),
  );

  const usageOverview = await adminJson(
    app,
    `/admin/api/usage/overview?from=${usageNow - 86_400_000}&to=${usageNow + 1}&groupBy=channel&currency=USD`,
  );
  const usageMetadata = await adminJson(app, '/admin/api/usage/metadata');
  const usageOperations = await adminJson(
    app,
    `/admin/api/usage/operations?from=${usageNow - 86_400_000}&to=${usageNow + 1}&limit=20`,
  );
  record(
    'Usage exposes estimated spend, channel attribution, work detail, and provider-owned limits',
    pageHtml.includes('var USAGE_ADMIN_UI = true') &&
      usageOverview.status === 200 &&
      usageOverview.body?.current?.totals?.operationCount === 1 &&
      usageOverview.body?.current?.totals?.estimateAmountMicros === 800 &&
      usageOverview.body?.current?.groups?.[0]?.key === CHANNEL_ID &&
      usageOverview.body?.current?.groups?.[0]?.label === null &&
      usageMetadata.status === 200 &&
      usageMetadata.body?.contract?.providerBillingIncluded === false &&
      usageMetadata.body?.contract?.limitsManagedByChickpea === false &&
      usageOperations.status === 200 &&
      usageOperations.body?.items?.[0]?.operation?.operationId === 'usage_admin_ui_release' &&
      usageOperations.body?.items?.[0]?.operation?.runId === 'run_admin_ui_release' &&
      !Object.hasOwn(usageOperations.body?.items?.[0] ?? {}, 'sessionDeepLink'),
    `overview=${usageOverview.status} metadata=${usageMetadata.status} operations=${usageOperations.status}`,
  );

  const sessions = await adminJson(app, '/admin/api/sessions?limit=20');
  const sessionDetail = await adminJson(app, '/admin/api/sessions/run_admin_ui_release');
  const retiredSessionsPage = await adminJson(app, '/admin/sessions/run_admin_ui_release');
  record(
    'Run inspection APIs remain available without exposing a Sessions page',
    sessions.status === 200 &&
      sessions.body?.items?.[0]?.runId === 'run_admin_ui_release' &&
      !Object.hasOwn(sessions.body?.items?.[0] ?? {}, 'deepLink') &&
      sessionDetail.status === 200 &&
      sessionDetail.body?.projection === 'public' &&
      sessionDetail.body?.session?.status === 'admitted' &&
      sessionDetail.body?.content?.trigger?.body === 'Admin UI Run trigger' &&
      sessionDetail.body?.usage?.state === 'reported' &&
      retiredSessionsPage.status === 302,
    `list=${sessions.status} detail=${sessionDetail.status} page=${retiredSessionsPage.status}`,
  );

  const routineList = await adminJson(app, '/admin/api/audit/scheduled_work/routines?state=active');
  const routineDetail = await adminJson(app, `/admin/api/audit/scheduled_work/routines/${ROUTINE_ID}`);
  record(
    'Scheduled Work lists definitions and safe occurrence detail through the real state store',
    routineList.status === 200 &&
      routineList.body?.routines?.[0]?.id === ROUTINE_ID &&
      routineList.body?.routines?.[0]?.taskText === undefined &&
      routineDetail.status === 200 &&
      routineDetail.body?.routine?.taskText === 'Review launch blockers and make safe progress.' &&
      routineDetail.body?.runs?.[0]?.id === 'rrun_admin_ui_release' &&
      routineDetail.body?.runs?.[0]?.revision === undefined,
    `list=${routineList.status} detail=${routineDetail.status}`,
  );

  const pausedRoutine = await adminJson(
    app,
    `/admin/api/audit/scheduled_work/routines/${ROUTINE_ID}/control`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'admin-ui-routine-pause' },
      body: JSON.stringify({ action: 'pause', expectedVersion: 1 }),
    },
  );
  record(
    'Scheduled Work control uses optimistic versioning and appends audit state',
    pausedRoutine.status === 200 && pausedRoutine.body?.routine?.state === 'paused' &&
      (await routines.listAuditEvents({ subjectId: ROUTINE_ID, limit: 20 })).length >= 2,
    `status=${pausedRoutine.status}`,
  );

  const created = await adminBody(app, 'POST', '/admin/api/agents', {
    id: AGENT_ID,
    name: 'Admin UI Agent',
    instructions: 'ADMIN_UI_AGENT_INSTRUCTIONS: answer from the admin-created Agent.',
    enabled: true,
    model: MODEL_SPECIFIER,
  });
  record(
    'POST /admin/api/agents creates the Agent',
    created.status === 201 && created.body?.agent?.id === AGENT_ID,
    `status=${created.status}`,
  );

  const assigned = await adminBody(app, 'POST', `/admin/api/agents/${AGENT_ID}/channels`, {
    workspaceId: WORKSPACE_ID,
    channelId: CHANNEL_ID,
  });
  record(
    'POST /admin/api/agents/:id/channels publishes the first Agent grant',
    assigned.status === 201 && assigned.body?.grant?.agentId === AGENT_ID &&
      assigned.body?.grant?.status === 'active',
    `status=${assigned.status}`,
  );

  const secondAgentId = 'agent_admin_ui_two';
  const secondCreated = await adminBody(app, 'POST', '/admin/api/agents', {
    id: secondAgentId,
    name: 'Release Analyst',
    instructions: 'Review release risk.',
    enabled: true,
    model: MODEL_SPECIFIER,
  });
  const secondPublished = await adminBody(app, 'POST', `/admin/api/agents/${secondAgentId}/channels`, {
    workspaceId: WORKSPACE_ID,
    channelId: CHANNEL_ID,
  });
  const channelInventory = await adminJson(app, '/admin/api/channels');
  const verifiedChannel = channelInventory.body?.channels?.find((channel) => channel.channelId === CHANNEL_ID);
  record(
    'Channel inventory keeps multiple additive Agent grants',
    secondCreated.status === 201 && secondPublished.status === 201 && channelInventory.status === 200 &&
      verifiedChannel?.grants?.length === 2 &&
      verifiedChannel.grants.some((grant) => grant.agentId === AGENT_ID) &&
      verifiedChannel.grants.some((grant) => grant.agentId === secondAgentId),
    `create=${secondCreated.status} publish=${secondPublished.status} grants=${String(verifiedChannel?.grants?.length)}`,
  );

  const owners = await adminJson(app, `/admin/api/audit/memory/owners?workspaceId=${WORKSPACE_ID}`);
  const channelFiles = await adminJson(
    app,
    `/admin/api/audit/memory/owners/channel/${WORKSPACE_ID}/${CHANNEL_ID}/files`,
  );
  const agentFiles = await adminJson(
    app,
    `/admin/api/audit/memory/owners/agent/${WORKSPACE_ID}/${AGENT_ID}/files`,
  );
  record(
    'Memory is Agent-owned and exact-Channel memory is forbidden',
    owners.status === 200 &&
      owners.body?.owners?.some((owner) => owner.ownerKind === 'agent' && owner.ownerId === AGENT_ID) &&
      !owners.body?.owners?.some((owner) => owner.ownerKind === 'channel') &&
      channelFiles.status === 403 &&
      agentFiles.status === 200 &&
      agentFiles.body?.files?.[1]?.name === 'release-principles.md',
    `owners=${owners.status} channel=${channelFiles.status} agent=${agentFiles.status}`,
  );

  const agentEntryPath =
    `/admin/api/audit/memory/owners/agent/${WORKSPACE_ID}/${AGENT_ID}/entries/${MEMORY_ENTRY_ID}`;

  const editBody = JSON.stringify({
    expectedVersion: 1,
    description: 'Use the full release checklist.',
    type: 'project',
    body: 'Run focused tests and the durability gate before release.',
  });
  const edit = await adminJson(app, agentEntryPath, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'admin-ui-memory-edit' },
    body: editBody,
  });
  const conflict = await adminJson(app, agentEntryPath, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'admin-ui-memory-conflict' },
    body: editBody,
  });
  record(
    'Memory edit is versioned and a stale draft receives 409 without overwrite',
    edit.status === 200 && edit.body?.entry?.version === 2 &&
      conflict.status === 409 && conflict.body?.currentVersion === 2,
    `edit=${edit.status} conflict=${conflict.status}`,
  );

  const history = await adminJson(app, `${agentEntryPath}/history`);
  record(
    'Agent memory history stays under the Agent owner route',
    history.status === 200 && history.body?.revisions?.length === 2,
    `status=${history.status} revisions=${String(history.body?.revisions?.length)}`,
  );

  const unacknowledgedDelete = await adminJson(
    app,
    agentEntryPath,
    {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'admin-ui-memory-delete-rejected' },
      body: JSON.stringify({ expectedVersion: 2, acknowledgeIrreversible: false }),
    },
  );
  const deleted = await adminJson(app, agentEntryPath, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'admin-ui-memory-delete' },
    body: JSON.stringify({ expectedVersion: 2, acknowledgeIrreversible: true }),
  });
  const deletedEntry = await memory.getOwnerEntry(MEMORY_ENTRY_ID);
  record(
    'Memory delete requires explicit acknowledgement and scrubs canonical content',
    unacknowledgedDelete.status === 400 && deleted.status === 200 &&
      deletedEntry?.status === 'forgotten' && deletedEntry.body === '' &&
      deletedEntry.description === '' && deletedEntry.contentHash === null,
    `unacknowledged=${unacknowledgedDelete.status} deleted=${deleted.status}`,
  );
} catch (error) {
  record('verification harness', false, error instanceof Error ? error.message : String(error));
} finally {
  store?.close();
  settings?.close();
  memory?.close();
  routines?.close();
  usage?.close();
  work?.close();
  identity?.close();
}

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
