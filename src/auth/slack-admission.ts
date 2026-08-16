import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';

import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../config/types.ts';
import type {
  AuthOperation,
  IdentityStore,
  SlackOidcAttempt,
  SlackOidcPurpose,
} from '../identity/types.ts';
import {
  resolveSlackControlPlaneAppCredentials,
  type SlackCredentialDependencies,
} from '../slack/identity-credentials.ts';
import { safeSetupDestination } from './setup-handoff.ts';
import {
  createBetterAuth,
  type BetterAuthAdmissionOperation,
  type BetterAuthPrivateSeam,
} from './better-auth.ts';
import type { BetterAuthEnvironment } from './better-auth-environment.ts';
import {
  SlackOidcError,
  SlackOidcGateway,
  type SlackOidcGatewayDependencies,
} from './slack-oidc.ts';

export const SLACK_OIDC_ATTEMPT_TTL_MS = 15 * 60_000;
export const SLACK_OIDC_PROCESSING_LEASE_MS = 10 * 60_000;

export interface SlackAdmissionDependencies {
  identity: IdentityStore;
  credentials: SlackCredentialDependencies;
  environment: BetterAuthEnvironment;
  gateway?: SlackOidcGateway;
  fetch?: typeof fetch;
  jwks?: SlackOidcGatewayDependencies['jwks'];
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}

export interface SlackAdmissionStartResult {
  attemptId: string;
  state: string;
  nonce: string;
  expiresAt: number;
  authorizationUrl: string;
}

export interface SlackAdmissionCallbackResult {
  destination: string;
  sessionResponse: Response;
}

export class SlackAdmissionService {
  private readonly now: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly gateway: SlackOidcGateway;

  constructor(private readonly dependencies: SlackAdmissionDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.randomBytes = dependencies.randomBytes ?? ((length) => nodeRandomBytes(length));
    this.gateway = dependencies.gateway ?? new SlackOidcGateway({
      credentials: dependencies.credentials,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      ...(dependencies.jwks ? { jwks: dependencies.jwks } : {}),
      now: this.now,
    });
  }

  async startFirstOwner(input: {
    setupId: string;
    expectedSetupRevision: number;
    browserBinding: string;
    redirectUri: string;
    destination?: string;
  }): Promise<SlackAdmissionStartResult> {
    requireBrowserBinding(input.browserBinding);
    const setup = await this.dependencies.identity.getSlackSetupTransaction(input.setupId);
    if (!setup || setup.state !== 'bot_installed' || setup.revision !== input.expectedSetupRevision ||
        !setup.appId || !setup.botCredentialRevision || !setup.slackTeamId ||
        !setup.installerSlackUserId) {
      throw new SlackOidcError('stale_revision');
    }
    const credentials = await this.requiredCredentials();
    if (credentials.appId !== setup.appId || credentials.teamId !== setup.slackTeamId ||
        credentials.connectionRevision !== setup.botCredentialRevision) {
      throw new SlackOidcError('stale_revision');
    }
    const now = this.now();
    const expiresAt = Math.min(now + SLACK_OIDC_ATTEMPT_TTL_MS, setup.expiresAt);
    if (expiresAt <= now) throw new SlackOidcError('expired_state');
    return this.createAttempt({
      purpose: 'first_owner',
      setupId: setup.id,
      setupRevision: setup.revision,
      operationId: `authop_${randomSecret(this.randomBytes, 18)}`,
      browserBinding: input.browserBinding,
      redirectUri: input.redirectUri,
      destination: safeSetupDestination(input.destination),
      teamId: setup.slackTeamId,
      userId: setup.installerSlackUserId,
      appId: credentials.appId,
      clientId: credentials.clientId,
      credentialRevision: credentials.connectionRevision,
      expiresAt,
    });
  }

  async startLogin(input: {
    browserBinding: string;
    redirectUri: string;
    destination?: string;
  }): Promise<SlackAdmissionStartResult> {
    requireBrowserBinding(input.browserBinding);
    const [organization, control, credentials] = await Promise.all([
      this.dependencies.identity.getOrganization(),
      this.dependencies.identity.getAuthControl(),
      this.requiredCredentials(),
    ]);
    if (!organization?.slackTeamId || organization.authMode !== 'slack_active' ||
        control?.authMode !== 'slack_active' || control.healthGate !== 'normal' ||
        credentials.teamId !== organization.slackTeamId) {
      throw new SlackOidcError('stale_revision');
    }
    const expiresAt = this.now() + SLACK_OIDC_ATTEMPT_TTL_MS;
    return this.createAttempt({
      purpose: 'login',
      browserBinding: input.browserBinding,
      redirectUri: input.redirectUri,
      destination: safeSetupDestination(input.destination),
      teamId: organization.slackTeamId,
      appId: credentials.appId,
      clientId: credentials.clientId,
      credentialRevision: credentials.connectionRevision,
      expiresAt,
    });
  }

  async callback(input: {
    purpose: SlackOidcPurpose;
    state: string;
    nonce: string;
    browserBinding: string;
    redirectUri: string;
    request: Request;
    code?: string;
    error?: string;
  }): Promise<SlackAdmissionCallbackResult> {
    requireBrowserBinding(input.browserBinding);
    if (input.state.length < 32 || input.state.length > 512 || /\s/.test(input.state)) {
      throw new SlackOidcError('invalid_state');
    }
    let attempt = await this.acquireAttempt(input);
    if (attempt.status === 'succeeded') {
      return this.issueExistingSession(attempt, input.request);
    }
    if (attempt.status === 'admitted') {
      return this.resumeAdmitted(attempt, input.state, input.request);
    }
    if (input.error) {
      await this.dependencies.identity.settleSlackOidcAttempt({
        attemptId: attempt.id,
        expectedLeaseGeneration: attempt.leaseGeneration,
        status: 'denied',
        resultCode: 'provider_denied',
      });
      throw new SlackOidcError('provider_denied');
    }
    if (!input.code) {
      await this.fail(attempt, 'invalid_response');
      throw new SlackOidcError('invalid_response');
    }
    let proof;
    try {
      proof = await this.gateway.exchangeAndVerify({
        attempt,
        code: input.code,
        nonce: input.nonce,
      });
    } catch (error) {
      if (error instanceof SlackOidcError && error.code === 'slack_unreachable') throw error;
      await this.fail(attempt, error instanceof SlackOidcError ? error.code : 'invalid_response');
      throw error;
    }
    let operation: AuthOperation;
    try {
      operation = await this.dependencies.identity.admitSlackOidcAttempt({
        attemptId: attempt.id,
        expectedLeaseGeneration: attempt.leaseGeneration,
        capabilityHash: hashSecret(input.state),
        slackTeamId: proof.slackTeamId,
        slackUserId: proof.slackUserId,
        expiresAt: attempt.expiresAt,
      });
      attempt = (await this.dependencies.identity.getSlackOidcAttempt(attempt.id))!;
    } catch {
      await this.fail(attempt, 'admission_denied').catch(() => {});
      throw new SlackOidcError('user_mismatch');
    }
    if (attempt.purpose !== 'first_owner') {
      await this.dependencies.identity.settleSlackOidcAttempt({
        attemptId: attempt.id,
        expectedLeaseGeneration: attempt.leaseGeneration,
        status: 'succeeded',
        resultCode: 'identity_active',
      });
      return this.issueSession(operation.id, attempt.destination, input.request);
    }

    const organization = await this.dependencies.identity.ensureOrganization({
      displayName: 'Chickpea',
      slackTeamId: proof.slackTeamId,
    });
    const auth = this.createAuth();
    const reconciled = await auth.chickpea.reconcileSlackIdentity({
      slackTeamId: proof.slackTeamId,
      slackUserId: proof.slackUserId,
      displayName: proof.displayName,
      organization: {
        name: organization.displayName,
        slug: `chickpea-${proof.slackTeamId.toLowerCase()}`,
      },
      ...(operation.betterAuthUserId ? { expectedUserId: operation.betterAuthUserId } : {}),
    });
    await this.dependencies.identity.advanceAuthOperation({
      operationId: operation.id,
      capabilityHash: hashSecret(input.state),
      step: Math.max(1, operation.step + 1),
      betterAuthUserId: reconciled.userId,
      betterAuthOrganizationId: reconciled.organizationId,
      betterAuthMembershipId: reconciled.membershipId,
    });
    await this.dependencies.identity.activateFirstOwner({
      operationId: operation.id,
      organizationId: organization.id,
      slackTeamId: proof.slackTeamId,
      slackUserId: proof.slackUserId,
      displayName: proof.displayName,
      betterAuthUserId: reconciled.userId,
      betterAuthMembershipId: reconciled.membershipId,
      setupId: attempt.setupId!,
      expectedSetupRevision: attempt.setupRevision!,
      oidcAttemptId: attempt.id,
      expectedOidcLeaseGeneration: attempt.leaseGeneration,
    });
    // Chickpea authority is active before the browser receives any session.
    return this.issueSession(operation.id, attempt.destination, input.request);
  }

  private async createAttempt(input: {
    purpose: SlackOidcPurpose;
    operationId?: string;
    setupId?: string;
    setupRevision?: number;
    browserBinding: string;
    redirectUri: string;
    destination: string;
    teamId: string;
    userId?: string;
    appId: string;
    clientId: string;
    credentialRevision: string;
    expiresAt: number;
  }): Promise<SlackAdmissionStartResult> {
    const state = randomSecret(this.randomBytes, 32);
    const nonce = randomSecret(this.randomBytes, 32);
    const attemptId = `slackoidc_${randomSecret(this.randomBytes, 18)}`;
    await this.dependencies.identity.createSlackOidcAttempt({
      id: attemptId,
      purpose: input.purpose,
      ...(input.operationId ? { operationId: input.operationId } : {}),
      ...(input.setupId ? { setupId: input.setupId } : {}),
      ...(input.setupRevision ? { setupRevision: input.setupRevision } : {}),
      stateHash: hashSecret(state),
      nonceHash: hashSecret(nonce),
      browserHash: hashSecret(input.browserBinding),
      appId: input.appId,
      clientId: input.clientId,
      credentialRevision: input.credentialRevision,
      redirectUri: input.redirectUri,
      destination: input.destination,
      expectedTeamId: input.teamId,
      ...(input.userId ? { expectedSlackUserId: input.userId } : {}),
      expiresAt: input.expiresAt,
    });
    return {
      attemptId,
      state,
      nonce,
      expiresAt: input.expiresAt,
      authorizationUrl: this.gateway.authorizationUrl({
        clientId: input.clientId,
        redirectUri: input.redirectUri,
        state,
        nonce,
        teamId: input.teamId,
      }),
    };
  }

  private async acquireAttempt(input: {
    purpose: SlackOidcPurpose;
    state: string;
    browserBinding: string;
    redirectUri: string;
  }): Promise<SlackOidcAttempt> {
    try {
      return await this.dependencies.identity.acquireSlackOidcAttempt({
        stateHash: hashSecret(input.state),
        browserHash: hashSecret(input.browserBinding),
        purpose: input.purpose,
        redirectUri: input.redirectUri,
        leaseExpiresAt: this.now() + SLACK_OIDC_PROCESSING_LEASE_MS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/expired/i.test(message)) throw new SlackOidcError('expired_state');
      if (/lease/i.test(message)) throw new SlackOidcError('processing');
      if (/browser/i.test(message)) throw new SlackOidcError('wrong_browser');
      throw new SlackOidcError('invalid_state');
    }
  }

  private async resumeAdmitted(
    attempt: SlackOidcAttempt,
    capabilitySecret: string,
    request: Request,
  ): Promise<SlackAdmissionCallbackResult> {
    if (!attempt.operationId || !attempt.admittedTeamId || !attempt.admittedSlackUserId) {
      throw new SlackOidcError('invalid_state');
    }
    if (attempt.purpose !== 'first_owner') {
      await this.dependencies.identity.settleSlackOidcAttempt({
        attemptId: attempt.id,
        expectedLeaseGeneration: attempt.leaseGeneration,
        status: 'succeeded',
        resultCode: 'identity_active',
      });
      return this.issueSession(attempt.operationId, attempt.destination, request);
    }
    let operation = await this.dependencies.identity.getAuthOperation(attempt.operationId);
    if (!operation) throw new SlackOidcError('invalid_state');
    if (operation.status === 'active') return this.issueSession(operation.id, attempt.destination, request);
    if (!operation.betterAuthUserId || !operation.betterAuthOrganizationId ||
        !operation.betterAuthMembershipId) {
      // The exchange is already durably admitted. Reconciliation is safe to
      // replay for the immutable same tuple without persisting identity tokens.
      const organization = await this.dependencies.identity.ensureOrganization({
        displayName: 'Chickpea', slackTeamId: attempt.admittedTeamId,
      });
      const auth = this.createAuth();
      const reconciled = await auth.chickpea.reconcileSlackIdentity({
        slackTeamId: attempt.admittedTeamId,
        slackUserId: attempt.admittedSlackUserId,
        displayName: 'Slack member',
        organization: {
          name: organization.displayName,
          slug: `chickpea-${attempt.admittedTeamId.toLowerCase()}`,
        },
        ...(operation.betterAuthUserId ? { expectedUserId: operation.betterAuthUserId } : {}),
      });
      operation = await this.dependencies.identity.advanceAuthOperation({
        operationId: operation.id,
        capabilityHash: hashSecret(capabilitySecret),
        step: Math.max(1, operation.step + 1),
        betterAuthUserId: reconciled.userId,
        betterAuthOrganizationId: reconciled.organizationId,
        betterAuthMembershipId: reconciled.membershipId,
      });
    }
    const organization = await this.dependencies.identity.getOrganization();
    if (!organization || !operation.betterAuthUserId || !operation.betterAuthMembershipId) {
      throw new SlackOidcError('invalid_state');
    }
    await this.dependencies.identity.activateFirstOwner({
      operationId: operation.id,
      organizationId: organization.id,
      slackTeamId: attempt.admittedTeamId,
      slackUserId: attempt.admittedSlackUserId,
      displayName: 'Slack member',
      betterAuthUserId: operation.betterAuthUserId,
      betterAuthMembershipId: operation.betterAuthMembershipId,
      setupId: attempt.setupId!,
      expectedSetupRevision: attempt.setupRevision!,
      oidcAttemptId: attempt.id,
      expectedOidcLeaseGeneration: attempt.leaseGeneration,
    });
    return this.issueSession(operation.id, attempt.destination, request);
  }

  private async issueExistingSession(
    attempt: SlackOidcAttempt,
    request: Request,
  ): Promise<SlackAdmissionCallbackResult> {
    if (!attempt.operationId) throw new SlackOidcError('invalid_state');
    return this.issueSession(attempt.operationId, attempt.destination, request);
  }

  private async issueSession(
    operationId: string,
    destination: string,
    request: Request,
  ): Promise<SlackAdmissionCallbackResult> {
    try {
      const response = await this.createAuth().chickpea.issueSession(operationId, request);
      if (!response.ok) throw new Error('session rejected');
      return { destination, sessionResponse: response };
    } catch {
      throw new SlackOidcError('session_unavailable');
    }
  }

  private createAuth() {
    return createBetterAuth({
      ...this.dependencies.environment,
      privateSeam: this.privateSeam(),
    });
  }

  private privateSeam(): BetterAuthPrivateSeam {
    return {
      resolveAdmissionOperation: async (operationId) => {
        const operation = await this.dependencies.identity.getAuthOperation(operationId);
        return activeAdmission(operation);
      },
    };
  }

  private async requiredCredentials() {
    try {
      const credentials = await resolveSlackControlPlaneAppCredentials(
        this.dependencies.credentials,
        WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      );
      if (!credentials.teamId) throw new Error();
      return credentials;
    } catch {
      throw new SlackOidcError('stale_revision');
    }
  }

  private fail(attempt: SlackOidcAttempt, resultCode: string) {
    return this.dependencies.identity.settleSlackOidcAttempt({
      attemptId: attempt.id,
      expectedLeaseGeneration: attempt.leaseGeneration,
      status: 'failed',
      resultCode,
    });
  }
}

function activeAdmission(operation: AuthOperation | undefined): BetterAuthAdmissionOperation | null {
  if (!operation || operation.status !== 'active' || !operation.chickpeaRole ||
      !operation.betterAuthUserId || !operation.betterAuthOrganizationId ||
      !operation.betterAuthMembershipId || !operation.chickpeaMembershipId) return null;
  return {
    operationId: operation.id,
    status: operation.status,
    chickpeaRole: operation.chickpeaRole,
    slackTeamId: operation.expectedSlackTeamId,
    slackUserId: operation.expectedSlackUserId,
    betterAuthUserId: operation.betterAuthUserId,
    betterAuthOrganizationId: operation.betterAuthOrganizationId,
    betterAuthMembershipId: operation.betterAuthMembershipId,
  };
}

function requireBrowserBinding(value: string): void {
  if (value.length < 32 || value.length > 512 || /\s/.test(value)) {
    throw new SlackOidcError('wrong_browser');
  }
}

function randomSecret(randomBytes: (length: number) => Uint8Array, length: number): string {
  return Buffer.from(randomBytes(length)).toString('base64url');
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
