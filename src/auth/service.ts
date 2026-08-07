import { createHash, randomUUID } from 'node:crypto';

import type { IdentityStore } from '../identity/types.ts';
import type { PersonalTokenService } from './personal-token.ts';
import type { TokenSessionService } from './token-session.ts';
import type {
  AdminAuthenticationService,
  Authenticator,
  AuthPrincipal,
  TokenLoginResult,
} from './types.ts';

export class AuthDeniedError extends Error {
  readonly name = 'AuthDeniedError';
  constructor() { super('Authentication unavailable.'); }
}

interface AuthServiceOptions {
  identity: IdentityStore;
  authenticators?: readonly Authenticator[];
  personalTokens?: PersonalTokenService;
  tokenSessions?: TokenSessionService;
}

const principalByRequest = new WeakMap<Request, AuthPrincipal>();

export class AuthService implements AdminAuthenticationService {
  constructor(private readonly options: AuthServiceOptions) {}

  async authenticateRequest(request: Request): Promise<AuthPrincipal> {
    const organization = await this.options.identity.getOrganization();
    if (!organization) throw new AuthDeniedError();

    if (organization.authMode === 'access_active') {
      return this.authenticateExternal(request);
    }
    if (organization.authMode !== 'token_active') throw new AuthDeniedError();

    const bearer = bearerToken(request.headers.get('authorization'));
    if (bearer && this.options.personalTokens) {
      return this.options.personalTokens.authenticate(bearer, true);
    }
    const session = cookieValue(request.headers.get('cookie'), 'chickpea_session');
    if (session && this.options.tokenSessions) {
      return this.options.tokenSessions.authenticate(session);
    }
    throw new AuthDeniedError();
  }

  private async authenticateExternal(request: Request): Promise<AuthPrincipal> {
    for (const authenticator of this.options.authenticators ?? []) {
      const external = await authenticator.authenticate(request);
      if (!external) continue;
      const resolution = await this.options.identity.resolveExternalIdentity(
        external.provider,
        external.issuer,
        external.subject,
      );
      if (!resolution || resolution.membership.status !== 'active') throw new AuthDeniedError();
      return {
        userId: resolution.user.id,
        membershipId: resolution.membership.id,
        organizationId: resolution.membership.organizationId,
        role: resolution.membership.role,
        authenticatorKind: authenticator.kind,
        credentialId: external.credentialId,
        correlationId: correlationId(request, external.credentialId),
        machine: false,
      };
    }
    throw new AuthDeniedError();
  }

  async loginWithPersonalToken(token: string): Promise<TokenLoginResult> {
    const organization = await this.options.identity.getOrganization();
    if (organization?.authMode !== 'token_active') throw new AuthDeniedError();
    if (!this.options.personalTokens || !this.options.tokenSessions) throw new AuthDeniedError();
    const principal = await this.options.personalTokens.authenticate(token, false);
    const record = await this.options.identity.getPersonalToken(principal.credentialId);
    if (!record) throw new AuthDeniedError();
    const session = await this.options.tokenSessions.create(record, principal.membershipId);
    return { principal, sessionToken: session.token, expiresAt: session.expiresAt };
  }

  async logoutSession(token: string): Promise<void> {
    await this.options.tokenSessions?.revoke(token);
  }
}

export function setRequestPrincipal(request: Request, principal: AuthPrincipal): void {
  principalByRequest.set(request, principal);
}

export function requestPrincipal(request: Request): AuthPrincipal | undefined {
  return principalByRequest.get(request);
}

function bearerToken(value: string | null): string | undefined {
  const match = /^Bearer\s+([^\s]+)$/i.exec(value ?? '');
  return match?.[1];
}

function cookieValue(raw: string | null, name: string): string | undefined {
  for (const part of (raw ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

function correlationId(request: Request, credentialId: string): string {
  const supplied = request.headers.get('x-request-id');
  if (supplied && /^[A-Za-z0-9_.:-]{1,128}$/.test(supplied)) return supplied;
  return `request_${createHash('sha256').update(`${credentialId}\0${randomUUID()}`).digest('hex').slice(0, 24)}`;
}
