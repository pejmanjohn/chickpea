import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeBase32, totpCode } from '../src/browser/totp.ts';

// RFC 6238 Appendix B, SHA-1 seed "12345678901234567890", last six digits.
const RFC_SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('totpCode matches the RFC 6238 SHA-1 vectors at six digits', async () => {
  assert.equal(await totpCode(RFC_SEED, 59 * 1000), '287082');
  assert.equal(await totpCode(RFC_SEED, 1_111_111_109 * 1000), '081804');
  assert.equal(await totpCode(RFC_SEED, 1_234_567_890 * 1000), '005924');
  assert.equal(await totpCode(RFC_SEED, 2_000_000_000 * 1000), '279037');
});

test('decodeBase32 ignores case, spaces, dashes, and padding, and rejects other characters', () => {
  assert.equal(new TextDecoder().decode(decodeBase32(RFC_SEED)), '12345678901234567890');
  assert.deepEqual(decodeBase32('gezd gnbv-gy3t qojq'), decodeBase32('GEZDGNBVGY3TQOJQ'));
  assert.deepEqual(decodeBase32('MY======'), new Uint8Array([0x66]));
  assert.throws(() => decodeBase32('GEZ1'), /not valid base32/);
  assert.throws(() => decodeBase32(''), /empty/);
});
