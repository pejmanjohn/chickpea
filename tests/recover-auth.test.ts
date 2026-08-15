import assert from 'node:assert/strict';
import { test } from 'node:test';

// @ts-expect-error The retained legacy .mjs executable has no TypeScript declarations.
import { recoverTokenMode } from '../scripts/recover-auth.mjs';

test('legacy token/password recovery cannot mint a product principal', async () => {
  await assert.rejects(
    () => recoverTokenMode({}),
    /Legacy token\/password recovery is disabled/,
  );
});
