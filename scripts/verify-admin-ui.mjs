#!/usr/bin/env node
/**
 * Prove the /admin configuration loop without Slack credentials:
 *   1. mount the real Hono admin routes against an in-memory SQLite store,
 *   2. exchange the POSTed admin token for a browser session cookie,
 *   3. create an Agent and addendum-bearing Channel placement through /admin/api,
 *   4. read the server-side effective-config panel data,
 *   5. edit the addendum and prove the panel data changes in the same process,
 *   6. seed Agent and exact-Channel memory and prove owner/index, conflict,
 *      history, and irreversible-delete contracts through the authenticated admin plane.
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
const AGENT_MEMORY_ENTRY_ID = 'mem_admin_ui_agent';
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
let settings;
let memory;
let routines;
let usage;
let work;
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
  const statePath = join(mkdtempSync(join(tmpdir(), 'chickpea-admin-ui-')), 'state.db');
  store = new SqliteConfigStore(statePath, { agents: [], assignments: [] });
  settings = new SqliteSettingsStore(statePath);
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
  const channelMemory = await memory.ensureOwner({
    workspaceId: WORKSPACE_ID,
    ownerKind: 'channel',
    ownerId: CHANNEL_ID,
  });
  const agentMemory = await memory.ensureOwner({
    workspaceId: WORKSPACE_ID,
    ownerKind: 'agent',
    ownerId: AGENT_ID,
  });
  await memory.createOwnerEntry({
    entryId: AGENT_MEMORY_ENTRY_ID,
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
  await memory.createOwnerEntry({
    entryId: MEMORY_ENTRY_ID,
    storeId: channelMemory.storeId,
    workspaceId: WORKSPACE_ID,
    slug: 'release-guidance',
    description: 'Use the release checklist.',
    type: 'project',
    body: 'Run focused tests before release.',
    actorId: 'U_ADMIN_UI_MEMBER',
    actorClass: 'member',
    writeOrigin: { kind: 'slack_channel', channelId: CHANNEL_ID },
    idempotencyKey: 'admin-ui-channel-memory-create',
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
  app.route(
    '/',
    createAdminRoutes({
      store,
      settings,
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
      pageResponse.headers.get('cache-control') === 'no-store' &&
      pageHtml.includes('Resolved configuration') &&
      pageHtml.includes('data-action="copy-channel-prompt"'),
    `login=${login.status} page=${pageResponse.status}`,
  );

  record(
    'admin page carries live audit domains without the retired Sessions UI',
    pageHtml.includes('Audit logs') &&
      !pageHtml.includes('SESSIONS_ADMIN_UI') &&
      !pageHtml.includes('data-action="open-sessions"') &&
      pageHtml.includes('data-action="audit-tab-scheduled">Scheduled work') &&
      pageHtml.includes('data-action="audit-tab-memory">Memory') &&
      pageHtml.includes('aria-disabled="true" title="Coming later">Network events') &&
      pageHtml.includes('Generated index · changes are made through individual files.') &&
      pageHtml.includes('Prior exports, Slack or provider logs, backups, and Flue transcripts may still retain copies'),
  );

  record(
    'first-run Slack permission completion is accessible and keeps credentials out of markup',
    pageHtml.includes('slackOnboardingContinuation') &&
      pageHtml.includes('data-action="slack-permissions-open"') &&
      pageHtml.includes('data-action="slack-permissions-check"') &&
      pageHtml.includes('role="status" aria-live="polite"') &&
      pageHtml.includes('target="_blank" rel="noopener noreferrer" data-action="slack-permissions-open"') &&
      pageHtml.includes('type="password" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false"') &&
      pageHtml.includes('signingSecretInput.value = state.slackDraft.signingSecret') &&
      pageHtml.includes('botTokenInput.value = state.slackDraft.botToken') &&
      !pageHtml.includes('id="onboarding-signing-secret" name="signingSecret" type="password" autocomplete="off" value="') &&
      !pageHtml.includes('id="onboarding-bot-token" name="botToken" type="password" autocomplete="off" placeholder="xoxb-&hellip;" value="'),
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
      assigned.body?.channel?.label === CHANNEL_LABEL &&
      assigned.body?.channel?.additionalInstructions === FIRST_ADDENDUM,
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
    'Memory owner tree separates Agent memory from exact-Channel memory',
    owners.status === 200 &&
      owners.body?.owners?.some((owner) => owner.ownerKind === 'agent' && owner.ownerId === AGENT_ID) &&
      owners.body?.owners?.some((owner) => owner.ownerKind === 'channel' && owner.ownerId === CHANNEL_ID) &&
      channelFiles.status === 200 &&
      channelFiles.body?.files?.[0]?.name === 'MEMORY.md' &&
      channelFiles.body?.files?.[1]?.name === 'release-guidance.md' &&
      agentFiles.status === 200 &&
      agentFiles.body?.files?.[1]?.name === 'release-principles.md',
    `owners=${owners.status} channel=${channelFiles.status} agent=${agentFiles.status}`,
  );

  const channelEntryPath =
    `/admin/api/audit/memory/owners/channel/${WORKSPACE_ID}/${CHANNEL_ID}/entries/${MEMORY_ENTRY_ID}`;

  const editBody = JSON.stringify({
    expectedVersion: 1,
    description: 'Use the full release checklist.',
    type: 'project',
    body: 'Run focused tests and the durability gate before release.',
  });
  const edit = await adminJson(app, channelEntryPath, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'admin-ui-memory-edit' },
    body: editBody,
  });
  const conflict = await adminJson(app, channelEntryPath, {
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

  const history = await adminJson(app, `${channelEntryPath}/history`);
  record(
    'Channel memory history stays under the exact owner route',
    history.status === 200 && history.body?.revisions?.length === 2,
    `status=${history.status} revisions=${String(history.body?.revisions?.length)}`,
  );

  const unacknowledgedDelete = await adminJson(
    app,
    channelEntryPath,
    {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'admin-ui-memory-delete-rejected' },
      body: JSON.stringify({ expectedVersion: 2, acknowledgeIrreversible: false }),
    },
  );
  const deleted = await adminJson(app, channelEntryPath, {
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
}

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
