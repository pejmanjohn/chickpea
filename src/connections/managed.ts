import type { PlatformEnv } from '../config/state-backend.ts';
import {
  ComposioConfigurationStateError,
  resolveComposioConfiguration,
  type ComposioConfigurationOptions,
  type ResolvedComposioConfiguration,
} from '../config/composio-settings.ts';
import type { ConfigStore } from '../config/store.ts';
import type {
  ConnectionAccountManagedPolicy,
} from '../config/types.ts';
import type { IdentityStore } from '../identity/types.ts';
import type { UsageStore } from '../usage/types.ts';
import { UsageStateError } from '../usage/store-error.ts';
import { estimateComposioManagedDirectToolCost } from '../usage/connectors/pricing.ts';
import type {
  ConnectorRetryClassification,
  ConnectorUsageOutcome,
  ReserveConnectorQuotaInput,
} from '../usage/connectors/types.ts';
import type {
  ManagedAccessLane,
  ManagedProviderAvailability,
} from './catalog/index.ts';
import { MANAGED_CONNECTOR_CATALOG } from './catalog/index.ts';
import {
  ManagedAuthorizationExpiredError,
  ManagedProviderRequestError,
  type ManagedProviderFailureMetadata,
} from './managed-errors.ts';
import { resolveManagedConnectionForInvocation } from './runtime.ts';
import { markManagedAccountExpired } from './store.ts';
import {
  ComposioManagedConnectionProvider,
  type ComposioManagedAuthConfigIds,
  isComposioAuthConfigId,
} from './providers/composio.ts';

export const MAX_MANAGED_CONNECTION_RESULT_BYTES = 256 * 1024;
let warnedInvalidComposioAuthConfigIds = false;
let warnedUnavailableComposioConfiguration = false;

export interface ManagedConnectionExecutionInput {
  policy: ConnectionAccountManagedPolicy;
  capability: string;
  arguments: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ManagedConnectionExecutionResult {
  data: Record<string, unknown>;
  logId?: string;
  providerTool?: string;
  providerVersion?: string;
  remoteCallCount?: number;
  providerToolCallCount?: number;
  rateLimitRemaining?: number;
}

export interface ManagedAuthorizationResult {
  authorizationUrl: URL;
  /** Exact provider connection request that this Connect Link may complete. */
  authorizationRef: string;
}

export interface ManagedResourceDiscoveryResult {
  resources: Array<{ providerRef: string; label: string; currencyCode?: string }>;
  nextCursor?: string;
}

export interface ManagedConnectionValidationResult {
  grantSummary?: {
    items: Array<{ type: 'page' | 'database'; label: string }>;
    truncated: boolean;
  };
}

export interface ManagedConnectionInvocationResult extends ManagedConnectionExecutionResult {
  serializedData: string;
}

export interface ManagedConnectionProvider {
  id: string;
  /** Report readiness for one connector/access lane without exposing configuration values. */
  availability?(input: {
    toolkit: string;
    accessLane: ManagedAccessLane;
  }): ManagedProviderAvailability;
  authorize?(input: {
    principalRef: string;
    toolkit: string;
    allowedCapabilities: readonly string[];
    returnUrl?: string;
    signal?: AbortSignal;
  }): Promise<ManagedAuthorizationResult>;
  pollAuthorization?(input: {
    authorizationRef: string;
    principalRef: string;
    toolkit: string;
    signal?: AbortSignal;
  }): Promise<
    | { status: 'pending' }
    | { status: 'active'; accountRef: string; toolkit: string }
    | {
        status: 'terminal';
        reason: 'disabled' | 'expired' | 'failed' | 'inactive' | 'revoked';
      }
  >;
  discoverResources?(input: {
    policy: ConnectionAccountManagedPolicy;
    resourceKey: string;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<ManagedResourceDiscoveryResult>;
  validate(input: {
    policy: ConnectionAccountManagedPolicy;
    signal?: AbortSignal;
  }): Promise<ManagedConnectionValidationResult | void>;
  execute(input: ManagedConnectionExecutionInput): Promise<ManagedConnectionExecutionResult>;
  quotaBudget?(input: {
    toolkit: string;
    bucket: string;
  }): { limit: number; timeZone: 'America/Los_Angeles' } | undefined;
  revoke(input: {
    policy: ConnectionAccountManagedPolicy;
    signal?: AbortSignal;
  }): Promise<void>;
  /** Exact-account cleanup used only to reconcile an unparseable durable attempt. */
  cleanupRemoteAccount?(input: {
    accountRef: string;
    signal?: AbortSignal;
  }): Promise<void>;
}

export interface ManagedConnectionProviderConfiguration {
  generation: number;
  lineage: string;
}

export function managedProviderAvailability(
  provider: ManagedConnectionProvider | undefined,
  input: { toolkit: string; accessLane: ManagedAccessLane },
): ManagedProviderAvailability {
  if (!provider) {
    return { status: 'unavailable', missingConfiguration: ['api_key_missing'] };
  }
  return provider.availability?.(input) ?? { status: 'ready', missingConfiguration: [] };
}

export class ManagedConnectionProviderRegistry {
  private readonly providers: ReadonlyMap<string, ManagedConnectionProvider>;
  private readonly configurations: ReadonlyMap<string, ManagedConnectionProviderConfiguration>;

  constructor(
    providers: readonly ManagedConnectionProvider[],
    configurations: Readonly<Record<string, ManagedConnectionProviderConfiguration>> = {},
  ) {
    const byId = new Map<string, ManagedConnectionProvider>();
    for (const provider of providers) {
      const id = provider.id.trim().toLowerCase();
      if (!id || byId.has(id)) throw new Error(`Duplicate managed connection provider ${id}`);
      byId.set(id, provider);
    }
    this.providers = byId;
    this.configurations = new Map(Object.entries(configurations).map(([id, configuration]) => {
      const normalizedId = id.trim().toLowerCase();
      if (!normalizedId || !Number.isSafeInteger(configuration.generation) ||
          configuration.generation < 1 || !/^[a-f0-9]{24}$/.test(configuration.lineage)) {
        throw new Error(`Invalid managed connection provider configuration ${id}`);
      }
      return [normalizedId, { ...configuration }];
    }));
  }

  get(id: string): ManagedConnectionProvider | undefined {
    return this.providers.get(id.trim().toLowerCase());
  }

  configuration(id: string): ManagedConnectionProviderConfiguration | undefined {
    const configuration = this.configurations.get(id.trim().toLowerCase());
    return configuration ? { ...configuration } : undefined;
  }
}

export function createManagedConnectionProviderRegistry(
  providers: readonly ManagedConnectionProvider[],
  configurations: Readonly<Record<string, ManagedConnectionProviderConfiguration>> = {},
): ManagedConnectionProviderRegistry {
  return new ManagedConnectionProviderRegistry(providers, configurations);
}

export function createDefaultManagedConnectionProviderRegistry(
  env?: PlatformEnv,
): ManagedConnectionProviderRegistry {
  const apiKey = managedProviderSecret(env, 'COMPOSIO_API_KEY');
  const googleAdsAccessLevel = managedProviderSecret(
    env, 'COMPOSIO_GOOGLE_ADS_ACCESS_LEVEL',
  );
  const googleAdsPermissibleUse = managedProviderSecret(
    env, 'COMPOSIO_GOOGLE_ADS_PERMISSIBLE_USE',
  );
  const youtubeGeneralDailyQuota = managedProviderSecret(
    env, 'COMPOSIO_YOUTUBE_GENERAL_DAILY_QUOTA_UNITS',
  );
  const youtubeSearchDailyLimit = managedProviderSecret(
    env, 'COMPOSIO_YOUTUBE_SEARCH_DAILY_CALL_LIMIT',
  );
  const youtubeUploadDailyLimit = managedProviderSecret(
    env, 'COMPOSIO_YOUTUBE_UPLOAD_DAILY_CALL_LIMIT',
  );
  const youtubeQuotaAuditApproved = managedProviderSecret(
    env, 'COMPOSIO_YOUTUBE_QUOTA_AUDIT_APPROVED',
  );
  const authConfigIds: ComposioManagedAuthConfigIds = {
    gmail: {
      read: managedProviderSecret(env, 'COMPOSIO_GMAIL_READ_AUTH_CONFIG_ID'),
      write: managedProviderSecret(env, 'COMPOSIO_GMAIL_WRITE_AUTH_CONFIG_ID'),
    },
    googlecalendar: {
      read: managedProviderSecret(env, 'COMPOSIO_CALENDAR_READ_AUTH_CONFIG_ID'),
      write: managedProviderSecret(env, 'COMPOSIO_CALENDAR_WRITE_AUTH_CONFIG_ID'),
    },
    googledrive: {
      read: managedProviderSecret(env, 'COMPOSIO_DRIVE_READ_AUTH_CONFIG_ID'),
      write: managedProviderSecret(env, 'COMPOSIO_DRIVE_WRITE_AUTH_CONFIG_ID'),
    },
    googlesheets: {
      read: managedProviderSecret(env, 'COMPOSIO_SHEETS_READ_AUTH_CONFIG_ID'),
      write: managedProviderSecret(env, 'COMPOSIO_SHEETS_WRITE_AUTH_CONFIG_ID'),
    },
    googledocs: {
      read: managedProviderSecret(env, 'COMPOSIO_DOCS_READ_AUTH_CONFIG_ID'),
      write: managedProviderSecret(env, 'COMPOSIO_DOCS_WRITE_AUTH_CONFIG_ID'),
    },
    googleslides: {
      read: managedProviderSecret(env, 'COMPOSIO_SLIDES_READ_AUTH_CONFIG_ID'),
      write: managedProviderSecret(env, 'COMPOSIO_SLIDES_WRITE_AUTH_CONFIG_ID'),
    },
    notion: {
      read: managedProviderSecret(env, 'COMPOSIO_NOTION_READ_AUTH_CONFIG_ID'),
      write: managedProviderSecret(env, 'COMPOSIO_NOTION_WRITE_AUTH_CONFIG_ID'),
    },
    google_search_console: {
      read: managedProviderSecret(env, 'COMPOSIO_SEARCH_CONSOLE_READ_AUTH_CONFIG_ID'),
    },
    google_analytics: {
      read: managedProviderSecret(env, 'COMPOSIO_ANALYTICS_READ_AUTH_CONFIG_ID'),
    },
    hubspot: {
      read: managedProviderSecret(env, 'COMPOSIO_HUBSPOT_READ_AUTH_CONFIG_ID'),
      write: managedProviderSecret(env, 'COMPOSIO_HUBSPOT_WRITE_AUTH_CONFIG_ID'),
    },
    gong: {
      read: managedProviderSecret(env, 'COMPOSIO_GONG_READ_AUTH_CONFIG_ID'),
    },
    googleads: {
      read: managedProviderSecret(env, 'COMPOSIO_GOOGLE_ADS_READ_AUTH_CONFIG_ID'),
      write: managedProviderSecret(env, 'COMPOSIO_GOOGLE_ADS_WRITE_AUTH_CONFIG_ID'),
    },
    youtube: {
      read: managedProviderSecret(env, 'COMPOSIO_YOUTUBE_READ_AUTH_CONFIG_ID'),
      write: managedProviderSecret(env, 'COMPOSIO_YOUTUBE_WRITE_AUTH_CONFIG_ID'),
    },
  };
  const authConfigEntries: readonly (readonly [string, string | undefined])[] = [
    ['gmail.read', authConfigIds.gmail?.read],
    ['gmail.write', authConfigIds.gmail?.write],
    ['googlecalendar.read', authConfigIds.googlecalendar?.read],
    ['googlecalendar.write', authConfigIds.googlecalendar?.write],
    ['googledrive.read', authConfigIds.googledrive?.read],
    ['googledrive.write', authConfigIds.googledrive?.write],
    ['googlesheets.read', authConfigIds.googlesheets?.read],
    ['googlesheets.write', authConfigIds.googlesheets?.write],
    ['googledocs.read', authConfigIds.googledocs?.read],
    ['googledocs.write', authConfigIds.googledocs?.write],
    ['googleslides.read', authConfigIds.googleslides?.read],
    ['googleslides.write', authConfigIds.googleslides?.write],
    ['notion.read', authConfigIds.notion?.read],
    ['notion.write', authConfigIds.notion?.write],
    ['google_search_console.read', authConfigIds.google_search_console?.read],
    ['google_analytics.read', authConfigIds.google_analytics?.read],
    ['hubspot.read', authConfigIds.hubspot?.read],
    ['hubspot.write', authConfigIds.hubspot?.write],
    ['gong.read', authConfigIds.gong?.read],
    ['googleads.read', authConfigIds.googleads?.read],
    ['googleads.write', authConfigIds.googleads?.write],
    ['youtube.read', authConfigIds.youtube?.read],
    ['youtube.write', authConfigIds.youtube?.write],
  ];
  const invalidAuthConfigs = authConfigEntries.flatMap(([name, value]) =>
    isComposioAuthConfigId(value) ? [] : [name]);
  if (apiKey && invalidAuthConfigs.length > 0 && !warnedInvalidComposioAuthConfigIds) {
    warnedInvalidComposioAuthConfigIds = true;
    console.warn(JSON.stringify({
      event: 'chickpea.managed_connection.authorization_config_unavailable',
      adapterId: 'composio',
      missingAuthConfigs: invalidAuthConfigs,
    }));
  }
  return createManagedConnectionProviderRegistry(
    apiKey
      ? [new ComposioManagedConnectionProvider({
          apiKey,
          authConfigIds,
          ...(googleAdsAccessLevel ? { googleAdsAccessLevel } : {}),
          ...(googleAdsPermissibleUse ? { googleAdsPermissibleUse } : {}),
          ...(youtubeGeneralDailyQuota ? { youtubeGeneralDailyQuota } : {}),
          ...(youtubeSearchDailyLimit ? { youtubeSearchDailyLimit } : {}),
          ...(youtubeUploadDailyLimit ? { youtubeUploadDailyLimit } : {}),
          ...(youtubeQuotaAuditApproved ? { youtubeQuotaAuditApproved } : {}),
        })]
      : [],
  );
}

/**
 * Resolve environment or encrypted installation configuration before building
 * the runtime registry. New request paths should use this async entrypoint;
 * the synchronous factory remains for environment-only Admin call sites.
 */
export async function resolveDefaultManagedConnectionProviderRegistry(
  env?: PlatformEnv,
  options: Omit<ComposioConfigurationOptions, 'env'> = {},
): Promise<ManagedConnectionProviderRegistry> {
  return buildResolvedManagedConnectionProviderRegistry(env, options);
}

async function buildResolvedManagedConnectionProviderRegistry(
  env: PlatformEnv | undefined,
  options: Omit<ComposioConfigurationOptions, 'env'>,
): Promise<ManagedConnectionProviderRegistry> {
  let resolved;
  try {
    resolved = await resolveComposioConfiguration({ ...options, ...(env ? { env } : {}) });
  } catch (error) {
    if (error instanceof ComposioConfigurationStateError) {
      if (!warnedUnavailableComposioConfiguration) {
        warnedUnavailableComposioConfiguration = true;
        console.warn(JSON.stringify({
          event: 'chickpea.managed_connection.configuration_unavailable',
          adapterId: 'composio',
          errorName: error.name,
        }));
      }
      return createManagedConnectionProviderRegistry([]);
    }
    throw error;
  }
  return createResolvedManagedConnectionProviderRegistry(resolved, env);
}

/** Build a request registry from configuration that has already been resolved. */
export function createResolvedManagedConnectionProviderRegistry(
  resolved: ResolvedComposioConfiguration,
  env?: PlatformEnv,
): ManagedConnectionProviderRegistry {
  if (!resolved.apiKey || resolved.desiredState !== 'enabled' ||
      resolved.reconciliationPending) {
    return createManagedConnectionProviderRegistry([]);
  }
  const provider = new ComposioManagedConnectionProvider({
    apiKey: resolved.apiKey,
    authConfigIds: resolved.authConfigIds,
    ...optionalProviderPrerequisites(env),
  });
  return createManagedConnectionProviderRegistry([provider], {
    composio: {
      generation: resolved.generation,
      lineage: resolved.keyFingerprint ?? resolved.lastKeyFingerprint ?? '0'.repeat(24),
    },
  });
}

export async function invokeManagedConnectionCapability(input: {
  config: ConfigStore;
  identity: Pick<
    IdentityStore,
    | 'getOrganization'
    | 'getMembership'
    | 'getMembershipAccessOverlay'
    | 'getUser'
    | 'resolveSlackIdentity'
  >;
  providers: ManagedConnectionProviderRegistry;
  workspaceId: string;
  agentId: string;
  actorMembershipId: string;
  connectionAccountId: string;
  capability: string;
  arguments: Record<string, unknown>;
  usage?: UsageStore;
  correlation?: {
    operationId?: string;
    runId?: string;
    runExecutionId?: string;
  };
  signal?: AbortSignal;
  now?: () => number;
  createAttemptId?: () => string;
}): Promise<ManagedConnectionInvocationResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const attemptId = input.createAttemptId?.() ?? `connector:${crypto.randomUUID()}`;
  const capabilityDefinition = MANAGED_CONNECTOR_CATALOG.capability(input.capability);
  let adapterId = 'unknown';
  let toolkit = capabilityDefinition?.connectorToolkit ?? 'unknown';
  let result: ManagedConnectionExecutionResult | undefined;
  let invocationResult: ManagedConnectionInvocationResult | undefined;
  let selectedPolicy: ConnectionAccountManagedPolicy | undefined;
  let failure: unknown;
  let dispatched = false;
  let resultBytes: number | null = null;
  const quotaReservations: ReserveConnectorQuotaInput[] = [];
  try {
    const selected = await resolveManagedConnectionForInvocation({
      config: input.config,
      identity: input.identity,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      actorMembershipId: input.actorMembershipId,
      connectionAccountId: input.connectionAccountId,
    });
    adapterId = selected.policy.adapterId;
    toolkit = selected.policy.toolkit;
    selectedPolicy = selected.policy;
    if (!capabilityDefinition || capabilityDefinition.connectorToolkit !== selected.policy.toolkit) {
      throw new Error('Managed connection capability is not available to this Agent');
    }
    if (!selected.policy.allowedCapabilities.includes(input.capability)) {
      throw new Error('Managed connection capability is not available to this Agent');
    }
    const provider = input.providers.get(selected.policy.adapterId);
    if (!provider) {
      throw new ManagedProviderRequestError(
        'provider_unavailable',
        'Managed connection provider is unavailable',
        { remoteCallCount: 0, providerToolCallCount: 0, capabilityToolDispatched: false },
      );
    }
    const activeConfiguration = input.providers.configuration(selected.policy.adapterId);
    const hasProviderGeneration = selected.policy.providerGeneration !== undefined;
    const hasProviderLineage = selected.policy.providerLineage !== undefined;
    if (activeConfiguration && (hasProviderGeneration || hasProviderLineage)) {
      if (!hasProviderGeneration || !hasProviderLineage ||
          selected.policy.providerGeneration !== activeConfiguration.generation ||
          selected.policy.providerLineage !== activeConfiguration.lineage) {
        throw new ManagedAuthorizationExpiredError({
          remoteCallCount: 0,
          providerToolCallCount: 0,
          capabilityToolDispatched: false,
        });
      }
    }
    const executionPolicy: ConnectionAccountManagedPolicy = activeConfiguration &&
        !hasProviderGeneration && !hasProviderLineage
      ? {
          ...selected.policy,
          providerGeneration: activeConfiguration.generation,
          providerLineage: activeConfiguration.lineage,
        }
      : selected.policy;
    selectedPolicy = executionPolicy;
    let quotaRemaining: number | undefined;
    if (capabilityDefinition.quota) {
      if (!input.usage) {
        throw new ManagedProviderRequestError(
          'provider_unavailable',
          'Managed connection quota enforcement is unavailable',
          { remoteCallCount: 0, providerToolCallCount: 0 },
        );
      }
      for (const quota of capabilityDefinition.quota) {
        const budget = provider.quotaBudget?.({ toolkit, bucket: quota.bucket });
        if (!budget) {
          throw new ManagedProviderRequestError(
            'provider_unavailable',
            'Managed connection quota enforcement is unavailable',
            { remoteCallCount: 0, providerToolCallCount: 0 },
          );
        }
        const period = dailyQuotaWindow(startedAt, budget.timeZone);
        try {
          const reservationInput: ReserveConnectorQuotaInput = {
            reservationId: `${attemptId}:${quota.bucket}`,
            workspaceId: input.workspaceId,
            adapterId,
            toolkit,
            bucket: quota.bucket,
            units: quota.units,
            limit: budget.limit,
            periodStart: period.start,
            periodEnd: period.end,
          };
          const reservation = await input.usage.reserveConnectorQuota(reservationInput);
          quotaReservations.push(reservationInput);
          quotaRemaining = quotaRemaining === undefined
            ? reservation.remaining
            : Math.min(quotaRemaining, reservation.remaining);
        } catch (error) {
        if (error instanceof UsageStateError &&
            error.code === 'usage_connector_quota_exceeded') {
          throw new ManagedProviderRequestError(
            'throttled',
            'Managed connection provider quota budget is exhausted for today',
            {
              remoteCallCount: 0,
              providerToolCallCount: 0,
              rateLimitRemaining: 0,
              retryAfterMs: Math.max(0, period.end - startedAt),
            },
          );
        }
        throw new ManagedProviderRequestError(
          'provider_unavailable',
          'Managed connection quota could not be reserved safely',
          { remoteCallCount: 0, providerToolCallCount: 0 },
        );
        }
      }
    }
    dispatched = true;
    result = await provider.execute({
      policy: executionPolicy,
      capability: input.capability,
      arguments: input.arguments,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (executionPolicy !== selected.policy && selected.account.policy.kind === 'managed') {
      try {
        await input.config.putConnectionAccount({
          ...selected.account,
          policy: {
            ...selected.account.policy,
            providerGeneration: activeConfiguration!.generation,
            providerLineage: activeConfiguration!.lineage,
          },
        }, selected.account.revision);
      } catch {
        let adoptedByConcurrentInvocation = false;
        try {
          const current = (await input.config.listConnectionAccounts(input.workspaceId))
            .find((account) => account.id === selected.account.id);
          adoptedByConcurrentInvocation = Boolean(
            current && current.lifecycle !== 'revoked' && current.policy.kind === 'managed' &&
            current.policy.providerGeneration === activeConfiguration!.generation &&
            current.policy.providerLineage === activeConfiguration!.lineage,
          );
        } catch {
          // Provider execution already succeeded. Lineage adoption is best
          // effort and must never turn a completed remote operation into a
          // reported tool failure, even when the config store is unavailable.
        }
        if (!adoptedByConcurrentInvocation) {
          console.warn(JSON.stringify({
            event: 'chickpea.managed_connection.lineage_adoption_deferred',
            connectionAccountId: selected.account.id,
          }));
        }
      }
    }
    if (quotaRemaining !== undefined) {
      result.rateLimitRemaining = result.rateLimitRemaining === undefined
        ? quotaRemaining
        : Math.min(result.rateLimitRemaining, quotaRemaining);
    }
    const serialized = JSON.stringify(result.data);
    resultBytes = serialized === undefined
      ? null
      : new TextEncoder().encode(serialized).byteLength;
    const resultLimit = Math.min(
      MAX_MANAGED_CONNECTION_RESULT_BYTES,
      capabilityDefinition.maxResultBytes,
    );
    if (serialized === undefined || resultBytes! > resultLimit) {
      throw new ManagedProviderRequestError(
        'validation_failed',
        serialized === undefined
          ? 'Managed connection provider returned an invalid result'
          : 'Managed connection result exceeded Chickpea’s size limit',
        {
          ...(result.providerTool ? { providerTool: result.providerTool } : {}),
          ...(result.providerVersion ? { providerVersion: result.providerVersion } : {}),
          remoteCallCount: result.remoteCallCount ?? 1,
          providerToolCallCount: result.providerToolCallCount ?? 1,
          capabilityToolDispatched: true,
          ...(result.logId ? { providerLogId: result.logId } : {}),
        },
      );
    }
    invocationResult = { ...result, serializedData: serialized };
  } catch (error) {
    failure = error;
    if (error instanceof ManagedAuthorizationExpiredError && selectedPolicy) {
      try {
        await markManagedAccountExpired(input.config, {
          adapterId: selectedPolicy.adapterId,
          accountRef: selectedPolicy.accountRef,
        });
      } catch (demotionError) {
        console.warn(JSON.stringify({
          event: 'chickpea.managed_connection.expiry_demotion_failed',
          adapterId: selectedPolicy.adapterId,
          errorName: demotionError instanceof Error ? demotionError.name : 'UnknownError',
        }));
      }
    }
    throw error;
  } finally {
    if (input.usage && capabilityDefinition) {
      const finishedAt = now();
      const terminal = connectorTerminal(failure, result, dispatched);
      const capabilityToolDispatched = failure instanceof ManagedProviderRequestError ||
          failure instanceof ManagedAuthorizationExpiredError
        ? failure.metadata?.capabilityToolDispatched
        : undefined;
      // Provider quota is charged for requests, not successful mutations. A
      // failed ownership/actor preflight has already spent general_units, so
      // retain that reservation. Only release a capability-specific search or
      // insert allowance when its own provider tool provably never dispatched.
      const releasableReservations = quotaReservations.filter((reservation) =>
        terminal.metadata.remoteCallCount === 0 ||
        capabilityToolDispatched === false &&
          (reservation.bucket === 'video_insert_calls' || reservation.bucket === 'search_calls')
      );
      if (releasableReservations.length > 0) {
        for (const reservation of releasableReservations) {
          try {
            await input.usage.releaseConnectorQuota(reservation);
          } catch {
            console.warn(JSON.stringify({
              event: 'chickpea.managed_connection.quota_release_failed',
              adapterId,
              toolkit,
              capability: input.capability,
              bucket: reservation.bucket,
            }));
          }
        }
      }
      const cost = adapterId === 'composio'
        ? estimateComposioManagedDirectToolCost(terminal.providerToolCallCount)
        : undefined;
      try {
        await input.usage.recordConnectorUsage({
          attemptId,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          connectionAccountId: input.connectionAccountId,
          operationId: input.correlation?.operationId ?? null,
          runId: input.correlation?.runId ?? null,
          runExecutionId: input.correlation?.runExecutionId ?? null,
          adapterId,
          toolkit,
          capability: input.capability,
          providerTool: terminal.metadata.providerTool ?? null,
          providerVersion: terminal.metadata.providerVersion ?? null,
          effectClass: capabilityDefinition.effect,
          outcome: terminal.outcome,
          retryClassification: terminal.retryClassification,
          startedAt,
          finishedAt,
          latencyMs: finishedAt - startedAt,
          remoteCallCount: terminal.metadata.remoteCallCount,
          providerToolCallCount: terminal.providerToolCallCount,
          resultBytes,
          httpStatus: terminal.metadata.httpStatus ?? null,
          rateLimitRemaining: terminal.metadata.rateLimitRemaining ?? null,
          retryAfterMs: terminal.metadata.retryAfterMs ?? null,
          providerLogId: terminal.metadata.providerLogId ?? null,
          priceVersionId: cost?.priceVersionId ?? null,
          estimatedCostMicros: cost?.estimatedCostMicros ?? null,
          estimateCurrency: cost?.estimateCurrency ?? null,
        });
      } catch {
        console.warn(JSON.stringify({
          event: 'chickpea.managed_connection.measurement_failed',
          adapterId,
          toolkit,
          capability: input.capability,
        }));
      }
    }
  }
  return invocationResult!;
}

function connectorTerminal(
  failure: unknown,
  result: ManagedConnectionExecutionResult | undefined,
  dispatched: boolean,
): {
  outcome: ConnectorUsageOutcome;
  retryClassification: ConnectorRetryClassification;
  metadata: ManagedProviderFailureMetadata;
  providerToolCallCount: number;
} {
  if (failure instanceof ManagedAuthorizationExpiredError) {
    const metadata = failure.metadata ?? {
      remoteCallCount: dispatched ? 1 : 0,
      providerToolCallCount: dispatched ? 1 : 0,
    };
    return {
      outcome: 'authorization_expired',
      retryClassification: 'reconnect_required',
      metadata,
      providerToolCallCount: metadata.providerToolCallCount,
    };
  }
  if (failure instanceof ManagedProviderRequestError) {
    return {
      outcome: failure.code,
      retryClassification: failure.code === 'throttled'
        ? 'retry_after'
        : failure.code === 'ambiguous'
        ? 'verify_before_retry'
        : failure.code === 'validation_failed'
        ? 'none'
        : 'safe_retry_available',
      metadata: failure.metadata,
      providerToolCallCount: failure.metadata.providerToolCallCount,
    };
  }
  if (result && !failure) {
    const providerToolCallCount = result.providerToolCallCount ?? 1;
    return {
      outcome: 'success',
      retryClassification: 'none',
      metadata: {
        ...(result.providerTool ? { providerTool: result.providerTool } : {}),
        ...(result.providerVersion ? { providerVersion: result.providerVersion } : {}),
        remoteCallCount: result.remoteCallCount ?? providerToolCallCount,
        providerToolCallCount,
        ...(result.rateLimitRemaining === undefined
          ? {}
          : { rateLimitRemaining: result.rateLimitRemaining }),
        ...(result.logId ? { providerLogId: result.logId } : {}),
      },
      providerToolCallCount,
    };
  }
  const providerToolCallCount = result?.providerToolCallCount ?? (dispatched ? 1 : 0);
  return {
    outcome: dispatched ? 'provider_unavailable' : 'validation_failed',
    retryClassification: dispatched ? 'safe_retry_available' : 'none',
    metadata: {
      ...(result?.providerTool ? { providerTool: result.providerTool } : {}),
      ...(result?.providerVersion ? { providerVersion: result.providerVersion } : {}),
      remoteCallCount: result?.remoteCallCount ?? providerToolCallCount,
      providerToolCallCount,
      ...(result?.rateLimitRemaining === undefined
        ? {}
        : { rateLimitRemaining: result.rateLimitRemaining }),
      ...(result?.logId ? { providerLogId: result.logId } : {}),
    },
    providerToolCallCount,
  };
}

function managedProviderSecret(env: PlatformEnv | undefined, name: string): string | undefined {
  const bound = env?.[name];
  const value = typeof bound === 'string' ? bound : process.env[name];
  const normalized = value?.trim();
  return normalized || undefined;
}

function optionalProviderPrerequisites(env: PlatformEnv | undefined): {
  googleAdsAccessLevel?: string;
  googleAdsPermissibleUse?: string;
  youtubeGeneralDailyQuota?: string;
  youtubeSearchDailyLimit?: string;
  youtubeUploadDailyLimit?: string;
  youtubeQuotaAuditApproved?: string;
} {
  const values = {
    googleAdsAccessLevel: managedProviderSecret(env, 'COMPOSIO_GOOGLE_ADS_ACCESS_LEVEL'),
    googleAdsPermissibleUse: managedProviderSecret(env, 'COMPOSIO_GOOGLE_ADS_PERMISSIBLE_USE'),
    youtubeGeneralDailyQuota: managedProviderSecret(
      env, 'COMPOSIO_YOUTUBE_GENERAL_DAILY_QUOTA_UNITS',
    ),
    youtubeSearchDailyLimit: managedProviderSecret(
      env, 'COMPOSIO_YOUTUBE_SEARCH_DAILY_CALL_LIMIT',
    ),
    youtubeUploadDailyLimit: managedProviderSecret(
      env, 'COMPOSIO_YOUTUBE_UPLOAD_DAILY_CALL_LIMIT',
    ),
    youtubeQuotaAuditApproved: managedProviderSecret(
      env, 'COMPOSIO_YOUTUBE_QUOTA_AUDIT_APPROVED',
    ),
  };
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

function dailyQuotaWindow(
  now: number,
  timeZone: 'America/Los_Angeles',
): { start: number; end: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  const local = localParts(formatter, now);
  const start = zonedTimestamp(formatter, local.year, local.month, local.day);
  const nextDate = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  const end = zonedTimestamp(
    formatter,
    nextDate.getUTCFullYear(),
    nextDate.getUTCMonth() + 1,
    nextDate.getUTCDate(),
  );
  return { start, end };
}

function zonedTimestamp(
  formatter: Intl.DateTimeFormat,
  year: number,
  month: number,
  day: number,
): number {
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = localParts(formatter, guess);
    const represented = Date.UTC(
      local.year, local.month - 1, local.day, local.hour, local.minute, local.second,
    );
    guess += target - represented;
  }
  return guess;
}

function localParts(formatter: Intl.DateTimeFormat, timestamp: number): {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
} {
  const values = Object.fromEntries(formatter.formatToParts(timestamp).flatMap((part) =>
    part.type === 'literal' ? [] : [[part.type, Number(part.value)]]));
  return {
    year: values.year!, month: values.month!, day: values.day!, hour: values.hour!,
    minute: values.minute!, second: values.second!,
  };
}
