import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';

export const SCRYPT_PARAMETERS = Object.freeze({
  N: 32_768,
  r: 8,
  p: 3,
  keyLength: 32,
  maxmem: 64 * 1024 * 1024,
  saltLength: 16,
});

export const SCRYPT_RECORD_PREFIX = 'scrypt$v=1$norm=NFKC$N=32768$r=8$p=3';

// A public, non-credential verifier used only to make unknown-account login
// attempts perform the same native scrypt work as wrong-password attempts.
export const DUMMY_PASSWORD_RECORD =
  'scrypt$v=1$norm=NFKC$N=32768$r=8$p=3$Y2hpY2twZWEtZHVtbXl2MQ$UcRlD_QbgqDJ_zykcUjVMS0q5yEqkU_Wlt2BDgV8EQc';

export interface PasswordPrimitive {
  hash(password: string): Promise<string>;
  verify(input: { hash: string; password: string }): Promise<boolean>;
}

interface DecodedRecord {
  salt: Buffer;
  verifier: Buffer;
}

function decodeBase64UrlExact(value: string, expectedLength: number): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== expectedLength) return null;
  return decoded.toString('base64url') === value ? decoded : null;
}

function decodeRecord(record: string): DecodedRecord | null {
  const parts = record.split('$');
  if (parts.length !== 8 || parts.slice(0, 6).join('$') !== SCRYPT_RECORD_PREFIX) return null;
  const salt = decodeBase64UrlExact(parts[6] ?? '', SCRYPT_PARAMETERS.saltLength);
  const verifier = decodeBase64UrlExact(parts[7] ?? '', SCRYPT_PARAMETERS.keyLength);
  return salt && verifier ? { salt, verifier } : null;
}

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password.normalize('NFKC'), salt, SCRYPT_PARAMETERS.keyLength, {
      N: SCRYPT_PARAMETERS.N,
      maxmem: SCRYPT_PARAMETERS.maxmem,
      p: SCRYPT_PARAMETERS.p,
      r: SCRYPT_PARAMETERS.r,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export function nativePasswordPrimitive(): PasswordPrimitive {
  return {
    async hash(password) {
      const salt = randomBytes(SCRYPT_PARAMETERS.saltLength);
      const verifier = await derive(password, salt);
      return `${SCRYPT_RECORD_PREFIX}$${salt.toString('base64url')}$${verifier.toString('base64url')}`;
    },

    async verify({ hash, password }) {
      const decoded = decodeRecord(hash);
      if (!decoded) return false;
      const candidate = await derive(password, decoded.salt);
      return timingSafeEqual(candidate, decoded.verifier);
    },
  };
}

export function verifierShard(record: string): string | null {
  return decodeRecord(record)?.salt.toString('base64url') ?? null;
}
