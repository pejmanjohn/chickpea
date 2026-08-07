import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';

import type { IdentityStore, PersonalTokenRecord } from '../identity/types.ts';
import { AuthDeniedError } from './service.ts';
import type { AuthPrincipal } from './types.ts';

interface PersonalTokenOptions {
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}

export class PersonalTokenService {
  private readonly now: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;

  constructor(
    private readonly identity: IdentityStore,
    options: PersonalTokenOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? ((length) => nodeRandomBytes(length));
  }

  async create(userId: string, label: string): Promise<{ token: string; record: PersonalTokenRecord }> {
    const secret = Buffer.from(this.randomBytes(32)).toString('base64url');
    const prefix = secret.slice(0, 12);
    const token = `chp_pat_${prefix}_${secret}`;
    const record = await this.identity.createPersonalToken({
      userId,
      tokenHash: digest(token),
      prefix,
      label,
    });
    return { token, record };
  }

  async authenticate(token: string, machine: boolean): Promise<AuthPrincipal> {
    const parsed = parseCredential(token, 'chp_pat');
    const candidateHash = digest(token);
    const records = parsed ? await this.identity.findPersonalTokens(parsed.prefix) : [];
    let matched: PersonalTokenRecord | undefined;
    for (const record of records) {
      if (constantHashEquals(record.tokenHash, candidateHash)) matched = record;
    }
    // Keep the malformed/unknown path on the same fixed-length comparison primitive.
    if (!matched) constantHashEquals('0'.repeat(64), candidateHash);
    if (!matched || matched.status !== 'active') throw new AuthDeniedError();
    const [user, membership] = await Promise.all([
      this.identity.getUser(matched.userId),
      this.identity.getMembershipForUser(matched.userId),
    ]);
    if (!user || !membership || membership.status !== 'active') throw new AuthDeniedError();
    await this.identity.touchPersonalToken(matched.id);
    return {
      userId: user.id,
      membershipId: membership.id,
      organizationId: membership.organizationId,
      role: membership.role,
      authenticatorKind: 'personal_token',
      credentialId: matched.id,
      correlationId: `auth_${createHash('sha256').update(`${matched.id}\0${this.now()}`).digest('hex').slice(0, 24)}`,
      machine,
    };
  }

  async revoke(tokenId: string): Promise<void> {
    await this.identity.revokePersonalToken(tokenId);
  }
}

export function parseCredential(
  value: string,
  kind: 'chp_pat' | 'chp_session',
): { prefix: string; secret: string } | undefined {
  const match = new RegExp(`^${kind}_([A-Za-z0-9_-]{12})_([A-Za-z0-9_-]{40,128})$`).exec(value);
  return match ? { prefix: match[1]!, secret: match[2]! } : undefined;
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function constantHashEquals(left: string, right: string): boolean {
  const a = Buffer.from(left.padEnd(64, '0').slice(0, 64));
  const b = Buffer.from(right.padEnd(64, '0').slice(0, 64));
  return timingSafeEqual(a, b) && left.length === 64 && right.length === 64;
}
