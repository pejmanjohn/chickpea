/**
 * Time-based one-time passwords (RFC 6238) over WebCrypto, for website logins
 * that store an authenticator seed. SHA-1, 30-second steps, 6 digits: the
 * parameters virtually every authenticator enrolment uses.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** Decode an RFC 4648 base32 seed; spaces, dashes, padding, and case are ignored. */
export function decodeBase32(seed: string): Uint8Array<ArrayBuffer> {
  const clean = seed.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value < 0) throw new Error('The authenticator seed is not valid base32.');
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }
  if (bytes.length === 0) throw new Error('The authenticator seed is empty.');
  return new Uint8Array(bytes);
}

/** The TOTP code for `atMs` (milliseconds since the epoch). */
export async function totpCode(seed: string, atMs: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    decodeBase32(seed),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const counter = Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}
