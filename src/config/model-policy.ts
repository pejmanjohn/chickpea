import { ModelResolutionError } from './errors.ts';
import { registeredPiProvider } from './pi-provider-registry.ts';
import type {
  AgentModelAttribution,
  AgentModelRole,
  CustomAgentConfig,
  NonChatModelRole,
  ResolvedAssignment,
  WorkspaceInstallation,
  WorkspaceModelDefault,
  WorkspaceModelRole,
  WorkspaceRuntimeContract,
} from './types.ts';
import { isProviderKeyId, resolveProviderApiKey } from './provider-keys.ts';
import type { SettingsStore } from './settings-store.ts';
import type { PlatformEnv } from './state-backend.ts';
import { resolveActiveCatalogRoute } from '../model-catalog/index.ts';
import { findImageModel } from '../model-catalog/image-profiles.ts';
import type { RuntimePlanImageCapabilityV3 } from '../agents/runtime-plan.ts';

// Accepts `model: null` alongside the stored shape so admin PATCH previews
// (where null means "clear the pin") can be checked without re-shaping.
export type ModelResolvableAgent = Pick<CustomAgentConfig, 'id'> & {
  model?: string | null;
};

export function resolveAgentModel(
  agent: ModelResolvableAgent,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (agent.model) {
    return noteResolvedModel(agent.model);
  }
  const fallbackModel = env.SLACK_TAG_MODEL;
  if (fallbackModel) {
    return noteResolvedModel(fallbackModel);
  }
  throw new ModelResolutionError(
    `No model pinned for agent ${agent.id}. Pin a model in /admin (Agents -> Model), ` +
      'or set SLACK_TAG_MODEL for offline/dev unpinned-agent fallback.',
  );
}

interface ResolvedAgentModelPolicy {
  model: string;
  attribution: AgentModelAttribution;
}

interface WorkspaceModelPolicyReader {
  getWorkspaceInstallation(workspaceId: string): Promise<WorkspaceInstallation | undefined>;
  getWorkspaceModelDefault(workspaceId: string): Promise<WorkspaceModelDefault | undefined>;
}

export async function resolveModelPolicyForAssignment(
  assignment: ResolvedAssignment,
  reader: WorkspaceModelPolicyReader,
  env: NodeJS.ProcessEnv = process.env,
  knownInstallation?: WorkspaceInstallation,
): Promise<ResolvedAssignment & { model: string; modelAttribution: AgentModelAttribution }> {
  const installation = knownInstallation ??
    await reader.getWorkspaceInstallation(assignment.workspaceId);
  if (!installation) {
    throw new ModelResolutionError('Workspace model policy is unavailable. Repair Slack setup.');
  }
  const workspaceDefault = installation.runtimeContract === 'chickpea-v1'
    ? await reader.getWorkspaceModelDefault(assignment.workspaceId)
    : undefined;
  const resolved = resolveAgentModelPolicy({
    agent: assignment.agent,
    runtimeContract: installation.runtimeContract,
    ...(workspaceDefault ? { workspaceDefault } : {}),
    env,
  });
  return { ...assignment, model: resolved.model, modelAttribution: resolved.attribution };
}

/** Resolve the policy source once, before effective configuration is built. */
export function resolveAgentModelPolicy(input: {
  agent: ModelResolvableAgent & Pick<CustomAgentConfig, 'kind'>;
  runtimeContract: WorkspaceRuntimeContract;
  workspaceDefault?: WorkspaceModelDefault;
  env?: NodeJS.ProcessEnv;
}): ResolvedAgentModelPolicy {
  if (input.runtimeContract === 'legacy') {
    const model = resolveAgentModel(input.agent, input.env);
    return {
      model,
      attribution: {
        source: input.agent.model ? 'pinned' : 'legacy_environment',
        providerId: providerPrefix(model),
      },
    };
  }

  if (input.agent.kind === 'system' && input.agent.model) {
    throw new ModelResolutionError('Chickpea cannot use a pinned model. Repair Workspace default.');
  }
  if (input.agent.kind === 'user' && input.agent.model) {
    const model = noteResolvedModel(input.agent.model);
    return {
      model,
      attribution: activatedAttribution(model, 'pinned'),
    };
  }

  const workspaceDefault = input.workspaceDefault;
  if (!workspaceDefault?.modelId) {
    throw new ModelResolutionError(
      'Workspace default is not ready. Choose a model in Settings > Model providers.',
      {
        status: 'provider_setup_required',
        providerId: 'workspace_default',
        path: '/admin/settings/providers',
      },
    );
  }
  const model = noteResolvedModel(workspaceDefault.modelId);
  return {
    model,
    attribution: {
      source: 'workspace_default',
      workspaceDefaultRevision: workspaceDefault.revision,
      providerId: providerPrefix(model),
      ...catalogRevisionForModel(model),
    },
  };
}

// Warn only from registered model metadata. Curated binding models have a
// context window; a provider prefix alone cannot establish that compaction is off.
const warnedUnboundedCloudflareModels = new Set<string>();
function noteResolvedModel(model: string): string {
  if (!model.startsWith('cloudflare/') || warnedUnboundedCloudflareModels.has(model)) return model;
  const provider = registeredPiProvider('cloudflare');
  if (!provider) return model;
  const metadata = provider.getModels().find((candidate) => candidate.id === model.slice('cloudflare/'.length));
  if (metadata && metadata.contextWindow > 0) return model;
  warnedUnboundedCloudflareModels.add(model);
  console.warn(
    `[chickpea] model ${model} has no declared context window in the registered Workers AI ` +
      'binding provider: auto-compaction is disabled and long DM transcripts grow unbounded.',
  );
  return model;
}

function providerPrefix(model: string): string {
  const separator = model.indexOf('/');
  return separator > 0 ? model.slice(0, separator) : model;
}

function activatedAttribution(
  model: string,
  source: Extract<AgentModelAttribution['source'], 'pinned'>,
): AgentModelAttribution {
  return {
    source,
    providerId: providerPrefix(model),
    ...catalogRevisionForModel(model),
  };
}

function catalogRevisionForModel(model: string): Pick<AgentModelAttribution, 'catalogRevision'> | {} {
  const providerId = providerPrefix(model);
  const lane = providerId === 'openai'
    ? 'openai_api_key'
    : providerId === 'anthropic'
      ? 'anthropic_api_key'
      : undefined;
  if (!lane) return {};
  const route = resolveActiveCatalogRoute(model, lane);
  if (!route) {
    throw new ModelResolutionError(
      `Model ${model} is not supported by the active catalog. Choose another Workspace default.`,
      { status: 'unsupported', providerId, path: '/admin/settings/providers' },
    );
  }
  return { catalogRevision: String(route.snapshot.revision) };
}

/* -------------------------------------------------------------------------
 * Model roles beyond chat.
 *
 * `resolveAgentModelForRole` mirrors `resolveAgentModelPolicy`: Agent pin,
 * then Workspace role default, else a typed "unset" result the caller turns
 * into the honesty instruction instead of an adapter auth error. The system
 * Agent rejects a pin exactly as it does for chat.
 * ---------------------------------------------------------------------- */

export type ModelRoleUnsetReason = 'role_unset' | 'credential_missing';

export type ModelRoleResolution =
  | { modelId: string; providerId: string; source: 'pinned' | 'workspace_default' }
  | { unset: true; reason: ModelRoleUnsetReason };

export interface ModelRoleReader {
  getWorkspaceModelRole(
    workspaceId: string,
    role: NonChatModelRole,
  ): Promise<WorkspaceModelRole | undefined>;
  getAgentModelRole(
    agentId: string,
    role: NonChatModelRole,
  ): Promise<AgentModelRole | undefined>;
}

export interface ResolveAgentModelForRoleInput {
  role: NonChatModelRole;
  agent: Pick<CustomAgentConfig, 'id'> & Pick<CustomAgentConfig, 'kind'>;
  /** The Agent's own override row, when one exists. */
  agentRole?: Pick<AgentModelRole, 'modelId'>;
  /** The Workspace default for this role, when one exists. */
  workspaceRole?: Pick<WorkspaceModelRole, 'modelId'>;
  env?: PlatformEnv;
  settings?: SettingsStore;
  /** Seam for tests; production reads the same stored/env provider keys. */
  hasProviderCredential?: (providerId: string) => Promise<boolean>;
}

export async function resolveAgentModelForRole(
  input: ResolveAgentModelForRoleInput,
): Promise<ModelRoleResolution> {
  const pinned = input.agentRole?.modelId;
  if (input.agent.kind === 'system' && pinned) {
    throw new ModelResolutionError(
      `Chickpea cannot use a pinned ${input.role} model. Repair Workspace default.`,
    );
  }
  const resolved = input.agent.kind === 'user' && pinned
    ? { modelId: pinned, source: 'pinned' as const }
    : input.workspaceRole?.modelId
      ? { modelId: input.workspaceRole.modelId, source: 'workspace_default' as const }
      : undefined;
  if (!resolved) return { unset: true, reason: 'role_unset' };
  const providerId = providerPrefix(resolved.modelId);
  const hasCredential = input.hasProviderCredential ??
    ((id: string) => defaultProviderCredentialCheck(id, input.env, input.settings));
  // A model whose provider has no credential resolves to unset on purpose: the
  // Agent then states the limit instead of failing inside the adapter.
  if (!await hasCredential(providerId)) return { unset: true, reason: 'credential_missing' };
  return { modelId: resolved.modelId, providerId, source: resolved.source };
}

/** Read both role rows, then resolve. The store is the only role authority. */
export async function resolveAgentModelRoleFromStore(input: {
  role: NonChatModelRole;
  workspaceId: string;
  agent: Pick<CustomAgentConfig, 'id' | 'kind'>;
  reader: ModelRoleReader;
  env?: PlatformEnv;
  settings?: SettingsStore;
  hasProviderCredential?: (providerId: string) => Promise<boolean>;
}): Promise<ModelRoleResolution> {
  const [agentRole, workspaceRole] = await Promise.all([
    input.reader.getAgentModelRole(input.agent.id, input.role),
    input.reader.getWorkspaceModelRole(input.workspaceId, input.role),
  ]);
  return resolveAgentModelForRole({
    role: input.role,
    agent: input.agent,
    ...(agentRole ? { agentRole } : {}),
    ...(workspaceRole ? { workspaceRole } : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(input.settings ? { settings: input.settings } : {}),
    ...(input.hasProviderCredential
      ? { hasProviderCredential: input.hasProviderCredential }
      : {}),
  });
}

/**
 * The bounded capability shape frozen on the runtime plan. It carries whether
 * the role is filled and whether the resolved model accepts image input, never
 * which model resolved: swapping two models of equal capability must not
 * rotate a live conversation's incarnation.
 */
export function imageCapabilityForResolution(
  resolution: ModelRoleResolution,
): RuntimePlanImageCapabilityV3 {
  if ('unset' in resolution) {
    return { role: 'image', filled: false, acceptsImageInput: false };
  }
  const profile = findImageModel(resolution.modelId);
  return {
    role: 'image',
    filled: true,
    // An undeclared capability is an absent capability.
    acceptsImageInput: profile?.input.includes('image') === true,
  };
}

// Only a provider with a first-class key lane can serve an image role today.
// Anything else (a binding provider, or a stale row naming a provider this
// build does not know) reads as "no credential", so the role falls back to the
// honesty instruction instead of reaching an adapter that cannot authenticate.
async function defaultProviderCredentialCheck(
  providerId: string,
  env?: PlatformEnv,
  settings?: SettingsStore,
): Promise<boolean> {
  if (!isProviderKeyId(providerId)) return false;
  const resolved = await resolveProviderApiKey(providerId, env, settings);
  return Boolean(resolved.apiKey);
}
