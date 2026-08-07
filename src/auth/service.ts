import { randomUUID } from 'node:crypto';

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
    const requestCorrelationId = correlationId(request);
    const organization = await this.options.identity.getOrganization();
    const authenticatorKind = organization?.authMode === 'access_active'
      ? 'cloudflare_access'
      : organization?.authMode === 'token_active'
        ? 'token'
        : 'unavailable';
    let principal: AuthPrincipal;
    try {
      if (!organization) throw new AuthDeniedError();
      if (organization.authMode === 'access_active') {
        principal = await this.authenticateExternal(request);
      } else {
        if (organization.authMode !== 'token_active') throw new AuthDeniedError();
        const bearer = bearerToken(request.headers.get('authorization'));
        if (bearer && this.options.personalTokens) {
          principal = await this.options.personalTokens.authenticate(bearer, true);
        } else {
          const session = cookieValue(request.headers.get('cookie'), 'chickpea_session');
          if (!session || !this.options.tokenSessions) throw new AuthDeniedError();
          principal = await this.options.tokenSessions.authenticate(session);
        }
      }
    } catch (error) {
      await this.options.identity.recordAuthAudit({
        event: 'authentication',
        outcome: 'denied',
        action: 'admin.authenticate',
        correlationId: requestCorrelationId,
        authenticatorKind,
        reasonCode: 'authentication_denied',
      });
      throw error instanceof AuthDeniedError ? error : new AuthDeniedError();
    }
    principal = { ...principal, correlationId: requestCorrelationId };
    await this.options.identity.recordAuthAudit({
      event: 'authentication',
      outcome: 'success',
      action: 'admin.authenticate',
      correlationId: principal.correlationId,
      authenticatorKind: principal.authenticatorKind,
      userId: principal.userId,
      membershipId: principal.membershipId,
    });
    return principal;
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
        correlationId: correlationId(request),
        machine: false,
      };
    }
    throw new AuthDeniedError();
  }

  async loginWithPersonalToken(token: string): Promise<TokenLoginResult> {
    const loginCorrelationId = correlationId();
    let principal: AuthPrincipal;
    let session: { token: string; expiresAt: number };
    try {
      const organization = await this.options.identity.getOrganization();
      if (organization?.authMode !== 'token_active') throw new AuthDeniedError();
      if (!this.options.personalTokens || !this.options.tokenSessions) throw new AuthDeniedError();
      principal = await this.options.personalTokens.authenticate(token, false);
      principal = { ...principal, correlationId: loginCorrelationId };
      const record = await this.options.identity.getPersonalToken(principal.credentialId);
      if (!record) throw new AuthDeniedError();
      session = await this.options.tokenSessions.create(record, principal.membershipId);
    } catch (error) {
      await this.options.identity.recordAuthAudit({
        event: 'authentication',
        outcome: 'denied',
        action: 'admin.token_login',
        correlationId: loginCorrelationId,
        authenticatorKind: 'personal_token',
        reasonCode: 'authentication_denied',
      });
      throw error instanceof AuthDeniedError ? error : new AuthDeniedError();
    }
    await this.options.identity.recordAuthAudit({
      event: 'authentication',
      outcome: 'success',
      action: 'admin.token_login',
      correlationId: principal.correlationId,
      authenticatorKind: principal.authenticatorKind,
      userId: principal.userId,
      membershipId: principal.membershipId,
    });
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

function correlationId(request?: Request): string {
  const supplied = request?.headers.get('x-request-id');
  if (supplied && /^[A-Za-z0-9_.:-]{1,128}$/.test(supplied)) return supplied;
  return `request_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
}
