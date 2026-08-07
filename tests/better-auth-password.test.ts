import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DUMMY_PASSWORD_RECORD,
  SCRYPT_PARAMETERS,
  SCRYPT_RECORD_PREFIX,
  nativePasswordPrimitive,
  verifierShard,
} from '../src/auth/password.ts';

test('native password primitive writes the exact reviewed scrypt record and verifies NFKC', async () => {
  const password = nativePasswordPrimitive();
  const record = await password.hash('A secure passphrase with Å');

  assert.equal(record.startsWith(`${SCRYPT_RECORD_PREFIX}$`), true);
  assert.equal(record.split('$').length, 8);
  assert.equal(Buffer.from(verifierShard(record) ?? '', 'base64url').byteLength, SCRYPT_PARAMETERS.saltLength);
  assert.equal(await password.verify({ hash: record, password: 'A secure passphrase with Å' }), true);
  assert.equal(await password.verify({ hash: record, password: 'A different passphrase' }), false);
});

test('unknown and malformed verifier records fail closed', async () => {
  const password = nativePasswordPrimitive();
  assert.equal(await password.verify({ hash: 'pbkdf2$old$record', password: 'anything' }), false);
  assert.equal(await password.verify({ hash: `${SCRYPT_RECORD_PREFIX}$short$short`, password: 'anything' }), false);
  assert.equal(
    await password.verify({ hash: DUMMY_PASSWORD_RECORD, password: 'not the public dummy value' }),
    false,
  );
});
