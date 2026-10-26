import { findImageModel } from '../model-catalog/image-profiles.ts';
import type { ConfigStore } from './store.ts';
import { NON_CHAT_MODEL_ROLES, type CustomAgentConfig, type NonChatModelRole } from './types.ts';

interface ProviderRuntimeImpact {
  pinnedAgents: CustomAgentConfig[];
  inheritingAgents: CustomAgentConfig[];
  activeInheritingAgentCount: number;
  workspaceDefaultAffected: boolean;
  /** Workspace image and coding defaults whose model needs this provider's key. */
  affectedWorkspaceRoles: NonChatModelRole[];
}

type ProviderImpactReader = Pick<
  ConfigStore,
  'listUserAgents' | 'listWorkspaceInstallations' | 'getWorkspaceModelDefault' | 'getWorkspaceModelRole'
>;

export async function resolveProviderRuntimeImpact(
  config: ProviderImpactReader,
  provider: string,
): Promise<ProviderRuntimeImpact> {
  return (await resolveProviderRuntimeImpacts(config, [provider])).get(provider)!;
}

export async function resolveProviderRuntimeImpacts(
  config: ProviderImpactReader,
  providers: readonly string[],
): Promise<Map<string, ProviderRuntimeImpact>> {
  const [agents, installations] = await Promise.all([
    config.listUserAgents(),
    config.listWorkspaceInstallations(),
  ]);
  const workspaceModels = await Promise.all(installations.map(async (installation) => {
    const [workspaceDefault, image, coding] = await Promise.all([
      config.getWorkspaceModelDefault(installation.workspaceId),
      config.getWorkspaceModelRole(installation.workspaceId, 'image'),
      config.getWorkspaceModelRole(installation.workspaceId, 'coding'),
    ]);
    return { installation, workspaceDefault, roles: { image: image?.modelId, coding: coding?.modelId } };
  }));
  return new Map(providers.map((provider) => {
    const workspaceDefaultAffected = workspaceModels.some(({ installation, workspaceDefault }) =>
      installation.runtimeContract === 'chickpea-v1' &&
      modelBelongsToProvider(workspaceDefault?.modelId, provider)
    );
    const inheritingAgents = workspaceDefaultAffected
      ? agents.filter((agent) => !agent.model)
      : [];
    return [provider, {
      pinnedAgents: agents.filter((agent) => modelBelongsToProvider(agent.model, provider)),
      inheritingAgents,
      activeInheritingAgentCount: inheritingAgents.filter((agent) =>
        agent.lifecycle === 'active' && agent.enabled
      ).length,
      workspaceDefaultAffected,
      affectedWorkspaceRoles: NON_CHAT_MODEL_ROLES.filter((role) =>
        workspaceModels.some(({ roles }) => roleNeedsProviderKey(role, roles[role], provider))
      ),
    }] as const;
  }));
}

function roleNeedsProviderKey(
  role: NonChatModelRole,
  model: string | undefined,
  provider: string,
): boolean {
  // ChatGPT Image runs on the connected ChatGPT subscription, not the API key.
  if (role === 'image' && model && findImageModel(model)?.authMethod === 'subscription') return false;
  return modelBelongsToProvider(model, provider);
}

export function modelBelongsToProvider(
  model: string | undefined,
  provider: string,
): boolean {
  if (!model) return false;
  if (provider === 'workers-ai') {
    return model.startsWith('cloudflare/') || model.startsWith('cloudflare-workers-ai/');
  }
  return model.startsWith(`${provider}/`);
}
