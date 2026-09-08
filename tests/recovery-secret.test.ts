import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RecoverySecretError,
  decodeRecoverySecret,
  digestSlackRecoveryGrant,
} from '../src/auth/recovery-secret.ts';

test('documented recovery encodings produce one deployment-scoped Slack recovery grant', () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
  const hex = Buffer.from(bytes).toString('hex');
  const base64 = Buffer.from(bytes).toString('base64');
  const base64url = Buffer.from(bytes).toString('base64url');

  assert.deepEqual([...decodeRecoverySecret(hex)], [...bytes]);
  assert.deepEqual([...decodeRecoverySecret(base64)], [...bytes]);
  assert.deepEqual([...decodeRecoverySecret(base64url)], [...bytes]);

  const grantDigests = [hex, base64, base64url].map((value) =>
    digestSlackRecoveryGrant('deployment_immutable', value));
  assert.equal(new Set(grantDigests).size, 1);
  assert.notEqual(
    grantDigests[0],
    digestSlackRecoveryGrant('deployment_other', hex),
  );
});

test('recovery decoding rejects ambiguous, padded, and wrong-length forms', () => {
  for (const value of ['', '0'.repeat(62), 'A'.repeat(42), 'A'.repeat(43) + '==', 'A'.repeat(42) + '/=']) {
    assert.throws(() => decodeRecoverySecret(value), RecoverySecretError);
  }
});
