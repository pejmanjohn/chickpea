export const SLACK_SECRET_ENVELOPE_VERSION = 1 as const;
export const SLACK_SECRET_ENVELOPE_ALGORITHM = 'AES-GCM-256' as const;

export type SlackCredentialIdentityClass = 'workspace_installation';
export type SlackCredentialPurpose =
  | 'app_credentials'
  | 'connected_credentials'
  | 'gateway_deployment_key'
  | 'managed_connector_project_key';

export interface CredentialKeyring {
  currentKeyId: string;
  /** Base64url-encoded 256-bit AES keys, indexed by stable key ID. */
  keys: Readonly<Record<string, string>>;
}

export interface SlackSecretEnvelopeContext {
  deploymentId: string;
  identityId: string;
  identityClass: SlackCredentialIdentityClass;
  appId: string;
  teamId: string | null;
  purpose: SlackCredentialPurpose;
  revision: string;
}

export interface SlackSecretEnvelope {
  version: typeof SLACK_SECRET_ENVELOPE_VERSION;
  algorithm: typeof SLACK_SECRET_ENVELOPE_ALGORITHM;
  keyId: string;
  nonce: string;
  ciphertext: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

/** Encrypt a complete bundle. No credential field is ever returned separately. */
export async function encryptSlackSecretEnvelope<T extends Record<string, string>>(
  keyring: CredentialKeyring,
  context: SlackSecretEnvelopeContext,
  secrets: T,
): Promise<SlackSecretEnvelope> {
  validateContext(context);
  validateSecrets(secrets);
  const keyId = requireKeyId(keyring.currentKeyId);
  const rawKey = keyring.keys[keyId];
  if (!rawKey) throw new Error('Slack credential encryption key is unavailable.');
  const key = await importAesKey(rawKey, ['encrypt']);
  const nonceBytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(nonceBytes);
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: arrayBuffer(nonceBytes),
      additionalData: arrayBuffer(associatedData(context)),
      tagLength: 128,
    },
    key,
    arrayBuffer(textEncoder.encode(JSON.stringify(secrets))),
  );
  return {
    version: SLACK_SECRET_ENVELOPE_VERSION,
    algorithm: SLACK_SECRET_ENVELOPE_ALGORITHM,
    keyId,
    nonce: encodeBase64Url(nonceBytes),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  };
}

/**
 * Decrypt only at the request-local consumer. Every failure is deliberately
 * indistinguishable and excludes key IDs, metadata, and secret material.
 */
export async function decryptSlackSecretEnvelope<T extends Record<string, string>>(
  keyring: CredentialKeyring,
  context: SlackSecretEnvelopeContext,
  envelope: SlackSecretEnvelope,
): Promise<T> {
  try {
    validateContext(context);
    if (
      envelope.version !== SLACK_SECRET_ENVELOPE_VERSION ||
      envelope.algorithm !== SLACK_SECRET_ENVELOPE_ALGORITHM
    ) {
      throw new Error('unsupported envelope');
    }
    const keyId = requireKeyId(envelope.keyId);
    const rawKey = keyring.keys[keyId];
    if (!rawKey) throw new Error('unknown key');
    const nonce = decodeBase64Url(envelope.nonce);
    if (nonce.byteLength !== 12) throw new Error('invalid nonce');
    const ciphertext = decodeBase64Url(envelope.ciphertext);
    const key = await importAesKey(rawKey, ['decrypt']);
    const plaintext = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: arrayBuffer(nonce),
        additionalData: arrayBuffer(associatedData(context)),
        tagLength: 128,
      },
      key,
      arrayBuffer(ciphertext),
    );
    const parsed = JSON.parse(textDecoder.decode(plaintext)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid plaintext');
    }
    validateSecrets(parsed as Record<string, unknown>);
    return parsed as T;
  } catch {
    throw new Error('Slack credential envelope could not be decrypted.');
  }
}

function associatedData(context: SlackSecretEnvelopeContext): Uint8Array {
  // Array order is the canonical encoding. Null remains distinct from an empty
  // or unknown team, so pre-install app credentials cannot be swapped into a
  // connected workspace context.
  return textEncoder.encode(JSON.stringify([
    'chickpea-slack-credential-v1',
    context.deploymentId,
    context.identityId,
    context.identityClass,
    context.appId,
    context.teamId,
    context.purpose,
    context.revision,
  ]));
}

function validateContext(context: SlackSecretEnvelopeContext): void {
  for (const value of [
    context.deploymentId,
    context.identityId,
    context.appId,
    context.purpose,
    context.revision,
  ]) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
      throw new Error('Slack credential envelope context is invalid.');
    }
  }
  if (context.teamId !== null && (!context.teamId || context.teamId.length > 256)) {
    throw new Error('Slack credential envelope context is invalid.');
  }
}

function validateSecrets(secrets: Record<string, unknown>): void {
  const entries = Object.entries(secrets);
  if (entries.length === 0 || entries.length > 16) {
    throw new Error('Slack credential bundle is invalid.');
  }
  for (const [name, value] of entries) {
    if (!/^[a-z][A-Za-z0-9]{0,63}$/.test(name) ||
        typeof value !== 'string' || value.length < 1 || value.length > 16_384) {
      throw new Error('Slack credential bundle is invalid.');
    }
  }
}

function requireKeyId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new Error('Slack credential encryption key ID is invalid.');
  }
  return value;
}

async function importAesKey(
  encoded: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const raw = decodeBase64Url(encoded);
  if (raw.byteLength !== 32) throw new Error('invalid key length');
  return globalThis.crypto.subtle.importKey(
    'raw', arrayBuffer(raw), { name: 'AES-GCM' }, false, usages,
  );
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url');
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeCredentialKey(bytes: Uint8Array): string {
  if (bytes.byteLength !== 32) throw new Error('Credential encryption keys must be 256 bits.');
  return encodeBase64Url(bytes);
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
