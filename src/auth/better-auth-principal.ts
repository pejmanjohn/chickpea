import type {
  ChickpeaIdentityControlStore,
  HumanIdentityDirectory,
  Membership,
  Organization,
  OrganizationRole,
  User,
} from '../identity/types.ts';
import type { BetterAuthDatabaseBackend, BetterAuthMembershipRecord } from './better-auth-backend.ts';
import { createBetterAuth } from './better-auth.ts';
import type { PasswordPrimitive } from './password.ts';
import type {
  AuthPrincipal,
  PrincipalAuthenticationResult,
  PrincipalAuthenticator,
} from './types.ts';

interface BetterAuthDirectoryInput {
  backend: BetterAuthDatabaseBackend;
  access: Pick<ChickpeaIdentityControlStore, 'getMembershipAccessOverlay'>;
  organizationId: string;
  canonicalAdminOrigin: string;
}

/**
 * Maps Better Auth's storage records into Chickpea-owned identity shapes.
 * Better Auth types deliberately stop at this file.
 */
export class BetterAuthDirectory implements HumanIdentityDirectory {
  private readonly users = new Map<string, User>();
  constructor(private readonly input: BetterAuthDirectoryInput) {}

  async getOrganization(): Promise<Organization | undefined> {
    const organization = await this.input.backend.getOrganization(this.input.organizationId);
    if (!organization) return undefined;
    return {
      id: organization.id,
      displayName: organization.name,
      authMode: 'password_active',
      canonicalAdminOrigin: this.input.canonicalAdminOrigin,
      createdAt: organization.createdAt,
      updatedAt: organization.createdAt,
    };
  }

  async listMemberships(): Promise<Membership[]> {
    const records = await this.input.backend.listMemberships(this.input.organizationId);
    for (const record of records) {
      if (record.user) this.users.set(record.user.id, userRecord(record.user));
    }
    const mapped = await Promise.all(records.map((record) => this.mapMembership(record)));
    return mapped.filter(isPresent);
  }

  async getUser(userId: string): Promise<User | undefined> {
    const cached = this.users.get(userId);
    if (cached) return cached;
    const user = await this.input.backend.getUser(userId);
    if (!user) return undefined;
    const mapped = userRecord(user);
    this.users.set(mapped.id, mapped);
    return mapped;
  }

  async findUserByEmail(email: string): Promise<User | undefined> {
    const user = await this.input.backend.findUserByEmail(email);
    return user ? userRecord(user) : undefined;
  }

  async getMembership(membershipId: string): Promise<Membership | undefined> {
    const membership = await this.input.backend.getMembership(membershipId);
    if (!membership || membership.organizationId !== this.input.organizationId) return undefined;
    return (await this.mapMembership(membership)) ?? undefined;
  }

  async getMembershipForUser(
    userId: string,
    organizationId = this.input.organizationId,
  ): Promise<Membership | undefined> {
    if (organizationId !== this.input.organizationId) return undefined;
    const membership = await this.input.backend.getMembershipForUser(userId, organizationId);
    return membership ? (await this.mapMembership(membership)) ?? undefined : undefined;
  }

  private async mapMembership(record: BetterAuthMembershipRecord): Promise<Membership | null> {
    const role = organizationRole(record.role);
    if (!role || record.organizationId !== this.input.organizationId) return null;
    const overlay = await this.input.access.getMembershipAccessOverlay(record.id);
    const overlayIsValid = !overlay || overlay.organizationId === record.organizationId;
    return {
      id: record.id,
      organizationId: record.organizationId,
      userId: record.userId,
      role,
      status: overlayIsValid && overlay?.accessStatus !== 'suspended' ? 'active' : 'suspended',
      createdAt: record.createdAt,
      updatedAt: overlay?.updatedAt ?? record.createdAt,
    };
  }
}

interface BetterAuthSessionAuthenticatorInput {
  backend: BetterAuthDatabaseBackend;
  directory: HumanIdentityDirectory;
  organizationId: string;
  baseURL: string;
  secret: string;
  password: PasswordPrimitive;
}

export class BetterAuthSessionAuthenticator implements PrincipalAuthenticator {
  readonly kind = 'better_auth';
  private readonly auth: ReturnType<typeof createBetterAuth>;

  constructor(private readonly input: BetterAuthSessionAuthenticatorInput) {
    this.auth = createBetterAuth({
      backend: input.backend,
      baseURL: input.baseURL,
      secret: input.secret,
      password: input.password,
      allowSignUp: false,
    });
  }

  async authenticate(request: Request): Promise<PrincipalAuthenticationResult | undefined> {
    const result = await this.auth.api.getSession({
      headers: request.headers,
      returnHeaders: true,
    }) as unknown as {
      headers?: Headers;
      response?: {
        session?: { id?: unknown };
        user?: { id?: unknown };
      } | null;
    };
    const userId = result.response?.user?.id;
    const sessionId = result.response?.session?.id;
    if (typeof userId !== 'string' || typeof sessionId !== 'string') return undefined;
    const membership = await this.input.directory.getMembershipForUser(
      userId,
      this.input.organizationId,
    );
    if (!membership || membership.status !== 'active') return undefined;
    const principal: AuthPrincipal = {
      userId,
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

function organizationRole(value: string): OrganizationRole | undefined {
  return value === 'owner' || value === 'admin' || value === 'member' ? value : undefined;
}

function userRecord(value: {
  id: string;
  email: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}): User {
  return {
    id: value.id,
    primaryEmail: value.email,
    displayName: value.name || null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
