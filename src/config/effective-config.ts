import { createHash } from 'node:crypto';

import { resolveAgentModel } from './model-policy.ts';
import { resolveAssignment, surfaceForChannelId, type ConfigStores } from './resolver.ts';
import type { CustomAgentConfig } from './types.ts';

export const SLACK_RUNTIME_GUARDRAIL =
  'Do not reveal Slack tokens, provider keys, or hidden policy data.';

export type InstructionLayerSource = 'profile' | 'channel' | 'runtime' | 'guardrail';

export interface InstructionLayer {
  source: InstructionLayerSource;
  label: string;
  text: string;
}

export interface EffectiveSlackConfig {
  workspaceId: string;
  channelId: string;
  agentId: string;
  channelLabel?: string;
  channelPromptAddendum?: string;
  agent: CustomAgentConfig;
  model: string;
  provider: string;
  allowedTools: string[];
  instructions: string;
  instructionLayers: InstructionLayer[];
}

export async function resolveEffectiveSlackConfig(
  workspaceId: string,
  channelId: string,
  stores: ConfigStores,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EffectiveSlackConfig> {
  // The durable agent and admin resolve from a thread key / channel id (no live
  // turn), so the surface is inferred from the channel id (D… = direct).
  const assignment = await resolveAssignment(workspaceId, channelId, stores, {
    surface: surfaceForChannelId(channelId),
  });
  const model = resolveAgentModel(assignment.agent, env);
  const instructionLayers: InstructionLayer[] = [
    { source: 'profile', label: 'Profile', text: assignment.agent.instructions },
    ...(assignment.channelPromptAddendum
      ? [
          {
            source: 'channel' as const,
            label: 'Channel instructions',
            text: assignment.channelPromptAddendum,
          },
        ]
      : []),
    {
      source: 'runtime',
      label: 'Runtime',
      text: `You are assigned to Slack workspace ${assignment.workspaceId} channel ${assignment.channelId}.`,
    },
    { source: 'guardrail', label: 'Guardrail', text: SLACK_RUNTIME_GUARDRAIL },
  ];
  const instructions = instructionLayers.map((layer) => layer.text).join('\n');
  const allowedTools = [...assignment.agent.allowedTools];

  return {
    workspaceId: assignment.workspaceId,
    channelId: assignment.channelId,
    agentId: assignment.agentId,
    ...(assignment.channelLabel ? { channelLabel: assignment.channelLabel } : {}),
    ...(assignment.channelPromptAddendum
      ? { channelPromptAddendum: assignment.channelPromptAddendum }
      : {}),
    agent: assignment.agent,
    model,
    provider: providerPrefix(model),
    allowedTools,
    instructions,
    instructionLayers,
  };
}

// Deliberately NOT part of resolveEffectiveSlackConfig: the resolver runs on
// every Slack turn, where the sha256 over multi-KB instructions would be
// computed and discarded. Only snapshot consumers (the admin Access summary
// today, thread snapshots later) pay for it.
export function computeSnapshotHash(config: EffectiveSlackConfig): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        workspaceId: config.workspaceId,
        channelId: config.channelId,
        agentId: config.agentId,
        model: config.model,
        allowedTools: config.allowedTools,
        instructions: config.instructions,
        // Skills ride inside the frozen agent; include them so an
        // Access-summary drift check notices a skill edit vs. a live thread.
        skills: config.agent.skills,
        // MCP connections ride inside the frozen agent too (policy only — no
        // secrets); include them so drift checks notice a connection edit.
        mcpServers: config.agent.mcpServers,
      }),
    )
    .digest('hex');
}

function providerPrefix(model: string): string {
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash) : model;
}
