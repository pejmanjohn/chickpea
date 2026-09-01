import type { ConfigStore } from './store.ts';
import type { CustomAgentConfig } from './types.ts';

interface ProviderRuntimeImpact {
  pinnedAgents: CustomAgentConfig[];
  inheritingAgents: CustomAgentConfig[];
  activeInheritingAgentCount: number;
  workspaceDefaultAffected: boolean;
}

export async function resolveProviderRuntimeImpact(
  config: Pick<
    ConfigStore,
    'listUserAgents' | 'listWorkspaceInstallations' | 'getWorkspaceModelDefault'
  >,
  provider: string,
): Promise<ProviderRuntimeImpact> {
  return (await resolveProviderRuntimeImpacts(config, [provider])).get(provider)!;
}

export async function resolveProviderRuntimeImpacts(
  config: Pick<
    ConfigStore,
    'listUserAgents' | 'listWorkspaceInstallations' | 'getWorkspaceModelDefault'
  >,
  providers: readonly string[],
): Promise<Map<string, ProviderRuntimeImpact>> {
  const [agents, installations] = await Promise.all([
    config.listUserAgents(),
    config.listWorkspaceInstallations(),
  ]);
  const workspaceDefaults = await Promise.all(installations.map(async (installation) => ({
    installation,
    workspaceDefault: await config.getWorkspaceModelDefault(installation.workspaceId),
  })));
  return new Map(providers.map((provider) => {
    const workspaceDefaultAffected = workspaceDefaults.some(({ installation, workspaceDefault }) =>
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
    }] as const;
  }));
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
