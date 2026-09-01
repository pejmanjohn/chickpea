import { AuthDeniedError } from '../../src/auth/service.ts';
import type { AdminAuthenticationService, AuthPrincipal } from '../../src/auth/types.ts';
import type { AuthControl, IdentityStore, Organization } from '../../src/identity/types.ts';

const TEST_ADMIN_ORIGIN = 'http://localhost';

const defaultPrincipal: AuthPrincipal = {
  userId: 'user_test_owner',
  membershipId: 'membership_test_owner',
  organizationId: 'org_oss',
  role: 'owner',
  authenticatorKind: 'test_slack_session',
  credentialId: 'session_test_owner',
  correlationId: 'request_test_owner',
  machine: false,
};

/**
 * Explicit authenticated Slack-owner seam for tests whose subject is not auth.
 * Authentication/identity integration itself is covered by the focused U1
 * Better Auth and canonical Slack binding suites.
 */
export function testAdminAuthority(
  token: string,
  origin = TEST_ADMIN_ORIGIN,
  sourceIdentity?: IdentityStore,
  principal: AuthPrincipal = defaultPrincipal,
): { identity: IdentityStore; authService: AdminAuthenticationService } {
  const control: AuthControl = {
    installationId: 'installation_test',
    authMode: 'slack_active',
    healthGate: 'normal',
    canonicalAdminOrigin: origin,
    betterAuthOrganizationId: 'better_auth_org_test',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const organization: Organization = {
    id: principal.organizationId,
    displayName: 'Chickpea',
    slackTeamId: 'T_TEST',
    authMode: 'slack_active',
    canonicalAdminOrigin: origin,
    createdAt: 1,
    updatedAt: 1,
  };
  const identity = sourceIdentity
    ? new Proxy(sourceIdentity, {
        get(target, property, receiver) {
          if (property === 'getAuthControl') return async () => control;
          if (property === 'getOrganization') return async () => organization;
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      })
    : ({
        getAuthControl: async () => control,
        getOrganization: async () => organization,
        recordAuthAudit: async () => undefined,
      } as unknown as IdentityStore);
  const authService: AdminAuthenticationService = {
    async authenticateRequest(request) {
      if (request.headers.get('authorization') !== `Bearer ${token}`) {
        throw new AuthDeniedError();
      }
      return principal;
    },
  };
  return { identity, authService };
}

export function testAdminHeaders(
  token: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    origin: TEST_ADMIN_ORIGIN,
    'sec-fetch-site': 'same-origin',
    ...extra,
  };
}
