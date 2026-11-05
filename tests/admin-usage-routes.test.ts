import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { createUsageAdminApi, type SlackMessage } from '../src/admin/usage-api.ts';
import type { UsageReport } from '../src/admin/usage-report.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  configurePlatformBilling,
  type BilledUsageRow,
  type BillingSummary,
  type PlatformBillingPort,
} from '../src/config/platform-billing.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import type { RoutineStore } from '../src/routines/types.ts';
import { RELEASE_PRICE_CATALOGS } from '../src/usage/pricing/catalog.ts';
import { usageEstimatesEnabled } from '../src/usage/pricing/estimate.ts';
import { usageRuntimeRecordingEnabled } from '../src/usage/runtime-recorder.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import type { AdmitUsageOperationInput } from '../src/usage/types.ts';
import { SqliteWorkStore } from '../src/work/store.ts';
import type { BindingId, RunId, WorkId, WorkStore } from '../src/work/types.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
import { TEAM_PLAN, usd } from './helpers/billing-summaries.ts';
import { withDirectSlackInstall } from './helpers/direct-slack-install.ts';

test('committed deployment internalizes Usage defaults and keeps independent kill switches', async () => {
  const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.doesNotMatch(config, /"vars"\s*:/);
  const deploymentEnv = {};

  assert.equal(usageRuntimeRecordingEnabled(deploymentEnv, {}), true);
  assert.equal(usageEstimatesEnabled(deploymentEnv, {}), true);

  const usage = new SqliteUsageStore(':memory:');
  try {
    const app = createAdminRoutes({
      usage,
      ...testAdminAuthority('usage-default-test-token'),
    });
    const headers = testAdminHeaders('usage-default-test-token');
    const enabled = await app.request('/admin', { headers }, deploymentEnv);
    assert.match(await enabled.text(), /"usageAdminUi":true/);
    const disabled = await app.request('/admin', { headers }, {
      ...deploymentEnv,
      USAGE_ADMIN_UI: '0',
    });
    assert.match(await disabled.text(), /"usageAdminUi":false/);
  } finally {
    usage.close();
  }

  assert.equal(usageRuntimeRecordingEnabled({ ...deploymentEnv, USAGE_RUNTIME_RECORDING: '0' }), false);
  assert.equal(usageEstimatesEnabled({ ...deploymentEnv, USAGE_ESTIMATES: '0' }), false);
});

test('usage Admin APIs are authenticated, bounded, and expose no content fields', async () => {
  const usage = new SqliteUsageStore(':memory:');
  try {
    await usage.admitOperation({
      operationId: 'op_admin',
      operationKind: 'interactive_turn',
      sourceId: 'op_admin',
      startedAt: 1_000,
      installationId: 'installation',
      workspaceId: 'T_ADMIN',
      agentId: 'agent_default',
      agentLabel: 'Default',
      channelId: 'C_ADMIN',
      channelLabel: 'admin-lab',
      conversationKind: 'named_channel',
      requestedProvider: 'openai',
      requestedModel: 'gpt-4.1-mini',
      credentialRefId: 'cred_openai_environment',
      credentialVersion: 1,
    });
    await usage.recordTerminal({
      operationId: 'op_admin',
      executionId: 'exec_admin',
      status: 'completed',
      finishedAt: 2_000,
      observedAt: 2_000,
      providerRoute: 'openai',
      requestedProvider: 'openai',
      requestedModel: 'gpt-4.1-mini',
      returnedProvider: 'openai',
      returnedModel: 'gpt-4.1-mini',
      credentialRefId: 'cred_openai_environment',
      credentialVersion: 1,
      usageCompleteness: 'complete',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      usageUnknownReason: null,
      estimateCompleteness: 'not_priced',
      estimateAmountMicros: null,
      estimateCurrency: null,
      priceVersionId: null,
      priceUnknownReason: 'price_unknown',
    });
    await usage.recordConnectorUsage({
      attemptId: 'connector_admin_1',
      workspaceId: 'T_ADMIN',
      agentId: 'agent_default',
      connectionAccountId: 'connection_gmail',
      operationId: 'op_admin',
      runId: null,
      runExecutionId: null,
      adapterId: 'composio',
      toolkit: 'gmail',
      capability: 'gmail.profile.read',
      providerTool: 'GMAIL_GET_PROFILE',
      providerVersion: '20260817_00',
      effectClass: 'read',
      outcome: 'success',
      retryClassification: 'none',
      startedAt: 1_100,
      finishedAt: 1_200,
      latencyMs: 100,
      remoteCallCount: 1,
      providerToolCallCount: 1,
      resultBytes: 128,
      httpStatus: null,
      rateLimitRemaining: 1_999,
      retryAfterMs: null,
      providerLogId: 'log_admin_1',
      priceVersionId: 'composio-2026-08-15',
      estimatedCostMicros: 600,
      estimateCurrency: 'USD',
    });
    await usage.admitOperation({
      operationId: 'op_admin_classifier',
      operationKind: 'interaction_classification',
      sourceId: 'op_admin_classifier',
      startedAt: 1_500,
      installationId: 'installation',
      workspaceId: 'T_ADMIN',
      agentId: 'agent_default',
      agentLabel: 'Default',
      channelId: 'C_ADMIN',
      channelLabel: 'admin-lab',
      conversationKind: 'named_channel',
      requestedProvider: 'openai',
      requestedModel: 'gpt-4.1-mini',
      credentialRefId: 'cred_openai_environment',
      credentialVersion: 1,
    });
    await usage.recordTerminal({
      operationId: 'op_admin_classifier',
      executionId: 'exec_admin_classifier',
      status: 'failed',
      finishedAt: 1_750,
      observedAt: 1_750,
      providerRoute: 'openai',
      requestedProvider: 'openai',
      requestedModel: 'gpt-4.1-mini',
      returnedProvider: null,
      returnedModel: null,
      credentialRefId: 'cred_openai_environment',
      credentialVersion: 1,
      usageCompleteness: 'not_reported',
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      usageUnknownReason: 'provider_request_unknown',
      estimateCompleteness: 'unknown',
      estimateAmountMicros: null,
      estimateCurrency: null,
      priceVersionId: null,
      priceUnknownReason: 'price_unknown',
    });
    assert.equal((await usage.summarize({ from: 1, to: 3_000 })).totals.operationCount, 2);

    const app = createAdminRoutes({ usage, ...testAdminAuthority('usage-test-token') });
    const unauthorized = await app.request('/admin/api/usage/summary?from=1&to=3000');
    assert.equal(unauthorized.status, 401);

    const headers = testAdminHeaders('usage-test-token');
    const enabledPage = await app.request('/admin', { headers });
    assert.match(await enabledPage.text(), /"usageAdminUi":true/);
    const disabledPage = await createAdminRoutes({
      usage,
      usageAdminUi: false,
      ...testAdminAuthority('usage-test-token'),
    }).request('/admin/usage', { headers });
    assert.match(await disabledPage.text(), /"usageAdminUi":false/);
    const summary = await app.request(
      '/admin/api/usage/summary?from=1&to=3000&groupBy=provider',
      { headers },
    );
    assert.equal(summary.status, 200);
    const summaryBody = await summary.json();
    assert.equal(summaryBody.totals.operationCount, 1);
    assert.equal(summaryBody.groups[0].key, 'openai');

    const overview = await app.request(
      '/admin/api/usage/overview?from=1&to=3000&groupBy=provider&currency=USD',
      { headers },
    );
    assert.equal(overview.status, 200);
    const overviewBody = await overview.json();
    assert.equal(overviewBody.current.totals.operationCount, 1);
    assert.equal(overviewBody.previous.to, 1);

    const connectors = await app.request(
      '/admin/api/usage/connectors?from=1&to=3000&workspace=T_ADMIN&toolkit=gmail',
      { headers },
    );
    assert.equal(connectors.status, 200);
    const connectorsText = await connectors.text();
    const connectorsBody = JSON.parse(connectorsText) as Record<string, any>;
    assert.equal(connectorsBody.attemptCount, 1);
    assert.equal(typeof connectorsBody.retainedFrom, 'number');
    assert.equal(connectorsBody.isComplete, false);
    assert.equal(connectorsBody.measuredConnectionAccountCount, 1);
    assert.equal(connectorsBody.estimatedCostMicros, 600);
    assert.equal(connectorsBody.totalResultBytes, 128);
    assert.doesNotMatch(connectorsText, /arguments|response|token|apiKey|accountRef/i);

    const metadata = await app.request('/admin/api/usage/metadata', { headers });
    assert.equal(metadata.status, 200);
    const metadataText = await metadata.text();
    assert.match(metadataText, /chickpea_list_price_estimate/);
    assert.match(metadataText, /limitsManagedByChickpea":false/);
    assert.match(metadataText, /rawRetentionDays":90/);
    assert.match(metadataText, /composio-2026-08-15/);
    // Admin needs each version's effective date to tell which one prices a model now.
    assert.deepEqual(
      (JSON.parse(metadataText) as { catalogs: Array<{ id: string; effectiveFrom: number }> }).catalogs
        .map(({ id, effectiveFrom }) => ({ id, effectiveFrom })),
      RELEASE_PRICE_CATALOGS.map(({ id, effectiveFrom }) => ({ id, effectiveFrom })),
    );
    assert.doesNotMatch(metadataText, /apiKey|authorization|billingCredential|clientSecret/i);

    const instances = await app.request(
      '/admin/api/usage/operations?from=1&to=3000&limit=20',
      { headers },
    );
    assert.equal(instances.status, 200);
    const instancesText = await instances.text();
    const instancesBody = JSON.parse(instancesText) as Record<string, any>;
    assert.deepEqual(
      instancesBody.items.map((item: Record<string, any>) => item.operation.operationId),
      ['op_admin'],
    );
    assert.doesNotMatch(instancesText, /interaction_classification|op_admin_classifier/);
    assert.doesNotMatch(instancesText, /prompt|resultText|authorization|apiKey/i);

    const invalid = await app.request(
      '/admin/api/usage/summary?from=1&to=999999999999999&groupBy=cache',
      { headers },
    );
    assert.equal(invalid.status, 400);
  } finally {
    usage.close();
  }
});

test('Usage public and redacted serializers expose canonical Run IDs without retired UI links or private labels', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'chickpea-admin-usage-redaction-')), 'state.db');
  const usage = new SqliteUsageStore(path);
  const work = new SqliteWorkStore(path);
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const privateCanary = 'PRIVATE_USAGE_LABEL_<script>alert(81)</script>';
  try {
    await seedUsageRun(work, 'public', 'public');
    await seedUsageRun(work, 'private', 'private');
    await usage.admitOperation({
      operationId: 'op_usage_public',
      runId: 'run_usage_public',
      operationKind: 'interactive_turn',
      sourceId: 'source_usage_public',
      startedAt: 1_000,
      installationId: 'installation',
      workspaceId: 'T_USAGE',
      agentId: 'profile_usage',
      agentLabel: 'Public profile',
      channelId: 'C_PUBLIC',
      channelLabel: 'public-lab',
      conversationKind: 'named_channel',
      requestedProvider: 'openai',
      requestedModel: 'gpt-5.6-sol',
      credentialRefId: 'cred_openai_environment',
      credentialVersion: 1,
    });
    await usage.admitOperation({
      operationId: 'op_usage_private',
      runId: 'run_usage_private',
      operationKind: 'interactive_turn',
      sourceId: 'source_usage_private',
      startedAt: 2_000,
      installationId: 'installation',
      workspaceId: 'T_USAGE',
      agentId: 'profile_usage',
      agentLabel: privateCanary,
      channelId: 'C_PRIVATE',
      channelLabel: privateCanary,
      conversationKind: 'named_channel',
      routineId: 'routine_private',
      routineLabel: privateCanary,
      requestedProvider: 'openai',
      requestedModel: 'gpt-5.6-sol',
      credentialRefId: 'cred_openai_environment',
      credentialVersion: 1,
    });
    let visibilityLookups = 0;
    const batchedWork = new Proxy(work as WorkStore, {
      get(target, property, receiver) {
        if (property === 'getRunVisibilities') {
          return async (runIds: RunId[]) => {
            visibilityLookups += 1;
            return target.getRunVisibilities(runIds);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const app = createAdminRoutes({
      store: config,
      usage,
      work: batchedWork,
      ...testAdminAuthority('usage-redaction-token'),
    });
    const headers = testAdminHeaders('usage-redaction-token');

    const pageText = await (await app.request(
      '/admin/api/usage/operations?from=1&to=3000&limit=20',
      { headers },
    )).text();
    assert.doesNotMatch(pageText, /PRIVATE_USAGE_LABEL|alert\(81\)/);
    const page = JSON.parse(pageText) as Record<string, any>;
    const privateItem = page.items.find((item: Record<string, any>) =>
      item.operation.operationId === 'op_usage_private');
    const publicItem = page.items.find((item: Record<string, any>) =>
      item.operation.operationId === 'op_usage_public');
    assert.equal(privateItem.projection, 'redacted');
    assert.equal(privateItem.operation.agentLabel, null);
    assert.equal(privateItem.operation.channelLabel, null);
    assert.equal(privateItem.operation.routineLabel, null);
    assert.equal(Object.hasOwn(privateItem, 'sessionDeepLink'), false);
    assert.equal(publicItem.projection, 'public');
    assert.equal(publicItem.operation.agentLabel, 'Public profile');
    assert.equal(publicItem.operation.channelLabel, 'public-lab');
    assert.equal(Object.hasOwn(publicItem, 'sessionDeepLink'), false);
    assert.equal(visibilityLookups, 1);

    const detailText = await (await app.request(
      '/admin/api/usage/operations/op_usage_private',
      { headers },
    )).text();
    assert.doesNotMatch(detailText, /PRIVATE_USAGE_LABEL|alert\(81\)/);
    assert.equal((JSON.parse(detailText) as Record<string, any>).projection, 'redacted');
    assert.equal(visibilityLookups, 2);

    const summary = await (await app.request(
      '/admin/api/usage/summary?from=1&to=3000&groupBy=channel',
      { headers },
    )).json() as Record<string, any>;
    assert.ok(summary.groups.every((group: Record<string, unknown>) => group.label === null));
  } finally {
    usage.close();
    work.close();
    config.close();
  }
});

test('Usage activity names a renamed Channel by its current label without rewriting history', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'chickpea-admin-usage-rename-')), 'state.db');
  const usage = new SqliteUsageStore(path);
  const work = new SqliteWorkStore(path);
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  try {
    await seedUsageRun(work, 'public', 'public');
    await config.putChannel({
      workspaceId: 'T_USAGE',
      channelId: 'C_RENAMED',
      label: 'new-channel',
      lifecycle: 'active',
    }, 0);
    await usage.admitOperation({
      operationId: 'op_usage_renamed',
      runId: 'run_usage_public',
      operationKind: 'interactive_turn',
      sourceId: 'source_usage_renamed',
      startedAt: 1_000,
      installationId: 'installation',
      workspaceId: 'T_USAGE',
      agentId: 'agent_default',
      agentLabel: 'Smoke',
      channelId: 'C_RENAMED',
      channelLabel: 'new-channel',
      conversationKind: 'named_channel',
      requestedProvider: 'openai',
      requestedModel: 'gpt-5.6-sol',
      credentialRefId: 'cred_openai_environment',
      credentialVersion: 1,
    });
    assert.equal(await config.refreshChannelLabel('T_USAGE', 'C_RENAMED', 'qa-cobalt'), true);
    assert.equal(await config.refreshChannelLabel('T_USAGE', 'C_RENAMED', 'qa-cobalt'), false);
    assert.equal((await config.getChannel('T_USAGE', 'C_RENAMED'))?.revision, 1);

    const app = createAdminRoutes({
      store: config,
      usage,
      work,
      ...testAdminAuthority('usage-rename-token'),
    });
    const headers = testAdminHeaders('usage-rename-token');
    const page = await (await app.request(
      '/admin/api/usage/operations?from=1&to=3000&limit=20',
      { headers },
    )).json() as Record<string, any>;
    assert.equal(page.items[0].operation.channelLabel, 'qa-cobalt');
    const detail = await (await app.request(
      '/admin/api/usage/operations/op_usage_renamed',
      { headers },
    )).json() as Record<string, any>;
    assert.equal(detail.operation.channelLabel, 'qa-cobalt');
    assert.equal(
      (await usage.getOperation('op_usage_renamed'))?.operation.channelLabel,
      'new-channel',
      'the recorded usage row keeps its historical label',
    );
  } finally {
    usage.close();
    work.close();
    config.close();
  }
});


function slackUsageRow(overrides: Partial<AdmitUsageOperationInput> & { operationId: string }): AdmitUsageOperationInput {
  return {
    operationKind: 'interactive_turn',
    sourceId: overrides.operationId,
    startedAt: 1_000,
    installationId: 'installation',
    workspaceId: 'T0SLACK',
    agentId: 'agent_default',
    agentLabel: 'Default',
    channelId: 'C0NEW',
    channelLabel: 'support',
    conversationKind: 'named_channel',
    requestedProvider: 'openai',
    requestedModel: 'gpt-5.6-sol',
    credentialRefId: null,
    credentialVersion: null,
    ...overrides,
  };
}

async function seedSlackUsageRows(usage: SqliteUsageStore): Promise<void> {
  await usage.admitOperation(slackUsageRow({
    operationId: 'op_new',
    slackMessageTs: '1793425408.462389',
    slackThreadTs: '1793425300.000001',
  }));
  await usage.admitOperation(slackUsageRow({
    operationId: 'op_top_level',
    slackMessageTs: '1793425300.000001',
    slackThreadTs: '1793425300.000001',
  }));
  await usage.admitOperation(slackUsageRow({ operationId: 'msg:C0OLD:1793425396.721899', channelId: 'C0OLD' }));
  await usage.admitOperation(slackUsageRow({
    operationId: 'msg:C0OLD:1793425400.000100:ask-agent_peer',
    channelId: 'C0OLD',
  }));
  await usage.admitOperation(slackUsageRow({ operationId: 'msg:C0ELSEWHERE:1793425401.000100', channelId: 'C0OLD' }));
  await usage.admitOperation(slackUsageRow({ operationId: 'oauthresume:resume_1' }));
  await usage.admitOperation(slackUsageRow({
    operationId: 'routine_run_posted',
    operationKind: 'routine_run',
    channelId: 'C0ROUTINE',
    routineId: 'routine_daily',
    routineLabel: 'Daily digest',
    routineRunId: 'routine_run_posted',
  }));
  await usage.admitOperation(slackUsageRow({
    operationId: 'routine_run_quiet',
    operationKind: 'routine_run',
    channelId: 'C0ROUTINE',
    routineId: 'routine_daily',
    routineLabel: 'Daily digest',
    routineRunId: 'routine_run_quiet',
  }));
  await usage.admitOperation(slackUsageRow({
    operationId: 'routine_run_private',
    operationKind: 'routine_run',
    channelId: 'D0PRIVATE',
    channelLabel: null,
    conversationKind: 'direct_message',
    routineId: 'routine_private',
    routineLabel: 'Private reminder',
    routineRunId: 'routine_run_private',
  }));
}

const POSTED_ROUTINE_MESSAGES: Record<string, { channelId: string; messageTs: string }> = {
  routine_run_posted: { channelId: 'C0ROUTINE', messageTs: '1793425500.000200' },
  routine_run_private: { channelId: 'D0PRIVATE', messageTs: '1793425600.000300' },
};

test('each Usage row links to the Slack message that started it, and Slack supplies the permalink', async () => {
  const usage = new SqliteUsageStore(':memory:');
  const asked: SlackMessage[] = [];
  let permalink: (message: SlackMessage) => Promise<string | undefined> = async (message) =>
    `https://acme.slack.com/archives/${message.channelId}/p${message.messageTs.replace('.', '')}?thread_ts=1793425300.000001&cid=${message.channelId}`;
  try {
    await seedSlackUsageRows(usage);
    const app = createUsageAdminApi({
      store: () => usage,
      agentNames: async () => new Map(),
      personNames: async () => new Map(),
      routineMessage: async (_c, routineRunId) => POSTED_ROUTINE_MESSAGES[routineRunId],
      slackPermalink: async (_c, message) => {
        asked.push(message);
        return permalink(message);
      },
    });

    const page = await (await app.request('/usage/operations?from=1&to=3000&limit=20')).json() as Record<string, any>;
    const paths = Object.fromEntries(page.items.map((item: Record<string, any>) =>
      [item.operation.operationId, item.operation.slackMessagePath]));
    assert.deepEqual(paths, {
      op_new: '/admin/api/usage/operations/op_new/slack-message',
      op_top_level: '/admin/api/usage/operations/op_top_level/slack-message',
      'msg:C0OLD:1793425396.721899': '/admin/api/usage/operations/msg%3AC0OLD%3A1793425396.721899/slack-message',
      'msg:C0OLD:1793425400.000100:ask-agent_peer':
        '/admin/api/usage/operations/msg%3AC0OLD%3A1793425400.000100%3Aask-agent_peer/slack-message',
      'msg:C0ELSEWHERE:1793425401.000100': null,
      'oauthresume:resume_1': null,
      routine_run_posted: '/admin/api/usage/operations/routine_run_posted/slack-message',
      routine_run_quiet: null,
    }, 'private routines stay off the page; a row links only when its message is known');

    const opened = await app.request('/usage/operations/op_new/slack-message');
    assert.equal(opened.status, 302);
    assert.equal(
      opened.headers.get('location'),
      'https://acme.slack.com/archives/C0NEW/p1793425408462389?thread_ts=1793425300.000001&cid=C0NEW',
    );
    asked.length = 0;
    await app.request('/usage/operations/msg%3AC0OLD%3A1793425396.721899/slack-message');
    await app.request('/usage/operations/msg%3AC0OLD%3A1793425400.000100%3Aask-agent_peer/slack-message');
    await app.request('/usage/operations/routine_run_posted/slack-message');
    assert.deepEqual(asked, [
      { workspaceId: 'T0SLACK', channelId: 'C0OLD', messageTs: '1793425396.721899' },
      { workspaceId: 'T0SLACK', channelId: 'C0OLD', messageTs: '1793425400.000100' },
      { workspaceId: 'T0SLACK', channelId: 'C0ROUTINE', messageTs: '1793425500.000200' },
    ], 'rows from before the column existed resolve from their recorded message');

    const fallback = 'https://slack.com/archives/C0NEW/p1793425408462389?thread_ts=1793425300.000001&cid=C0NEW';
    for (const unsafe of [
      'https://acme.slack.com.attacker.example/archives/C0NEW/p1793425408462389',
      'http://acme.slack.com/archives/C0NEW/p1793425408462389',
      'javascript:alert(1)',
      undefined,
    ]) {
      permalink = async () => unsafe;
      const response = await app.request('/usage/operations/op_new/slack-message');
      assert.equal(response.headers.get('location'), fallback, `refuses ${String(unsafe)}`);
    }
    permalink = async () => { throw new Error('channel_not_found'); };
    assert.equal(
      (await app.request('/usage/operations/op_new/slack-message')).headers.get('location'),
      fallback,
      'a Slack failure still opens the reply in its thread from the stored coordinate',
    );
    assert.equal(
      (await app.request('/usage/operations/op_top_level/slack-message')).headers.get('location'),
      'https://slack.com/archives/C0NEW/p1793425300000001',
      'a top-level message needs no thread parameters',
    );
    assert.equal(
      (await app.request('/usage/operations/msg%3AC0OLD%3A1793425396.721899/slack-message')).headers.get('location'),
      'https://slack.com/archives/C0OLD/p1793425396721899',
      'an earlier row has no recorded thread, so only Slack\'s permalink can open its thread',
    );

    for (const operationId of ['oauthresume%3Aresume_1', 'routine_run_quiet', 'routine_run_private', 'op_missing']) {
      const missing = await app.request(`/usage/operations/${operationId}/slack-message`);
      assert.equal(missing.status, 404, operationId);
      assert.deepEqual(await missing.json(), { error: 'slack_message_not_found' });
    }
  } finally {
    usage.close();
  }
});

test('the Usage Slack link route is authenticated and reads routine posts from the routine store', async () => {
  const usage = new SqliteUsageStore(':memory:');
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  try {
    await seedSlackUsageRows(usage);
    const routines = {
      getRun: async (id: string) => id === 'routine_run_posted'
        ? { deliveryChannelId: 'C0ROUTINE', deliveryMessageTs: '1793425500.000200' }
        : { deliveryChannelId: 'C0ROUTINE', deliveryMessageTs: null },
    } as unknown as RoutineStore;
    const app = createAdminRoutes({
      store: config,
      usage,
      routines,
      ...testAdminAuthority('usage-slack-link-token'),
    });
    const headers = testAdminHeaders('usage-slack-link-token');

    const anonymous = await app.request('/admin/api/usage/operations/op_new/slack-message');
    assert.notEqual(anonymous.status, 302);
    assert.equal(anonymous.headers.get('location'), null);

    const opened = await app.request('/admin/api/usage/operations/op_new/slack-message', { headers });
    assert.equal(opened.status, 302);
    assert.equal(
      opened.headers.get('location'),
      'https://slack.com/archives/C0NEW/p1793425408462389?thread_ts=1793425300.000001&cid=C0NEW',
      'with no Slack installation to ask, the stored coordinate still opens the reply in its thread',
    );
    const routine = await app.request('/admin/api/usage/operations/routine_run_posted/slack-message', { headers });
    assert.equal(routine.headers.get('location'), 'https://slack.com/archives/C0ROUTINE/p1793425500000200');
    const quiet = await app.request('/admin/api/usage/operations/routine_run_quiet/slack-message', { headers });
    assert.equal(quiet.status, 404);
  } finally {
    usage.close();
    config.close();
  }
});


test('a direct install asks Slack for the permalink through its own installation', async () => {
  const permalink = 'https://team-one.slack.com/archives/C1/p1793425408462389?thread_ts=1793425300.000001&cid=C1';
  await withDirectSlackInstall({
    answer: (method) => {
      if (method === 'auth.test') return { ok: true, team_id: 'T1', user_id: 'UBOT', app_id: 'A1', team: 'Team One', user: 'chickpea' };
      if (method === 'chat.getPermalink') return { ok: true, channel: 'C1', permalink };
      return undefined;
    },
  }, async (install) => {
    const usage = new SqliteUsageStore(':memory:');
    try {
      await usage.admitOperation(slackUsageRow({
        operationId: 'op_direct',
        workspaceId: 'T1',
        channelId: 'C1',
        slackMessageTs: '1793425408.462389',
        slackThreadTs: '1793425300.000001',
      }));
      const app = createAdminRoutes({
        store: install.stores.config,
        usage,
        ...testAdminAuthority('usage-direct-token'),
      });
      const opened = await app.request('/admin/api/usage/operations/op_direct/slack-message', {
        headers: testAdminHeaders('usage-direct-token'),
      });
      assert.equal(opened.status, 302);
      assert.equal(opened.headers.get('location'), permalink);
      const asked = install.calls.filter((call) => call.method === 'chat.getPermalink');
      assert.equal(asked.length, 1);
      assert.deepEqual(
        [asked[0]!.body.get('channel'), asked[0]!.body.get('message_ts')],
        ['C1', '1793425408.462389'],
      );
    } finally {
      usage.close();
    }
  });
});

async function seedUsageRun(
  work: SqliteWorkStore,
  suffix: string,
  visibility: 'public' | 'private',
): Promise<void> {
  const workId = `work_usage_${suffix}` as WorkId;
  const bindingId = `binding_usage_${suffix}` as BindingId;
  const runId = `run_usage_${suffix}` as RunId;
  await work.admitShadowRun({
    work: {
      id: workId,
      kind: 'conversation',
      maximumSensitivity: visibility,
      createdAt: 1_000,
    },
    binding: {
      id: bindingId,
      workId,
      adapterKind: 'slack',
      externalAccountId: `account_usage_${suffix}`,
      externalConversationId: `conversation_usage_${suffix}`,
      generation: 1,
      sourceVisibility: visibility,
      configMode: 'frozen_on_open',
      orderingKey: `ordering_usage_${suffix}`,
      createdAt: 1_000,
    },
    run: {
      id: runId,
      workId,
      bindingId,
      kind: 'interactive',
      triggerKind: 'slack_app_mention',
      triggerRef: `trigger_usage_${suffix}`,
      dedupeKey: `dedupe_usage_${suffix}`,
      actorTrustTier: 'member',
      effectiveCapabilityDigest: 'b'.repeat(64),
      executionAuthority: 'legacy',
      coordinatorKind: 'interactive',
      authorityEpoch: 1,
      createdAt: 1_000,
    },
    safeConfig: {
      schemaVersion: 1,
      profileId: 'profile_usage',
      configuredModel: 'openai/gpt-5.6-sol',
      snapshotDigest: 'a'.repeat(64),
      capabilityDigest: 'b'.repeat(64),
      skillNames: [],
      connectionIds: [],
      repositoryIds: [],
      memoryMode: visibility,
      ceilings: {
        maxModelAttempts: 3,
        maxToolCalls: 20,
        maxActionAttempts: 0,
        timeoutMs: 120_000,
      },
    },
    triggerContent: null,
    auditEventId: `audit_usage_${suffix}`,
    auditIdempotencyKey: `auditkey_usage_${suffix}`,
  });
}

const REPORT_TOKEN = 'usage-report-token';
const REPORT_INSTALLATION = 'inst_usage_report';
const REPORT_HOSTED = scopeInstallationEnv(
  { CHICKPEA_TENANCY: 'installation' } as Record<string, unknown>,
  { installationId: REPORT_INSTALLATION },
);
const DAY_MS = 86_400_000;
const MACHINE_OWNER: AuthPrincipal = {
  userId: 'user_test_owner',
  membershipId: 'membership_test_owner',
  organizationId: 'org_oss',
  role: 'owner',
  authenticatorKind: 'personal_token',
  credentialId: 'token_test_owner',
  correlationId: 'request_test_token',
  machine: true,
};
const REPORT_PEOPLE = {
  listMemberships: async () => [{ id: 'membership_maya', userId: 'user_maya' }],
  getUser: async (id: string) => (id === 'user_maya' ? { id, displayName: 'Maya Chen' } : undefined),
  recordAuthAudit: async () => undefined,
} as unknown as IdentityStore;

/**
 * Admin over a workspace whose Agent "Reporter" answered Maya yesterday on
 * Claude Sonnet 5.5, charged to the run `sub_ik_report`, in a billing period
 * that began three days ago.
 */
async function hostedUsageAdmin(
  t: TestContext,
  usageRead?: PlatformBillingPort['usage'],
  options: { publicRun?: boolean; principal?: AuthPrincipal } = {},
) {
  const now = Date.now();
  const summary: BillingSummary = { ...TEAM_PLAN, period: { start: new Date(now - 3 * DAY_MS), end: new Date(now + 27 * DAY_MS) } };
  const reads: Array<{ installationId: string; from: number; to: number }> = [];
  configurePlatformBilling({
    summary: async () => summary,
    checkout: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test_usage' }),
    portal: async () => ({ url: 'https://billing.stripe.com/p/session/test_usage' }),
    chooseFunding: async () => undefined,
    ...(usageRead ? {
      usage: (installationId, range) => {
        reads.push({ installationId, from: range.from.getTime(), to: range.to.getTime() });
        return usageRead(installationId, range);
      },
    } : {}),
  });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const usage = new SqliteUsageStore(':memory:');
  t.after(() => { configurePlatformBilling(undefined); config.close(); usage.close(); });
  await config.createAgent({
    id: 'agent_report', name: 'Reporter', instructions: 'Answer.', enabled: true,
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  });
  const startedAt = now - DAY_MS;
  await usage.admitOperation({
    operationId: 'op_report', operationKind: 'interactive_turn', sourceId: 'op_report', runId: 'run_report', startedAt,
    installationId: REPORT_INSTALLATION, workspaceId: 'T_REPORT', agentId: 'agent_report', agentLabel: 'Reporter',
    channelId: 'C_REPORT', channelLabel: 'report', conversationKind: 'named_channel', requesterMembershipId: 'membership_maya',
    requestedProvider: 'anthropic', requestedModel: 'claude-sonnet-5-5', credentialRefId: null, credentialVersion: null,
  });
  await usage.recordTerminal({
    operationId: 'op_report', executionId: 'exec_report', status: 'completed', finishedAt: startedAt + 1_000,
    observedAt: startedAt + 1_000, providerRoute: 'anthropic', requestedProvider: 'anthropic',
    requestedModel: 'claude-sonnet-5-5', returnedProvider: 'anthropic', returnedModel: 'claude-sonnet-5-5',
    credentialRefId: null, credentialVersion: null, usageCompleteness: 'complete', inputTokens: 10, outputTokens: 5,
    totalTokens: 15, usageUnknownReason: null, estimateCompleteness: 'not_priced', estimateAmountMicros: null,
    estimateCurrency: null, priceVersionId: null, priceUnknownReason: 'price_unknown', billingRunId: 'sub_ik_report',
  });
  // The Work ledger says whether the run is public; a private channel's or DM's run is not.
  const work = {
    getRunVisibilities: async (runIds: RunId[]) => runIds.map((runId) => ({ runId, public: options.publicRun ?? true })),
  } as unknown as WorkStore;
  const app = createAdminRoutes({
    store: config, usage, work, ...testAdminAuthority(REPORT_TOKEN, undefined, REPORT_PEOPLE, options.principal),
  });
  const get = async (path: string, env: Record<string, unknown> = REPORT_HOSTED) =>
    app.request(path, { headers: testAdminHeaders(REPORT_TOKEN) }, env);
  return { get, reads, summary, startedAt, yesterday: new Date(startedAt).toISOString().slice(0, 10) };
}

const billedRows = (day: string): BilledUsageRow[] => [
  { runId: 'sub_ik_report', day, modelMicros: usd(1.5), feeMicros: usd(0.3), task: true, creditedBackMicros: usd(0) },
  // Usage of a run Core never listed, under a cent.
  { runId: 'sub_ik_unlisted', day, modelMicros: usd(0.004), feeMicros: usd(0), task: false, creditedBackMicros: usd(0) },
];

test('the hosted Usage report is not found standalone, or where the host installed no billing port', async (t) => {
  const standalone = await hostedUsageAdmin(t, async () => ({ rows: [] }));
  const response = await standalone.get('/admin/api/usage/report?period=this_billing_period', {});
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
  configurePlatformBilling(undefined);
  assert.equal((await standalone.get('/admin/api/usage/report?period=this_billing_period')).status, 404);
  assert.deepEqual(standalone.reads, []);
});

test('the hosted Usage report joins the host\'s billed usage to the activity that ran it', async (t) => {
  const admin = await hostedUsageAdmin(t, async () => ({ rows: billedRows(admin.yesterday) }));
  const response = await admin.get('/admin/api/usage/report?period=this_billing_period');
  assert.equal(response.status, 200);
  const report = await response.json() as UsageReport;
  assert.equal(report.measure, 'usage');
  assert.deepEqual(report.total, { value: usd(1.804), text: '$1.80' });
  assert.deepEqual(report.agents?.map((agent) => [agent.key, agent.name, agent.amount.text, agent.topPerson, agent.mainModel]), [
    ['agent_report', 'Reporter', '$1.80', 'Maya Chen', 'Claude Sonnet 5.5'],
    [null, 'Other', '<$0.01', null, null],
  ]);
  assert.deepEqual(report.people.map((person) => person.name), ['Maya Chen', 'Everyone else']);
  assert.deepEqual(report.models.map((model) => [model.key, model.name]), [['anthropic/claude-sonnet-5-5', 'Claude Sonnet 5.5'], [null, 'Other']]);
  const start = admin.summary.period!.start.getTime();
  const [current, prior] = admin.reads;
  assert.equal(admin.reads.length, 2, 'the current period, then the one before');
  assert.deepEqual([current?.installationId, current?.from, prior?.installationId, prior?.to], [REPORT_INSTALLATION, start, REPORT_INSTALLATION, start]);
  assert.ok(current!.to > Date.now() - 60_000 && current!.to <= Date.now() + 1, 'through now');
  assert.ok(start - prior!.from >= 28 * DAY_MS && start - prior!.from <= 31 * DAY_MS, 'one calendar month');

  for (const query of ['period=next_billing_period', 'from=20&to=10', 'from=1', `from=0&to=${367 * DAY_MS}`, 'period=this_billing_period&agent=a%20b']) {
    assert.equal((await admin.get(`/admin/api/usage/report?${query}`)).status, 400, query);
  }
});

test('without the host\'s usage read, or when it fails, the report counts activities and logs one line', async (t) => {
  const warnings = t.mock.method(console, 'warn', () => undefined);
  for (const read of [undefined, async () => { throw new Error(`usage read failed for ${REPORT_INSTALLATION}`); }]) {
    const admin = await hostedUsageAdmin(t, read);
    const report = await (await admin.get('/admin/api/usage/report?period=this_billing_period')).json() as UsageReport;
    assert.deepEqual([report.measure, report.total], ['activity', { value: 1, text: '1' }]);
    assert.deepEqual(report.agents?.map((agent) => [agent.name, agent.amount.text]), [['Reporter', '1']]);
  }
  const lines = warnings.mock.calls.map((call) => String(call.arguments[0]));
  assert.deepEqual(lines, [JSON.stringify({ component: 'platform_billing', event: 'billed_usage_unavailable' })]);
});

test('hosted activity rows carry who asked, the model and the billed usage of their runs; standalone rows do not', async (t) => {
  const admin = await hostedUsageAdmin(t, async () => ({ rows: billedRows(admin.yesterday) }));
  const path = `/admin/api/usage/operations?from=${admin.startedAt - 1}&to=${admin.startedAt + 60_000}`;
  const page = await (await admin.get(path)).json() as { items: Array<Record<string, any>> };
  assert.deepEqual(page.items.map((item) => item.hosted), [{
    requester: 'Maya Chen',
    modelName: 'Claude Sonnet 5.5',
    billed: { amount: '$1.80', model: '$1.50', fee: '$0.30', task: true, creditedBack: false },
  }]);
  assert.equal(page.items[0]?.measurements[0]?.billingRunId, 'sub_ik_report');
  // One read for the page's own run, whole: from its start's UTC day to past the range, for charges written later.
  assert.equal(admin.reads.length, 1);
  assert.equal(admin.reads[0]!.from, Math.floor(admin.startedAt / DAY_MS) * DAY_MS);
  assert.ok(admin.reads[0]!.to > admin.startedAt + 60_000);

  const standalone = await (await admin.get(path, {})).json() as { items: Array<Record<string, any>> };
  assert.equal('hosted' in standalone.items[0]!, false);
});

test('a private run\'s activity row names nobody, and a personal token reads no one\'s name', async (t) => {
  const rowsFor = async (admin: Awaited<ReturnType<typeof hostedUsageAdmin>>) => {
    const path = `/admin/api/usage/operations?from=${admin.startedAt - 1}&to=${admin.startedAt + 60_000}`;
    return (await (await admin.get(path)).json() as { items: Array<Record<string, any>> }).items.map((item) => item.hosted);
  };
  const privateRun = await hostedUsageAdmin(t, async () => ({ rows: billedRows(privateRun.yesterday) }), { publicRun: false });
  assert.deepEqual((await rowsFor(privateRun)).map((hosted) => [hosted.requester, hosted.billed?.amount]), [[null, '$1.80']]);
  const report = await (await privateRun.get('/admin/api/usage/report?period=this_billing_period')).json() as UsageReport;
  assert.deepEqual(report.people.map((person) => person.name), ['Maya Chen', 'Everyone else'], 'the run still counts toward who asked');

  const token = await hostedUsageAdmin(t, async () => ({ rows: billedRows(token.yesterday) }), {
    principal: { ...MACHINE_OWNER },
  });
  assert.deepEqual((await rowsFor(token)).map((hosted) => hosted.requester), [null]);
  const tokenReport = await (await token.get('/admin/api/usage/report?period=this_billing_period')).json() as UsageReport;
  assert.deepEqual(tokenReport.people.map((person) => person.name), ['Everyone else']);
  assert.deepEqual(tokenReport.agents?.map((agent) => agent.topPerson), [null, null]);
});
