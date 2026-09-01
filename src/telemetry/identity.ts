import type { SettingsStore } from '../config/settings-store.ts';
import { envValue } from '../config/env-value.ts';
import { decodeBase64Url, encodeBase64Url } from '../security/base64url.ts';

export const TELEMETRY_IDENTITY_SETTING = 'telemetry.identity.v1';

const IDENTITY_KEY_BYTES = 32;
const PSEUDONYM_BYTES = 16;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TelemetryIdentityDomain = 'workspace' | 'agent';

export interface TelemetryIdentity {
  installationId: string;
  hmacKey: Uint8Array;
}

interface StoredTelemetryIdentity {
  version: 1;
  installationId: string;
  hmacKey: string;
}

export class TelemetryIdentityUnavailableError extends Error {
  constructor() {
    super('Product telemetry identity is unavailable.');
    this.name = 'TelemetryIdentityUnavailableError';
  }
}

export function productTelemetryDisabled(env?: Record<string, unknown>): boolean {
  return disabledValue(envValue(env, 'DO_NOT_TRACK')) ||
    disabledValue(envValue(env, 'CHICKPEA_DISABLE_TELEMETRY'));
}

export async function loadOrCreateTelemetryIdentity(input: {
  settings: SettingsStore;
  env?: Record<string, unknown>;
  randomUUID?: () => string;
  randomBytes?: (length: number) => Uint8Array;
}): Promise<TelemetryIdentity | undefined> {
  if (productTelemetryDisabled(input.env)) return undefined;

  const current = await input.settings.getSetting(TELEMETRY_IDENTITY_SETTING);
  if (current !== undefined) return parseStoredIdentity(current);

  const installationId = (input.randomUUID ?? (() => crypto.randomUUID()))();
  const hmacKey = (input.randomBytes ?? secureRandomBytes)(IDENTITY_KEY_BYTES);
  if (!UUID_PATTERN.test(installationId) || hmacKey.byteLength !== IDENTITY_KEY_BYTES) {
    throw new TelemetryIdentityUnavailableError();
  }
  const stored: StoredTelemetryIdentity = {
    version: 1,
    installationId,
    hmacKey: encodeBase64Url(hmacKey),
  };
  const written = await input.settings.applySettingsPatch({
    expected: { key: TELEMETRY_IDENTITY_SETTING, value: null },
    set: [{ key: TELEMETRY_IDENTITY_SETTING, value: JSON.stringify(stored) }],
  });
  if (written) return { installationId, hmacKey: new Uint8Array(hmacKey) };

  const winner = await input.settings.getSetting(TELEMETRY_IDENTITY_SETTING);
  if (winner === undefined) throw new TelemetryIdentityUnavailableError();
  return parseStoredIdentity(winner);
}

export async function telemetryPseudonym(
  identity: TelemetryIdentity,
  domain: TelemetryIdentityDomain,
  localId: string,
): Promise<string> {
  if (identity.hmacKey.byteLength !== IDENTITY_KEY_BYTES || !validLocalId(localId)) {
    throw new TelemetryIdentityUnavailableError();
  }
  const keyBytes = new ArrayBuffer(identity.hmacKey.byteLength);
  new Uint8Array(keyBytes).set(identity.hmacKey);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`chickpea-product-telemetry-${domain}-v1\0${localId}`),
  );
  const prefix = domain === 'workspace' ? 'ws' : 'agent';
  return `${prefix}_${encodeBase64Url(new Uint8Array(signature).slice(0, PSEUDONYM_BYTES))}`;
}

function parseStoredIdentity(raw: string): TelemetryIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TelemetryIdentityUnavailableError();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TelemetryIdentityUnavailableError();
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.version !== 1 || typeof value.installationId !== 'string' ||
    !UUID_PATTERN.test(value.installationId) || typeof value.hmacKey !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.hmacKey)
  ) {
    throw new TelemetryIdentityUnavailableError();
  }
  let hmacKey: Uint8Array;
  try {
    hmacKey = decodeBase64Url(value.hmacKey);
  } catch {
    throw new TelemetryIdentityUnavailableError();
  }
  if (hmacKey.byteLength !== IDENTITY_KEY_BYTES) {
    throw new TelemetryIdentityUnavailableError();
  }
  return { installationId: value.installationId, hmacKey };
}

function disabledValue(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes'].includes(value.toLowerCase());
}

function validLocalId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function secureRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

