import type {
  HumanIdentityDirectory,
  IdentityResolution,
  IdentityStore,
  Membership,
  Organization,
  User,
} from '../identity/types.ts';
import type { BetterAuthDatabaseBackend } from './better-auth-backend.ts';
import { createBetterAuth } from './better-auth.ts';
import { hostedLoginAgrees, type HostedLoginFence } from './hosted-login.ts';
import type {
  AuthPrincipal,
  PrincipalAuthenticationResult,
  PrincipalAuthenticator,
} from './types.ts';

interface BetterAuthDirectoryInput {
  backend: BetterAuthDatabaseBackend;
  access: IdentityStore;
  organizationId: string;
  canonicalAdminOrigin: string;
  /**
   * Under installation tenancy (`hostedLoginFence(env)`): a Better Auth user
   * resolves only if they are the login the host routed the request by, and
   * only while this installation's stored binding and organization agree
   * with that login's Slack account. Without a login nobody resolves.
   */
  hostedLogin?: HostedLoginFence | undefined;
}

/** Chickpea's Slack-keyed TAG_STATE directory remains authoritative. */
export class BetterAuthDirectory implements HumanIdentityDirectory {
  constructor(private readonly input: BetterAuthDirectoryInput) {}

  getOrganization(): Promise<Organization | undefined> {
    return this.input.access.getOrganization();
  }

  listMemberships(): Promise<Membership[]> {
    return this.input.access.listMemberships();
  }

  getUser(userId: string): Promise<User | undefined> {
    return this.input.access.getUser(userId);
  }

  getMembership(membershipId: string): Promise<Membership | undefined> {
    return this.input.access.getMembership(membershipId);
  }

  getMembershipForUser(userId: string, organizationId?: string): Promise<Membership | undefined> {
    return this.input.access.getMembershipForUser(userId, organizationId);
  }

  async resolveBetterAuthUser(betterAuthUserId: string): Promise<IdentityResolution | undefined> {
    const fence = this.input.hostedLogin;
    if (fence && fence.login?.betterAuthUserId !== betterAuthUserId) return undefined;
    const direct = await this.input.access.resolveBetterAuthIdentity(betterAuthUserId);
    if (!direct) return undefined;
    const { binding } = direct;
    const [betterAuthMembership, organization, user, membership, overlay] = await Promise.all([
      binding.betterAuthMembershipId
        ? this.input.backend.getMembership(binding.betterAuthMembershipId)
        : Promise.resolve(null),
      this.input.access.getOrganization(),
      this.input.access.getUser(binding.userId),
      this.input.access.getMembership(binding.membershipId),
      this.input.access.getMembershipAccessOverlay(binding.membershipId),
    ]);
    if (!binding.betterAuthUserId || !binding.betterAuthMembershipId ||
        !betterAuthMembership || betterAuthMembership.role !== 'member' ||
        betterAuthMembership.userId !== betterAuthUserId ||
        betterAuthMembership.organizationId !== this.input.organizationId ||
        !organization || !user || !membership ||
        membership.organizationId !== organization.id ||
        binding.organizationId !== organization.id) {
      return undefined;
    }
    if (fence && !(fence.login && hostedLoginAgrees(fence.login, binding, organization))) return undefined;
    if (overlay && (overlay.organizationId !== membership.organizationId ||
        overlay.accessStatus !== 'active')) return undefined;
    return { user, binding, membership };
  }
}

interface BetterAuthSessionAuthenticatorInput {
  backend: BetterAuthDatabaseBackend;
  directory: BetterAuthDirectory;
  organizationId: string;
  baseURL: string;
  secret: string;
}

export class BetterAuthSessionAuthenticator implements PrincipalAuthenticator {
  readonly kind = 'better_auth';
  // Built on first use: creating Better Auth starts database work, which a
  // request authenticated another way (or refused) would leave running past
  // a per-request database's lifetime.
  private auth: ReturnType<typeof createBetterAuth> | undefined;

  constructor(private readonly input: BetterAuthSessionAuthenticatorInput) {}

  async authenticate(request: Request): Promise<PrincipalAuthenticationResult | undefined> {
    this.auth ??= createBetterAuth({
      backend: this.input.backend,
      baseURL: this.input.baseURL,
      secret: this.input.secret,
    });
    const result = await this.auth.api.getSession({
      headers: request.headers,
      returnHeaders: true,
    }) as unknown as {
      headers?: Headers;
      response?: { session?: { id?: unknown }; user?: { id?: unknown } } | null;
    };
    const betterAuthUserId = result.response?.user?.id;
    const sessionId = result.response?.session?.id;
    if (typeof betterAuthUserId !== 'string' || typeof sessionId !== 'string') return undefined;
    const resolution = await this.input.directory.resolveBetterAuthUser(betterAuthUserId);
    if (!resolution || resolution.membership.status !== 'active') return undefined;
    const { user, membership } = resolution;
    const principal: AuthPrincipal = {
      userId: user.id,
      membershipId: membership.id,
      organizationId: membership.organizationId,
      role: membership.role,
      authenticatorKind: this.kind,
      credentialId: sessionId,
      correlationId: '',
      machine: false,
    };
    return { principal, ...(result.headers ? { responseHeaders: result.headers } : {}) };
  }
}
