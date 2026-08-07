import type { AuthProviderConfig, IdentityStore } from '../identity/types.ts';
import { AuthDeniedError } from './service.ts';
import { constantCredentialEquals, validRecoveryToken } from './setup.ts';
import type { ExternalIdentity } from './types.ts';

interface AuthRecoveryOptions {
  recoveryToken: string;
}

export class AuthRecoveryService {
  private readonly recoveryToken: string;

  constructor(
    private readonly identityStore: IdentityStore,
    options: AuthRecoveryOptions,
  ) {
    this.recoveryToken = validRecoveryToken(options.recoveryToken);
  }

  async repairAudience(input: {
    recoveryToken: string;
    identity: ExternalIdentity;
    audience: string;
  }): Promise<AuthProviderConfig> {
    if (!constantCredentialEquals(input.recoveryToken, this.recoveryToken)) throw new AuthDeniedError();
    const organization = await this.identityStore.getOrganization();
    const config = await this.identityStore.getAuthProviderConfig('cloudflare_access');
    if (!organization || organization.authMode !== 'access_active' || !config ||
        config.state !== 'active' || !config.issuer || input.identity.provider !== 'cloudflare_access' ||
        input.identity.issuer !== config.issuer) {
      throw new AuthDeniedError();
    }
    const resolution = await this.identityStore.resolveExternalIdentity(
      input.identity.provider,
      input.identity.issuer,
      input.identity.subject,
      organization.id,
    );
    if (!resolution || resolution.membership.role !== 'owner' ||
        resolution.membership.status !== 'active') {
      throw new AuthDeniedError();
    }
    return this.identityStore.updateAuthProviderAudience(
      'cloudflare_access',
      input.audience,
      resolution.membership.id,
    );
  }

  async replaceOwnerBinding(input: {
    recoveryToken: string;
    identity: ExternalIdentity;
  }) {
    if (!constantCredentialEquals(input.recoveryToken, this.recoveryToken)) throw new AuthDeniedError();
    const organization = await this.identityStore.getOrganization();
    const config = await this.identityStore.getAuthProviderConfig('cloudflare_access');
    if (!organization || organization.authMode !== 'access_active' || !config ||
        config.state !== 'active' || !config.issuer || input.identity.provider !== 'cloudflare_access' ||
        input.identity.issuer !== config.issuer) {
      throw new AuthDeniedError();
    }
    try {
      return await this.identityStore.replaceAccessOwnerBinding({
        organizationId: organization.id,
        provider: input.identity.provider,
        issuer: input.identity.issuer,
        subject: input.identity.subject,
        verifiedEmail: input.identity.verifiedEmail,
        ...(input.identity.displayName === undefined ? {} : { displayName: input.identity.displayName }),
      });
    } catch {
      throw new AuthDeniedError();
    }
  }
}
