import { createHash } from 'node:crypto';

const HKDF_CONTEXT = 'chickpea/better-auth/v1';
const SLACK_RECOVERY_GRANT_CONTEXT = 'chickpea/slack-recovery-grant/v1';
const RECOVERY_BYTES = 32;

export class RecoverySecretError extends Error {
  readonly name = 'RecoverySecretError';

  constructor() {
    super('The Chickpea recovery secret is invalid.');
  }
}

/** Accept the three documented encodings and nothing else. */
export function decodeRecoverySecret(value: string): Uint8Array {
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
  }
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    return decodeCanonicalBase64(value, 'base64');
  }
  if (/^[A-Za-z0-9_-]{43}$/.test(value)) {
    return decodeCanonicalBase64(value, 'base64url');
  }
  throw new RecoverySecretError();
}

export async function deriveBetterAuthSecret(value: string): Promise<string> {
  const recovery = decodeRecoverySecret(value);
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(recovery).buffer,
    'HKDF',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new Uint8Array(32),
    info: new TextEncoder().encode(HKDF_CONTEXT),
  }, key, 256);
  return Buffer.from(bits).toString('base64url');
}

/** Canonical decoded bytes prevent alternate encodings from replaying one grant. */
export function digestSlackRecoveryGrant(deploymentId: string, value: string): string {
  if (!deploymentId || deploymentId.length > 256) throw new RecoverySecretError();
  return createHash('sha256')
    .update(SLACK_RECOVERY_GRANT_CONTEXT).update('\0').update(deploymentId).update('\0')
    .update(decodeRecoverySecret(value))
    .digest('hex');
}

function decodeCanonicalBase64(value: string, encoding: 'base64' | 'base64url'): Uint8Array {
  const decoded = Buffer.from(value, encoding);
  if (decoded.byteLength !== RECOVERY_BYTES || decoded.toString(encoding) !== value) {
    throw new RecoverySecretError();
  }
  return decoded;
}
