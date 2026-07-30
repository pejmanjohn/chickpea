const IDENTITY_KEY_BYTES = 32;
const FINGERPRINT_BYTES = 16;

export function generateOpenAiSubscriptionIdentityKey(
  randomBytes: (length: number) => Uint8Array = secureRandomBytes,
): Uint8Array {
  const key = randomBytes(IDENTITY_KEY_BYTES);
  if (key.byteLength !== IDENTITY_KEY_BYTES) {
    throw new Error('OpenAI subscription identity key generation failed');
  }
  return new Uint8Array(key);
}

export async function accountFingerprint(
  accountId: string,
  identityKey: Uint8Array,
): Promise<string> {
  if (!accountId.trim() || identityKey.byteLength !== IDENTITY_KEY_BYTES) {
    throw new Error('OpenAI subscription identity input is invalid');
  }
  const keyMaterial = new ArrayBuffer(identityKey.byteLength);
  new Uint8Array(keyMaterial).set(identityKey);
  const key = await crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`chickpea-openai-subscription-account-v1\0${accountId}`),
  );
  return `oas_${base64Url(new Uint8Array(signature).slice(0, FINGERPRINT_BYTES))}`;
}

export function encodeOpenAiSubscriptionIdentityKey(key: Uint8Array): string {
  if (key.byteLength !== IDENTITY_KEY_BYTES) {
    throw new Error('OpenAI subscription identity key is invalid');
  }
  return base64Url(key);
}

export function decodeOpenAiSubscriptionIdentityKey(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error('OpenAI subscription identity key is invalid');
  }
  const decoded = base64UrlDecode(value);
  if (decoded.byteLength !== IDENTITY_KEY_BYTES) {
    throw new Error('OpenAI subscription identity key is invalid');
  }
  return decoded;
}

export function randomOpenAiSubscriptionCapability(
  randomBytes: (length: number) => Uint8Array = secureRandomBytes,
): string {
  const value = randomBytes(IDENTITY_KEY_BYTES);
  if (value.byteLength !== IDENTITY_KEY_BYTES) {
    throw new Error('OpenAI subscription capability generation failed');
  }
  return base64Url(value);
}

export async function hashOpenAiSubscriptionCapability(value: string): Promise<string> {
  if (!value || value.length > 512) throw new Error('OpenAI subscription capability is invalid');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

export function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function secureRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
