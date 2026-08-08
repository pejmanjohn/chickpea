import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';

import type { IdentityStore, PersonalTokenRecord } from '../identity/types.ts';
import { AuthDeniedError } from './service.ts';
import type { AuthPrincipal } from './types.ts';
import { constantHashEquals, digest, parseCredential } from './personal-token.ts';

const MAX_SESSION_MS = 24 * 60 * 60 * 1_000;

interface TokenSessionOptions {
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}

export class TokenSessionService {
  private readonly now: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;

  constructor(
    private readonly identity: IdentityStore,
    options: TokenSessionOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? ((length) => nodeRandomBytes(length));
  }

  async create(
    token: PersonalTokenRecord,
    membershipId: string,
    ttlMs = MAX_SESSION_MS,
  ): Promise<{ token: string; expiresAt: number }> {
    const membership = await this.identity.getMembershipForUser(token.userId);
    if (!membership || membership.id !== membershipId || membership.status !== 'active' || token.status !== 'active') {
      throw new AuthDeniedError();
    }
    const boundedTtl = Math.min(Math.max(ttlMs, 1), MAX_SESSION_MS);
    const secret = Buffer.from(this.randomBytes(32)).toString('base64url');
    const prefix = secret.slice(0, 12);
    const raw = `chp_session_${prefix}_${secret}`;
    const expiresAt = this.now() + boundedTtl;
    await this.identity.createBrowserSession({
      organizationId: membership.organizationId,
      userId: token.userId,
      membershipId: membership.id,
      personalTokenId: token.id,
      sessionHash: digest(raw),
      prefix,
      expiresAt,
    });
    return { token: raw, expiresAt };
  }

  async authenticate(raw: string): Promise<AuthPrincipal> {
    const parsed = parseCredential(raw, 'chp_session');
    const candidateHash = digest(raw);
    const sessions = parsed ? await this.identity.findBrowserSessions(parsed.prefix) : [];
    const session = sessions.find((item) => constantHashEquals(item.sessionHash, candidateHash));
    if (!session) constantHashEquals('0'.repeat(64), candidateHash);
    if (!session || session.revokedAt !== null || session.expiresAt <= this.now()) throw new AuthDeniedError();
    const [sourceToken, user, membership] = await Promise.all([
      this.identity.getPersonalToken(session.personalTokenId),
      this.identity.getUser(session.userId),
      session.membershipId
        ? this.identity.getMembership(session.membershipId)
        : this.identity.getMembershipForUser(session.userId),
    ]);
    if (!sourceToken || sourceToken.status !== 'active' || !user || !membership ||
        membership.userId !== session.userId || membership.status !== 'active' ||
        (session.organizationId !== null && membership.organizationId !== session.organizationId)) {
      throw new AuthDeniedError();
    }
    return {
      userId: user.id,
      membershipId: membership.id,
      organizationId: membership.organizationId,
      role: membership.role,
      authenticatorKind: 'token_session',
      credentialId: session.id,
      correlationId: `auth_${createHash('sha256').update(`${session.id}\0${this.now()}`).digest('hex').slice(0, 24)}`,
      machine: false,
    };
  }

  async revoke(raw: string): Promise<void> {
    const parsed = parseCredential(raw, 'chp_session');
    if (!parsed) return;
    const hash = digest(raw);
    const sessions = await this.identity.findBrowserSessions(parsed.prefix);
    const session = sessions.find((item) => constantHashEquals(item.sessionHash, hash));
    if (session) await this.identity.revokeBrowserSession(session.id);
  }
}
