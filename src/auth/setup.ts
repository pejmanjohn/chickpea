// @ts-nocheck -- password/Access bootstrap runtime is disconnected; physical deletion is U10.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type {
  AuthControl,
  AuthOperation,
  IdentityResolution,
  IdentityStore,
  Organization,
} from '../identity/types.ts';
import { normalizeCloudflareAccessIssuer } from './cloudflare-access.ts';
import { AuthDeniedError } from './service.ts';
import type { ExternalIdentity } from './types.ts';
import { createBetterAuth, requireSupportedOrigin } from './better-auth.ts';
import type { BetterAuthEnvironment } from './better-auth-environment.ts';
import { assertPasswordPolicy } from './password-policy.ts';
import { decodeRecoverySecret } from './recovery-secret.ts';
import { SETUP_CAPABILITY_TTL_MS, verifySetupCapability } from './setup-capability.mjs';

const OWNER_SETUP_TTL_MS = 24 * 60 * 60 * 1_000;

export interface CompletePasswordOwnerSetupInput {
  recoveryToken: string;
  email: string;
  password: string;
  /** Accepted for source compatibility; fresh setup always creates Chickpea. */
  organizationName?: string;
  canonicalOrigin: string;
}

export interface CompletePasswordOwnerSetupResult {
  operationId: string;
  userId: string;
  organizationId: string;
  membershipId: string;
  headers: Headers;
}

export type PasswordOwnerSetupReadiness =
  | { state: 'fresh'; control: AuthControl }
  | {
      state: 'orphaned';
      control: AuthControl;
      orphanedOrganizationId: string;
      authorityPresent: boolean;
    }
  | { state: 'configured'; control: AuthControl }
  | { state: 'inconsistent'; control: AuthControl };

export interface PasswordOwnerSetupAuthoritySnapshot {
  control: AuthControl;
  legacyOrganization: Organization | undefined;
}

/**
 * Classifies the split Chickpea/Better Auth authority without changing either
 * store. Orphan recovery is intentionally narrower than "organization not
 * found": Better Auth must be empty or exactly match one pending recovery
 * operation bound to the unchanged orphaned control.
 */
export async function resolvePasswordOwnerSetupReadiness(
  identity: IdentityStore,
  environment: BetterAuthEnvironment,
  canonicalOrigin: string,
  snapshot?: PasswordOwnerSetupAuthoritySnapshot,
): Promise<PasswordOwnerSetupReadiness> {
  const origin = requireSupportedOrigin(canonicalOrigin);
  const [control, legacyOrganization] = snapshot
    ? [snapshot.control, snapshot.legacyOrganization]
    : await Promise.all([
        identity.ensureAuthControl(),
        identity.getOrganization(),
      ]);
  if (legacyOrganization) return { state: 'inconsistent', control };
  if (control.authMode === 'unconfigured') {
    return control.canonicalAdminOrigin === null && control.betterAuthOrganizationId === null
      ? { state: 'fresh', control }
      : { state: 'inconsistent', control };
  }
  if (control.authMode !== 'password_active' ||
      !control.canonicalAdminOrigin ||
      !control.betterAuthOrganizationId ||
      control.canonicalAdminOrigin !== origin ||
      environment.baseURL !== origin) {
    return { state: 'inconsistent', control };
  }
  const organization = await environment.backend.getOrganization(control.betterAuthOrganizationId);
  if (organization) return { state: 'configured', control };
  const authorityPresent = await environment.backend.hasIdentityAuthority();
  if (authorityPresent) {
    const pending = await identity.listAuthOperations(
      'owner_setup',
      control.betterAuthOrganizationId,
    );
    for (const operation of pending) {
      if (orphanOperationBoundToControl(operation, control) &&
          await ownerSetupAuthorityMatches(environment, operation)) {
        return {
          state: 'orphaned',
          control,
          orphanedOrganizationId: control.betterAuthOrganizationId,
          authorityPresent,
        };
      }
    }
    return { state: 'inconsistent', control };
  }
  return {
    state: 'orphaned',
    control,
    orphanedOrganizationId: control.betterAuthOrganizationId,
    authorityPresent,
  };
}

/** Trusted, recovery-gated wrapper around Better Auth's otherwise dark signup path. */
export class PasswordOwnerSetupService {
  constructor(
    private readonly identity: IdentityStore,
    private readonly environment: BetterAuthEnvironment,
    private readonly now: () => number = Date.now,
    private readonly setupCapability?: { digest: string; issuedAt: number },
    private readonly beginOnboarding: () => Promise<void> = async () => {},
  ) {}

  async complete(input: CompletePasswordOwnerSetupInput): Promise<CompletePasswordOwnerSetupResult> {
    const initialCapabilityHash = this.setupCapability
      ? await verifiedSetupCapabilityHash(input.recoveryToken, this.setupCapability, this.now)
      : ownerSetupCapabilityHash(
          requireMatchingRecoverySecret(input.recoveryToken, this.environment.recoveryToken),
          normalizeSetupEmail(input.email),
          requireSupportedOrigin(input.canonicalOrigin),
        );
    const canonicalOrigin = requireSupportedOrigin(input.canonicalOrigin);
    if (canonicalOrigin !== this.environment.baseURL) throw new AuthDeniedError();
    const organizationName = 'Chickpea';
    const email = normalizeSetupEmail(input.email);
    const displayName = displayNameFromEmail(email);
    assertPasswordPolicy(input.password, { email, organizationName });

    const readiness = await resolvePasswordOwnerSetupReadiness(
      this.identity,
      this.environment,
      canonicalOrigin,
    );
    if (readiness.state !== 'fresh' && readiness.state !== 'orphaned') {
      throw new AuthDeniedError();
    }
    const control = readiness.control;
    const capabilityHash = readiness.state === 'orphaned'
      ? orphanedOwnerSetupCapabilityHash(
          initialCapabilityHash,
          control,
          readiness.orphanedOrganizationId,
        )
      : initialCapabilityHash;
    let operation = await this.identity.findAuthOperation('owner_setup', capabilityHash);
    if (readiness.state === 'orphaned') {
      const pendingRecoveryOperations = (await this.identity.listAuthOperations(
        'owner_setup',
        readiness.orphanedOrganizationId,
      )).filter((candidate) => candidate.status === 'pending');
      if (operation) {
        if (!orphanOperationBoundToControl(operation, control)) throw new AuthDeniedError();
        const operationId = operation.id;
        if (pendingRecoveryOperations.some((candidate) => candidate.id !== operationId)) {
          throw new AuthDeniedError();
        }
      }
      if (!operation && (readiness.authorityPresent || pendingRecoveryOperations.length > 0)) {
        throw new AuthDeniedError();
      }
    }
    operation ??= await this.identity.createAuthOperation({
      kind: 'owner_setup',
      ...(readiness.state === 'orphaned'
        ? {
            organizationId: readiness.orphanedOrganizationId,
            targetCredentialVersion: control.revision,
          }
        : {}),
      expectedEmail: email,
      capabilityHash,
      expiresAt: this.setupCapability
        ? this.setupCapability.issuedAt + SETUP_CAPABILITY_TTL_MS
        : this.now() + OWNER_SETUP_TTL_MS,
    });
    if (operation.expectedNormalizedEmail !== email || operation.status !== 'pending') {
      throw new AuthDeniedError();
    }
    if (readiness.state === 'orphaned') {
      const pendingRecoveryOperations = (await this.identity.listAuthOperations(
        'owner_setup',
        readiness.orphanedOrganizationId,
      )).filter((candidate) => candidate.status === 'pending');
      if (pendingRecoveryOperations.length !== 1 ||
          pendingRecoveryOperations[0]?.id !== operation.id) throw new AuthDeniedError();
      await requireMatchingOwnerSetupAuthority(this.environment, operation);
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
        const memberships = await this.environment.backend.listMembershipsForUser(existing.id);
        if (existing.createdAt >= operation.createdAt && memberships.length === 0) {
          await replacePrivateCredential(auth, this.environment, existing.id, input.password);
        } else {
          await verifyPasswordWithPrivateSession(auth, email, input.password);
        }
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
    if (readiness.state === 'orphaned') {
      await requireMatchingOwnerSetupAuthority(this.environment, operation);
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
    if (readiness.state === 'orphaned') {
      await requireMatchingOwnerSetupAuthority(this.environment, operation);
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

    // Seed the resumable product journey before releasing owner authority. A
    // retry can safely observe the same record if the final control write is
    // interrupted, while the owner can never be activated without a journey.
    await this.beginOnboarding();
    // Establish the owner's first usable session before releasing Chickpea's
    // authority boundary. If a new Cloudflare Durable Object is briefly
    // unavailable during password verification, the setup operation remains
    // pending and the same private link can resume it safely.
    const login = await auth.api.signInEmail({
      body: { email, password: input.password },
      returnHeaders: true,
    });
    if (readiness.state === 'orphaned') {
      await requireMatchingOwnerSetupAuthority(this.environment, operation);
    }
    await this.identity.completePasswordSetup({
      operationId: operation.id,
      capabilityHash,
      expectedStep: 2,
      expectedControlRevision: control.revision,
      expectedControlAuthMode: readiness.state === 'fresh' ? 'unconfigured' : 'password_active',
      expectedBetterAuthOrganizationId: readiness.state === 'fresh'
        ? null
        : readiness.orphanedOrganizationId,
      canonicalAdminOrigin: canonicalOrigin,
      betterAuthOrganizationId: completedOrganizationId,
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

function orphanOperationBoundToControl(
  operation: AuthOperation,
  control: AuthControl,
): boolean {
  return operation.kind === 'owner_setup' && operation.status === 'pending' &&
    operation.organizationId === control.betterAuthOrganizationId &&
    operation.targetCredentialVersion === control.revision;
}

async function ownerSetupAuthorityMatches(
  environment: BetterAuthEnvironment,
  operation: AuthOperation,
): Promise<boolean> {
  if (operation.step === 0) {
    if (operation.betterAuthUserId || operation.betterAuthOrganizationId ||
        operation.betterAuthMembershipId) return false;
  } else if (operation.step === 1) {
    if (!operation.betterAuthUserId || operation.betterAuthOrganizationId ||
        operation.betterAuthMembershipId) return false;
  } else if (operation.step === 2) {
    if (!operation.betterAuthUserId || !operation.betterAuthOrganizationId ||
        !operation.betterAuthMembershipId) return false;
  } else {
    return false;
  }
  return environment.backend.matchesOwnerSetupAuthority({
    expectedEmail: operation.expectedNormalizedEmail,
    operationCreatedAt: operation.createdAt,
    step: operation.step,
    betterAuthUserId: operation.betterAuthUserId,
    betterAuthOrganizationId: operation.betterAuthOrganizationId,
    betterAuthMembershipId: operation.betterAuthMembershipId,
  });
}

async function requireMatchingOwnerSetupAuthority(
  environment: BetterAuthEnvironment,
  operation: AuthOperation,
): Promise<void> {
  if (!await ownerSetupAuthorityMatches(environment, operation)) {
    throw new AuthDeniedError();
  }
}

function orphanedOwnerSetupCapabilityHash(
  capabilityHash: string,
  control: AuthControl,
  orphanedOrganizationId: string,
): string {
  return createHash('sha256')
    .update('chickpea/orphaned-owner-setup/v1\0')
    .update(capabilityHash)
    .update('\0')
    .update(control.installationId)
    .update('\0')
    .update(String(control.revision))
    .update('\0')
    .update(orphanedOrganizationId)
    .digest('hex');
}

async function verifiedSetupCapabilityHash(
  capability: string,
  expected: { digest: string; issuedAt: number },
  now: () => number,
): Promise<string> {
  if (!await verifySetupCapability({
    capability,
    digest: expected.digest,
    issuedAt: expected.issuedAt,
    now,
  })) throw new AuthDeniedError();
  return createHash('sha256').update(capability).digest('hex');
}

function normalizeSetupEmail(value: string): string {
  const email = value.trim().normalize('NFKC').toLowerCase();
  if (email.length < 3 || email.length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthDeniedError();
  return email;
}

function displayNameFromEmail(email: string): string {
  const local = (email.split('@', 1)[0] ?? '').split('+', 1)[0] ?? '';
  const words = local.normalize('NFKC').split(/[._-]+/u).filter(Boolean);
  const displayName = words.map((word) => {
    const [first = '', ...rest] = Array.from(word);
    return first.toLocaleUpperCase() + rest.join('');
  }).join(' ');
  return boundedHumanText(displayName || 'Owner', 'displayName');
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

async function replacePrivateCredential(
  auth: ReturnType<typeof createBetterAuth>,
  environment: BetterAuthEnvironment,
  userId: string,
  password: string,
): Promise<void> {
  const context = await auth.$context;
  const account = (await context.internalAdapter.findAccounts(userId)).find(
    (candidate) => candidate.providerId === 'credential' && candidate.password,
  );
  if (!account) throw new AuthDeniedError();
  const verifier = await environment.password.hash(password);
  await context.internalAdapter.updateAccount(account.id, { password: verifier });
  await context.internalAdapter.deleteUserSessions(userId);
}

function bounded(value: string, label: string): string {
  const result = value.trim();
  if (!result || result.length > 1_024 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error(`${label} is invalid.`);
  }
  return result;
}
