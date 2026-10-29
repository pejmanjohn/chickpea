import { isRecord } from '../security/content-validation.ts';
import { sha256Hex } from '../security/digest.ts';
import type { AuthPrincipal } from '../auth/types.ts';
import { canEditAgent, canManageOwnedResource, requirePermission, AuthorizationError } from '../auth/permissions.ts';
import {
  finishConnectorSecretCleanup,
  saveConnectionAccountSecret,
  stageConnectorSettingCleanup,
  tombstoneConnectionAccountSecret,
} from '../config/connector-secrets.ts';
import {
  apiOAuthSettingKeys,
  connectionAccountIdFromOAuthRef,
  connectionAccountOAuthRef,
  deleteApiOAuthSettings,
} from '../config/api-oauth.ts';
import { deleteMcpOAuthSettings, mcpOAuthSettingKeys } from '../config/mcp-oauth.ts';
import { finishMcpSecretCleanup, stageMcpSecretCleanup } from '../config/mcp-secrets.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { ConfigStore } from '../config/store.ts';
import {
  AgentRevisionConflictError,
  AgentStillReferencedError,
  ConnectionAccountRevisionConflictError,
  ManagedRemoteAccountAlreadyUsedError,
  ManagedSignInGroupConflictError,
} from '../config/errors.ts';
import { signInGroupKey, signInGroupPolicy } from '../config/sign-in-group.ts';
import type {
  AgentConnectionBinding,
  AgentScheduleReference,
  ConnectionAccount,
  ConnectionAccountApiPolicy,
  ConnectionAccountInput,
  ConnectionAccountManagedPolicy,
  ConnectionAccountMcpPolicy,
  ConnectionAccountPolicy,
  ManagedAccountResourceConstraints,
  ManagedBindingResourceConstraints,
  ManagedResourceSelection,
  ManagedSignIn,
  McpConnectionIdentity,
} from '../config/types.ts';
import { MAX_MANAGED_RESOURCE_SELECTIONS_PER_KEY } from '../config/types.ts';
import type { ConnectionAccountView } from './types.ts';
import type { ProductTelemetryCapture } from '../telemetry/client.ts';
import { sameMcpServerUrl } from '../config/mcp-url.ts';
import type {
  ManagedConnectionProviderRegistry,
  ManagedConnectionValidationResult,
  ManagedPageListing,
} from './managed.ts';
import {
  MANAGED_CONNECTOR_CATALOG,
  type ManagedAccessLane,
  type ManagedConnectorCatalog,
  type ManagedConnectorDefinition,
  intersectManagedResourceConstraints,
  managedAccessLane,
  projectManagedResourceHandles,
} from './catalog/index.ts';
import {
  projectEffectiveConnectionAccounts,
  projectRecoverableConnectionAccounts,
} from './runtime.ts';
import {
  MAX_NOTION_PAGES,
  NOTION_PAGES_KEY,
  agentPageScope,
  pageRoots,
  parseNotionId,
  readAgentPageChoice,
  writeAgentPageChoice,
  notionPageHandle,
  type NotionId,
  type NotionListedPage,
  type NotionPageListing,
} from './notion-pages.ts';
import { ManagedSignInMixError, signInMix, signInMixRefusal, signInSigner } from './sign-in-mix.ts';
import { managedPrincipalRef } from './managed-principal.ts';

export interface ConnectionAccountServiceDependencies {
  config: ConfigStore;
  settings: SettingsStore;
  managedProviders?: ManagedConnectionProviderRegistry;
  managedCatalog?: ManagedConnectorCatalog;
  randomId?: () => string;
  productTelemetry?: ProductTelemetryCapture;
  telemetrySurface?: 'admin' | 'slack' | 'mcp' | 'other';
  /** The env the request runs in; it names the actor's remote principal. */
  platformEnv?: PlatformEnv;
}

/** A page an Agent may choose, as the browser sees it. */
export interface ChoosablePage {
  handle: string;
  kind: 'page' | 'database';
  label: string;
}

/** "All pages", or only the pages a choice names by handle. */
export type AgentPageChoice = { mode: 'all' } | { mode: 'only'; pages: readonly string[] };

/** A sign-in another Agent may use without signing in again. */
export interface ReusableSignIn {
  sourceConnectionId: string;
  /** The display name of whoever signed in, when Chickpea knows it. */
  signerName?: string;
  signedByYou: boolean;
  pages: ChoosablePage[];
  /** False when Notion had more pages than Chickpea lists. */
  complete: boolean;
  /** The Agents already using it. Only Owners and Admins may see their names. */
  agentIds: string[];
}

export class ManagedConnectionConflictError extends Error {
  readonly name = 'ManagedConnectionConflictError';
}

export class ConnectionScheduleConflictError extends Error {
  readonly name = 'ConnectionScheduleConflictError';
}

export class ConnectionCredentialEntryUnavailableError extends Error {
  readonly name = 'ConnectionCredentialEntryUnavailableError';
}

/**
 * Browser-safe projection shared by every Admin response carrying an account.
 * A page-scoped connector's grant titles are limited to the pages `binding`'s
 * Agent may reach; without its binding, none are sent. Page ids are never sent.
 */
export function toConnectionAccountView(
  account: ConnectionAccount,
  binding?: AgentConnectionBinding,
): ConnectionAccountView {
  const { secretRefId: _secretRefId, policy, ...safeAccount } = account;
  if (policy.kind !== 'managed') {
    return {
      ...safeAccount,
      policy,
      credentialConfigured: account.lifecycle === 'ready',
    };
  }
  // Name each field sent, so a new policy field never reaches the browser by spread.
  const {
    kind, adapterId, toolkit, allowedCapabilities, grantSummary, oauthAttemptId, resourceConstraints,
  } = policy;
  const pageScoped = MANAGED_CONNECTOR_CATALOG.connector(toolkit)?.pageScope !== undefined;
  const scope = binding && agentPageScope(binding.resourceConstraints);
  const shown = (raw: string | undefined): boolean => {
    if (!pageScoped) return true;
    if (!binding) return false;
    const id = parseNotionId(raw);
    return !scope || (id !== undefined && scope.allow.has(id));
  };
  return {
    ...safeAccount,
    policy: {
      kind,
      adapterId,
      toolkit,
      allowedCapabilities,
      ...(grantSummary
        ? {
            grantSummary: {
              items: grantSummary.items.filter(({ id }) => shown(id)).map(({ type, label }) => ({ type, label })),
              truncated: grantSummary.truncated,
            },
          }
        : {}),
      ...(oauthAttemptId ? { oauthAttemptId } : {}),
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

/** A binding as the browser sees it, without the Agent's chosen Notion pages. */
export function toAgentConnectionBindingView(binding: AgentConnectionBinding): AgentConnectionBinding {
  if (binding.resourceConstraints?.[NOTION_PAGES_KEY] === undefined) return binding;
  return { ...binding, resourceConstraints: writeAgentPageChoice(binding.resourceConstraints, undefined) };
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

/** The account is revoked, but its OAuth settings remain. Revoking again finishes the cleanup. */
export class ConnectionOAuthCleanupError extends Error {
  readonly name = 'ConnectionOAuthCleanupError';

  constructor(cause: unknown) {
    super('The connection is disconnected, but its stored sign-in remains. Retry to finish cleanup.', { cause });
  }
}

/**
 * After a revoke, a connection's OAuth settings (its client registration,
 * pending authorization and tokens) are deleted behind a durable cleanup
 * marker, so a retry after a failure finishes the job. Every revoke runs it,
 * as does a policy change that resets the credential.
 */
export async function deleteRevokedConnectionOAuthSettings(
  account: ConnectionAccount,
  env: PlatformEnv | undefined,
  settings: SettingsStore,
): Promise<void> {
  if (account.policy.kind === 'mcp' && account.policy.authMode === 'oauth') {
    const oauthRef = connectionAccountOAuthRef(account.id);
    await stageMcpSecretCleanup(oauthRef.agentId, mcpOAuthSettingKeys(oauthRef), settings);
    await deleteMcpOAuthSettings(oauthRef, settings);
    await finishMcpSecretCleanup(oauthRef.agentId, settings);
  } else if (account.policy.kind === 'api' && account.policy.authMode === 'oauth') {
    const oauthRef = connectionAccountOAuthRef(account.id);
    await stageConnectorSettingCleanup(oauthRef.agentId, apiOAuthSettingKeys(oauthRef), env, settings);
    await deleteApiOAuthSettings(oauthRef, settings);
    await finishConnectorSecretCleanup(oauthRef.agentId, env, settings);
  }
}

/** Whether a native account needs a stored credential or a sign-in before an Agent can use it. */
export function nativeCredentialRequired(
  policy: ConnectionAccountApiPolicy | ConnectionAccountMcpPolicy,
): boolean {
  return policy.kind === 'api' || policy.authMode !== 'none' ||
    (policy.credentialHeaderName !== undefined && policy.credentialOptional !== true);
}

export class ConnectionAccountService {
  constructor(private readonly dependencies: ConnectionAccountServiceDependencies) {}

  /**
   * Replace a native account's label and policy for the Agent it belongs to.
   * A policy whose credential no longer applies loses its stored credential
   * and OAuth tokens and waits for setup again.
   */
  async updateForAgent(input: {
    principal: AuthPrincipal;
    agentId: string;
    connectionAccountId: string;
    expectedRevision: number;
    label: string;
    policy: ConnectionAccountApiPolicy | ConnectionAccountMcpPolicy;
    identity?: McpConnectionIdentity;
    resetCredential: boolean;
  }): Promise<ConnectionAccount> {
    const { account } = await this.requireAgentOwnedAccount(input);
    if (account.revision !== input.expectedRevision) {
      throw new ConnectionAccountRevisionConflictError(account.id, input.expectedRevision, account.revision);
    }
    if (account.policy.kind !== input.policy.kind || account.lifecycle === 'revoked') {
      throw new Error('Only a connected native account can change its policy');
    }
    if (input.resetCredential) {
      await tombstoneConnectionAccountSecret(account.secretRefId, undefined, this.dependencies.settings);
      await deleteRevokedConnectionOAuthSettings(account, undefined, this.dependencies.settings);
    }
    const { identity: _identity, ...withoutIdentity } = account;
    return this.dependencies.config.putConnectionAccount({
      ...withoutIdentity,
      label: input.label,
      policy: input.policy,
      ...(input.identity ? { identity: input.identity } : {}),
      lifecycle: !input.resetCredential
        ? account.lifecycle
        : nativeCredentialRequired(input.policy) ? 'pending' : 'ready',
    }, account.revision);
  }

  /**
   * Store the key a native account is waiting for and mark it ready, fenced on
   * the revision the caller read.
   */
  async setCredentialForAgent(input: {
    principal: AuthPrincipal;
    agentId: string;
    connectionAccountId: string;
    expectedRevision: number;
    credential: string;
  }): Promise<ConnectionAccount> {
    const { account, binding } = await this.requireAgentOwnedAccount(input);
    const { policy } = account;
    const awaitsCredential = account.lifecycle !== 'ready' && account.lifecycle !== 'revoked' && (
      policy.kind === 'api'
        ? policy.authMode === 'credential'
        : policy.kind === 'mcp' && policy.authMode !== 'oauth' &&
          (policy.authMode === 'bearer' || policy.credentialHeaderName !== undefined)
    );
    if (!awaitsCredential) {
      throw new ConnectionCredentialEntryUnavailableError(`Connection account ${account.id} is not waiting for a credential`);
    }
    if (account.revision !== input.expectedRevision) {
      throw new ConnectionAccountRevisionConflictError(account.id, input.expectedRevision, account.revision);
    }
    await saveConnectionAccountSecret(account.secretRefId, input.credential, undefined, this.dependencies.settings);
    let ready: ConnectionAccount;
    try {
      ready = await this.dependencies.config.putConnectionAccount({ ...account, lifecycle: 'ready' }, account.revision);
    } catch (error) {
      // After a lost revision race the slot may already hold another writer's key.
      if (!(error instanceof ConnectionAccountRevisionConflictError)) {
        await tombstoneConnectionAccountSecret(account.secretRefId, undefined, this.dependencies.settings)
          .catch((cleanupError: unknown) => {
            throw new AggregateError([error, cleanupError], 'Connection setup failed and its credential could not be removed');
          });
      }
      throw error;
    }
    this.captureConnectionReady(account.lifecycle, ready, binding);
    return ready;
  }

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
    /** A native account without its credential waits for a setup link (pending), not an Admin re-entry. */
    pendingSetup?: boolean;
    allowedCapabilities?: string[];
    resourceConstraints?: ManagedBindingResourceConstraints;
    /** The lane a managed sign-in's credential was issued on, when an authorization attempt made it. */
    issuedAccessLane?: ManagedAccessLane;
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
      const created = await this.dependencies.config.createAgentOwnedConnection({
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
      this.captureConnectionReady(undefined, created.account, created.binding);
      logSignInRecorded(created.account);
      return created;
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
    return Promise.all(accounts.map((account) => this.view(account)));
  }

  /** One account as the browser sees it, with the grant titles its Agent may reach; see toConnectionAccountView. */
  async view(account: ConnectionAccount): Promise<ConnectionAccountView> {
    const pageScoped = account.policy.kind === 'managed' &&
      this.catalog().connector(account.policy.toolkit)?.pageScope !== undefined;
    const binding = pageScoped
      ? await this.dependencies.config.getAgentConnectionBindingForAccount(account.id)
      : undefined;
    return toConnectionAccountView(account, binding);
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
    this.captureConnectionReady(account.lifecycle, updatedAccount, updatedBinding);
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

  /**
   * The sign-ins the actor may add `agentId` to as `ownerKind` without signing
   * in again: their own personal ones, or the team's for Owners and Admins,
   * each ready, covering `access`, and with its pages as this Agent may choose them.
   */
  async listReusableSignIns(input: {
    principal: AuthPrincipal;
    agentId: string;
    workspaceId: string;
    toolkit: string;
    ownerKind: 'team' | 'member';
    access: ManagedAccessLane;
    signerName?: (membershipId: string) => Promise<string | undefined>;
    signal?: AbortSignal;
  }): Promise<ReusableSignIn[]> {
    const connector = this.catalog().connector(input.toolkit);
    if (!connector?.sharedSignIn) return [];
    try {
      await this.assertManagedLaneAvailable({ ...input, adapterId: 'composio' });
    } catch (error) {
      if (error instanceof ManagedConnectionConflictError) return [];
      throw error;
    }
    const accounts = await this.dependencies.config.listConnectionAccounts(input.workspaceId);
    const reusable: ReusableSignIn[] = [];
    for (const group of signInGroups(accounts)) {
      const source = group[0]!;
      if (source.policy.kind !== 'managed' || source.policy.toolkit !== connector.toolkit ||
          this.reuseRefusal({ ...input, connector, source, group, accounts, needed: input.access })) continue;
      const { pages, complete } = await this.choosablePages(source.policy, input.signal);
      const signer = signInSigner(source);
      const signerName = signer ? await input.signerName?.(signer) : undefined;
      const bindings = await Promise.all(group.map(({ id }) =>
        this.dependencies.config.getAgentConnectionBindingForAccount(id)));
      reusable.push({
        sourceConnectionId: source.id,
        ...(signerName ? { signerName } : {}),
        signedByYou: signer === input.principal.membershipId,
        pages: pages.map(({ id: _id, ...page }) => page),
        complete,
        agentIds: bindings.flatMap((binding) => binding?.enabled ? [binding.agentId] : []),
      });
    }
    return reusable;
  }

  /**
   * Add `agentId` to an existing sign-in without asking the provider for a
   * new one. The new account's owner and principal come from the actor and
   * must equal the sign-in's; everything the sign-in shares, provider
   * generation and lineage included, is copied from it.
   */
  async reuseSignIn(input: {
    principal: AuthPrincipal;
    agentId: string;
    workspaceId: string;
    sourceConnectionId: string;
    ownerKind: 'team' | 'member';
    access: ManagedAccessLane;
    /** A setup link's frozen capability ceiling; otherwise every capability of `access`. */
    capabilities?: readonly string[];
    choice: AgentPageChoice;
    signal?: AbortSignal;
  }): Promise<{ account: ConnectionAccount; binding: AgentConnectionBinding }> {
    const requested = requestedPages(input.choice);
    let source: ConnectionAccount;
    try {
      source = await this.findAccount(input.sourceConnectionId);
    } catch {
      throw new AuthorizationError();
    }
    const connector = source.policy.kind === 'managed'
      ? this.catalog().connector(source.policy.toolkit)
      : undefined;
    if (source.policy.kind !== 'managed' || !connector?.sharedSignIn) throw new AuthorizationError();
    await this.assertManagedLaneAvailable({
      principal: input.principal,
      agentId: input.agentId,
      ownerKind: input.ownerKind,
      adapterId: source.policy.adapterId,
      toolkit: connector.toolkit,
    });
    const live = this.catalog().capabilities(connector.toolkit, input.access).map(({ id }) => id);
    const capabilities = input.capabilities ? [...input.capabilities] : live;
    if (capabilities.length === 0 || new Set(capabilities).size !== capabilities.length ||
        capabilities.some((capability) => !live.includes(capability))) {
      throw new ManagedResourceSelectionError('invalid', 'Requested capabilities are invalid');
    }
    const accounts = await this.dependencies.config.listConnectionAccounts(input.workspaceId);
    const group = await this.signInGroup(source);
    const refusal = this.reuseRefusal({
      ...input, connector, source, group, accounts, needed: managedAccessLane(connector, capabilities),
    });
    if (refusal) throw refusal;
    const policy = source.policy;
    const provider = this.dependencies.managedProviders?.get(policy.adapterId);
    if (!provider) throw new ManagedConnectionProviderUnavailableError(policy.adapterId);
    await provider.validate({ policy, ...(input.signal ? { signal: input.signal } : {}) });
    const chosen = requested && await this.chosenPages(policy, requested, input.signal);
    const id = `connection_${this.id()}`;
    const account: ConnectionAccountInput = {
      id,
      workspaceId: input.workspaceId,
      ownerKind: input.ownerKind,
      ...(input.ownerKind === 'member' ? { ownerMembershipId: input.principal.membershipId } : {}),
      createdByMembershipId: input.principal.membershipId,
      providerId: connector.providerId,
      label: `${connector.label} · ${input.ownerKind === 'team' ? 'Team' : 'Personal'}`,
      ...(source.identity ? { identity: source.identity } : {}),
      policy: {
        kind: 'managed',
        ...signInGroupPolicy(policy),
        principalRef: managedPrincipalRef(input.principal, input.ownerKind, this.dependencies.platformEnv)!,
        allowedCapabilities: capabilities,
      },
      secretRefId: `secret_${this.id()}`,
      lifecycle: 'ready',
    };
    let joined: ConnectionAccount[];
    try {
      joined = await this.dependencies.config.applySignInGroup({
        adapterId: policy.adapterId,
        accountRef: policy.accountRef,
        members: group.map((member) => ({ connectionAccountId: member.id, expectedRevision: member.revision })),
        shared: signInGroupPolicy(policy),
        join: {
          account,
          binding: {
            agentId: input.agentId,
            connectionAccountId: id,
            providerId: connector.providerId,
            allowedCapabilities: capabilities,
            resourceConstraints: writeAgentPageChoice(projectManagedResourceHandles(policy.resourceConstraints), chosen),
            enabled: true,
          },
        },
      });
    } catch (error) {
      if (error instanceof ManagedSignInGroupConflictError ||
          error instanceof ConnectionAccountRevisionConflictError ||
          error instanceof ManagedRemoteAccountAlreadyUsedError) {
        throw new ManagedConnectionConflictError('That sign-in changed while this Agent was being added');
      }
      throw error;
    }
    const created = joined.find((member) => member.id === id);
    const binding = await this.dependencies.config.getAgentConnectionBindingForAccount(id);
    if (!created || !binding) throw new ManagedConnectionConflictError('That sign-in changed while this Agent was being added');
    this.captureConnectionReady(undefined, created, binding);
    return { account: created, binding };
  }

  /** Why the actor cannot add an Agent to `source`'s sign-in as `ownerKind`; undefined when they can. */
  private reuseRefusal(input: {
    principal: AuthPrincipal;
    workspaceId: string;
    ownerKind: 'team' | 'member';
    needed: ManagedAccessLane;
    connector: ManagedConnectorDefinition;
    source: ConnectionAccount;
    group: readonly ConnectionAccount[];
    accounts: readonly ConnectionAccount[];
  }): Error | undefined {
    const { source, connector } = input;
    const principalRef = managedPrincipalRef(input.principal, input.ownerKind, this.dependencies.platformEnv);
    if (source.policy.kind !== 'managed' || source.lifecycle === 'revoked' ||
        source.workspaceId !== input.workspaceId || source.providerId !== connector.providerId ||
        source.policy.adapterId.trim().toLowerCase() !== 'composio' ||
        source.policy.toolkit !== connector.toolkit || source.ownerKind !== input.ownerKind ||
        !principalRef || source.policy.principalRef !== principalRef ||
        (input.ownerKind === 'member' && source.ownerMembershipId !== input.principal.membershipId)) {
      return new AuthorizationError();
    }
    if (input.group.some(({ lifecycle }) => lifecycle !== 'ready')) {
      return new ManagedConnectionConflictError('That sign-in needs attention before another Agent can use it');
    }
    const issued = source.policy.signIn?.accessLane ?? signInGroupAccessLane(connector, input.group);
    if (!laneCovers(issued, input.needed)) {
      return new ManagedConnectionConflictError('That sign-in does not cover the access this Agent needs');
    }
    // The sign-in's own signer stands in for the actor: it is their account that would back both kinds.
    const mix = signInMix({
      connector,
      adapterId: source.policy.adapterId,
      ownerKind: input.ownerKind,
      actorMembershipId: signInSigner(source) ?? input.principal.membershipId,
      person: source.policy.signIn?.person,
      accounts: input.accounts,
    });
    if (mix) {
      return new ManagedConnectionConflictError(
        `That ${connector.label} account is also used for a ${mix.account.ownerKind === 'team' ? 'team' : 'personal'} ` +
          `connection in this workspace, so another Agent can't use it.`,
      );
    }
    return undefined;
  }

  /** Preflight the one-Team/one-Personal lane invariant before remote import. */
  async assertManagedLaneAvailable(input: {
    principal: AuthPrincipal;
    agentId: string;
    ownerKind: 'team' | 'member';
    adapterId: string;
    toolkit: string;
  }): Promise<void> {
    requirePermission(
      input.principal,
      input.ownerKind === 'team' ? 'connection.create_team' : 'connection.create_personal',
    );
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

  /**
   * Revoke one account on the deployment's own authority, exactly as its
   * owner's revoke does, for a host's operator revoking an installation's
   * access (connections/hosted-revocation.ts). No principal is checked:
   * callers decide authority before calling.
   */
  async revokeWithSystemAuthority(connectionAccountId: string): Promise<ConnectionAccount> {
    return this.revokeOwnedAccount(await this.findAccount(connectionAccountId));
  }

  private async revokeOwnedAccount(account: ConnectionAccount): Promise<ConnectionAccount> {
    if (account.lifecycle === 'revoked') {
      try {
        await markRevokedConnectionDependencies(
          this.dependencies.config,
          account.id,
        );
      } catch {
        throw new ConnectionScheduleConflictError(
          'The connection is disconnected, but dependent schedules changed. Retry to finish cleanup.',
        );
      }
      await this.deleteOAuthSettings(account);
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
    let revoked: ConnectionAccount | undefined;
    if (account.policy.kind === 'managed') {
      // Another Agent's account still uses this sign-in: revoke only this one
      // and keep the remote account. Exactly one of two concurrent
      // disconnects sees the last reference.
      const release = await this.dependencies.config.releaseSignInReference({
        connectionAccountId: account.id,
        expectedRevision: needsAttention.revision,
      });
      if (release.kind === 'released') {
        revoked = release.account;
      } else {
        const provider = this.dependencies.managedProviders?.get(account.policy.adapterId);
        if (!provider) {
          throw new ManagedConnectionProviderUnavailableError(account.policy.adapterId);
        }
        await provider.revoke({ policy: account.policy });
      }
    }
    await tombstoneConnectionAccountSecret(
      account.secretRefId,
      undefined,
      this.dependencies.settings,
    );
    revoked ??= await this.dependencies.config.putConnectionAccount(
      { ...needsAttention, lifecycle: 'revoked' },
      needsAttention.revision,
    );
    try {
      await markRevokedConnectionDependencies(
        this.dependencies.config,
        account.id,
        scheduleIndex,
      );
    } catch {
      throw new ConnectionScheduleConflictError(
        'The connection is disconnected, but dependent schedules changed. Retry to finish cleanup.',
      );
    }
    await this.deleteOAuthSettings(revoked);
    return revoked;
  }

  private async deleteOAuthSettings(account: ConnectionAccount): Promise<void> {
    try {
      await deleteRevokedConnectionOAuthSettings(account, undefined, this.dependencies.settings);
    } catch (cause) {
      throw new ConnectionOAuthCleanupError(cause);
    }
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
    expectedCredentialIncarnation: string;
  }): Promise<ConnectionAccount[]> {
    const agent = await this.dependencies.config.getAgent(input.agentId);
    if (!canEditAgent(input.principal, agent)) throw new AuthorizationError();
    if (agent.revision !== input.expectedRevision ||
        agent.credentialIncarnation !== input.expectedCredentialIncarnation) {
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
    const ownedAccounts: ConnectionAccount[] = [];
    for (const binding of bindings) {
      const currentBinding = await this.dependencies.config.getAgentConnectionBindingForAccount(
        binding.connectionAccountId,
      );
      if (currentBinding?.agentId !== input.agentId) throw new AuthorizationError();
      const account = await this.findAccount(binding.connectionAccountId);
      // Agent deletion must not turn edit access into authority over a Team
      // connection after its creator has been demoted. Preflight every Team
      // account before revoking anything so a denial cannot leave partial
      // cleanup behind.
      if (account.ownerKind === 'team') {
        requirePermission(input.principal, 'connection.create_team');
      }
      ownedAccounts.push(account);
    }
    const revoked: ConnectionAccount[] = [];
    for (const account of ownedAccounts) {
      revoked.push(await this.revokeOwnedAccount(account));
    }
    return revoked;
  }

  /** A live account holding this remote account; the one a completed attempt created, when several share it. */
  async findManagedByRemoteRef(input: {
    principal: AuthPrincipal;
    workspaceId: string;
    adapterId: string;
    accountRef: string;
    oauthAttemptId?: string;
  }): Promise<ConnectionAccount | undefined> {
    const normalizedAdapterId = input.adapterId.trim().toLowerCase();
    const holders = (await this.dependencies.config.listConnectionAccounts(input.workspaceId))
      .filter((candidate) => candidate.lifecycle !== 'revoked' &&
        candidate.policy.kind === 'managed' &&
        candidate.policy.adapterId.trim().toLowerCase() === normalizedAdapterId &&
        candidate.policy.accountRef === input.accountRef);
    const account = holders.find(({ policy }) => input.oauthAttemptId !== undefined &&
      policy.kind === 'managed' && policy.oauthAttemptId === input.oauthAttemptId) ?? holders[0];
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

  /**
   * Replace an expired provider authorization without changing Chickpea
   * bindings. Every account sharing the sign-in moves to the new remote
   * account together; the previous one is revoked once.
   */
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
    /** The lane the new credential was issued on. */
    issuedAccessLane: ManagedAccessLane;
    providerGeneration?: number;
    providerLineage?: string;
  }): Promise<ConnectionAccount> {
    const { account, binding } = await this.requireAgentOwnedAccount(input);
    const previous = account.policy;
    if (account.revision !== input.expectedRevision || account.lifecycle === 'revoked' ||
        previous.kind !== 'managed' ||
        previous.adapterId.trim().toLowerCase() !== input.adapterId.trim().toLowerCase() ||
        previous.toolkit !== input.toolkit ||
        previous.principalRef !== input.principalRef ||
        !sameStringSet(
          previous.allowedCapabilities,
          input.expectedAllowedCapabilities ?? input.allowedCapabilities,
        )) {
      throw new ManagedConnectionConflictError('Managed connection changed during authorization');
    }
    const group = await this.signInGroup(account);
    for (const member of group) this.requireManage(input.principal, member);
    await this.requireUniqueManagedAccount(input.adapterId, input.accountRef, group.map(({ id }) => id));
    const provider = this.dependencies.managedProviders?.get(input.adapterId);
    if (!provider) {
      throw new Error(`Managed connection provider ${input.adapterId} is unavailable`);
    }
    const connector = this.catalog().connector(previous.toolkit);
    if (!connector) throw new Error('Managed connection connector is unavailable');
    const candidate: ConnectionAccountManagedPolicy = {
      ...previous,
      accountRef: input.accountRef,
      allowedCapabilities: [...input.allowedCapabilities],
      ...(input.providerGeneration !== undefined
        ? { providerGeneration: input.providerGeneration }
        : {}),
      ...(input.providerLineage !== undefined
        ? { providerLineage: input.providerLineage }
        : {}),
    };
    // A sibling may have joined with write access after this sign-in began on read.
    const needed = signInGroupAccessLane(connector, group.map((member) =>
      member.id === account.id ? { ...member, policy: candidate } : member));
    if (!laneCovers(input.issuedAccessLane, needed)) {
      throw new ManagedConnectionConflictError('The sign-in does not cover the access this connection needs now');
    }
    const validation = await provider.validate({ policy: candidate });
    const policy: ConnectionAccountManagedPolicy = {
      ...applyManagedValidation(candidate, validation),
      signIn: managedSignIn(connector, input.issuedAccessLane, validation, input.principal.membershipId),
    };
    await this.refuseSignInMix({
      principal: input.principal,
      workspaceId: account.workspaceId,
      ownerKind: account.ownerKind,
      connector,
      policy,
    });
    const lifecycle = connector.resources?.some((resource) =>
      resource.required && !(policy.resourceConstraints?.[resource.key]?.length)
    ) ? 'pending' as const : 'ready' as const;
    let rotated: ConnectionAccount[];
    try {
      rotated = await this.dependencies.config.applySignInGroup({
        adapterId: previous.adapterId,
        accountRef: previous.accountRef,
        members: group.map(({ id, revision }) => ({
          connectionAccountId: id,
          expectedRevision: revision,
          ...(id === account.id ? { allowedCapabilities: [...input.allowedCapabilities] } : {}),
        })),
        shared: signInGroupPolicy(policy),
        lifecycle,
      });
    } catch (error) {
      if (error instanceof ManagedSignInGroupConflictError) {
        throw new ManagedConnectionConflictError('Managed connection changed during authorization');
      }
      throw error;
    }
    const replaced = rotated.find(({ id }) => id === account.id);
    if (!replaced) throw new ManagedConnectionConflictError('Managed connection changed during authorization');
    this.captureConnectionReady(account.lifecycle, replaced, binding);
    logSignInRecorded(replaced);
    const pages = connector.pageScope && validation?.pages && parsePageListing(validation.pages);
    if (pages) await this.prunePageChoices(rotated, pages);
    if (previous.accountRef !== policy.accountRef) {
      try {
        await provider.revoke({ policy: previous });
      } catch {
        console.warn(JSON.stringify({
          event: 'chickpea.managed_connection.previous_authorization_cleanup_failed',
          adapterId: previous.adapterId,
          connectionAccountId: account.id,
        }));
      }
    }
    if (lifecycle === 'ready') {
      for (const member of rotated) {
        try {
          await resumeDependentSchedules(this.dependencies.config, member.id);
        } catch {
          console.warn(JSON.stringify({
            event: 'chickpea.managed_connection.schedule_resume_deferred',
            connectionAccountId: member.id,
          }));
        }
      }
    }
    return replaced;
  }

  /**
   * The pages a Notion connection's sign-in reaches now, as one Agent sees
   * them: whether the Agent is limited, and which pages it has chosen.
   */
  async agentPages(input: {
    principal: AuthPrincipal;
    agentId: string;
    connectionAccountId: string;
    signal?: AbortSignal;
  }): Promise<{
    mode: 'all' | 'only';
    pages: Array<ChoosablePage & { chosen: boolean }>;
    complete: boolean;
  }> {
    const { account, binding } = await this.requireAgentOwnedAccount(input);
    const { pages, complete } = await this.choosablePages(this.pageScopedPolicy(account), input.signal);
    const choice = readAgentPageChoice(binding.resourceConstraints);
    const chosen = choice && new Set(choice);
    return {
      mode: choice ? 'only' : 'all',
      pages: pages.map(({ id, ...page }) => ({ ...page, chosen: !chosen || chosen.has(id) })),
      complete,
    };
  }

  /**
   * Limit one Agent to chosen pages, named by their handles, or give it all of
   * them again. Every chosen page must be one agentPages lists for this Agent now.
   */
  async setAgentPages(input: {
    principal: AuthPrincipal;
    agentId: string;
    connectionAccountId: string;
    expectedRevision: number;
    choice: { mode: 'all' } | { mode: 'only'; pages: readonly string[] };
    signal?: AbortSignal;
  }): Promise<{ account: ConnectionAccount; binding: AgentConnectionBinding }> {
    const requested = requestedPages(input.choice);
    const { account, binding } = await this.requireAgentOwnedAccount(input);
    if (account.revision !== input.expectedRevision) {
      throw new ManagedResourceSelectionError('stale', 'Managed connection changed');
    }
    const policy = this.pageScopedPolicy(account);
    const chosen = requested && await this.chosenPages(policy, requested, input.signal);
    // The listing took a while. As selectManagedResources does, let the store refuse a
    // revision another edit has moved, then change only the choice on the binding as it is now.
    let updatedAccount: ConnectionAccount;
    try {
      updatedAccount = await this.dependencies.config.putConnectionAccount(account, input.expectedRevision);
    } catch (error) {
      if (error instanceof ConnectionAccountRevisionConflictError) {
        throw new ManagedResourceSelectionError('stale', 'Managed connection changed');
      }
      throw error;
    }
    const current = await this.dependencies.config.getAgentConnectionBindingForAccount(account.id);
    if (!current || current.agentId !== binding.agentId) throw new AuthorizationError();
    // A stored map that could not be read must not be saved back as if it were a choice.
    if (current.resourceConstraints && 'unreadable' in current.resourceConstraints) {
      throw new ManagedResourceSelectionError('invalid', 'Notion page choice is invalid');
    }
    const updatedBinding = await this.dependencies.config.putAgentConnectionBindingIfUnchanged(current, {
      ...current,
      resourceConstraints: writeAgentPageChoice(current.resourceConstraints, chosen),
    });
    if (!updatedBinding) throw new ManagedResourceSelectionError('stale', 'Managed connection changed');
    return { account: updatedAccount, binding: updatedBinding };
  }

  /** The pages a sign-in lists that an Agent may choose, each with the handle the browser names it by. */
  private async choosablePages(
    policy: ConnectionAccountManagedPolicy,
    signal?: AbortSignal,
  ): Promise<{ pages: Array<ChoosablePage & { id: NotionId }>; complete: boolean }> {
    const { roots, complete } = pageRoots(await this.listPages(policy, signal));
    return {
      pages: await Promise.all(roots.map(async ({ id, kind, label }) =>
        ({ id, handle: await notionPageHandle(id), kind, label }))),
      complete,
    };
  }

  private async chosenPages(
    policy: ConnectionAccountManagedPolicy,
    handles: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<NotionId[]> {
    const { pages } = await this.choosablePages(policy, signal);
    const byHandle = new Map(pages.map(({ handle, id }) => [handle, id]));
    return [...new Set(handles.map((handle) => {
      const id = typeof handle === 'string' ? byHandle.get(handle) : undefined;
      if (!id) throw new ManagedResourceSelectionError('invalid', 'Notion page is not available');
      return id;
    }))];
  }

  private pageScopedPolicy(account: ConnectionAccount): ConnectionAccountManagedPolicy {
    const connector = account.policy.kind === 'managed'
      ? this.catalog().connector(account.policy.toolkit)
      : undefined;
    if (account.policy.kind !== 'managed' || account.lifecycle === 'revoked' ||
        !connector?.pageScope || connector.providerId !== account.providerId) {
      throw new ManagedResourceSelectionError('invalid', 'Page choice is unavailable for this connection');
    }
    return account.policy;
  }

  private async listPages(
    policy: ConnectionAccountManagedPolicy,
    signal?: AbortSignal,
  ): Promise<NotionPageListing> {
    const provider = this.dependencies.managedProviders?.get(policy.adapterId);
    if (!provider?.listPages) {
      throw new ManagedResourceSelectionError('unavailable', 'Managed page listing is unavailable');
    }
    let listing: ManagedPageListing;
    try {
      listing = await provider.listPages({ policy, ...(signal ? { signal } : {}) });
    } catch {
      throw new ManagedResourceSelectionError('unavailable', 'Managed page listing failed');
    }
    const parsed = parsePageListing(listing);
    if (!parsed) throw new ManagedResourceSelectionError('unavailable', 'Managed page listing is invalid');
    return parsed;
  }

  /** After signing in again, pages a whole listing leaves out leave every member's choice. */
  private async prunePageChoices(
    members: readonly ConnectionAccount[],
    listing: NotionPageListing,
  ): Promise<void> {
    if (!listing.complete) return;
    const listed = new Set(listing.pages.map(({ id }) => id));
    for (const member of members) {
      try {
        // A write lands only on the binding it read, so a choice narrowed in between is read
        // again rather than written back.
        for (let attempt = 1; ; attempt += 1) {
          const binding = await this.dependencies.config.getAgentConnectionBindingForAccount(member.id);
          const choice = readAgentPageChoice(binding?.resourceConstraints);
          if (!binding || choice === undefined || choice.every((id) => listed.has(id))) break;
          const pruned = await this.dependencies.config.putAgentConnectionBindingIfUnchanged(binding, {
            ...binding,
            resourceConstraints: writeAgentPageChoice(
              binding.resourceConstraints,
              choice.filter((id) => listed.has(id)),
            ),
          });
          if (pruned) break;
          if (attempt === 3) throw new Error('Agent connection binding kept changing');
        }
      } catch {
        console.warn(JSON.stringify({
          event: 'chickpea.managed_connection.page_choice_update_deferred',
          connectionAccountId: member.id,
        }));
      }
    }
  }

  /** The auth-config lane a new sign-in for this managed account must use; see signInGroupAccessLane. */
  async signInAccessLane(account: ConnectionAccount): Promise<ManagedAccessLane> {
    const connector = account.policy.kind === 'managed'
      ? this.catalog().connector(account.policy.toolkit)
      : undefined;
    if (!connector) throw new Error('Managed connection connector is unavailable');
    return signInGroupAccessLane(connector, await this.signInGroup(account));
  }

  async markManagedAccountExpired(input: {
    adapterId: string;
    accountRef: string;
  }): Promise<number> {
    return markManagedAccountExpired(this.dependencies.config, input);
  }

  /** The live accounts sharing this account's remote account, this one included. */
  private async signInGroup(account: ConnectionAccount): Promise<ConnectionAccount[]> {
    const key = signInGroupKey(account);
    if (!key) return [account];
    return (await this.dependencies.config.listConnectionAccounts(account.workspaceId))
      .filter((candidate) => signInGroupKey(candidate) === key);
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

  private captureConnectionReady(
    previousLifecycle: ConnectionAccount['lifecycle'] | undefined,
    account: ConnectionAccount,
    binding: AgentConnectionBinding,
  ): void {
    if (previousLifecycle === 'ready' || account.lifecycle !== 'ready' || !binding.enabled) return;
    try {
      this.dependencies.productTelemetry?.capture({
        event: 'connection_ready',
        workspaceId: account.workspaceId,
        agentId: binding.agentId,
        connectionKind: account.policy.kind,
        ownerKind: account.ownerKind,
        surface: this.dependencies.telemetrySurface ?? 'other',
      });
    } catch {
      // Advisory telemetry never changes a committed connection transition.
    }
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
    pendingSetup?: boolean;
    issuedAccessLane?: ManagedAccessLane;
  }) {
    requirePermission(
      input.principal,
      input.ownerKind === 'team' ? 'connection.create_team' : 'connection.create_personal',
    );
    let policy = input.policy;
    if (policy.kind === 'managed') {
      const connector = assertManagedAccountPolicy(this.catalog(), input.providerId, policy);
      const accessLane = input.issuedAccessLane ?? managedAccessLane(connector, policy.allowedCapabilities);
      if (!laneCovers(accessLane, managedAccessLane(connector, policy.allowedCapabilities))) {
        throw new ManagedConnectionConflictError('The sign-in does not cover the access this connection needs');
      }
      await this.requireUniqueManagedAccount(policy.adapterId, policy.accountRef);
      const provider = this.dependencies.managedProviders?.get(policy.adapterId);
      if (!provider) throw new ManagedConnectionProviderUnavailableError(policy.adapterId);
      const validation = await provider.validate({ policy });
      policy = {
        ...applyManagedValidation(policy, validation),
        signIn: managedSignIn(connector, accessLane, validation, input.principal.membershipId),
      };
      await this.refuseSignInMix({
        principal: input.principal,
        workspaceId: input.workspaceId,
        ownerKind: input.ownerKind,
        connector,
        policy,
      });
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
        : input.credential || !nativeCredentialRequired(policy)
          ? 'ready' as const
          : input.pendingSetup ? 'pending' as const : 'needs_attention' as const,
    };
  }

  private async requireUniqueManagedAccount(
    adapterId: string,
    accountRef: string,
    excludeConnectionAccountIds: readonly string[] = [],
  ): Promise<void> {
    const normalizedAdapterId = adapterId.trim().toLowerCase();
    const installations = await this.dependencies.config.listWorkspaceInstallations();
    for (const installation of installations) {
      const duplicate = (await this.dependencies.config.listConnectionAccounts(installation.workspaceId))
        .find((account) =>
          !excludeConnectionAccountIds.includes(account.id) &&
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

  /** Refuse a sign-in whose account already backs a connection of the other owner kind here; nothing is written yet. */
  private async refuseSignInMix(input: {
    principal: AuthPrincipal;
    workspaceId: string;
    ownerKind: 'team' | 'member';
    connector: ManagedConnectorDefinition;
    policy: ConnectionAccountManagedPolicy;
  }): Promise<void> {
    if (!input.connector.sharedSignIn) return;
    const mix = signInMix({
      connector: input.connector,
      adapterId: input.policy.adapterId,
      ownerKind: input.ownerKind,
      actorMembershipId: input.principal.membershipId,
      person: input.policy.signIn?.person,
      accounts: await this.dependencies.config.listConnectionAccounts(input.workspaceId),
    });
    if (!mix) return;
    const { account } = mix;
    // Changing a personal connection's pages takes its owner's own sign-in.
    const manageable = account.ownerKind === 'member'
      ? account.ownerMembershipId === input.principal.membershipId
      : canManageOwnedResource(input.principal, account);
    throw new ManagedSignInMixError(signInMixRefusal(input.connector, account.ownerKind, {
      samePerson: mix.samePerson,
      manageable,
    }));
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
    if (!canManageOwnedResource(principal, account)) throw new AuthorizationError();
  }

  private id(): string {
    return (this.dependencies.randomId ?? (() => crypto.randomUUID().replace(/-/g, '')))();
  }
}

function assertManagedAccountPolicy(
  catalog: ManagedConnectorCatalog,
  providerId: string,
  policy: Extract<ConnectionAccountPolicy, { kind: 'managed' }>,
): ManagedConnectorDefinition {
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
  return connector;
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
        typeof item.label !== 'string' || !item.label.trim() || item.label.length > 240 ||
        (item.id !== undefined && parseNotionId(item.id) !== item.id))) {
    throw new Error('Managed connection grant summary is invalid');
  }
  return {
    ...policy,
    grantSummary: {
      items: items.map(({ id, type, label }) => ({ ...(id ? { id } : {}), type, label: label.trim() })),
      truncated,
    },
  };
}

/**
 * The widest lane the accounts sharing one sign-in need now. Signing in again
 * on a narrower lane would take capabilities from the rest; once no member
 * writes, the next sign-in drops back to read.
 */
function signInGroupAccessLane(
  connector: ManagedConnectorDefinition,
  members: readonly ConnectionAccount[],
): ManagedAccessLane {
  return members.some(({ policy }) => policy.kind === 'managed' &&
    managedAccessLane(connector, policy.allowedCapabilities) === 'write') ? 'write' : 'read';
}

function laneCovers(issued: ManagedAccessLane, needed: ManagedAccessLane): boolean {
  return issued === 'write' || needed === 'read';
}

/**
 * A connector whose sign-ins may be shared always records whose sign-in it
 * is: the person the provider named for this sign-in, or the signer when it
 * names nobody.
 */
function managedSignIn(
  connector: ManagedConnectorDefinition,
  accessLane: ManagedAccessLane,
  validation: ManagedConnectionValidationResult | void,
  signerMembershipId: string,
): ManagedSignIn {
  const person = validation?.person ??
    (connector.sharedSignIn ? `member:${signerMembershipId}` : undefined);
  return { ...(person ? { person } : {}), accessLane };
}

/**
 * Which source named the person behind a saved shared sign-in decides whether
 * shared-page separation can tell two Chickpea members apart; the person
 * itself is never logged.
 */
function logSignInRecorded(account: ConnectionAccount): void {
  const policy = account.policy;
  if (policy.kind !== 'managed' || !policy.signIn ||
      !MANAGED_CONNECTOR_CATALOG.connector(policy.toolkit)?.sharedSignIn) return;
  console.info(JSON.stringify({
    event: 'chickpea.managed_connection.sign_in_recorded',
    toolkit: policy.toolkit,
    accessLane: policy.signIn.accessLane,
    personSource: policy.signIn.person?.startsWith('member:') ? 'member' : 'provider',
  }));
}

/** The live sign-in groups among a workspace's accounts. */
function signInGroups(accounts: readonly ConnectionAccount[]): ConnectionAccount[][] {
  const groups = new Map<string, ConnectionAccount[]>();
  for (const account of accounts) {
    const key = signInGroupKey(account);
    if (key) groups.set(key, [...groups.get(key) ?? [], account]);
  }
  return [...groups.values()];
}

/** The pages a choice names, or undefined for all of them; any other choice is refused before Notion is asked. */
function requestedPages(choice: unknown): readonly unknown[] | undefined {
  const mode = isRecord(choice) ? choice.mode : undefined;
  const pages = isRecord(choice) ? choice.pages : undefined;
  if (mode === 'all') return undefined;
  if (mode === 'only' && Array.isArray(pages) && pages.length <= MAX_NOTION_PAGES) return pages;
  throw new ManagedResourceSelectionError('invalid', 'Notion page choice is invalid');
}

/** Every page in canonical form; undefined when the provider returned anything else. */
function parsePageListing(listing: ManagedPageListing): NotionPageListing | undefined {
  const pages = listing.pages.flatMap((page): NotionListedPage[] => {
    const id = parseNotionId(page.id);
    const parent = page.parent === undefined ? undefined : parseNotionId(page.parent);
    return id === page.id && parent === page.parent && (page.kind === 'page' || page.kind === 'database') &&
      typeof page.label === 'string'
      ? [{ id, kind: page.kind, label: page.label, ...(parent ? { parent } : {}) }]
      : [];
  });
  return pages.length === listing.pages.length ? { pages, complete: listing.complete === true } : undefined;
}

async function managedResourceHandle(resourceKey: string, providerRef: string): Promise<string> {
  const hex = await sha256Hex(`${resourceKey}\u0000${providerRef}`);
  return `resource_${hex.slice(0, 32)}`;
}

/** The connection account an OAuth credential ref belongs to, if any. */
export async function findConnectionAccountForOAuthRef(
  config: Pick<ConfigStore, 'listWorkspaceInstallations' | 'listConnectionAccounts'>,
  ref: { agentId: string; connectionId: string },
  workspaceId?: string,
): Promise<ConnectionAccount | undefined> {
  const id = connectionAccountIdFromOAuthRef(ref);
  if (!id) return undefined;
  const workspaces = workspaceId
    ? [{ workspaceId }]
    : await config.listWorkspaceInstallations();
  for (const workspace of workspaces) {
    const account = (await config.listConnectionAccounts(workspace.workspaceId))
      .find((candidate) => candidate.id === id);
    if (account) return account;
  }
  return undefined;
}

/** A rejected native grant may only demote the account observed before refresh. */
export async function markApiOAuthAccountExpired(
  config: ConfigStore,
  account: ConnectionAccount,
): Promise<void> {
  await markConnectionAccountNeedsAttention(config, account);
}

/** Demote one exact account revision and pause work that depends on it. */
export async function markConnectionAccountNeedsAttention(
  config: ConfigStore,
  account: ConnectionAccount,
): Promise<boolean> {
  const workspaceAccounts = await config.listConnectionAccounts(account.workspaceId);
  const index = await buildConnectionScheduleIndex(config, new Map([[
    account.workspaceId,
    workspaceAccounts.map((candidate) => candidate.id === account.id
      ? { ...candidate, lifecycle: 'ready' as const }
      : candidate),
  ]]));
  if (!await putConnectionAccountIfCurrent(
    config, { ...account, lifecycle: 'needs_attention' }, account.revision,
  )) return false;
  await pauseDependentSchedules(config, account.id, index);
  return true;
}

/** A provider cancellation may demote only the pending MCP attempt it consumed. */
export async function markCancelledMcpOAuthAccount(
  config: ConfigStore,
  input: {
    connectionAccountId: string;
    serverUrl: string;
    accountRevision?: number;
    oauthAttemptId?: string;
  },
): Promise<boolean> {
  if (input.accountRevision === undefined || !input.oauthAttemptId) return false;
  let account: ConnectionAccount | undefined;
  for (const installation of await config.listWorkspaceInstallations()) {
    account = (await config.listConnectionAccounts(installation.workspaceId)).find(
      (candidate) => candidate.id === input.connectionAccountId,
    );
    if (account) break;
  }
  if (!account || account.lifecycle !== 'pending' || account.revision !== input.accountRevision ||
      account.policy.kind !== 'mcp' || account.policy.authMode !== 'oauth' ||
      account.policy.oauthAttemptId !== input.oauthAttemptId ||
      !sameMcpServerUrl(account.policy.url, input.serverUrl)) return false;
  return markConnectionAccountNeedsAttention(config, account);
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
    // Accounts sharing one sign-in hold one remote account: inspect it once
    // and move every member together.
    const groups = new Map<string, { policy: ConnectionAccountManagedPolicy; members: ConnectionAccount[] }>();
    for (const account of accountsByWorkspace.get(installation.workspaceId) ?? []) {
      const key = signInGroupKey(account);
      if (!key || account.policy.kind !== 'managed' ||
          account.policy.adapterId.trim().toLowerCase() !== normalizedAdapterId) continue;
      const group = groups.get(key) ?? { policy: account.policy, members: [] };
      group.members.push(account);
      groups.set(key, group);
    }
    for (const { policy, members } of groups.values()) {
      if (policy.providerGeneration === input.generation &&
          policy.providerLineage === input.lineage) {
        for (const account of members) {
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
          accountRef: policy.accountRef,
          principalRef: policy.principalRef,
          toolkit: policy.toolkit,
        });
      } catch {
        inspection = 'transient';
      }
      if (inspection === 'transient') {
        retryable += 1;
        continue;
      }
      const connector = MANAGED_CONNECTOR_CATALOG.connector(policy.toolkit);
      const lifecycle = inspection !== 'match'
        ? 'needs_attention' as const
        : connector?.resources?.some((resource) =>
            resource.required && !(policy.resourceConstraints?.[resource.key]?.length)
          ) ? 'pending' as const : 'ready' as const;
      let updated: ConnectionAccount[];
      try {
        updated = await config.applySignInGroup({
          adapterId: policy.adapterId,
          accountRef: policy.accountRef,
          members: members.map(({ id, revision }) => ({ connectionAccountId: id, expectedRevision: revision })),
          shared: {
            ...signInGroupPolicy(policy),
            providerGeneration: input.generation,
            providerLineage: input.lineage,
          },
          lifecycle,
        });
      } catch (error) {
        if (!(error instanceof ConnectionAccountRevisionConflictError) &&
            !(error instanceof ManagedSignInGroupConflictError)) throw error;
        retryable += 1;
        continue;
      }
      for (const account of updated) {
        cacheConnectionAccount(scheduleIndex, account);
        try {
          if (lifecycle === 'needs_attention') {
            await pauseDependentSchedules(config, account.id, scheduleIndex);
          } else if (lifecycle === 'ready') {
            await resumeDependentSchedules(config, account.id, scheduleIndex);
          }
        } catch {
          retryable += 1;
          console.warn(JSON.stringify({
            event: lifecycle === 'needs_attention'
              ? 'chickpea.managed_connection.schedule_pause_deferred'
              : 'chickpea.managed_connection.schedule_resume_deferred',
            connectionAccountId: account.id,
          }));
        }
      }
      if (lifecycle === 'needs_attention') needsAttention += updated.length;
      else restored += updated.length;
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

async function markRevokedConnectionDependencies(
  config: ConfigStore,
  connectionAccountId: string,
  scheduleIndex?: ConnectionScheduleIndex,
): Promise<number> {
  const index = scheduleIndex ?? await buildConnectionScheduleIndex(config);
  const scheduleIds = new Set([
    ...(index.requiredScheduleIdsByConnection.get(connectionAccountId) ?? []),
    ...(index.pausedScheduleIdsByConnection.get(connectionAccountId) ?? []),
  ]);
  let changed = 0;
  for (const scheduleId of scheduleIds) {
    const schedule = index.schedules.get(scheduleId);
    if (!schedule) continue;
    const pausedBy = schedule.connectionPauseAccountIds ?? [];
    // Revocation changes availability, never the saved task's dependency set.
    // Keeping the exact ID prevents a reconnect or metadata edit from silently
    // replacing a personal account (or resuming work with missing inputs).
    const requiredConnectionAccountIds = schedule.requiredConnectionAccountIds;
    const nextPauseIds = [...new Set([...pausedBy, ...requiredConnectionAccountIds
      .filter((id) => id === connectionAccountId)])];
    const state = schedule.state === 'archived' ||
      (schedule.state === 'paused' && index.archivedAgentIds.has(schedule.agentId))
      ? schedule.state : nextPauseIds.length > 0 ? 'needs_attention' : schedule.state;
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
