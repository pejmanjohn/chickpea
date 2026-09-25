import type { RuntimePlanV2 } from '../agents/runtime-plan.ts';
import {
  sealTurnEnvelope,
  TURN_ENVELOPE_SETTING_KEYS,
  type TurnEnvelopeAgentV1,
  type TurnEnvelopeV1,
} from '../agents/turn-envelope.ts';
import { getGithubConnection } from '../config/github-app.ts';
import { resolveAgentModelRoleFromStore } from '../config/model-policy.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import { sha256Hex } from '../security/digest.ts';

export interface BuildTurnEnvelopeInput {
  plan: RuntimePlanV2;
  /** The host's own stores: on Cloudflare these are local to the state object. */
  settings: SettingsStore;
  config: Pick<ConfigStore, 'getAgent' | 'getAgentModelRole' | 'getWorkspaceModelRole'>;
  env?: PlatformEnv | undefined;
  now?: () => number;
}

/**
 * Freeze the per-turn facts the Agent's tools read, on the host side where
 * the reads are local. Returns undefined when the envelope would exceed its
 * bound; the Agent then reads live, as before.
 */
export async function buildTurnEnvelope(
  input: BuildTurnEnvelopeInput,
): Promise<TurnEnvelopeV1 | undefined> {
  const { plan } = input;
  const [agent, settingValues, githubAppConnected] = await Promise.all([
    input.config.getAgent(plan.agentId).then(
      (current): TurnEnvelopeAgentV1 => ({
        id: current.id,
        kind: current.kind,
        revision: current.revision,
        enabled: current.enabled,
        repositories: current.repositories.map((grant) => ({ ...grant })),
      }),
      () => null,
    ),
    input.settings.getSettings(TURN_ENVELOPE_SETTING_KEYS),
    getGithubConnection(input.settings).then(
      (connection) => connection.mode === 'app',
      () => false,
    ),
  ]);
  const imageModelId = plan.imageCapability?.filled && agent
    ? await resolveImageModelId(input, agent)
    : undefined;
  return sealTurnEnvelope({
    frozenAt: (input.now ?? Date.now)(),
    agentId: plan.agentId,
    agent,
    settings: Object.fromEntries(
      TURN_ENVELOPE_SETTING_KEYS.map((key, index) => [key, settingValues[index] ?? null]),
    ),
    githubAppConnected,
    ...(imageModelId === undefined ? {} : { imageModelId }),
  }, sha256Hex);
}

async function resolveImageModelId(
  input: BuildTurnEnvelopeInput,
  agent: TurnEnvelopeAgentV1,
): Promise<string | null> {
  try {
    const resolution = await resolveAgentModelRoleFromStore({
      role: 'image',
      workspaceId: input.plan.conversation.workspaceId,
      agent: { id: agent.id, kind: agent.kind },
      reader: {
        getWorkspaceModelRole: (workspaceId, role) =>
          input.config.getWorkspaceModelRole(workspaceId, role),
        getAgentModelRole: (agentId, role) => input.config.getAgentModelRole(agentId, role),
      },
      ...(input.env ? { env: input.env } : {}),
      settings: input.settings,
    });
    return 'unset' in resolution ? null : resolution.modelId;
  } catch {
    return null;
  }
}
