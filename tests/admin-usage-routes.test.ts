import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { SqliteWorkStore } from '../src/work/store.ts';
import type { BindingId, RunId, WorkId } from '../src/work/types.ts';

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

test('Usage public and redacted serializers share canonical Session links without leaking private labels', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'chickpea-admin-usage-redaction-')), 'state.db');
  const usage = new SqliteUsageStore(path);
  const work = new SqliteWorkStore(path);
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
      profileId: 'profile_usage',
      profileLabel: 'Public profile',
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
      profileId: 'profile_usage',
      profileLabel: privateCanary,
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
    const app = createAdminRoutes({
      adminToken: 'usage-redaction-token',
      usage,
      work,
    });
    const headers = { authorization: 'Bearer usage-redaction-token' };

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
    assert.equal(privateItem.operation.profileLabel, null);
    assert.equal(privateItem.operation.channelLabel, null);
    assert.equal(privateItem.operation.routineLabel, null);
    assert.equal(privateItem.sessionDeepLink, '/admin/sessions/run_usage_private');
    assert.equal(publicItem.projection, 'public');
    assert.equal(publicItem.operation.profileLabel, 'Public profile');
    assert.equal(publicItem.operation.channelLabel, 'public-lab');
    assert.equal(publicItem.sessionDeepLink, '/admin/sessions/run_usage_public');

    const detailText = await (await app.request(
      '/admin/api/usage/operations/op_usage_private',
      { headers },
    )).text();
    assert.doesNotMatch(detailText, /PRIVATE_USAGE_LABEL|alert\(81\)/);
    assert.equal((JSON.parse(detailText) as Record<string, any>).projection, 'redacted');

    const summary = await (await app.request(
      '/admin/api/usage/summary?from=1&to=3000&groupBy=channel',
      { headers },
    )).json() as Record<string, any>;
    assert.ok(summary.groups.every((group: Record<string, unknown>) => group.label === null));
  } finally {
    usage.close();
    work.close();
  }
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
