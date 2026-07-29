import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';

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
      profileId: 'agent_default',
      profileLabel: 'Default',
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

    const app = createAdminRoutes({ adminToken: 'usage-test-token', usage });
    const unauthorized = await app.request('/admin/api/usage/summary?from=1&to=3000');
    assert.equal(unauthorized.status, 401);

    const headers = { authorization: 'Bearer usage-test-token' };
    const disabledPage = await app.request('/admin', { headers });
    assert.match(await disabledPage.text(), /var USAGE_ADMIN_UI = false/);
    const enabledPage = await createAdminRoutes({
      adminToken: 'usage-test-token',
      usage,
      usageAdminUi: true,
    }).request('/admin/usage', { headers });
    assert.match(await enabledPage.text(), /var USAGE_ADMIN_UI = true/);
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

    const metadata = await app.request('/admin/api/usage/metadata', { headers });
    assert.equal(metadata.status, 200);
    const metadataText = await metadata.text();
    assert.match(metadataText, /chickpea_list_price_estimate/);
    assert.match(metadataText, /limitsManagedByChickpea":false/);
    assert.match(metadataText, /rawRetentionDays":90/);
    assert.doesNotMatch(metadataText, /apiKey|authorization|billingCredential|clientSecret/i);

    const instances = await app.request(
      '/admin/api/usage/operations?from=1&to=3000&limit=20',
      { headers },
    );
    assert.equal(instances.status, 200);
    const instancesText = await instances.text();
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
