import type { OrganizationRole } from '../identity/types.ts';

export interface ExternalIdentity {
  kind: 'external_identity';
  provider: string;
  issuer: string;
  subject: string;
  verifiedEmail: string;
  displayName?: string | null;
  credentialId: string;
}

export interface Authenticator {
  readonly kind: string;
  authenticate(request: Request): Promise<ExternalIdentity | undefined>;
}

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

export interface TokenLoginResult {
  principal: AuthPrincipal;
  sessionToken: string;
  expiresAt: number;
}

export interface AdminAuthenticationService {
  authenticateRequest(request: Request): Promise<AuthPrincipal>;
  loginWithPersonalToken?(token: string): Promise<TokenLoginResult>;
  logoutSession?(token: string): Promise<void>;
}
