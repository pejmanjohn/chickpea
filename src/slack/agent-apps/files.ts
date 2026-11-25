import type { WebClient } from '@slack/web-api';

import type { RuntimePlanV2 } from '../../agents/runtime-plan.ts';
import { getConfigStore, getSettingsStore, getSlackCredentialResolutionDependencies, type PlatformEnv } from '../../config/state-backend.ts';
import { createSlackAttachmentClient, readDirectSlackAttachment } from '../attachment-client.ts';
import type { GatewayAttachmentClient } from '../gateway/client.ts';
import { resolveSlackInstallationExecutionContext } from '../installation-execution.ts';
import type { SlackSpeaker } from '../speaker.ts';
import { runOwnBot } from './place.ts';

type RunPlan = Pick<RuntimePlanV2, 'agentId'> & { conversation: Pick<RuntimePlanV2['conversation'], 'workspaceId'> };

/**
 * Reads a run's Slack files as the bot the run speaks as (runOwnBot). A file
 * shared in an Agent app's own DM, or in a private Channel only that app's bot
 * is in, is visible to that bot alone, so a run whose admission chose it reads
 * with its token, and fails as its run does when that app can no longer
 * answer. Every other run reads through the installation, as before.
 */
export function runAttachmentClient(
  env: PlatformEnv | undefined,
  plan: RunPlan,
  turnJobId: string | undefined,
  options: { installation?: GatewayAttachmentClient; speakerOf?: (turnJobId: string) => Promise<SlackSpeaker | undefined> } = {},
): GatewayAttachmentClient {
  const { agentId, conversation: { workspaceId } } = plan;
  const { installation = createSlackAttachmentClient(env), speakerOf } = options;
  return {
    async readAttachment(fileId, maxBytes, signal, accept) {
      const bot = await runOwnBot(env, { workspaceId, agentId, turnJobId }, speakerOf ? { speakerOf } : {});
      if (!bot) return installation.readAttachment(fileId, maxBytes, signal, accept);
      return readDirectSlackAttachment({
        fileId, maxBytes, token: bot.botToken!, workspaceId, ...(signal ? { signal } : {}), ...(accept ? { accept } : {}),
      });
    },
  };
}

/**
 * The client a run acts in its conversation with: the bot it speaks as
 * (runOwnBot). A file the run makes is staged and completed with it, so the
 * file belongs to the bot whose reply shares it. The installation resolves
 * first either way, so a revoked or gated installation refuses an Agent app's
 * run too.
 */
export async function runSlackClient(env: PlatformEnv | undefined, plan: RunPlan, turnJobId: string | undefined): Promise<WebClient> {
  const installation = await resolveSlackInstallationExecutionContext(plan.conversation.workspaceId, env, {
    config: getConfigStore(env),
    settings: getSettingsStore(env),
    credentialDependencies: getSlackCredentialResolutionDependencies(env),
  });
  const bot = await runOwnBot(env, { workspaceId: installation.workspaceId, agentId: plan.agentId, turnJobId });
  return (bot ?? installation).client;
}
