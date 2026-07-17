#!/usr/bin/env node
/**
 * Prove the /admin configuration loop without Slack credentials:
 *   1. mount the real Hono admin routes against an in-memory SQLite store,
 *   2. create a profile and addendum-bearing assignment through /admin/api,
 *   3. read the server-side effective-config panel data,
 *   4. edit the addendum and prove the panel data changes in the same process.
 */
import {
  assertNodeVersion,
  loadTsModule,
} from './lib/offline-harness.mjs';

const ADMIN_TOKEN = 'admin-ui-admin-token';
const WORKSPACE_ID = 'T_ADMIN_UI';
const CHANNEL_ID = 'C_ADMIN_UI';
const CHANNEL_LABEL = 'eng-releases';
const AGENT_ID = 'agent_admin_ui';
const MODEL_SPECIFIER = 'local-stub/admin-ui-model';
const FIRST_ADDENDUM = 'ADMIN_UI_ADDENDUM_V1: prefer release readiness.';
const SECOND_ADDENDUM = 'ADMIN_UI_ADDENDUM_V2: prefer launch-risk deltas.';

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
try {
  console.log(`node ${assertNodeVersion()}`);
  const { Hono } = await import('hono');
  const { createAdminRoutes } = await loadTsModule('src/admin/routes.ts');
  const { SqliteConfigStore } = await loadTsModule('src/config/store.ts');
  store = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const app = new Hono();
  app.route(
    '/',
    createAdminRoutes({
      store,
      adminToken: ADMIN_TOKEN,
      knownProviders: new Set(['local-stub']),
    }),
  );

  const page = await adminJson(app, '/admin');
  record(
    'GET /admin serves the single-page UI',
    page.status === 200 && typeof page.body === 'string' && page.body.includes('Access summary'),
    `status=${page.status}`,
  );

  const created = await adminBody(app, 'POST', '/admin/api/agents', {
    id: AGENT_ID,
    name: 'Admin UI Profile',
    description: 'Created by verify-admin-ui.mjs',
    instructions: 'ADMIN_UI_PROFILE_INSTRUCTIONS: answer from the admin-created profile.',
    enabled: true,
    model: MODEL_SPECIFIER,
    defaultModels: {
      claude: 'anthropic/admin-ui-claude',
      'workers-ai': '@cf/admin-ui/model',
    },
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
} catch (error) {
  record('verification harness', false, error instanceof Error ? error.message : String(error));
} finally {
  store?.close();
}

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
