const CAPABILITY_BYTES = 32;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const SETUP_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1_000;
export const SETUP_CAPABILITY_CLOCK_SKEW_MS = 5 * 60 * 1_000;
export const SETUP_CAPABILITY_DIGEST_BINDING = 'CHICKPEA_SETUP_CAPABILITY_DIGEST';
export const SETUP_CAPABILITY_ISSUED_AT_BINDING = 'CHICKPEA_SETUP_CAPABILITY_ISSUED_AT';

export async function mintSetupCapability(options = {}) {
  const cryptoApi = options.crypto ?? globalThis.crypto;
  if (!cryptoApi?.getRandomValues || !cryptoApi?.subtle) {
    throw new Error('A Web Crypto implementation is required to mint a setup capability.');
  }
  const bytes = new Uint8Array(CAPABILITY_BYTES);
  cryptoApi.getRandomValues(bytes);
  const capability = base64url(bytes);
  const issuedAt = options.now?.() ?? Date.now();
  return {
    capability,
    digest: await digestSetupCapability(capability, cryptoApi),
    issuedAt,
  };
}

export async function digestSetupCapability(capability, cryptoApi = globalThis.crypto) {
  if (!CAPABILITY_PATTERN.test(capability) || !cryptoApi?.subtle) {
    throw new Error('The setup capability is invalid.');
  }
  const digest = await cryptoApi.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(capability),
  );
  return base64url(new Uint8Array(digest));
}

export async function verifySetupCapability(input) {
  if (!CAPABILITY_PATTERN.test(input.capability) ||
      !CAPABILITY_PATTERN.test(input.digest) ||
      !Number.isSafeInteger(input.issuedAt)) return false;
  const now = input.now?.() ?? Date.now();
  if (
    input.issuedAt - now > SETUP_CAPABILITY_CLOCK_SKEW_MS ||
    now - input.issuedAt >= SETUP_CAPABILITY_TTL_MS
  ) return false;
  const actual = await digestSetupCapability(input.capability, input.crypto ?? globalThis.crypto);
  return constantTextEquals(actual, input.digest);
}

export function setupCapabilityUrl(baseUrl, capability) {
  if (!CAPABILITY_PATTERN.test(capability)) throw new Error('The setup capability is invalid.');
  const url = new URL('/admin/setup', baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Setup requires an HTTP(S) URL.');
  url.search = '';
  url.hash = `setup=${capability}`;
  return url.href;
}

function constantTextEquals(left, right) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
