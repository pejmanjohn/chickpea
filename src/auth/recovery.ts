import { createHash, randomBytes } from 'node:crypto';

import type { AuthProviderConfig, IdentityStore } from '../identity/types.ts';
import { createBetterAuth } from './better-auth.ts';
import type { BetterAuthEnvironment } from './better-auth-environment.ts';
import { assertPasswordPolicy } from './password-policy.ts';
import { AuthDeniedError } from './service.ts';
import {
  constantCredentialEquals,
  requireMatchingRecoverySecret,
  validRecoveryToken,
} from './setup.ts';
import type { ExternalIdentity } from './types.ts';

interface AuthRecoveryOptions {
  recoveryToken: string;
}

export class PasswordOwnerRecoveryService {
  constructor(
    private readonly identityStore: IdentityStore,
    private readonly environment: BetterAuthEnvironment,
    private readonly now: () => number = Date.now,
  ) {}

  async replacePassword(input: {
    recoveryToken: string;
    email: string;
    newPassword: string;
  }): Promise<void> {
    requireMatchingRecoverySecret(input.recoveryToken, this.environment.recoveryToken);
    const control = await this.identityStore.getAuthControl();
    if (control?.authMode !== 'password_active' ||
        !control.betterAuthOrganizationId ||
        control.canonicalAdminOrigin !== this.environment.baseURL) throw new AuthDeniedError();
    const email = input.email.trim().normalize('NFKC').toLowerCase();
    const user = await this.environment.backend.findUserByEmail(email);
    if (!user) throw new AuthDeniedError();
    const membership = await this.environment.backend.getMembershipForUser(
      user.id,
      control.betterAuthOrganizationId,
    );
    if (!membership || membership.role !== 'owner') throw new AuthDeniedError();
    const organization = await this.environment.backend.getOrganization(
      control.betterAuthOrganizationId,
    );
    assertPasswordPolicy(input.newPassword, {
      email,
      ...(organization ? { organizationName: organization.name } : {}),
    });

    const capabilityHash = createHash('sha256').update(randomBytes(32)).digest('hex');
    const operation = await this.identityStore.createAuthOperation({
      kind: 'owner_recovery',
      organizationId: control.betterAuthOrganizationId,
      expectedEmail: email,
      capabilityHash,
      expiresAt: this.now() + 15 * 60_000,
    });
    const auth = createBetterAuth({ ...this.environment, allowSignUp: false });
    const context = await auth.$context;
    const account = (await context.internalAdapter.findAccounts(user.id)).find(
      (candidate) => candidate.providerId === 'credential' && candidate.password,
    );
    if (!account) throw new AuthDeniedError();
    const verifier = await this.environment.password.hash(input.newPassword);
    await context.internalAdapter.updateAccount(account.id, { password: verifier });
    await context.internalAdapter.deleteUserSessions(user.id);
    const advanced = await this.identityStore.advanceAuthOperation({
      operationId: operation.id,
      capabilityHash,
      step: 1,
      betterAuthUserId: user.id,
      betterAuthOrganizationId: control.betterAuthOrganizationId,
      betterAuthMembershipId: membership.id,
    });
    await this.identityStore.consumeAuthOperation({
      operationId: advanced.id,
      capabilityHash,
      expectedStep: 1,
    });
    const tokens = (await this.identityStore.exportSummary()).personalTokens
      .filter((token) => token.userId === user.id && token.status === 'active');
    await Promise.all(tokens.map((token) => this.identityStore.revokePersonalToken(token.id)));
  }
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
