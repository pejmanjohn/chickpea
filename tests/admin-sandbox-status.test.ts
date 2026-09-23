import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminRoutes } from '../src/admin/routes.ts';
import type { ConfigStore } from '../src/config/store.ts';
import type { SettingsStore } from '../src/config/settings-store.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

function fakeSandbox(probe: () => Promise<boolean>) {
  return {
    idFromName: (name: string) => name,
    get: () => ({ probeContainerRuntime: probe }),
  };
}

async function onCloudflare<T>(run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Cloudflare-Workers' } });
  try {
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete (globalThis as { navigator?: Navigator }).navigator;
  }
}

function routes() {
  const values = new Map<string, string>([['sandbox.installRequested', 'true']]);
  const settings = {
    getSetting: async (key: string) => values.get(key),
    getSettings: async (keys: string[]) => keys.map((key) => values.get(key)),
    setSetting: async (key: string, value: string) => { values.set(key, value); },
    setSettings: async (entries: Array<{ key: string; value: string }>) => { for (const entry of entries) values.set(entry.key, entry.value); },
  } as unknown as SettingsStore;
  const store = { listUserAgents: async () => [] } as unknown as ConfigStore;
  return createAdminRoutes({ ...testAdminAuthority('token'), settings, store });
}

test('a SANDBOX binding without a Container application is not reported as installed', async () => {
  await onCloudflare(async () => {
    const missing = fakeSandbox(async () => {
      throw new Error('Containers have not been enabled for this Durable Object class.');
    });
    const response = await routes().request('http://localhost/admin/api/sandbox/status',
      { headers: testAdminHeaders('token') }, { SANDBOX: missing });
    assert.equal(response.status, 200);
    const body = await response.json() as { installed: boolean; containerApplication: string; unmetPrerequisites: string[] };
    assert.equal(body.installed, false);
    assert.equal(body.containerApplication, 'missing');
    assert.ok(body.unmetPrerequisites.includes('sandbox_container'));
    assert.equal(body.unmetPrerequisites.includes('sandbox_binding'), false);

    const enable = await routes().request('http://localhost/admin/api/sandbox/status', {
      method: 'PUT',
      headers: { ...testAdminHeaders('token'), 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, readinessConfirmed: true, allowedHosts: [], monthlySessionCap: 0 }),
    }, { SANDBOX: missing });
    assert.equal(enable.status, 409);
    assert.deepEqual(await enable.json(), { error: 'sandbox_not_installed' });
  });
});

test('an attached Container application, or an inconclusive probe, keeps the binding installed', async () => {
  await onCloudflare(async () => {
    for (const [probe, expected] of [
      [async () => true, 'attached'],
      [async () => { throw new Error('Network connection lost.'); }, 'unknown'],
    ] as const) {
      const response = await routes().request('http://localhost/admin/api/sandbox/status',
        { headers: testAdminHeaders('token') }, { SANDBOX: fakeSandbox(probe) });
      const body = await response.json() as { installed: boolean; containerApplication: string };
      assert.equal(body.installed, true);
      assert.equal(body.containerApplication, expected);
    }
  });
});

test('an installed sandbox without the checkpoint bucket says checkpoints are off until R2 is enabled', async () => {
  await onCloudflare(async () => {
    const attached = fakeSandbox(async () => true);
    const off = await routes().request('http://localhost/admin/api/sandbox/status',
      { headers: testAdminHeaders('token') }, { SANDBOX: attached });
    const offBody = await off.json() as { installed: boolean; checkpointsNote: string | null; workersPaidNote: string };
    assert.equal(offBody.installed, true);
    assert.match(offBody.checkpointsNote ?? '', /^Workspace checkpoints are off until R2 is enabled/);
    assert.match(offBody.workersPaidNote, /Workspace checkpoints also need R2 enabled on the account/);

    const bucket = { list: async () => ({ objects: [], truncated: false }), delete: async () => {} };
    const on = await routes().request('http://localhost/admin/api/sandbox/status',
      { headers: testAdminHeaders('token') }, { SANDBOX: attached, BACKUP_BUCKET: bucket });
    assert.equal((await on.json() as { checkpointsNote: string | null }).checkpointsNote, null);

    // Not installed yet: the redeploy steps carry the R2 prerequisite instead.
    const missing = fakeSandbox(async () => { throw new Error('Containers have not been enabled for this Durable Object class.'); });
    const pending = await routes().request('http://localhost/admin/api/sandbox/status',
      { headers: testAdminHeaders('token') }, { SANDBOX: missing });
    assert.equal((await pending.json() as { checkpointsNote: string | null }).checkpointsNote, null);
  });
});
