import type { OrganizationRole } from '../identity/types.ts';

export interface AuthPrincipal {
  userId: string;
  membershipId: string;
  organizationId: string;
  role: OrganizationRole;
  authenticatorKind: string;
  credentialId: string;
  correlationId: string;
  machine: boolean;
}

export interface PrincipalAuthenticationResult {
  principal: AuthPrincipal;
  responseHeaders?: Headers;
}

export interface PrincipalAuthenticator {
  readonly kind: string;
  authenticate(request: Request): Promise<PrincipalAuthenticationResult | undefined>;
}

export interface AdminAuthenticationService {
  authenticateRequest(request: Request): Promise<AuthPrincipal>;
  takeResponseHeaders?(request: Request): Headers | undefined;
}
