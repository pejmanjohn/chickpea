import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { createUsageAdminApi, type SlackMessage } from '../src/admin/usage-api.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
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


test('a direct install asks Slack for the permalink with its own bot token', async () => {
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
