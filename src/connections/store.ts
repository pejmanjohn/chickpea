import type { AuthPrincipal } from '../auth/types.ts';
import { canEditAgent, requirePermission, AuthorizationError } from '../auth/permissions.ts';
import {
  saveConnectionAccountSecret,
  tombstoneConnectionAccountSecret,
} from '../config/connector-secrets.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { ConfigStore } from '../config/store.ts';
import {
  AgentRevisionConflictError,
  AgentStillReferencedError,
  ConnectionAccountRevisionConflictError,
  ManagedRemoteAccountAlreadyUsedError,
} from '../config/errors.ts';
import type {
  AgentConnectionBinding,
  AgentScheduleReference,
  ConnectionAccount,
  ConnectionAccountPolicy,
  ManagedAccountResourceConstraints,
  ManagedBindingResourceConstraints,
  ManagedResourceSelection,
  McpConnectionIdentity,
} from '../config/types.ts';
import { MAX_MANAGED_RESOURCE_SELECTIONS_PER_KEY } from '../config/types.ts';
import type { ConnectionAccountView } from './types.ts';
import type {
  ManagedConnectionProviderRegistry,
  ManagedConnectionValidationResult,
} from './managed.ts';
import {
  MANAGED_CONNECTOR_CATALOG,
  type ManagedConnectorCatalog,
  intersectManagedResourceConstraints,
  projectManagedResourceHandles,
} from './catalog/index.ts';
import {
  projectEffectiveConnectionAccounts,
  projectRecoverableConnectionAccounts,
} from './runtime.ts';

export interface ConnectionAccountServiceDependencies {
  config: ConfigStore;
  settings: SettingsStore;
  managedProviders?: ManagedConnectionProviderRegistry;
  managedCatalog?: ManagedConnectorCatalog;
  randomId?: () => string;
}

export class ManagedConnectionConflictError extends Error {
  readonly name = 'ManagedConnectionConflictError';
}

export class ConnectionScheduleConflictError extends Error {
  readonly name = 'ConnectionScheduleConflictError';
}

/** Browser-safe projection shared by every Admin response carrying an account. */
export function toConnectionAccountView(account: ConnectionAccount): ConnectionAccountView {
  const { secretRefId: _secretRefId, policy, ...safeAccount } = account;
  if (policy.kind !== 'managed') {
    return {
      ...safeAccount,
      policy,
      credentialConfigured: account.lifecycle === 'ready',
    };
  }
  const {
    principalRef: _principalRef,
    accountRef: _accountRef,
    providerGeneration: _providerGeneration,
    providerLineage: _providerLineage,
    resourceConstraints,
    ...safePolicy
  } = policy;
  return {
    ...safeAccount,
    policy: {
      ...safePolicy,
      ...(resourceConstraints
        ? {
            resourceConstraints: Object.fromEntries(
              Object.entries(resourceConstraints).map(([key, selections]) => [
                key,
                selections.map(({ handle, label }) => ({ handle, label })),
              ]),
            ),
          }
        : {}),
    },
    credentialConfigured: account.lifecycle === 'ready',
  };
}

export class ManagedConnectionProviderUnavailableError extends Error {
  readonly name = 'ManagedConnectionProviderUnavailableError';

  constructor(readonly adapterId: string) {
    super(`Managed connection provider ${adapterId} is unavailable`);
  }
}

export class ManagedResourceSelectionError extends Error {
  readonly name = 'ManagedResourceSelectionError';

  constructor(readonly code: 'invalid' | 'stale' | 'unavailable', message: string) {
    super(message);
  }
}

export class ConnectionAccountService {
  constructor(private readonly dependencies: ConnectionAccountServiceDependencies) {}

  async createForAgent(input: {
    principal: AuthPrincipal;
    agentId: string;
    workspaceId: string;
    ownerKind: 'team' | 'member';
    providerId: string;
    label: string;
    purpose?: string;
    identity?: McpConnectionIdentity;
    policy: ConnectionAccountPolicy;
    credential?: string;
    allowedCapabilities?: string[];
    resourceConstraints?: ManagedBindingResourceConstraints;
  }): Promise<{ account: ConnectionAccount; binding: AgentConnectionBinding }> {
    const agent = await this.dependencies.config.getAgent(input.agentId);
    if (!canEditAgent(input.principal, agent)) throw new AuthorizationError();
    const accountInput = await this.prepareAccountCreation(input);
    const allowedCapabilities = accountInput.policy.kind === 'managed'
      ? [...(input.allowedCapabilities ?? accountInput.policy.allowedCapabilities)]
      : [...(input.allowedCapabilities ?? [])];
    const resourceConstraints = accountInput.policy.kind === 'managed'
      ? input.resourceConstraints ?? projectManagedResourceHandles(
          accountInput.policy.resourceConstraints,
        )
      : input.resourceConstraints ?? {};
    if (accountInput.policy.kind === 'managed') {
      const managedPolicy = accountInput.policy;
      const connector = this.catalog().connector(managedPolicy.toolkit);
      if (!connector || connector.providerId !== accountInput.providerId) {
        throw new Error('Managed connection connector is unavailable');
      }
      if (allowedCapabilities.some(
        (capability) => !managedPolicy.allowedCapabilities.includes(capability),
      )) {
        throw new Error('Managed connection binding exceeds the account capability ceiling');
      }
      const effectiveResources = intersectManagedResourceConstraints(
        connector,
        managedPolicy.resourceConstraints,
        resourceConstraints,
      );
      const pendingResourceSelection = Boolean(
        connector.resources?.length && Object.keys(resourceConstraints).length === 0,
      );
      if (effectiveResources === undefined && !pendingResourceSelection) {
        throw new Error('Managed connection resource selection is incomplete');
      }
      await this.assertManagedLaneAvailable({
        principal: input.principal,
        agentId: input.agentId,
        ownerKind: accountInput.ownerKind,
        adapterId: managedPolicy.adapterId,
        toolkit: managedPolicy.toolkit,
      });
    }
    let secretSaved = false;
    try {
      if (input.credential) {
        await saveConnectionAccountSecret(
          accountInput.secretRefId,
          input.credential,
          undefined,
          this.dependencies.settings,
        );
        secretSaved = true;
      }
      return await this.dependencies.config.createAgentOwnedConnection({
        account: accountInput,
        binding: {
          agentId: input.agentId,
          connectionAccountId: accountInput.id,
          providerId: accountInput.providerId,
          allowedCapabilities,
          resourceConstraints,
          enabled: true,
        },
      });
    } catch (error) {
      const setupError = error instanceof ManagedRemoteAccountAlreadyUsedError
        ? new ManagedConnectionConflictError(error.message)
        : error;
      if (secretSaved) {
        try {
          await tombstoneConnectionAccountSecret(
            accountInput.secretRefId,
            undefined,
            this.dependencies.settings,
          );
        } catch (cleanupError) {
          throw new AggregateError(
            [setupError, cleanupError],
            'Connection setup failed and its staged credential could not be removed',
          );
        }
      }
      throw setupError;
    }
  }

  async listViews(workspaceId: string): Promise<ConnectionAccountView[]> {
    const accounts = await this.dependencies.config.listConnectionAccounts(workspaceId);
    return accounts.map(toConnectionAccountView);
  }

  /** Return an account only after proving the caller owns its management lane. */
  async getForManagement(
    principal: AuthPrincipal,
    connectionAccountId: string,
  ): Promise<ConnectionAccount> {
    const account = await this.findAccount(connectionAccountId);
    this.requireManage(principal, account);
    return account;
  }

  async listManagedResources(input: {
    principal: AuthPrincipal;
    agentId: string;
    connectionAccountId: string;
    resourceKey: string;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<{
    resources: Array<{ handle: string; label: string }>;
    nextCursor?: string;
  }> {
    const { account } = await this.requireAgentOwnedAccount({
      principal: input.principal,
      agentId: input.agentId,
      connectionAccountId: input.connectionAccountId,
    });
    if (account.policy.kind !== 'managed' || account.lifecycle === 'revoked') {
      throw new ManagedResourceSelectionError('invalid', 'Managed resource selection is unavailable');
    }
    const connector = this.catalog().connector(account.policy.toolkit);
    const resource = connector?.resources?.find(({ key }) => key === input.resourceKey);
    if (!connector || connector.providerId !== account.providerId || !resource) {
      throw new ManagedResourceSelectionError('invalid', 'Managed resource key is invalid');
    }
    const page = await this.discoverManagedResources({
      policy: account.policy,
      resourceKey: resource.key,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return {
      resources: await Promise.all(page.resources.map(async ({ providerRef, label }) => ({
        handle: await managedResourceHandle(resource.key, providerRef),
        label,
      }))),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async selectManagedResources(input: {
    principal: AuthPrincipal;
    agentId: string;
    connectionAccountId: string;
    expectedRevision: number;
    resourceConstraints: ManagedBindingResourceConstraints;
    signal?: AbortSignal;
  }): Promise<{
    account: {
      id: string;
      revision: number;
      lifecycle: ConnectionAccount['lifecycle'];
      resources: Record<string, Array<{ handle: string; label: string }>>;
    };
    binding: AgentConnectionBinding;
  }> {
    const { account, binding } = await this.requireAgentOwnedAccount({
      principal: input.principal,
      agentId: input.agentId,
      connectionAccountId: input.connectionAccountId,
    });
    if (account.revision !== input.expectedRevision) {
      throw new ManagedResourceSelectionError('stale', 'Managed connection changed');
    }
    if (account.policy.kind !== 'managed' || account.lifecycle === 'revoked') {
      throw new ManagedResourceSelectionError('invalid', 'Managed resource selection is unavailable');
    }
    const connector = this.catalog().connector(account.policy.toolkit);
    if (!connector || connector.providerId !== account.providerId || !connector.resources?.length) {
      throw new ManagedResourceSelectionError('invalid', 'Managed resource selection is unavailable');
    }
    const definitionsByKey = new Map(connector.resources.map((resource) => [resource.key, resource]));
    if (Object.keys(input.resourceConstraints).some((key) => !definitionsByKey.has(key))) {
      throw new ManagedResourceSelectionError('invalid', 'Managed resource key is invalid');
    }
    // One account belongs to one Agent, so the submitted selection replaces
    // both the account ceiling and its binding constraint. Removed resources
    // must not survive in a ceiling that no sibling Agent can legitimately use.
    const accountConstraints: ManagedAccountResourceConstraints = {};
    let bindingSelectionComplete = true;
    for (const resource of connector.resources) {
      const requestedHandles = input.resourceConstraints[resource.key] ?? [];
      if (!resource.multiple && requestedHandles.length > 1) {
        throw new ManagedResourceSelectionError('invalid', 'Managed resource selection is invalid');
      }
      if (resource.required && requestedHandles.length === 0) bindingSelectionComplete = false;
      if (requestedHandles.length === 0) continue;
      const discovered = await this.discoverAllManagedResources({
        policy: account.policy,
        resourceKey: resource.key,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const byHandle = new Map<string, ManagedResourceSelection>();
      for (const item of discovered) {
        const handle = await managedResourceHandle(resource.key, item.providerRef);
        byHandle.set(handle, {
          handle,
          providerRef: item.providerRef,
          label: item.label,
          ...(item.currencyCode ? { currencyCode: item.currencyCode } : {}),
        });
      }
      const selected = requestedHandles.map((handle) => byHandle.get(handle));
      if (selected.some((item) => !item) || new Set(requestedHandles).size !== requestedHandles.length) {
        throw new ManagedResourceSelectionError('invalid', 'Managed resource is not available');
      }
      const selections = selected as ManagedResourceSelection[];
      if (selections.length > MAX_MANAGED_RESOURCE_SELECTIONS_PER_KEY) {
        throw new ManagedResourceSelectionError(
          'invalid',
          `This connected account can grant at most ${MAX_MANAGED_RESOURCE_SELECTIONS_PER_KEY} ` +
            `${resource.label.toLowerCase()}. Connect a separate account for additional resources.`,
        );
      }
      accountConstraints[resource.key] = selections;
    }
    const effective = intersectManagedResourceConstraints(
      connector,
      accountConstraints,
      input.resourceConstraints,
    );
    if (bindingSelectionComplete && effective === undefined) {
      throw new ManagedResourceSelectionError('invalid', 'Managed resource selection is invalid');
    }
    let policy: Extract<ConnectionAccountPolicy, { kind: 'managed' }> = {
      ...account.policy,
      resourceConstraints: accountConstraints,
    };
    const accountSelectionComplete = connector.resources.every((resource) =>
      !resource.required || (accountConstraints[resource.key]?.length ?? 0) > 0
    );
    if (accountSelectionComplete) {
      const provider = this.dependencies.managedProviders?.get(policy.adapterId);
      if (!provider) throw new ManagedResourceSelectionError(
        'unavailable',
        'Managed connection provider is unavailable',
      );
      policy = applyManagedValidation(
        policy,
        await provider.validate({ policy, ...(input.signal ? { signal: input.signal } : {}) }),
      );
    }
    const lifecycle = account.lifecycle === 'needs_attention'
      ? account.lifecycle
      : accountSelectionComplete ? 'ready' as const : 'pending' as const;
    const updatedAccount = await this.dependencies.config.putConnectionAccount(
      { ...account, policy, lifecycle },
      input.expectedRevision,
    );
    const updatedBinding = await this.dependencies.config.putAgentConnectionBinding({
      ...binding,
      resourceConstraints: input.resourceConstraints,
    });
    if (updatedAccount.lifecycle === 'ready') {
      try {
        await resumeDependentSchedules(this.dependencies.config, updatedAccount.id);
      } catch {
        console.warn(JSON.stringify({
          event: 'chickpea.managed_connection.schedule_resume_deferred',
          connectionAccountId: updatedAccount.id,
        }));
      }
    }
    return {
      account: {
        id: updatedAccount.id,
        revision: updatedAccount.revision,
        lifecycle: updatedAccount.lifecycle,
        resources: Object.fromEntries(Object.entries(accountConstraints).map(([key, selections]) => [
          key,
          selections.map(({ handle, label }) => ({ handle, label })),
        ])),
      },
      binding: updatedBinding,
    };
  }

  /** Preflight the one-Team/one-Personal lane invariant before remote import. */
  async assertManagedLaneAvailable(input: {
    principal: AuthPrincipal;
    agentId: string;
    ownerKind: 'team' | 'member';
    adapterId: string;
    toolkit: string;
  }): Promise<void> {
    const agent = await this.dependencies.config.getAgent(input.agentId);
    if (!canEditAgent(input.principal, agent)) throw new AuthorizationError();
    const normalizedAdapterId = input.adapterId.trim().toLowerCase();
    const siblingBindings = await this.dependencies.config.listAgentConnectionBindings(
      input.agentId,
    );
    for (const siblingBinding of siblingBindings) {
      if (!siblingBinding.enabled) continue;
      const sibling = await this.findAccount(siblingBinding.connectionAccountId);
      if (
        sibling.lifecycle !== 'revoked' &&
        sibling.ownerKind === input.ownerKind &&
        (input.ownerKind === 'team' ||
          sibling.ownerMembershipId === input.principal.membershipId) &&
        sibling.policy.kind === 'managed' &&
        sibling.policy.adapterId.trim().toLowerCase() === normalizedAdapterId &&
        sibling.policy.toolkit === input.toolkit
      ) {
        throw new ManagedConnectionConflictError(
          'This Agent already has a managed connection for that owner and toolkit',
        );
      }
    }
  }

  async revoke(input: {
    principal: AuthPrincipal;
    connectionAccountId: string;
  }): Promise<ConnectionAccount> {
    const account = await this.findAccount(input.connectionAccountId);
    this.requireManage(input.principal, account);
    return this.revokeOwnedAccount(account);
  }

  private async revokeOwnedAccount(account: ConnectionAccount): Promise<ConnectionAccount> {
    if (account.lifecycle === 'revoked') {
      try {
        await retireConnectionFromDependentSchedules(
          this.dependencies.config,
          account.id,
          undefined,
          undefined,
          true,
        );
      } catch {
        throw new ConnectionScheduleConflictError(
          'The connection is disconnected, but dependent schedules changed. Retry to finish cleanup.',
        );
      }
      return account;
    }

    // Pause dependents before making the account unavailable. If secret
    // deletion fails, needs_attention remains a fail-closed intermediate state.
    const scheduleIndex = await buildConnectionScheduleIndex(this.dependencies.config);
    const needsAttention = await this.dependencies.config.putConnectionAccount(
      { ...account, lifecycle: 'needs_attention' },
      account.revision,
    );
    try {
      await pauseDependentSchedules(this.dependencies.config, account.id, scheduleIndex);
    } catch {
      throw new ConnectionScheduleConflictError(
        'Dependent schedules changed before the connection could be disconnected. Try again.',
      );
    }
    if (account.policy.kind === 'managed') {
      const provider = this.dependencies.managedProviders?.get(account.policy.adapterId);
      if (!provider) {
        throw new ManagedConnectionProviderUnavailableError(account.policy.adapterId);
      }
      await provider.revoke({ policy: account.policy });
    }
    await tombstoneConnectionAccountSecret(
      account.secretRefId,
      undefined,
      this.dependencies.settings,
    );
    const revoked = await this.dependencies.config.putConnectionAccount(
      { ...needsAttention, lifecycle: 'revoked' },
      needsAttention.revision,
    );
    try {
      await retireConnectionFromDependentSchedules(
        this.dependencies.config,
        account.id,
        undefined,
        scheduleIndex,
        true,
      );
    } catch {
      throw new ConnectionScheduleConflictError(
        'The connection is disconnected, but dependent schedules changed. Retry to finish cleanup.',
      );
    }
    return revoked;
  }

  async disconnectForAgent(input: {
    principal: AuthPrincipal;
    agentId: string;
    connectionAccountId: string;
  }): Promise<ConnectionAccount> {
    await this.requireAgentOwnedAccount(input);
    return this.revoke({
      principal: input.principal,
      connectionAccountId: input.connectionAccountId,
    });
  }

  async prepareAgentDeletion(input: {
    principal: AuthPrincipal;
    agentId: string;
    expectedRevision: number;
  }): Promise<ConnectionAccount[]> {
    const agent = await this.dependencies.config.getAgent(input.agentId);
    if (!canEditAgent(input.principal, agent)) throw new AuthorizationError();
    if (agent.revision !== input.expectedRevision) {
      throw new AgentRevisionConflictError(input.agentId, input.expectedRevision, agent.revision);
    }
    const references = await this.dependencies.config.getAgentReferences(input.agentId);
    if (references.channelGrants.length > 0) {
      throw new AgentStillReferencedError(
        input.agentId,
        references.channelGrants.map(({ workspaceId, channelId }) =>
          `${workspaceId}/${channelId}`).join(', '),
      );
    }
    const bindings = await this.dependencies.config.listAgentConnectionBindings(input.agentId);
    const revoked: ConnectionAccount[] = [];
    for (const binding of bindings) {
      const currentBinding = await this.dependencies.config.getAgentConnectionBindingForAccount(
        binding.connectionAccountId,
      );
      if (currentBinding?.agentId !== input.agentId) throw new AuthorizationError();
      revoked.push(await this.revokeOwnedAccount(await this.findAccount(binding.connectionAccountId)));
    }
    return revoked;
  }

  async findManagedByRemoteRef(input: {
    principal: AuthPrincipal;
    workspaceId: string;
    adapterId: string;
    accountRef: string;
  }): Promise<ConnectionAccount | undefined> {
    const normalizedAdapterId = input.adapterId.trim().toLowerCase();
    const account = (await this.dependencies.config.listConnectionAccounts(input.workspaceId))
      .find((candidate) => candidate.lifecycle !== 'revoked' &&
        candidate.policy.kind === 'managed' &&
        candidate.policy.adapterId.trim().toLowerCase() === normalizedAdapterId &&
        candidate.policy.accountRef === input.accountRef);
    if (!account) return undefined;
    this.requireManage(input.principal, account);
    return account;
  }

  /** Internal cleanup guard; returns no account or ownership detail. */
  async hasManagedRemoteRef(input: { adapterId: string; accountRef: string }): Promise<boolean> {
    const normalizedAdapterId = input.adapterId.trim().toLowerCase();
    for (const installation of await this.dependencies.config.listWorkspaceInstallations()) {
      if ((await this.dependencies.config.listConnectionAccounts(installation.workspaceId)).some(
        (candidate) => candidate.lifecycle !== 'revoked' &&
          candidate.policy.kind === 'managed' &&
          candidate.policy.adapterId.trim().toLowerCase() === normalizedAdapterId &&
          candidate.policy.accountRef === input.accountRef,
      )) return true;
    }
    return false;
  }

  /** Replace an expired provider authorization without changing Chickpea bindings. */
  async replaceManagedAuthorization(input: {
    principal: AuthPrincipal;
    agentId: string;
    connectionAccountId: string;
    expectedRevision: number;
    adapterId: string;
    toolkit: string;
    principalRef: string;
    /** Capability ceiling observed before authorization began. */
    expectedAllowedCapabilities?: string[];
    /** Capability ceiling to persist after provider validation. */
    allowedCapabilities: string[];
    accountRef: string;
    providerGeneration?: number;
    providerLineage?: string;
  }): Promise<ConnectionAccount> {
    const { account } = await this.requireAgentOwnedAccount(input);
    if (account.revision !== input.expectedRevision || account.lifecycle === 'revoked' ||
        account.policy.kind !== 'managed' ||
        account.policy.adapterId.trim().toLowerCase() !== input.adapterId.trim().toLowerCase() ||
        account.policy.toolkit !== input.toolkit ||
        account.policy.principalRef !== input.principalRef ||
        !sameStringSet(
          account.policy.allowedCapabilities,
          input.expectedAllowedCapabilities ?? input.allowedCapabilities,
        )) {
      throw new ManagedConnectionConflictError('Managed connection changed during authorization');
    }
    await this.requireUniqueManagedAccount(input.adapterId, input.accountRef, account.id);
    const provider = this.dependencies.managedProviders?.get(input.adapterId);
    if (!provider) {
      throw new Error(`Managed connection provider ${input.adapterId} is unavailable`);
    }
    let policy: ConnectionAccountPolicy = {
      ...account.policy,
      accountRef: input.accountRef,
      allowedCapabilities: [...input.allowedCapabilities],
      ...(input.providerGeneration !== undefined
        ? { providerGeneration: input.providerGeneration }
        : {}),
      ...(input.providerLineage !== undefined
        ? { providerLineage: input.providerLineage }
        : {}),
    };
    if (policy.kind !== 'managed') throw new Error('Managed connection policy is unavailable');
    policy = applyManagedValidation(policy, await provider.validate({ policy }));
    const connector = this.catalog().connector(policy.toolkit);
    const lifecycle = connector?.resources?.some((resource) =>
      resource.required && !(policy.resourceConstraints?.[resource.key]?.length)
    ) ? 'pending' as const : 'ready' as const;
    const replaced = await this.dependencies.config.putConnectionAccount(
      { ...account, policy, lifecycle },
      account.revision,
    );
    if (account.policy.accountRef !== policy.accountRef) {
      try {
        await provider.revoke({ policy: account.policy });
      } catch {
        console.warn(JSON.stringify({
          event: 'chickpea.managed_connection.previous_authorization_cleanup_failed',
          adapterId: account.policy.adapterId,
          connectionAccountId: account.id,
        }));
      }
    }
    if (replaced.lifecycle === 'ready') {
      try {
        await resumeDependentSchedules(this.dependencies.config, replaced.id);
      } catch {
        console.warn(JSON.stringify({
          event: 'chickpea.managed_connection.schedule_resume_deferred',
          connectionAccountId: replaced.id,
        }));
      }
    }
    return replaced;
  }

  async markManagedAccountExpired(input: {
    adapterId: string;
    accountRef: string;
  }): Promise<number> {
    return markManagedAccountExpired(this.dependencies.config, input);
  }

  private async findAccount(id: string): Promise<ConnectionAccount> {
    const installations = await this.dependencies.config.listWorkspaceInstallations();
    for (const installation of installations) {
      const account = (await this.dependencies.config.listConnectionAccounts(installation.workspaceId))
        .find((candidate) => candidate.id === id);
      if (account) return account;
    }
    throw new Error(`Unknown connection account ${id}`);
  }

  private async requireAgentOwnedAccount(input: {
    principal: AuthPrincipal;
    agentId: string;
    connectionAccountId: string;
  }): Promise<{ account: ConnectionAccount; binding: AgentConnectionBinding }> {
    const agent = await this.dependencies.config.getAgent(input.agentId);
    if (!canEditAgent(input.principal, agent)) throw new AuthorizationError();
    const binding = await this.dependencies.config.getAgentConnectionBindingForAccount(
      input.connectionAccountId,
    );
    if (!binding || binding.agentId !== input.agentId) throw new AuthorizationError();
    const account = await this.findAccount(input.connectionAccountId);
    this.requireManage(input.principal, account);
    return { account, binding };
  }

  private async prepareAccountCreation(input: {
    principal: AuthPrincipal;
    workspaceId: string;
    ownerKind: 'team' | 'member';
    providerId: string;
    label: string;
    purpose?: string;
    identity?: McpConnectionIdentity;
    policy: ConnectionAccountPolicy;
    credential?: string;
  }) {
    requirePermission(
      input.principal,
      input.ownerKind === 'team' ? 'connection.create_team' : 'connection.create_personal',
    );
    let policy = input.policy;
    if (policy.kind === 'managed') {
      assertManagedAccountPolicy(this.catalog(), input.providerId, policy);
      await this.requireUniqueManagedAccount(policy.adapterId, policy.accountRef);
      const provider = this.dependencies.managedProviders?.get(policy.adapterId);
      if (!provider) throw new ManagedConnectionProviderUnavailableError(policy.adapterId);
      policy = applyManagedValidation(policy, await provider.validate({ policy }));
    }
    const id = `connection_${this.id()}`;
    const secretRefId = `secret_${this.id()}`;
    const managedConnector = policy.kind === 'managed'
      ? this.catalog().connector(policy.toolkit)
      : undefined;
    const requiresManagedResourceSelection = Boolean(
      managedConnector?.resources?.some(({ required }) => required) &&
      policy.kind === 'managed' && !policy.resourceConstraints,
    );
    return {
      id,
      workspaceId: input.workspaceId,
      ownerKind: input.ownerKind,
      ...(input.ownerKind === 'member'
        ? { ownerMembershipId: input.principal.membershipId }
        : {}),
      createdByMembershipId: input.principal.membershipId,
      providerId: input.providerId,
      label: input.label,
      ...(input.purpose ? { purpose: input.purpose } : {}),
      ...(input.identity ? { identity: input.identity } : {}),
      policy,
      secretRefId,
      lifecycle: policy.kind === 'managed'
        ? requiresManagedResourceSelection ? 'pending' as const : 'ready' as const
        : input.credential || input.policy.kind === 'mcp' && input.policy.authMode === 'none'
          ? 'ready' as const
          : 'needs_attention' as const,
    };
  }

  private async requireUniqueManagedAccount(
    adapterId: string,
    accountRef: string,
    excludeConnectionAccountId?: string,
  ): Promise<void> {
    const normalizedAdapterId = adapterId.trim().toLowerCase();
    const installations = await this.dependencies.config.listWorkspaceInstallations();
    for (const installation of installations) {
      const duplicate = (await this.dependencies.config.listConnectionAccounts(installation.workspaceId))
        .find((account) =>
          account.id !== excludeConnectionAccountId &&
          account.lifecycle !== 'revoked' &&
          account.policy.kind === 'managed' &&
          account.policy.adapterId.trim().toLowerCase() === normalizedAdapterId &&
          account.policy.accountRef === accountRef
        );
      if (duplicate) {
        throw new ManagedConnectionConflictError(
          `Managed account ${accountRef} is already committed to another connection`,
        );
      }
    }
  }

  private catalog(): ManagedConnectorCatalog {
    return this.dependencies.managedCatalog ?? MANAGED_CONNECTOR_CATALOG;
  }

  private async discoverManagedResources(input: {
    policy: Extract<ConnectionAccountPolicy, { kind: 'managed' }>;
    resourceKey: string;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<{
    resources: Array<{ providerRef: string; label: string; currencyCode?: string }>;
    nextCursor?: string;
  }> {
    const provider = this.dependencies.managedProviders?.get(input.policy.adapterId);
    if (!provider?.discoverResources) {
      throw new ManagedResourceSelectionError(
        'unavailable',
        'Managed resource discovery is unavailable',
      );
    }
    let result: Awaited<ReturnType<NonNullable<typeof provider.discoverResources>>>;
    try {
      result = await provider.discoverResources(input);
    } catch {
      throw new ManagedResourceSelectionError(
        'unavailable',
        'Managed resource discovery failed',
      );
    }
    if (!Array.isArray(result.resources) || result.resources.length > 250 ||
        result.nextCursor !== undefined && (
          typeof result.nextCursor !== 'string' || !result.nextCursor.trim() ||
          result.nextCursor.length > 2_000
        )) {
      throw new ManagedResourceSelectionError('unavailable', 'Managed resource response is invalid');
    }
    const resources: Array<{ providerRef: string; label: string; currencyCode?: string }> = [];
    const providerRefs = new Set<string>();
    for (const item of result.resources) {
      if (!item || typeof item.providerRef !== 'string' || typeof item.label !== 'string' ||
          !item.providerRef.trim() || item.providerRef.length > 2_000 ||
          !item.label.trim() || item.label.length > 240 || providerRefs.has(item.providerRef)) {
        throw new ManagedResourceSelectionError('unavailable', 'Managed resource response is invalid');
      }
      if (item.currencyCode !== undefined && !/^[A-Z]{3}$/.test(item.currencyCode)) {
        throw new ManagedResourceSelectionError('unavailable', 'Managed resource response is invalid');
      }
      providerRefs.add(item.providerRef);
      resources.push({
        providerRef: item.providerRef,
        label: item.label.trim(),
        ...(item.currencyCode ? { currencyCode: item.currencyCode } : {}),
      });
    }
    return {
      resources,
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  }

  private async discoverAllManagedResources(input: {
    policy: Extract<ConnectionAccountPolicy, { kind: 'managed' }>;
    resourceKey: string;
    signal?: AbortSignal;
  }): Promise<Array<{ providerRef: string; label: string; currencyCode?: string }>> {
    const resources: Array<{ providerRef: string; label: string; currencyCode?: string }> = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      const page = await this.discoverManagedResources({
        ...input,
        ...(cursor ? { cursor } : {}),
      });
      const remaining = 2_000 - resources.length;
      resources.push(...page.resources.slice(0, remaining));
      if (resources.length >= 2_000) return resources;
      if (!page.nextCursor) return resources;
      if (cursors.has(page.nextCursor)) {
        throw new ManagedResourceSelectionError('unavailable', 'Managed resource pagination is invalid');
      }
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return resources;
  }

  private requireManage(principal: AuthPrincipal, account: ConnectionAccount): void {
    if (principal.role === 'owner' || principal.role === 'admin') return;
    if (account.ownerKind === 'member' && account.ownerMembershipId === principal.membershipId) return;
    if (account.ownerKind === 'team' && account.createdByMembershipId === principal.membershipId) return;
    throw new AuthorizationError();
  }

  private id(): string {
    return (this.dependencies.randomId ?? (() => crypto.randomUUID().replace(/-/g, '')))();
  }
}

function assertManagedAccountPolicy(
  catalog: ManagedConnectorCatalog,
  providerId: string,
  policy: Extract<ConnectionAccountPolicy, { kind: 'managed' }>,
): void {
  const connector = catalog.connector(policy.toolkit);
  const catalogCapabilities = new Set(connector?.capabilities.map(({ id }) => id) ?? []);
  const resourcePolicyValid = !connector?.resources?.length ||
    policy.resourceConstraints === undefined ||
    intersectManagedResourceConstraints(
      connector,
      policy.resourceConstraints,
      projectManagedResourceHandles(policy.resourceConstraints),
    ) !== undefined;
  if (!connector || connector.providerId !== providerId ||
      policy.allowedCapabilities.some((capability) => !catalogCapabilities.has(capability)) ||
      !resourcePolicyValid) {
    throw new Error('Managed connection account policy is invalid');
  }
}

function applyManagedValidation(
  policy: Extract<ConnectionAccountPolicy, { kind: 'managed' }>,
  validation: ManagedConnectionValidationResult | void,
): Extract<ConnectionAccountPolicy, { kind: 'managed' }> {
  if (!validation?.grantSummary) return policy;
  const { items, truncated } = validation.grantSummary;
  if (typeof truncated !== 'boolean' || !Array.isArray(items) || items.length > 20 ||
      items.some((item) =>
        !item || (item.type !== 'page' && item.type !== 'database') ||
        typeof item.label !== 'string' || !item.label.trim() || item.label.length > 240)) {
    throw new Error('Managed connection grant summary is invalid');
  }
  return {
    ...policy,
    grantSummary: {
      items: items.map(({ type, label }) => ({ type, label: label.trim() })),
      truncated,
    },
  };
}

async function managedResourceHandle(resourceKey: string, providerRef: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${resourceKey}\u0000${providerRef}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `resource_${hex.slice(0, 32)}`;
}

export async function markManagedAccountExpired(
  config: ConfigStore,
  input: { adapterId: string; accountRef: string },
): Promise<number> {
  const normalizedAdapterId = input.adapterId.trim().toLowerCase();
  let changed = 0;
  for (const installation of await config.listWorkspaceInstallations()) {
    const accounts = await config.listConnectionAccounts(installation.workspaceId);
    for (const account of accounts) {
      if (!matchesManagedRemoteAccount(account, normalizedAdapterId, input.accountRef)) continue;
      let current: ConnectionAccount | undefined = account;
      let pauseSchedules = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (!matchesManagedRemoteAccount(current, normalizedAdapterId, input.accountRef)) break;
        if (current.lifecycle === 'needs_attention') {
          pauseSchedules = true;
          break;
        }
        if (await putConnectionAccountIfCurrent(
          config,
          { ...current, lifecycle: 'needs_attention' },
          current.revision,
        )) {
          changed += 1;
          pauseSchedules = true;
          break;
        }
        current = (await config.listConnectionAccounts(installation.workspaceId))
          .find((candidate) => candidate.id === account.id);
        if (matchesManagedRemoteAccount(current, normalizedAdapterId, input.accountRef) &&
            current.lifecycle === 'needs_attention') {
          pauseSchedules = true;
          break;
        }
        if (attempt === 2 &&
            matchesManagedRemoteAccount(current, normalizedAdapterId, input.accountRef) &&
            current.lifecycle !== 'needs_attention') {
          throw new ManagedConnectionConflictError(
            'Managed account expiry could not be persisted. Retry delivery.',
          );
        }
      }
      if (pauseSchedules) await pauseDependentSchedules(config, account.id);
    }
  }
  return changed;
}

function matchesManagedRemoteAccount(
  account: ConnectionAccount | undefined,
  normalizedAdapterId: string,
  accountRef: string,
): account is ConnectionAccount & { policy: Extract<ConnectionAccountPolicy, { kind: 'managed' }> } {
  return Boolean(account && account.lifecycle !== 'revoked' && account.policy.kind === 'managed' &&
    account.policy.adapterId.trim().toLowerCase() === normalizedAdapterId &&
    account.policy.accountRef === accountRef);
}

export async function markManagedProviderAccountsUnavailable(
  config: ConfigStore,
  input: { adapterId: string },
): Promise<{ accounts: number; schedules: number; retryable: number }> {
  const normalizedAdapterId = input.adapterId.trim().toLowerCase();
  const installations = await config.listWorkspaceInstallations();
  const accountsByWorkspace = await listConnectionAccountsByWorkspace(config, installations);
  const scheduleIndex = await buildConnectionScheduleIndex(config, accountsByWorkspace);
  let accounts = 0;
  let schedules = 0;
  let retryable = 0;
  for (const installation of installations) {
    for (const account of accountsByWorkspace.get(installation.workspaceId) ?? []) {
      if (account.lifecycle === 'revoked' || account.policy.kind !== 'managed' ||
          account.policy.adapterId.trim().toLowerCase() !== normalizedAdapterId) continue;
      if (account.lifecycle !== 'needs_attention') {
        const updated = { ...account, lifecycle: 'needs_attention' as const };
        if (!await putConnectionAccountIfCurrent(
          config,
          updated,
          account.revision,
        )) {
          retryable += 1;
          continue;
        }
        cacheConnectionAccount(scheduleIndex, updated);
        accounts += 1;
      }
      try {
        schedules += await pauseDependentSchedules(config, account.id, scheduleIndex);
      } catch {
        retryable += 1;
        console.warn(JSON.stringify({
          event: 'chickpea.managed_connection.schedule_pause_deferred',
          connectionAccountId: account.id,
        }));
      }
    }
  }
  return { accounts, schedules, retryable };
}

export type ManagedProviderAccountInspection =
  | 'match'
  | 'missing'
  | 'mismatch'
  | 'transient';

export async function reconcileManagedProviderAccounts(
  config: ConfigStore,
  input: {
    adapterId: string;
    generation: number;
    lineage: string;
    inspect(input: {
      accountRef: string;
      principalRef: string;
      toolkit: string;
    }): Promise<ManagedProviderAccountInspection>;
    maxInspections?: number;
  },
): Promise<{ restored: number; needsAttention: number; retryable: number }> {
  if (!Number.isSafeInteger(input.generation) || input.generation < 1 ||
      !/^[a-f0-9]{24}$/.test(input.lineage)) {
    throw new Error('Managed provider reconciliation input is invalid');
  }
  const maxInspections = input.maxInspections ?? 25;
  if (!Number.isSafeInteger(maxInspections) || maxInspections < 1 || maxInspections > 100) {
    throw new Error('Managed provider reconciliation batch is invalid');
  }
  const normalizedAdapterId = input.adapterId.trim().toLowerCase();
  const installations = await config.listWorkspaceInstallations();
  const accountsByWorkspace = await listConnectionAccountsByWorkspace(config, installations);
  const scheduleIndex = await buildConnectionScheduleIndex(config, accountsByWorkspace);
  let restored = 0;
  let needsAttention = 0;
  let retryable = 0;
  let inspectionCount = 0;
  for (const installation of installations) {
    for (const account of accountsByWorkspace.get(installation.workspaceId) ?? []) {
      if (account.lifecycle === 'revoked' || account.policy.kind !== 'managed' ||
          account.policy.adapterId.trim().toLowerCase() !== normalizedAdapterId) continue;
      if (account.policy.providerGeneration === input.generation &&
          account.policy.providerLineage === input.lineage) {
        try {
          if (account.lifecycle === 'ready') {
            await resumeDependentSchedules(config, account.id, scheduleIndex);
          } else if (account.lifecycle === 'needs_attention') {
            await pauseDependentSchedules(config, account.id, scheduleIndex);
          }
        } catch {
          retryable += 1;
          console.warn(JSON.stringify({
            event: 'chickpea.managed_connection.schedule_reconciliation_deferred',
            connectionAccountId: account.id,
          }));
        }
        continue;
      }
      if (inspectionCount >= maxInspections) {
        retryable += 1;
        continue;
      }
      inspectionCount += 1;
      let inspection: ManagedProviderAccountInspection;
      try {
        inspection = await input.inspect({
          accountRef: account.policy.accountRef,
          principalRef: account.policy.principalRef,
          toolkit: account.policy.toolkit,
        });
      } catch {
        inspection = 'transient';
      }
      if (inspection === 'transient') {
        retryable += 1;
        continue;
      }
      if (inspection !== 'match') {
        const updated = {
            ...account,
            lifecycle: 'needs_attention' as const,
            policy: {
              ...account.policy,
              providerGeneration: input.generation,
              providerLineage: input.lineage,
            },
          };
        if (!await putConnectionAccountIfCurrent(config, updated, account.revision)) {
          retryable += 1;
          continue;
        }
        cacheConnectionAccount(scheduleIndex, updated);
        try {
          await pauseDependentSchedules(config, account.id, scheduleIndex);
        } catch {
          retryable += 1;
          console.warn(JSON.stringify({
            event: 'chickpea.managed_connection.schedule_pause_deferred',
            connectionAccountId: account.id,
          }));
        }
        needsAttention += 1;
        continue;
      }
      const connector = MANAGED_CONNECTOR_CATALOG.connector(account.policy.toolkit);
      const lifecycle = connector?.resources?.some((resource) =>
        resource.required && !(account.policy.kind === 'managed' &&
          account.policy.resourceConstraints?.[resource.key]?.length)
      ) ? 'pending' as const : 'ready' as const;
      const updated = {
          ...account,
          lifecycle,
          policy: {
            ...account.policy,
            providerGeneration: input.generation,
            providerLineage: input.lineage,
          },
        };
      if (!await putConnectionAccountIfCurrent(config, updated, account.revision)) {
        retryable += 1;
        continue;
      }
      cacheConnectionAccount(scheduleIndex, updated);
      if (lifecycle === 'ready') {
        try {
          await resumeDependentSchedules(config, account.id, scheduleIndex);
        } catch {
          retryable += 1;
          console.warn(JSON.stringify({
            event: 'chickpea.managed_connection.schedule_resume_deferred',
            connectionAccountId: account.id,
          }));
        }
      }
      restored += 1;
    }
  }
  return { restored, needsAttention, retryable };
}

interface ConnectionScheduleIndex {
  schedules: Map<string, AgentScheduleReference>;
  bindingsByAgent: Map<string, AgentConnectionBinding[]>;
  accountsByWorkspace: Map<string, ConnectionAccount[]>;
  archivedAgentIds: Set<string>;
  requiredScheduleIdsByConnection: Map<string, Set<string>>;
  pausableScheduleIdsByConnection: Map<string, Set<string>>;
  pausedScheduleIdsByConnection: Map<string, Set<string>>;
}

async function buildConnectionScheduleIndex(
  config: ConfigStore,
  knownAccountsByWorkspace = new Map<string, ConnectionAccount[]>(),
): Promise<ConnectionScheduleIndex> {
  const agents = await config.listAgents();
  const index: ConnectionScheduleIndex = {
    schedules: new Map(),
    bindingsByAgent: new Map(),
    accountsByWorkspace: new Map(knownAccountsByWorkspace),
    archivedAgentIds: new Set(agents.filter(({ lifecycle }) => lifecycle === 'archived')
      .map(({ id }) => id)),
    requiredScheduleIdsByConnection: new Map(),
    pausableScheduleIdsByConnection: new Map(),
    pausedScheduleIdsByConnection: new Map(),
  };
  const schedulesByAgent = await Promise.all(agents.map(async ({ id }) => {
    const [bindings, schedules] = await Promise.all([
      config.listAgentConnectionBindings(id),
      config.listAgentScheduleReferences(id),
    ]);
    index.bindingsByAgent.set(id, bindings);
    return schedules;
  }));
  const schedules = schedulesByAgent.flat();
  const workspaceIds = new Set(schedules.map(({ workspaceId }) => workspaceId));
  await Promise.all([...workspaceIds].map(async (workspaceId) => {
    if (index.accountsByWorkspace.has(workspaceId)) return;
    index.accountsByWorkspace.set(workspaceId, await config.listConnectionAccounts(workspaceId));
  }));
  for (const schedule of schedules) indexConnectionSchedule(index, schedule);
  return index;
}

async function listConnectionAccountsByWorkspace(
  config: ConfigStore,
  installations: Awaited<ReturnType<ConfigStore['listWorkspaceInstallations']>>,
): Promise<Map<string, ConnectionAccount[]>> {
  return new Map(await Promise.all(installations.map(async ({ workspaceId }) => [
    workspaceId,
    await config.listConnectionAccounts(workspaceId),
  ] as const)));
}

function cacheConnectionAccount(
  index: ConnectionScheduleIndex,
  account: ConnectionAccount,
): void {
  const accounts = index.accountsByWorkspace.get(account.workspaceId) ?? [];
  index.accountsByWorkspace.set(account.workspaceId, [
    ...accounts.filter(({ id }) => id !== account.id),
    account,
  ]);
}

function indexConnectionSchedule(
  index: ConnectionScheduleIndex,
  schedule: AgentScheduleReference,
  previous?: AgentScheduleReference,
): void {
  if (previous) removeConnectionScheduleFromIndex(index, previous);
  index.schedules.set(schedule.scheduleId, schedule);
  const pausedBy = schedule.connectionPauseAccountIds ?? [];
  const recoverable = recoverableConnectionIds(index, schedule);
  for (const connectionAccountId of schedule.requiredConnectionAccountIds) {
    addScheduleIndexEntry(
      index.requiredScheduleIdsByConnection,
      connectionAccountId,
      schedule.scheduleId,
    );
    if (schedule.state !== 'archived') {
      if (!recoverable.has(connectionAccountId)) continue;
      addScheduleIndexEntry(
        index.pausableScheduleIdsByConnection,
        connectionAccountId,
        schedule.scheduleId,
      );
    }
  }
  for (const connectionAccountId of pausedBy) {
    addScheduleIndexEntry(
      index.pausedScheduleIdsByConnection,
      connectionAccountId,
      schedule.scheduleId,
    );
  }
}

function removeConnectionScheduleFromIndex(
  index: ConnectionScheduleIndex,
  schedule: AgentScheduleReference,
): void {
  for (const connectionAccountId of schedule.requiredConnectionAccountIds) {
    index.requiredScheduleIdsByConnection.get(connectionAccountId)?.delete(schedule.scheduleId);
    index.pausableScheduleIdsByConnection.get(connectionAccountId)?.delete(schedule.scheduleId);
  }
  for (const connectionAccountId of schedule.connectionPauseAccountIds ?? []) {
    index.pausedScheduleIdsByConnection.get(connectionAccountId)?.delete(schedule.scheduleId);
  }
}

function addScheduleIndexEntry(
  index: Map<string, Set<string>>,
  connectionAccountId: string,
  scheduleId: string,
): void {
  const scheduleIds = index.get(connectionAccountId) ?? new Set<string>();
  scheduleIds.add(scheduleId);
  index.set(connectionAccountId, scheduleIds);
}

async function pauseDependentSchedules(
  config: ConfigStore,
  connectionAccountId: string,
  scheduleIndex?: ConnectionScheduleIndex,
): Promise<number> {
  const index = scheduleIndex ?? await buildConnectionScheduleIndex(config);
  let changed = 0;
  const scheduleIds = [
    ...(index.pausableScheduleIdsByConnection.get(connectionAccountId) ?? []),
  ];
  for (const scheduleId of scheduleIds) {
    const schedule = index.schedules.get(scheduleId);
    if (!schedule) continue;
    const pausedBy = schedule.connectionPauseAccountIds ?? [];
    if (schedule.state === 'archived') continue;
    if (pausedBy.includes(connectionAccountId)) continue;
    const connectionPausePreservesState = schedule.connectionPausePreservesState === true ||
      (pausedBy.length === 0 && schedule.state !== 'active' &&
        !(schedule.state === 'paused' && index.archivedAgentIds.has(schedule.agentId)));
    const {
      connectionPausePreservesState: _connectionPausePreservesState,
      ...scheduleWithoutPauseState
    } = schedule;
    const updated = await config.putAgentScheduleReference({
      ...scheduleWithoutPauseState,
      connectionPauseAccountIds: [...pausedBy, connectionAccountId],
      ...(connectionPausePreservesState ? { connectionPausePreservesState: true } : {}),
      state: schedule.state === 'paused' ? 'paused' : 'needs_attention',
    }, schedule.revision);
    indexConnectionSchedule(index, updated, schedule);
    if (schedule.state === 'active') changed += 1;
  }
  return changed;
}

async function resumeDependentSchedules(
  config: ConfigStore,
  connectionAccountId: string,
  scheduleIndex?: ConnectionScheduleIndex,
): Promise<number> {
  const index = scheduleIndex ?? await buildConnectionScheduleIndex(config);
  let changed = 0;
  const scheduleIds = new Set([
    ...(index.pausedScheduleIdsByConnection.get(connectionAccountId) ?? []),
    ...(index.requiredScheduleIdsByConnection.get(connectionAccountId) ?? []),
  ]);
  for (const scheduleId of scheduleIds) {
    const schedule = index.schedules.get(scheduleId);
    if (!schedule) continue;
    const pausedBy = schedule.connectionPauseAccountIds ?? [];
    if (pausedBy.length === 0 || schedule.state === 'archived') continue;
    const available = effectiveConnectionIds(index, schedule);
    const nextPauseIds = schedule.requiredConnectionAccountIds
      .filter((id) => !available.has(id));
    const state = nextPauseIds.length > 0
      ? 'needs_attention' as const
      : index.archivedAgentIds.has(schedule.agentId)
        ? schedule.state
        : schedule.connectionPausePreservesState ? schedule.state : 'active' as const;
    if (state === schedule.state && sameStringSet(nextPauseIds, pausedBy)) continue;
    const {
      connectionPauseAccountIds: _pausedBy,
      connectionPausePreservesState: _connectionPausePreservesState,
      ...scheduleWithoutPauseIds
    } = schedule;
    const updated = await config.putAgentScheduleReference({
      ...scheduleWithoutPauseIds,
      ...(nextPauseIds.length > 0 ? { connectionPauseAccountIds: nextPauseIds } : {}),
      ...(nextPauseIds.length > 0 && schedule.connectionPausePreservesState
        ? { connectionPausePreservesState: true }
        : {}),
      state,
    }, schedule.revision);
    indexConnectionSchedule(index, updated, schedule);
    if (schedule.state !== 'active' && state === 'active') changed += 1;
  }
  return changed;
}

async function retireConnectionFromDependentSchedules(
  config: ConfigStore,
  connectionAccountId: string,
  agentId?: string,
  scheduleIndex?: ConnectionScheduleIndex,
  keepPaused = false,
  eligibleScheduleIds?: ReadonlySet<string>,
): Promise<number> {
  const index = scheduleIndex ?? await buildConnectionScheduleIndex(config);
  const scheduleIds = new Set([
    ...(index.requiredScheduleIdsByConnection.get(connectionAccountId) ?? []),
    ...(index.pausedScheduleIdsByConnection.get(connectionAccountId) ?? []),
  ]);
  let changed = 0;
  for (const scheduleId of scheduleIds) {
    const schedule = index.schedules.get(scheduleId);
    if (!schedule || (agentId && schedule.agentId !== agentId) ||
        (eligibleScheduleIds && !eligibleScheduleIds.has(scheduleId))) continue;
    const pausedBy = schedule.connectionPauseAccountIds ?? [];
    const requiredConnectionAccountIds = schedule.requiredConnectionAccountIds
      .filter((id) => id !== connectionAccountId);
    let nextPauseIds = pausedBy.filter((id) => id !== connectionAccountId);
    let state = schedule.state;
    if (keepPaused && schedule.state !== 'archived' &&
        (pausedBy.includes(connectionAccountId) ||
          schedule.requiredConnectionAccountIds.includes(connectionAccountId))) {
      state = schedule.state === 'paused' && index.archivedAgentIds.has(schedule.agentId)
        ? schedule.state
        : 'needs_attention';
    } else if (pausedBy.includes(connectionAccountId) && schedule.state !== 'archived') {
      const available = effectiveConnectionIds(index, schedule);
      nextPauseIds = requiredConnectionAccountIds.filter((id) => !available.has(id));
      state = nextPauseIds.length > 0
        ? 'needs_attention'
        : index.archivedAgentIds.has(schedule.agentId)
          ? schedule.state
          : schedule.connectionPausePreservesState ? schedule.state : 'active';
    }
    if (sameStringSet(requiredConnectionAccountIds, schedule.requiredConnectionAccountIds) &&
        sameStringSet(nextPauseIds, pausedBy) && state === schedule.state) continue;
    const {
      connectionPauseAccountIds: _pausedBy,
      connectionPausePreservesState: _connectionPausePreservesState,
      ...scheduleWithoutPauseIds
    } = schedule;
    const updated = await config.putAgentScheduleReference({
      ...scheduleWithoutPauseIds,
      requiredConnectionAccountIds,
      ...(nextPauseIds.length > 0 ? { connectionPauseAccountIds: nextPauseIds } : {}),
      ...(nextPauseIds.length > 0 && schedule.connectionPausePreservesState
        ? { connectionPausePreservesState: true }
        : {}),
      state,
    }, schedule.revision);
    indexConnectionSchedule(index, updated, schedule);
    changed += 1;
  }
  return changed;
}

function effectiveConnectionIds(
  index: ConnectionScheduleIndex,
  schedule: AgentScheduleReference,
): Set<string> {
  return new Set(projectEffectiveConnectionAccounts(
    index.accountsByWorkspace.get(schedule.workspaceId) ?? [],
    index.bindingsByAgent.get(schedule.agentId) ?? [],
    schedule.runsAsMembershipId,
  ).map(({ account }) => account.id));
}

function recoverableConnectionIds(
  index: ConnectionScheduleIndex,
  schedule: AgentScheduleReference,
): Set<string> {
  return new Set(projectRecoverableConnectionAccounts(
    index.accountsByWorkspace.get(schedule.workspaceId) ?? [],
    index.bindingsByAgent.get(schedule.agentId) ?? [],
    schedule.runsAsMembershipId,
  ).map(({ account }) => account.id));
}

async function putConnectionAccountIfCurrent(
  config: ConfigStore,
  account: ConnectionAccount,
  expectedRevision: number,
): Promise<boolean> {
  try {
    await config.putConnectionAccount(account, expectedRevision);
    return true;
  } catch (error) {
    if (error instanceof ConnectionAccountRevisionConflictError) return false;
    throw error;
  }
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}
