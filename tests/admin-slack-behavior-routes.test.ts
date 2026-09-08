import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

const TOKEN = 'slack-behavior-contract-token';

test('Slack behavior API retains internal keys and rejects removed presentation switches', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await settings.applySettingsPatch({
      set: [
        { key: 'slack.behavior.unassignedHint', value: 'false' },
        { key: 'slack.behavior.welcomeOnJoin', value: 'true' },
        { key: 'slack.behavior.progressiveStreaming', value: 'false' },
        { key: 'slack.behavior.nativeTasks', value: 'false' },
      ],
    });
    const app = createAdminRoutes({
      settings,
      ...testAdminAuthority(TOKEN),
    });
    const headers = testAdminHeaders(TOKEN, { 'content-type': 'application/json' });

    const current = await app.request('/admin/api/slack-behavior', { headers });
    assert.equal(current.status, 200);
    assert.deepEqual(await current.json(), {
      unassignedHint: { value: false, source: 'stored' },
      welcomeOnJoin: { value: true, source: 'stored' },
    });

    for (const removed of [
      { progressiveStreaming: true },
      { nativeTasks: true },
      { welcomeOnJoin: false, progressiveStreaming: true },
    ]) {
      const response = await app.request('/admin/api/slack-behavior', {
        method: 'PUT',
        headers,
        body: JSON.stringify(removed),
      });
      assert.equal(response.status, 400, JSON.stringify(removed));
      assert.deepEqual(await response.json(), { error: 'invalid_request' });
    }

    const updated = await app.request('/admin/api/slack-behavior', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ unassignedHint: true, welcomeOnJoin: false }),
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(await updated.json(), {
      unassignedHint: { value: true, source: 'stored' },
      welcomeOnJoin: { value: false, source: 'stored' },
    });
    assert.equal(await settings.getSetting('slack.behavior.progressiveStreaming'), 'false');
    assert.equal(await settings.getSetting('slack.behavior.nativeTasks'), 'false');
  } finally {
    settings.close();
  }
});
