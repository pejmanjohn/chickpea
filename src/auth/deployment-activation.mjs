const CAPABILITY_BYTES = 32;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const DEPLOYMENT_ACTIVATION_TTL_MS = 10 * 60 * 1_000;
export const DEPLOYMENT_ACTIVATION_CLOCK_SKEW_MS = 60 * 1_000;
export const DEPLOYMENT_ACTIVATION_DIGEST_BINDING =
  'CHICKPEA_DEPLOYMENT_ACTIVATION_DIGEST';
export const DEPLOYMENT_ACTIVATION_ISSUED_AT_BINDING =
  'CHICKPEA_DEPLOYMENT_ACTIVATION_ISSUED_AT';

export async function mintDeploymentActivation(options = {}) {
  const cryptoApi = options.crypto ?? globalThis.crypto;
  if (!cryptoApi?.getRandomValues || !cryptoApi?.subtle) {
    throw new Error('A Web Crypto implementation is required to mint deployment activation.');
  }
  const bytes = new Uint8Array(CAPABILITY_BYTES);
  cryptoApi.getRandomValues(bytes);
  const capability = base64url(bytes);
  const issuedAt = options.now?.() ?? Date.now();
  return {
    capability,
    digest: await digestDeploymentActivation(capability, cryptoApi),
    issuedAt,
  };
}

export async function digestDeploymentActivation(capability, cryptoApi = globalThis.crypto) {
  if (!CAPABILITY_PATTERN.test(capability) || !cryptoApi?.subtle) {
    throw new Error('The deployment activation capability is invalid.');
  }
  const digest = await cryptoApi.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(capability),
  );
  return base64url(new Uint8Array(digest));
}

export async function verifyDeploymentActivation(input) {
  if (!CAPABILITY_PATTERN.test(input.capability) ||
      !CAPABILITY_PATTERN.test(input.digest) ||
      !Number.isSafeInteger(input.issuedAt)) return false;
  const now = input.now?.() ?? Date.now();
  if (
    input.issuedAt - now > DEPLOYMENT_ACTIVATION_CLOCK_SKEW_MS ||
    now - input.issuedAt >= DEPLOYMENT_ACTIVATION_TTL_MS
  ) return false;
  const actual = await digestDeploymentActivation(
    input.capability,
    input.crypto ?? globalThis.crypto,
  );
  return constantTextEquals(actual, input.digest);
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
