import { createHmac, timingSafeEqual } from 'node:crypto';

import type { IdentityResolution, IdentityStore } from '../identity/types.ts';
import { normalizeCloudflareAccessIssuer } from './cloudflare-access.ts';
import { AuthDeniedError } from './service.ts';
import type { ExternalIdentity } from './types.ts';
import { createBetterAuth, requireSupportedOrigin } from './better-auth.ts';
import type { BetterAuthEnvironment } from './better-auth-environment.ts';
import { assertPasswordPolicy } from './password-policy.ts';
import { decodeRecoverySecret } from './recovery-secret.ts';

const OWNER_SETUP_TTL_MS = 24 * 60 * 60 * 1_000;

export interface CompletePasswordOwnerSetupInput {
  recoveryToken: string;
  displayName: string;
  email: string;
  password: string;
  organizationName: string;
  canonicalOrigin: string;
}

export interface CompletePasswordOwnerSetupResult {
  operationId: string;
  userId: string;
  organizationId: string;
  membershipId: string;
  headers: Headers;
}

/** Trusted, recovery-gated wrapper around Better Auth's otherwise dark signup path. */
export class PasswordOwnerSetupService {
  constructor(
    private readonly identity: IdentityStore,
    private readonly environment: BetterAuthEnvironment,
    private readonly now: () => number = Date.now,
  ) {}

  async complete(input: CompletePasswordOwnerSetupInput): Promise<CompletePasswordOwnerSetupResult> {
    const recovery = requireMatchingRecoverySecret(
      input.recoveryToken,
      this.environment.recoveryToken,
    );
    const canonicalOrigin = requireSupportedOrigin(input.canonicalOrigin);
    if (canonicalOrigin !== this.environment.baseURL) throw new AuthDeniedError();
    const displayName = boundedHumanText(input.displayName, 'displayName');
    const organizationName = boundedHumanText(input.organizationName, 'organizationName');
    const email = normalizeSetupEmail(input.email);
    assertPasswordPolicy(input.password, { email, organizationName });

    const control = await this.identity.ensureAuthControl();
    if (control.authMode !== 'unconfigured') throw new AuthDeniedError();
    const capabilityHash = ownerSetupCapabilityHash(recovery, email, canonicalOrigin);
    let operation = await this.identity.findAuthOperation('owner_setup', capabilityHash);
    operation ??= await this.identity.createAuthOperation({
      kind: 'owner_setup',
      expectedEmail: email,
      capabilityHash,
      expiresAt: this.now() + OWNER_SETUP_TTL_MS,
    });
    if (operation.expectedNormalizedEmail !== email || operation.status !== 'pending') {
      throw new AuthDeniedError();
    }

    const auth = createBetterAuth({
      ...this.environment,
      allowSignUp: true,
      autoSignInAfterSignUp: false,
    });
    let userId = operation.betterAuthUserId;
    if (!userId) {
      const existing = await this.environment.backend.findUserByEmail(email);
      if (existing) {
        await verifyPasswordWithPrivateSession(auth, email, input.password);
        userId = existing.id;
      } else {
        const signup = await auth.api.signUpEmail({
          body: { email, name: displayName, password: input.password },
        });
        userId = signup.user.id;
      }
      operation = await this.identity.advanceAuthOperation({
        operationId: operation.id,
        capabilityHash,
        step: 1,
        betterAuthUserId: userId,
      });
    }

    let organizationId = operation.betterAuthOrganizationId;
    let membershipId = operation.betterAuthMembershipId;
    if (!organizationId || !membershipId) {
      const priorMemberships = await this.environment.backend.listMembershipsForUser(userId);
      if (priorMemberships.length > 1 || priorMemberships.some((member) => member.role !== 'owner')) {
        throw new AuthDeniedError();
      }
      const prior = priorMemberships[0];
      if (prior) {
        organizationId = prior.organizationId;
        membershipId = prior.id;
      } else {
        const organizationApi = auth.api as unknown as {
          createOrganization(input: {
            body: { name: string; slug: string; userId: string };
          }): Promise<{
          id: string;
          members: Array<{ id: string; userId: string; role: string } | undefined>;
          }>;
        };
        const created = await organizationApi.createOrganization({
          body: { name: organizationName, slug: 'chickpea', userId },
        });
        const owner = created.members.find((member) => member?.userId === userId && member.role === 'owner');
        if (!owner) throw new AuthDeniedError();
        organizationId = created.id;
        membershipId = owner.id;
      }
      operation = await this.identity.advanceAuthOperation({
        operationId: operation.id,
        capabilityHash,
        step: 2,
        betterAuthOrganizationId: organizationId,
        betterAuthMembershipId: membershipId,
      });
    }
    if (!organizationId || !membershipId) throw new AuthDeniedError();
    const completedOrganizationId = organizationId;
    const completedMembershipId = membershipId;

    const [user, organization, membership] = await Promise.all([
      this.environment.backend.getUser(userId),
      this.environment.backend.getOrganization(completedOrganizationId),
      this.environment.backend.getMembership(completedMembershipId),
    ]);
    if (user?.email !== email || organization?.id !== completedOrganizationId ||
        membership?.userId !== userId || membership.organizationId !== completedOrganizationId ||
        membership.role !== 'owner') throw new AuthDeniedError();

    await this.identity.completePasswordSetup({
      operationId: operation.id,
      capabilityHash,
      expectedStep: 2,
      expectedControlRevision: control.revision,
      canonicalAdminOrigin: canonicalOrigin,
      betterAuthOrganizationId: completedOrganizationId,
    });
    const login = await auth.api.signInEmail({
      body: { email, password: input.password },
      returnHeaders: true,
    });
    return {
      operationId: operation.id,
      userId,
      organizationId: completedOrganizationId,
      membershipId: completedMembershipId,
      headers: login.headers,
    };
  }
}

interface AuthSetupOptions {
  recoveryToken: string;
  now?: () => number;
}

export class AuthSetupService {
  private readonly recoveryToken: string;
  private readonly now: () => number;

  constructor(
    private readonly identity: IdentityStore,
    options: AuthSetupOptions,
  ) {
    this.recoveryToken = validRecoveryToken(options.recoveryToken);
    this.now = options.now ?? Date.now;
  }

  async beginAccessSetup(input: { recoveryToken: string; ownerEmail: string }) {
    this.requireRecovery(input.recoveryToken);
    const organization = await this.identity.ensureOrganization({ displayName: 'Chickpea' });
    const ownerClaim = await this.identity.createOwnerClaim({
      organizationId: organization.id,
      email: input.ownerEmail,
    });
    await this.identity.configureAuthProvider({
      organizationId: organization.id,
      kind: 'cloudflare_access',
      state: 'pending',
    });
    const pending = await this.identity.updateOrganizationAuth({
      organizationId: organization.id,
      authMode: 'access_pending',
    });
    return { organization: pending, ownerClaim };
  }

  async configureAccess(input: {
    recoveryToken: string;
    issuer: string;
    audience: string;
    canonicalAdminOrigin: string;
  }) {
    this.requireRecovery(input.recoveryToken);
    const organization = await this.requiredPendingOrganization();
    const issuer = normalizeCloudflareAccessIssuer(input.issuer);
    const audience = bounded(input.audience, 'Access audience');
    await this.identity.updateOrganizationAuth({
      organizationId: organization.id,
      authMode: 'access_pending',
      canonicalAdminOrigin: input.canonicalAdminOrigin,
    });
    return this.identity.configureAuthProvider({
      organizationId: organization.id,
      kind: 'cloudflare_access',
      state: 'pending',
      issuer,
      audience,
      admissionState: 'action_required',
    });
  }

  async activateAccess(external: ExternalIdentity): Promise<IdentityResolution> {
    const organization = await this.identity.getOrganization();
    const config = await this.identity.getAuthProviderConfig('cloudflare_access');
    if (!organization || !config || !config.issuer || !config.audience ||
        external.provider !== 'cloudflare_access' || external.issuer !== config.issuer ||
        !organization.canonicalAdminOrigin) {
      throw new AuthDeniedError();
    }

    if (organization.authMode === 'access_active' && config.state === 'active') {
      const existing = await this.identity.resolveExternalIdentity(
        external.provider,
        external.issuer,
        external.subject,
        organization.id,
      );
      const ownerClaim = await this.identity.getOwnerClaim();
      if (existing?.membership.role === 'owner' && existing.binding.id === ownerClaim?.bindingId) {
        return existing;
      }
      throw new AuthDeniedError();
    }
    if (!['access_pending', 'legacy_shared'].includes(organization.authMode) ||
        config.state !== 'pending') {
      throw new AuthDeniedError();
    }

    const input = {
      organizationId: organization.id,
      provider: external.provider,
      issuer: external.issuer,
      subject: external.subject,
      verifiedEmail: external.verifiedEmail,
      audience: config.audience,
      canonicalAdminOrigin: organization.canonicalAdminOrigin,
      at: this.now(),
      ...(external.displayName === undefined ? {} : { displayName: external.displayName }),
    };
    return this.identity.activateAccessOwner(input);
  }

  private requireRecovery(candidate: string): void {
    if (!constantCredentialEquals(candidate, this.recoveryToken)) throw new AuthDeniedError();
  }

  private async requiredPendingOrganization() {
    const organization = await this.identity.getOrganization();
    if (!organization || organization.authMode !== 'access_pending') throw new AuthDeniedError();
    return organization;
  }
}

export function validRecoveryToken(value: string): string {
  if (value.length < 32 || value.length > 512 || /\s/.test(value)) {
    throw new Error('CHICKPEA_RECOVERY_TOKEN must contain at least 32 non-whitespace characters.');
  }
  return value;
}

export function constantCredentialEquals(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate.padEnd(512, '\0').slice(0, 512));
  const right = Buffer.from(expected.padEnd(512, '\0').slice(0, 512));
  return timingSafeEqual(left, right) && candidate.length === expected.length;
}

export function requireMatchingRecoverySecret(candidate: string, expected: string): Uint8Array {
  try {
    const left = decodeRecoverySecret(candidate);
    const right = decodeRecoverySecret(expected);
    if (!timingSafeEqual(Buffer.from(left), Buffer.from(right))) throw new AuthDeniedError();
    return right;
  } catch {
    throw new AuthDeniedError();
  }
}

function ownerSetupCapabilityHash(
  recovery: Uint8Array,
  email: string,
  canonicalOrigin: string,
): string {
  return createHmac('sha256', recovery)
    .update('chickpea/owner-setup/v1\0')
    .update(email)
    .update('\0')
    .update(canonicalOrigin)
    .digest('hex');
}

function normalizeSetupEmail(value: string): string {
  const email = value.trim().normalize('NFKC').toLowerCase();
  if (email.length < 3 || email.length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthDeniedError();
  return email;
}

function boundedHumanText(value: string, field: string): string {
  const result = value.trim().normalize('NFKC');
  if (!result || Array.from(result).length > 128 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error(`${field} is invalid.`);
  }
  return result;
}

async function verifyPasswordWithPrivateSession(
  auth: ReturnType<typeof createBetterAuth>,
  email: string,
  password: string,
): Promise<void> {
  try {
    await auth.api.signInEmail({ body: { email, password } });
  } catch {
    throw new AuthDeniedError();
  }
}

function bounded(value: string, label: string): string {
  const result = value.trim();
  if (!result || result.length > 1_024 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error(`${label} is invalid.`);
  }
  return result;
}
