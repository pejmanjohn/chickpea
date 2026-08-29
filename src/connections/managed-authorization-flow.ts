import { AuthorizationError, requirePermission } from '../auth/permissions.ts';
import type { AuthPrincipal } from '../auth/types.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { ConfigStore } from '../config/store.ts';
import type { ConnectionAccount, CustomAgentConfig } from '../config/types.ts';
import {
  ConnectionAccountService,
  ManagedConnectionConflictError,
  ManagedConnectionProviderUnavailableError,
} from './store.ts';
import {
  managedProviderAvailability,
  type ManagedConnectionProvider,
  type ManagedConnectionProviderRegistry,
} from './managed.ts';
import type { ManagedConnectorCatalog } from './catalog/index.ts';
import {
  ManagedAuthorizationAllocatedError,
  ManagedProviderRequestError,
} from './managed-errors.ts';
import {
  abandonManagedAuthorization,
  abandonManagedAuthorizationForRestart,
  abandonStaleManagedAuthorization,
  assertManagedAuthorizationProvider,
  beginManagedAuthorization,
  finalizeManagedAuthorization,
  inspectManagedAuthorization,
  inspectManagedAuthorizationForCleanup,
  inspectStaleManagedAuthorization,
  ManagedAuthorizationError,
  recordManagedAuthorizationAccount,
  recordManagedAuthorizationRequest,
  type ManagedAuthorizationAttempt,
} from './managed-authorization.ts';

const MAX_MANAGED_PRINCIPAL_REF_LENGTH = 256;

export interface ManagedAuthorizationProviderContext {
  providers: ManagedConnectionProviderRegistry;
  generation: number;
  lineage: string;
}

export interface ManagedAuthorizationFlowDependencies {
  config: ConfigStore;
  settings: SettingsStore;
  catalog: ManagedConnectorCatalog;
  providerContext: ManagedAuthorizationProviderContext;
}

export class ManagedConnectionAlreadyAttachedError extends Error {
  readonly name = 'ManagedConnectionAlreadyAttachedError';

  constructor(
    readonly ownerKind: 'team' | 'member',
    readonly connectorLabel: string,
  ) {
    super(`Agent already has a ${ownerKind} ${connectorLabel} connection`);
  }
}

class ManagedSetupCompletionLostError extends Error {
  readonly name = 'ManagedSetupCompletionLostError';
}

export interface StartManagedAuthorizationFlowInput {
  principal: AuthPrincipal;
  agent: CustomAgentConfig;
  workspaceId: string;
  ownerKind?: 'team' | 'member';
  toolkit?: string;
  access?: 'read' | 'write';
  /** Exact non-secret capability ceiling frozen by the initiating handoff. */
  capabilities?: readonly string[];
  connectionAccountId?: string;
  existingBrowserSecret?: string;
  /** Setup id used to isolate this browser flow from unrelated authorizations. */
  attemptScopeId?: string;
  returnUrl?: string;
  randomSecret?: () => string;
}

export interface StartManagedAuthorizationFlowResult {
  authorizationUrl: URL;
  browserSecret: string;
  attempt: ManagedAuthorizationAttempt;
}

export async function startManagedAuthorizationFlow(
  dependencies: ManagedAuthorizationFlowDependencies,
  input: StartManagedAuthorizationFlowInput,
): Promise<StartManagedAuthorizationFlowResult> {
  let startedAttempt: Awaited<ReturnType<typeof beginManagedAuthorization>> | undefined;
  let startedAuthorizationRef: string | undefined;
  let startedAuthorizationRecorded = false;
  const service = connectionAccounts(dependencies);
  const { providers, generation, lineage } = dependencies.providerContext;
  try {
    const replacement = input.connectionAccountId
      ? await replacementAccount(dependencies, service, {
          ...input,
          connectionAccountId: input.connectionAccountId,
        })
      : undefined;
    if (!replacement) {
      requirePermission(
        input.principal,
        input.ownerKind === 'team' ? 'connection.create_team' : 'connection.create_personal',
      );
    }
    const replacementPolicy = replacement?.policy.kind === 'managed'
      ? replacement.policy
      : undefined;
    const toolkit = replacementPolicy?.toolkit ?? input.toolkit;
    const connector = toolkit ? dependencies.catalog.connector(toolkit) : undefined;
    const ownerKind = replacement?.ownerKind ?? input.ownerKind;
    const principalRef = ownerKind ? managedPrincipalRef(input.principal, ownerKind) : undefined;
    if (!connector || !ownerKind || !principalRef) throw new ManagedAuthorizationError('invalid');
    if (replacement && (
      replacement.workspaceId !== input.workspaceId ||
      replacement.lifecycle === 'revoked' ||
      !replacementPolicy ||
      replacementPolicy.adapterId.trim().toLowerCase() !== 'composio' ||
      replacementPolicy.principalRef !== principalRef
    )) {
      throw new AuthorizationError();
    }
    if (!replacement) {
      const [accounts, bindings] = await Promise.all([
        dependencies.config.listConnectionAccounts(input.workspaceId),
        dependencies.config.listAgentConnectionBindings(input.agent.id),
      ]);
      const enabledAccountIds = new Set(
        bindings.filter((binding) => binding.enabled)
          .map((binding) => binding.connectionAccountId),
      );
      const existingOwnerLane = accounts.find((account) =>
        enabledAccountIds.has(account.id) &&
        account.lifecycle !== 'revoked' &&
        account.ownerKind === ownerKind &&
        (ownerKind === 'team' || account.ownerMembershipId === input.principal.membershipId) &&
        account.policy.kind === 'managed' &&
        account.policy.adapterId.trim().toLowerCase() === 'composio' &&
        account.policy.toolkit === connector.toolkit);
      if (existingOwnerLane) {
        throw new ManagedConnectionAlreadyAttachedError(ownerKind, connector.label);
      }
    }
    const liveCapabilities = dependencies.catalog
      .capabilities(connector.toolkit, input.access ?? 'read')
      .map(({ id }) => id);
    const capabilities = replacementPolicy
      ? [...replacementPolicy.allowedCapabilities]
      : input.capabilities
        ? frozenCapabilities(input.capabilities, liveCapabilities)
        : liveCapabilities;
    const provider = providers.get('composio');
    const accessLane = connector.capabilities.some(({ id, accessLane }) =>
      accessLane === 'write' && capabilities.includes(id)) ? 'write' : 'read';
    if (!provider?.authorize || managedProviderAvailability(provider, {
      toolkit: connector.toolkit,
      accessLane,
    }).status !== 'ready') {
      throw new ManagedConnectionProviderUnavailableError('composio');
    }
    await cleanupExistingAttempt(
      dependencies,
      service,
      input.principal.membershipId,
      input.existingBrowserSecret,
      input.attemptScopeId,
    );
    startedAttempt = await beginManagedAuthorization({
      settings: dependencies.settings,
      input: {
        workspaceId: input.workspaceId,
        agentId: input.agent.id,
        actorMembershipId: input.principal.membershipId,
        ...(input.attemptScopeId ? { attemptScopeId: input.attemptScopeId } : {}),
        ownerKind,
        providerId: replacement?.providerId ?? connector.providerId,
        adapterId: 'composio',
        toolkit: connector.toolkit,
        label: replacement?.label ??
          `${connector.label} · ${ownerKind === 'team' ? 'Team' : 'Personal'}`,
        principalRef,
        allowedCapabilities: capabilities,
        ...(replacement
          ? { connectionAccountId: replacement.id }
          : { bindingCapabilities: [...capabilities] }),
        providerGeneration: generation,
        providerLineage: lineage,
      },
      ...(input.randomSecret ? { randomSecret: input.randomSecret } : {}),
    });
    const authorization = await provider.authorize({
      principalRef,
      toolkit: connector.toolkit,
      allowedCapabilities: capabilities,
      ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
    });
    startedAuthorizationRef = authorization.authorizationRef;
    await recordManagedAuthorizationRequest({
      settings: dependencies.settings,
      actorMembershipId: input.principal.membershipId,
      ...(input.attemptScopeId ? { attemptScopeId: input.attemptScopeId } : {}),
      browserSecret: startedAttempt.browserSecret,
      authorizationRef: authorization.authorizationRef,
    });
    startedAuthorizationRecorded = true;
    return {
      authorizationUrl: authorization.authorizationUrl,
      browserSecret: startedAttempt.browserSecret,
      attempt: startedAttempt.attempt,
    };
  } catch (error) {
    if (error instanceof ManagedAuthorizationAllocatedError) {
      startedAuthorizationRef = error.authorizationRef;
    }
    if (startedAttempt) {
      await cleanupFailedStart({
        dependencies,
        startedAttempt,
        ...(startedAuthorizationRef ? { startedAuthorizationRef } : {}),
        startedAuthorizationRecorded,
      });
    }
    throw error;
  }
}

export type PollManagedAuthorizationFlowResult =
  | { status: 'pending' }
  | { status: 'lost' }
  | { status: 'terminal'; reason: 'disabled' | 'expired' | 'failed' | 'inactive' | 'revoked' }
  | { status: 'connected'; account: ConnectionAccount };

export async function pollManagedAuthorizationFlow(
  dependencies: ManagedAuthorizationFlowDependencies,
  input: {
    principal: AuthPrincipal;
    agent: CustomAgentConfig;
    workspaceId: string;
    browserSecret: string;
    attemptScopeId?: string;
    /** Atomically records the completed setup after the account is ready. */
    commit?: (account: ConnectionAccount) => Promise<boolean>;
  },
): Promise<PollManagedAuthorizationFlowResult> {
  let cleanupAttempt: ManagedAuthorizationAttempt | undefined;
  let cleanupService: ConnectionAccountService | undefined;
  let cleanupProvider: ManagedConnectionProvider | undefined;
  let remoteAccountObserved = false;
  let accountMutation:
    | { kind: 'created'; accountId: string }
    | { kind: 'replaced'; previous: ConnectionAccount; currentRevision: number }
    | undefined;
  try {
    let attempt = await inspectManagedAuthorization({
      settings: dependencies.settings,
      actorMembershipId: input.principal.membershipId,
      ...(input.attemptScopeId ? { attemptScopeId: input.attemptScopeId } : {}),
      browserSecret: input.browserSecret,
    });
    cleanupAttempt = attempt;
    if (attempt.workspaceId !== input.workspaceId) throw new AuthorizationError();
    if (attempt.agentId !== input.agent.id || !attempt.authorizationRef) {
      throw new ManagedAuthorizationError('invalid');
    }
    const providerContext = dependencies.providerContext;
    assertManagedAuthorizationProvider(attempt, providerContext);
    const provider = providerContext.providers.get(attempt.adapterId);
    if (!provider?.pollAuthorization) {
      throw new ManagedConnectionProviderUnavailableError(attempt.adapterId);
    }
    cleanupProvider = provider;
    const result = await provider.pollAuthorization({
      authorizationRef: attempt.authorizationRef,
      principalRef: attempt.principalRef,
      toolkit: attempt.toolkit,
    });
    if (result.status === 'pending') return { status: 'pending' };
    const service = connectionAccounts(dependencies);
    if (result.status === 'terminal') {
      const remoteRef = managedAuthorizationRemoteRef(attempt);
      if (remoteRef && !await service.hasManagedRemoteRef({
        adapterId: attempt.adapterId,
        accountRef: remoteRef,
      })) {
        if (provider.cleanupRemoteAccount) {
          await provider.cleanupRemoteAccount({ accountRef: remoteRef });
        } else {
          await provider.revoke({ policy: managedPolicy(attempt, remoteRef) });
        }
      }
      await abandonManagedAuthorization({
        settings: dependencies.settings,
        actorMembershipId: input.principal.membershipId,
        ...(input.attemptScopeId ? { attemptScopeId: input.attemptScopeId } : {}),
        browserSecret: input.browserSecret,
      });
      return { status: 'terminal', reason: result.reason };
    }
    remoteAccountObserved = true;
    attempt = await recordManagedAuthorizationAccount({
      settings: dependencies.settings,
      actorMembershipId: input.principal.membershipId,
      ...(input.attemptScopeId ? { attemptScopeId: input.attemptScopeId } : {}),
      browserSecret: input.browserSecret,
      accountRef: result.accountRef,
      toolkit: result.toolkit,
    });
    cleanupAttempt = attempt;
    assertManagedAuthorizationProvider(attempt, providerContext);
    cleanupService = service;
    if (!attempt.connectionAccountId) {
      await service.assertManagedLaneAvailable({
        principal: input.principal,
        agentId: input.agent.id,
        ownerKind: attempt.ownerKind,
        adapterId: attempt.adapterId,
        toolkit: attempt.toolkit,
      });
    }
    const imported = await service.findManagedByRemoteRef({
      principal: input.principal,
      workspaceId: attempt.workspaceId,
      adapterId: attempt.adapterId,
      accountRef: attempt.accountRef!,
    });
    let account: ConnectionAccount;
    let scheduleResumeDeferred = false;
    if (attempt.connectionAccountId) {
      const current = await service.getForManagement(input.principal, attempt.connectionAccountId);
      if (current.policy.kind !== 'managed') throw new ManagedAuthorizationError('invalid');
      account = await service.replaceManagedAuthorization({
        principal: input.principal,
        connectionAccountId: current.id,
        expectedRevision: current.revision,
        adapterId: attempt.adapterId,
        toolkit: attempt.toolkit,
        principalRef: attempt.principalRef,
        expectedAllowedCapabilities: attempt.allowedCapabilities,
        allowedCapabilities: attempt.allowedCapabilities,
        accountRef: attempt.accountRef!,
        providerGeneration: providerContext.generation,
        providerLineage: providerContext.lineage,
      });
    } else if (imported) {
      if (imported.policy.kind !== 'managed') throw new ManagedAuthorizationError('replayed');
      account = await service.replaceManagedAuthorization({
        principal: input.principal,
        connectionAccountId: imported.id,
        expectedRevision: imported.revision,
        adapterId: attempt.adapterId,
        toolkit: attempt.toolkit,
        principalRef: attempt.principalRef,
        expectedAllowedCapabilities: imported.policy.allowedCapabilities,
        allowedCapabilities: [...new Set([
          ...imported.policy.allowedCapabilities,
          ...attempt.allowedCapabilities,
        ])],
        accountRef: attempt.accountRef!,
        providerGeneration: providerContext.generation,
        providerLineage: providerContext.lineage,
        deferScheduleResume: true,
      });
      scheduleResumeDeferred = true;
      accountMutation = { kind: 'replaced', previous: imported, currentRevision: account.revision };
    } else {
      account = await service.create({
        principal: input.principal,
        workspaceId: attempt.workspaceId,
        ownerKind: attempt.ownerKind,
        providerId: attempt.providerId,
        label: attempt.label,
        policy: {
          kind: 'managed',
          adapterId: attempt.adapterId,
          toolkit: attempt.toolkit,
          principalRef: attempt.principalRef,
          accountRef: attempt.accountRef!,
          allowedCapabilities: [...attempt.allowedCapabilities],
          providerGeneration: providerContext.generation,
          providerLineage: providerContext.lineage,
        },
      });
      accountMutation = { kind: 'created', accountId: account.id };
    }
    if (!attempt.connectionAccountId) {
      if (!attempt.bindingCapabilities) throw new ManagedAuthorizationError('invalid');
      await service.attach({
        principal: input.principal,
        agentId: input.agent.id,
        connectionAccountId: account.id,
        allowedCapabilities: [...attempt.bindingCapabilities],
      });
      if (scheduleResumeDeferred) {
        await service.resumeManagedAccountSchedules({
          principal: input.principal,
          connectionAccountId: account.id,
        });
      }
    }
    if (input.commit && !await input.commit(account)) {
      throw new ManagedSetupCompletionLostError();
    }
    accountMutation = undefined;
    try {
      await finalizeManagedAuthorization({
        settings: dependencies.settings,
        actorMembershipId: input.principal.membershipId,
        ...(input.attemptScopeId ? { attemptScopeId: input.attemptScopeId } : {}),
        browserSecret: input.browserSecret,
      });
    } catch {
      console.warn(JSON.stringify({
        event: 'chickpea.managed_connection.finalization_deferred',
        adapterId: attempt.adapterId,
        toolkit: attempt.toolkit,
      }));
    }
    return { status: 'connected', account };
  } catch (error) {
    if (error instanceof ManagedProviderRequestError && error.metadata.definiteFailure !== true) {
      throw error;
    }
    if (!remoteAccountObserved && accountMutation === undefined) throw error;
    let cleanupComplete = true;
    let remoteIdentitySafe = false;
    if (accountMutation?.kind === 'created' && cleanupService) {
      try {
        await cleanupService.revoke({
          principal: input.principal,
          connectionAccountId: accountMutation.accountId,
        });
        remoteIdentitySafe = true;
      } catch {
        cleanupComplete = false;
      }
    } else if (accountMutation?.kind === 'replaced') {
      try {
        await dependencies.config.putConnectionAccount(
          accountMutation.previous,
          accountMutation.currentRevision,
        );
        remoteIdentitySafe = true;
      } catch {
        cleanupComplete = false;
      }
    }
    const remoteRef = cleanupAttempt && managedAuthorizationRemoteRef(cleanupAttempt);
    if (!remoteIdentitySafe && cleanupComplete && remoteRef && cleanupService) {
      try {
        if (await cleanupService.hasManagedRemoteRef({
          adapterId: cleanupAttempt!.adapterId,
          accountRef: remoteRef,
        })) {
          remoteIdentitySafe = true;
        } else if (cleanupProvider?.cleanupRemoteAccount) {
          await cleanupProvider.cleanupRemoteAccount({ accountRef: remoteRef });
          remoteIdentitySafe = true;
        } else if (cleanupProvider) {
          await cleanupProvider.revoke({
            policy: managedPolicy(cleanupAttempt!, remoteRef),
          });
          remoteIdentitySafe = true;
        } else {
          cleanupComplete = false;
        }
      } catch {
        cleanupComplete = false;
      }
    }
    if (cleanupComplete && remoteIdentitySafe) {
      try {
        await abandonManagedAuthorizationForRestart({
          settings: dependencies.settings,
          actorMembershipId: input.principal.membershipId,
          ...(input.attemptScopeId ? { attemptScopeId: input.attemptScopeId } : {}),
          browserSecret: input.browserSecret,
        });
      } catch {
        cleanupComplete = false;
      }
    }
    if (!cleanupComplete) {
      console.error(JSON.stringify({
        event: 'chickpea.managed_connection.poll_cleanup_failed',
        adapterId: cleanupAttempt?.adapterId ?? 'composio',
      }));
      throw error;
    }
    if (error instanceof ManagedSetupCompletionLostError ||
        error instanceof ManagedConnectionConflictError) {
      return { status: 'lost' };
    }
    if (error instanceof ManagedProviderRequestError && error.metadata.definiteFailure === true) {
      return { status: 'terminal', reason: 'failed' };
    }
    if (error instanceof AuthorizationError ||
        error instanceof ManagedConnectionProviderUnavailableError ||
        error instanceof ManagedAuthorizationError) {
      throw error;
    }
    throw new ManagedAuthorizationError('invalid');
  }
}

/** Cancel only this member's setup attempt and make its remote request safe. */
export async function cancelManagedAuthorizationFlow(
  dependencies: ManagedAuthorizationFlowDependencies,
  input: {
    principal: AuthPrincipal;
    browserSecret: string;
    attemptScopeId: string;
  },
): Promise<'none' | 'discarded' | 'committed'> {
  let attempt: ManagedAuthorizationAttempt;
  try {
    attempt = await inspectManagedAuthorizationForCleanup({
      settings: dependencies.settings,
      actorMembershipId: input.principal.membershipId,
      attemptScopeId: input.attemptScopeId,
      browserSecret: input.browserSecret,
    });
  } catch (error) {
    if (error instanceof ManagedAuthorizationError &&
        (error.code === 'invalid' || error.code === 'replayed')) return 'none';
    throw error;
  }
  const service = connectionAccounts(dependencies);
  const remoteRef = managedAuthorizationRemoteRef(attempt);
  const committed = remoteRef ? await service.hasManagedRemoteRef({
    adapterId: attempt.adapterId,
    accountRef: remoteRef,
  }) : false;
  if (remoteRef && !committed) {
    const provider = dependencies.providerContext.providers.get(attempt.adapterId);
    if (!provider) throw new ManagedConnectionProviderUnavailableError(attempt.adapterId);
    if (provider.cleanupRemoteAccount) {
      await provider.cleanupRemoteAccount({ accountRef: remoteRef });
    } else {
      await provider.revoke({ policy: managedPolicy(attempt, remoteRef) });
    }
  }
  await abandonManagedAuthorizationForRestart({
    settings: dependencies.settings,
    actorMembershipId: input.principal.membershipId,
    attemptScopeId: input.attemptScopeId,
    browserSecret: input.browserSecret,
  });
  return committed ? 'committed' : 'discarded';
}

export function managedPrincipalRef(
  principal: AuthPrincipal,
  ownerKind: 'team' | 'member',
): string | undefined {
  const value = ownerKind === 'member'
    ? `chickpea:membership:${principal.membershipId}`
    : `chickpea:organization:${principal.organizationId}`;
  return value.length <= MAX_MANAGED_PRINCIPAL_REF_LENGTH ? value : undefined;
}

export function managedAuthorizationRemoteRef(
  attempt: ManagedAuthorizationAttempt,
): string | undefined {
  return attempt.accountRef ?? attempt.authorizationRef;
}

function connectionAccounts(
  dependencies: ManagedAuthorizationFlowDependencies,
): ConnectionAccountService {
  return new ConnectionAccountService({
    config: dependencies.config,
    settings: dependencies.settings,
    managedProviders: dependencies.providerContext.providers,
    managedCatalog: dependencies.catalog,
  });
}

function frozenCapabilities(
  frozen: readonly string[],
  liveLane: readonly string[],
): string[] {
  const unique = new Set(frozen);
  const allowed = new Set(liveLane);
  if (frozen.length === 0 || unique.size !== frozen.length ||
      frozen.some((capability) => !allowed.has(capability))) {
    throw new Error('target_changed');
  }
  return [...frozen];
}

async function replacementAccount(
  dependencies: ManagedAuthorizationFlowDependencies,
  service: ConnectionAccountService,
  input: StartManagedAuthorizationFlowInput & { connectionAccountId: string },
): Promise<ConnectionAccount> {
  const account = await service.getForManagement(input.principal, input.connectionAccountId);
  const binding = (await dependencies.config.listAgentConnectionBindings(input.agent.id)).find(
    (candidate) => candidate.connectionAccountId === account.id,
  );
  if (!binding) throw new AuthorizationError();
  return account;
}

async function cleanupExistingAttempt(
  dependencies: ManagedAuthorizationFlowDependencies,
  service: ConnectionAccountService,
  actorMembershipId: string,
  existingBrowserSecret: string | undefined,
  attemptScopeId: string | undefined,
): Promise<void> {
  if (existingBrowserSecret) {
    let existingAttempt: ManagedAuthorizationAttempt | undefined;
    try {
      existingAttempt = await inspectManagedAuthorizationForCleanup({
        settings: dependencies.settings,
        actorMembershipId,
        ...(attemptScopeId ? { attemptScopeId } : {}),
        browserSecret: existingBrowserSecret,
      });
    } catch {
      // A malformed or foreign secret cannot cancel another browser's attempt.
    }
    const existingRemoteRef = existingAttempt
      ? managedAuthorizationRemoteRef(existingAttempt)
      : undefined;
    if (existingAttempt && existingRemoteRef && !await service.hasManagedRemoteRef({
      adapterId: existingAttempt.adapterId,
      accountRef: existingRemoteRef,
    })) {
      const provider = dependencies.providerContext.providers.get(existingAttempt.adapterId);
      if (!provider) throw new ManagedConnectionProviderUnavailableError(existingAttempt.adapterId);
      await provider.revoke({ policy: managedPolicy(existingAttempt, existingRemoteRef) });
    }
    if (existingAttempt) {
      await abandonManagedAuthorizationForRestart({
        settings: dependencies.settings,
        actorMembershipId,
        ...(attemptScopeId ? { attemptScopeId } : {}),
        browserSecret: existingBrowserSecret,
      });
    }
  }
  // Reusable setup claims have independent slots. Never inspect or clean the
  // member-wide legacy slot while starting one of those scoped attempts.
  if (attemptScopeId) return;
  let staleAttempt: ManagedAuthorizationAttempt | undefined;
  try {
    staleAttempt = await inspectStaleManagedAuthorization({
      settings: dependencies.settings,
      actorMembershipId,
    });
  } catch (error) {
    if (!(error instanceof ManagedAuthorizationError && error.code === 'invalid')) throw error;
  }
  const staleRemoteRef = staleAttempt ? managedAuthorizationRemoteRef(staleAttempt) : undefined;
  if (staleAttempt && staleRemoteRef && !await service.hasManagedRemoteRef({
    adapterId: staleAttempt.adapterId,
    accountRef: staleRemoteRef,
  })) {
    const provider = dependencies.providerContext.providers.get(staleAttempt.adapterId);
    if (!provider) throw new ManagedConnectionProviderUnavailableError(staleAttempt.adapterId);
    await provider.revoke({ policy: managedPolicy(staleAttempt, staleRemoteRef) });
  }
  if (staleAttempt) {
    await abandonStaleManagedAuthorization({
      settings: dependencies.settings,
      actorMembershipId,
    });
  }
}

async function cleanupFailedStart(input: {
  dependencies: ManagedAuthorizationFlowDependencies;
  startedAttempt: Awaited<ReturnType<typeof beginManagedAuthorization>>;
  startedAuthorizationRef?: string;
  startedAuthorizationRecorded: boolean;
}): Promise<void> {
  let recorded = input.startedAuthorizationRecorded;
  let remoteCleanupComplete = true;
  if (input.startedAuthorizationRef && !recorded) {
    try {
      await recordManagedAuthorizationRequest({
        settings: input.dependencies.settings,
        actorMembershipId: input.startedAttempt.attempt.actorMembershipId,
        ...(input.startedAttempt.attempt.attemptScopeId
          ? { attemptScopeId: input.startedAttempt.attempt.attemptScopeId }
          : {}),
        browserSecret: input.startedAttempt.browserSecret,
        authorizationRef: input.startedAuthorizationRef,
      });
      recorded = true;
    } catch {
      console.error(JSON.stringify({
        event: 'chickpea.managed_connection.authorization_start_reference_persist_failed',
        adapterId: input.startedAttempt.attempt.adapterId,
      }));
    }
  }
  if (input.startedAuthorizationRef) {
    try {
      const provider = input.dependencies.providerContext.providers
        .get(input.startedAttempt.attempt.adapterId);
      if (!provider) throw new Error('managed provider is unavailable');
      await provider.revoke({
        policy: managedPolicy(input.startedAttempt.attempt, input.startedAuthorizationRef),
      });
    } catch {
      remoteCleanupComplete = false;
      console.error(JSON.stringify({
        event: 'chickpea.managed_connection.authorization_start_remote_cleanup_failed',
        adapterId: input.startedAttempt.attempt.adapterId,
      }));
    }
  }
  try {
    if (remoteCleanupComplete) {
      await abandonManagedAuthorization({
        settings: input.dependencies.settings,
        actorMembershipId: input.startedAttempt.attempt.actorMembershipId,
        ...(input.startedAttempt.attempt.attemptScopeId
          ? { attemptScopeId: input.startedAttempt.attempt.attemptScopeId }
          : {}),
        browserSecret: input.startedAttempt.browserSecret,
      });
    }
  } catch {
    console.error(JSON.stringify({
      event: 'chickpea.managed_connection.authorization_start_cleanup_failed',
      adapterId: input.startedAttempt.attempt.adapterId,
    }));
  }
}

function managedPolicy(attempt: ManagedAuthorizationAttempt, accountRef: string) {
  return {
    kind: 'managed' as const,
    adapterId: attempt.adapterId,
    toolkit: attempt.toolkit,
    principalRef: attempt.principalRef,
    accountRef,
    allowedCapabilities: [...attempt.allowedCapabilities],
  };
}
