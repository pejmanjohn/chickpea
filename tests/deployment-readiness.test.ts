import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import {
  DEPLOYMENT_ACTIVATION_DIGEST_BINDING,
  DEPLOYMENT_ACTIVATION_ISSUED_AT_BINDING,
  mintDeploymentActivation,
} from '../src/auth/deployment-activation.mjs';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { GATEWAY_BINDING_SETTING } from '../src/slack/gateway/client.ts';

const TARGET_VERSION = '11111111-2222-3333-4444-555555555555';
const OLD_VERSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('deployment readiness is private and does not require a gateway before setup', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const activation = await mintDeploymentActivation();
  const app = createAdminRoutes({ settings });
  const env = {
    [DEPLOYMENT_ACTIVATION_DIGEST_BINDING]: activation.digest,
    [DEPLOYMENT_ACTIVATION_ISSUED_AT_BINDING]: String(activation.issuedAt),
    CF_VERSION_METADATA: { id: TARGET_VERSION },
  };
  try {
    const unauthorized = await app.request('http://localhost/internal/deployment/ready', {
      method: 'POST',
      headers: { 'X-Chickpea-Target-Version': TARGET_VERSION },
    }, env);
    assert.equal(unauthorized.status, 404);

    const ready = await app.request('http://localhost/internal/deployment/ready', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${activation.capability}`,
        'X-Chickpea-Target-Version': TARGET_VERSION,
      },
    }, env);
    assert.equal(ready.status, 204);
    assert.equal(ready.headers.get('cache-control'), 'no-store');
  } finally {
    settings.close();
  }
});

test('deployment readiness waits for the installed Slack gateway to run the target version', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  await settings.setSetting(GATEWAY_BINDING_SETTING, 'binding_test');
  const activation = await mintDeploymentActivation();
  let gatewayVersion = OLD_VERSION;
  let statusCalls = 0;
  const app = createAdminRoutes({ settings });
  const env = {
    [DEPLOYMENT_ACTIVATION_DIGEST_BINDING]: activation.digest,
    [DEPLOYMENT_ACTIVATION_ISSUED_AT_BINDING]: String(activation.issuedAt),
    CF_VERSION_METADATA: { id: TARGET_VERSION },
    SLACK_GATEWAY_SESSION: {
      idFromName: (name: string) => name,
      get: () => ({
        status: async () => {
          statusCalls += 1;
          return {
            healthy: true,
            phase: 'healthy',
            detail: null,
            generation: 4,
            versionId: gatewayVersion,
          };
        },
      }),
    },
  };
  const request = () => app.request('http://localhost/internal/deployment/ready', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${activation.capability}`,
      'X-Chickpea-Target-Version': TARGET_VERSION,
    },
  }, env);
  try {
    const workerPending = await app.request('http://localhost/internal/deployment/ready', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${activation.capability}`,
        'X-Chickpea-Target-Version': OLD_VERSION,
      },
    }, env);
    assert.equal(workerPending.status, 409);
    assert.deepEqual(await workerPending.json(), { error: 'worker_version_pending' });
    assert.equal(statusCalls, 0);

    const stale = await request();
    assert.equal(stale.status, 503);
    assert.deepEqual(await stale.json(), { error: 'gateway_session_stale_version' });
    assert.equal(stale.headers.get('retry-after'), '1');

    gatewayVersion = TARGET_VERSION;
    const ready = await request();
    assert.equal(ready.status, 204);
    assert.equal(statusCalls, 2);
  } finally {
    settings.close();
  }
});
