import type { AuthPrincipal } from '../auth/types.ts';
import { canEditAgent, requirePermission, AuthorizationError } from '../auth/permissions.ts';
import {
  saveConnectionAccountSecret,
  tombstoneConnectionAccountSecret,
} from '../config/connector-secrets.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { ConfigStore } from '../config/store.ts';
import type {
  AgentConnectionBinding,
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

  async create(input: {
    principal: AuthPrincipal;
    workspaceId: string;
    ownerKind: 'team' | 'member';
    providerId: string;
    label: string;
    purpose?: string;
    identity?: McpConnectionIdentity;
    policy: ConnectionAccountPolicy;
    credential?: string;
  }): Promise<ConnectionAccount> {
    requirePermission(
      input.principal,
      input.ownerKind === 'team' ? 'connection.create_team' : 'connection.create_personal',
    );
    let policy = input.policy;
    if (policy.kind === 'managed') {
      assertManagedAccountPolicy(this.catalog(), input.providerId, policy);
      await this.requireUniqueManagedAccount(policy.adapterId, policy.accountRef);
      const provider = this.dependencies.managedProviders?.get(policy.adapterId);
      if (!provider) {
        throw new ManagedConnectionProviderUnavailableError(policy.adapterId);
      }
      policy = applyManagedValidation(
        policy,
        await provider.validate({ policy }),
      );
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
    const account = await this.dependencies.config.putConnectionAccount({
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
        ? requiresManagedResourceSelection ? 'pending' : 'ready'
        : input.credential || input.policy.kind === 'mcp' && input.policy.authMode === 'none'
        ? 'pending'
        : 'needs_attention',
    }, 0);
    // Managed credentials already passed provider validation and never have a
    // local secret to promote. Persist them ready in one atomic account write.
    if (policy.kind === 'managed') return account;
    if (
      !input.credential &&
      !(input.policy.kind === 'mcp' && input.policy.authMode === 'none')
    ) {
      return account;
    }
    if (input.credential) {
      await saveConnectionAccountSecret(secretRefId, input.credential, undefined, this.dependencies.settings);
    }
    return this.dependencies.config.putConnectionAccount(
      { ...account, lifecycle: 'ready' },
      account.revision,
    );
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
    connectionAccountId: string;
    resourceKey: string;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<{
    resources: Array<{ handle: string; label: string }>;
    nextCursor?: string;
  }> {
    const account = await this.getForManagement(input.principal, input.connectionAccountId);
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
    const agent = await this.dependencies.config.getAgent(input.agentId);
    if (!canEditAgent(input.principal, agent)) throw new AuthorizationError();
    const account = await this.getForManagement(input.principal, input.connectionAccountId);
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
    // The account policy is the reusable credential's maximum resource set;
    // each Agent binding narrows that set independently. Selecting resources
    // for one Agent must therefore accumulate into the account ceiling instead
    // of replacing resources already used by another Agent.
    const accountConstraints: ManagedAccountResourceConstraints = {
      ...(account.policy.resourceConstraints ?? {}),
    };
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
      const existing = accountConstraints[resource.key] ?? [];
      const mergedSelections = [...new Map(
        [...existing, ...(selected as ManagedResourceSelection[])].map((selection) => [
          selection.handle,
          selection,
        ]),
      ).values()];
      if (mergedSelections.length > MAX_MANAGED_RESOURCE_SELECTIONS_PER_KEY) {
        throw new ManagedResourceSelectionError(
          'invalid',
          `This connected account can grant at most ${MAX_MANAGED_RESOURCE_SELECTIONS_PER_KEY} ` +
            `${resource.label.toLowerCase()}. Connect a separate account for additional resources.`,
        );
      }
      accountConstraints[resource.key] = mergedSelections;
    }
    const effective = intersectManagedResourceConstraints(
      connector,
      accountConstraints,
      input.resourceConstraints,
    );
    if (bindingSelectionComplete && effective === undefined) {
      throw new ManagedResourceSelectionError('invalid', 'Managed resource selection is invalid');
    }
    const binding = (await this.dependencies.config.listAgentConnectionBindings(input.agentId))
      .find((candidate) => candidate.connectionAccountId === account.id);
    if (!binding) {
      throw new ManagedResourceSelectionError('invalid', 'Managed connection is not attached');
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

  async attach(input: {
    principal: AuthPrincipal;
    agentId: string;
    connectionAccountId: string;
    allowedCapabilities?: string[];
    resourceConstraints?: ManagedBindingResourceConstraints;
  }): Promise<AgentConnectionBinding> {
    const agent = await this.dependencies.config.getAgent(input.agentId);
    if (!canEditAgent(input.principal, agent)) throw new AuthorizationError();
    const account = await this.findAccount(input.connectionAccountId);
    if (
      account.ownerKind === 'member' &&
      account.ownerMembershipId !== input.principal.membershipId
    ) {
      throw new AuthorizationError();
    }
    if (account.lifecycle === 'revoked') throw new Error('Revoked connection accounts cannot be attached');
    const existingBinding = (await this.dependencies.config.listAgentConnectionBindings(
      input.agentId,
    )).find((binding) => binding.connectionAccountId === account.id);
    const bindingCapabilities = account.policy.kind === 'managed' &&
      (!input.allowedCapabilities || input.allowedCapabilities.length === 0)
      ? existingBinding
        ? [...existingBinding.allowedCapabilities]
        : [...account.policy.allowedCapabilities]
      : [...(input.allowedCapabilities ?? [])];
    const bindingResourceConstraints = account.policy.kind === 'managed' &&
      input.resourceConstraints === undefined
      ? existingBinding
        ? { ...(existingBinding.resourceConstraints ?? {}) }
        : projectManagedResourceHandles(account.policy.resourceConstraints)
      : input.resourceConstraints ?? {};
    if (account.policy.kind === 'managed') {
      const connector = this.catalog().connector(account.policy.toolkit);
      if (!connector || connector.providerId !== account.providerId) {
        throw new Error('Managed connection connector is unavailable');
      }
      const allowedCapabilities = account.policy.allowedCapabilities;
      if (bindingCapabilities.some(
        (capability) => !allowedCapabilities.includes(capability),
      )) {
        throw new Error('Managed connection binding exceeds the account capability ceiling');
      }
      const effectiveResources = intersectManagedResourceConstraints(
        connector,
        account.policy.resourceConstraints,
        bindingResourceConstraints,
      );
      const pendingResourceSelection = Boolean(
        connector.resources?.length &&
        Object.keys(bindingResourceConstraints).length === 0,
      );
      if (effectiveResources === undefined && !pendingResourceSelection) {
        throw new Error('Managed connection resource selection is incomplete');
      }
      await this.assertManagedLaneAvailable({
        principal: input.principal,
        agentId: input.agentId,
        ownerKind: account.ownerKind,
        adapterId: account.policy.adapterId,
        toolkit: account.policy.toolkit,
        excludeConnectionAccountId: account.id,
      });
    }
    return this.dependencies.config.putAgentConnectionBinding({
      agentId: input.agentId,
      connectionAccountId: account.id,
      providerId: account.providerId,
      allowedCapabilities: bindingCapabilities,
      resourceConstraints: bindingResourceConstraints,
      enabled: true,
    });
  }

  /** Preflight the one-Team/one-Personal lane invariant before remote import. */
  async assertManagedLaneAvailable(input: {
    principal: AuthPrincipal;
    agentId: string;
    ownerKind: 'team' | 'member';
    adapterId: string;
    toolkit: string;
    excludeConnectionAccountId?: string;
  }): Promise<void> {
    const agent = await this.dependencies.config.getAgent(input.agentId);
    if (!canEditAgent(input.principal, agent)) throw new AuthorizationError();
    const normalizedAdapterId = input.adapterId.trim().toLowerCase();
    const siblingBindings = await this.dependencies.config.listAgentConnectionBindings(
      input.agentId,
    );
    for (const siblingBinding of siblingBindings) {
      if (!siblingBinding.enabled ||
          siblingBinding.connectionAccountId === input.excludeConnectionAccountId) continue;
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

  async detach(input: {
    principal: AuthPrincipal;
    agentId: string;
    connectionAccountId: string;
  }): Promise<AgentConnectionBinding> {
    const agent = await this.dependencies.config.getAgent(input.agentId);
    if (!canEditAgent(input.principal, agent)) throw new AuthorizationError();
    const current = (await this.dependencies.config.listAgentConnectionBindings(input.agentId))
      .find((binding) => binding.connectionAccountId === input.connectionAccountId);
    if (!current) throw new Error('Connection binding does not exist');
    return this.dependencies.config.putAgentConnectionBinding({ ...current, enabled: false });
  }

  async revoke(input: {
    principal: AuthPrincipal;
    connectionAccountId: string;
  }): Promise<ConnectionAccount> {
    const account = await this.findAccount(input.connectionAccountId);
    this.requireManage(input.principal, account);
    if (account.lifecycle === 'revoked') return account;

    // Pause dependents before making the account unavailable. If secret
    // deletion fails, needs_attention remains a fail-closed intermediate state.
    const needsAttention = await this.dependencies.config.putConnectionAccount(
      { ...account, lifecycle: 'needs_attention' },
      account.revision,
    );
    await this.pauseDependentSchedules(account.id);
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
    return this.dependencies.config.putConnectionAccount(
      { ...needsAttention, lifecycle: 'revoked' },
      needsAttention.revision,
    );
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
  }): Promise<ConnectionAccount> {
    const account = await this.findAccount(input.connectionAccountId);
    this.requireManage(input.principal, account);
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
    return replaced;
  }

  async markManagedAccountExpired(input: {
    adapterId: string;
    accountRef: string;
  }): Promise<number> {
    return markManagedAccountExpired(this.dependencies.config, input);
  }

  private async pauseDependentSchedules(connectionAccountId: string): Promise<void> {
    await pauseDependentSchedules(this.dependencies.config, connectionAccountId);
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
          `Managed account ${accountRef} is already imported; reuse connection account ${duplicate.id}`,
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
      if (account.lifecycle === 'revoked' || account.policy.kind !== 'managed' ||
          account.policy.adapterId.trim().toLowerCase() !== normalizedAdapterId ||
          account.policy.accountRef !== input.accountRef) continue;
      if (account.lifecycle !== 'needs_attention') {
        await config.putConnectionAccount(
          { ...account, lifecycle: 'needs_attention' },
          account.revision,
        );
        changed += 1;
      }
      await pauseDependentSchedules(config, account.id);
    }
  }
  return changed;
}

async function pauseDependentSchedules(
  config: ConfigStore,
  connectionAccountId: string,
): Promise<void> {
  const agents = await config.listAgents();
  for (const agent of agents) {
    const binding = (await config.listAgentConnectionBindings(agent.id))
      .find((candidate) => candidate.connectionAccountId === connectionAccountId && candidate.enabled);
    if (!binding) continue;
    for (const schedule of await config.listAgentScheduleReferences(agent.id)) {
      if (
        schedule.state === 'active' &&
        schedule.requiredConnectionAccountIds.includes(connectionAccountId)
      ) {
        await config.putAgentScheduleReference(
          { ...schedule, state: 'needs_attention' },
          schedule.revision,
        );
      }
    }
  }
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}
