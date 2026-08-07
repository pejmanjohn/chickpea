import { createHash } from 'node:crypto';

import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose';

import { AuthDeniedError } from './service.ts';
import type { Authenticator, ExternalIdentity } from './types.ts';

interface CloudflareAccessVerifierOptions {
  issuer: string;
  jwks?: JSONWebKeySet;
  keySet?: JWTVerifyGetKey;
}

interface CloudflareAccessAuthenticatorOptions extends CloudflareAccessVerifierOptions {
  audience: string;
}

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

export class CloudflareAccessAuthenticator implements Authenticator {
  readonly kind = 'cloudflare_access';
  private readonly issuer: string;
  private readonly audience: string;
  private readonly keySet: JWTVerifyGetKey;

  constructor(options: CloudflareAccessAuthenticatorOptions) {
    this.issuer = normalizeCloudflareAccessIssuer(options.issuer);
    this.audience = bounded(options.audience, 'Access audience');
    this.keySet = resolveKeySet(this.issuer, options);
  }

  async authenticate(request: Request): Promise<ExternalIdentity> {
    const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!assertion) throw new AuthDeniedError();
    return verifyAssertion(assertion, {
      issuer: this.issuer,
      audience: this.audience,
      keySet: this.keySet,
    });
  }
}

export async function verifyCloudflareAccessRecoveryAssertion(
  assertion: string,
  options: CloudflareAccessVerifierOptions,
): Promise<ExternalIdentity> {
  const issuer = normalizeCloudflareAccessIssuer(options.issuer);
  const keySet = resolveKeySet(issuer, options);
  return verifyAssertion(assertion, { issuer, keySet });
}

export function normalizeCloudflareAccessIssuer(raw: string): string {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      !url.hostname.endsWith('.cloudflareaccess.com') ||
      url.hostname === 'cloudflareaccess.com' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.port
    ) {
      throw new Error('invalid');
    }
    return url.origin;
  } catch {
    throw new Error('Cloudflare Access issuer is invalid.');
  }
}

async function verifyAssertion(
  assertion: string,
  options: { issuer: string; audience?: string; keySet: JWTVerifyGetKey },
): Promise<ExternalIdentity> {
  try {
    const { payload } = await jwtVerify(assertion, options.keySet, {
      issuer: options.issuer,
      ...(options.audience ? { audience: options.audience } : {}),
    });
    const subject = typeof payload.sub === 'string' ? payload.sub.trim() : '';
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!subject || subject.length > 512 || !email || email.length > 320 || !email.includes('@')) {
      throw new Error('claims');
    }
    return {
      kind: 'external_identity',
      provider: 'cloudflare_access',
      issuer: options.issuer,
      subject,
      verifiedEmail: email,
      credentialId: `access_${createHash('sha256').update(assertion).digest('hex').slice(0, 24)}`,
    };
  } catch {
    throw new AuthDeniedError();
  }
}

function resolveKeySet(
  issuer: string,
  options: Pick<CloudflareAccessVerifierOptions, 'jwks' | 'keySet'>,
): JWTVerifyGetKey {
  if (options.keySet) return options.keySet;
  if (options.jwks) return createLocalJWKSet(options.jwks);
  const cached = remoteKeySets.get(issuer);
  if (cached) return cached;
  const keySet = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  remoteKeySets.set(issuer, keySet);
  return keySet;
}

function bounded(value: string, label: string): string {
  const result = value.trim();
  if (!result || result.length > 1_024 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error(`${label} is invalid.`);
  }
  return result;
}
