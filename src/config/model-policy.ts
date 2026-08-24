import { ModelResolutionError } from './errors.ts';
import type {
  AgentModelAttribution,
  CustomAgentConfig,
  ResolvedAssignment,
  WorkspaceInstallation,
  WorkspaceModelDefault,
  WorkspaceRuntimeContract,
} from './types.ts';
import { resolveActiveCatalogRoute } from '../model-catalog/index.ts';

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

export interface ResolvedAgentModelPolicy {
  model: string;
  attribution: AgentModelAttribution;
}

export interface WorkspaceModelPolicyReader {
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

// A `cloudflare/<model>` id resolves through Flue's binding-backed provider,
// which declares no context window — Flue then treats contextWindow as 0 and
// NEVER threshold-compacts. Pre-release transcript testing measured linear DM
// history growth on that path. Warn ONCE per model id so an operator who runs
// (or pins) a non-catalog `cloudflare/*` model knows auto-compaction is off.
// The REST `cloudflare-workers-ai/*` provider declares a floor in src/app.ts
// and is unaffected, so it is deliberately not matched here.
const warnedUnboundedCloudflareModels = new Set<string>();
function noteResolvedModel(model: string): string {
  if (model.startsWith('cloudflare/') && !warnedUnboundedCloudflareModels.has(model)) {
    warnedUnboundedCloudflareModels.add(model);
    console.warn(
      `[chickpea] model ${model} resolves through the Workers AI binding with no declared ` +
        'context window (contextWindow 0): auto-compaction is disabled and long DM transcripts ' +
        'grow unbounded.',
    );
  }
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
