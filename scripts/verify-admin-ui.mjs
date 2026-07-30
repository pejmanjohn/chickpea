#!/usr/bin/env node
/**
 * Prove the /admin configuration loop without Slack credentials:
 *   1. mount the real Hono admin routes against an in-memory SQLite store,
 *   2. exchange the POSTed admin token for a browser session cookie,
 *   3. create a profile and addendum-bearing assignment through /admin/api,
 *   4. read the server-side effective-config panel data,
 *   5. edit the addendum and prove the panel data changes in the same process,
 *   6. seed the real Memory store and prove scope/index, conflict, and
 *      irreversible-delete contracts through the authenticated admin plane.
 */
import {
  assertNodeVersion,
  loadTsModule,
} from './lib/offline-harness.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADMIN_TOKEN = 'admin-ui-admin-token';
const WORKSPACE_ID = 'T_ADMIN_UI';
const CHANNEL_ID = 'C_ADMIN_UI';
const CHANNEL_LABEL = 'eng-releases';
const AGENT_ID = 'agent_admin_ui';
const MODEL_SPECIFIER = 'local-stub/admin-ui-model';
const FIRST_ADDENDUM = 'ADMIN_UI_ADDENDUM_V1: prefer release readiness.';
const SECOND_ADDENDUM = 'ADMIN_UI_ADDENDUM_V2: prefer launch-risk deltas.';
const MEMORY_ENTRY_ID = 'mem_admin_ui_release';
const ROUTINE_ID = 'routine_admin_ui_release';

const results = [];

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

async function adminJson(app, path, options = {}) {
  const response = await app.request(path, {
    ...options,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
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

async function readEffectiveConfig(app) {
  return adminJson(
    app,
    `/admin/api/effective-config?workspaceId=${encodeURIComponent(WORKSPACE_ID)}` +
      `&channelId=${encodeURIComponent(CHANNEL_ID)}`,
  );
}

let store;
let memory;
let routines;
let usage;
let work;
try {
  console.log(`node ${assertNodeVersion()}`);
  const { Hono } = await import('hono');
  const { createAdminRoutes } = await loadTsModule('src/admin/routes.ts');
  const { SqliteConfigStore } = await loadTsModule('src/config/store.ts');
  const { SqliteMemoryStateStore } = await loadTsModule('src/memory/store.ts');
  const { SqliteRoutineStore } = await loadTsModule('src/routines/store.ts');
  const { RoutineService } = await loadTsModule('src/routines/service.ts');
  const { SqliteUsageStore } = await loadTsModule('src/usage/store.ts');
  const { SqliteWorkStore } = await loadTsModule('src/work/store.ts');
  const statePath = join(mkdtempSync(join(tmpdir(), 'chickpea-admin-ui-')), 'state.db');
  store = new SqliteConfigStore(statePath, { agents: [], assignments: [] });
  memory = new SqliteMemoryStateStore(statePath);
  routines = new SqliteRoutineStore(statePath);
  usage = new SqliteUsageStore(statePath);
  work = new SqliteWorkStore(statePath);
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
    profileId: AGENT_ID,
    profileLabel: 'Admin UI Profile',
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
  const publicMemory = await memory.ensurePublicStore(WORKSPACE_ID);
  await memory.observeChannelScope({
    workspaceId: WORKSPACE_ID,
    channelId: CHANNEL_ID,
    privacy: 'public',
    displayName: CHANNEL_LABEL,
    observedAt: Date.now(),
  });
  await memory.createEntry({
    entryId: MEMORY_ENTRY_ID,
    storeId: publicMemory.storeId,
    workspaceId: WORKSPACE_ID,
    sourceChannelId: CHANNEL_ID,
    slug: 'release-guidance',
    description: 'Use the release checklist.',
    type: 'project',
    body: 'Run focused tests before release.',
    actorId: 'U_ADMIN_UI_MEMBER',
    actorClass: 'member',
    idempotencyKey: 'admin-ui-memory-create',
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
  app.route(
    '/',
    createAdminRoutes({
      store,
      memory,
      routines,
      usage,
      work,
      usageAdminUi: true,
      adminToken: ADMIN_TOKEN,
      knownProviders: new Set(['local-stub']),
    }),
  );

  const loginForm = await app.request('/admin');
  const loginHtml = await loginForm.text();
  const login = await app.request('/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: ADMIN_TOKEN, returnTo: '/admin' }).toString(),
  });
  const sessionCookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const pageResponse = await app.request('/admin', { headers: { cookie: sessionCookie } });
  const pageHtml = await pageResponse.text();
  record(
    'POST /admin/login exchanges the body token for the UI session',
    loginForm.status === 401 &&
      loginHtml.includes('method="post" action="/admin/login"') &&
      login.status === 303 &&
      login.headers.get('location') === '/admin' &&
      sessionCookie.startsWith('flue_admin=') &&
      pageResponse.status === 200 &&
      pageHtml.includes('Access summary'),
    `login=${login.status} page=${pageResponse.status}`,
  );

  record(
    'admin page carries live Scheduled Work and Memory audit domains',
    pageHtml.includes('Audit logs') &&
      pageHtml.includes('data-action="open-sessions"') &&
      pageHtml.includes('data-action="audit-tab-scheduled">Scheduled work') &&
      pageHtml.includes('data-action="audit-tab-memory">Memory') &&
      pageHtml.includes('aria-disabled="true" title="Coming later">Network events') &&
      pageHtml.includes('Generated index · changes are made through individual files.') &&
      pageHtml.includes('Prior exports, Slack or provider logs, backups, and Flue transcripts may still retain copies'),
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
      usageOperations.body?.items?.[0]?.sessionDeepLink === '/admin/sessions/run_admin_ui_release',
    `overview=${usageOverview.status} metadata=${usageMetadata.status} operations=${usageOperations.status}`,
  );

  const sessions = await adminJson(app, '/admin/api/sessions?limit=20');
  const sessionDetail = await adminJson(app, '/admin/api/sessions/run_admin_ui_release');
  record(
    'Sessions lists and reconstructs the public canonical Run without Usage authority',
    sessions.status === 200 &&
      sessions.body?.items?.[0]?.runId === 'run_admin_ui_release' &&
      sessions.body?.items?.[0]?.deepLink === '/admin/sessions/run_admin_ui_release' &&
      sessionDetail.status === 200 &&
      sessionDetail.body?.projection === 'public' &&
      sessionDetail.body?.session?.status === 'admitted' &&
      sessionDetail.body?.content?.trigger?.body === 'Admin UI Run trigger' &&
      sessionDetail.body?.usage?.state === 'reported',
    `list=${sessions.status} detail=${sessionDetail.status}`,
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
    name: 'Admin UI Profile',
    instructions: 'ADMIN_UI_PROFILE_INSTRUCTIONS: answer from the admin-created profile.',
    enabled: true,
    model: MODEL_SPECIFIER,
  });
  record(
    'POST /admin/api/agents creates the profile',
    created.status === 201 && created.body?.agent?.id === AGENT_ID,
    `status=${created.status}`,
  );

  const assigned = await adminBody(app, 'PUT', '/admin/api/assignments', {
    workspaceId: WORKSPACE_ID,
    channelId: CHANNEL_ID,
    channelLabel: CHANNEL_LABEL,
    agentId: AGENT_ID,
    enabled: true,
    channelPromptAddendum: FIRST_ADDENDUM,
  });
  record(
    'PUT /admin/api/assignments creates the labeled addendum assignment',
    assigned.status === 200 &&
      assigned.body?.assignment?.channelLabel === CHANNEL_LABEL &&
      assigned.body?.assignment?.channelPromptAddendum === FIRST_ADDENDUM,
    `status=${assigned.status}`,
  );

  const first = await readEffectiveConfig(app);
  const firstConfig = first.body?.config;
  record(
    'effective-config resolves model and first addendum',
    first.status === 200 &&
      firstConfig?.model === MODEL_SPECIFIER &&
      firstConfig?.instructions?.includes(FIRST_ADDENDUM),
    `status=${first.status} model=${String(firstConfig?.model)}`,
  );

  const edited = await adminBody(app, 'PUT', '/admin/api/assignments', {
    workspaceId: WORKSPACE_ID,
    channelId: CHANNEL_ID,
    channelLabel: CHANNEL_LABEL,
    agentId: AGENT_ID,
    enabled: true,
    channelPromptAddendum: SECOND_ADDENDUM,
  });
  record(
    'PUT /admin/api/assignments edits the addendum without remounting routes',
    edited.status === 200,
    `status=${edited.status}`,
  );

  const second = await readEffectiveConfig(app);
  const secondConfig = second.body?.config;
  record(
    'effective-config reflects edited addendum in the same process',
    second.status === 200 &&
      secondConfig?.instructions?.includes(SECOND_ADDENDUM) &&
      !secondConfig?.instructions?.includes(FIRST_ADDENDUM) &&
      secondConfig?.snapshotHash !== firstConfig?.snapshotHash,
    `status=${second.status} hashChanged=${String(secondConfig?.snapshotHash !== firstConfig?.snapshotHash)}`,
  );

  const scopes = await adminJson(app, '/admin/api/audit/memory/scopes');
  const files = await adminJson(
    app,
    `/admin/api/audit/memory/stores/${encodeURIComponent(publicMemory.storeId)}/files` +
      `?sourceChannelId=${encodeURIComponent(CHANNEL_ID)}`,
  );
  record(
    'Memory scope tree and generated channel index use the real state store',
    scopes.status === 200 &&
      scopes.body?.scopes?.[0]?.channelId === CHANNEL_ID &&
      files.status === 200 &&
      files.body?.files?.[0]?.name === 'MEMORY.md' &&
      files.body?.files?.[1]?.name === 'release-guidance.md',
    `scopes=${scopes.status} files=${files.status}`,
  );

  const editBody = JSON.stringify({
    expectedVersion: 1,
    description: 'Use the full release checklist.',
    type: 'project',
    body: 'Run focused tests and the durability gate before release.',
  });
  const edit = await adminJson(app, `/admin/api/audit/memory/entries/${MEMORY_ENTRY_ID}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'admin-ui-memory-edit' },
    body: editBody,
  });
  const conflict = await adminJson(app, `/admin/api/audit/memory/entries/${MEMORY_ENTRY_ID}`, {
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

  const unacknowledgedDelete = await adminJson(
    app,
    `/admin/api/audit/memory/entries/${MEMORY_ENTRY_ID}`,
    {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'admin-ui-memory-delete-rejected' },
      body: JSON.stringify({ expectedVersion: 2, acknowledgeIrreversible: false }),
    },
  );
  const deleted = await adminJson(app, `/admin/api/audit/memory/entries/${MEMORY_ENTRY_ID}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'admin-ui-memory-delete' },
    body: JSON.stringify({ expectedVersion: 2, acknowledgeIrreversible: true }),
  });
  const deletedEntry = await memory.getEntry(MEMORY_ENTRY_ID);
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
  memory?.close();
  routines?.close();
  usage?.close();
  work?.close();
}

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
