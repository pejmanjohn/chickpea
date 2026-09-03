import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { WORKSPACE_SLACK_INSTALLATION_ID } from '../src/config/types.ts';
import type { SlackStateStore } from '../src/slack/claim-store.ts';
import { writeSlackInstallationCredentials } from '../src/slack/installation-credentials.ts';
import type { SlackPresentationSummary } from '../src/slack/run-presentations.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

const TOKEN = 'slack-runtime-summary-token';
const WORKSPACE_ID = 'T_RUNTIME_SUMMARY';

test('Slack connection GET exposes bounded gateway status without restart or installation mutation', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const store = new SqliteConfigStore(':memory:');
  let statusCalls = 0;
  let restartCalls = 0;
  try {
    await store.ensureWorkspaceInstallation({
      workspaceId: WORKSPACE_ID,
      teamId: WORKSPACE_ID,
      appId: 'A_RUNTIME',
      botUserId: 'U_RUNTIME',
      transportMode: 'gateway',
      gatewayBindingId: 'binding-runtime',
    });
    const before = await store.getWorkspaceInstallation(WORKSPACE_ID);
    const app = createAdminRoutes({
      settings,
      store,
      ...testAdminAuthority(TOKEN),
    });
    const env = {
      CF_VERSION_METADATA: { id: 'version-runtime' },
      SLACK_GATEWAY_SESSION: {
        idFromName: (name: string) => name,
        get: () => ({
          status: async () => {
            statusCalls += 1;
            return {
              healthy: false,
              phase: 'retrying',
              detail: 'gateway_session_offline',
              generation: 9,
              versionId: 'version-runtime',
            };
          },
          restart: async () => {
            restartCalls += 1;
          },
        }),
      },
    };

    const denied = await app.request('http://localhost/admin/api/slack-connection', {}, env);
    assert.notEqual(denied.status, 200);
    assert.equal(statusCalls, 0);

    const response = await app.request(
      'http://localhost/admin/api/slack-connection',
      { headers: testAdminHeaders(TOKEN) },
      env,
    );
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(body.gateway, {
      healthy: false,
      phase: 'retrying',
      detail: 'gateway_session_offline',
      generation: 9,
      versionId: 'version-runtime',
    });
    assert.equal(statusCalls, 1);
    assert.equal(restartCalls, 0);
    assert.deepEqual(await store.getWorkspaceInstallation(WORKSPACE_ID), before);
    assert.deepEqual(Object.keys(body.gateway as object).sort(), [
      'detail', 'generation', 'healthy', 'phase', 'versionId',
    ]);
  } finally {
    store.close();
    settings.close();
  }
});

test('Slack presentation summary authorizes the connected workspace and exposes no content', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await writeSlackInstallationCredentials(
      settings,
      WORKSPACE_SLACK_INSTALLATION_ID,
      null,
      {
        botToken: 'xoxb-runtime-summary-token',
        signingSecret: 'runtime-summary-signing-secret',
        teamId: WORKSPACE_ID,
      },
    );
    const summary: SlackPresentationSummary = {
      workspaceId: WORKSPACE_ID,
      total: 2,
      truncated: false,
      streamStates: { finalized: 2 },
      eligibility: { allowed: 2 },
      outcomes: { progressive: 1, terminal_only: 1 },
      degradations: { none: 2 },
      offers: { offered: 2 },
      intents: { requested: 1, not_requested: 1 },
      policyOutcomes: { requested_progressive: 1, offered_not_requested: 1 },
      acceptedBytes: { total: 128, max: 128 },
      latencyMs: {
        offerToRequest: { count: 1, min: 30, p50: 30, p90: 30, max: 30 },
        requestToFirstEffect: { count: 1, min: 15, p50: 15, p90: 15, max: 15 },
        total: { count: 2, min: 45, p50: 45, p90: 80, max: 80 },
      },
    };
    let summarized = 0;
    const slackState = {
      async summarizeRunPresentations(workspaceId: string) {
        summarized += 1;
        assert.equal(workspaceId, WORKSPACE_ID);
        return structuredClone(summary);
      },
    } as unknown as SlackStateStore;
    const app = createAdminRoutes({
      settings,
      slackState,
      ...testAdminAuthority(TOKEN),
    });
    const headers = testAdminHeaders(TOKEN);

    const denied = await app.request(
      `/admin/api/runtime/slack-presentations?workspaceId=T_OTHER`,
      { headers },
    );
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'workspace_not_authorized' });
    assert.equal(summarized, 0);

    const authorized = await app.request(
      `/admin/api/runtime/slack-presentations?workspaceId=${WORKSPACE_ID}`,
      { headers },
    );
    assert.equal(authorized.status, 200);
    assert.equal(authorized.headers.get('cache-control'), 'no-store');
    const text = await authorized.text();
    assert.deepEqual(JSON.parse(text), summary);
    assert.equal(summarized, 1);
    for (const forbidden of [
      'message', 'prompt', 'answer', 'threadTs', 'channelId', 'requesterUserId',
    ]) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
  } finally {
    settings.close();
  }
});
