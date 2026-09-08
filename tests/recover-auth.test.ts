import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// @ts-expect-error Executable .mjs helpers intentionally have no declaration file.
import { inspectSlackRecoveryReadiness } from '../scripts/recover-auth.mjs';

test('operator preflight points to hidden Slack repair without creating identity authority', async () => {
  const result = await inspectSlackRecoveryReadiness({
    origin: 'https://chickpea.example',
    expectedRecoveryToken: 'a'.repeat(64),
  });
  assert.deepEqual(result, { recoveryUrl: 'https://chickpea.example/admin/recovery' });
  const source = await readFile(new URL('../scripts/recover-auth.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /PersonalTokenService|ownerEmail|replacePassword|fetch\s*\(/);
  assert.match(source, /read-only/i);
});

test('operator preflight rejects malformed recovery configuration and unsafe origins', async () => {
  await assert.rejects(
    () => inspectSlackRecoveryReadiness({
      origin: 'https://chickpea.example', expectedRecoveryToken: 'short',
    }),
    /recovery secret is invalid/i,
  );
  await assert.rejects(
    () => inspectSlackRecoveryReadiness({
      origin: 'https://user:pass@chickpea.example/path', expectedRecoveryToken: 'a'.repeat(64),
    }),
    /HTTPS origin/i,
  );
});
