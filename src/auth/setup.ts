import { timingSafeEqual } from 'node:crypto';

import type { IdentityResolution, IdentityStore } from '../identity/types.ts';
import { normalizeCloudflareAccessIssuer } from './cloudflare-access.ts';
import { AuthDeniedError } from './service.ts';
import type { ExternalIdentity } from './types.ts';

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

function bounded(value: string, label: string): string {
  const result = value.trim();
  if (!result || result.length > 1_024 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error(`${label} is invalid.`);
  }
  return result;
}
