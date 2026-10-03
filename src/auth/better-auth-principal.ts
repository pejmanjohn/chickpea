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
import { hostedLoginAgrees, type HostedLoginFence, type HostedSessionRead } from './hosted-login.ts';
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
   * with that login's Slack account. Without a login nobody resolves. What
   * routing already read for the login is used instead of reading it again.
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
    // One state-store call reads everything Chickpea holds for this user,
    // beside Better Auth's read of their membership in this organization.
    // Chickpea's migrations make that pair unique, so the row found is
    // normally the one the binding names. A database without that index can
    // hold another row for the pair; then the bound row is read by its ID.
    // Hosted routing may have read both already, for this login.
    const routed = fence?.routed;
    const carried = routed?.memberships;
    const [stored, memberInOrganization] = await Promise.all([
      routed?.principal ?? this.input.access.resolveBetterAuthPrincipal(betterAuthUserId),
      carried
        ? carried.find((row) => row.userId === betterAuthUserId && row.organizationId === this.input.organizationId) ?? null
        : this.input.backend.getMembershipForUser(betterAuthUserId, this.input.organizationId),
    ]);
    if (!stored || !memberInOrganization) return undefined;
    const { binding, organization, user, membership, overlay } = stored;
    if (!binding.betterAuthUserId || !binding.betterAuthMembershipId) return undefined;
    const betterAuthMembership = memberInOrganization.id === binding.betterAuthMembershipId
      ? memberInOrganization
      : carried
        ? carried.find((row) => row.id === binding.betterAuthMembershipId) ?? null
        : await this.input.backend.getMembership(binding.betterAuthMembershipId);
    if (!betterAuthMembership || betterAuthMembership.role !== 'member' ||
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
  /**
   * Under installation tenancy, the session hosted routing read for this
   * request (`hostedLoginFence(env)?.routed?.session`). A request presenting
   * the same Cookie header authenticates with it, without asking Better
   * Auth again; any other is read as usual.
   */
  routedSession?: HostedSessionRead | undefined;
}

interface SessionRead {
  betterAuthUserId: string;
  sessionId: string;
  headers?: Headers | undefined;
}

export class BetterAuthSessionAuthenticator implements PrincipalAuthenticator {
  readonly kind = 'better_auth';
  private auth: ReturnType<typeof createBetterAuth> | undefined;

  constructor(private readonly input: BetterAuthSessionAuthenticatorInput) {
    // With a routed session Better Auth is built only if a request needs it.
    if (!input.routedSession) this.auth = this.createAuth();
  }

  async authenticate(request: Request): Promise<PrincipalAuthenticationResult | undefined> {
    const session = this.routedSession(request) ?? await this.readSession(request);
    if (!session) return undefined;
    const resolution = await this.input.directory.resolveBetterAuthUser(session.betterAuthUserId);
    if (!resolution || resolution.membership.status !== 'active') return undefined;
    const { user, membership } = resolution;
    const principal: AuthPrincipal = {
      userId: user.id,
      membershipId: membership.id,
      organizationId: membership.organizationId,
      role: membership.role,
      authenticatorKind: this.kind,
      credentialId: session.sessionId,
      correlationId: '',
      machine: false,
    };
    return { principal, ...(session.headers ? { responseHeaders: session.headers } : {}) };
  }

  private routedSession(request: Request): SessionRead | undefined {
    const routed = this.input.routedSession;
    if (!routed || routed.cookie !== request.headers.get('cookie')) return undefined;
    return {
      betterAuthUserId: routed.betterAuthUserId,
      sessionId: routed.id,
      ...(routed.setCookies.length
        ? { headers: new Headers(routed.setCookies.map((value): [string, string] => ['set-cookie', value])) }
        : {}),
    };
  }

  private async readSession(request: Request): Promise<SessionRead | undefined> {
    this.auth ??= this.createAuth();
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
    return { betterAuthUserId, sessionId, headers: result.headers };
  }

  private createAuth(): ReturnType<typeof createBetterAuth> {
    return createBetterAuth({
      backend: this.input.backend,
      baseURL: this.input.baseURL,
      secret: this.input.secret,
    });
  }
}
