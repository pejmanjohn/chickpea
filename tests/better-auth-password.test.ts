import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBetterAuthPublicHandler } from '../src/auth/better-auth-routes.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';

const ORIGIN = 'https://chickpea.example';

test('password signup, login, reset, and account endpoints are absent', async () => {
  const backend = new NodeBetterAuthBackend(':memory:');
  try {
    const handler = createBetterAuthPublicHandler({
      backend, baseURL: ORIGIN, secret: 'password-route-absence-contract',
    });
    for (const path of [
      '/api/auth/sign-up/email', '/api/auth/sign-in/email',
      '/api/auth/forget-password', '/api/auth/reset-password',
      '/api/auth/change-password', '/api/auth/set-password',
    ]) {
      const response = await handler(new Request(`${ORIGIN}${path}`, { method: 'POST' }));
      assert.equal(response.status, 404, path);
      assert.equal(response.headers.has('set-cookie'), false, path);
    }
  } finally {
    backend.close();
  }
});
