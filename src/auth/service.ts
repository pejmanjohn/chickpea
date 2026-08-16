import { randomUUID } from 'node:crypto';

import type { IdentityStore } from '../identity/types.ts';
import type { PersonalTokenService } from './personal-token.ts';
import type {
  AdminAuthenticationService,
  AuthPrincipal,
  PrincipalAuthenticator,
} from './types.ts';

export class AuthDeniedError extends Error {
  readonly name = 'AuthDeniedError';
  constructor() { super('Authentication unavailable.'); }
}

interface AuthServiceOptions {
  identity: IdentityStore;
  personalTokens?: PersonalTokenService;
  sessionAuthenticator?: PrincipalAuthenticator;
}

const principalByRequest = new WeakMap<Request, AuthPrincipal>();
const responseHeadersByRequest = new WeakMap<Request, Headers>();

export class AuthService implements AdminAuthenticationService {
  constructor(private readonly options: AuthServiceOptions) {}

  async authenticateRequest(request: Request): Promise<AuthPrincipal> {
    const requestCorrelationId = correlationId(request);
    const control = await this.options.identity.getAuthControl();
    const authenticatorKind = control?.authMode === 'slack_active'
      ? 'better_auth'
      : 'unavailable';
    let principal: AuthPrincipal;
    try {
      if (control?.authMode === 'slack_active' && control.healthGate === 'normal' &&
          control.betterAuthOrganizationId && control.canonicalAdminOrigin) {
        if (!control.betterAuthOrganizationId || !control.canonicalAdminOrigin) {
          throw new AuthDeniedError();
        }
        const authorization = request.headers.get('authorization');
        if (authorization !== null) {
          const bearer = bearerToken(authorization);
          if (!bearer || !this.options.personalTokens) throw new AuthDeniedError();
          principal = await this.options.personalTokens.authenticate(bearer, true);
        } else {
          const result = await this.options.sessionAuthenticator?.authenticate(request);
          if (!result) throw new AuthDeniedError();
          principal = result.principal;
          if (result.responseHeaders) responseHeadersByRequest.set(request, result.responseHeaders);
        }
      } else {
        throw new AuthDeniedError();
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

  takeResponseHeaders(request: Request): Headers | undefined {
    const headers = responseHeadersByRequest.get(request);
    responseHeadersByRequest.delete(request);
    return headers;
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

function correlationId(request?: Request): string {
  const supplied = request?.headers.get('x-request-id');
  if (supplied && /^[A-Za-z0-9_.:-]{1,128}$/.test(supplied)) return supplied;
  return `request_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
}
