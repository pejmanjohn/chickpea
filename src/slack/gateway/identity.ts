import type { SettingsStore } from '../../config/settings-store.ts';
import {
  decryptSlackSecretEnvelope,
  encryptSlackSecretEnvelope,
  type CredentialKeyring,
  type SlackSecretEnvelope,
} from '../secret-envelope.ts';
import {
  canonicalGatewayPayload,
  gatewaySigningPayload,
  parseGatewayPublicKey,
  type GatewayPublicKey,
  type GatewaySignedRequest,
} from './protocol.ts';

export const GATEWAY_DEPLOYMENT_IDENTITY_SETTING = 'slack.gateway.deploymentIdentity.v1';

export interface GatewayDeploymentIdentity {
  deploymentId: string;
  publicKey: GatewayPublicKey;
  privateKey: JsonWebKey;
  createdAt: number;
}

interface StoredGatewayDeploymentIdentity {
  version: 1;
  deploymentId: string;
  publicKey: GatewayPublicKey;
  privateKeyEnvelope: SlackSecretEnvelope;
  createdAt: number;
}

const encoder = new TextEncoder();

export async function loadOrCreateGatewayDeploymentIdentity(input: {
  settings: SettingsStore;
  keyring: CredentialKeyring;
  now?: () => number;
}): Promise<GatewayDeploymentIdentity> {
  const current = await input.settings.getSetting(GATEWAY_DEPLOYMENT_IDENTITY_SETTING);
  if (current) return openStoredIdentity(current, input.keyring);

  const createdAt = (input.now ?? Date.now)();
  const keyPair = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const [publicJwk, privateKey] = await Promise.all([
    globalThis.crypto.subtle.exportKey('jwk', keyPair.publicKey),
    globalThis.crypto.subtle.exportKey('jwk', keyPair.privateKey),
  ]);
  const publicKey = parseGatewayPublicKey(publicJwk);
  const deploymentId = await deploymentIdFor(publicKey);
  const privateKeyEnvelope = await encryptSlackSecretEnvelope(
    input.keyring,
    envelopeContext(deploymentId),
    { privateJwk: JSON.stringify(privateKey) },
  );
  const stored: StoredGatewayDeploymentIdentity = {
    version: 1,
    deploymentId,
    publicKey,
    privateKeyEnvelope,
    createdAt,
  };
  const written = await input.settings.applySettingsPatch({
    expected: { key: GATEWAY_DEPLOYMENT_IDENTITY_SETTING, value: null },
    set: [{ key: GATEWAY_DEPLOYMENT_IDENTITY_SETTING, value: JSON.stringify(stored) }],
  });
  return written
    ? { deploymentId, publicKey, privateKey, createdAt }
    : openStoredIdentity(
        requiredStoredValue(await input.settings.getSetting(GATEWAY_DEPLOYMENT_IDENTITY_SETTING)),
        input.keyring,
      );
}

export async function signGatewayRequest<T extends Omit<GatewaySignedRequest, 'signature'>>(
  identity: GatewayDeploymentIdentity,
  unsigned: T,
): Promise<T & { signature: string }> {
  if (unsigned.deploymentId !== identity.deploymentId) {
    throw new Error('Gateway request deployment identity mismatch.');
  }
  const key = await globalThis.crypto.subtle.importKey(
    'jwk',
    identity.privateKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    encoder.encode(gatewaySigningPayload(unsigned as T & Record<string, unknown>)),
  );
  return { ...unsigned, signature: encodeBase64Url(new Uint8Array(signature)) };
}

export async function verifyGatewayRequestSignature(input: {
  publicKey: GatewayPublicKey;
  request: GatewaySignedRequest & Record<string, unknown>;
}): Promise<boolean> {
  try {
    const key = await globalThis.crypto.subtle.importKey(
      'jwk',
      { ...input.publicKey, ext: true, key_ops: ['verify'] },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return globalThis.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      arrayBuffer(decodeBase64Url(input.request.signature)),
      encoder.encode(gatewaySigningPayload(input.request)),
    );
  } catch {
    return false;
  }
}

async function openStoredIdentity(
  raw: string,
  keyring: CredentialKeyring,
): Promise<GatewayDeploymentIdentity> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Gateway deployment identity is invalid.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Gateway deployment identity is invalid.');
  }
  const record = parsed as Record<string, unknown>;
  const publicKey = parseGatewayPublicKey(record.publicKey);
  if (
    record.version !== 1 || typeof record.deploymentId !== 'string' ||
    typeof record.createdAt !== 'number' || !Number.isSafeInteger(record.createdAt) ||
    !record.privateKeyEnvelope || typeof record.privateKeyEnvelope !== 'object'
  ) {
    throw new Error('Gateway deployment identity is invalid.');
  }
  if (await deploymentIdFor(publicKey) !== record.deploymentId) {
    throw new Error('Gateway deployment identity is invalid.');
  }
  const secret = await decryptSlackSecretEnvelope(
    keyring,
    envelopeContext(record.deploymentId),
    record.privateKeyEnvelope as SlackSecretEnvelope,
  );
  let privateKey: unknown;
  try {
    privateKey = JSON.parse(secret.privateJwk ?? '');
  } catch {
    throw new Error('Gateway deployment identity is invalid.');
  }
  if (!privateKey || typeof privateKey !== 'object' || Array.isArray(privateKey)) {
    throw new Error('Gateway deployment identity is invalid.');
  }
  return {
    deploymentId: record.deploymentId,
    publicKey,
    privateKey: privateKey as JsonWebKey,
    createdAt: record.createdAt,
  };
}

async function deploymentIdFor(publicKey: GatewayPublicKey): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    encoder.encode(canonicalGatewayPayload(publicKey)),
  );
  return `deployment_${encodeBase64Url(new Uint8Array(digest)).slice(0, 32)}`;
}

function envelopeContext(deploymentId: string) {
  return {
    deploymentId,
    identityId: 'gateway_deployment',
    identityClass: 'workspace_default' as const,
    appId: 'chickpea_shared_gateway',
    teamId: null,
    purpose: 'gateway_deployment_key' as const,
    revision: '1',
  };
}

function requiredStoredValue(value: string | undefined): string {
  if (!value) throw new Error('Gateway deployment identity was not retained.');
  return value;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid signature');
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
